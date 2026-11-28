import tls from "node:tls";
import { peerProblem, tlsOptions, type Verify } from "./socket.ts";

/**
 * HTTP/1.1 requests to the control plane over an encrypted link (spec 31 "Remote runners are
 * always encrypted", C4-01, C4-03): the runner opens the TLS socket itself and writes nothing,
 * not even the request line, until the certificate on that very connection is accepted: one of
 * the pinned SHA-256 fingerprints (public authorities play no part), or, for a host name, a public
 * authority's certificate for exactly that name. Bun's fetch with `tls.ca` trusts every public
 * authority as well, and calls `checkServerIdentity` only after it has written the request, so a
 * certificate any public authority issued for any name would have received the credential or the
 * join token.
 *
 * One request per connection (`Connection: close`). The answer is a standard `Response` whose
 * body streams (large uploads and migration archives never sit in memory); reading it slowly
 * pauses the socket. An answer must give its length or come in chunks, so its end is known
 * without trusting the connection's close, and a body that stalls for a minute while it is read
 * stops the request (C4-17).
 */

const MAX_HEADER_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;
/** A body that brings no byte for this long, while it is being read, stops the request (C4-17). */
export const BODY_IDLE_TIMEOUT_MS = 60_000;
/** Queued body bytes above which the socket is paused until the reader catches up. */
const BODY_HIGH_WATER = 1024 * 1024;

export interface LinkTarget {
  /** An https:// origin. */
  url: string;
  /** How its certificate is checked: pinned (the current and next fingerprints), or authority. */
  verify: Exclude<Verify, { kind: "plain" }>;
  /** For tests: BODY_IDLE_TIMEOUT_MS. */
  idleTimeoutMs?: number;
}

function bodyBytes(body: RequestInit["body"]): Uint8Array {
  if (body === undefined || body === null) return new Uint8Array(0);
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error("A pinned request's body must be text or bytes.");
}

function abortError(signal: AbortSignal | null | undefined): Error {
  const reason = signal?.reason;
  return reason instanceof Error
    ? reason
    : new DOMException("The request was aborted.", "AbortError");
}

/** Decodes a chunked body (RFC 9112 7.1) as it arrives; trailers are read and dropped. */
class Dechunker {
  #state: "size" | "data" | "data-end" | "trailers" | "done" = "size";
  #left = 0;
  #pending: Buffer = Buffer.alloc(0);

  get done(): boolean {
    return this.#state === "done";
  }

  /** Feeds raw bytes; returns the body bytes they carry. Throws on a malformed body. */
  push(chunk: Buffer): Buffer[] {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    const out: Buffer[] = [];
    while (this.#pending.length > 0 && this.#state !== "done") {
      if (this.#state === "size" || this.#state === "trailers") {
        const end = this.#pending.indexOf("\r\n");
        if (end < 0) {
          if (this.#pending.length > 4096) throw new Error("A chunk header was too long.");
          break;
        }
        const line = this.#pending.subarray(0, end).toString("latin1");
        this.#pending = this.#pending.subarray(end + 2);
        if (this.#state === "trailers") {
          if (line === "") this.#state = "done";
          continue;
        }
        const size = /^([0-9a-fA-F]{1,12})(;.*)?$/.exec(line)?.[1];
        if (size === undefined) throw new Error("A chunk size wasn't readable.");
        this.#left = Number.parseInt(size, 16);
        this.#state = this.#left === 0 ? "trailers" : "data";
      } else if (this.#state === "data") {
        const take = Math.min(this.#left, this.#pending.length);
        out.push(this.#pending.subarray(0, take));
        this.#pending = this.#pending.subarray(take);
        this.#left -= take;
        if (this.#left === 0) this.#state = "data-end";
      } else {
        if (this.#pending.length < 2) break;
        if (this.#pending[0] !== 0x0d || this.#pending[1] !== 0x0a) {
          throw new Error("A chunk didn't end where its size said.");
        }
        this.#pending = this.#pending.subarray(2);
        this.#state = "size";
      }
    }
    return out;
  }
}

/** A request to the link's address; resolves once the answer's headers are in. */
export function linkRequest(
  target: LinkTarget,
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const origin = new URL(target.url);
  const url = new URL(String(input), origin);
  if (url.origin !== origin.origin || url.protocol !== "https:") {
    return Promise.reject(new Error(`${url.origin} isn't the link's address ${origin.origin}.`));
  }
  if (target.verify.kind === "pinned" && target.verify.fingerprints.length === 0) {
    return Promise.reject(new Error("A pinned address needs a fingerprint."));
  }
  const signal = init.signal ?? null;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  let body: Uint8Array;
  try {
    body = bodyBytes(init.body);
  } catch (error) {
    return Promise.reject(error);
  }
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.delete("connection");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("host");
  const head = [
    `${method} ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    "Connection: close",
    ...(body.length > 0 || method === "POST" || method === "PUT"
      ? [`Content-Length: ${body.length}`]
      : []),
    ...[...headers.entries()].map(([name, value]) => `${name}: ${value}`),
    "",
    "",
  ].join("\r\n");
  if (/[\r\n]/.test(`${url.pathname}${url.search}`)) {
    return Promise.reject(new Error("The request's path isn't valid."));
  }
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  const port = Number(origin.port || 443);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let finished = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const stopIdle = () => {
      if (idle) clearTimeout(idle);
      idle = null;
    };
    // While the body is being read (not while the reader holds it paused), every byte resets it.
    const armIdle = () => {
      stopIdle();
      if (finished) return;
      const ms = target.idleTimeoutMs ?? BODY_IDLE_TIMEOUT_MS;
      idle = setTimeout(
        () =>
          fail(
            new Error(
              `${url.host} sent nothing for ${Math.round(ms / 1000)} seconds in the middle of its answer, so the request stopped.`,
            ),
          ),
        ms,
      );
    };
    const fail = (error: Error) => {
      stopIdle();
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(error);
      } else if (controller && !finished) {
        finished = true;
        controller.error(error);
      }
    };
    const timer = setTimeout(
      () => fail(new Error(`Connecting to ${url.host} took too long.`)),
      CONNECT_TIMEOUT_MS,
    );
    const socket = tls.connect(tlsOptions(host, port, target.verify), () => {
      const problem = peerProblem(socket, host, url.host, target.verify);
      if (problem) {
        fail(problem);
        return;
      }
      socket.write(head);
      if (body.length > 0) socket.write(body);
    });
    const onAbort = () => fail(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("error", (error) => fail(error));

    let buffered: Buffer = Buffer.alloc(0);
    let parsed = false;
    let remaining: number | null = null;
    let dechunker: Dechunker | null = null;
    let noBody = false;

    const deliver = (bytes: Buffer) => {
      if (!controller || finished || bytes.length === 0) return;
      controller.enqueue(new Uint8Array(bytes));
      if ((controller.desiredSize ?? 1) <= 0) {
        socket.pause();
        stopIdle();
      }
    };
    const complete = () => {
      stopIdle();
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", onAbort);
      controller?.close();
      socket.destroy();
    };

    socket.on("data", (chunk: Buffer) => {
      if (!parsed) {
        buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
        const end = buffered.indexOf("\r\n\r\n");
        if (end < 0) {
          if (buffered.length > MAX_HEADER_BYTES)
            fail(new Error("The answer's headers were too long."));
          return;
        }
        const lines = buffered.subarray(0, end).toString("latin1").split("\r\n");
        const rest = buffered.subarray(end + 4);
        buffered = Buffer.alloc(0);
        const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? "");
        if (!status) {
          fail(new Error("The answer wasn't HTTP."));
          return;
        }
        const code = Number(status[1]);
        const answerHeaders = new Headers();
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(":");
          if (colon <= 0) continue;
          answerHeaders.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
        }
        if (code < 200) {
          // An interim answer (we never ask for 100-continue); the real one follows.
          buffered = rest;
          if (rest.length > 0) socket.emit("data", Buffer.alloc(0));
          return;
        }
        parsed = true;
        clearTimeout(timer);
        noBody = method === "HEAD" || code === 204 || code === 304;
        if (/\bchunked\b/i.test(answerHeaders.get("transfer-encoding") ?? "")) {
          dechunker = new Dechunker();
        } else if (answerHeaders.has("content-length")) {
          remaining = Number(answerHeaders.get("content-length"));
          if (!Number.isSafeInteger(remaining) || remaining < 0) {
            fail(new Error("The answer's length wasn't readable."));
            return;
          }
        } else if (!noBody) {
          // Its end would be only the connection closing, which someone on the path can fake
          // without the TLS stream's close_notify (RFC 9112 9.8). Nearzero's own server always
          // sends a length or chunks (C4-17).
          fail(
            new Error(
              "The answer had neither a length nor chunked encoding, so it couldn't be known to be complete.",
            ),
          );
          return;
        }
        const stream = new ReadableStream<Uint8Array>(
          {
            start(c) {
              controller = c;
            },
            pull() {
              if (finished) return;
              socket.resume();
              armIdle();
            },
            cancel() {
              finished = true;
              socket.destroy();
            },
          },
          { highWaterMark: BODY_HIGH_WATER, size: (piece) => piece?.byteLength ?? 0 },
        );
        settled = true;
        resolve(
          new Response(noBody ? null : stream, {
            status: code,
            statusText: status[2] ?? "",
            headers: answerHeaders,
          }),
        );
        if (noBody || remaining === 0) {
          complete();
          return;
        }
        armIdle();
        chunk = rest;
        if (chunk.length === 0) return;
      }
      if (!socket.isPaused()) armIdle();
      try {
        if (dechunker) {
          for (const piece of dechunker.push(chunk)) deliver(piece);
          if (dechunker.done) complete();
        } else if (remaining !== null) {
          const piece = chunk.subarray(0, remaining);
          remaining -= piece.length;
          deliver(piece);
          if (remaining === 0) complete();
        }
      } catch (error) {
        fail(error as Error);
      }
    });
    socket.on("end", () => {
      if (!parsed) {
        fail(new Error("The connection closed before an answer."));
      } else if ((remaining !== null && remaining > 0) || (dechunker && !dechunker.done)) {
        fail(new Error("The connection closed before the whole answer arrived."));
      } else {
        complete();
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      if (!settled) fail(new Error("The connection closed before an answer."));
      else if (!finished) fail(new Error("The connection closed before the whole answer arrived."));
    });
  });
}
