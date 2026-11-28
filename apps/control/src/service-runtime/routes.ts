import {
  AppError,
  appSourceRequestSchema,
  buildSettingsRequestSchema,
  CONNECTION_NOT_RUNNING,
  DATABASE_DEFAULTS,
  type DatabaseKind,
  databaseConnectionUrl,
  deploySettingsRequestSchema,
  isDatabaseKind,
  makePublicRequestSchema,
  maskedConnectionUrl,
  mountsRequestSchema,
  normalizeBuildPath,
  PRIVATE_DATABASE_HINT,
  portsRequestSchema,
  publicPortHint,
  runtimeLogsQuerySchema,
  TERMINAL_NEEDS_WEBSOCKET,
  UPLOAD_MAX_BYTES,
  UPLOAD_TOO_LARGE,
  unknownAddressHint,
  WEBHOOK_AUTODEPLOY_OFF,
  WEBHOOK_NEEDS_DEPLOY,
  WEBHOOK_NONE_YET,
  WEBHOOK_NONE_YET_IMAGE,
} from "@nearzero/shared";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { recordAudit } from "../audit/audit.ts";
import { startServiceDeploy } from "../deploys/routes.ts";
import { lastEventId, pipeHubStream, sseResponse } from "../deploys/streaming.ts";
import { auditActor, type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { check, readBody } from "../http/validate.ts";
import { verifyCredential } from "../runners/credentials.ts";
import { HOST_TARGET, targetOf } from "../runners/hub.ts";
import { allocatePublicPort, NO_FREE_PORT_NOTE } from "../services/placement.ts";
import { revealCredentials, type ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { storeUpload, uploadForRunner } from "../sources/uploads.ts";
import {
  currentWebhookToken,
  replaceWebhookToken,
  WEBHOOK_UPLOAD_SOURCE,
  webhookUrl,
} from "../webhooks/tokens.ts";
import { readAppSettings } from "./app-settings.ts";
import { readDatabaseSettings } from "./databases.ts";
import {
  runtimeAction,
  serverOf,
  serviceContainer,
  serviceForAction,
  serviceRuntime,
} from "./runtime.ts";
import {
  recordUpload,
  saveBuild,
  saveDeploySettings,
  saveMounts,
  savePorts,
  saveSource,
  shareableVolumes,
} from "./settings.ts";

/**
 * A service at run time (spec 6.2, 6.3, 6.6–6.8, 8.2): Start, Stop, Reload, its containers,
 * live logs, a terminal, source/builder/ports/mounts/deploy settings, uploads, the deploy
 * webhook, and a database's connection details and public port. docs/api/deploys.md has them all.
 */

/** Uploads are the one request larger than the API's usual limit. */
export const UPLOAD_PATH = /^\/api\/v1\/services\/[^/]+\/source\/upload$/;

/** The largest request body the HTTP server takes at all: an upload and its framing. */
export const MAX_REQUEST_BODY_BYTES = UPLOAD_MAX_BYTES + 16 * 1024 * 1024;

/** The shells a terminal can open (spec 6.7). */
function terminalCommand(shell: string): string[] {
  if (shell === "bash") {
    return [
      "/bin/sh",
      "-c",
      "if command -v bash >/dev/null 2>&1; then exec bash; else echo 'bash is not installed in this container; opening sh.'; exec sh; fi",
    ];
  }
  return ["/bin/sh"];
}

function intQuery(c: Context<AppEnv>, name: string, fallback: number, min: number, max: number) {
  const raw = c.req.query(name);
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError("invalid_request", `${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

async function serverAddress(services: ControlServices, row: ServiceRow): Promise<string | null> {
  if (row.server_id === null) return services.runners.hostPublicIPv4;
  const server = await services.db
    .selectFrom("server")
    .select("address")
    .where("id", "=", row.server_id)
    .executeTakeFirst();
  return server?.address ?? null;
}

export function serviceRuntimeRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = services;
  const hub = services.runners;
  // Which service and container each live log stream reads (B1-31): resuming with
  // Last-Event-ID reuses a stream only for the same service and container, so knowing another
  // service's stream id never reads its logs. Entries go when their stream does.
  const logStreams = new Map<string, { serviceId: string; containerId: string }>();
  const forgetEnded = () => {
    for (const id of logStreams.keys()) if (!hub.stream(id)) logStreams.delete(id);
  };

  // ---- Start, stop, reload, containers (spec 6.2, 8.2)

  for (const action of ["start", "stop", "reload"] as const) {
    app.post(`/services/:serviceId/${action}`, async (c) => {
      const actor = await workspaceActorFor(c, services);
      return c.json(await runtimeAction(services, actor, c.req.param("serviceId"), action));
    });
  }

  app.get("/services/:serviceId/runtime", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json(await serviceRuntime(services, actor, c.req.param("serviceId")));
  });

  // ---- Logs (spec 6.7): live output with a line count, since, search and follow.

  app.get("/services/:serviceId/logs", async (c) => {
    const actor = await workspaceActorFor(c, services);
    // Access first: nothing is sent before it is checked (spec 22.4, rule 2).
    const row = await serviceForAction(
      services,
      actor,
      c.req.param("serviceId"),
      "service.deployments",
    );
    const query = check(runtimeLogsQuerySchema, c.req.query());
    const container = await serviceContainer(services, row, query.container);
    const resume = lastEventId(c);
    const existing = resume ? hub.stream(resume.id) : null;
    const owner = existing ? logStreams.get(existing.id) : undefined;
    const reuse =
      existing &&
      existing.target === serverOf(row) &&
      existing.kind === "container.logs" &&
      owner?.serviceId === row.id &&
      owner.containerId === container.id
        ? existing
        : null;
    let stream = reuse;
    if (!stream) {
      forgetEnded();
      stream = (
        await hub.openStream(serverOf(row), "container.logs", {
          id: container.id,
          follow: query.follow === "1",
          // A stream that ended: carry on from now. Someone else's: start as asked.
          tail: resume && !existing ? 0 : query.tail === "all" ? "all" : Number(query.tail),
          // Each line starts with the time Docker recorded for it (31d G4-15).
          timestamps: true,
          ...(query.since ? { since: Date.parse(query.since) / 1000 } : {}),
        })
      ).stream;
      logStreams.set(stream.id, { serviceId: row.id, containerId: container.id });
    }
    const search = query.search.trim().toLowerCase();
    return sseResponse(c, (writer, aborted) =>
      pipeHubStream(
        writer,
        aborted,
        stream,
        reuse && resume ? resume.position : 0,
        search ? (line) => line.toLowerCase().includes(search) : null,
      ),
    );
  });

  // ---- Terminal (spec 6.7, G11): deploy rights on the service, checked before the shell starts.

  app.get("/services/:serviceId/terminal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await serviceForAction(services, actor, c.req.param("serviceId"), "service.deploy");
    // The container is found before the WebSocket is asked for, so a plain GET answers with the
    // same refusal an upgrade gets (a container that is gone): the console shows it (C3-06).
    const container = await serviceContainer(services, row, c.req.query("container") || undefined);
    const upgrade = c.env?.upgrade;
    if (!upgrade || c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new AppError("invalid_request", TERMINAL_NEEDS_WEBSOCKET);
    }
    const shell = c.req.query("shell") === "bash" ? "bash" : "sh";
    const opened = await hub.openStream(serverOf(row), "container.exec", {
      id: container.id,
      command: terminalCommand(shell),
      tty: true,
      cols: intQuery(c, "cols", 80, 1, 1000),
      rows: intQuery(c, "rows", 24, 1, 1000),
    });
    await recordAudit(db, services.log, auditActor(actor), {
      action: "terminal.opened",
      workspaceId: actor.workspace.id,
      target: { kind: "service", id: row.id },
      details: { container: container.name, shell },
    });
    const streamId = opened.stream.id;
    let unsubscribe: (() => void) | null = null;
    const ok = upgrade(c.req.raw, {
      open(socket) {
        const stream = hub.stream(streamId);
        if (!stream) {
          socket.close(1011, "terminal ended");
          return;
        }
        unsubscribe = stream.subscribe((event) => {
          if (event.type === "output") socket.send(event.bytes);
          else if (event.type === "link") {
            socket.send(JSON.stringify({ type: "status", connected: event.connected }));
          } else if (event.type === "end") {
            socket.send(
              JSON.stringify({ type: "exit", exitCode: event.exitCode, error: event.error }),
            );
            socket.close(1000, "exited");
          }
        });
      },
      message(_socket, data) {
        if (typeof data !== "string") {
          hub.input(streamId, data);
          return;
        }
        let parsed: { type?: string; cols?: number; rows?: number; data?: string } | null = null;
        try {
          parsed = JSON.parse(data);
        } catch {
          hub.input(streamId, new TextEncoder().encode(data));
          return;
        }
        if (
          parsed?.type === "resize" &&
          Number.isInteger(parsed.cols) &&
          Number.isInteger(parsed.rows)
        ) {
          hub.resize(
            streamId,
            Math.min(1000, Math.max(1, parsed.cols as number)),
            Math.min(1000, Math.max(1, parsed.rows as number)),
          );
        } else if (parsed?.type === "input" && typeof parsed.data === "string") {
          hub.input(streamId, new TextEncoder().encode(parsed.data));
        }
      },
      close() {
        unsubscribe?.();
        hub.closeStream(streamId);
      },
    });
    if (!ok) {
      hub.closeStream(streamId);
      throw new AppError("invalid_request", "Couldn't open the terminal.");
    }
    return new Response(null);
  });

  // ---- Settings (spec 6.3, 6.4, 6.6, 6.8): configure rights; applied on the next deploy.

  app.put("/services/:serviceId/source", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, appSourceRequestSchema);
    return c.json(await saveSource(services, actor, c.req.param("serviceId"), input));
  });

  app.post(
    "/services/:serviceId/source/upload",
    bodyLimit({
      maxSize: UPLOAD_MAX_BYTES,
      onError: () => {
        throw new AppError("payload_too_large", UPLOAD_TOO_LARGE);
      },
    }),
    async (c) => {
      const actor = await workspaceActorFor(c, services);
      const row = await serviceForAction(
        services,
        actor,
        c.req.param("serviceId"),
        "service.configure",
      );
      if (row.kind !== "application")
        throw new AppError("conflict", "Only applications take uploads.");
      const buildPath = normalizeBuildPath(c.req.query("buildPath") ?? "");
      if (typeof buildPath !== "string") throw new AppError("invalid_request", buildPath.problem);
      const declared = Number(c.req.header("content-length") ?? "0");
      if (declared > UPLOAD_MAX_BYTES) throw new AppError("payload_too_large", UPLOAD_TOO_LARGE);
      const fileName =
        (c.req.query("fileName") ?? "upload.zip").replace(/[^\w. -]/g, "").slice(0, 200) ||
        "upload.zip";
      const upload = await storeUpload(db, {
        serviceId: row.id,
        workspaceId: actor.workspace.id,
        personId: actor.personId,
        fileName,
        body: c.req.raw.body,
      });
      const service = await recordUpload(services, actor, row.id, upload, buildPath);
      const deploy =
        c.req.query("deploy") === "1"
          ? await startServiceDeploy(services, actor, row.id, { cleanCache: false })
          : null;
      return c.json(
        {
          service,
          upload,
          deployment: deploy?.deployment ?? null,
          message: deploy
            ? "Archive uploaded. Deployment started"
            : "Archive uploaded. Deploy to use it.",
        },
        201,
      );
    },
  );

  app.put("/services/:serviceId/build", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, buildSettingsRequestSchema);
    return c.json({ service: await saveBuild(services, actor, c.req.param("serviceId"), input) });
  });

  app.put("/services/:serviceId/ports", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, portsRequestSchema);
    return c.json(await savePorts(services, actor, c.req.param("serviceId"), input));
  });

  app.put("/services/:serviceId/mounts", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, mountsRequestSchema);
    return c.json(await saveMounts(services, actor, c.req.param("serviceId"), input));
  });

  // Volumes of other apps in this environment on this server it may mount (31b G2-08).
  app.get("/services/:serviceId/shareable-volumes", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ volumes: await shareableVolumes(services, actor, c.req.param("serviceId")) });
  });

  app.patch("/services/:serviceId/deploy-settings", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, deploySettingsRequestSchema);
    return c.json({
      service: await saveDeploySettings(services, actor, c.req.param("serviceId"), input),
    });
  });

  // ---- The deploy webhook (spec 6.6, G4)

  app.get("/services/:serviceId/webhook", async (c) => {
    const actor = await workspaceActorFor(c, services);
    await actor.access.require("service.see", { kind: "service", id: c.req.param("serviceId") });
    const decision = actor.access.decide(
      "service.deploy",
      await targetFor(actor, c.req.param("serviceId")),
    );
    if (!decision.allowed) {
      return c.json({ visible: false, url: null, message: WEBHOOK_NEEDS_DEPLOY, warnings: [] });
    }
    const row = await serviceForAction(services, actor, c.req.param("serviceId"), "service.deploy");
    return c.json(await webhookView(row));
  });

  app.post("/services/:serviceId/webhook", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await serviceForAction(
      services,
      actor,
      c.req.param("serviceId"),
      "service.configure",
    );
    await actor.access.require("service.deploy", { kind: "service", id: row.id });
    if (row.kind !== "application" && row.kind !== "compose") {
      throw new AppError(
        "conflict",
        "Only applications and Compose services have a deploy webhook.",
      );
    }
    if (row.kind === "application" && readAppSettings(row.settings).source?.type === "upload") {
      throw new AppError("conflict", WEBHOOK_UPLOAD_SOURCE);
    }
    const existed = await currentWebhookToken(services, row.id);
    await replaceWebhookToken(services, row, actor.personId);
    await recordAudit(db, services.log, auditActor(actor), {
      action: existed ? "service.webhook-replaced" : "service.webhook-created",
      workspaceId: actor.workspace.id,
      target: { kind: "service", id: row.id },
      details: {},
    });
    return c.json({
      ...(await webhookView(row)),
      message: existed
        ? "Webhook URL replaced. The old URL stopped working."
        : "Webhook URL created",
    });
  });

  // ---- Databases: connection details and the public port (spec 8.2)

  app.get("/services/:serviceId/connection", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await serviceForAction(services, actor, c.req.param("serviceId"), "service.see");
    return c.json({ connection: await connectionView(row, false) });
  });

  app.post("/services/:serviceId/connection/reveal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await serviceForAction(services, actor, c.req.param("serviceId"), "service.see");
    return c.json({ connection: await connectionView(row, true, actor) });
  });

  app.post("/services/:serviceId/public", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, makePublicRequestSchema);
    const row = await serviceForAction(
      services,
      actor,
      c.req.param("serviceId"),
      "service.configure",
    );
    if (!isDatabaseKind(row.kind))
      throw new AppError("conflict", "Only databases have a public port.");
    let port: number | null = null;
    if (input.public) {
      if (row.public_port !== null) port = row.public_port;
      else {
        port = await db.transaction().execute(async (trx) => {
          const free = await allocatePublicPort(trx, row.server_id);
          if (free === null) return null;
          await trx
            .updateTable("service")
            .set({ public_port: free, public_port_note: null, updated_at: new Date() })
            .where("id", "=", row.id)
            .execute();
          return free;
        });
        if (port === null) throw new AppError("conflict", NO_FREE_PORT_NOTE);
      }
    } else {
      await db
        .updateTable("service")
        .set({ public_port: null, public_port_note: null, updated_at: new Date() })
        .where("id", "=", row.id)
        .execute();
    }
    const deployed = await db
      .selectFrom("deployment")
      .select("id")
      .where("service_id", "=", row.id)
      .where("status", "in", ["active", "not_running"])
      .executeTakeFirst();
    const restart = deployed
      ? await startServiceDeploy(services, actor, row.id, {
          cleanCache: false,
          title: input.public ? "Make public" : "Make private",
        })
      : null;
    await recordAudit(db, services.log, auditActor(actor), {
      action: input.public ? "service.made-public" : "service.made-private",
      workspaceId: actor.workspace.id,
      target: { kind: "service", id: row.id },
      details: { port },
    });
    const updated = await serviceForAction(services, actor, row.id, "service.see");
    return c.json({
      publicPort: port,
      connection: await connectionView(updated, false),
      deployment: restart?.deployment ?? null,
      message: input.public
        ? `Public on port ${port}.${restart ? " The database restarts in the background." : ""}`
        : `Private now.${restart ? " The database restarts in the background." : ""}`,
    });
  });

  return app;

  async function targetFor(actor: WorkspaceActor, serviceId: string) {
    const row = await db
      .selectFrom("service")
      .select(["id", "project_id", "environment_id"])
      .where("id", "=", serviceId)
      .where("workspace_id", "=", actor.workspace.id)
      .executeTakeFirstOrThrow();
    return {
      kind: "service" as const,
      id: row.id,
      projectId: row.project_id,
      environmentId: row.environment_id,
    };
  }

  async function webhookView(row: ServiceRow) {
    const app = readAppSettings(row.settings);
    const current = await currentWebhookToken(services, row.id);
    const warnings: string[] = [];
    const image = row.kind === "application" && app.source?.type === "image";
    // Image apps redeploy when their registry calls the URL (30b R2-03); uploads have nothing
    // to redeploy from.
    if (row.kind === "application" && app.source?.type === "upload") {
      warnings.push(WEBHOOK_UPLOAD_SOURCE);
    }
    if (!app.deploy.autodeploy) warnings.push(WEBHOOK_AUTODEPLOY_OFF);
    const consoleUrl = services.consoleUrl();
    if (
      consoleUrl &&
      /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(
        consoleUrl,
      )
    ) {
      // The words fit who calls it: a registry for an image app, a Git host otherwise (C3-03).
      warnings.push(
        image
          ? `Docker Hub and GitHub's registry can't reach ${new URL(consoleUrl).host}: the console isn't reachable from the internet, so your registry can't call this URL.`
          : `GitHub can't reach ${new URL(consoleUrl).host}: the console isn't reachable from the internet, so pushes can't call this URL.`,
      );
    }
    if (!current?.token) {
      return {
        visible: true,
        url: null,
        message: image ? WEBHOOK_NONE_YET_IMAGE : WEBHOOK_NONE_YET,
        warnings,
        createdAt: null,
        lastCalledAt: null,
      };
    }
    return {
      visible: true,
      url: webhookUrl(services, current.token),
      message: null,
      warnings,
      createdAt: current.createdAt.toISOString(),
      lastCalledAt: current.lastCalledAt?.toISOString() ?? null,
    };
  }

  async function connectionView(row: ServiceRow, reveal: boolean, actor?: WorkspaceActor) {
    if (!isDatabaseKind(row.kind))
      throw new AppError("conflict", "Only databases have connection details.");
    const kind = row.kind as DatabaseKind;
    const settings = readDatabaseSettings(kind, row.settings, row.app_name);
    let password = "";
    if (reveal && actor) {
      const credentials = await revealCredentials(services, actor, row.id);
      password = credentials.password;
    }
    const running = row.status === "running";
    const address = await serverAddress(services, row);
    const base = {
      kind,
      user: kind === "redis" ? "default" : settings.user,
      password,
      database: settings.databaseName,
      replicaSet: settings.replicaSet,
    };
    const build = (host: string, port: number, from: "internal" | "public") => {
      const input = { ...base, host, port, from };
      return reveal ? databaseConnectionUrl(input) : maskedConnectionUrl(input);
    };
    const publicPort = row.public_port;
    return {
      running,
      notice: running ? null : CONNECTION_NOT_RUNNING,
      user: base.user,
      database: settings.databaseName,
      password: reveal ? password : null,
      internal: {
        host: row.app_name,
        port: settings.port ?? DATABASE_DEFAULTS[kind].port,
        url: build(row.app_name, settings.port, "internal"),
        label: "From apps on this server",
      },
      public: {
        enabled: publicPort !== null,
        port: publicPort,
        host: address,
        url: publicPort !== null && address ? build(address, publicPort, "public") : null,
        label: "From anywhere",
        hint:
          publicPort === null
            ? PRIVATE_DATABASE_HINT
            : address
              ? publicPortHint(publicPort)
              : unknownAddressHint(publicPort),
      },
      server: row.server_id === null ? HOST_TARGET : row.server_id,
    };
  }
}

/**
 * The runner's download of an uploaded archive (its own credential, never a person's session):
 * only while a deploy of a service using it builds on that runner's server.
 */
export function runnerUploadRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get("/runner/uploads/:uploadId", async (c) => {
    const header = c.req.header("authorization") ?? "";
    const credential = /^Bearer\s+(\S{10,512})$/i.exec(header)?.[1];
    const runner = credential ? await verifyCredential(services.db, credential) : null;
    if (!runner) throw new AppError("unauthenticated", "This runner's credential isn't accepted.");
    const found = await uploadForRunner(
      services.db,
      c.req.param("uploadId"),
      targetOf(runner.serverId),
    );
    if (!found) throw new AppError("not_found", "There's no such archive for this server.");
    return new Response(found.body, {
      headers: {
        "content-type": "application/zip",
        "content-length": String(found.sizeBytes),
        "cache-control": "no-store",
      },
    });
  });
  return app;
}
