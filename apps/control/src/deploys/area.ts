import { Hono } from "hono";
import type { AppEnv } from "../http/context.ts";
import { runnerUploadRoutes, serviceRuntimeRoutes } from "../service-runtime/routes.ts";
import type { ControlServices } from "../services.ts";
import { publicGitRoutes } from "../sources/public-git.ts";
import { webhookRoutes } from "../webhooks/routes.ts";
import { deployRoutes } from "./routes.ts";

/**
 * Everything of M3c under /api/v1: deployments and their logs, a service's runtime (start, stop,
 * reload, logs, terminal), its source, builder, ports, mounts and deploy settings, uploads, the
 * deploy webhook, database connections, and the runner's archive download.
 */
export function deployAreaRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/", deployRoutes(services));
  app.route("/", serviceRuntimeRoutes(services));
  app.route("/", webhookRoutes(services));
  app.route("/", runnerUploadRoutes(services));
  app.route("/", publicGitRoutes(services));
  return app;
}
