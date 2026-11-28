import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";

/**
 * The certificate the control plane serves the runner link with when it has no domain (spec 25
 * D1, decision "Remote runners are always encrypted" in spec 31). It is made once, the first time
 * the control plane starts on an install, and kept in a folder that outlives restarts, upgrades
 * and reruns of the installer (the `nearzero-runner-link` volume). Servers don't check it against
 * a certificate authority: setup and the join command give each runner the certificate's SHA-256
 * fingerprint, and the runner accepts only that certificate (runner/src/link/).
 *
 * The certificate is self-signed: an ECDSA P-256 key, valid until 9999 (RFC 5280's "no
 * well-defined expiration date"), so pinned runners never see it expire.
 */

export const LINK_CERTIFICATE_FILE = "link.crt";
export const LINK_KEY_FILE = "link.key";
/** The fingerprint as text, for `sudo nearzero` and the installer's summary to print. */
export const LINK_FINGERPRINT_FILE = "fingerprint";
/** The name in the certificate. Runners never check it; it says what the certificate is for. */
export const LINK_CERTIFICATE_NAME = "nearzero-runner-link";

export interface LinkCertificate {
  certificate: string;
  key: string;
  /** SHA-256 of the certificate (DER), 64 lowercase hex characters. */
  fingerprint: string;
}

/** SHA-256 of a PEM certificate's DER bytes, as 64 lowercase hex characters. */
export function certificateFingerprint(pem: string): string {
  const x509 = new X509Certificate(pem);
  return createHash("sha256").update(x509.raw).digest("hex");
}

// ---- A small DER writer, enough for one self-signed certificate.

function length(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = Buffer.concat(parts);
  return Buffer.concat([Uint8Array.of(tag), length(body.length), body]);
}

const sequence = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts);

function oid(dotted: string): Uint8Array {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes: number[] = [first * 40 + second];
  for (const part of rest) {
    const chunk: number[] = [];
    let value = part;
    do {
      chunk.unshift(value % 128);
      value = Math.floor(value / 128);
    } while (value > 0);
    for (let index = 0; index < chunk.length - 1; index++)
      chunk[index] = (chunk[index] ?? 0) | 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}

function positiveInteger(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.subarray(start);
  return (trimmed[0] ?? 0) & 0x80 ? tlv(0x02, Uint8Array.of(0), trimmed) : tlv(0x02, trimmed);
}

function utf8(text: string): Uint8Array {
  return tlv(0x0c, new TextEncoder().encode(text));
}

function time(date: Date): Uint8Array {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const year = date.getUTCFullYear();
  // UTCTime through 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
  return year < 2050
    ? tlv(0x17, new TextEncoder().encode(`${iso.slice(2)}Z`))
    : tlv(0x18, new TextEncoder().encode(`${iso}Z`));
}

function name(commonName: string): Uint8Array {
  return sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
}

function extension(id: string, critical: boolean, value: Uint8Array): Uint8Array {
  return sequence(
    oid(id),
    ...(critical ? [Uint8Array.of(0x01, 0x01, 0xff)] : []),
    tlv(0x04, value),
  );
}

function ipBytes(address: string): Uint8Array | null {
  const kind = isIP(address);
  if (kind === 4) return Uint8Array.from(address.split(".").map(Number));
  if (kind !== 6) return null;
  const [head = "", tail = ""] = address.split("::");
  const groups = (text: string) => (text === "" ? [] : text.split(":"));
  const left = groups(head);
  const right = address.includes("::") ? groups(tail) : [];
  const middle = Array(8 - left.length - right.length).fill("0");
  const all = [...left, ...middle, ...right];
  const out = new Uint8Array(16);
  all.forEach((group, index) => {
    const value = Number.parseInt(group, 16);
    out[index * 2] = value >> 8;
    out[index * 2 + 1] = value & 0xff;
  });
  return out;
}

export interface CertificateOptions {
  /** The subject's common name. */
  commonName?: string;
  /** IP addresses and names for the subject alternative names. */
  addresses?: readonly string[];
  /** True for an authority that signs others (tests make a stand-in public authority). */
  authority?: boolean;
  /** Who signs it: an authority made here (its PEM certificate and key); itself when absent. */
  issuer?: LinkCertificate & { commonName: string };
  now?: Date;
  /** The end of its validity; 9999 when absent (RFC 5280's "no well-defined expiration date"). */
  notAfter?: Date;
}

/**
 * A new certificate and its key (PEM), ECDSA P-256. The runner link uses a self-signed one
 * (`createLinkCertificate`); tests also make an authority and certificates it signs, to stand
 * in for a public one.
 */
export function createCertificate(options: CertificateOptions = {}): LinkCertificate {
  const now = options.now ?? new Date();
  const commonName = options.commonName ?? LINK_CERTIFICATE_NAME;
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaWithSha256 = sequence(oid("1.2.840.10045.4.3.2"));
  const alternativeNames: Uint8Array[] = [];
  for (const address of new Set([commonName, ...(options.addresses ?? [])])) {
    const ip = ipBytes(address);
    if (ip) alternativeNames.push(tlv(0x87, ip));
    else if (/^[a-z0-9.-]+$/i.test(address))
      alternativeNames.push(tlv(0x82, new TextEncoder().encode(address.toLowerCase())));
  }
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const selfSigned = !options.issuer;
  const authority = options.authority ?? selfSigned;
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Uint8Array.of(2))),
    positiveInteger(serial),
    ecdsaWithSha256,
    name(options.issuer?.commonName ?? commonName),
    sequence(
      time(new Date(now.getTime() - 24 * 3_600_000)),
      time(options.notAfter ?? new Date("9999-12-31T23:59:59Z")),
    ),
    name(commonName),
    spki,
    tlv(
      0xa3,
      sequence(
        // A self-signed certificate is its own authority (as `openssl req -x509` makes them).
        extension(
          "2.5.29.19",
          true,
          authority ? sequence(Uint8Array.of(0x01, 0x01, 0xff)) : sequence(),
        ),
        // digitalSignature, and keyCertSign for an authority.
        extension(
          "2.5.29.15",
          true,
          authority ? Uint8Array.of(0x03, 0x02, 0x02, 0x84) : Uint8Array.of(0x03, 0x02, 0x07, 0x80),
        ),
        // serverAuth.
        extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
        extension("2.5.29.17", false, sequence(...alternativeNames)),
      ),
    ),
  );
  const signature = sign(
    "sha256",
    tbs,
    options.issuer ? createPrivateKey(options.issuer.key) : privateKey,
  );
  const der = sequence(tbs, ecdsaWithSha256, tlv(0x03, Uint8Array.of(0), signature));
  const base64 = Buffer.from(der).toString("base64");
  const certificate = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join("\n")}\n-----END CERTIFICATE-----\n`;
  const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { certificate, key, fingerprint: createHash("sha256").update(der).digest("hex") };
}

/**
 * A new self-signed certificate and its key (PEM) for the runner link. `addresses` (IP addresses
 * and names) go into its subject alternative names for anyone who looks at it; pinning doesn't
 * depend on them.
 */
export function createLinkCertificate(
  addresses: readonly string[] = [],
  now: Date = new Date(),
): LinkCertificate {
  return createCertificate({ addresses, now });
}

async function writeAtomically(path: string, contents: string, mode: number): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, contents, { mode });
  await chmod(temporary, mode);
  await rename(temporary, path);
}

async function writeFingerprint(directory: string, fingerprint: string): Promise<void> {
  const path = join(directory, LINK_FINGERPRINT_FILE);
  if ((await readFile(path, "utf8").catch(() => ""))?.trim() === fingerprint) return;
  await writeAtomically(path, `${fingerprint}\n`, 0o644).catch(() => {});
}

async function readIfThere(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Nearzero can't read ${path}: ${(error as Error).message}`);
  }
}

/** A pair from its two files, checked to belong together; null when neither file is there. */
async function readPair(
  directory: string,
  certificateFile: string,
  keyFile: string,
): Promise<LinkCertificate | null> {
  const certificatePath = join(directory, certificateFile);
  const keyPath = join(directory, keyFile);
  const certificate = await readIfThere(certificatePath);
  const key = await readIfThere(keyPath);
  if (certificate === null && key === null) return null;
  if (certificate === null || key === null) {
    throw new Error(
      certificate === null
        ? `${keyPath} is there without its certificate ${certificatePath}.`
        : `${certificatePath} is there without its key ${keyPath}.`,
    );
  }
  try {
    const x509 = new X509Certificate(certificate);
    if (!x509.checkPrivateKey(createPrivateKey(key))) throw new Error("mismatch");
    return { certificate, key, fingerprint: createHash("sha256").update(x509.raw).digest("hex") };
  } catch {
    throw new Error(`${certificatePath} and ${keyPath} can't be read or don't belong together.`);
  }
}

/**
 * The install's link certificate: the one kept in `directory`, or a new one made and kept there
 * when there is none yet. A pair already there is never replaced, so every runner pinned to it
 * keeps connecting. A pair that can't be read or doesn't belong together, or a certificate whose
 * key is gone (a file removed, a partial restore), stops the link with the files named instead
 * of silently making a new pair, which would cut every pinned server off (C4-10). A key without
 * its certificate can only be an interrupted first start (the key is written first), which no
 * server can have pinned yet, so that pair is made again and `replaced` says so.
 */
export async function ensureLinkCertificate(
  directory: string,
  addresses: readonly string[] = [],
): Promise<LinkCertificate & { created: boolean; replaced: boolean }> {
  const certificatePath = join(directory, LINK_CERTIFICATE_FILE);
  const keyPath = join(directory, LINK_KEY_FILE);
  const certificate = await readIfThere(certificatePath);
  const key = await readIfThere(keyPath);
  if (certificate !== null) {
    let pair: LinkCertificate | null = null;
    try {
      pair = await readPair(directory, LINK_CERTIFICATE_FILE, LINK_KEY_FILE);
    } catch {
      pair = null;
    }
    if (!pair) {
      const next = await readNextLinkCertificate(directory).catch(() => null);
      if (next && (await halfSwitched(directory, next))) {
        throw new Error(
          `A switch to the next runner link certificate in ${directory} was interrupted, so its files don't belong together yet. Finish it with: sudo nearzero runner-link switch`,
        );
      }
      throw new Error(
        key === null
          ? `The runner link's certificate ${certificatePath} is there but its key ${keyPath} isn't, so the encrypted port stays off rather than make a new pair, which would cut off every server pinned to this one. Put the key back from a backup. Only if it is lost for good: remove the certificate too, restart Nearzero, and run setup again on every server.`
          : `The runner link's certificate and key in ${directory} can't be read or don't belong together. Put them back from a backup, or remove both files so Nearzero makes a new pair, then run setup again on every server.`,
      );
    }
    await writeFingerprint(directory, pair.fingerprint);
    return { ...pair, created: false, replaced: false };
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const made = createLinkCertificate(addresses);
  await writeAtomically(keyPath, made.key, 0o600);
  await writeAtomically(certificatePath, made.certificate, 0o644);
  await writeFingerprint(directory, made.fingerprint);
  return { ...made, created: true, replaced: key !== null };
}

// ---- Replacing the pair (`nearzero runner-link rotate`, then `switch`; C4-10, C4-14)

/** The pair that will replace the current one, made by `rotate` and kept until `switch`. */
export const NEXT_CERTIFICATE_FILE = "link.next.crt";
export const NEXT_KEY_FILE = "link.next.key";
/**
 * The pair `switch` replaced, kept only until every server has reconnected to the new one, or for
 * PREVIOUS_KEPT_MS at most (C4-14), so a failed restart can still be put right by hand.
 */
export const PREVIOUS_CERTIFICATE_FILE = "link.previous.crt";
export const PREVIOUS_KEY_FILE = "link.previous.key";
export const PREVIOUS_INFO_FILE = "link.previous.json";
export const PREVIOUS_KEPT_MS = 7 * 24 * 3_600_000;

export interface PreviousPair {
  fingerprint: string;
  /** When `switch` put the next pair in its place. */
  switchedAt: Date;
}

/** The current pair, or null when there is none yet. Throws for a broken pair. */
export async function readLinkCertificate(directory: string): Promise<LinkCertificate | null> {
  return readPair(directory, LINK_CERTIFICATE_FILE, LINK_KEY_FILE);
}

/** The next pair's fingerprint, or null when none is waiting. Throws for a broken pair. */
export async function readNextLinkCertificate(directory: string): Promise<LinkCertificate | null> {
  return readPair(directory, NEXT_CERTIFICATE_FILE, NEXT_KEY_FILE);
}

/** The replaced pair still kept, or null. */
export async function readPreviousLinkCertificate(directory: string): Promise<PreviousPair | null> {
  const text = await readIfThere(join(directory, PREVIOUS_INFO_FILE)).catch(() => null);
  const key = await readIfThere(join(directory, PREVIOUS_KEY_FILE)).catch(() => null);
  if (text === null && key === null) return null;
  try {
    const info = JSON.parse(text ?? "{}") as { fingerprint?: string; switchedAt?: string };
    const switchedAt = new Date(info.switchedAt ?? 0);
    return {
      fingerprint: typeof info.fingerprint === "string" ? info.fingerprint : "",
      switchedAt: Number.isNaN(switchedAt.getTime()) ? new Date(0) : switchedAt,
    };
  } catch {
    return { fingerprint: "", switchedAt: new Date(0) };
  }
}

/** Makes the next pair, or returns the one already waiting. */
export async function createNextLinkCertificate(
  directory: string,
  addresses: readonly string[] = [],
): Promise<LinkCertificate & { created: boolean }> {
  const waiting = await readNextLinkCertificate(directory);
  if (waiting) return { ...waiting, created: false };
  if (!(await readLinkCertificate(directory))) {
    throw new Error(
      `There is no runner link certificate in ${directory} yet to replace; Nearzero makes one when it starts.`,
    );
  }
  const made = createLinkCertificate(addresses);
  await writeAtomically(join(directory, NEXT_KEY_FILE), made.key, 0o600);
  await writeAtomically(join(directory, NEXT_CERTIFICATE_FILE), made.certificate, 0o644);
  return { ...made, created: true };
}

/** Drops the next pair without using it; returns its fingerprint, or null when none waited. */
export async function cancelNextLinkCertificate(directory: string): Promise<string | null> {
  const waiting = await readNextLinkCertificate(directory).catch(() => null);
  const there =
    waiting !== null ||
    (await readIfThere(join(directory, NEXT_KEY_FILE)).catch(() => null)) !== null ||
    (await readIfThere(join(directory, NEXT_CERTIFICATE_FILE)).catch(() => null)) !== null;
  if (!there) return null;
  await rm(join(directory, NEXT_CERTIFICATE_FILE), { force: true });
  await rm(join(directory, NEXT_KEY_FILE), { force: true });
  return waiting?.fingerprint ?? "";
}

/** Whether the files in place are a switch to `next` left half-done (one file written). */
async function halfSwitched(directory: string, next: LinkCertificate): Promise<boolean> {
  const key = await readIfThere(join(directory, LINK_KEY_FILE)).catch(() => null);
  const certificate = await readIfThere(join(directory, LINK_CERTIFICATE_FILE)).catch(() => null);
  return key?.trim() === next.key.trim() || certificate?.trim() === next.certificate.trim();
}

/**
 * Puts the next pair in place of the current one, which is kept as link.previous.* (C4-14). Every
 * file is written under a temporary name and renamed, the key first; a switch interrupted between
 * the two renames leaves the next pair waiting, and running it again finishes it. The control
 * plane serves the new pair from its next start.
 */
export async function switchLinkCertificate(
  directory: string,
  now: Date = new Date(),
): Promise<{ previous: string; current: string }> {
  const next = await readNextLinkCertificate(directory);
  if (!next)
    throw new Error("No next pair is waiting. Make one first: nearzero runner-link rotate");
  let current: LinkCertificate | null = null;
  try {
    current = await readLinkCertificate(directory);
  } catch (error) {
    // Only a switch to this very pair that stopped half-way is finished; any other broken pair
    // stays as it is, for a person to put right.
    if (!(await halfSwitched(directory, next))) throw error;
  }
  let previous = (await readPreviousLinkCertificate(directory))?.fingerprint ?? "";
  if (current && current.fingerprint !== next.fingerprint) {
    await writeAtomically(join(directory, PREVIOUS_KEY_FILE), current.key, 0o600);
    await writeAtomically(join(directory, PREVIOUS_CERTIFICATE_FILE), current.certificate, 0o644);
    await writeAtomically(
      join(directory, PREVIOUS_INFO_FILE),
      `${JSON.stringify({ fingerprint: current.fingerprint, switchedAt: now.toISOString() })}\n`,
      0o644,
    );
    previous = current.fingerprint;
  }
  if (!current || current.fingerprint !== next.fingerprint) {
    await writeAtomically(join(directory, LINK_KEY_FILE), next.key, 0o600);
    await writeAtomically(join(directory, LINK_CERTIFICATE_FILE), next.certificate, 0o644);
  }
  await writeFingerprint(directory, next.fingerprint);
  await rm(join(directory, NEXT_CERTIFICATE_FILE), { force: true });
  await rm(join(directory, NEXT_KEY_FILE), { force: true });
  return { previous, current: next.fingerprint };
}

/**
 * Removes the replaced pair once it can no longer be needed (C4-14): every server has reconnected
 * to the new one (`everyServerMoved`), or PREVIOUS_KEPT_MS has passed since the switch. Returns
 * the removed pair's fingerprint, or null when nothing was removed.
 */
export async function prunePreviousLinkCertificate(
  directory: string,
  options: { everyServerMoved: boolean; now?: Date },
): Promise<string | null> {
  const previous = await readPreviousLinkCertificate(directory);
  if (!previous) return null;
  const age = (options.now ?? new Date()).getTime() - previous.switchedAt.getTime();
  if (!options.everyServerMoved && age < PREVIOUS_KEPT_MS) return null;
  await rm(join(directory, PREVIOUS_KEY_FILE), { force: true });
  await rm(join(directory, PREVIOUS_CERTIFICATE_FILE), { force: true });
  await rm(join(directory, PREVIOUS_INFO_FILE), { force: true });
  return previous.fingerprint;
}

/**
 * The fingerprint every remote runner's welcome announces as the next one (C4-13): the pair
 * `rotate` made, or, between `switch` and the restart, the pair now in place on disk while this
 * process still serves the old one, so a runner that reconnects in that window keeps the new pin.
 */
export async function nextPinToAnnounce(
  directory: string,
  servedFingerprint: string,
): Promise<string | null> {
  const next = await readNextLinkCertificate(directory);
  if (next) return next.fingerprint;
  const onDisk = await readLinkCertificate(directory).catch(() => null);
  return onDisk && onDisk.fingerprint !== servedFingerprint ? onDisk.fingerprint : null;
}
