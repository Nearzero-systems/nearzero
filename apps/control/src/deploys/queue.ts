import {
  AppError,
  type DeployTrigger,
  HOST_SERVER_ID,
  isDatabaseKind,
  type ServiceKind,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import { JobQueue } from "../jobs/queue.ts";
import { silentLogger } from "../log.ts";
import { emitDeployEvent } from "../notifications/emit.ts";
import { HOST_NAME } from "../servers/targets.ts";
import { readAppSettings } from "../service-runtime/app-settings.ts";
import { deployBus } from "./log.ts";
import { DEPLOYMENT_COLUMNS, type DeploymentRow } from "./records.ts";

/**
 * The deploy queue of each service (spec 6.5, 6.6, 23.1 "Pushes are never lost"): exactly one
 * deploy runs at a time, at most one waits. A request while one waits replaces the waiting one
 * (it takes the newer commit and trigger); a request while one runs queues one more after it.
 * The database backs this with unique indexes, and every decision is made under a lock on the
 * service's row, so racing requests and several control-plane processes agree.
 *
 * A deployment runs as the job "deploys.run"; when it ends it starts the next waiting one.
 */

export const RUN_DEPLOY_JOB = "deploys.run";

export interface DeployRequest {
  serviceId: string;
  workspaceId: string;
  trigger: DeployTrigger;
  requestedBy: string | null;
  title?: string;
  commit?: string | null;
  tag?: string | null;
  cleanCache?: boolean;
}

export interface DeployRequestResult {
  deployment: DeploymentRow;
  /** The request replaced a deployment that was waiting. */
  replaced: boolean;
  /** It waits behind a running deployment. */
  waiting: boolean;
  /**
   * A Redeploy or Reload found a deploy already waiting and left it as it was: that one runs
   * next with newer code and the saved settings anyway (30b R2-02, R2-09).
   */
  kept?: boolean;
}

export const DELETING_REFUSAL = "This service is being deleted, so it can't be deployed.";

function defaultTitle(trigger: DeployTrigger): string {
  switch (trigger) {
    case "manual":
      return "Manual deployment";
    case "agent":
      return "Deploy by the Agent";
    case "webhook":
      return "Webhook deploy";
    case "push":
      return "Push deploy";
    case "tag":
      return "Tag deploy";
    case "redeploy":
      return "Redeploy";
    case "reload":
      return "Reload";
  }
}

/** Gives a deployment a job, unless one is already waiting or running for it. */
export async function enqueueRun(db: Db, deploymentId: string): Promise<number | null> {
  // The check and the insert are one step: the deployment's row is locked meanwhile, so two
  // callers at once (a deploy ending while the queue's recovery runs, say) never give one
  // deployment two jobs.
  return db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("deployment")
      .select(["id", "status"])
      .where("id", "=", deploymentId)
      .forUpdate()
      .executeTakeFirst();
    if (row?.status !== "queued") return null;
    const pending = await trx
      .selectFrom("job")
      .select("id")
      .where("kind", "=", RUN_DEPLOY_JOB)
      .where("idempotency_key", "like", `deploy:${deploymentId}:%`)
      .where("state", "in", ["queued", "running"])
      .executeTakeFirst();
    if (pending) return pending.id;
    const queue = new JobQueue(trx, { workerId: "control-api" });
    const job = await queue.enqueue({
      kind: RUN_DEPLOY_JOB,
      payload: { deploymentId },
      maxAttempts: 3,
      idempotencyKey: `deploy:${deploymentId}:${Date.now()}`,
    });
    await trx
      .updateTable("deployment")
      .set({ job_id: job.id })
      .where("id", "=", deploymentId)
      .execute();
    return job.id;
  });
}

/** Asks for a deploy of a service. */
export async function requestDeploy(db: Db, request: DeployRequest): Promise<DeployRequestResult> {
  const result = await db.transaction().execute(async (trx) => {
    const service = await trx
      .selectFrom("service as s")
      .innerJoin("environment as e", "e.id", "s.environment_id")
      .innerJoin("project as p", "p.id", "s.project_id")
      .select([
        "s.id",
        "s.workspace_id",
        "s.project_id",
        "s.environment_id",
        "s.kind",
        "s.name",
        "s.app_name",
        "s.server_id",
        "s.deleting_run_id",
        "e.name as environment_name",
        "p.name as project_name",
      ])
      .where("s.id", "=", request.serviceId)
      .where("s.workspace_id", "=", request.workspaceId)
      .forUpdate("s")
      .executeTakeFirst();
    if (!service) {
      throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
    }
    if (service.deleting_run_id) throw new AppError("conflict", DELETING_REFUSAL);
    const open = await trx
      .selectFrom("deployment as d")
      .select(DEPLOYMENT_COLUMNS)
      .where("d.service_id", "=", service.id)
      .where("d.status", "in", ["queued", "building"])
      .execute();
    const waiting = open.find((row) => row.status === "queued");
    const running = open.find((row) => row.status === "building");
    // Redeploy and Reload rebuild or restart what runs: a waiting deploy (a push, say) is never
    // turned into one of them, so its newer commit isn't lost.
    if (waiting && (request.trigger === "redeploy" || request.trigger === "reload")) {
      return { deployment: waiting, replaced: false, waiting: true, enqueue: false, kept: true };
    }
    // Still waiting when it is replaced: a cancel that landed meanwhile leaves it cancelled, and
    // this request becomes a deployment of its own instead of disappearing into it (23.1).
    const updated = waiting
      ? await trx
          .updateTable("deployment")
          .set({
            trigger: request.trigger,
            requested_by: request.requestedBy,
            title: request.title ?? defaultTitle(request.trigger),
            requested_commit: request.commit ?? null,
            requested_tag: request.tag ?? null,
            clean_cache: waiting.clean_cache || request.cleanCache === true,
            updated_at: new Date(),
          })
          .where("id", "=", waiting.id)
          .where("status", "=", "queued")
          .returning(DEPLOYMENT_COLUMNS.map((column) => column.slice(2) as never))
          .executeTakeFirst()
      : undefined;
    if (updated) {
      return {
        deployment: updated as unknown as DeploymentRow,
        replaced: true,
        waiting: true,
        enqueue: false,
      };
    }
    let serverName = HOST_NAME;
    if (service.server_id) {
      const server = await trx
        .selectFrom("server")
        .select("name")
        .where("id", "=", service.server_id)
        .executeTakeFirst();
      serverName = server?.name ?? "server";
    }
    const inserted = await trx
      .insertInto("deployment")
      .values({
        workspace_id: service.workspace_id,
        service_id: service.id,
        project_id: service.project_id,
        environment_id: service.environment_id,
        service_kind: service.kind,
        service_name: service.name,
        app_name: service.app_name,
        project_name: service.project_name,
        environment_name: service.environment_name,
        server_id: service.server_id,
        server_name: serverName,
        trigger: request.trigger,
        requested_by: request.requestedBy,
        title: request.title ?? defaultTitle(request.trigger),
        requested_commit: request.commit ?? null,
        requested_tag: request.tag ?? null,
        clean_cache: request.cleanCache === true,
      })
      .returning(DEPLOYMENT_COLUMNS.map((column) => column.slice(2) as never))
      .executeTakeFirstOrThrow();
    const deployment = inserted as unknown as DeploymentRow;
    return { deployment, replaced: false, waiting: running !== undefined, enqueue: !running };
  });
  if (result.enqueue) await enqueueRun(db, result.deployment.id);
  deployBus.emit(result.deployment.id, {
    type: "status",
    status: result.deployment.status,
    error: null,
    finished: false,
  });
  return {
    deployment: result.deployment,
    replaced: result.replaced,
    waiting: result.waiting,
    ...("kept" in result && result.kept ? { kept: true } : {}),
  };
}

/**
 * Moves a queued deployment to "building", or says why it can't: it was cancelled or replaced,
 * or another one of the service is building (that one starts this when it ends). A deployment
 * already building is one a stopped control plane left behind: the job that started it runs it
 * again. Any other job finds it taken, so one deployment never runs twice at once.
 */
export async function startBuilding(
  db: Db,
  deploymentId: string,
  options: {
    /** The job running it: a deployment another job is building is left to that job (B1-39). */
    jobId?: number;
    /** How many deploys one server runs at once (R2-15); unlimited when left out. */
    perServer?: number;
  } = {},
): Promise<
  | { start: true; resumed: boolean; row: DeploymentRow }
  | { start: false; serverBusy?: { serverName: string; cleanup?: boolean } }
> {
  const { jobId, perServer } = options;
  return db.transaction().execute(async (trx) => {
    const first = await trx
      .selectFrom("deployment")
      .select("service_id")
      .where("id", "=", deploymentId)
      .executeTakeFirst();
    if (!first?.service_id) return { start: false as const };
    await trx
      .selectFrom("service")
      .select("id")
      .where("id", "=", first.service_id)
      .forUpdate()
      .executeTakeFirst();
    // Read again under the lock: another job may have started it meanwhile.
    const row = await trx
      .selectFrom("deployment as d")
      .select(DEPLOYMENT_COLUMNS)
      .where("d.id", "=", deploymentId)
      .executeTakeFirst();
    if (!row?.service_id) return { start: false as const };
    if (row.status === "building") {
      if (jobId !== undefined && row.job_id !== null && row.job_id !== jobId) {
        return { start: false as const };
      }
      return { start: true as const, resumed: true, row };
    }
    if (row.status !== "queued") return { start: false as const };
    const other = await trx
      .selectFrom("deployment")
      .select("id")
      .where("service_id", "=", row.service_id)
      .where("status", "=", "building")
      .executeTakeFirst();
    if (other) return { start: false as const };
    // Only deploys that build count toward the server's limit (G2-05): Reload, databases,
    // image-only deploys and Make public or Make private start at once.
    const builds = await deploymentBuilds(trx, row);
    // Every deploy takes its server's lock: the daily Docker cleanup takes it too, so the two
    // never run at once on one server (31c G3-03) and builds never both take the last place.
    const target = row.server_id ?? "host";
    await sql`select pg_advisory_xact_lock(hashtext(${`deploy-server:${target}`}))`.execute(trx);
    if (await cleanupRunningOn(trx, target)) {
      return {
        start: false as const,
        serverBusy: { serverName: row.server_name ?? "this server", cleanup: true },
      };
    }
    if (perServer !== undefined && builds) {
      // One build at a time per server unless an administrator raised the limit: a small
      // server doesn't build four apps at once (R2-15, R4-03).
      const busy = await trx
        .selectFrom("deployment")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("status", "=", "building")
        .where("builds", "=", true)
        .where((eb) =>
          row.server_id === null
            ? eb("server_id", "is", null)
            : eb("server_id", "=", row.server_id as string),
        )
        .executeTakeFirstOrThrow();
      if (Number(busy.count) >= perServer) {
        return {
          start: false as const,
          serverBusy: { serverName: row.server_name ?? "this server" },
        };
      }
    }
    const updated = await trx
      .updateTable("deployment")
      .set({
        status: "building",
        builds,
        started_at: sql<Date>`now()`,
        updated_at: sql<Date>`now()`,
        ...(jobId !== undefined ? { job_id: jobId } : {}),
      })
      .where("id", "=", row.id)
      .returning(DEPLOYMENT_COLUMNS.map((column) => column.slice(2) as never))
      .executeTakeFirstOrThrow();
    await trx
      .updateTable("service")
      .set({ status: "deploying", updated_at: new Date() })
      .where("id", "=", row.service_id)
      .execute();
    return { start: true as const, resumed: false, row: updated as unknown as DeploymentRow };
  });
}

/** The daily Docker cleanup's job kind (server-setup/cleanup.ts). */
const CLEANUP_JOB_KIND = "servers.docker-cleanup";

/** Whether the daily Docker cleanup is removing images on this server now (G3-03). */
async function cleanupRunningOn(trx: Db, target: string): Promise<boolean> {
  const running = await trx
    .selectFrom("job")
    .select("id")
    .where("kind", "=", CLEANUP_JOB_KIND)
    .where("state", "=", "running")
    .where(sql<boolean>`payload->>'target' = ${target}`)
    .executeTakeFirst();
  return running !== undefined;
}

/**
 * Whether a deploy is going on this server (G3-03): the daily Docker cleanup waits for it, since
 * it would remove the image a deploy pulled or built before its container exists. Takes the
 * server's deploy lock, so a deploy can't start between this check and the cleanup.
 */
export async function deployGoingOn(db: Db, target: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    await sql`select pg_advisory_xact_lock(hashtext(${`deploy-server:${target}`}))`.execute(trx);
    const building = await trx
      .selectFrom("deployment")
      .select("id")
      .where("status", "=", "building")
      .where((eb) =>
        target === "host" ? eb("server_id", "is", null) : eb("server_id", "=", target),
      )
      .executeTakeFirst();
    return building !== undefined;
  });
}

/**
 * Whether a deployment builds anything (G2-05): an app from Git or an uploaded archive does,
 * unless it is a Reload; an image app only pulls; a Compose stack does when one of its services
 * has a build step (a stack whose file isn't known yet counts as building); databases never do.
 */
async function deploymentBuilds(
  trx: Db,
  row: { service_id: string | null; service_kind: string; trigger: string },
): Promise<boolean> {
  if (row.service_kind !== "application" && row.service_kind !== "compose") return false;
  if (row.trigger === "reload" || !row.service_id) return false;
  const service = await trx
    .selectFrom("service")
    .select("settings")
    .where("id", "=", row.service_id)
    .executeTakeFirst();
  const settings = service?.settings ?? null;
  if (row.service_kind === "application") return readAppSettings(settings).source?.type !== "image";
  const { composeBuilds } = await import("../compose-runtime/plan.ts");
  return composeBuilds(settings);
}

export type DeployOutcome =
  | { status: "active"; containerName: string | null; image: string | null }
  | { status: "failed"; error: string }
  | { status: "cancelled" };

/** What a service's status is once no deploy is running, from its deployments. */
async function settledStatus(
  db: Db,
  serviceId: string,
  outcome: DeployOutcome["status"],
): Promise<"running" | "stopped" | "failed" | "idle"> {
  const current = await db
    .selectFrom("deployment")
    .select("status")
    .where("service_id", "=", serviceId)
    .where("status", "in", ["active", "not_running"])
    .executeTakeFirst();
  if (current?.status === "active") return "running";
  if (current?.status === "not_running") return "stopped";
  if (outcome === "failed") return "failed";
  const ever = await db
    .selectFrom("deployment")
    .select("id")
    .where("service_id", "=", serviceId)
    .where("status", "in", ["previous", "failed"])
    .executeTakeFirst();
  return ever ? "failed" : "idle";
}

/**
 * Records how a deployment ended, updates its service, and starts the service's next waiting
 * deployment. Safe to repeat.
 */
export async function finishDeployment(
  db: Db,
  deploymentId: string,
  outcome: DeployOutcome,
): Promise<void> {
  const next = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("deployment")
      .select(["id", "service_id", "status"])
      .where("id", "=", deploymentId)
      .executeTakeFirst();
    if (!row) return null;
    if (row.service_id) {
      await trx
        .selectFrom("service")
        .select("id")
        .where("id", "=", row.service_id)
        .forUpdate()
        .executeTakeFirst();
    }
    if (row.status === "building" || row.status === "queued") {
      if (outcome.status === "active" && row.service_id) {
        await trx
          .updateTable("deployment")
          .set({ status: "previous", updated_at: new Date() })
          .where("service_id", "=", row.service_id)
          .where("status", "in", ["active", "not_running"])
          .execute();
      }
      await trx
        .updateTable("deployment")
        .set({
          status: outcome.status,
          finished_at: sql<Date>`now()`,
          updated_at: sql<Date>`now()`,
          error: outcome.status === "failed" ? outcome.error.slice(0, 4000) : null,
          ...(outcome.status === "active"
            ? { container_name: outcome.containerName, image: outcome.image }
            : {}),
        })
        .where("id", "=", row.id)
        .execute();
    }
    if (!row.service_id) return null;
    const status = await settledStatus(trx, row.service_id, outcome.status);
    await trx
      .updateTable("service")
      .set({ status, updated_at: new Date() })
      .where("id", "=", row.service_id)
      .where("status", "=", "deploying")
      .execute();
    // A finished deploy that had nothing to do with a still-running one leaves it be.
    const waiting = await trx
      .selectFrom("deployment")
      .select("id")
      .where("service_id", "=", row.service_id)
      .where("status", "=", "queued")
      .executeTakeFirst();
    const building = await trx
      .selectFrom("deployment")
      .select("id")
      .where("service_id", "=", row.service_id)
      .where("status", "=", "building")
      .executeTakeFirst();
    return waiting && !building ? waiting.id : null;
  });
  deployBus.emit(deploymentId, {
    type: "status",
    status: outcome.status,
    error: outcome.status === "failed" ? outcome.error : null,
    finished: true,
  });
  // The waiting deploy starts first, so a notification that fails never holds up the queue.
  if (next) await enqueueRun(db, next);
  // "Deploy succeeded" / "Deploy failed" for notification channels (spec 15.3); once per outcome.
  if (outcome.status !== "cancelled") {
    await emitDeployEvent(db, silentLogger, deploymentId).catch(() => {});
  }
}

/**
 * For a job that found its deployment already finished: makes sure the service's waiting deploy
 * has a job, in case the run that finished it stopped before starting the next one.
 */
export async function startNextWaiting(db: Db, deploymentId: string): Promise<void> {
  const row = await db
    .selectFrom("deployment")
    .select(["service_id", "status"])
    .where("id", "=", deploymentId)
    .executeTakeFirst();
  if (!row?.service_id || row.status === "queued" || row.status === "building") return;
  const open = await db
    .selectFrom("deployment")
    .select(["id", "status"])
    .where("service_id", "=", row.service_id)
    .where("status", "in", ["queued", "building"])
    .execute();
  const waiting = open.find((item) => item.status === "queued");
  if (waiting && !open.some((item) => item.status === "building")) {
    await enqueueRun(db, waiting.id);
  }
}

/** Saves how the pipeline ended, before the deployment's record is updated (B1-38, 0768). */
export async function saveOutcome(
  db: Db,
  deploymentId: string,
  outcome: DeployOutcome,
): Promise<void> {
  await db
    .updateTable("deployment")
    .set({ pipeline_outcome: JSON.stringify(outcome) })
    .where("id", "=", deploymentId)
    .where("status", "=", "building")
    .execute();
}

/** The outcome a run saved before it could record it, if any. */
export async function savedOutcome(db: Db, deploymentId: string): Promise<DeployOutcome | null> {
  const row = await db
    .selectFrom("deployment")
    .select("pipeline_outcome")
    .where("id", "=", deploymentId)
    .executeTakeFirst();
  const value = row?.pipeline_outcome as Partial<DeployOutcome> | null | undefined;
  if (!value || typeof value !== "object") return null;
  if (value.status === "active") {
    const active = value as { containerName?: unknown; image?: unknown };
    return {
      status: "active",
      containerName: typeof active.containerName === "string" ? active.containerName : null,
      image: typeof active.image === "string" ? active.image : null,
    };
  }
  if (value.status === "failed") {
    const failed = value as { error?: unknown };
    return {
      status: "failed",
      error: typeof failed.error === "string" ? failed.error : "The deploy failed.",
    };
  }
  if (value.status === "cancelled") return { status: "cancelled" };
  return null;
}

/** In-process cancel switches for running deployments. */
const running = new Map<string, AbortController>();

export function registerRunning(deploymentId: string, controller: AbortController): () => void {
  running.set(deploymentId, controller);
  return () => {
    if (running.get(deploymentId) === controller) running.delete(deploymentId);
  };
}

/**
 * Cancels a queued or building deployment (spec 11.2). A queued one ends at once; a building one
 * is stopped (its build is killed on the server) and the running version keeps serving.
 */
export async function cancelDeployment(
  db: Db,
  deploymentId: string,
): Promise<"cancelled" | "stopping"> {
  const row = await db
    .selectFrom("deployment")
    .select(["id", "status", "service_id"])
    .where("id", "=", deploymentId)
    .executeTakeFirstOrThrow();
  if (row.status === "queued") {
    // Under the service's lock, like requestDeploy: a push that replaces this waiting deploy
    // either lands before the cancel (and is cancelled with it, as the person saw it) or after
    // (and queues a deploy of its own). It never vanishes into a cancelled one.
    const updated = await db.transaction().execute(async (trx) => {
      if (row.service_id) {
        await trx
          .selectFrom("service")
          .select("id")
          .where("id", "=", row.service_id)
          .forUpdate()
          .executeTakeFirst();
      }
      return trx
        .updateTable("deployment")
        .set({ status: "cancelled", finished_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
        .where("id", "=", row.id)
        .where("status", "=", "queued")
        .executeTakeFirst();
    });
    if (updated.numUpdatedRows > 0n) {
      deployBus.emit(row.id, { type: "status", status: "cancelled", error: null, finished: true });
      return "cancelled";
    }
  }
  const now = await db
    .updateTable("deployment")
    .set({ cancel_requested_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
    .where("id", "=", row.id)
    .where("status", "=", "building")
    .executeTakeFirst();
  if (now.numUpdatedRows === 0n) {
    throw new AppError(
      "conflict",
      "This deployment already finished, so there is nothing to cancel.",
    );
  }
  running.get(row.id)?.abort();
  return "stopping";
}

/**
 * Deployments a stopped control plane may have left without a job: waiting ones with nothing
 * running before them are started. Run at startup and by the daily clean-up.
 */
export async function recoverQueue(db: Db): Promise<number> {
  const stranded = await db
    .selectFrom("deployment as d")
    .select(["d.id"])
    .where("d.status", "=", "queued")
    .where("d.service_id", "is not", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("deployment as b")
            .select("b.id")
            .whereRef("b.service_id", "=", "d.service_id")
            .where("b.status", "=", "building"),
        ),
      ),
    )
    .execute();
  for (const row of stranded) await enqueueRun(db, row.id);
  // Building ones whose job gave up (the control plane stopped during every attempt) end as failed.
  const abandoned = await db
    .selectFrom("deployment as d")
    .select(["d.id"])
    .where("d.status", "=", "building")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("job as j")
            .select("j.id")
            .where("j.kind", "=", RUN_DEPLOY_JOB)
            .where("j.state", "in", ["queued", "running"])
            .where(sql<boolean>`j.idempotency_key like 'deploy:' || d.id::text || ':%'`),
        ),
      ),
    )
    .execute();
  for (const row of abandoned) {
    // A pipeline that ended but couldn't be recorded is recorded as it ended.
    await finishDeployment(
      db,
      row.id,
      (await savedOutcome(db, row.id)) ?? {
        status: "failed",
        error: "Nearzero stopped during this deploy and couldn't finish it. Deploy again.",
      },
    );
  }
  return stranded.length + abandoned.length;
}

/** Whether a deploy of this kind of service can be started by the caller's action. */
export function deployable(kind: ServiceKind): boolean {
  return kind === "application" || isDatabaseKind(kind) || kind === "compose";
}

export { HOST_SERVER_ID };
