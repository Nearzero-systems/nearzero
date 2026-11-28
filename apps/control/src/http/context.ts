import { newRequestId, REQUEST_ID_HEADER, REQUEST_ID_PATTERN } from "@nearzero/shared";
import type { MiddlewareHandler } from "hono";
import type { SessionContext } from "../identity/sessions.ts";
import type { Logger } from "../log.ts";
import type { SocketHandler } from "../runners/sockets.ts";

export interface AppEnv {
  Bindings: {
    /** The connecting peer's address, given by the server (Bun's requestIP) for each request. */
    peerAddress?: string;
    /** Turns the request into a WebSocket handled by `handler` (runners and terminals). */
    upgrade?: (request: Request, handler: SocketHandler) => boolean;
    /** True on the runner link's own TLS port (spec 31 "Remote runners are always encrypted"). */
    runnerLinkTls?: boolean;
  };
  Variables: {
    requestId: string;
    log: Logger;
    /** The signed-in person's session, when the request carries a valid session cookie. */
    session: SessionContext | undefined;
  };
}

const DEPLOY_WEBHOOK_PATH = /^(\/api\/v1\/webhooks\/deploy\/)(nzw1\.[0-9a-f-]{36}\.)?[^/]*$/;
const LEGACY_WEBHOOK_PATH = /^\/api\/v1\/webhooks\/legacy\//;
/** A path segment that could be a 0.1.x webhook token (spec 29a.5.12: 16 or more URL-safe characters). */
const TOKEN_LIKE = /^[A-Za-z0-9._~%-]{16,}$/;

/**
 * The path as the access log shows it (31d G4-11): a deploy webhook's address is its credential,
 * so its secret part is replaced, `/api/v1/webhooks/deploy/nzw1.<id>.[redacted]`; in a 0.1.x
 * address a move kept, every segment that could be a token is.
 */
export function loggedPath(path: string): string {
  const deploy = DEPLOY_WEBHOOK_PATH.exec(path);
  if (deploy) return `${deploy[1]}${deploy[2] ?? ""}[redacted]`;
  if (LEGACY_WEBHOOK_PATH.test(path)) {
    return path
      .split("/")
      .map((segment, index) => (index > 4 && TOKEN_LIKE.test(segment) ? "[redacted]" : segment))
      .join("/");
  }
  return path;
}

/**
 * Gives every request an id (kept from the console proxy when well formed), a logger that
 * includes it, an `X-Request-Id` response header, and one access-log line when it ends. The
 * query string is never logged, nor a webhook's secret (loggedPath).
 */
export function requestContext(log: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const incoming = c.req.header(REQUEST_ID_HEADER);
    const requestId = incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : newRequestId();
    const requestLog = log.child({ requestId });
    c.set("requestId", requestId);
    c.set("log", requestLog);
    const started = performance.now();
    await next();
    c.res.headers.set(REQUEST_ID_HEADER, requestId);
    requestLog.info("request", {
      method: c.req.method,
      path: loggedPath(c.req.path),
      status: c.res.status,
      durationMs: Math.round(performance.now() - started),
    });
  };
}
