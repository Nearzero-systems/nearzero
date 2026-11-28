import type { DatabaseKind } from "./project-rules.ts";

/**
 * Deployments, app sources, builders, ports, mounts and database connections without the request
 * schemas: the words, limits and pure helpers the console, the control plane and the runner
 * share (spec 06, 08 8.1–8.2, 11). Imports nothing heavy, so browser code can use it through
 * "@nearzero/shared/browser"; deploys.ts builds the zod schemas on it.
 */

// ---- Deployments (spec 11.1)

/**
 * Where a deployment is in its life. queued: waiting; building: running; active: the version
 * serving now; previous: an older successful deploy of the same service; not_running: the active
 * version, stopped; removed: the service was deleted.
 */
export const DEPLOYMENT_STATUSES = [
  "queued",
  "building",
  "active",
  "previous",
  "not_running",
  "failed",
  "cancelled",
  "removed",
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const DEPLOYMENT_STATUS_LABELS: Record<DeploymentStatus, string> = {
  queued: "Queued",
  building: "Building",
  active: "Active",
  previous: "Previous version",
  not_running: "Not running",
  failed: "Failed",
  cancelled: "Cancelled",
  removed: "Removed",
};

/** Deployments still in the queue or running: they can be cancelled. */
export function isDeploymentOpen(status: DeploymentStatus): boolean {
  return status === "queued" || status === "building";
}

export const DEPLOY_TRIGGERS = [
  "push",
  "tag",
  "webhook",
  "manual",
  "agent",
  "redeploy",
  "reload",
] as const;
export type DeployTrigger = (typeof DEPLOY_TRIGGERS)[number];

/** What started a deployment, as each deployment row says it (spec 6.3). */
export const DEPLOY_TRIGGER_LABELS: Record<DeployTrigger, string> = {
  manual: "Manual",
  push: "Push",
  tag: "Tag",
  webhook: "Webhook",
  agent: "Agent",
  redeploy: "Redeploy",
  reload: "Reload",
};

/** Each service keeps its newest deployments with their logs; a deleted service's for 30 days. */
export const DEPLOYMENTS_KEPT_PER_SERVICE = 50;
export const REMOVED_DEPLOYMENTS_KEPT_DAYS = 30;

/** The first line of every deployment log (spec 6.5, 23.1). */
export function deployLogFirstLine(version: string): string {
  return `Initializing deployment (Nearzero ${version})`;
}

/** The short form of a commit hash shown in lists. */
export function shortCommit(hash: string | null | undefined): string | null {
  return hash ? hash.slice(0, 7) : null;
}

/**
 * "Failure detected on line N: …" (spec 11.2): the first line of a log that reads like an error,
 * 1-based, or null when none does.
 */
export function firstFailureLine(text: string): { line: number; text: string } | null {
  const lines = text.split("\n");
  const pattern =
    /(^|\b)(error|failed|failure|fatal|exception|panic|traceback|cannot|can't|not found|denied|refused)\b/i;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (line.startsWith("Initializing deployment")) continue;
    if (pattern.test(line)) return { line: index + 1, text: line.trim() };
  }
  return null;
}

// ---- Application sources (spec 6.1, 6.3)

export const APP_SOURCE_TYPES = ["git", "image", "upload"] as const;
export type AppSourceType = (typeof APP_SOURCE_TYPES)[number];

export const GIT_URL_INVALID = "Enter a valid public Git URL (HTTPS or git@host:owner/repo).";
export const GIT_URL_CREDENTIALS =
  "Credentials inside the URL are refused. Use an SSH URL with a deploy key, or connect a Git provider.";

export type GitTransport = "https" | "ssh";

export interface ParsedGitUrl {
  transport: GitTransport;
  host: string;
  /** owner/repo (without .git), for display. */
  path: string;
  /** The URL as git is given it. */
  url: string;
}

const HOST =
  /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const REPO_PATH = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+$/;

/**
 * Reads a repository URL: https://host/owner/repo(.git), git@host:owner/repo(.git) or
 * ssh://git@host[:port]/owner/repo(.git). Credentials in the URL are refused (spec 6.3).
 */
export function parseGitUrl(input: string): ParsedGitUrl | { problem: string } {
  const value = input.trim();
  if (value === "" || value.length > 1000 || /\s/.test(value)) return { problem: GIT_URL_INVALID };
  const scp = /^([A-Za-z0-9][A-Za-z0-9._-]*)@([^:/]+):(?!\/)(.+)$/.exec(value);
  if (scp) {
    const [, , host = "", rest = ""] = scp;
    const path = rest.replace(/\.git$/, "").replace(/\/+$/, "");
    if (!HOST.test(host) || !REPO_PATH.test(path) || path.split("/").includes("..")) {
      return { problem: GIT_URL_INVALID };
    }
    return { transport: "ssh", host: host.toLowerCase(), path, url: value };
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: GIT_URL_INVALID };
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") return { problem: GIT_URL_INVALID };
  if (url.password !== "" || (url.protocol === "https:" && url.username !== "")) {
    return { problem: GIT_URL_CREDENTIALS };
  }
  if (url.search !== "" || url.hash !== "") return { problem: GIT_URL_INVALID };
  const path = decodeURIComponent(url.pathname)
    .replace(/^\/+/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  if (!HOST.test(url.hostname) || !REPO_PATH.test(path) || path.split("/").includes("..")) {
    return { problem: GIT_URL_INVALID };
  }
  return {
    transport: url.protocol === "https:" ? "https" : "ssh",
    host: url.hostname.toLowerCase(),
    path,
    url: url.toString().replace(/\/+$/, ""),
  };
}

/** A branch or tag name git accepts, kept to the safe subset (no option-looking names). */
export function branchProblem(branch: string): string | null {
  if (branch === "") return "Enter a branch.";
  if (
    branch.length > 255 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//")
  ) {
    return "Enter a valid branch name, like main or release/2.0.";
  }
  return null;
}

/**
 * A build path inside the source: "" is its root. Leading and trailing slashes are dropped;
 * "..", "." and empty segments are refused, so a build never leaves its folder.
 */
export function normalizeBuildPath(input: string): string | { problem: string } {
  const trimmed = input.trim().replace(/^\/+|\/+$/g, "");
  if (trimmed === "") return "";
  const parts = trimmed.split("/");
  if (
    trimmed.length > 500 ||
    parts.some((part) => part === "" || part === "." || part === ".." || !/^[^\0\\]+$/.test(part))
  ) {
    return { problem: "Enter a folder inside the repository, like apps/web, or leave it empty." };
  }
  return trimmed;
}

/** Uploads (spec 6.3): one .zip of at most 200 MB. */
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
export const UPLOAD_TOO_LARGE =
  "The archive is larger than 200 MB. Leave out build output and dependencies, then upload it again.";

// ---- Builders (spec 6.4)

export const BUILDER_TYPES = [
  "automatic",
  "dockerfile",
  "railpack",
  "nixpacks",
  "heroku",
  "paketo",
  "static",
] as const;
export type BuilderType = (typeof BUILDER_TYPES)[number];

export const BUILDER_LABELS: Record<BuilderType, string> = {
  automatic: "Automatic",
  dockerfile: "Dockerfile",
  railpack: "Railpack",
  nixpacks: "Nixpacks",
  heroku: "Heroku buildpacks",
  paketo: "Paketo buildpacks",
  static: "Static",
};

/** Railpack versions a builder may pick, newest (the default) first. */
export const RAILPACK_VERSIONS = ["0.43.0", "0.42.0"] as const;
export type RailpackVersion = (typeof RAILPACK_VERSIONS)[number];

/** Heroku's builder stacks, newest (the default) first. */
export const HEROKU_STACKS = ["24", "22"] as const;
export type HerokuStack = (typeof HEROKU_STACKS)[number];

/** Seconds a new container must keep running before it replaces the old one (spec 23.1). */
export const DEFAULT_STABILITY_SECONDS = 10;
export const MAX_STABILITY_SECONDS = 600;
/** Databases get up to this long to start and answer (spec 23.1). */
export const DATABASE_START_SECONDS = 120;

// ---- Ports and mounts (spec 6.8)

export const PORT_PROTOCOLS = ["tcp", "udp"] as const;
export type PortProtocol = (typeof PORT_PROTOCOLS)[number];
export const PORT_MODES = ["routed", "host"] as const;
export type PortMode = (typeof PORT_MODES)[number];

/** Ports the router and Nearzero itself use on every server, and the host's own. */
export const SERVER_RESERVED_PORTS = [22, 80, 443] as const;
export const HOST_RESERVED_PORTS = [53, 3000, 4321] as const;

export function reservedPortMessage(port: number): string {
  return `Port ${port} is used by Nearzero on this server. Pick another.`;
}

export const PORTS_NOTE =
  "Published ports are not needed for web traffic, which reaches the app through its hostnames.";

export const MOUNT_TYPES = ["volume", "bind", "file"] as const;
export type MountType = (typeof MOUNT_TYPES)[number];

/** An absolute path inside a container (or on the server for bind mounts), without "..". */
export function absolutePathProblem(path: string, what: string): string | null {
  if (!path.startsWith("/") || path.length > 1000 || /[\0\n\r]/.test(path)) {
    return `Enter the ${what} as an absolute path, like /data.`;
  }
  if (path.split("/").includes("..")) return `The ${what} can't contain "..".`;
  return null;
}

/** Volume names people choose; the Docker volume is named after the service's app name. */
export function volumeNameProblem(name: string): string | null {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name)) {
    return "Use lowercase letters, numbers, - and _ for the volume name (at most 63).";
  }
  return null;
}

export function dockerVolumeName(appName: string, volume: string): string {
  return `${appName}-${volume}`;
}

// ---- Database connections (spec 8.2)

/** The replica set name a MongoDB with "Use replica set" runs. */
export const MONGO_REPLICA_SET = "rs0";

export interface ConnectionUrlInput {
  kind: DatabaseKind;
  /** null for Redis, whose user is always "default". */
  user: string | null;
  password: string;
  host: string;
  port: number;
  /** Postgres, MySQL and MariaDB. */
  database?: string | null;
  /** MongoDB with a replica set. */
  replicaSet?: boolean;
  /** "internal": from apps on the same server; "public": from anywhere. */
  from: "internal" | "public";
}

/** Percent-encodes a user name or password for the user-info part of a URL (RFC 3986). */
export function encodeUserInfo(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function hostPart(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/**
 * A database's connection URL (spec 8.2), credentials percent-encoded:
 * postgresql://user:pass@host:port/db, mysql://…, mongodb://user:pass@host:port/?authSource=admin
 * (with replicaSet=rs0 inside, directConnection=true from outside), redis://default:pass@host:port
 * and http://user:pass@host:port for libSQL.
 */
export function databaseConnectionUrl(input: ConnectionUrlInput): string {
  const user = encodeUserInfo(input.kind === "redis" ? "default" : (input.user ?? ""));
  const password = encodeUserInfo(input.password);
  const where = `${hostPart(input.host)}:${input.port}`;
  const database = input.database ? `/${encodeURIComponent(input.database)}` : "";
  switch (input.kind) {
    case "postgres":
      return `postgresql://${user}:${password}@${where}${database}`;
    case "mysql":
    case "mariadb":
      return `mysql://${user}:${password}@${where}${database}`;
    case "mongodb": {
      const options = ["authSource=admin"];
      if (input.replicaSet) {
        options.push(
          input.from === "internal" ? `replicaSet=${MONGO_REPLICA_SET}` : "directConnection=true",
        );
      }
      return `mongodb://${user}:${password}@${where}/?${options.join("&")}`;
    }
    case "redis":
      return `redis://${user}:${password}@${where}`;
    case "libsql":
      return `http://${user}:${password}@${where}`;
  }
}

/** The same URL with the password hidden, for display before "Show password". */
export function maskedConnectionUrl(input: ConnectionUrlInput): string {
  return databaseConnectionUrl({ ...input, password: "••••••••" }).replace(
    encodeUserInfo("••••••••"),
    "••••••••",
  );
}

export const CONNECTION_NOT_RUNNING = "Works once the database is deployed and running.";

export function publicPortHint(port: number): string {
  return `If it doesn't connect, allow inbound TCP ${port} in the server's firewall or cloud security group.`;
}

export const PRIVATE_DATABASE_HINT = "Not reachable from outside this server.";

export function unknownAddressHint(port: number): string {
  return `Port ${port} on this database's server. The server's public address isn't known here: use its IP with port ${port}.`;
}

// ---- Deploy webhooks (spec 6.6, 24 G4)

/** Where generic deploy webhooks are called, under the console's address. */
export const DEPLOY_WEBHOOK_PATH = "/api/v1/webhooks/deploy";

export const WEBHOOK_AUTODEPLOY_OFF =
  "Autodeploy is off, so calls to this URL are ignored. Turn Autodeploy on to deploy from your Git host.";
export const WEBHOOK_NONE_YET =
  "This service has no webhook URL yet. Create one to deploy when you push.";
/** An image app's webhook is one its registry calls (30b R2-03, C3-03). */
export const WEBHOOK_NONE_YET_IMAGE =
  "This service has no webhook URL yet. Create one for your registry to call when a new image is pushed.";
export const WEBHOOK_NEEDS_DEPLOY = "You need permission to deploy this service to see its webhook";

// ---- A container's last output in a deploy log (31b G2-01)

/** How much of a crashed container's last output a deploy log keeps. */
export const CRASH_OUTPUT_MAX_LINES = 60;
export const CRASH_OUTPUT_MAX_CHARS = 6_000;
export const OUTPUT_REDACTED = "[redacted]";
export const CREDENTIALS_REDACTED = "[credentials-redacted]";

/** Escape sequences: CSI (colours, cursor moves), OSC (titles, links) and the short ones. */
const ESCAPES =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape codes are control characters.
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u009b[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control characters to remove.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** scheme://user:password@ and scheme://token@ in connection strings. */
const URL_LOGIN = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"`<>]+@/gi;

/**
 * A container's last output, made fit for a deploy log that people without access to the
 * variables can read (spec 23.4, 11.4; 31b G2-01): every value of the service's variables of 4
 * characters or more becomes "[redacted]", logins inside connection strings become
 * "[credentials-redacted]", terminal escape codes and control characters are removed, and only
 * the last 60 lines and 6,000 characters are kept.
 */
export function cleanContainerOutput(text: string, values: Iterable<string>): string {
  let out = text
    .replace(ESCAPES, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(CONTROL, "");
  const secrets = [...new Set([...values].filter((value) => value.length >= 4))].sort(
    (a, b) => b.length - a.length,
  );
  for (const secret of secrets) out = out.split(secret).join(OUTPUT_REDACTED);
  out = out.replace(URL_LOGIN, `$1${CREDENTIALS_REDACTED}@`);
  const lines = out.replace(/\s+$/, "").split("\n");
  let kept = lines.slice(-CRASH_OUTPUT_MAX_LINES).join("\n");
  if (kept.length > CRASH_OUTPUT_MAX_CHARS) {
    kept = kept.slice(kept.length - CRASH_OUTPUT_MAX_CHARS);
    // Start at a whole line when there is one.
    const firstBreak = kept.indexOf("\n");
    if (firstBreak !== -1) kept = kept.slice(firstBreak + 1);
  }
  return kept;
}

/**
 * Watch paths typed in one box, split at commas and line breaks outside braces, so a pattern
 * like `{apps/web,packages/ui}/**` stays whole (31b G2-03).
 */
export function splitWatchPaths(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "{") depth++;
    else if (char === "}" && depth > 0) depth--;
    if (depth === 0 && (char === "," || char === "\n" || char === "\r")) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((item) => item.trim()).filter(Boolean);
}

// ---- Terminals (spec 6.7)

/** A plain GET of a service's terminal, which the console asks to learn why one didn't open. */
export const TERMINAL_NEEDS_WEBSOCKET = "Open the terminal with a WebSocket.";

/**
 * The close code the console's bridge gives a browser's terminal socket when the control plane
 * never opened its side (C3-06), so the page asks why instead of saying the terminal closed.
 */
export const TERMINAL_UPSTREAM_REFUSED = 4001;
