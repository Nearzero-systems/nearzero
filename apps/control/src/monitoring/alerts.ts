import {
  ALERT_METRICS,
  ALERT_STALE_MS,
  type AlertMetric,
  type AlertSettingsRequest,
  type AlertState,
  AppError,
  INITIAL_ALERT_STATE,
  type MetricsSample,
  MONITORING_MESSAGES,
  memoryPercent,
  stepAlert,
  thresholdProblem,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import type { Logger } from "../log.ts";
import { recordEvent } from "../notifications/outbox.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { HOST_NAME, resolveTarget } from "../servers/targets.ts";
import type { ControlServices } from "../services.ts";
import { firstWorkspaceId } from "../workspaces/workspaces.ts";
// The table types this area adds to the database type.
import type {} from "./tables.ts";

/**
 * Server alerts (spec 14.3, 24 P2): CPU and memory thresholds per server, off when blank. Each
 * sample the runner reports moves the alert's state (monitoring-rules.ts `stepAlert`): 3 samples
 * in a row above the threshold fire one "Server alert" event, then none for 30 minutes unless
 * the value drops and rises again. Samples older than 5 minutes when they arrive (a runner's
 * backlog after a reconnect) are stored but never fire.
 */

export interface AlertSettingsView {
  target: string;
  cpuThreshold: number | null;
  memoryThreshold: number | null;
  canEdit: boolean;
  /** Channels of the server's workspace that subscribe to "Server alert". */
  channels: number;
}

/** The workspace a target's events go to: the server's, or the first (for the host). */
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

async function subscribedChannels(db: Db, workspaceId: string): Promise<number> {
  const row = await db
    .selectFrom("notification_channel")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`'server.alert' = any(events)`)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

export async function alertSettings(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<AlertSettingsView> {
  const target = await resolveTarget(services, actor, id, "server.see");
  const row = await services.db
    .selectFrom("server_alert_setting")
    .selectAll()
    .where("target", "=", target.key)
    .executeTakeFirst();
  const workspace = await eventWorkspace(services.db, target.key);
  const canEdit =
    target.serverId === null
      ? actor.isInstanceAdmin
      : actor.access.can("server.manage", { kind: "server", id: target.key });
  return {
    target: target.key,
    cpuThreshold: row?.cpu_threshold ?? null,
    memoryThreshold: row?.memory_threshold ?? null,
    canEdit,
    channels: workspace ? await subscribedChannels(services.db, workspace.id) : 0,
  };
}

export async function updateAlertSettings(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  request: AlertSettingsRequest,
): Promise<AlertSettingsView> {
  const target = await resolveTarget(services, actor, id, "server.manage");
  const fields: Record<string, string> = {};
  const cpu = thresholdProblem(request.cpuThreshold);
  if (cpu) fields.cpuThreshold = cpu;
  const memory = thresholdProblem(request.memoryThreshold);
  if (memory) fields.memoryThreshold = memory;
  const first = Object.values(fields)[0];
  if (first) throw new AppError("invalid_request", first, { fields });
  await services.db
    .insertInto("server_alert_setting")
    .values({
      target: target.key,
      cpu_threshold: request.cpuThreshold,
      memory_threshold: request.memoryThreshold,
      updated_by: actor.personId,
    })
    .onConflict((conflict) =>
      conflict.column("target").doUpdateSet({
        cpu_threshold: request.cpuThreshold,
        memory_threshold: request.memoryThreshold,
        updated_by: actor.personId,
        updated_at: new Date(),
      }),
    )
    .execute();
  // A changed threshold starts its count again.
  await services.db.deleteFrom("server_alert_state").where("target", "=", target.key).execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "server.alerts-changed",
    workspaceId: target.serverId ? actor.workspace.id : null,
    target: { kind: target.serverId ? "server" : "host", id: target.key },
    details: { cpuThreshold: request.cpuThreshold, memoryThreshold: request.memoryThreshold },
  });
  return alertSettings(services, actor, id);
}

/** "Send a test alert": a Server alert event marked as a test, to the subscribed channels. */
export async function sendTestAlert(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<{ channels: number; message: string }> {
  const target = await resolveTarget(services, actor, id, "server.manage");
  const workspace = await eventWorkspace(services.db, target.key);
  if (!workspace) throw new AppError("not_found", "This server doesn't exist any more.");
  const channels = await subscribedChannels(services.db, workspace.id);
  if (channels === 0) return { channels, message: MONITORING_MESSAGES.noChannels };
  const settings = await services.db
    .selectFrom("server_alert_setting")
    .selectAll()
    .where("target", "=", target.key)
    .executeTakeFirst();
  await recordEvent(services.db, services.log, {
    workspaceId: workspace.id,
    event: "server.alert",
    dedupeKey: `server-alert-test:${target.key}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`,
    payload: {
      server: { id: target.key, name: workspace.name },
      metric: "cpu",
      value: settings?.cpu_threshold ?? 90,
      threshold: settings?.cpu_threshold ?? 90,
      at: new Date().toISOString(),
      test: true,
    },
  });
  return {
    channels,
    message: `${MONITORING_MESSAGES.testSent} to ${channels === 1 ? "1 channel" : `${channels} channels`}.`,
  };
}

function metricValue(metric: AlertMetric, sample: MetricsSample): number {
  return metric === "cpu"
    ? sample.cpuPercent
    : memoryPercent(sample.memoryUsedBytes, sample.memoryTotalBytes);
}

/**
 * Applies a runner's new samples to the target's alerts and writes an event for each alert that
 * fires. Called by the runner hub for every metrics message.
 */
export async function evaluateAlerts(
  db: Db,
  log: Logger,
  target: string,
  samples: readonly MetricsSample[],
  now = Date.now(),
): Promise<number> {
  const settings = await db
    .selectFrom("server_alert_setting")
    .selectAll()
    .where("target", "=", target)
    .executeTakeFirst();
  if (!settings || (settings.cpu_threshold === null && settings.memory_threshold === null))
    return 0;
  const fresh = samples
    .filter((sample) => now - sample.at <= ALERT_STALE_MS)
    .sort((a, b) => a.at - b.at);
  if (fresh.length === 0) return 0;
  const fires: { metric: AlertMetric; value: number; threshold: number; at: number }[] = [];
  await db.transaction().execute(async (trx) => {
    for (const metric of ALERT_METRICS) {
      const threshold = metric === "cpu" ? settings.cpu_threshold : settings.memory_threshold;
      if (threshold === null) continue;
      const row = await trx
        .selectFrom("server_alert_state")
        .selectAll()
        .where("target", "=", target)
        .where("metric", "=", metric)
        .forUpdate()
        .executeTakeFirst();
      let state: AlertState = row
        ? {
            streak: row.streak,
            firedAt: row.fired_at ? row.fired_at.getTime() : null,
            droppedSince: row.dropped_since,
          }
        : { ...INITIAL_ALERT_STATE };
      const lastAt = row?.last_sample_at?.getTime() ?? 0;
      let lastValue = row?.last_value ?? null;
      let lastSampleAt = lastAt;
      for (const sample of fresh) {
        if (sample.at <= lastAt) continue;
        const value = metricValue(metric, sample);
        const stepped = stepAlert(state, value, threshold, sample.at);
        state = stepped.state;
        lastValue = value;
        lastSampleAt = sample.at;
        if (stepped.fire) fires.push({ metric, value, threshold, at: sample.at });
      }
      const values = {
        streak: state.streak,
        fired_at: state.firedAt === null ? null : new Date(state.firedAt),
        dropped_since: state.droppedSince,
        last_value: lastValue,
        last_sample_at: lastSampleAt ? new Date(lastSampleAt) : null,
      };
      await trx
        .insertInto("server_alert_state")
        .values({ target, metric, ...values })
        .onConflict((conflict) => conflict.columns(["target", "metric"]).doUpdateSet(values))
        .execute();
    }
  });
  if (fires.length === 0) return 0;
  const workspace = await eventWorkspace(db, target);
  if (!workspace) return 0;
  for (const fire of fires) {
    await recordEvent(db, log, {
      workspaceId: workspace.id,
      event: "server.alert",
      dedupeKey: `server-alert:${target}:${fire.metric}:${fire.at}`,
      payload: {
        server: { id: target, name: workspace.name },
        metric: fire.metric,
        value: Math.round(fire.value * 10) / 10,
        threshold: fire.threshold,
        at: new Date(fire.at).toISOString(),
        test: false,
      },
    });
  }
  log.info("server alert fired", { target, alerts: fires.map((fire) => fire.metric) });
  return fires.length;
}
