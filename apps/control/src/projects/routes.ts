import {
  createProjectRequestSchema,
  deleteProjectRequestSchema,
  listProjectsQuerySchema,
  updateProjectRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { projectDeletePlan } from "../deletion/plan.ts";
import { getRun, latestProjectRun, startProjectDelete } from "../deletion/runs.ts";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { check, readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import { createProject, getProject, listProjects, updateProject } from "./projects.ts";

/** Projects in the active workspace (spec 05 5.1), and following deletes. */
export function projectRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/projects", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const query = check(listProjectsQuerySchema, {
      search: c.req.query("search") ?? "",
      sort: c.req.query("sort") || undefined,
    });
    return c.json(await listProjects(services, actor, query));
  });

  app.post("/projects", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createProjectRequestSchema);
    return c.json(await createProject(services, actor, input), 201);
  });

  app.get("/projects/:projectId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ project: await getProject(services, actor, c.req.param("projectId")) });
  });

  app.patch("/projects/:projectId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateProjectRequestSchema);
    return c.json(await updateProject(services, actor, c.req.param("projectId"), input));
  });

  app.get("/projects/:projectId/delete-plan", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ plan: await projectDeletePlan(services, actor, c.req.param("projectId")) });
  });

  app.post("/projects/:projectId/delete", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, deleteProjectRequestSchema);
    const run = await startProjectDelete(services, actor, c.req.param("projectId"), input);
    return c.json({ run }, 202);
  });

  app.get("/projects/:projectId/delete-run", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ run: await latestProjectRun(services, actor, c.req.param("projectId")) });
  });

  app.get("/delete-runs/:runId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ run: await getRun(services, actor, c.req.param("runId")) });
  });

  return app;
}
