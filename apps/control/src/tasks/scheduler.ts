import { nextTaskRun, OPEN_TASK_RUN_STATUSES, TASK_MESSAGES } from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import { missedWhileStopped, schedulesStartedAt } from "../jobs/started.ts";
import type { Logger } from "../log.ts";
import type { ControlServices } from "../services.ts";
import { finishRun, RUN_JOB_ATTEMPTS, RUN_JOB_KIND } from "./runs.ts";

/**
 * The one task scheduler (spec 12.3, 23.2). It is a job of the control plane's queue: each tick
 * claims the tasks that are due with FOR UPDATE SKIP LOCKED, moves each one's next time forward
 * and records its run in the same transaction, so several processes never start a due time
 * twice (the run's (task, due time) is unique too). A due run waits as "queued" until a task
 * lane starts it. A task whose run is still going, or still queued, when it comes due gets a
 * recorded skip instead of a second run. A due time that passed while the control plane
 * was stopped is skipped: the task next runs at its next scheduled time (R3-30). A tick also
 * marks runs a stopped control plane left behind, then books the next tick: at the next due
 * time, or within a minute.
 */

export const TASK_TICK_KIND = "tasks.tick";
const GRID_MS = 60_000;
const BATCH = 50;

export function nextGridPoint(now: number): Date {
  return new Date((Math.floor(now / GRID_MS) + 1) * GRID_MS);
}

/** Books a tick for `at` (to the second); ticks for one second merge into one job. */
export async function wakeTaskScheduler(db: Db, at: Date, now = Date.now()): Promise<void> {
  const second = new Date(Math.floor(at.getTime() / 1000) * 1000);
  await new JobQueue(db, { workerId: "tasks-scheduler" }).enqueue({
    kind: TASK_TICK_KIND,
    payload: {},
    maxAttempts: 5,
    delayMs: Math.max(0, second.getTime() - now),
    idempotencyKey: `${TASK_TICK_KIND}:${second.toISOString().slice(0, 19)}`,
  });
}

export interface DueResult {
  started: number;
  skipped: number;
}

/**
 * Starts (or skips) every task that is due. `startedAt` is when this control plane started its
 * schedules: due times before it were missed while it was stopped.
 */
export async function startDueTasks(
  db: Db,
  now = new Date(),
  startedAt: Date | null = schedulesStartedAt(db),
): Promise<DueResult> {
  const result: DueResult = { started: 0, skipped: 0 };
  for (;;) {
    const handled = await db.transaction().execute(async (trx) => {
      const due = await trx
        .selectFrom("task")
        .select(["id", "cron", "time_zone", "next_run_at"])
        .where("enabled", "=", true)
        .where("next_run_at", "<=", now)
        .orderBy("next_run_at")
        .limit(BATCH)
        .forUpdate()
        .skipLocked()
        .execute();
      const queue = new JobQueue(trx, { workerId: "tasks-scheduler" });
      for (const task of due) {
        const dueAt = task.next_run_at ? new Date(task.next_run_at) : now;
        // The schedule moves on to its next time after now either way.
        const next = nextTaskRun(task.cron, task.time_zone, now.getTime());
        await trx
          .updateTable("task")
          .set({ next_run_at: next === null ? null : new Date(next) })
          .where("id", "=", task.id)
          .execute();
        // A due time that passed while Nearzero was stopped is skipped, not run at start
        // (spec 30, R3-30): the task runs at its next scheduled time.
        if (missedWhileStopped(dueAt, startedAt)) continue;
        // One open run per task: a due time while one is going, or still waiting for a task
        // lane, is a recorded skip that says which (C1-09).
        const busy = await trx
          .selectFrom("task_run")
          .select(["id", "status"])
          .where("task_id", "=", task.id)
          .where("status", "in", OPEN_TASK_RUN_STATUSES)
          .executeTakeFirst();
        if (busy) {
          const skipped = await trx
            .insertInto("task_run")
            .values({
              task_id: task.id,
              trigger: "schedule",
              status: "skipped",
              due_at: dueAt,
              started_at: dueAt,
              finished_at: now,
              error: busy.status === "queued" ? TASK_MESSAGES.skippedQueued : TASK_MESSAGES.skipped,
            })
            .onConflict((conflict) =>
              conflict.columns(["task_id", "due_at"]).where("due_at", "is not", null).doNothing(),
            )
            .returning("id")
            .executeTakeFirst();
          if (skipped) result.skipped++;
          continue;
        }
        const run = await trx
          .insertInto("task_run")
          // Queued until a task lane starts it (runs.ts beginRun).
          .values({ task_id: task.id, trigger: "schedule", status: "queued", due_at: dueAt })
          .onConflict((conflict) =>
            conflict.columns(["task_id", "due_at"]).where("due_at", "is not", null).doNothing(),
          )
          .returning("id")
          .executeTakeFirst();
        if (!run) continue;
        const job = await queue.enqueue({
          kind: RUN_JOB_KIND,
          payload: { runId: run.id },
          maxAttempts: RUN_JOB_ATTEMPTS,
          idempotencyKey: `task-run:${run.id}`,
        });
        await trx
          .updateTable("task_run")
          .set({ job_id: job.id })
          .where("id", "=", run.id)
          .execute();
        result.started++;
      }
      return due.length;
    });
    if (handled < BATCH) return result;
  }
}

/** Runs whose job ended (or vanished) without finishing them: the control plane stopped. */
export async function recoverRuns(db: Db): Promise<number> {
  const stale = await db
    .selectFrom("task_run as r")
    .leftJoin("job as j", "j.id", "r.job_id")
    .select(["r.id"])
    .where("r.status", "in", OPEN_TASK_RUN_STATUSES)
    .where("r.started_at", "<", sql<Date>`now() - interval '1 minute'`)
    .where((eb) => eb.or([eb("j.id", "is", null), eb("j.state", "in", ["succeeded", "failed"])]))
    .execute();
  let recovered = 0;
  for (const run of stale) {
    const row = await finishRun(db, run.id, { status: "failed", error: TASK_MESSAGES.restarted });
    if (row) recovered++;
  }
  return recovered;
}

export async function nextTickAt(db: Db, now = Date.now()): Promise<Date> {
  const grid = nextGridPoint(now);
  const row = await db
    .selectFrom("task")
    .select((eb) => eb.fn.min("next_run_at").as("next"))
    .where("enabled", "=", true)
    .executeTakeFirst();
  const next = row?.next ? new Date(row.next as Date) : null;
  if (!next || next.getTime() >= grid.getTime()) return grid;
  return new Date(Math.max(next.getTime(), now + 1000));
}

export async function taskTick(services: ControlServices, log: Logger): Promise<void> {
  const due = await startDueTasks(services.db);
  const recovered = await recoverRuns(services.db);
  if (due.started + due.skipped + recovered > 0) log.info("task schedules", { ...due, recovered });
}

export function taskTickJob(services: ControlServices) {
  return defineJob({
    kind: TASK_TICK_KIND,
    payload: z.object({}),
    maxAttempts: 5,
    lane: "schedule",
    async run(_payload, { log }) {
      try {
        await taskTick(services, log);
      } finally {
        // The next tick is booked even when this one failed, so the chain never breaks.
        await wakeTaskScheduler(services.db, await nextTickAt(services.db));
      }
    },
  });
}

/** At start: a tick now, which books the ones after it. */
export async function startTaskScheduler(db: Db): Promise<void> {
  await wakeTaskScheduler(db, new Date(Math.floor(Date.now() / 1000) * 1000));
}
