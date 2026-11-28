import { X509Certificate } from "node:crypto";
import {
  failureCountsTowardPause,
  isRateLimitError,
  ROUTER_CONTAINER,
  type StoredCertificate,
} from "@nearzero/shared";
import { type DockerClient, DockerError } from "../docker/client.ts";

/**
 * What the router knows about its Let's Encrypt certificates (spec 10.7): the certificates in its
 * store (acme.json in the router's certificates volume, read through Docker without starting
 * anything), and the failed attempts it logs. Only names and dates leave this module, never a key.
 */

export const ACME_STORE_PATH = "/certificates/acme.json";

/** The first regular file in a tar archive (Docker's archive endpoint returns one). */
export function firstTarFile(tar: Uint8Array): Uint8Array | null {
  let offset = 0;
  const decoder = new TextDecoder();
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) return null;
    const size = Number.parseInt(
      decoder.decode(header.subarray(124, 136)).replace(/\0.*$/, "").trim() || "0",
      8,
    );
    const type = String.fromCharCode(header[156] ?? 0);
    const start = offset + 512;
    if (type === "0" || type === "\0") return tar.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

interface AcmeFile {
  [resolver: string]: {
    Certificates?: { domain?: { main?: string; sans?: string[] }; certificate?: string }[] | null;
  };
}

/** The certificates in an acme.json document. */
export function certificatesIn(json: string): StoredCertificate[] {
  const parsed = JSON.parse(json) as AcmeFile;
  const out: StoredCertificate[] = [];
  for (const resolver of Object.values(parsed ?? {})) {
    for (const entry of resolver?.Certificates ?? []) {
      if (!entry?.certificate) continue;
      try {
        const pem = Buffer.from(entry.certificate, "base64").toString("utf8");
        const leaf = new X509Certificate(
          pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0] ?? pem,
        );
        const names = new Set<string>();
        if (entry.domain?.main) names.add(entry.domain.main.toLowerCase());
        for (const san of entry.domain?.sans ?? []) names.add(san.toLowerCase());
        for (const part of (leaf.subjectAltName ?? "").split(",")) {
          const match = /^\s*DNS:(.+)$/.exec(part);
          if (match) names.add((match[1] as string).trim().toLowerCase());
        }
        const issuer = /(?:^|\n)(?:O|CN)=([^\n]+)/.exec(leaf.issuer)?.[1] ?? leaf.issuer;
        out.push({
          names: [...names],
          notBefore: Date.parse(leaf.validFrom),
          notAfter: Date.parse(leaf.validTo),
          issuer: issuer.trim(),
        });
      } catch {
        // A damaged entry is left out; the router asks again for its name.
      }
    }
  }
  return out;
}

/** Reads the router's certificate store. A store that doesn't exist yet holds nothing. */
export async function readStoredCertificates(docker: DockerClient): Promise<StoredCertificate[]> {
  let response: Response;
  try {
    response = await docker.request("GET", `/containers/${ROUTER_CONTAINER}/archive`, {
      query: { path: ACME_STORE_PATH },
    });
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return [];
    throw error;
  }
  const file = firstTarFile(new Uint8Array(await response.arrayBuffer()));
  if (!file || file.length === 0) return [];
  return certificatesIn(new TextDecoder().decode(file));
}

// ---- The router's log: failed attempts

export interface AcmeFailure {
  hostnames: string[];
  at: number;
  rateLimited: boolean;
  /**
   * Whether it counts toward the 3-per-hour pause: only a check Let's Encrypt made of the name
   * (R3-18). Couldn't reach Let's Encrypt, or a name refused by policy, doesn't.
   */
  counts: boolean;
  /** The reason, shortened for people. */
  message: string;
  raw: string;
}

const FAILURE_MESSAGES = [
  /unable to obtain acme certificate/i,
  /error renewing certificate/i,
  /cannot obtain certificates/i,
];

/** The hostnames an ACME log entry is about. */
function hostnamesOf(entry: Record<string, unknown>, error: string): string[] {
  const names = new Set<string>();
  const domains = entry.domains;
  if (Array.isArray(domains))
    for (const d of domains) if (typeof d === "string") names.add(d.toLowerCase());
  const domain = entry.domain as { main?: string; sans?: string[] } | undefined;
  if (domain?.main) names.add(domain.main.toLowerCase());
  if (names.size === 0 && typeof entry.rule === "string") {
    for (const match of entry.rule.matchAll(/Host\(`([^`]+)`\)/g))
      names.add((match[1] as string).toLowerCase());
  }
  if (names.size === 0) {
    const listed = /for the domains? \[([^\]]+)\]/i.exec(error);
    for (const name of listed?.[1]?.split(/[\s,]+/) ?? []) if (name) names.add(name.toLowerCase());
  }
  return [...names];
}

/** The useful part of an ACME error: after the error type, without the long preamble. */
export function shortReason(error: string): string {
  const flat = error.replace(/\s+/g, " ").trim();
  const typed = /urn:ietf:params:acme:error:([A-Za-z]+) :: (.+)$/.exec(flat);
  let reason = typed ? `${typed[1]}: ${typed[2]}` : flat;
  // Traefik lists problems in brackets; the last one's closing bracket isn't part of it.
  if (reason.endsWith("]") && !reason.includes("[")) reason = reason.slice(0, -1);
  return reason.length > 400 ? `${reason.slice(0, 397)}...` : reason;
}

/** One line of the router's JSON log, as a failed attempt, or null when it isn't one. */
export function parseAcmeLine(line: string, now = Date.now()): AcmeFailure | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const level = String(entry.level ?? "").toLowerCase();
  const message = String(entry.message ?? entry.msg ?? "");
  if (level !== "error" && level !== "warn" && level !== "warning") return null;
  if (!FAILURE_MESSAGES.some((pattern) => pattern.test(message))) return null;
  const error = String(entry.error ?? "");
  const hostnames = hostnamesOf(entry, error);
  if (hostnames.length === 0) return null;
  const time = typeof entry.time === "string" ? Date.parse(entry.time) : Number.NaN;
  return {
    hostnames,
    at: Number.isNaN(time) ? now : time,
    rateLimited: isRateLimitError(error),
    counts: failureCountsTowardPause(error),
    message: shortReason(error || message),
    raw: error,
  };
}
