import type { NotificationEvent } from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";

/**
 * Writing notification events (spec 15.3) to the outbox that the dispatcher sends from. Each
 * thing that happened has one dedupe key, so a retried job or a repeated call never writes a
 * second event. Payloads carry names, results and links only: never secrets or variable values.
 */

type Waker = () => void;
let waker: Waker | null = null;

/** The dispatcher of this process registers itself, so a new event goes out at once. */
export function onEventRecorded(wake: Waker | null): void {
  waker = wake;
}

export async function recordEvent(
  db: Db,
  log: Logger,
  event: {
    workspaceId: string;
    event: NotificationEvent;
    dedupeKey: string;
    payload: Record<string, unknown>;
  },
): Promise<boolean> {
  try {
    const row = await db
      .insertInto("notification_outbox")
      .values({
        workspace_id: event.workspaceId,
        event: event.event,
        dedupe_key: event.dedupeKey,
        payload: JSON.stringify(event.payload),
      })
      .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
      .returning("id")
      .executeTakeFirst();
    if (row) waker?.();
    return row !== undefined;
  } catch (error) {
    // A lost notification never turns the work that caused it into a failure.
    log.warn("couldn't record a notification event", { event: event.event, error });
    return false;
  }
}
