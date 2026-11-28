import { encodeChunk, type RunnerError, STREAM_CHUNK_MAX_BYTES } from "@nearzero/shared";
import { OutputBuffer } from "./buffer.ts";

/**
 * One stream of output the runner sends to the control plane (a log follow, a build, a
 * terminal), with the buffer that makes it survive a reconnect. While the link is down the
 * output keeps collecting; when the control plane says from which offset to resume, the stream
 * sends from exactly there.
 */

export type StreamMessage =
  | { type: "stream.data"; streamId: string; offset: number; data: string }
  | {
      type: "stream.end";
      streamId: string;
      offset: number;
      exitCode?: number | null;
      error?: RunnerError;
    };

/** Per stream: 8 MB waits for the control plane, which is minutes of busy logs. */
export const STREAM_BUFFER_BYTES = 8 * 1024 * 1024;

export class RunnerStream {
  readonly id: string;
  readonly buffer: OutputBuffer;
  /** Where the next send starts; null while the control plane hasn't said where to resume. */
  #sentOffset: number | null;
  #send: ((message: StreamMessage) => boolean) | null;
  #ended: { exitCode: number | null; error?: RunnerError } | null = null;
  #endSent = false;
  readonly #closeHandlers: (() => void)[] = [];
  #onInput: ((bytes: Uint8Array) => void) | null = null;
  #onResize: ((cols: number, rows: number) => void) | null = null;
  /** Input and a resize that arrived before the process was ready for them. */
  readonly #pendingInput: Uint8Array[] = [];
  #pendingSize: { cols: number; rows: number } | null = null;
  /** When the stream ended, for clean-up of streams nobody acknowledges. */
  endedAt: number | null = null;

  constructor(
    id: string,
    send: ((message: StreamMessage) => boolean) | null,
    limit = STREAM_BUFFER_BYTES,
  ) {
    this.id = id;
    this.buffer = new OutputBuffer(limit);
    this.#send = send;
    this.#sentOffset = send ? 0 : null;
  }

  /** Where input goes once the process runs; input that came earlier is delivered then. */
  set onInput(handler: ((bytes: Uint8Array) => void) | null) {
    this.#onInput = handler;
    if (handler) for (const bytes of this.#pendingInput.splice(0)) handler(bytes);
  }

  set onResize(handler: ((cols: number, rows: number) => void) | null) {
    this.#onResize = handler;
    if (handler && this.#pendingSize) handler(this.#pendingSize.cols, this.#pendingSize.rows);
    this.#pendingSize = null;
  }

  input(bytes: Uint8Array): void {
    if (this.#onInput) this.#onInput(bytes);
    else if (this.#pendingInput.length < 1024) this.#pendingInput.push(bytes);
  }

  resize(cols: number, rows: number): void {
    if (this.#onResize) this.#onResize(cols, rows);
    else this.#pendingSize = { cols, rows };
  }

  get ended(): boolean {
    return this.#ended !== null;
  }

  /** Output from the work; sent at once when the link is up. */
  write(bytes: Uint8Array): void {
    if (this.#ended || bytes.length === 0) return;
    for (let at = 0; at < bytes.length; at += STREAM_CHUNK_MAX_BYTES) {
      this.buffer.append(bytes.slice(at, at + STREAM_CHUNK_MAX_BYTES));
    }
    this.#pump();
  }

  text(line: string): void {
    this.write(new TextEncoder().encode(line));
  }

  end(exitCode: number | null = null, error?: RunnerError): void {
    if (this.#ended) return;
    this.#ended = error ? { exitCode, error } : { exitCode };
    this.endedAt = Date.now();
    this.#pump();
  }

  /** The control plane asked to stop following (or the stream is being dropped). */
  close(): void {
    for (const handler of this.#closeHandlers.splice(0)) {
      try {
        handler();
      } catch {
        // Closing is best effort.
      }
    }
  }

  onClose(handler: () => void): void {
    this.#closeHandlers.push(handler);
  }

  /** The link went down: hold output until the control plane says where to resume. */
  detach(): void {
    this.#send = null;
    this.#sentOffset = null;
    this.#endSent = false;
  }

  /** The link is up again and the control plane has stored everything before `offset`. */
  resume(send: (message: StreamMessage) => boolean, offset: number): void {
    this.#send = send;
    this.buffer.ack(offset);
    this.#sentOffset = Math.max(offset, this.buffer.firstOffset);
    this.#endSent = false;
    this.#pump();
  }

  ack(offset: number): void {
    this.buffer.ack(offset);
  }

  /** Sends what the link refused earlier (it was backed up, C4-07), now that it has room. */
  flush(): void {
    this.#pump();
  }

  /** Ended, and the control plane has every byte. */
  get finished(): boolean {
    return this.#ended !== null && this.#endSent && this.buffer.heldBytes === 0;
  }

  #pump(): void {
    const send = this.#send;
    if (!send || this.#sentOffset === null) return;
    for (const chunk of this.buffer.from(this.#sentOffset)) {
      if (
        !send({
          type: "stream.data",
          streamId: this.id,
          offset: chunk.offset,
          data: encodeChunk(chunk.bytes),
        })
      ) {
        return;
      }
      this.#sentOffset = chunk.offset + chunk.bytes.length;
    }
    if (this.#ended && !this.#endSent && this.#sentOffset >= this.buffer.endOffset) {
      const message: StreamMessage = {
        type: "stream.end",
        streamId: this.id,
        offset: this.buffer.endOffset,
        exitCode: this.#ended.exitCode,
        ...(this.#ended.error ? { error: this.#ended.error } : {}),
      };
      if (send(message)) this.#endSent = true;
    }
  }
}
