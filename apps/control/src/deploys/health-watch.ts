import { NEARZERO_LABELS } from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import { silentLogger } from "../log.ts";
import { emitDeployEvent } from "../notifications/emit.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { requestDeploy } from "./queue.ts";

/**
 * Apps that turn unhealthy after their deploy (31b G2-06; spec 06 6.5, 23.1). Docker only reports
 * a failing health check; nothing restarts the container. Once a minute this looks at what every
 * server's runner last reported: an app's live container that stays "unhealthy" for a minute is
 * replaced with a fresh one by a Reload, whose log says why. One that keeps failing (three
 * replacements within an hour) is left running and reported instead, as a failed deployment on
 * the service's page and in the "Deploy failed" notification, never restarted forever in silence.
 */

export const HEALTH_WATCH_JOB = "deploys.health-watch";
export const HEALTH_RELOAD_TITLE = "Health check failing: replaced with a fresh container";
export const HEALTH_REPORT_TITLE = "Health check still failing after replacements";
export const HEALTH_RELOAD_LINE =
  "The running container kept failing its health check, so Nearzero replaces it with a fresh one.";

/** How the watch decides; tests shorten them. */
export const healthWatch = {
  /** How long a container must stay unhealthy before it is replaced. */
  graceMs: 60_000,
  /** Replacements within this window that count toward giving up. */
  windowMs: 60 * 60_000,
  maxReplacements: 3,
  everyMs: 60_000,
};

/** When each container was first seen unhealthy (one control plane per install). */
const unhealthySince = new Map<string, number>();

/** Docker's status words for a container failing its health check: "Up 2 hours (unhealthy)". */
export function reportsUnhealthy(status: string): boolean {
  return /\(unhealthy\)/i.test(status);
}

export async function watchHealth(
  services: Pick<ControlServices, "db" | "runners">,
  now = Date.now(),
): Promise<{ replaced: string[]; reported: string[] }> {
  const { db } = services;
  const live = await db
    .selectFrom("service as s")
    .innerJoin("deployment as d", "d.service_id", "s.id")
    .select(["s.id", "s.workspace_id", "s.server_id", "s.name", "d.id as deployment_id"])
    .where("s.kind", "=", "application")
    .where("s.deleting_run_id", "is", null)
    .where("d.status", "=", "active")
    .execute();
  const replaced: string[] = [];
  const reported: string[] = [];
  const seen = new Set<string>();
  for (const service of live) {
    const state = services.runners.state(service.server_id ?? HOST_TARGET);
    const container = state?.containers.find(
      (item) =>
        item.labels[NEARZERO_LABELS.service] === service.id &&
        item.labels[NEARZERO_LABELS.deployment] === service.deployment_id,
    );
    if (!container || !reportsUnhealthy(container.status)) continue;
    seen.add(container.id);
    const since = unhealthySince.get(container.id) ?? now;
    unhealthySince.set(container.id, since);
    if (now - since < healthWatch.graceMs) continue;
    // A deploy already on its way replaces it anyway.
    const open = await db
      .selectFrom("deployment")
      .select("id")
      .where("service_id", "=", service.id)
      .where("status", "in", ["queued", "building"])
      .executeTakeFirst();
    if (open) continue;
    const window = new Date(now - healthWatch.windowMs);
    const recent = await db
      .selectFrom("deployment")
      .select(["title", "status", "created_at"])
      .where("service_id", "=", service.id)
      .where("title", "in", [HEALTH_RELOAD_TITLE, HEALTH_REPORT_TITLE])
      .where("created_at", ">", window)
      .execute();
    const replacements = recent.filter((row) => row.title === HEALTH_RELOAD_TITLE).length;
    if (replacements < healthWatch.maxReplacements) {
      await requestDeploy(db, {
        serviceId: service.id,
        workspaceId: service.workspace_id,
        trigger: "reload",
        requestedBy: null,
        title: HEALTH_RELOAD_TITLE,
      });
      unhealthySince.delete(container.id);
      replaced.push(service.id);
      continue;
    }
    // Given up: said once, until the container changes or the window passes.
    if (recent.some((row) => row.title === HEALTH_REPORT_TITLE)) continue;
    // Recorded as a failed deployment, never run: the service's page and "Deploy failed" say so.
    const report = await db
      .insertInto("deployment")
      .columns([
        "workspace_id",
        "service_id",
        "project_id",
        "environment_id",
        "service_kind",
        "service_name",
        "app_name",
        "project_name",
        "environment_name",
        "server_id",
        "server_name",
        "trigger",
        "title",
        "status",
        "error",
        "builds",
        "finished_at",
      ])
      .expression((eb) =>
        eb
          .selectFrom("deployment")
          .select([
            "workspace_id",
            "service_id",
            "project_id",
            "environment_id",
            "service_kind",
            "service_name",
            "app_name",
            "project_name",
            "environment_name",
            "server_id",
            "server_name",
            sql<string>`'reload'`.as("trigger"),
            sql<string>`${HEALTH_REPORT_TITLE}`.as("title"),
            sql<string>`'failed'`.as("status"),
            sql<string>`${`${service.name} keeps failing its health check: Nearzero replaced its container ${replacements} times in the last hour, and the new one failed too. It is left running as it is. Check its runtime logs, fix the app or its health check, then deploy again.`}`.as(
              "error",
            ),
            sql<boolean>`false`.as("builds"),
            sql<Date>`now()`.as("finished_at"),
          ])
          .where("id", "=", service.deployment_id),
      )
      .returning("id")
      .executeTakeFirst();
    if (report) await emitDeployEvent(db, silentLogger, report.id).catch(() => {});
    reported.push(service.id);
  }
  // Containers that recovered or went away start over.
  for (const id of unhealthySince.keys()) if (!seen.has(id)) unhealthySince.delete(id);
  return { replaced, reported };
}

export function healthWatchJob(services: ControlServices) {
  return defineJob({
    kind: HEALTH_WATCH_JOB,
    payload: z.object({}),
    maxAttempts: 2,
    lane: "schedule",
    async run(_payload, { db, log }) {
      try {
        const result = await watchHealth(services);
        if (result.replaced.length > 0 || result.reported.length > 0) {
          log.info("health watch", result);
        }
      } finally {
        await scheduleHealthWatch(db, healthWatch.everyMs);
      }
    },
  });
}

export async function scheduleHealthWatch(db: Db, delayMs = 0): Promise<void> {
  const due = new Date(Date.now() + delayMs);
  await new JobQueue(db, { workerId: "scheduler" }).enqueue({
    kind: HEALTH_WATCH_JOB,
    payload: {},
    maxAttempts: 2,
    delayMs,
    idempotencyKey: `health-watch:${due.toISOString().slice(0, 16)}`,
  });
}
