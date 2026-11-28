import {
  AppError,
  BACKUP_RUN_LABELS,
  type BackupRunStatus,
  RESTORE_RUN_LABELS,
} from "@nearzero/shared";
import { type Selectable, sql, type Transaction } from "kysely";
import type { Db } from "../db/database.ts";
import type { Database } from "../db/schema.ts";
import { JobQueue } from "../jobs/queue.ts";
import type { BackupOperation, BackupRunTable, BackupTrigger } from "./tables.ts";

/**
 * Backup and restore runs (spec 08 8.3, 17.2, 23.1): every run is a record with a log, started
 * in the background. Two runs of one schedule never overlap: a new one replaces a waiting one
 * (which is cancelled) and waits behind a running one, which hands over when it ends. One
 * restore at a time goes into a service. Unique indexes in migration 0300 back these rules up.
 */

export const RUN_JOB_KIND = "backups.run";
/** Each service keeps its newest runs and their logs. */
export const RUNS_KEPT_PER_SERVICE = 100;
/** Runs of deleted services are kept this long. */
export const ORPHAN_RUNS_KEPT_DAYS = 30;

export type RunRow = Selectable<BackupRunTable>;

export interface RunView {
  id: string;
  operation: BackupOperation;
  kind: "database" | "volume";
  status: BackupRunStatus;
  statusLabel: string;
  trigger: BackupTrigger;
  scheduleId: string | null;
  service: { id: string | null; name: string };
  destination: { id: string | null; name: string };
  database: string | null;
  volume: string | null;
  file: { key: string; name: string; sizeBytes: number | null } | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  log: { lines: number; bytes: number };
  /** Still queued or running. */
  open: boolean;
}

export function runView(row: RunRow): RunView {
  const labels = row.operation === "restore" ? RESTORE_RUN_LABELS : BACKUP_RUN_LABELS;
  const started = row.started_at ? new Date(row.started_at) : null;
  const finished = row.finished_at ? new Date(row.finished_at) : null;
  return {
    id: row.id,
    operation: row.operation,
    kind: row.kind,
    status: row.status,
    statusLabel: labels[row.status],
    trigger: row.trigger,
    scheduleId: row.schedule_id,
    service: { id: row.service_id, name: row.service_name },
    destination: { id: row.destination_id, name: row.destination_name },
    database: row.database_name,
    volume: row.volume_name,
    file: row.file_key
      ? {
          key: row.file_key,
          name: row.file_key.split("/").at(-1) ?? row.file_key,
          sizeBytes: row.size_bytes,
        }
      : null,
    error: row.error,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: started?.toISOString() ?? null,
    finishedAt: finished?.toISOString() ?? null,
    durationMs: started ? (finished ?? new Date()).getTime() - started.getTime() : null,
    log: { lines: row.log_lines, bytes: row.log_bytes },
    open: row.status === "queued" || row.status === "running",
  };
}

// ---- Live updates, in this process (one control plane runs per install)

export type RunEvent =
  | { type: "log"; seq: number; text: string }
  | { type: "status"; run: RunView };

type RunListener = (event: RunEvent) => void;
type ServiceListener = (run: RunView) => void;

class RunBus {
  readonly #runs = new Map<string, Set<RunListener>>();
  readonly #services = new Map<string, Set<ServiceListener>>();

  subscribe(runId: string, listener: RunListener): () => void {
    return add(this.#runs, runId, listener);
  }

  /** Status changes of every run of one service (the Backups tab's rows). */
  subscribeService(serviceId: string, listener: ServiceListener): () => void {
    return add(this.#services, serviceId, listener);
  }

  emit(runId: string, serviceId: string | null, event: RunEvent): void {
    for (const listener of [...(this.#runs.get(runId) ?? [])]) safely(() => listener(event));
    if (event.type !== "status" || !serviceId) return;
    for (const listener of [...(this.#services.get(serviceId) ?? [])]) {
      safely(() => listener(event.run));
    }
  }
}

function add<T>(map: Map<string, Set<T>>, key: string, listener: T): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set?.size === 0) map.delete(key);
  };
}

function safely(run: () => void): void {
  try {
    run();
  } catch {
    // One viewer's failure never stops the others.
  }
}

export const runBus = new RunBus();

export async function publishStatus(db: Db, runId: string): Promise<RunView | null> {
  const row = await db
    .selectFrom("backup_run")
    .selectAll()
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!row) return null;
  const view = runView(row);
  runBus.emit(runId, row.service_id, { type: "status", run: view });
  return view;
}

// ---- The log

const FLUSH_MS = 200;
const PIECE_BYTES = 64 * 1024;
/** Output from the runner is capped per run; the run's own lines are always kept. */
export const RUN_LOG_OUTPUT_CAP_BYTES = 2 * 1024 * 1024;

export class RunLog {
  readonly runId: string;
  readonly #db: Db;
  readonly #serviceId: string | null;
  #seq = 0;
  #bytes = 0;
  #lines = 0;
  #outputBytes = 0;
  #capped = false;
  #pending = "";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  #tail = "";
  #hidden: string[] = [];

  private constructor(db: Db, runId: string, serviceId: string | null) {
    this.#db = db;
    this.runId = runId;
    this.#serviceId = serviceId;
  }

  static async open(db: Db, run: Pick<RunRow, "id" | "service_id">): Promise<RunLog> {
    const log = new RunLog(db, run.id, run.service_id);
    const last = await db
      .selectFrom("backup_run_log")
      .select((eb) => eb.fn.max<number>("seq").as("seq"))
      .where("run_id", "=", run.id)
      .executeTakeFirst();
    const counts = await db
      .selectFrom("backup_run")
      .select(["log_bytes", "log_lines"])
      .where("id", "=", run.id)
      .executeTakeFirst();
    log.#seq = Number(last?.seq ?? 0);
    log.#bytes = counts?.log_bytes ?? 0;
    log.#lines = counts?.log_lines ?? 0;
    return log;
  }

  /** A line of the run's own; always kept. */
  line(text: string): void {
    this.#append(`${this.#redact(text).replace(/\n+$/, "")}\n`);
  }

  /**
   * Values cut out of everything written from now on (keys, passwords), as a second guard
   * behind the runner's own redaction (spec 23.4).
   */
  hide(values: readonly (string | null | undefined)[]): void {
    for (const value of values) {
      if (value && value.length >= 4 && !this.#hidden.includes(value)) this.#hidden.push(value);
    }
    this.#hidden.sort((a, b) => b.length - a.length);
  }

  #redact(text: string): string {
    let out = text;
    for (const value of this.#hidden) out = out.split(value).join("[redacted]");
    return out;
  }

  /** Output from the runner; kept up to the cap. */
  output(raw: string): void {
    if (raw === "" || this.#capped) return;
    const text = this.#redact(raw);
    this.#outputBytes += Buffer.byteLength(text);
    if (this.#outputBytes > RUN_LOG_OUTPUT_CAP_BYTES) {
      this.#capped = true;
      this.#append("\n… This log keeps the first 2 MB of output; the rest is not stored.\n");
      return;
    }
    this.#append(text);
  }

  get tail(): string {
    return this.#tail;
  }

  #append(text: string): void {
    this.#pending += text;
    this.#tail = (this.#tail + text).slice(-8 * 1024);
    if (Buffer.byteLength(this.#pending) >= PIECE_BYTES) {
      void this.flush();
      return;
    }
    this.#timer ??= setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, FLUSH_MS);
  }

  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const text = this.#pending;
    this.#pending = "";
    if (text !== "") {
      const seq = ++this.#seq;
      this.#bytes += Buffer.byteLength(text);
      this.#lines += (text.match(/\n/g) ?? []).length;
      const bytes = this.#bytes;
      const lines = this.#lines;
      this.#writing = this.#writing.then(async () => {
        try {
          await this.#db
            .insertInto("backup_run_log")
            .values({ run_id: this.runId, seq, text })
            .execute();
          await this.#db
            .updateTable("backup_run")
            .set({ log_bytes: bytes, log_lines: lines })
            .where("id", "=", this.runId)
            .execute();
          runBus.emit(this.runId, this.#serviceId, { type: "log", seq, text });
        } catch {
          // The run may have been pruned meanwhile.
        }
      });
    }
    return this.#writing;
  }
}

export async function readRunLog(
  db: Db,
  runId: string,
  afterSeq = 0,
): Promise<{ seq: number; text: string }[]> {
  return db
    .selectFrom("backup_run_log")
    .select(["seq", "text"])
    .where("run_id", "=", runId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .execute();
}

// ---- Requesting runs

type Trx = Transaction<Database>;

export interface NewRun {
  workspaceId: string;
  scheduleId: string | null;
  serviceId: string;
  operation: BackupOperation;
  kind: "database" | "volume";
  serviceKind: string;
  serviceName: string;
  appName: string;
  projectName: string;
  environmentName: string;
  serverId: string | null;
  destinationId: string;
  destinationName: string;
  databaseName: string | null;
  /** Restores: the database the file was dumped from, when known. */
  sourceDatabase?: string | null;
  volumeName: string | null;
  fileKey: string | null;
  trigger: BackupTrigger;
  dueAt: Date | null;
  requestedBy: string | null;
  /** The request's Idempotency-Key, when it sent one. */
  requestKey?: string | null;
  /**
   * The run stops the service (a volume backup that stops it while copying) or restores into
   * it: it never runs beside another such run of the same service (R3-48).
   */
  exclusive?: boolean;
}

export interface RequestedRun {
  run: RunRow;
  /** A waiting run was cancelled in favour of this one. */
  replaced: boolean;
  /** This run waits for a running one of the same schedule. */
  waiting: boolean;
}

/**
 * Puts a run's job in the queue, once per reason (the key names the run and why: its request, a
 * hand-over from the run before it, or the scheduler's recovery). Two jobs for one run are
 * harmless: only one can move it from queued to running.
 */
export async function enqueueRunJob(
  db: Db | Trx,
  runId: string,
  reason = "request",
): Promise<number> {
  const queue = new JobQueue(db as Db, { workerId: "backups" });
  const job = await queue.enqueue({
    kind: RUN_JOB_KIND,
    payload: { runId },
    maxAttempts: 2,
    idempotencyKey: `${RUN_JOB_KIND}:${runId}:${reason}`,
  });
  await db.updateTable("backup_run").set({ job_id: job.id }).where("id", "=", runId).execute();
  return job.id;
}

/**
 * Adds a run of a schedule (scheduled or Run now) under the overlap rules: a waiting run of the
 * same schedule is cancelled and replaced; a running one is never touched, and this one waits.
 * Call inside a transaction; the schedule row is locked for the duration.
 */
export async function requestScheduleRun(trx: Trx, input: NewRun): Promise<RequestedRun> {
  if (!input.scheduleId) throw new Error("A schedule run needs its schedule.");
  await trx
    .selectFrom("backup_schedule")
    .select("id")
    .where("id", "=", input.scheduleId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const cancelled = await trx
    .updateTable("backup_run")
    .set({
      status: "cancelled",
      error: "Replaced by a newer run of this schedule.",
      finished_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("schedule_id", "=", input.scheduleId)
    .where("status", "=", "queued")
    .returning("id")
    .execute();
  const running = await trx
    .selectFrom("backup_run")
    .select("id")
    .where("schedule_id", "=", input.scheduleId)
    .where("status", "=", "running")
    .executeTakeFirst();
  const run = await insertRun(trx, input);
  if (!running) await enqueueRunJob(trx, run.id);
  return { run, replaced: cancelled.length > 0, waiting: running !== undefined };
}

/** Adds a restore; refused while another restore of the service is open. */
export async function requestRestoreRun(db: Db, input: NewRun): Promise<RunRow> {
  try {
    return await db.transaction().execute(async (trx) => {
      const run = await insertRun(trx, input);
      await enqueueRunJob(trx, run.id);
      return run;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AppError(
        "conflict",
        "A restore of this service is already running. Wait for it to finish.",
      );
    }
    throw error;
  }
}

async function insertRun(trx: Trx, input: NewRun): Promise<RunRow> {
  return trx
    .insertInto("backup_run")
    .values({
      workspace_id: input.workspaceId,
      schedule_id: input.scheduleId,
      service_id: input.serviceId,
      operation: input.operation,
      kind: input.kind,
      service_kind: input.serviceKind,
      service_name: input.serviceName,
      app_name: input.appName,
      project_name: input.projectName,
      environment_name: input.environmentName,
      server_id: input.serverId,
      destination_id: input.destinationId,
      destination_name: input.destinationName,
      database_name: input.databaseName,
      source_database: input.sourceDatabase ?? null,
      volume_name: input.volumeName,
      file_key: input.fileKey,
      trigger: input.trigger,
      due_at: input.dueAt,
      requested_by: input.requestedBy,
      request_key: input.requestKey ?? null,
      exclusive: input.exclusive ?? false,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * Whether this run must wait for another run of the same service (R3-48, C1-11): a run that stops
 * the service or restores into it waits while any other run of the service is going (a restore
 * never empties a volume a backup is still reading), and any run waits while such a run is going.
 * Call in the claim's transaction after locking the service's row.
 */
async function serviceBusy(
  trx: Trx,
  serviceId: string,
  runId: string,
  exclusive: boolean,
): Promise<boolean> {
  let query = trx
    .selectFrom("backup_run")
    .select("id")
    .where("service_id", "=", serviceId)
    .where("status", "=", "running")
    .where("id", "!=", runId);
  if (!exclusive) query = query.where("exclusive", "=", true);
  return (await query.executeTakeFirst()) !== undefined;
}

/**
 * Moves a queued run to running, unless it was cancelled meanwhile, another run of its schedule
 * is still running, or (for a run that stops the service or restores into it) another such run
 * of the same service is (R3-48). Returns the running row, or null when there is nothing to do.
 */
export async function claimRun(db: Db, runId: string): Promise<RunRow | "wait" | null> {
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("backup_run")
      .select(["id", "schedule_id", "status", "service_id", "exclusive"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (row?.status !== "queued") return null;
    if (row.service_id) {
      // One claim at a time per service, so two runs can't both see the other as waiting.
      await trx
        .selectFrom("service")
        .select("id")
        .where("id", "=", row.service_id)
        .forUpdate()
        .executeTakeFirst();
      if (await serviceBusy(trx, row.service_id, row.id, row.exclusive)) return "wait" as const;
    }
    if (row.schedule_id) {
      await trx
        .selectFrom("backup_schedule")
        .select("id")
        .where("id", "=", row.schedule_id)
        .forUpdate()
        .executeTakeFirst();
      const running = await trx
        .selectFrom("backup_run")
        .select("id")
        .where("schedule_id", "=", row.schedule_id)
        .where("status", "=", "running")
        .executeTakeFirst();
      if (running) return "wait" as const;
    }
    const claimed = await trx
      .updateTable("backup_run")
      .set({ status: "running", started_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where("id", "=", runId)
      .where("status", "=", "queued")
      .returningAll()
      .executeTakeFirst();
    return claimed ?? null;
  });
}

export interface RunOutcome {
  status: "succeeded" | "failed";
  error?: string | null;
  fileKey?: string | null;
  sizeBytes?: number | null;
}

/**
 * Records how a run ended, then starts the run waiting behind it on the same schedule. Only a
 * running run can end, so a repeated call changes nothing.
 */
export async function finishRun(
  db: Db,
  runId: string,
  outcome: RunOutcome,
): Promise<RunRow | null> {
  const row = await db
    .updateTable("backup_run")
    .set({
      status: outcome.status,
      error: outcome.error ?? null,
      ...(outcome.fileKey === undefined ? {} : { file_key: outcome.fileKey }),
      ...(outcome.sizeBytes === undefined ? {} : { size_bytes: outcome.sizeBytes }),
      finished_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", runId)
    .where("status", "=", "running")
    .returningAll()
    .executeTakeFirst();
  if (row?.schedule_id) await handOver(db, row.schedule_id, row.id);
  if (row?.service_id) await handOverService(db, row.service_id, row.id);
  return row ?? null;
}

/** Starts the waiting run of a schedule, if one waits and none runs. */
export async function handOver(db: Db, scheduleId: string, after = ""): Promise<void> {
  const waiting = await db
    .selectFrom("backup_run")
    .select("id")
    .where("schedule_id", "=", scheduleId)
    .where("status", "=", "queued")
    .executeTakeFirst();
  if (!waiting) return;
  await enqueueRunJob(db, waiting.id, after ? `handover:${after}` : "handover");
}

/**
 * When a run of a service ends, the runs waiting for the service try again (R3-48, C1-11), oldest
 * first; each waits again if another run still keeps it waiting.
 */
export async function handOverService(db: Db, serviceId: string, after: string): Promise<void> {
  const waiting = await db
    .selectFrom("backup_run")
    .select("id")
    .where("service_id", "=", serviceId)
    .where("status", "=", "queued")
    .orderBy("created_at")
    .limit(20)
    .execute();
  for (const run of waiting) await enqueueRunJob(db, run.id, `service-handover:${after}`);
}

/** Cancels the waiting runs of a schedule (it is being deleted). */
export async function cancelWaitingRuns(trx: Db | Trx, scheduleId: string): Promise<string[]> {
  const rows = await trx
    .updateTable("backup_run")
    .set({
      status: "cancelled",
      error: "The schedule was deleted.",
      finished_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("schedule_id", "=", scheduleId)
    .where("status", "=", "queued")
    .returning("id")
    .execute();
  return rows.map((row) => row.id);
}

/** The latest run of each schedule, and any open one. */
export async function latestRuns(
  db: Db,
  scheduleIds: string[],
): Promise<Map<string, { last: RunRow | null; open: RunRow | null }>> {
  const result = new Map<string, { last: RunRow | null; open: RunRow | null }>();
  if (scheduleIds.length === 0) return result;
  const rows = await db
    .selectFrom("backup_run")
    .selectAll()
    .where("schedule_id", "in", scheduleIds)
    .where("operation", "=", "backup")
    .where((eb) =>
      eb.or([
        eb("status", "in", ["queued", "running"]),
        eb(
          "id",
          "in",
          eb
            .selectFrom("backup_run as latest")
            .select("latest.id")
            .where("latest.schedule_id", "in", scheduleIds)
            .where("latest.status", "not in", ["queued", "running", "cancelled"])
            .distinctOn("latest.schedule_id")
            .orderBy("latest.schedule_id")
            .orderBy("latest.created_at", "desc"),
        ),
      ]),
    )
    .execute();
  for (const id of scheduleIds) result.set(id, { last: null, open: null });
  for (const row of rows) {
    const entry = result.get(row.schedule_id as string);
    if (!entry) continue;
    if (row.status === "queued" || row.status === "running") {
      // Running wins over the one waiting behind it.
      if (!entry.open || row.status === "running") entry.open = row;
    } else {
      entry.last = row;
    }
  }
  return result;
}

/** Removes runs beyond each service's newest, and old runs of deleted services. */
export async function pruneRuns(db: Db): Promise<number> {
  const beyond = await db
    .deleteFrom("backup_run")
    .where("id", "in", (eb) =>
      eb
        .selectFrom(
          eb
            .selectFrom("backup_run")
            .select([
              "id",
              "status",
              sql<number>`row_number() over (partition by service_id order by created_at desc)`.as(
                "rank",
              ),
            ])
            .where("service_id", "is not", null)
            .as("ranked"),
        )
        .select("ranked.id")
        .where("ranked.rank", ">", RUNS_KEPT_PER_SERVICE)
        .where("ranked.status", "not in", ["queued", "running"]),
    )
    .executeTakeFirst();
  const orphans = await db
    .deleteFrom("backup_run")
    .where("service_id", "is", null)
    .where(
      "created_at",
      "<",
      sql<Date>`now() - make_interval(days => ${ORPHAN_RUNS_KEPT_DAYS}::integer)`,
    )
    .executeTakeFirst();
  return Number(beyond.numDeletedRows) + Number(orphans.numDeletedRows);
}
