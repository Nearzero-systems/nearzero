import type { ColumnType, Generated } from "kysely";

/**
 * Types for the Git provider tables of migration 0350 (spec 16). They join the control plane's
 * `Database` type here, beside the area that owns them.
 */

type DbTime = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string | undefined, string>;
/** bigint columns come back as strings from node-postgres. */
type BigId = ColumnType<string | null, number | string | null | undefined, number | string | null>;

export type GitProviderKindColumn = "github" | "gitlab" | "bitbucket" | "gitea";

export interface GitProviderTable {
  id: Generated<string>;
  workspace_id: string;
  owner_person_id: string | null;
  kind: GitProviderKindColumn;
  name: string;
  shared: ColumnType<boolean, boolean | undefined, boolean>;
  status: ColumnType<"pending" | "ready", "pending" | "ready" | undefined, "pending" | "ready">;
  settings: Json;
  secrets_sealed: string | null;
  github_app_id: BigId;
  installation_id: BigId;
  account_login: string | null;
  last_error: string | null;
  connected_at: Date | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export type GitFlowPurpose = "github-manifest" | "github-install" | "oauth";

export interface GitProviderFlowTable {
  id: Generated<string>;
  token_hash: string;
  workspace_id: string;
  person_id: string;
  provider_id: string | null;
  purpose: GitFlowPurpose;
  return_to: string | null;
  details: Json;
  expires_at: Date | string;
  used_at: Date | null;
  created_at: DbTime;
}

export interface GitServiceHookTable {
  service_id: string;
  workspace_id: string;
  provider_id: string | null;
  kind: "gitlab" | "bitbucket" | "gitea";
  repository: string;
  secret_sealed: string;
  remote_hook_id: string | null;
  registered_url: string | null;
  status: ColumnType<"registered" | "manual", "registered" | "manual" | undefined>;
  message: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface GitPushDeliveryTable {
  provider_id: string;
  delivery_id: string;
  received_at: DbTime;
}

declare module "../db/schema.ts" {
  interface Database {
    git_provider: GitProviderTable;
    git_provider_flow: GitProviderFlowTable;
    git_service_hook: GitServiceHookTable;
    git_push_delivery: GitPushDeliveryTable;
  }
}
