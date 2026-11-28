import type { AlertMetric } from "@nearzero/shared";
import type { ColumnType } from "kysely";

/** Types for migration 0502 (spec 14.3), added to the control plane's `Database` type. */

export interface ServerAlertSettingTable {
  target: string;
  cpu_threshold: number | null;
  memory_threshold: number | null;
  updated_by: string | null;
  updated_at: ColumnType<Date, Date | undefined, Date>;
}

export interface ServerAlertStateTable {
  target: string;
  metric: AlertMetric;
  streak: ColumnType<number, number | undefined, number>;
  fired_at: Date | null;
  dropped_since: ColumnType<boolean, boolean | undefined, boolean>;
  last_value: number | null;
  last_sample_at: Date | null;
}

declare module "../db/schema.ts" {
  interface Database {
    server_alert_setting: ServerAlertSettingTable;
    server_alert_state: ServerAlertStateTable;
  }
}
