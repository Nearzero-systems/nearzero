/**
 * "Generate" in the Add user dialog (spec 04 4.7): 16 characters without look-alike letters
 * (no 0/O/o, 1/l/I/i). Built from random bytes, which browsers offer even on plain HTTP
 * (spec 21.9); bytes that would bias the choice are skipped.
 */

export const PASSWORD_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const GENERATED_LENGTH = 16;

export function generatePassword(
  randomBytes: (count: number) => Uint8Array,
  length = GENERATED_LENGTH,
): string {
  const size = PASSWORD_ALPHABET.length;
  const limit = 256 - (256 % size);
  let result = "";
  while (result.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      result += PASSWORD_ALPHABET[byte % size];
      if (result.length === length) break;
    }
  }
  return result;
}
