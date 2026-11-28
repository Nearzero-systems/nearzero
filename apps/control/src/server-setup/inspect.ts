import {
  AppError,
  type AuditView,
  VALIDATION_FRESH_MS,
  type ValidationView,
} from "@nearzero/shared";
import type { WorkspaceActor } from "../http/actor.ts";
import { loadView } from "../servers/servers.ts";
import type { ControlServices } from "../services.ts";
import { runAudit } from "./audit.ts";
import { AccessFailure, loadServerAccess, signIn } from "./connection.ts";
import { storedValidation, unconfirmedValidation, validateServer } from "./validation.ts";

/**
 * Looking at a server (spec 09 9.4; spec 30 decisions part 2, R3-06): setup validation and the
 * security audit only read the server, so anyone who can see it may run them; changing anything
 * still needs the server's manage rights. Opening a set-up server's details checks it again
 * unless the stored result is under a minute old. Shared by the API and the Agent.
 */

/** Checks running now, by server, so two people opening the details share one sign-in. */
const inFlight = new WeakMap<ControlServices, Map<string, Promise<ValidationView>>>();

async function checkNow(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
): Promise<ValidationView> {
  const view = await loadView(services, actor.workspace.id, serverId);
  const server = await loadServerAccess(services.db, serverId);
  if (!server) throw new AppError("not_found", "This server doesn't exist any more.");
  try {
    const { session, sudo } = await signIn(services, server);
    try {
      const reason =
        view.setup.error ?? (view.setup.state === "not_started" ? "setup hasn't run" : null);
      return await validateServer(
        services,
        { serverId, user: server.user, session, sudo, readiness: view.readiness },
        reason,
      );
    } finally {
      session.close();
    }
  } catch (error) {
    if (error instanceof AccessFailure) return unconfirmedValidation(error.failure.message);
    if (error instanceof AppError) throw error;
    services.log.warn("a server check couldn't finish", { serverId, error });
    return unconfirmedValidation(`The check couldn't finish: ${(error as Error).message}`);
  }
}

/** "Check again": validates the server now, for anyone who can see it. */
export async function checkServer(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
): Promise<ValidationView> {
  await actor.access.require("server.see", { kind: "server", id: serverId });
  let running = inFlight.get(services);
  if (!running) {
    running = new Map();
    inFlight.set(services, running);
  }
  const current = running.get(serverId);
  if (current) return current;
  const check = checkNow(services, actor, serverId).finally(() => {
    if (running.get(serverId) === check) running.delete(serverId);
  });
  running.set(serverId, check);
  return check;
}

/**
 * What the details show when they open: for a server that has been set up, a validation checked
 * now unless the stored one is under a minute old; otherwise the stored one, which may be null.
 * A server that was never checked over SSH (one that joined with the join command, which
 * Nearzero may not reach over SSH at all) isn't signed in to until someone presses Check again.
 */
export async function validationOnOpen(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
): Promise<ValidationView | null> {
  await actor.access.require("server.see", { kind: "server", id: serverId });
  const view = await loadView(services, actor.workspace.id, serverId);
  const row = await services.db
    .selectFrom("server_inspection")
    .select("validation_at")
    .where("server_id", "=", serverId)
    .executeTakeFirst();
  const at = row?.validation_at ? new Date(row.validation_at).getTime() : null;
  const fresh = at !== null && services.now() - at < VALIDATION_FRESH_MS;
  if (view.setup.state !== "ready" || at === null || fresh) {
    return storedValidation(services, serverId);
  }
  return checkServer(services, actor, serverId);
}

/** The read-only security audit, for anyone who can see the server. */
export async function auditServer(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string,
): Promise<AuditView> {
  await actor.access.require("server.see", { kind: "server", id: serverId });
  await loadView(services, actor.workspace.id, serverId);
  return runAudit(services, serverId);
}
