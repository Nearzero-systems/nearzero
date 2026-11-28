import { AppError, NEARZERO_LABELS } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { deployBus } from "../deploys/log.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { loadService, type ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { type ContainerSummary, ServerOps } from "./server-ops.ts";

/**
 * A deployed service's running state (spec 6.2, 6.7, 8.2): Start, Stop and Reload (restart
 * without rebuilding), its containers for the logs and terminal pickers. Every action needs
 * deploy rights on the service and acts on the containers labelled with its id.
 */

export async function serviceForAction(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  action: "service.deploy" | "service.see" | "service.deployments" | "service.configure",
): Promise<ServiceRow> {
  await actor.access.require(action, { kind: "service", id: serviceId });
  const row = await loadService(services.db, actor.workspace.id, serviceId);
  if (!row)
    throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
  return row;
}

export function serverOf(row: { server_id: string | null }): string {
  return row.server_id ?? HOST_TARGET;
}

function opsFor(services: ControlServices, row: ServiceRow): ServerOps {
  return new ServerOps(services, serverOf(row), new AbortController().signal);
}

export interface RuntimeView {
  status: string;
  containers: {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    deploymentId: string | null;
    current: boolean;
    createdAt: string;
  }[];
}

async function activeDeployment(services: ControlServices, serviceId: string) {
  return services.db
    .selectFrom("deployment")
    .select(["id", "status", "container_name"])
    .where("service_id", "=", serviceId)
    .where("status", "in", ["active", "not_running"])
    .executeTakeFirst();
}

function summarize(
  list: ContainerSummary[],
  currentDeployment: string | null,
): RuntimeView["containers"] {
  return list.map((item) => ({
    id: item.id,
    name: item.name,
    image: item.image,
    state: item.state,
    status: item.status,
    deploymentId: item.labels[NEARZERO_LABELS.deployment] ?? null,
    current: item.labels[NEARZERO_LABELS.deployment] === currentDeployment,
    createdAt: new Date(item.createdAt * 1000).toISOString(),
  }));
}

/** The service's containers on its server (the logs and terminal pickers). */
export async function serviceRuntime(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<RuntimeView> {
  const row = await serviceForAction(services, actor, serviceId, "service.deployments");
  const active = await activeDeployment(services, row.id);
  if (row.status === "idle") return { status: row.status, containers: [] };
  const list = await opsFor(services, row).serviceContainers(row.id);
  return { status: row.status, containers: summarize(list, active?.id ?? null) };
}

async function setStatus(
  services: ControlServices,
  serviceId: string,
  status: "running" | "stopped",
  deploymentStatus: "active" | "not_running",
  deploymentId: string,
): Promise<void> {
  await services.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("service")
      .set({ status, updated_at: new Date() })
      .where("id", "=", serviceId)
      .where("status", "!=", "deploying")
      .execute();
    await trx
      .updateTable("deployment")
      .set({ status: deploymentStatus, updated_at: sql<Date>`now()` })
      .where("id", "=", deploymentId)
      .where("status", "in", ["active", "not_running"])
      .execute();
  });
  deployBus.emit(deploymentId, {
    type: "status",
    status: deploymentStatus,
    error: null,
    finished: true,
  });
}

const NOT_DEPLOYED = "This service hasn't been deployed yet. Deploy it first.";
const WHILE_DEPLOYING = "Wait for the deployment to finish first.";

/** The containers of the service's serving deployment. */
async function currentContainers(services: ControlServices, row: ServiceRow) {
  const active = await activeDeployment(services, row.id);
  if (!active) throw new AppError("conflict", NOT_DEPLOYED);
  const ops = opsFor(services, row);
  const list = (await ops.serviceContainers(row.id)).filter(
    (item) => item.labels[NEARZERO_LABELS.deployment] === active.id,
  );
  if (list.length === 0) {
    throw new AppError(
      "conflict",
      "The deployed container isn't on the server any more. Deploy the service again.",
    );
  }
  return { active, ops, list };
}

export type RuntimeAction = "start" | "stop" | "reload";

const DONE: Record<RuntimeAction, string> = {
  start: "Started",
  stop: "Stopped",
  reload: "Reloaded",
};

export async function runtimeAction(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  action: RuntimeAction,
): Promise<{ status: string; message: string }> {
  const row = await serviceForAction(services, actor, serviceId, "service.deploy");
  if (row.kind === "compose") {
    // Stacks start and stop all their containers, and Reload is a redeploy (spec 07 7.2).
    const { composeRuntimeAction } = await import("../compose-runtime/runtime.ts");
    return composeRuntimeAction(services, actor, row, action);
  }
  if (row.status === "deploying") throw new AppError("conflict", WHILE_DEPLOYING);
  if (row.status === "idle") throw new AppError("conflict", NOT_DEPLOYED);
  if (action === "reload" && row.kind === "application")
    return reloadApplication(services, actor, row);
  const { active, ops, list } = await currentContainers(services, row);
  const stopSeconds = row.kind === "application" ? 10 : 30;
  if (action === "stop" || action === "reload") {
    for (const item of list) {
      if (item.state === "running" || item.state === "restarting") {
        await ops.command(
          "container.stop",
          { id: item.id, timeoutSeconds: stopSeconds },
          (stopSeconds + 30) * 1000,
        );
      }
    }
  }
  if (action === "start" || action === "reload") {
    for (const item of list) await ops.command("container.start", { id: item.id }, 60_000);
  }
  const running = action !== "stop";
  await setStatus(
    services,
    row.id,
    running ? "running" : "stopped",
    running ? "active" : "not_running",
    active.id,
  );
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: `service.${action}`,
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: { server: serverOf(row) },
  });
  return { status: running ? "running" : "stopped", message: DONE[action] };
}

/**
 * Reload of an app (spec 6.2, 30b R2-02): the running version's image is started again as a new
 * container with the saved variables, mounts, ports and start command, then traffic switches to
 * it, like a deploy with nothing fetched or built. It runs in the service's deploy queue with its
 * own log, so it never overlaps a deploy.
 */
async function reloadApplication(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ServiceRow,
): Promise<{ status: string; message: string; deploymentId: string }> {
  const { requestDeploy } = await import("../deploys/queue.ts");
  if (!(await activeDeployment(services, row.id))) throw new AppError("conflict", NOT_DEPLOYED);
  const { hostDeployPrecheck } = await import("./host-mounts.ts");
  await hostDeployPrecheck(services, actor, row);
  const result = await requestDeploy(services.db, {
    serviceId: row.id,
    workspaceId: actor.workspace.id,
    trigger: "reload",
    requestedBy: actor.personId,
  });
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "service.reload",
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: { server: serverOf(row), deploymentId: result.deployment.id },
  });
  return {
    status: "deploying",
    deploymentId: result.deployment.id,
    message: result.kept
      ? "A deploy is already waiting; it starts the app with the saved settings."
      : "Reloading with the saved settings. Nothing is rebuilt; the running version serves until the new container is up.",
  };
}

/** A container of this service that people may open logs or a terminal in. */
export async function serviceContainer(
  services: ControlServices,
  row: ServiceRow,
  wanted: string | undefined,
): Promise<{ id: string; name: string }> {
  const ops = opsFor(services, row);
  const list = await ops.serviceContainers(row.id);
  if (list.length === 0) {
    throw new AppError("conflict", "This service has no container on its server. Deploy it first.");
  }
  if (wanted) {
    const found = list.find(
      (item) => item.id === wanted || item.id.startsWith(wanted) || item.name === wanted,
    );
    if (!found) throw new AppError("not_found", "That container isn't one of this service's.");
    return { id: found.id, name: found.name };
  }
  const active = await activeDeployment(services, row.id);
  const current =
    list.find(
      (item) => item.labels[NEARZERO_LABELS.deployment] === active?.id && item.state === "running",
    ) ??
    list.find((item) => item.state === "running") ??
    list[0];
  return { id: (current as ContainerSummary).id, name: (current as ContainerSummary).name };
}
