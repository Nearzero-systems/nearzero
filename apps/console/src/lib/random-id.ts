/**
 * Random ids for the browser (spec 21.9). Plain HTTP hides the browser's UUID generator and its
 * subtle crypto API, so ids come from getRandomValues, which every browser has in every context.
 */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** The largest multiple of the alphabet size below 256: bytes at or above it are redrawn. */
const ACCEPT_BELOW = 256 - (256 % ALPHABET.length);

export interface RandomBytesSource {
  getRandomValues<T extends ArrayBufferView | null>(array: T): T;
}

function defaultSource(): RandomBytesSource {
  const source = globalThis.crypto;
  if (!source || typeof source.getRandomValues !== "function") {
    throw new Error("This browser has no random number source. Update the browser and try again.");
  }
  return source;
}

/** A lowercase letters-and-digits id, optionally after `prefix_`. No modulo bias. */
export function randomId(
  length = 16,
  prefix = "",
  source: RandomBytesSource = defaultSource(),
): string {
  if (!Number.isInteger(length) || length < 1 || length > 128) {
    throw new RangeError("An id is 1 to 128 characters long.");
  }
  let out = "";
  const bytes = new Uint8Array(length * 2);
  while (out.length < length) {
    source.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= ACCEPT_BELOW) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return prefix ? `${prefix}_${out}` : out;
}
