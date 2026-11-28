import { API_PREFIX } from "@nearzero/shared";
import { controlUrl } from "./control-api.ts";
import type { Scheme } from "./forwarding.ts";

/**
 * Plain-HTTP visits to the server's IP address move to the console's HTTPS address once it has
 * one (spec 04 4.1 "Plain HTTP", 21.9), so nobody types a password into the plain-HTTP page or
 * keeps using an old bookmark. Not moved: API paths, anything but GET and HEAD, loopback
 * addresses (SSH tunnels), names rather than IP addresses, and requests a trusted proxy says
 * arrived over HTTPS. The HTTPS address comes from the control plane, which offers it only once
 * it can answer (see apps/control/src/identity/console-address.ts).
 */

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** The host part of a Host header ("203.0.113.10:4321" → "203.0.113.10", "[::1]:80" → "::1"). */
function hostName(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const bracketed = trimmed.match(/^\[([0-9a-f:.]+)\](?::\d+)?$/);
  if (bracketed?.[1]) return bracketed[1];
  return trimmed.replace(/:\d+$/, "");
}

/** True for an IP address that isn't loopback: the address of the server itself. */
export function isServerIpAddress(host: string): boolean {
  const name = hostName(host);
  const v4 = name.match(IPV4);
  if (v4) {
    if (v4.slice(1).some((part) => Number(part) > 255)) return false;
    return v4[1] !== "127";
  }
  if (name.includes(":") && /^[0-9a-f:.]+$/.test(name)) {
    return name !== "::1" && !name.startsWith("::ffff:127.");
  }
  return false;
}

/** Whether a request could be moved at all, before the HTTPS address is looked up. */
export function mayMoveToHttps(input: {
  method: string;
  url: URL;
  host: string | null;
  scheme: Scheme;
}): boolean {
  if (input.method !== "GET" && input.method !== "HEAD") return false;
  if (input.url.pathname === "/api" || input.url.pathname.startsWith("/api/")) return false;
  if (input.scheme !== "http") return false;
  return input.host !== null && isServerIpAddress(input.host);
}

/** The address to send the browser to, or null to answer the page as usual. */
export function httpsTarget(url: URL, httpsUrl: string | null): string | null {
  if (!httpsUrl) return null;
  let target: URL;
  try {
    target = new URL(httpsUrl);
  } catch {
    return null;
  }
  if (target.protocol !== "https:") return null;
  return `${target.origin}${url.pathname}${url.search}`;
}

const TTL_MS = 30_000;
const cache = { value: null as string | null, at: Number.NEGATIVE_INFINITY };
let pending: Promise<string | null> | null = null;

type Fetcher = () => Promise<string | null>;

const fromControl: Fetcher = async () => {
  const response = await fetch(new URL(`${API_PREFIX}/auth/console-address`, controlUrl()), {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`console address: ${response.status}`);
  const body = (await response.json()) as { httpsUrl?: unknown };
  return typeof body.httpsUrl === "string" ? body.httpsUrl : null;
};

let fetcher: Fetcher = fromControl;

/**
 * The console's HTTPS address, asked of the control plane at most every 30 seconds. When it
 * can't be asked, the last answer stands (none at first), so an unreachable control plane never
 * sends anyone elsewhere.
 */
export async function consoleHttpsAddress(now = Date.now()): Promise<string | null> {
  if (now - cache.at < TTL_MS) return cache.value;
  if (!pending) {
    pending = fetcher()
      .then((value) => {
        cache.value = value;
        cache.at = Date.now();
        return value;
      })
      .catch(() => {
        cache.at = Date.now();
        return cache.value;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

/** For the unit tests: where the address comes from, and a fresh start. */
export function useConsoleAddressSource(source: Fetcher | null): void {
  fetcher = source ?? fromControl;
  cache.value = null;
  cache.at = Number.NEGATIVE_INFINITY;
  pending = null;
}
