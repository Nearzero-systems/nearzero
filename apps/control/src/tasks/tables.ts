import type { TaskPlace, TaskRunStatus, TaskShell, TaskTrigger } from "@nearzero/shared";
import type { ColumnType, Generated, Selectable } from "kysely";

/**
 * Types for the task tables of migrations 0500 and 0820 (spec 12). They are added to the control plane's
 * `Database` type here, beside the area that owns them.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;

export interface TaskTable {
  id: Generated<string>;
  workspace_id: string | null;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  place: TaskPlace;
  service_id: string | null;
  inner_service: string | null;
  server_id: string | null;
  shell: TaskShell;
  cron: string;
  time_zone: string;
  script: string;
  enabled: ColumnType<boolean, boolean | undefined, boolean>;
  next_run_at: Date | null;
  created_by: string | null;
  /** The instance administrator a host task belongs to (0820, R3-29); null elsewhere. */
  owner_id: ColumnType<string | null, string | null | undefined, string | null>;
  created_via: ColumnType<
    "console" | "agent",
    "console" | "agent" | undefined,
    "console" | "agent"
  >;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface TaskRunTable {
  id: Generated<string>;
  task_id: string;
  status: ColumnType<TaskRunStatus, TaskRunStatus | undefined, TaskRunStatus>;
  trigger: TaskTrigger;
  requested_by: string | null;
  due_at: Date | null;
  exit_code: number | null;
  error: string | null;
  log: ColumnType<string, string | undefined, string>;
  log_lines: ColumnType<number, number | undefined, number>;
  log_truncated: ColumnType<boolean, boolean | undefined, boolean>;
  stop_requested_at: Date | null;
  job_id: number | null;
  started_at: DbTime;
  finished_at: Date | null;
  updated_at: DbTime;
}

export type TaskRow = Selectable<TaskTable>;
export type TaskRunRow = Selectable<TaskRunTable>;

declare module "../db/schema.ts" {
  interface Database {
    task: TaskTable;
    task_run: TaskRunTable;
  }
}
