import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { defineJob } from "../jobs/definition.ts";
import { missedWhileStopped, schedulesStartedAt } from "../jobs/started.ts";
import type { Logger } from "../log.ts";
import type { ControlServices } from "../services.ts";
import { emitBackupEvent } from "./events.ts";
import { STOPPED_MESSAGE } from "./job.ts";
import { enqueueRunJob, finishRun, pruneRuns, publishStatus, requestScheduleRun } from "./runs.ts";
import { nextGridPoint, TICK_KIND, wakeScheduler } from "./scheduler-wake.ts";
import { loadScheduleContext, nextRunFor, scheduleRunInput, serverTimeZone } from "./schedules.ts";

/**
 * The one backup scheduler (spec 17.2, 23.2, 24 P5). It is a job of the control plane's queue,
 * never a separate worker: each tick claims the schedules that are due with FOR UPDATE SKIP
 * LOCKED, moves each one's next time forward and adds its run in the same transaction, so two
 * processes ticking at once never start a schedule twice. A tick also recovers runs a stopped
 * control plane left behind, prunes old runs, and books the next tick.
 */

const BATCH = 50;

/**
 * Starts the runs of every schedule that is due. Returns how many it started. A due time from
 * before `startedAt` (this control plane's start) passed while it was stopped, so it is skipped
 * and the schedule next runs at its next scheduled time (spec 30, R3-30).
 */
export async function startDueSchedules(
  services: ControlServices,
  now = new Date(),
  startedAt: Date | null = schedulesStartedAt(services.db),
): Promise<number> {
  let started = 0;
  for (;;) {
    const batch = await services.db.transaction().execute(async (trx) => {
      let begun = 0;
      const due = await trx
        .selectFrom("backup_schedule")
        .select(["id", "cron", "next_run_at"])
        .where("enabled", "=", true)
        .where("next_run_at", "<=", now)
        .orderBy("next_run_at")
        .limit(BATCH)
        .forUpdate()
        .skipLocked()
        .execute();
      for (const schedule of due) {
        const context = await loadScheduleContext(trx, schedule.id);
        if (!context) {
          await trx
            .updateTable("backup_schedule")
            .set({ next_run_at: null })
            .where("id", "=", schedule.id)
            .execute();
          continue;
        }
        const zone = await serverTimeZone(trx, context.service.row.server_id);
        const next = nextRunFor(schedule.cron, zone, now.getTime());
        await trx
          .updateTable("backup_schedule")
          .set({ next_run_at: next })
          .where("id", "=", schedule.id)
          .execute();
        // Missed while Nearzero was stopped: skipped, not run at start (R3-30).
        const dueAt = schedule.next_run_at ? new Date(schedule.next_run_at) : null;
        if (missedWhileStopped(dueAt, startedAt)) continue;
        const input = await scheduleRunInput(
          trx,
          context.schedule,
          context.service,
          "schedule",
          null,
        );
        await requestScheduleRun(trx, {
          ...input,
          dueAt: schedule.next_run_at ? new Date(schedule.next_run_at) : now,
        });
        begun++;
      }
      return { due: due.length, begun };
    });
    started += batch.begun;
    if (batch.due < BATCH) return started;
  }
}

/**
 * Runs left behind: a waiting run whose job is gone gets a new one (when nothing of its
 * schedule runs); a running run whose job ended without finishing it is marked Failed.
 */
export async function recoverRuns(services: ControlServices, log: Logger): Promise<number> {
  const { db } = services;
  let recovered = 0;
  const stale = await db
    .selectFrom("backup_run as r")
    .leftJoin("job as j", "j.id", "r.job_id")
    .select([
      "r.id",
      "r.status",
      "r.schedule_id",
      "r.service_id",
      "r.exclusive",
      "j.state as job_state",
    ])
    .where("r.status", "in", ["queued", "running"])
    .where("r.updated_at", "<", sql<Date>`now() - interval '1 minute'`)
    .where((eb) => eb.or([eb("j.id", "is", null), eb("j.state", "in", ["succeeded", "failed"])]))
    .execute();
  for (const run of stale) {
    if (run.status === "running") {
      const failed = await finishRun(db, run.id, { status: "failed", error: STOPPED_MESSAGE });
      if (failed) {
        await emitBackupEvent(db, log, failed);
        await publishStatus(db, run.id);
        recovered++;
      }
      continue;
    }
    if (run.schedule_id) {
      const running = await db
        .selectFrom("backup_run")
        .select("id")
        .where("schedule_id", "=", run.schedule_id)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (running) continue;
    }
    if (run.exclusive && run.service_id) {
      // It waits for the run that stops its service; that one hands over when it ends.
      const busy = await db
        .selectFrom("backup_run")
        .select("id")
        .where("service_id", "=", run.service_id)
        .where("exclusive", "=", true)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (busy) continue;
    }
    await enqueueRunJob(db, run.id, `recover:${new Date().toISOString().slice(0, 16)}`);
    recovered++;
  }
  return recovered;
}

/** When the next tick should happen: the next due schedule, or the next 5-minute grid point. */
export async function nextTickAt(db: Db, now = Date.now()): Promise<Date> {
  const grid = nextGridPoint(now);
  const row = await db
    .selectFrom("backup_schedule")
    .select((eb) => eb.fn.min("next_run_at").as("next"))
    .where("enabled", "=", true)
    .executeTakeFirst();
  const next = row?.next ? new Date(row.next as Date) : null;
  if (!next || next.getTime() >= grid.getTime()) return grid;
  return new Date(Math.max(next.getTime(), now + 1000));
}

export async function tick(services: ControlServices, log: Logger): Promise<void> {
  const started = await startDueSchedules(services);
  const recovered = await recoverRuns(services, log);
  const pruned = await pruneRuns(services.db);
  if (started + recovered + pruned > 0)
    log.info("backup schedules", { started, recovered, pruned });
}

export function backupTickJob(services: ControlServices) {
  return defineJob({
    kind: TICK_KIND,
    payload: z.object({}),
    maxAttempts: 5,
    lane: "schedule",
    async run(_payload, { log }) {
      try {
        await tick(services, log);
      } finally {
        // The next tick is booked even when this one failed, so the chain never breaks.
        await wakeScheduler(services.db, await nextTickAt(services.db));
      }
    },
  });
}

/** At start: a tick now, which books the ones after it. */
export async function startBackupScheduler(db: Db): Promise<void> {
  await wakeScheduler(db, new Date(Math.floor(Date.now() / 60_000) * 60_000));
}
