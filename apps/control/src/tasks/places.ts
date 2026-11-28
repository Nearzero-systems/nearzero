import {
  AppError,
  isDatabaseKind,
  NEARZERO_LABELS,
  TASK_MESSAGES,
  type TaskPlace,
} from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import { isOurId, serviceTarget } from "../projects/objects.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { HOST_NAME } from "../servers/targets.ts";
import type { ContainerSummary } from "../service-runtime/server-ops.ts";
import { ServerOps } from "../service-runtime/server-ops.ts";
import type { ControlServices } from "../services.ts";

/**
 * Where a task runs (spec 12.2, 12.4) and who may use each place:
 * - a service's container: task rights on the service (members by default for their services);
 * - a server: owners and admins, and people with manage rights on that server;
 * - the Nearzero host: instance administrators only.
 */

export interface PlaceInput {
  place: TaskPlace;
  serviceId?: string | null | undefined;
  innerService?: string | null | undefined;
  serverId?: string | null | undefined;
}

export interface ResolvedPlace {
  place: TaskPlace;
  serviceId: string | null;
  innerService: string | null;
  serverId: string | null;
  /** The runner that carries the task out: a server id, or "host". */
  target: string;
  /** "web (Shop / production)", "web-1", "Nearzero host". */
  label: string;
  service: ServiceRef | null;
  server: { id: string; name: string } | null;
}

export interface ServiceRef {
  id: string;
  name: string;
  kind: string;
  appName: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  /** Compose: the stack's inner services, when known. */
  innerServices: string[];
  /** Production environments need production rights through the Agent (spec 12.2). */
  production: boolean;
}

const SERVICE_NOT_FOUND =
  "This service doesn't exist in this workspace, or you don't have access to it.";
const SERVER_NOT_FOUND =
  "This server doesn't exist in this workspace, or you don't have access to it.";

function innerServicesOf(settings: unknown): string[] {
  const inventory = (settings as { composeInventory?: { services?: unknown } } | null)
    ?.composeInventory;
  const list = Array.isArray(inventory?.services) ? inventory.services : [];
  return list
    .map((item) => (item as { name?: unknown }).name)
    .filter((name): name is string => typeof name === "string")
    .sort();
}

export async function loadServiceRef(
  db: Db,
  workspaceId: string,
  serviceId: string,
): Promise<(ServiceRef & { serverId: string | null }) | null> {
  if (!isOurId(serviceId)) return null;
  const row = await db
    .selectFrom("service as s")
    .innerJoin("project as p", "p.id", "s.project_id")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([
      "s.id",
      "s.name",
      "s.kind",
      "s.app_name",
      "s.settings",
      "s.server_id",
      "s.project_id",
      "s.environment_id",
      "p.name as project_name",
      "e.name as environment_name",
    ])
    .where("s.workspace_id", "=", workspaceId)
    .where("s.id", "=", serviceId)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    appName: row.app_name,
    projectId: row.project_id,
    projectName: row.project_name,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    innerServices: row.kind === "compose" ? innerServicesOf(row.settings) : [],
    production: row.environment_name === "production",
    serverId: row.server_id,
  };
}

export function serviceLabel(
  service: { name: string; projectName: string; environmentName: string },
  inner?: string | null,
): string {
  return `${service.name}${inner ? ` · ${inner}` : ""} (${service.projectName} / ${service.environmentName})`;
}

/** Refuses with the spec's words unless the person may manage tasks in this place. */
export async function resolvePlace(
  services: ControlServices,
  actor: WorkspaceActor,
  input: PlaceInput,
): Promise<ResolvedPlace> {
  if (input.place === "host") {
    if (!actor.isInstanceAdmin) throw new AppError("forbidden", TASK_MESSAGES.hostOnly);
    return {
      place: "host",
      serviceId: null,
      innerService: null,
      serverId: null,
      target: HOST_TARGET,
      label: HOST_NAME,
      service: null,
      server: null,
    };
  }
  if (input.place === "server") {
    const serverId = input.serverId ?? "";
    if (!isOurId(serverId)) {
      throw new AppError("invalid_request", "Choose the server the task runs on.", {
        fields: { serverId: "Choose the server the task runs on." },
      });
    }
    await actor.access.require("server.tasks", { kind: "server", id: serverId });
    const row = await services.db
      .selectFrom("server")
      .select(["id", "name"])
      .where("id", "=", serverId)
      .where("workspace_id", "=", actor.workspace.id)
      .executeTakeFirst();
    if (!row) throw new AppError("not_found", SERVER_NOT_FOUND);
    return {
      place: "server",
      serviceId: null,
      innerService: null,
      serverId: row.id,
      target: row.id,
      label: row.name,
      service: null,
      server: { id: row.id, name: row.name },
    };
  }
  const serviceId = input.serviceId ?? "";
  if (!isOurId(serviceId)) {
    throw new AppError("invalid_request", "Choose the service the task runs in.", {
      fields: { serviceId: "Choose the service the task runs in." },
    });
  }
  await actor.access.require("service.tasks", { kind: "service", id: serviceId });
  const service = await loadServiceRef(services.db, actor.workspace.id, serviceId);
  if (!service) throw new AppError("not_found", SERVICE_NOT_FOUND);
  if (isDatabaseKind(service.kind as never)) {
    throw new AppError(
      "invalid_request",
      "Tasks run in apps and Compose stacks, not in databases.",
      {
        fields: { serviceId: "Tasks run in apps and Compose stacks, not in databases." },
      },
    );
  }
  let innerService: string | null = input.innerService ?? null;
  if (service.kind === "compose") {
    if (service.innerServices.length > 1 && !innerService) {
      throw new AppError(
        "invalid_request",
        "Choose which of the stack's services the task runs in.",
        {
          fields: { innerService: "Choose which of the stack's services the task runs in." },
        },
      );
    }
    if (
      innerService &&
      service.innerServices.length > 0 &&
      !service.innerServices.includes(innerService)
    ) {
      throw new AppError("invalid_request", `The stack has no service named "${innerService}".`, {
        fields: { innerService: `The stack has no service named "${innerService}".` },
      });
    }
    if (!innerService && service.innerServices.length === 1)
      innerService = service.innerServices[0] ?? null;
  } else {
    innerService = null;
  }
  return {
    place: "container",
    serviceId: service.id,
    innerService,
    serverId: null,
    target: service.serverId ?? HOST_TARGET,
    label: serviceLabel(service, innerService),
    service,
    server: null,
  };
}

/** Whether the person may manage tasks in a place, without throwing (lists and pickers). */
export function canUsePlace(
  actor: WorkspaceActor,
  row: {
    place: TaskPlace;
    service_id: string | null;
    server_id: string | null;
    project_id?: string | null;
    environment_id?: string | null;
  },
): boolean {
  if (row.place === "host") return actor.isInstanceAdmin;
  if (row.place === "server") {
    return (
      row.server_id !== null &&
      actor.access.can("server.tasks", { kind: "server", id: row.server_id })
    );
  }
  if (!row.service_id || !row.project_id || !row.environment_id) return false;
  return actor.access.can(
    "service.tasks",
    serviceTarget({
      id: row.service_id,
      project_id: row.project_id,
      environment_id: row.environment_id,
    }),
  );
}

export interface PlaceChoices {
  services: {
    id: string;
    name: string;
    kind: string;
    projectName: string;
    environmentName: string;
    label: string;
    innerServices: string[];
  }[];
  servers: { id: string; name: string }[];
  host: boolean;
}

/** The places the person may pick in the form (spec 12.2: only those are offered). */
export async function placeChoices(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<PlaceChoices> {
  const rows = await services.db
    .selectFrom("service as s")
    .innerJoin("project as p", "p.id", "s.project_id")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([
      "s.id",
      "s.name",
      "s.kind",
      "s.settings",
      "s.project_id",
      "s.environment_id",
      "p.name as project_name",
      "e.name as environment_name",
    ])
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.deleting_run_id", "is", null)
    .orderBy("p.name")
    .orderBy("e.name")
    .orderBy("s.name")
    .execute();
  const servers = await services.db
    .selectFrom("server")
    .select(["id", "name"])
    .where("workspace_id", "=", actor.workspace.id)
    .orderBy("name")
    .execute();
  return {
    services: rows
      // Databases have shells too, but tasks are for apps and Compose stacks (spec 12.2).
      .filter((row) => !isDatabaseKind(row.kind as never))
      .filter((row) =>
        actor.access.can(
          "service.tasks",
          serviceTarget({
            id: row.id,
            project_id: row.project_id,
            environment_id: row.environment_id,
          }),
        ),
      )
      .map((row) => {
        const ref = {
          name: row.name,
          projectName: row.project_name,
          environmentName: row.environment_name,
        };
        return {
          id: row.id,
          name: row.name,
          kind: row.kind,
          projectName: row.project_name,
          environmentName: row.environment_name,
          label: serviceLabel(ref),
          innerServices: row.kind === "compose" ? innerServicesOf(row.settings) : [],
        };
      }),
    servers: servers.filter((row) =>
      actor.access.can("server.tasks", { kind: "server", id: row.id }),
    ),
    host: actor.isInstanceAdmin,
  };
}

/**
 * Whether the person may use Tasks at all (spec 12.1, 24 G8, R3-31): owners, admins and
 * instance administrators always; a member only with task rights on an app or Compose stack, or
 * manage rights on a server. Everyone else doesn't see Tasks in the sidebar, and the page says
 * they have no access.
 */
export async function canUseTasks(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<boolean> {
  if (actor.role === "owner" || actor.role === "admin" || actor.isInstanceAdmin) return true;
  const servers = await services.db
    .selectFrom("server")
    .select("id")
    .where("workspace_id", "=", actor.workspace.id)
    .execute();
  if (servers.some((row) => actor.access.can("server.tasks", { kind: "server", id: row.id })))
    return true;
  const rows = await services.db
    .selectFrom("service")
    .select(["id", "kind", "project_id", "environment_id"])
    .where("workspace_id", "=", actor.workspace.id)
    .where("deleting_run_id", "is", null)
    .execute();
  return rows.some(
    (row) =>
      !isDatabaseKind(row.kind as never) &&
      actor.access.can(
        "service.tasks",
        serviceTarget({
          id: row.id,
          project_id: row.project_id,
          environment_id: row.environment_id,
        }),
      ),
  );
}

const COMPOSE_SERVICE_LABELS = ["dev.nearzero.compose-service", "com.docker.compose.service"];

/** The running container a task runs in, or a plain refusal naming the service. */
export async function runningContainer(
  ops: ServerOps,
  serviceId: string,
  appName: string,
  innerService: string | null,
): Promise<ContainerSummary | null> {
  let list = await ops.serviceContainers(serviceId);
  if (innerService) {
    const byProject = (await ops.command("container.list", {
      all: true,
      labels: [`com.docker.compose.project=${appName}`],
    })) as ContainerSummary[];
    const seen = new Set(list.map((item) => item.id));
    list = [...list, ...byProject.filter((item) => !seen.has(item.id))];
    list = list.filter((item) =>
      COMPOSE_SERVICE_LABELS.some((label) => item.labels[label] === innerService),
    );
  }
  return (
    list
      .filter((item) => item.state === "running" && !item.labels[NEARZERO_LABELS.component])
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  );
}

export function opsFor(
  services: ControlServices,
  target: string,
  signal = new AbortController().signal,
): ServerOps {
  return new ServerOps(services, target, signal);
}
