import {
  checkTaskRequestSchema,
  createTaskRequestSchema,
  TASK_MESSAGES,
  updateTaskRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";
import {
  checkTaskRequest,
  createTask,
  deleteTask,
  getTask,
  listTasks,
  placeChoices,
  reviewTask,
  runTaskNow,
  stopTaskRun,
  taskRun,
  taskRuns,
  updateTask,
} from "./area.ts";

/** Tasks (spec 12); docs/api/tasks.md documents each endpoint. */
export function taskRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get("/tasks", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await listTasks(services, actor, c.req.query()));
  });

  app.get("/tasks/places", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ places: await placeChoices(services, actor) });
  });

  app.post("/tasks/check", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(c, checkTaskRequestSchema);
    return c.json({ check: await checkTaskRequest(services, actor, body) });
  });

  app.post("/tasks", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(c, createTaskRequestSchema);
    const result = await createTask(services, actor, body);
    if (!result.saved) return c.json({ saved: false, check: result.check });
    return c.json(
      { saved: true, task: result.task, check: result.check, message: TASK_MESSAGES.created },
      201,
    );
  });

  app.get("/tasks/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ task: await getTask(services, actor, c.req.param("id")) });
  });

  app.get("/tasks/:id/review", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await reviewTask(services, actor, c.req.param("id")));
  });

  app.patch("/tasks/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const body = await readBody(c, updateTaskRequestSchema.passthrough());
    const result = await updateTask(services, actor, c.req.param("id"), body);
    if (!result.saved) return c.json({ saved: false, check: result.check });
    return c.json({
      saved: true,
      task: result.task,
      check: result.check,
      message: TASK_MESSAGES.updated,
    });
  });

  app.delete("/tasks/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await deleteTask(services, actor, c.req.param("id"));
    return c.json({ deleted: true, message: TASK_MESSAGES.deleted });
  });

  app.post("/tasks/:id/run", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const run = await runTaskNow(services, actor, c.req.param("id"));
    return c.json({ run, message: TASK_MESSAGES.started }, 202);
  });

  app.get("/tasks/:id/runs", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ runs: await taskRuns(services, actor, c.req.param("id")) });
  });

  app.get("/task-runs/:runId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ run: await taskRun(services, actor, c.req.param("runId")) });
  });

  app.post("/task-runs/:runId/stop", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const run = await stopTaskRun(services, actor, c.req.param("runId"));
    return c.json({ run, message: TASK_MESSAGES.stopped });
  });

  return app;
}
