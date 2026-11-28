import type { ColumnType, Generated } from "kysely";

/**
 * Types for the Agent's tables of migration 0550 (spec 19). They join the control plane's
 * `Database` type here, beside the area that owns them.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | undefined, string>;
type BigCount = ColumnType<number, number | undefined, number>;

export type TurnStateColumn = "working" | "waiting" | "finished" | "stopped" | "failed";

export interface AgentSessionTable {
  id: Generated<string>;
  workspace_id: string;
  author_id: string;
  title: string | null;
  title_source: "provisional" | "generated" | "person" | null;
  shared: ColumnType<boolean, boolean | undefined, boolean>;
  position: ColumnType<number, number | undefined, number>;
  last_message_at: Date | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface AgentMessageTable {
  id: Generated<string>;
  session_id: string;
  author_id: string | null;
  text: ColumnType<string, string | undefined, string>;
  quote: string | null;
  file_ids: ColumnType<string[], string[] | undefined, string[]>;
  created_at: DbTime;
}

export interface AgentTurnTable {
  id: Generated<string>;
  session_id: string;
  workspace_id: string;
  person_id: string | null;
  message_id: string;
  state: ColumnType<TurnStateColumn, TurnStateColumn | undefined, TurnStateColumn>;
  deep_research: ColumnType<boolean, boolean | undefined, boolean>;
  owner: string | null;
  heartbeat_at: Date | null;
  stop_requested_at: Date | null;
  stopped_by: "person" | "restart" | null;
  wait: ColumnType<unknown, string | null | undefined, string | null>;
  rounds: BigCount;
  steps: BigCount;
  failed_steps: BigCount;
  deploys: Json;
  failures: Json;
  worked_ms: BigCount;
  work_started_at: Date | null;
  answer_text: ColumnType<string, string | undefined, string>;
  hidden: ColumnType<boolean, boolean | undefined, boolean>;
  created_at: DbTime;
  finished_at: Date | null;
  closed_at: Date | null;
}

export interface AgentEventTable {
  turn_id: string;
  seq: number;
  type: string;
  data: Json;
  created_at: DbTime;
}

export interface AgentModelItemTable {
  id: Generated<number>;
  session_id: string;
  turn_id: string;
  item: Json;
  created_at: DbTime;
}

export type AgentFileKindColumn = "image" | "pdf" | "docx" | "text" | "video";

export interface AgentFileTable {
  id: Generated<string>;
  workspace_id: string;
  uploader_id: string;
  session_id: string | null;
  message_id: string | null;
  name: string;
  kind: AgentFileKindColumn;
  content_type: string;
  size_bytes: number;
  bytes: ColumnType<Uint8Array, Uint8Array, Uint8Array>;
  text_content: string | null;
  pages: ColumnType<unknown, string | null | undefined, string | null>;
  sent_at: Date | null;
  created_at: DbTime;
}

export interface AgentSessionKeyTable {
  session_id: string;
  ssh_key_id: string;
  created_at: DbTime;
}

declare module "../db/schema.ts" {
  interface Database {
    agent_session: AgentSessionTable;
    agent_message: AgentMessageTable;
    agent_turn: AgentTurnTable;
    agent_event: AgentEventTable;
    agent_model_item: AgentModelItemTable;
    agent_file: AgentFileTable;
    agent_session_key: AgentSessionKeyTable;
  }
}
