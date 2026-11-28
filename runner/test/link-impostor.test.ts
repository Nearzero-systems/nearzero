import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
  createCertificate,
  createLinkCertificate,
  type LinkCertificate,
} from "../../apps/control/src/runners/link-certificate.ts";
import type { ControlLink } from "../src/link/link.ts";
import { CREDENTIAL, JOIN_TOKEN, type Kind } from "./support/link-client.ts";

/**
 * C4-01 and C4-03, at the TCP level: an impostor whose certificate a public authority issued
 * (a test authority the runner's process trusts through NODE_EXTRA_CA_CERTS, as it would trust
 * Let's Encrypt) gets not one application byte from the runner, for every request it makes:
 * the credential check, enrolling with a join token, downloading an upload, and the WebSocket.
 *
 * - Pinned: whatever authority signed it, only the pinned certificate is accepted, on the same
 *   connection that would carry the request. The first connection to the address reaches the
 *   real control plane and later ones the impostor, so both a first ("cold") request and one
 *   after a successful one ("warm") are tried: the old runner read the certificate on one
 *   connection and sent the request on another (probe-firstjoin), and with the pin known it
 *   sent the request before checking it (probe-tls, probe-tls2).
 * - By authority: a certificate for another name is refused before anything is sent, and an IP
 *   address is never reached that way at all (Bun's TLS client checks no IP, probe-ipcheck).
 */

setDefaultTimeout(120_000);

const SECRETS = [CREDENTIAL, JOIN_TOKEN];
let directory: string;
let authorityFile: string;
let authority: LinkCertificate & { commonName: string };
/** Nearzero's own link certificate, which the runner pins. */
const real = createLinkCertificate(["127.0.0.1"]);
let trusted: LinkCertificate;
let otherName: LinkCertificate;
let realServer: ReturnType<typeof Bun.serve>;
const realRequests: string[] = [];

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nz-impostor-"));
  const made = createCertificate({ commonName: "Test Public Root", authority: true });
  authority = { ...made, commonName: "Test Public Root" };
  const notAfter = new Date(Date.now() + 86_400_000);
  trusted = createCertificate({
    commonName: "localhost",
    addresses: ["127.0.0.1", "::1"],
    issuer: authority,
    notAfter,
  });
  otherName = createCertificate({ commonName: "wrong.example", issuer: authority, notAfter });
  authorityFile = join(directory, "authority.pem");
  await writeFile(authorityFile, authority.certificate);
  realServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: real.certificate, key: real.key },
    fetch(request, server) {
      const path = new URL(request.url).pathname;
      realRequests.push(path);
      if (path === "/api/v1/runner/connect" && server.upgrade(request, { data: undefined })) {
        return undefined;
      }
      if (path === "/api/v1/runner/enroll") {
        return Response.json({ error: { message: "used already" } }, { status: 401 });
      }
      return Response.json({ ok: true });
    },
    websocket: { message() {} },
  });
});

afterAll(async () => {
  realServer?.stop(true);
  await rm(directory, { recursive: true, force: true });
});

/** A TLS server that counts every application byte it receives, and answers 200 to any request. */
async function impostor(certificate: LinkCertificate, host = "127.0.0.1") {
  const seen = { handshakes: 0, bytes: 0, text: "" };
  const server = tls.createServer(
    { cert: certificate.certificate, key: certificate.key },
    (socket) => {
      seen.handshakes++;
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        seen.bytes += chunk.length;
        seen.text += chunk.toString("latin1");
        socket.end('HTTP/1.1 200 OK\r\ncontent-length: 11\r\nconnection: close\r\n\r\n{"ok":true}');
      });
    },
  );
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { seen, port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** An address whose first connection reaches the real control plane, and the rest `next`. */
async function forwarder(nextPort: number) {
  let connections = 0;
  const server = net.createServer((client) => {
    connections++;
    const upstream = net.connect(
      connections === 1 ? (realServer.port as number) : nextPort,
      "127.0.0.1",
    );
    client.pipe(upstream).pipe(client);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as net.AddressInfo).port, close: () => server.close() };
}

/** Runs the runner's requests in a process that trusts the test authority as a public one. */
async function runner(
  steps: { kind: Kind; link: ControlLink }[],
): Promise<{ ok: boolean; detail: string }[]> {
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "support", "link-client.ts"), JSON.stringify(steps)],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: authorityFile },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const lines = out.trim().split("\n").filter(Boolean);
  if (lines.length !== steps.length) throw new Error(`the runner process failed: ${err}${out}`);
  return lines.map((line) => JSON.parse(line));
}

const KINDS: Kind[] = ["check", "enroll", "upload", "socket"];

describe("a pinned address answered by a certificate a public authority issued (C4-01)", () => {
  for (const kind of KINDS) {
    test(`${kind}: cold and warm, the impostor gets not one byte`, async () => {
      const fake = await impostor(trusted);
      const address = await forwarder(fake.port);
      const link = { url: `https://127.0.0.1:${address.port}`, fingerprint: real.fingerprint };
      const before = realRequests.length;
      const [first, second, third] = await runner([
        { kind, link },
        { kind, link },
        { kind, link },
      ]);
      // Every connection after the first met the impostor: the handshake happened, and nothing
      // was written, the credential and the join token least of all.
      expect(fake.seen.bytes).toBe(0);
      for (const secret of SECRETS) expect(fake.seen.text).not.toContain(secret);
      expect(fake.seen.handshakes).toBeGreaterThanOrEqual(2);
      for (const later of [second, third]) {
        expect(later?.ok).toBe(false);
        expect(later?.detail).toContain("isn't Nearzero's");
      }
      // The first connection was the real control plane's: the request went there.
      expect(realRequests.length).toBe(before + 1);
      if (kind !== "enroll") expect(first?.ok).toBe(true);
      address.close();
      fake.close();
    });
  }

  test("the impostor is trusted in that process: by authority, with the right name, it is reached", async () => {
    // The control for the tests above: the authority really counts as a public one there.
    const fake = await impostor(trusted, "::");
    const [answer] = await runner([
      { kind: "check", link: { url: `https://localhost:${fake.port}`, fingerprint: null } },
    ]);
    expect(answer?.ok).toBe(true);
    expect(fake.seen.bytes).toBeGreaterThan(0);
    fake.close();
  });

  test("the next fingerprint, while the pair is replaced, is accepted as well (C4-10)", async () => {
    const next = createLinkCertificate(["127.0.0.1"]);
    const nextServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: next.certificate, key: next.key },
      fetch: () => Response.json({ ok: true }),
    });
    const url = `https://127.0.0.1:${nextServer.port}`;
    const [withNext, without] = await runner([
      {
        kind: "check",
        link: { url, fingerprint: real.fingerprint, nextFingerprint: next.fingerprint },
      },
      { kind: "check", link: { url, fingerprint: real.fingerprint } },
    ]);
    expect(withNext?.ok).toBe(true);
    expect(without?.ok).toBe(false);
    nextServer.stop(true);
  });
});

describe("by public authority (C4-03)", () => {
  for (const kind of KINDS) {
    test(`${kind}: a certificate for another name gets not one byte`, async () => {
      const fake = await impostor(otherName, "::");
      const [answer] = await runner([
        { kind, link: { url: `https://localhost:${fake.port}`, fingerprint: null } },
      ]);
      expect(answer?.ok).toBe(false);
      // Refused by the TLS library during the handshake, or by the runner's own check after it.
      expect(answer?.detail).toMatch(/isn't for that name|does not match certificate's altnames/);
      expect(fake.seen.handshakes).toBeGreaterThanOrEqual(1);
      expect(fake.seen.bytes).toBe(0);
      fake.close();
    });

    test(`${kind}: an IP address without a fingerprint is never reached, even with a valid certificate for it`, async () => {
      // `trusted` names 127.0.0.1 too, so a check that worked would have passed it: the runner
      // refuses before connecting, since Bun's TLS client checks no IP address.
      const fake = await impostor(trusted);
      const [answer] = await runner([
        { kind, link: { url: `https://127.0.0.1:${fake.port}`, fingerprint: null } },
      ]);
      expect(answer?.ok).toBe(false);
      expect(answer?.detail).toContain("IP address");
      expect(fake.seen.handshakes).toBe(0);
      expect(fake.seen.bytes).toBe(0);
      fake.close();
    });
  }
});
