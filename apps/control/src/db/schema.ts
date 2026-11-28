import type { ColumnType, Generated } from "kysely";

/**
 * Types for the tables the control plane reads and writes. They mirror the hand-written SQL in
 * `apps/control/migrations`; when a migration changes a table, change its type here too.
 */
export interface Database {
  applied_migration: AppliedMigrationTable;
  job: JobTable;
  person: PersonTable;
  person_avatar_image: PersonAvatarImageTable;
  person_session: PersonSessionTable;
  two_factor: TwoFactorTable;
  two_factor_backup_code: TwoFactorBackupCodeTable;
  sign_in_challenge: SignInChallengeTable;
  email_confirmation: EmailConfirmationTable;
  attempt_record: AttemptRecordTable;
  workspace: WorkspaceTable;
  workspace_old_slug: WorkspaceOldSlugTable;
  install_state: InstallStateTable;
  membership: MembershipTable;
  access_policy: AccessPolicyTable;
  member_access: MemberAccessTable;
  access_scope_item: AccessScopeItemTable;
  policy_attachment: PolicyAttachmentTable;
  invitation: InvitationTable;
  invitation_policy: InvitationPolicyTable;
  workspace_settings: WorkspaceSettingsTable;
  workspace_secret: WorkspaceSecretTable;
  workspace_email: WorkspaceEmailTable;
  audit_event: AuditEventTable;
  project: ProjectTable;
  environment: EnvironmentTable;
  service: ServiceTable;
  variable_set: VariableSetTable;
  delete_run: DeleteRunTable;
  delete_run_item: DeleteRunItemTable;
  // Servers, SSH keys, runners and routes (0150–0152).
  ssh_key: SshKeyTable;
  server: ServerTable;
  host_allowed_workspace: HostAllowedWorkspaceTable;
  runner: RunnerTable;
  runner_join_token: RunnerJoinTokenTable;
  server_metric: ServerMetricTable;
  router_route: RouterRouteTable;
  // Deployments, their logs, deploy webhooks and uploads (0200).
  deployment: DeploymentTable;
  deployment_log: DeploymentLogTable;
  deploy_webhook: DeployWebhookTable;
  source_upload: SourceUploadTable;
  source_upload_part: SourceUploadPartTable;
}

/** One row per migration file that has been applied. Created by the migration runner itself. */
export interface AppliedMigrationTable {
  version: number;
  name: string;
  checksum: string;
  applied_at: Generated<Date>;
}

export const JOB_STATES = ["queued", "running", "succeeded", "failed"] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Timestamps the database sets itself; writes pass SQL like now(). */
type DbTime = ColumnType<Date, Date | undefined, Date>;

export interface JobTable {
  id: Generated<number>;
  kind: string;
  /** JSON. Written as a JSON string so arrays and objects are stored exactly. */
  payload: ColumnType<unknown, string, string>;
  state: ColumnType<JobState, JobState | undefined, JobState>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  run_at: DbTime;
  idempotency_key: string | null;
  locked_by: string | null;
  locked_until: Date | null;
  last_error: string | null;
  created_at: DbTime;
  updated_at: DbTime;
  started_at: Date | null;
  finished_at: Date | null;
}

export type OnboardingStep = "workspace" | "invite" | "name";

/** A uuid primary key the database fills in. */
type GeneratedId = Generated<string>;

export type RoleColumn = "owner" | "admin" | "member";

export interface PersonTable {
  id: GeneratedId;
  email: string;
  email_verified_at: Date | null;
  password_hash: string | null;
  password_changed_at: Date | null;
  first_name: string | null;
  last_name: string | null;
  avatar_kind: ColumnType<"initials" | "image" | "gravatar", string | undefined, string>;
  avatar_color: ColumnType<string, string | undefined, string>;
  last_workspace_id: string | null;
  onboarding_step: OnboardingStep | null;
  onboarding_completed_at: Date | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface PersonAvatarImageTable {
  person_id: string;
  content_type: string;
  bytes: Buffer;
  updated_at: DbTime;
}

export interface PersonSessionTable {
  id: GeneratedId;
  person_id: string;
  token_hash: Buffer;
  active_workspace_id: string | null;
  client_address: string | null;
  user_agent: string | null;
  created_at: DbTime;
  last_used_at: DbTime;
  expires_at: Date;
}

export interface TwoFactorTable {
  person_id: string;
  secret_sealed: string;
  issuer: ColumnType<string, string | undefined, string>;
  enabled_at: Date | null;
  last_used_step: number | null;
  created_at: DbTime;
}

export interface TwoFactorBackupCodeTable {
  id: Generated<number>;
  person_id: string;
  code_hash: Buffer;
  used_at: Date | null;
  created_at: DbTime;
}

/** A link that proves an email address (0701, spec 04 4.6): one per account at a time. */
export interface EmailConfirmationTable {
  person_id: string;
  email: string;
  token_hash: Buffer;
  created_at: DbTime;
  expires_at: Date;
}

export interface SignInChallengeTable {
  id: GeneratedId;
  person_id: string;
  token_hash: Buffer;
  client_address: string | null;
  window_started_at: Date | null;
  attempts_in_window: Generated<number>;
  created_at: DbTime;
  expires_at: Date;
  consumed_at: Date | null;
}

export interface AttemptRecordTable {
  id: Generated<number>;
  bucket: string;
  subject: string;
  attempted_at: DbTime;
}

export interface WorkspaceTable {
  id: GeneratedId;
  name: string;
  slug: string;
  logo_url: string | null;
  is_personal: Generated<boolean>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface WorkspaceOldSlugTable {
  slug: string;
  workspace_id: string;
  retired_at: DbTime;
}

export interface InstallStateTable {
  singleton: Generated<boolean>;
  first_workspace_id: string;
  owner_created_at: DbTime;
}

export interface MembershipTable {
  workspace_id: string;
  person_id: string;
  role: RoleColumn;
  created_at: DbTime;
}

export interface AccessPolicyTable {
  id: GeneratedId;
  workspace_id: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  capabilities: ColumnType<string[], string[] | undefined, string[]>;
  all_projects: Generated<boolean>;
  all_servers: Generated<boolean>;
  all_git_accounts: Generated<boolean>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface MemberAccessTable {
  workspace_id: string;
  person_id: string;
  capabilities: ColumnType<string[], string[] | undefined, string[]>;
  all_projects: Generated<boolean>;
  all_servers: Generated<boolean>;
  all_git_accounts: Generated<boolean>;
  updated_by: string | null;
  updated_at: DbTime;
}

export type ScopeKindColumn = "project" | "environment" | "service" | "server" | "git_account";

export interface AccessScopeItemTable {
  id: Generated<number>;
  workspace_id: string;
  policy_id: string | null;
  person_id: string | null;
  object_kind: ScopeKindColumn;
  object_id: string;
  parent_id: string | null;
}

export interface PolicyAttachmentTable {
  policy_id: string;
  workspace_id: string;
  person_id: string;
  attached_by: string | null;
  created_at: DbTime;
}

export type InvitationStatus = "pending" | "accepted" | "declined" | "cancelled";

export interface InvitationTable {
  id: GeneratedId;
  workspace_id: string;
  email: string;
  role: "admin" | "member";
  token_hash: Buffer;
  token_sealed: string;
  invited_by: string | null;
  created_at: DbTime;
  expires_at: Date;
  last_emailed_at: Date | null;
  status: ColumnType<InvitationStatus, InvitationStatus | undefined, InvitationStatus>;
  closed_at: Date | null;
  accepted_by: string | null;
}

export interface InvitationPolicyTable {
  invitation_id: string;
  policy_id: string;
  workspace_id: string;
}

export interface WorkspaceSettingsTable {
  workspace_id: string;
  /** JSON object of switches; null means the defaults. */
  agent_policies: ColumnType<unknown, string | null, string | null>;
  agent_policies_saved_by: string | null;
  agent_policies_saved_at: Date | null;
  updated_at: DbTime;
}

export type WorkspaceSecretKind =
  | "model-key"
  | "research-key"
  | "email-resend-key"
  | "email-smtp-password";

export interface WorkspaceSecretTable {
  workspace_id: string;
  kind: WorkspaceSecretKind;
  sealed: string;
  masked: string;
  added_by: string | null;
  added_at: DbTime;
}

export interface WorkspaceEmailTable {
  workspace_id: string;
  provider: "resend" | "smtp";
  sender: string;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: "tls" | "starttls" | "none" | null;
  smtp_username: string | null;
  /** An instance administrator saved it, so it may be a private or internal address (0941). */
  internal_allowed: ColumnType<boolean, boolean | undefined, boolean>;
  saved_by: string | null;
  saved_at: DbTime;
}

export type AuditActorKind = "person" | "agent" | "command" | "system";

export interface AuditEventTable {
  id: Generated<number>;
  occurred_at: DbTime;
  workspace_id: string | null;
  actor_kind: AuditActorKind;
  actor_person_id: string | null;
  actor_label: string | null;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  client_address: string | null;
  details: ColumnType<unknown, string | undefined, string>;
}

// ---- Projects, environments, services and variables (0100, 0101)

export interface ProjectTable {
  id: GeneratedId;
  workspace_id: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface EnvironmentTable {
  id: GeneratedId;
  workspace_id: string;
  project_id: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  is_default: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export type ServiceKindColumn =
  | "application"
  | "compose"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "libsql";

export type ServiceStatusColumn = "idle" | "deploying" | "running" | "stopped" | "failed";

export interface ServiceTable {
  id: GeneratedId;
  workspace_id: string;
  project_id: string;
  environment_id: string;
  copy_group_id: string | null;
  kind: ServiceKindColumn;
  name: string;
  app_name_base: string;
  app_name: string;
  description: ColumnType<string, string | undefined, string>;
  /** Null is the Nearzero host. */
  server_id: string | null;
  status: ColumnType<ServiceStatusColumn, ServiceStatusColumn | undefined, ServiceStatusColumn>;
  /** JSON object; written as a JSON string. */
  settings: ColumnType<Record<string, unknown>, string, string>;
  secrets_sealed: string | null;
  public_port: number | null;
  public_port_note: string | null;
  deleting_run_id: string | null;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface VariableSetTable {
  id: GeneratedId;
  workspace_id: string;
  environment_id: string | null;
  service_id: string | null;
  sealed: string;
  names: string[];
  size_bytes: number;
  version: ColumnType<number, number | undefined, number>;
  updated_by: string | null;
  updated_at: DbTime;
}

export type DeleteRunState = "running" | "succeeded" | "failed";
export type DeleteItemState = "waiting" | "removing" | "removed" | "not_removed";

export interface DeleteRunTable {
  id: GeneratedId;
  workspace_id: string;
  scope: "project" | "services";
  project_id: string;
  project_name: string;
  state: ColumnType<DeleteRunState, DeleteRunState | undefined, DeleteRunState>;
  fingerprint: string | null;
  job_id: number | null;
  requested_by: string | null;
  created_at: DbTime;
  finished_at: Date | null;
}

export interface DeleteRunItemTable {
  run_id: string;
  position: number;
  service_id: string;
  environment_id: string;
  environment_name: string;
  service_name: string;
  kind: ServiceKindColumn;
  app_name: string;
  server_id: string | null;
  production: boolean;
  stop_first: boolean;
  state: ColumnType<DeleteItemState, DeleteItemState | undefined, DeleteItemState>;
  reason: string | null;
}

// ---- Servers, SSH keys, runners and routes (0150, 0151, 0152)

export interface SshKeyTable {
  id: GeneratedId;
  workspace_id: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  key_type: "rsa" | "ed25519";
  public_key: string;
  fingerprint: string;
  private_key_sealed: string;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export type ServerSetupState = "not_started" | "running" | "ready" | "failed";

export interface ServerTable {
  id: GeneratedId;
  workspace_id: string;
  name: string;
  description: ColumnType<string, string | undefined, string>;
  address: string;
  port: ColumnType<number, number | undefined, number>;
  ssh_user: string;
  ssh_key_id: string;
  label: string;
  host_key_fingerprint: string | null;
  setup_state: ColumnType<ServerSetupState, ServerSetupState | undefined, ServerSetupState>;
  setup_error: string | null;
  setup_started_at: Date | null;
  setup_finished_at: Date | null;
  docker_cleanup: ColumnType<boolean, boolean | undefined, boolean>;
  /** Set by a person; wins over its address for DNS and certificates (spec 10.2, 10.7). */
  public_ipv4: ColumnType<string | null, string | null | undefined, string | null>;
  created_by: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface HostAllowedWorkspaceTable {
  workspace_id: string;
  allowed_by: string | null;
  allowed_at: DbTime;
}

export interface RunnerTable {
  id: GeneratedId;
  /** Null is the Nearzero host. */
  server_id: string | null;
  credential_hash: string | null;
  credential_issued_at: Date | null;
  /** Where the runner reaches the control plane (0940), as it said in its last hello. */
  link_url: string | null;
  /** What is wrong with that link, for the server's page (0940), or null. */
  link_problem: string | null;
  /**
   * The next link certificate's fingerprint the runner holds, while the pair is being replaced
   * (0942, C4-10), or null.
   */
  link_next: string | null;
  revoked_at: Date | null;
  runner_version: string | null;
  protocol: number | null;
  /** JSON; written as a JSON string. */
  system: ColumnType<unknown, string | null | undefined, string | null>;
  checks: ColumnType<unknown, string | null | undefined, string | null>;
  /** The containers it last reported: id, Docker state and service (JSON string on write). */
  containers: ColumnType<unknown, string | null | undefined, string | null>;
  containers_at: Date | null;
  connected_at: Date | null;
  last_seen_at: Date | null;
  disconnected_at: Date | null;
  refusal: string | null;
  created_at: DbTime;
  updated_at: DbTime;
}

export interface RunnerJoinTokenTable {
  id: GeneratedId;
  server_id: string | null;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
  created_by: string | null;
  created_at: DbTime;
}

export interface ServerMetricTable {
  target: string;
  at: Date;
  cpu_percent: number;
  /** bigint columns come back as strings from node-postgres. */
  memory_used_bytes: ColumnType<string, number, number>;
  memory_total_bytes: ColumnType<string, number, number>;
  disk_used_bytes: ColumnType<string, number, number>;
  disk_total_bytes: ColumnType<string, number, number>;
  uptime_seconds: ColumnType<string, number, number>;
  /** df's "Available" (0845, 30c R3-34); null from older runners. */
  disk_available_bytes: ColumnType<string | null, number | null | undefined, number | null>;
}

export interface RouterRouteTable {
  id: GeneratedId;
  target: string;
  key: string;
  hostnames: string[];
  /** JSON; written as a JSON string. */
  spec: ColumnType<unknown, string, string>;
  written_at: Date | null;
  created_at: DbTime;
  updated_at: DbTime;
}

// ---- Deployments, logs, webhooks and uploads (0200)

export type DeploymentStatusColumn =
  | "queued"
  | "building"
  | "active"
  | "previous"
  | "not_running"
  | "failed"
  | "cancelled"
  | "removed";

export type DeployTriggerColumn =
  | "push"
  | "tag"
  | "webhook"
  | "manual"
  | "agent"
  | "redeploy"
  | "reload";

export interface DeploymentTable {
  id: GeneratedId;
  workspace_id: string;
  service_id: string | null;
  project_id: string | null;
  environment_id: string | null;
  service_kind: ServiceKindColumn;
  service_name: string;
  app_name: string;
  project_name: string;
  environment_name: string;
  /** Null is the Nearzero host. */
  server_id: string | null;
  server_name: string;
  status: ColumnType<
    DeploymentStatusColumn,
    DeploymentStatusColumn | undefined,
    DeploymentStatusColumn
  >;
  trigger: DeployTriggerColumn;
  requested_by: string | null;
  title: ColumnType<string, string | undefined, string>;
  /** JSON; written as a JSON string. */
  source: ColumnType<Record<string, unknown>, string | undefined, string>;
  requested_commit: string | null;
  requested_tag: string | null;
  commit_hash: string | null;
  builder: string | null;
  framework: string | null;
  image: string | null;
  container_name: string | null;
  error: string | null;
  clean_cache: ColumnType<boolean, boolean | undefined, boolean>;
  cancel_requested_at: Date | null;
  job_id: number | null;
  log_bytes: ColumnType<number, number | undefined, number>;
  log_lines: ColumnType<number, number | undefined, number>;
  log_truncated: ColumnType<boolean, boolean | undefined, boolean>;
  /** Whether it builds anything: only builds wait for a server's build limit (G2-05). */
  builds: ColumnType<boolean, boolean | undefined, boolean>;
  /** How the pipeline ended (0768), saved before the record is updated; JSON as a string. */
  pipeline_outcome: ColumnType<Record<string, unknown> | null, string | null | undefined, string>;
  created_at: DbTime;
  started_at: Date | null;
  finished_at: Date | null;
  removed_at: Date | null;
  updated_at: DbTime;
}

export interface DeploymentLogTable {
  deployment_id: string;
  seq: number;
  at: DbTime;
  text: string;
}

export interface DeployWebhookTable {
  id: GeneratedId;
  service_id: string;
  workspace_id: string;
  secret_hash: string;
  token_sealed: string;
  created_by: string | null;
  created_at: DbTime;
  last_called_at: Date | null;
}

export interface SourceUploadTable {
  id: GeneratedId;
  service_id: string;
  workspace_id: string;
  file_name: ColumnType<string, string | undefined, string>;
  /** bigint comes back as a number (see database.ts). */
  size_bytes: number;
  sha256: string;
  complete: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string | null;
  created_at: DbTime;
}

export interface SourceUploadPartTable {
  upload_id: string;
  seq: number;
  bytes: Buffer;
}
