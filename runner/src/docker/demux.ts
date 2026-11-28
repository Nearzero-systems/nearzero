/**
 * Docker sends a container's output without a TTY as frames: an 8-byte header (stream type,
 * three zero bytes, the payload length as a 32-bit big-endian number) and then the payload. The
 * demuxer turns that back into one byte stream, stdout and stderr in the order they were written.
 */

const HEADER = 8;

export class Demuxer {
  #pending: Uint8Array = new Uint8Array(0);

  /** Feeds bytes in; returns the payloads now complete. */
  push(chunk: Uint8Array): Uint8Array[] {
    const data = this.#pending.length === 0 ? chunk : concat(this.#pending, chunk);
    const out: Uint8Array[] = [];
    let at = 0;
    while (data.length - at >= HEADER) {
      const size =
        ((data[at + 4] ?? 0) << 24) |
        ((data[at + 5] ?? 0) << 16) |
        ((data[at + 6] ?? 0) << 8) |
        (data[at + 7] ?? 0);
      const length = size >>> 0;
      if (data.length - at - HEADER < length) break;
      if (length > 0) out.push(data.subarray(at + HEADER, at + HEADER + length));
      at += HEADER + length;
    }
    this.#pending = data.slice(at);
    return out;
  }

  /** Bytes still waiting for the rest of their frame. */
  get pendingBytes(): number {
    return this.#pending.length;
  }
}

export async function* demuxDockerStream(
  source: AsyncIterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const demuxer = new Demuxer();
  for await (const chunk of source) {
    for (const payload of demuxer.push(chunk)) yield payload;
  }
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
