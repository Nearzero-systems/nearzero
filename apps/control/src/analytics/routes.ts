import { analyticsSettingsRequestSchema } from "@nearzero/shared";
import { Hono } from "hono";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  analyticsPage,
  analyticsSettings,
  deleteAllRequests,
  updateAnalyticsSettings,
} from "./area.ts";

/** Analytics (spec 13), instance administrators only; docs/api/analytics.md. */
export function analyticsRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/analytics", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await analyticsPage(services, actor, c.req.query()));
  });

  app.get("/analytics/settings", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ settings: await analyticsSettings(services, actor) });
  });

  app.patch("/analytics/settings", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(c, analyticsSettingsRequestSchema);
    return c.json(await updateAnalyticsSettings(services, actor, body));
  });

  app.post("/analytics/delete-all", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await deleteAllRequests(services, actor));
  });

  return app;
}
