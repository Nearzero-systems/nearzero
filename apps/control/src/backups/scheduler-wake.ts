import type { Db } from "../db/database.ts";
import { JobQueue } from "../jobs/queue.ts";

/**
 * The backup scheduler's wake-up calls (spec 23.2, 24 P5). The scheduler is one job kind,
 * `backups.tick`, that the control plane's job queue runs: each tick starts the schedules that
 * are due and books the next tick. Ticks are keyed by their time to the second, so any number of
 * processes asking for the same tick add one job, and every chain of ticks lands on the same
 * times (schedules' due times, or a 5-minute grid), so chains merge instead of multiplying.
 */

export const TICK_KIND = "backups.tick";
/** Ticks happen at least this often, on a fixed grid, to recover runs a stop left behind. */
export const TICK_GRID_MS = 5 * 60_000;

export function tickKey(at: Date): string {
  return `${TICK_KIND}:${at.toISOString().slice(0, 19)}`;
}

/** The next point of the 5-minute grid after `now`. */
export function nextGridPoint(now: number): Date {
  return new Date((Math.floor(now / TICK_GRID_MS) + 1) * TICK_GRID_MS);
}

/** Books a tick for `at` (to the second). */
export async function wakeScheduler(db: Db, at: Date, now = Date.now()): Promise<void> {
  const second = new Date(Math.floor(at.getTime() / 1000) * 1000);
  await new JobQueue(db, { workerId: "backups-scheduler" }).enqueue({
    kind: TICK_KIND,
    payload: {},
    maxAttempts: 5,
    delayMs: Math.max(0, second.getTime() - now),
    idempotencyKey: tickKey(second),
  });
}
