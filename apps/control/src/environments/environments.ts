import { randomUUID } from "node:crypto";
import {
  AppError,
  blankValues,
  type createEnvironmentRequestSchema,
  duplicateEnvironmentMessage,
  isProductionEnvironment,
  type updateEnvironmentRequestSchema,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { z } from "zod";
import type { WorkspaceAccess } from "../access/grants.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { environmentTarget, serviceTarget } from "../projects/objects.ts";
import { pruneScopes } from "../projects/scope.ts";
import {
  copyOwnVariableNames,
  insertCopy,
  refuseWhileProjectDeleting,
  SERVICE_COLUMNS,
  type ServiceRow,
} from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { readVariables, writeVariables } from "../variables/store.ts";

/**
 * Environments (spec 05 5.3): one copy of a project's services with their own variables, data
 * and hostnames. Every project starts with "development", its default. An environment named
 * exactly "production" is production.
 */

export interface EnvironmentRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  description: string;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

const ENVIRONMENT_COLUMNS = [
  "id",
  "workspace_id",
  "project_id",
  "name",
  "description",
  "is_default",
  "created_at",
  "updated_at",
] as const;

export interface EnvironmentView {
  id: string;
  projectId: string;
  name: string;
  description: string;
  isDefault: boolean;
  isProduction: boolean;
  /** Services in it the viewer can see. */
  serviceCount: number;
  createdAt: string;
  updatedAt: string;
  can: {
    rename: boolean;
    delete: boolean;
    createService: boolean;
    /** Deploy rights on a service created here (the new-application page's Create & deploy). */
    deployNewService: boolean;
    sharedVariables: boolean;
  };
}

export function environmentView(
  row: EnvironmentRow,
  access: WorkspaceAccess,
  serviceCount: number,
): EnvironmentView {
  const target = environmentTarget(row);
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    description: row.description,
    isDefault: row.is_default,
    isProduction: isProductionEnvironment(row.name),
    serviceCount,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    can: {
      rename: access.can("environment.update", target),
      delete: access.can("environment.delete", target) && !row.is_default,
      createService: access.can("service.create", target),
      // A service that doesn't exist yet: the person's scope over this environment decides.
      deployNewService: access.can("service.deploy", {
        kind: "service",
        id: "new",
        projectId: row.project_id,
        environmentId: row.id,
      }),
      sharedVariables: access.can("environment.shared-variables", target),
    },
  };
}

async function visibleServiceCounts(
  db: Db,
  access: WorkspaceAccess,
  environmentIds: readonly string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (environmentIds.length === 0) return counts;
  const rows = await db
    .selectFrom("service")
    .select(["id", "project_id", "environment_id"])
    .where("environment_id", "in", [...environmentIds])
    .execute();
  for (const row of rows) {
    if (!access.can("service.see", serviceTarget(row))) continue;
    counts.set(row.environment_id, (counts.get(row.environment_id) ?? 0) + 1);
  }
  return counts;
}

export async function loadEnvironment(
  db: Db,
  workspaceId: string,
  environmentId: string,
): Promise<EnvironmentRow> {
  const row = await db
    .selectFrom("environment")
    .select(ENVIRONMENT_COLUMNS)
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", environmentId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError("not_found", "This environment doesn't exist in this workspace any more.");
  }
  return row;
}

export async function listEnvironments(
  services: ControlServices,
  actor: WorkspaceActor,
  projectId: string,
): Promise<{ environments: EnvironmentView[]; can: { create: boolean } }> {
  const project = await actor.access.require("project.see", { kind: "project", id: projectId });
  const rows = await services.db
    .selectFrom("environment")
    .select(ENVIRONMENT_COLUMNS)
    .where("workspace_id", "=", actor.workspace.id)
    .where("project_id", "=", projectId)
    .orderBy("created_at")
    .execute();
  const visible = rows.filter((row) => actor.access.can("environment.see", environmentTarget(row)));
  const counts = await visibleServiceCounts(
    services.db,
    actor.access,
    visible.map((row) => row.id),
  );
  return {
    environments: visible.map((row) => environmentView(row, actor.access, counts.get(row.id) ?? 0)),
    can: { create: actor.access.can("environment.create", project) },
  };
}

export async function getEnvironment(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
): Promise<EnvironmentView & { project: { id: string; name: string } }> {
  await actor.access.require("environment.see", { kind: "environment", id: environmentId });
  const row = await loadEnvironment(services.db, actor.workspace.id, environmentId);
  const project = await services.db
    .selectFrom("project")
    .select(["id", "name"])
    .where("id", "=", row.project_id)
    .executeTakeFirstOrThrow();
  const counts = await visibleServiceCounts(services.db, actor.access, [row.id]);
  return { ...environmentView(row, actor.access, counts.get(row.id) ?? 0), project };
}

function duplicate(name: string): AppError {
  const message = duplicateEnvironmentMessage(name);
  return new AppError("conflict", message, { fields: { name: message } });
}

async function nameInUse(
  db: Db,
  projectId: string,
  name: string,
  except?: string,
): Promise<boolean> {
  let query = db
    .selectFrom("environment")
    .select("id")
    .where("project_id", "=", projectId)
    .where("name", "=", name);
  if (except) query = query.where("id", "!=", except);
  return (await query.executeTakeFirst()) !== undefined;
}

export interface CreateEnvironmentResult {
  environment: EnvironmentView;
  /** "Created <name>". */
  message: string;
  copiedServices: number;
  /** Services that couldn't be copied in, with why. */
  notCopied: { name: string; reason: string }[];
}

/**
 * Creates an environment and copies every service of the project into it, idle, with variable
 * names only (spec 05 5.3, 5.4). With a source environment, its shared variable names come too,
 * and with `values` also the values, secrets included: those of the source's shared variables
 * and of the services the person may read, never anything they couldn't read themselves.
 */
export async function createEnvironment(
  services: ControlServices,
  actor: WorkspaceActor,
  projectId: string,
  input: z.output<typeof createEnvironmentRequestSchema>,
): Promise<CreateEnvironmentResult> {
  const { db } = services;
  await actor.access.require("environment.create", { kind: "project", id: projectId });
  let source: EnvironmentRow | null = null;
  if (input.variables.from) {
    await actor.access.require("environment.see", {
      kind: "environment",
      id: input.variables.from,
    });
    source = await loadEnvironment(db, actor.workspace.id, input.variables.from);
    if (source.project_id !== projectId) {
      throw new AppError(
        "invalid_request",
        "Copy variables from an environment of the same project.",
        { fields: { "variables.from": "Copy variables from an environment of the same project." } },
      );
    }
  }
  const sourceEnvironment = source;
  const copyValues = input.variables.values && sourceEnvironment !== null;

  const result = await db.transaction().execute(async (trx) => {
    const project = await trx
      .selectFrom("project")
      .select(["id", "name", "workspace_id"])
      .where("id", "=", projectId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await refuseWhileProjectDeleting(trx, project);
    if (await nameInUse(trx, projectId, input.name)) throw duplicate(input.name);

    const environment = await trx
      .insertInto("environment")
      .values({
        workspace_id: project.workspace_id,
        project_id: project.id,
        name: input.name,
        description: input.description,
        created_by: actor.personId,
      })
      .returning(ENVIRONMENT_COLUMNS)
      .executeTakeFirstOrThrow();

    if (sourceEnvironment) {
      const shared = await readVariables(trx, services.secrets, {
        kind: "environment",
        id: sourceEnvironment.id,
        workspaceId: project.workspace_id,
      });
      if (shared.exists) {
        const readable =
          shared.text !== null &&
          actor.access.can("environment.shared-variables", environmentTarget(sourceEnvironment));
        const text =
          shared.text === null
            ? shared.names.map((name) => `${name}=\n`).join("")
            : copyValues && readable
              ? shared.text
              : blankValues(shared.text);
        if (text !== "") {
          await writeVariables(
            trx,
            services.secrets,
            { kind: "environment", id: environment.id, workspaceId: project.workspace_id },
            text,
            { by: actor.personId },
          );
        }
      }
    }

    const all = await trx
      .selectFrom("service as s")
      .innerJoin("environment as e", "e.id", "s.environment_id")
      .select([...SERVICE_COLUMNS, "e.is_default"])
      .where("s.project_id", "=", projectId)
      .where("s.environment_id", "!=", environment.id)
      .orderBy("s.created_at")
      .execute();

    // Services from before linking: link the ones that match by name and kind now.
    const unlinked = new Map<string, typeof all>();
    for (const row of all) {
      if (row.copy_group_id) continue;
      const key = `${row.kind}:${row.name.toLowerCase()}`;
      unlinked.set(key, [...(unlinked.get(key) ?? []), row]);
    }
    for (const members of unlinked.values()) {
      const group = randomUUID();
      await trx
        .updateTable("service")
        .set({ copy_group_id: group })
        .where(
          "id",
          "in",
          members.map((member) => member.id),
        )
        .execute();
      for (const member of members) member.copy_group_id = group;
    }

    const groups = new Map<string, typeof all>();
    for (const row of all) {
      const key = row.copy_group_id ?? row.id;
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    const usedNames = new Set<string>();
    const notCopied: { name: string; reason: string }[] = [];
    let copied = 0;
    for (const members of groups.values()) {
      const template =
        members.find((member) => member.environment_id === sourceEnvironment?.id) ??
        members.find((member) => member.is_default) ??
        members[0];
      if (!template) continue;
      const nameKey = template.name.toLowerCase();
      if (usedNames.has(nameKey)) {
        notCopied.push({
          name: template.name,
          reason: `Another service of this project is also called "${template.name}", so only one was copied.`,
        });
        continue;
      }
      usedNames.add(nameKey);
      // The Nearzero host is a deploy target only for instance administrators and allowed
      // workspaces (spec 24 G3; B1-07): a copy never lands there for anyone else.
      if (template.server_id === null && !actor.access.can("host.use")) {
        notCopied.push({
          name: template.name,
          reason: `${template.name} runs on the Nearzero host, which this workspace can't use, so it wasn't copied. Create it in this environment on another server.`,
        });
        continue;
      }
      const copy = await insertCopy(
        trx,
        services,
        template as ServiceRow,
        environment,
        actor.personId,
      );
      const keepValues =
        copyValues &&
        template.environment_id === sourceEnvironment?.id &&
        actor.access.can("service.variables", serviceTarget(template));
      await copyOwnVariableNames(trx, services, template as ServiceRow, copy, {
        values: keepValues,
        by: actor.personId,
      });
      copied++;
    }
    return { environment, copied, notCopied, projectName: project.name };
  });

  await recordAudit(db, services.log, auditActor(actor), {
    action: "environment.created",
    workspaceId: actor.workspace.id,
    target: { kind: "environment", id: result.environment.id },
    details: {
      project: result.projectName,
      name: result.environment.name,
      copiedServices: result.copied,
      variablesFrom: sourceEnvironment?.name ?? null,
      valuesCopied: copyValues,
    },
  });
  const counts = await visibleServiceCounts(db, actor.access, [result.environment.id]);
  return {
    environment: environmentView(
      result.environment,
      actor.access,
      counts.get(result.environment.id) ?? 0,
    ),
    message: `Created ${result.environment.name}`,
    copiedServices: result.copied,
    notCopied: result.notCopied,
  };
}

export async function updateEnvironment(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
  input: z.output<typeof updateEnvironmentRequestSchema>,
): Promise<EnvironmentView> {
  const { db } = services;
  await actor.access.require("environment.update", { kind: "environment", id: environmentId });
  const before = await loadEnvironment(db, actor.workspace.id, environmentId);
  const row = await db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("project")
      .select("id")
      .where("id", "=", before.project_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (
      input.name !== undefined &&
      (await nameInUse(trx, before.project_id, input.name, before.id))
    ) {
      throw duplicate(input.name);
    }
    return trx
      .updateTable("environment")
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", before.id)
      .returning(ENVIRONMENT_COLUMNS)
      .executeTakeFirstOrThrow();
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "environment.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "environment", id: row.id },
    details: {
      ...(input.name !== undefined && input.name !== before.name
        ? { renamedFrom: before.name, name: row.name }
        : {}),
      ...(input.description !== undefined ? { descriptionChanged: true } : {}),
    },
  });
  const counts = await visibleServiceCounts(db, actor.access, [row.id]);
  return environmentView(row, actor.access, counts.get(row.id) ?? 0);
}

/** Deletes an empty environment that isn't the project's default. */
export async function deleteEnvironment(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
): Promise<void> {
  const { db } = services;
  await actor.access.require("environment.delete", { kind: "environment", id: environmentId });
  const row = await loadEnvironment(db, actor.workspace.id, environmentId);
  if (row.is_default) {
    throw new AppError(
      "conflict",
      "This is the project's default environment, so it can't be deleted. You can rename it.",
    );
  }
  await db.transaction().execute(async (trx) => {
    await trx
      .selectFrom("project")
      .select("id")
      .where("id", "=", row.project_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const count = Number(
      (
        await trx
          .selectFrom("service")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("environment_id", "=", row.id)
          .executeTakeFirstOrThrow()
      ).count,
    );
    if (count > 0) {
      throw new AppError(
        "conflict",
        `Delete or move its ${count} ${count === 1 ? "service" : "services"} first.`,
      );
    }
    await trx.deleteFrom("environment").where("id", "=", row.id).execute();
    await pruneScopes(trx, row.workspace_id, { environments: [row.id] });
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "environment.deleted",
    workspaceId: actor.workspace.id,
    target: { kind: "environment", id: row.id },
    details: { name: row.name, projectId: row.project_id },
  });
}
