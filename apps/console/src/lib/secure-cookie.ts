import type { AstroCookies } from "astro";
import { connectionOf } from "./control-api.ts";

/**
 * Cookies the console sets itself (an invitation link, the "already shown this invitation" mark,
 * flash messages) are Secure whenever the page was reached over HTTPS, by the same per-request
 * rule as the session cookie the control plane sets (31a G1-13, spec 21.9). Over plain HTTP they
 * keep working.
 */
export interface CookieContext {
  cookies: AstroCookies;
  request: Request;
}

export function isSecureRequest(context: CookieContext): boolean {
  let peer: string | undefined;
  try {
    // Astro throws when the adapter can't tell the peer.
    peer = (context as { clientAddress?: string }).clientAddress;
  } catch {
    peer = undefined;
  }
  return connectionOf(context.request, peer).scheme === "https";
}
