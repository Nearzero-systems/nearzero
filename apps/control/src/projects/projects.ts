import {
  AppError,
  type createProjectRequestSchema,
  DEFAULT_ENVIRONMENT_NAME,
  isProductionEnvironment,
  type ProjectSort,
  type updateProjectRequestSchema,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { z } from "zod";
import type { WorkspaceAccess } from "../access/grants.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import type { ControlServices } from "../services.ts";
import { environmentTarget, projectTarget, serviceTarget } from "./objects.ts";
import { grantToCreator, refreshAccess } from "./scope.ts";

/**
 * Projects (spec 05 5.1): the list with search and the six sort orders, create (with its one
 * "development" environment), read and update. Deleting is in ../deletion.
 */

export interface EnvironmentBrief {
  id: string;
  name: string;
  isDefault: boolean;
  isProduction: boolean;
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /** Services across all environments that the viewer can see. */
  serviceCount: number;
  /** The environments the viewer can open, oldest first. */
  environments: EnvironmentBrief[];
  /**
   * Where opening the project goes: "development", else the default, else the first; null shows
   * "No environments available".
   */
  openEnvironmentId: string | null;
  can: { update: boolean; delete: boolean; createEnvironment: boolean };
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  created_at: Date;
  updated_at: Date;
}

interface EnvironmentRowLite {
  id: string;
  project_id: string;
  name: string;
  is_default: boolean;
}

function openTarget(environments: EnvironmentBrief[]): string | null {
  return (
    environments.find((environment) => environment.name === DEFAULT_ENVIRONMENT_NAME)?.id ??
    environments.find((environment) => environment.isDefault)?.id ??
    environments[0]?.id ??
    null
  );
}

function buildView(
  project: ProjectRow,
  environments: EnvironmentRowLite[],
  serviceCount: number,
  access: WorkspaceAccess,
): ProjectView {
  const target = projectTarget(project.id);
  const briefs = environments
    .filter((environment) => access.can("environment.see", environmentTarget(environment)))
    .map((environment) => ({
      id: environment.id,
      name: environment.name,
      isDefault: environment.is_default,
      isProduction: isProductionEnvironment(environment.name),
    }));
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    createdAt: project.created_at.toISOString(),
    updatedAt: project.updated_at.toISOString(),
    serviceCount,
    environments: briefs,
    openEnvironmentId: openTarget(briefs),
    can: {
      update: access.can("project.update", target),
      delete: access.can("project.delete", target),
      createEnvironment: access.can("environment.create", target),
    },
  };
}

async function loadViews(
  db: Db,
  access: WorkspaceAccess,
  workspaceId: string,
  projectIds?: readonly string[],
): Promise<ProjectView[]> {
  if (projectIds && projectIds.length === 0) return [];
  let projects = db
    .selectFrom("project")
    .select(["id", "name", "description", "created_at", "updated_at"])
    .where("workspace_id", "=", workspaceId);
  let environments = db
    .selectFrom("environment")
    .select(["id", "project_id", "name", "is_default"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at");
  let serviceRows = db
    .selectFrom("service")
    .select(["id", "project_id", "environment_id"])
    .where("workspace_id", "=", workspaceId);
  if (projectIds) {
    projects = projects.where("id", "in", [...projectIds]);
    environments = environments.where("project_id", "in", [...projectIds]);
    serviceRows = serviceRows.where("project_id", "in", [...projectIds]);
  }
  const [projectList, environmentList, serviceList] = await Promise.all([
    projects.execute(),
    environments.execute(),
    serviceRows.execute(),
  ]);
  const visible = projectList.filter((project) =>
    access.can("project.see", projectTarget(project.id)),
  );
  const counts = new Map<string, number>();
  for (const service of serviceList) {
    if (!access.can("service.see", serviceTarget(service))) continue;
    counts.set(service.project_id, (counts.get(service.project_id) ?? 0) + 1);
  }
  return visible.map((project) =>
    buildView(
      project,
      environmentList.filter((environment) => environment.project_id === project.id),
      counts.get(project.id) ?? 0,
      access,
    ),
  );
}

const byName = (a: ProjectView, b: ProjectView) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" });
const byNewest = (a: ProjectView, b: ProjectView) =>
  b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

const SORTS: Record<ProjectSort, (a: ProjectView, b: ProjectView) => number> = {
  "name-asc": (a, b) => byName(a, b) || byNewest(a, b),
  "name-desc": (a, b) => byName(b, a) || byNewest(a, b),
  newest: byNewest,
  oldest: (a, b) => byNewest(b, a),
  "most-services": (a, b) => b.serviceCount - a.serviceCount || byName(a, b) || byNewest(a, b),
  "least-services": (a, b) => a.serviceCount - b.serviceCount || byName(a, b) || byNewest(a, b),
};

export interface ProjectList {
  projects: ProjectView[];
  /** Projects the viewer can see ("N total"). */
  total: number;
  /** Of those, the ones matching the search ("N of M total"). */
  matching: number;
  search: string;
  sort: ProjectSort;
  can: { create: boolean };
}

/** Search is case-insensitive over name and description; sorting is done here, not in the browser. */
export async function listProjects(
  services: ControlServices,
  actor: WorkspaceActor,
  query: { search: string; sort: ProjectSort },
): Promise<ProjectList> {
  const all = await loadViews(services.db, actor.access, actor.workspace.id);
  const needle = query.search.toLowerCase();
  const matching = needle
    ? all.filter(
        (project) =>
          project.name.toLowerCase().includes(needle) ||
          project.description.toLowerCase().includes(needle),
      )
    : all;
  return {
    projects: [...matching].sort(SORTS[query.sort]),
    total: all.length,
    matching: matching.length,
    search: query.search,
    sort: query.sort,
    can: { create: actor.access.can("project.create") },
  };
}

export async function getProject(
  services: ControlServices,
  actor: WorkspaceActor,
  projectId: string,
): Promise<ProjectView> {
  await actor.access.require("project.see", { kind: "project", id: projectId });
  const [view] = await loadViews(services.db, actor.access, actor.workspace.id, [projectId]);
  if (!view)
    throw new AppError("not_found", "This project doesn't exist in this workspace any more.");
  return view;
}

/** Creates a project with exactly one environment, "development", its default. */
export async function createProject(
  services: ControlServices,
  actor: WorkspaceActor,
  input: z.output<typeof createProjectRequestSchema>,
): Promise<{ project: ProjectView; environmentId: string; message: string }> {
  const { db } = services;
  await actor.access.require("project.create");
  const created = await db.transaction().execute(async (trx) => {
    const project = await trx
      .insertInto("project")
      .values({
        workspace_id: actor.workspace.id,
        name: input.name,
        description: input.description,
        created_by: actor.personId,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    const environment = await trx
      .insertInto("environment")
      .values({
        workspace_id: actor.workspace.id,
        project_id: project.id,
        name: DEFAULT_ENVIRONMENT_NAME,
        is_default: true,
        created_by: actor.personId,
      })
      .returning(["id"])
      .executeTakeFirstOrThrow();
    return { projectId: project.id, environmentId: environment.id };
  });
  if (await grantToCreator(db, actor, [projectTarget(created.projectId)])) {
    await refreshAccess(services, actor);
  }
  await recordAudit(db, services.log, auditActor(actor), {
    action: "project.created",
    workspaceId: actor.workspace.id,
    target: { kind: "project", id: created.projectId },
    details: { name: input.name },
  });
  return {
    project: await getProject(services, actor, created.projectId),
    environmentId: created.environmentId,
    message: "Project created",
  };
}

export async function updateProject(
  services: ControlServices,
  actor: WorkspaceActor,
  projectId: string,
  input: z.output<typeof updateProjectRequestSchema>,
): Promise<{ project: ProjectView; message: string }> {
  const { db } = services;
  await actor.access.require("project.update", { kind: "project", id: projectId });
  const before = await db
    .selectFrom("project")
    .select(["name"])
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  await db
    .updateTable("project")
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updated_at: sql<Date>`now()`,
    })
    .where("workspace_id", "=", actor.workspace.id)
    .where("id", "=", projectId)
    .execute();
  await recordAudit(db, services.log, auditActor(actor), {
    action: "project.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "project", id: projectId },
    details: {
      ...(input.name !== undefined && input.name !== before.name
        ? { renamedFrom: before.name, name: input.name }
        : {}),
      ...(input.description !== undefined ? { descriptionChanged: true } : {}),
    },
  });
  return { project: await getProject(services, actor, projectId), message: "Project updated" };
}
