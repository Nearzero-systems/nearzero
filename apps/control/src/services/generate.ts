import { randomBytes } from "node:crypto";
import { APP_NAME_SUFFIX_LENGTH, GENERATED_PASSWORD_LENGTH } from "@nearzero/shared";

/**
 * Random parts of a service: generated database passwords (spec 08 8.1: 24 letters and digits
 * from a secure generator) and the 6-character suffix that makes an app name unique (spec 06 6.1).
 */

const LETTERS_AND_DIGITS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER_AND_DIGITS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Uniform random text over an alphabet: bytes past the last whole multiple are thrown away. */
function randomText(alphabet: string, length: number): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}

export function generatePassword(length = GENERATED_PASSWORD_LENGTH): string {
  return randomText(LETTERS_AND_DIGITS, length);
}

export function appNameSuffix(): string {
  return randomText(LOWER_AND_DIGITS, APP_NAME_SUFFIX_LENGTH);
}
