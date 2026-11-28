import { saveVariablesRequestSchema } from "@nearzero/shared";
import { Hono } from "hono";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  revealServiceVariables,
  revealSharedVariables,
  saveServiceVariables,
  saveSharedVariables,
  serviceVariablesTab,
  sharedVariablesPage,
} from "./editor.ts";

/** Shared variables of an environment and a service's own (spec 05 5.5). Values are masked. */
export function variableRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/environments/:environmentId/variables", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await sharedVariablesPage(services, actor, c.req.param("environmentId")));
  });

  // "Show values": POST so the values never sit in a cache or a prefetch.
  app.post("/environments/:environmentId/variables/reveal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await revealSharedVariables(services, actor, c.req.param("environmentId")));
  });

  app.put("/environments/:environmentId/variables", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, saveVariablesRequestSchema);
    return c.json(await saveSharedVariables(services, actor, c.req.param("environmentId"), input));
  });

  app.get("/services/:serviceId/variables", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await serviceVariablesTab(services, actor, c.req.param("serviceId")));
  });

  app.post("/services/:serviceId/variables/reveal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await revealServiceVariables(services, actor, c.req.param("serviceId")));
  });

  app.put("/services/:serviceId/variables", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, saveVariablesRequestSchema);
    return c.json(await saveServiceVariables(services, actor, c.req.param("serviceId"), input));
  });

  return app;
}
