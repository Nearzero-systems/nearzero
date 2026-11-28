import {
  ACCESS_LOG_KEEP_LINES,
  ANALYTICS_MESSAGES,
  ANALYTICS_PAGE_SIZE,
  ANALYTICS_RANGES,
  type AnalyticsRange,
  type AnalyticsSettingsRequest,
  AppError,
  describeTaskSchedule,
  nextRunAfter,
  pageRangeText,
  parseCron,
  rangeWindow,
  STATUS_CLASSES,
  type StatusClass,
  summarize,
} from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { serverTimeZone } from "../backups/schedules.ts";
import type { Db } from "../db/database.ts";
import { consoleHostname } from "../domains/addresses.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import type { Logger } from "../log.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { reasonOf } from "../service-runtime/server-ops.ts";
import type { ControlServices } from "../services.ts";
import { readerFor } from "./reader.ts";
// The table types this area adds to the database type.
import type {} from "./tables.ts";

/**
 * Analytics (spec 13): the requests the Nearzero host's router handled, for every workspace, so
 * for instance administrators only (G8). Recording is on by default; turning it on or off
 * recreates the router in the background; a cleanup schedule keeps the newest 10,000 requests;
 * "Delete all request logs" empties the log and is audited. Requests to apps on other servers
 * are not counted yet.
 */

export const CLEANUP_JOB = "analytics.cleanup";

export interface AnalyticsSettings {
  enabled: boolean;
  cleanupCron: string;
  cleanupText: string;
  timeZone: string;
  nextCleanupAt: string | null;
  lastCleanupAt: string | null;
  lastCleanupError: string | null;
  appliedAt: string | null;
  applyError: string | null;
}

async function settingsRow(db: Db) {
  const row = await db.selectFrom("analytics_setting").selectAll().executeTakeFirst();
  if (row) return row;
  await db
    .insertInto("analytics_setting")
    .values({ enabled: true })
    .onConflict((c) => c.column("id").doNothing())
    .execute();
  return db.selectFrom("analytics_setting").selectAll().executeTakeFirstOrThrow();
}

async function settingsView(db: Db): Promise<AnalyticsSettings> {
  const row = await settingsRow(db);
  const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);
  return {
    enabled: row.enabled,
    cleanupCron: row.cleanup_cron,
    cleanupText: describeTaskSchedule(row.cleanup_cron),
    timeZone: await serverTimeZone(db, null),
    nextCleanupAt: iso(row.next_cleanup_at),
    lastCleanupAt: iso(row.last_cleanup_at),
    lastCleanupError: row.last_cleanup_error,
    appliedAt: iso(row.applied_at),
    applyError: row.apply_error,
  };
}

export const analyticsQuerySchema = z.object({
  range: z.enum(ANALYTICS_RANGES).default("24h"),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  q: z.string().trim().max(500).optional(),
  status: z
    .string()
    .max(40)
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter((item): item is StatusClass =>
          (STATUS_CLASSES as readonly string[]).includes(item),
        ),
    ),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  sort: z.enum(["time-desc", "time-asc"]).default("time-desc"),
});
export type AnalyticsQuery = z.input<typeof analyticsQuerySchema>;

export async function requireAnalytics(actor: WorkspaceActor): Promise<void> {
  await actor.access.require("analytics.see");
}

/** The page: recording state, stats, chart, busiest hosts and one page of the table. */
export async function analyticsPage(
  services: ControlServices,
  actor: WorkspaceActor,
  input: AnalyticsQuery,
) {
  await requireAnalytics(actor);
  const parsed = analyticsQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("invalid_request", "Check the filters and try again.");
  }
  const query = parsed.data;
  const now = Date.now();
  const custom =
    query.range === "custom" && query.from && query.to
      ? { from: Date.parse(query.from), to: Date.parse(query.to) }
      : undefined;
  if (custom && !(custom.to > custom.from)) {
    throw new AppError("invalid_request", "The end of the range must come after its start.", {
      fields: { to: "The end of the range must come after its start." },
    });
  }
  const window = rangeWindow(query.range as AnalyticsRange, now, custom);
  const settings = await settingsView(services.db);
  const reader = readerFor(HOST_TARGET);
  let readError: string | null = null;
  if (services.runners.isOnline(HOST_TARGET)) {
    try {
      await reader.sync(services.runners);
    } catch (error) {
      readError = reasonOf(error);
    }
  } else {
    readError = ANALYTICS_MESSAGES.runnerAway;
  }
  // The console's own requests are never counted (spec 13.1, R3-26).
  const consoleHost = await consoleHostname(services);
  const summary = summarize(reader.entries(), {
    from: window.from,
    to: window.to,
    ...(query.q ? { search: query.q } : {}),
    statuses: query.status,
    excludeHosts: consoleHost ? [consoleHost.toLowerCase()] : [],
  });
  const ordered = query.sort === "time-asc" ? [...summary.entries].reverse() : summary.entries;
  const total = ordered.length;
  const pages = Math.max(1, Math.ceil(total / ANALYTICS_PAGE_SIZE));
  const page = Math.min(query.page, pages);
  const rows = ordered.slice((page - 1) * ANALYTICS_PAGE_SIZE, page * ANALYTICS_PAGE_SIZE);
  return {
    recording: {
      enabled: settings.enabled,
      message: settings.enabled ? ANALYTICS_MESSAGES.recording : ANALYTICS_MESSAGES.off,
      runnerOnline: services.runners.isOnline(HOST_TARGET),
    },
    settings,
    window: {
      range: query.range,
      from: new Date(window.from).toISOString(),
      to: new Date(window.to).toISOString(),
    },
    stats: summary.stats,
    chart: summary.chart,
    hosts: summary.hosts,
    table: {
      entries: rows.map((entry) => ({
        id: entry.id,
        at: new Date(entry.at).toISOString(),
        method: entry.method,
        host: entry.host,
        path: entry.path,
        status: entry.status,
        durationMs: entry.durationMs,
        client: entry.client,
        fields: entry.fields,
      })),
      page,
      pages,
      pageSize: ANALYTICS_PAGE_SIZE,
      total,
      rangeText: pageRangeText(page, ANALYTICS_PAGE_SIZE, total),
      sort: query.sort,
    },
    source: { sizeBytes: reader.sizeBytes, limited: reader.limited, error: readError },
    note: ANALYTICS_MESSAGES.otherServers,
  };
}

export async function analyticsSettings(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<AnalyticsSettings> {
  await requireAnalytics(actor);
  return settingsView(services.db);
}

/** Tells the host's runner whether its router logs requests. */
export async function applyLogging(services: ControlServices, enabled: boolean): Promise<boolean> {
  if (!services.runners.isOnline(HOST_TARGET)) return false;
  try {
    await services.runners.command(
      HOST_TARGET,
      "access-log.configure",
      { enabled },
      { timeoutMs: 30_000 },
    );
    await services.db
      .updateTable("analytics_setting")
      .set({ applied_at: sql<Date>`now()`, apply_error: null })
      .execute();
    return true;
  } catch (error) {
    await services.db
      .updateTable("analytics_setting")
      .set({ apply_error: reasonOf(error) })
      .execute();
    return false;
  }
}

/** When the host's runner connects it gets the setting (that is how "on by default" applies). */
export async function onHostRunnerReady(services: ControlServices): Promise<void> {
  const row = await settingsRow(services.db);
  await applyLogging(services, row.enabled);
  await scheduleCleanup(services.db).catch(() => {});
}

export async function updateAnalyticsSettings(
  services: ControlServices,
  actor: WorkspaceActor,
  request: AnalyticsSettingsRequest,
): Promise<{ settings: AnalyticsSettings; message: string }> {
  await requireAnalytics(actor);
  const row = await settingsRow(services.db);
  let message = ANALYTICS_MESSAGES.cleanupSaved as string;
  if (request.cleanupCron !== undefined) {
    const parsed = parseCron(request.cleanupCron);
    if (!parsed.ok) {
      throw new AppError("invalid_request", parsed.message, {
        fields: { cleanupCron: parsed.message },
      });
    }
    await services.db
      .updateTable("analytics_setting")
      .set({ cleanup_cron: parsed.cron.expression })
      .execute();
    await scheduleCleanup(services.db);
  }
  if (request.enabled !== undefined && request.enabled !== row.enabled) {
    await services.db
      .updateTable("analytics_setting")
      .set({
        enabled: request.enabled,
        changed_by: actor.personId,
        changed_at: sql<Date>`now()`,
        applied_at: null,
      })
      .execute();
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: request.enabled ? "analytics.logging-on" : "analytics.logging-off",
      workspaceId: null,
      target: { kind: "host", id: HOST_TARGET },
    });
    // The router restarts in the background (spec 13.1); the runner answers at once.
    void applyLogging(services, request.enabled);
    message = request.enabled ? ANALYTICS_MESSAGES.turnedOn : ANALYTICS_MESSAGES.turnedOff;
  }
  return { settings: await settingsView(services.db), message };
}

/** "Delete all request logs" (spec 13.1): audited. */
export async function deleteAllRequests(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<{ message: string }> {
  await requireAnalytics(actor);
  if (!services.runners.isOnline(HOST_TARGET))
    throw new AppError("unavailable", ANALYTICS_MESSAGES.runnerAway);
  await services.runners.command(HOST_TARGET, "access-log.clear", {}, { timeoutMs: 60_000 });
  readerFor(HOST_TARGET).reset();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "analytics.request-logs-deleted",
    workspaceId: null,
    target: { kind: "host", id: HOST_TARGET },
  });
  return { message: ANALYTICS_MESSAGES.deleted };
}

// ---- The cleanup schedule

/** Books the next cleanup at the cron's next time in the host's zone. */
export async function scheduleCleanup(db: Db, now = Date.now()): Promise<Date | null> {
  const row = await settingsRow(db);
  const parsed = parseCron(row.cleanup_cron);
  if (!parsed.ok) return null;
  const zone = await serverTimeZone(db, null);
  const nextMs = nextRunAfter(parsed.cron, now, zone);
  if (nextMs === null) return null;
  const next = new Date(nextMs);
  await db.updateTable("analytics_setting").set({ next_cleanup_at: next }).execute();
  await new JobQueue(db, { workerId: "analytics" }).enqueue({
    kind: CLEANUP_JOB,
    payload: { dueAt: next.toISOString() },
    maxAttempts: 3,
    delayMs: Math.max(0, nextMs - now),
    idempotencyKey: `${CLEANUP_JOB}:${next.toISOString()}`,
  });
  return next;
}

export async function runCleanup(
  services: ControlServices,
  log: Logger,
  dueAt: string,
): Promise<void> {
  const row = await settingsRow(services.db);
  // A schedule changed since this job was booked: the newer booking does the work.
  if (!row.next_cleanup_at || new Date(row.next_cleanup_at).toISOString() !== dueAt) return;
  try {
    const result = (await services.runners.command(
      HOST_TARGET,
      "access-log.trim",
      { keepLines: ACCESS_LOG_KEEP_LINES },
      { timeoutMs: 5 * 60_000 },
    )) as { kept: number; removedBytes: number };
    readerFor(HOST_TARGET).reset();
    await services.db
      .updateTable("analytics_setting")
      .set({ last_cleanup_at: sql<Date>`now()`, last_cleanup_error: null })
      .execute();
    log.info("request log cleaned up", result);
  } catch (error) {
    await services.db
      .updateTable("analytics_setting")
      .set({ last_cleanup_at: sql<Date>`now()`, last_cleanup_error: reasonOf(error) })
      .execute();
  } finally {
    await scheduleCleanup(services.db, Math.max(Date.now(), Date.parse(dueAt)));
  }
}

export function cleanupJob(services: ControlServices) {
  return defineJob({
    kind: CLEANUP_JOB,
    payload: z.object({ dueAt: z.string().datetime() }),
    maxAttempts: 3,
    lane: "schedule",
    async run({ dueAt }, { log }) {
      await runCleanup(services, log, dueAt);
    },
  });
}
