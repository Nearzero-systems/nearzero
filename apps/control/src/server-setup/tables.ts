import type { ColumnType, Generated } from "kysely";

/**
 * Types for the tables of migration 0400 (setting servers up over SSH, spec 09 9.3–9.6). They are
 * added to the control plane's `Database` type here, beside the area that owns them.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;
type Json<T> = ColumnType<T, string | undefined, string>;

export type SetupRunState = "running" | "succeeded" | "failed";

export interface StoredStep {
  state: "waiting" | "running" | "done" | "skipped" | "failed";
  note: string | null;
}

export interface ServerSetupRunTable {
  id: Generated<string>;
  server_id: string;
  workspace_id: string;
  state: ColumnType<SetupRunState, SetupRunState | undefined, SetupRunState>;
  step: number | null;
  steps: Json<StoredStep[]>;
  failure: ColumnType<unknown, string | null | undefined, string | null>;
  retried_stalled: ColumnType<boolean, boolean | undefined, boolean>;
  ssh_user: string;
  job_id: number | null;
  requested_by: string | null;
  log_seq: ColumnType<number, number | undefined, number>;
  started_at: DbTime;
  last_activity_at: DbTime;
  finished_at: Date | null;
}

export interface ServerSetupLogTable {
  run_id: string;
  seq: number;
  at: DbTime;
  text: string;
}

export interface ServerInspectionTable {
  server_id: string;
  validation: ColumnType<unknown, string | null | undefined, string | null>;
  validation_at: Date | null;
  audit: ColumnType<unknown, string | null | undefined, string | null>;
  audit_at: Date | null;
}

export interface DockerCleanupTable {
  target: string;
  enabled: boolean | null;
  last_local_date: string | null;
  last_at: Date | null;
  /** bigint comes back as a number (see database.ts). */
  last_freed_bytes: number | null;
  last_error: string | null;
}

export interface ServerRemovalTable {
  id: Generated<string>;
  workspace_id: string;
  server_id: string;
  server_name: string;
  state: ColumnType<SetupRunState, SetupRunState | undefined, SetupRunState>;
  run_ids: ColumnType<string[], string[] | undefined, string[]>;
  message: string | null;
  job_id: number | null;
  requested_by: string | null;
  created_at: DbTime;
  finished_at: Date | null;
}

declare module "../db/schema.ts" {
  interface Database {
    server_setup_run: ServerSetupRunTable;
    server_setup_log: ServerSetupLogTable;
    server_inspection: ServerInspectionTable;
    docker_cleanup: DockerCleanupTable;
    server_removal: ServerRemovalTable;
  }
}
