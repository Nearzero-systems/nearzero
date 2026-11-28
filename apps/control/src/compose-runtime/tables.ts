import type { ColumnType } from "kysely";

/**
 * The table of migration 0450 (spec 07), added to the control plane's `Database` type beside the
 * area that owns it.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;

export interface ComposeStackTable {
  service_id: string;
  deployment_id: string | null;
  source_fingerprint: string | null;
  compose_file: string | null;
  additions_file: string | null;
  project_directory: ColumnType<string, string | undefined, string>;
  deployed_at: Date | null;
  approved_keys: ColumnType<string[], string[] | undefined, string[]>;
  approved_by: string | null;
  approved_at: Date | null;
  created_at: DbTime;
  updated_at: DbTime;
}

declare module "../db/schema.ts" {
  interface Database {
    compose_stack: ComposeStackTable;
  }
}
