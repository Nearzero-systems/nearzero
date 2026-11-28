import { AppError } from "@nearzero/shared";
import { sql } from "kysely";
import QRCode from "qrcode";
import type { Db } from "../db/database.ts";
import type { SecretBox } from "../security/secret-box.ts";
import { hashToken, readableCode } from "../security/tokens.ts";
import { matchTotp, newTotpSecret, otpauthUri } from "../security/totp.ts";

/**
 * Two-factor sign-in (spec 04 4.6): an authenticator secret sealed with the install key, and ten
 * single-use backup codes stored hashed. Codes change only when the person asks (spec 24 G12).
 */

export const BACKUP_CODE_COUNT = 10;
export const DEFAULT_ISSUER = "Nearzero";

function secretContext(personId: string): string {
  return `person:${personId}:totp`;
}

/** Ten codes shaped xxxxx-xxxxx. */
export function newBackupCodes(): string[] {
  return Array.from({ length: BACKUP_CODE_COUNT }, () => `${readableCode(5)}-${readableCode(5)}`);
}

/** Accepts codes typed with or without the dash, in any case, with stray spaces. */
export function normalizeBackupCode(input: string): string | null {
  const compact = input.toLowerCase().replace(/[\s-]/g, "");
  if (!/^[a-z0-9]{10}$/.test(compact)) return null;
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}

async function replaceBackupCodes(db: Db, personId: string, codes: string[]): Promise<void> {
  await db.deleteFrom("two_factor_backup_code").where("person_id", "=", personId).execute();
  await db
    .insertInto("two_factor_backup_code")
    .values(codes.map((code) => ({ person_id: personId, code_hash: hashToken(code) })))
    .execute();
}

export interface TwoFactorStatus {
  enabled: boolean;
  backupCodesLeft: number;
}

export async function twoFactorStatus(db: Db, personId: string): Promise<TwoFactorStatus> {
  const row = await db
    .selectFrom("two_factor")
    .select("enabled_at")
    .where("person_id", "=", personId)
    .executeTakeFirst();
  const enabled = row?.enabled_at != null;
  if (!enabled) return { enabled, backupCodesLeft: 0 };
  const left = await db
    .selectFrom("two_factor_backup_code")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("person_id", "=", personId)
    .where("used_at", "is", null)
    .executeTakeFirstOrThrow();
  return { enabled, backupCodesLeft: Number(left.count) };
}

export interface TwoFactorSetup {
  secret: string;
  otpauthUri: string;
  /** The QR code as an SVG document, drawn on the server. */
  qrSvg: string;
  backupCodes: string[];
}

/**
 * Starts (or restarts) set-up: a new secret and new backup codes that take effect when the first
 * code is confirmed. Refused while two-factor is on.
 */
export async function startSetup(
  db: Db,
  secrets: SecretBox,
  person: { id: string; email: string },
  issuer: string | undefined,
): Promise<TwoFactorSetup> {
  const existing = await db
    .selectFrom("two_factor")
    .select("enabled_at")
    .where("person_id", "=", person.id)
    .executeTakeFirst();
  if (existing?.enabled_at) {
    throw new AppError(
      "conflict",
      "Two-factor sign-in is already on. Use Manage to regenerate backup codes or turn it off.",
    );
  }
  const label = issuer?.trim() || DEFAULT_ISSUER;
  const secret = newTotpSecret();
  const backupCodes = newBackupCodes();
  await db.transaction().execute(async (trx) => {
    await trx
      .insertInto("two_factor")
      .values({
        person_id: person.id,
        secret_sealed: secrets.seal(secret, secretContext(person.id)),
        issuer: label,
        enabled_at: null,
        last_used_step: null,
      })
      .onConflict((conflict) =>
        conflict.column("person_id").doUpdateSet({
          secret_sealed: secrets.seal(secret, secretContext(person.id)),
          issuer: label,
          enabled_at: null,
          last_used_step: null,
          created_at: sql<Date>`now()`,
        }),
      )
      .execute();
    await replaceBackupCodes(trx, person.id, backupCodes);
  });
  const uri = otpauthUri(secret, person.email, label);
  const qrSvg = await QRCode.toString(uri, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
  return { secret, otpauthUri: uri, qrSvg, backupCodes };
}

function openSecret(secrets: SecretBox, personId: string, sealed: string): string {
  const opened = secrets.open(sealed, secretContext(personId));
  if (!opened.ok) {
    throw new AppError(
      "conflict",
      "This account's two-factor secret can't be read on this server anymore. Ask an administrator to run: sudo nearzero reset-2fa",
    );
  }
  return opened.value;
}

/** Confirms set-up with the first code from the authenticator app. */
export async function confirmSetup(
  db: Db,
  secrets: SecretBox,
  personId: string,
  code: string,
  nowMs: number,
): Promise<void> {
  const row = await db
    .selectFrom("two_factor")
    .select(["secret_sealed", "enabled_at"])
    .where("person_id", "=", personId)
    .executeTakeFirst();
  if (!row) {
    throw new AppError(
      "conflict",
      "Start two-factor set-up first: enter your password to get a QR code.",
    );
  }
  if (row.enabled_at) throw new AppError("conflict", "Two-factor sign-in is already on.");
  const step = matchTotp(openSecret(secrets, personId, row.secret_sealed), code, nowMs, null);
  if (step === null) {
    throw new AppError("invalid_request", "That code is not valid. Try again.", {
      fields: { code: "That code is not valid. Try again." },
    });
  }
  await db
    .updateTable("two_factor")
    .set({ enabled_at: sql<Date>`now()`, last_used_step: step })
    .where("person_id", "=", personId)
    .execute();
}

/**
 * Checks a second factor at sign-in: a 6-digit authenticator code (each works once) or an unused
 * backup code (used up by this). Returns which kind matched, or null.
 */
export async function verifySecondFactor(
  db: Db,
  secrets: SecretBox,
  personId: string,
  input: string,
  nowMs: number,
): Promise<"authenticator" | "backup" | null> {
  const code = input.trim();
  const row = await db
    .selectFrom("two_factor")
    .select(["secret_sealed", "enabled_at", "last_used_step"])
    .where("person_id", "=", personId)
    .executeTakeFirst();
  if (!row?.enabled_at) return null;

  if (/^\d{6}$/.test(code)) {
    const step = matchTotp(
      openSecret(secrets, personId, row.secret_sealed),
      code,
      nowMs,
      row.last_used_step,
    );
    if (step === null) return null;
    // Only one request can move the step forward, so a code can't be used twice in a race.
    const updated = await db
      .updateTable("two_factor")
      .set({ last_used_step: step })
      .where("person_id", "=", personId)
      .where((eb) => eb.or([eb("last_used_step", "is", null), eb("last_used_step", "<", step)]))
      .executeTakeFirst();
    return Number(updated.numUpdatedRows) === 1 ? "authenticator" : null;
  }

  // 1.0's codes in their normalized form; codes carried over from 0.1.x were hashed exactly as
  // they were shown (spec 29a.5.1), so the typed text is tried as well.
  const typed = code.trim();
  const candidates = [normalizeBackupCode(code), typed, typed.toUpperCase(), typed.toLowerCase()]
    .filter((item): item is string => item !== null && item !== "")
    .map((item) => hashToken(item));
  if (candidates.length === 0) return null;
  const used = await db
    .updateTable("two_factor_backup_code")
    .set({ used_at: sql<Date>`now()` })
    .where("person_id", "=", personId)
    .where("code_hash", "in", candidates)
    .where("used_at", "is", null)
    .where("id", "=", (eb) =>
      eb
        .selectFrom("two_factor_backup_code")
        .select((inner) => inner.fn.min("id").as("id"))
        .where("person_id", "=", personId)
        .where("code_hash", "in", candidates)
        .where("used_at", "is", null),
    )
    .executeTakeFirst();
  return Number(used.numUpdatedRows) === 1 ? "backup" : null;
}

/** New backup codes, only because the person asked; the old ones stop working. */
export async function regenerateBackupCodes(db: Db, personId: string): Promise<string[]> {
  const status = await twoFactorStatus(db, personId);
  if (!status.enabled) {
    throw new AppError(
      "conflict",
      "Two-factor sign-in is off, so there are no backup codes to replace.",
    );
  }
  const codes = newBackupCodes();
  await db.transaction().execute((trx) => replaceBackupCodes(trx, personId, codes));
  return codes;
}

/** Turns two-factor sign-in off and removes its secret and codes. Returns whether it was on. */
export async function disableTwoFactor(db: Db, personId: string): Promise<boolean> {
  return db.transaction().execute(async (trx) => {
    const removed = await trx
      .deleteFrom("two_factor")
      .where("person_id", "=", personId)
      .returning("enabled_at")
      .executeTakeFirst();
    await trx.deleteFrom("two_factor_backup_code").where("person_id", "=", personId).execute();
    return removed?.enabled_at != null;
  });
}
