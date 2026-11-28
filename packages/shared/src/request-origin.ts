/**
 * Which browser requests may change things (spec 22.4, 24 G11). A page on another site, including
 * an app on a sibling subdomain or another port of the same IP address (both "same-site", so Lax
 * cookies go with them), must never act with a signed-in person's session: not by a form, not by
 * a bodyless POST, and not by opening a terminal's WebSocket.
 *
 * The rule, for every request that can change something (any method but GET, HEAD and OPTIONS,
 * and every WebSocket upgrade):
 * - a browser's `Sec-Fetch-Site` must be `same-origin` or `none` (typed or bookmarked);
 * - without it (older browsers), an `Origin` must be one of the console's own addresses;
 * - a request with neither header doesn't come from a web page (a script, a Git host, a runner)
 *   and carries no ambient browser session, so it passes.
 */

/** What a refused request is told. */
export const CROSS_SITE_REFUSAL =
  "This request came from another site, so Nearzero refused it. Make the change from Nearzero's own pages.";

/**
 * Set by the console's proxy on requests whose origin it has checked against the address the
 * browser used. The control plane believes it only from a trusted proxy.
 */
export const ORIGIN_CHECKED_HEADER = "x-nearzero-origin-checked";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** "https://Console.Example.com:443" and "https://console.example.com" are one origin. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export interface OriginCheckInput {
  method: string;
  /** True for a WebSocket upgrade, which a GET can't otherwise be told from. */
  upgrade: boolean;
  /** The Sec-Fetch-Site header, or null. */
  fetchSite: string | null | undefined;
  /** The Origin header, or null. */
  origin: string | null | undefined;
  /** The addresses the console answers on, as origins. */
  ownOrigins: readonly string[];
}

/** True when the request must be refused as coming from another site. */
export function isCrossSiteRequest(input: OriginCheckInput): boolean {
  if (!input.upgrade && SAFE_METHODS.has(input.method.toUpperCase())) return false;
  const site = input.fetchSite?.trim().toLowerCase();
  if (site) return site !== "same-origin" && site !== "none";
  if (input.origin === null || input.origin === undefined || input.origin.trim() === "") {
    return false;
  }
  const origin = normalizeOrigin(input.origin);
  if (!origin) return true;
  return !input.ownOrigins.some((own) => normalizeOrigin(own) === origin);
}

/** The origins in a comma-separated list (NEARZERO_TRUSTED_ORIGINS); unreadable items are skipped. */
export function parseOriginList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => normalizeOrigin(item))
    .filter((item): item is string => item !== null);
}
