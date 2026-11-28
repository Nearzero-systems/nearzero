import { createEnvironmentRequestSchema, updateEnvironmentRequestSchema } from "@nearzero/shared";
import { Hono } from "hono";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  createEnvironment,
  deleteEnvironment,
  getEnvironment,
  listEnvironments,
  updateEnvironment,
} from "./environments.ts";

/** A project's environments (spec 05 5.3). */
export function environmentRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/projects/:projectId/environments", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await listEnvironments(services, actor, c.req.param("projectId")));
  });

  app.post("/projects/:projectId/environments", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createEnvironmentRequestSchema);
    return c.json(await createEnvironment(services, actor, c.req.param("projectId"), input), 201);
  });

  app.get("/environments/:environmentId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({
      environment: await getEnvironment(services, actor, c.req.param("environmentId")),
    });
  });

  app.patch("/environments/:environmentId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateEnvironmentRequestSchema);
    return c.json({
      environment: await updateEnvironment(services, actor, c.req.param("environmentId"), input),
    });
  });

  app.delete("/environments/:environmentId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await deleteEnvironment(services, actor, c.req.param("environmentId"));
    return c.json({ deleted: true });
  });

  return app;
}
