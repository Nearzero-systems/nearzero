import { Hono } from "hono";
import { environmentRoutes } from "../environments/routes.ts";
import type { AppEnv } from "../http/context.ts";
import { serviceRoutes } from "../services/routes.ts";
import type { ControlServices } from "../services.ts";
import { variableRoutes } from "../variables/routes.ts";
import { projectRoutes } from "./routes.ts";

/**
 * Everything of M3b under /api/v1: projects, environments, services and variables. Every
 * endpoint acts on the active workspace and goes through the permission module.
 */
export function projectAreaRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.route("/", projectRoutes(services));
  app.route("/", environmentRoutes(services));
  app.route("/", serviceRoutes(services));
  app.route("/", variableRoutes(services));
  return app;
}
