import {
  AppError,
  DEPLOYMENT_STATUS_LABELS,
  type DeploymentStatus,
  firstFailureLine,
  isDatabaseKind,
  listDeploymentsQuerySchema,
  startDeployRequestSchema,
} from "@nearzero/shared";
import { Hono } from "hono";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { check, readBody } from "../http/validate.ts";
import { isOurId } from "../projects/objects.ts";
import { hostDeployPrecheck } from "../service-runtime/host-mounts.ts";
import { serviceForAction } from "../service-runtime/runtime.ts";
import type { ControlServices } from "../services.ts";
import { deployBus, readLogPieces, readLogText } from "./log.ts";
import { cancelDeployment, requestDeploy } from "./queue.ts";
import {
  canSeeDeployment,
  DEPLOYMENT_COLUMNS,
  type DeploymentRow,
  deploymentView,
  visibleDeployment,
  visibleServiceIds,
} from "./records.ts";
import { EventQueue, lastEventId, sseResponse } from "./streaming.ts";

/**
 * Deployments (spec 6.2, 6.3, 6.5, 8.2, 11): starting a deploy, the list with search and
 * filters, the detail page, its log (stored text and a live stream that resumes), Cancel and
 * Redeploy, a service's own list, and a live feed of status changes for the list and the bell.
 * docs/api/deploys.md documents each one.
 */

const TAIL_LINES = 500;

export async function startServiceDeploy(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  options: { cleanCache: boolean; trigger?: "manual" | "agent" | "redeploy"; title?: string },
) {
  const row = await serviceForAction(services, actor, serviceId, "service.deploy");
  // The Nearzero host: the workspace must still be allowed there, and an app's bind mounts must
  // be approved for this person (spec 24 G3; B1-07, 30b R2-07).
  await hostDeployPrecheck(services, actor, row);
  if (row.kind === "compose") {
    // A stack with no file, or with options the Nearzero host refuses for this person, is
    // refused before it queues (spec 07 7.3, 24 G3); the deploy checks again with the real file.
    const { composeDeployPrecheck } = await import("../compose-runtime/routes.ts");
    await composeDeployPrecheck(services, actor, row);
  }
  const result = await requestDeploy(services.db, {
    serviceId: row.id,
    workspaceId: actor.workspace.id,
    trigger: options.trigger ?? "manual",
    requestedBy: actor.personId,
    ...(options.title ? { title: options.title } : {}),
    cleanCache: options.cleanCache,
  });
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "service.deploy-requested",
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details: { deploymentId: result.deployment.id, replaced: result.replaced },
  });
  return {
    deployment: deploymentView(result.deployment, actor),
    replaced: result.replaced,
    waiting: result.waiting,
    message: result.kept
      ? "A deploy is already waiting with newer code; it runs next with the saved settings."
      : result.replaced
        ? "A deploy was already waiting; it will use this request instead."
        : result.waiting
          ? "Deployment queued. It starts when the running one ends."
          : "Deployment started",
  };
}

const NOT_A_SERVICE_ID = "That isn't a service's id. Choose the service from the list.";

export function deployRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = services;

  app.post("/services/:serviceId/deployments", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, startDeployRequestSchema);
    const started = await startServiceDeploy(services, actor, c.req.param("serviceId"), {
      cleanCache: input.cleanCache,
      ...(input.redeploy ? { trigger: "redeploy" as const } : {}),
    });
    return c.json(started, 202);
  });

  app.get("/services/:serviceId/deployments", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await serviceForAction(
      services,
      actor,
      c.req.param("serviceId"),
      "service.deployments",
    );
    const rows = await db
      .selectFrom("deployment as d")
      .select(DEPLOYMENT_COLUMNS)
      .where("d.service_id", "=", row.id)
      .orderBy("d.created_at", "desc")
      .limit(50)
      .execute();
    return c.json({ deployments: rows.map((item) => deploymentView(item, actor)) });
  });

  app.get("/deployments", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const query = check(listDeploymentsQuerySchema, c.req.query());
    const visible = await visibleServiceIds(db, actor);
    let base = db.selectFrom("deployment as d").where("d.workspace_id", "=", actor.workspace.id);
    if (visible !== null) {
      if (visible.length === 0) {
        return c.json({ deployments: [], total: 0, page: query.page, pageSize: query.pageSize });
      }
      base = base.where("d.service_id", "in", visible);
    }
    if (query.serviceId) {
      // A malformed id names no service (B1-36): refused before it reaches the uuid column.
      if (!isOurId(query.serviceId)) {
        throw new AppError("invalid_request", NOT_A_SERVICE_ID, {
          fields: { serviceId: NOT_A_SERVICE_ID },
        });
      }
      base = base.where("d.service_id", "=", query.serviceId);
    }
    if (query.status !== "all") base = base.where("d.status", "=", query.status);
    if (query.type === "application" || query.type === "compose") {
      base = base.where("d.service_kind", "=", query.type);
    } else if (query.type === "database") {
      base = base.where("d.service_kind", "not in", ["application", "compose"]);
    }
    if (query.search) {
      const like = `%${query.search.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      base = base.where((eb) =>
        eb.or([
          eb("d.service_name", "ilike", like),
          eb("d.project_name", "ilike", like),
          eb("d.environment_name", "ilike", like),
          eb("d.server_name", "ilike", like),
          eb("d.title", "ilike", like),
          eb("d.commit_hash", "ilike", like),
        ]),
      );
    }
    const total = await base
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    const rows = await base
      .select(DEPLOYMENT_COLUMNS)
      .orderBy("d.created_at", "desc")
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .execute();
    return c.json({
      deployments: rows.map((row) => deploymentView(row, actor)),
      total: Number(total.count),
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  // The bell (spec 11.5): the newest 8 the person can see, and failures since a time.
  app.get("/deployments/recent", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const visible = await visibleServiceIds(db, actor);
    const sinceRaw = c.req.query("since");
    const since =
      sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
        ? new Date(sinceRaw)
        : new Date(Date.now() - 24 * 3_600_000);
    let base = db
      .selectFrom("deployment as d")
      .where("d.workspace_id", "=", actor.workspace.id)
      .where("d.status", "!=", "removed");
    if (visible !== null) {
      if (visible.length === 0) return c.json({ deployments: [], failedSince: 0 });
      base = base.where("d.service_id", "in", visible);
    }
    const rows = await base
      .select(DEPLOYMENT_COLUMNS)
      .orderBy("d.created_at", "desc")
      .limit(8)
      .execute();
    const failed = await base
      .where("d.status", "=", "failed")
      .where("d.finished_at", ">", since)
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    return c.json({
      deployments: rows.map((row) => deploymentView(row, actor)),
      failedSince: Number(failed.count),
    });
  });

  // Live status changes of deployments the person can see (the list and the bell).
  app.get("/deployments/stream", async (c) => {
    const actor = await workspaceActorFor(c, services);
    return sseResponse(c, async (writer, aborted) => {
      const queue = new EventQueue<{ id: string; status: string }>();
      const unsubscribe = deployBus.subscribeAll((id, event) => {
        if (event.type === "status") queue.push({ id, status: event.status });
      });
      try {
        await writer.send("open", {});
        for (;;) {
          const item = await queue.next(aborted, 60_000);
          if (item === "aborted") return;
          if (item === "timeout") continue;
          const row = await db
            .selectFrom("deployment as d")
            .select(DEPLOYMENT_COLUMNS)
            .where("d.id", "=", item.id)
            .where("d.workspace_id", "=", actor.workspace.id)
            .executeTakeFirst();
          if (!row || !canSeeDeployment(actor, row)) continue;
          await writer.send("deployment", { deployment: deploymentView(row, actor) });
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.get("/deployments/:deploymentId", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await visibleDeployment(db, actor, c.req.param("deploymentId"));
    return c.json({ deployment: await detailOf(row, actor) });
  });

  app.get("/deployments/:deploymentId/log", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await visibleDeployment(db, actor, c.req.param("deploymentId"));
    const { text, seq } = await readLogText(db, row.id);
    const all = c.req.query("lines") === "all";
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const shown = all ? lines : lines.slice(-TAIL_LINES);
    const failure = row.status === "failed" ? firstFailureLine(text) : null;
    // A queued or building deployment's log is still being written, so it is never complete:
    // clients follow the live stream from lastEventId (spec 11.2 "Streams while running").
    const running = row.status === "queued" || row.status === "building";
    return c.json({
      text: shown.length ? `${shown.join("\n")}\n` : "",
      totalLines: lines.length,
      shownFrom: lines.length - shown.length + 1,
      complete: !running && shown.length === lines.length,
      truncated: row.log_truncated,
      failure: failure
        ? {
            line: failure.line,
            text: failure.text,
            message: `Failure detected on line ${failure.line}: ${failure.text}`,
          }
        : null,
      lastEventId: `${row.id}:${seq}`,
    });
  });

  // The live log (spec 11.2): stored pieces after Last-Event-ID, then new ones as they come.
  app.get("/deployments/:deploymentId/events", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await visibleDeployment(db, actor, c.req.param("deploymentId"));
    const resume = lastEventId(c);
    let after = resume && resume.id === row.id ? resume.position : 0;
    return sseResponse(c, async (writer, aborted) => {
      const queue = new EventQueue<
        "poke" | { status: string; error: string | null; finished: boolean }
      >();
      const unsubscribe = deployBus.subscribe(row.id, (event) => {
        queue.push(event.type === "log" ? "poke" : event);
      });
      const send = async () => {
        for (;;) {
          const pieces = await readLogPieces(db, row.id, after);
          for (const piece of pieces) {
            await writer.send(
              "log",
              { text: piece.text, seq: piece.seq },
              `${row.id}:${piece.seq}`,
            );
            after = piece.seq;
          }
          if (pieces.length < 2_000) return;
        }
      };
      try {
        await writer.send("open", { deploymentId: row.id, status: row.status });
        await send();
        let status: string = (await currentStatus(row.id)) ?? row.status;
        if (!["queued", "building"].includes(status)) {
          await writer.send("end", {
            status,
            statusLabel: label(status),
            error: await errorOf(row.id),
          });
          return;
        }
        for (;;) {
          const item = await queue.next(aborted, 3_000);
          if (item === "aborted") return;
          await send();
          if (item === "poke") continue;
          // A status change, or a quiet moment: check the stored status (other processes too).
          const now: string | null = item === "timeout" ? await currentStatus(row.id) : item.status;
          if (now && now !== status) {
            status = now;
            await writer.send("status", { status, statusLabel: label(status) });
          }
          if (now && !["queued", "building"].includes(now)) {
            await send();
            await writer.send("end", {
              status: now,
              statusLabel: label(now),
              error: await errorOf(row.id),
            });
            return;
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  app.post("/deployments/:deploymentId/cancel", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await visibleDeployment(db, actor, c.req.param("deploymentId"));
    const view = deploymentView(row, actor);
    if (!view.can.cancel) {
      if (row.status !== "queued" && row.status !== "building") {
        throw new AppError("conflict", "Only queued and building deployments can be cancelled.");
      }
      throw new AppError(
        "forbidden",
        "You can't cancel this deployment: it needs deploy rights on its service.",
      );
    }
    const result = await cancelDeployment(db, row.id);
    await recordAudit(db, services.log, auditActor(actor), {
      action: "deployment.cancelled",
      workspaceId: actor.workspace.id,
      target: { kind: "deployment", id: row.id },
      details: { service: row.service_id },
    });
    return c.json({
      cancelled: result === "cancelled",
      stopping: result === "stopping",
      message:
        result === "cancelled"
          ? "Deployment cancelled"
          : "Cancelling. The build stops within seconds; the running version keeps serving.",
    });
  });

  app.post("/deployments/:deploymentId/redeploy", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await visibleDeployment(db, actor, c.req.param("deploymentId"));
    if (!row.service_id)
      throw new AppError("conflict", "This service was deleted, so it can't be redeployed.");
    if (isDatabaseKind(row.service_kind)) {
      throw new AppError("conflict", "Databases are deployed from their own page.");
    }
    if (row.status === "building")
      throw new AppError("conflict", "This deployment is still building.");
    const started = await startServiceDeploy(services, actor, row.service_id, {
      cleanCache: false,
      trigger: "redeploy",
    });
    return c.json({ ...started, message: "Redeployment queued" }, 202);
  });

  return app;

  async function currentStatus(id: string): Promise<DeploymentStatus | null> {
    const found = await db
      .selectFrom("deployment")
      .select("status")
      .where("id", "=", id)
      .executeTakeFirst();
    return found?.status ?? null;
  }

  async function errorOf(id: string): Promise<string | null> {
    const found = await db
      .selectFrom("deployment")
      .select("error")
      .where("id", "=", id)
      .executeTakeFirst();
    return found?.error ?? null;
  }

  async function detailOf(row: DeploymentRow, actor: WorkspaceActor) {
    const view = deploymentView(row, actor);
    const newer =
      row.service_id && row.status === "previous"
        ? await db
            .selectFrom("deployment")
            .select("id")
            .where("service_id", "=", row.service_id)
            .where("status", "in", ["active", "not_running"])
            .executeTakeFirst()
        : undefined;
    const urls = row.service_id
      ? await db
          .selectFrom("router_route")
          .select(["hostnames", "spec"])
          .where("key", "like", `s-${row.service_id}-%`)
          .execute()
      : [];
    return {
      ...view,
      urls: urls.flatMap((route) => {
        const spec = route.spec as { path?: string; certificate?: string };
        return route.hostnames.map(
          (host) =>
            `${spec.certificate === "none" ? "http" : "https"}://${host}${spec.path && spec.path !== "/" ? spec.path : ""}`,
        );
      }),
      servingNewer: newer ? "Now serving a newer deployment" : null,
      newerDeploymentId: newer?.id ?? null,
    };
  }
}

function label(status: string): string {
  return DEPLOYMENT_STATUS_LABELS[status as DeploymentStatus] ?? status;
}
