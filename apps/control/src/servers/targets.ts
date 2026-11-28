import { AppError, NEARZERO_LABELS } from "@nearzero/shared";
import type { Action } from "../access/matrix.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";

/**
 * The places work runs: one of the workspace's servers, or the Nearzero host. Endpoints that act
 * on "a server" take either a server id or "host". The host belongs to no workspace, and reading
 * or operating it (containers, logs, terminals, metrics, router files) is for instance
 * administrators only (spec 22.2, 24 G3); a server needs the right named for the action.
 */

export interface Target {
  /** The hub's key: the server id, or "host". */
  key: string;
  name: string;
  serverId: string | null;
}

export const HOST_NAME = "Nearzero host";

export async function resolveTarget(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  serverAction: Action,
): Promise<Target> {
  if (id === HOST_TARGET) {
    await actor.access.require("host.manage");
    return { key: HOST_TARGET, name: HOST_NAME, serverId: null };
  }
  await actor.access.require(serverAction, { kind: "server", id });
  const row = await services.db
    .selectFrom("server")
    .select(["id", "name"])
    .where("id", "=", id)
    .where("workspace_id", "=", actor.workspace.id)
    .executeTakeFirstOrThrow();
  return { key: row.id, name: row.name, serverId: row.id };
}

/** Routes are internal plumbing: instance administrators only, on top of the target's rights. */
export async function resolveRouteTarget(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<Target> {
  if (!actor.isInstanceAdmin) {
    throw new AppError(
      "forbidden",
      "Only Nearzero administrators can change router routes directly. Hostnames are added from a service.",
    );
  }
  return resolveTarget(services, actor, id, "server.manage");
}

export const RESERVED_CONTAINER =
  "That container is part of Nearzero itself, so it can't be opened from here. On the host, use: sudo nearzero logs";

/**
 * A container on the target that people may reach: Nearzero's own (control plane, database,
 * runner, router, DNS) are reserved (spec 22.4, rule 4).
 */
export async function reachableContainer(
  services: ControlServices,
  target: Target,
  container: string,
): Promise<{ id: string; name: string; labels: Record<string, string> }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(container)) {
    throw new AppError("not_found", "There's no such container on this server.");
  }
  const details = (await services.runners.command(target.key, "container.inspect", {
    id: container,
  })) as { id: string; name: string; labels: Record<string, string> };
  if (details.labels[NEARZERO_LABELS.component])
    throw new AppError("forbidden", RESERVED_CONTAINER);
  return details;
}
