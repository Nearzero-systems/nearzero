import {
  AppError,
  DOCKER_CLEANUP_EVENT,
  DOCKER_CLEANUP_TEXT,
  type DockerCleanupView,
  formatBytes,
  localTime,
  usableTimeZone,
  zonedInstant,
} from "@nearzero/shared";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { DeferJob, defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { HOST_NAME, resolveTarget } from "../servers/targets.ts";
import type { ControlServices } from "../services.ts";
import { firstWorkspaceId } from "../workspaces/workspaces.ts";

/**
 * The daily Docker cleanup (spec 09 9.4, 14.4, 15.3): unused images and build cache are removed
 * at 23:50 in each server's own time zone, by its runner (the `system.prune` command). On by
 * default for the Nearzero host, off for other servers, with a switch on each server's details.
 *
 * One scheduler job ticks every 5 minutes (each tick books the next with an idempotency key, so
 * several processes never double it, spec 23.2). A target whose 23:50 passed less than an hour
 * ago gets one cleanup job per local day, keyed by target and date. Each cleanup that ran writes
 * the "Docker cleanup" notification event (server, space freed) to the notification outbox.
 */

export const CLEANUP_TICK_JOB = "servers.docker-cleanup-tick";
export const CLEANUP_RUN_JOB = "servers.docker-cleanup";
const TICK_MS = 5 * 60_000;
/** A cleanup missed by more than this (Nearzero was stopped) waits for the next day. */
const LATE_WINDOW_MS = 60 * 60_000;
const CLEANUP_HOUR = 23;
const CLEANUP_MINUTE = 50;

export async function targetTimeZone(db: Db, target: string): Promise<string> {
  let query = db.selectFrom("runner").select("system").limit(1);
  query =
    target === HOST_TARGET
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", target);
  const row = await query.executeTakeFirst();
  const zone = (row?.system as { timeZone?: unknown } | null | undefined)?.timeZone;
  return usableTimeZone(typeof zone === "string" ? zone : null);
}

/** Today's 23:50 in the zone (as an instant) and the local date it belongs to. */
export function cleanupTimeOn(nowMs: number, zone: string): { dueMs: number; localDate: string } {
  const local = localTime(nowMs, zone);
  const dueMs = zonedInstant(
    {
      year: local.year,
      month: local.month,
      day: local.day,
      hour: CLEANUP_HOUR,
      minute: CLEANUP_MINUTE,
    },
    zone,
  );
  const localDate = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  return { dueMs, localDate };
}

/** The cleanup to run now, if its time came within the last hour. */
export function dueCleanup(nowMs: number, zone: string): { localDate: string } | null {
  // Today's 23:50, and yesterday's: after midnight the hour that began at 23:50 still runs
  // (it used to be cut to 10 minutes, B1-47).
  for (const at of [nowMs, nowMs - 12 * 3_600_000]) {
    const { dueMs, localDate } = cleanupTimeOn(at, zone);
    if (nowMs >= dueMs && nowMs - dueMs < LATE_WINDOW_MS) return { localDate };
  }
  return null;
}

/** The next 23:50 in the zone after now. */
export function nextCleanupAt(nowMs: number, zone: string): Date {
  const today = cleanupTimeOn(nowMs, zone);
  if (nowMs < today.dueMs) return new Date(today.dueMs);
  return new Date(cleanupTimeOn(today.dueMs + 12 * 3_600_000, zone).dueMs);
}

async function hostEnabled(db: Db): Promise<boolean> {
  const row = await db
    .selectFrom("docker_cleanup")
    .select("enabled")
    .where("target", "=", HOST_TARGET)
    .executeTakeFirst();
  return row?.enabled ?? true;
}

/** Every target whose cleanup is on. */
export async function enabledTargets(db: Db): Promise<string[]> {
  const servers = await db
    .selectFrom("server")
    .select("id")
    .where("docker_cleanup", "=", true)
    .where("setup_state", "=", "ready")
    .execute();
  const targets = servers.map((row) => row.id);
  if (await hostEnabled(db)) targets.unshift(HOST_TARGET);
  return targets;
}

function nextGrid(nowMs: number): Date {
  return new Date(Math.floor(nowMs / TICK_MS) * TICK_MS + TICK_MS);
}

export async function scheduleCleanupTick(db: Db, nowMs = Date.now()): Promise<void> {
  const at = nextGrid(nowMs);
  await new JobQueue(db, { workerId: "scheduler" }).enqueue({
    kind: CLEANUP_TICK_JOB,
    payload: {},
    maxAttempts: 3,
    delayMs: Math.max(0, at.getTime() - nowMs),
    idempotencyKey: `docker-cleanup-tick:${at.toISOString()}`,
  });
}

/** One tick: start the cleanups that are due, then book the next tick. */
export async function cleanupTick(db: Db, nowMs = Date.now()): Promise<number> {
  let started = 0;
  const queue = new JobQueue(db, { workerId: "scheduler" });
  for (const target of await enabledTargets(db)) {
    const due = dueCleanup(nowMs, await targetTimeZone(db, target));
    if (!due) continue;
    const done = await db
      .selectFrom("docker_cleanup")
      .select("last_local_date")
      .where("target", "=", target)
      .executeTakeFirst();
    if (done?.last_local_date === due.localDate) continue;
    const result = await queue.enqueue({
      kind: CLEANUP_RUN_JOB,
      payload: { target, localDate: due.localDate },
      maxAttempts: 3,
      idempotencyKey: `docker-cleanup:${target}:${due.localDate}`,
    });
    if (result.created) started++;
  }
  return started;
}

export const cleanupTickJob = defineJob({
  kind: CLEANUP_TICK_JOB,
  payload: z.object({}),
  maxAttempts: 3,
  lane: "schedule",
  async run(_payload, { db }) {
    try {
      await cleanupTick(db);
    } finally {
      await scheduleCleanupTick(db);
    }
  },
});

async function eventWorkspace(
  db: Db,
  target: string,
): Promise<{ id: string; name: string } | null> {
  if (target === HOST_TARGET) {
    const first = await firstWorkspaceId(db);
    return first ? { id: first, name: HOST_NAME } : null;
  }
  const row = await db
    .selectFrom("server")
    .select(["workspace_id", "name"])
    .where("id", "=", target)
    .executeTakeFirst();
  return row ? { id: row.workspace_id, name: row.name } : null;
}

/** Runs one target's cleanup through its runner and records it. */
export async function runCleanup(
  services: Pick<ControlServices, "db" | "runners">,
  log: Logger,
  target: string,
  localDate: string,
): Promise<{ freedBytes: number }> {
  const { db } = services;
  const result = (await services.runners.command(
    target,
    "system.prune",
    { images: "unused", buildCache: true },
    { timeoutMs: 30 * 60_000 },
  )) as { reclaimedBytes?: number };
  const freedBytes = Math.max(0, Math.round(result.reclaimedBytes ?? 0));
  const now = new Date();
  await db
    .insertInto("docker_cleanup")
    .values({
      target,
      last_local_date: localDate,
      last_at: now,
      last_freed_bytes: freedBytes,
      last_error: null,
    })
    .onConflict((conflict) =>
      conflict.column("target").doUpdateSet({
        last_local_date: localDate,
        last_at: now,
        last_freed_bytes: freedBytes,
        last_error: null,
      }),
    )
    .execute();
  const workspace = await eventWorkspace(db, target);
  if (workspace) {
    try {
      await db
        .insertInto("notification_outbox")
        .values({
          workspace_id: workspace.id,
          event: DOCKER_CLEANUP_EVENT,
          dedupe_key: `docker-cleanup:${target}:${localDate}`,
          payload: JSON.stringify({
            server: { id: target, name: workspace.name },
            freedBytes,
            freedText: formatBytes(freedBytes),
            localDate,
            ranAt: now.toISOString(),
          }),
        })
        .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
        .execute();
    } catch (error) {
      // A lost notification never turns a finished cleanup into a failure.
      log.warn("couldn't record the Docker cleanup notification", { target, error });
    }
  }
  log.info("docker cleanup finished", { target, freedBytes });
  return { freedBytes };
}

export function cleanupRunJob(services: ControlServices) {
  return defineJob({
    kind: CLEANUP_RUN_JOB,
    payload: z.object({
      target: z.string().min(1).max(64),
      localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }),
    maxAttempts: 3,
    lane: "cleanup",
    retryDelayMs: () => 2 * 60_000,
    async run({ target, localDate }, { db, log, job }) {
      // A deploy pulls or builds its image before its container exists: the cleanup waits until
      // no deploy is going on this server, and deploys wait while it runs (31c G3-03).
      const { deployGoingOn } = await import("../deploys/queue.ts");
      if (await deployGoingOn(db, target)) {
        throw new DeferJob(60_000, "a deploy is going on this server");
      }
      try {
        await runCleanup(services, log, target, localDate);
      } catch (error) {
        if (job.attempt >= job.maxAttempts) {
          await db
            .insertInto("docker_cleanup")
            .values({ target, last_at: new Date(), last_error: (error as Error).message })
            .onConflict((conflict) =>
              conflict
                .column("target")
                .doUpdateSet({ last_at: new Date(), last_error: (error as Error).message }),
            )
            .execute();
        }
        throw error;
      }
    },
  });
}

// ---- The switch on a server's details

export async function cleanupView(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<DockerCleanupView> {
  const target = await resolveTarget(services, actor, id, "server.see");
  let enabled: boolean;
  if (target.serverId === null) enabled = await hostEnabled(services.db);
  else {
    const row = await services.db
      .selectFrom("server")
      .select("docker_cleanup")
      .where("id", "=", target.serverId)
      .executeTakeFirstOrThrow();
    enabled = row.docker_cleanup;
  }
  const zone = await targetTimeZone(services.db, target.key);
  const last = await services.db
    .selectFrom("docker_cleanup")
    .select(["last_at", "last_freed_bytes", "last_error"])
    .where("target", "=", target.key)
    .executeTakeFirst();
  return {
    enabled,
    defaultEnabled: target.serverId === null,
    description: DOCKER_CLEANUP_TEXT,
    timeZone: zone,
    nextRunAt: enabled ? nextCleanupAt(Date.now(), zone).toISOString() : null,
    last: last?.last_at
      ? {
          at: last.last_at.toISOString(),
          freedBytes: last.last_freed_bytes,
          freedText: last.last_freed_bytes === null ? null : formatBytes(last.last_freed_bytes),
          error: last.last_error,
        }
      : null,
  };
}

export async function setCleanup(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  enabled: boolean,
): Promise<DockerCleanupView> {
  const target = await resolveTarget(services, actor, id, "server.manage");
  if (target.serverId === null) {
    await services.db
      .insertInto("docker_cleanup")
      .values({ target: HOST_TARGET, enabled })
      .onConflict((conflict) => conflict.column("target").doUpdateSet({ enabled }))
      .execute();
  } else {
    const updated = await services.db
      .updateTable("server")
      .set({ docker_cleanup: enabled, updated_at: new Date() })
      .where("id", "=", target.serverId)
      .where("workspace_id", "=", actor.workspace.id)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) === 0) {
      throw new AppError(
        "not_found",
        "This server doesn't exist in this workspace, or you don't have access to it.",
      );
    }
  }
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "server.docker-cleanup-changed",
    workspaceId: target.serverId ? actor.workspace.id : null,
    target: { kind: target.serverId ? "server" : "host", id: target.key },
    details: { enabled },
  });
  return cleanupView(services, actor, id);
}
