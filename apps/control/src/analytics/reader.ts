import {
  ACCESS_LOG_PIECE_BYTES,
  ACCESS_LOG_READ_LIMIT_BYTES,
  type AccessLogPiece,
  parseAccessLine,
  type RequestEntry,
} from "@nearzero/shared";
import type { RunnerHub } from "../runners/hub.ts";

/**
 * The host router's request log as this process holds it (spec 13.1): entries parsed from the
 * file the runner reads in pieces. A page load reads only what was added since the last one; the
 * first read starts at most 32 MB before the end (the most ever read), and entries older than
 * the last 32 MB are dropped. A replaced or shortened file starts the reading over.
 */

const NEWLINE = 0x0a;
/** Reads are at most this often; pages opened together share one. */
const SYNC_EVERY_MS = 1_500;

interface Held {
  entry: RequestEntry;
  /** The line's byte offset in the file. */
  offset: number;
}

export class AccessLogReader {
  readonly #target: string;
  #fileId: string | null = null;
  #offset: number | null = null;
  #held: Held[] = [];
  #size = 0;
  #syncedAt = 0;
  #syncing: Promise<void> | null = null;
  /** The first read reached back to the 32 MB limit (older requests aren't counted). */
  limited = false;

  constructor(target: string) {
    this.#target = target;
  }

  /** Forgets everything (after a cleanup or "Delete all", which rewrite the file). */
  reset(): void {
    this.#fileId = null;
    this.#offset = null;
    this.#held = [];
    this.#size = 0;
    this.#syncedAt = 0;
    this.limited = false;
  }

  get sizeBytes(): number {
    return this.#size;
  }

  entries(): RequestEntry[] {
    return this.#held.map((item) => item.entry);
  }

  async sync(hub: Pick<RunnerHub, "command">, force = false): Promise<void> {
    if (!force && Date.now() - this.#syncedAt < SYNC_EVERY_MS) return;
    this.#syncing ??= this.#read(hub).finally(() => {
      this.#syncing = null;
      this.#syncedAt = Date.now();
    });
    await this.#syncing;
  }

  async #read(hub: Pick<RunnerHub, "command">): Promise<void> {
    let budget = ACCESS_LOG_READ_LIMIT_BYTES + ACCESS_LOG_PIECE_BYTES;
    for (;;) {
      const piece = (await hub.command(
        this.#target,
        "access-log.read",
        {
          fromOffset: this.#offset,
          maxBytes: ACCESS_LOG_PIECE_BYTES,
          tailBytes: ACCESS_LOG_READ_LIMIT_BYTES,
        },
        { timeoutMs: 60_000 },
      )) as AccessLogPiece;
      if (!piece.exists) {
        this.reset();
        return;
      }
      if (this.#offset !== null && piece.fileId !== this.#fileId) {
        // Another file now: read its end from the start of a line.
        this.#offset = null;
        this.#held = [];
        continue;
      }
      const restarted = this.#offset === null || piece.start !== this.#offset;
      if (restarted) {
        this.#held = [];
        this.limited = piece.start > 0;
      }
      this.#fileId = piece.fileId;
      this.#size = piece.size;
      this.#take(piece);
      this.#offset = piece.end;
      budget -= piece.end - piece.start;
      if (piece.end >= piece.size || piece.end === piece.start || budget <= 0) break;
    }
    // Only the last 32 MB of the file counts.
    const floor = this.#size - ACCESS_LOG_READ_LIMIT_BYTES;
    if (floor > 0 && this.#held.length > 0 && (this.#held[0] as Held).offset < floor) {
      this.#held = this.#held.filter((item) => item.offset >= floor);
      this.limited = true;
    }
  }

  #take(piece: AccessLogPiece): void {
    const bytes = Buffer.from(piece.data, "base64");
    let lineStart = 0;
    for (let index = 0; index < bytes.length; index++) {
      if (bytes[index] !== NEWLINE) continue;
      this.#line(bytes, lineStart, index, piece.start + lineStart, piece.fileId);
      lineStart = index + 1;
    }
    if (lineStart < bytes.length)
      this.#line(bytes, lineStart, bytes.length, piece.start + lineStart, piece.fileId);
  }

  #line(bytes: Buffer, from: number, to: number, offset: number, fileId: string): void {
    if (to <= from) return;
    const entry = parseAccessLine(
      bytes.toString("utf8", from, to),
      `${fileId.replace(/[^0-9]/g, "")}-${offset}`,
    );
    if (entry) this.#held.push({ entry, offset });
  }
}

const readers = new Map<string, AccessLogReader>();

export function readerFor(target: string): AccessLogReader {
  let reader = readers.get(target);
  if (!reader) {
    reader = new AccessLogReader(target);
    readers.set(target, reader);
  }
  return reader;
}
