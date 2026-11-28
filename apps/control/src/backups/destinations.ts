import {
  AppError,
  type BackupProvider,
  type CreateDestinationRequest,
  DESTINATION_MESSAGES,
  destinationDeletedMessage,
  destinationNotPublicMessage,
  destinationTestOk,
  duplicateDestinationMessage,
  PROVIDER_PRESETS,
  type RunnerDestination,
  type TestDestinationValuesRequest,
  type UpdateDestinationRequest,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { isOurId } from "../projects/objects.ts";
import { HOST_TARGET, RunnerCommandError } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { publicEndpoint } from "./addresses.ts";
import { cancelWaitingRuns } from "./runs.ts";
import "./tables.ts";

/**
 * Backup destinations (spec 17.1): S3-compatible buckets a workspace backs up to. The keys are
 * sealed with the install key the moment they arrive and never leave the platform again except
 * to a runner carrying out a backup; views show only who saved them and when (spec 23.4).
 */

export interface DestinationView {
  id: string;
  name: string;
  provider: BackupProvider;
  providerLabel: string;
  endpoint: string;
  bucket: string;
  region: string;
  keys: { savedAt: string; savedBy: string | null; readable: boolean };
  schedules: number;
  createdAt: string;
  updatedAt: string;
}

export interface DestinationList {
  destinations: DestinationView[];
  can: { use: boolean; manage: boolean };
}

const NOT_FOUND =
  "This destination doesn't exist in this workspace, or you don't have access to it.";

function keysContext(workspaceId: string, destinationId: string): string {
  return `workspace:${workspaceId}:backup-destination:${destinationId}`;
}

/** Seeing destinations needs either backup right (spec 17.5). */
export function destinationRights(actor: WorkspaceActor): { use: boolean; manage: boolean } {
  return {
    use: actor.access.can("destinations.use"),
    manage: actor.access.can("destinations.manage"),
  };
}

async function requireSight(actor: WorkspaceActor): Promise<void> {
  if (destinationRights(actor).manage) return;
  await actor.access.require("destinations.use");
}

function personName(row: { first_name: string | null; last_name: string | null; email: string }) {
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return name || row.email;
}

async function views(
  services: ControlServices,
  workspaceId: string,
  ids?: string[],
): Promise<DestinationView[]> {
  let query = services.db
    .selectFrom("backup_destination as d")
    .leftJoin("person as p", "p.id", "d.keys_saved_by")
    .select([
      "d.id",
      "d.name",
      "d.provider",
      "d.endpoint",
      "d.bucket",
      "d.region",
      "d.keys_sealed",
      "d.keys_saved_at",
      "d.created_at",
      "d.updated_at",
      "p.first_name",
      "p.last_name",
      "p.email",
    ])
    .select((eb) =>
      eb
        .selectFrom("backup_schedule as s")
        .select((inner) => inner.fn.countAll<number>().as("n"))
        .whereRef("s.destination_id", "=", "d.id")
        .as("schedules"),
    )
    .where("d.workspace_id", "=", workspaceId)
    .orderBy(sql`lower(d.name)`);
  if (ids) query = query.where("d.id", "in", ids);
  const rows = await query.execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    provider: row.provider,
    providerLabel: PROVIDER_PRESETS[row.provider].label,
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region,
    keys: {
      savedAt: new Date(row.keys_saved_at).toISOString(),
      savedBy: row.email ? personName({ ...row, email: row.email }) : null,
      readable: services.secrets.open(row.keys_sealed, keysContext(workspaceId, row.id)).ok,
    },
    schedules: Number(row.schedules ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

async function one(services: ControlServices, workspaceId: string, id: string) {
  if (!isOurId(id)) throw new AppError("not_found", NOT_FOUND);
  const [view] = await views(services, workspaceId, [id]);
  if (!view) throw new AppError("not_found", NOT_FOUND);
  return view;
}

export async function listDestinations(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<DestinationList> {
  await requireSight(actor);
  return {
    destinations: await views(services, actor.workspace.id),
    can: destinationRights(actor),
  };
}

export async function getDestination(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<DestinationView> {
  await requireSight(actor);
  return one(services, actor.workspace.id, id);
}

function duplicate(error: unknown): boolean {
  return (
    (error as { code?: string }).code === "23505" &&
    String((error as { constraint?: string }).constraint ?? "").includes("name")
  );
}

export async function addDestination(
  services: ControlServices,
  actor: WorkspaceActor,
  input: CreateDestinationRequest,
): Promise<DestinationView> {
  await actor.access.require("destinations.manage");
  const id = crypto.randomUUID();
  const sealed = services.secrets.seal(
    JSON.stringify({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }),
    keysContext(actor.workspace.id, id),
  );
  try {
    await services.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("backup_destination")
        .values({
          id,
          workspace_id: actor.workspace.id,
          name: input.name,
          provider: input.provider,
          endpoint: input.endpoint,
          bucket: input.bucket,
          region: input.region,
          keys_sealed: sealed,
          keys_saved_by: actor.personId,
          created_by: actor.personId,
        })
        .execute();
      await recordAudit(trx, services.log, auditActor(actor), {
        action: "backup-destination.added",
        workspaceId: actor.workspace.id,
        target: { kind: "backup_destination", id },
        details: { name: input.name, provider: input.provider, bucket: input.bucket },
      });
    });
  } catch (error) {
    if (duplicate(error)) {
      throw new AppError("conflict", duplicateDestinationMessage(input.name), {
        fields: { name: duplicateDestinationMessage(input.name) },
      });
    }
    throw error;
  }
  return one(services, actor.workspace.id, id);
}

export async function updateDestination(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  input: UpdateDestinationRequest,
): Promise<DestinationView> {
  await actor.access.require("destinations.manage");
  const current = await one(services, actor.workspace.id, id);
  const changes: Record<string, unknown> = {};
  for (const key of ["name", "provider", "endpoint", "bucket", "region"] as const) {
    if (input[key] !== undefined && input[key] !== current[key]) changes[key] = input[key];
  }
  const newAccess = input.accessKeyId ?? "";
  const newSecret = input.secretAccessKey ?? "";
  // Blank keys keep the saved ones (spec 17.1); one new key replaces only that one.
  let keysChanged = false;
  if (newAccess !== "" || newSecret !== "") {
    const saved = openKeys(services, actor.workspace.id, id, await sealedKeys(services, id));
    if ((newAccess === "" || newSecret === "") && !saved) {
      throw new AppError("invalid_request", DESTINATION_MESSAGES.keysUnreadable, {
        fields: {
          [newAccess === "" ? "accessKeyId" : "secretAccessKey"]:
            DESTINATION_MESSAGES.keysUnreadable,
        },
      });
    }
    const next = {
      accessKeyId: newAccess || saved?.accessKeyId || "",
      secretAccessKey: newSecret || saved?.secretAccessKey || "",
    };
    changes.keys_sealed = services.secrets.seal(
      JSON.stringify(next),
      keysContext(actor.workspace.id, id),
    );
    changes.keys_saved_at = new Date();
    changes.keys_saved_by = actor.personId;
    keysChanged = true;
  }
  if (Object.keys(changes).length === 0) return current;
  try {
    await services.db
      .updateTable("backup_destination")
      .set({ ...changes, updated_at: new Date() })
      .where("id", "=", id)
      .where("workspace_id", "=", actor.workspace.id)
      .execute();
  } catch (error) {
    if (duplicate(error) && input.name) {
      throw new AppError("conflict", duplicateDestinationMessage(input.name), {
        fields: { name: duplicateDestinationMessage(input.name) },
      });
    }
    throw error;
  }
  const { keys_sealed: _sealed, keys_saved_at: _at, keys_saved_by: _by, ...shown } = changes;
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "backup-destination.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "backup_destination", id },
    details: { ...shown, keysReplaced: keysChanged },
  });
  return one(services, actor.workspace.id, id);
}

export async function deleteDestination(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<{ deleted: true; schedulesRemoved: number; message: string }> {
  await actor.access.require("destinations.manage");
  const current = await one(services, actor.workspace.id, id);
  const removed = await services.db.transaction().execute(async (trx) => {
    const schedules = await trx
      .selectFrom("backup_schedule")
      .select("id")
      .where("destination_id", "=", id)
      .where("workspace_id", "=", actor.workspace.id)
      .execute();
    for (const schedule of schedules) await cancelWaitingRuns(trx, schedule.id);
    // Its schedules go with it (ON DELETE CASCADE); the files stay in the bucket (spec 17.1).
    await trx
      .deleteFrom("backup_destination")
      .where("id", "=", id)
      .where("workspace_id", "=", actor.workspace.id)
      .execute();
    await recordAudit(trx, services.log, auditActor(actor), {
      action: "backup-destination.deleted",
      workspaceId: actor.workspace.id,
      target: { kind: "backup_destination", id },
      details: { name: current.name, schedulesRemoved: schedules.length },
    });
    return schedules.length;
  });
  return { deleted: true, schedulesRemoved: removed, message: destinationDeletedMessage(removed) };
}

async function sealedKeys(services: ControlServices, id: string): Promise<string> {
  const row = await services.db
    .selectFrom("backup_destination")
    .select("keys_sealed")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.keys_sealed;
}

function openKeys(
  services: ControlServices,
  workspaceId: string,
  id: string,
  sealed: string,
): { accessKeyId: string; secretAccessKey: string } | null {
  const opened = services.secrets.open(sealed, keysContext(workspaceId, id));
  if (!opened.ok) return null;
  return JSON.parse(opened.value) as { accessKeyId: string; secretAccessKey: string };
}

export interface LoadedDestination {
  id: string;
  name: string;
  bucket: string;
  runner: RunnerDestination;
}

/**
 * A destination with its keys, for a runner. Only ever the workspace's own (spec 22.4 rule 1);
 * never sent to a browser or the model.
 */
export async function loadDestination(
  services: ControlServices,
  workspaceId: string,
  id: string,
): Promise<LoadedDestination> {
  if (!isOurId(id)) throw new AppError("not_found", NOT_FOUND);
  const row = await services.db
    .selectFrom("backup_destination")
    .select(["id", "name", "provider", "endpoint", "bucket", "region", "keys_sealed"])
    .where("id", "=", id)
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!row) throw new AppError("not_found", NOT_FOUND);
  const keys = openKeys(services, workspaceId, id, row.keys_sealed);
  if (!keys) throw new AppError("conflict", DESTINATION_MESSAGES.keysUnreadable);
  return {
    id: row.id,
    name: row.name,
    bucket: row.bucket,
    runner: {
      provider: row.provider,
      endpoint: row.endpoint,
      bucket: row.bucket,
      region: row.region,
      accessKeyId: keys.accessKeyId,
      secretAccessKey: keys.secretAccessKey,
    },
  };
}

/** Destinations a schedule may pick, by name (people with "Back up to …"). */
export async function destinationChoices(
  services: ControlServices,
  workspaceId: string,
): Promise<{ id: string; name: string; bucket: string; providerLabel: string }[]> {
  const rows = await services.db
    .selectFrom("backup_destination")
    .select(["id", "name", "bucket", "provider"])
    .where("workspace_id", "=", workspaceId)
    .orderBy(sql`lower(name)`)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    bucket: row.bucket,
    providerLabel: PROVIDER_PRESETS[row.provider].label,
  }));
}

interface TestTarget {
  target: string;
  name: string;
  /** The Nearzero host, testing for a workspace that doesn't use it: public endpoints only. */
  publicOnly?: boolean;
}

/**
 * The server a Test runs on: the one asked for, when the person can reach it; else the Nearzero
 * host for people who may use it, then their other connected servers, by name; else (a
 * workspace with no server of its own, R3-49) the Nearzero host, for endpoints on the public
 * internet only.
 */
async function testTarget(
  services: ControlServices,
  actor: WorkspaceActor,
  serverId: string | undefined,
): Promise<TestTarget> {
  const online = (target: string) => services.runners.isOnline(target);
  if (serverId === HOST_TARGET) {
    await actor.access.require("host.use");
    if (!online(HOST_TARGET)) throw new AppError("conflict", DESTINATION_MESSAGES.noServer);
    return { target: HOST_TARGET, name: "Nearzero host" };
  }
  if (serverId) {
    await actor.access.require("server.see", { kind: "server", id: serverId });
    const row = await services.db
      .selectFrom("server")
      .select(["id", "name"])
      .where("id", "=", serverId)
      .where("workspace_id", "=", actor.workspace.id)
      .executeTakeFirst();
    if (!row || !online(row.id)) throw new AppError("conflict", DESTINATION_MESSAGES.noServer);
    return { target: row.id, name: row.name };
  }
  if (actor.access.can("host.use") && online(HOST_TARGET)) {
    return { target: HOST_TARGET, name: "Nearzero host" };
  }
  const rows = await services.db
    .selectFrom("server")
    .select(["id", "name"])
    .where("workspace_id", "=", actor.workspace.id)
    .orderBy(sql`lower(name)`)
    .execute();
  for (const row of rows) {
    if (!actor.access.can("server.see", { kind: "server", id: row.id })) continue;
    if (online(row.id)) return { target: row.id, name: row.name };
  }
  if (online(HOST_TARGET)) return { target: HOST_TARGET, name: "Nearzero host", publicOnly: true };
  throw new AppError("conflict", DESTINATION_MESSAGES.noServer);
}

/** Lists the bucket from the chosen server within 10 seconds, and says how it went (spec 17.1). */
async function runTest(
  services: ControlServices,
  where: TestTarget,
  destination: RunnerDestination,
): Promise<TestResult> {
  let pinnedHosts: { host: string; address: string }[] = [];
  if (where.publicOnly) {
    const checked = await publicEndpoint(destination.endpoint);
    if (!checked.ok) {
      return {
        ok: false,
        message: DESTINATION_MESSAGES.testFailed,
        detail: destinationNotPublicMessage(checked.host),
        server: where.name,
      };
    }
    pinnedHosts = checked.pinned;
  }
  try {
    await services.runners.command(
      where.target,
      "backup.test",
      { destination, timeoutSeconds: 10, pinnedHosts },
      // The listing itself gets 10 seconds; the first test on a server also fetches the helper.
      { timeoutMs: 180_000 },
    );
    return {
      ok: true,
      message: destinationTestOk(destination.bucket),
      detail: null,
      server: where.name,
    };
  } catch (error) {
    const detail =
      error instanceof RunnerCommandError
        ? error.message
        : error instanceof AppError
          ? error.message
          : null;
    return { ok: false, message: DESTINATION_MESSAGES.testFailed, detail, server: where.name };
  }
}

export interface TestResult {
  ok: boolean;
  message: string;
  /** What the store said, for the person to act on. Never contains the keys. */
  detail: string | null;
  server: string;
}

/** Lists the bucket through a runner within 10 seconds (spec 17.1). */
/**
 * Test connection with the dialog's typed values, before anything is saved (spec 17.1). Blank
 * keys on an edit use the destination's saved ones; nothing typed is stored or logged.
 */
export async function testDestinationValues(
  services: ControlServices,
  actor: WorkspaceActor,
  input: TestDestinationValuesRequest,
): Promise<TestResult> {
  await actor.access.require("destinations.manage");
  let accessKeyId = input.accessKeyId;
  let secretAccessKey = input.secretAccessKey;
  if ((accessKeyId === "" || secretAccessKey === "") && input.destinationId) {
    const saved = await loadDestination(services, actor.workspace.id, input.destinationId);
    accessKeyId ||= saved.runner.accessKeyId;
    secretAccessKey ||= saved.runner.secretAccessKey;
  }
  if (accessKeyId === "" || secretAccessKey === "") {
    const field = accessKeyId === "" ? "accessKeyId" : "secretAccessKey";
    const text =
      field === "accessKeyId" ? "Paste the access key ID." : "Paste the secret access key.";
    throw new AppError("invalid_request", text, { fields: { [field]: text } });
  }
  const where = await testTarget(services, actor, input.serverId);
  return runTest(services, where, {
    provider: input.provider,
    endpoint: input.endpoint,
    bucket: input.bucket,
    region: input.region,
    accessKeyId,
    secretAccessKey,
  });
}

export async function testDestination(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  serverId?: string,
): Promise<TestResult> {
  await requireSight(actor);
  const destination = await loadDestination(services, actor.workspace.id, id);
  const where = await testTarget(services, actor, serverId);
  return runTest(services, where, destination.runner);
}
