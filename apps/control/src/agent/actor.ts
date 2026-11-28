import { AppError } from "@nearzero/shared";
import { loadGrants, WorkspaceAccess } from "../access/grants.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import type { ControlServices } from "../services.ts";
import { isInstanceAdmin, listMemberships } from "../workspaces/workspaces.ts";

/**
 * The person the Agent acts for, rebuilt from the database for every stretch of a turn: their
 * current role, grants and workspace, so a member removed or narrowed meanwhile gets exactly what
 * they may do now (spec 01 principle 1, 20 intro). Area functions take it as any request's actor;
 * `viaAgent` makes their audit records name the Agent.
 */
export async function agentActor(
  services: ControlServices,
  input: { personId: string; workspaceId: string; sessionId: string; turnId: string },
): Promise<WorkspaceActor> {
  const { db } = services;
  const person = await db
    .selectFrom("person")
    .select(["email"])
    .where("id", "=", input.personId)
    .executeTakeFirst();
  const workspace = person
    ? (await listMemberships(db, input.personId)).find((item) => item.id === input.workspaceId)
    : undefined;
  if (!person || !workspace) {
    throw new AppError(
      "forbidden",
      "You're no longer a member of this workspace, so the Agent can't act for you here.",
    );
  }
  const [instanceAdmin, hostAllowed] = await Promise.all([
    isInstanceAdmin(db, input.personId),
    db
      .selectFrom("host_allowed_workspace")
      .select("workspace_id")
      .where("workspace_id", "=", workspace.id)
      .executeTakeFirst()
      .then((row) => row !== undefined),
  ]);
  const grants = await loadGrants(db, {
    personId: input.personId,
    workspaceId: workspace.id,
    role: workspace.role,
    isInstanceAdmin: instanceAdmin,
    hostAllowed,
  });
  return {
    personId: input.personId,
    email: person.email,
    sessionId: `agent:${input.sessionId}`,
    clientAddress: "agent",
    secure: false,
    userAgent: "Nearzero Agent",
    viaAgent: { sessionId: input.sessionId, turnId: input.turnId },
    workspace,
    role: workspace.role,
    isInstanceAdmin: instanceAdmin,
    access: new WorkspaceAccess(db, services.objects, grants),
  };
}
