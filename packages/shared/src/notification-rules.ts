/**
 * Notification channels and events (spec 15): the 12 channel types with their fields, the checks
 * each field gets (in the spec's words), which fields are secrets, and the events a channel can
 * subscribe to. Pure and browser-safe: the console renders its forms from these definitions and
 * the control plane checks with the same ones.
 */

export const CHANNEL_TYPES = [
  "slack",
  "telegram",
  "discord",
  "lark",
  "teams",
  "email",
  "resend",
  "gotify",
  "ntfy",
  "mattermost",
  "pushover",
  "webhook",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export type ChannelFieldKind =
  | "url"
  | "text"
  | "secret"
  | "number"
  | "boolean"
  | "email"
  | "emails"
  | "headers";

export interface ChannelField {
  key: string;
  label: string;
  kind: ChannelFieldKind;
  required?: boolean;
  /** Never shown again once saved; blank on edit keeps the saved value. */
  secret?: boolean;
  /** Where the channel sends: changing it requires its secrets again. */
  destination?: boolean;
  /** For numbers. */
  min?: number;
  max?: number;
  defaultValue?: string | number | boolean;
  placeholder?: string;
  hint?: string;
  /** A secret that is a URL (provider webhooks carry their token in the address). */
  secretUrl?: boolean;
  /**
   * A server's address that Nearzero adds paths to (Gotify, ntfy): its trailing "/" is dropped.
   * Every other URL is called exactly as typed, a trailing "/" included (G3-17).
   */
  serverAddress?: boolean;
}

export interface ChannelTypeInfo {
  label: string;
  fields: ChannelField[];
}

const webhookUrl = (placeholder: string): ChannelField => ({
  key: "webhookUrl",
  label: "Webhook URL",
  kind: "url",
  required: true,
  secret: true,
  secretUrl: true,
  destination: true,
  placeholder,
});

const decoration: ChannelField = {
  key: "decoration",
  label: "Decoration",
  kind: "boolean",
  defaultValue: true,
  hint: "Titles, colors and fields instead of plain text.",
};

export const CHANNEL_TYPE_INFO: Record<ChannelType, ChannelTypeInfo> = {
  slack: {
    label: "Slack",
    fields: [
      webhookUrl("https://hooks.slack.com/services/…"),
      {
        key: "channel",
        label: "Channel",
        kind: "text",
        placeholder: "#deploys",
        hint: "Leave blank to post where the webhook posts.",
      },
    ],
  },
  telegram: {
    label: "Telegram",
    fields: [
      { key: "botToken", label: "Bot token", kind: "secret", required: true, secret: true },
      {
        key: "chatId",
        label: "Chat ID",
        kind: "text",
        required: true,
        destination: true,
        placeholder: "-1001234567890",
      },
      {
        key: "threadId",
        label: "Message thread ID",
        kind: "number",
        min: 1,
        hint: "Optional: a topic in a group with topics.",
      },
    ],
  },
  discord: {
    label: "Discord",
    fields: [
      webhookUrl("https://discord.com/api/webhooks/…"),
      // Off still sends the embed, only without emoji (R3-38).
      { ...decoration, hint: "Emoji in titles. Off sends the same message without them." },
    ],
  },
  lark: {
    label: "Lark",
    fields: [webhookUrl("https://open.larksuite.com/open-apis/bot/v2/hook/…")],
  },
  teams: {
    label: "Microsoft Teams",
    fields: [webhookUrl("https://….webhook.office.com/…")],
  },
  email: {
    label: "Email (SMTP)",
    fields: [
      {
        key: "host",
        label: "SMTP server",
        kind: "text",
        required: true,
        destination: true,
        placeholder: "smtp.example.com",
      },
      {
        key: "port",
        label: "Port",
        kind: "number",
        required: true,
        destination: true,
        min: 1,
        max: 65535,
        defaultValue: 587,
      },
      { key: "username", label: "User name", kind: "text" },
      { key: "password", label: "Password", kind: "secret", secret: true },
      {
        key: "from",
        label: "From address",
        kind: "email",
        required: true,
        placeholder: "nearzero@example.com",
      },
      {
        key: "to",
        label: "To addresses",
        kind: "emails",
        required: true,
        placeholder: "ops@example.com, oncall@example.com",
        hint: "Separate several with commas.",
      },
    ],
  },
  resend: {
    label: "Resend",
    fields: [
      { key: "apiKey", label: "API key", kind: "secret", required: true, secret: true },
      { key: "from", label: "From address", kind: "email", required: true },
      {
        key: "to",
        label: "To addresses",
        kind: "emails",
        required: true,
        hint: "Separate several with commas.",
      },
    ],
  },
  gotify: {
    label: "Gotify",
    fields: [
      {
        key: "serverUrl",
        label: "Server URL",
        kind: "url",
        required: true,
        destination: true,
        serverAddress: true,
        placeholder: "https://gotify.example.com",
      },
      { key: "appToken", label: "App token", kind: "secret", required: true, secret: true },
      { key: "priority", label: "Priority", kind: "number", min: 1, max: 10, defaultValue: 5 },
      decoration,
    ],
  },
  ntfy: {
    label: "ntfy",
    fields: [
      {
        key: "serverUrl",
        label: "Server URL",
        kind: "url",
        required: true,
        destination: true,
        serverAddress: true,
        defaultValue: "https://ntfy.sh",
      },
      {
        key: "topic",
        label: "Topic",
        kind: "text",
        required: true,
        destination: true,
        placeholder: "nearzero-alerts",
      },
      {
        key: "accessToken",
        label: "Access token",
        kind: "secret",
        secret: true,
        hint: "Optional: for a protected topic.",
      },
      { key: "priority", label: "Priority", kind: "number", min: 1, max: 5, defaultValue: 3 },
    ],
  },
  mattermost: {
    label: "Mattermost",
    fields: [
      webhookUrl("https://mattermost.example.com/hooks/…"),
      { key: "channel", label: "Channel", kind: "text", hint: "Optional." },
      { key: "username", label: "User name", kind: "text", hint: "Optional." },
    ],
  },
  pushover: {
    label: "Pushover",
    fields: [
      { key: "userKey", label: "User key", kind: "secret", required: true, secret: true },
      { key: "apiToken", label: "API token", kind: "secret", required: true, secret: true },
      { key: "priority", label: "Priority", kind: "number", min: -2, max: 2, defaultValue: 0 },
      {
        key: "retry",
        label: "Retry (seconds)",
        kind: "number",
        min: 30,
        hint: "With priority 2: how often Pushover repeats it (at least 30).",
      },
      {
        key: "expire",
        label: "Expire (seconds)",
        kind: "number",
        min: 1,
        max: 10_800,
        hint: "With priority 2: when Pushover stops repeating (up to 10800).",
      },
    ],
  },
  webhook: {
    label: "Custom webhook",
    fields: [
      {
        key: "url",
        label: "URL",
        kind: "url",
        required: true,
        destination: true,
        placeholder: "https://example.com/hooks/nearzero",
        hint: "Nearzero sends a POST with a JSON body.",
      },
      {
        key: "headers",
        label: "Headers",
        kind: "headers",
        secret: true,
        hint: "Sent with every request, like Authorization. Never shown again.",
      },
    ],
  },
};

export function isChannelType(value: string): value is ChannelType {
  return (CHANNEL_TYPES as readonly string[]).includes(value);
}

export function channelTypeLabel(type: string): string {
  return isChannelType(type) ? CHANNEL_TYPE_INFO[type].label : type;
}

// ---- Events (spec 15.3)

export const NOTIFICATION_EVENTS = [
  "deploy.succeeded",
  "deploy.failed",
  "backup.database",
  "backup.volume",
  "server.docker-cleanup",
  "server.alert",
  "nearzero.restart",
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_EVENT_INFO: Record<
  NotificationEvent,
  { label: string; short: string; hint: string }
> = {
  "deploy.succeeded": {
    label: "Deploy succeeded",
    short: "Deploys",
    hint: "A deploy finished and the new version serves.",
  },
  "deploy.failed": {
    label: "Deploy failed",
    short: "Failed deploys",
    hint: "A deploy failed, including a container that never became healthy.",
  },
  "backup.database": {
    label: "Database backup",
    short: "Database backups",
    hint: "A database backup finished, successfully or not.",
  },
  "backup.volume": {
    label: "Volume backup",
    short: "Volume backups",
    hint: "A volume backup finished, successfully or not.",
  },
  "server.docker-cleanup": {
    label: "Docker cleanup",
    short: "Docker cleanup",
    hint: "The daily cleanup ran on a server.",
  },
  "server.alert": {
    label: "Server alert",
    short: "Server alerts",
    hint: "CPU or memory stayed above its threshold.",
  },
  "nearzero.restart": {
    label: "Nearzero restart",
    short: "Nearzero restarts",
    hint: "Nearzero started again after a stop or a crash.",
  },
};

export function isNotificationEvent(value: string): value is NotificationEvent {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value);
}

/** "Deploys, Failed deploys" or "No events". */
export function eventsText(events: readonly string[]): string {
  const known = NOTIFICATION_EVENTS.filter((event) => events.includes(event));
  if (known.length === 0) return "No events";
  return known.map((event) => NOTIFICATION_EVENT_INFO[event].short).join(", ");
}

export const NOTIFICATION_MESSAGES = {
  pageTitle: "Notifications",
  empty: "To send notifications, add at least one channel.",
  add: "Add notification",
  created: "Notification channel added",
  saved: "Notification channel saved",
  deleted: "Notification channel deleted",
  secretSaved: "Saved, leave blank to keep",
  nameRequired: "Name is required.",
  nameTaken: "A channel with this name already exists in this workspace. Pick another name.",
  notFound: "This channel doesn't exist in this workspace, or you don't have access to it.",
  keysUnreadable:
    "This channel's secrets can't be read any more (the install's secret changed). Edit it and enter them again.",
  restartOnlyFirst:
    "Nearzero restart notifications are only for the instance administrators' workspace.",
} as const;

export function deleteChannelText(name: string): string {
  return `Delete ${name}? It stops getting notifications. This can't be undone.`;
}

export function testSentText(type: ChannelType): string {
  return `Test sent. Check ${CHANNEL_TYPE_INFO[type].label} for the message.`;
}

export function testFailedText(reason: string): string {
  return `Test failed: ${reason}`;
}

export function lastFailureText(reason: string): string {
  return `Last delivery failed: ${reason}`;
}

// ---- Checking a channel's fields

export type ChannelValue = string | number | boolean | string[] | { name: string; value: string }[];

export interface ChannelInput {
  /** What the person typed; secrets left blank keep the saved ones. */
  [key: string]: unknown;
}

export interface CheckedChannel {
  /** Fields that are not secret, as stored and shown. */
  settings: Record<string, ChannelValue>;
  /** Secrets to store (merged with the saved ones the person left blank). */
  secrets: Record<string, ChannelValue>;
  problems: Record<string, string>;
}

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

function isBlank(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function asText(value: unknown): string {
  return typeof value === "string"
    ? value.trim()
    : value === undefined || value === null
      ? ""
      : String(value).trim();
}

function httpUrlProblem(label: string, value: string): string | null {
  if (!/^https?:\/\//i.test(value)) return `${label} must start with http:// or https://.`;
  try {
    const url = new URL(value);
    if (!url.hostname) return `${label} must be a full address, like https://example.com.`;
  } catch {
    return `${label} must be a full address, like https://example.com.`;
  }
  return null;
}

function emailList(value: unknown): string[] {
  const items = Array.isArray(value) ? value.map(String) : asText(value).split(/[,;\s]+/);
  return items.map((item) => item.trim()).filter(Boolean);
}

function headerRows(value: unknown): { name: string; value: string }[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      const item = (row ?? {}) as { name?: unknown; value?: unknown };
      return {
        name: asText(item.name),
        value: typeof item.value === "string" ? item.value : asText(item.value),
      };
    })
    .filter((row) => row.name !== "" || row.value !== "");
}

function numberProblem(field: ChannelField, value: number): string | null {
  const range =
    field.min !== undefined && field.max !== undefined
      ? `a number from ${field.min} to ${field.max}`
      : field.min !== undefined
        ? `a number of at least ${field.min}`
        : "a number";
  if (!Number.isInteger(value)) return `${field.label} must be ${range}.`;
  if (field.min !== undefined && value < field.min) return `${field.label} must be ${range}.`;
  if (field.max !== undefined && value > field.max) return `${field.label} must be ${range}.`;
  return null;
}

/** "Bot token is required." with the label's own capital. */
function required(label: string): string {
  return `${label} is required.`;
}

/**
 * Checks a channel's fields. On edit, `saved` holds the stored settings and secrets: a blank
 * secret keeps the saved one, unless a destination field changed, which needs every saved
 * secret entered again (spec 15.2).
 */
export function checkChannel(
  type: ChannelType,
  input: ChannelInput,
  saved: {
    settings: Record<string, ChannelValue>;
    secrets: Record<string, ChannelValue>;
  } | null = null,
): CheckedChannel {
  const info = CHANNEL_TYPE_INFO[type];
  const settings: Record<string, ChannelValue> = {};
  const secrets: Record<string, ChannelValue> = {};
  const problems: Record<string, string> = {};
  const destinationChanged =
    saved !== null &&
    info.fields.some((field) => {
      if (!field.destination) return false;
      if (field.secret) return !isBlank(input[field.key]);
      const before = saved.settings[field.key];
      const after = input[field.key];
      return asText(after) !== asText(before);
    });

  for (const field of info.fields) {
    const raw = input[field.key];
    const blank = isBlank(raw);
    if (field.secret) {
      const savedValue = saved?.secrets[field.key];
      const hasSaved = savedValue !== undefined && !isBlank(savedValue);
      if (blank) {
        if (hasSaved && !destinationChanged) {
          secrets[field.key] = savedValue as ChannelValue;
          continue;
        }
        if (hasSaved && destinationChanged) {
          problems[field.key] =
            `Enter the ${field.label.toLowerCase()} again when you change where this channel sends.`;
          continue;
        }
        if (field.required) problems[field.key] = required(field.label);
        continue;
      }
      if (field.kind === "headers") {
        const rows = headerRows(raw);
        const bad = rows.find((row) => !HEADER_NAME.test(row.name));
        if (bad) {
          problems[field.key] = bad.name
            ? `"${bad.name}" isn't a header name. Use letters, digits and dashes.`
            : "Each header needs a name.";
          continue;
        }
        if (rows.length > 0) secrets[field.key] = rows;
        continue;
      }
      const value = asText(raw);
      if (field.secretUrl || field.kind === "url") {
        const problem = httpUrlProblem(field.label, value);
        if (problem) {
          problems[field.key] = problem;
          continue;
        }
      }
      if (value.length > 2048) {
        problems[field.key] = `${field.label} is too long.`;
        continue;
      }
      secrets[field.key] = value;
      continue;
    }

    if (field.kind === "boolean") {
      settings[field.key] =
        raw === undefined || raw === null || raw === ""
          ? Boolean(field.defaultValue ?? false)
          : raw === true || raw === "true" || raw === "on";
      continue;
    }
    if (blank) {
      if (field.required) problems[field.key] = required(field.label);
      else if (field.defaultValue !== undefined && field.kind === "number") {
        settings[field.key] = field.defaultValue as number;
      }
      continue;
    }
    switch (field.kind) {
      case "url": {
        const typed = asText(raw);
        const value = field.serverAddress ? typed.replace(/\/+$/, "") : typed;
        const problem = httpUrlProblem(field.label, value);
        if (problem) problems[field.key] = problem;
        else settings[field.key] = value;
        break;
      }
      case "number": {
        const value = typeof raw === "number" ? raw : Number(asText(raw));
        const problem = Number.isFinite(value)
          ? numberProblem(field, value)
          : numberProblem(field, NaN);
        if (problem) problems[field.key] = problem;
        else settings[field.key] = value;
        break;
      }
      case "email": {
        const value = asText(raw);
        const address = /<([^>]+)>\s*$/.exec(value)?.[1] ?? value;
        if (!EMAIL.test(address))
          problems[field.key] = `Enter a valid email address for ${field.label}.`;
        else settings[field.key] = value;
        break;
      }
      case "emails": {
        const list = emailList(raw);
        const bad = list.find((item) => !EMAIL.test(item));
        if (list.length === 0) problems[field.key] = required(field.label);
        else if (bad) problems[field.key] = `"${bad}" isn't a valid email address.`;
        else if (list.length > 50) problems[field.key] = "Use at most 50 addresses.";
        else settings[field.key] = list;
        break;
      }
      default: {
        const value = asText(raw);
        if (value.length > 500) problems[field.key] = `${field.label} is too long.`;
        else settings[field.key] = value;
      }
    }
  }

  if (type === "telegram" && typeof input.chatId === "string" && !problems.chatId) {
    if (!/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,64})$/.test(asText(input.chatId))) {
      problems.chatId =
        "Chat ID must be a number like -1001234567890, or a channel name like @mychannel.";
    }
  }
  if (type === "pushover" && settings.priority === 2) {
    if (settings.retry === undefined && !problems.retry) {
      problems.retry = "Retry is required with priority 2 (at least 30 seconds).";
    }
    if (settings.expire === undefined && !problems.expire) {
      problems.expire = "Expire is required with priority 2 (1 to 10800 seconds).";
    }
  }
  if (type === "ntfy" && typeof settings.topic === "string" && !problems.topic) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(settings.topic)) {
      problems.topic = "Topic may use letters, digits, - and _ (up to 64).";
    }
  }
  return { settings, secrets, problems };
}

/** A secret URL shown without its token: "https://hooks.slack.com/…". */
export function maskedUrl(url: string): string {
  try {
    return `${new URL(url).origin}/…`;
  } catch {
    return "Saved";
  }
}
