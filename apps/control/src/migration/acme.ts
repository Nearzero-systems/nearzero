import { X509Certificate } from "node:crypto";

/**
 * A server's certificate authority state from the bundle (`acme/<server ref>.json` or
 * `acme/host.json`, spec 29.4): the ACME account and every issued certificate with its key, so
 * the 1.0 router continues them without new orders (spec 29.5, "Certificates").
 *
 * Two shapes are accepted: the bundle's own ({ account, certificates }) and a router store as
 * Traefik writes it ({ <resolver>: { Account, Certificates } }), from Traefik's documented
 * storage format. Both become one Traefik store for the resolver 1.0's router uses
 * ("letsencrypt"), which the runner merges into its router's store.
 */

export const ROUTER_RESOLVER = "letsencrypt";

export interface RouterCertificate {
  domain: { main: string; sans?: string[] };
  /** Base64 of the PEM chain. */
  certificate: string;
  /** Base64 of the PEM private key. */
  key: string;
  Store: string;
}

export interface RouterStore {
  [ROUTER_RESOLVER]: {
    Account: Record<string, unknown> | null;
    Certificates: RouterCertificate[];
  };
}

type Plain = Record<string, unknown>;

function isObject(value: unknown): value is Plain {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Base64 of a PEM, whether the value is the PEM itself or already base64. */
function asBase64Pem(value: unknown, marker: RegExp): string | null {
  if (typeof value !== "string" || value === "") return null;
  if (marker.test(value)) return Buffer.from(value, "utf8").toString("base64");
  const decoded = Buffer.from(value, "base64").toString("utf8");
  return marker.test(decoded) ? value.replace(/\s+/g, "") : null;
}

function certificateNames(pemBase64: string): string[] | null {
  try {
    const pem = Buffer.from(pemBase64, "base64").toString("utf8");
    const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
    if (!block) return null;
    const leaf = new X509Certificate(block);
    const names: string[] = [];
    for (const part of (leaf.subjectAltName ?? "").split(",")) {
      const match = /^\s*DNS:(.+)$/.exec(part);
      if (match) names.push((match[1] as string).trim().toLowerCase());
    }
    return names;
  } catch {
    return null;
  }
}

function account(value: unknown): Plain | null {
  if (!isObject(value)) return null;
  const email = value.Email ?? value.email;
  const registration = value.Registration ?? value.registration;
  const privateKey = value.PrivateKey ?? value.privateKey;
  const keyType = value.KeyType ?? value.keyType ?? "4096";
  if (typeof privateKey !== "string" || !isObject(registration)) return null;
  return {
    Email: typeof email === "string" ? email : "",
    Registration: registration,
    PrivateKey: privateKey,
    KeyType: String(keyType),
  };
}

function certificate(value: unknown): RouterCertificate | null {
  if (!isObject(value)) return null;
  const domain = isObject(value.domain)
    ? value.domain
    : isObject(value.Domain)
      ? value.Domain
      : null;
  const cert = asBase64Pem(value.certificate ?? value.Certificate, /-----BEGIN CERTIFICATE-----/);
  const key = asBase64Pem(value.key ?? value.Key, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  if (!cert || !key) return null;
  const names = certificateNames(cert);
  if (!names) return null;
  const main =
    typeof domain?.main === "string" && domain.main !== ""
      ? domain.main.toLowerCase()
      : (names[0] ?? null);
  if (!main) return null;
  const sans = Array.isArray(domain?.sans)
    ? domain.sans
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.toLowerCase())
    : names.filter((name) => name !== main);
  return {
    domain: sans.length > 0 ? { main, sans } : { main },
    certificate: cert,
    key,
    Store: "default",
  };
}

export type AcmeParse =
  | { ok: true; store: RouterStore; certificates: number; skipped: number }
  | { ok: false; reason: string };

/** Reads either shape into one store for the router's resolver. */
export function routerStoreFrom(value: unknown): AcmeParse {
  if (!isObject(value)) return { ok: false, reason: "it isn't a JSON object" };
  let accountValue: Plain | null = null;
  const entries: unknown[] = [];
  if ("certificates" in value || "account" in value) {
    accountValue = account(value.account);
    if (Array.isArray(value.certificates)) entries.push(...value.certificates);
  } else {
    for (const resolver of Object.values(value)) {
      if (!isObject(resolver)) continue;
      accountValue ??= account(resolver.Account);
      if (Array.isArray(resolver.Certificates)) entries.push(...resolver.Certificates);
    }
  }
  const certificates: RouterCertificate[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const parsed = certificate(entry);
    if (!parsed || seen.has(parsed.domain.main)) {
      skipped++;
      continue;
    }
    seen.add(parsed.domain.main);
    certificates.push(parsed);
  }
  if (!accountValue && certificates.length === 0) {
    return { ok: false, reason: "it holds no certificate authority account and no certificates" };
  }
  return {
    ok: true,
    store: { [ROUTER_RESOLVER]: { Account: accountValue, Certificates: certificates } },
    certificates: certificates.length,
    skipped,
  };
}
