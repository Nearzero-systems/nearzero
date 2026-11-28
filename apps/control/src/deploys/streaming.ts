import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../http/context.ts";
import type { HubStream, StreamEvent } from "../runners/streams.ts";

/**
 * Server-sent event plumbing for deploy logs and runtime logs (spec 25 D5, 23.2): headers at
 * once, a keep-alive comment at least every 15 seconds, and ids a client sends back as
 * Last-Event-ID to resume exactly where it stopped.
 */

export const KEEP_ALIVE_MS = 15_000;

export interface SseWriter {
  send(event: string, data: unknown, id?: string): Promise<void>;
}

/** Runs `body` with a writer; resolves `done` to finish the response. */
export function sseResponse(
  c: Context<AppEnv>,
  body: (writer: SseWriter, aborted: Promise<void>) => Promise<void>,
): Response {
  return streamSSE(c, async (sse) => {
    let abort: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      abort = resolve;
    });
    sse.onAbort(() => abort());
    const keepAlive = setInterval(() => {
      void sse.write(": keep-alive\n\n").catch(() => {});
    }, KEEP_ALIVE_MS);
    try {
      await body(
        {
          send: (event, data, id) =>
            sse.writeSSE({ event, data: JSON.stringify(data), ...(id ? { id } : {}) }),
        },
        aborted,
      );
    } finally {
      clearInterval(keepAlive);
    }
  });
}

/** Last-Event-ID (header or ?lastEventId=) of the form <id>:<number>. */
export function lastEventId(c: Context<AppEnv>): { id: string; position: number } | null {
  const value = c.req.header("last-event-id") ?? c.req.query("lastEventId") ?? "";
  const match = /^([0-9a-f-]{36}):(\d{1,15})$/.exec(value);
  return match ? { id: match[1] as string, position: Number(match[2]) } : null;
}

/** A queue that a producer pushes into and the SSE loop takes from, waking when needed. */
export class EventQueue<T> {
  readonly #items: T[] = [];
  #wake: (() => void) | null = null;

  push(item: T): void {
    this.#items.push(item);
    this.#wake?.();
  }

  async next(until: Promise<void>, timeoutMs: number): Promise<T | "timeout" | "aborted"> {
    const item = this.#items.shift();
    if (item !== undefined) return item;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      new Promise<"wake">((resolve) => {
        this.#wake = () => resolve("wake");
      }),
      until.then(() => "aborted" as const),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    this.#wake = null;
    if (outcome === "wake") return this.#items.shift() ?? "timeout";
    return outcome;
  }
}

/**
 * Sends a runner stream (runtime logs) as SSE events: open, output (id <stream id>:<end>),
 * status, gap and end. With `filter`, only whole lines it accepts are sent.
 */
export async function pipeHubStream(
  writer: SseWriter,
  aborted: Promise<void>,
  stream: HubStream,
  fromOffset: number,
  filter: ((line: string) => boolean) | null,
): Promise<void> {
  const queue = new EventQueue<StreamEvent>();
  const unsubscribe = stream.subscribe((event) => queue.push(event), fromOffset);
  const decoder = new TextDecoder();
  let partial = "";
  try {
    await writer.send("open", { streamId: stream.id });
    for (;;) {
      const event = await queue.next(aborted, 60_000);
      if (event === "aborted") return;
      if (event === "timeout") continue;
      if (event.type === "output") {
        let text = decoder.decode(event.bytes, { stream: true });
        if (filter) {
          const all = partial + text;
          const lines = all.split("\n");
          partial = lines.pop() ?? "";
          const kept = lines.filter(filter);
          if (kept.length === 0) continue;
          text = `${kept.join("\n")}\n`;
        }
        await writer.send("output", { text, offset: event.offset }, `${stream.id}:${event.end}`);
      } else if (event.type === "gap") {
        await writer.send("gap", {
          from: event.from,
          to: event.to,
          message: "Some output was lost while the server was unreachable.",
        });
      } else if (event.type === "link") {
        await writer.send("status", {
          connected: event.connected,
          message: event.connected
            ? "The server is back; the log continues."
            : "Lost the server for a moment; the log continues when it is back.",
        });
      } else {
        if (filter && partial && filter(partial)) {
          await writer.send(
            "output",
            { text: partial, offset: event.offset },
            `${stream.id}:${event.offset}`,
          );
        }
        await writer.send(
          "end",
          { exitCode: event.exitCode, error: event.error },
          `${stream.id}:${event.offset}`,
        );
        return;
      }
    }
  } finally {
    unsubscribe();
  }
}
