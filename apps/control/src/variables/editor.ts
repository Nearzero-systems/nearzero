import {
  AppError,
  checkEnvText,
  checkRows,
  type EnvRow,
  formFromText,
  isProductionEnvironment,
  type PublicSecretWarning,
  parseEnv,
  publicSecretWarnings,
  type saveVariablesRequestSchema,
  textFromRows,
} from "@nearzero/shared";
import type { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import { environmentTarget, serviceTarget } from "../projects/objects.ts";
import { loadService, SERVICE_COLUMNS } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import {
  readVariables,
  type StoredVariables,
  UNREADABLE_VARIABLES,
  type VariablesOwner,
  variableCounts,
  writeVariables,
} from "./store.ts";

/**
 * The shared variables page and a service's Variables tab (spec 05 5.5): masked views, the
 * explicit "Show values" reveal, and saving from text or from the form.
 */

export interface MaskedVariables {
  /** Names in order; values are never here. */
  variables: { name: string; empty: boolean }[];
  count: number;
  sizeBytes: number;
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
  /** Saved with another install secret: the names are known, the values are lost. */
  unreadable: string | null;
  warnings: PublicSecretWarning[];
}

async function updatedBy(db: Db, personId: string | null) {
  if (!personId) return null;
  const person = await db
    .selectFrom("person")
    .select(["id", "email", "first_name", "last_name"])
    .where("id", "=", personId)
    .executeTakeFirst();
  return person ? { id: person.id, name: displayName(person) } : null;
}

async function masked(db: Db, stored: StoredVariables): Promise<MaskedVariables> {
  const variables =
    stored.text === null
      ? stored.names.map((name) => ({ name, empty: false }))
      : parseEnv(stored.text).variables.map((variable) => ({
          name: variable.name,
          empty: variable.value === "",
        }));
  return {
    variables,
    count: variables.length,
    sizeBytes: stored.sizeBytes,
    version: stored.version,
    updatedAt: stored.updatedAt?.toISOString() ?? null,
    updatedBy: await updatedBy(db, stored.updatedBy),
    unreadable: stored.text === null ? UNREADABLE_VARIABLES : null,
    warnings: publicSecretWarnings(variables.map((variable) => variable.name)),
  };
}

export interface RevealedVariables {
  /** The text exactly as saved, for "Edit as .env". */
  text: string;
  rows: EnvRow[];
  trailing: string[];
  /** Set when the form can't hold the text exactly: open it as text. */
  formProblem: string | null;
  version: number;
}

function revealed(stored: StoredVariables): RevealedVariables {
  if (stored.text === null) throw new AppError("conflict", UNREADABLE_VARIABLES);
  const form = formFromText(stored.text);
  return {
    text: stored.text,
    rows: form.rows,
    trailing: form.trailing,
    formProblem: form.problem,
    version: stored.version,
  };
}

const NAMES_ONLY =
  "You can see the names. Their values are for people who can deploy a service in this environment or edit its variables. Ask an owner or admin.";
const EDIT_NEEDS_WHOLE =
  "Editing them needs access to the whole environment, since they reach every service in it. Ask an owner or admin.";

/** Editing shared variables needs access to the whole environment (B1-33, kept by C1-20). */
async function requireSharedVariablesEdit(actor: WorkspaceActor, environmentId: string) {
  const target = await actor.access.require("environment.see", {
    kind: "environment",
    id: environmentId,
  });
  if (!target) throw new Error("An environment target was expected.");
  await actor.access.require("environment.shared-variables", target);
  return target;
}

/**
 * Who reads shared values (the C1-20 decision in spec 31, replacing B1-33's): every service in
 * the environment receives them, so anyone who can deploy, edit the variables of, or open the
 * terminal of at least one service there could read them anyway, and may. Access to the whole
 * environment, which editing needs, counts too.
 */
async function canReadSharedValues(
  services: ControlServices,
  actor: WorkspaceActor,
  environment: { id: string; project_id: string; workspace_id: string },
): Promise<boolean> {
  if (actor.access.can("environment.shared-variables", environmentTarget(environment))) {
    return true;
  }
  const rows = await services.db
    .selectFrom("service as s")
    .select(["s.id", "s.project_id", "s.environment_id"])
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.environment_id", "=", environment.id)
    .execute();
  return rows.some((row) => {
    const target = serviceTarget(row);
    return (
      actor.access.can("service.variables", target) || actor.access.can("service.deploy", target)
    );
  });
}

async function environmentRow(db: Db, workspaceId: string, environmentId: string) {
  return db
    .selectFrom("environment")
    .select(["id", "project_id", "workspace_id", "name"])
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", environmentId)
    .executeTakeFirstOrThrow();
}

function environmentOwner(row: { id: string; workspace_id: string }): VariablesOwner {
  return { kind: "environment", id: row.id, workspaceId: row.workspace_id };
}

function serviceOwner(row: { id: string; workspace_id: string }): VariablesOwner {
  return { kind: "service", id: row.id, workspaceId: row.workspace_id };
}

export async function sharedVariablesPage(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
) {
  const { db } = services;
  // Anyone who can see the environment sees the names; values go to anyone with a service there,
  // and editing needs the whole environment (C1-20).
  const target = await actor.access.require("environment.see", {
    kind: "environment",
    id: environmentId,
  });
  const canEdit = target ? actor.access.can("environment.shared-variables", target) : false;
  const environment = await environmentRow(db, actor.workspace.id, environmentId);
  const canReveal = canEdit || (await canReadSharedValues(services, actor, environment));
  const stored = await readVariables(db, services.secrets, environmentOwner(environment));
  const serviceRows = await db
    .selectFrom("service as s")
    .select(SERVICE_COLUMNS)
    .where("s.environment_id", "=", environment.id)
    .orderBy((eb) => eb.fn("lower", ["s.name"]))
    .execute();
  const visible = serviceRows.filter((row) => actor.access.can("service.see", serviceTarget(row)));
  const counts = await variableCounts(
    db,
    actor.workspace.id,
    "service",
    visible.map((row) => row.id),
  );
  const production = isProductionEnvironment(environment.name);
  return {
    environment: { id: environment.id, name: environment.name, isProduction: production },
    shared: await masked(db, stored),
    notice: production
      ? "This is production. Saved changes reach services when they next deploy."
      : null,
    services: visible.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      count: counts.get(row.id) ?? 0,
    })),
    can: { edit: canEdit, reveal: canReveal },
    message: canEdit ? null : canReveal ? EDIT_NEEDS_WHOLE : NAMES_ONLY,
  };
}

export async function revealSharedVariables(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
): Promise<RevealedVariables> {
  await actor.access.require("environment.see", { kind: "environment", id: environmentId });
  const environment = await environmentRow(services.db, actor.workspace.id, environmentId);
  if (!(await canReadSharedValues(services, actor, environment))) {
    throw new AppError("forbidden", NAMES_ONLY);
  }
  return revealed(
    await readVariables(services.db, services.secrets, environmentOwner(environment)),
  );
}

export async function serviceVariablesTab(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
) {
  const { db } = services;
  await actor.access.require("service.variables", { kind: "service", id: serviceId });
  const row = await loadService(db, actor.workspace.id, serviceId);
  if (!row)
    throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
  const environment = await environmentRow(db, actor.workspace.id, row.environment_id);
  const own = await masked(db, await readVariables(db, services.secrets, serviceOwner(row)));
  // The names show to anyone who can see the environment; Edit shared needs all of it (B1-33).
  const sharedReadable = actor.access.can("environment.see", environmentTarget(environment));
  const sharedEditable = actor.access.can(
    "environment.shared-variables",
    environmentTarget(environment),
  );
  let shared: {
    variables: { name: string; empty: boolean; overridden: boolean }[];
    count: number;
  } | null = null;
  if (sharedReadable) {
    const view = await masked(
      db,
      await readVariables(db, services.secrets, environmentOwner(environment)),
    );
    const ownNames = new Set(own.variables.map((variable) => variable.name));
    shared = {
      variables: view.variables.map((variable) => ({
        ...variable,
        // Shown as "(its own wins)".
        overridden: ownNames.has(variable.name),
      })),
      count: view.count,
    };
  }
  return {
    service: { id: row.id, name: row.name, kind: row.kind },
    environment: {
      id: environment.id,
      name: environment.name,
      isProduction: isProductionEnvironment(environment.name),
    },
    own,
    shared,
    can: { edit: true, editShared: sharedEditable },
  };
}

export async function revealServiceVariables(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<RevealedVariables> {
  await actor.access.require("service.variables", { kind: "service", id: serviceId });
  const row = await loadService(services.db, actor.workspace.id, serviceId);
  if (!row)
    throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
  return revealed(await readVariables(services.db, services.secrets, serviceOwner(row)));
}

type SaveInput = z.output<typeof saveVariablesRequestSchema>;

function blocked(problems: { line: number; message: string }[], field: "lines" | "rows"): AppError {
  const fields: Record<string, string> = {};
  for (const problem of problems) {
    fields[problem.line > 0 ? `${field}.${problem.line}` : "text"] ??= problem.message;
  }
  return new AppError("invalid_request", problems[0]?.message ?? "Check the variables.", {
    fields,
  });
}

/** The text to store: as sent in text mode, or the form's rows merged into the saved text. */
function nextText(current: StoredVariables, input: SaveInput): string {
  if (input.text !== undefined) {
    const problems = checkEnvText(input.text);
    if (problems.length > 0) throw blocked(problems, "lines");
    return input.text;
  }
  const saved = current.text ?? "";
  const savedValues = new Map(
    parseEnv(saved).variables.map((variable) => [variable.name, variable.value]),
  );
  const rows = (input.rows ?? []).map((row, index) => {
    const name = row.name.trim();
    if (row.keep) {
      const value = savedValues.get(name);
      if (value === undefined) {
        throw new AppError(
          "invalid_request",
          `${name || `Row ${index + 1}`} has no saved value to keep. Enter a value.`,
          { fields: { [`rows.${index + 1}`]: "Enter a value." } },
        );
      }
      return { name, value };
    }
    return { name, value: row.value ?? "" };
  });
  const rowProblems = checkRows(rows);
  if (rowProblems.length > 0) throw blocked(rowProblems, "rows");
  const text = textFromRows(current.text === null ? "" : saved, rows);
  const problems = checkEnvText(text);
  if (problems.length > 0) throw blocked(problems, "lines");
  return text;
}

const SAVED = { message: "Variables saved", detail: "They reach the service on its next deploy." };

async function save(
  services: ControlServices,
  actor: WorkspaceActor,
  owner: VariablesOwner,
  input: SaveInput,
  audit: { target: { kind: string; id: string }; details: Record<string, unknown> },
) {
  const { db } = services;
  const version = await db.transaction().execute(async (trx) => {
    const current = await readVariables(trx, services.secrets, owner);
    const text = nextText(current, input);
    return writeVariables(trx, services.secrets, owner, text, {
      by: actor.personId,
      ...(input.baseVersion !== undefined ? { baseVersion: input.baseVersion } : {}),
    });
  });
  const stored = await readVariables(db, services.secrets, owner);
  await recordAudit(db, services.log, auditActor(actor), {
    action: "variables.saved",
    workspaceId: actor.workspace.id,
    target: audit.target,
    // Names only: values are secrets.
    details: { ...audit.details, names: stored.names, version },
  });
  return { ...SAVED, variables: await masked(db, stored) };
}

export async function saveSharedVariables(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
  input: SaveInput,
) {
  await requireSharedVariablesEdit(actor, environmentId);
  const environment = await environmentRow(services.db, actor.workspace.id, environmentId);
  return save(services, actor, environmentOwner(environment), input, {
    target: { kind: "environment", id: environment.id },
    details: { scope: "shared" },
  });
}

export async function saveServiceVariables(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: SaveInput,
) {
  await actor.access.require("service.variables", { kind: "service", id: serviceId });
  const row = await loadService(services.db, actor.workspace.id, serviceId);
  if (!row)
    throw new AppError("not_found", "This service doesn't exist in this workspace any more.");
  return save(services, actor, serviceOwner(row), input, {
    target: { kind: "service", id: row.id },
    details: { scope: "own" },
  });
}
