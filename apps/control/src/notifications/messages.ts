import {
  ALERT_METRIC_LABELS,
  type AlertMetric,
  alertSentence,
  formatBytes,
  HOST_SERVER_ID,
  type NotificationEvent,
  SERVICE_KIND_LABELS,
  type ServiceKind,
} from "@nearzero/shared";

/**
 * What each event says (spec 15.3), in one shape every channel type formats its own way. Only
 * names, results, addresses and links: never secrets or variable values. The deploy failure line
 * is the engine's own message, cut to one line.
 */

export type MessageTone = "success" | "failure" | "warning" | "info";

export interface NotificationMessage {
  event: NotificationEvent | "test";
  title: string;
  summary: string;
  facts: { label: string; value: string }[];
  link: { label: string; url: string } | null;
  tone: MessageTone;
  /** The event's own fields (names and results only), for custom webhooks. */
  data?: Record<string, unknown>;
  /** A deploy's log in the console, when the console has a public address. */
  logUrl?: string | null;
  /**
   * When what it reports happened, as an ISO time: a deploy's or a backup's end, a cleanup's
   * run, a restart, an alert's sample (R3-35, R3-38). Every channel shows it.
   */
  at?: string;
}

/** An ISO time in words every channel shows the same: "2026-11-27 14:05:09 UTC". */
export function utcText(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`;
}

export interface MessageContext {
  /** The console's public address, or null when it has none. */
  consoleUrl: string | null;
  /** The workspace's address part, for links into the console. */
  workspaceSlug: string | null;
  /** When the event was recorded: the time a message falls back to when its event names none. */
  recordedAt?: Date;
}

type Payload = Record<string, unknown>;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function name(value: unknown): string {
  return text((value as { name?: unknown } | null)?.name, "a service");
}

function oneLine(value: string, max = 300): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function consoleLink(context: MessageContext, path: string): string | null {
  if (!context.workspaceSlug) return null;
  const relative = `/${encodeURIComponent(context.workspaceSlug)}/dashboard/${path}`;
  return context.consoleUrl ? `${context.consoleUrl.replace(/\/+$/, "")}${relative}` : null;
}

function sizeText(bytes: unknown): string | null {
  return typeof bytes === "number" && bytes >= 0 ? formatBytes(bytes) : null;
}

/** The first of the payload's times that is a real time, else when the event was recorded. */
function eventTime(payload: Payload, keys: string[], context: MessageContext): string {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value !== "string") continue;
    const time = new Date(value);
    if (!Number.isNaN(time.getTime())) return time.toISOString();
  }
  return (context.recordedAt ?? new Date()).toISOString();
}

/** A deploy's service kind in words: application, Compose, or the database type (R3-38). */
export function serviceKindText(kind: unknown): string | null {
  return typeof kind === "string" && Object.hasOwn(SERVICE_KIND_LABELS, kind)
    ? SERVICE_KIND_LABELS[kind as ServiceKind]
    : null;
}

/** Every message says when its event happened, as its last fact (R3-38). */
function timed(message: NotificationMessage, at: string): NotificationMessage {
  return { ...message, at, facts: [...message.facts, { label: "Time", value: utcText(at) }] };
}

export function buildMessage(
  event: string,
  payload: Payload,
  context: MessageContext,
): NotificationMessage {
  const message = untimedMessage(event, payload, context);
  // A server alert's time is its sample's, already among its facts (R3-35).
  if (event === "server.alert")
    return message.at ? message : timed(message, eventTime({}, [], context));
  const keys: Record<string, string[]> = {
    "deploy.succeeded": ["finishedAt"],
    "deploy.failed": ["finishedAt"],
    "backup.database": ["finishedAt"],
    "backup.volume": ["finishedAt"],
    "server.docker-cleanup": ["ranAt"],
    "nearzero.restart": ["startedAt"],
  };
  return timed(message, eventTime(payload, keys[event] ?? [], context));
}

function untimedMessage(
  event: string,
  payload: Payload,
  context: MessageContext,
): NotificationMessage {
  switch (event) {
    case "deploy.succeeded": {
      const service = name(payload.service);
      const kind = serviceKindText((payload.service as { kind?: unknown } | null)?.kind);
      const facts = [
        { label: "Service", value: service },
        ...(kind ? [{ label: "Type", value: kind }] : []),
        { label: "Project", value: text(payload.project, "—") },
        { label: "Environment", value: text(payload.environment, "—") },
      ];
      const commit = text(payload.commit);
      if (commit) facts.push({ label: "Commit", value: commit.slice(0, 12) });
      const address = text(payload.address);
      if (address) facts.push({ label: "Address", value: address });
      const log = consoleLink(
        context,
        `deployments/${encodeURIComponent(text(payload.deploymentId))}`,
      );
      return {
        event,
        title: `Deployed ${service}`,
        summary: `${service} in ${text(payload.project, "its project")} / ${text(payload.environment, "its environment")} is serving the new version.`,
        facts,
        link: address
          ? { label: "Open the app", url: address }
          : log
            ? { label: "Open the deployment", url: log }
            : null,
        tone: "success",
        logUrl: log,
      };
    }
    case "deploy.failed": {
      const service = name(payload.service);
      const kind = serviceKindText((payload.service as { kind?: unknown } | null)?.kind);
      const failure = oneLine(text(payload.error, "The deploy failed."));
      const log = consoleLink(
        context,
        `deployments/${encodeURIComponent(text(payload.deploymentId))}`,
      );
      return {
        event,
        title: `Deploy failed: ${service}`,
        summary: failure,
        facts: [
          { label: "Service", value: service },
          ...(kind ? [{ label: "Type", value: kind }] : []),
          { label: "Project", value: text(payload.project, "—") },
          { label: "Environment", value: text(payload.environment, "—") },
          { label: "Failure", value: failure },
          ...(log ? [] : [{ label: "Log", value: "Deployments page, in the console" }]),
        ],
        link: log ? { label: "Open the log", url: log } : null,
        tone: "failure",
        logUrl: log,
      };
    }
    case "backup.database":
    case "backup.volume": {
      const service = name(payload.service);
      const ok = payload.result === "succeeded";
      const what = event === "backup.database" ? "Database backup" : "Volume backup";
      // R3-47: where it belongs, and what was copied.
      const facts = [
        { label: "Project", value: text(payload.project, "—") },
        { label: "Environment", value: text(payload.environment, "—") },
        { label: "Service", value: service },
        ...(event === "backup.volume"
          ? [{ label: "Volume", value: text(payload.volume, "—") }]
          : [
              { label: "Database type", value: text(payload.databaseType, "—") },
              { label: "Database", value: text(payload.database, "All databases") },
            ]),
        { label: "Destination", value: text(payload.destination, "—") },
        { label: "Result", value: ok ? "Succeeded" : "Failed" },
      ];
      const size = sizeText(payload.sizeBytes);
      if (ok && size) facts.push({ label: "Size", value: size });
      if (!ok)
        facts.push({ label: "Reason", value: oneLine(text(payload.error, "The backup failed.")) });
      return {
        event,
        title: `${what} ${ok ? "succeeded" : "failed"}: ${service}`,
        summary: ok
          ? `${what} of ${service} to ${text(payload.destination, "its destination")} finished.`
          : oneLine(text(payload.error, `${what} of ${service} failed.`)),
        facts,
        link: null,
        tone: ok ? "success" : "failure",
      };
    }
    case "server.docker-cleanup": {
      const server = text((payload.server as { name?: unknown } | null)?.name, "a server");
      const freed = text(payload.freedText) || sizeText(payload.freedBytes) || "0 B";
      return {
        event,
        title: `Docker cleanup on ${server}`,
        summary: `The daily cleanup on ${server} freed ${freed}.`,
        facts: [
          { label: "Server", value: server },
          { label: "Space freed", value: freed },
        ],
        link: null,
        tone: "info",
      };
    }
    case "server.alert": {
      const server = text((payload.server as { name?: unknown } | null)?.name, "a server");
      const metric = (payload.metric === "memory" ? "memory" : "cpu") as AlertMetric;
      const value = typeof payload.value === "number" ? payload.value : 0;
      const threshold = typeof payload.threshold === "number" ? payload.threshold : 0;
      const test = payload.test === true;
      // The time of the sample that crossed the threshold, on every channel (R3-35).
      const sampled = typeof payload.at === "string" ? new Date(payload.at) : null;
      const at = sampled && !Number.isNaN(sampled.getTime()) ? sampled.toISOString() : null;
      return {
        event,
        title: `${test ? "Test alert" : "Server alert"}: ${server}`,
        summary: test
          ? `This is a test of ${server}'s alerts. Real alerts look like this one.`
          : alertSentence(server, metric, value, threshold),
        facts: [
          { label: "Server", value: server },
          { label: "Metric", value: ALERT_METRIC_LABELS[metric] },
          { label: "Value", value: `${Math.round(value)}%` },
          { label: "Threshold", value: `${threshold}%` },
          ...(at ? [{ label: "Time", value: utcText(at) }] : []),
        ],
        link: null,
        tone: "warning",
        ...(at ? { at } : {}),
      };
    }
    case "nearzero.restart": {
      const version = text(payload.version, "unknown");
      const crashed = payload.after === "crash";
      return {
        event,
        title: "Nearzero restarted",
        summary: `Nearzero ${version} started again after ${crashed ? "an unexpected stop" : "a stop"}.`,
        facts: [
          { label: "Version", value: version },
          {
            label: "Previous stop",
            value: crashed ? "Unexpected (a crash or a power loss)" : "Clean",
          },
        ],
        link: null,
        tone: crashed ? "warning" : "info",
      };
    }
    default:
      return {
        event: "test",
        title: "Nearzero",
        summary: `Event ${oneLine(event, 64)}.`,
        facts: [],
        link: null,
        tone: "info",
      };
  }
}

/** A service kind under its 0.1.x name, which a moved webhook receiver compares with (R3-37). */
export function legacyServiceKind(kind: unknown, fallback = ""): string {
  const value = text(kind, fallback);
  return value === "mongodb" ? "mongo" : value;
}

/**
 * The fixed title and sentence 0.1.x's custom webhook body had for each event (R4-14, spec 15.4).
 * A receiver that sorts on `title == "Build Error"` keeps matching after the move.
 */
export const LEGACY_WEBHOOK_TEXT = {
  buildSuccess: { title: "Build Success", message: "Build completed successfully" },
  buildError: { title: "Build Error", message: "Build failed with errors" },
  databaseBackupSuccess: {
    title: "Database Backup Successful",
    message: "Database backup completed successfully",
  },
  databaseBackupError: { title: "Database Backup Failed", message: "Database backup failed" },
  volumeBackupSuccess: {
    title: "Volume Backup Successful",
    message: "Volume backup completed successfully",
  },
  volumeBackupError: { title: "Volume Backup Failed", message: "Volume backup failed" },
  dockerCleanup: { title: "Docker Cleanup", message: "Docker cleanup completed successfully" },
  restart: { title: "Nearzero Server Restarted", message: "Nearzero server restarted" },
  cpuAlert: { title: "Server CPU Alert", message: "Server CPU usage is above its threshold" },
  memoryAlert: {
    title: "Server Memory Alert",
    message: "Server memory usage is above its threshold",
  },
} as const;

/**
 * The fields a custom webhook moved from 0.1.x reads (R3-37, R4-14, spec 15.4): the flat shape
 * 0.1.x posted, beside 1.0's own. `title` and `message` are 0.1.x's fixed texts (1.0's own title
 * and summary are `headline` and `summary`); `status` is "success", "error" or "alert"; `type`
 * names the event the way 0.1.x did ("build", "docker-cleanup", "nearzero-restart", and for
 * backups the result, the same as `status`; for an alert the metric); `timestamp` is when the
 * event happened (a server alert: its sample), as ISO, and `date` the same instant in the
 * control plane's own local format. Names, results and links only, never secrets.
 */
export function legacyWebhookFields(message: NotificationMessage): Record<string, unknown> {
  const data = (message.data ?? {}) as Payload;
  const service = (data.service ?? {}) as { name?: unknown; kind?: unknown };
  const parsed = message.at ? new Date(message.at) : null;
  const at = parsed && !Number.isNaN(parsed.getTime()) ? parsed : new Date();
  const time = { timestamp: at.toISOString(), date: at.toLocaleString() };
  const fixed = (texts: { title: string; message: string }) => ({ ...texts, ...time });
  switch (message.event) {
    case "deploy.succeeded":
    case "deploy.failed": {
      const failed = message.event === "deploy.failed";
      const hostnames = Array.isArray(data.hostnames)
        ? data.hostnames.filter((host): host is string => typeof host === "string" && host !== "")
        : [];
      return {
        ...fixed(failed ? LEGACY_WEBHOOK_TEXT.buildError : LEGACY_WEBHOOK_TEXT.buildSuccess),
        status: failed ? "error" : "success",
        type: "build",
        projectName: text(data.project),
        environmentName: text(data.environment),
        applicationName: text(service.name),
        applicationType: legacyServiceKind(service.kind, "application"),
        buildLink: message.logUrl ?? null,
        ...(failed
          ? { errorMessage: oneLine(text(data.error, "The deploy failed.")) }
          : { domains: hostnames.join(", ") }),
      };
    }
    case "backup.database":
    case "backup.volume": {
      const ok = data.result === "succeeded";
      const database = message.event === "backup.database";
      const status = ok ? "success" : "error";
      const texts = database
        ? ok
          ? LEGACY_WEBHOOK_TEXT.databaseBackupSuccess
          : LEGACY_WEBHOOK_TEXT.databaseBackupError
        : ok
          ? LEGACY_WEBHOOK_TEXT.volumeBackupSuccess
          : LEGACY_WEBHOOK_TEXT.volumeBackupError;
      const size = ok ? sizeText(data.sizeBytes) : null;
      return {
        ...fixed(texts),
        status,
        type: status,
        projectName: text(data.project),
        environmentName: text(data.environment),
        applicationName: text(service.name),
        databaseType: legacyServiceKind(service.kind),
        ...(database
          ? { databaseName: text(data.database) }
          : { volumeName: text(data.volume), serviceType: legacyServiceKind(service.kind) }),
        ...(size ? { backupSize: size } : {}),
        errorMessage: ok ? "" : oneLine(text(data.error, "The backup failed.")),
      };
    }
    case "server.docker-cleanup": {
      const server = (data.server ?? {}) as { id?: unknown; name?: unknown };
      const id = text(server.id);
      return {
        ...fixed(LEGACY_WEBHOOK_TEXT.dockerCleanup),
        status: "success",
        type: "docker-cleanup",
        serverName: text(server.name),
        cleanupMessage:
          id === HOST_SERVER_ID || id === ""
            ? "Docker cleanup for nearzero"
            : `Docker cleanup for Server ${text(server.name)} (${id})`,
      };
    }
    case "server.alert": {
      const memory = data.metric === "memory";
      return {
        ...fixed(memory ? LEGACY_WEBHOOK_TEXT.memoryAlert : LEGACY_WEBHOOK_TEXT.cpuAlert),
        status: "alert",
        type: memory ? "Memory" : "CPU",
        alertType: "server-threshold",
        serverName: text((data.server as { name?: unknown } | null)?.name),
        currentValue: typeof data.value === "number" ? data.value : null,
        threshold: typeof data.threshold === "number" ? data.threshold : null,
      };
    }
    case "nearzero.restart":
      return { ...fixed(LEGACY_WEBHOOK_TEXT.restart), status: "success", type: "nearzero-restart" };
    default:
      return { title: message.title, message: message.summary, ...time, type: "test" };
  }
}

export function testMessage(channelName: string, at = new Date()): NotificationMessage {
  return timed(
    {
      event: "test",
      title: "Test notification from Nearzero",
      summary: `If you can read this, the channel ${channelName || "you set up"} works.`,
      facts: [],
      link: null,
      tone: "info",
    },
    at.toISOString(),
  );
}

/** Whether the message reports a deploy, whose log the chat channels offer as a button. */
export function isDeployMessage(message: NotificationMessage): boolean {
  return message.event === "deploy.succeeded" || message.event === "deploy.failed";
}

/** The emoji a decorated title starts with (Discord with Decoration on). */
export const TONE_EMOJI: Record<MessageTone, string> = {
  success: "✅",
  failure: "❌",
  warning: "⚠️",
  info: "ℹ️",
};

/** The message as plain text: title, summary, facts, link. */
export function plainText(message: NotificationMessage): string {
  const lines = [message.title, message.summary];
  if (message.facts.length > 0) {
    lines.push("");
    for (const fact of message.facts) lines.push(`${fact.label}: ${fact.value}`);
  }
  if (message.link) lines.push("", `${message.link.label}: ${message.link.url}`);
  return lines.join("\n");
}

/** Markdown (Gotify, Mattermost, Teams' text). */
export function markdown(message: NotificationMessage): string {
  const lines = [`**${message.title}**`, message.summary];
  if (message.facts.length > 0) {
    lines.push("");
    for (const fact of message.facts) lines.push(`- **${fact.label}:** ${fact.value}`);
  }
  if (message.link) lines.push("", `[${message.link.label}](${message.link.url})`);
  return lines.join("\n");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export const TONE_COLORS: Record<MessageTone, number> = {
  success: 0x16a34a,
  failure: 0xdc2626,
  warning: 0xd97706,
  info: 0x7c3aed,
};

/** The same colors as #rrggbb (Slack attachments, the email template). */
export function toneHex(tone: MessageTone): string {
  return `#${TONE_COLORS[tone].toString(16).padStart(6, "0")}`;
}
