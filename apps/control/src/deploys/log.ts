import type { Db } from "../db/database.ts";

/**
 * A deployment's log (spec 6.5, 11.2, 23.1): pieces of text stored in order as they are written
 * (from the pipeline itself and from the runner's fetch, build and container output), and a bus
 * that tells live viewers about each new piece and every status change. Viewers resume after
 * the last piece they saw, so a dropped connection never loses or repeats a line.
 *
 * Output from the runner is capped per deployment (a runaway build can't fill the database),
 * keeping its beginning and its end (31b G2-02): once the first 1 MB is stored, later output is
 * stored in whole lines and the oldest of it is dropped to keep the last 4 MB, with one line where
 * the middle was left out saying how much. A build's error at the end is therefore always kept.
 * The pipeline's own lines are always kept.
 */

export const LOG_OUTPUT_CAP_BYTES = 5 * 1024 * 1024;
/** The beginning of the output always kept, and the end kept after it (5 MB in all). */
export const LOG_HEAD_BYTES = 1024 * 1024;
export const LOG_TAIL_BYTES = LOG_OUTPUT_CAP_BYTES - LOG_HEAD_BYTES;
const FLUSH_MS = 200;
const PIECE_BYTES = 64 * 1024;

function sizeWords(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** The line standing where the middle of a long log was left out. */
export function leftOutLine(bytes: number, lines: number): string {
  if (bytes === 0) {
    return "… This log keeps the first 1 MB and the last 4 MB of output; anything in between is left out here.\n";
  }
  return `… ${sizeWords(bytes)} of output (${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}) from the middle of this log ${lines === 1 ? "was" : "were"} left out here. The first 1 MB is above and the last 4 MB below.\n`;
}

interface DroppablePiece {
  seq: number;
  bytes: number;
  lines: number;
}

export type DeployEvent =
  | { type: "log"; seq: number; text: string }
  | { type: "status"; status: string; error: string | null; finished: boolean };

type Listener = (event: DeployEvent) => void;

/** Live updates for deployments, in this process (one control plane runs per install). */
class DeployBus {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #any = new Set<(deploymentId: string, event: DeployEvent) => void>();

  subscribe(deploymentId: string, listener: Listener): () => void {
    let set = this.#listeners.get(deploymentId);
    if (!set) {
      set = new Set();
      this.#listeners.set(deploymentId, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set?.size === 0) this.#listeners.delete(deploymentId);
    };
  }

  /** Every deployment's status changes (the live list and the bell). */
  subscribeAll(listener: (deploymentId: string, event: DeployEvent) => void): () => void {
    this.#any.add(listener);
    return () => this.#any.delete(listener);
  }

  emit(deploymentId: string, event: DeployEvent): void {
    for (const listener of [...(this.#listeners.get(deploymentId) ?? [])]) {
      try {
        listener(event);
      } catch {
        // One viewer's failure never stops the others.
      }
    }
    if (event.type !== "status") return;
    for (const listener of [...this.#any]) {
      try {
        listener(deploymentId, event);
      } catch {
        // As above.
      }
    }
  }
}

export const deployBus = new DeployBus();

export class DeployLog {
  readonly deploymentId: string;
  readonly #db: Db;
  #seq: number;
  #pending = "";
  #timer: ReturnType<typeof setTimeout> | null = null;
  #writing: Promise<void> = Promise.resolve();
  #outputBytes = 0;
  #truncated = false;
  #bytes = 0;
  #lines = 0;
  /** The end of everything written, kept for the failure summary. */
  #tail = "";
  /** What `#pending` holds: in the end part, output and the pipeline's lines go in pieces apart. */
  #pendingKind: "line" | "output" = "line";
  /** Once past the first 1 MB: the piece saying what was left out, and output pieces after it. */
  #marker: { seq: number; bytes: number } | null = null;
  readonly #droppable: DroppablePiece[] = [];
  #droppableBytes = 0;
  #droppedBytes = 0;
  #droppedLines = 0;

  private constructor(db: Db, deploymentId: string, seq: number, bytes: number, lines: number) {
    this.#db = db;
    this.deploymentId = deploymentId;
    this.#seq = seq;
    this.#bytes = bytes;
    this.#lines = lines;
  }

  /** Continues a deployment's log after what is already stored. */
  static async open(db: Db, deploymentId: string): Promise<DeployLog> {
    const row = await db
      .selectFrom("deployment_log")
      .select((eb) => eb.fn.max<number>("seq").as("seq"))
      .where("deployment_id", "=", deploymentId)
      .executeTakeFirst();
    const counts = await db
      .selectFrom("deployment")
      .select(["log_bytes", "log_lines"])
      .where("id", "=", deploymentId)
      .executeTakeFirst();
    return new DeployLog(
      db,
      deploymentId,
      Number(row?.seq ?? 0),
      counts?.log_bytes ?? 0,
      counts?.log_lines ?? 0,
    );
  }

  /** A line from the pipeline; always kept. */
  line(text: string): void {
    this.#kind("line");
    this.#append(`${text.replace(/\n+$/, "")}\n`);
  }

  /** Output from the runner (fetch, build, container): its beginning and its end are kept. */
  output(text: string): void {
    if (text === "") return;
    const size = Buffer.byteLength(text);
    if (this.#marker === null && this.#outputBytes + size <= LOG_HEAD_BYTES) {
      this.#outputBytes += size;
      this.#append(text);
      return;
    }
    if (this.#marker === null) this.#startTail();
    this.#outputBytes += size;
    this.#kind("output");
    this.#append(text);
  }

  /** Past the first 1 MB: what is pending goes, then the line where the middle is left out. */
  #startTail(): void {
    void this.flush();
    const text = leftOutLine(0, 0);
    this.#pending = text;
    this.#pendingKind = "line";
    void this.flush();
    this.#marker = { seq: this.#seq, bytes: Buffer.byteLength(text) };
  }

  /** In the end part, output pieces are kept apart from the pipeline's lines. */
  #kind(kind: "line" | "output"): void {
    if (this.#marker === null || this.#pendingKind === kind) return;
    if (this.#pending !== "") void this.flush(true);
    this.#pendingKind = kind;
  }

  /** The last few KB written (for "Failure detected" summaries in tests and errors). */
  get tail(): string {
    return this.#tail;
  }

  #append(text: string): void {
    this.#pending += text;
    this.#tail = (this.#tail + text).slice(-16 * 1024);
    if (Buffer.byteLength(this.#pending) >= PIECE_BYTES) {
      void this.flush(false);
      return;
    }
    this.#armTimer();
  }

  /**
   * Writes what is pending; resolves once everything written so far is stored. Output in the end
   * part is written in whole lines (the rest waits), unless `all` (the deploy is done with it).
   */
  flush(all = true): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    let text = this.#pending;
    this.#pending = "";
    const droppable = this.#marker !== null && this.#pendingKind === "output";
    if (droppable && !all) {
      const cut = text.lastIndexOf("\n") + 1;
      if (cut > 0 && cut < text.length) {
        this.#pending = text.slice(cut);
        text = text.slice(0, cut);
        this.#armTimer();
      } else if (cut === 0 && Buffer.byteLength(text) < PIECE_BYTES * 4) {
        this.#pending = text;
        text = "";
        this.#armTimer();
      }
    }
    if (text !== "") {
      const seq = ++this.#seq;
      const size = Buffer.byteLength(text);
      const lineCount = (text.match(/\n/g) ?? []).length;
      this.#bytes += size;
      this.#lines += lineCount;
      const dropped: number[] = [];
      if (droppable) {
        this.#droppable.push({ seq, bytes: size, lines: lineCount });
        this.#droppableBytes += size;
        // Only the last 4 MB of the end part stay: the oldest output pieces go first.
        while (this.#droppableBytes > LOG_TAIL_BYTES && this.#droppable.length > 1) {
          const oldest = this.#droppable.shift() as DroppablePiece;
          this.#droppableBytes -= oldest.bytes;
          this.#droppedBytes += oldest.bytes;
          this.#droppedLines += oldest.lines;
          this.#bytes -= oldest.bytes;
          this.#lines -= oldest.lines;
          dropped.push(oldest.seq);
        }
        if (dropped.length > 0) this.#truncated = true;
      }
      let markerText: string | null = null;
      const marker = this.#marker;
      if (dropped.length > 0 && marker) {
        markerText = leftOutLine(this.#droppedBytes, this.#droppedLines);
        const markerBytes = Buffer.byteLength(markerText);
        this.#bytes += markerBytes - marker.bytes;
        marker.bytes = markerBytes;
      }
      const bytes = this.#bytes;
      const lines = this.#lines;
      const truncated = this.#truncated;
      this.#writing = this.#writing.then(async () => {
        try {
          await this.#db
            .insertInto("deployment_log")
            .values({ deployment_id: this.deploymentId, seq, text })
            .execute();
          if (dropped.length > 0) {
            await this.#db
              .deleteFrom("deployment_log")
              .where("deployment_id", "=", this.deploymentId)
              .where("seq", "in", dropped)
              .execute();
          }
          if (markerText !== null && marker) {
            await this.#db
              .updateTable("deployment_log")
              .set({ text: markerText })
              .where("deployment_id", "=", this.deploymentId)
              .where("seq", "=", marker.seq)
              .execute();
          }
          await this.#db
            .updateTable("deployment")
            .set({ log_bytes: bytes, log_lines: lines, log_truncated: truncated })
            .where("id", "=", this.deploymentId)
            .execute();
          deployBus.emit(this.deploymentId, { type: "log", seq, text });
        } catch {
          // The deployment may have been pruned meanwhile; nothing to keep it for.
        }
      });
    }
    return this.#writing;
  }

  #armTimer(): void {
    if (this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush(false);
    }, FLUSH_MS);
  }
}

/** The stored pieces after `afterSeq`, oldest first. */
export async function readLogPieces(
  db: Db,
  deploymentId: string,
  afterSeq: number,
  limit = 2_000,
): Promise<{ seq: number; text: string }[]> {
  return db
    .selectFrom("deployment_log")
    .select(["seq", "text"])
    .where("deployment_id", "=", deploymentId)
    .where("seq", ">", afterSeq)
    .orderBy("seq")
    .limit(limit)
    .execute();
}

/** The whole stored log as text. */
export async function readLogText(
  db: Db,
  deploymentId: string,
): Promise<{ text: string; seq: number }> {
  const pieces = await db
    .selectFrom("deployment_log")
    .select(["seq", "text"])
    .where("deployment_id", "=", deploymentId)
    .orderBy("seq")
    .execute();
  return {
    text: pieces.map((piece) => piece.text).join(""),
    seq: pieces.at(-1)?.seq ?? 0,
  };
}
