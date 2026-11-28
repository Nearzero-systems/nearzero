import {
  AppError,
  createDestinationRequestSchema,
  createScheduleRequestSchema,
  listFilesQuerySchema,
  restoreRequestSchema,
  testDestinationRequestSchema,
  testDestinationValuesRequestSchema,
  updateDestinationRequestSchema,
  updateScheduleRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { isWorkspaceAdmin } from "../access/evaluate.ts";
import { EventQueue, lastEventId, sseResponse } from "../deploys/streaming.ts";
import { type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { check, readBody } from "../http/validate.ts";
import { isOurId } from "../projects/objects.ts";
import type { ControlServices } from "../services.ts";
import {
  addDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  testDestination,
  testDestinationValues,
  updateDestination,
} from "./destinations.ts";
import { listServiceFiles, startRestore } from "./files.ts";
import { type RunEvent, type RunRow, type RunView, readRunLog, runBus, runView } from "./runs.ts";
import {
  backupsPanel,
  createSchedule,
  deleteSchedule,
  runScheduleNow,
  serviceFor,
  updateSchedule,
} from "./schedules.ts";

/**
 * Backups (spec 08 8.3, 17): destinations, schedules, runs and their live logs, finding backups
 * and restoring them. docs/api/backups.md documents each endpoint.
 */

const RUN_NOT_FOUND =
  "This backup run doesn't exist in this workspace, or you don't have access to it.";

/** A run, after checking the person may see it: its service's backup (or restore) rights. */
async function runFor(
  services: ControlServices,
  actor: WorkspaceActor,
  runId: string,
): Promise<RunRow> {
  if (!isOurId(runId)) throw new AppError("not_found", RUN_NOT_FOUND);
  const row = await services.db
    .selectFrom("backup_run")
    .selectAll()
    .where("id", "=", runId)
    .where("workspace_id", "=", actor.workspace.id)
    .executeTakeFirst();
  if (!row) throw new AppError("not_found", RUN_NOT_FOUND);
  if (!row.service_id) {
    // A deleted service's runs are for owners and admins.
    if (!isWorkspaceAdmin(actor.role)) throw new AppError("not_found", RUN_NOT_FOUND);
    return row;
  }
  const action = row.operation === "restore" ? "service.restore" : "service.backups";
  try {
    await actor.access.require(action, { kind: "service", id: row.service_id });
  } catch (error) {
    if (error instanceof AppError) throw new AppError("not_found", RUN_NOT_FOUND);
    throw error;
  }
  return row;
}

/** The Idempotency-Key a client sent with a request that starts a run (spec 23.1). */
function requestKeyOf(header: string | undefined): string | null {
  return header && /^[A-Za-z0-9_-]{8,100}$/.test(header) ? header : null;
}

function logEventId(runId: string, seq: number): string {
  return `${runId}:${seq}`;
}

export function backupRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- Destinations (spec 17.1)

  app.get("/backup-destinations", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await listDestinations(services, actor));
  });

  app.post("/backup-destinations", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createDestinationRequestSchema);
    const destination = await addDestination(services, actor, input);
    return c.json({ destination, message: "Destination added" }, 201);
  });

  app.get("/backup-destinations/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ destination: await getDestination(services, actor, c.req.param("id")) });
  });

  app.patch("/backup-destinations/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateDestinationRequestSchema);
    const destination = await updateDestination(services, actor, c.req.param("id"), input);
    return c.json({ destination, message: "Destination saved" });
  });

  app.delete("/backup-destinations/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await deleteDestination(services, actor, c.req.param("id")));
  });

  // Test connection in the Add / Edit dialog, with what is typed there (spec 17.1).
  app.post("/backup-destinations/test", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, testDestinationValuesRequestSchema);
    return c.json(await testDestinationValues(services, actor, input));
  });

  app.post("/backup-destinations/:id/test", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const raw = c.req.header("content-type")?.includes("json")
      ? await c.req.json().catch(() => ({}))
      : {};
    const input = check(testDestinationRequestSchema, raw ?? {});
    return c.json(await testDestination(services, actor, c.req.param("id"), input.serverId));
  });

  // ---- A service's backups (spec 08 8.3, 17.3)

  app.get("/services/:serviceId/backups", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await backupsPanel(services, actor, c.req.param("serviceId")));
  });

  app.post("/services/:serviceId/backup-schedules", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createScheduleRequestSchema);
    const schedule = await createSchedule(services, actor, c.req.param("serviceId"), input);
    return c.json({ schedule, message: "Backup schedule added" }, 201);
  });

  app.patch("/backup-schedules/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateScheduleRequestSchema);
    const schedule = await updateSchedule(services, actor, c.req.param("id"), input);
    return c.json({ schedule, message: "Backup schedule saved" });
  });

  app.delete("/backup-schedules/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await deleteSchedule(services, actor, c.req.param("id")));
  });

  // Run now (spec 08 8.3): answers at once; the run carries on in the background.
  app.post("/backup-schedules/:id/run", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const key = requestKeyOf(c.req.header("idempotency-key"));
    return c.json(await runScheduleNow(services, actor, c.req.param("id"), key), 202);
  });

  app.get("/services/:serviceId/backup-runs", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const { row } = await serviceFor(services, actor, c.req.param("serviceId"));
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 20) || 20));
    let query = services.db
      .selectFrom("backup_run")
      .selectAll()
      .where("service_id", "=", row.id)
      .orderBy("created_at", "desc")
      .limit(limit);
    const scheduleId = c.req.query("scheduleId");
    if (scheduleId && isOurId(scheduleId)) query = query.where("schedule_id", "=", scheduleId);
    const runs = await query.execute();
    return c.json({ runs: runs.map(runView) });
  });

  // The rows of the Backups tab follow their runs without a reload (spec 08 8.3).
  app.get("/services/:serviceId/backup-runs/events", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const { row } = await serviceFor(services, actor, c.req.param("serviceId"));
    return sseResponse(c, async (writer, aborted) => {
      const queue = new EventQueue<RunView>();
      const unsubscribe = runBus.subscribeService(row.id, (run) => queue.push(run));
      try {
        await writer.send("open", { serviceId: row.id });
        for (;;) {
          const next = await queue.next(aborted, 60_000);
          if (next === "aborted") return;
          if (next === "timeout") continue;
          await writer.send("run", { run: next });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  // Finding backups (spec 08 8.3, 17.3, 24 G1): only this service's own files.
  app.get("/services/:serviceId/backup-files", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const query = check(listFilesQuerySchema, {
      destinationId: c.req.query("destinationId") ?? "",
      folder: c.req.query("folder") ?? "",
      ...(c.req.query("volume") ? { volume: c.req.query("volume") } : {}),
    });
    return c.json(await listServiceFiles(services, actor, c.req.param("serviceId"), query));
  });

  app.post("/services/:serviceId/restores", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, restoreRequestSchema);
    const key = requestKeyOf(c.req.header("idempotency-key"));
    return c.json(await startRestore(services, actor, c.req.param("serviceId"), input, key), 202);
  });

  // ---- Runs and their logs

  app.get("/backup-runs/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ run: runView(await runFor(services, actor, c.req.param("id"))) });
  });

  app.get("/backup-runs/:id/log", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const run = await runFor(services, actor, c.req.param("id"));
    const pieces = await readRunLog(services.db, run.id);
    const last = pieces.at(-1)?.seq ?? 0;
    return c.json({
      text: pieces.map((piece) => piece.text).join(""),
      complete: run.status !== "queued" && run.status !== "running",
      lastEventId: logEventId(run.id, last),
    });
  });

  app.get("/backup-runs/:id/events", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const run = await runFor(services, actor, c.req.param("id"));
    const resume = lastEventId(c);
    const after = resume && resume.id === run.id ? resume.position : 0;
    return sseResponse(c, async (writer, aborted) => {
      const queue = new EventQueue<RunEvent>();
      // Subscribe before reading what is stored, so nothing written in between is lost.
      const unsubscribe = runBus.subscribe(run.id, (event) => queue.push(event));
      try {
        const current = runView(
          await services.db
            .selectFrom("backup_run")
            .selectAll()
            .where("id", "=", run.id)
            .executeTakeFirstOrThrow(),
        );
        await writer.send("open", { runId: run.id, status: current.status });
        let seq = after;
        for (const piece of await readRunLog(services.db, run.id, after)) {
          await writer.send(
            "log",
            { text: piece.text, seq: piece.seq },
            logEventId(run.id, piece.seq),
          );
          seq = piece.seq;
        }
        if (!current.open) {
          await writer.send("end", { run: current });
          return;
        }
        await writer.send("status", { run: current });
        for (;;) {
          const event = await queue.next(aborted, 60_000);
          if (event === "aborted") return;
          if (event === "timeout") continue;
          if (event.type === "log") {
            if (event.seq <= seq) continue;
            seq = event.seq;
            await writer.send(
              "log",
              { text: event.text, seq: event.seq },
              logEventId(run.id, event.seq),
            );
            continue;
          }
          if (event.run.open) {
            await writer.send("status", { run: event.run });
            continue;
          }
          // Anything written just before the end is sent before it.
          for (const piece of await readRunLog(services.db, run.id, seq)) {
            await writer.send(
              "log",
              { text: piece.text, seq: piece.seq },
              logEventId(run.id, piece.seq),
            );
            seq = piece.seq;
          }
          await writer.send("end", { run: event.run });
          return;
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
