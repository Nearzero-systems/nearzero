import type { ColumnType, Generated } from "kysely";

/**
 * Types for the tables of migration 0650 (spec 29): imports, what each bundle record became, and
 * the move of servers and services onto the 1.0 runner. They join the control plane's `Database`
 * type here, beside the area that owns them.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>;
type NullableJson = ColumnType<unknown, string | null | undefined, string | null>;

export interface MigrationImportTable {
  id: Generated<string>;
  source_install: string;
  bundle_sha256: string;
  format_version: number;
  source_version: string;
  exported_at: Date | null;
  in_place: ColumnType<boolean, boolean | undefined, boolean>;
  report: Json;
  imported_at: DbTime;
}

export interface MigrationRecordTable {
  source_install: string;
  kind: string;
  ref: string;
  object_id: string;
  import_id: string;
}

export type ServerMoveState = "waiting" | "setting_up" | "ready" | "failed";
export type ServiceMoveState = "waiting" | "moving" | "moved" | "failed" | "skipped";

export interface MigrationServerMoveTable {
  target: string;
  import_id: string;
  position: number;
  legacy: NullableJson;
  state: ColumnType<ServerMoveState, ServerMoveState | undefined, ServerMoveState>;
  reason: string | null;
  setup_run_id: string | null;
  certificates_placed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: DbTime;
}

export interface MigrationMoveTable {
  service_id: string;
  import_id: string;
  target: string;
  position: number;
  legacy: NullableJson;
  state: ColumnType<ServiceMoveState, ServiceMoveState | undefined, ServiceMoveState>;
  reason: string | null;
  deployment_id: string | null;
  legacy_stopped: ColumnType<boolean, boolean | undefined, boolean>;
  legacy_removed_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: DbTime;
}

export interface MigrationAcmeStateTable {
  target: string;
  import_id: string;
  sealed: string;
  certificate_count: ColumnType<number, number | undefined, number>;
  placed_at: Date | null;
}

export type MigrationPhase = "imported" | "moving" | "moved" | "finalized";

export interface MigrationStateTable {
  singleton: Generated<boolean>;
  phase: ColumnType<MigrationPhase, MigrationPhase | undefined, MigrationPhase>;
  job_id: number | null;
  finalized_at: Date | null;
  updated_at: DbTime;
}

export interface MigrationWebhookPathTable {
  pattern: string;
  kind: "deploy" | "github";
  import_id: string | null;
  created_at: DbTime;
}

export type ConsolePathKind = "project" | "environment" | "service" | "deployment" | "server";

export interface MigrationConsolePathTable {
  path: string;
  tail: string | null;
  kind: ConsolePathKind;
  object_id: string;
  import_id: string | null;
  created_at: DbTime;
}

export interface MigrationVolumeArchiveTable {
  id: Generated<string>;
  import_id: string;
  service_id: string;
  volume: string;
  /** bigint comes back as a number (see database.ts). */
  size_bytes: number;
  sha256: string;
  restored_at: Date | null;
}

export interface MigrationVolumeArchivePartTable {
  archive_id: string;
  seq: number;
  bytes: Buffer;
}

declare module "../db/schema.ts" {
  interface Database {
    migration_import: MigrationImportTable;
    migration_record: MigrationRecordTable;
    migration_server_move: MigrationServerMoveTable;
    migration_move: MigrationMoveTable;
    migration_acme_state: MigrationAcmeStateTable;
    migration_state: MigrationStateTable;
    migration_webhook_path: MigrationWebhookPathTable;
    migration_volume_archive: MigrationVolumeArchiveTable;
    migration_volume_archive_part: MigrationVolumeArchivePartTable;
    migration_console_path: MigrationConsolePathTable;
  }
}
