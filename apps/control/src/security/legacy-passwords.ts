import { scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashes carried over from 0.1.x (spec 29.5, "Identity"): the export bundle declares
 * each hash with its algorithm and parameters, 1.0 keeps it as is, checks it at sign-in, and
 * replaces it with an argon2id hash on the first successful sign-in.
 *
 * Supported: scrypt in its common encodings (a PHC string "$scrypt$ln=…,r=…,p=…$salt$key", the
 * "scrypt:N:r:p$salt$hexkey" form, and "salt:key" with the parameters declared beside it, as
 * spec 29a.5.1 gives them: N, r, p, saltEncoding "utf8", keyEncoding "hex",
 * passwordNormalization "NFKC"), bcrypt ("$2a$", "$2b$", "$2y$") and argon2 PHC strings. A declared hash is checked once at import and
 * stored as "nzlegacy1:" followed by its normalized description, so sign-in never guesses.
 */

export const LEGACY_HASH_PREFIX = "nzlegacy1:";

export interface LegacyPasswordDeclaration {
  algorithm: string;
  hash: string;
  parameters?: Record<string, unknown>;
}

type SaltEncoding = "text" | "hex" | "base64";
type Normalization = "none" | "NFC" | "NFKC";

interface ScryptHash {
  algorithm: "scrypt";
  N: number;
  r: number;
  p: number;
  /** The salt bytes, base64. */
  salt: string;
  /** The derived key, base64. */
  key: string;
  normalize: Normalization;
}

interface NativeHash {
  algorithm: "bcrypt" | "argon2";
  hash: string;
  normalize: Normalization;
}

type LegacyHash = ScryptHash | NativeHash;

export type LegacyParse = { ok: true; stored: string } | { ok: false; reason: string };

const SCRYPT_MAX_N = 2 ** 20;

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 1 && (value & (value - 1)) === 0;
}

/** Base64 in either alphabet (standard or URL-safe; passlib's "." for "+"), padded or not. */
function base64Bytes(text: string): Buffer | null {
  const normalized = text.replace(/\./g, "+").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;
  return Buffer.from(normalized, "base64");
}

function keyBytes(text: string, declared: unknown): Buffer | null {
  if (declared === "base64") return base64Bytes(text);
  if (declared === "hex" || (/^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0)) {
    return /^[0-9a-fA-F]+$/.test(text) && text.length % 2 === 0 ? Buffer.from(text, "hex") : null;
  }
  return base64Bytes(text);
}

function saltBytes(text: string, encoding: SaltEncoding): Buffer | null {
  if (encoding === "text") return Buffer.from(text, "utf8");
  if (encoding === "hex") {
    return /^[0-9a-fA-F]*$/.test(text) && text.length % 2 === 0 ? Buffer.from(text, "hex") : null;
  }
  return base64Bytes(text);
}

function normalizationOf(value: unknown): Normalization | null {
  if (value === undefined || value === null || value === "none") return "none";
  if (value === "NFC" || value === "NFKC") return value;
  return null;
}

function numberParam(parameters: Record<string, unknown>, ...names: string[]): number | null {
  for (const name of names) {
    const value = parameters[name];
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

/** A checked scrypt hash, or what is wrong with it. */
function scryptHash(
  N: number,
  r: number,
  p: number,
  salt: Buffer | null,
  key: Buffer | null,
  normalize: Normalization,
): ScryptHash | string {
  if (!isPowerOfTwo(N) || N > SCRYPT_MAX_N) return "its scrypt cost (N) isn't usable";
  if (r < 1 || r > 32 || p < 1 || p > 16) return "its scrypt r or p isn't usable";
  if (!salt || salt.length === 0) return "its salt can't be read";
  if (!key || key.length < 16 || key.length > 128) return "its key can't be read";
  return {
    algorithm: "scrypt",
    N,
    r,
    p,
    salt: salt.toString("base64"),
    key: key.toString("base64"),
    normalize,
  };
}

function parseScrypt(hash: string, parameters: Record<string, unknown>): ScryptHash | string {
  const normalize = normalizationOf(parameters.normalize ?? parameters.passwordNormalization);
  if (!normalize) return "its text normalization isn't one Nearzero knows";

  // PHC: $scrypt$ln=17,r=8,p=1$<salt>$<key>
  const phc = /^\$scrypt\$([^$]+)\$([^$]+)\$([^$]+)$/.exec(hash);
  if (phc) {
    const settings = Object.fromEntries(
      (phc[1] as string).split(",").map((pair) => pair.split("=") as [string, string]),
    );
    const ln = numberParam(settings, "ln");
    const N = ln !== null ? 2 ** ln : (numberParam(settings, "N", "n") ?? 0);
    const r = numberParam(settings, "r") ?? 0;
    const p = numberParam(settings, "p") ?? 0;
    const salt = base64Bytes(phc[2] as string);
    const key = base64Bytes(phc[3] as string);
    return scryptHash(N, r, p, salt, key, normalize);
  }

  // scrypt:N:r:p$<salt>$<hex key>, with the salt used as text.
  const colonParams = /^scrypt:(\d+):(\d+):(\d+)\$([^$]+)\$([0-9a-fA-F]+)$/.exec(hash);
  if (colonParams) {
    const N = Number(colonParams[1]);
    const r = Number(colonParams[2]);
    const p = Number(colonParams[3]);
    const salt = saltBytes(colonParams[4] as string, "text");
    const key = keyBytes(colonParams[5] as string, "hex");
    return scryptHash(N, r, p, salt, key, normalize);
  }

  // <salt>:<key>, with N, r and p declared beside it.
  const pair = /^([^:$]+):([^:$]+)$/.exec(hash);
  if (pair) {
    const N = numberParam(parameters, "N", "n", "cost");
    const r = numberParam(parameters, "r", "blockSize");
    const p = numberParam(parameters, "p", "parallelization");
    if (N === null || r === null || p === null)
      return "its scrypt parameters (N, r and p) are missing";
    // "utf8" (spec 29a.5.1) and "text" both mean the salt text's UTF-8 bytes, not hex-decoded.
    const declared =
      parameters.saltEncoding === "utf8" ? "text" : (parameters.saltEncoding ?? "text");
    const encoding = declared as SaltEncoding;
    if (!["text", "hex", "base64"].includes(encoding))
      return "its salt encoding isn't one Nearzero knows";
    const salt = saltBytes(pair[1] as string, encoding);
    const key = keyBytes(pair[2] as string, parameters.keyEncoding);
    return scryptHash(N, r, p, salt, key, normalize);
  }
  return "its scrypt hash is in a form Nearzero doesn't know";
}

function parse(declaration: LegacyPasswordDeclaration): LegacyHash | string {
  const algorithm = declaration.algorithm.trim().toLowerCase();
  const hash = declaration.hash.trim();
  const parameters = declaration.parameters ?? {};
  if (hash === "" || hash.length > 1024) return "its hash is empty or too long";
  if (algorithm === "scrypt") return parseScrypt(hash, parameters);
  if (algorithm === "bcrypt") {
    const normalize = normalizationOf(parameters.normalize ?? parameters.passwordNormalization);
    if (!normalize) return "its text normalization isn't one Nearzero knows";
    if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return "its bcrypt hash can't be read";
    // $2y$ (PHP) is the same algorithm as $2b$.
    return { algorithm: "bcrypt", hash: hash.replace(/^\$2y\$/, "$2b$"), normalize };
  }
  if (
    algorithm === "argon2" ||
    algorithm === "argon2id" ||
    algorithm === "argon2i" ||
    algorithm === "argon2d"
  ) {
    const normalize = normalizationOf(parameters.normalize ?? parameters.passwordNormalization);
    if (!normalize) return "its text normalization isn't one Nearzero knows";
    if (
      !/^\$argon2(id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/.test(hash)
    ) {
      return "its argon2 hash can't be read";
    }
    return { algorithm: "argon2", hash, normalize };
  }
  return `its algorithm (${declaration.algorithm}) isn't one Nearzero can check`;
}

/**
 * Checks a declared hash and gives the form stored in person.password_hash, or the reason it
 * can't be used ("its algorithm (md5) isn't one Nearzero can check").
 */
export function parseLegacyPassword(declaration: LegacyPasswordDeclaration): LegacyParse {
  const parsed = parse(declaration);
  if (typeof parsed === "string") return { ok: false, reason: parsed };
  return {
    ok: true,
    stored: LEGACY_HASH_PREFIX + Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url"),
  };
}

export function isLegacyHash(stored: string | null): boolean {
  return stored?.startsWith(LEGACY_HASH_PREFIX) === true;
}

function decode(stored: string): LegacyHash | null {
  try {
    const value = JSON.parse(
      Buffer.from(stored.slice(LEGACY_HASH_PREFIX.length), "base64url").toString("utf8"),
    ) as LegacyHash;
    return value && typeof value === "object" && typeof value.algorithm === "string" ? value : null;
  } catch {
    return null;
  }
}

function scryptKey(password: string, hash: ScryptHash, length: number): Promise<Buffer> {
  const maxmem = 128 * hash.N * hash.r * 2 + 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(hash.salt, "base64"),
      length,
      { N: hash.N, r: hash.r, p: hash.p, maxmem },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** True when the password matches a stored legacy hash; false for anything malformed. */
export async function verifyLegacyPassword(password: string, stored: string): Promise<boolean> {
  const hash = decode(stored);
  if (!hash) return false;
  const text = hash.normalize === "none" ? password : password.normalize(hash.normalize);
  try {
    if (hash.algorithm === "scrypt") {
      const expected = Buffer.from(hash.key, "base64");
      const derived = await scryptKey(text, hash, expected.length);
      return derived.length === expected.length && timingSafeEqual(derived, expected);
    }
    if (hash.algorithm === "bcrypt") {
      // Standard bcrypt reads at most 72 bytes; Bun would pre-hash a longer input instead.
      const bytes = new TextEncoder().encode(text);
      return await Bun.password.verify(
        bytes.length > 72 ? bytes.subarray(0, 72) : text,
        hash.hash,
        "bcrypt",
      );
    }
    if (hash.algorithm === "argon2") return await Bun.password.verify(text, hash.hash);
  } catch {
    return false;
  }
  return false;
}
