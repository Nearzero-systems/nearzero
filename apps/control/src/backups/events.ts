import { isDatabaseKind, SERVICE_KIND_LABELS } from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";
import type { RunRow } from "./runs.ts";

/**
 * The "Database backup" and "Volume backup" notification events (spec 15.3): one per finished
 * backup run, success or failure, written to the notification outbox for the notifications
 * milestone to send. A retried job never writes a second one (the run id is the dedupe key).
 * Payloads carry names and results only, never secrets: the project, environment and service, the
 * database and its type or the volume, the destination, the result and the size or the reason.
 */

export const BACKUP_EVENTS = {
  database: "backup.database",
  volume: "backup.volume",
} as const;

export interface BackupEventPayload {
  runId: string;
  trigger: "schedule" | "manual";
  service: { id: string | null; name: string; kind: string };
  project: string;
  environment: string;
  destination: string;
  volume: string | null;
  /** Database backups: the database dumped (null: every database, MongoDB) and its type (R3-47). */
  database: string | null;
  databaseType: string | null;
  result: "succeeded" | "failed";
  /** The reason a run failed, in plain words (never secrets). */
  error: string | null;
  file: string | null;
  sizeBytes: number | null;
  finishedAt: string;
}

export async function emitBackupEvent(db: Db, log: Logger, run: RunRow): Promise<void> {
  if (run.operation !== "backup") return;
  if (run.status !== "succeeded" && run.status !== "failed") return;
  const payload: BackupEventPayload = {
    runId: run.id,
    trigger: run.trigger,
    service: { id: run.service_id, name: run.service_name, kind: run.service_kind },
    project: run.project_name,
    environment: run.environment_name,
    destination: run.destination_name,
    volume: run.volume_name,
    database: run.kind === "database" ? run.database_name : null,
    databaseType:
      run.kind === "database" && isDatabaseKind(run.service_kind)
        ? SERVICE_KIND_LABELS[run.service_kind]
        : null,
    result: run.status,
    error: run.error,
    file: run.file_key,
    sizeBytes: run.size_bytes,
    finishedAt: new Date(run.finished_at ?? Date.now()).toISOString(),
  };
  try {
    await db
      .insertInto("notification_outbox")
      .values({
        workspace_id: run.workspace_id,
        event: BACKUP_EVENTS[run.kind],
        dedupe_key: `backup-run:${run.id}`,
        payload: JSON.stringify(payload),
      })
      .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
      .execute();
  } catch (error) {
    // A lost notification never turns a finished backup into a failure.
    log.warn("couldn't record the backup notification", { runId: run.id, error });
  }
}
