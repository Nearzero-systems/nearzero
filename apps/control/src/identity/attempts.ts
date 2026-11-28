import { AppError } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";

/**
 * Counting failed attempts in the database, so limits survive a restart and hold across several
 * control-plane processes (spec 24 G10).
 */

export interface AttemptLimit {
  bucket: string;
  max: number;
  windowSeconds: number;
}

/** 10 failed sign-ins for one email from one client address in 15 minutes (spec 22.4, rule 9). */
export const SIGN_IN_LIMIT: AttemptLimit = { bucket: "sign-in", max: 10, windowSeconds: 15 * 60 };

/**
 * A backstop across all addresses for one email, so a password can't be guessed from many
 * addresses at once. High enough that it never trips for a person who mistypes.
 */
export const SIGN_IN_EMAIL_LIMIT: AttemptLimit = {
  bucket: "sign-in-email",
  max: 50,
  windowSeconds: 15 * 60,
};

/** Wrong current passwords on Profile and in two-factor management, per account. */
export const PASSWORD_CHECK_LIMIT: AttemptLimit = {
  bucket: "password-check",
  max: 10,
  windowSeconds: 15 * 60,
};

/**
 * Authenticator and backup codes per account, across every sign-in challenge it opens, so signing
 * in again never buys more guesses (spec 22.4 rule 9: 3 two-factor attempts per 10 seconds).
 */
export const TWO_FACTOR_LIMIT: AttemptLimit = {
  bucket: "two-factor",
  max: 3,
  windowSeconds: 10,
};

/** Wrong codes per account before codes are refused for a while, whoever holds the password. */
export const TWO_FACTOR_FAILURE_LIMIT: AttemptLimit = {
  bucket: "two-factor-failed",
  max: 10,
  windowSeconds: 15 * 60,
};

/** Confirmation links an account asks to have sent again (spec 04 4.6). */
export const EMAIL_CONFIRMATION_LIMIT: AttemptLimit = {
  bucket: "email-confirmation",
  max: 5,
  windowSeconds: 60 * 60,
};

/** Email changes per account, so they can't be used to probe which addresses have accounts. */
export const EMAIL_CHANGE_LIMIT: AttemptLimit = {
  bucket: "email-change",
  max: 5,
  windowSeconds: 60 * 60,
};

/**
 * Sign-ups from one client address (31d G4-14, spec 22.4 rule 9): a burst of 3 in 10 seconds,
 * and 10 in 15 minutes, so neither accounts nor "an account already exists" answers come as fast
 * as requests can be sent.
 */
export const REGISTER_BURST_LIMIT: AttemptLimit = {
  bucket: "register-burst",
  max: 3,
  windowSeconds: 10,
};
export const REGISTER_LIMIT: AttemptLimit = {
  bucket: "register",
  max: 10,
  windowSeconds: 15 * 60,
};

/** A limit that was reached, with how long until the next attempt is allowed. */
export class AttemptsLimited extends AppError {
  constructor(
    message: (seconds: number) => string,
    readonly retryAfterSeconds: number,
  ) {
    super("rate_limited", message(retryAfterSeconds));
    this.name = "AttemptsLimited";
  }
}

/** Seconds until the oldest attempt in a full window ages out, at least 1. */
export async function secondsUntilAllowed(
  db: Db,
  limits: readonly AttemptLimit[],
  subject: string,
): Promise<number> {
  let wait = 1;
  for (const limit of limits) {
    if ((await countAttempts(db, limit, subject)) < limit.max) continue;
    const row = await db
      .selectFrom("attempt_record")
      .select(
        sql<number>`ceil(extract(epoch from (attempted_at + make_interval(secs => ${limit.windowSeconds}::double precision) - now())))`.as(
          "seconds",
        ),
      )
      .where("bucket", "=", limit.bucket)
      .where("subject", "=", subject)
      .where(
        "attempted_at",
        ">",
        sql<Date>`now() - make_interval(secs => ${limit.windowSeconds}::double precision)`,
      )
      .orderBy("attempted_at", "desc")
      .offset(limit.max - 1)
      .limit(1)
      .executeTakeFirst();
    wait = Math.max(wait, Number(row?.seconds ?? 1));
  }
  return wait;
}

export async function countAttempts(db: Db, limit: AttemptLimit, subject: string): Promise<number> {
  const row = await db
    .selectFrom("attempt_record")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("bucket", "=", limit.bucket)
    .where("subject", "=", subject)
    .where(
      "attempted_at",
      ">",
      sql<Date>`now() - make_interval(secs => ${limit.windowSeconds}::double precision)`,
    )
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function isLimited(db: Db, limit: AttemptLimit, subject: string): Promise<boolean> {
  return (await countAttempts(db, limit, subject)) >= limit.max;
}

export async function recordAttempt(db: Db, limit: AttemptLimit, subject: string): Promise<void> {
  await db.insertInto("attempt_record").values({ bucket: limit.bucket, subject }).execute();
}

export async function clearAttempts(db: Db, limit: AttemptLimit, subject: string): Promise<void> {
  await db
    .deleteFrom("attempt_record")
    .where("bucket", "=", limit.bucket)
    .where("subject", "=", subject)
    .execute();
}

export interface AttemptClaim {
  limit: AttemptLimit;
  subject: string;
}

/**
 * Counts and records attempts in one step, before the guarded check runs: each subject is locked
 * for the length of the transaction, so attempts sent at once are counted one after another and
 * the limit holds however many arrive together. Returns the recorded rows, which the caller
 * removes again when the attempt turns out fine, or null (nothing recorded) when any limit is
 * already reached.
 */
export async function claimAttempts(db: Db, claims: AttemptClaim[]): Promise<number[] | null> {
  return db.transaction().execute(async (trx) => {
    for (const claim of claims) {
      await sql`select pg_advisory_xact_lock(hashtextextended(${`attempt:${claim.limit.bucket}:${claim.subject}`}, 0))`.execute(
        trx,
      );
    }
    for (const claim of claims) {
      if ((await countAttempts(trx, claim.limit, claim.subject)) >= claim.limit.max) return null;
    }
    const ids: number[] = [];
    for (const claim of claims) {
      const row = await trx
        .insertInto("attempt_record")
        .values({ bucket: claim.limit.bucket, subject: claim.subject })
        .returning("id")
        .executeTakeFirstOrThrow();
      ids.push(Number(row.id));
    }
    return ids;
  });
}

/** Takes back attempts recorded by claimAttempts that turned out not to be failures. */
export async function releaseAttempts(db: Db, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await db.deleteFrom("attempt_record").where("id", "in", ids).execute();
}
