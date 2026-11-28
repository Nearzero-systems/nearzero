import { z } from "zod";
import { isIPv4, isIPv6 } from "./servers.ts";
import { capSlug, slugify } from "./slugs.ts";

/**
 * Hostnames, certificates and managed DNS zones (spec 10): the rules both the control plane and
 * the console apply, in the spec's words. Everything here is pure, so it is unit-tested without
 * a database, a resolver or a runner.
 */

// ---- Where hostnames come from (spec 10.1)

export const HOSTNAME_SOURCES = ["platform", "server", "zone", "own"] as const;
export type HostnameSource = (typeof HOSTNAME_SOURCES)[number];

/** How the Hostnames table names a hostname's DNS source (spec 10.4). */
export function dnsSourceLabel(source: HostnameSource, zone: string | null): string {
  switch (source) {
    case "platform":
    case "server":
      return "Platform domain";
    case "zone":
      return `Nearzero DNS · ${zone ?? "zone"}`;
    case "own":
      return "Your DNS provider";
  }
}

// ---- Validating a hostname someone typed (spec 10.5 step 1)

export const HOSTNAME_MESSAGES = {
  empty: "Enter a hostname, like app.example.com.",
  scheme: "Leave out http:// or https://.",
  pathOrPort: "Enter just the hostname, without a path or port.",
  wildcard:
    "Wildcards can't be added here. Add each hostname on its own; a wildcard certificate can be uploaded under Uploaded certificates.",
  notFull: "Use a full hostname, like app.example.com, not just one name.",
  invalid: "That isn't a valid hostname.",
  ipAddress: "Use a hostname, like app.example.com, not an IP address.",
} as const;

export function numericLabelMessage(label: string): string {
  return `"${label}" looks like a number, which browsers read as an address. Put a letter in it, like app-${label}.`;
}

export function reservedHostnameMessage(hostname: string): string {
  return `${hostname} is reserved for Nearzero itself. Pick another hostname.`;
}

export function duplicateHostnameMessage(hostname: string): string {
  return `${hostname} is already added. Find it in the Hostnames list.`;
}

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * Labels that look like numbers or hex (all digits, or 0x…). Browsers parse a name whose last
 * label is one as an IPv4 address, so such a hostname is refused; digits anywhere else are fine
 * (123.example.com). Generated and derived labels never look like one (spec 10.1).
 */
export function isNumericLikeLabel(label: string): boolean {
  return /^\d+$/.test(label) || /^0x[0-9a-f]*$/i.test(label);
}

export type HostnameCheck = { ok: true; hostname: string } | { ok: false; message: string };

/** Checks and normalizes a hostname typed into Add domain (lowercase, no trailing dot). */
export function checkHostnameInput(raw: string): HostnameCheck {
  const value = raw.trim();
  if (value === "") return { ok: false, message: HOSTNAME_MESSAGES.empty };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
    return { ok: false, message: HOSTNAME_MESSAGES.scheme };
  if (value.includes("*")) return { ok: false, message: HOSTNAME_MESSAGES.wildcard };
  if (isIPv4(value) || isIPv6(value.replace(/^\[|\]$/g, ""))) {
    return { ok: false, message: HOSTNAME_MESSAGES.ipAddress };
  }
  if (/[/?#:@\\]/.test(value)) return { ok: false, message: HOSTNAME_MESSAGES.pathOrPort };
  if (/\s/.test(value)) return { ok: false, message: HOSTNAME_MESSAGES.invalid };
  let host = value.toLowerCase().replace(/\.$/, "");
  // Internationalized names are stored in their ASCII (punycode) form.
  if ([...host].some((char) => char.charCodeAt(0) > 127)) {
    try {
      host = new URL(`http://${host}/`).hostname;
    } catch {
      return { ok: false, message: HOSTNAME_MESSAGES.invalid };
    }
  }
  if (!host.includes(".")) return { ok: false, message: HOSTNAME_MESSAGES.notFull };
  if (host.length > 253) return { ok: false, message: HOSTNAME_MESSAGES.invalid };
  const labels = host.split(".");
  if (!labels.every((label) => LABEL.test(label))) {
    return { ok: false, message: HOSTNAME_MESSAGES.invalid };
  }
  // Only the last label matters to browsers (spec 10.1).
  const last = labels[labels.length - 1] as string;
  if (isNumericLikeLabel(last)) return { ok: false, message: numericLabelMessage(last) };
  return { ok: true, hostname: host };
}

/** Whether `hostname` is `parent` or under it. */
export function isWithin(hostname: string, parent: string): boolean {
  return hostname === parent || hostname.endsWith(`.${parent}`);
}

// ---- Labels Nearzero makes (spec 10.1, 10.2)

const LABEL_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const LABEL_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
export const GENERATED_LABEL_LENGTH = 8;

/**
 * A short random label, like a3f9c2b1, from random bytes. It starts with a letter, so it never
 * looks like a number, and it is never the service's name.
 */
export function generatedLabel(bytes: Uint8Array): string {
  if (bytes.length < GENERATED_LABEL_LENGTH) throw new Error("Not enough random bytes.");
  let label = LABEL_LETTERS[(bytes[0] as number) % LABEL_LETTERS.length] as string;
  for (let i = 1; i < GENERATED_LABEL_LENGTH; i++) {
    label += LABEL_CHARACTERS[(bytes[i] as number) % LABEL_CHARACTERS.length];
  }
  return label;
}

/**
 * The label a managed zone gives a service from its name: an app named web gets web (spec 10.1).
 * `app-` goes in front of a leading digit (server labels get `server-` instead).
 */
export function nameLabel(name: string, maxLength = 63): string {
  let slug = slugify(name);
  if (slug === "") slug = "app";
  if (/^\d/.test(slug)) slug = `app-${slug}`;
  return capSlug(slug, maxLength);
}

/**
 * The name prefix of an environment default: dot-separated labels, or empty. Digits are fine in
 * it: the zone always comes after it, so it is never a hostname's last label (spec 10.1).
 */
export function checkNamePrefix(
  raw: string,
): { ok: true; prefix: string } | { ok: false; message: string } {
  const prefix = raw
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  if (prefix === "") return { ok: true, prefix: "" };
  const labels = prefix.split(".");
  if (prefix.length > 100 || !labels.every((label) => LABEL.test(label))) {
    return {
      ok: false,
      message: 'Use letters, digits and dashes for the name prefix, like "staging".',
    };
  }
  return { ok: true, prefix };
}

// ---- Records people add at their DNS provider

/** The name of a record relative to its DNS zone: "@" for the apex itself. */
export function relativeRecordName(fqdn: string, zone: string): string {
  const name = fqdn.replace(/\.$/, "").toLowerCase();
  const apex = zone.replace(/\.$/, "").toLowerCase();
  if (name === apex) return "@";
  if (name.endsWith(`.${apex}`)) return name.slice(0, -(apex.length + 1));
  return name;
}

/** The wildcard record a server's hostnames need: *.<label>.<platform domain> (spec 10.2). */
export function serverWildcardName(serverLabel: string, platformDomain: string): string {
  return `*.${serverLabel}.${platformDomain}`;
}

// ---- HTTPS states (spec 10.7)

export const HTTPS_STATES = [
  "valid",
  "expires_soon",
  "expired",
  "uploaded",
  "not_trusted",
  "not_in_use",
  "waiting_for_dns",
  "queued",
  "issuing",
  "rate_limited",
  "paused",
  "failed",
  "unknown",
] as const;
export type HttpsState = (typeof HTTPS_STATES)[number];

export const HTTPS_STATE_LABELS: Record<HttpsState, string> = {
  valid: "Valid",
  expires_soon: "Expires soon",
  expired: "Expired",
  uploaded: "Uploaded",
  not_trusted: "Not trusted",
  not_in_use: "Not in use",
  waiting_for_dns: "Waiting for DNS",
  queued: "Queued",
  issuing: "Issuing",
  rate_limited: "Rate limited",
  paused: "Paused",
  failed: "Failed",
  unknown: "Unknown",
};

/** Why the runner holds a hostname on the placeholder certificate (from the runner protocol). */
export type DnsHoldReason =
  | "not_public"
  | "address_unknown"
  | "no_record"
  | "points_elsewhere"
  | "lookup_failed";

/** Everything known about one hostname's certificate, from the runner and the DNS check. */
export interface CertificateFacts {
  hostname: string;
  /** A service is connected, so the hostname has a route. */
  connected: boolean;
  /** An uploaded certificate on its server covers it. */
  uploaded: { name: string; notAfter: number } | null;
  /** The runner answered with its certificate store. False means "Couldn't read certificates". */
  storeReadable: boolean;
  /** The router's Let's Encrypt certificate for it, if one exists. */
  certificate: { notBefore: number; notAfter: number; issuer: string } | null;
  /** The runner's DNS hold, or null when Let's Encrypt may be asked. */
  hold: DnsHoldReason | null;
  /** The control plane's own lookup: true when DNS points at the server, null when unknown. */
  dnsPointsHere: boolean | null;
  /** Times of failed validations (milliseconds), any order. */
  failures: readonly number[];
  rateLimitedUntil: number | null;
  lastError: string | null;
  /**
   * When the last error happened, including errors that don't count toward the pause (R3-18).
   * Runners that don't report it leave it out; the newest failure stands in for it.
   */
  lastErrorAt?: number | null;
  /** When Nearzero last asked Let's Encrypt (a hold released, or Retry). */
  requestedAt: number | null;
  /** A Retry after a pause: failures before it no longer pause requests. */
  retriedAt: number | null;
}

export const HOUR_MS = 60 * 60_000;
export const DAY_MS = 24 * HOUR_MS;
/** Requests pause after this many failed validations in an hour (spec 10.7). */
export const PAUSE_AFTER_FAILURES = 3;
/** Retry is refused from this many failures in the last hour (Let's Encrypt allows 5). */
export const RETRY_REFUSED_FROM_FAILURES = 4;
/** A Let's Encrypt rate limit without a retry-after time holds this long. */
export const RATE_LIMIT_DEFAULT_MS = HOUR_MS;
/** Retry waits this long after the last attempt. */
export const RETRY_MIN_INTERVAL_MS = 60_000;
/** An attempt with no answer after this long is no longer shown as Issuing. */
const ISSUING_FOR_MS = 10 * 60_000;
/** Certificates renew this long before they expire. */
export const RENEW_BEFORE_MS = 30 * DAY_MS;
/** A hostname warns this long before its uploaded certificate ends (R3-19). */
export const UPLOAD_WARNING_MS = 14 * DAY_MS;

/** Failures within the hour before `now`, oldest first. */
export function recentFailures(failures: readonly number[], now: number): number[] {
  return failures.filter((at) => at > now - HOUR_MS && at <= now).sort((a, b) => a - b);
}

/**
 * Until when requests for a hostname are paused: after 3 failed validations in an hour, until an
 * hour after the first of them. A Retry lifts the pause for the failures before it. Null when
 * not paused.
 */
export function pausedUntil(
  failures: readonly number[],
  now: number,
  retriedAt: number | null = null,
): number | null {
  const counted = recentFailures(failures, now).filter(
    (at) => retriedAt === null || at > retriedAt,
  );
  if (counted.length < PAUSE_AFTER_FAILURES) return null;
  const until = (counted[0] as number) + HOUR_MS;
  return until > now ? until : null;
}

/** Whether a certificate is close to its end: less than min(20 days, a quarter of its life). */
export function expiresSoon(notBefore: number, notAfter: number, now: number): boolean {
  const lifetime = Math.max(0, notAfter - notBefore);
  return notAfter - now < Math.min(20 * DAY_MS, lifetime / 4);
}

export interface HttpsStatus {
  state: HttpsState;
  label: string;
  note: string;
  /** When it can next be tried (paused, rate limited). */
  until: number | null;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16).concat(" UTC");
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function status(state: HttpsState, note: string, until: number | null = null): HttpsStatus {
  return { state, label: HTTPS_STATE_LABELS[state], note, until };
}

/** The HTTPS state of a hostname and its note (spec 10.7). */
export function httpsStatus(facts: CertificateFacts, now: number): HttpsStatus {
  if (!facts.connected) return status("not_in_use", "Connect a service to get a certificate.");
  if (facts.uploaded) {
    if (facts.uploaded.notAfter < now) {
      return status(
        "expired",
        `The uploaded certificate "${facts.uploaded.name}" expired on ${formatDate(facts.uploaded.notAfter)}. Upload a new one, or delete it to use Let's Encrypt.`,
      );
    }
    // Nobody renews an uploaded certificate, so its end is announced early (R3-19).
    if (facts.uploaded.notAfter - now < UPLOAD_WARNING_MS) {
      return status(
        "expires_soon",
        `The uploaded certificate "${facts.uploaded.name}" ends on ${formatDate(facts.uploaded.notAfter)}. Nearzero can't renew uploaded certificates: upload a new one before then, or delete it to use Let's Encrypt.`,
      );
    }
    return status(
      "uploaded",
      `Covered by the uploaded certificate "${facts.uploaded.name}", valid until ${formatDate(facts.uploaded.notAfter)}.`,
    );
  }
  if (!facts.storeReadable) return status("unknown", "Couldn't read certificates on this server.");
  const cert = facts.certificate;
  if (cert) {
    if (cert.notAfter <= now) {
      return status(
        "expired",
        `Expired on ${formatDate(cert.notAfter)}. Nearzero asks Let's Encrypt again once DNS points here.`,
      );
    }
    if (expiresSoon(cert.notBefore, cert.notAfter, now)) {
      return status(
        "expires_soon",
        `Expires on ${formatDate(cert.notAfter)}. It renews automatically; if it doesn't, check DNS and press Retry.`,
      );
    }
    return status("valid", `Valid until ${formatDate(cert.notAfter)}. Renews automatically.`);
  }
  if (facts.rateLimitedUntil !== null && facts.rateLimitedUntil > now) {
    return status(
      "rate_limited",
      `Let's Encrypt limited requests for this domain. Retry after ${formatTime(facts.rateLimitedUntil)}.`,
      facts.rateLimitedUntil,
    );
  }
  const paused = pausedUntil(facts.failures, now, facts.retriedAt);
  if (paused !== null) {
    const count = recentFailures(facts.failures, now).length;
    return status(
      "paused",
      `Failed ${count} times in the last hour, so Nearzero stopped asking Let's Encrypt until ${formatTime(paused)}.${facts.lastError ? ` Last error: ${facts.lastError}` : ""} Fix it, then press Retry.`,
      paused,
    );
  }
  if (facts.hold === "not_public") {
    return status(
      "not_trusted",
      "This name can't get a public certificate, so the router's default certificate is served.",
    );
  }
  if (facts.hold !== null) {
    if (facts.dnsPointsHere === true) {
      return status(
        "queued",
        "DNS points here now. Nearzero asks Let's Encrypt within 5 minutes, or press Check DNS to ask now.",
      );
    }
    return status(
      "waiting_for_dns",
      "The router serves a placeholder certificate and asks Let's Encrypt once DNS points here.",
    );
  }
  // The newest error, whether or not it counts toward the pause (R3-18).
  const lastFailure =
    facts.lastErrorAt !== undefined &&
    facts.lastErrorAt !== null &&
    facts.lastErrorAt > now - HOUR_MS
      ? facts.lastErrorAt
      : (recentFailures(facts.failures, now).at(-1) ?? null);
  if (
    facts.lastError &&
    lastFailure !== null &&
    (facts.requestedAt === null || lastFailure >= facts.requestedAt)
  ) {
    return status("failed", facts.lastError);
  }
  if (facts.requestedAt !== null && now - facts.requestedAt < ISSUING_FOR_MS) {
    return status("issuing", "Asking Let's Encrypt; usually under a minute.");
  }
  return status("not_trusted", "The router's default certificate is being served.");
}

/**
 * Why Retry is refused for a hostname, or null when it may go ahead (spec 10.7). Checked in the
 * spec's order.
 */
export function retryRefusal(facts: CertificateFacts, now: number, lastAttemptAt: number | null) {
  const host = facts.hostname;
  if (!facts.connected) {
    return `Connect a service to ${host} first. Certificates are only requested for hostnames that serve something.`;
  }
  if (facts.uploaded) {
    return `The uploaded certificate "${facts.uploaded.name}" covers ${host}, so Let's Encrypt isn't asked. Delete it under Uploaded certificates to use Let's Encrypt instead.`;
  }
  const cert = facts.certificate;
  if (cert && cert.notAfter > now) {
    return `${host} already has a valid certificate (until ${formatDate(cert.notAfter)}), and it renews by itself.`;
  }
  const dnsWrong =
    facts.dnsPointsHere === false ||
    (facts.dnsPointsHere === null && facts.hold !== null && facts.hold !== "lookup_failed");
  if (facts.hold === "not_public") {
    return `${host} can't get a public certificate: Let's Encrypt only issues for public domain names.`;
  }
  if (dnsWrong) {
    return `DNS for ${host} doesn't point at this server yet, so Let's Encrypt would refuse it. Fix the record, then press Check DNS.`;
  }
  if (facts.rateLimitedUntil !== null && facts.rateLimitedUntil > now) {
    return `Let's Encrypt limited requests for this domain. Try again after ${formatTime(facts.rateLimitedUntil)}.`;
  }
  const recent = recentFailures(facts.failures, now);
  if (recent.length >= RETRY_REFUSED_FROM_FAILURES) {
    return `Let's Encrypt allows 5 failed checks per hour. Try again after ${formatTime((recent[0] as number) + HOUR_MS)}.`;
  }
  if (lastAttemptAt !== null && now - lastAttemptAt < RETRY_MIN_INTERVAL_MS) {
    return "Nearzero asked Let's Encrypt less than a minute ago. Wait a minute, then try again.";
  }
  return null;
}

/** Whether an uploaded certificate's names cover a hostname (exact, or a one-label wildcard). */
export function certificateCovers(names: readonly string[], hostname: string): boolean {
  const host = hostname.toLowerCase();
  return names.some((raw) => {
    const name = raw.toLowerCase();
    if (name === host) return true;
    if (!name.startsWith("*.")) return false;
    const parent = name.slice(2);
    const dot = host.indexOf(".");
    return dot > 0 && host.slice(dot + 1) === parent;
  });
}

/**
 * The retry-after time in a Let's Encrypt rate-limit error ("retry after 2026-01-02 03:04:05
 * UTC"), or null.
 */
export function retryAfterIn(message: string): number | null {
  const phrase = "retry after ";
  const start = message.toLowerCase().indexOf(phrase);
  if (start < 0) return null;
  // "YYYY-MM-DD", one separator (a space or "T"), then "HH:MM:SS"; a zone after it is UTC.
  const rest = message.slice(start + phrase.length);
  const datePart = rest.slice(0, 10);
  const separator = rest.charAt(10);
  const timePart = rest.slice(11, 19);
  if (separator !== " " && separator !== "T" && separator !== "t") return null;
  const dateNumbers = datePart.split("-");
  const timeNumbers = timePart.split(":");
  const digits = (part: string, length: number) =>
    part.length === length && [...part].every((c) => c >= "0" && c <= "9");
  if (dateNumbers.length !== 3 || timeNumbers.length !== 3) return null;
  const [year, month, day] = dateNumbers as [string, string, string];
  const [hours, minutes, seconds] = timeNumbers as [string, string, string];
  if (!digits(year, 4) || !digits(month, 2) || !digits(day, 2)) return null;
  if (!digits(hours, 2) || !digits(minutes, 2) || !digits(seconds, 2)) return null;
  const at = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hours),
    Number(minutes),
    Number(seconds),
  );
  const check = new Date(at);
  // Refuse dates that don't exist (2026-02-30 would roll over into March).
  if (
    check.getUTCMonth() !== Number(month) - 1 ||
    check.getUTCDate() !== Number(day) ||
    Number(hours) > 23
  )
    return null;
  return at;
}

/** Whether an ACME error is a rate limit rather than a failed validation. */
export function isRateLimitError(message: string): boolean {
  return /urn:ietf:params:acme:error:rateLimited|too many (certificates|failed authorizations|new orders|requests)/i.test(
    message,
  );
}

/** The ACME problem type an error names ("connection", "dns", …), or null when it names none. */
export function acmeProblemType(error: string): string | null {
  return /urn:ietf:params:acme:error:([A-Za-z]+)/.exec(error)?.[1] ?? null;
}

/** Problem types that mean Let's Encrypt checked the name, and the check failed (RFC 8555). */
const VALIDATION_PROBLEMS = new Set([
  "caa",
  "compound",
  "connection",
  "dns",
  "incorrectResponse",
  "tls",
  "unauthorized",
]);

/**
 * Whether a failed attempt counts toward the 3-per-hour pause (spec 10.7, R3-18): only checks
 * Let's Encrypt made of the name and that failed. When the server couldn't reach Let's Encrypt
 * (the error names no ACME problem), or the name was refused by policy, Let's Encrypt never
 * checked it, so it counts toward none of its limits either.
 */
export function failureCountsTowardPause(error: string): boolean {
  const type = acmeProblemType(error);
  return type !== null && VALIDATION_PROBLEMS.has(type);
}

/** The address an ACME connection error names (Let's Encrypt says which one it tried). */
function triedAddress(text: string): { address: string; ipv6: boolean } | null {
  const v6 =
    /\[([0-9a-fA-F]*:[0-9a-fA-F:]+)\]/.exec(text) ??
    /(?:^|\s)([0-9a-fA-F]{0,4}(?::[0-9a-fA-F]{0,4}){2,7}):\s/.exec(text);
  if (v6?.[1]) return { address: v6[1], ipv6: true };
  const v4 = /\b(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(text);
  return v4?.[1] ? { address: v4[1], ipv6: false } : null;
}

const UNREACHABLE =
  /no such host|i\/o timeout|connection refused|tls handshake timeout|context deadline exceeded|network is unreachable|certificate signed by unknown authority/i;

/**
 * A certificate error in plain words, with the fix (spec 10.7, R3-18). `error` is what the
 * runner reports: "<problem type>: <detail>" for errors from Let's Encrypt, or the router's own
 * text when Let's Encrypt couldn't be reached. Anything not recognized stays as it is.
 */
export function certificateAdvice(error: string, hostname: string, ip: string | null): string {
  const type = /^([A-Za-z]+): /.exec(error)?.[1] ?? acmeProblemType(error);
  const known = type !== null && (VALIDATION_PROBLEMS.has(type) || /identifier$/i.test(type));
  const detail = known ? error.replace(/^[A-Za-z]+: /, "") : error;
  if (type === "caa" || /\bCAA record\b.*\bprevents? issuance\b/i.test(error)) {
    return `A CAA record blocks Let's Encrypt for ${hostname}. Add a CAA record: 0 issue "letsencrypt.org", then press Retry.`;
  }
  if (
    type === "rejectedIdentifier" ||
    type === "unsupportedIdentifier" ||
    /policy forbids issuing/i.test(error)
  ) {
    return `Let's Encrypt does not issue certificates for ${hostname}. Use another hostname, or upload a certificate that covers it.`;
  }
  if (
    known &&
    /(?:from|fetching|get "?)\s*https:\/\/\S*\.well-known\/acme-challenge/i.test(detail)
  ) {
    return `The check was redirected to HTTPS, so Let's Encrypt couldn't read Nearzero's answer over HTTP. If Cloudflare proxies ${hostname}, turn off Always Use HTTPS for it (or set it to DNS only), then press Retry.`;
  }
  if (
    type === "connection" ||
    (known && /timeout during connect|connection refused|no route to host/i.test(detail))
  ) {
    const tried = triedAddress(detail);
    if (tried?.ipv6) {
      return `Let's Encrypt tried ${hostname} over IPv6 (${tried.address}) and couldn't reach port 80 there. Remove the AAAA record for ${hostname}, or make port 80 reachable over IPv6, then press Retry.`;
    }
    return `Let's Encrypt could not reach port 80 on ${tried?.address ?? ip ?? "this server"}. Open TCP port 80 in the server's firewall and any cloud firewall, then press Retry.`;
  }
  if (type === "dns") {
    if (/NXDOMAIN|no valid (A|AAAA|IP)/i.test(detail)) {
      return `Let's Encrypt found no DNS record for ${hostname}. Add the A record pointing at ${ip ?? "the server's public IPv4"}, wait a few minutes, then press Retry.`;
    }
    return `Let's Encrypt couldn't look up ${hostname} in DNS (${detail}). Check the domain's records and nameservers, then press Retry.`;
  }
  if (type === null && (/dial tcp/i.test(error) || UNREACHABLE.test(error))) {
    const why = UNREACHABLE.exec(error)?.[0]?.toLowerCase();
    return `This server couldn't reach Let's Encrypt${why ? ` (${why})` : ""}, so ${hostname} wasn't checked. Allow outgoing HTTPS (TCP 443) from the server, then press Retry.`;
  }
  return error;
}

// ---- Managed DNS zones (spec 10.8)

export const DNS_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT", "MX", "CAA", "NS"] as const;
export type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

/** Any TTL DNS allows (RFC 2181: 1 second up to 2^31 - 1), so a week for NS and MX works (R3-24). */
export const DNS_TTL_MIN = 1;
export const DNS_TTL_MAX = 2_147_483_647;
export const DNS_TTL_DEFAULT = 300;

export const ZONE_MESSAGES = {
  domain: "Enter the domain, like example.com.",
  adminEmail: "Enter the DNS admin email, like hostmaster@example.com.",
  takenElsewhere: "This DNS zone is already managed by another workspace",
  takenHere: "This DNS zone is already connected. Find it in the DNS zones tab.",
  cnameAlone: "CNAME cannot coexist with other records",
  managed: "Managed by Nearzero",
} as const;

const RECORD_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;

/** A record name, made relative to the zone ("@" for the apex), or a problem. */
export function checkRecordName(
  raw: string,
  zone: string,
): { ok: true; name: string } | { ok: false; message: string } {
  let value = raw.trim().toLowerCase();
  if (value === "" || value === "@") return { ok: true, name: "@" };
  if (value.endsWith(".")) {
    value = value.slice(0, -1);
    if (!isWithin(value, zone)) {
      return { ok: false, message: `Use a name inside ${zone}, like www or www.${zone}.` };
    }
  }
  if (isWithin(value, zone)) value = relativeRecordName(value, zone);
  if (value === "@") return { ok: true, name: "@" };
  const labels = value.split(".");
  const valid = labels.every(
    (label, index) => (index === 0 && label === "*") || RECORD_LABEL.test(label),
  );
  if (!valid || `${value}.${zone}`.length > 253) {
    return {
      ok: false,
      message: `Use a name inside ${zone}: letters, digits, dashes and dots, like www or api.staging.`,
    };
  }
  return { ok: true, name: value };
}

function hostValue(value: string): boolean {
  const trimmed = value.trim();
  // "@" is the zone itself (G3-11).
  if (trimmed === "@") return true;
  const host = trimmed.toLowerCase().replace(/\.$/, "");
  return (
    host.length > 0 && host.length <= 253 && host.split(".").every((l) => RECORD_LABEL.test(l))
  );
}

/**
 * The name a CNAME, MX or NS value points at, read as 0.1.x read it (G3-11, spec 10.8): "@" is
 * the zone itself, a value without a dot ("mail") is a name inside the zone, and anything else
 * is a full name. Returned with its final dot, as a zone file writes it.
 */
export function recordTarget(value: string, zone: string): string {
  const name = value.trim().toLowerCase();
  const apex = `${zone.toLowerCase().replace(/\.$/, "")}.`;
  if (name === "@" || name === "") return apex;
  if (name.endsWith(".")) return name;
  if (!name.includes(".")) return `${name}.${apex}`;
  return `${name}.`;
}

/** A CAA value as written with or without quotes ("0 issue letsencrypt.org"), or null. */
export function caaParts(value: string): { flags: number; tag: string; value: string } | null {
  const trimmed = value.trim();
  const quoted = CAA.exec(trimmed);
  const plain = quoted ? null : /^(\d{1,3})\s+([A-Za-z0-9]{1,15})\s+([^"\s][^"]*)$/.exec(trimmed);
  const match = quoted ?? plain;
  if (!match || Number(match[1]) > 255) return null;
  return { flags: Number(match[1]), tag: match[2] as string, value: (match[3] as string).trim() };
}

/** A CAA value in its standard form, its value quoted: 0 issue "letsencrypt.org". */
export function caaText(value: string): string {
  const parts = caaParts(value);
  return parts ? `${parts.flags} ${parts.tag} "${parts.value}"` : value.trim();
}

/** The strings of a TXT value: quoted strings as given, or the whole text as one string. */
export function txtStrings(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith('"')) return [trimmed];
  const strings: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"\s*/gy;
  let match: RegExpExecArray | null = pattern.exec(trimmed);
  let consumed = 0;
  while (match) {
    strings.push((match[1] as string).replace(/\\(.)/g, "$1"));
    consumed = pattern.lastIndex;
    match = pattern.exec(trimmed);
  }
  return consumed === trimmed.length ? strings : [trimmed];
}

const CAA = /^(\d{1,3})\s+([A-Za-z0-9]{1,15})\s+"([^"]*)"$/;

export interface RecordInput {
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
  priority: number | null;
}

export interface ExistingRecord {
  id: string;
  name: string;
  type: DnsRecordType;
}

/**
 * Checks one record of a zone (spec 10.8): A is IPv4, AAAA IPv6, TXT at most 255 bytes per
 * string, CAA as flags, tag and value (quoted or not), MX with a priority (blank is 10), CNAME,
 * MX and NS values that are hostnames, "@" or one word inside the zone (recordTarget), the name
 * inside the zone, and a CNAME alone at its name. Returns field problems, or null when it's fine.
 */
export function checkRecord(
  input: RecordInput,
  zone: string,
  others: readonly ExistingRecord[],
): Record<string, string> | null {
  const problems: Record<string, string> = {};
  const name = checkRecordName(input.name, zone);
  if (!name.ok) problems.name = name.message;
  const value = input.value.trim();
  switch (input.type) {
    case "A":
      if (!isIPv4(value)) problems.value = "An A record needs an IPv4 address, like 203.0.113.10.";
      break;
    case "AAAA":
      if (!isIPv6(value))
        problems.value = "An AAAA record needs an IPv6 address, like 2001:db8::10.";
      break;
    case "CNAME":
    case "NS":
      if (!hostValue(value))
        problems.value = `A ${input.type} record needs a hostname, like target.example.net.`;
      break;
    case "MX":
      if (!hostValue(value))
        problems.value = "An MX record needs a mail server's hostname, like mail.example.com.";
      // A blank priority is 10, as 0.1.x read it (G3-11).
      if (input.priority !== null && (input.priority < 0 || input.priority > 65535)) {
        problems.priority = "Enter the MX priority, a number from 0 to 65535.";
      }
      break;
    case "TXT": {
      const strings = txtStrings(value);
      const encoder = new TextEncoder();
      if (value === "") problems.value = "Enter the text for the TXT record.";
      else if (strings.some((text) => encoder.encode(text).length > 255)) {
        problems.value =
          'Each TXT string can be at most 255 bytes. Split longer text into quoted strings, like "first part" "second part".';
      }
      break;
    }
    case "CAA": {
      // With or without quotes around the value (G3-11).
      if (!caaParts(value)) {
        problems.value =
          'Write a CAA record as flags, tag and value, like 0 issue "letsencrypt.org" or 0 issue letsencrypt.org.';
      }
      break;
    }
  }
  if (!Number.isInteger(input.ttl) || input.ttl < DNS_TTL_MIN || input.ttl > DNS_TTL_MAX) {
    problems.ttl = `Use a TTL from ${DNS_TTL_MIN} to ${DNS_TTL_MAX} seconds.`;
  }
  if (name.ok) {
    const sameName = others.filter((other) => other.name === name.name);
    if (input.type === "CNAME" && (name.name === "@" || sameName.length > 0)) {
      problems.type = ZONE_MESSAGES.cnameAlone;
    } else if (sameName.some((other) => other.type === "CNAME")) {
      problems.type = ZONE_MESSAGES.cnameAlone;
    }
  }
  return Object.keys(problems).length > 0 ? problems : null;
}

/** A zone name: a full domain name (the same rules as a hostname). */
export function checkZoneName(raw: string): HostnameCheck {
  const checked = checkHostnameInput(raw);
  if (!checked.ok && checked.message === HOSTNAME_MESSAGES.empty) {
    return { ok: false, message: ZONE_MESSAGES.domain };
  }
  return checked;
}

// ---- Request schemas (docs/api/domains.md)

const portField = z
  .number({ error: "Enter a port from 1 to 65535." })
  .int("Enter a port from 1 to 65535.")
  .min(1, "Enter a port from 1 to 65535.")
  .max(65535, "Enter a port from 1 to 65535.");

const pathField = z
  .string()
  .trim()
  .max(1024)
  .transform((value) => (value === "" ? "/" : value.startsWith("/") ? value : `/${value}`))
  .refine((value) => /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(value), {
    message: "A path starts with / and has no spaces, like /api.",
  });

const composeServiceField = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, "Pick one of the Compose file's services.")
  .optional();

export const connectServiceSchema = z.object({
  serviceId: z.string({ error: 'Pick a service, or untick "Connect it to a service now".' }).min(1),
  port: portField.optional(),
  path: pathField.default("/"),
  composeService: composeServiceField,
});
export type ConnectServiceInput = z.output<typeof connectServiceSchema>;

export const createHostnameSchema = z.object({
  hostname: z.string({ error: HOSTNAME_MESSAGES.empty }).max(300),
  /** Connect it now; without it, `serverId` names where it points. */
  connect: connectServiceSchema.nullable().optional(),
  serverId: z.string().min(1).optional(),
  /** Inside a managed zone: Nearzero creates the record, or the person does elsewhere. */
  dns: z.enum(["managed", "external"]).optional(),
});
export type CreateHostnameInput = z.output<typeof createHostnameSchema>;

export const previewHostnameSchema = z.object({
  hostname: z.string().max(300),
  serviceId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
});

export const generateHostnameSchema = z.object({
  port: portField.optional(),
  path: pathField.default("/"),
  composeService: composeServiceField,
});

/**
 * Whether an email can be the DNS admin mailbox of a zone file's SOA record (RFC 1035 3.3.13):
 * the local part becomes the first label(s), with its dots escaped, so it may hold only letters,
 * digits, "_", "+" and "-" between single dots; the domain is a real hostname. Anything a zone
 * file treats as syntax (";", "(", ")", quotes, "\\", "$", spaces) can never reach the file.
 */
export function isZoneMailbox(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0 || email.length > 254) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  return (
    local.length <= 64 &&
    /^[a-z0-9_+-]+(\.[a-z0-9_+-]+)*$/.test(local) &&
    checkHostnameInput(domain).ok &&
    !domain.endsWith(".")
  );
}

export const zoneSchema = z.object({
  domain: z.string({ error: ZONE_MESSAGES.domain }).max(300),
  adminEmail: z
    .string({ error: ZONE_MESSAGES.adminEmail })
    .trim()
    .toLowerCase()
    .refine(isZoneMailbox, ZONE_MESSAGES.adminEmail),
  nameservers: z.array(z.string().max(253)).max(13).optional(),
});

export const zoneUpdateSchema = z.object({
  adminEmail: zoneSchema.shape.adminEmail.optional(),
  nameservers: z.array(z.string().max(253)).max(13).optional(),
});

export const recordSchema = z.object({
  name: z.string().max(253).default("@"),
  type: z.enum(DNS_RECORD_TYPES, { error: `Pick a type: ${DNS_RECORD_TYPES.join(", ")}.` }),
  value: z.string({ error: "Enter the record's value." }).max(4000),
  ttl: z.number().int().default(DNS_TTL_DEFAULT),
  priority: z.number().int().nullable().default(null),
});

export const environmentDefaultSchema = z.object({
  /** "platform", "none", or a zone id. */
  source: z.string().min(1),
  prefix: z.string().max(100).default(""),
});

export const uploadCertificateSchema = z.object({
  name: z
    .string({ error: "Enter a name for the certificate." })
    .trim()
    .min(1, "Enter a name for the certificate.")
    .max(100, "Use at most 100 characters."),
  certificate: z.string({ error: "Paste the certificate (PEM)." }).max(65_536),
  privateKey: z.string({ error: "Paste the private key (PEM)." }).max(65_536),
  serverId: z.string({ error: "Pick the server that uses it." }).min(1),
});

export const updateCertificateSchema = z.object({
  name: uploadCertificateSchema.shape.name.optional(),
  certificate: z.string().max(65_536).optional(),
  /** Blank keeps the stored private key. */
  privateKey: z.string().max(65_536).optional(),
});

export const serverIpSchema = z.object({ ip: z.string().trim().max(64) });

export const publicDomainSchema = z.object({
  hostname: z.string().max(300),
  email: z
    .string({ error: "Enter an email for HTTPS certificates." })
    .trim()
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email address, like you@company.com."),
});
