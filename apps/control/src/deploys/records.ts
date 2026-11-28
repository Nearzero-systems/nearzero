import {
  AppError,
  DEPLOYMENT_STATUS_LABELS,
  type DeploymentStatus,
  type DeployTrigger,
  HOST_SERVER_ID,
  isDatabaseKind,
  isDeploymentOpen,
  SERVICE_KIND_LABELS,
  type ServiceKind,
  shortCommit,
} from "@nearzero/shared";
import type { Selectable } from "kysely";
import { isWorkspaceAdmin } from "../access/evaluate.ts";
import type { Db } from "../db/database.ts";
import type { DeploymentTable } from "../db/schema.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import { isOurId, serviceTarget } from "../projects/objects.ts";

/**
 * Deployment records as people see them (spec 11.1, 11.2, 11.4): one view for the list, the
 * service's Deployments panel, the detail page and the bell. Who sees a deployment follows its
 * service: people with access to the service; a removed service's rows only owners and admins.
 */

export type DeploymentRow = Selectable<DeploymentTable>;

export interface DeploymentView {
  id: string;
  status: DeploymentStatus;
  statusLabel: string;
  trigger: DeployTrigger;
  title: string;
  commit: string | null;
  shortCommit: string | null;
  service: { id: string | null; name: string; kind: ServiceKind; kindLabel: string; type: string };
  project: { id: string | null; name: string };
  environment: { id: string | null; name: string };
  /** "host" for the Nearzero host. */
  server: { id: string; name: string };
  source: Record<string, unknown>;
  builder: string | null;
  framework: string | null;
  image: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Milliseconds; for running deployments, so far ("… so far"). */
  durationMs: number | null;
  running: boolean;
  log: { lines: number; bytes: number; truncated: boolean };
  can: { cancel: boolean; redeploy: boolean };
}

export const DEPLOYMENT_COLUMNS = [
  "d.id",
  "d.workspace_id",
  "d.service_id",
  "d.project_id",
  "d.environment_id",
  "d.service_kind",
  "d.service_name",
  "d.app_name",
  "d.project_name",
  "d.environment_name",
  "d.server_id",
  "d.server_name",
  "d.status",
  "d.trigger",
  "d.requested_by",
  "d.title",
  "d.source",
  "d.requested_commit",
  "d.requested_tag",
  "d.commit_hash",
  "d.builder",
  "d.framework",
  "d.image",
  "d.container_name",
  "d.error",
  "d.clean_cache",
  "d.cancel_requested_at",
  "d.job_id",
  "d.log_bytes",
  "d.log_lines",
  "d.log_truncated",
  "d.builds",
  "d.pipeline_outcome",
  "d.created_at",
  "d.started_at",
  "d.finished_at",
  "d.removed_at",
  "d.updated_at",
] as const;

export function serviceType(kind: ServiceKind): "application" | "compose" | "database" {
  if (kind === "application" || kind === "compose") return kind;
  return "database";
}

export function deploymentView(
  row: DeploymentRow,
  actor: WorkspaceActor | null,
  now = Date.now(),
): DeploymentView {
  const kind = row.service_kind as ServiceKind;
  const end = row.finished_at?.getTime() ?? (row.status === "building" ? now : null);
  const target =
    row.service_id && row.project_id && row.environment_id
      ? serviceTarget({
          id: row.service_id,
          project_id: row.project_id,
          environment_id: row.environment_id,
        })
      : null;
  const canDeploy = actor !== null && target !== null && actor.access.can("service.deploy", target);
  return {
    id: row.id,
    status: row.status,
    statusLabel: DEPLOYMENT_STATUS_LABELS[row.status],
    trigger: row.trigger,
    title: row.title,
    commit: row.commit_hash,
    shortCommit: shortCommit(row.commit_hash),
    service: {
      id: row.service_id,
      name: row.service_name,
      kind,
      kindLabel: SERVICE_KIND_LABELS[kind] ?? kind,
      type: serviceType(kind),
    },
    project: { id: row.project_id, name: row.project_name },
    environment: { id: row.environment_id, name: row.environment_name },
    server: { id: row.server_id ?? HOST_SERVER_ID, name: row.server_name },
    source: row.source ?? {},
    builder: row.builder,
    framework: row.framework,
    image: row.image,
    error: row.error,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    durationMs: row.started_at && end !== null ? Math.max(0, end - row.started_at.getTime()) : null,
    running: row.status === "building",
    log: { lines: row.log_lines, bytes: row.log_bytes, truncated: row.log_truncated },
    can: {
      cancel: canDeploy && isDeploymentOpen(row.status),
      redeploy:
        canDeploy && row.status !== "building" && row.status !== "removed" && !isDatabaseKind(kind),
    },
  };
}

/**
 * A deployment the person may see, or "not found" (spec 11.4, 22.4 rule 3): in the active
 * workspace, and of a service they can see (a removed service's rows: owners and admins).
 */
export async function visibleDeployment(
  db: Db,
  actor: WorkspaceActor,
  deploymentId: string,
): Promise<DeploymentRow> {
  const missing = new AppError(
    "not_found",
    "Deployment not found. This deployment may have been removed or filtered out.",
  );
  if (!isOurId(deploymentId)) throw missing;
  const row = await db
    .selectFrom("deployment as d")
    .select(DEPLOYMENT_COLUMNS)
    .where("d.id", "=", deploymentId)
    .where("d.workspace_id", "=", actor.workspace.id)
    .executeTakeFirst();
  if (!row) throw missing;
  if (!canSeeDeployment(actor, row)) throw missing;
  return row;
}

export function canSeeDeployment(actor: WorkspaceActor, row: DeploymentRow): boolean {
  if (isWorkspaceAdmin(actor.role)) return true;
  if (!row.service_id || !row.project_id || !row.environment_id) return false;
  return actor.access.can(
    "service.deployments",
    serviceTarget({
      id: row.service_id,
      project_id: row.project_id,
      environment_id: row.environment_id,
    }),
  );
}

/** The services a member may see deployments of; null means every one (owners and admins). */
export async function visibleServiceIds(db: Db, actor: WorkspaceActor): Promise<string[] | null> {
  if (isWorkspaceAdmin(actor.role)) return null;
  const rows = await db
    .selectFrom("service")
    .select(["id", "project_id", "environment_id"])
    .where("workspace_id", "=", actor.workspace.id)
    .execute();
  return rows
    .filter((row) => actor.access.can("service.deployments", serviceTarget(row)))
    .map((row) => row.id);
}

/** A service's last deploy result, for its views (the canvas shows services whose last deploy succeeded). */
export interface ServiceDeploySummary {
  /** The newest finished deployment (cancelled ones don't count), or null before any. */
  last: {
    id: string;
    status: DeploymentStatus;
    statusLabel: string;
    succeeded: boolean;
    title: string;
    commit: string | null;
    shortCommit: string | null;
    finishedAt: string | null;
  } | null;
  /** The deployment queued or building now, if any. */
  inProgress: { id: string; status: "queued" | "building" } | null;
}

export async function deploySummaries(
  db: Db,
  serviceIds: readonly string[],
): Promise<Map<string, ServiceDeploySummary>> {
  const out = new Map<string, ServiceDeploySummary>();
  for (const id of serviceIds) out.set(id, { last: null, inProgress: null });
  if (serviceIds.length === 0) return out;
  const finished = await db
    .selectFrom("deployment")
    .distinctOn("service_id")
    .select(["id", "service_id", "status", "title", "commit_hash", "finished_at"])
    .where("service_id", "in", [...serviceIds])
    .where("status", "not in", ["queued", "building", "cancelled", "removed"])
    .orderBy("service_id")
    .orderBy("created_at", "desc")
    .execute();
  for (const row of finished) {
    const summary = out.get(row.service_id as string);
    if (!summary) continue;
    summary.last = {
      id: row.id,
      status: row.status,
      statusLabel: DEPLOYMENT_STATUS_LABELS[row.status],
      succeeded: row.status !== "failed",
      title: row.title,
      commit: row.commit_hash,
      shortCommit: shortCommit(row.commit_hash),
      finishedAt: row.finished_at?.toISOString() ?? null,
    };
  }
  const open = await db
    .selectFrom("deployment")
    .select(["id", "service_id", "status"])
    .where("service_id", "in", [...serviceIds])
    .where("status", "in", ["queued", "building"])
    .orderBy("created_at")
    .execute();
  for (const row of open) {
    const summary = out.get(row.service_id as string);
    if (!summary) continue;
    // The building one wins over the one waiting behind it.
    if (!summary.inProgress || row.status === "building") {
      summary.inProgress = { id: row.id, status: row.status as "queued" | "building" };
    }
  }
  return out;
}
