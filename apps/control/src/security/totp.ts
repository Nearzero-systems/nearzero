import { createHmac, randomBytes } from "node:crypto";
import { constantTimeEqual } from "./tokens.ts";

/**
 * Time-based one-time passwords per RFC 6238 (HMAC-SHA1, 6 digits, 30-second steps), the kind
 * every authenticator app reads from an otpauth:// link. Secrets are shown in base32 (RFC 4648).
 */

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes from one step before or after now are accepted, for clocks that drift a little. */
const DRIFT_STEPS = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error("The secret is not valid base32.");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32-encoded. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const binary =
    (((digest[offset] ?? 0) & 0x7f) << 24) |
    ((digest[offset + 1] ?? 0) << 16) |
    ((digest[offset + 2] ?? 0) << 8) |
    (digest[offset + 3] ?? 0);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Finds the step a code belongs to, near the given time, or null. Steps at or before
 * `lastUsedStep` are refused, so a code works once.
 */
export function matchTotp(
  secret: string,
  code: string,
  atMs: number,
  lastUsedStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(atMs);
  let found: number | null = null;
  // Check every candidate so the time taken doesn't say which one matched.
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    if (constantTimeEqual(totpCode(secret, step), code) && found === null) found = step;
  }
  if (found === null) return null;
  if (lastUsedStep !== null && found <= lastUsedStep) return null;
  return found;
}

/** The link authenticator apps read from the QR code. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
