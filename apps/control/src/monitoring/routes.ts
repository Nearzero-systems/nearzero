import {
  alertSettingsRequestSchema,
  type MetricsSample,
  MONITORING_MESSAGES,
} from "@nearzero/shared";
import { Hono } from "hono";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { Logger } from "../log.ts";
import type { ControlServices } from "../services.ts";
import { alertSettings, evaluateAlerts, sendTestAlert, updateAlertSettings } from "./alerts.ts";

/**
 * A server's alert settings (spec 14.3); its samples are served by GET /servers/:id/metrics.
 * docs/api/monitoring.md.
 */
export function monitoringRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/servers/:id/alerts", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ alerts: await alertSettings(services, actor, c.req.param("id")) });
  });

  app.put("/servers/:id/alerts", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(c, alertSettingsRequestSchema);
    const alerts = await updateAlertSettings(services, actor, c.req.param("id"), body);
    return c.json({ alerts, message: MONITORING_MESSAGES.saved });
  });

  app.post("/servers/:id/alerts/test", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await sendTestAlert(services, actor, c.req.param("id")));
  });

  return app;
}

/** Each target's samples are applied in arrival order, one message at a time. */
const chains = new Map<string, Promise<unknown>>();

export function alertsOnMetrics(services: Pick<ControlServices, "db">, log: Logger) {
  return (target: string, samples: readonly MetricsSample[]): Promise<void> => {
    const previous = chains.get(target) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(() => evaluateAlerts(services.db, log, target, samples))
      .catch((error: unknown) => log.warn("couldn't check server alerts", { target, error }))
      .finally(() => {
        if (chains.get(target) === next) chains.delete(target);
      });
    chains.set(target, next);
    return next.then(() => {});
  };
}
