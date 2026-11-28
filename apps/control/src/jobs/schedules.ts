import { scheduleCleanup as scheduleRequestLogCleanup } from "../analytics/area.ts";
import { TICK_KIND as BACKUP_TICK_KIND, wakeScheduler } from "../backups/scheduler-wake.ts";
import type { Db } from "../db/database.ts";
import { HEALTH_WATCH_JOB, scheduleHealthWatch } from "../deploys/health-watch.ts";
import { recoverQueue } from "../deploys/queue.ts";
import { scheduleDeploymentPruning } from "../deploys/retention.ts";
import { pruneIdentityRecords } from "../identity/maintenance.ts";
import type { Logger } from "../log.ts";
import { scheduleMetricsPruning } from "../runners/metrics.ts";
import { scheduleCleanupTick } from "../server-setup/cleanup.ts";
import { TASK_TICK_KIND, wakeTaskScheduler } from "../tasks/scheduler.ts";
import { pruneFinishedJobs } from "./prune-finished-jobs.ts";
import { JobQueue } from "./queue.ts";

/**
 * The control plane's own schedules (spec 23.2): the task and backup schedulers, the daily
 * Docker cleanup, the request log's cleanup, and the clean-ups that keep the database small
 * (finished jobs, ended sessions, attempt counts, old invitations, audit events past 90 days,
 * deployment retention, metrics). Each is a chain of jobs on the schedule lanes, and this keeper
 * makes sure every chain has its next job booked: at start and then every few minutes, on its
 * own timer. So a daily clean-up runs every day the control plane is up, not only the day it
 * started, and a chain whose job failed for good starts again by itself (B1-13).
 *
 * Every booking uses an idempotency key made from its due time, so asking again books nothing
 * twice, and several processes keeping the same schedules agree.
 */

export const KEEPER_INTERVAL_MS = 5 * 60_000;

export interface Schedule {
  name: string;
  ensure(db: Db, now: Date): Promise<void>;
}

/** Whether a job of this kind is waiting or running. */
async function chainAlive(db: Db, kind: string): Promise<boolean> {
  const row = await db
    .selectFrom("job")
    .select("id")
    .where("kind", "=", kind)
    .where("state", "in", ["queued", "running"])
    .executeTakeFirst();
  return row !== undefined;
}

export function controlSchedules(options: { metricsRetentionDays?: number } = {}): Schedule[] {
  return [
    // A scheduler whose chain ended (its tick failed for good) ticks now, which books the rest.
    {
      name: "task scheduler",
      async ensure(db, now) {
        if (!(await chainAlive(db, TASK_TICK_KIND))) await wakeTaskScheduler(db, now);
      },
    },
    {
      name: "backup scheduler",
      async ensure(db, now) {
        if (!(await chainAlive(db, BACKUP_TICK_KIND))) await wakeScheduler(db, now);
      },
    },
    { name: "Docker cleanup", ensure: (db) => scheduleCleanupTick(db) },
    {
      name: "request log cleanup",
      async ensure(db) {
        await scheduleRequestLogCleanup(db);
      },
    },
    {
      name: "finished jobs",
      async ensure(db, now) {
        await new JobQueue(db, { workerId: "scheduler" }).add(
          pruneFinishedJobs,
          { olderThanDays: 7 },
          { idempotencyKey: `prune-finished-jobs:${now.toISOString().slice(0, 10)}` },
        );
      },
    },
    {
      name: "identity records",
      async ensure(db, now) {
        await new JobQueue(db, { workerId: "scheduler" }).add(
          pruneIdentityRecords,
          {},
          { idempotencyKey: `prune-identity-records:${now.toISOString().slice(0, 10)}` },
        );
      },
    },
    { name: "deployment retention", ensure: (db) => scheduleDeploymentPruning(db) },
    // Unhealthy apps are replaced (31b G2-06): a chain of one-minute checks.
    {
      name: "health watch",
      async ensure(db) {
        if (!(await chainAlive(db, HEALTH_WATCH_JOB))) await scheduleHealthWatch(db);
      },
    },
    {
      name: "metrics retention",
      ensure: (db) => scheduleMetricsPruning(db, 0, options.metricsRetentionDays),
    },
    // Deploys a stopped control plane left waiting get their job back at once (B1-13).
    {
      name: "deploy queue",
      async ensure(db) {
        await recoverQueue(db);
      },
    },
  ];
}

/** Makes sure every schedule has its next job, once. Problems are logged, never thrown. */
export async function keepSchedules(
  db: Db,
  log: Logger,
  schedules: readonly Schedule[],
  now = new Date(),
): Promise<void> {
  for (const schedule of schedules) {
    try {
      await schedule.ensure(db, now);
    } catch (error) {
      log.warn("couldn't book a schedule's next run; trying again soon", {
        schedule: schedule.name,
        error,
      });
    }
  }
}

/** Keeps the schedules at start and then every few minutes, until stopped. */
export function startScheduleKeeper(
  db: Db,
  log: Logger,
  schedules: readonly Schedule[],
  everyMs = KEEPER_INTERVAL_MS,
): { first: Promise<void>; stop(): void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const round = async () => {
    if (stopped) return;
    await keepSchedules(db, log, schedules);
    if (!stopped) timer = setTimeout(() => void round(), everyMs);
  };
  const first = round();
  return {
    first,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
