import { API_PREFIX, AppError, type HealthResponse, VERSION } from "@nearzero/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { AGENT_UPLOAD_PATH, agentRoutes } from "./agent/routes.ts";
import { analyticsRoutes } from "./analytics/routes.ts";
import { backupRoutes } from "./backups/routes.ts";
import { composeRoutes } from "./compose-runtime/routes.ts";
import { type Db, databaseIsReachable } from "./db/database.ts";
import { deployAreaRoutes } from "./deploys/area.ts";
import { domainRoutes } from "./domains/routes.ts";
import { gitProviderRoutes } from "./git-providers/routes.ts";
import { type AppEnv, requestContext } from "./http/context.ts";
import { handleError, handleNotFound } from "./http/errors.ts";
import { originGuard } from "./http/origin-guard.ts";
import { identityRoutes } from "./identity/routes.ts";
import { sessionMiddleware } from "./identity/sessions.ts";
import type { Logger } from "./log.ts";
import { memberRoutes } from "./members/routes.ts";
import { runnerMigrationRoutes } from "./migration/routes.ts";
import { legacyWebhookRoutes } from "./migration/webhook-paths.ts";
import { monitoringRoutes } from "./monitoring/routes.ts";
import { notificationRoutes } from "./notifications/routes.ts";
import { projectAreaRoutes } from "./projects/area.ts";
import { runnerGatewayRoutes } from "./runners/gateway.ts";
import { serverSetupRoutes } from "./server-setup/routes.ts";
import { serverRoutes } from "./servers/routes.ts";
import { UPLOAD_PATH } from "./service-runtime/routes.ts";
import { type ControlServices, createServices, type ServiceOptions } from "./services.ts";
import { settingsRoutes } from "./settings/routes.ts";
import { sshKeyRoutes } from "./ssh-keys/routes.ts";
import { taskRoutes } from "./tasks/routes.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "./webhooks/routes.ts";
import { workspaceRoutes } from "./workspaces/routes.ts";

export interface AppDependencies {
  db: Db;
  log: Logger;
  /** Ready-made services (tests build their own to reach them); otherwise made from `options`. */
  services?: ControlServices;
  options?: Omit<ServiceOptions, "db" | "log">;
}

/** The control plane's HTTP API. Everything is JSON under /api/v1 (spec 25, D5). */
export function createApp({ db, log, services, options }: AppDependencies): Hono<AppEnv> {
  const shared = services ?? createServices({ db, log, ...options });
  const app = new Hono<AppEnv>();
  app.use("*", requestContext(log));
  app.onError(handleError);
  app.notFound(handleNotFound);

  const api = new Hono<AppEnv>();

  // Answers carry people's data, so nothing in between keeps a copy unless a route says so.
  api.use("*", async (c, next) => {
    await next();
    if (!c.res.headers.has("cache-control")) c.res.headers.set("cache-control", "no-store");
  });

  // Reports the running version so a support question starts from the right one (spec 23.1).
  const health = async (c: Context<AppEnv>) => {
    const database = (await databaseIsReachable(db)) ? "ok" : "unreachable";
    const body: HealthResponse = {
      status: database === "ok" ? "ok" : "degraded",
      version: VERSION,
      checks: { database },
    };
    c.header("cache-control", "no-store");
    return c.json(body, database === "ok" ? 200 : 503);
  };
  api.get("/health", health);
  // 0.1.x's health address, which uptime monitors point at, answers the same (R4-11).
  app.get("/api/health", health);

  // Webhooks from Git hosts and registries: the deploy webhook, the GitHub App's, and 0.1.x's
  // addresses a move kept.
  const WEBHOOK_PATH = /^\/api\/v1\/webhooks\/(deploy|github|legacy)\//;
  // The largest body an identity endpoint takes is an avatar image (2 MB); JSON is far smaller.
  // Uploaded app archives (up to 200 MB) have their own limit on their route.
  const usualLimit = bodyLimit({
    maxSize: 3 * 1024 * 1024,
    onError: () => {
      throw new AppError("payload_too_large", "The request is too large. Send less at once.");
    },
  });
  // Git hosts' and registries' webhooks may send up to 25 MB (G2-04); the routes check it.
  const webhookLimit = bodyLimit({
    maxSize: WEBHOOK_MAX_BODY_BYTES,
    onError: () => {
      throw new AppError("payload_too_large", "The webhook body is larger than 25 MB.");
    },
  });
  api.use("*", (c, next) =>
    UPLOAD_PATH.test(c.req.path) || AGENT_UPLOAD_PATH.test(c.req.path)
      ? next()
      : WEBHOOK_PATH.test(c.req.path)
        ? webhookLimit(c, next)
        : usualLimit(c, next),
  );
  // Changes and terminals only from the console's own pages (spec 22.4, 24 G11).
  api.use("*", originGuard(shared));
  api.use("*", sessionMiddleware(shared));
  api.route("/", identityRoutes(shared));
  api.route("/", workspaceRoutes(shared));
  api.route("/", memberRoutes(shared));
  api.route("/", settingsRoutes(shared));
  api.route("/", projectAreaRoutes(shared));
  api.route("/", runnerGatewayRoutes(shared));
  api.route("/", serverRoutes(shared));
  api.route("/", serverSetupRoutes(shared));
  api.route("/", sshKeyRoutes(shared));
  api.route("/", domainRoutes(shared));
  api.route("/", deployAreaRoutes(shared));
  api.route("/", gitProviderRoutes(shared));
  api.route("/", backupRoutes(shared));
  api.route("/", agentRoutes(shared));
  api.route("/", composeRoutes(shared));
  // Tasks, analytics, monitoring alerts and notification channels (spec 12–15).
  api.route("/", taskRoutes(shared));
  api.route("/", analyticsRoutes(shared));
  api.route("/", monitoringRoutes(shared));
  api.route("/", notificationRoutes(shared));
  // What a move from 0.1.x keeps working (spec 29.5): a runner's download of a volume archive
  // it restores, the old webhook addresses (answered like 1.0's own) and old console addresses.
  api.route("/", runnerMigrationRoutes(shared));
  api.route(
    "/",
    legacyWebhookRoutes(shared, async (path, init, env) =>
      app.request(path, init, env as AppEnv["Bindings"]),
    ),
  );

  app.route(API_PREFIX, api);
  return app;
}
