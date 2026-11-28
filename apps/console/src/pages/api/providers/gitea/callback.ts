import { legacyGitCallbackTarget } from "@nearzero/shared/browser";
import type { APIRoute } from "astro";

/**
 * 0.1.x's Gitea OAuth redirect address on the console (R3-41, R4-15): Git hosts set up for 0.1.x still send people
 * here, so it goes on to 1.0's page with the same query.
 */
export const GET: APIRoute = ({ url }) => {
  const target = legacyGitCallbackTarget(url.pathname, url.search);
  return new Response(null, {
    status: 302,
    headers: { location: target ?? "/", "cache-control": "no-store" },
  });
};
