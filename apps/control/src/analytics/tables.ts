import type { ColumnType } from "kysely";

/** Types for migration 0501 (spec 13), added to the control plane's `Database` type. */

export interface AnalyticsSettingTable {
  id: ColumnType<boolean, boolean | undefined, never>;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  cleanup_cron: ColumnType<string, string | undefined, string>;
  next_cleanup_at: Date | null;
  last_cleanup_at: Date | null;
  last_cleanup_error: string | null;
  changed_by: string | null;
  changed_at: Date | null;
  applied_at: Date | null;
  apply_error: string | null;
}

declare module "../db/schema.ts" {
  interface Database {
    analytics_setting: AnalyticsSettingTable;
  }
}
