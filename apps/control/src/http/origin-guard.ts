import {
  API_PREFIX,
  AppError,
  CROSS_SITE_REFUSAL,
  isCrossSiteRequest,
  normalizeOrigin,
  ORIGIN_CHECKED_HEADER,
} from "@nearzero/shared";
import type { MiddlewareHandler } from "hono";
import { consoleHostname } from "../domains/addresses.ts";
import type { ControlServices } from "../services.ts";
import { isTrustedPeer } from "./client.ts";
import type { AppEnv } from "./context.ts";

/**
 * Refuses changes and terminal WebSockets that a page on another site starts in a signed-in
 * person's browser (spec 22.4, 24 G11; the rule is in @nearzero/shared request-origin.ts). Apps
 * live on the console's own registrable domain or IP address, so Lax cookies alone don't stop
 * them. Browsers usually reach this API through the console, which checks the origin against the
 * address the browser used and says so; the API port can also be reached straight, where the
 * request's own address and the console's configured addresses count as this site.
 *
 * Git hosts' webhooks and runners call their own paths without a browser session and are left
 * alone.
 */

const MACHINE_PATHS = [`${API_PREFIX}/webhooks/`, `${API_PREFIX}/runner/`];

export function originGuard(services: ControlServices): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (MACHINE_PATHS.some((prefix) => c.req.path.startsWith(prefix))) return next();
    const upgrade = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const peer = c.env?.peerAddress;
    const checkedByConsole =
      c.req.header(ORIGIN_CHECKED_HEADER) === "1" &&
      peer !== undefined &&
      isTrustedPeer(peer, services.trustedProxies);
    const input = {
      method: c.req.method,
      upgrade,
      fetchSite: c.req.header("sec-fetch-site"),
      // The console compared the origin with the address its browser used.
      origin: checkedByConsole ? null : c.req.header("origin"),
      ownOrigins: [] as string[],
    };
    if (input.origin) input.ownOrigins = await ownOrigins(services, c.req.url);
    if (isCrossSiteRequest(input)) throw new AppError("forbidden", CROSS_SITE_REFUSAL);
    return next();
  };
}

async function ownOrigins(services: ControlServices, requestUrl: string): Promise<string[]> {
  const origins = [new URL(requestUrl).origin, ...services.trustedOrigins];
  const configured = services.consoleUrl();
  if (configured) origins.push(configured);
  const hostname = await consoleHostname(services).catch(() => null);
  if (hostname) origins.push(`https://${hostname}`);
  return origins.map((item) => normalizeOrigin(item)).filter((item): item is string => !!item);
}
