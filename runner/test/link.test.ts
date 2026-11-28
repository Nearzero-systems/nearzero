import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { createLinkCertificate } from "../../apps/control/src/runners/link-certificate.ts";
import { readConfig } from "../src/config.ts";
import { linkRequest } from "../src/link/http.ts";
import {
  type ControlLink,
  isHostInternalLink,
  linkFetch,
  linkKind,
  normalizeFingerprint,
  openLinkSocket,
  readSavedLinks,
  remoteLinkProblem,
  SAVED_LINK_FILE,
  saveLinks,
} from "../src/link/link.ts";
import { LinkSocket } from "../src/link/socket.ts";
import { joinArguments } from "../src/main.ts";

/**
 * The runner's side of the encrypted link (spec 31 "Remote runners are always encrypted", G3-01):
 * the WebSocket and every request reach the control plane only over a certificate checked before
 * anything is sent. Pinned: exactly the certificate whose SHA-256 the runner was given. By
 * authority: a public authority and the hostname, which Bun's own WebSocket client doesn't check.
 */

const ours = createLinkCertificate(["127.0.0.1"]);
const someoneElse = createLinkCertificate(["127.0.0.1"]);
const BIG = "x".repeat(200_000);

/** Every request that reached the server, with its headers: none must arrive after a refusal. */
const requests: { path: string; authorization: string | null }[] = [];
const closes: number[] = [];
let tlsServer: ReturnType<typeof serve>;
let plainServer: ReturnType<typeof serve>;
let directory: string;

function serve(port: number, tls?: { cert: string; key: string }) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    ...(tls ? { tls } : {}),
    fetch(request, server) {
      const url = new URL(request.url);
      requests.push({ path: url.pathname, authorization: request.headers.get("authorization") });
      if (url.pathname === "/api/v1/runner/connect" && server.upgrade(request)) return undefined;
      return Response.json({ ok: true });
    },
    websocket: {
      open(ws) {
        ws.send("hello from the control plane");
      },
      message(ws, message) {
        const text = String(message);
        if (text === "close please") ws.close(4002, "rotated");
        else if (text === "ping me") ws.ping("p");
        else ws.send(text);
      },
      close(_ws, code) {
        closes.push(code);
      },
    },
  });
}

beforeAll(async () => {
  tlsServer = serve(0, { cert: ours.certificate, key: ours.key });
  plainServer = serve(0);
  directory = await mkdtemp(join(tmpdir(), "nz-link-"));
});

afterAll(async () => {
  tlsServer.stop(true);
  plainServer.stop(true);
  await rm(directory, { recursive: true, force: true });
});

function pinned(fingerprint: string): ControlLink {
  return { url: `https://127.0.0.1:${tlsServer.port}`, fingerprint };
}

function events(socket: LinkSocket) {
  const messages: string[] = [];
  const opened = new Promise<void>((resolve) => socket.addEventListener("open", () => resolve()));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.addEventListener("close", (event) => {
      const close = event as CloseEvent;
      resolve({ code: close.code, reason: close.reason });
    }),
  );
  const errors: string[] = [];
  socket.addEventListener("error", (event) => {
    errors.push((event as unknown as { message: string }).message);
  });
  socket.addEventListener("message", (event) =>
    messages.push(String((event as MessageEvent).data)),
  );
  return { messages, opened, closed, errors };
}

/**
 * The message a request failed with. (Bun 1.3.10's `expect(promise).rejects` crashes the test
 * process here after an earlier request succeeded, so the error is caught by hand.)
 */
async function failure(promise: Promise<unknown>): Promise<string> {
  const outcome = await promise.then(
    () => null,
    (error: unknown) => error as Error,
  );
  if (!outcome) throw new Error("the request succeeded");
  return outcome.message;
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("the WebSocket over a pinned certificate", () => {
  test("opens with the right fingerprint, and carries small and large messages both ways", async () => {
    const socket = openLinkSocket(pinned(ours.fingerprint), "/api/v1/runner/connect", {
      authorization: "Bearer nzr1.secret",
    });
    const seen = events(socket);
    await seen.opened;
    await until(() => seen.messages.length === 1);
    expect(seen.messages[0]).toBe("hello from the control plane");
    socket.send("short");
    socket.send("m".repeat(1_000));
    socket.send(BIG);
    await until(() => seen.messages.length === 4);
    expect(seen.messages.slice(1)).toEqual(["short", "m".repeat(1_000), BIG]);
    expect(requests.at(-1)).toEqual({
      path: "/api/v1/runner/connect",
      authorization: "Bearer nzr1.secret",
    });
    socket.send("ping me");
    socket.send("after the ping");
    await until(() => seen.messages.length === 5);
    socket.close(4006, "moving");
    expect((await seen.closed).code).toBe(4006);
    await until(() => closes.includes(4006));
  });

  test("a different certificate is refused before the request, and its credential, is sent", async () => {
    const before = requests.length;
    const socket = openLinkSocket(pinned(someoneElse.fingerprint), "/api/v1/runner/connect", {
      authorization: "Bearer nzr1.secret",
    });
    const seen = events(socket);
    const closed = await seen.closed;
    expect(closed.reason).toContain("isn't Nearzero's");
    expect(seen.errors.join(" ")).toContain("fingerprint doesn't match");
    await Bun.sleep(100);
    expect(requests.length).toBe(before);
  });

  test("checked by authority, a self-signed certificate is refused before anything is sent", async () => {
    const before = requests.length;
    // By name (authority checks never take an IP address, C4-03).
    const socket = new LinkSocket(`wss://localhost:${tlsServer.port}/api/v1/runner/connect`, {
      headers: { authorization: "Bearer nzr1.secret" },
      verify: { kind: "authority" },
    });
    const seen = events(socket);
    const closed = await seen.closed;
    expect(closed.code).not.toBe(1000);
    await Bun.sleep(100);
    expect(requests.length).toBe(before);
  });

  test("the server closing with a code reaches the runner with that code", async () => {
    const socket = openLinkSocket(pinned(ours.fingerprint), "/api/v1/runner/connect", {});
    const seen = events(socket);
    await seen.opened;
    socket.send("close please");
    expect(await seen.closed).toEqual({ code: 4002, reason: "rotated" });
  });

  test("plain WebSocket on the Nearzero host's private network", async () => {
    const socket = openLinkSocket(
      { url: `http://127.0.0.1:${plainServer.port}`, fingerprint: null },
      "/api/v1/runner/connect",
      {},
    );
    const seen = events(socket);
    await seen.opened;
    socket.send("plain");
    await until(() => seen.messages.length === 2);
    expect(seen.messages[1]).toBe("plain");
    socket.close();
    expect((await seen.closed).code).toBe(1000);
  });

  test("an answer that isn't a WebSocket upgrade fails the connection", async () => {
    const socket = openLinkSocket(pinned(ours.fingerprint), "/api/v1/runner/check", {});
    const seen = events(socket);
    const closed = await seen.closed;
    expect(closed.reason).toContain("answered 200");
  });

  test("a frame the server masks, or an oversized length, closes the link as a protocol error", async () => {
    // A raw server that upgrades and then sends a masked frame (servers must never mask).
    const raw = net.createServer((client) => {
      client.once("data", (data) => {
        const key = /Sec-WebSocket-Key: (\S+)/i.exec(String(data))?.[1] ?? "";
        const accept = new Bun.CryptoHasher("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        client.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        client.write(Buffer.from([0x81, 0x82, 1, 2, 3, 4, 0x69 ^ 1, 0x69 ^ 2]));
      });
      client.on("error", () => {});
    });
    await new Promise<void>((resolve) => raw.listen(0, "127.0.0.1", resolve));
    const port = (raw.address() as net.AddressInfo).port;
    const socket = openLinkSocket(
      { url: `http://127.0.0.1:${port}`, fingerprint: null },
      "/api/v1/runner/connect",
      {},
    );
    const seen = events(socket);
    await seen.opened;
    expect((await seen.closed).code).toBe(1002);
    expect(seen.messages).toEqual([]);
    raw.close();
  });
});

describe("requests over a pinned certificate", () => {
  test("fetch works with the right fingerprint and refuses another certificate", async () => {
    const good = await linkFetch(pinned(ours.fingerprint))(
      `https://127.0.0.1:${tlsServer.port}/api/v1/runner/check`,
      { headers: { authorization: "Bearer nzr1.secret" } },
    );
    expect(good.status).toBe(200);
    expect(await good.json()).toEqual({ ok: true });
    const before = requests.length;
    expect(
      await failure(
        linkFetch(pinned(someoneElse.fingerprint))(
          `https://127.0.0.1:${tlsServer.port}/api/v1/runner/check`,
          { headers: { authorization: "Bearer nzr1.secret" } },
        ),
      ),
    ).toContain("isn't Nearzero's");
    expect(requests.length).toBe(before);
  });

  test("a server that changes its certificate after a good request is refused", async () => {
    const port = tlsServer.port as number;
    const link = pinned(ours.fingerprint);
    expect((await linkFetch(link)(`https://127.0.0.1:${port}/api/v1/runner/check`)).status).toBe(
      200,
    );
    tlsServer.stop(true);
    const impostor = serve(port, { cert: someoneElse.certificate, key: someoneElse.key });
    const before = requests.length;
    expect(
      await failure(
        linkFetch(link)(`https://127.0.0.1:${port}/api/v1/runner/check`, {
          headers: { authorization: "Bearer nzr1.secret" },
        }),
      ),
    ).toContain("isn't Nearzero's");
    const socket = openLinkSocket(link, "/api/v1/runner/connect", {
      authorization: "Bearer nzr1.secret",
    });
    await events(socket).closed;
    expect(requests.length).toBe(before);
    impostor.stop(true);
    tlsServer = serve(port, { cert: ours.certificate, key: ours.key });
  });

  test("answers stream: a large body, chunked or with a length, read slowly, arrives whole", async () => {
    const big = new Uint8Array(5 * 1024 * 1024).map((_, index) => index % 251);
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: ours.certificate, key: ours.key },
      fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/length") return new Response(big);
        if (path === "/empty") return new Response(null, { status: 204 });
        if (path === "/post")
          return request.text().then((text) => new Response(text.toUpperCase()));
        // Chunked: a stream of pieces.
        let at = 0;
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (at >= big.length) {
                controller.close();
                return;
              }
              controller.enqueue(big.subarray(at, at + 70_000));
              at += 70_000;
            },
          }),
        );
      },
    });
    const link = { url: `https://127.0.0.1:${server.port}`, fingerprint: ours.fingerprint };
    for (const path of ["/length", "/chunked"]) {
      const response = await linkFetch(link)(`${link.url}${path}`);
      expect(response.status).toBe(200);
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      const parts: Uint8Array[] = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parts.push(value);
        if (parts.length % 10 === 0) await Bun.sleep(5);
      }
      expect(Buffer.concat(parts).equals(Buffer.from(big))).toBe(true);
    }
    expect((await linkFetch(link)(`${link.url}/empty`)).status).toBe(204);
    const posted = await linkFetch(link)(`${link.url}/post`, { method: "POST", body: "hello" });
    expect(await posted.text()).toBe("HELLO");
    // Another origin is never sent to with this link's pin.
    expect(await failure(linkFetch(link)("https://example.com/api/v1/runner/check"))).toContain(
      "isn't the link's address",
    );
    const aborted = new AbortController();
    aborted.abort();
    expect(
      await failure(linkFetch(link)(`${link.url}/length`, { signal: aborted.signal })),
    ).toContain("abort");
    server.stop(true);
  });
});

describe("answers whose end can't be trusted (C4-17)", () => {
  /** A pinned TLS server that answers every request with `answer`, then does what `then` says. */
  async function answering(answer: string, then: (socket: tls.TLSSocket) => void = () => {}) {
    const server = tls.createServer({ cert: ours.certificate, key: ours.key }, (socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        socket.write(answer);
        then(socket);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as net.AddressInfo).port;
    return { server, link: { url: `https://127.0.0.1:${port}`, fingerprint: ours.fingerprint } };
  }

  test("an answer with neither a length nor chunks is refused, even one cut off by a FIN", async () => {
    // recheck-fin: an on-path FIN (no close_notify) ended a close-delimited body, which was taken
    // as complete. Nearzero's server always sends a length or chunks.
    const { server, link } = await answering(
      "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\n\r\npart one, ",
      (socket) => setTimeout(() => socket.end(), 100),
    );
    expect(await failure(linkFetch(link)(`${link.url}/x`))).toContain(
      "neither a length nor chunked",
    );
    server.close();
  });

  test("a body cut short of its length or its last chunk is refused", async () => {
    for (const answer of [
      "HTTP/1.1 200 OK\r\ncontent-length: 20\r\n\r\npart one, ",
      "HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n9\r\npart one,\r\n",
    ]) {
      const { server, link } = await answering(answer, (socket) =>
        setTimeout(() => socket.destroy(), 100),
      );
      const response = await linkFetch(link)(`${link.url}/x`);
      expect(await failure(response.text())).toContain("before the whole answer arrived");
      server.close();
    }
  });

  test("a body that stalls stops the request after the idle time, however long the caller waits", async () => {
    const { server, link } = await answering(
      "HTTP/1.1 200 OK\r\ncontent-length: 1000\r\n\r\nthe first bytes",
    );
    const response = await linkRequest(
      {
        url: link.url,
        verify: { kind: "pinned", fingerprints: [ours.fingerprint] },
        idleTimeoutMs: 300,
      },
      `${link.url}/x`,
    );
    const started = Date.now();
    expect(await failure(response.text())).toContain("sent nothing for");
    expect(Date.now() - started).toBeLessThan(5_000);
    server.close();
  });
});

describe("which addresses a runner uses (spec 31, C4-02 to C4-04)", () => {
  test("pinned, a host name by authority, plain only on the host, never an IP without its pin", () => {
    expect(linkKind({ url: "https://203.0.113.10:3443", fingerprint: ours.fingerprint })).toEqual({
      kind: "pinned",
    });
    expect(linkKind({ url: "https://nz.example.com", fingerprint: null })).toEqual({
      kind: "authority",
    });
    expect(linkKind({ url: "https://203.0.113.10:3443", fingerprint: null }).kind).toBe("refused");
    expect(linkKind({ url: "https://[2001:db8::1]", fingerprint: null }).kind).toBe("refused");
    expect(remoteLinkProblem({ url: "http://203.0.113.10:3000", fingerprint: null })).toContain(
      "plain http://",
    );
    expect(remoteLinkProblem({ url: "https://nz.example.com", fingerprint: null })).toBeNull();
    expect(isHostInternalLink({ url: "http://nearzero-control:3000", fingerprint: null })).toBe(
      true,
    );
    // Loopback isn't the host's private network: only tests run a runner that way (C4-16).
    for (const url of ["http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000"]) {
      expect(isHostInternalLink({ url, fingerprint: null })).toBe(false);
    }
    expect(isHostInternalLink({ url: "http://nz.example.com:3000", fingerprint: null })).toBe(
      false,
    );
    expect(isHostInternalLink({ url: "http://203.0.113.10:3000", fingerprint: null })).toBe(false);
    // Authority checks are never asked for an IP address: the socket refuses to be made.
    expect(
      () =>
        new LinkSocket("wss://127.0.0.1:1/api/v1/runner/connect", {
          verify: { kind: "authority" },
        }),
    ).toThrow("IP address");
    expect(
      () =>
        new LinkSocket("wss://127.0.0.1:1/api/v1/runner/connect", {
          verify: { kind: "pinned", fingerprints: [] },
        }),
    ).toThrow("fingerprint");
  });
});

describe("fingerprints, settings and the saved address", () => {
  test("the forms people paste are all read as the same fingerprint", () => {
    const hex = ours.fingerprint;
    const colons = hex.toUpperCase().match(/../g)?.join(":");
    expect(normalizeFingerprint(`sha256:${hex}`)).toBe(hex);
    expect(normalizeFingerprint(colons)).toBe(hex);
    expect(normalizeFingerprint(`SHA256=${colons}`)).toBe(hex);
    expect(normalizeFingerprint("sha256:abc")).toBeNull();
  });

  test("NEARZERO_CONTROL_FINGERPRINT pins an https:// address and is refused with http://", () => {
    const good = readConfig({
      NEARZERO_CONTROL_URL: "https://203.0.113.10:3443",
      NEARZERO_CONTROL_FINGERPRINT: `sha256:${ours.fingerprint}`,
    });
    expect(good.ok && good.config.controlFingerprint).toBe(ours.fingerprint);
    expect(good.ok && good.config.allowPlain).toBe(false);
    const plain = readConfig({
      NEARZERO_CONTROL_URL: "http://203.0.113.10:3000",
      NEARZERO_CONTROL_FINGERPRINT: ours.fingerprint,
    });
    expect(plain.ok).toBe(false);
    const broken = readConfig({
      NEARZERO_CONTROL_URL: "https://203.0.113.10:3443",
      NEARZERO_CONTROL_FINGERPRINT: "nope",
    });
    expect(!broken.ok && broken.problems.join(" ")).toContain("SHA-256 fingerprint");
  });

  test("C4-02, C4-04, C4-16: a plain address is refused, except the Nearzero host's own", async () => {
    const handoff = await mkdtemp(join(tmpdir(), "nz-handoff-"));
    for (const url of [
      "http://203.0.113.10:3000",
      "http://nz.example.com",
      "http://localhost:3000",
      "http://127.0.0.1:3000",
    ]) {
      const result = readConfig({
        NEARZERO_CONTROL_URL: url,
        NEARZERO_RUNNER_CONTAINERIZED: "true",
        NEARZERO_RUNNER_HANDOFF_DIR: handoff,
      });
      expect([url, !result.ok && result.problems.join(" ")]).toEqual([
        url,
        expect.stringContaining("plain http://"),
      ]);
    }
    // The Nearzero host's runner: in its container, with the hand-off folder it really has, on
    // the host's private network.
    const host = readConfig({
      NEARZERO_CONTROL_URL: "http://nearzero-control:3000",
      NEARZERO_RUNNER_CONTAINERIZED: "true",
      NEARZERO_RUNNER_HANDOFF_DIR: handoff,
    });
    expect(host.ok && host.config.allowPlain).toBe(true);
    // The same name otherwise is a remote runner: refused. Without the folder, with a folder
    // that isn't there, or outside a container (setup writes NEARZERO_RUNNER_CONTAINERIZED=false).
    for (const env of [
      { NEARZERO_RUNNER_CONTAINERIZED: "true" },
      { NEARZERO_RUNNER_CONTAINERIZED: "true", NEARZERO_RUNNER_HANDOFF_DIR: "/does/not/exist" },
      { NEARZERO_RUNNER_CONTAINERIZED: "false", NEARZERO_RUNNER_HANDOFF_DIR: handoff },
      { NEARZERO_RUNNER_HANDOFF_DIR: handoff },
    ]) {
      const result = readConfig({ NEARZERO_CONTROL_URL: "http://nearzero-control:3000", ...env });
      expect([env, result.ok]).toEqual([env, false]);
    }
    await rm(handoff, { recursive: true, force: true });
  });

  test("C4-03: an https:// IP address without a fingerprint is refused", () => {
    for (const url of ["https://203.0.113.10:3443", "https://[2001:db8::1]:3443"]) {
      const result = readConfig({ NEARZERO_CONTROL_URL: url });
      expect(!result.ok && result.problems.join(" ")).toContain("IP address");
    }
    expect(readConfig({ NEARZERO_CONTROL_URL: "https://nz.example.com" }).ok).toBe(true);
  });

  test("C4-06: the pinned fallback setup writes, both settings or neither", () => {
    const both = readConfig({
      NEARZERO_CONTROL_URL: "https://nz.example.com",
      NEARZERO_CONTROL_FALLBACK_URL: "https://203.0.113.10:3443",
      NEARZERO_CONTROL_FALLBACK_FINGERPRINT: `sha256:${ours.fingerprint}`,
    });
    expect(both.ok && both.config.controlFallback).toEqual({
      url: "https://203.0.113.10:3443",
      fingerprint: ours.fingerprint,
    });
    for (const half of [
      { NEARZERO_CONTROL_FALLBACK_URL: "https://203.0.113.10:3443" },
      { NEARZERO_CONTROL_FALLBACK_FINGERPRINT: `sha256:${ours.fingerprint}` },
      {
        NEARZERO_CONTROL_FALLBACK_URL: "http://203.0.113.10:3000",
        NEARZERO_CONTROL_FALLBACK_FINGERPRINT: `sha256:${ours.fingerprint}`,
      },
    ]) {
      const result = readConfig({ NEARZERO_CONTROL_URL: "https://nz.example.com", ...half });
      expect(!result.ok && result.problems.join(" ")).toContain("go together");
    }
  });

  test("the join command's --fingerprint, and what it refuses (C4-04)", () => {
    expect(
      joinArguments(["https://203.0.113.10:3443", "--fingerprint", `sha256:${ours.fingerprint}`]),
    ).toEqual({
      controlUrl: "https://203.0.113.10:3443",
      fingerprint: `sha256:${ours.fingerprint}`,
    });
    expect(joinArguments(["https://x.example", "nzj1.a.b"])).toEqual({
      controlUrl: "https://x.example",
      token: "nzj1.a.b",
    });
    expect(joinArguments(["https://x.example", "--fingerprint"])).toHaveProperty("problem");
    // An empty --fingerprint= would have turned a pinned join into authority checks on an IP.
    expect(joinArguments(["https://203.0.113.10:3443", "--fingerprint="])).toHaveProperty(
      "problem",
    );
    expect(joinArguments(["https://203.0.113.10:3443", "--fingerprint=  "])).toHaveProperty(
      "problem",
    );
    // A server joins only over https://.
    const plain = joinArguments(["http://203.0.113.10:3000", "nzj1.a.b"]);
    expect(plain).toHaveProperty("problem");
    expect((plain as { problem: string }).problem).toContain("https://");
  });

  test("the saved addresses are private, and yield to new settings (C4-12)", async () => {
    const configured = {
      link: { url: "https://nz.example.com", fingerprint: null },
      fallback: null,
    };
    // The fallback keeps the next fingerprint too, while the pair is replaced (C4-10).
    const fallback = { ...pinned(ours.fingerprint), nextFingerprint: someoneElse.fingerprint };
    await saveLinks(
      directory,
      { link: pinned(ours.fingerprint), fallback, retired: ["ab".repeat(32)] },
      configured,
    );
    expect((await stat(join(directory, SAVED_LINK_FILE))).mode & 0o777).toBe(0o600);
    expect(await readSavedLinks(directory, configured)).toEqual({
      link: pinned(ours.fingerprint),
      fallback,
      retired: ["ab".repeat(32)],
    });
    // Setup ran again: another address, or the same one with another fallback. Its settings win;
    // only the retired fingerprints are kept.
    for (const settings of [
      { link: { url: "https://other.example.com", fingerprint: null }, fallback: null },
      { ...configured, fallback: pinned(someoneElse.fingerprint) },
    ]) {
      expect(await readSavedLinks(directory, settings)).toEqual({
        link: null,
        fallback: null,
        retired: ["ab".repeat(32)],
      });
    }
    // A fingerprint setup now writes is setup's newest word, and no longer retired.
    expect(
      await readSavedLinks(directory, {
        link: { url: "https://203.0.113.10:3443", fingerprint: "ab".repeat(32) },
        fallback: null,
      }),
    ).toEqual({ link: null, fallback: null, retired: [] });
    // Never a plain address, an IP address without its pin, or an unpinned fallback; nothing broken.
    const none = { link: { url: "", fingerprint: null }, fallback: null };
    for (const saved of [
      { url: "http://x", fingerprint: null, from: "" },
      { url: "https://203.0.113.66:3443", fingerprint: null, from: "" },
    ]) {
      await writeFile(join(directory, SAVED_LINK_FILE), JSON.stringify(saved));
      expect(await readSavedLinks(directory, none)).toEqual({
        link: null,
        fallback: null,
        retired: [],
      });
    }
    await writeFile(
      join(directory, SAVED_LINK_FILE),
      JSON.stringify({
        url: "https://nz.example.com",
        fingerprint: null,
        fallback: { url: "https://nz.example.com", fingerprint: null },
        from: "",
      }),
    );
    expect(await readSavedLinks(directory, none)).toEqual({
      link: { url: "https://nz.example.com", fingerprint: null },
      fallback: null,
      retired: [],
    });
    await writeFile(join(directory, SAVED_LINK_FILE), "{not json");
    expect(await readSavedLinks(directory, none)).toBeNull();
    expect(await readFile(join(directory, SAVED_LINK_FILE), "utf8")).toBe("{not json");
  });
});
