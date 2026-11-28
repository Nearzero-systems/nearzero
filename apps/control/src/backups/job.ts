import {
  AppError,
  BACKUP_MESSAGES,
  type BackupFileEntry,
  backupFileName,
  backupPrefix,
  type DatabaseBackupKind,
  type DatabaseKind,
  formatBytes,
  isBackupFileName,
  isLegacyFileOf,
  newestFirst,
  VERSION,
} from "@nearzero/shared";
import { z } from "zod";
import { defineJob } from "../jobs/definition.ts";
import type { Logger } from "../log.ts";
import { HubStopping, targetOf } from "../runners/hub.ts";
import { readDatabaseSettings } from "../service-runtime/databases.ts";
import { Cancelled, NotResumable, reasonOf, ServerOps } from "../service-runtime/server-ops.ts";
import { loadService, type ServiceRow, secretsContext } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { type LoadedDestination, loadDestination } from "./destinations.ts";
import { emitBackupEvent } from "./events.ts";
import { checkRestoreKey, fileKindOf } from "./files.ts";
import {
  claimRun,
  finishRun,
  publishStatus,
  RUN_JOB_KIND,
  RunLog,
  type RunOutcome,
  type RunRow,
} from "./runs.ts";
import { belongsTo, checkVolume } from "./volumes.ts";

/**
 * The background job of every backup and restore run (spec 08 8.3, 17.2, 17.3, 23.1). It runs
 * the work on the service's own server through its runner, writes everything to the run's log,
 * and records the real result: a run whose any step failed, or that uploaded nothing, is Failed.
 * Keep N prunes the schedule's older files only after a successful upload.
 */

class RunFailure extends Error {}

export const STOPPED_MESSAGE =
  "The control plane stopped while this run was in progress. Run it again.";

/** The key a run's work goes under on its runner, so a restart can follow it again (B2-20). */
function workKey(runId: string): string {
  return `backup:${runId}`;
}

interface Secrets {
  password?: string;
  rootPassword?: string;
}

type ServiceWithSecrets = ServiceRow & { secrets_sealed: string | null };

function openDatabaseSecrets(services: ControlServices, row: ServiceWithSecrets): Secrets {
  if (!row.secrets_sealed) return {};
  const opened = services.secrets.open(row.secrets_sealed, secretsContext(row.id));
  if (!opened.ok) {
    throw new RunFailure(
      "This database's password was saved with another install secret and can't be read any more.",
    );
  }
  return JSON.parse(opened.value) as Secrets;
}

async function serviceWithSecrets(
  services: ControlServices,
  run: RunRow,
): Promise<ServiceWithSecrets> {
  if (!run.service_id) throw new RunFailure("The service was deleted.");
  const row = await loadService(services.db, run.workspace_id, run.service_id);
  if (!row) throw new RunFailure("The service was deleted.");
  const sealed = await services.db
    .selectFrom("service")
    .select("secrets_sealed")
    .where("id", "=", row.id)
    .executeTakeFirstOrThrow();
  return { ...row, secrets_sealed: sealed.secrets_sealed };
}

async function destinationOf(services: ControlServices, run: RunRow): Promise<LoadedDestination> {
  if (!run.destination_id) throw new RunFailure("The destination was deleted.");
  try {
    return await loadDestination(services, run.workspace_id, run.destination_id);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") {
      throw new RunFailure("The destination was deleted.");
    }
    throw new RunFailure(reasonOf(error));
  }
}

async function runningContainer(ops: ServerOps, serviceId: string): Promise<string> {
  const containers = await ops.serviceContainers(serviceId);
  const running = containers.find((container) => container.state === "running");
  if (!running) throw new RunFailure(BACKUP_MESSAGES.notRunning);
  return running.id;
}

interface DatabaseParams {
  kind: DatabaseBackupKind;
  database: string | null;
  user: string | null;
  password: string;
  rootPassword: string | null;
  port: number;
  dataVolume: string;
}

/**
 * How the runner reaches the database. A backup dumps the schedule's database, or the
 * service's own; a restore loads into exactly the run's database (R3-45: for MongoDB, none named
 * means every database the file holds, not the service's own).
 */
function databaseParams(
  row: ServiceRow,
  secrets: Secrets,
  database: string | null,
  exact = false,
): DatabaseParams {
  const kind = row.kind as DatabaseBackupKind;
  const settings = readDatabaseSettings(row.kind as DatabaseKind, row.settings, row.app_name);
  return {
    kind,
    database:
      kind === "libsql"
        ? null
        : exact && kind === "mongodb"
          ? database
          : (database ?? settings.databaseName),
    user: settings.user,
    password: secrets.password ?? "",
    rootPassword: secrets.rootPassword ?? null,
    port: settings.port,
    dataVolume: settings.dataVolume,
  };
}

/** libSQL with namespaces is backed up as an archive of its data folder (R3-51). */
function archivesDataFolder(row: ServiceRow): boolean {
  return (
    row.kind === "libsql" && readDatabaseSettings("libsql", row.settings, row.app_name).namespaces
  );
}

const sizeWords = (bytes: number): string => formatBytes(bytes);

/**
 * Deletes the schedule's older files beyond the newest `keep` (spec 17.2). Only this schedule's
 * own files count (B1-52): those its runs wrote (backup_file), and for a schedule moved from
 * 0.1.x the files 0.1.x wrote in its folder (R3-44), for a volume only its own volume's (C1-12).
 * A file another schedule wrote into the same folder, of another volume or through another
 * destination, is never touched (G3-20).
 */
async function prune(
  services: ControlServices,
  ops: ServerOps,
  destination: LoadedDestination,
  schedule: { id: string; legacy_files: boolean; kind: string; volume_name: string | null },
  prefix: string,
  kind: ReturnType<typeof fileKindOf>,
  keep: number,
  log: RunLog,
): Promise<void> {
  const listing = (await ops.command(
    "backup.files",
    { destination: destination.runner, prefix },
    120_000,
  )) as { files: BackupFileEntry[] };
  const written = new Set(
    (
      await services.db
        .selectFrom("backup_file")
        .select("key")
        .where("schedule_id", "=", schedule.id)
        .execute()
    ).map((row) => row.key),
  );
  const ours = listing.files
    .filter((file) => file.key.startsWith(prefix))
    .map((file) => file.key.slice(prefix.length))
    .filter((name) => !name.includes("/") && isBackupFileName(name, kind))
    .filter(
      (name) =>
        written.has(`${prefix}${name}`) ||
        (schedule.legacy_files &&
          isLegacyFileOf(name, schedule.kind === "volume" ? schedule.volume_name : null)),
    )
    .sort(newestFirst);
  const doomed = ours.slice(keep);
  if (doomed.length === 0) {
    log.line(
      `Keeping the last ${keep}: this schedule has ${ours.length} ${ours.length === 1 ? "backup" : "backups"} in ${prefix}, nothing to delete.`,
    );
    return;
  }
  const keys = doomed.map((name) => `${prefix}${name}`);
  await ops.command("backup.prune", { destination: destination.runner, keys }, 120_000);
  await services.db
    .deleteFrom("backup_file")
    .where("schedule_id", "=", schedule.id)
    .where("key", "in", keys)
    .execute();
  log.line(
    `Keeping the last ${keep}: deleted ${doomed.length} older ${doomed.length === 1 ? "backup" : "backups"} (${doomed.join(", ")}).`,
  );
}

async function backup(
  services: ControlServices,
  run: RunRow,
  log: RunLog,
  ops: ServerOps,
): Promise<RunOutcome> {
  if (!run.schedule_id) throw new RunFailure("The schedule was deleted.");
  const schedule = await services.db
    .selectFrom("backup_schedule")
    .selectAll()
    .where("id", "=", run.schedule_id)
    .executeTakeFirst();
  if (!schedule) throw new RunFailure("The schedule was deleted.");
  const row = await serviceWithSecrets(services, run);
  const destination = await destinationOf(services, run);
  log.hide([destination.runner.accessKeyId, destination.runner.secretAccessKey]);
  const prefix = backupPrefix(row.app_name, schedule.folder, schedule.inner_service);
  const kind = fileKindOf(row);
  const archive = run.kind === "database" && archivesDataFolder(row);
  const key = `${prefix}${backupFileName(
    new Date(run.started_at ?? Date.now()),
    kind,
    archive,
    run.kind === "volume" ? schedule.volume_name : null,
  )}`;
  log.line(`Destination: ${destination.name} (bucket ${destination.bucket}), file ${key}`);
  let result: { key: string; bytes: number };
  if (run.kind === "database") {
    const container = await runningContainer(ops, row.id);
    const params = databaseParams(row, openDatabaseSecrets(services, row), schedule.database_name);
    log.hide([params.password, params.rootPassword]);
    log.line(
      archive
        ? `Archiving the data folder of ${row.name}, with every namespace.`
        : params.database
          ? `Dumping the database ${params.database} of ${row.name}.`
          : `Dumping ${row.name}.`,
    );
    result = (await ops.stream(
      "backup.database",
      { runId: run.id, ...params, container, destination: destination.runner, key, archive },
      (text) => log.output(text),
      12 * 3_600_000,
      { key: workKey(run.id) },
    )) as { key: string; bytes: number };
  } else {
    const volume = schedule.volume_name as string;
    const check = await checkVolume(services, row, volume);
    // Reading a volume another service also uses would hand its data to this one (B1-03).
    if (check.others.length > 0) throw new RunFailure(BACKUP_MESSAGES.sharedVolumeBackup);
    const stop = schedule.stop_service
      ? check.users
          .filter((container) => belongsTo(container, row) && container.state === "running")
          .map((container) => container.id)
      : [];
    if (schedule.stop_service) {
      log.line(
        stop.length > 0
          ? `Stopping ${stop.length === 1 ? "1 container" : `${stop.length} containers`} of ${row.name} while copying.`
          : `None of ${row.name}'s containers using ${volume} is running, so nothing is stopped.`,
      );
    }
    log.line(`Archiving the volume ${volume}.`);
    result = (await ops.stream(
      "backup.volume",
      { runId: run.id, volume, stop, destination: destination.runner, key },
      (text) => log.output(text),
      12 * 3_600_000,
      { key: workKey(run.id) },
    )) as { key: string; bytes: number };
  }
  // Never "Succeeded" having uploaded nothing (spec 23.1).
  if (!result || typeof result.bytes !== "number" || result.bytes <= 0) {
    throw new RunFailure(BACKUP_MESSAGES.uploadedNothing);
  }
  log.line(`Uploaded ${result.key} (${sizeWords(result.bytes)}).`);
  // The file is this schedule's: its Keep N counts it, no other schedule's does (B1-52).
  await services.db
    .insertInto("backup_file")
    .values({ schedule_id: schedule.id, key: result.key })
    .onConflict((conflict) => conflict.columns(["schedule_id", "key"]).doNothing())
    .execute();
  if (schedule.keep !== null) {
    try {
      await prune(services, ops, destination, schedule, prefix, kind, schedule.keep, log);
    } catch (error) {
      if (error instanceof Cancelled) throw error;
      return {
        status: "failed",
        error: `The backup was uploaded, but deleting older backups failed: ${reasonOf(error)}`,
        fileKey: result.key,
        sizeBytes: result.bytes,
      };
    }
  }
  return { status: "succeeded", fileKey: result.key, sizeBytes: result.bytes };
}

async function restore(
  services: ControlServices,
  run: RunRow,
  log: RunLog,
  ops: ServerOps,
): Promise<RunOutcome> {
  const row = await serviceWithSecrets(services, run);
  const key = run.file_key as string;
  // The file is checked against the service's prefixes again before anything runs (G2).
  checkRestoreKey(row, key);
  const destination = await destinationOf(services, run);
  log.hide([destination.runner.accessKeyId, destination.runner.secretAccessKey]);
  let result: { bytes: number };
  if (run.kind === "database") {
    const container = await runningContainer(ops, row.id);
    const params = databaseParams(row, openDatabaseSecrets(services, row), run.database_name, true);
    log.hide([params.password, params.rootPassword]);
    log.line(
      `Restoring ${key} from ${destination.name} into ${
        params.database
          ? `the database ${params.database} of ${row.name}`
          : row.kind === "mongodb"
            ? `every database it holds, in ${row.name}`
            : row.name
      }.`,
    );
    result = (await ops.stream(
      "restore.database",
      {
        runId: run.id,
        ...params,
        sourceDatabase: run.source_database,
        container,
        destination: destination.runner,
        key,
      },
      (text) => log.output(text),
      12 * 3_600_000,
      { key: workKey(run.id) },
    )) as { bytes: number };
  } else {
    const volume = run.volume_name as string;
    log.line(`Restoring ${key} from ${destination.name} into the volume ${volume} of ${row.name}.`);
    const check = await checkVolume(services, row, volume, { allowMissing: true });
    if (check.others.length > 0) throw new RunFailure(BACKUP_MESSAGES.sharedVolume);
    if (check.missing) {
      log.line(`The volume ${volume} isn't on the server yet, so the restore makes it.`);
    }
    result = (await ops.stream(
      "restore.volume",
      {
        runId: run.id,
        volume,
        allowedContainers: check.users.map((container) => container.id),
        destination: destination.runner,
        key,
        create: check.missing ? { labels: check.createLabels } : null,
      },
      (text) => log.output(text),
      12 * 3_600_000,
      { key: workKey(run.id) },
    )) as { bytes: number };
  }
  log.line(`Restored ${key} (${sizeWords(result?.bytes ?? 0)}).`);
  return { status: "succeeded", fileKey: key, sizeBytes: result?.bytes ?? null };
}

/** Carries out one claimed run and records how it ended. */
export async function executeRun(
  services: ControlServices,
  run: RunRow,
  signal: AbortSignal,
  log: Logger,
  resume = false,
): Promise<RunRow | null> {
  const runLog = await RunLog.open(services.db, run);
  const what = run.operation === "restore" ? "restore" : "backup";
  runLog.line(
    resume
      ? `Nearzero restarted while this ${what} ran; following it again (Nearzero ${VERSION}).`
      : `Initializing ${what} (Nearzero ${VERSION})`,
  );
  await publishStatus(services.db, run.id);
  // Resuming, the work already going on its server is followed and never started again.
  const ops = new ServerOps(services, targetOf(run.server_id), signal, { resume });
  let outcome: RunOutcome;
  try {
    outcome =
      run.operation === "restore"
        ? await restore(services, run, runLog, ops)
        : await backup(services, run, runLog, ops);
  } catch (error) {
    if (error instanceof HubStopping) {
      // The work goes on on its server; the job's next attempt follows it again (B2-20).
      runLog.line(
        `Nearzero is restarting; the ${what} goes on and is followed again once it's back.`,
      );
      await runLog.flush();
      throw error;
    }
    const reason =
      error instanceof Cancelled
        ? "The run was stopped because the control plane is shutting down."
        : error instanceof NotResumable
          ? STOPPED_MESSAGE
          : reasonOf(error);
    outcome = { status: "failed", error: reason };
    if (!(error instanceof RunFailure) && !(error instanceof AppError)) {
      log.warn("backup run failed", { runId: run.id, error });
    }
  }
  if (outcome.status === "failed") {
    runLog.line(`${what === "restore" ? "Restore failed" : "Backup failed"}: ${outcome.error}`);
  } else {
    runLog.line(what === "restore" ? "Restore finished." : "Backup finished.");
  }
  await runLog.flush();
  const finished = await finishRun(services.db, run.id, outcome);
  if (finished) {
    await emitBackupEvent(services.db, log, finished);
    await publishStatus(services.db, run.id);
  }
  return finished;
}

export function runBackupJob(services: ControlServices) {
  return defineJob({
    kind: RUN_JOB_KIND,
    payload: z.object({ runId: z.string().uuid() }),
    maxAttempts: 2,
    // Backups and restores have lanes of their own: no task run or setup holds one (R4-03).
    lane: "backup",
    async run({ runId }, { job, signal, log }) {
      const current = await services.db
        .selectFrom("backup_run")
        .selectAll()
        .where("id", "=", runId)
        .executeTakeFirst();
      if (!current) return;
      if (current.status === "running") {
        // A run already under way when the control plane stopped is not started twice: it is
        // followed again on its server, or failed when the server no longer has it (B2-20).
        // Another job for a run that is running leaves it alone.
        if (current.job_id === job.id && job.attempt > 1) {
          await executeRun(services, current, signal, log, true);
        }
        return;
      }
      const claimed = await claimRun(services.db, runId);
      // Cancelled or finished meanwhile, or waiting for a run of its schedule to end (that run
      // hands over to it when it does).
      if (claimed === null || claimed === "wait") return;
      await services.db
        .updateTable("backup_run")
        .set({ job_id: job.id })
        .where("id", "=", runId)
        .execute();
      await executeRun(services, claimed, signal, log);
    },
  });
}
