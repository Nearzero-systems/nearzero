import { AppError, isProductionEnvironment, RUNNER_CLOSE, SETUP_MESSAGES } from "@nearzero/shared";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { carryOutRun } from "../deletion/job.ts";
import { chosenCandidates, DEPLOYING_REFUSAL } from "../deletion/plan.ts";
import { closeUntrackedRun, isRunTracked } from "../deletion/state.ts";
import type { ServiceTeardown } from "../deletion/teardown.ts";
import { publishZones } from "../domains/zones.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import { isOurId, serviceTarget } from "../projects/objects.ts";
import { revokeRunner } from "../runners/credentials.ts";
import { forgetServerDomains } from "../servers/servers.ts";
import type { ControlServices } from "../services.ts";
import { AccessFailure, loadServerAccess, type ServerAccess, signIn } from "./connection.ts";
import { remoteCommand, uninstallRunnerScript } from "./scripts.ts";

/**
 * Deleting a server (spec 09 9.6). With attached services, the person ticks "Also delete all
 * attached services on this server": each service is torn down like a project delete (one
 * delete run per project, with a result per service, through the same teardown), and the server
 * is deleted only once every one of them is gone. Then, and for a server without services, the
 * runner's service and credential are removed from the server over SSH when it can be reached;
 * an unreachable server only loses its records (its credential is revoked either way).
 */

export const REMOVAL_JOB = "servers.remove";
export const UNINSTALL_JOB = "servers.uninstall-runner";

export interface RemovalView {
  id: string;
  state: "running" | "succeeded" | "failed";
  server: { id: string; name: string };
  message: string;
  items: {
    serviceId: string;
    name: string;
    projectName: string;
    environmentName: string;
    state: "waiting" | "removing" | "removed" | "not_removed";
    reason: string | null;
  }[];
  counts: { waiting: number; removing: number; removed: number; notRemoved: number };
  createdAt: string;
  finishedAt: string | null;
}

interface RemovalRow {
  id: string;
  workspace_id: string;
  server_id: string;
  server_name: string;
  state: "running" | "succeeded" | "failed";
  run_ids: string[];
  message: string | null;
  job_id: number | null;
  created_at: Date;
  finished_at: Date | null;
}

const COLUMNS = [
  "id",
  "workspace_id",
  "server_id",
  "server_name",
  "state",
  "run_ids",
  "message",
  "job_id",
  "created_at",
  "finished_at",
] as const;

const KEPT_MESSAGE =
  "The server was kept: some services couldn't be removed, and each shows why. Fix that, then delete the server again.";

export async function removalView(db: Db, row: RemovalRow): Promise<RemovalView> {
  const items =
    row.run_ids.length === 0
      ? []
      : await db
          .selectFrom("delete_run_item as i")
          .innerJoin("delete_run as r", "r.id", "i.run_id")
          .select([
            "i.service_id",
            "i.service_name",
            "i.environment_name",
            "i.state",
            "i.reason",
            "r.project_name",
          ])
          .where("i.run_id", "in", row.run_ids)
          .orderBy("r.project_name")
          .orderBy("i.position")
          .execute();
  const counts = {
    waiting: items.filter((item) => item.state === "waiting").length,
    removing: items.filter((item) => item.state === "removing").length,
    removed: items.filter((item) => item.state === "removed").length,
    notRemoved: items.filter((item) => item.state === "not_removed").length,
  };
  return {
    id: row.id,
    state: row.state,
    server: { id: row.server_id, name: row.server_name },
    message:
      row.message ??
      (row.state === "running"
        ? SETUP_MESSAGES.removalStarted
        : row.state === "succeeded"
          ? SETUP_MESSAGES.serverDeleted
          : KEPT_MESSAGE),
    items: items.map((item) => ({
      serviceId: item.service_id,
      name: item.service_name,
      projectName: item.project_name,
      environmentName: item.environment_name,
      state: item.state,
      reason: item.reason,
    })),
    counts,
    createdAt: row.created_at.toISOString(),
    finishedAt: row.finished_at?.toISOString() ?? null,
  };
}

async function jobAlive(db: Db, jobId: number | null): Promise<boolean> {
  if (jobId === null) return false;
  const job = await db.selectFrom("job").select("state").where("id", "=", jobId).executeTakeFirst();
  return job?.state === "queued" || job?.state === "running";
}

export async function latestRemoval(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
): Promise<RemovalView | null> {
  if (!isOurId(serverId)) throw new AppError("not_found", "There's no such server delete.");
  const row = (await services.db
    .selectFrom("server_removal")
    .select(COLUMNS)
    .where("workspace_id", "=", actor.workspace.id)
    .where("server_id", "=", serverId)
    .orderBy("created_at", "desc")
    .limit(1)
    .executeTakeFirst()) as RemovalRow | undefined;
  if (!row) return null;
  return removalView(services.db, row);
}

/**
 * Starts deleting a server together with every service on it. With `onlyEmpty` (the Agent's
 * removal, spec 9.6 and the G4-01 decision in spec 31) a server that still has any service, in
 * any state, is refused instead, checked with the server row locked so no service can be added
 * in between.
 */
export async function startServerRemoval(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
  options: { onlyEmpty?: (serviceIds: string[]) => Promise<never> } = {},
): Promise<RemovalView> {
  await actor.access.require("server.manage", { kind: "server", id: serverId });
  const { db } = services;
  const row = await db.transaction().execute(async (trx) => {
    const server = await trx
      .selectFrom("server")
      .select(["id", "name"])
      .where("id", "=", serverId)
      .where("workspace_id", "=", actor.workspace.id)
      .forUpdate()
      .executeTakeFirst();
    if (!server) {
      throw new AppError(
        "not_found",
        "This server doesn't exist in this workspace, or you don't have access to it.",
      );
    }
    const running = (await trx
      .selectFrom("server_removal")
      .select(COLUMNS)
      .where("server_id", "=", serverId)
      .where("state", "=", "running")
      .executeTakeFirst()) as RemovalRow | undefined;
    if (running) {
      if (await jobAlive(trx, running.job_id)) return running;
      await trx
        .updateTable("server_removal")
        .set({ state: "failed", finished_at: new Date(), message: KEPT_MESSAGE })
        .where("id", "=", running.id)
        .execute();
      for (const runId of running.run_ids) await closeUntrackedRun(trx, runId);
    }
    const ids = (
      await trx.selectFrom("service").select("id").where("server_id", "=", serverId).execute()
    ).map((item) => item.id);
    if (ids.length > 0 && options.onlyEmpty) await options.onlyEmpty(ids);
    const candidates =
      ids.length === 0 ? [] : await chosenCandidates(trx, actor.workspace.id, ids, { lock: true });
    const refused = candidates.filter(
      (item) => !actor.access.can("service.delete", serviceTarget(item)),
    );
    if (refused.length > 0) {
      throw new AppError(
        "forbidden",
        `You can't delete ${refused.length === 1 ? `the service ${refused[0]?.name}` : `${refused.length} of the services`} on this server, so nothing was deleted. Ask an owner or admin.`,
      );
    }
    const deploying = candidates.find((item) => item.status === "deploying");
    if (deploying)
      throw new AppError("conflict", `${deploying.name} is deploying. ${DEPLOYING_REFUSAL}`);
    for (const item of candidates) {
      if (!item.deleting_run_id) continue;
      const other = await trx
        .selectFrom("delete_run")
        .select(["id", "state", "job_id"])
        .where("id", "=", item.deleting_run_id)
        .executeTakeFirst();
      if (other && (await isRunTracked(trx, other))) {
        throw new AppError("conflict", `${item.name} is already being deleted.`);
      }
      if (other) await closeUntrackedRun(trx, other.id);
    }
    const removal = await trx
      .insertInto("server_removal")
      .values({
        workspace_id: actor.workspace.id,
        server_id: serverId,
        server_name: server.name,
        requested_by: actor.personId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const job = await new JobQueue(trx, { workerId: "control-api" }).enqueue({
      kind: REMOVAL_JOB,
      payload: { removalId: removal.id },
      maxAttempts: 10,
      idempotencyKey: `server-removal:${removal.id}`,
    });
    // One delete run per project, carried out by this removal's job (so they count as tracked).
    const byProject = new Map<string, typeof candidates>();
    for (const item of candidates) {
      const list = byProject.get(item.project_id) ?? [];
      list.push(item);
      byProject.set(item.project_id, list);
    }
    const projects =
      byProject.size === 0
        ? []
        : await trx
            .selectFrom("project")
            .select(["id", "name"])
            .where("id", "in", [...byProject.keys()])
            .execute();
    const runIds: string[] = [];
    for (const [projectId, items] of byProject) {
      const run = await trx
        .insertInto("delete_run")
        .values({
          workspace_id: actor.workspace.id,
          scope: "services",
          project_id: projectId,
          project_name: projects.find((project) => project.id === projectId)?.name ?? "project",
          fingerprint: null,
          job_id: job.id,
          requested_by: actor.personId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("delete_run_item")
        .values(
          items.map((item, position) => ({
            run_id: run.id,
            position,
            service_id: item.id,
            environment_id: item.environment_id,
            environment_name: item.environment_name,
            service_name: item.name,
            kind: item.kind,
            app_name: item.app_name,
            server_id: item.server_id,
            production: isProductionEnvironment(item.environment_name),
            stop_first: item.status === "running",
          })),
        )
        .execute();
      await trx
        .updateTable("service")
        .set({ deleting_run_id: run.id })
        .where(
          "id",
          "in",
          items.map((item) => item.id),
        )
        .execute();
      runIds.push(run.id);
    }
    await trx
      .updateTable("server_removal")
      .set({ run_ids: runIds, job_id: job.id })
      .where("id", "=", removal.id)
      .execute();
    await recordAudit(trx, services.log, auditActor(actor), {
      action: "server.delete-started",
      workspaceId: actor.workspace.id,
      target: { kind: "server", id: serverId },
      details: { name: server.name, services: candidates.length, removalId: removal.id },
    });
    return (await trx
      .selectFrom("server_removal")
      .select(COLUMNS)
      .where("id", "=", removal.id)
      .executeTakeFirstOrThrow()) as RemovalRow;
  });
  return removalView(db, row);
}

/** Removes the runner's service and credential over SSH, when the server can be reached. */
export async function uninstallRunner(
  services: ControlServices,
  log: Logger,
  server: ServerAccess,
): Promise<string> {
  try {
    const { session, sudo, facts } = await signIn(services, server);
    try {
      const result = await session.exec(
        remoteCommand({ shell: facts.hasBash ? "bash" : "sh", sudo }),
        {
          stdin: uninstallRunnerScript(facts.init),
          timeoutMs: 120_000,
        },
      );
      return result.code === 0
        ? "Removed the runner and its credential from the server."
        : `The runner couldn't be removed from the server (exit code ${result.code}).`;
    } finally {
      session.close();
    }
  } catch (error) {
    const reason =
      error instanceof AccessFailure ? error.failure.message : (error as Error).message;
    log.info("couldn't remove the runner from a deleted server", { server: server.name, reason });
    return `Nearzero couldn't sign in to remove the runner (${reason}); its credential is revoked, so it can't connect again.`;
  }
}

/** Deletes a server's records once nothing of it is left (its runner is revoked first). */
export async function deleteServerRecords(
  services: ControlServices,
  serverId: string,
  audit: { actorLabel: string | null; personId: string | null; workspaceId: string; name: string },
): Promise<void> {
  await revokeRunner(services.db, serverId);
  services.runners.disconnect(serverId, RUNNER_CLOSE.revoked, "server deleted");
  let zones: string[] = [];
  await services.db.transaction().execute(async (trx) => {
    zones = await forgetServerDomains(trx, serverId);
    await trx.deleteFrom("router_route").where("target", "=", serverId).execute();
    await trx.deleteFrom("server_metric").where("target", "=", serverId).execute();
    await trx.deleteFrom("docker_cleanup").where("target", "=", serverId).execute();
    await trx.deleteFrom("server").where("id", "=", serverId).execute();
    await recordAudit(
      trx,
      services.log,
      { kind: "person", personId: audit.personId, label: audit.actorLabel },
      {
        action: "server.deleted",
        workspaceId: audit.workspaceId,
        target: { kind: "server", id: serverId },
        details: { name: audit.name, withServices: true },
      },
    );
  });
  if (zones.length > 0) await publishZones(services, zones).catch(() => {});
}

export function removeServerJob(services: ControlServices, teardown: ServiceTeardown) {
  return defineJob({
    kind: REMOVAL_JOB,
    payload: z.object({ removalId: z.string().regex(/^[0-9a-f-]{36}$/) }),
    maxAttempts: 10,
    lane: "delete",
    async run({ removalId }, { db, log, signal }) {
      const removal = (await db
        .selectFrom("server_removal")
        .select([...COLUMNS, "requested_by"])
        .where("id", "=", removalId)
        .executeTakeFirst()) as (RemovalRow & { requested_by: string | null }) | undefined;
      if (removal?.state !== "running") return;
      for (const runId of removal.run_ids) {
        await carryOutRun(db, log, teardown, runId, signal);
      }
      const left = await db
        .selectFrom("delete_run_item")
        .select("state")
        .where(
          "run_id",
          "in",
          removal.run_ids.length > 0 ? removal.run_ids : ["00000000-0000-0000-0000-000000000000"],
        )
        .where("state", "<>", "removed")
        .executeTakeFirst();
      const stillThere = await db
        .selectFrom("service")
        .select("id")
        .where("server_id", "=", removal.server_id)
        .executeTakeFirst();
      if (left || stillThere) {
        await db
          .updateTable("server_removal")
          .set({ state: "failed", finished_at: new Date(), message: KEPT_MESSAGE })
          .where("id", "=", removal.id)
          .execute();
        return;
      }
      const server = await loadServerAccess(db, removal.server_id);
      let note = "";
      if (server) {
        note = await uninstallRunner(services, log, server);
        const person = removal.requested_by
          ? await db
              .selectFrom("person")
              .select("email")
              .where("id", "=", removal.requested_by)
              .executeTakeFirst()
          : undefined;
        await deleteServerRecords(services, server.id, {
          actorLabel: person?.email ?? null,
          personId: removal.requested_by,
          workspaceId: removal.workspace_id,
          name: removal.server_name,
        });
      }
      await db
        .updateTable("server_removal")
        .set({
          state: "succeeded",
          finished_at: new Date(),
          message: note ? `${SETUP_MESSAGES.serverDeleted}. ${note}` : SETUP_MESSAGES.serverDeleted,
        })
        .where("id", "=", removal.id)
        .execute();
    },
  });
}

const uninstallPayload = z.object({
  workspaceId: z.string(),
  name: z.string(),
  sshKeyId: z.string(),
  address: z.string(),
  port: z.number().int(),
  user: z.string(),
  hostKeyFingerprint: z.string().nullable(),
});

/** After a server without services was deleted: remove its runner when it can be reached. */
export function uninstallRunnerJob(services: ControlServices) {
  return defineJob({
    kind: UNINSTALL_JOB,
    payload: uninstallPayload,
    maxAttempts: 1,
    lane: "delete",
    async run(payload, { log }) {
      await uninstallRunner(services, log, {
        id: "00000000-0000-0000-0000-000000000000",
        workspaceId: payload.workspaceId,
        name: payload.name,
        address: payload.address,
        port: payload.port,
        user: payload.user,
        sshKeyId: payload.sshKeyId,
        hostKeyFingerprint: payload.hostKeyFingerprint,
      });
    },
  });
}

export async function queueRunnerUninstall(db: Db, server: ServerAccess): Promise<void> {
  if (!server.hostKeyFingerprint) return; // Never signed in: nothing of Nearzero is there.
  await new JobQueue(db, { workerId: "control-api" }).enqueue({
    kind: UNINSTALL_JOB,
    payload: uninstallPayload.parse({
      workspaceId: server.workspaceId,
      name: server.name,
      sshKeyId: server.sshKeyId,
      address: server.address,
      port: server.port,
      user: server.user,
      hostKeyFingerprint: server.hostKeyFingerprint,
    }),
    maxAttempts: 1,
  });
}
