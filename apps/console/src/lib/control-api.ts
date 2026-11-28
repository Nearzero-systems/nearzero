import {
  API_PREFIX,
  AppError,
  CROSS_SITE_REFUSAL,
  type ErrorCode,
  newRequestId,
  ORIGIN_CHECKED_HEADER,
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
} from "@nearzero/shared";
import {
  type Connection,
  forwardedHeaders,
  parseTrustedProxies,
  resolveConnection,
  type Scheme,
} from "./forwarding.ts";

/**
 * How the console reaches the control-plane API. The console calls one fixed internal address
 * and never derives it from the incoming request or forwarded host headers (spec 22.4, rule 5).
 */

const DEFAULT_CONTROL_URL = "http://127.0.0.1:3000";

/**
 * The timeout covers the wait for response headers only, so long streams are never cut (spec
 * 23.2). It starts once the request body has been passed on, so a large upload (an app archive
 * of up to 200 MB, spec 6.3) isn't cut while it is still being sent.
 */
export const FIRST_BYTE_TIMEOUT_MS = 30_000;

/**
 * Actions whose control-plane route answers only once its work is done, and may legitimately
 * take longer than 30 seconds (31d G4-13, the "long actions" decision in spec 31). The console
 * waits a little longer than each route's own limit, so the person sees the real result; every
 * other route keeps the 30-second wait.
 */
const LONG_ACTIONS: { method: string; path: RegExp; ms: number }[] = [
  // A backup destination's Test connection: up to 180 seconds the first time on a server.
  { method: "POST", path: /^\/backup-destinations(?:\/[^/]+)?\/test$/, ms: 200_000 },
  // The backup file list for Restore: 120 seconds.
  { method: "GET", path: /^\/services\/[^/]+\/backup-files$/, ms: 140_000 },
  // A server's Check again: the SSH sign-in, then up to 120 seconds of checks and sudo.
  { method: "POST", path: /^\/servers\/[^/]+\/validation$/, ms: 200_000 },
  // The security audit: the SSH sign-in, then 60 seconds.
  { method: "POST", path: /^\/servers\/[^/]+\/security-audit$/, ms: 120_000 },
  // Analytics reads the request log in pieces of up to 60 seconds each, 17 at most.
  { method: "GET", path: /^\/analytics$/, ms: 17 * 60_000 + 20_000 },
  // Delete all request logs: 60 seconds.
  { method: "POST", path: /^\/analytics\/delete-all$/, ms: 90_000 },
];

/** How long the console waits for the first byte of an answer to `method` `path` (G4-13). */
export function firstByteTimeoutFor(method: string, path: string): number {
  const bare = path.replace(/\?.*$/, "").replace(new RegExp(`^${API_PREFIX}`), "");
  const found = LONG_ACTIONS.find(
    (action) => action.method === method.toUpperCase() && action.path.test(bare),
  );
  return found?.ms ?? FIRST_BYTE_TIMEOUT_MS;
}

export function controlUrl(): URL {
  const configured = process.env.NEARZERO_CONTROL_URL?.trim() || DEFAULT_CONTROL_URL;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      `NEARZERO_CONTROL_URL is not a valid address. Set it to the control plane's internal address, like ${DEFAULT_CONTROL_URL}.`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NEARZERO_CONTROL_URL must start with http:// or https://.");
  }
  return url;
}

/** Request headers never passed on: per-connection headers and anything a client could spoof. */
const DROPPED_REQUEST_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  // Bodies pass through unchanged, so ask the control plane not to compress them.
  "accept-encoding",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  // Only the console says it checked a request's origin.
  ORIGIN_CHECKED_HEADER,
]);

/** Response headers that describe the upstream connection, not the body we pass on. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
]);

/** The answer to a change sent from a page on another site (see origin-check.ts). */
export function crossSiteResponse(request: Request): Response {
  const offered = request.headers.get(REQUEST_ID_HEADER);
  const requestId = offered && REQUEST_ID_PATTERN.test(offered) ? offered : newRequestId();
  return errorResponse("forbidden", CROSS_SITE_REFUSAL, requestId);
}

function errorResponse(code: ErrorCode, message: string, requestId: string): Response {
  const error = new AppError(code, message);
  return Response.json(error.toBody(requestId), {
    status: error.status,
    headers: { [REQUEST_ID_HEADER]: requestId, "cache-control": "no-store" },
  });
}

/**
 * The browser's connection as the control plane should see it: the peer's address and scheme,
 * or what a trusted proxy in front of the console reported (see forwarding.ts).
 */
export function connectionOf(request: Request, peerAddress: string | undefined): Connection {
  const scheme: Scheme = new URL(request.url).protocol === "https:" ? "https" : "http";
  return resolveConnection({
    peer: peerAddress ?? "",
    scheme,
    headers: request.headers,
    trusted: parseTrustedProxies(process.env.NEARZERO_TRUSTED_PROXIES),
  });
}

/**
 * Forwards one browser request under /api/v1 to the control plane and streams the answer back,
 * so server-sent events pass through as they arrive. Whatever forwarded headers the browser
 * sent are dropped; the console sets X-Forwarded-For and X-Forwarded-Proto itself, because the
 * control plane believes them only from the console (sign-in limits, Secure cookies).
 */
export async function forwardToControl(
  request: Request,
  connection: Connection,
  options: { originChecked?: boolean } = {},
): Promise<Response> {
  const incoming = new URL(request.url);
  if (!incoming.pathname.startsWith(`${API_PREFIX}/`)) {
    throw new Error(`Only ${API_PREFIX} requests are forwarded to the control plane.`);
  }
  const target = new URL(`${incoming.pathname}${incoming.search}`, controlUrl());

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  }
  for (const [name, value] of Object.entries(forwardedHeaders(connection)))
    headers.set(name, value);
  if (options.originChecked) headers.set(ORIGIN_CHECKED_HEADER, "1");
  const offered = request.headers.get(REQUEST_ID_HEADER);
  const requestId = offered && REQUEST_ID_PATTERN.test(offered) ? offered : newRequestId();
  headers.set(REQUEST_ID_HEADER, requestId);

  const firstByte = new AbortController();
  const waitMs = firstByteTimeoutFor(request.method, incoming.pathname);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const startTimer = () => {
    if (timer === undefined) timer = setTimeout(() => firstByte.abort(), waitMs);
  };
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  // The body streams through as it arrives (never held whole); the wait for an answer starts
  // when the last of it has gone on.
  const body =
    hasBody && request.body
      ? request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ flush: startTimer }))
      : null;
  if (!body) startTimer();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.any([request.signal, firstByte.signal]),
      // Lets Node stream a request body; Bun ignores it.
      duplex: "half",
    } as RequestInit);
  } catch {
    if (firstByte.signal.aborted) {
      return errorResponse(
        "timeout",
        `The Nearzero API didn't answer within ${Math.round(waitMs / 1000)} seconds. Try again; if it keeps happening, check the control plane's log with: sudo nearzero logs`,
        requestId,
      );
    }
    return errorResponse(
      "control_unreachable",
      "The console can't reach the Nearzero API. Check that Nearzero is running with: sudo nearzero status",
      requestId,
    );
  } finally {
    clearTimeout(timer);
  }

  const responseHeaders = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) responseHeaders.append(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
