import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import type { JobState } from "../db/schema.ts";
import type { ClaimedJob, JobDefinition } from "./definition.ts";

/**
 * The job table, seen as a queue. Workers claim due jobs with `FOR UPDATE SKIP LOCKED`, so any
 * number of workers in any number of processes can pull from it without taking the same job
 * twice. A claimed job holds a lease; the worker renews it while the job runs, and a job whose
 * lease ran out (its process stopped) is put back or failed by {@link JobQueue.recoverExpired}.
 *
 * All times come from the database clock, so processes never disagree about what is due.
 */

/** Longest error text kept on a job. */
const MAX_ERROR_LENGTH = 4_000;

export const DEFAULT_LEASE_MS = 60_000;

export interface EnqueueRequest {
  kind: string;
  payload?: unknown;
  /** Run no earlier than this many milliseconds from now. */
  delayMs?: number;
  maxAttempts?: number;
  /**
   * A key for "this exact piece of work". Enqueueing again with a key that is already used
   * returns the existing job instead of adding a second one.
   */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  id: number;
  /** False when a job with the same idempotency key already existed. */
  created: boolean;
}

export interface JobQueueOptions {
  /** Identifies the claimer in the job row; unique per worker process. */
  workerId: string;
  leaseMs?: number;
}

function interval(ms: number) {
  return sql<Date>`now() + make_interval(secs => ${ms / 1000}::double precision)`;
}

function trimError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}…` : message;
}

export class JobQueue {
  readonly workerId: string;
  readonly leaseMs: number;

  constructor(
    private readonly db: Db,
    options: JobQueueOptions,
  ) {
    this.workerId = options.workerId;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  }

  /** Adds a job of a known kind, checking its payload and using the kind's attempt limit. */
  async add<Payload>(
    definition: JobDefinition<Payload>,
    payload: Payload,
    options: Pick<EnqueueRequest, "delayMs" | "idempotencyKey"> = {},
  ): Promise<EnqueueResult> {
    return this.enqueue({
      ...options,
      kind: definition.kind,
      payload: definition.payload.parse(payload),
      ...(definition.maxAttempts === undefined ? {} : { maxAttempts: definition.maxAttempts }),
    });
  }

  async enqueue(request: EnqueueRequest): Promise<EnqueueResult> {
    const inserted = await this.db
      .insertInto("job")
      .values({
        kind: request.kind,
        payload: JSON.stringify(request.payload ?? {}),
        ...(request.maxAttempts === undefined ? {} : { max_attempts: request.maxAttempts }),
        ...(request.idempotencyKey === undefined
          ? {}
          : { idempotency_key: request.idempotencyKey }),
        run_at: interval(request.delayMs ?? 0),
      })
      .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (inserted) return { id: inserted.id, created: true };

    // Only an idempotency key can conflict, so the existing job is found by it.
    const key = request.idempotencyKey;
    if (key === undefined) throw new Error("A job without an idempotency key was not inserted.");
    const existing = await this.db
      .selectFrom("job")
      .select("id")
      .where("idempotency_key", "=", key)
      .executeTakeFirstOrThrow();
    return { id: existing.id, created: false };
  }

  /** Claims the oldest due job of the given kinds, or returns null when none is due. */
  async claim(kinds: readonly string[]): Promise<ClaimedJob | null> {
    if (kinds.length === 0) return null;
    const row = await this.db
      .updateTable("job")
      .set((eb) => ({
        state: "running",
        attempts: eb("attempts", "+", 1),
        locked_by: this.workerId,
        locked_until: interval(this.leaseMs),
        started_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      }))
      .where("id", "=", (eb) =>
        eb
          .selectFrom("job")
          .select("id")
          .where("state", "=", "queued")
          .where("run_at", "<=", sql<Date>`now()`)
          .where("kind", "in", kinds)
          .orderBy("run_at")
          .orderBy("id")
          .limit(1)
          .forUpdate()
          .skipLocked(),
      )
      .returning(["id", "kind", "payload", "attempts", "max_attempts"])
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      payload: row.payload,
      attempt: row.attempts,
      maxAttempts: row.max_attempts,
    };
  }

  /** Renews the lease. False means this worker no longer holds the job. */
  async extendLease(job: ClaimedJob): Promise<boolean> {
    const result = await this.ownedBy(job)
      .set({ locked_until: interval(this.leaseMs), updated_at: sql<Date>`now()` })
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async complete(job: ClaimedJob): Promise<boolean> {
    return this.finish(job, "succeeded", null);
  }

  async fail(job: ClaimedJob, message: string): Promise<boolean> {
    return this.finish(job, "failed", message);
  }

  /** Puts the job back in the queue to run again after the delay. */
  async retryLater(job: ClaimedJob, message: string, delayMs: number): Promise<boolean> {
    const result = await this.ownedBy(job)
      .set({
        state: "queued",
        run_at: interval(delayMs),
        last_error: trimError(message),
        locked_by: null,
        locked_until: null,
        updated_at: sql<Date>`now()`,
      })
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /** Puts the job back to run after the delay, giving back the attempt its claim used. */
  async defer(job: ClaimedJob, delayMs: number): Promise<boolean> {
    const result = await this.ownedBy(job)
      .set((eb) => ({
        state: "queued",
        run_at: interval(delayMs),
        attempts: eb("attempts", "-", 1),
        locked_by: null,
        locked_until: null,
        updated_at: sql<Date>`now()`,
      }))
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  /**
   * Handles jobs whose worker stopped without finishing them: each goes back in the queue, or is
   * marked failed when it has used all its attempts. Returns how many jobs were handled.
   */
  async recoverExpired(): Promise<number> {
    const message = "The control plane stopped while this job was running.";
    const result = await this.db
      .updateTable("job")
      .set({
        state: sql<JobState>`case when attempts >= max_attempts then 'failed' else 'queued' end`,
        finished_at: sql<Date | null>`case when attempts >= max_attempts then now() end`,
        run_at: sql<Date>`now()`,
        last_error: message,
        locked_by: null,
        locked_until: null,
        updated_at: sql<Date>`now()`,
      })
      .where("state", "=", "running")
      .where("locked_until", "<", sql<Date>`now()`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  private ownedBy(job: ClaimedJob) {
    return this.db
      .updateTable("job")
      .where("id", "=", job.id)
      .where("state", "=", "running")
      .where("locked_by", "=", this.workerId)
      .where("attempts", "=", job.attempt);
  }

  private async finish(
    job: ClaimedJob,
    state: "succeeded" | "failed",
    message: string | null,
  ): Promise<boolean> {
    const result = await this.ownedBy(job)
      .set({
        state,
        last_error: message === null ? null : trimError(message),
        locked_by: null,
        locked_until: null,
        finished_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
      })
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }
}
