import { AppError } from "@nearzero/shared";
import type { WorkspaceActor } from "../../http/actor.ts";
import { HOST_TARGET } from "../../runners/hub.ts";
import { auditServer, checkServer } from "../../server-setup/inspect.ts";
import { readSetupLog } from "../../server-setup/log.ts";
import { startServerRemoval } from "../../server-setup/removal.ts";
import { latestRun, setupView, startSetup } from "../../server-setup/runs.ts";
import type { ControlServices } from "../../services.ts";

/**
 * The Agent's seam to server setup over SSH (M6, still being finished): setup runs, their logs,
 * validation, the security audit and removal, each through the module's own exported functions
 * with the person's actor and the same permission checks as its routes. When M6 changes its
 * functions, only this file follows.
 */

export interface ServerSetupPort {
  start(
    services: ControlServices,
    actor: WorkspaceActor,
    serverId: string,
    sshUser?: string,
  ): Promise<{ started: boolean }>;
  progress(
    services: ControlServices,
    actor: WorkspaceActor,
    serverId: string,
  ): Promise<SetupProgress>;
  log(
    services: ControlServices,
    actor: WorkspaceActor,
    serverId: string,
    lines: number,
  ): Promise<string>;
  validate(services: ControlServices, actor: WorkspaceActor, serverId: string): Promise<unknown>;
  audit(services: ControlServices, actor: WorkspaceActor, serverId: string): Promise<unknown>;
  /**
   * Removes a server with no services at all; `refuse` is called with the ids of the services
   * still on it, and throws the refusal (spec 9.6: never a service deleted as a side effect).
   */
  remove(
    services: ControlServices,
    actor: WorkspaceActor,
    serverId: string,
    refuse: (serviceIds: string[]) => Promise<never>,
  ): Promise<{ message: string }>;
}

export interface SetupProgress {
  state: "none" | "running" | "succeeded" | "failed";
  step: string | null;
  failure: {
    message: string;
    suggestedUser: string | null;
    hints: string[];
    fixCommand: string | null;
  } | null;
}

function noHost(serverId: string): void {
  if (serverId === HOST_TARGET) {
    throw new AppError(
      "invalid_request",
      "The Nearzero host is set up by the installer, not from here. On the host, run: sudo nearzero status",
    );
  }
}

export const serverSetupPort: ServerSetupPort = {
  async start(services, actor, serverId, sshUser) {
    noHost(serverId);
    const result = await startSetup(services, actor, serverId, sshUser ? { sshUser } : {});
    return { started: result.started };
  },
  async progress(services, actor, serverId) {
    noHost(serverId);
    const view = await setupView(services, actor, serverId);
    const run = view.run;
    if (!run) return { state: "none", step: null, failure: null };
    return {
      state: run.state,
      step: run.stepTitle,
      failure: run.failure
        ? {
            message: run.failure.message,
            suggestedUser: run.failure.suggestedUser,
            hints: run.failure.hints,
            fixCommand: run.failure.fixCommand,
          }
        : null,
    };
  },
  async log(services, actor, serverId, lines) {
    noHost(serverId);
    await actor.access.require("server.see", { kind: "server", id: serverId });
    const run = await latestRun(services.db, serverId);
    if (!run) return "";
    const pieces = await readSetupLog(services.db, run.id, 0, 20_000);
    return pieces
      .map((piece) => piece.text)
      .join("\n")
      .split("\n")
      .slice(-lines)
      .join("\n");
  },
  // Both only read the server, so seeing it is enough, as on its details (R3-06).
  async validate(services, actor, serverId) {
    noHost(serverId);
    return checkServer(services, actor, serverId);
  },
  async audit(services, actor, serverId) {
    noHost(serverId);
    return auditServer(services, actor, serverId);
  },
  async remove(services, actor, serverId, refuse) {
    noHost(serverId);
    await startServerRemoval(services, actor, serverId, { onlyEmpty: refuse });
    return {
      message:
        "Removing the server. Its runner is uninstalled and its records deleted in the background.",
    };
  },
};
