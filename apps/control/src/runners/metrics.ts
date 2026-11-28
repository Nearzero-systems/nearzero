import { type MetricsReporting, type MetricsSample, reportingState } from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";

/**
 * Stored server metrics (spec 14.1, 14.2): the runner reports a sample every 5 seconds, kept for
 * 2 days unless the install sets NEARZERO_METRICS_RETENTION_DAYS (spec 03 3.5). Charts read the
 * newest 50, 200 or 500 samples, or all of them.
 */

export const METRICS_RETENTION_DAYS = 2;
export const METRIC_POINTS = ["50", "200", "500", "all"] as const;
export type MetricPoints = (typeof METRIC_POINTS)[number];

export async function readMetrics(
  db: Db,
  target: string,
  points: MetricPoints,
): Promise<MetricsSample[]> {
  let query = db
    .selectFrom("server_metric")
    .selectAll()
    .where("target", "=", target)
    .orderBy("at", "desc");
  if (points !== "all") query = query.limit(Number(points));
  const rows = await query.execute();
  return rows.reverse().map((row) => ({
    at: row.at.getTime(),
    cpuPercent: row.cpu_percent,
    memoryUsedBytes: Number(row.memory_used_bytes),
    memoryTotalBytes: Number(row.memory_total_bytes),
    diskUsedBytes: Number(row.disk_used_bytes),
    diskTotalBytes: Number(row.disk_total_bytes),
    uptimeSeconds: Number(row.uptime_seconds),
    // Older runners' samples have none, and show used / total (30c R3-34).
    ...(row.disk_available_bytes === null
      ? {}
      : { diskAvailableBytes: Number(row.disk_available_bytes) }),
  }));
}

/**
 * A metrics answer (GET /servers/:id/metrics): the samples as history, and the newest one as
 * `latest` only while the server is reporting. Once its runner has been gone for over a minute,
 * `latest` is null and `reporting` says so, with when the last sample was taken, so nothing
 * shows an old sample as the server's current state (30c R3-33).
 */
export function metricsAnswer<System>(
  name: string,
  runner: { state: string; lastSeenAt: string | null; system: System },
  samples: MetricsSample[],
  now: number,
): {
  samples: MetricsSample[];
  system: System;
  latest: MetricsSample | null;
  reporting: MetricsReporting;
} {
  const newest = samples.at(-1) ?? null;
  const reporting = reportingState({
    name,
    online: runner.state === "online",
    lastSeenAt: runner.lastSeenAt ? Date.parse(runner.lastSeenAt) : null,
    lastSampleAt: newest?.at ?? null,
    now,
  });
  return {
    samples,
    system: runner.system,
    latest: reporting.current ? newest : null,
    reporting,
  };
}

/** Deletes samples past the retention, then schedules itself for the next hour. */
export const pruneServerMetrics = defineJob({
  kind: "runners.prune-server-metrics",
  payload: z.object({ olderThanDays: z.number().int().min(1).max(365) }),
  maxAttempts: 3,
  lane: "schedule",
  async run({ olderThanDays }, { db, log }) {
    try {
      const result = await db
        .deleteFrom("server_metric")
        .where("at", "<", sql<Date>`now() - make_interval(days => ${olderThanDays}::integer)`)
        .executeTakeFirst();
      log.info("pruned server metrics", { deleted: Number(result.numDeletedRows) });
    } finally {
      // The next hour is booked even when this one failed, so the chain never breaks (B1-13).
      await scheduleMetricsPruning(db, 60 * 60_000, olderThanDays);
    }
  },
});

export async function scheduleMetricsPruning(
  db: Db,
  delayMs = 0,
  retentionDays: number = METRICS_RETENTION_DAYS,
): Promise<void> {
  const due = new Date(Date.now() + delayMs);
  const hour = due.toISOString().slice(0, 13);
  await new JobQueue(db, { workerId: "scheduler" }).add(
    pruneServerMetrics,
    { olderThanDays: retentionDays },
    { delayMs, idempotencyKey: `prune-server-metrics:${hour}` },
  );
}
