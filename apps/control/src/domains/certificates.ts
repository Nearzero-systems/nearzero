import { createPrivateKey, X509Certificate } from "node:crypto";
import {
  AppError,
  type CertificateFacts,
  type CertificateStatus,
  certificateAdvice,
  certificateCovers,
  certificateStatusSchema,
  type DnsHoldReason,
  type HttpsStatus,
  httpsStatus,
  retryRefusal,
} from "@nearzero/shared";
import { RunnerCommandError } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { consoleAcmeEmail } from "./addresses.ts";
import type { DnsCheck } from "./dns-check.ts";

/**
 * HTTPS for hostnames (spec 10.7). The router on each server keeps the certificates and asks
 * Let's Encrypt; its runner reports what it holds and what it tried. The control plane keeps the
 * last report per server, adds its own DNS check and the uploaded certificates, and turns that
 * into one state per hostname with the spec's notes and Retry refusals.
 */

export interface Snapshot {
  status: CertificateStatus | null;
  /** Why the last read failed (the older status is kept). */
  error: string | null;
  readAt: number | null;
}

const EMPTY: Snapshot = { status: null, error: null, readAt: null };

export async function loadSnapshots(
  services: ControlServices,
  targets: readonly string[],
): Promise<Map<string, Snapshot>> {
  const out = new Map<string, Snapshot>();
  const unique = [...new Set(targets)];
  if (unique.length === 0) return out;
  const rows = await services.db
    .selectFrom("certificate_snapshot")
    .select(["target", "status", "error", "read_at"])
    .where("target", "in", unique)
    .execute();
  for (const row of rows) {
    const parsed = certificateStatusSchema.safeParse(row.status);
    out.set(row.target, {
      status: parsed.success ? parsed.data : null,
      error: row.error,
      readAt: row.read_at.getTime(),
    });
  }
  return out;
}

/** Asks a server's runner for its certificates now, and keeps the answer. */
export async function refreshSnapshot(
  services: ControlServices,
  target: string,
): Promise<Snapshot> {
  try {
    const data = await services.runners.command(
      target,
      "certificates.status",
      {},
      { timeoutMs: 20_000 },
    );
    const status = certificateStatusSchema.parse(data);
    await services.db
      .insertInto("certificate_snapshot")
      .values({ target, status: JSON.stringify(status), error: null, read_at: new Date() })
      .onConflict((c) =>
        c
          .column("target")
          .doUpdateSet({ status: JSON.stringify(status), error: null, read_at: new Date() }),
      )
      .execute();
    return { status, error: null, readAt: Date.now() };
  } catch (error) {
    const message = (error as Error).message;
    await services.db
      .insertInto("certificate_snapshot")
      .values({ target, status: null, error: message, read_at: new Date() })
      .onConflict((c) => c.column("target").doUpdateSet({ error: message, read_at: new Date() }))
      .execute();
    const [kept] = (await loadSnapshots(services, [target])).values();
    return kept ?? { ...EMPTY, error: message };
  }
}

export interface UploadCover {
  id: string;
  name: string;
  target: string;
  names: string[];
  notAfter: number;
}

export async function uploadsFor(
  services: ControlServices,
  targets: readonly string[],
): Promise<UploadCover[]> {
  const unique = [...new Set(targets)];
  if (unique.length === 0) return [];
  const rows = await services.db
    .selectFrom("uploaded_certificate")
    .select(["id", "name", "target", "names", "not_after"])
    .where("target", "in", unique)
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    target: row.target,
    names: row.names,
    notAfter: row.not_after.getTime(),
  }));
}

const DNS_HOLDS = new Set<string>([
  "not_public",
  "address_unknown",
  "no_record",
  "points_elsewhere",
  "lookup_failed",
]);

/** The facts for one hostname, from its server's report, the uploads and the DNS check. */
export function factsFor(
  hostname: { host: string; connected: boolean; target: string },
  snapshot: Snapshot | undefined,
  uploads: readonly UploadCover[],
  dns: DnsCheck | null,
): CertificateFacts {
  const status = snapshot?.status ?? null;
  const upload = uploads
    .filter(
      (item) => item.target === hostname.target && certificateCovers(item.names, hostname.host),
    )
    .sort((a, b) => b.notAfter - a.notAfter)[0];
  const stored = (status?.certificates ?? [])
    .filter((cert) => cert.names.some((name) => name.toLowerCase() === hostname.host))
    .sort((a, b) => b.notAfter - a.notAfter)[0];
  const hold = status?.holds.find((item) => item.hostname === hostname.host)?.reason ?? null;
  const attempt = status?.attempts.find((item) => item.hostname === hostname.host);
  const dnsPointsHere =
    dns === null
      ? null
      : dns.status === "points_here"
        ? true
        : // Behind a proxy, or reachable over IPv6 only, Let's Encrypt may still validate it,
          // so neither counts as DNS being wrong (R3-11).
          dns.status === "lookup_failed" ||
            dns.status === "address_unknown" ||
            dns.status === "proxied" ||
            dns.status === "ipv6_only"
          ? null
          : false;
  return {
    hostname: hostname.host,
    connected: hostname.connected,
    uploaded: upload ? { name: upload.name, notAfter: upload.notAfter } : null,
    storeReadable: status?.readable === true,
    certificate: stored
      ? { notBefore: stored.notBefore, notAfter: stored.notAfter, issuer: stored.issuer }
      : null,
    hold: hold && DNS_HOLDS.has(hold) ? (hold as DnsHoldReason) : null,
    dnsPointsHere,
    failures: attempt?.failures ?? [],
    rateLimitedUntil: attempt?.rateLimitedUntil ?? null,
    // The router's error as plain advice with the fix (R3-18).
    lastError: attempt?.lastError
      ? certificateAdvice(attempt.lastError, hostname.host, dns?.expected ?? null)
      : null,
    lastErrorAt: attempt?.lastErrorAt ?? null,
    requestedAt: attempt?.requestedAt ?? null,
    retriedAt: attempt?.retriedAt ?? null,
  };
}

export interface HttpsView extends HttpsStatus {
  lastError: string | null;
  /** Why Retry would be refused now, or null when it may be pressed. */
  retryRefusal: string | null;
  certificate: { notAfter: string; issuer: string } | null;
}

export function httpsView(
  facts: CertificateFacts,
  lastAttemptAt: number | null,
  now = Date.now(),
): HttpsView {
  const state = httpsStatus(facts, now);
  return {
    ...state,
    lastError: facts.lastError,
    retryRefusal: retryRefusal(facts, now, lastAttemptAt),
    certificate: facts.certificate
      ? {
          notAfter: new Date(facts.certificate.notAfter).toISOString(),
          issuer: facts.certificate.issuer,
        }
      : null,
  };
}

// ---- Uploaded certificates: reading PEM (spec 10.7)

export const CERTIFICATE_MESSAGES = {
  notPem: "Paste the certificate in PEM form: it starts with -----BEGIN CERTIFICATE-----.",
  badCertificate: "That certificate can't be read. Paste the PEM block exactly as your CA gave it.",
  notKey:
    "Paste the private key in PEM form: it starts with -----BEGIN PRIVATE KEY----- (or RSA or EC PRIVATE KEY).",
  encryptedKey:
    "That private key is protected with a passphrase. Remove the passphrase, then paste it again.",
  mismatch: "The private key doesn't belong to this certificate.",
  noNames: "That certificate names no hostnames, so it can't cover any.",
} as const;

export interface ParsedCertificate {
  pem: string;
  names: string[];
  notBefore: Date;
  notAfter: Date;
  issuer: string;
  fingerprint: string;
}

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;

export function parseCertificate(pem: string): ParsedCertificate {
  const blocks = pem.match(CERT_BLOCK);
  if (!blocks || blocks.length === 0) {
    throw new AppError("invalid_request", CERTIFICATE_MESSAGES.notPem, {
      fields: { certificate: CERTIFICATE_MESSAGES.notPem },
    });
  }
  let leaf: X509Certificate;
  try {
    for (const block of blocks) new X509Certificate(block);
    leaf = new X509Certificate(blocks[0] as string);
  } catch {
    throw new AppError("invalid_request", CERTIFICATE_MESSAGES.badCertificate, {
      fields: { certificate: CERTIFICATE_MESSAGES.badCertificate },
    });
  }
  const names = new Set<string>();
  for (const part of (leaf.subjectAltName ?? "").split(",")) {
    const match = /^\s*DNS:(.+)$/.exec(part);
    if (match) names.add((match[1] as string).trim().toLowerCase());
  }
  if (names.size === 0) {
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(leaf.subject);
    if (cn) names.add((cn[1] as string).trim().toLowerCase());
  }
  if (names.size === 0) {
    throw new AppError("invalid_request", CERTIFICATE_MESSAGES.noNames, {
      fields: { certificate: CERTIFICATE_MESSAGES.noNames },
    });
  }
  const issuer = /(?:^|\n)(?:O|CN)=([^\n]+)/.exec(leaf.issuer)?.[1] ?? leaf.issuer;
  return {
    pem: blocks.join("\n").concat("\n"),
    names: [...names],
    notBefore: new Date(leaf.validFrom),
    notAfter: new Date(leaf.validTo),
    issuer: issuer.trim(),
    fingerprint: leaf.fingerprint256,
  };
}

/** Checks that a private key is PEM, unencrypted, and belongs to the certificate. */
export function checkKeyMatches(certificatePem: string, keyPem: string): string {
  const trimmed = keyPem.trim();
  if (/ENCRYPTED/.test(trimmed)) {
    throw new AppError("invalid_request", CERTIFICATE_MESSAGES.encryptedKey, {
      fields: { privateKey: CERTIFICATE_MESSAGES.encryptedKey },
    });
  }
  if (
    !/^-----BEGIN (RSA |EC )?PRIVATE KEY-----[\s\S]+-----END (RSA |EC )?PRIVATE KEY-----$/.test(
      trimmed,
    )
  ) {
    throw new AppError("invalid_request", CERTIFICATE_MESSAGES.notKey, {
      fields: { privateKey: CERTIFICATE_MESSAGES.notKey },
    });
  }
  let matches = false;
  try {
    const leaf = new X509Certificate((certificatePem.match(CERT_BLOCK) as string[])[0] as string);
    matches = leaf.checkPrivateKey(createPrivateKey(trimmed));
  } catch {
    throw new AppError("invalid_request", CERTIFICATE_MESSAGES.notKey, {
      fields: { privateKey: CERTIFICATE_MESSAGES.notKey },
    });
  }
  if (!matches) {
    throw new AppError("invalid_request", CERTIFICATE_MESSAGES.mismatch, {
      fields: { privateKey: CERTIFICATE_MESSAGES.mismatch },
    });
  }
  return `${trimmed}\n`;
}

export function keyContext(id: string): string {
  return `uploaded-certificate:${id}`;
}

/**
 * Gives a server's router exactly the uploaded certificates it should hold. `extra` adds one not
 * saved yet (an upload being made), `without` leaves one out (a delete being made).
 */
export async function pushUploads(
  services: ControlServices,
  target: string,
  change: { extra?: { id: string; pem: string; keyPem: string }; without?: string } = {},
): Promise<void> {
  const rows = await services.db
    .selectFrom("uploaded_certificate")
    .select(["id", "certificate_pem", "key_sealed"])
    .where("target", "=", target)
    .execute();
  const certificates: { id: string; certificatePem: string; keyPem: string }[] = [];
  for (const row of rows) {
    if (row.id === change.without || row.id === change.extra?.id) continue;
    const opened = services.secrets.open(row.key_sealed, keyContext(row.id));
    if (!opened.ok) continue;
    certificates.push({ id: row.id, certificatePem: row.certificate_pem, keyPem: opened.value });
  }
  if (change.extra) {
    certificates.push({
      id: change.extra.id,
      certificatePem: change.extra.pem,
      keyPem: change.extra.keyPem,
    });
  }
  await services.runners.command(
    target,
    "certificates.uploads",
    { certificates },
    { timeoutMs: 30_000 },
  );
}

/**
 * Gives routers the certificate contact email (spec 10.1: the one set under About Nearzero is the
 * one the router uses for new certificates; the install's until one is saved). With no target,
 * every connected runner gets it; runners that join later get it when they connect. A runner too
 * old to know the command keeps the email it was installed with.
 */
export async function pushCertificateContact(
  services: ControlServices,
  target?: string,
): Promise<void> {
  const email = await consoleAcmeEmail(services);
  if (!email) return;
  const targets = target ? [target] : services.runners.onlineTargets();
  for (const each of targets) {
    try {
      await services.runners.command(
        each,
        "certificates.contact",
        { email },
        { timeoutMs: 30_000 },
      );
    } catch (error) {
      if (error instanceof RunnerCommandError && error.runnerCode === "unsupported") continue;
      services.log.warn("couldn't give a router the certificate contact email", {
        target: each,
        error,
      });
    }
  }
}
