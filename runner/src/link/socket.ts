import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import tls from "node:tls";

/**
 * The runner's WebSocket client (RFC 6455), over a TCP or TLS socket it opens itself so that the
 * server's certificate is checked before a single byte of the request (which carries the runner's
 * credential) is written. Bun's built-in client doesn't do that: with `tls.ca` it still trusts
 * every public authority and checks no hostname (seen with Bun 1.3.10), so a certificate for any
 * name, from any public authority, would pass.
 *
 * It offers the part of the browser `WebSocket` interface the session uses: `readyState`,
 * `send(text)`, `close(code, reason)`, `bufferedAmount`, and `open`, `message`, `close`, `error`
 * and `drain` (the queue emptied after `send` returned false) events.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
/** The control plane sends frames of up to 4 MB (apps/control/src/runners/sockets.ts). */
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
const CLOSE_WAIT_MS = 3_000;

export type Verify =
  /** Plain TCP (the Nearzero host's private network only). */
  | { kind: "plain" }
  /**
   * TLS checked against public authorities and the hostname, as a browser would. Only for host
   * names: an IP address is refused here, since Bun's TLS client checks no IP (C4-03).
   */
  | { kind: "authority" }
  /** TLS whose certificate must have one of these SHA-256 (DER), whoever signed it. */
  | { kind: "pinned"; fingerprints: readonly string[] };

/** What the runner says when the certificate at a pinned address isn't Nearzero's. */
export function pinMismatchMessage(host: string): string {
  return `${host} answered with a certificate that isn't Nearzero's (its SHA-256 fingerprint doesn't match the one this runner was given), so the runner sent nothing there. Someone may be between this server and Nearzero, or Nearzero's link certificate was replaced: run setup again on the server.`;
}

/** TLS options for a checked connection: SNI only for names, TLS 1.3 when pinned. */
export function tlsOptions(host: string, port: number, verify: Exclude<Verify, { kind: "plain" }>) {
  return {
    host,
    port,
    // SNI is a name, never an address (RFC 6066).
    ...(net.isIP(host) ? {} : { servername: host }),
    ALPNProtocols: ["http/1.1"],
    // Pinned: the authority doesn't matter, only the exact certificate, checked by `peerProblem`
    // before anything is written; TLS 1.3, which has no renegotiation (asked for here, and
    // checked by `peerProblem`, since Bun's client ignores this setting). Otherwise the usual
    // chain and hostname checks, done again by `peerProblem`.
    rejectUnauthorized: verify.kind === "authority",
    ...(verify.kind === "pinned" ? { minVersion: "TLSv1.3" as const } : {}),
  };
}

/**
 * Why the certificate on a just-opened TLS connection isn't the one this runner accepts, or null.
 * Called before a single byte is written on that connection (C4-01, C4-03).
 */
export function peerProblem(
  socket: tls.TLSSocket,
  host: string,
  display: string,
  verify: Exclude<Verify, { kind: "plain" }>,
): Error | null {
  // Nothing on a link renegotiates (TLS 1.2's renegotiation could swap the certificate checked
  // here for another one mid-connection); TLS 1.3 has none at all.
  socket.disableRenegotiation?.();
  const peer = socket.getPeerCertificate(true);
  if (verify.kind === "pinned") {
    const raw = peer?.raw;
    if (!raw || !verify.fingerprints.includes(derFingerprint(raw))) {
      return new Error(pinMismatchMessage(display));
    }
    // TLS 1.3 only (C4-15): Bun's client ignores `minVersion`, so the version is checked here,
    // on the negotiated connection, before anything is written.
    const protocol = socket.getProtocol();
    return protocol === "TLSv1.3"
      ? null
      : new Error(
          `${display} answered over ${protocol ?? "an unknown TLS version"}, and a runner reaches Nearzero's own port only over TLS 1.3, so it sent nothing there.`,
        );
  }
  if (net.isIP(host)) {
    // Bun's TLS client checks no IP address against a certificate (C4-03).
    return new Error(
      `${display} is an IP address, which a runner reaches only with Nearzero's certificate fingerprint.`,
    );
  }
  if (!socket.authorized || !peer?.subject) {
    return new Error(
      `${display}'s certificate isn't one a public authority issued (${String(socket.authorizationError ?? "not trusted")}), so the runner sent nothing there.`,
    );
  }
  const mismatch = tls.checkServerIdentity(host, peer);
  return mismatch
    ? new Error(
        `${display}'s certificate isn't for that name (${mismatch.message}), so the runner sent nothing there.`,
      )
    : null;
}

/** Above this many bytes written but not yet sent, the session holds stream output back (C4-07). */
export const LINK_HIGH_WATER_BYTES = 4 * 1024 * 1024;
/**
 * The most the link ever holds unsent. A send past it drops the connection instead of queueing
 * (results wait in the session's outbox and streams resume from their offsets after the
 * reconnect), so a control plane that stops reading can't make the runner's memory grow (C4-07).
 */
export const LINK_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

/** Close codes a peer may send (RFC 6455 7.4, and 1012 to 1014 from IANA's registry). */
function validCloseCode(code: number): boolean {
  return (
    (code >= 1000 && code <= 1003) ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export interface LinkSocketOptions {
  headers?: Record<string, string>;
  verify: Verify;
  /** For tests: how long the connection and the upgrade may take. */
  connectTimeoutMs?: number;
}

/** SHA-256 of a peer certificate's DER bytes, as lowercase hex. */
export function derFingerprint(raw: Uint8Array): string {
  return createHash("sha256").update(raw).digest("hex");
}

export class LinkSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = 0;
  readonly url: string;
  #socket: net.Socket | null = null;
  #buffer: Buffer = Buffer.alloc(0);
  #upgraded = false;
  #key = randomBytes(16).toString("base64");
  #fragments: Buffer[] = [];
  #fragmentBytes = 0;
  #fragmentOpcode = 0;
  #closeSent = false;
  #closeEmitted = false;
  #closeTimer: ReturnType<typeof setTimeout> | null = null;
  #connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string, options: LinkSocketOptions) {
    super();
    this.url = url;
    const target = new URL(url);
    const secure = target.protocol === "wss:";
    if (!secure && target.protocol !== "ws:") throw new Error(`Not a WebSocket address: ${url}`);
    if (secure === (options.verify.kind === "plain")) {
      throw new Error(`${url} and the way its certificate is checked don't go together.`);
    }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    if (options.verify.kind === "authority" && net.isIP(host)) {
      throw new Error(
        `${target.host} is an IP address, which a runner reaches only with Nearzero's certificate fingerprint.`,
      );
    }
    if (options.verify.kind === "pinned" && options.verify.fingerprints.length === 0) {
      throw new Error(`${target.host} needs Nearzero's certificate fingerprint.`);
    }
    const port = Number(target.port || (secure ? 443 : 80));
    const path = `${target.pathname}${target.search}`;
    const request = [
      `GET ${path} HTTP/1.1`,
      `Host: ${target.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${this.#key}`,
      "Sec-WebSocket-Version: 13",
      ...Object.entries(options.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n");
    this.#connectTimer = setTimeout(
      () => this.#fail(new Error(`Connecting to ${target.host} took too long.`)),
      options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS,
    );
    const verify = options.verify;
    if (verify.kind === "plain") {
      const socket = net.connect({ host, port }, () => socket.write(request));
      this.#attach(socket);
    } else {
      const socket = tls.connect(tlsOptions(host, port, verify), () => {
        // Checked before anything is written, whatever the TLS library did on its own.
        const problem = peerProblem(socket, host, target.host, verify);
        if (problem) {
          this.#fail(problem);
          return;
        }
        socket.write(request);
      });
      this.#attach(socket);
    }
  }

  /** Bytes handed to the socket and not yet sent (C4-07). */
  get bufferedAmount(): number {
    return this.#socket?.writableLength ?? 0;
  }

  #attach(socket: net.Socket): void {
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on("drain", () => this.dispatchEvent(new Event("drain")));
    socket.on("data", (chunk: Buffer) => this.#receive(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => this.#emitClose(1006, "connection lost"));
  }

  #fail(error: Error): void {
    if (this.#closeEmitted) return;
    this.dispatchEvent(Object.assign(new Event("error"), { message: error.message, error }));
    this.#socket?.destroy();
    this.#emitClose(this.#upgraded ? 1006 : 1015, error.message);
  }

  #emitClose(code: number, reason: string): void {
    if (this.#closeEmitted) return;
    this.#closeEmitted = true;
    this.readyState = LinkSocket.CLOSED;
    if (this.#connectTimer) clearTimeout(this.#connectTimer);
    if (this.#closeTimer) clearTimeout(this.#closeTimer);
    this.#socket?.destroy();
    this.dispatchEvent(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }

  #receive(chunk: Buffer): void {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    if (!this.#upgraded) {
      const end = this.#buffer.indexOf("\r\n\r\n");
      if (end < 0) {
        if (this.#buffer.length > MAX_HEADER_BYTES)
          this.#fail(new Error("The answer was too long."));
        return;
      }
      const head = this.#buffer.subarray(0, end).toString("latin1");
      this.#buffer = this.#buffer.subarray(end + 4);
      const [status = "", ...lines] = head.split("\r\n");
      const headers = new Map<string, string>();
      for (const line of lines) {
        const colon = line.indexOf(":");
        if (colon > 0)
          headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
      }
      const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(status)?.[1] ?? 0);
      const expected = createHash("sha1").update(`${this.#key}${GUID}`).digest("base64");
      if (code !== 101) {
        this.#fail(
          new Error(
            `The control plane answered ${code || "something other than HTTP"} instead of opening the link.`,
          ),
        );
        return;
      }
      const connection = (headers.get("connection") ?? "")
        .toLowerCase()
        .split(",")
        .map((token) => token.trim());
      if (
        headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        !connection.includes("upgrade") ||
        headers.get("sec-websocket-accept") !== expected
      ) {
        this.#fail(new Error("The control plane's answer didn't open a WebSocket."));
        return;
      }
      // Neither was asked for (RFC 6455 4.1): an answer with one isn't for this client.
      if (headers.has("sec-websocket-extensions") || headers.has("sec-websocket-protocol")) {
        this.#fail(new Error("The control plane's answer named an extension or a subprotocol."));
        return;
      }
      this.#upgraded = true;
      this.readyState = LinkSocket.OPEN;
      if (this.#connectTimer) clearTimeout(this.#connectTimer);
      this.#connectTimer = null;
      this.dispatchEvent(new Event("open"));
    }
    this.#readFrames();
  }

  #readFrames(): void {
    while (!this.#closeEmitted) {
      const buffer = this.#buffer;
      if (buffer.length < 2) return;
      const first = buffer[0] ?? 0;
      const second = buffer[1] ?? 0;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      if ((first & 0x70) !== 0) {
        this.#protocolError("reserved bits set");
        return;
      }
      if ((second & 0x80) !== 0) {
        this.#protocolError("a server frame was masked");
        return;
      }
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          this.#tooBig();
          return;
        }
        length = Number(big);
        offset = 10;
      }
      if (length > MAX_MESSAGE_BYTES) {
        this.#tooBig();
        return;
      }
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      this.#buffer = buffer.subarray(offset + length);
      if (opcode >= 0x8) {
        if (!fin || length > 125) {
          this.#protocolError("a control frame was split or too long");
          return;
        }
        this.#control(opcode, Buffer.from(payload));
        continue;
      }
      if (opcode === 0x0) {
        if (this.#fragments.length === 0) {
          this.#protocolError("a continuation came first");
          return;
        }
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.#fragments.length > 0) {
          this.#protocolError("a new message began mid-message");
          return;
        }
        this.#fragmentOpcode = opcode;
      } else {
        this.#protocolError(`unknown opcode ${opcode}`);
        return;
      }
      this.#fragmentBytes += payload.length;
      if (this.#fragmentBytes > MAX_MESSAGE_BYTES) {
        this.#tooBig();
        return;
      }
      this.#fragments.push(Buffer.from(payload));
      if (!fin) continue;
      const message = Buffer.concat(this.#fragments);
      this.#fragments = [];
      this.#fragmentBytes = 0;
      if (this.readyState !== LinkSocket.OPEN) continue;
      let data: string | Buffer = message;
      if (this.#fragmentOpcode === 0x1) {
        try {
          data = strictUtf8.decode(message);
        } catch {
          // RFC 6455 8.1: text that isn't UTF-8 fails the connection.
          this.close(1007, "text that isn't UTF-8");
          return;
        }
      }
      this.dispatchEvent(new MessageEvent("message", { data }));
    }
  }

  #control(opcode: number, payload: Buffer): void {
    if (opcode === 0x9) {
      this.#write(0xa, payload);
      return;
    }
    if (opcode === 0xa) return;
    if (opcode !== 0x8) {
      this.#protocolError(`unknown control opcode ${opcode}`);
      return;
    }
    // RFC 6455 5.5.1 and 7.4: no code, or a code and a UTF-8 reason; never one of the codes
    // reserved for the endpoints themselves.
    if (payload.length === 1) {
      this.#protocolError("a close frame of one byte");
      return;
    }
    const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
    if (payload.length >= 2 && !validCloseCode(code)) {
      this.#protocolError(`close code ${code} isn't allowed`);
      return;
    }
    let reason = "";
    if (payload.length > 2) {
      try {
        reason = strictUtf8.decode(payload.subarray(2));
      } catch {
        this.close(1007, "a close reason that isn't UTF-8");
        return;
      }
    }
    if (!this.#closeSent) {
      this.#closeSent = true;
      this.#write(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
    }
    this.readyState = LinkSocket.CLOSING;
    this.#socket?.end();
    this.#emitClose(code, reason);
  }

  #protocolError(why: string): void {
    this.close(1002, why);
  }

  #tooBig(): void {
    this.close(1009, "message too big");
  }

  #write(opcode: number, payload: Uint8Array): boolean {
    const socket = this.#socket;
    if (!socket || socket.destroyed || !this.#upgraded) return false;
    const mask = randomBytes(4);
    const length = payload.length;
    const header =
      length < 126
        ? Buffer.from([0x80 | opcode, 0x80 | length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
          : (() => {
              const head = Buffer.alloc(10);
              head[0] = 0x80 | opcode;
              head[1] = 0x80 | 127;
              head.writeBigUInt64BE(BigInt(length), 2);
              return head;
            })();
    const masked = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index++) {
      masked[index] = (payload[index] ?? 0) ^ (mask[index & 3] ?? 0);
    }
    socket.write(Buffer.concat([header, mask, masked]));
    return true;
  }

  /**
   * Sends a text message. Returns false when the bytes not yet sent are above
   * LINK_HIGH_WATER_BYTES (a `drain` event follows once they're out). A message that would take
   * the queue past LINK_MAX_BUFFERED_BYTES isn't queued: the connection is dropped instead.
   */
  send(data: string): boolean {
    if (this.readyState !== LinkSocket.OPEN) throw new Error("The link isn't open.");
    const bytes = Buffer.from(data, "utf8");
    if (this.bufferedAmount + bytes.length > LINK_MAX_BUFFERED_BYTES) {
      this.#socket?.destroy();
      this.#emitClose(1006, "the control plane stopped reading");
      return false;
    }
    this.#write(0x1, bytes);
    return this.bufferedAmount <= LINK_HIGH_WATER_BYTES;
  }

  close(code = 1000, reason = ""): void {
    if (this.#closeEmitted) return;
    if (!this.#upgraded) {
      this.#socket?.destroy();
      this.#emitClose(code, reason);
      return;
    }
    if (!this.#closeSent) {
      this.#closeSent = true;
      const text = Buffer.from(reason, "utf8").subarray(0, 123);
      const payload = Buffer.alloc(2 + text.length);
      payload.writeUInt16BE(code, 0);
      text.copy(payload, 2);
      this.#write(0x8, payload);
    }
    this.readyState = LinkSocket.CLOSING;
    // The other side answers with its own close frame; don't wait for it forever.
    this.#closeTimer = setTimeout(() => this.#emitClose(code, reason), CLOSE_WAIT_MS);
    this.#closeTimer.unref?.();
  }
}
