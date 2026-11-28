import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Encryption at rest for secrets the control plane stores: model and research keys, email keys,
 * invitation links, two-factor secrets, and later Git tokens, SSH keys and passwords (spec 23.4).
 *
 * AES-256-GCM with a key derived from the install's authentication secret. Each sealed value is
 * bound to a context (like "workspace:<id>:model-key"), so a value copied into another row does
 * not open. A sealed value names the key it was made with, so a changed install secret shows as
 * "this can't be decrypted any more" (spec 04 4.8, "Add it again") rather than as damage.
 *
 * Format: nzs1.<key id>.<iv>.<ciphertext and tag>, each part base64url.
 */

const FORMAT = "nzs1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type OpenResult =
  | { ok: true; value: string }
  /** key_changed: sealed with another install secret. damaged: not a value this box made. */
  | { ok: false; reason: "key_changed" | "damaged" };

export class SecretBox {
  readonly keyId: string;
  readonly #key: Buffer;
  readonly #derivationRoot: Buffer;

  constructor(installSecret: string) {
    if (installSecret.length < 16) {
      throw new Error("The install secret is too short to derive keys from.");
    }
    this.#derivationRoot = Buffer.from(installSecret, "utf8");
    this.#key = this.deriveKey("secret storage v1");
    this.keyId = createHash("sha256")
      .update(this.#key)
      .update("key id")
      .digest("base64url")
      .slice(0, 10);
  }

  /** A separate 32-byte key for another purpose (signing proofs, for example). */
  deriveKey(purpose: string): Buffer {
    return Buffer.from(
      hkdfSync("sha256", this.#derivationRoot, "nearzero", `nearzero ${purpose}`, 32),
    );
  }

  seal(plaintext: string, context: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(Buffer.from(context, "utf8"));
    const body = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return [FORMAT, this.keyId, iv.toString("base64url"), body.toString("base64url")].join(".");
  }

  open(sealed: string, context: string): OpenResult {
    const parts = sealed.split(".");
    if (parts.length !== 4 || parts[0] !== FORMAT) return { ok: false, reason: "damaged" };
    const [, keyId, ivText, bodyText] = parts as [string, string, string, string];
    if (keyId !== this.keyId) return { ok: false, reason: "key_changed" };
    const iv = Buffer.from(ivText, "base64url");
    const body = Buffer.from(bodyText, "base64url");
    if (iv.length !== IV_BYTES || body.length < TAG_BYTES) return { ok: false, reason: "damaged" };
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(Buffer.from(context, "utf8"));
      decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(body.subarray(0, body.length - TAG_BYTES)),
        decipher.final(),
      ]);
      return { ok: true, value: plain.toString("utf8") };
    } catch {
      return { ok: false, reason: "damaged" };
    }
  }
}
