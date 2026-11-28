import type { InstanceEmailConfig } from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import {
  checkOutboundHost,
  OutboundRefused,
  type ResolveHost,
  systemResolve,
} from "../security/outbound.ts";
import type { SecretBox } from "../security/secret-box.ts";
import type { HttpFetch } from "../services.ts";
import { sendWithResend } from "./resend.ts";
import type { SmtpConnector } from "./smtp.ts";

/**
 * Which way an email leaves this server (spec 04 4.5, 4.6). Invitations and welcomes take the
 * workspace's own settings, else the install's, else none. Mail that proves an address
 * (confirmation links and the notice of a changed address) takes only the install's settings
 * ({@link addressMailRoute}): a workspace's own Resend key or SMTP server is chosen by whoever
 * runs that workspace, so a link sent through it proves nothing about who reads the address
 * (C1-01). Sending never throws; it returns what happened, so a failed email never turns into a
 * failed request.
 */

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type DeliveryResult = { sent: true } | { sent: false; reason: string };

export interface EmailRoute {
  source: "workspace" | "instance";
  provider: "resend" | "smtp";
  from: string;
  send(mail: OutgoingEmail): Promise<DeliveryResult>;
}

export interface EmailDependencies {
  db: Db;
  secrets: SecretBox;
  http: HttpFetch;
  smtp: SmtpConnector;
  instanceEmail: InstanceEmailConfig | null;
  /** How a workspace's SMTP host is looked up before it is checked (C1-05). */
  resolveHost?: ResolveHost;
}

/** Why a workspace's SMTP server is refused (C1-05), in words the Email settings show. */
export function internalSmtpMessage(host: string): string {
  return `${host} is a private or internal address. A workspace's email goes only to a public mail server, unless a Nearzero administrator saves it.`;
}

export const UNREADABLE_EMAIL_KEY =
  "The saved key can't be read on this server anymore. Paste it again.";

export function secretContext(workspaceId: string, kind: string): string {
  return `workspace:${workspaceId}:${kind}`;
}

function guard(send: (mail: OutgoingEmail) => Promise<DeliveryResult>) {
  return async (mail: OutgoingEmail): Promise<DeliveryResult> => {
    try {
      return await send(mail);
    } catch {
      return { sent: false, reason: "The email couldn't be sent. Try again later." };
    }
  };
}

export function instanceRoute(deps: EmailDependencies): EmailRoute | null {
  const config = deps.instanceEmail;
  if (!config) return null;
  if (config.provider === "resend") {
    return {
      source: "instance",
      provider: "resend",
      from: config.from,
      send: guard((mail) =>
        sendWithResend(deps.http, config.apiKey, { ...mail, from: config.from }),
      ),
    };
  }
  return {
    source: "instance",
    provider: "smtp",
    from: config.from,
    send: guard((mail) => deps.smtp(config, { ...mail, from: config.from })),
  };
}

/**
 * The route for mail that proves an address or warns it (confirmation links, the notice to an
 * old address): the install's email settings only, or null when the install has none.
 */
export function addressMailRoute(deps: EmailDependencies): EmailRoute | null {
  return instanceRoute(deps);
}

/** The workspace's own email route, or null when it has none saved. */
export async function workspaceRoute(
  deps: EmailDependencies,
  workspaceId: string,
): Promise<EmailRoute | null> {
  const settings = await deps.db
    .selectFrom("workspace_email")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  if (!settings) return null;
  const secretKind = settings.provider === "resend" ? "email-resend-key" : "email-smtp-password";
  const secret = await deps.db
    .selectFrom("workspace_secret")
    .select("sealed")
    .where("workspace_id", "=", workspaceId)
    .where("kind", "=", secretKind)
    .executeTakeFirst();
  const opened = secret
    ? deps.secrets.open(secret.sealed, secretContext(workspaceId, secretKind))
    : null;
  const unreadable = secret !== undefined && opened !== null && !opened.ok;
  const value = opened?.ok ? opened.value : "";

  const send = async (mail: OutgoingEmail): Promise<DeliveryResult> => {
    if (unreadable) return { sent: false, reason: UNREADABLE_EMAIL_KEY };
    if (settings.provider === "resend") {
      return sendWithResend(deps.http, value, { ...mail, from: settings.sender });
    }
    const host = settings.smtp_host ?? "";
    // Checked at every send, as a name can come to point elsewhere, and connected to the very
    // address checked (C1-05, spec 23.9; the rule channels follow).
    let addresses: string[];
    try {
      addresses = await checkOutboundHost(
        host,
        deps.resolveHost ?? systemResolve,
        settings.internal_allowed,
      );
    } catch (error) {
      if (!(error instanceof OutboundRefused)) throw error;
      return {
        sent: false,
        reason:
          error.kind === "internal"
            ? internalSmtpMessage(host)
            : `Nearzero couldn't look up ${host}. Check the SMTP server's host name.`,
      };
    }
    return deps.smtp(
      {
        host,
        port: settings.smtp_port ?? 587,
        security: settings.smtp_security ?? "starttls",
        username: settings.smtp_username ?? "",
        password: value,
      },
      { ...mail, from: settings.sender },
      { connectTo: addresses[0] as string, quoteReplies: settings.internal_allowed },
    );
  };
  return {
    source: "workspace",
    provider: settings.provider,
    from: settings.sender,
    send: guard(send),
  };
}

/** The route invitation emails for a workspace take, or null when none exists. */
export async function emailRouteFor(
  deps: EmailDependencies,
  workspaceId: string | null,
): Promise<EmailRoute | null> {
  if (workspaceId) {
    const own = await workspaceRoute(deps, workspaceId);
    if (own) return own;
  }
  return instanceRoute(deps);
}
