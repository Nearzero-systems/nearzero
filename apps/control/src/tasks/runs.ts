import {
  isOpenTaskRun,
  OPEN_TASK_RUN_STATUSES,
  TASK_LOG_LINES,
  TASK_MESSAGES,
  TASK_RUN_LABELS,
  TASK_RUNS_KEPT,
  type TaskRunAnswer,
  type TaskRunStatus,
  type TaskTrigger,
} from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import { HubStopping } from "../runners/hub.ts";
import { Cancelled, NotResumable, reasonOf, ServerOps } from "../service-runtime/server-ops.ts";
import type { ControlServices } from "../services.ts";
import { loadServiceRef, opsFor, runningContainer } from "./places.ts";
import type { TaskRow, TaskRunRow } from "./tables.ts";

/**
 * Task runs (spec 12.3): each run is a record with its status, times, exit code and the last
 * 1,000 lines of its log, carried out in the background by the `tasks.run` job on the task's
 * runner, on lanes of its own (R4-03). A run is queued until a task lane starts it. Stop kills
 * the run there; a run still open when the schedule comes due again makes that due time a
 * recorded skip. Each task keeps its newest 100 runs.
 */

export const RUN_JOB_KIND = "tasks.run";
/** A run longer than this is stopped (spec 12 gives no limit; this keeps a stuck run bounded). */
export const RUN_TIMEOUT_SECONDS = 6 * 3600;
/** Most of the log kept in the row, whatever the line count. */
const LOG_MAX_CHARS = 256 * 1024;
const FLUSH_MS = 1_000;
const STOP_POLL_MS = 2_000;

export interface TaskRunView {
  id: string;
  taskId: string;
  status: TaskRunStatus;
  statusLabel: string;
  trigger: TaskTrigger;
  dueAt: string | null;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  exitCode: number | null;
  error: string | null;
  open: boolean;
  logLines: number;
  logTruncated: boolean;
  /** The last 1,000 lines; only when asked for one run. */
  log?: string;
}

export function runView(row: TaskRunRow, withLog = false): TaskRunView {
  const started = new Date(row.started_at);
  const finished = row.finished_at ? new Date(row.finished_at) : null;
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    statusLabel: TASK_RUN_LABELS[row.status],
    trigger: row.trigger,
    dueAt: row.due_at ? new Date(row.due_at).toISOString() : null,
    startedAt: started.toISOString(),
    finishedAt: finished?.toISOString() ?? null,
    // A run that hasn't started yet has no duration: its wait isn't counted (C1-09).
    durationMs:
      row.status === "skipped" || row.status === "queued"
        ? null
        : (finished ?? new Date()).getTime() - started.getTime(),
    exitCode: row.exit_code,
    error: row.error,
    open: isOpenTaskRun(row.status),
    logLines: row.log_lines,
    logTruncated: row.log_truncated,
    ...(withLog ? { log: row.log } : {}),
  };
}

// ---- The log: the last 1,000 lines, written to the run's row about once a second

export class RunLog {
  readonly #db: Db;
  readonly #runId: string;
  #lines: string[] = [];
  #partial = "";
  #total = 0;
  #truncated = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  #dirty = false;

  constructor(db: Db, runId: string) {
    this.#db = db;
    this.#runId = runId;
  }

  /** Output from the runner, in any pieces. */
  output(text: string): void {
    if (!text) return;
    const parts = (this.#partial + text).split("\n");
    this.#partial = parts.pop() ?? "";
    for (const line of parts) this.#push(line);
    if (this.#partial.length > 16 * 1024) {
      this.#push(this.#partial);
      this.#partial = "";
    }
    this.#schedule();
  }

  /** A line of Nearzero's own. */
  line(text: string): void {
    if (this.#partial) {
      this.#push(this.#partial);
      this.#partial = "";
    }
    this.#push(text);
    this.#schedule();
  }

  #push(line: string): void {
    this.#total++;
    this.#lines.push(line);
    if (this.#lines.length > TASK_LOG_LINES) {
      this.#lines.splice(0, this.#lines.length - TASK_LOG_LINES);
      this.#truncated = true;
    }
    this.#dirty = true;
  }

  text(): string {
    const lines = this.#partial ? [...this.#lines, this.#partial] : this.#lines;
    let text = lines.join("\n");
    if (text.length > LOG_MAX_CHARS) {
      text = text.slice(text.length - LOG_MAX_CHARS);
      this.#truncated = true;
    }
    return text;
  }

  #schedule(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#writing = this.#writing.then(async () => {
      if (!this.#dirty && !this.#partial) return;
      this.#dirty = false;
      await this.#db
        .updateTable("task_run")
        .set({
          log: this.text(),
          log_lines: this.#total + (this.#partial ? 1 : 0),
          log_truncated: this.#truncated,
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", this.#runId)
        .execute()
        .catch(() => {});
    });
    await this.#writing;
  }
}

// ---- Starting and finishing

/** In-process switches for runs this process carries out (Stop reaches them at once). */
const running = new Map<string, AbortController>();

export function stopLocally(runId: string): boolean {
  const controller = running.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

export async function enqueueRunJob(db: Db, runId: string): Promise<number> {
  const queued = await new JobQueue(db, { workerId: "tasks" }).enqueue({
    kind: RUN_JOB_KIND,
    payload: { runId },
    maxAttempts: RUN_JOB_ATTEMPTS,
    idempotencyKey: `task-run:${runId}`,
  });
  await db.updateTable("task_run").set({ job_id: queued.id }).where("id", "=", runId).execute();
  return queued.id;
}

export async function finishRun(
  db: Db,
  runId: string,
  outcome: {
    status: Exclude<TaskRunStatus, "queued" | "running" | "skipped">;
    exitCode?: number | null;
    error?: string | null;
  },
): Promise<TaskRunRow | null> {
  const row = await db
    .updateTable("task_run")
    .set({
      status: outcome.status,
      exit_code: outcome.exitCode ?? null,
      error: outcome.error ? outcome.error.slice(0, 2000) : null,
      finished_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", runId)
    .where("status", "in", OPEN_TASK_RUN_STATUSES)
    .returningAll()
    .executeTakeFirst();
  if (row) await pruneRuns(db, row.task_id);
  return row ?? null;
}

/** Keeps a task's newest 100 runs. */
export async function pruneRuns(db: Db, taskId: string): Promise<number> {
  const result = await db
    .deleteFrom("task_run")
    .where("task_id", "=", taskId)
    .where("status", "not in", OPEN_TASK_RUN_STATUSES)
    .where(
      "id",
      "not in",
      db
        .selectFrom("task_run")
        .select("id")
        .where("task_id", "=", taskId)
        .orderBy("started_at", "desc")
        .orderBy("id", "desc")
        .limit(TASK_RUNS_KEPT),
    )
    .executeTakeFirst();
  return Number(result.numDeletedRows);
}

function outcomeOf(answer: TaskRunAnswer, stopRequested: boolean) {
  if (answer.stopped || stopRequested)
    return { status: "stopped" as const, exitCode: null, error: null };
  if (answer.timedOut) {
    return {
      status: "failed" as const,
      exitCode: null,
      error: `The run went on for more than ${RUN_TIMEOUT_SECONDS / 3600} hours, so it was stopped.`,
    };
  }
  if (answer.exitCode === 0) return { status: "succeeded" as const, exitCode: 0, error: null };
  return {
    status: "failed" as const,
    exitCode: answer.exitCode,
    error:
      answer.exitCode === null
        ? "The script ended without an exit code."
        : `The script exited with code ${answer.exitCode}.`,
  };
}

/** A run's job: its second attempt only follows the run after a restart (runTaskJob). */
export const RUN_JOB_ATTEMPTS = 2;

/** The key a run's script goes under on its runner, so a restart can follow it again (B2-20). */
export function runWorkKey(runId: string): string {
  return `task:${runId}`;
}

async function runOnce(
  services: ControlServices,
  log: Logger,
  runId: string,
  signal: AbortSignal,
  resume = false,
): Promise<void> {
  const { db } = services;
  const run = await beginRun(db, runId);
  if (!run) return;
  const task = await db
    .selectFrom("task")
    .selectAll()
    .where("id", "=", run.task_id)
    .executeTakeFirst();
  if (!task) {
    await finishRun(db, runId, { status: "failed", error: "The task was deleted." });
    return;
  }
  const runLog = new RunLog(db, runId);
  if (run.stop_requested_at) {
    runLog.line("Stopped before it started.");
    await runLog.flush();
    await finishRun(db, runId, { status: "stopped" });
    return;
  }
  const controller = new AbortController();
  running.set(runId, controller);
  const onJobAbort = () => controller.abort();
  signal.addEventListener("abort", onJobAbort, { once: true });
  const poll = setInterval(() => {
    void db
      .selectFrom("task_run")
      .select("stop_requested_at")
      .where("id", "=", runId)
      .executeTakeFirst()
      .then((row) => {
        if (row?.stop_requested_at) controller.abort();
      })
      .catch(() => {});
  }, STOP_POLL_MS);
  const target = await targetOf(services, task);
  let container: string | undefined;
  try {
    if (resume) {
      runLog.line("Nearzero restarted while this ran; following it again.");
    } else if (task.place === "container") {
      const service =
        task.service_id && task.workspace_id
          ? await loadServiceRef(db, task.workspace_id, task.service_id)
          : null;
      if (!service) throw new Error("The service was deleted.");
      const found = await runningContainer(
        opsFor(services, target),
        service.id,
        service.appName,
        task.inner_service,
      );
      if (!found)
        throw new Error(
          `${service.name} isn't running, so the task can't run in its container. Deploy or start it first.`,
        );
      container = found.id;
    }
    const ops = new ServerOps(services, target, controller.signal, { resume });
    // Stop also sends task.stop, in case the stream's close doesn't reach the runner. Not while
    // the control plane stops: the run goes on and is followed again (B2-20).
    controller.signal.addEventListener(
      "abort",
      () => {
        if (services.runners.stopping) return;
        void services.runners
          .command(target, "task.stop", {
            runId,
            place: task.place === "container" ? "container" : "server",
            ...(container ? { container } : {}),
          })
          .catch(() => {});
      },
      { once: true },
    );
    const answer = (await ops.stream(
      "task.run",
      {
        runId,
        place: task.place === "container" ? "container" : "server",
        ...(container ? { container } : {}),
        shell: task.shell,
        script: task.script,
        timeoutSeconds: RUN_TIMEOUT_SECONDS,
      },
      (text) => runLog.output(text),
      (RUN_TIMEOUT_SECONDS + 120) * 1000,
      { key: runWorkKey(runId) },
    )) as TaskRunAnswer;
    const stopRequested = controller.signal.aborted;
    const outcome = outcomeOf(answer, stopRequested);
    if (outcome.status === "stopped") runLog.line(TASK_MESSAGES.stopped);
    await runLog.flush();
    await finishRun(db, runId, outcome);
  } catch (error) {
    if (error instanceof HubStopping) {
      // The script goes on on its server; the job's next attempt follows it again.
      runLog.line("Nearzero is restarting; the run goes on and is followed again once it's back.");
      await runLog.flush();
      throw error;
    }
    await runLog.flush();
    if (error instanceof NotResumable) {
      runLog.line(TASK_MESSAGES.restarted);
      await runLog.flush();
      await finishRun(db, runId, { status: "failed", error: TASK_MESSAGES.restarted });
      return;
    }
    if (error instanceof Cancelled || controller.signal.aborted) {
      if (signal.aborted && !(await stopWasRequested(db, runId))) {
        runLog.line(TASK_MESSAGES.restarted);
        await runLog.flush();
        await finishRun(db, runId, { status: "failed", error: TASK_MESSAGES.restarted });
      } else {
        runLog.line(TASK_MESSAGES.stopped);
        await runLog.flush();
        await finishRun(db, runId, { status: "stopped" });
      }
      return;
    }
    const reason = reasonOf(error);
    runLog.line(`The run failed: ${reason}`);
    await runLog.flush();
    await finishRun(db, runId, { status: "failed", error: reason });
    log.info("a task run failed", { runId, reason });
  } finally {
    clearInterval(poll);
    signal.removeEventListener("abort", onJobAbort);
    running.delete(runId);
  }
}

async function stopWasRequested(db: Db, runId: string): Promise<boolean> {
  const row = await db
    .selectFrom("task_run")
    .select("stop_requested_at")
    .where("id", "=", runId)
    .executeTakeFirst();
  return Boolean(row?.stop_requested_at);
}

export async function targetOf(services: ControlServices, task: TaskRow): Promise<string> {
  if (task.place === "host") return "host";
  if (task.place === "server") return task.server_id ?? "host";
  const row = task.service_id
    ? await services.db
        .selectFrom("service")
        .select("server_id")
        .where("id", "=", task.service_id)
        .executeTakeFirst()
    : undefined;
  return row?.server_id ?? "host";
}

export function runTaskJob(services: ControlServices) {
  return defineJob({
    kind: RUN_JOB_KIND,
    payload: z.object({ runId: z.string().regex(/^[0-9a-f-]{36}$/) }),
    // A script never runs twice because the control plane stopped: the second attempt only
    // follows the run already going on its server, and marks it failed when the server no
    // longer has it (B2-20).
    maxAttempts: RUN_JOB_ATTEMPTS,
    // Task runs (up to 6 hours) have lanes of their own: they never hold a backup (R4-03, C1-09).
    lane: "task",
    retryDelayMs: () => 1_000,
    async run({ runId }, { log, signal, job }) {
      await runOnce(services, log, runId, signal, job.attempt > 1);
    },
  });
}

/**
 * A task lane took the run's job: a queued run is running from now, and its start time is now,
 * so neither the skip rule nor its duration counts its wait for a lane (C1-09). Returns the run
 * when it is running (a later attempt follows one already running), else null.
 */
export async function beginRun(db: Db, runId: string): Promise<TaskRunRow | null> {
  const began = await db
    .updateTable("task_run")
    .set({ status: "running", started_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("id", "=", runId)
    .where("status", "=", "queued")
    .returningAll()
    .executeTakeFirst();
  if (began) return began;
  const run = await db
    .selectFrom("task_run")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  return run?.status === "running" ? run : null;
}

/** Starts one run now (Run, or the Agent). Refuses while a run of the task is open. */
export async function startRun(
  db: Db,
  taskId: string,
  trigger: TaskTrigger,
  personId: string | null,
): Promise<TaskRunRow | null> {
  // The task's row is locked first, as the scheduler's tick locks it before it records a due
  // run: taken in the other order, a Run pressed while the tick records one deadlocks (the run's
  // foreign key waits for the tick's lock while the tick waits for the run's unique entry).
  return db.transaction().execute(async (trx) => {
    const task = await trx
      .selectFrom("task")
      .select("id")
      .where("id", "=", taskId)
      .forUpdate()
      .executeTakeFirst();
    if (!task) return null;
    const row = await trx
      .insertInto("task_run")
      .values({ task_id: taskId, trigger, requested_by: personId, status: "queued" })
      .onConflict((conflict) =>
        conflict.column("task_id").where("status", "in", OPEN_TASK_RUN_STATUSES).doNothing(),
      )
      .returningAll()
      .executeTakeFirst();
    if (!row) return null;
    const job = await enqueueRunJob(trx, row.id);
    return { ...row, job_id: job };
  });
}
