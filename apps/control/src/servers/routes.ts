import {
  AppError,
  createServerRequestSchema,
  hostAllowanceRequestSchema,
  isManagedRouterFile,
  ROUTER_FILE_MAX_BYTES,
  ROUTER_FILE_MESSAGES,
  ROUTER_MAIN_SETTINGS,
  RUNNER_CLOSE,
  routerFileNameProblem,
  routeSpecSchema,
  runnerMoveTarget,
  SERVER_READINESS,
  type ServerReadiness,
  updateServerRequestSchema,
} from "@nearzero/shared";
import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import { isOurId } from "../projects/objects.ts";
import { checkRouterFile, describeRouterFileProblem } from "../routing/router-file-check.ts";
import { listRoutes, removeRoute, upsertRoute } from "../routing/routes.ts";
import { createJoinToken, revokeRunner } from "../runners/credentials.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { joinArguments } from "../runners/link.ts";
import {
  METRIC_POINTS,
  type MetricPoints,
  metricsAnswer,
  readMetrics,
} from "../runners/metrics.ts";
import { hostRunnerView } from "../runners/records.ts";
import type { StreamEvent } from "../runners/streams.ts";
import { loadServerAccess } from "../server-setup/connection.ts";
import { queueRunnerUninstall, startServerRemoval } from "../server-setup/removal.ts";
import type { ControlServices } from "../services.ts";
import { hostView, listHostAllowances, setHostAllowance } from "./host.ts";
import {
  createServer,
  deleteServer,
  getServer,
  listServers,
  loadView,
  updateServer,
} from "./servers.ts";
import { sshTerminal } from "./ssh-terminal.ts";
import { reachableContainer, resolveRouteTarget, resolveTarget, type Target } from "./targets.ts";

/**
 * Servers, the Nearzero host, and what runs on them (spec 09, 14.2, 22.2, 22.4): records, the
 * runner's status, metrics, containers, live logs (server-sent events), terminals (WebSocket),
 * router files, and the internal route endpoints. docs/api/servers.md documents each one.
 */

/** Streams send a keep-alive at least this often (spec 23.2). */
const KEEP_ALIVE_MS = 15_000;

function readiness(value: string | undefined): ServerReadiness | undefined {
  if (value === undefined || value === "" || value === "all") return undefined;
  if ((SERVER_READINESS as readonly string[]).includes(value)) return value as ServerReadiness;
  throw new AppError("invalid_request", `Filter by one of: ${SERVER_READINESS.join(", ")}.`);
}

function points(value: string | undefined): MetricPoints {
  const wanted = value ?? "50";
  if ((METRIC_POINTS as readonly string[]).includes(wanted)) return wanted as MetricPoints;
  throw new AppError("invalid_request", "Choose 50, 200, 500 or all data points.");
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

/** Parses an SSE Last-Event-ID of the form <stream id>:<offset>. */
function lastEventId(c: Context<AppEnv>): { streamId: string; offset: number } | null {
  const value = c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? "";
  const match = /^([0-9a-f-]{36}):(\d{1,15})$/.exec(value);
  return match ? { streamId: match[1] as string, offset: Number(match[2]) } : null;
}

/** The shell a terminal starts: bash when the image has it, sh otherwise. */
const TERMINAL_SHELL = [
  "/bin/sh",
  "-c",
  "if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi",
];

const routerFileRequestSchema = z.object({ contents: z.string().max(ROUTER_FILE_MAX_BYTES) });

/** Saving router files: the host's instance administrators, or the server's managers. */
function canEditRouterFiles(actor: WorkspaceActor, target: Target): boolean {
  if (!target.serverId) return true;
  return actor.access.can("server.manage", { kind: "server", id: target.serverId });
}

export function serverRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const hub = services.runners;

  // ---- Deploy targets and the Nearzero host

  app.get("/servers/targets", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const servers = await listServers(services, actor);
    const targets: { id: string; name: string; readiness: string; host: boolean }[] = [];
    if (actor.access.can("host.use")) {
      const runner = await hostRunnerView(services);
      targets.push({
        id: HOST_TARGET,
        name: "Nearzero host",
        readiness: runner.state === "online" ? "ready" : "inactive",
        host: true,
      });
    }
    for (const server of servers) {
      targets.push({ id: server.id, name: server.name, readiness: server.readiness, host: false });
    }
    return c.json({ targets });
  });

  app.get("/host", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ host: await hostView(services, actor) });
  });

  app.get("/host/allowed-workspaces", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return c.json({ workspaces: await listHostAllowances(services, actor) });
  });

  app.put("/host/allowed-workspaces/:workspaceId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, hostAllowanceRequestSchema);
    await setHostAllowance(services, actor, c.req.param("workspaceId"), input.allowed);
    return c.json({ workspaces: await listHostAllowances(services, actor) });
  });

  // ---- Server records

  app.get("/servers", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const search = c.req.query("q");
    const status = readiness(c.req.query("status"));
    const servers = await listServers(services, actor, {
      ...(search === undefined ? {} : { search }),
      ...(status === undefined ? {} : { readiness: status }),
    });
    return c.json({ servers });
  });

  app.post("/servers", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, createServerRequestSchema);
    return c.json({ server: await createServer(services, actor, input) }, 201);
  });

  app.get("/servers/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = c.req.param("id");
    if (id === HOST_TARGET) return c.json({ host: await hostView(services, actor) });
    return c.json({ server: await getServer(services, actor, id) });
  });

  app.patch("/servers/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, updateServerRequestSchema);
    return c.json(await updateServer(services, actor, c.req.param("id"), input));
  });

  /**
   * Deletes a server (spec 9.6). One with services needs ?deleteServices=true (the dialog's
   * "Also delete all attached services on this server"): the services are torn down first, in the
   * background, and the answer is the removal to follow (202). Either way the runner's service
   * and credential are then removed from the server over SSH when it can be reached.
   */
  app.delete("/servers/:id", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const id = c.req.param("id");
    // ?deleteServices=true, or the delete form's JSON body with the ticked checkbox.
    let withServices = c.req.query("deleteServices") === "true";
    if (!withServices && /^application\/json\b/i.test(c.req.header("content-type") ?? "")) {
      const body = (await c.req.json().catch(() => null)) as { deleteServices?: unknown } | null;
      withServices = [true, "true", "on"].includes(body?.deleteServices as never);
    }
    if (withServices && id !== HOST_TARGET) {
      await actor.access.require("server.manage", { kind: "server", id });
      const view = await loadView(services, actor.workspace.id, id);
      if (view.services > 0) {
        const removal = await startServerRemoval(services, actor, id);
        return c.json({ deleted: false, removal, message: removal.message }, 202);
      }
    }
    // A malformed id is simply not found (B1-36): it never reaches the uuid column.
    const access =
      id === HOST_TARGET || !isOurId(id) ? null : await loadServerAccess(services.db, id);
    await deleteServer(services, actor, id, async (serverId) => {
      hub.disconnect(serverId, RUNNER_CLOSE.revoked, "server deleted");
      await services.db.deleteFrom("docker_cleanup").where("target", "=", serverId).execute();
      if (access) await queueRunnerUninstall(services.db, access);
    });
    return c.json({ deleted: true, message: "Server deleted" });
  });

  /**
   * A one-time join command for the server (spec 25 D1 option C): run on the server, it trades
   * the token for the runner's own credential. Issuing one again later is how the credential is
   * rotated.
   */
  app.post("/servers/:id/join-command", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.manage");
    const { token, expiresAt } = await createJoinToken(services.db, target.serverId, {
      createdBy: actor.personId,
    });
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "runner.join-token-issued",
      workspaceId: target.serverId ? actor.workspace.id : null,
      target: { kind: target.serverId ? "server" : "host", id: target.key },
    });
    // Only an encrypted address, with the fingerprint of Nearzero's own certificate when there
    // is no domain (spec 31 "Remote runners are always encrypted").
    const link = await services.runnerLink();
    const url = link && runnerMoveTarget.safeParse(link).success ? link : null;
    c.header("cache-control", "no-store");
    return c.json({
      token,
      expiresAt: expiresAt.toISOString(),
      controlUrl: url?.url ?? null,
      controlFingerprint: url?.fingerprint ?? null,
      // The token isn't part of the command: it asks for it, so the token stays out of process
      // lists, the shell's history and sudo's log (B2-16).
      command: url ? `sudo nearzero-runner join ${joinArguments(url)}` : null,
      note: url
        ? "Run it on the server within an hour, and paste the join token when it asks. The token works once."
        : "This Nearzero has no encrypted address servers can reach yet, so a join command can't be built. Run the install command again on the Nearzero host to give it a public IP address or a domain.",
    });
  });

  app.post("/servers/:id/runner/revoke", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.manage");
    await revokeRunner(services.db, target.serverId);
    hub.disconnect(target.key, RUNNER_CLOSE.revoked, "revoked");
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "runner.revoked",
      workspaceId: target.serverId ? actor.workspace.id : null,
      target: { kind: target.serverId ? "server" : "host", id: target.key },
    });
    return c.json({ revoked: true });
  });

  // ---- Runner status and metrics (spec 14.2)

  app.get("/servers/:id/runner", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.see");
    if (target.serverId === null) return c.json({ runner: await hostRunnerView(services) });
    const view = await loadView(services, actor.workspace.id, target.serverId);
    return c.json({ runner: view.runner, readiness: view.readiness });
  });

  app.get("/servers/:id/metrics", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.see");
    const samples = await readMetrics(services.db, target.key, points(c.req.query("points")));
    const view =
      target.serverId === null
        ? { name: "The Nearzero host", runner: await hostRunnerView(services) }
        : await loadView(services, actor.workspace.id, target.serverId);
    // A server that stopped reporting gets its samples as history only (30c R3-33).
    return c.json(metricsAnswer(view.name, view.runner, samples, services.now()));
  });

  // ---- Containers, logs and terminals (spec 22.4 rules 2 and 4)

  app.get("/servers/:id/containers", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.manage");
    const list = (await hub.command(target.key, "container.list", { all: true })) as {
      id: string;
      name: string;
      image: string;
      state: string;
      status: string;
      labels: Record<string, string>;
      createdAt: number;
    }[];
    const containers = list
      .filter((item) => !item.labels["dev.nearzero.component"])
      .map((item) => ({
        id: item.id,
        name: item.name,
        image: item.image,
        state: item.state,
        status: item.status,
        serviceId: item.labels["dev.nearzero.service"] ?? null,
        createdAt: new Date(item.createdAt * 1000).toISOString(),
      }));
    return c.json({ containers });
  });

  app.get("/servers/:id/containers/:container/logs", async (c) => {
    const actor = await workspaceActorFor(c, services);
    // Access first: nothing is sent before it is checked (spec 22.4, rule 2).
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.manage");
    const container = await reachableContainer(services, target, c.req.param("container"));
    const tail = intQuery(c, "tail", 200, 0, 10_000);
    const timestamps = c.req.query("timestamps") === "1";
    const resume = lastEventId(c);
    const existing = resume ? hub.stream(resume.streamId) : null;
    const reuse = existing && existing.target === target.key && existing.kind === "container.logs";
    const stream = reuse
      ? existing
      : (
          await hub.openStream(target.key, "container.logs", {
            id: container.id,
            follow: true,
            tail: resume ? 0 : tail,
            timestamps,
          })
        ).stream;
    return followStream(c, stream, reuse && resume ? resume.offset : 0, () => {});
  });

  app.get("/servers/:id/containers/:container/terminal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.manage");
    const container = await reachableContainer(services, target, c.req.param("container"));
    const upgrade = c.env?.upgrade;
    if (!upgrade || c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new AppError("invalid_request", "Open the terminal with a WebSocket.");
    }
    const cols = intQuery(c, "cols", 80, 1, 1000);
    const rows = intQuery(c, "rows", 24, 1, 1000);
    const opened = await hub.openStream(target.key, "container.exec", {
      id: container.id,
      command: TERMINAL_SHELL,
      tty: true,
      cols,
      rows,
    });
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "terminal.opened",
      workspaceId: target.serverId ? actor.workspace.id : null,
      target: { kind: "container", id: container.id },
      details: { server: target.key, container: container.name },
    });
    return openTerminal(c, upgrade, opened.stream.id, target);
  });

  // The server card's Terminal (spec 9.1, 22.3): an SSH shell on the server itself, for people
  // who may manage it. Rights are checked and the audit entry written before the socket opens.
  app.get("/servers/:id/terminal", async (c) => {
    const actor = await workspaceActorFor(c, services);
    if (c.req.param("id") === HOST_TARGET) {
      throw new AppError(
        "invalid_request",
        "The Nearzero host has no SSH terminal in the console. Sign in to it with SSH from your own computer.",
      );
    }
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.manage");
    const upgrade = c.env?.upgrade;
    if (!upgrade || c.req.header("upgrade")?.toLowerCase() !== "websocket") {
      throw new AppError("invalid_request", "Open the terminal with a WebSocket.");
    }
    const access = await loadServerAccess(services.db, target.key);
    if (!access) throw new AppError("not_found", "This server doesn't exist.");
    const size = { cols: intQuery(c, "cols", 80, 1, 1000), rows: intQuery(c, "rows", 24, 1, 1000) };
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "terminal.opened",
      workspaceId: actor.workspace.id,
      target: { kind: "server", id: access.id },
      details: { ssh: true, user: access.user },
    });
    if (!upgrade(c.req.raw, sshTerminal(services, access, size, c.get("log")))) {
      throw new AppError("invalid_request", `Couldn't open the terminal on ${target.name}.`);
    }
    return new Response(null);
  });

  // ---- Router files and routes (spec 9.1 Router files; spec 10)

  // Settings → Router files (spec 18.3): reading needs "See router files" on the server (the
  // host: instance administrators); saving also needs the server's manage rights. Each file says
  // whether it is the runner's own (read-only) and whether this person may edit it.
  app.get("/servers/:id/router-files", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.router-files");
    const result = (await hub.command(target.key, "router.files", {})) as {
      files: { name: string; contents: string }[];
      /** R3-23: the router's main settings as text; absent from older runners. */
      mainSettings?: string | null;
    };
    const canEdit = canEditRouterFiles(actor, target);
    return c.json({
      canEdit,
      files: result.files.map((file) => {
        const managed = isManagedRouterFile(file.name);
        return {
          ...file,
          managed,
          editable: canEdit && routerFileNameProblem(file.name) === null,
        };
      }),
      // Read-only for everyone: Nearzero sets them when it starts the router (R3-23).
      mainSettings:
        typeof result.mainSettings === "string"
          ? {
              name: ROUTER_MAIN_SETTINGS.name,
              title: ROUTER_MAIN_SETTINGS.title,
              contents: result.mainSettings,
              note: ROUTER_MAIN_SETTINGS.note,
              managed: true,
              editable: false,
            }
          : null,
    });
  });

  app.put("/servers/:id/router-files/:name", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveTarget(services, actor, c.req.param("id"), "server.router-files");
    if (!canEditRouterFiles(actor, target)) {
      await actor.access.require("server.manage", { kind: "server", id: target.key });
    }
    const name = c.req.param("name");
    const nameProblem = routerFileNameProblem(name);
    if (nameProblem)
      throw new AppError("invalid_request", nameProblem, { fields: { name: nameProblem } });
    const input = await readBody(c, routerFileRequestSchema);
    const problem = checkRouterFile(input.contents);
    if (problem) {
      const message = describeRouterFileProblem(problem);
      throw new AppError("invalid_request", message, { fields: { contents: message } });
    }
    const saved = (await hub.command(target.key, "router.file-write", {
      name,
      contents: input.contents,
    })) as { name: string; contents: string };
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: "router-file.saved",
      workspaceId: target.serverId ? actor.workspace.id : null,
      target: { kind: target.serverId ? "server" : "host", id: target.key },
      details: { file: name, bytes: new TextEncoder().encode(input.contents).length },
    });
    return c.json({
      file: { ...saved, managed: false, editable: true },
      message: ROUTER_FILE_MESSAGES.saved,
    });
  });

  app.get("/servers/:id/routes", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveRouteTarget(services, actor, c.req.param("id"));
    const state = hub.state(target.key);
    return c.json({
      routes: await listRoutes(services, target.key),
      held: state?.router.held ?? [],
    });
  });

  app.put("/servers/:id/routes/:key", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveRouteTarget(services, actor, c.req.param("id"));
    const input = await readBody(c, routeSpecSchema.omit({ key: true }));
    const route = await upsertRoute(services, target.key, { ...input, key: c.req.param("key") });
    return c.json({ route });
  });

  app.delete("/servers/:id/routes/:key", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const target = await resolveRouteTarget(services, actor, c.req.param("id"));
    const removed = await removeRoute(services, target.key, c.req.param("key"));
    if (!removed) throw new AppError("not_found", "There's no route with that key on this server.");
    return c.json({ removed: true });
  });

  return app;

  /** Sends a hub stream to the browser as server-sent events, resumable by Last-Event-ID. */
  function followStream(
    c: Context<AppEnv>,
    stream: NonNullable<ReturnType<typeof hub.stream>>,
    fromOffset: number,
    onEnd: () => void,
  ) {
    return streamSSE(c, async (sse) => {
      const decoder = new TextDecoder();
      const queue: StreamEvent[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const unsubscribe = stream.subscribe((event) => {
        queue.push(event);
        wake?.();
      }, fromOffset);
      sse.onAbort(() => {
        finished = true;
        wake?.();
      });
      const keepAlive = setInterval(() => {
        void sse.write(": keep-alive\n\n").catch(() => {});
      }, KEEP_ALIVE_MS);
      try {
        await sse.writeSSE({ event: "open", data: JSON.stringify({ streamId: stream.id }) });
        while (!finished) {
          const event = queue.shift();
          if (!event) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
            wake = null;
            continue;
          }
          if (event.type === "output") {
            await sse.writeSSE({
              id: `${stream.id}:${event.end}`,
              event: "output",
              data: JSON.stringify({
                text: decoder.decode(event.bytes, { stream: true }),
                offset: event.offset,
              }),
            });
          } else if (event.type === "gap") {
            await sse.writeSSE({
              event: "gap",
              data: JSON.stringify({
                ...event,
                message: "Some output was lost while the server was unreachable.",
              }),
            });
          } else if (event.type === "link") {
            await sse.writeSSE({
              event: "status",
              data: JSON.stringify({
                connected: event.connected,
                message: event.connected
                  ? "The server is back; the log continues."
                  : "Lost the server for a moment; the log continues when it is back.",
              }),
            });
          } else {
            await sse.writeSSE({
              id: `${stream.id}:${event.offset}`,
              event: "end",
              data: JSON.stringify({ exitCode: event.exitCode, error: event.error }),
            });
            finished = true;
          }
        }
      } finally {
        clearInterval(keepAlive);
        unsubscribe();
        onEnd();
      }
    });
  }

  function openTerminal(
    c: Context<AppEnv>,
    upgrade: NonNullable<AppEnv["Bindings"]["upgrade"]>,
    streamId: string,
    target: Target,
  ) {
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
          else if (event.type === "link")
            socket.send(JSON.stringify({ type: "status", connected: event.connected }));
          else if (event.type === "end") {
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
          const cols = Math.min(1000, Math.max(1, parsed.cols as number));
          const rows = Math.min(1000, Math.max(1, parsed.rows as number));
          hub.resize(streamId, cols, rows);
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
      throw new AppError("invalid_request", `Couldn't open the terminal on ${target.name}.`);
    }
    return new Response(null);
  }
}
