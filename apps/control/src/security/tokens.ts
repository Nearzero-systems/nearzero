import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Random tokens, their stored hashes, and comparisons that take the same time whatever the input
 * (spec 22.4, rule 7). Tokens are base64url so they fit in cookies and links unchanged.
 */

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** What the database keeps for a token: its SHA-256, never the token itself. */
export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hmac(key: Buffer, message: string): Buffer {
  return createHmac("sha256", key).update(message, "utf8").digest();
}

/** Compares two strings in time that depends only on their lengths. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still do the work so a length mismatch isn't faster than a content mismatch.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const READABLE = "abcdefghjkmnpqrstuvwxyz23456789";

/** Random text from letters and digits that can't be confused (no l, 1, o, 0, i). */
export function readableCode(length: number): string {
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    const byte = bytes[i] ?? 0;
    // Reject the top of the range so every character is equally likely.
    if (byte >= 256 - (256 % READABLE.length)) continue;
    out += READABLE[byte % READABLE.length];
  }
  return out.length === length ? out : readableCode(length);
}
