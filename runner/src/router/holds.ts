import { Resolver, resolve4, resolve6 } from "node:dns/promises";
import type { HoldReason } from "@nearzero/shared";
import { DEFAULT_DNS_RESOLVERS, isIPv4, isIPv6, proxyOf } from "@nearzero/shared";

/**
 * The certificate hold (spec 10.7): a hostname whose DNS doesn't point at this server is served
 * with the router's placeholder certificate, and Let's Encrypt is never asked for it. The check
 * runs when a route is written, a minute after the runner starts and every 5 minutes after, and
 * whenever the control plane asks; a hostname whose DNS now points here is released.
 *
 * The failure back-off (3 failed validations an hour, rate limits) needs the router's validation
 * results and arrives with the certificates milestone; this is the DNS part. Names are looked up
 * through public resolvers, the way Let's Encrypt and the control plane's Hostnames list see
 * them (G3-09), and the server's public IPv4 follows the control plane's 5-minute check (R3-10).
 */

export const FIRST_CHECK_AFTER_MS = 60_000;
export const CHECK_EVERY_MS = 5 * 60_000;
/** Slow lookups give up rather than hang (spec 10.6). */
export const LOOKUP_TIMEOUT_MS = 10_000;

const NEVER_PUBLIC_SUFFIXES = [
  "localhost",
  "local",
  "test",
  "example",
  "invalid",
  "internal",
  "home.arpa",
  "lan",
];

/** Names no public certificate authority will ever issue for. */
export function neverPublic(hostname: string): boolean {
  if (isIPv4(hostname) || isIPv6(hostname)) return true;
  if (!hostname.includes(".")) return true;
  return NEVER_PUBLIC_SUFFIXES.some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

export type Resolve4 = (hostname: string) => Promise<string[]>;

export const systemResolve4: Resolve4 = (hostname) => resolve4(hostname);
export const systemResolve6: Resolve4 = (hostname) => resolve6(hostname);

/**
 * The public resolvers the hold asks (G3-09): NEARZERO_DNS_RESOLVERS on the runner ("ip" or
 * "ip:port", comma separated), else Cloudflare's and Google's, the ones the control plane asks
 * for the Hostnames list. Anything else in the setting is ignored.
 */
export function publicResolvers(setting = process.env.NEARZERO_DNS_RESOLVERS): string[] {
  const items = (setting ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => {
      const host = item.replace(/:\d{1,5}$/, "");
      return isIPv4(host) || isIPv6(host.replace(/^\[|\]$/g, ""));
    });
  return items.length > 0 ? items : [...DEFAULT_DNS_RESOLVERS];
}

/** Answers that mean public DNS couldn't be reached, not that it answered (G3-09). */
const UNREACHABLE = new Set([
  "ETIMEOUT",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "EREFUSED",
  "ECANCELLED",
  "EAI_AGAIN",
]);

/**
 * Looks a name up the way Let's Encrypt sees it (G3-09): through public resolvers, so a cloud's
 * private zone, a company resolver or a stale negative cache on the server never holds a name
 * that public DNS points here. The server's own resolver answers only when public DNS can't be
 * reached at all.
 */
export function publicLookup(
  family: 4 | 6,
  servers: readonly string[] = publicResolvers(),
  fallback: Resolve4 = family === 4 ? systemResolve4 : systemResolve6,
): Resolve4 {
  let resolver: Resolver | null = null;
  return async (hostname) => {
    if (!resolver) {
      resolver = new Resolver({ timeout: 3_000, tries: 1 });
      resolver.setServers([...servers]);
    }
    try {
      return family === 4 ? await resolver.resolve4(hostname) : await resolver.resolve6(hostname);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code && !UNREACHABLE.has(code)) throw error;
      return fallback(hostname);
    }
  };
}

export const publicResolve4: Resolve4 = publicLookup(4);
export const publicResolve6: Resolve4 = publicLookup(6);

/**
 * Whether a hostname must stay on the placeholder certificate, and why; null means Let's Encrypt
 * may be asked (spec 10.7). Only DNS that clearly can't reach this server holds a name: no
 * record at all, or A records at another address that isn't a known proxy's (R3-11). A name
 * behind Cloudflare, Fastly, Bunny CDN or Arvancloud, an IPv6-only name, and a lookup that
 * failed just now all let Let's Encrypt try; a failed lookup never takes a working certificate's
 * HTTPS redirect away.
 */
export async function holdReason(
  hostname: string,
  publicIPv4: string | null,
  lookup: Resolve4 = publicResolve4,
  lookup6: Resolve4 = publicResolve6,
  addressLookupFailed = false,
): Promise<HoldReason | null> {
  if (neverPublic(hostname)) return "not_public";
  // The server's own name didn't resolve just now (R3-10): nothing says DNS is wrong, so a
  // working certificate keeps its redirect and renewals until the next check knows the address.
  if (!publicIPv4) return addressLookupFailed ? null : "address_unknown";
  let addresses: string[];
  try {
    addresses = await withTimeout(lookup(hostname), LOOKUP_TIMEOUT_MS);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") addresses = [];
    // Couldn't tell: nothing says DNS is wrong, so nothing is held.
    else return null;
  }
  if (addresses.length === 0) {
    const ipv6 = await withTimeout(lookup6(hostname), LOOKUP_TIMEOUT_MS).catch(() => []);
    return ipv6.length > 0 ? null : "no_record";
  }
  if (addresses.includes(publicIPv4)) return null;
  return proxyOf(addresses) ? null : "points_elsewhere";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
