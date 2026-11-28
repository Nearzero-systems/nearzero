import {
  AGENT_POLICIES,
  type AgentPolicy,
  CAPABILITIES,
  type Capability,
  type ChannelType,
  type NotificationEvent,
  type ServiceKind,
} from "@nearzero/shared";

/**
 * The bundle's label vocabularies (spec 29a.6) and what each label is in 1.0. A label the tables
 * don't hold is unknown: the importer reports it and uses 1.0's default (29a.1).
 */

function table<T>(entries: Record<string, T>): (label: string | null | undefined) => T | null {
  const map = new Map(
    Object.entries(entries).map(([label, value]) => [label.toLowerCase(), value]),
  );
  return (label) => (label ? (map.get(label.trim().toLowerCase()) ?? null) : null);
}

/** A 1.0 label without the explanation in brackets: "Import from Git (needs …)" → "Import from Git". */
function bare(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function byLabel<K extends string>(
  catalog: Record<K, { label: string }>,
): (name: string) => K | null {
  const entries: Record<string, K> = {};
  for (const key of Object.keys(catalog) as K[]) {
    entries[key] = key;
    entries[catalog[key].label] = key;
    entries[bare(catalog[key].label)] = key;
  }
  const find = table(entries);
  return (name) => find(name);
}

/** 29a.6.1: Agent policies by the policy names of spec 19.9 (1.0's own keys work too). */
export const agentPolicyNamed: (name: string) => AgentPolicy | null = byLabel(AGENT_POLICIES);

/** 29a.6.2: capabilities by the catalog labels of spec 4.7 (1.0's own keys work too). */
export const capabilityNamed: (name: string) => Capability | null = byLabel(CAPABILITIES);

/** 29a.6.3 */
export const roleNamed = table<"owner" | "admin" | "member">({
  Owner: "owner",
  Admin: "admin",
  Member: "member",
});

/** 29a.6.4: service kinds, also the database types of Compose database backups. */
export const serviceKindNamed = table<ServiceKind>({
  Application: "application",
  Compose: "compose",
  Postgres: "postgres",
  MySQL: "mysql",
  MariaDB: "mariadb",
  MongoDB: "mongodb",
  Redis: "redis",
  libSQL: "libsql",
});

/** 29a.6.5 */
export type SourceType =
  | "github"
  | "gitlab"
  | "gitea"
  | "bitbucket"
  | "git"
  | "image"
  | "upload"
  | "raw";
export const sourceTypeNamed = table<SourceType>({
  GitHub: "github",
  GitLab: "gitlab",
  Gitea: "gitea",
  Bitbucket: "bitbucket",
  "Git URL": "git",
  "Container image": "image",
  "Uploaded archive": "upload",
  "Pasted Compose file": "raw",
});

/** 29a.6.6 */
export const mountTypeNamed = table<"volume" | "bind" | "file">({
  Volume: "volume",
  "Host folder": "bind",
  File: "file",
});

/** 29a.6.7 */
export const gitProviderKindNamed = table<"github" | "gitlab" | "gitea" | "bitbucket">({
  GitHub: "github",
  GitLab: "gitlab",
  Gitea: "gitea",
  Bitbucket: "bitbucket",
});

/** 29a.6.8 */
export const builderNamed = table<
  "dockerfile" | "nixpacks" | "railpack" | "heroku" | "paketo" | "static" | "automatic"
>({
  Dockerfile: "dockerfile",
  Nixpacks: "nixpacks",
  Railpack: "railpack",
  "Heroku buildpacks": "heroku",
  "Paketo buildpacks": "paketo",
  "Static site": "static",
  Automatic: "automatic",
});

/** 29a.6.9 */
export const hostnameSourceNamed = table<"platform" | "server" | "zone" | "own">({
  "Platform domain": "platform",
  "Server wildcard": "server",
  "Managed DNS zone": "zone",
  "Own domain": "own",
});
export const hostnameDefaultNamed = table<"platform" | "zone" | "none">({
  "Platform domain": "platform",
  "Managed DNS zone": "zone",
  None: "none",
});

/** 29a.6.11: channel kinds, and each kind's setting and secret labels to 1.0 field keys. */
export const channelKindNamed = table<ChannelType>({
  Slack: "slack",
  Telegram: "telegram",
  Discord: "discord",
  "Email (SMTP)": "email",
  "Email (Resend)": "resend",
  Gotify: "gotify",
  ntfy: "ntfy",
  Mattermost: "mattermost",
  Pushover: "pushover",
  Webhook: "webhook",
  Lark: "lark",
  "Microsoft Teams": "teams",
});

export const CHANNEL_FIELDS: Record<ChannelType, Record<string, string>> = {
  slack: { Channel: "channel", "Webhook URL": "webhookUrl" },
  telegram: { "Chat ID": "chatId", "Topic thread ID": "threadId", "Bot token": "botToken" },
  discord: { "Rich formatting": "decoration", "Webhook URL": "webhookUrl" },
  email: {
    "SMTP server": "host",
    "SMTP port": "port",
    Username: "username",
    From: "from",
    To: "to",
    Password: "password",
  },
  resend: { From: "from", To: "to", "API key": "apiKey" },
  gotify: {
    "Server URL": "serverUrl",
    Priority: "priority",
    "Rich formatting": "decoration",
    "App token": "appToken",
  },
  ntfy: {
    "Server URL": "serverUrl",
    Topic: "topic",
    Priority: "priority",
    "Access token": "accessToken",
  },
  mattermost: { Channel: "channel", Username: "username", "Webhook URL": "webhookUrl" },
  pushover: {
    Priority: "priority",
    "Retry seconds": "retry",
    "Expire seconds": "expire",
    "User key": "userKey",
    "API token": "apiToken",
  },
  webhook: { URL: "url", Headers: "headers" },
  lark: { "Webhook URL": "webhookUrl" },
  teams: { "Webhook URL": "webhookUrl" },
};

/** 29a.6.12: "Nearzero backup" has no 1.0 event (spec 27). */
export const eventNamed = table<NotificationEvent>({
  "Deployment succeeded": "deploy.succeeded",
  "Deployment failed": "deploy.failed",
  "Database backup": "backup.database",
  "Volume backup": "backup.volume",
  "Nearzero restarted": "nearzero.restart",
  "Server cleanup": "server.docker-cleanup",
  "Server over its alert threshold": "server.alert",
});

/** 29a.6.14: history only; the move makes the deployment that runs on 1.0. */
export const deploymentStatusNamed = table<"previous" | "failed" | "cancelled">({
  Running: "previous",
  Succeeded: "previous",
  Failed: "failed",
  Cancelled: "cancelled",
});

/** 29a.6.15: triggers 1.0 doesn't have are recorded as manual. */
export const deploymentTriggerNamed = table<"manual" | "push" | "agent" | "webhook">({
  Manual: "manual",
  Push: "push",
  Tag: "push",
  Agent: "agent",
  Redeploy: "manual",
  Preview: "manual",
  Rollback: "manual",
  Webhook: "webhook",
});

/** 29a.6.16 */
export const dataModeNamed = table<"local" | "external">({
  "Bundled database": "local",
  "External database": "external",
});
export const registrationModeNamed = table<"invite" | "open">({
  "Invitations only": "invite",
  "Open sign-up": "open",
});
