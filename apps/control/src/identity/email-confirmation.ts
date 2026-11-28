import { AppError } from "@nearzero/shared";
import { sql } from "kysely";
import { type AuditActor, recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import {
  EMAIL_CONFIRMATION_HOURS,
  emailChangedNotice,
  emailConfirmationEmail,
} from "../email/messages.ts";
import { addressMailRoute } from "../email/transport.ts";
import { type Actor, auditActor } from "../http/actor.ts";
import { hashToken, randomToken } from "../security/tokens.ts";
import type { ControlServices } from "../services.ts";
import {
  claimAttempts,
  EMAIL_CHANGE_LIMIT,
  EMAIL_CONFIRMATION_LIMIT,
  releaseAttempts,
} from "./attempts.ts";
import { findPersonByEmail } from "./people.ts";

/**
 * Proving an email address (spec 04 4.6, 30a R1-02, B1-63). A changed address counts only once
 * the person opens the link sent to it while signed in as that account; until then the old address
 * stays the account's address, for sign-in, invitations and the bell, so nobody can take an
 * address they don't receive mail at. An account whose own address was never proven (an
 * invitation emailed through a workspace's own settings, for example) can ask for a link to it
 * from Profile. One link per account at a time, for 24 hours.
 *
 * These links and the notice to an old address go only through the install's email settings,
 * never a workspace's own (C1-01): whoever runs a workspace chooses its mail server, so a link
 * that travelled through it proves nothing. Without install email, an instance administrator
 * changes or confirms an address instead (Members, or `sudo nearzero set-email`).
 */

export const ADDRESS_IN_USE =
  "Another account already uses this email address. Use a different one.";
export const NO_CONFIRMATION_EMAIL =
  "This server can't send email, so a new address can't be confirmed. Ask a Nearzero administrator to change it in Members, or run sudo nearzero set-email on the server.";
/** The same refusal when the address to confirm is the account's own (30a R1-02). */
export const NO_OWN_CONFIRMATION_EMAIL =
  "This server can't send email, so your address can't be confirmed by email. Ask a Nearzero administrator to confirm it in Members, or run sudo nearzero set-email on the server.";
export const NO_CONSOLE_ADDRESS_FOR_LINK =
  "This server has no console address set, so there's no link to send. Ask a Nearzero administrator to set it.";
const EXPIRED_LINK =
  "This link has expired or was already used. Ask for a new one from your profile.";

/** The address a live link would change the account to, or null. */
export async function pendingEmailOf(db: Db, personId: string): Promise<string | null> {
  const row = await db
    .selectFrom("email_confirmation as c")
    .innerJoin("person as p", "p.id", "c.person_id")
    .select(["c.email", "p.email as current"])
    .where("c.person_id", "=", personId)
    .where("c.expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  return row && row.email !== row.current ? row.email : null;
}

function confirmationLink(services: ControlServices, token: string): string {
  const base = services.consoleUrl();
  if (!base) throw new AppError("conflict", NO_CONSOLE_ADDRESS_FOR_LINK);
  return `${base.replace(/\/+$/, "")}/confirm-email?token=${encodeURIComponent(token)}`;
}

/**
 * Saves a new link for `email` (replacing any earlier one) and emails it there. Nothing is kept
 * when the email can't go out, so the person isn't left waiting for a link that never comes.
 */
async function sendLink(
  services: ControlServices,
  personId: string,
  email: string,
  current: string,
): Promise<void> {
  const { db } = services;
  const route = addressMailRoute(services);
  if (!route) {
    throw new AppError(
      "conflict",
      email === current ? NO_OWN_CONFIRMATION_EMAIL : NO_CONFIRMATION_EMAIL,
    );
  }
  const token = randomToken(32);
  const link = confirmationLink(services, token);
  await db
    .insertInto("email_confirmation")
    .values({
      person_id: personId,
      email,
      token_hash: hashToken(token),
      expires_at: sql<Date>`now() + make_interval(hours => ${EMAIL_CONFIRMATION_HOURS}::integer)`,
    })
    .onConflict((conflict) =>
      conflict.column("person_id").doUpdateSet({
        email,
        token_hash: hashToken(token),
        created_at: sql<Date>`now()`,
        expires_at: sql<Date>`now() + make_interval(hours => ${EMAIL_CONFIRMATION_HOURS}::integer)`,
      }),
    )
    .execute();
  const sent = await route.send(
    emailConfirmationEmail({ to: email, replacing: email === current ? null : current, link }),
  );
  if (!sent.sent) {
    await db.deleteFrom("email_confirmation").where("person_id", "=", personId).execute();
    throw new AppError(
      "conflict",
      `The confirmation email to ${email} couldn't be sent. ${sent.reason}`,
    );
  }
}

/**
 * Starts a change of the account's email: a link goes to the new address, and the old one stays
 * in use until it is opened. The caller has checked the current password.
 */
export async function startEmailChange(
  services: ControlServices,
  actor: Actor,
  email: string,
): Promise<void> {
  const { db } = services;
  const claimed = await claimAttempts(db, [{ limit: EMAIL_CHANGE_LIMIT, subject: actor.personId }]);
  if (!claimed) {
    throw new AppError(
      "rate_limited",
      "Too many email changes in the last hour. Wait a while and try again.",
    );
  }
  if (email === actor.email) {
    throw new AppError("invalid_request", "That is already your email address.", {
      fields: { email: "That is already your email address." },
    });
  }
  if (await findPersonByEmail(db, email)) {
    throw new AppError("conflict", ADDRESS_IN_USE, {
      fields: { email: "Another account already uses this email address." },
    });
  }
  await sendLink(services, actor.personId, email, actor.email);
  await recordAudit(db, services.log, auditActor(actor), {
    action: "person.email-change-requested",
    target: { kind: "person", id: actor.personId },
    details: { from: actor.email, to: email },
  });
}

/**
 * Sends the link again: to the address a change is waiting for, else to the account's own address
 * when it was never proven.
 */
export async function resendConfirmation(
  services: ControlServices,
  actor: Actor,
): Promise<{ sentTo: string }> {
  const { db } = services;
  const person = await db
    .selectFrom("person")
    .select(["email", "email_verified_at"])
    .where("id", "=", actor.personId)
    .executeTakeFirstOrThrow();
  const pending = await pendingEmailOf(db, actor.personId);
  const target = pending ?? (person.email_verified_at === null ? person.email : null);
  if (!target) {
    throw new AppError("conflict", "Your email address is already confirmed.");
  }
  const claimed = await claimAttempts(db, [
    { limit: EMAIL_CONFIRMATION_LIMIT, subject: actor.personId },
  ]);
  if (!claimed) {
    throw new AppError(
      "rate_limited",
      "Too many confirmation emails in the last hour. Wait a while and try again.",
    );
  }
  try {
    await sendLink(services, actor.personId, target, person.email);
  } catch (error) {
    await releaseAttempts(db, claimed);
    throw error;
  }
  return { sentTo: target };
}

/** Takes back a change that hasn't been confirmed; the current address stays. */
export async function cancelEmailChange(services: ControlServices, actor: Actor): Promise<void> {
  await services.db
    .deleteFrom("email_confirmation")
    .where("person_id", "=", actor.personId)
    .where("email", "!=", actor.email)
    .execute();
}

/**
 * Opens a link as the signed-in account: its address becomes the account's, confirmed. A link
 * made for another account, expired or already used changes nothing.
 */
export async function confirmEmail(
  services: ControlServices,
  actor: Actor,
  token: string,
): Promise<{ email: string; changed: boolean; noticeSent: boolean }> {
  const { db } = services;
  const row = await db
    .selectFrom("email_confirmation")
    .select(["person_id", "email"])
    .where("token_hash", "=", hashToken(token))
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  if (!row) throw new AppError("not_found", EXPIRED_LINK);
  if (row.person_id !== actor.personId) {
    throw new AppError(
      "forbidden",
      "This link was sent for another Nearzero account. Sign in as that account, then open it again.",
    );
  }
  const previous = actor.email;
  const changed = row.email !== previous;
  try {
    await db.transaction().execute(async (trx) => {
      const used = await trx
        .deleteFrom("email_confirmation")
        .where("person_id", "=", actor.personId)
        .where("token_hash", "=", hashToken(token))
        .executeTakeFirst();
      if (Number(used.numDeletedRows) !== 1) throw new AppError("not_found", EXPIRED_LINK);
      await trx
        .updateTable("person")
        .set({ email: row.email, email_verified_at: sql<Date>`now()`, updated_at: new Date() })
        .where("id", "=", actor.personId)
        .execute();
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      // Someone else took the address while the link waited.
      await db.deleteFrom("email_confirmation").where("person_id", "=", actor.personId).execute();
      throw new AppError("conflict", ADDRESS_IN_USE);
    }
    throw error;
  }
  let noticeSent = false;
  if (changed) {
    // Through the install's settings only, so no workspace's mail server can keep it from the
    // old address (C1-01, spec 24 G9).
    const route = addressMailRoute(services);
    noticeSent = route
      ? (await route.send(emailChangedNotice({ to: previous, newEmail: row.email }))).sent
      : false;
  }
  await recordAudit(db, services.log, auditActor(actor), {
    action: changed ? "person.email-changed" : "person.email-confirmed",
    target: { kind: "person", id: actor.personId },
    details: changed ? { from: previous, to: row.email, noticeSent } : { email: row.email },
  });
  return { email: row.email, changed, noticeSent };
}

export interface VouchedEmailResult {
  /** The address before; the same as `email` when an unconfirmed address was only confirmed. */
  from: string;
  email: string;
  changed: boolean;
  /** False when the address was already the account's and already confirmed. */
  updated: boolean;
  sessionsEnded: number;
}

/**
 * Sets an account's address on someone's word (G1-02 and the decision in spec 31): an instance
 * administrator in Members, on a server that can't send email, or the server's root through
 * `sudo nearzero set-email`. They vouch for it as they do when adding someone with a password,
 * so it counts as confirmed at once. Giving the account's own unconfirmed address confirms it.
 * Any link waiting for the account stops working, every session of the account ends, and the
 * change is audited.
 */
export async function setVouchedEmail(
  services: ControlServices,
  personId: string,
  email: string,
  audit: { actor: AuditActor; workspaceId?: string | null },
): Promise<VouchedEmailResult> {
  const { db } = services;
  const person = await db
    .selectFrom("person")
    .select(["email", "email_verified_at"])
    .where("id", "=", personId)
    .executeTakeFirstOrThrow();
  const changed = person.email !== email;
  if (!changed && person.email_verified_at !== null) {
    return { from: person.email, email, changed, updated: false, sessionsEnded: 0 };
  }
  if (changed && (await findPersonByEmail(db, email))) {
    throw new AppError("conflict", ADDRESS_IN_USE, {
      fields: { email: "Another account already uses this email address." },
    });
  }
  let sessionsEnded = 0;
  try {
    sessionsEnded = await db.transaction().execute(async (trx) => {
      await trx
        .updateTable("person")
        .set({ email, email_verified_at: sql<Date>`now()`, updated_at: new Date() })
        .where("id", "=", personId)
        .execute();
      await trx.deleteFrom("email_confirmation").where("person_id", "=", personId).execute();
      if (!changed) return 0;
      const ended = await trx
        .deleteFrom("person_session")
        .where("person_id", "=", personId)
        .executeTakeFirst();
      return Number(ended.numDeletedRows);
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AppError("conflict", ADDRESS_IN_USE, {
        fields: { email: "Another account already uses this email address." },
      });
    }
    throw error;
  }
  await recordAudit(db, services.log, audit.actor, {
    action: changed ? "person.email-set" : "person.email-confirmed",
    workspaceId: audit.workspaceId ?? null,
    target: { kind: "person", id: personId },
    details: changed
      ? { from: person.email, to: email, vouched: true, sessionsEnded }
      : { email, vouched: true },
  });
  return { from: person.email, email, changed, updated: true, sessionsEnded };
}
