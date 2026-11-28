import {
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  generateKeyPair as generateWithCallback,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import {
  AppError,
  privateKeyBlockKind,
  publicKeyLineType,
  SSH_KEY_MESSAGES,
  type SshKeyType,
} from "@nearzero/shared";

/**
 * SSH key formats (spec 09 9.7): reading pasted keys, checking the two halves belong together,
 * fingerprints, and generating new pairs on the server (never with browser crypto).
 *
 * Public keys are the one-line OpenSSH form ("ssh-ed25519 AAAA… comment"); private keys are
 * OpenSSH ("BEGIN OPENSSH PRIVATE KEY") or RSA PEM ("BEGIN RSA PRIVATE KEY"). The wire encoding
 * follows RFC 4251 (string = 32-bit length + bytes; mpint = big-endian two's complement) and the
 * OpenSSH private key container ("openssh-key-v1").
 */

const OPENSSH_MAGIC = "openssh-key-v1\0";

// ---- Wire encoding

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0);
  return out;
}

function sshString(value: Buffer | string): Buffer {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([u32(bytes.length), bytes]);
}

function mpint(unsigned: Buffer): Buffer {
  let start = 0;
  while (start < unsigned.length - 1 && unsigned[start] === 0) start++;
  let bytes = unsigned.subarray(start);
  if ((bytes[0] ?? 0) & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return sshString(bytes);
}

class Reader {
  #at = 0;
  constructor(private readonly bytes: Buffer) {}

  u32(): number {
    if (this.#at + 4 > this.bytes.length) throw new Error("truncated");
    const value = this.bytes.readUInt32BE(this.#at);
    this.#at += 4;
    return value;
  }

  string(): Buffer {
    const length = this.u32();
    if (length > this.bytes.length - this.#at) throw new Error("truncated");
    const value = this.bytes.subarray(this.#at, this.#at + length);
    this.#at += length;
    return value;
  }

  text(): string {
    return this.string().toString("utf8");
  }

  get done(): boolean {
    return this.#at >= this.bytes.length;
  }
}

function base64Body(pem: string): Buffer {
  const lines = pem
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("-----") && !line.includes(":"));
  return Buffer.from(lines.join(""), "base64");
}

function wrap(text: string, width: number): string {
  const out: string[] = [];
  for (let at = 0; at < text.length; at += width) out.push(text.slice(at, at + width));
  return out.join("\n");
}

// ---- Public keys

export interface PublicKeyInfo {
  type: SshKeyType;
  blob: Buffer;
  fingerprint: string;
  /** The key line normalized: type, base64 and the comment if there was one. */
  line: string;
}

/** SHA256:<base64 without padding>, as ssh-keygen -l prints it. */
export function fingerprintOf(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

export function parsePublicKey(line: string): PublicKeyInfo {
  const trimmed = line.trim();
  const type = publicKeyLineType(trimmed);
  if (!type) throw invalid("publicKey", SSH_KEY_MESSAGES.invalidPublic);
  const [prefix = "", body = "", ...comment] = trimmed.split(" ");
  const blob = Buffer.from(body, "base64");
  try {
    const reader = new Reader(blob);
    if (reader.text() !== prefix) throw new Error("type");
    if (type === "ed25519") {
      if (reader.string().length !== 32) throw new Error("length");
    } else {
      reader.string();
      if (reader.string().length < 128) throw new Error("too small");
    }
    if (!reader.done) throw new Error("trailing");
  } catch {
    throw invalid("publicKey", SSH_KEY_MESSAGES.invalidPublic);
  }
  return {
    type,
    blob,
    fingerprint: fingerprintOf(blob),
    line: [prefix, body, ...comment].join(" ").trim(),
  };
}

function invalid(field: "publicKey" | "privateKey", message: string): AppError {
  return new AppError("invalid_request", message, { fields: { [field]: message } });
}

function rsaBlob(n: Buffer, e: Buffer): Buffer {
  return Buffer.concat([sshString("ssh-rsa"), mpint(e), mpint(n)]);
}

function ed25519Blob(publicKey: Buffer): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(publicKey)]);
}

// ---- Private keys

/** The public key blob a private key holds, after checking it can be used without a passphrase. */
export function publicBlobOfPrivateKey(pem: string): Buffer {
  const kind = privateKeyBlockKind(pem);
  if (!kind) throw invalid("privateKey", SSH_KEY_MESSAGES.invalidPrivate);
  if (kind === "rsa") {
    if (/Proc-Type:\s*4,ENCRYPTED/i.test(pem)) {
      throw invalid("privateKey", SSH_KEY_MESSAGES.passphrase);
    }
    try {
      const jwk = createPrivateKey({ key: pem.trim(), format: "pem" }).export({ format: "jwk" });
      if (jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new Error("not rsa");
      return rsaBlob(Buffer.from(jwk.n, "base64url"), Buffer.from(jwk.e, "base64url"));
    } catch {
      throw invalid("privateKey", SSH_KEY_MESSAGES.invalidPrivate);
    }
  }
  let reader: Reader;
  let cipher: string;
  let publicBlob: Buffer;
  let section: Buffer;
  try {
    const bytes = base64Body(pem);
    if (bytes.subarray(0, OPENSSH_MAGIC.length).toString("latin1") !== OPENSSH_MAGIC) {
      throw new Error("magic");
    }
    reader = new Reader(bytes.subarray(OPENSSH_MAGIC.length));
    cipher = reader.text();
    reader.text(); // kdf name
    reader.string(); // kdf options
    if (reader.u32() !== 1) throw new Error("one key only");
    publicBlob = Buffer.from(reader.string());
    section = reader.string();
  } catch {
    throw invalid("privateKey", SSH_KEY_MESSAGES.invalidPrivate);
  }
  if (cipher !== "none") throw invalid("privateKey", SSH_KEY_MESSAGES.passphrase);
  try {
    const inner = new Reader(section);
    const first = inner.u32();
    const second = inner.u32();
    if (first !== second) throw new Error("check");
    const type = inner.text();
    if (type !== "ssh-ed25519" && type !== "ssh-rsa") throw new Error("type");
  } catch {
    throw invalid("privateKey", SSH_KEY_MESSAGES.invalidPrivate);
  }
  return publicBlob;
}

/** Checks a pasted pair: both well formed, unprotected, and halves of the same key. */
export function checkKeyPair(publicKeyLine: string, privateKeyPem: string): PublicKeyInfo {
  const info = parsePublicKey(publicKeyLine);
  const fromPrivate = publicBlobOfPrivateKey(privateKeyPem);
  if (!fromPrivate.equals(info.blob)) throw invalid("privateKey", SSH_KEY_MESSAGES.mismatch);
  return info;
}

// ---- Generating

export interface GeneratedKeyPair {
  type: SshKeyType;
  publicKey: string;
  privateKey: string;
  fingerprint: string;
}

function openSshPrivateKey(publicKey: Buffer, seed: Buffer, comment: string): string {
  const publicBlob = ed25519Blob(publicKey);
  const check = randomBytes(4);
  let section = Buffer.concat([
    check,
    check,
    sshString("ssh-ed25519"),
    sshString(publicKey),
    sshString(Buffer.concat([seed, publicKey])),
    sshString(comment),
  ]);
  const padding: number[] = [];
  for (let n = 1; (section.length + padding.length) % 8 !== 0; n++) padding.push(n);
  section = Buffer.concat([section, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from(OPENSSH_MAGIC, "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(publicBlob),
    sshString(section),
  ]);
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrap(body.toString("base64"), 70)}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** A comment for the key line: the key's name with spaces turned into dashes. */
export function keyComment(name: string | undefined): string {
  const cleaned = (name ?? "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._@-]/g, "");
  return cleaned === "" ? "nearzero" : cleaned.slice(0, 64);
}

/** Generates a pair; RSA keys are made off the main thread, since 4096 bits takes a moment. */
export async function generateKeyPair(type: SshKeyType, name?: string): Promise<GeneratedKeyPair> {
  const comment = keyComment(name);
  if (type === "ed25519") {
    const { privateKey } = generateKeyPairSync("ed25519");
    const jwk = privateKey.export({ format: "jwk" });
    const publicKey = Buffer.from(jwk.x ?? "", "base64url");
    const seed = Buffer.from(jwk.d ?? "", "base64url");
    const blob = ed25519Blob(publicKey);
    return {
      type,
      publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
      privateKey: openSshPrivateKey(publicKey, seed, comment),
      fingerprint: fingerprintOf(blob),
    };
  }
  const { privateKey, publicKey } = await new Promise<{
    privateKey: KeyObject;
    publicKey: KeyObject;
  }>((resolve, reject) =>
    generateWithCallback(
      "rsa",
      { modulusLength: 4096, publicExponent: 0x10001 },
      (error, pub, priv) => (error ? reject(error) : resolve({ privateKey: priv, publicKey: pub })),
    ),
  );
  const jwk = publicKey.export({ format: "jwk" });
  const blob = rsaBlob(
    Buffer.from(jwk.n ?? "", "base64url"),
    Buffer.from(jwk.e ?? "", "base64url"),
  );
  return {
    type,
    publicKey: `ssh-rsa ${blob.toString("base64")} ${comment}`,
    privateKey: String(privateKey.export({ type: "pkcs1", format: "pem" })),
    fingerprint: fingerprintOf(blob),
  };
}
