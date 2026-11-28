import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import { bundleLines } from "./bundle.ts";
import type { ImportRun } from "./importer.ts";
import { RECORD_FILES, type RecordKind } from "./records.ts";
import type { ConsolePathKind } from "./tables.ts";

/**
 * Old console addresses (spec 29a.9.1): the path at which 0.1.x showed a project, environment,
 * service, deployment or server is kept, and a request for it (with or without the old workspace
 * prefix) finds the object, whose 1.0 page the console then opens.
 */

const KINDS: [RecordKind, ConsolePathKind][] = [
  ["projects", "project"],
  ["environments", "environment"],
  ["services", "service"],
  ["deployments", "deployment"],
  ["servers", "server"],
];

/** An old address as it is kept: its path only (no host, query or fragment), no trailing slash. */
export function consolePathKey(raw: string): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return null;
  let path: string;
  try {
    path = new URL(raw, "http://old.invalid").pathname;
  } catch {
    return null;
  }
  path = path.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return path.length >= 2 && path.startsWith("/") ? path : null;
}

/** The path without its first segment (an old workspace prefix), when it has more than one. */
export function consolePathTail(path: string): string | null {
  const parts = path.split("/").filter(Boolean);
  return parts.length >= 2 ? `/${parts.slice(1).join("/")}` : null;
}

/**
 * Keeps each imported object's old address. A deployment that wasn't imported (export without
 * deployments) leads to its service's page instead.
 */
export async function importConsolePaths(run: ImportRun): Promise<void> {
  let kept = 0;
  for (const [recordKind, kind] of KINDS) {
    for (const { value } of bundleLines(run.bundle, RECORD_FILES[recordKind].file)) {
      const record = value as { ref?: unknown; serviceRef?: unknown; legacyConsolePath?: unknown };
      if (typeof record?.legacyConsolePath !== "string" || typeof record.ref !== "string") continue;
      const path = consolePathKey(record.legacyConsolePath);
      if (!path) continue;
      let target: { kind: ConsolePathKind; id: string } | null = null;
      const id = run.id(recordKind, record.ref);
      if (id) target = { kind, id };
      else if (kind === "deployment" && typeof record.serviceRef === "string") {
        const serviceId = run.id("services", record.serviceRef);
        if (serviceId) target = { kind: "service", id: serviceId };
      }
      if (!target) continue;
      await run.db
        .insertInto("migration_console_path")
        .values({
          path,
          tail: consolePathTail(path),
          kind: target.kind,
          object_id: target.id,
          import_id: run.importId,
        })
        .onConflict((conflict) =>
          conflict.column("path").doUpdateSet({ kind: target.kind, object_id: target.id }),
        )
        .execute();
      kept++;
    }
  }
  if (kept > 0) {
    run.report.install.push({
      kind: "install",
      name: "console addresses",
      message: `${kept} old console address${kept === 1 ? "" : "es"} (bookmarks, links in old notifications) open the same project, service or deployment in 1.0.`,
    });
  }
}

/** Where an old address leads: the object and what its 1.0 page needs. */
export interface ConsoleTarget {
  kind: ConsolePathKind;
  workspaceId: string;
  workspace: string;
  projectId?: string;
  environmentId?: string;
  serviceId?: string;
  deploymentId?: string;
  serverId?: string;
}

/** The kept address a request path names, exact first, then with or without its first segment. */
export async function findConsolePath(
  db: Db,
  raw: string,
): Promise<{ kind: ConsolePathKind; object_id: string } | null> {
  const path = consolePathKey(raw);
  if (!path) return null;
  const tail = consolePathTail(path);
  const candidates = tail ? [path, tail] : [path];
  const row = await db
    .selectFrom("migration_console_path")
    .select(["kind", "object_id"])
    .where((eb) => eb.or([eb("path", "in", candidates), eb("tail", "in", candidates)]))
    .orderBy(sql`path = ${path}`, "desc")
    .orderBy(sql`tail = ${path}`, "desc")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  return row ?? null;
}

async function slugOf(db: Db, workspaceId: string): Promise<string | null> {
  const row = await db
    .selectFrom("workspace")
    .select("slug")
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  return row?.slug ?? null;
}

/** The object behind a kept address, or null when it no longer exists. */
export async function consoleTarget(
  db: Db,
  found: { kind: ConsolePathKind; object_id: string },
): Promise<ConsoleTarget | null> {
  const id = found.object_id;
  let target: Omit<ConsoleTarget, "workspace"> | null = null;
  switch (found.kind) {
    case "project": {
      const project = await db
        .selectFrom("project")
        .select(["id", "workspace_id"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!project) return null;
      const environment = await db
        .selectFrom("environment")
        .select("id")
        .where("project_id", "=", project.id)
        .orderBy("is_default", "desc")
        .orderBy("created_at")
        .executeTakeFirst();
      if (!environment) return null;
      target = {
        kind: "project",
        workspaceId: project.workspace_id,
        projectId: project.id,
        environmentId: environment.id,
      };
      break;
    }
    case "environment": {
      const environment = await db
        .selectFrom("environment")
        .select(["id", "workspace_id", "project_id"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!environment) return null;
      target = {
        kind: "environment",
        workspaceId: environment.workspace_id,
        projectId: environment.project_id,
        environmentId: environment.id,
      };
      break;
    }
    case "service": {
      const service = await db
        .selectFrom("service")
        .select(["id", "workspace_id", "project_id", "environment_id"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!service) return null;
      target = {
        kind: "service",
        workspaceId: service.workspace_id,
        projectId: service.project_id,
        environmentId: service.environment_id,
        serviceId: service.id,
      };
      break;
    }
    case "deployment": {
      const deployment = await db
        .selectFrom("deployment")
        .select(["id", "workspace_id"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!deployment) return null;
      target = { kind: "deployment", workspaceId: deployment.workspace_id, deploymentId: id };
      break;
    }
    case "server": {
      const server = await db
        .selectFrom("server")
        .select(["id", "workspace_id"])
        .where("id", "=", id)
        .executeTakeFirst();
      if (!server) return null;
      target = { kind: "server", workspaceId: server.workspace_id, serverId: server.id };
      break;
    }
  }
  const workspace = await slugOf(db, target.workspaceId);
  return workspace ? { ...target, workspace } : null;
}
