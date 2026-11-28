import { AppError, type SetupRunView } from "@nearzero/shared";
import { Hono } from "hono";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { EventQueue, lastEventId, sseResponse } from "../deploys/streaming.ts";
import { auditActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import { isOurId } from "../projects/objects.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { loadView } from "../servers/servers.ts";
import type { ControlServices } from "../services.ts";
import { storedAudit } from "./audit.ts";
import { cleanupView, setCleanup } from "./cleanup.ts";
import { auditServer, checkServer, validationOnOpen } from "./inspect.ts";
import { readSetupLog, type SetupEvent, setupBus } from "./log.ts";
import { latestRemoval } from "./removal.ts";
import { latestRun, loadRun, runView, setupView, startSetup } from "./runs.ts";
import { storedValidation } from "./validation.ts";

/**
 * Setting servers up over SSH, and what setup leaves to look at (spec 09 9.3–9.6):
 * docs/api/server-setup.md documents each endpoint.
 */

const startSchema = z.object({
  /** "Use <user> and run setup again": the server's SSH user changes first. */
  sshUser: z.string().max(64).optional(),
});

const cleanupSchema = z.object({ enabled: z.boolean({ error: "Send enabled: true or false." }) });

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const trustSchema = z.object({
  fingerprint: z
    .string()
    .trim()
    .regex(FINGERPRINT, "Paste the fingerprint as SHA256:… (43 characters after the colon)."),
});

function serverId(value: string): string {
  if (value === HOST_TARGET) {
    throw new AppError(
      "invalid_request",
      "The Nearzero host is set up by the installer, not over SSH.",
    );
  }
  if (!isOurId(value)) {
    throw new AppError(
      "not_found",
      "This server doesn't exist in this workspace, or you don't have access to it.",
    );
  }
  return value;
}

export function serverSetupRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // ---- Setup runs (spec 9.3)

  app.get("/servers/:id/setup", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ setup: await setupView(services, actor, serverId(c.req.param("id"))) });
  });

  app.post("/servers/:id/setup", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const json = /^application\/json\b/i.test(c.req.header("content-type") ?? "");
    const input = json ? await readBody(c, startSchema) : {};
    const result = await startSetup(services, actor, serverId(c.req.param("id")), input);
    return c.json({ setup: result.view, started: result.started }, 202);
  });

  /** The run's log and state as server-sent events; resumes from Last-Event-ID (<run>:<seq>). */
  app.get("/servers/:id/setup/events", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    await actor.access.require("server.see", { kind: "server", id });
    await loadView(services, actor.workspace.id, id);
    const resume = lastEventId(c);
    const wanted = c.req.query("run");
    return sseResponse(c, async (writer, aborted) => {
      const queue = new EventQueue<SetupEvent>();
      const unsubscribe = setupBus.subscribe(id, (event) => queue.push(event));
      try {
        let run =
          wanted && isOurId(wanted)
            ? await loadRun(services.db, wanted)
            : await latestRun(services.db, id);
        if (run && run.server_id !== id) run = undefined;
        let runId = run?.id ?? null;
        let seq = resume && resume.id === runId ? resume.position : 0;
        const sendRun = async (view: SetupRunView | null) => {
          await writer.send("run", { run: view });
        };
        await sendRun(run ? runView(run) : null);
        const catchUp = async () => {
          if (!runId) return;
          for (;;) {
            const lines = await readSetupLog(services.db, runId, seq, 1_000);
            for (const line of lines) {
              seq = line.seq;
              await writer.send("log", { seq: line.seq, text: line.text }, `${runId}:${line.seq}`);
            }
            if (lines.length < 1_000) return;
          }
        };
        await catchUp();
        for (;;) {
          const event = await queue.next(aborted, 30_000);
          if (event === "aborted") return;
          if (event === "timeout") continue;
          if (event.type === "log") {
            if (event.runId !== runId) continue;
            if (event.seq <= seq) continue;
            if (event.seq > seq + 1) {
              await catchUp();
              continue;
            }
            seq = event.seq;
            await writer.send("log", { seq: event.seq, text: event.text }, `${runId}:${event.seq}`);
          } else {
            const fresh = await loadRun(services.db, event.runId);
            if (!fresh || fresh.server_id !== id) continue;
            if (fresh.id !== runId) {
              // A new run started: follow it from its first line.
              runId = fresh.id;
              seq = 0;
            }
            await sendRun(runView(fresh));
            await catchUp();
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get("/servers/:id/setup/log", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    await actor.access.require("server.see", { kind: "server", id });
    const wanted = c.req.query("run");
    const run =
      wanted && isOurId(wanted)
        ? await loadRun(services.db, wanted)
        : await latestRun(services.db, id);
    if (!run || run.server_id !== id) return c.json({ runId: null, lines: [], text: "" });
    const lines = await readSetupLog(services.db, run.id, 0, 20_000);
    return c.json({ runId: run.id, lines, text: lines.map((line) => line.text).join("\n") });
  });

  // ---- Host key (spec 9.2, 22.5)

  app.post("/servers/:id/host-key/trust", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    await actor.access.require("server.manage", { kind: "server", id });
    const { fingerprint } = await readBody(c, trustSchema);
    await services.db
      .updateTable("server")
      .set({ host_key_fingerprint: fingerprint, updated_at: new Date() })
      .where("id", "=", id)
      .where("workspace_id", "=", actor.workspace.id)
      .execute();
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "server.host-key-trusted",
      workspaceId: actor.workspace.id,
      target: { kind: "server", id },
      details: { fingerprint },
    });
    return c.json({ hostKeyFingerprint: fingerprint });
  });

  app.delete("/servers/:id/host-key", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    await actor.access.require("server.manage", { kind: "server", id });
    await services.db
      .updateTable("server")
      .set({ host_key_fingerprint: null, updated_at: new Date() })
      .where("id", "=", id)
      .where("workspace_id", "=", actor.workspace.id)
      .execute();
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "server.host-key-forgotten",
      workspaceId: actor.workspace.id,
      target: { kind: "server", id },
    });
    return c.json({ hostKeyFingerprint: null });
  });

  // ---- Validation and the security audit (spec 9.4)

  // Both only read the server, so anyone who can see it may run them; changing anything still
  // needs its manage rights (spec 30 decisions part 2, R3-06).

  app.get("/servers/:id/validation", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    // ?fresh=1 is the details opening: a set-up server is checked again unless the stored
    // result is under a minute old.
    if (c.req.query("fresh") === "1") {
      return c.json({ validation: await validationOnOpen(services, actor, id) });
    }
    await actor.access.require("server.see", { kind: "server", id });
    return c.json({ validation: await storedValidation(services, id) });
  });

  app.post("/servers/:id/validation", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    return c.json({ validation: await checkServer(services, actor, id) });
  });

  app.get("/servers/:id/security-audit", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    await actor.access.require("server.see", { kind: "server", id });
    return c.json({ audit: await storedAudit(services, id) });
  });

  app.post("/servers/:id/security-audit", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = serverId(c.req.param("id"));
    return c.json({ audit: await auditServer(services, actor, id) });
  });

  // ---- Daily Docker cleanup (spec 9.4, 14.4); "host" works too (instance administrators)

  app.get("/servers/:id/docker-cleanup", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ cleanup: await cleanupView(services, actor, c.req.param("id")) });
  });

  app.put("/servers/:id/docker-cleanup", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const { enabled } = await readBody(c, cleanupSchema);
    return c.json({ cleanup: await setCleanup(services, actor, c.req.param("id"), enabled) });
  });

  // ---- Deleting a server with its services (spec 9.6)

  app.get("/servers/:id/removal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = c.req.param("id");
    // Who can't see the server never learns of its delete, or the services on it (B1-48). Once
    // the server is gone, its finished delete is for those who may add and remove servers.
    const exists = isOurId(id)
      ? await services.db
          .selectFrom("server")
          .select("id")
          .where("id", "=", id)
          .where("workspace_id", "=", actor.workspace.id)
          .executeTakeFirst()
      : undefined;
    if (exists) await actor.access.require("server.see", { kind: "server", id });
    else if (!actor.access.can("servers.add")) {
      throw new AppError(
        "not_found",
        "This server doesn't exist in this workspace, or you don't have access to it.",
      );
    }
    const removal = await latestRemoval(services, actor, id);
    if (!removal && !exists) {
      throw new AppError(
        "not_found",
        "This server doesn't exist in this workspace, or you don't have access to it.",
      );
    }
    return c.json({ removal });
  });

  return app;
}
