import { isCrossSiteRequest, normalizeOrigin, parseOriginList } from "@nearzero/shared";
import { consoleOrigin } from "./page-meta.ts";

/**
 * The console's half of the cross-site rule (spec 22.4, 24 G11; the rule itself is in
 * @nearzero/shared request-origin.ts). Every change sent through the console's API proxy and every
 * terminal WebSocket must come from a page at the address the browser used for the console, from
 * the console's configured address, or from NEARZERO_TRUSTED_ORIGINS. The control plane is told the
 * origin was checked and applies the same rule to whatever reaches it straight.
 */

/** The origins that count as this console for one request. */
export function ownOrigins(request: Request, peer: string | undefined): string[] {
  const origins = [
    consoleOrigin(request, peer, new URL(request.url)),
    ...parseOriginList(process.env.NEARZERO_TRUSTED_ORIGINS),
  ];
  const configured = normalizeOrigin(process.env.NEARZERO_CONSOLE_URL ?? "");
  if (configured) origins.push(configured);
  return origins;
}

/** True when the request comes from a page on another site and must not reach the API. */
export function refusedAsCrossSite(
  request: Request,
  peer: string | undefined,
  upgrade = false,
): boolean {
  return isCrossSiteRequest({
    method: request.method,
    upgrade,
    fetchSite: request.headers.get("sec-fetch-site"),
    origin: request.headers.get("origin"),
    ownOrigins: ownOrigins(request, peer),
  });
}
