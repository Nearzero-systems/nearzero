import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { z } from "zod";
import { ArchiveError, readArchive, writeArchive } from "./archive.ts";

/**
 * The export bundle a final 0.1.x release writes and 1.0 reads, byte for byte as spec 29a.2–29a.4
 * fixes it:
 *
 *   bytes 0–7    "NZEXPORT"
 *   bytes 8–11   L, the clear header's length, unsigned 32-bit big-endian (at most 65,536)
 *   next L       the clear header, UTF-8 JSON: format, cipher, kdf { name, input, N, r, p,
 *                keyLength, salt }, iv, tagLength
 *   then         the tar archive, encrypted with AES-256-GCM as one message
 *   last 16      the authentication tag
 *
 * The additional authenticated data is every byte before the ciphertext, so a changed header
 * fails like a wrong passphrase. The key is scrypt over the passphrase normalized to NFC. Inside:
 * manifest.json (format, source version, export time, options, counts, every file with its
 * SHA-256 and size, certificate stores, volume archives, notes) and the record files.
 *
 * Plain copies of the archive exist only in memory: nothing here writes to disk.
 */

export const BUNDLE_MAGIC = "NZEXPORT";
export const BUNDLE_FORMAT_VERSION = 1;
export const SCRYPT_DEFAULTS = { N: 2 ** 17, r: 8, p: 1 } as const;
/** The weakest work factor accepted (tests use it; real exports use 2^17). */
const SCRYPT_MIN_N = 2 ** 14;
const SCRYPT_MAX_N = 2 ** 20;
const HEADER_MAX_BYTES = 65_536;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
/** Bundles are opened in memory; a larger one is refused with a message. */
export const BUNDLE_MAX_BYTES = 2 * 1024 * 1024 * 1024 - 1;
/**
 * The key what each ref became is kept under. Refs are stable across exports of one install and
 * opaque (29a.1), so every bundle shares one key: a newer export of the same install matches its
 * records one to one.
 */
export const SOURCE_REFS = "0.1.x";

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BundleError";
  }
}

export const BUNDLE_MESSAGES = {
  notBundle:
    "This file isn't a Nearzero export. Make one on the 0.1.x server with: sudo nearzero export",
  wrongPassphrase: "Wrong passphrase, or the bundle was changed.",
  noPassphrase: "Enter the passphrase the export was made with.",
  unsafeHeader:
    "This export asks for key settings Nearzero doesn't accept (scrypt N up to 2^20, r up to 32, p up to 16).",
  tooLarge: "This export is larger than 2 GB, which is more than Nearzero can open.",
  newerFormat: (version: number) =>
    `This export uses bundle format ${version}, and this version of Nearzero reads format ${BUNDLE_FORMAT_VERSION}. Update this server to the newest 1.0 release, then import again.`,
  badManifest: (problem: string) => `The export's manifest is not valid: ${problem}`,
  checksum: (path: string) =>
    `${path} doesn't match the checksum in the export's manifest, so the export was changed or damaged. Export again on the 0.1.x server.`,
  missing: (path: string) =>
    `${path} is listed in the export's manifest but isn't in the export. Export again on the 0.1.x server.`,
  unlisted: (path: string) =>
    `${path} is in the export but not in its manifest, so the export was changed. Export again on the 0.1.x server.`,
  badLine: (path: string, line: number) =>
    `Line ${line} of ${path} is not valid JSON. Export again on the 0.1.x server.`,
} as const;

const headerSchema = z.object({
  format: z.number().int(),
  cipher: z.literal("aes-256-gcm"),
  kdf: z.object({
    name: z.literal("scrypt"),
    input: z.literal("utf8-nfc"),
    N: z.number().int(),
    r: z.number().int(),
    p: z.number().int(),
    keyLength: z.literal(KEY_BYTES),
    salt: z.string().min(1),
  }),
  iv: z.string().min(1),
  tagLength: z.literal(TAG_BYTES),
});
type ContainerHeader = z.infer<typeof headerSchema>;

const sha256Field = z.string().regex(/^[0-9a-f]{64}$/, "use a lowercase hex SHA-256");

export const manifestSchema = z.object({
  format: z.number().int().min(1),
  sourceVersion: z.string().min(1).max(64),
  exportedAt: z.string().max(64).nullish(),
  options: z
    .object({ deployments: z.boolean().nullish(), volumes: z.boolean().nullish() })
    .nullish(),
  counts: z.record(z.string(), z.number().int().min(0)).nullish(),
  files: z.array(
    z.object({
      path: z.string().min(1).max(4096),
      sha256: sha256Field,
      bytes: z.number().int().min(0),
    }),
  ),
  acme: z
    .array(
      z.object({
        path: z.string().max(4096),
        serverRef: z.string().max(200).nullish(),
        host: z.boolean().nullish(),
        certificates: z.number().int().nullish(),
      }),
    )
    .nullish(),
  volumes: z
    .array(
      z.object({
        path: z.string().max(4096),
        serviceRef: z.string().max(200).nullish(),
        volume: z.string().max(255).nullish(),
        serverRef: z.string().max(200).nullish(),
        bytes: z.number().nullish(),
      }),
    )
    .nullish(),
  notes: z
    .array(
      z.object({
        kind: z.string().max(40),
        ref: z.string().max(200).nullish(),
        name: z.string().max(500).nullish(),
        reason: z.string().max(4000),
      }),
    )
    .nullish(),
  /** Not in 29a; accepted when present. */
  installId: z.string().min(1).max(200).nullish(),
});
export type BundleManifest = z.infer<typeof manifestSchema>;

export interface OpenedBundle {
  manifest: BundleManifest;
  /** Every file but the manifest, already checked against the manifest. */
  files: Map<string, Uint8Array>;
  /** SHA-256 of the whole encrypted file. */
  sha256: string;
  /** The key refs are kept under (see {@link SOURCE_REFS}); the manifest's installId is checked apart. */
  sourceInstall: string;
}

function deriveKey(passphrase: string, salt: Buffer, header: ContainerHeader): Promise<Buffer> {
  const maxmem = 128 * header.kdf.N * header.kdf.r * 2 + 64 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(
      Buffer.from(passphrase.normalize("NFC"), "utf8"),
      salt,
      header.kdf.keyLength,
      { N: header.kdf.N, r: header.kdf.r, p: header.kdf.p, maxmem },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The parts of the file; null when it doesn't start like a bundle. */
function splitHeader(
  bytes: Uint8Array,
): { aad: Uint8Array; header: unknown; body: Uint8Array } | null {
  if (bytes.length < 12 + TAG_BYTES) return null;
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== BUNDLE_MAGIC) return null;
  const length = Buffer.from(bytes.buffer, bytes.byteOffset + 8, 4).readUInt32BE(0);
  if (length === 0 || length > HEADER_MAX_BYTES || 12 + length > bytes.length) return null;
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length)));
  } catch {
    return null;
  }
  return { aad: bytes.subarray(0, 12 + length), header, body: bytes.subarray(12 + length) };
}

/** Decrypts and checks a bundle. Every refusal is a {@link BundleError} with a plain message. */
export async function openBundle(bytes: Uint8Array, passphrase: string): Promise<OpenedBundle> {
  if (bytes.length > BUNDLE_MAX_BYTES) throw new BundleError(BUNDLE_MESSAGES.tooLarge);
  const split = splitHeader(bytes);
  if (!split) throw new BundleError(BUNDLE_MESSAGES.notBundle);
  const format = (split.header as { format?: unknown } | null)?.format;
  if (typeof format === "number" && format > BUNDLE_FORMAT_VERSION) {
    throw new BundleError(BUNDLE_MESSAGES.newerFormat(format));
  }
  const parsed = headerSchema.safeParse(split.header);
  if (!parsed.success) throw new BundleError(BUNDLE_MESSAGES.notBundle);
  const header = parsed.data;
  if (header.format < 1) throw new BundleError(BUNDLE_MESSAGES.notBundle);
  const { N, r, p } = header.kdf;
  if (
    N < SCRYPT_MIN_N ||
    N > SCRYPT_MAX_N ||
    (N & (N - 1)) !== 0 ||
    r < 1 ||
    r > 32 ||
    p < 1 ||
    p > 16
  ) {
    throw new BundleError(BUNDLE_MESSAGES.unsafeHeader);
  }
  if (passphrase === "") throw new BundleError(BUNDLE_MESSAGES.noPassphrase);
  const salt = Buffer.from(header.kdf.salt, "base64");
  const iv = Buffer.from(header.iv, "base64");
  if (iv.length !== IV_BYTES || salt.length < 8) throw new BundleError(BUNDLE_MESSAGES.notBundle);

  const key = await deriveKey(passphrase, salt, header);
  let archive: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(split.aad);
    decipher.setAuthTag(split.body.subarray(split.body.length - TAG_BYTES));
    archive = Buffer.concat([
      decipher.update(split.body.subarray(0, split.body.length - TAG_BYTES)),
      decipher.final(),
    ]);
  } catch {
    throw new BundleError(BUNDLE_MESSAGES.wrongPassphrase);
  } finally {
    key.fill(0);
  }

  let files: Map<string, Uint8Array>;
  try {
    files = readArchive(archive);
  } catch (error) {
    if (error instanceof ArchiveError) throw new BundleError(error.message);
    throw error;
  }
  const manifestBytes = files.get("manifest.json");
  if (!manifestBytes)
    throw new BundleError(BUNDLE_MESSAGES.badManifest("manifest.json is missing."));
  files.delete("manifest.json");
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    throw new BundleError(BUNDLE_MESSAGES.badManifest("it isn't JSON."));
  }
  const manifestFormat = (manifestJson as { format?: unknown } | null)?.format;
  if (typeof manifestFormat === "number" && manifestFormat > BUNDLE_FORMAT_VERSION) {
    throw new BundleError(BUNDLE_MESSAGES.newerFormat(manifestFormat));
  }
  const manifest = manifestSchema.safeParse(manifestJson);
  if (!manifest.success) {
    const issue = manifest.error.issues[0];
    const where = issue?.path.join(".") || "manifest";
    throw new BundleError(BUNDLE_MESSAGES.badManifest(`${where}: ${issue?.message ?? "invalid"}.`));
  }
  const listed = new Set<string>();
  for (const entry of manifest.data.files) {
    listed.add(entry.path);
    const content = files.get(entry.path);
    if (!content) throw new BundleError(BUNDLE_MESSAGES.missing(entry.path));
    if (content.length !== entry.bytes || sha256Hex(content) !== entry.sha256) {
      throw new BundleError(BUNDLE_MESSAGES.checksum(entry.path));
    }
  }
  for (const path of files.keys()) {
    if (!listed.has(path)) throw new BundleError(BUNDLE_MESSAGES.unlisted(path));
  }
  return {
    manifest: manifest.data,
    files,
    sha256: sha256Hex(bytes),
    sourceInstall: SOURCE_REFS,
  };
}

/** The records of one JSON Lines file (empty when the bundle has none). */
export function bundleLines(
  bundle: OpenedBundle,
  path: string,
): { line: number; value: unknown }[] {
  const content = bundle.files.get(path);
  if (!content) return [];
  const out: { line: number; value: unknown }[] = [];
  const lines = new TextDecoder().decode(content).split("\n");
  lines.forEach((text, index) => {
    if (text.trim() === "") return;
    try {
      out.push({ line: index + 1, value: JSON.parse(text) });
    } catch {
      throw new BundleError(BUNDLE_MESSAGES.badLine(path, index + 1));
    }
  });
  return out;
}

/** One JSON file of the bundle, or null when it has none. */
export function bundleJson(bundle: OpenedBundle, path: string): unknown {
  const content = bundle.files.get(path);
  if (!content) return null;
  try {
    return JSON.parse(new TextDecoder().decode(content));
  } catch {
    throw new BundleError(BUNDLE_MESSAGES.badLine(path, 1));
  }
}

// ---- Writing (the reference writer: tests build their fixtures with it)

export interface BundleContent {
  sourceVersion: string;
  exportedAt?: string;
  /** JSON Lines files by name (people.jsonl, …), as arrays of records. */
  records: Record<string, unknown[]>;
  /** Other files: install.json, acme/<host or server ref>/acme.json, volumes/…, uploads/…. */
  extra?: Record<string, Uint8Array | object>;
  notes?: { kind: string; ref?: string; name?: string; reason: string }[];
  /** Overrides for tests: a different format version. */
  format?: number;
  /** The 0.1.x install's id (29a.9), when the exporter writes one. */
  installId?: string;
}

export interface SealOptions {
  N?: number;
  r?: number;
  p?: number;
}

/** The files of a bundle with its manifest first. */
export function bundleFiles(content: BundleContent): Map<string, Uint8Array> {
  const encoder = new TextEncoder();
  const files = new Map<string, Uint8Array>();
  const counts: Record<string, number> = {};
  for (const [name, value] of Object.entries(content.extra ?? {})) {
    if (name === "install.json") {
      files.set(name, value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value)));
    }
  }
  for (const [name, records] of Object.entries(content.records)) {
    files.set(
      name,
      encoder.encode(
        records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""),
      ),
    );
    const kind = name
      .replace(/\.jsonl$/, "")
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    counts[kind] = records.length;
  }
  for (const [name, value] of Object.entries(content.extra ?? {})) {
    if (name === "install.json") continue;
    files.set(name, value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value)));
  }
  const acme = [...files.keys()]
    .filter((path) => /^acme\/[^/]+\/acme\.json$/.test(path))
    .map((path) => {
      const owner = path.split("/")[1] as string;
      return {
        path,
        serverRef: owner === "host" ? null : owner,
        host: owner === "host",
        certificates: 0,
      };
    });
  const volumes = [...files.keys()]
    .filter((path) => /^volumes\/[^/]+\/.+\.tar$/.test(path))
    .map((path) => {
      const [, serviceRef, file] = path.split("/") as [string, string, string];
      return {
        path,
        serviceRef,
        volume: file.replace(/\.tar$/, ""),
        serverRef: null,
        bytes: files.get(path)?.length ?? 0,
      };
    });
  counts.acme = acme.length;
  counts.volumes = volumes.length;
  const manifest = {
    format: content.format ?? BUNDLE_FORMAT_VERSION,
    sourceVersion: content.sourceVersion,
    exportedAt: content.exportedAt ?? new Date().toISOString(),
    options: { deployments: "deployments.jsonl" in content.records, volumes: volumes.length > 0 },
    counts,
    files: [...files].map(([path, bytes]) => ({
      path,
      sha256: sha256Hex(bytes),
      bytes: bytes.length,
    })),
    acme,
    volumes,
    notes: content.notes ?? [],
    ...(content.installId ? { installId: content.installId } : {}),
  };
  return new Map([["manifest.json", encoder.encode(JSON.stringify(manifest, null, 2))], ...files]);
}

/** Encrypts an archive of the given files under the passphrase. */
export async function sealArchive(
  files: Map<string, Uint8Array>,
  passphrase: string,
  options: SealOptions = {},
  format = BUNDLE_FORMAT_VERSION,
): Promise<Uint8Array> {
  const header: ContainerHeader = {
    format,
    cipher: "aes-256-gcm",
    kdf: {
      name: "scrypt",
      input: "utf8-nfc",
      N: options.N ?? SCRYPT_DEFAULTS.N,
      r: options.r ?? SCRYPT_DEFAULTS.r,
      p: options.p ?? SCRYPT_DEFAULTS.p,
      keyLength: KEY_BYTES,
      salt: randomBytes(SALT_BYTES).toString("base64"),
    },
    iv: randomBytes(IV_BYTES).toString("base64"),
    tagLength: TAG_BYTES,
  };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const aad = new Uint8Array(12 + json.length);
  aad.set(new TextEncoder().encode(BUNDLE_MAGIC), 0);
  new DataView(aad.buffer).setUint32(8, json.length, false);
  aad.set(json, 12);
  const key = await deriveKey(passphrase, Buffer.from(header.kdf.salt, "base64"), header);
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.from(header.iv, "base64"), {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad);
  const body = Buffer.concat([
    cipher.update(writeArchive(files)),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  key.fill(0);
  const out = new Uint8Array(aad.length + body.length);
  out.set(aad, 0);
  out.set(body, aad.length);
  return out;
}

/** Makes a complete bundle: manifest, checksums, archive, encryption. */
export function createBundle(
  content: BundleContent,
  passphrase: string,
  options: SealOptions = {},
): Promise<Uint8Array> {
  return sealArchive(
    bundleFiles(content),
    passphrase,
    options,
    content.format ?? BUNDLE_FORMAT_VERSION,
  );
}
