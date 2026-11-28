import type { z } from "zod";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";

/** A job as a worker sees it while running it. */
export interface ClaimedJob {
  id: number;
  kind: string;
  payload: unknown;
  /** This run's attempt number, starting at 1. */
  attempt: number;
  maxAttempts: number;
}

export interface JobContext {
  job: ClaimedJob;
  db: Db;
  log: Logger;
  /** Aborted when the worker stops or loses the job's lease; long work should check it. */
  signal: AbortSignal;
}

/**
 * Which worker lanes run a job (spec 23.1, 23.2; R2-15, R4-03, B1-12, C1-09). Every kind of long
 * work has lanes of its own, so no kind can use up the lanes another kind needs to start on time:
 * four 6-hour task runs never hold a backup that falls due, and four server setups never hold a
 * task.
 * - "schedule": scheduler ticks and short housekeeping, so schedules fire on time;
 * - "deploy": deploys, so a push never waits behind a task run;
 * - "backup": backups and restores;
 * - "task": task runs;
 * - "setup": server setups;
 * - "delete": deleting services and servers, and removing a server's runner;
 * - "cleanup": the daily Docker cleanup of each server;
 * - "work": anything else long (moving a 0.1.x install).
 */
export const JOB_LANES = [
  "schedule",
  "deploy",
  "backup",
  "task",
  "setup",
  "delete",
  "cleanup",
  "work",
] as const;
export type JobLane = (typeof JOB_LANES)[number];

/**
 * One kind of background job. Payloads are checked when the job runs, because a job written by
 * one version of Nearzero may be run by the next.
 *
 * Jobs run at least once: if the control plane stops mid-run, the job runs again after its lease
 * ends. Handlers must be safe to repeat.
 */
export interface JobDefinition<Payload> {
  /** Dotted lowercase name, like "maintenance.prune-finished-jobs". Never renamed once shipped. */
  kind: string;
  payload: z.ZodType<Payload>;
  /** Attempts before the job is marked failed. Defaults to the queue's default (5). */
  maxAttempts?: number;
  /** The lanes that run it; "work" when left out. */
  lane?: JobLane;
  /** Delay before attempt `attempt + 1`, after attempt `attempt` failed. */
  retryDelayMs?: (attempt: number) => number;
  run(payload: Payload, context: JobContext): Promise<void>;
}

// biome-ignore lint/suspicious/noExplicitAny: a catalog holds definitions of different payloads.
export type AnyJobDefinition = JobDefinition<any>;

export function defineJob<Payload>(definition: JobDefinition<Payload>): JobDefinition<Payload> {
  return definition;
}

/** Throw this from a job to fail it at once, without retrying (the input can never work). */
export class PermanentJobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PermanentJobError";
  }
}

/**
 * Throw this to put the job back in the queue for a while without using an attempt: it isn't
 * failing, it waits its turn (a deploy whose server is busy building another app). Its lane is
 * free meanwhile.
 */
export class DeferJob extends Error {
  readonly delayMs: number;
  constructor(delayMs: number, reason: string) {
    super(reason);
    this.name = "DeferJob";
    this.delayMs = delayMs;
  }
}

export const RETRY_BASE_MS = 5_000;
export const RETRY_MAX_MS = 10 * 60_000;

/** Exponential backoff: 5s, 10s, 20s, 40s… capped at 10 minutes. */
export function defaultRetryDelayMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 1);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}
