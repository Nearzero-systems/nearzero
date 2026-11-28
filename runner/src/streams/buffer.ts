/**
 * The output of one stream (a log, a build, a terminal) as the runner holds it until the control
 * plane says it has stored it. Every byte has an offset from the start of the stream, so after a
 * reconnect the runner sends again exactly from the control plane's last offset and nothing is
 * lost or repeated (docs/runner-protocol.md, "Streams and resume").
 *
 * The buffer has a limit. When the control plane is away long enough for it to fill, the oldest
 * bytes go and the control plane sees a gap (the next offset it gets is past the one it expects).
 */

export interface BufferedChunk {
  offset: number;
  bytes: Uint8Array;
}

export class OutputBuffer {
  readonly limitBytes: number;
  readonly #chunks: BufferedChunk[] = [];
  #first = 0;
  #end = 0;
  #held = 0;

  constructor(limitBytes: number) {
    this.limitBytes = limitBytes;
  }

  /** Offset of the oldest byte still held. */
  get firstOffset(): number {
    return this.#first;
  }

  /** Offset just past the newest byte: the stream's length so far. */
  get endOffset(): number {
    return this.#end;
  }

  get heldBytes(): number {
    return this.#held;
  }

  /** Adds output; returns the chunk with its offset. */
  append(bytes: Uint8Array): BufferedChunk {
    const chunk = { offset: this.#end, bytes };
    this.#chunks.push(chunk);
    this.#end += bytes.length;
    this.#held += bytes.length;
    while (this.#held > this.limitBytes && this.#chunks.length > 1) this.#dropOldest();
    return chunk;
  }

  /** Forgets everything before an offset the control plane has stored. */
  ack(offset: number): void {
    while (this.#chunks.length > 0) {
      const oldest = this.#chunks[0] as BufferedChunk;
      if (oldest.offset + oldest.bytes.length > offset) break;
      this.#dropOldest();
    }
    if (this.#chunks.length === 0) this.#first = Math.max(this.#first, Math.min(offset, this.#end));
  }

  /** Everything from an offset on, the first chunk cut to start exactly there. */
  from(offset: number): BufferedChunk[] {
    const out: BufferedChunk[] = [];
    for (const chunk of this.#chunks) {
      const chunkEnd = chunk.offset + chunk.bytes.length;
      if (chunkEnd <= offset) continue;
      if (chunk.offset >= offset) {
        out.push(chunk);
      } else {
        out.push({ offset, bytes: chunk.bytes.subarray(offset - chunk.offset) });
      }
    }
    return out;
  }

  #dropOldest(): void {
    const oldest = this.#chunks.shift();
    if (!oldest) return;
    this.#held -= oldest.bytes.length;
    this.#first = oldest.offset + oldest.bytes.length;
  }
}

/**
 * Groups text output into whole lines, so each chunk sent is readable on its own: a chunk ends
 * at a newline, or when a line runs long, or when output pauses with a partial line waiting.
 */
export class LineChunker {
  readonly #emit: (bytes: Uint8Array) => void;
  readonly #maxBytes: number;
  readonly #flushAfterMs: number;
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(emit: (bytes: Uint8Array) => void, maxBytes = 32 * 1024, flushAfterMs = 200) {
    this.#emit = emit;
    this.#maxBytes = maxBytes;
    this.#flushAfterMs = flushAfterMs;
  }

  push(bytes: Uint8Array): void {
    const lastNewline = bytes.lastIndexOf(10);
    if (lastNewline >= 0) {
      // Everything up to the last newline goes out as one chunk of whole lines.
      this.#add(bytes.subarray(0, lastNewline + 1));
      this.flush();
      this.#add(bytes.subarray(lastNewline + 1));
    } else {
      this.#add(bytes);
    }
    if (this.#pendingBytes >= this.#maxBytes) this.flush();
    else if (this.#pendingBytes > 0 && !this.#timer) {
      this.#timer = setTimeout(() => this.flush(), this.#flushAfterMs);
    }
  }

  flush(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#pendingBytes === 0) return;
    const out = new Uint8Array(this.#pendingBytes);
    let at = 0;
    for (const part of this.#pending) {
      out.set(part, at);
      at += part.length;
    }
    this.#pending = [];
    this.#pendingBytes = 0;
    this.#emit(out);
  }

  #add(bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    this.#pending.push(bytes.slice());
    this.#pendingBytes += bytes.length;
  }
}
