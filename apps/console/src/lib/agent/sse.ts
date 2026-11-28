/**
 * Reading a server-sent event stream in pieces (the Agent's turn stream, docs/api/agent.md):
 * `event:`, `id:` and `data:` lines, blocks split by a blank line, comments (": keep-alive")
 * ignored. Pure, so it can be tested without a network.
 */

export interface SseMessage {
  type: string;
  id: string | null;
  data: string;
}

export class SseParser {
  #buffer = "";

  /** Feeds a decoded chunk; returns the messages it completed. */
  push(chunk: string): SseMessage[] {
    this.#buffer += chunk.replace(/\r\n?/g, "\n");
    const out: SseMessage[] = [];
    let index = this.#buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 2);
      const message = parseBlock(block);
      if (message) out.push(message);
      index = this.#buffer.indexOf("\n\n");
    }
    return out;
  }
}

function parseBlock(block: string): SseMessage | null {
  let type = "message";
  let id: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") type = value;
    else if (field === "id") id = value;
    else if (field === "data") data.push(value);
  }
  if (data.length === 0 && type === "message") return null;
  return { type, id, data: data.join("\n") };
}

/** Waits between reconnects: 0.5s, 1s, 2s, 4s, then every 8s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** Math.max(0, attempt));
}
