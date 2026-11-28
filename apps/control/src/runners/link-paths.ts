import type { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import { MAX_REQUEST_BODY_BYTES } from "../service-runtime/routes.ts";
import { socketServer, upgraderFor } from "./sockets.ts";

/**
 * The runner link's own TLS port (spec 31 "Remote runners are always encrypted"): what servers
 * reach when Nearzero has no domain, served with the certificate made at install. It serves the
 * runner's own routes and the health check, nothing a browser uses: sign-in, the console's API and
 * webhooks stay on the API's port and the console's domain.
 */
export function isRunnerLinkPath(pathname: string): boolean {
  return pathname.startsWith("/api/v1/runner/") || pathname === "/api/v1/health";
}

export function serveRunnerLink(
  app: Pick<Hono<AppEnv>, "fetch">,
  options: {
    hostname: string;
    port: number;
    certificate: string;
    key: string;
    idleTimeoutSeconds: number;
  },
): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: options.hostname,
    port: options.port,
    idleTimeout: options.idleTimeoutSeconds,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    tls: { cert: options.certificate, key: options.key },
    websocket: socketServer,
    fetch: (request, server) => {
      if (!isRunnerLinkPath(new URL(request.url).pathname)) {
        return new Response("Only Nearzero's runners connect here.\n", { status: 404 });
      }
      return app.fetch(request, {
        peerAddress: server.requestIP(request)?.address,
        upgrade: upgraderFor(server),
        runnerLinkTls: true,
      });
    },
  });
}
