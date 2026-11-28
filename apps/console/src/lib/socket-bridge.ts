import type { IncomingMessage, Server } from "node:http";
import { createRequire } from "node:module";
import type { Duplex } from "node:stream";
import {
  API_PREFIX,
  newRequestId,
  ORIGIN_CHECKED_HEADER,
  REQUEST_ID_HEADER,
  REQUEST_ID_PATTERN,
  TERMINAL_UPSTREAM_REFUSED,
} from "@nearzero/shared";
import { controlUrl } from "./control-api.ts";
import { forwardedHeaders, parseTrustedProxies, resolveConnection } from "./forwarding.ts";
import { refusedAsCrossSite } from "./origin-check.ts";

/**
 * WebSocket upgrades through the console's proxy (spec 6.7, 9.1; docs/api/deploys.md and
 * servers.md: "The console's proxy must pass WebSocket upgrades through"). Terminals are the
 * only WebSockets the browser opens. An upgrade under /api/v1/ is accepted here and bridged
 * frame by frame to the same path on the control plane's fixed internal address (spec 22.4,
 * rule 5), with the browser's cookies and the console's own X-Forwarded-For / -Proto. Binary
 * frames stay binary and text frames stay text; either side closing closes the other.
 *
 * The console runs under Bun, whose `node:http` hands upgrades to its built-in `ws` module; the
 * module is loaded at run time (never bundled), so the Bun runtime's implementation is used.
 */

/** Request headers passed on to the control plane for a terminal. */
const PASSED_HEADERS = ["cookie", "user-agent", "origin", "sec-fetch-site", "accept-language"];

interface PeerSocket {
  readyState: number;
  send(data: unknown, options?: { binary?: boolean }): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: unknown, isBinary: boolean) => void): void;
  on(event: "close", listener: (code: number, reason: unknown) => void): void;
  on(event: "error", listener: (error: unknown) => void): void;
}

interface SocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    done: (socket: PeerSocket) => void,
  ): void;
}

let server: SocketServer | null = null;

/**
 * The runtime's `ws` module, loaded with `require` from the console's own location: a computed
 * name keeps bundlers from resolving it, and `require` (not `import()`) keeps it out of the dev
 * server's module runner, which is closed by the time terminals connect.
 */
function socketServer(): SocketServer {
  if (!server) {
    const name = ["w", "s"].join("");
    const module = createRequire(import.meta.url)(name) as {
      WebSocketServer: new (options: { noServer: boolean }) => SocketServer;
    };
    server = new module.WebSocketServer({ noServer: true });
  }
  return server;
}

/** Whether an upgrade is one the console bridges (exported for the unit tests). */
export function bridgedPath(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? "";
  return path.startsWith(`${API_PREFIX}/`) && !path.startsWith(`${API_PREFIX}/runner/`);
}

/** The control plane's WebSocket address for a browser path (exported for the unit tests). */
export function upstreamUrl(path: string, base: URL = controlUrl()): string {
  const target = new URL(path, base);
  target.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

/** The headers the control plane gets for one upgrade (exported for the unit tests). */
export function upstreamHeaders(request: {
  headers: Record<string, string | string[] | undefined>;
  peer: string;
  encrypted: boolean;
}): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of PASSED_HEADERS) {
    const value = request.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  const flat = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") flat.set(name, value);
  }
  const connection = resolveConnection({
    peer: request.peer,
    scheme: request.encrypted ? "https" : "http",
    headers: flat,
    trusted: parseTrustedProxies(process.env.NEARZERO_TRUSTED_PROXIES),
  });
  Object.assign(headers, forwardedHeaders(connection));
  // Only upgrades that passed refusedUpgrade() are bridged.
  headers[ORIGIN_CHECKED_HEADER] = "1";
  const offered = request.headers[REQUEST_ID_HEADER];
  headers[REQUEST_ID_HEADER] =
    typeof offered === "string" && REQUEST_ID_PATTERN.test(offered) ? offered : newRequestId();
  return headers;
}

function bridge(browser: PeerSocket, request: IncomingMessage): void {
  const encrypted = Boolean((request.socket as { encrypted?: boolean }).encrypted);
  const upstream = new WebSocket(upstreamUrl(request.url ?? "/"), {
    headers: upstreamHeaders({
      headers: request.headers,
      peer: request.socket.remoteAddress ?? "",
      encrypted,
    }),
  } as unknown as string[]);
  upstream.binaryType = "arraybuffer";
  const early: { data: unknown; binary: boolean }[] = [];
  let closed = false;
  let upstreamOpened = false;
  const closeBoth = (code = 1000, reason = "") => {
    if (closed) return;
    closed = true;
    const safe = code >= 1000 && code < 5000 && code !== 1005 && code !== 1006 ? code : 1000;
    try {
      browser.close(safe, reason.slice(0, 120));
    } catch {
      // Already closed.
    }
    try {
      upstream.close(safe, reason.slice(0, 120));
    } catch {
      // Already closed.
    }
  };

  browser.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) upstream.send(toSendable(data, isBinary));
    else if (upstream.readyState === WebSocket.CONNECTING) early.push({ data, binary: isBinary });
  });
  browser.on("close", (code) => closeBoth(code));
  browser.on("error", () => closeBoth(1011));

  upstream.addEventListener("open", () => {
    upstreamOpened = true;
    for (const item of early.splice(0)) upstream.send(toSendable(item.data, item.binary));
  });
  upstream.addEventListener("message", (event) => {
    if (browser.readyState !== 1) return;
    if (typeof event.data === "string") browser.send(event.data, { binary: false });
    else browser.send(Buffer.from(event.data as ArrayBuffer), { binary: true });
  });
  // Nearzero answered the upgrade with a refusal (a container that is gone, no access): the
  // browser learns that it never opened, and asks the API why in its own words (C3-06).
  const refused = () => closeBoth(TERMINAL_UPSTREAM_REFUSED, "Nearzero didn't open the terminal.");
  upstream.addEventListener("close", (event) =>
    upstreamOpened ? closeBoth(event.code, event.reason) : refused(),
  );
  upstream.addEventListener("error", () =>
    upstreamOpened ? closeBoth(1011, "The terminal's link to Nearzero broke.") : refused(),
  );
}

function toSendable(data: unknown, isBinary: boolean): string | Uint8Array<ArrayBuffer> {
  if (typeof data === "string") return data;
  const chunks = Array.isArray(data) ? (data as Uint8Array[]) : [data as Uint8Array | ArrayBuffer];
  const parts = chunks.map((chunk) =>
    chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk,
  );
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return isBinary ? bytes : new TextDecoder().decode(bytes);
}

/**
 * True when a terminal WebSocket is opened by a page on another site, which must never get a
 * shell with the person's session (spec 24 G11). Exported for the unit tests.
 */
export function refusedUpgrade(request: {
  url: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  peer: string;
  encrypted: boolean;
}): boolean {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const host = headers.get("host") ?? "localhost";
  let probe: Request;
  try {
    probe = new Request(`${request.encrypted ? "https" : "http"}://${host}${request.url ?? "/"}`, {
      headers,
    });
  } catch {
    return true;
  }
  return refusedAsCrossSite(probe, request.peer, true);
}

/** Attaches the bridge to the console's HTTP server (dev server and production alike). */
export function attachSocketBridge(httpServer: Server | null | undefined): void {
  if (!httpServer || (httpServer as { nzSockets?: boolean }).nzSockets) return;
  (httpServer as { nzSockets?: boolean }).nzSockets = true;
  httpServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!bridgedPath(request.url)) return;
    const encrypted = Boolean((request.socket as { encrypted?: boolean }).encrypted);
    if (
      refusedUpgrade({
        url: request.url,
        headers: request.headers,
        peer: request.socket.remoteAddress ?? "",
        encrypted,
      })
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    // Taken in the same turn the upgrade arrives: Bun's `ws` needs that.
    try {
      socketServer().handleUpgrade(request, socket, head, (browser) => bridge(browser, request));
    } catch {
      socket.destroy();
    }
  });
}
