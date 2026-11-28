import { isIP } from "node:net";
import nodemailer from "nodemailer";
import type { DeliveryResult, OutgoingEmail } from "./transport.ts";

/**
 * Sending through an SMTP server (decision D4), with nodemailer. Connecting is injectable so tests
 * can stand in a fake server or a fake connector.
 */

export interface SmtpSettings {
  host: string;
  port: number;
  /** tls: TLS from the first byte (usually 465). starttls: upgrade required (usually 587). */
  security: "tls" | "starttls" | "none";
  username: string;
  password: string;
}

/**
 * How a send that isn't the install's own goes out (C1-05): to the address the host was checked
 * at, so a name can't point somewhere else between the check and the connection, and without
 * the server's reply in the reason unless an instance administrator chose the server.
 */
export interface SmtpSendOptions {
  /** The checked address to connect to; the host name is still used for TLS. */
  connectTo?: string;
  /** False: only the reply code is given, never the server's words. */
  quoteReplies?: boolean;
}

export type SmtpConnector = (
  settings: SmtpSettings,
  mail: OutgoingEmail & { from: string },
  options?: SmtpSendOptions,
) => Promise<DeliveryResult>;

interface MailError {
  code?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

function describe(error: MailError, settings: SmtpSettings, quoteReplies = true): string {
  const where = `${settings.host}:${settings.port}`;
  if (error.code === "EAUTH") {
    return "The SMTP server refused the user name or password. Check them and save again.";
  }
  if (
    error.code === "ECONNECTION" ||
    error.code === "ETIMEDOUT" ||
    error.code === "ESOCKET" ||
    error.code === "EDNS"
  ) {
    return `The SMTP server at ${where} couldn't be reached. Check the host, the port and the security setting.`;
  }
  if (error.code === "ETLS") {
    return `The SMTP server at ${where} didn't accept a secure connection. Check the security setting.`;
  }
  if (!quoteReplies) {
    // A server someone typed: what it said stays here (C1-05), only an SMTP reply code is given.
    return `The SMTP server at ${where} refused the message${error.responseCode ? ` (reply ${error.responseCode})` : ""}. Check the server's settings and its log.`;
  }
  const detail = (error.response ?? error.message ?? "").replace(/\s+/g, " ").slice(0, 200);
  return `The SMTP server at ${where} refused the message${detail ? `: ${detail}` : "."}`;
}

export const nodemailerConnector: SmtpConnector = async (settings, mail, options = {}) => {
  const pinned =
    options.connectTo && options.connectTo !== settings.host ? options.connectTo : null;
  const transport = nodemailer.createTransport({
    host: pinned ?? settings.host,
    port: settings.port,
    // Connected by address, the certificate is still checked against the name (SNI too).
    ...(pinned && !isIP(settings.host) ? { tls: { servername: settings.host } } : {}),
    secure: settings.security === "tls",
    requireTLS: settings.security === "starttls",
    ignoreTLS: settings.security === "none",
    ...(settings.username ? { auth: { user: settings.username, pass: settings.password } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: mail.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { sent: true };
  } catch (error) {
    return {
      sent: false,
      reason: describe(error as MailError, settings, options.quoteReplies ?? true),
    };
  } finally {
    transport.close();
  }
};
