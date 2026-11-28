import { AppError, type emailSettingsRequestSchema, maskKey } from "@nearzero/shared";
import type { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { testEmail } from "../email/messages.ts";
import {
  instanceRoute,
  internalSmtpMessage,
  secretContext,
  UNREADABLE_EMAIL_KEY,
  workspaceRoute,
} from "../email/transport.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import { checkOutboundHost, OutboundRefused, systemResolve } from "../security/outbound.ts";
import type { ControlServices } from "../services.ts";
import { storeWorkspaceSecret } from "./keys.ts";

/**
 * The "Invitation emails" strip and dialog (spec 04 4.7): a workspace's own Resend key or SMTP
 * server (decision D4), else the install's email settings, else links to share by hand. Saving
 * sends a test to the person who saved.
 */

export interface EmailSettingsView {
  on: boolean;
  source: "workspace" | "instance" | "none";
  /** The strip's detail line. */
  detail: string;
  workspace: null | {
    provider: "resend" | "smtp";
    sender: string;
    /** The Resend key or SMTP password, masked; null when none is saved. */
    maskedSecret: string | null;
    /** False when the saved key can't be decrypted any more ("Paste it again"). */
    secretReadable: boolean;
    smtp: {
      host: string;
      port: number;
      security: "tls" | "starttls" | "none";
      username: string;
    } | null;
    savedAt: string;
    savedBy: { id: string; name: string } | null;
  };
  canManage: boolean;
  /** Whether "Set a password" is offered in Add user. */
  canAddWithPassword: boolean;
  /**
   * Why this server's own email settings can't be used, for people who manage email here, or
   * null (30a R1-04). Invitations then fall back to links.
   */
  serverProblem: string | null;
}

/** What an SMTP password shows instead of any of its characters (B1-50, spec 23.4.3). */
export const SAVED_SECRET_LABEL = "Saved";

export async function emailSettingsView(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<EmailSettingsView> {
  await actor.access.require("members.see");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  const row = await db
    .selectFrom("workspace_email as e")
    .leftJoin("person as p", "p.id", "e.saved_by")
    .selectAll("e")
    .select(["p.id as saver_id", "p.email", "p.first_name", "p.last_name"])
    .where("e.workspace_id", "=", workspaceId)
    .executeTakeFirst();
  const canManage = actor.access.can("workspace-email.manage");
  const canAddWithPassword =
    actor.access.can("members.add-with-password") && !actor.workspace.personal;
  const serverProblem = canManage ? services.instanceEmailProblem : null;

  if (row) {
    const secretKind = row.provider === "resend" ? "email-resend-key" : "email-smtp-password";
    const secret = await db
      .selectFrom("workspace_secret")
      .select(["sealed", "masked"])
      .where("workspace_id", "=", workspaceId)
      .where("kind", "=", secretKind)
      .executeTakeFirst();
    const readable = secret
      ? services.secrets.open(secret.sealed, secretContext(workspaceId, secretKind)).ok
      : true;
    return {
      on: true,
      source: "workspace",
      detail:
        row.provider === "resend"
          ? `Sent from ${row.sender} with your Resend key ${secret?.masked ?? ""}.`.replace(
              " .",
              ".",
            )
          : `Sent from ${row.sender} through ${row.smtp_host}:${row.smtp_port}.`,
      workspace: {
        provider: row.provider,
        sender: row.sender,
        // A password shows nothing of itself; a Resend key keeps its short masked form.
        maskedSecret: secret
          ? row.provider === "smtp"
            ? SAVED_SECRET_LABEL
            : secret.masked
          : null,
        secretReadable: readable,
        smtp:
          row.provider === "smtp"
            ? {
                host: row.smtp_host ?? "",
                port: row.smtp_port ?? 587,
                security: row.smtp_security ?? "starttls",
                username: row.smtp_username ?? "",
              }
            : null,
        savedAt: row.saved_at.toISOString(),
        savedBy:
          row.saver_id && row.email
            ? {
                id: row.saver_id,
                name: displayName({
                  first_name: row.first_name,
                  last_name: row.last_name,
                  email: row.email,
                }),
              }
            : null,
      },
      canManage,
      canAddWithPassword,
      serverProblem,
    };
  }
  if (instanceRoute(services)) {
    return {
      on: true,
      source: "instance",
      detail: "Sent with this server's email settings.",
      workspace: null,
      canManage,
      canAddWithPassword,
      serverProblem,
    };
  }
  return {
    on: false,
    source: "none",
    detail: "New invitations give you a link to send yourself",
    workspace: null,
    canManage,
    canAddWithPassword,
    serverProblem,
  };
}

type EmailSettingsInput = z.output<typeof emailSettingsRequestSchema>;

export const SMTP_PASSWORD_AGAIN =
  "Enter the SMTP password again: the saved one is only sent to the server it was saved for.";

/** Saves the workspace's email settings, then sends a test to the person saving. */
export async function saveEmailSettings(
  services: ControlServices,
  actor: WorkspaceActor,
  input: EmailSettingsInput,
): Promise<{ settings: EmailSettingsView; testSent: boolean; message: string }> {
  await actor.access.require("workspace-email.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  const current = await db
    .selectFrom("workspace_email")
    .select(["provider", "smtp_host", "smtp_port", "smtp_security", "smtp_username"])
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirst();
  const secretKind = input.provider === "resend" ? "email-resend-key" : "email-smtp-password";
  const saved = await db
    .selectFrom("workspace_secret")
    .select("sealed")
    .where("workspace_id", "=", workspaceId)
    .where("kind", "=", secretKind)
    .executeTakeFirst();
  const savedReadable =
    saved !== undefined &&
    services.secrets.open(saved.sealed, secretContext(workspaceId, secretKind)).ok;
  const sameProvider = current?.provider === input.provider;

  // A workspace's SMTP server is never this machine, a private network or a cloud's metadata
  // address unless an instance administrator saves it (C1-05, spec 23.9): refused before anything
  // is saved or any connection is made.
  if (input.provider === "smtp") {
    try {
      await checkOutboundHost(
        input.host,
        services.resolveHost ?? systemResolve,
        actor.isInstanceAdmin,
      );
    } catch (error) {
      if (!(error instanceof OutboundRefused)) throw error;
      const message =
        error.kind === "internal"
          ? internalSmtpMessage(input.host)
          : `Nearzero couldn't look up ${input.host}. Check the SMTP server's host name.`;
      throw new AppError("invalid_request", message, { fields: { host: message } });
    }
  }

  let newSecret: string | null = null;
  if (input.provider === "resend") {
    const key = input.apiKey?.trim() ?? "";
    if (key === "") {
      if (!sameProvider || !saved) {
        throw new AppError("invalid_request", "Paste your Resend API key.", {
          fields: { apiKey: "Paste your Resend API key." },
        });
      }
      if (!savedReadable) {
        throw new AppError("invalid_request", UNREADABLE_EMAIL_KEY, {
          fields: { apiKey: UNREADABLE_EMAIL_KEY },
        });
      }
    } else {
      if (!key.startsWith("re_")) {
        const message = "That doesn't look like a Resend API key. Resend keys start with re_.";
        throw new AppError("invalid_request", message, { fields: { apiKey: message } });
      }
      newSecret = key;
    }
  } else {
    const password = input.password ?? "";
    if (password === "") {
      if (input.username !== "") {
        if (!sameProvider || !saved) {
          throw new AppError("invalid_request", "Enter the SMTP password.", {
            fields: { password: "Enter the SMTP password." },
          });
        }
        if (!savedReadable) {
          throw new AppError("invalid_request", UNREADABLE_EMAIL_KEY, {
            fields: { password: UNREADABLE_EMAIL_KEY },
          });
        }
        // The saved password only ever goes where it was saved for (B1-51, the rule 15.2 sets
        // for channels): another server, port, security or user name needs it typed again.
        const sameDestination =
          current?.smtp_host === input.host &&
          current?.smtp_port === input.port &&
          current?.smtp_security === input.security &&
          current?.smtp_username === input.username;
        if (!sameDestination) {
          throw new AppError("invalid_request", SMTP_PASSWORD_AGAIN, {
            fields: { password: SMTP_PASSWORD_AGAIN },
          });
        }
      }
    } else {
      newSecret = password;
    }
  }

  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("workspace_email")
      .values({
        workspace_id: workspaceId,
        provider: input.provider,
        sender: input.from,
        smtp_host: input.provider === "smtp" ? input.host : null,
        smtp_port: input.provider === "smtp" ? input.port : null,
        smtp_security: input.provider === "smtp" ? input.security : null,
        smtp_username: input.provider === "smtp" ? input.username : null,
        internal_allowed: input.provider === "smtp" && actor.isInstanceAdmin,
        saved_by: actor.personId,
      })
      .onConflict((conflict) =>
        conflict.column("workspace_id").doUpdateSet({
          provider: input.provider,
          sender: input.from,
          smtp_host: input.provider === "smtp" ? input.host : null,
          smtp_port: input.provider === "smtp" ? input.port : null,
          smtp_security: input.provider === "smtp" ? input.security : null,
          smtp_username: input.provider === "smtp" ? input.username : null,
          internal_allowed: input.provider === "smtp" && actor.isInstanceAdmin,
          saved_by: actor.personId,
          saved_at: new Date(),
        }),
      )
      .execute();
    // Only the chosen provider's secret is kept.
    await trx
      .deleteFrom("workspace_secret")
      .where("workspace_id", "=", workspaceId)
      .where("kind", "=", input.provider === "resend" ? "email-smtp-password" : "email-resend-key")
      .execute();
    if (input.provider === "smtp" && input.username === "" && newSecret === null) {
      await trx
        .deleteFrom("workspace_secret")
        .where("workspace_id", "=", workspaceId)
        .where("kind", "=", "email-smtp-password")
        .execute();
    }
    if (newSecret !== null) {
      await storeWorkspaceSecret(trx, services, workspaceId, secretKind, newSecret, actor.personId);
    }
  });

  await recordAudit(db, services.log, auditActor(actor), {
    action: "email-settings.saved",
    workspaceId,
    details: {
      provider: input.provider,
      sender: input.from,
      // Passwords leave nothing of themselves in the audit trail (B1-50).
      ...(newSecret && input.provider === "resend" ? { masked: maskKey(newSecret) } : {}),
      ...(input.provider === "smtp" ? { smtpHost: input.host } : {}),
    },
  });

  const route = await workspaceRoute(services, workspaceId);
  const result = route
    ? await route.send(testEmail({ to: actor.email, workspaceName: actor.workspace.name }))
    : { sent: false as const, reason: "The settings couldn't be read back." };
  const message = result.sent
    ? `Saved. A test email was sent to ${actor.email}. Check that it arrived.`
    : `Saved, but the test email to ${actor.email} failed. ${result.reason}`;
  return { settings: await emailSettingsView(services, actor), testSent: result.sent, message };
}

/** Turns the workspace's own invitation emails off; invitations fall back to the install's or links. */
export async function removeEmailSettings(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<EmailSettingsView> {
  await actor.access.require("workspace-email.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  await db.transaction().execute(async (trx) => {
    await trx.deleteFrom("workspace_email").where("workspace_id", "=", workspaceId).execute();
    await trx
      .deleteFrom("workspace_secret")
      .where("workspace_id", "=", workspaceId)
      .where("kind", "in", ["email-resend-key", "email-smtp-password"])
      .execute();
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "email-settings.removed",
    workspaceId,
  });
  return emailSettingsView(services, actor);
}
