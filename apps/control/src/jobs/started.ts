import type { Db } from "../db/database.ts";

/**
 * When this control plane started its schedules (spec 12.3, 23.2; spec 30 "Missed runs are
 * skipped", R3-30). A task's or backup schedule's due time earlier than this passed while the
 * control plane was stopped: the schedulers skip it, and the schedule next runs at its next
 * scheduled time, so nothing runs at start just because a time was missed. Work that was
 * already running when it stopped is resumed or reported as before; this is only about due
 * times. Kept per database handle, so each control plane (and each test harness) has its own.
 */
const started = new WeakMap<Db, Date>();

/** Called once at start, before the job worker picks up any schedule's tick. */
export function markSchedulesStarted(db: Db, at = new Date()): void {
  started.set(db, at);
}

/** When this process started its schedules, or null when it hasn't (some tests). */
export function schedulesStartedAt(db: Db): Date | null {
  return started.get(db) ?? null;
}

/** Forgets the start (tests). */
export function forgetSchedulesStarted(db: Db): void {
  started.delete(db);
}

/** Whether a due time passed while the control plane was stopped. */
export function missedWhileStopped(dueAt: Date | null, startedAt: Date | null): boolean {
  return dueAt !== null && startedAt !== null && dueAt.getTime() < startedAt.getTime();
}
