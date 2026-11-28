import { AppError, parseEnv, textBytes } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import type { SecretBox } from "../security/secret-box.ts";

/**
 * Where variables are kept: one sealed text per environment (its shared variables) or per
 * service (its own), exactly as saved, so comments and layout survive byte for byte
 * (spec 05 5.5). Values are secrets (spec 23.4): sealed with the install key, bound to their
 * owner, never logged. The names are kept in the clear beside the text for counts and lists.
 */

export type VariablesOwner =
  | { kind: "environment"; id: string; workspaceId: string }
  | { kind: "service"; id: string; workspaceId: string };

export interface StoredVariables {
  /** The saved text; null when it can't be opened with this install's key any more. */
  text: string | null;
  names: string[];
  version: number;
  sizeBytes: number;
  updatedAt: Date | null;
  updatedBy: string | null;
  exists: boolean;
}

function sealContext(owner: VariablesOwner): string {
  return `variables:${owner.kind}:${owner.id}`;
}

function ownerColumn(owner: VariablesOwner) {
  return owner.kind === "environment" ? ("environment_id" as const) : ("service_id" as const);
}

export const UNREADABLE_VARIABLES =
  "These variables were saved with another install secret and can't be read any more. Enter them again and save.";

export async function readVariables(
  db: Db,
  box: SecretBox,
  owner: VariablesOwner,
): Promise<StoredVariables> {
  const row = await db
    .selectFrom("variable_set")
    .select(["sealed", "names", "version", "size_bytes", "updated_at", "updated_by"])
    .where("workspace_id", "=", owner.workspaceId)
    .where(ownerColumn(owner), "=", owner.id)
    .executeTakeFirst();
  if (!row) {
    return {
      text: "",
      names: [],
      version: 0,
      sizeBytes: 0,
      updatedAt: null,
      updatedBy: null,
      exists: false,
    };
  }
  const opened = box.open(row.sealed, sealContext(owner));
  return {
    text: opened.ok ? opened.value : null,
    names: row.names,
    version: row.version,
    sizeBytes: row.size_bytes,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
    exists: true,
  };
}

/** Names and counts for many owners at once, without opening anything. */
export async function variableCounts(
  db: Db,
  workspaceId: string,
  kind: VariablesOwner["kind"],
  ids: readonly string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const column = kind === "environment" ? ("environment_id" as const) : ("service_id" as const);
  const rows = await db
    .selectFrom("variable_set")
    .select([column, "names"])
    .where("workspace_id", "=", workspaceId)
    .where(column, "in", [...ids])
    .execute();
  return new Map(rows.map((row) => [String(row[column]), row.names.length]));
}

export interface WriteOptions {
  by: string | null;
  /** The version the editor opened; a newer saved version refuses the write. */
  baseVersion?: number;
}

/**
 * Saves the text as it is. The caller has checked it (parse errors, size). Runs inside the
 * caller's transaction when given one; the row is locked so two saves can't both win.
 */
export async function writeVariables(
  db: Db,
  box: SecretBox,
  owner: VariablesOwner,
  text: string,
  options: WriteOptions,
): Promise<number> {
  const names = parseEnv(text).variables.map((variable) => variable.name);
  const sealed = box.seal(text, sealContext(owner));
  const sizeBytes = textBytes(text);
  const column = ownerColumn(owner);
  const changedElsewhere = () =>
    new AppError(
      "conflict",
      "These variables were changed by someone else after you opened them. Reload to see the latest, then make your change again.",
    );
  const current = await db
    .selectFrom("variable_set")
    .select(["id", "version"])
    .where("workspace_id", "=", owner.workspaceId)
    .where(column, "=", owner.id)
    .forUpdate()
    .executeTakeFirst();
  const opened = current?.version ?? 0;
  if (options.baseVersion !== undefined && options.baseVersion !== opened) throw changedElsewhere();
  if (current) {
    await db
      .updateTable("variable_set")
      .set({
        sealed,
        names,
        size_bytes: sizeBytes,
        version: current.version + 1,
        updated_by: options.by,
        updated_at: sql<Date>`now()`,
      })
      .where("id", "=", current.id)
      .execute();
    return current.version + 1;
  }
  // The first save: locking a row that doesn't exist yet locks nothing, so two first saves can
  // both get here (B1-34). The second one's insert does nothing, and it is told someone else
  // saved first, or (with no version to keep to) saves over it as the next version.
  const inserted = await db
    .insertInto("variable_set")
    .values({
      workspace_id: owner.workspaceId,
      environment_id: owner.kind === "environment" ? owner.id : null,
      service_id: owner.kind === "service" ? owner.id : null,
      sealed,
      names,
      size_bytes: sizeBytes,
      updated_by: options.by,
    })
    .onConflict((conflict) => conflict.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return 1;
  if (options.baseVersion !== undefined) throw changedElsewhere();
  const winner = await db
    .selectFrom("variable_set")
    .select(["id", "version"])
    .where("workspace_id", "=", owner.workspaceId)
    .where(column, "=", owner.id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  await db
    .updateTable("variable_set")
    .set({
      sealed,
      names,
      size_bytes: sizeBytes,
      version: winner.version + 1,
      updated_by: options.by,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", winner.id)
    .execute();
  return winner.version + 1;
}
