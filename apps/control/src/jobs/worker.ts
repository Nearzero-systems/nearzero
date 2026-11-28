import { z } from "zod";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";
import {
  type AnyJobDefinition,
  type ClaimedJob,
  DeferJob,
  defaultRetryDelayMs,
  JOB_LANES,
  type JobLane,
  PermanentJobError,
} from "./definition.ts";
import type { JobQueue } from "./queue.ts";

/**
 * Runs queued jobs inside the control plane. Lanes claim one job at a time, run it, record the
 * result, and sleep for the poll interval when nothing is due. Lanes are grouped by what they
 * run (definition.ts, JobLane): scheduler ticks, deploys, and each kind of long work (backups
 * and restores, task runs, setups, deletes, cleanups) have their own, so four 6-hour task runs
 * never hold a deploy or a backup that falls due, and four setups never hold a task (spec 23.1,
 * 23.2, R4-03). The idle lanes of a group take turns asking the database, so more lanes don't
 * mean more polling. A failed attempt is retried after a backoff until the kind's attempt limit,
 * then marked failed.
 */

export interface JobWorkerOptions {
  db: Db;
  queue: JobQueue;
  definitions: readonly AnyJobDefinition[];
  log: Logger;
  /** Lanes for each kind of long work (backups, task runs, setups, deletes, cleanups, moves). */
  concurrency?: number;
  /** Lanes for deploys. */
  deployConcurrency?: number;
  /** Lanes for scheduler ticks and housekeeping. */
  scheduleConcurrency?: number;
  pollIntervalMs?: number;
  /** How often to look for jobs whose worker stopped mid-run. */
  recoverIntervalMs?: number;
}

export interface StopOptions {
  /** How long running jobs get to finish before they are told to stop. */
  graceMs?: number;
}

const MAX_IDLE_DELAY_MS = 30_000;

/** Sleeps until the time is up or any of the signals aborts (listeners removed after). */
function sleep(ms: number, ...signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    if (signals.some((signal) => signal.aborted)) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener("abort", done);
      resolve();
    }
    for (const signal of signals) signal.addEventListener("abort", done, { once: true });
  });
}

function timeout(ms: number): Promise<"timeout"> {
  return new Promise((resolve) => setTimeout(() => resolve("timeout"), ms));
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

export class JobWorker {
  private readonly definitions: Map<string, AnyJobDefinition>;
  private readonly kinds: string[];
  /** The kinds each lane group claims. */
  private readonly laneKinds: Record<JobLane, string[]>;
  private readonly laneCounts: Record<JobLane, number>;
  private readonly concurrency: number;
  private readonly pollIntervalMs: number;
  private readonly recoverIntervalMs: number;
  private running = false;
  private loops: Promise<void>[] = [];
  /** Wakes sleeping lanes when the worker stops. */
  private wake = new AbortController();
  /** Until when a group's idle lanes leave the database alone: one of them just asked it. */
  private readonly idleUntil: Record<JobLane, number>;
  /** Wakes a group's sleeping lanes when one of them claimed a job (more may be due). */
  private readonly kicks: Record<JobLane, AbortController>;
  /** Tells running jobs to stop, once the grace period is over. */
  private jobsAbort = new AbortController();

  constructor(private readonly options: JobWorkerOptions) {
    this.definitions = new Map();
    for (const definition of options.definitions) {
      if (this.definitions.has(definition.kind)) {
        throw new Error(`The job kind ${definition.kind} is defined twice.`);
      }
      this.definitions.set(definition.kind, definition);
    }
    this.kinds = [...this.definitions.keys()];
    const perGroup = <T>(value: () => T) =>
      Object.fromEntries(JOB_LANES.map((group) => [group, value()])) as Record<JobLane, T>;
    this.laneKinds = perGroup<string[]>(() => []);
    for (const definition of this.definitions.values()) {
      this.laneKinds[definition.lane ?? "work"].push(definition.kind);
    }
    this.concurrency = options.concurrency ?? 4;
    // Each kind of long work gets the same number of lanes, its own.
    this.laneCounts = {
      ...perGroup(() => this.concurrency),
      schedule: options.scheduleConcurrency ?? 2,
      deploy: options.deployConcurrency ?? 4,
    };
    this.idleUntil = perGroup(() => 0);
    this.kicks = perGroup(() => new AbortController());
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.recoverIntervalMs = options.recoverIntervalMs ?? 15_000;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.wake = new AbortController();
    this.jobsAbort = new AbortController();
    this.loops = [this.recoverLoop()];
    for (const group of JOB_LANES) {
      if (this.laneKinds[group].length === 0) continue;
      this.idleUntil[group] = 0;
      for (let lane = 0; lane < this.laneCounts[group]; lane++) {
        this.loops.push(this.lane(group));
      }
    }
    this.options.log.info("job worker started", {
      lanes: this.laneCounts,
      kinds: this.kinds,
    });
  }

  /** Stops claiming jobs and waits for running ones to finish. */
  async stop(options: StopOptions = {}): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake.abort();
    const finished = Promise.all(this.loops).then(() => "finished" as const);
    if ((await Promise.race([finished, timeout(options.graceMs ?? 20_000)])) === "timeout") {
      this.options.log.warn("jobs are still running; asking them to stop");
      this.jobsAbort.abort();
      await Promise.race([finished, timeout(5_000)]);
    }
    this.loops = [];
    this.options.log.info("job worker stopped");
  }

  /** Claims and runs one due job (of the given kinds, or any). False when nothing was due. */
  async runOnce(kinds: readonly string[] = this.kinds): Promise<boolean> {
    const job = await this.options.queue.claim(kinds);
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** The kinds a lane group runs (for tests and the status page). */
  kindsOf(group: JobLane): readonly string[] {
    return this.laneKinds[group];
  }

  /** The lane count of each group (for tests and the status page). */
  lanesOf(group: JobLane): number {
    return this.laneKinds[group].length === 0 ? 0 : this.laneCounts[group];
  }

  private kick(group: JobLane): void {
    const kick = this.kicks[group];
    this.kicks[group] = new AbortController();
    kick.abort();
  }

  private async lane(group: JobLane): Promise<void> {
    const kinds = this.laneKinds[group];
    let idleDelay = this.pollIntervalMs;
    while (this.running) {
      // Another idle lane of this group asked a moment ago and found nothing: wait for the next
      // look, or for a lane that claimed something to wake the rest.
      const wait = this.idleUntil[group] - Date.now();
      if (wait > 0) {
        await sleep(wait, this.wake.signal, this.kicks[group].signal);
        continue;
      }
      this.idleUntil[group] = Date.now() + idleDelay;
      let job: ClaimedJob | null = null;
      try {
        job = await this.options.queue.claim(kinds);
        idleDelay = this.pollIntervalMs;
      } catch (error) {
        this.options.log.error("the job worker can't reach the database; it will try again", {
          error,
          retryInMs: idleDelay,
        });
        idleDelay = Math.min(idleDelay * 2, MAX_IDLE_DELAY_MS);
        this.idleUntil[group] = Date.now() + idleDelay;
      }
      if (job) {
        // More may be due: the group's other idle lanes look again at once.
        this.idleUntil[group] = 0;
        this.kick(group);
        await this.execute(job);
      } else if (this.running) {
        await sleep(idleDelay, this.wake.signal, this.kicks[group].signal);
      }
    }
  }

  private async recoverLoop(): Promise<void> {
    while (this.running) {
      try {
        const recovered = await this.options.queue.recoverExpired();
        if (recovered > 0) {
          this.options.log.warn("put back jobs whose worker stopped mid-run", { count: recovered });
        }
      } catch (error) {
        this.options.log.error("couldn't check for interrupted jobs; will try again", { error });
      }
      await sleep(this.recoverIntervalMs, this.wake.signal);
    }
  }

  private async execute(job: ClaimedJob): Promise<void> {
    const { queue, db } = this.options;
    const definition = this.definitions.get(job.kind);
    const log = this.options.log.child({ jobId: job.id, jobKind: job.kind, attempt: job.attempt });
    if (!definition) {
      // Unreachable: claims only ask for known kinds.
      await queue.fail(job, `No handler is installed for jobs of kind ${job.kind}.`);
      return;
    }

    const leaseLost = new AbortController();
    const signal = AbortSignal.any([this.jobsAbort.signal, leaseLost.signal]);
    const heartbeat = setInterval(
      () => {
        queue
          .extendLease(job)
          .then((owned) => {
            if (!owned && !leaseLost.signal.aborted) {
              log.warn("the job's lease was lost; stopping it");
              leaseLost.abort();
            }
          })
          .catch((error: unknown) => log.warn("couldn't renew the job's lease", { error }));
      },
      Math.max(10, Math.floor(queue.leaseMs / 3)),
    );

    const started = performance.now();
    let failure: { error: unknown } | null = null;
    try {
      const parsed = definition.payload.safeParse(job.payload);
      if (!parsed.success) {
        throw new PermanentJobError(
          `The job's data is not valid: ${z.prettifyError(parsed.error)}`,
        );
      }
      await definition.run(parsed.data, { job, db, log, signal });
    } catch (error) {
      failure = { error };
    } finally {
      clearInterval(heartbeat);
    }
    const durationMs = Math.round(performance.now() - started);

    try {
      if (!failure) {
        const recorded = await queue.complete(job);
        if (recorded) log.info("job succeeded", { durationMs });
        else log.warn("job finished after its lease was lost; it may run again", { durationMs });
        return;
      }
      if (failure.error instanceof DeferJob) {
        await queue.defer(job, failure.error.delayMs);
        log.debug("job waits its turn", { reason: failure.error.message });
        return;
      }
      const message = errorText(failure.error);
      const permanent = failure.error instanceof PermanentJobError;
      if (!permanent && job.attempt < job.maxAttempts) {
        const delayMs = (definition.retryDelayMs ?? defaultRetryDelayMs)(job.attempt);
        await queue.retryLater(job, message, delayMs);
        log.warn("job failed; it will run again", { error: failure.error, delayMs, durationMs });
      } else {
        await queue.fail(job, message);
        log.error("job failed", { error: failure.error, durationMs, permanent });
      }
    } catch (error) {
      log.error("couldn't record the job's result; it will run again after its lease ends", {
        error,
      });
    }
  }
}
