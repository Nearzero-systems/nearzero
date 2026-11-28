import { z } from "zod";
import { isPublicIPv4 } from "./addresses.ts";
import { capSlug, slugify } from "./slugs.ts";

/**
 * Servers and SSH keys: fields, rules and the words of their messages (spec 09 9.1, 9.2, 9.7;
 * spec 10.2 for server labels). The control plane validates with these, and the console can use
 * the same ones so its words match.
 */

export const SERVER_NAME_MAX = 100;
export const SERVER_DESCRIPTION_MAX = 1000;
export const SSH_USER_MAX = 32;
export const SSH_KEY_NAME_MAX = 100;
export const SSH_KEY_DESCRIPTION_MAX = 1000;
/** A pasted private key is at most this long (a 16384-bit RSA key in PEM is about 12 KB). */
export const SSH_PRIVATE_KEY_MAX = 16_384;
export const SSH_PUBLIC_KEY_MAX = 8_192;
export const SERVER_LABEL_MAX = 40;
export const DEFAULT_SSH_PORT = 22;

export const SSH_USER_PLACEHOLDER = "ubuntu";
export const SSH_USER_HINT =
  "AWS Ubuntu servers use ubuntu, Amazon Linux uses ec2-user, Debian on AWS uses admin, and most VPS providers use root. A user other than root needs passwordless sudo; setup adds it to the Docker group.";

export const SERVER_MESSAGES = {
  addressRule: "Enter an IP address or hostname without a protocol, path, or port",
  keyNotFound: "Saved SSH key not found.",
  hasServices: "Server has active services, please delete them first",
  sshUserChanged:
    "Run setup again: files on the server are owned by the setup user, so the new user needs them.",
  noAccess: "You do not have access to servers.",
  hostKeyForgotten:
    "The host key recorded for the old address was forgotten. The next setup records the server's new one.",
  publicIPv4Rule:
    "Use the server's public IPv4 address, or leave it blank to use its address. Private, shared, loopback and reserved addresses can't be reached from the internet.",
  /** B1-15: the other server is never named. */
  addressOfAnotherWorkspace: "That address belongs to a server in another workspace.",
  /** B1-15, B1-43: the host's address is for people who may use the host. */
  addressOfHost: "That address belongs to the Nearzero host, which you aren't allowed to use.",
} as const;

/** 0.1.x's sentences for a taken name and a taken address (G3-08, spec 9.2, 21.10). */
export function duplicateServerNameMessage(name: string): string {
  return `A server named "${name}" already exists. Use another name, or change that server instead.`;
}

export function duplicateServerAddressMessage(
  otherName: string,
  address: string,
  port: number,
): string {
  return `"${otherName}" already uses ${address}:${port}. Change that server instead of adding the same machine twice.`;
}

export const SSH_KEY_MESSAGES = {
  invalidPublic: "Invalid public key format",
  invalidPrivate: "Invalid private key format",
  mismatch:
    "The private key doesn't belong to this public key. Paste the two halves of the same key pair.",
  passphrase:
    'This private key is protected by a passphrase, which setup can\'t type. Remove it (ssh-keygen -p -N "" -f <key file>) and paste it again.',
  storedHidden: "Stored private keys cannot be displayed",
  generated: "SSH key generated",
} as const;

/** Names every server a key is on: one in the singular, several in the plural (R3-08). */
/**
 * Why a key can't be deleted: the servers that sign in with it. Only the ones the person can see
 * are named; `hidden` counts the others (C1-13, spec 22.4 rule 3).
 */
export function sshKeyInUseMessage(serverNames: string | readonly string[], hidden = 0): string {
  const names = typeof serverNames === "string" ? [serverNames] : [...serverNames];
  if (names.length === 0 && hidden > 0) {
    return `This SSH key is attached to ${hidden === 1 ? "a server" : `${hidden} servers`} you can't see. Ask an owner or admin to remove ${hidden === 1 ? "it" : "them"} first.`;
  }
  const listed = [...names, ...(hidden > 0 ? [`${hidden} more you can't see`] : [])];
  if (listed.length <= 1) {
    return `This SSH key is attached to server: ${listed[0] ?? "another server"}. Remove that server first.`;
  }
  return `This SSH key is attached to servers: ${listed.join(", ")}. Remove those servers first.`;
}

// ---- Field rules

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_LABEL = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

export function isIPv4(value: string): boolean {
  return IPV4.test(value);
}

/** Loose but sufficient: hex groups and colons, at most one "::", no zone or port. */
export function isIPv6(value: string): boolean {
  if (!/^[0-9a-fA-F:.]+$/.test(value) || !value.includes(":")) return false;
  if ((value.match(/::/g) ?? []).length > 1) return false;
  const groups = value.split(":");
  return groups.length >= 3 && groups.length <= 8;
}

/** An IP address or a hostname, with no protocol, path, port or spaces (spec 9.2). */
export function isServerAddress(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  if (isIPv4(value) || isIPv6(value)) return true;
  // Something that looks like a dotted number but isn't a valid IPv4 address is a typo.
  if (/^[\d.]+$/.test(value)) return false;
  return value.split(".").every((label) => HOST_LABEL.test(label));
}

const SSH_USER = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

export const SSH_USER_RULE =
  "Use up to 32 characters: a letter or _ first, then letters, digits, _ or -.";

export function isSshUser(value: string): boolean {
  return SSH_USER.test(value);
}

const name = (max: number, empty: string) =>
  z
    .string({ error: empty })
    .transform((value) => value.trim())
    .pipe(z.string().min(1, empty).max(max, `Use at most ${max} characters.`));

const description = (max: number) =>
  z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().max(max, `Use at most ${max} characters.`));

const address = z
  .string({ error: "Enter the server's IP address or hostname." })
  .transform((value) => value.trim())
  .pipe(
    z
      .string()
      .min(1, "Enter the server's IP address or hostname.")
      .refine(isServerAddress, SERVER_MESSAGES.addressRule),
  )
  .transform((value) => value.toLowerCase());

const port = z
  .number({ error: "Enter a port from 1 to 65535." })
  .int("Enter a port from 1 to 65535.")
  .min(1, "Enter a port from 1 to 65535.")
  .max(65535, "Enter a port from 1 to 65535.");

const sshUser = z
  .string({ error: "Enter the SSH user, like ubuntu." })
  .transform((value) => value.trim())
  .pipe(z.string().min(1, "Enter the SSH user, like ubuntu.").refine(isSshUser, SSH_USER_RULE));

export const createServerRequestSchema = z.object({
  name: name(SERVER_NAME_MAX, "Enter a name for the server."),
  description: description(SERVER_DESCRIPTION_MAX).default(""),
  sshKeyId: z.string({ error: SERVER_MESSAGES.keyNotFound }).min(1, SERVER_MESSAGES.keyNotFound),
  address,
  port: port.default(DEFAULT_SSH_PORT),
  sshUser,
});
export type CreateServerRequest = z.input<typeof createServerRequestSchema>;

/** A server's public IPv4 (spec 10.2, 10.7): blank or null clears it. */
const publicIPv4 = z
  .string()
  .nullable()
  .transform((value) => (value ?? "").trim())
  .pipe(
    z
      .string()
      .refine((value) => value === "" || isPublicIPv4(value), SERVER_MESSAGES.publicIPv4Rule),
  )
  .transform((value) => (value === "" ? null : value));

export const updateServerRequestSchema = createServerRequestSchema.partial().extend({
  description: description(SERVER_DESCRIPTION_MAX).optional(),
  dockerCleanup: z.boolean().optional(),
  publicIPv4: publicIPv4.optional(),
});
export type UpdateServerRequest = z.input<typeof updateServerRequestSchema>;

/** The readiness badge on a server's card (spec 9.1). */
export const SERVER_READINESS = [
  "ready",
  "setup_needed",
  "setup_running",
  "setup_failed",
  "inactive",
] as const;
export type ServerReadiness = (typeof SERVER_READINESS)[number];

export const SERVER_READINESS_LABELS: Record<ServerReadiness, string> = {
  ready: "Ready",
  setup_needed: "Setup needed",
  setup_running: "Setup running",
  setup_failed: "Setup failed",
  inactive: "Inactive",
};

/** The runner's link as a person reads it on the server's page. */
export const RUNNER_STATES = ["online", "offline", "never_connected", "update_needed"] as const;
export type RunnerState = (typeof RUNNER_STATES)[number];

// ---- Server labels (spec 10.2)

/**
 * The label a server's hostnames live under, from its name: lowercase letters, digits and
 * single dashes, at most 40 characters, with `server-` in front of a leading digit (so it never
 * looks like a number or hex). Clashes get `-2`, `-3`… from {@link labelCandidates}.
 */
export function serverLabelBase(serverName: string): string {
  let slug = slugify(serverName);
  if (slug === "") slug = "server";
  if (/^\d/.test(slug)) slug = `server-${slug}`;
  return capSlug(slug, SERVER_LABEL_MAX);
}

/** The base, then base-2, base-3…, each kept within 40 characters. */
export function* labelCandidates(base: string): Generator<string> {
  yield base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    yield `${capSlug(base, SERVER_LABEL_MAX - suffix.length)}${suffix}`;
  }
}

// ---- SSH keys (spec 9.7)

export const SSH_KEY_TYPES = ["rsa", "ed25519"] as const;
export type SshKeyType = (typeof SSH_KEY_TYPES)[number];

const PUBLIC_LINE = /^(ssh-rsa|ssh-ed25519) ([A-Za-z0-9+/]+={0,2})( [^\r\n]*)?$/;
const PRIVATE_BLOCK =
  /^-----BEGIN (OPENSSH|RSA) PRIVATE KEY-----\r?\n[A-Za-z0-9+/=\r\n:,-]+?\r?\n?-----END \1 PRIVATE KEY-----\s*$/;

/** One `ssh-rsa` or `ssh-ed25519` line. Returns the type, or null. */
export function publicKeyLineType(value: string): SshKeyType | null {
  const match = PUBLIC_LINE.exec(value.trim());
  if (!match) return null;
  return match[1] === "ssh-rsa" ? "rsa" : "ed25519";
}

/** An OpenSSH or RSA PEM block. Returns which, or null. */
export function privateKeyBlockKind(value: string): "openssh" | "rsa" | null {
  const match = PRIVATE_BLOCK.exec(value.trim());
  if (!match) return null;
  return match[1] === "OPENSSH" ? "openssh" : "rsa";
}

export const createSshKeyRequestSchema = z.object({
  name: name(SSH_KEY_NAME_MAX, "Enter a name for the key."),
  description: description(SSH_KEY_DESCRIPTION_MAX).default(""),
  privateKey: z
    .string({ error: SSH_KEY_MESSAGES.invalidPrivate })
    .max(SSH_PRIVATE_KEY_MAX, SSH_KEY_MESSAGES.invalidPrivate)
    .refine((value) => privateKeyBlockKind(value) !== null, SSH_KEY_MESSAGES.invalidPrivate),
  publicKey: z
    .string({ error: SSH_KEY_MESSAGES.invalidPublic })
    .max(SSH_PUBLIC_KEY_MAX, SSH_KEY_MESSAGES.invalidPublic)
    .transform((value) => value.trim())
    .refine((value) => publicKeyLineType(value) !== null, SSH_KEY_MESSAGES.invalidPublic),
});
export type CreateSshKeyRequest = z.input<typeof createSshKeyRequestSchema>;

export const updateSshKeyRequestSchema = z.object({
  name: name(SSH_KEY_NAME_MAX, "Enter a name for the key.").optional(),
  description: description(SSH_KEY_DESCRIPTION_MAX).optional(),
});

export const generateSshKeyRequestSchema = z.object({
  type: z.enum(SSH_KEY_TYPES, { error: "Choose RSA or ED25519." }),
  /** Becomes the key's comment, like the file name it is saved as. */
  name: z.string().max(SSH_KEY_NAME_MAX).optional(),
});

// ---- The Nearzero host (spec 24 G3)

/** An instance administrator lets a workspace deploy to the Nearzero host, or stops it. */
export const hostAllowanceRequestSchema = z.object({ allowed: z.boolean() });
