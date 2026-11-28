import { lookup } from "node:dns/promises";

/**
 * Who the browser is, for the control plane (docs/api/identity.md, "console proxy contract").
 * The control plane believes X-Forwarded-For and X-Forwarded-Proto only from the console, so
 * the console must say who its own client is: the connecting peer and the scheme it used. When
 * the console itself sits behind a trusted proxy (the router terminating HTTPS), that proxy's
 * forwarded headers say it instead. Trusted peers are loopback by default, or the addresses and
 * IPv4 ranges in NEARZERO_TRUSTED_PROXIES (the same setting the control plane reads).
 *
 * The Nearzero host's own router is always trusted (B1-27): it serves the console's HTTPS address
 * and reaches the console over the edge network from an address Docker picks, so the console
 * looks it up by its container name (NEARZERO_ROUTER_HOST, `nearzero-router` by default; empty
 * turns this off). Only that one address is trusted, never the network: apps share it.
 */

export type Scheme = "http" | "https";

export interface Connection {
  /** The browser's address, as the control plane should see it. */
  clientAddress: string;
  scheme: Scheme;
}

const LOOPBACK = ["127.0.0.0/8", "::1"];
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

const ROUTER_REFRESH_MS = 30_000;

type Resolve = (host: string) => Promise<string[]>;

const resolveAll: Resolve = async (host) =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

const router = {
  addresses: [] as string[],
  checkedAt: Number.NEGATIVE_INFINITY,
  pending: null as Promise<void> | null,
  resolve: resolveAll,
};

function routerHost(): string | null {
  const configured = process.env.NEARZERO_ROUTER_HOST;
  if (configured === undefined) return "nearzero-router";
  return configured.trim() || null;
}

/**
 * Looks the router's address up again when the last look is older than 30 seconds. It runs in
 * the background, so a request never waits for DNS; a failed look trusts no router address.
 */
export function refreshRouterAddresses(now = Date.now()): Promise<void> {
  const host = routerHost();
  if (!host) {
    router.addresses = [];
    return Promise.resolve();
  }
  if (router.pending) return router.pending;
  if (now - router.checkedAt < ROUTER_REFRESH_MS) return Promise.resolve();
  router.checkedAt = now;
  router.pending = router
    .resolve(host)
    .then((addresses) => {
      router.addresses = addresses.map(normalizeAddress);
    })
    .catch(() => {
      router.addresses = [];
    })
    .finally(() => {
      router.pending = null;
    });
  return router.pending;
}

/** For the unit tests: how the router's name is looked up, and a fresh start. */
export function useRouterResolver(resolve: Resolve | null): void {
  router.resolve = resolve ?? resolveAll;
  router.addresses = [];
  router.checkedAt = Number.NEGATIVE_INFINITY;
  router.pending = null;
}

export function parseTrustedProxies(value: string | undefined): string[] {
  void refreshRouterAddresses();
  const items = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return [...(items.length > 0 ? items : LOOPBACK), ...router.addresses];
}

/** "::ffff:10.0.0.1" and "10.0.0.1" are the same peer. */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  const mapped = trimmed.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return mapped?.[1] ?? trimmed;
}

function ipv4ToNumber(address: string): number | null {
  const match = address.match(IPV4);
  if (!match) return null;
  let value = 0;
  for (const part of match.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

function matches(address: string, entry: string): boolean {
  const [base = "", bitsText] = entry.split("/");
  const target = normalizeAddress(base);
  if (bitsText === undefined) return address === target;
  const bits = Number(bitsText);
  const ip = ipv4ToNumber(address);
  const network = ipv4ToNumber(target);
  if (ip === null || network === null || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const size = 2 ** (32 - bits);
  return Math.floor(ip / size) === Math.floor(network / size);
}

export function isTrustedPeer(address: string, trusted: string[]): boolean {
  const peer = normalizeAddress(address);
  return trusted.some((entry) => matches(peer, entry));
}

function looksLikeAddress(value: string): boolean {
  return IPV4.test(value) || /^[0-9a-f:]+$/i.test(value);
}

/**
 * The connection to report upstream. Forwarded headers from an untrusted peer (any browser) are
 * ignored; from a trusted proxy, the last X-Forwarded-For entry is the client it saw.
 */
export function resolveConnection(input: {
  peer: string;
  scheme: Scheme;
  headers: Headers;
  trusted: string[];
}): Connection {
  const peer = normalizeAddress(input.peer);
  if (!isTrustedPeer(peer, input.trusted)) return { clientAddress: peer, scheme: input.scheme };

  const chain = (input.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const last = chain[chain.length - 1];
  const proto = input.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return {
    clientAddress: last && looksLikeAddress(last) ? normalizeAddress(last) : peer,
    scheme: proto === "https" || proto === "http" ? proto : input.scheme,
  };
}

/** The forwarded headers the console sends to the control plane for this connection. */
export function forwardedHeaders(connection: Connection): Record<string, string> {
  const headers: Record<string, string> = { "x-forwarded-proto": connection.scheme };
  if (connection.clientAddress) headers["x-forwarded-for"] = connection.clientAddress;
  return headers;
}
