import type { AccessTarget, ObjectRegistry } from "../access/objects.ts";
import type { Db } from "../db/database.ts";

/**
 * Projects, environments and services as the permission module sees them: resolvers that find
 * them inside one workspace (so another workspace's ids are simply not found), and the targets
 * policy scopes are checked against (project → environment → service).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ids that can be ours; anything else is "not found" without asking the database. */
export function ourIds(ids: readonly string[]): string[] {
  return ids.filter((id) => UUID.test(id));
}

export function isOurId(id: string): boolean {
  return UUID.test(id);
}

export function projectTarget(id: string): AccessTarget {
  return { kind: "project", id };
}

export function environmentTarget(row: { id: string; project_id: string }): AccessTarget {
  return { kind: "environment", id: row.id, projectId: row.project_id };
}

export function serviceTarget(row: {
  id: string;
  project_id: string;
  environment_id: string;
}): AccessTarget {
  return {
    kind: "service",
    id: row.id,
    projectId: row.project_id,
    environmentId: row.environment_id,
  };
}

export function registerProjectObjects(registry: ObjectRegistry): void {
  registry.register("project", {
    async resolve(db: Db, workspaceId, ids) {
      const wanted = ourIds(ids);
      if (wanted.length === 0) return [];
      const rows = await db
        .selectFrom("project")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("id", "in", wanted)
        .execute();
      return rows.map((row) => projectTarget(row.id));
    },
  });
  registry.register("environment", {
    async resolve(db: Db, workspaceId, ids) {
      const wanted = ourIds(ids);
      if (wanted.length === 0) return [];
      const rows = await db
        .selectFrom("environment")
        .select(["id", "project_id"])
        .where("workspace_id", "=", workspaceId)
        .where("id", "in", wanted)
        .execute();
      return rows.map(environmentTarget);
    },
  });
  registry.register("service", {
    async resolve(db: Db, workspaceId, ids) {
      const wanted = ourIds(ids);
      if (wanted.length === 0) return [];
      const rows = await db
        .selectFrom("service")
        .select(["id", "project_id", "environment_id"])
        .where("workspace_id", "=", workspaceId)
        .where("id", "in", wanted)
        .execute();
      return rows.map(serviceTarget);
    },
  });
}

/** A workspace that still has projects can't be deleted (spec 23.1). */
export async function projectsBlockWorkspaceDeletion(
  db: Db,
  workspaceId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("project")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  const count = Number(row.count);
  if (count === 0) return null;
  return `Delete this workspace's ${count} ${count === 1 ? "project" : "projects"} first, then try again.`;
}
