import type { ChannelType } from "@nearzero/shared";
import type { ColumnType, Generated, Selectable } from "kysely";

/** Types for migration 0503 (spec 15), added to the control plane's `Database` type. */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;

export interface NotificationChannelTable {
  id: Generated<string>;
  workspace_id: string;
  name: string;
  type: ChannelType;
  /** JSON; written as a JSON string. */
  settings: ColumnType<Record<string, unknown>, string, string>;
  secrets_sealed: string | null;
  events: ColumnType<string[], string[] | undefined, string[]>;
  last_delivery_at: Date | null;
  last_failure_at: Date | null;
  last_failure: string | null;
  /** Whether it may send to private and internal addresses (an instance administrator saved it). */
  internal_allowed: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface NotificationDeliveryTable {
  id: Generated<number>;
  outbox_id: number;
  channel_id: string;
  status: ColumnType<
    "pending" | "sent" | "failed",
    "pending" | "sent" | "failed" | undefined,
    "pending" | "sent" | "failed"
  >;
  attempts: ColumnType<number, number | undefined, number>;
  next_attempt_at: DbTime;
  locked_until: Date | null;
  last_error: string | null;
  sent_at: Date | null;
  created_at: DbTime;
}

export interface ControlPlaneStartTable {
  id: Generated<number>;
  version: string;
  started_at: DbTime;
  stopped_at: Date | null;
}

export type ChannelRow = Selectable<NotificationChannelTable>;

declare module "../db/schema.ts" {
  interface Database {
    notification_channel: NotificationChannelTable;
    notification_delivery: NotificationDeliveryTable;
    control_plane_start: ControlPlaneStartTable;
  }
}
