import { isIP } from "node:net";
import { CHANNEL_TYPE_INFO, type ChannelType, type ChannelValue } from "@nearzero/shared";
import {
  checkOutboundHost,
  OutboundRefused,
  type ResolveHost,
  systemResolve,
} from "../security/outbound.ts";
import type { HttpFetch } from "../services.ts";
import {
  escapeHtml,
  isDeployMessage,
  legacyWebhookFields,
  type MessageTone,
  markdown,
  type NotificationMessage,
  plainText,
  TONE_COLORS,
  TONE_EMOJI,
  toneHex,
} from "./messages.ts";
import { type SmtpSender, sendSmtp } from "./smtp.ts";

/**
 * Sending one message to one channel (spec 15.2), with each provider's own API as its official
 * documentation describes it. A failure throws a {@link DeliveryError} whose reason names the
 * provider's answer in plain words and never carries a secret (tokens live in URLs and headers,
 * which are never quoted back).
 */

export interface NotificationTransport {
  http: HttpFetch;
  smtp: SmtpSender;
  /** Fixed provider addresses; tests point them at local fakes. */
  endpoints: { telegram: string; pushover: string; resend: string };
  timeoutMs: number;
  /** Looks up the hosts people typed, so private and internal addresses are refused (B1-20). */
  resolve: ResolveHost;
}

/** Who may send where: only instance administrators reach private and internal addresses. */
export interface DeliverOptions {
  allowInternal: boolean;
}

/**
 * Providers whose answers are safe to quote in a failure reason: their public addresses. A
 * host a person typed gets only the status code, so nobody can read internal pages through a
 * channel's test (B1-20).
 */
const QUOTED_HOSTS = [
  "hooks.slack.com",
  "discord.com",
  "discordapp.com",
  "open.larksuite.com",
  "open.feishu.cn",
];

function quotable(url: string, fixed: boolean): boolean {
  if (fixed) return true;
  const host = hostOf(url);
  return QUOTED_HOSTS.includes(host) || host.endsWith(".webhook.office.com");
}

export const DEFAULT_ENDPOINTS = {
  telegram: "https://api.telegram.org",
  pushover: "https://api.pushover.net",
  resend: "https://api.resend.com",
};

export function defaultTransport(http: HttpFetch): NotificationTransport {
  return {
    http,
    smtp: sendSmtp,
    endpoints: { ...DEFAULT_ENDPOINTS },
    timeoutMs: 10_000,
    resolve: systemResolve,
  };
}

export class DeliveryError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "DeliveryError";
  }
}

type Fields = Record<string, ChannelValue | undefined>;

function str(fields: Fields, key: string): string {
  const value = fields[key];
  return typeof value === "string" ? value : value === undefined ? "" : String(value);
}

function num(fields: Fields, key: string): number | undefined {
  const value = fields[key];
  return typeof value === "number" ? value : undefined;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the server";
  }
}

/** Removes every secret value from a reason before anyone sees it. */
function scrub(reason: string, secrets: Fields): string {
  let out = reason;
  for (const value of Object.values(secrets)) {
    const items = Array.isArray(value)
      ? value.map((item) => (typeof item === "string" ? item : (item as { value: string }).value))
      : [typeof value === "string" ? value : ""];
    for (const item of items) if (item && item.length >= 4) out = out.split(item).join("…");
  }
  return out;
}

/** The hosts a channel sends to that a person typed (not the fixed provider endpoints). */
export function destinationHosts(type: ChannelType, settings: Fields, secrets: Fields): string[] {
  const hosts: string[] = [];
  for (const field of CHANNEL_TYPE_INFO[type].fields) {
    const value = field.secret ? secrets[field.key] : settings[field.key];
    if (typeof value !== "string" || value === "") continue;
    if (field.kind === "url") {
      try {
        hosts.push(new URL(value).hostname);
      } catch {
        // Checked by checkChannel already.
      }
    }
  }
  if (type === "email" && typeof settings.host === "string") hosts.push(settings.host);
  return hosts;
}

/**
 * Refuses saving a channel that points at a private or internal address, for anyone but an
 * instance administrator. A name that doesn't resolve right now is let through: the send
 * checks it again.
 */
export async function checkDestinations(
  transport: NotificationTransport,
  type: ChannelType,
  settings: Fields,
  secrets: Fields,
  options: DeliverOptions,
): Promise<string | null> {
  for (const host of destinationHosts(type, settings, secrets)) {
    try {
      await checkOutboundHost(host, transport.resolve, options.allowInternal);
    } catch (error) {
      if (error instanceof OutboundRefused && error.kind === "internal") {
        return `${host} is a private or internal address. Only an instance administrator can send notifications there.`;
      }
    }
  }
  return null;
}

/**
 * Refuses a typed destination that resolves to a private or internal address (B1-20), and
 * returns the address it checked: the send connects to that one, never to a second lookup of the
 * name, so a name that answers differently a moment later (DNS rebinding) changes nothing
 * (C1-07, spec 23.9).
 */
async function guardHost(
  transport: NotificationTransport,
  host: string,
  options: DeliverOptions,
): Promise<string> {
  try {
    const [address] = await checkOutboundHost(host, transport.resolve, options.allowInternal);
    if (!address) throw new DeliveryError(`couldn't look up ${host}`);
    return address;
  } catch (error) {
    if (error instanceof OutboundRefused) throw new DeliveryError(error.message);
    throw error;
  }
}

/**
 * A request to a typed URL, sent to the address that was checked: the URL names that IP, while
 * the Host header and the TLS server name keep the hostname, so the certificate is still checked
 * for the name (C1-07).
 */
function pinnedTo(url: URL, address: string): { input: string; host: string; tls?: object } {
  const named = isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0;
  if (!named) return { input: url.toString(), host: url.host };
  const pinned = new URL(url.toString());
  pinned.hostname = address.includes(":") ? `[${address}]` : address;
  return {
    input: pinned.toString(),
    host: url.host,
    ...(url.protocol === "https:" ? { tls: { serverName: url.hostname } } : {}),
  };
}

/**
 * POSTs to a provider. `guard` is set for addresses a person typed (checked first, then
 * connected to as checked); fixed provider endpoints pass null. Redirects aren't followed, as a
 * redirect could lead to an address nobody checked; one is reported as such (G3-18).
 */
async function post(
  transport: NotificationTransport,
  provider: string,
  url: string,
  body: string,
  headers: Record<string, string>,
  guard: DeliverOptions | null,
): Promise<Response> {
  let input = url;
  let sendHeaders = headers;
  let tls: object | undefined;
  if (guard) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new DeliveryError("the address isn't a valid URL");
    }
    const pinned = pinnedTo(parsed, await guardHost(transport, parsed.hostname, guard));
    input = pinned.input;
    sendHeaders = { ...headers, host: pinned.host };
    tls = pinned.tls;
  }
  let response: Response;
  try {
    response = await transport.http(input, {
      method: "POST",
      headers: sendHeaders,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(transport.timeoutMs),
      ...(tls ? { tls } : {}),
    } as RequestInit);
  } catch (error) {
    const reason =
      (error as Error)?.name === "TimeoutError"
        ? "no answer within 10 seconds"
        : "the connection failed";
    throw new DeliveryError(`couldn't reach ${hostOf(url)} (${reason})`);
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    throw new DeliveryError(
      `${hostOf(url)} answered with a redirect (${response.status}); use the final address`,
    );
  }
  if (!response.ok) {
    const detail = quotable(url, guard === null)
      ? (await response.text().catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 200)
      : "";
    if (!detail) await response.body?.cancel().catch(() => {});
    throw new DeliveryError(
      `${provider} answered ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response;
}

const json = (value: unknown) => JSON.stringify(value);
const JSON_HEADERS = { "content-type": "application/json" };

/** Slack's own escaping for text it formats: &, < and > (its message formatting docs). */
function slackEscape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Slack (R3-38): the title as the message's text, then one attachment in the event's color
 * (green for success, red for a failure) with the summary, a field per fact, the link and the
 * event's time.
 */
function slackBody(message: NotificationMessage, channel: string) {
  const link = message.link ? `\n<${message.link.url}|${slackEscape(message.link.label)}>` : "";
  const log =
    isDeployMessage(message) && message.logUrl && message.logUrl !== message.link?.url
      ? `\n<${message.logUrl}|Deployment logs>`
      : "";
  return {
    text: `*${slackEscape(message.title)}*`,
    attachments: [
      {
        color: toneHex(message.tone),
        fallback: plainText(message).slice(0, 3000),
        text: `${slackEscape(message.summary)}${link}${log}`,
        fields: message.facts.slice(0, 20).map((fact) => ({
          title: fact.label,
          value: slackEscape(fact.value),
          short: fact.value.length < 40,
        })),
        footer: "Nearzero",
        ...(message.at ? { ts: Math.floor(Date.parse(message.at) / 1000) } : {}),
      },
    ],
    ...(channel ? { channel } : {}),
  };
}

/** Links a chat app can open from a button: http(s) on a name or address it can reach. */
function buttonUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    const host = parsed.hostname;
    if (host === "localhost" || /\.(localhost|local)$/.test(host) || !host.includes(".")) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * The buttons a chat message carries (R3-38): the deploy's log ("Deployment Logs" on Telegram,
 * "View Build Details" on Lark, "Build details" on ntfy) and the message's own link when it is
 * another address (a deployed app). Links a chat app can't open stay in the text.
 */
function messageButtons(
  message: NotificationMessage,
  logLabel: string,
): { label: string; url: string }[] {
  const buttons: { label: string; url: string }[] = [];
  const log = isDeployMessage(message) ? buttonUrl(message.logUrl) : null;
  if (log) buttons.push({ label: logLabel, url: log });
  const own = buttonUrl(message.link?.url);
  if (message.link && own && own !== log) buttons.push({ label: message.link.label, url: own });
  return buttons;
}

function telegramHtml(message: NotificationMessage, buttons: { url: string }[]): string {
  const lines = [`<b>${escapeHtml(message.title)}</b>`, escapeHtml(message.summary)];
  if (message.facts.length > 0) lines.push("");
  for (const fact of message.facts)
    lines.push(`<b>${escapeHtml(fact.label)}:</b> ${escapeHtml(fact.value)}`);
  // A link that is a button isn't repeated in the text.
  if (message.link && !buttons.some((button) => button.url === buttonUrl(message.link?.url)))
    lines.push(
      "",
      `<a href="${escapeHtml(message.link.url)}">${escapeHtml(message.link.label)}</a>`,
    );
  return lines.join("\n").slice(0, 4000);
}

/** Lark's card header colors for each tone (its message card docs: header templates). */
const LARK_TEMPLATES: Record<MessageTone, string> = {
  success: "green",
  failure: "red",
  warning: "orange",
  info: "purple",
};

/**
 * Lark (R3-38): an interactive card with the title in the event's color, the summary, the facts
 * as fields, and buttons: "View Build Details" for a deploy's log.
 */
function larkCard(message: NotificationMessage) {
  const elements: Record<string, unknown>[] = [
    { tag: "div", text: { tag: "plain_text", content: message.summary.slice(0, 2000) } },
  ];
  if (message.facts.length > 0) {
    elements.push({
      tag: "div",
      fields: message.facts.slice(0, 20).map((fact) => ({
        is_short: fact.value.length < 40,
        text: { tag: "lark_md", content: `**${fact.label}**\n${fact.value}` },
      })),
    });
  }
  const buttons = messageButtons(message, "View Build Details");
  if (buttons.length > 0) {
    elements.push({
      tag: "action",
      actions: buttons.map((button, index) => ({
        tag: "button",
        text: { tag: "plain_text", content: button.label },
        url: button.url,
        type: index === 0 ? "primary" : "default",
      })),
    });
  } else if (message.link) {
    elements.push({
      tag: "div",
      text: { tag: "plain_text", content: `${message.link.label}: ${message.link.url}` },
    });
  }
  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        template: LARK_TEMPLATES[message.tone],
        title: { tag: "plain_text", content: message.title.slice(0, 200) },
      },
      elements,
    },
  };
}

/**
 * The email template (R3-38): a band in the event's color, the title and summary, the facts as
 * a table, the link as a button and a footer naming Nearzero. Inline styles only, as mail
 * clients need.
 */
function emailHtml(message: NotificationMessage): string {
  const color = toneHex(message.tone);
  const rows = message.facts
    .map(
      (fact) =>
        `<tr><td style="padding:6px 16px 6px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${escapeHtml(fact.label)}</td><td style="padding:6px 0;color:#111827">${escapeHtml(fact.value)}</td></tr>`,
    )
    .join("");
  const links = [
    ...(message.link ? [message.link] : []),
    ...(isDeployMessage(message) && message.logUrl && message.logUrl !== message.link?.url
      ? [{ label: "Open the log", url: message.logUrl }]
      : []),
  ]
    .map(
      (link) =>
        `<a href="${escapeHtml(link.url)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;border-radius:6px;background:${color};color:#ffffff;text-decoration:none;font-weight:600">${escapeHtml(link.label)}</a>`,
    )
    .join("");
  return [
    '<div style="background:#f3f4f6;padding:24px 12px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.5">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">',
    `<div style="height:4px;background:${color}"></div>`,
    '<div style="padding:20px 24px">',
    `<p style="margin:0 0 4px;font-size:16px;font-weight:600;color:#111827">${escapeHtml(message.title)}</p>`,
    `<p style="margin:0 0 16px;color:#374151">${escapeHtml(message.summary)}</p>`,
    rows
      ? `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px">${rows}</table>`
      : "",
    links ? `<p style="margin:0">${links}</p>` : "",
    "</div>",
    '<div style="padding:12px 24px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px">Sent by Nearzero</div>',
    "</div></div>",
  ].join("");
}

function teamsCard(message: NotificationMessage) {
  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: message.title, weight: "Bolder", size: "Medium", wrap: true },
    { type: "TextBlock", text: message.summary, wrap: true },
  ];
  if (message.facts.length > 0) {
    body.push({
      type: "FactSet",
      facts: message.facts.map((fact) => ({ title: fact.label, value: fact.value })),
    });
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
          ...(message.link
            ? {
                actions: [
                  { type: "Action.OpenUrl", title: message.link.label, url: message.link.url },
                ],
              }
            : {}),
        },
      },
    ],
  };
}

const NTFY_TAGS = {
  success: "white_check_mark",
  failure: "x",
  warning: "warning",
  info: "information_source",
};

/** Sends the message to one channel; throws DeliveryError with the reason when it fails. */
export async function deliver(
  transport: NotificationTransport,
  type: ChannelType,
  settings: Fields,
  secrets: Fields,
  message: NotificationMessage,
  options: DeliverOptions,
): Promise<void> {
  const provider = CHANNEL_TYPE_INFO[type].label;
  const typed = options;
  try {
    switch (type) {
      case "slack": {
        await post(
          transport,
          provider,
          str(secrets, "webhookUrl"),
          json(slackBody(message, str(settings, "channel"))),
          JSON_HEADERS,
          typed,
        );
        return;
      }
      case "telegram": {
        const thread = num(settings, "threadId");
        // A deploy's log is an inline keyboard button (R3-38).
        const buttons = messageButtons(message, "Deployment Logs");
        const response = await post(
          transport,
          provider,
          `${transport.endpoints.telegram}/bot${str(secrets, "botToken")}/sendMessage`,
          json({
            chat_id: str(settings, "chatId"),
            text: telegramHtml(message, buttons),
            parse_mode: "HTML",
            disable_web_page_preview: true,
            ...(thread ? { message_thread_id: thread } : {}),
            ...(buttons.length > 0
              ? {
                  reply_markup: {
                    inline_keyboard: [
                      buttons.map((button) => ({ text: button.label, url: button.url })),
                    ],
                  },
                }
              : {}),
          }),
          JSON_HEADERS,
          null,
        );
        const answer = (await response.json().catch(() => ({ ok: true }))) as {
          ok?: boolean;
          description?: string;
        };
        if (answer.ok === false)
          throw new DeliveryError(
            `Telegram refused it: ${answer.description ?? "no reason given"}`,
          );
        return;
      }
      case "discord": {
        // Decoration puts emoji in the title; without it the embed is the same, plainer (R3-38).
        const decorated = settings.decoration !== false;
        const title = decorated ? `${TONE_EMOJI[message.tone]} ${message.title}` : message.title;
        const log =
          isDeployMessage(message) && message.logUrl && message.logUrl !== message.link?.url
            ? message.logUrl
            : null;
        // No username: Discord shows the name the webhook was given there (G3-19).
        const body = {
          embeds: [
            {
              title: title.slice(0, 256),
              description: `${message.summary}${log ? `\n[Deployment logs](${log})` : ""}`.slice(
                0,
                2000,
              ),
              color: TONE_COLORS[message.tone],
              fields: message.facts.slice(0, 20).map((fact) => ({
                name: fact.label.slice(0, 256),
                value: fact.value.slice(0, 1024) || "—",
                inline: fact.value.length < 40,
              })),
              ...(message.link ? { url: message.link.url } : {}),
              // When it happened (a server alert's sample), not when it was sent (R3-35).
              timestamp: message.at ?? new Date().toISOString(),
              footer: { text: "Nearzero" },
            },
          ],
        };
        await post(
          transport,
          provider,
          str(secrets, "webhookUrl"),
          json(body),
          JSON_HEADERS,
          typed,
        );
        return;
      }
      case "lark": {
        const response = await post(
          transport,
          provider,
          str(secrets, "webhookUrl"),
          json(larkCard(message)),
          JSON_HEADERS,
          typed,
        );
        const answer = (await response.json().catch(() => ({}))) as {
          code?: number;
          msg?: string;
          StatusCode?: number;
        };
        const code = answer.code ?? answer.StatusCode ?? 0;
        // Lark's own words only from Lark's own hosts: another address's answer is never quoted,
        // so a channel's Test can't read an internal service (C1-07, B1-20).
        const words = quotable(str(secrets, "webhookUrl"), false) ? answer.msg : undefined;
        if (code !== 0)
          throw new DeliveryError(
            `Lark refused it: ${words ? words.replace(/\s+/g, " ").slice(0, 200) : `code ${code}`}`,
          );
        return;
      }
      case "teams":
        await post(
          transport,
          provider,
          str(secrets, "webhookUrl"),
          json(teamsCard(message)),
          JSON_HEADERS,
          typed,
        );
        return;
      case "email": {
        const to = Array.isArray(settings.to) ? (settings.to as string[]) : [];
        // The mail goes to the address that was checked; TLS still checks the server's name.
        const address = await guardHost(transport, str(settings, "host"), typed);
        const result = await transport.smtp(
          {
            host: str(settings, "host"),
            address,
            port: num(settings, "port") ?? 587,
            username: str(settings, "username"),
            password: str(secrets, "password"),
          },
          {
            from: str(settings, "from"),
            to,
            subject: message.title,
            text: plainText(message),
            html: emailHtml(message),
          },
        );
        if (!result.ok) throw new DeliveryError(result.reason);
        return;
      }
      case "resend": {
        const to = Array.isArray(settings.to) ? (settings.to as string[]) : [];
        await post(
          transport,
          provider,
          `${transport.endpoints.resend}/emails`,
          json({
            from: str(settings, "from"),
            to,
            subject: message.title,
            text: plainText(message),
            html: emailHtml(message),
          }),
          { ...JSON_HEADERS, authorization: `Bearer ${str(secrets, "apiKey")}` },
          null,
        );
        return;
      }
      case "gotify": {
        const decorated = settings.decoration !== false;
        await post(
          transport,
          provider,
          `${str(settings, "serverUrl")}/message`,
          json({
            title: message.title,
            message: decorated ? markdown(message) : plainText(message),
            priority: num(settings, "priority") ?? 5,
            ...(decorated
              ? { extras: { "client::display": { contentType: "text/markdown" } } }
              : {}),
          }),
          { ...JSON_HEADERS, "x-gotify-key": str(secrets, "appToken") },
          typed,
        );
        return;
      }
      case "ntfy": {
        const token = str(secrets, "accessToken");
        const body = [
          message.summary,
          ...message.facts.map((fact) => `${fact.label}: ${fact.value}`),
        ].join("\n");
        // A deploy's log is a "Build details" action button (R3-38); ntfy allows three.
        const actions = messageButtons(message, "Build details")
          .slice(0, 3)
          .map((button) => ({ action: "view", label: button.label, url: button.url }));
        await post(
          transport,
          provider,
          str(settings, "serverUrl"),
          json({
            topic: str(settings, "topic"),
            title: message.title,
            message: body,
            priority: num(settings, "priority") ?? 3,
            tags: [NTFY_TAGS[message.tone]],
            ...(message.link ? { click: message.link.url } : {}),
            ...(actions.length > 0 ? { actions } : {}),
          }),
          { ...JSON_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) },
          typed,
        );
        return;
      }
      case "mattermost": {
        const channel = str(settings, "channel");
        const username = str(settings, "username");
        await post(
          transport,
          provider,
          str(secrets, "webhookUrl"),
          json({
            text: markdown(message),
            ...(channel ? { channel } : {}),
            // Posts as "Nearzero" unless the channel names another user (R3-38).
            username: username || "Nearzero",
          }),
          JSON_HEADERS,
          typed,
        );
        return;
      }
      case "pushover": {
        const priority = num(settings, "priority") ?? 0;
        const form = new URLSearchParams({
          token: str(secrets, "apiToken"),
          user: str(secrets, "userKey"),
          title: message.title.slice(0, 250),
          message: [message.summary, ...message.facts.map((fact) => `${fact.label}: ${fact.value}`)]
            .join("\n")
            .slice(0, 1024),
          priority: String(priority),
        });
        if (priority === 2) {
          form.set("retry", String(num(settings, "retry") ?? 60));
          form.set("expire", String(num(settings, "expire") ?? 3600));
        }
        if (message.link) {
          form.set("url", message.link.url);
          form.set("url_title", message.link.label);
        }
        const response = await post(
          transport,
          provider,
          `${transport.endpoints.pushover}/1/messages.json`,
          form.toString(),
          {
            "content-type": "application/x-www-form-urlencoded",
          },
          null,
        );
        const answer = (await response.json().catch(() => ({ status: 1 }))) as {
          status?: number;
          errors?: string[];
        };
        if (answer.status !== 1)
          throw new DeliveryError(
            `Pushover refused it: ${(answer.errors ?? []).join("; ") || "no reason given"}`,
          );
        return;
      }
      case "webhook": {
        const headers: Record<string, string> = {
          ...JSON_HEADERS,
          "user-agent": "Nearzero-Notifications",
        };
        const rows = Array.isArray(secrets.headers)
          ? (secrets.headers as { name: string; value: string }[])
          : [];
        for (const row of rows) headers[row.name.toLowerCase()] = row.value;
        await post(
          transport,
          provider,
          str(settings, "url"),
          json({
            // The flat fields 0.1.x posted, its `title` and `message` included, so receivers
            // written for it keep working (R3-37, R4-14). 1.0's own fields follow under names
            // that never overwrite them: its title is `headline`.
            ...legacyWebhookFields(message),
            event: message.event,
            headline: message.title,
            summary: message.summary,
            facts: message.facts,
            link: message.link,
            tone: message.tone,
            data: message.data ?? {},
            sentAt: new Date().toISOString(),
          }),
          headers,
          typed,
        );
        return;
      }
    }
  } catch (error) {
    const reason =
      error instanceof DeliveryError ? error.message : (error as Error)?.message || String(error);
    throw new DeliveryError(scrub(reason, secrets));
  }
}
