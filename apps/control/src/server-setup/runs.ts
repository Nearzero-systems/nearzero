import {
  AppError,
  isSshUser,
  SETUP_MESSAGES,
  SETUP_STALLED_MS,
  SETUP_STATE_LABELS,
  SETUP_STEPS,
  type SetupFailureView,
  type SetupRunView,
  type SetupStepView,
  type SetupView,
  SSH_USER_RULE,
  stateLine,
} from "@nearzero/shared";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { JobQueue } from "../jobs/queue.ts";
import { isOurId } from "../projects/objects.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { setupBus } from "./log.ts";
import type { SetupRunState, StoredStep } from "./tables.ts";

/**
 * Setup runs (spec 09 9.3): starting one, seeing the newest, and noticing one that stopped
 * responding. A run is a job, so the request that starts it returns at once (spec 23.1); the
 * dialog follows it through its log.
 *
 * Stalled: a run counts as stalled when nothing happened for 5 minutes (no log line and no
 * heartbeat; a working run beats every 30 seconds), or when its job is no longer queued or
 * running. Starting setup then retries it ("Previous setup looks stalled. Retrying…"); otherwise
 * it answers with the running one ("Setup is already running…").
 */

export const SETUP_JOB = "servers.setup";

export interface RunRow {
  id: string;
  server_id: string;
  workspace_id: string;
  state: SetupRunState;
  step: number | null;
  steps: StoredStep[];
  failure: unknown;
  retried_stalled: boolean;
  ssh_user: string;
  job_id: number | null;
  requested_by: string | null;
  log_seq: number;
  started_at: Date;
  last_activity_at: Date;
  finished_at: Date | null;
}

export const RUN_COLUMNS = [
  "id",
  "server_id",
  "workspace_id",
  "state",
  "step",
  "steps",
  "failure",
  "retried_stalled",
  "ssh_user",
  "job_id",
  "requested_by",
  "log_seq",
  "started_at",
  "last_activity_at",
  "finished_at",
] as const;

export function initialSteps(): StoredStep[] {
  return SETUP_STEPS.map(() => ({ state: "waiting", note: null }));
}

function stepViews(row: Pick<RunRow, "steps">): SetupStepView[] {
  const stored = Array.isArray(row.steps) ? row.steps : [];
  return SETUP_STEPS.map((title, index) => ({
    number: index + 1,
    title,
    state: stored[index]?.state ?? "waiting",
    note: stored[index]?.note ?? null,
  }));
}

export function failureOf(value: unknown): SetupFailureView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<SetupFailureView>;
  if (typeof raw.message !== "string" || typeof raw.kind !== "string") return null;
  return {
    kind: raw.kind,
    message: raw.message,
    hints: Array.isArray(raw.hints) ? raw.hints.filter((hint) => typeof hint === "string") : [],
    suggestedUser: typeof raw.suggestedUser === "string" ? raw.suggestedUser : null,
    fixCommand: typeof raw.fixCommand === "string" ? raw.fixCommand : null,
    presentedFingerprint:
      typeof raw.presentedFingerprint === "string" ? raw.presentedFingerprint : null,
  };
}

export function runView(row: RunRow): SetupRunView {
  const step = row.step ?? null;
  const title = step ? (SETUP_STEPS[step - 1] ?? null) : null;
  const state = row.state === "succeeded" ? "ready" : row.state;
  return {
    id: row.id,
    state: row.state,
    step,
    stepTitle: title,
    steps: stepViews(row),
    stateLine: stateLine(state, step, title),
    failure: failureOf(row.failure),
    retriedStalled: row.retried_stalled,
    startedAt: row.started_at.toISOString(),
    lastActivityAt: row.last_activity_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
    logSeq: row.log_seq,
  };
}

export async function latestRun(db: Db, serverId: string): Promise<RunRow | undefined> {
  return (await db
    .selectFrom("server_setup_run")
    .select(RUN_COLUMNS)
    .where("server_id", "=", serverId)
    .orderBy("started_at", "desc")
    .limit(1)
    .executeTakeFirst()) as RunRow | undefined;
}

export async function loadRun(db: Db, runId: string): Promise<RunRow | undefined> {
  return (await db
    .selectFrom("server_setup_run")
    .select(RUN_COLUMNS)
    .where("id", "=", runId)
    .executeTakeFirst()) as RunRow | undefined;
}

async function jobIsAlive(db: Db, jobId: number | null): Promise<boolean> {
  if (jobId === null) return false;
  const job = await db.selectFrom("job").select("state").where("id", "=", jobId).executeTakeFirst();
  return job?.state === "queued" || job?.state === "running";
}

/** True when a running run stopped responding (see the module comment). */
export async function isStalled(db: Db, row: RunRow, now = Date.now()): Promise<boolean> {
  if (row.state !== "running") return false;
  if (now - row.last_activity_at.getTime() > SETUP_STALLED_MS) return true;
  // A run carried out inside another job (the move from 0.1.x sets its servers up itself) has
  // no job of its own: it is alive while it beats, so a setup started from the console or the
  // Agent waits for it instead of running beside it (C2-23).
  if (row.job_id === null) return false;
  return !(await jobIsAlive(db, row.job_id));
}

export const STALLED_FAILURE: SetupFailureView = {
  kind: "stalled",
  message:
    "Setup stopped responding (Nearzero may have restarted, or the server went quiet), so it was retried.",
  hints: [],
  suggestedUser: null,
  fixCommand: null,
  presentedFingerprint: null,
};

interface ServerRow {
  id: string;
  name: string;
  address: string;
  port: number;
  ssh_user: string;
  setup_state: "not_started" | "running" | "ready" | "failed";
  host_key_fingerprint: string | null;
}

async function serverRow(
  db: Db,
  workspaceId: string,
  serverId: string,
  lock = false,
): Promise<ServerRow> {
  if (serverId === HOST_TARGET)
    throw new AppError("invalid_request", SETUP_MESSAGES.hostOpensDetails);
  if (!isOurId(serverId)) throw notFound();
  let query = db
    .selectFrom("server")
    .select(["id", "name", "address", "port", "ssh_user", "setup_state", "host_key_fingerprint"])
    .where("id", "=", serverId)
    .where("workspace_id", "=", workspaceId);
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw notFound();
  return row;
}

function notFound(): AppError {
  return new AppError(
    "not_found",
    "This server doesn't exist in this workspace, or you don't have access to it.",
  );
}

export async function setupView(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
  notice: string | null = null,
): Promise<SetupView> {
  if (serverId === HOST_TARGET)
    throw new AppError("invalid_request", SETUP_MESSAGES.hostOpensDetails);
  await actor.access.require("server.see", { kind: "server", id: serverId });
  const server = await serverRow(services.db, actor.workspace.id, serverId);
  const run = await latestRun(services.db, serverId);
  let shownNotice = notice;
  if (shownNotice === null && run?.state === "running") {
    shownNotice = (await isStalled(services.db, run))
      ? SETUP_MESSAGES.stalledRetrying
      : SETUP_MESSAGES.alreadyRunning;
  }
  return {
    server: {
      id: server.id,
      name: server.name,
      target: `${server.ssh_user}@${server.address}:${server.port}`,
      setupState: server.setup_state,
      setupStateLabel: SETUP_STATE_LABELS[server.setup_state],
      hostKeyFingerprint: server.host_key_fingerprint,
    },
    run: run ? runView(run) : null,
    notice: shownNotice,
    canManage: actor.access.can("server.manage", { kind: "server", id: serverId }),
  };
}

export interface StartResult {
  view: SetupView;
  started: boolean;
}

/**
 * Starts setup on a server, or answers with the run already going. `sshUser` changes the
 * server's SSH user first (the wrong-user button: "Use <user> and run setup again").
 */
export async function startSetup(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
  input: { sshUser?: string } = {},
): Promise<StartResult> {
  if (serverId === HOST_TARGET)
    throw new AppError("invalid_request", SETUP_MESSAGES.hostOpensDetails);
  await actor.access.require("server.manage", { kind: "server", id: serverId });
  if (input.sshUser !== undefined && !isSshUser(input.sshUser.trim())) {
    throw new AppError("invalid_request", SSH_USER_RULE, { fields: { sshUser: SSH_USER_RULE } });
  }
  const { db } = services;
  const outcome = await db.transaction().execute(async (trx) => {
    const server = await serverRow(trx, actor.workspace.id, serverId, true);
    const running = await latestRun(trx, serverId);
    let retried = false;
    if (running?.state === "running") {
      if (!(await isStalled(trx, running))) {
        return { started: false as const, notice: SETUP_MESSAGES.alreadyRunning };
      }
      await trx
        .updateTable("server_setup_run")
        .set({ state: "failed", failure: JSON.stringify(STALLED_FAILURE), finished_at: new Date() })
        .where("id", "=", running.id)
        .execute();
      retried = true;
    }
    const user = input.sshUser?.trim() ?? server.ssh_user;
    if (user !== server.ssh_user) {
      await trx
        .updateTable("server")
        .set({ ssh_user: user, updated_at: new Date() })
        .where("id", "=", serverId)
        .execute();
      await recordAudit(trx, services.log, auditActor(actor), {
        action: "server.updated",
        workspaceId: actor.workspace.id,
        target: { kind: "server", id: serverId },
        details: { ssh_user: user, reason: "the server asked for this user" },
      });
    }
    const run = await trx
      .insertInto("server_setup_run")
      .values({
        server_id: serverId,
        workspace_id: actor.workspace.id,
        steps: JSON.stringify(initialSteps()),
        retried_stalled: retried,
        ssh_user: user,
        requested_by: actor.personId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const queue = new JobQueue(trx, { workerId: "control-api" });
    const job = await queue.enqueue({
      kind: SETUP_JOB,
      payload: { runId: run.id },
      maxAttempts: 2,
      idempotencyKey: `server-setup:${run.id}`,
    });
    await trx
      .updateTable("server_setup_run")
      .set({ job_id: job.id })
      .where("id", "=", run.id)
      .execute();
    await trx
      .updateTable("server")
      .set({
        setup_state: "running",
        setup_error: null,
        setup_started_at: new Date(),
        updated_at: new Date(),
      })
      .where("id", "=", serverId)
      .execute();
    await recordAudit(trx, services.log, auditActor(actor), {
      action: "server.setup-started",
      workspaceId: actor.workspace.id,
      target: { kind: "server", id: serverId },
      details: { runId: run.id, user, retriedStalled: retried },
    });
    return {
      started: true as const,
      runId: run.id,
      notice: retried ? SETUP_MESSAGES.stalledRetrying : null,
    };
  });
  if (outcome.started) setupBus.emit(serverId, { type: "run", runId: outcome.runId });
  return {
    view: await setupView(services, actor, serverId, outcome.notice),
    started: outcome.started,
  };
}

/** Moves a run's last activity forward (its heartbeat while a long step works). */
export async function touchRun(db: Db, runId: string): Promise<void> {
  await db
    .updateTable("server_setup_run")
    .set({ last_activity_at: new Date() })
    .where("id", "=", runId)
    .where("state", "=", "running")
    .execute();
}
