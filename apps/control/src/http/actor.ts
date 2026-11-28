import { AppError, type Role } from "@nearzero/shared";
import type { Context } from "hono";
import { loadGrants, WorkspaceAccess } from "../access/grants.ts";
import type { AuditActor } from "../audit/audit.ts";
import { requireSession } from "../identity/sessions.ts";
import type { ControlServices } from "../services.ts";
import {
  isInstanceAdmin,
  resolveActiveWorkspace,
  type WorkspaceSummary,
} from "../workspaces/workspaces.ts";
import { clientInfo } from "./client.ts";
import type { AppEnv } from "./context.ts";

/**
 * Who is making a request: the signed-in person and, for workspace endpoints, their active
 * workspace, role and access. Every workspace endpoint acts on the active workspace only
 * (spec 22.4, rule 1).
 */

export interface Actor {
  personId: string;
  email: string;
  sessionId: string;
  clientAddress: string;
  secure: boolean;
  userAgent: string | null;
  /** Set when the Agent acts for this person: area audit records then name the Agent (spec 19.6). */
  viaAgent?: { sessionId: string; turnId: string };
}

export interface WorkspaceActor extends Actor {
  workspace: WorkspaceSummary;
  role: Role;
  isInstanceAdmin: boolean;
  access: WorkspaceAccess;
}

export async function actorFor(c: Context<AppEnv>, services: ControlServices): Promise<Actor> {
  const session = requireSession(c);
  const person = await services.db
    .selectFrom("person")
    .select(["email"])
    .where("id", "=", session.personId)
    .executeTakeFirst();
  if (!person) {
    throw new AppError("unauthenticated", "Your session has ended. Sign in again to continue.");
  }
  const client = clientInfo(c, services.trustedProxies);
  return {
    personId: session.personId,
    email: person.email,
    sessionId: session.id,
    clientAddress: client.address,
    secure: client.secure,
    userAgent: c.req.header("user-agent") ?? null,
  };
}

export async function workspaceActorFor(
  c: Context<AppEnv>,
  services: ControlServices,
): Promise<WorkspaceActor> {
  const actor = await actorFor(c, services);
  const session = requireSession(c);
  const workspace = await resolveActiveWorkspace(services.db, {
    id: session.id,
    personId: session.personId,
    activeWorkspaceId: session.activeWorkspaceId,
  });
  if (!workspace) {
    throw new AppError(
      "not_found",
      "You don't belong to any workspace. Ask a workspace owner to invite you.",
    );
  }
  const [instanceAdmin, hostAllowed] = await Promise.all([
    isInstanceAdmin(services.db, actor.personId),
    services.db
      .selectFrom("host_allowed_workspace")
      .select("workspace_id")
      .where("workspace_id", "=", workspace.id)
      .executeTakeFirst()
      .then((row) => row !== undefined),
  ]);
  const grants = await loadGrants(services.db, {
    personId: actor.personId,
    workspaceId: workspace.id,
    role: workspace.role,
    isInstanceAdmin: instanceAdmin,
    hostAllowed,
  });
  return {
    ...actor,
    workspace,
    role: workspace.role,
    isInstanceAdmin: instanceAdmin,
    access: new WorkspaceAccess(services.db, services.objects, grants),
  };
}

export function auditActor(actor: Actor): AuditActor {
  return {
    kind: actor.viaAgent ? "agent" : "person",
    personId: actor.personId,
    label: actor.email,
    clientAddress: actor.clientAddress,
  };
}
