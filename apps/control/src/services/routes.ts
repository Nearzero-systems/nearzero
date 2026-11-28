import {
  createServiceRequestSchema,
  deleteServiceRequestSchema,
  deleteServicesRequestSchema,
  servicesDeletePlanRequestSchema,
  updateServiceRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { servicesDeletePlan } from "../deletion/plan.ts";
import { serviceDeletePlan, startServiceDelete, startServicesDelete } from "../deletion/runs.ts";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  createService,
  getService,
  listServices,
  revealCredentials,
  updateService,
} from "./records.ts";

/** Services in an environment (spec 05 5.2, 5.4; spec 06 6.1; spec 07 7.1; spec 08 8.1). */
export function serviceRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/environments/:environmentId/services", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await listServices(services, actor, c.req.param("environmentId")));
  });

  app.post("/environments/:environmentId/services", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createServiceRequestSchema);
    return c.json(await createService(services, actor, c.req.param("environmentId"), input), 201);
  });

  app.post("/environments/:environmentId/services/delete-plan", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, servicesDeletePlanRequestSchema);
    return c.json({
      plan: await servicesDeletePlan(
        services,
        actor,
        c.req.param("environmentId"),
        input.serviceIds,
      ),
    });
  });

  app.post("/environments/:environmentId/services/delete", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, deleteServicesRequestSchema);
    const run = await startServicesDelete(services, actor, c.req.param("environmentId"), input);
    return c.json({ run }, 202);
  });

  app.get("/services/:serviceId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ service: await getService(services, actor, c.req.param("serviceId")) });
  });

  app.patch("/services/:serviceId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateServiceRequestSchema);
    return c.json(await updateService(services, actor, c.req.param("serviceId"), input));
  });

  app.get("/services/:serviceId/delete-plan", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ plan: await serviceDeletePlan(services, actor, c.req.param("serviceId")) });
  });

  app.post("/services/:serviceId/delete", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, deleteServiceRequestSchema);
    const run = await startServiceDelete(services, actor, c.req.param("serviceId"), input);
    return c.json({ run }, 202);
  });

  // POST so nothing caches or prefetches it; the answer carries a password.
  app.post("/services/:serviceId/credentials/reveal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      credentials: await revealCredentials(services, actor, c.req.param("serviceId")),
    });
  });

  return app;
}
