import { AppError, NEARZERO_LABELS, PRIVATE_NETWORK } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { deployBus } from "../deploys/log.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { RunnerCommandError } from "../runners/hub.ts";
import { serverOf } from "../service-runtime/runtime.ts";
import { type ContainerSummary, reasonOf, ServerOps } from "../service-runtime/server-ops.ts";
import type { ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { startOrder } from "./model.ts";
import { savedInventory } from "./plan.ts";
import { COMPOSE_LABEL, innerAlias } from "./render.ts";

/**
 * A deployed stack at run time (spec 07 7.2): Start (Compose format) and Stop act on every
 * container of the serving deployment, in dependency order; Reload is a redeploy; the
 * Containers section lists them and restarts, starts, stops or kills one. Every action needs
 * deploy rights on the service; the list needs access to it.
 */

const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";

const NOT_DEPLOYED = "This service hasn't been deployed yet. Deploy it first.";
const WHILE_DEPLOYING = "Wait for the deployment to finish first.";

function opsFor(services: ControlServices, row: ServiceRow): ServerOps {
  return new ServerOps(services, serverOf(row), new AbortController().signal);
}

async function activeDeployment(services: ControlServices, serviceId: string) {
  return services.db
    .selectFrom("deployment")
    .select(["id", "status"])
    .where("service_id", "=", serviceId)
    .where("status", "in", ["active", "not_running"])
    .executeTakeFirst();
}

function innerOf(container: ContainerSummary): string {
  return container.labels[COMPOSE_LABEL] ?? container.labels[COMPOSE_SERVICE] ?? container.name;
}

/** The stack's containers on its server: Nearzero's label, and Compose's project label. */
export async function stackContainers(
  services: ControlServices,
  row: ServiceRow,
): Promise<ContainerSummary[]> {
  const ops = opsFor(services, row);
  const labelled = await ops.serviceContainers(row.id);
  const byProject = (await ops.command("container.list", {
    all: true,
    labels: [`${COMPOSE_PROJECT}=${row.app_name}`],
  })) as ContainerSummary[];
  const seen = new Set(labelled.map((item) => item.id));
  return [...labelled, ...byProject.filter((item) => !seen.has(item.id))];
}

async function setStatus(
  services: ControlServices,
  serviceId: string,
  running: boolean,
  deploymentId: string,
): Promise<void> {
  await services.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("service")
      .set({ status: running ? "running" : "stopped", updated_at: new Date() })
      .where("id", "=", serviceId)
      .where("status", "!=", "deploying")
      .execute();
    await trx
      .updateTable("deployment")
      .set({ status: running ? "active" : "not_running", updated_at: sql<Date>`now()` })
      .where("id", "=", deploymentId)
      .where("status", "in", ["active", "not_running"])
      .execute();
  });
  deployBus.emit(deploymentId, {
    type: "status",
    status: running ? "active" : "not_running",
    error: null,
    finished: true,
  });
}

export async function composeRuntimeAction(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ServiceRow,
  action: "start" | "stop" | "reload",
): Promise<{ status: string; message: string; deploymentId?: string }> {
  if (row.status === "deploying") throw new AppError("conflict", WHILE_DEPLOYING);
  if (row.status === "idle") throw new AppError("conflict", NOT_DEPLOYED);
  if (action === "reload") {
    // Reload is a redeploy for a stack (spec 07 7.2).
    const { startServiceDeploy } = await import("../deploys/routes.ts");
    const started = await startServiceDeploy(services, actor, row.id, {
      cleanCache: false,
      title: "Reload",
    });
    return { status: "deploying", message: started.message, deploymentId: started.deployment.id };
  }
  if (action === "start" && row.settings?.format === "stack") {
    throw new AppError("conflict", "A Stack starts again when you deploy it.");
  }
  const active = await activeDeployment(services, row.id);
  if (!active) throw new AppError("conflict", NOT_DEPLOYED);
  const ops = opsFor(services, row);
  const list = (await ops.serviceContainers(row.id)).filter(
    (item) => item.labels[NEARZERO_LABELS.deployment] === active.id,
  );
  if (list.length === 0) {
    throw new AppError(
      "conflict",
      "The stack's containers aren't on the server any more. Deploy the service again.",
    );
  }
  const order = startOrder(
    (savedInventory(row.settings)?.services ?? []).map((item) => ({
      ...item,
      image: null,
      build: false,
      networkMode: null,
    })),
  );
  const rank = (container: ContainerSummary) => {
    const index = order.indexOf(innerOf(container));
    return index < 0 ? order.length : index;
  };
  const sorted = [...list].sort((a, b) => rank(a) - rank(b));
  if (action === "stop") {
    for (const item of sorted.reverse()) {
      if (item.state === "running" || item.state === "restarting" || item.state === "paused") {
        await ops.command("container.stop", { id: item.id, timeoutSeconds: 10 }, 40_000);
      }
    }
  } else {
    for (const item of sorted) {
      if (item.state !== "running") await ops.command("container.start", { id: item.id }, 60_000);
    }
  }
  await setStatus(services, row.id, action === "start", active.id);
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: `service.${action}`,
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: { server: serverOf(row), containers: list.length },
  });
  return {
    status: action === "start" ? "running" : "stopped",
    message: action === "start" ? "Started" : "Stopped",
  };
}

// ---- The Containers section

export interface StackContainerView {
  id: string;
  shortId: string;
  name: string;
  /** The inner service it runs. */
  service: string;
  state: string;
  status: string;
  image: string;
  /** Part of the deployment that serves now. */
  current: boolean;
  createdAt: string;
}

export async function containersView(
  services: ControlServices,
  row: ServiceRow,
): Promise<{ containers: StackContainerView[]; message: string | null; checkedAt: string }> {
  const checkedAt = new Date().toISOString();
  if (row.status === "idle") {
    return { containers: [], message: null, checkedAt };
  }
  const active = await activeDeployment(services, row.id);
  let list: ContainerSummary[];
  try {
    list = await stackContainers(services, row);
  } catch (error) {
    return {
      containers: [],
      message: `Couldn't read the containers from the server: ${reasonOf(error)}`,
      checkedAt,
    };
  }
  const containers = list
    .map((item) => ({
      id: item.id,
      shortId: item.id.slice(0, 12),
      name: item.name,
      service: innerOf(item),
      state: item.state,
      status: item.status,
      image: item.image,
      current: active !== undefined && item.labels[NEARZERO_LABELS.deployment] === active.id,
      createdAt: new Date(item.createdAt * 1000).toISOString(),
    }))
    .sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name));
  return { containers, message: null, checkedAt };
}

export const CONTAINER_ACTIONS = ["restart", "start", "stop", "kill"] as const;
export type ContainerAction = (typeof CONTAINER_ACTIONS)[number];

const DONE: Record<ContainerAction, string> = {
  restart: "Restarted",
  start: "Started",
  stop: "Stopped",
  kill: "Killed",
};

export async function containerAction(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ServiceRow,
  containerId: string,
  action: ContainerAction,
): Promise<{ container: StackContainerView | null; message: string }> {
  if (row.status === "deploying") throw new AppError("conflict", WHILE_DEPLOYING);
  const list = await stackContainers(services, row);
  const found = list.find(
    (item) =>
      item.id === containerId || (containerId.length >= 12 && item.id.startsWith(containerId)),
  );
  if (!found) throw new AppError("not_found", "That container isn't one of this stack's.");
  const ops = opsFor(services, row);
  try {
    if (action === "restart") {
      await ops.command("container.restart", { id: found.id, timeoutSeconds: 10 }, 60_000);
    } else if (action === "start") {
      await ops.command("container.start", { id: found.id }, 60_000);
    } else if (action === "stop") {
      await ops.command("container.stop", { id: found.id, timeoutSeconds: 10 }, 40_000);
    } else {
      await ops.command("container.kill", { id: found.id, signal: "KILL" }, 30_000);
    }
  } catch (error) {
    if (
      error instanceof RunnerCommandError &&
      error.runnerCode === "conflict" &&
      action === "kill"
    ) {
      throw new AppError("conflict", `${found.name} isn't running, so there is nothing to kill.`);
    }
    throw error;
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: `compose.container-${action}`,
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: { container: found.name, server: serverOf(row) },
  });
  const after = (await containersView(services, row)).containers.find(
    (item) => item.id === found.id,
  );
  return { container: after ?? null, message: `${DONE[action]} ${found.name}` };
}

/**
 * A hostname connected to an inner service between deploys (spec 10.6): only routed inner
 * services are on the private network (30b R2-11), so this one joins it now, under its alias,
 * before the router sends it traffic. Best effort: with the runner away, the next deploy joins it.
 */
export async function joinRoutedInnerService(
  services: ControlServices,
  target: string,
  service: { id: string; app_name: string },
  inner: string,
): Promise<void> {
  if (!services.runners.isOnline(target)) return;
  const ops = new ServerOps(services, target, new AbortController().signal);
  try {
    const containers = await ops.serviceContainers(service.id);
    for (const container of containers) {
      const name = container.labels[COMPOSE_LABEL] ?? container.labels[COMPOSE_SERVICE];
      if (name?.toLowerCase() !== inner.toLowerCase()) continue;
      await ops.command("network.connect", {
        network: PRIVATE_NETWORK,
        container: container.id,
        aliases: [innerAlias(service.app_name, inner)],
      });
    }
  } catch (error) {
    services.log.warn("an inner service couldn't join the private network", {
      serviceId: service.id,
      inner,
      reason: reasonOf(error),
    });
  }
}
