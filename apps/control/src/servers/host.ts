import { AppError } from "@nearzero/shared";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { isOurId } from "../projects/objects.ts";
import { hostRunnerView, type RunnerView } from "../runners/records.ts";
import type { ControlServices } from "../services.ts";
import { HOST_NAME } from "./targets.ts";

/**
 * The Nearzero host as a deploy target (spec 02, spec 24 G3): always there for instance
 * administrators, and for the workspaces they allow. Everyone else is never offered it.
 */

export interface HostView {
  id: "host";
  name: string;
  /** Whether people in the active workspace may deploy to it. */
  available: boolean;
  runner: Pick<RunnerView, "state" | "version" | "message" | "updateNeeded"> & Partial<RunnerView>;
  /** Whether the person may read its containers, logs, metrics and router files. */
  canManage: boolean;
}

export async function hostView(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<HostView> {
  const available = actor.access.can("host.use");
  if (!available) {
    throw new AppError("not_found", "The Nearzero host isn't available to this workspace.");
  }
  const canManage = actor.access.can("host.manage");
  const runner = await hostRunnerView(services);
  return {
    id: "host",
    name: HOST_NAME,
    available,
    canManage,
    runner: canManage
      ? runner
      : {
          state: runner.state,
          version: runner.version,
          message: runner.message,
          updateNeeded: runner.updateNeeded,
        },
  };
}

export interface HostAllowance {
  workspaceId: string;
  name: string;
  slug: string;
  /**
   * Who owns it, so workspaces of the same name (every personal one is "My Workspace") can be
   * told apart (B3-23): their name, or their email without one.
   */
  owner: string | null;
  /** The first workspace's people are instance administrators; it is always allowed. */
  first: boolean;
  allowed: boolean;
  allowedAt: string | null;
}

export async function listHostAllowances(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<HostAllowance[]> {
  await actor.access.require("host.manage");
  const [rows, first] = await Promise.all([
    services.db
      .selectFrom("workspace as w")
      .leftJoin("host_allowed_workspace as h", "h.workspace_id", "w.id")
      .leftJoin("membership as m", (join) =>
        join.onRef("m.workspace_id", "=", "w.id").on("m.role", "=", "owner"),
      )
      .leftJoin("person as p", "p.id", "m.person_id")
      .select([
        "w.id",
        "w.name",
        "w.slug",
        "h.allowed_at",
        "p.email",
        "p.first_name",
        "p.last_name",
      ])
      .orderBy("w.name")
      .orderBy("p.email")
      .execute(),
    services.db.selectFrom("install_state").select("first_workspace_id").executeTakeFirst(),
  ]);
  return rows.map((row) => {
    const isFirst = row.id === first?.first_workspace_id;
    const fullName = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
    return {
      workspaceId: row.id,
      name: row.name,
      slug: row.slug,
      owner: fullName ? `${fullName} (${row.email})` : (row.email ?? null),
      first: isFirst,
      allowed: isFirst || row.allowed_at !== null,
      allowedAt: row.allowed_at?.toISOString() ?? null,
    };
  });
}

export async function setHostAllowance(
  services: ControlServices,
  actor: WorkspaceActor,
  workspaceId: string,
  allowed: boolean,
): Promise<void> {
  await actor.access.require("host.manage");
  const workspace =
    isOurId(workspaceId) &&
    (await services.db
      .selectFrom("workspace")
      .select(["id", "name"])
      .where("id", "=", workspaceId)
      .executeTakeFirst());
  if (!workspace) throw new AppError("not_found", "There's no such workspace on this Nearzero.");
  if (allowed) {
    await services.db
      .insertInto("host_allowed_workspace")
      .values({ workspace_id: workspaceId, allowed_by: actor.personId })
      .onConflict((conflict) => conflict.column("workspace_id").doNothing())
      .execute();
  } else {
    await services.db
      .deleteFrom("host_allowed_workspace")
      .where("workspace_id", "=", workspaceId)
      .execute();
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: allowed ? "host.workspace-allowed" : "host.workspace-disallowed",
    workspaceId,
    target: { kind: "workspace", id: workspaceId },
    details: { name: workspace.name },
  });
}
