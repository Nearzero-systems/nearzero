import type { Socket } from "bun";
import { PushQueue } from "../streams/queue.ts";
import { concat } from "./demux.ts";

/**
 * Docker's "hijacked" connections, used to talk to a process started with exec: the request is
 * an HTTP upgrade, and after the 101 answer the same socket carries the process's input one way
 * and its output the other. Bun's fetch can't do that, so this speaks HTTP/1.1 on a raw socket.
 */

export interface HijackedStream {
  /** The process's output: raw with a TTY, multiplexed frames without one. */
  readonly output: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): void;
  /** Ends the process's input (like closing a pipe). */
  closeWrite(): void;
  close(): void;
}

const HEADER_END = new TextEncoder().encode("\r\n\r\n");

function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function hijack(socketPath: string, path: string, body: unknown): Promise<HijackedStream> {
  const payload = JSON.stringify(body);
  const request =
    `POST ${path} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n` +
    `Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;

  return new Promise((resolve, reject) => {
    const output = new PushQueue<Uint8Array>();
    let head: Uint8Array = new Uint8Array(0);
    let upgraded = false;
    let settled = false;
    const queue: Uint8Array[] = [];
    let socketRef: Socket<undefined> | null = null;

    const flush = () => {
      const socket = socketRef;
      if (!socket) return;
      while (queue.length > 0) {
        const next = queue[0] as Uint8Array;
        const written = socket.write(next);
        if (written < next.length) {
          queue[0] = next.subarray(Math.max(0, written));
          return;
        }
        queue.shift();
      }
    };

    const stream: HijackedStream = {
      output,
      write(bytes) {
        queue.push(bytes);
        flush();
      },
      closeWrite() {
        socketRef?.shutdown(true);
      },
      close() {
        socketRef?.end();
        output.end();
      },
    };

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socketRef = socket;
          socket.write(request);
        },
        data(_socket, data) {
          if (upgraded) {
            output.push(new Uint8Array(data));
            return;
          }
          head = concat(head, new Uint8Array(data));
          const end = indexOfBytes(head, HEADER_END);
          if (end < 0) return;
          const headerText = new TextDecoder().decode(head.subarray(0, end));
          const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(headerText)?.[1] ?? 0);
          const rest = head.subarray(end + HEADER_END.length);
          if (status !== 101 && status !== 200) {
            settled = true;
            const message = new TextDecoder().decode(rest).trim();
            reject(new Error(`Docker refused to start the process (${status}): ${message}`));
            socketRef?.end();
            return;
          }
          upgraded = true;
          settled = true;
          if (rest.length > 0) output.push(rest.slice());
          resolve(stream);
        },
        drain() {
          flush();
        },
        close() {
          output.end();
          if (!settled) {
            settled = true;
            reject(new Error("Docker closed the connection before the process started."));
          }
        },
        error(_socket, error) {
          output.end();
          if (!settled) {
            settled = true;
            reject(error);
          }
        },
      },
    }).catch((error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}
