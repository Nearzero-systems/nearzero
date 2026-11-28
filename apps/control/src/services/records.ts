import { randomUUID } from "node:crypto";
import {
  AppError,
  blankValues,
  type CreateServiceRequest,
  checkEnvText,
  checkRows,
  isProductionEnvironment,
  publicSecretWarnings,
  SERVICE_KIND_LABELS,
  type ServiceKind,
  type ServiceStatus,
  suggestAppNameBase,
  textFromRows,
  type updateServiceRequestSchema,
} from "@nearzero/shared";
import type { Selectable } from "kysely";
import type { z } from "zod";
import type { WorkspaceAccess } from "../access/grants.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import type { ServiceTable } from "../db/schema.ts";
import { deploySummaries, type ServiceDeploySummary } from "../deploys/records.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { environmentTarget, serviceTarget } from "../projects/objects.ts";
import { grantToCreator, refreshAccess } from "../projects/scope.ts";
import type { ControlServices } from "../services.ts";
import { cloneUpload } from "../sources/uploads.ts";
import { readVariables, writeVariables } from "../variables/store.ts";
import { generatePassword } from "./generate.ts";
import {
  checkSettingsUpdate,
  type KindContext,
  kindModule,
  type MadeSettings,
  type Secrets,
  type Settings,
} from "./kinds/index.ts";
import {
  allocatePublicPort,
  choosePlacement,
  DUPLICATE_APP_NAME,
  NO_FREE_PORT_NOTE,
  type Placement,
  serverIdOut,
  uniqueAppName,
} from "./placement.ts";

/**
 * Services as records (spec 02, spec 05 5.4): one model for all eight kinds, created together
 * with linked copies in the project's other environments, never deployed by being created.
 */

/** Every column a service view needs; the sealed secrets are never loaded with it (spec 23.2). */
export const SERVICE_COLUMNS = [
  "s.id",
  "s.workspace_id",
  "s.project_id",
  "s.environment_id",
  "s.copy_group_id",
  "s.kind",
  "s.name",
  "s.app_name_base",
  "s.app_name",
  "s.description",
  "s.server_id",
  "s.status",
  "s.settings",
  "s.public_port",
  "s.public_port_note",
  "s.deleting_run_id",
  "s.created_at",
  "s.updated_at",
] as const;

/** The same columns, for `returning` after an insert or update. */
const SERVICE_RETURNING = [
  "id",
  "workspace_id",
  "project_id",
  "environment_id",
  "copy_group_id",
  "kind",
  "name",
  "app_name_base",
  "app_name",
  "description",
  "server_id",
  "status",
  "settings",
  "public_port",
  "public_port_note",
  "deleting_run_id",
  "created_at",
  "updated_at",
] as const;

export type ServiceRow = Omit<Selectable<ServiceTable>, "secrets_sealed" | "created_by">;

export interface ServiceView {
  id: string;
  projectId: string;
  environmentId: string;
  kind: ServiceKind;
  kindLabel: string;
  name: string;
  appName: string;
  description: string;
  status: ServiceStatus;
  /** "host" for the Nearzero host. */
  serverId: string;
  onHost: boolean;
  /** Only what the kind's module lists as public; secrets never appear here. */
  settings: Settings;
  publicPort: number | null;
  publicPortNote: string | null;
  copyGroupId: string | null;
  deleting: boolean;
  createdAt: string;
  updatedAt: string;
  can: {
    configure: boolean;
    delete: boolean;
    deploy: boolean;
    variables: boolean;
    /** Its Backups tab (apps, databases) or Volume backups section (Compose), spec 6.2, 8.3. */
    backups: boolean;
  };
}

/** The one filter every service answer goes through (spec 23.4, rule 6). */
export function serviceView(row: ServiceRow, access: WorkspaceAccess): ServiceView {
  const target = serviceTarget(row);
  return {
    id: row.id,
    projectId: row.project_id,
    environmentId: row.environment_id,
    kind: row.kind,
    kindLabel: SERVICE_KIND_LABELS[row.kind],
    name: row.name,
    appName: row.app_name,
    description: row.description,
    status: row.status,
    serverId: serverIdOut(row.server_id),
    onHost: row.server_id === null,
    settings: kindModule(row.kind).publicSettings(row.settings ?? {}),
    publicPort: row.public_port,
    publicPortNote: row.public_port_note,
    copyGroupId: row.copy_group_id,
    deleting: row.deleting_run_id !== null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    can: {
      configure: access.can("service.configure", target),
      delete: access.can("service.delete", target),
      deploy: access.can("service.deploy", target),
      variables: access.can("service.variables", target),
      backups: access.can("service.backups", target),
    },
  };
}

export function secretsContext(serviceId: string): string {
  return `service:${serviceId}:secrets`;
}

export async function loadService(
  db: Db,
  workspaceId: string,
  serviceId: string,
): Promise<ServiceRow | undefined> {
  return db
    .selectFrom("service as s")
    .select(SERVICE_COLUMNS)
    .where("s.workspace_id", "=", workspaceId)
    .where("s.id", "=", serviceId)
    .executeTakeFirst();
}

interface EnvironmentRef {
  id: string;
  project_id: string;
  workspace_id: string;
  name: string;
}

interface NewService {
  environment: EnvironmentRef;
  copyGroupId: string;
  kind: ServiceKind;
  name: string;
  description: string;
  appNameBase: string;
  placement: Placement;
  createdBy: string | null;
  make(context: KindContext): MadeSettings;
}

/** Inserts one service with its own app name, secrets and (for databases) public port. */
async function insertService(
  db: Db,
  services: ControlServices,
  record: NewService,
): Promise<ServiceRow> {
  const id = randomUUID();
  const appName = await uniqueAppName(db, record.appNameBase);
  const made = record.make({ appName, generatePassword: () => generatePassword() });
  let publicPort: number | null = null;
  let note: string | null = null;
  if (kindModule(record.kind).database) {
    publicPort = await allocatePublicPort(db, record.placement);
    if (publicPort === null) note = NO_FREE_PORT_NOTE;
  }
  return db
    .insertInto("service")
    .values({
      id,
      workspace_id: record.environment.workspace_id,
      project_id: record.environment.project_id,
      environment_id: record.environment.id,
      copy_group_id: record.copyGroupId,
      kind: record.kind,
      name: record.name,
      app_name_base: record.appNameBase,
      app_name: appName,
      description: record.description,
      server_id: record.placement,
      settings: JSON.stringify(made.settings),
      secrets_sealed: made.secrets
        ? services.secrets.seal(JSON.stringify(made.secrets), secretsContext(id))
        : null,
      public_port: publicPort,
      public_port_note: note,
      created_by: record.createdBy,
    })
    .returning(SERVICE_RETURNING)
    .executeTakeFirstOrThrow();
}

/**
 * A linked copy of a service in another environment: the same name and settings, its own app
 * name, volume, passwords and public port, and no hostnames. Never deployed (spec 05 5.4).
 */
export async function insertCopy(
  db: Db,
  services: ControlServices,
  template: ServiceRow,
  environment: EnvironmentRef,
  createdBy: string | null,
): Promise<ServiceRow> {
  const module = kindModule(template.kind);
  const copy = await insertService(db, services, {
    environment,
    copyGroupId: template.copy_group_id ?? randomUUID(),
    kind: template.kind,
    name: template.name,
    description: template.description,
    appNameBase: template.app_name_base,
    placement: template.server_id,
    createdBy,
    make: (context) => module.copy(template.settings ?? {}, context),
  });
  // An uploaded archive is the copy's own from the start (B1-30): the original's next upload
  // or delete never takes it away.
  const source = copy.settings?.source as { type?: unknown; upload?: { id?: unknown } } | undefined;
  if (source?.type === "upload" && typeof source.upload?.id === "string") {
    const id = await cloneUpload(db, source.upload.id, {
      serviceId: copy.id,
      workspaceId: copy.workspace_id,
    });
    const settings = {
      ...(copy.settings ?? {}),
      source: { ...source, upload: id ? { ...source.upload, id } : null },
    };
    await db
      .updateTable("service")
      .set({ settings: JSON.stringify(settings) })
      .where("id", "=", copy.id)
      .execute();
    return { ...copy, settings };
  }
  return copy;
}

export function serviceVariablesOwner(row: { id: string; workspace_id: string }) {
  return { kind: "service" as const, id: row.id, workspaceId: row.workspace_id };
}

/** A service's own variables for a copy: the names (and comments), never the values. */
export async function copyOwnVariableNames(
  db: Db,
  services: ControlServices,
  from: ServiceRow,
  to: ServiceRow,
  options: { values: boolean; by: string | null },
): Promise<void> {
  const stored = await readVariables(db, services.secrets, serviceVariablesOwner(from));
  if (!stored.exists) return;
  const text =
    stored.text === null
      ? stored.names.map((name) => `${name}=`).join("\n") + (stored.names.length ? "\n" : "")
      : options.values
        ? stored.text
        : blankValues(stored.text);
  if (text === "") return;
  await writeVariables(db, services.secrets, serviceVariablesOwner(to), text, { by: options.by });
}

async function nameTaken(db: Db, environmentId: string, name: string): Promise<boolean> {
  const row = await db
    .selectFrom("service")
    .select("id")
    .where("environment_id", "=", environmentId)
    .where((eb) => eb(eb.fn("lower", ["name"]), "=", name.toLowerCase()))
    .executeTakeFirst();
  return row !== undefined;
}

export function duplicateServiceName(name: string): AppError {
  const message = `This environment already has a service called "${name}". Pick another name.`;
  return new AppError("conflict", message, { fields: { name: message } });
}

/** Refuses changes to a project while it is being deleted. */
export async function refuseWhileProjectDeleting(
  db: Db,
  project: { id: string; name: string },
): Promise<void> {
  const running = await db
    .selectFrom("delete_run")
    .select("id")
    .where("project_id", "=", project.id)
    .where("scope", "=", "project")
    .where("state", "=", "running")
    .executeTakeFirst();
  if (running) {
    throw new AppError(
      "conflict",
      `${project.name} is being deleted, so nothing can be added to it. Wait for the delete to finish.`,
    );
  }
}

/** "a", "a and b", "a, b and c". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What every create says about the other environments (spec 05 5.4). */
export function alsoAddedMessage(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  return `Also added to ${joinNames(names)}, not deployed yet. Each environment has its own variables and URL.`;
}

export interface CreateServiceResult {
  service: ServiceView;
  alsoAddedTo: { environmentId: string; environmentName: string; serviceId: string }[];
  notAddedTo: { environmentId: string; environmentName: string; reason: string }[];
  message: string | null;
  notes: string[];
}

function rowsProblem(problems: { line: number; message: string }[]): AppError {
  const fields: Record<string, string> = {};
  for (const problem of problems) fields[`variables.${problem.line - 1}`] ??= problem.message;
  return new AppError("invalid_request", problems[0]?.message ?? "Check the variables.", {
    fields,
  });
}

interface PgError {
  code?: string;
  constraint?: string;
}

function translateUniqueViolation(error: unknown, name: string): unknown {
  const pg = error as PgError;
  if (pg?.code !== "23505") return error;
  if (pg.constraint === "service_name_idx") return duplicateServiceName(name);
  if (pg.constraint === "service_app_name_key") {
    return new AppError("conflict", DUPLICATE_APP_NAME, {
      fields: { appName: DUPLICATE_APP_NAME },
    });
  }
  return error;
}

/**
 * Creates a service and adds linked copies to every other environment of the project where the
 * person may add services. All or nothing: either every record is made, or none.
 */
export interface CreateServiceOptions {
  /**
   * Why the copy for another environment is left out, or null to make it: the Agent leaves
   * production out while its production changes are off (B1-56).
   */
  skipCopy?: (environment: { id: string; name: string }) => string | null;
}

export async function createService(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
  input: CreateServiceRequest,
  options: CreateServiceOptions = {},
): Promise<CreateServiceResult> {
  const { db } = services;
  await actor.access.require("service.create", { kind: "environment", id: environmentId });
  const environment = await db
    .selectFrom("environment as e")
    .innerJoin("project as p", "p.id", "e.project_id")
    .select(["e.id", "e.project_id", "e.workspace_id", "e.name", "p.name as project_name"])
    .where("e.workspace_id", "=", actor.workspace.id)
    .where("e.id", "=", environmentId)
    .executeTakeFirstOrThrow();
  const placement = await choosePlacement(actor, input.serverId);
  const module = kindModule(input.kind);

  const rows = input.variables
    .map((row) => ({ name: row.name.trim(), value: row.value }))
    .filter((row) => !(row.name === "" && row.value === ""));
  const problems = checkRows(rows);
  if (problems.length > 0) throw rowsProblem(problems);
  if (input.kind === "application") {
    const warnings = publicSecretWarnings(rows.map((row) => row.name));
    if (warnings.length > 0) {
      throw new AppError(
        "invalid_request",
        `Rename ${joinNames(warnings.map((warning) => warning.name))} before creating the app. ${warnings[0]?.message}`,
        { fields: { variables: warnings.map((warning) => warning.message).join(" ") } },
      );
    }
  }
  const ownText = rows.length > 0 ? textFromRows("", rows) : "";
  const textProblems = checkEnvText(ownText);
  if (textProblems.length > 0) throw rowsProblem(textProblems);
  const appNameBase = input.appName ?? suggestAppNameBase(environment.project_name, input.name);

  let created: {
    original: ServiceRow;
    copies: { row: ServiceRow; environmentName: string }[];
    notAddedTo: CreateServiceResult["notAddedTo"];
  };
  try {
    created = await db.transaction().execute(async (trx) => {
      // Shares the project with other creates; creating an environment waits for this to finish,
      // so it always copies every service.
      await trx
        .selectFrom("project")
        .select("id")
        .where("id", "=", environment.project_id)
        .forShare()
        .executeTakeFirstOrThrow();
      await refuseWhileProjectDeleting(trx, {
        id: environment.project_id,
        name: environment.project_name,
      });
      if (await nameTaken(trx, environment.id, input.name)) throw duplicateServiceName(input.name);

      const original = await insertService(trx, services, {
        environment,
        copyGroupId: randomUUID(),
        kind: input.kind,
        name: input.name,
        description: input.description,
        appNameBase,
        placement,
        createdBy: actor.personId,
        make: (context) => module.create(input.settings, context),
      });
      if (ownText) {
        await writeVariables(trx, services.secrets, serviceVariablesOwner(original), ownText, {
          by: actor.personId,
        });
      }

      const others = await trx
        .selectFrom("environment")
        .select(["id", "project_id", "workspace_id", "name"])
        .where("project_id", "=", environment.project_id)
        .where("id", "!=", environment.id)
        .orderBy("created_at")
        .execute();
      const copies: { row: ServiceRow; environmentName: string }[] = [];
      const notAddedTo: CreateServiceResult["notAddedTo"] = [];
      for (const other of others) {
        const target = environmentTarget(other);
        if (!actor.access.can("service.create", target)) {
          if (actor.access.can("environment.see", target)) {
            notAddedTo.push({
              environmentId: other.id,
              environmentName: other.name,
              reason: "You can't add services there.",
            });
          }
          continue;
        }
        const skipped = options.skipCopy?.(other) ?? null;
        if (skipped) {
          notAddedTo.push({
            environmentId: other.id,
            environmentName: other.name,
            reason: skipped,
          });
          continue;
        }
        if (await nameTaken(trx, other.id, input.name)) {
          notAddedTo.push({
            environmentId: other.id,
            environmentName: other.name,
            reason: `It already has a service called "${input.name}".`,
          });
          continue;
        }
        const copy = await insertCopy(trx, services, original, other, actor.personId);
        if (ownText) {
          await writeVariables(
            trx,
            services.secrets,
            serviceVariablesOwner(copy),
            blankValues(ownText),
            { by: actor.personId },
          );
        }
        copies.push({ row: copy, environmentName: other.name });
      }
      return { original, copies, notAddedTo };
    });
  } catch (error) {
    throw translateUniqueViolation(error, input.name);
  }

  const granted = await grantToCreator(db, actor, [
    serviceTarget(created.original),
    ...created.copies.map((copy) => serviceTarget(copy.row)),
  ]);
  if (granted) await refreshAccess(services, actor);

  const names = created.copies.map((copy) => copy.environmentName);
  await recordAudit(db, services.log, auditActor(actor), {
    action: "service.created",
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: created.original.id },
    details: {
      kind: input.kind,
      name: input.name,
      environment: environment.name,
      appName: created.original.app_name,
      alsoAddedTo: names,
    },
  });
  const notes = created.original.public_port_note ? [created.original.public_port_note] : [];
  return {
    service: serviceView(created.original, actor.access),
    alsoAddedTo: created.copies.map((copy) => ({
      environmentId: copy.row.environment_id,
      environmentName: copy.environmentName,
      serviceId: copy.row.id,
    })),
    notAddedTo: created.notAddedTo,
    message: alsoAddedMessage(names),
    notes,
  };
}

/**
 * The other environments' copies of a service. Linked copies share a group; services from
 * before linking match by name and kind (spec 05 5.4).
 */
export async function copiesOf(
  db: Db,
  row: ServiceRow,
): Promise<(ServiceRow & { environment_name: string })[]> {
  let query = db
    .selectFrom("service as s")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([...SERVICE_COLUMNS, "e.name as environment_name"])
    .where("s.project_id", "=", row.project_id)
    .where("s.id", "!=", row.id)
    .where("s.environment_id", "!=", row.environment_id);
  query = row.copy_group_id
    ? query.where("s.copy_group_id", "=", row.copy_group_id)
    : query
        .where("s.copy_group_id", "is", null)
        .where("s.kind", "=", row.kind)
        .where((eb) => eb(eb.fn("lower", ["s.name"]), "=", row.name.toLowerCase()));
  return query.orderBy("e.created_at").execute();
}

export interface ServiceDetail extends ServiceView {
  /** The last deploy result and any deploy in progress (M3c). */
  deploy: ServiceDeploySummary;
  environment: { id: string; name: string; isProduction: boolean };
  project: { id: string; name: string };
  /** Copies in other environments the viewer can open. */
  copies: { id: string; environmentId: string; environmentName: string; status: ServiceStatus }[];
}

export async function getService(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<ServiceDetail> {
  const { db } = services;
  await actor.access.require("service.see", { kind: "service", id: serviceId });
  const row = await loadService(db, actor.workspace.id, serviceId);
  if (!row)
    throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
  const [environment, project, copies] = await Promise.all([
    db
      .selectFrom("environment")
      .select(["id", "name"])
      .where("id", "=", row.environment_id)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("project")
      .select(["id", "name"])
      .where("id", "=", row.project_id)
      .executeTakeFirstOrThrow(),
    copiesOf(db, row),
  ]);
  const deploys = await deploySummaries(db, [row.id]);
  return {
    ...serviceView(row, actor.access),
    deploy: deploys.get(row.id) ?? { last: null, inProgress: null },
    environment: { ...environment, isProduction: isProductionEnvironment(environment.name) },
    project,
    copies: copies
      .filter((copy) => actor.access.can("service.see", serviceTarget(copy)))
      .map((copy) => ({
        id: copy.id,
        environmentId: copy.environment_id,
        environmentName: copy.environment_name,
        status: copy.status,
      })),
  };
}

export async function listServices(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
): Promise<{
  services: (ServiceView & { deploy: ServiceDeploySummary })[];
  can: { create: boolean };
}> {
  const target = await actor.access.require("environment.see", {
    kind: "environment",
    id: environmentId,
  });
  const rows = await services.db
    .selectFrom("service as s")
    .select(SERVICE_COLUMNS)
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.environment_id", "=", environmentId)
    .orderBy((eb) => eb.fn("lower", ["s.name"]))
    .execute();
  const visible = rows.filter((row) => actor.access.can("service.see", serviceTarget(row)));
  const deploys = await deploySummaries(
    services.db,
    visible.map((row) => row.id),
  );
  return {
    services: visible.map((row) => ({
      ...serviceView(row, actor.access),
      deploy: deploys.get(row.id) ?? { last: null, inProgress: null },
    })),
    can: { create: actor.access.can("service.create", target) },
  };
}

export async function updateService(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: z.output<typeof updateServiceRequestSchema>,
): Promise<{ service: ServiceView; notes: string[] }> {
  const { db } = services;
  await actor.access.require("service.configure", { kind: "service", id: serviceId });
  const row = await loadService(db, actor.workspace.id, serviceId);
  if (!row)
    throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
  let settings = row.settings ?? {};
  const notes: string[] = [];
  if (input.settings !== undefined) {
    const change = checkSettingsUpdate(row.kind, input.settings);
    const updated = kindModule(row.kind).update(settings, change);
    settings = updated.settings;
    notes.push(...updated.notes);
  }
  const saved = await db
    .updateTable("service")
    .set({
      settings: JSON.stringify(settings),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", row.id)
    .returning(SERVICE_RETURNING)
    .executeTakeFirstOrThrow();
  await recordAudit(db, services.log, auditActor(actor), {
    action: "service.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: {
      fields: [
        ...(input.description !== undefined ? ["description"] : []),
        ...Object.keys(input.settings ?? {}),
      ],
    },
  });
  return { service: serviceView(saved, actor.access), notes };
}

export interface DatabaseCredentials {
  user: string | null;
  password: string;
  rootPassword: string | null;
  databaseName: string | null;
}

/** "Show password": the one secret that is shown again, to people who manage the database. */
export async function revealCredentials(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<DatabaseCredentials> {
  const { db } = services;
  await actor.access.require("service.variables", { kind: "service", id: serviceId });
  const row = await db
    .selectFrom("service")
    .select(["id", "kind", "settings", "secrets_sealed"])
    .where("workspace_id", "=", actor.workspace.id)
    .where("id", "=", serviceId)
    .executeTakeFirstOrThrow();
  if (!kindModule(row.kind).database || !row.secrets_sealed) {
    throw new AppError("conflict", "Only databases have a password to show.");
  }
  const opened = services.secrets.open(row.secrets_sealed, secretsContext(row.id));
  if (!opened.ok) {
    throw new AppError(
      "conflict",
      "This database's password was saved with another install secret and can't be read any more.",
    );
  }
  const secrets = JSON.parse(opened.value) as Secrets;
  const settings = row.settings ?? {};
  return {
    user:
      typeof settings.user === "string" ? settings.user : row.kind === "redis" ? "default" : null,
    password: secrets.password ?? "",
    rootPassword: secrets.rootPassword ?? null,
    databaseName: typeof settings.databaseName === "string" ? settings.databaseName : null,
  };
}
