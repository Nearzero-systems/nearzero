import { type ChannelValue, isChannelType } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";
import type { ControlServices } from "../services.ts";
import { openSecrets } from "./channels.ts";
import { buildMessage } from "./messages.ts";
import { onEventRecorded } from "./outbox.ts";
import { DeliveryError, deliver } from "./senders.ts";
import { dispatchSettingsOf } from "./transport.ts";

/**
 * Sending the outbox (spec 15.3). Each new event becomes one delivery per channel of its
 * workspace that subscribes to it (unique per event and channel, so it is sent once), then the
 * event is marked delivered (fanned out). Deliveries that are due are claimed with
 * FOR UPDATE SKIP LOCKED and a short lease, so several processes never send one twice. A failed
 * delivery is retried 3 times with back-off; the channel's row shows "Last delivery failed:
 * <reason>" until one succeeds again.
 */

const FAN_OUT_BATCH = 100;
const SEND_BATCH = 20;
const LEASE_SECONDS = 120;
/** Delivered events and finished deliveries are kept this long. */
const KEEP_DAYS = 30;

export interface DispatchResult {
  fannedOut: number;
  sent: number;
  failed: number;
  retrying: number;
}

/** Turns new events into deliveries. */
export async function fanOut(db: Db): Promise<number> {
  return db.transaction().execute(async (trx) => {
    const events = await trx
      .selectFrom("notification_outbox")
      .select(["id", "workspace_id", "event"])
      .where("delivered_at", "is", null)
      .orderBy("id")
      .limit(FAN_OUT_BATCH)
      .forUpdate()
      .skipLocked()
      .execute();
    for (const event of events) {
      const channels = await trx
        .selectFrom("notification_channel")
        .select("id")
        .where("workspace_id", "=", event.workspace_id)
        .where(sql<boolean>`${event.event} = any(events)`)
        .execute();
      if (channels.length > 0) {
        await trx
          .insertInto("notification_delivery")
          .values(channels.map((channel) => ({ outbox_id: event.id, channel_id: channel.id })))
          .onConflict((conflict) => conflict.columns(["outbox_id", "channel_id"]).doNothing())
          .execute();
      }
      await trx
        .updateTable("notification_outbox")
        .set({ delivered_at: sql<Date>`now()` })
        .where("id", "=", event.id)
        .execute();
    }
    return events.length;
  });
}

interface Claimed {
  id: number;
  attempts: number;
  outbox_id: number;
  channel_id: string;
}

async function claimDue(db: Db): Promise<Claimed[]> {
  const rows = await sql<Claimed>`
    update notification_delivery
       set attempts = attempts + 1,
           locked_until = now() + make_interval(secs => ${LEASE_SECONDS})
     where id in (
       select id from notification_delivery
        where status = 'pending'
          and next_attempt_at <= now()
          and (locked_until is null or locked_until < now())
        order by next_attempt_at, id
        limit ${SEND_BATCH}
        for update skip locked)
    returning id, attempts, outbox_id, channel_id`.execute(db);
  return rows.rows;
}

async function workspaceSlug(db: Db, workspaceId: string): Promise<string | null> {
  const row = await db
    .selectFrom("workspace")
    .select("slug")
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  return row?.slug ?? null;
}

async function sendOne(
  services: ControlServices,
  log: Logger,
  claimed: Claimed,
): Promise<"sent" | "failed" | "retrying"> {
  const { db } = services;
  const settings = dispatchSettingsOf(services);
  const maxAttempts = settings.retryDelaysMs.length + 1;
  const channel = await db
    .selectFrom("notification_channel")
    .selectAll()
    .where("id", "=", claimed.channel_id)
    .executeTakeFirst();
  const event = await db
    .selectFrom("notification_outbox")
    .selectAll()
    .where("id", "=", claimed.outbox_id)
    .executeTakeFirst();
  if (!channel || !event || !isChannelType(channel.type)) {
    await db.deleteFrom("notification_delivery").where("id", "=", claimed.id).execute();
    return "failed";
  }
  let reason: string | null = null;
  const opened = openSecrets(services, channel);
  if (!opened.ok) {
    reason = "the channel's secrets can't be read any more; edit it and enter them again";
  } else {
    const message = buildMessage(event.event, (event.payload ?? {}) as Record<string, unknown>, {
      consoleUrl: services.consoleUrl(),
      workspaceSlug: await workspaceSlug(db, event.workspace_id),
      recordedAt: new Date(event.created_at),
    });
    message.data = (event.payload ?? {}) as Record<string, unknown>;
    try {
      await deliver(
        settings.transport,
        channel.type,
        (channel.settings ?? {}) as Record<string, ChannelValue>,
        opened.secrets,
        message,
        { allowInternal: channel.internal_allowed },
      );
    } catch (error) {
      reason = error instanceof DeliveryError ? error.message : "the message couldn't be sent";
    }
  }
  if (reason === null) {
    await db
      .updateTable("notification_delivery")
      .set({ status: "sent", sent_at: sql<Date>`now()`, locked_until: null, last_error: null })
      .where("id", "=", claimed.id)
      .execute();
    await db
      .updateTable("notification_channel")
      .set({ last_delivery_at: sql<Date>`now()`, last_failure: null, last_failure_at: null })
      .where("id", "=", channel.id)
      .execute();
    return "sent";
  }
  const final = claimed.attempts >= maxAttempts;
  const delay = settings.retryDelaysMs[claimed.attempts - 1] ?? 0;
  await db
    .updateTable("notification_delivery")
    .set({
      status: final ? "failed" : "pending",
      locked_until: null,
      last_error: reason.slice(0, 500),
      next_attempt_at: sql<Date>`now() + make_interval(secs => ${delay / 1000})`,
    })
    .where("id", "=", claimed.id)
    .execute();
  await db
    .updateTable("notification_channel")
    .set({ last_failure: reason.slice(0, 500), last_failure_at: sql<Date>`now()` })
    .where("id", "=", channel.id)
    .execute();
  log.info("a notification delivery failed", {
    channelId: channel.id,
    attempt: claimed.attempts,
    final,
    reason,
  });
  return final ? "failed" : "retrying";
}

/** One pass: fan out new events, then send what is due. */
export async function dispatchNotifications(
  services: ControlServices,
  log: Logger = services.log,
): Promise<DispatchResult> {
  const result: DispatchResult = { fannedOut: 0, sent: 0, failed: 0, retrying: 0 };
  for (;;) {
    const count = await fanOut(services.db);
    result.fannedOut += count;
    if (count < FAN_OUT_BATCH) break;
  }
  for (;;) {
    const claimed = await claimDue(services.db);
    if (claimed.length === 0) break;
    const outcomes = await Promise.all(claimed.map((item) => sendOne(services, log, item)));
    for (const outcome of outcomes) result[outcome]++;
    if (claimed.length < SEND_BATCH) break;
  }
  return result;
}

/** Drops old delivered events and finished deliveries. */
export async function pruneNotifications(db: Db): Promise<number> {
  const deliveries = await db
    .deleteFrom("notification_delivery")
    .where("status", "in", ["sent", "failed"])
    .where("created_at", "<", sql<Date>`now() - make_interval(days => ${KEEP_DAYS})`)
    .executeTakeFirst();
  const events = await db
    .deleteFrom("notification_outbox")
    .where("delivered_at", "is not", null)
    .where("delivered_at", "<", sql<Date>`now() - make_interval(days => ${KEEP_DAYS})`)
    .executeTakeFirst();
  return Number(deliveries.numDeletedRows) + Number(events.numDeletedRows);
}

export interface Dispatcher {
  /** Runs a pass soon (a new event was recorded in this process). */
  wake(): void;
  stop(): Promise<void>;
}

/** The dispatcher loop of this process: a pass every 2 seconds, and at once after a new event. */
export function startNotificationDispatcher(
  services: ControlServices,
  intervalMs = 2_000,
): Dispatcher {
  const log = services.log.child({ component: "notifications" });
  let running: Promise<void> | null = null;
  let again = false;
  let stopped = false;
  let lastPrune = 0;
  const pass = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      try {
        await dispatchNotifications(services, log);
        if (Date.now() - lastPrune > 6 * 3_600_000) {
          lastPrune = Date.now();
          await pruneNotifications(services.db);
        }
      } catch (error) {
        log.warn("notification dispatch failed", { error });
      }
    })().finally(() => {
      running = null;
      if (again) {
        again = false;
        queueMicrotask(pass);
      }
    });
  };
  const timer = setInterval(pass, intervalMs);
  timer.unref?.();
  onEventRecorded(pass);
  queueMicrotask(pass);
  return {
    wake: pass,
    async stop() {
      stopped = true;
      clearInterval(timer);
      onEventRecorded(null);
      await running;
    },
  };
}
