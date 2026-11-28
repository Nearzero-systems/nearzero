import {
  AppError,
  BACKUP_MESSAGES,
  type BackupFileEntry,
  type BackupFileKind,
  backupPrefix,
  confirmServiceNameMessage,
  fileBelongsToService,
  isBackupFileName,
  newestFirst,
  type RestoreRequest,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { targetOf } from "../runners/hub.ts";
import type { ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { loadDestination } from "./destinations.ts";
import { type RunView, requestRestoreRun, runView } from "./runs.ts";
import { backupKindOf, checkDatabaseChoice, ownDatabase, serviceFor } from "./schedules.ts";
import { checkVolume, discoverVolumes } from "./volumes.ts";

/**
 * Finding and restoring backups (spec 08 8.3, 17.3, 24 G1 and G2). A person lists only the files
 * under this service's own prefixes, on the service's own server, and a restore accepts only a
 * file of this service's backups: the key is checked against the service's prefix before
 * anything runs. The files 0.1.x wrote are listed and restored with 1.0's (R2-06, R3-44), and a
 * database backup goes back into the database it was dumped from unless the person names
 * another (R3-45).
 */

export interface BackupFileView {
  key: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string;
  /** Database backups: the database it was dumped from (null: every database, or libSQL). */
  database: string | null;
}

export function fileKindOf(row: Pick<ServiceRow, "kind">): BackupFileKind {
  if (backupKindOf(row.kind) === "volume") return "volume";
  return row.kind as BackupFileKind;
}

/** The prefix a listing or a restore uses: the service's app name, any inner service, folder. */
async function prefixFor(
  services: ControlServices,
  row: ServiceRow,
  folder: string,
  volume: string | undefined,
): Promise<string> {
  if (row.kind !== "compose" || !volume) return backupPrefix(row.app_name, folder);
  // A Compose volume's backups go under <app name>_<inner service> when one service uses it,
  // as its schedules write them.
  const found = (await discoverVolumes(services, row)).volumes.find((item) => item.name === volume);
  const inner = found?.innerServices.length === 1 ? (found.innerServices[0] ?? null) : null;
  return backupPrefix(row.app_name, folder, inner);
}

export async function listServiceFiles(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  query: { destinationId: string; folder: string; volume?: string | undefined },
): Promise<{ prefix: string; files: BackupFileView[] }> {
  const { row } = await serviceFor(services, actor, serviceId, "service.restore");
  await actor.access.require("destinations.use");
  const destination = await loadDestination(services, actor.workspace.id, query.destinationId);
  const prefix = await prefixFor(services, row, query.folder, query.volume);
  const kind = fileKindOf(row);
  const answer = (await services.runners.command(
    targetOf(row.server_id),
    "backup.files",
    { destination: destination.runner, prefix },
    { timeoutMs: 120_000 },
  )) as { files: BackupFileEntry[] };
  const files = answer.files
    // Only this prefix's own files (never a deeper folder's), and only Nearzero's (G1).
    .filter((file) => file.key.startsWith(prefix) && !file.key.slice(prefix.length).includes("/"))
    .filter((file) => fileBelongsToService(file.key, row.app_name))
    .filter((file) => isBackupFileName(file.key.slice(prefix.length), kind))
    .map((file) => ({
      key: file.key,
      name: file.key.slice(prefix.length),
      sizeBytes: file.size,
      modifiedAt: file.modifiedAt,
      database: null as string | null,
    }))
    .sort((a, b) => newestFirst(a.name, b.name));
  if (backupKindOf(row.kind) === "database" && row.kind !== "libsql") {
    // What each file restores into by default (R3-45), so the confirm step can name it.
    const sources = await sourceDatabases(
      services.db,
      row,
      files.map((file) => file.key),
      destination.id,
    );
    for (const file of files) file.database = sources.get(file.key) ?? null;
  }
  return { prefix, files };
}

/**
 * Whether a key is a backup of this service (G2). Refused with "This backup belongs to another
 * service." otherwise, before anything runs.
 */
export function checkRestoreKey(row: Pick<ServiceRow, "kind" | "app_name">, key: string): void {
  if (!fileBelongsToService(key, row.app_name)) {
    throw new AppError("forbidden", BACKUP_MESSAGES.otherService, {
      fields: { key: BACKUP_MESSAGES.otherService },
    });
  }
  const name = key.split("/").at(-1) ?? "";
  if (!isBackupFileName(name, fileKindOf(row))) {
    throw new AppError("invalid_request", BACKUP_MESSAGES.wrongFileKind, {
      fields: { key: BACKUP_MESSAGES.wrongFileKind },
    });
  }
}

/**
 * The database a backup file was dumped from (R3-45): the run that wrote it says; a file no run
 * of 1.0 wrote (0.1.x's, or one whose run record is gone) belongs to the schedule writing to its
 * folder; otherwise the service's own database. Null for MongoDB means every database.
 */
export async function sourceDatabases(
  db: Db,
  row: ServiceRow,
  keys: readonly string[],
  destinationId: string,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (keys.length === 0 || row.kind === "libsql") return out;
  const fallback = ownDatabase(row);
  const written = await db
    .selectFrom("backup_run")
    .select(["file_key", "database_name"])
    .where("service_id", "=", row.id)
    .where("operation", "=", "backup")
    .where("status", "=", "succeeded")
    .where("file_key", "in", [...keys])
    .orderBy("created_at")
    .execute();
  for (const run of written) {
    // An older run of a database other than MongoDB left the name out: it dumped the default.
    const name = run.database_name ?? (row.kind === "mongodb" ? null : fallback);
    out.set(run.file_key as string, name);
  }
  const schedules = await db
    .selectFrom("backup_schedule")
    .select(["folder", "database_name"])
    .where("service_id", "=", row.id)
    .where("kind", "=", "database")
    .orderBy(sql`destination_id = ${destinationId}`)
    .orderBy("created_at", "desc")
    .execute();
  // Later rows win: the same destination's, then the oldest schedule of the folder.
  const byFolder = new Map(schedules.map((item) => [item.folder, item.database_name]));
  for (const key of keys) {
    if (out.has(key)) continue;
    const folder = key.split("/").slice(1, -1).join("/");
    out.set(key, byFolder.has(folder) ? (byFolder.get(folder) ?? fallback) : fallback);
  }
  return out;
}

export async function sourceDatabaseOf(
  db: Db,
  row: ServiceRow,
  key: string,
  destinationId: string,
): Promise<string | null> {
  return (await sourceDatabases(db, row, [key], destinationId)).get(key) ?? null;
}

/** Starts a restore in the background (spec 08 8.3 steps 2–4, 17.3 Restore). */
export async function startRestore(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: RestoreRequest,
  requestKey: string | null = null,
): Promise<{ run: RunView; message: string }> {
  const context = await serviceFor(services, actor, serviceId, "service.restore");
  const { row } = context;
  // A retried request gets the restore it already started.
  if (requestKey) {
    const earlier = await services.db
      .selectFrom("backup_run")
      .selectAll()
      .where("service_id", "=", row.id)
      .where("schedule_id", "is", null)
      .where("request_key", "=", requestKey)
      .executeTakeFirst();
    if (earlier) return { run: runView(earlier), message: BACKUP_MESSAGES.restoreStarted };
  }
  checkRestoreKey(row, input.key);
  if (input.confirm.trim() !== row.name) {
    throw new AppError("invalid_request", confirmServiceNameMessage(row.name), {
      fields: { confirm: confirmServiceNameMessage(row.name) },
    });
  }
  await actor.access.require("destinations.use");
  const destination = await loadDestination(services, actor.workspace.id, input.destinationId);
  const kind = backupKindOf(row.kind);
  let volume: string | null = null;
  let source: string | null = null;
  let database: string | null = null;
  if (kind === "volume") {
    if (!input.volume) {
      throw new AppError("invalid_request", "Pick the volume to restore into.", {
        fields: { volume: "Pick the volume to restore into." },
      });
    }
    // Checked before anything runs, and again by the runner when it starts (spec 17.3). A
    // volume the service mounts that isn't on the server yet is made by the restore (R3-52).
    const check = await checkVolume(services, row, input.volume, { allowMissing: true });
    if (check.others.length > 0) {
      throw new AppError("conflict", BACKUP_MESSAGES.sharedVolume, {
        fields: { volume: BACKUP_MESSAGES.sharedVolume },
      });
    }
    volume = input.volume;
  } else if (row.kind !== "libsql") {
    source = await sourceDatabaseOf(services.db, row, input.key, destination.id);
    database = input.database ? input.database : source;
    checkDatabaseChoice(row, database);
  }
  const run = await requestRestoreRun(services.db, {
    workspaceId: actor.workspace.id,
    scheduleId: null,
    serviceId: row.id,
    operation: "restore",
    kind,
    serviceKind: row.kind,
    serviceName: row.name,
    appName: row.app_name,
    projectName: context.projectName,
    environmentName: context.environmentName,
    serverId: row.server_id,
    destinationId: destination.id,
    destinationName: destination.name,
    databaseName: database,
    sourceDatabase: source,
    volumeName: volume,
    fileKey: input.key,
    trigger: "manual",
    dueAt: null,
    requestedBy: actor.personId,
    requestKey,
    exclusive: true,
  });
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "backup.restore-requested",
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: { runId: run.id, destination: destination.name, key: input.key, volume, database },
  });
  return { run: runView(run), message: BACKUP_MESSAGES.restoreStarted };
}
