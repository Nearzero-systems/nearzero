import type { Db } from "../db/database.ts";
import { redact } from "./parse.ts";

/**
 * A setup run's live log (spec 09 9.3 "Setup logs · live", 23.8): lines stored in order, cleaned
 * of secrets first, and a bus that tells the dialogs following the run about each new line and
 * every change of state. Viewers resume after the last line they saw (Last-Event-ID), so a
 * dropped connection never loses or repeats a line. One control plane runs per install, so the
 * bus lives in this process, like the deploy log's.
 */

export type SetupEvent =
  | { type: "log"; runId: string; seq: number; text: string }
  | { type: "run"; runId: string };

type Listener = (event: SetupEvent) => void;

class SetupBus {
  readonly #listeners = new Map<string, Set<Listener>>();

  /** Events for one server's runs. */
  subscribe(serverId: string, listener: Listener): () => void {
    let set = this.#listeners.get(serverId);
    if (!set) {
      set = new Set();
      this.#listeners.set(serverId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.#listeners.delete(serverId);
    };
  }

  emit(serverId: string, event: SetupEvent): void {
    for (const listener of [...(this.#listeners.get(serverId) ?? [])]) {
      try {
        listener(event);
      } catch {
        // One viewer's failure never stops the others.
      }
    }
  }
}

export const setupBus = new SetupBus();

const FLUSH_MS = 150;
/** A run keeps at most this many lines; later output is summarized. */
const MAX_LINES = 20_000;
const MAX_LINE_LENGTH = 4_000;

export class SetupLog {
  readonly runId: string;
  readonly serverId: string;
  readonly #db: Db;
  readonly #secrets: string[] = [];
  #seq: number;
  #pending: { seq: number; text: string }[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  #capped = false;
  /** Called after each write, so the run's last activity moves. */
  onWrite: (() => void) | null = null;

  constructor(db: Db, runId: string, serverId: string, seq: number) {
    this.#db = db;
    this.runId = runId;
    this.serverId = serverId;
    this.#seq = seq;
  }

  get seq(): number {
    return this.#seq;
  }

  /** Values never to show (a join token); they are cut out of every later line. */
  addSecret(value: string): void {
    if (value.length >= 6) this.#secrets.push(value);
  }

  clean(text: string): string {
    return redact(text, this.#secrets);
  }

  line(text: string): void {
    for (const piece of this.clean(text).replace(/\r/g, "").split("\n")) {
      if (this.#seq >= MAX_LINES) {
        if (!this.#capped) {
          this.#capped = true;
          this.#push("… This log keeps its first 20,000 lines; later output isn't stored.");
        }
        return;
      }
      this.#push(piece.length > MAX_LINE_LENGTH ? `${piece.slice(0, MAX_LINE_LENGTH)}…` : piece);
    }
  }

  #push(text: string): void {
    const seq = ++this.#seq;
    this.#pending.push({ seq, text });
    if (!this.#timer) {
      this.#timer = setTimeout(() => {
        this.#timer = null;
        void this.flush();
      }, FLUSH_MS);
    }
  }

  /** Writes what is pending; resolves once everything written so far is stored. */
  flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const rows = this.#pending;
    this.#pending = [];
    if (rows.length > 0) {
      const last = rows[rows.length - 1]?.seq ?? this.#seq;
      this.#writing = this.#writing.then(async () => {
        try {
          await this.#db
            .insertInto("server_setup_log")
            .values(rows.map((row) => ({ run_id: this.runId, seq: row.seq, text: row.text })))
            .onConflict((conflict) => conflict.columns(["run_id", "seq"]).doNothing())
            .execute();
          await this.#db
            .updateTable("server_setup_run")
            .set({ log_seq: last, last_activity_at: new Date() })
            .where("id", "=", this.runId)
            .execute();
          for (const row of rows) {
            setupBus.emit(this.serverId, {
              type: "log",
              runId: this.runId,
              seq: row.seq,
              text: row.text,
            });
          }
          this.onWrite?.();
        } catch {
          // The server (and its runs) may have been deleted meanwhile.
        }
      });
    }
    return this.#writing;
  }
}

/** Stored lines after `afterSeq`, oldest first. */
export async function readSetupLog(
  db: Db,
  runId: string,
  afterSeq = 0,
  limit = 5_000,
): Promise<{ seq: number; text: string }[]> {
  return db
    .selectFrom("server_setup_log")
    .select(["seq", "text"])
    .where("run_id", "=", runId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .limit(limit)
    .execute();
}
