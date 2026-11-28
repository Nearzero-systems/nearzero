import { createHash } from "node:crypto";
import {
  AppError,
  isProductionEnvironment,
  SERVICE_KIND_LABELS,
  type ServiceKind,
  type ServiceStatus,
} from "@nearzero/shared";
import type { WorkspaceAccess } from "../access/grants.ts";
import type { Db } from "../db/database.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import { environmentTarget, isOurId, serviceTarget } from "../projects/objects.ts";
import { serverIdOut } from "../services/placement.ts";
import { SERVICE_COLUMNS, type ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { isRunTracked, runningProjectRun } from "./state.ts";

/**
 * Delete plans (spec 05 5.1, 5.2): what a delete would remove, shown before anything happens.
 * Every service is listed with its server and marked production or no access; a member who
 * can't delete one of them sees why, and nothing is deleted. The fingerprint changes whenever
 * the plan would, so a delete confirmed against an old plan is refused.
 */

export interface PlanService {
  /** Hidden (null) when the viewer has no access to the service. */
  id: string | null;
  name: string | null;
  kind: ServiceKind | null;
  kindLabel: string | null;
  /** Shown when the viewer can see the environment. */
  environment: { id: string; name: string } | null;
  /** "host" for the Nearzero host. */
  serverId: string | null;
  production: boolean;
  access: boolean;
  status: ServiceStatus | null;
  deploying: boolean;
  /** A running service is stopped as part of its deletion. */
  willStop: boolean;
  beingDeleted: boolean;
}

export interface DeletePlan {
  scope: "project" | "services";
  project: { id: string; name: string };
  services: PlanService[];
  counts: {
    services: number;
    noAccess: number;
    production: number;
    deploying: number;
    running: number;
    beingDeleted: number;
  };
  /** False when any blocker applies: then nothing will be deleted. */
  canDelete: boolean;
  blockers: string[];
  warnings: string[];
  summary: string;
  confirmLabel: string;
  /** What the person types to confirm: the project's name. */
  confirmText: string;
  fingerprint: string;
  /** Set while the whole project is already being deleted. */
  inProgress: { runId: string; message: string } | null;
}

export type Candidate = ServiceRow & { environment_name: string };

export const DEPLOYING_REFUSAL = "Wait for the deployment to finish before deleting this service.";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function fingerprintOf(parts: unknown): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url").slice(0, 32);
}

export async function projectCandidates(
  db: Db,
  projectId: string,
  options: { lock?: boolean } = {},
): Promise<Candidate[]> {
  let query = db
    .selectFrom("service as s")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([...SERVICE_COLUMNS, "e.name as environment_name"])
    .where("s.project_id", "=", projectId)
    .orderBy("e.created_at")
    .orderBy((eb) => eb.fn("lower", ["s.name"]))
    .orderBy("s.id");
  if (options.lock) query = query.forUpdate();
  return query.execute();
}

export async function chosenCandidates(
  db: Db,
  workspaceId: string,
  serviceIds: readonly string[],
  options: { lock?: boolean } = {},
): Promise<Candidate[]> {
  const ids = [...new Set(serviceIds)];
  if (ids.some((id) => !isOurId(id))) throw missingService();
  let query = db
    .selectFrom("service as s")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([...SERVICE_COLUMNS, "e.name as environment_name"])
    .where("s.workspace_id", "=", workspaceId)
    .where("s.id", "in", ids)
    .orderBy("e.created_at")
    .orderBy((eb) => eb.fn("lower", ["s.name"]))
    .orderBy("s.id");
  if (options.lock) query = query.forUpdate();
  const rows = await query.execute();
  if (rows.length !== ids.length) throw missingService();
  return rows;
}

export function missingService(): AppError {
  return new AppError(
    "not_found",
    "One of the chosen services doesn't exist in this workspace any more, or you don't have access to it. Reload the page.",
  );
}

interface BuildInput {
  scope: "project" | "services";
  project: { id: string; name: string };
  environments: { id: string; project_id: string; name: string }[];
  candidates: Candidate[];
  /** project: seeing a service is enough; services: the person must be able to delete it. */
  accessCheck: (row: Candidate) => boolean;
  /** Runs that are still tracked, by id. */
  trackedRuns: ReadonlySet<string>;
  access: WorkspaceAccess;
}

function buildPlan(input: BuildInput): DeletePlan {
  const { access } = input;
  const items: PlanService[] = input.candidates.map((row) => {
    const allowed = input.accessCheck(row);
    const environmentVisible = access.can(
      "environment.see",
      environmentTarget({ id: row.environment_id, project_id: row.project_id }),
    );
    const seen = allowed || access.can("service.see", serviceTarget(row));
    return {
      id: seen ? row.id : null,
      name: seen ? row.name : null,
      kind: seen ? row.kind : null,
      kindLabel: seen ? SERVICE_KIND_LABELS[row.kind] : null,
      environment: environmentVisible
        ? { id: row.environment_id, name: row.environment_name }
        : null,
      serverId: seen ? serverIdOut(row.server_id) : null,
      production: isProductionEnvironment(row.environment_name),
      access: allowed,
      status: seen ? row.status : null,
      deploying: row.status === "deploying",
      willStop: row.status === "running",
      beingDeleted: row.deleting_run_id !== null && input.trackedRuns.has(row.deleting_run_id),
    };
  });
  const counts = {
    services: items.length,
    noAccess: items.filter((item) => !item.access).length,
    production: items.filter((item) => item.production).length,
    deploying: items.filter((item) => item.deploying).length,
    running: items.filter((item) => item.willStop).length,
    beingDeleted: items.filter((item) => item.beingDeleted).length,
  };

  const blockers: string[] = [];
  if (counts.noAccess > 0) {
    blockers.push(
      `You can't delete ${plural(counts.noAccess, "service", "services")} in this list, so nothing will be deleted. Ask an owner or admin.`,
    );
  }
  const deploying = items.filter((item) => item.deploying && item.access);
  if (deploying.length === 1) {
    blockers.push(`${deploying[0]?.name} is deploying. ${DEPLOYING_REFUSAL}`);
  } else if (deploying.length > 1) {
    blockers.push(
      `${deploying.length} services are deploying. Wait for their deployments to finish before deleting them.`,
    );
  }
  if (counts.beingDeleted > 0) {
    blockers.push(
      `${plural(counts.beingDeleted, "service in this list is", "services in this list are")} already being deleted. Wait for that to finish.`,
    );
  }
  const warnings: string[] = [];
  if (counts.production > 0) {
    warnings.push(`${plural(counts.production, "service runs", "services run")} in production.`);
  }
  if (counts.running > 0) {
    warnings.push(
      `${plural(counts.running, "service is", "services are")} running and will be stopped first.`,
    );
  }

  const name = input.project.name;
  const n = counts.services;
  const summary =
    input.scope === "project"
      ? n === 0
        ? `Delete ${name}? It has no services.`
        : `Delete ${name} and remove its ${plural(n, "service", "services")} from their servers? Their containers, volumes, files, logs, images, domains and DNS records are wiped from the servers. This cannot be undone.`
      : `Remove ${plural(n, "service", "services")} of ${name} from their servers? Their containers, volumes, files, logs, images, domains and DNS records are wiped from the servers. This cannot be undone.`;
  const confirmLabel =
    input.scope === "project"
      ? n === 0
        ? "Delete project"
        : `Delete project and ${plural(n, "service", "services")}`
      : `Delete ${plural(n, "service", "services")}`;

  const fingerprint = fingerprintOf([
    input.scope,
    input.project.id,
    input.project.name,
    input.environments.map((environment) => [environment.id, environment.name]),
    input.candidates.map((row, index) => [
      row.id,
      row.environment_id,
      row.name,
      row.status,
      row.server_id,
      items[index]?.access,
      items[index]?.beingDeleted,
    ]),
  ]);

  return {
    scope: input.scope,
    project: input.project,
    services: items,
    counts,
    canDelete: blockers.length === 0,
    blockers,
    warnings,
    summary,
    confirmLabel,
    confirmText: name,
    fingerprint,
    inProgress: null,
  };
}

async function trackedRunsOf(db: Db, candidates: Candidate[]): Promise<Set<string>> {
  const runIds = [
    ...new Set(candidates.map((row) => row.deleting_run_id).filter((id): id is string => !!id)),
  ];
  const tracked = new Set<string>();
  if (runIds.length === 0) return tracked;
  const runs = await db
    .selectFrom("delete_run")
    .select(["id", "state", "job_id"])
    .where("id", "in", runIds)
    .execute();
  for (const run of runs) if (await isRunTracked(db, run)) tracked.add(run.id);
  return tracked;
}

/** The plan for deleting a whole project: every service in every environment. */
export async function buildProjectPlan(
  db: Db,
  actor: WorkspaceActor,
  projectId: string,
  options: { lock?: boolean } = {},
): Promise<DeletePlan> {
  const project = await db
    .selectFrom("project")
    .select(["id", "name"])
    .where("workspace_id", "=", actor.workspace.id)
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  const [environments, candidates] = await Promise.all([
    db
      .selectFrom("environment")
      .select(["id", "project_id", "name"])
      .where("project_id", "=", projectId)
      .orderBy("created_at")
      .execute(),
    projectCandidates(db, projectId, options),
  ]);
  const plan = buildPlan({
    scope: "project",
    project,
    environments,
    candidates,
    accessCheck: (row) => actor.access.can("service.see", serviceTarget(row)),
    trackedRuns: await trackedRunsOf(db, candidates),
    access: actor.access,
  });
  const running = await runningProjectRun(db, projectId);
  if (running && (await isRunTracked(db, running))) {
    plan.inProgress = { runId: running.id, message: `${project.name} is already being deleted.` };
    plan.canDelete = false;
  }
  return plan;
}

/** The plan for deleting chosen services of one project (the Services page's bulk delete). */
export async function buildServicesPlan(
  db: Db,
  actor: WorkspaceActor,
  candidates: Candidate[],
): Promise<DeletePlan> {
  const projectIds = new Set(candidates.map((row) => row.project_id));
  if (projectIds.size !== 1) {
    throw new AppError("invalid_request", "Choose services of one project at a time.");
  }
  const [projectId] = [...projectIds] as [string];
  const project = await db
    .selectFrom("project")
    .select(["id", "name"])
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  const environmentIds = [...new Set(candidates.map((row) => row.environment_id))];
  const environments = await db
    .selectFrom("environment")
    .select(["id", "project_id", "name"])
    .where("id", "in", environmentIds)
    .orderBy("created_at")
    .execute();
  return buildPlan({
    scope: "services",
    project,
    environments,
    candidates,
    accessCheck: (row) => actor.access.can("service.delete", serviceTarget(row)),
    trackedRuns: await trackedRunsOf(db, candidates),
    access: actor.access,
  });
}

export async function projectDeletePlan(
  services: ControlServices,
  actor: WorkspaceActor,
  projectId: string,
): Promise<DeletePlan> {
  await actor.access.require("project.delete", { kind: "project", id: projectId });
  return buildProjectPlan(services.db, actor, projectId);
}

/** The bulk plan: the chosen services must be in this environment and visible. */
export async function servicesDeletePlan(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
  serviceIds: readonly string[],
): Promise<DeletePlan> {
  await actor.access.require("environment.see", { kind: "environment", id: environmentId });
  const candidates = await chosenCandidates(services.db, actor.workspace.id, serviceIds);
  for (const row of candidates) {
    if (row.environment_id !== environmentId) throw missingService();
    if (!actor.access.can("service.see", serviceTarget(row))) throw missingService();
  }
  return buildServicesPlan(services.db, actor, candidates);
}
