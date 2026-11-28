import { isIP } from "node:net";
import nodemailer from "nodemailer";

/**
 * Email channels over SMTP (spec 15.2): the SMTP server, its port, a user name and password,
 * a From address and To addresses. Port 465 speaks TLS from the first byte; other ports start in
 * plain text and upgrade with STARTTLS when the server offers it.
 */

export interface SmtpChannelSettings {
  host: string;
  /**
   * The address the host was checked to resolve to: the connection goes there, and TLS checks
   * the certificate for `host` (C1-07). Without it, `host` is looked up when connecting.
   */
  address?: string;
  port: number;
  username: string;
  password: string;
}

export interface ChannelMail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export type SmtpSender = (
  settings: SmtpChannelSettings,
  mail: ChannelMail,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

interface MailError {
  code?: string;
  responseCode?: number;
  response?: string;
  message?: string;
}

export const sendSmtp: SmtpSender = async (settings, mail) => {
  const pinned = settings.address && settings.address !== settings.host;
  const transport = nodemailer.createTransport({
    host: settings.address || settings.host,
    port: settings.port,
    secure: settings.port === 465,
    // Connecting to the checked IP: the certificate is still checked for the server's name.
    ...(pinned && isIP(settings.host) === 0 ? { tls: { servername: settings.host } } : {}),
    ...(settings.username ? { auth: { user: settings.username, pass: settings.password } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: mail.from,
      to: mail.to.join(", "),
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    });
    return { ok: true };
  } catch (error) {
    const failure = error as MailError;
    const where = `${settings.host}:${settings.port}`;
    if (failure.code === "EAUTH") {
      return { ok: false, reason: "the SMTP server refused the user name or password" };
    }
    if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"].includes(failure.code ?? "")) {
      return { ok: false, reason: `couldn't reach the SMTP server at ${where}` };
    }
    const detail = (failure.response ?? failure.message ?? "").replace(/\s+/g, " ").slice(0, 200);
    return {
      ok: false,
      reason: `the SMTP server at ${where} refused the message${detail ? `: ${detail}` : ""}`,
    };
  } finally {
    transport.close();
  }
};
