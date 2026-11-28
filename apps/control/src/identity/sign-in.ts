import { AppError } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { ClientInfo } from "../http/client.ts";
import { hashToken, randomToken } from "../security/tokens.ts";
import type { ControlServices } from "../services.ts";
import {
  claimAttempts,
  clearAttempts,
  isLimited,
  recordAttempt,
  releaseAttempts,
  SIGN_IN_EMAIL_LIMIT,
  SIGN_IN_LIMIT,
  TWO_FACTOR_FAILURE_LIMIT,
  TWO_FACTOR_LIMIT,
} from "./attempts.ts";
import { findPersonByEmail } from "./people.ts";
import { createSession } from "./sessions.ts";
import { verifySecondFactor } from "./two-factor.ts";

/**
 * Signing in (spec 04 4.1). A wrong password gets the same words and takes the same time whether
 * or not the account exists. Ten failures for one email from one address in 15 minutes lock that
 * pair out, counted in the database. Each attempt is counted before its password is checked, so
 * attempts sent all at once can't slip past the limit. With two-factor on, the password alone
 * never creates a session: it opens a 10-minute challenge, and an account takes at most 3 codes
 * per 10 seconds across all its challenges, and no more codes after 10 wrong ones in 15 minutes.
 */

export const INVALID_CREDENTIALS = "Invalid email or password.";
export const TOO_MANY_SIGN_INS =
  "Too many failed sign-in attempts. Wait a few minutes and try again.";
export const INVALID_CODE = "That code is not valid. Try again.";
export const TOO_MANY_CODES = "Too many codes tried. Wait a few seconds and try again.";
export const TOO_MANY_WRONG_CODES =
  "Too many wrong codes for this account. Wait 15 minutes, then sign in again.";
export const CHALLENGE_SECONDS = 10 * 60;
const CHALLENGE_WINDOW_SECONDS = 10;
const CHALLENGE_ATTEMPTS_PER_WINDOW = 3;

export type SignInOutcome =
  | { kind: "session"; personId: string; sessionId: string; token: string }
  | { kind: "two_factor"; personId: string; challengeToken: string };

export interface SignInRequestContext {
  client: ClientInfo;
  userAgent: string | null;
}

export async function signIn(
  services: ControlServices,
  email: string,
  password: string,
  context: SignInRequestContext,
): Promise<SignInOutcome> {
  const { db, log, passwords } = services;
  const pairSubject = `${email}|${context.client.address}`;
  // The attempt is recorded as a failure first and taken back if the password matches.
  const claimed = await claimAttempts(db, [
    { limit: SIGN_IN_LIMIT, subject: pairSubject },
    { limit: SIGN_IN_EMAIL_LIMIT, subject: email },
  ]);
  if (!claimed) throw new AppError("rate_limited", TOO_MANY_SIGN_INS);

  const person = await findPersonByEmail(db, email);
  // Accounts without a password (none are made in 1.0) answer like a wrong password, so this
  // endpoint never says whether an account exists.
  const matches = await passwords.verify(password, person?.password_hash ?? null);
  if (!person || !matches) {
    await recordAudit(
      db,
      log,
      { kind: "person", personId: null, label: email, clientAddress: context.client.address },
      { action: "auth.sign-in-failed", details: { reason: "credentials" } },
    );
    throw new AppError("unauthenticated", INVALID_CREDENTIALS);
  }
  await releaseAttempts(db, claimed);
  await clearAttempts(db, SIGN_IN_LIMIT, pairSubject);
  // A password hash carried over from 0.1.x is replaced with argon2id on its first match
  // (spec 29.5). Only the hash changes: the password, its date and other sessions stay.
  if (passwords.needsRehash(person.password_hash)) {
    await db
      .updateTable("person")
      .set({ password_hash: await passwords.hash(password) })
      .where("id", "=", person.id)
      .where("password_hash", "=", person.password_hash)
      .execute();
  }

  const twoFactor = await db
    .selectFrom("two_factor")
    .select("enabled_at")
    .where("person_id", "=", person.id)
    .executeTakeFirst();
  if (twoFactor?.enabled_at) {
    const challengeToken = randomToken(32);
    await db
      .insertInto("sign_in_challenge")
      .values({
        person_id: person.id,
        token_hash: hashToken(challengeToken),
        client_address: context.client.address,
        expires_at: sql<Date>`now() + make_interval(secs => ${CHALLENGE_SECONDS}::double precision)`,
      })
      .execute();
    return { kind: "two_factor", personId: person.id, challengeToken };
  }

  const session = await createSession(db, {
    personId: person.id,
    clientAddress: context.client.address,
    userAgent: context.userAgent,
  });
  await recordAudit(
    db,
    log,
    { kind: "person", personId: person.id, label: email, clientAddress: context.client.address },
    { action: "auth.sign-in", details: { secondFactor: false } },
  );
  return { kind: "session", personId: person.id, sessionId: session.id, token: session.token };
}

/** Finishes a sign-in with an authenticator code or a backup code. */
export async function completeTwoFactor(
  services: ControlServices,
  challengeToken: string,
  code: string,
  context: SignInRequestContext,
): Promise<{ personId: string; sessionId: string; token: string }> {
  const { db, log } = services;
  const tokenHash = hashToken(challengeToken);

  // Count the attempt before checking the code, in its own transaction, so the limit holds
  // even when many requests arrive at once.
  const challenge = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("sign_in_challenge")
      .select([
        "id",
        "person_id",
        "attempts_in_window",
        sql<boolean>`window_started_at is null or window_started_at < now() - make_interval(secs => ${CHALLENGE_WINDOW_SECONDS}::double precision)`.as(
          "window_over",
        ),
      ])
      .where("token_hash", "=", tokenHash)
      .where("consumed_at", "is", null)
      .where("expires_at", ">", sql<Date>`now()`)
      .forUpdate()
      .executeTakeFirst();
    if (!row) return null;
    const attempts = row.window_over ? 0 : row.attempts_in_window;
    if (attempts >= CHALLENGE_ATTEMPTS_PER_WINDOW) return { ...row, limited: true };
    await trx
      .updateTable("sign_in_challenge")
      .set({
        attempts_in_window: attempts + 1,
        ...(row.window_over ? { window_started_at: sql<Date>`now()` } : {}),
      })
      .where("id", "=", row.id)
      .execute();
    return { ...row, limited: false };
  });

  if (!challenge) {
    throw new AppError(
      "unauthenticated",
      "This sign-in has expired. Enter your email and password again.",
    );
  }
  if (challenge.limited) throw new AppError("rate_limited", TOO_MANY_CODES);

  // The account's own limits hold across challenges: a new sign-in with the password never
  // brings fresh tries.
  if (await isLimited(db, TWO_FACTOR_FAILURE_LIMIT, challenge.person_id)) {
    throw new AppError("rate_limited", TOO_MANY_WRONG_CODES);
  }
  const claimed = await claimAttempts(db, [
    { limit: TWO_FACTOR_LIMIT, subject: challenge.person_id },
  ]);
  if (!claimed) throw new AppError("rate_limited", TOO_MANY_CODES);

  const person = await db
    .selectFrom("person")
    .select(["id", "email"])
    .where("id", "=", challenge.person_id)
    .executeTakeFirstOrThrow();
  const matched = await verifySecondFactor(db, services.secrets, person.id, code, services.now());
  if (!matched) {
    await recordAttempt(db, TWO_FACTOR_FAILURE_LIMIT, person.id);
    await recordAudit(
      db,
      log,
      {
        kind: "person",
        personId: person.id,
        label: person.email,
        clientAddress: context.client.address,
      },
      { action: "auth.two-factor-failed" },
    );
    throw new AppError("unauthenticated", INVALID_CODE, { fields: { code: INVALID_CODE } });
  }

  const consumed = await db
    .updateTable("sign_in_challenge")
    .set({ consumed_at: sql<Date>`now()` })
    .where("id", "=", challenge.id)
    .where("consumed_at", "is", null)
    .executeTakeFirst();
  if (Number(consumed.numUpdatedRows) !== 1) {
    throw new AppError(
      "unauthenticated",
      "This sign-in has expired. Enter your email and password again.",
    );
  }
  await releaseAttempts(db, claimed);
  await clearAttempts(db, TWO_FACTOR_FAILURE_LIMIT, person.id);

  const session = await createSession(db, {
    personId: person.id,
    clientAddress: context.client.address,
    userAgent: context.userAgent,
  });
  await recordAudit(
    db,
    log,
    {
      kind: "person",
      personId: person.id,
      label: person.email,
      clientAddress: context.client.address,
    },
    { action: "auth.sign-in", details: { secondFactor: matched } },
  );
  return { personId: person.id, sessionId: session.id, token: session.token };
}
