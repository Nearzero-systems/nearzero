import type { AgentEventMap, AgentEventType } from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import { EventQueue, type SseWriter } from "../deploys/streaming.ts";
import type { Logger } from "../log.ts";
import "./tables.ts";

/**
 * A turn's events (docs/api/agent.md): every event is written to agent_event the moment it
 * happens, then handed to followers in this process. Followers in other processes, or of a turn
 * carried out by another process, read new rows from the table, so nothing depends on which
 * process serves the stream (ARCHITECTURE.md, Live updates).
 */

export interface StoredEvent {
  turnId: string;
  seq: number;
  type: AgentEventType;
  data: Record<string, unknown>;
}

type Listener = (event: StoredEvent | "closed") => void;

class AgentBus {
  readonly #listeners = new Map<string, Set<Listener>>();

  subscribe(turnId: string, listener: Listener): () => void {
    let set = this.#listeners.get(turnId);
    if (!set) {
      set = new Set();
      this.#listeners.set(turnId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(turnId);
    };
  }

  publish(turnId: string, event: StoredEvent | "closed"): void {
    for (const listener of this.#listeners.get(turnId) ?? []) {
      try {
        listener(event);
      } catch {
        // A follower that went away must not stop the turn.
      }
    }
  }
}

export const agentBus = new AgentBus();

const writers = new Map<string, Promise<TurnEvents>>();

/**
 * Writes one turn's events in order. Text deltas are gathered for a few milliseconds so a long
 * answer is tens of rows, not thousands; any other event flushes them first. One writer per turn
 * per process ({@link TurnEvents.open} hands out the same one), and a number taken meanwhile by
 * another process is skipped, so every event gets its own place in order.
 */
export class TurnEvents {
  #seq: number;
  #chain: Promise<unknown> = Promise.resolve();
  #text = "";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #failed = false;

  private constructor(
    private readonly db: Db,
    private readonly log: Logger,
    readonly turnId: string,
    lastSeq: number,
    private readonly flushMs: number,
  ) {
    this.#seq = lastSeq;
  }

  static open(db: Db, log: Logger, turnId: string, flushMs: number): Promise<TurnEvents> {
    const known = writers.get(turnId);
    if (known) return known;
    const made = TurnEvents.#maxSeq(db, turnId).then(
      (seq) => new TurnEvents(db, log, turnId, seq, flushMs),
    );
    writers.set(turnId, made);
    made.catch(() => writers.delete(turnId));
    return made;
  }

  /** Forgets the writer once the turn is closed. */
  static release(turnId: string): void {
    writers.delete(turnId);
  }

  static async #maxSeq(db: Db, turnId: string): Promise<number> {
    const row = await db
      .selectFrom("agent_event")
      .select((eb) => eb.fn.max("seq").as("seq"))
      .where("turn_id", "=", turnId)
      .executeTakeFirst();
    return Number(row?.seq ?? 0);
  }

  get lastSeq(): number {
    return this.#seq;
  }

  emit<K extends AgentEventType>(type: K, data: AgentEventMap[K] & Record<string, unknown>) {
    this.#flushText();
    return this.#write(type, data);
  }

  text(delta: string): void {
    if (delta === "") return;
    this.#text += delta;
    if (!this.#timer) this.#timer = setTimeout(() => this.#flushText(), this.flushMs);
  }

  /**
   * A guided flow's words (spec 19.7), saved apart from the model's so a viewer of a shared chat
   * gets them only as its author's (C1-15): `first` marks the first piece of each reply.
   */
  guidedText(delta: string, first: boolean): void {
    if (delta === "") return;
    this.#flushText();
    void this.#write("text", { delta, guided: true, first });
  }

  /** Resolves once everything handed over so far is saved. */
  async settle(): Promise<void> {
    this.#flushText();
    await this.#chain;
  }

  #flushText(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#text === "") return;
    const delta = this.#text;
    this.#text = "";
    void this.#write("text", { delta });
  }

  #write(type: AgentEventType, data: Record<string, unknown>): Promise<StoredEvent> {
    const written = this.#chain.then(async () => {
      const insert = (seq: number) =>
        this.db
          .insertInto("agent_event")
          .values({ turn_id: this.turnId, seq, type, data: JSON.stringify(data) })
          .execute();
      let seq = ++this.#seq;
      try {
        await insert(seq);
      } catch (error) {
        try {
          if ((error as { code?: string }).code !== "23505") throw error;
          this.#seq = Math.max(this.#seq, await TurnEvents.#maxSeq(this.db, this.turnId));
          seq = ++this.#seq;
          await insert(seq);
        } catch (inner) {
          if (!this.#failed) this.log.error("couldn't save an Agent event", { type, error: inner });
          this.#failed = true;
        }
      }
      const event: StoredEvent = { turnId: this.turnId, seq, type, data };
      agentBus.publish(this.turnId, event);
      return event;
    });
    this.#chain = written;
    return written;
  }
}

export async function readEvents(db: Db, turnId: string, afterSeq = 0): Promise<StoredEvent[]> {
  const rows = await db
    .selectFrom("agent_event")
    .select(["seq", "type", "data"])
    .where("turn_id", "=", turnId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .execute();
  return rows.map((row) => ({
    turnId,
    seq: row.seq,
    type: row.type as AgentEventType,
    data: row.data as Record<string, unknown>,
  }));
}

export function eventId(turnId: string, seq: number): string {
  return `${turnId}:${seq}`;
}

/** A transform per viewer: drops internal fields and what the viewer may not see (G6). */
export type EventView = (event: StoredEvent) => Record<string, unknown>;

/**
 * Sends a turn's saved events after `afterSeq`, then the live ones, then `end` once the turn is
 * closed. Works for turns run by any process: when nothing arrives for a moment it reads the
 * table again.
 */
export async function followTurn(
  db: Db,
  turnId: string,
  afterSeq: number,
  writer: SseWriter,
  aborted: Promise<void>,
  view: EventView,
  pollMs: () => number,
): Promise<void> {
  const queue = new EventQueue<StoredEvent | "closed">();
  const unsubscribe = agentBus.subscribe(turnId, (event) => queue.push(event));
  let sent = afterSeq;
  const send = async (event: StoredEvent) => {
    if (event.seq <= sent) return;
    sent = event.seq;
    await writer.send(event.type, view(event), eventId(turnId, event.seq));
  };
  const catchUp = async (): Promise<boolean> => {
    for (const event of await readEvents(db, turnId, sent)) await send(event);
    const row = await db
      .selectFrom("agent_turn")
      .select(["closed_at"])
      .where("id", "=", turnId)
      .executeTakeFirst();
    return !row || row.closed_at !== null;
  };
  try {
    if (await catchUp()) {
      await writer.send("end", {});
      return;
    }
    for (;;) {
      const next = await queue.next(aborted, pollMs());
      if (next === "aborted") return;
      if (next === "timeout" || next === "closed") {
        if (await catchUp()) {
          await writer.send("end", {});
          return;
        }
        continue;
      }
      if (next.seq > sent + 1) {
        // Something written meanwhile hasn't reached this process's bus: read it first.
        for (const event of await readEvents(db, turnId, sent)) {
          if (event.seq < next.seq) await send(event);
        }
      }
      await send(next);
    }
  } finally {
    unsubscribe();
  }
}
