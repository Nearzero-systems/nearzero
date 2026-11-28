import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import net from "node:net";
import { LINK_HIGH_WATER_BYTES, LINK_MAX_BUFFERED_BYTES, LinkSocket } from "../src/link/socket.ts";

/**
 * The runner's WebSocket client against a raw server that misbehaves on purpose: RFC 6455's
 * handshake and framing rules (C4-08), and flow control on a link the other side stops reading
 * (C4-07). Over plain TCP; the framing code is the same over TLS.
 */

setDefaultTimeout(60_000);

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function header(opcode: number, length: number, fin = true): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  if (length < 126) return Buffer.from([first, length]);
  if (length < 65536) return Buffer.from([first, 126, length >> 8, length & 0xff]);
  const head = Buffer.alloc(10);
  head[0] = first;
  head[1] = 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return head;
}

const frame = (opcode: number, payload: Buffer, fin = true) =>
  Buffer.concat([header(opcode, payload.length, fin), payload]);

/** The client's frames as the server reads them (unmasked). */
function clientFrames(buffer: Buffer): { opcode: number; payload: Buffer }[] {
  const out: { opcode: number; payload: Buffer }[] = [];
  let at = 0;
  while (buffer.length - at >= 6) {
    const opcode = (buffer[at] ?? 0) & 0x0f;
    let length = (buffer[at + 1] ?? 0) & 0x7f;
    let offset = at + 2;
    if (length === 126) {
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    if (buffer.length < offset + length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    for (let index = 0; index < payload.length; index++) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index & 3] ?? 0);
    }
    out.push({ opcode, payload });
    at = offset + length;
  }
  return out;
}

const servers: net.Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

interface Outcome {
  opened: boolean;
  messages: string[];
  close: { code: number; reason: string };
  /** What the client sent after the upgrade: close codes, pongs. */
  sent: { opcode: number; payload: Buffer }[];
}

/**
 * A raw server: it answers the upgrade (or `answer` does), then runs `script`. It echoes a close
 * frame like a well-behaved peer, so the client's own close code is the one it reports.
 */
async function scenario(
  script: (socket: net.Socket) => unknown,
  answer?: (accept: string) => string,
): Promise<Outcome> {
  let fromClient = Buffer.alloc(0);
  const server = net.createServer((socket) => {
    let upgraded = false;
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        upgraded = true;
        const key = /sec-websocket-key: (\S+)/i.exec(chunk.toString("latin1"))?.[1] ?? "";
        const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
        socket.write(
          answer
            ? answer(accept)
            : `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        void script(socket);
        return;
      }
      fromClient = Buffer.concat([fromClient, chunk]);
      const close = clientFrames(fromClient).find((item) => item.opcode === 0x8);
      if (close && !socket.destroyed) {
        socket.end(frame(0x8, close.payload.subarray(0, 2)));
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  const client = new LinkSocket(`ws://127.0.0.1:${port}/`, { verify: { kind: "plain" } });
  const messages: string[] = [];
  let opened = false;
  client.addEventListener("open", () => {
    opened = true;
  });
  client.addEventListener("message", (event) => {
    messages.push(String((event as MessageEvent).data));
  });
  const close = await new Promise<{ code: number; reason: string }>((resolve) =>
    client.addEventListener("close", (event) => {
      const closed = event as CloseEvent;
      resolve({ code: closed.code, reason: closed.reason });
    }),
  );
  await Bun.sleep(30);
  return { opened, messages, close, sent: clientFrames(fromClient) };
}

const closeCodeSent = (outcome: Outcome) =>
  outcome.sent.find((item) => item.opcode === 0x8)?.payload.readUInt16BE(0);

describe("RFC 6455 frames the client refuses (C4-08)", () => {
  test("text that isn't UTF-8 fails the connection with 1007, and isn't delivered (8.1)", async () => {
    const outcome = await scenario((socket) => {
      socket.write(frame(0x1, Buffer.from([0xc3, 0x28, 0x7b])));
    });
    expect(outcome.messages).toEqual([]);
    expect(closeCodeSent(outcome)).toBe(1007);
    expect(outcome.close.code).toBe(1007);
  });

  test("a close frame with a one-byte payload is a protocol error, 1002 (5.5.1)", async () => {
    const outcome = await scenario((socket) => socket.write(frame(0x8, Buffer.from([0x03]))));
    expect(closeCodeSent(outcome)).toBe(1002);
    expect(outcome.close.code).toBe(1002);
  });

  test("close codes outside the allowed ranges are a protocol error, 1002 (7.4)", async () => {
    for (const code of [999, 1004, 1005, 1006, 1015, 2000, 5000]) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      const outcome = await scenario((socket) => socket.write(frame(0x8, payload)));
      expect([code, closeCodeSent(outcome)]).toEqual([code, 1002]);
    }
    // Allowed ones are taken as the peer's, and echoed.
    for (const code of [1000, 1001, 1011, 1014, 3000, 4999]) {
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      const outcome = await scenario((socket) => socket.write(frame(0x8, payload)));
      expect([code, outcome.close.code, closeCodeSent(outcome)]).toEqual([code, code, code]);
    }
  });

  test("a close reason that isn't UTF-8 fails with 1007", async () => {
    const outcome = await scenario((socket) =>
      socket.write(frame(0x8, Buffer.from([0x03, 0xe8, 0xff, 0xfe]))),
    );
    expect(closeCodeSent(outcome)).toBe(1007);
    expect(outcome.close.code).toBe(1007);
  });

  test("a 101 without Connection: Upgrade, or with a wrong Sec-WebSocket-Accept, never opens (4.1)", async () => {
    for (const answer of [
      (accept: string) =>
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      () =>
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: AAAAAAAAAAAAAAAAAAAAAAAAAAA=\r\n\r\n",
    ]) {
      const outcome = await scenario(
        (socket) => socket.write(frame(0x1, Buffer.from("hi"))),
        answer,
      );
      expect(outcome.opened).toBe(false);
      expect(outcome.messages).toEqual([]);
    }
  });

  test("a 101 with an extension or a subprotocol nobody asked for never opens (4.1)", async () => {
    for (const extra of [
      "Sec-WebSocket-Extensions: permessage-deflate\r\n",
      "Sec-WebSocket-Protocol: chat\r\n",
    ]) {
      const outcome = await scenario(
        (socket) => socket.write(frame(0x1, Buffer.from("hi"))),
        (accept) =>
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${extra}Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      expect(outcome.opened).toBe(false);
      expect(outcome.messages).toEqual([]);
    }
  });

  test("a 64-bit or oversized length closes with 1009 before anything is buffered", async () => {
    for (const write of [
      (socket: net.Socket): unknown =>
        socket.write(
          Buffer.concat([Buffer.from([0x81, 127]), Buffer.from("7fffffffffffffff", "hex")]),
        ),
      (socket: net.Socket): unknown => socket.write(header(0x2, 16 * 1024 * 1024 + 1)),
    ]) {
      const outcome = await scenario(write);
      expect(outcome.opened).toBe(true);
      expect(closeCodeSent(outcome)).toBe(1009);
    }
  });

  test("reserved bits, an unknown opcode, a split control frame or a stray continuation are protocol errors", async () => {
    for (const bytes of [
      Buffer.from([0xf1, 0x00]),
      Buffer.from([0x83, 0x00]),
      Buffer.from([0x09, 0x00]),
      Buffer.from([0x80, 0x00]),
    ]) {
      const outcome = await scenario((socket) => socket.write(bytes));
      expect(closeCodeSent(outcome)).toBe(1002);
    }
  });

  test("a ping inside a fragmented message is answered, and the message arrives whole", async () => {
    const outcome = await scenario((socket) => {
      socket.write(frame(0x1, Buffer.from("ab"), false));
      socket.write(frame(0x9, Buffer.from("p")));
      socket.write(frame(0x0, Buffer.from("cd"), true));
      setTimeout(() => socket.write(frame(0x8, Buffer.from([0x03, 0xe8]))), 100);
    });
    expect(outcome.messages).toEqual(["abcd"]);
    expect(
      outcome.sent.filter((item) => item.opcode === 0xa).map((item) => String(item.payload)),
    ).toEqual(["p"]);
    expect(outcome.close.code).toBe(1000);
  });

  test("a peer that never answers the close is closed after a few seconds", async () => {
    const started = Date.now();
    let fromClient = Buffer.alloc(0);
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (chunk) => {
        const key = /sec-websocket-key: (\S+)/i.exec(chunk.toString("latin1"))?.[1] ?? "";
        const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.on("data", (more: Buffer) => {
          fromClient = Buffer.concat([fromClient, more]);
        });
        socket.write(Buffer.from([0xf1, 0x00]));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new LinkSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/`, {
      verify: { kind: "plain" },
    });
    const close = await new Promise<number>((resolve) =>
      client.addEventListener("close", (event) => resolve((event as CloseEvent).code)),
    );
    expect(close).toBe(1002);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(clientFrames(fromClient)[0]?.payload.readUInt16BE(0)).toBe(1002);
  });

  test("a 4 MiB text message in small writes arrives whole", async () => {
    const total = 4 * 1024 * 1024;
    const outcome = await scenario(async (socket) => {
      socket.write(header(0x1, total));
      const chunk = Buffer.alloc(16 * 1024, 0x61);
      for (let sent = 0; sent < total; sent += chunk.length) {
        if (!socket.write(chunk)) await new Promise((resolve) => socket.once("drain", resolve));
      }
      socket.write(frame(0x8, Buffer.from([0x03, 0xe8])));
    });
    expect(outcome.messages.map((message) => message.length)).toEqual([total]);
    expect(outcome.close.code).toBe(1000);
  });

  test("a server that doesn't answer the upgrade in time fails the connection", async () => {
    const server = net.createServer((socket) => socket.on("error", () => {}));
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new LinkSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/`, {
      verify: { kind: "plain" },
      connectTimeoutMs: 300,
    });
    let opened = false;
    client.addEventListener("open", () => {
      opened = true;
    });
    const reason = await new Promise<string>((resolve) =>
      client.addEventListener("close", (event) => resolve((event as CloseEvent).reason)),
    );
    expect(opened).toBe(false);
    expect(reason).toContain("took too long");
  });
});

describe("flow control (C4-07)", () => {
  test("a peer that stops reading: send() says so, memory stays bounded, and drain follows", async () => {
    // probe-backpressure2: 188 MiB of sends all "succeeded" and RSS grew by 559 MiB.
    let serverSide: net.Socket | null = null;
    let received = 0;
    const server = net.createServer((socket) => {
      serverSide = socket;
      socket.on("error", () => {});
      socket.once("data", (chunk) => {
        const key = /sec-websocket-key: (\S+)/i.exec(chunk.toString("latin1"))?.[1] ?? "";
        const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.pause();
        socket.on("data", (more) => {
          received += more.length;
        });
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new LinkSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/`, {
      verify: { kind: "plain" },
    });
    await new Promise((resolve) => client.addEventListener("open", resolve));
    const chunk = "x".repeat(64 * 1024);
    let accepted = 0;
    let refusedAt = -1;
    for (let index = 0; index < 3000; index++) {
      if (!client.send(chunk)) {
        refusedAt = index;
        break;
      }
      accepted++;
    }
    // Back-pressure is signalled once the unsent bytes pass the high-water mark.
    expect(refusedAt).toBeGreaterThan(-1);
    expect(client.bufferedAmount).toBeGreaterThan(LINK_HIGH_WATER_BYTES);
    expect(client.bufferedAmount).toBeLessThan(LINK_HIGH_WATER_BYTES + 2 * chunk.length);
    // The peer reads again: the queue empties and `drain` says so.
    const drained = new Promise((resolve) => client.addEventListener("drain", resolve));
    (serverSide as net.Socket | null)?.resume();
    await drained;
    // Each 64 KiB frame: 2 bytes, a 64-bit length and a 4-byte mask ahead of the payload.
    const expected = (accepted + 1) * (chunk.length + 14);
    const deadline = Date.now() + 20_000;
    while (received < expected && Date.now() < deadline) await Bun.sleep(20);
    expect(received).toBe(expected);
    client.close();
  });

  test("a sender that ignores the signal is cut off at the cap instead of queueing without bound", async () => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (chunk) => {
        const key = /sec-websocket-key: (\S+)/i.exec(chunk.toString("latin1"))?.[1] ?? "";
        const accept = createHash("sha1").update(`${key}${GUID}`).digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        socket.pause();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new LinkSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}/`, {
      verify: { kind: "plain" },
    });
    await new Promise((resolve) => client.addEventListener("open", resolve));
    const closed = new Promise<{ code: number; reason: string }>((resolve) =>
      client.addEventListener("close", (event) => {
        const close = event as CloseEvent;
        resolve({ code: close.code, reason: close.reason });
      }),
    );
    const chunk = "x".repeat(64 * 1024);
    let peak = 0;
    for (let index = 0; index < 3000 && client.readyState === LinkSocket.OPEN; index++) {
      client.send(chunk);
      peak = Math.max(peak, client.bufferedAmount);
    }
    expect(peak).toBeLessThanOrEqual(LINK_MAX_BUFFERED_BYTES);
    expect(await closed).toMatchObject({ code: 1006, reason: "the control plane stopped reading" });
  });
});
