import type { BackupProvider, BackupRunStatus } from "@nearzero/shared";
import type { ColumnType, Generated } from "kysely";

/**
 * Types for the backup tables of migrations 0300 and 0750 (spec 08 8.3, 15.3, 17). They are added to the
 * control plane's `Database` type here, beside the area that owns them.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;
type Id = Generated<string>;

export interface BackupDestinationTable {
  id: Id;
  workspace_id: string;
  name: string;
  provider: BackupProvider;
  endpoint: string;
  bucket: string;
  region: ColumnType<string, string | undefined, string>;
  keys_sealed: string;
  keys_saved_at: DbTime;
  keys_saved_by: string | null;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export type BackupScheduleKind = "database" | "volume";

export interface BackupScheduleTable {
  id: Id;
  workspace_id: string;
  service_id: string;
  destination_id: string;
  kind: BackupScheduleKind;
  database_name: string | null;
  volume_name: string | null;
  inner_service: string | null;
  stop_service: ColumnType<boolean, boolean | undefined, boolean>;
  folder: string;
  cron: string;
  keep: number | null;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  next_run_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** Moved from 0.1.x: 0.1.x's files in its folder are its own (migration 0750). */
  legacy_files: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export type BackupOperation = "backup" | "restore";
export type BackupTrigger = "schedule" | "manual";

export interface BackupRunTable {
  id: Id;
  workspace_id: string;
  schedule_id: string | null;
  service_id: string | null;
  operation: BackupOperation;
  kind: BackupScheduleKind;
  service_kind: string;
  service_name: string;
  app_name: string;
  project_name: string;
  environment_name: string;
  server_id: string | null;
  destination_id: string | null;
  destination_name: string;
  database_name: string | null;
  /** Restores: the database the file was dumped from, when known (migration 0750). */
  source_database: ColumnType<string | null, string | null | undefined, string | null>;
  volume_name: string | null;
  file_key: string | null;
  /** Stops the service (or restores into it): one such run per service at a time. */
  exclusive: ColumnType<boolean, boolean | undefined, boolean>;
  /** bigint, read as a number (see db/database.ts). */
  size_bytes: number | null;
  status: ColumnType<BackupRunStatus, BackupRunStatus | undefined, BackupRunStatus>;
  trigger: BackupTrigger;
  request_key: ColumnType<string | null, string | null | undefined, string | null>;
  due_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  error: string | null;
  requested_by: string | null;
  job_id: number | null;
  log_bytes: ColumnType<number, number | undefined, number>;
  log_lines: ColumnType<number, number | undefined, number>;
  created_at: DbTime;
  started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  updated_at: DbTime;
}

/** A file a schedule's run wrote (migration 0750): what its Keep N may prune. */
export interface BackupFileTable {
  schedule_id: string;
  key: string;
  created_at: DbTime;
}

export interface BackupRunLogTable {
  run_id: string;
  seq: number;
  at: DbTime;
  text: string;
}

export interface NotificationOutboxTable {
  id: Generated<number>;
  workspace_id: string;
  event: string;
  dedupe_key: string;
  /** JSON; written as a JSON string. */
  payload: ColumnType<Record<string, unknown>, string, string>;
  created_at: DbTime;
  delivered_at: Date | null;
}

declare module "../db/schema.ts" {
  interface Database {
    backup_destination: BackupDestinationTable;
    backup_schedule: BackupScheduleTable;
    backup_run: BackupRunTable;
    backup_run_log: BackupRunLogTable;
    backup_file: BackupFileTable;
    notification_outbox: NotificationOutboxTable;
  }
}
