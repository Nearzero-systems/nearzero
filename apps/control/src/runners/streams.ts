import type { RunnerError } from "@nearzero/shared";

/**
 * A stream as the control plane follows it (docs/runner-protocol.md, "Streams and resume"):
 * the offset received so far, a window of recent output for viewers who reconnect, and the people
 * watching. Output from the runner is placed by offset, so a chunk sent twice after a reconnect is
 * kept once, and a jump forward (the runner had to drop output) is reported as a gap.
 */

export type StreamEvent =
  | { type: "output"; offset: number; end: number; bytes: Uint8Array }
  | { type: "gap"; from: number; to: number }
  | { type: "end"; offset: number; exitCode: number | null; error: RunnerError | null }
  /** The runner's link dropped or came back; output resumes where it stopped. */
  | { type: "link"; connected: boolean };

export type StreamListener = (event: StreamEvent) => void;

/** Output kept for viewers who reconnect (each SSE id is an offset into it). */
export const REPLAY_BYTES = 2 * 1024 * 1024;

export class HubStream {
  readonly id: string;
  readonly target: string;
  readonly kind: string;
  /** Every byte before this offset has been received. */
  received = 0;
  ended: { exitCode: number | null; error: RunnerError | null } | null = null;
  readonly #chunks: { offset: number; bytes: Uint8Array }[] = [];
  #replayBytes = 0;
  readonly #listeners = new Set<StreamListener>();
  readonly #gaps: { from: number; to: number }[] = [];
  lastActivity = Date.now();
  /**
   * Where this process started following it: 0, or for work found running after a restart the
   * oldest output its runner still held (what came before was followed by the earlier process).
   */
  readonly startOffset: number;

  constructor(id: string, target: string, kind: string, startOffset = 0) {
    this.id = id;
    this.target = target;
    this.kind = kind;
    this.startOffset = startOffset;
    this.received = startOffset;
  }

  get listeners(): number {
    return this.#listeners.size;
  }

  /** Takes a chunk from the runner; returns false when it was all a repeat. */
  accept(offset: number, bytes: Uint8Array): boolean {
    this.lastActivity = Date.now();
    const end = offset + bytes.length;
    if (end <= this.received) return false;
    let start = offset;
    let data = bytes;
    if (offset < this.received) {
      data = bytes.subarray(this.received - offset);
      start = this.received;
    } else if (offset > this.received) {
      const gap = { from: this.received, to: offset };
      this.#gaps.push(gap);
      this.#emit({ type: "gap", ...gap });
    }
    this.#chunks.push({ offset: start, bytes: data });
    this.#replayBytes += data.length;
    while (this.#replayBytes > REPLAY_BYTES && this.#chunks.length > 1) {
      const dropped = this.#chunks.shift();
      this.#replayBytes -= dropped?.bytes.length ?? 0;
    }
    this.received = end;
    this.#emit({ type: "output", offset: start, end, bytes: data });
    return true;
  }

  finish(offset: number, exitCode: number | null, error: RunnerError | null): void {
    if (this.ended) return;
    if (offset > this.received) {
      const gap = { from: this.received, to: offset };
      this.#gaps.push(gap);
      this.#emit({ type: "gap", ...gap });
      this.received = offset;
    }
    this.ended = { exitCode, error };
    this.#emit({ type: "end", offset: this.received, exitCode, error });
  }

  link(connected: boolean): void {
    this.#emit({ type: "link", connected });
  }

  /**
   * Follows the stream from an offset: what is still held after it first, then live output. An
   * offset older than the window is reported as a gap before the oldest held output.
   */
  subscribe(listener: StreamListener, fromOffset = this.startOffset): () => void {
    const oldest = this.#chunks[0]?.offset ?? this.received;
    if (fromOffset < oldest) listener({ type: "gap", from: fromOffset, to: oldest });
    for (const chunk of this.#chunks) {
      const end = chunk.offset + chunk.bytes.length;
      if (end <= fromOffset) continue;
      const bytes =
        chunk.offset >= fromOffset ? chunk.bytes : chunk.bytes.subarray(fromOffset - chunk.offset);
      const offset = Math.max(chunk.offset, fromOffset);
      listener({ type: "output", offset, end, bytes });
    }
    if (this.ended) {
      listener({ type: "end", offset: this.received, ...this.ended });
    }
    this.#listeners.add(listener);
    this.lastActivity = Date.now();
    return () => {
      this.#listeners.delete(listener);
      this.lastActivity = Date.now();
    };
  }

  /** Gaps seen so far (tests and the integration suite assert there are none). */
  get gaps(): readonly { from: number; to: number }[] {
    return this.#gaps;
  }

  #emit(event: StreamEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // One viewer's failure never stops the others.
      }
    }
  }
}
