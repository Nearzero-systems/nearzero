import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkCertificate } from "../../apps/control/src/runners/link-certificate.ts";
import { checkCredential } from "../src/credentials.ts";
import { linkFetch, openLinkSocket } from "../src/link/link.ts";

/**
 * C4-15: a pinned link is TLS 1.3 only. Bun's client ignores `minVersion`, so a server holding the
 * pinned key but speaking TLS 1.2 (which can renegotiate, and swap the certificate checked at the
 * handshake) was accepted. The runner checks the negotiated version itself and writes nothing
 * over anything older. The TLS 1.2 server runs under Node (Bun's server can't be limited to 1.2);
 * without Node on the machine the test is skipped, and says so.
 */

setDefaultTimeout(60_000);

const node = Bun.which("node");
const pinned = createLinkCertificate(["127.0.0.1"]);
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "nz-tls12-"));
  await writeFile(join(directory, "link.crt"), pinned.certificate);
  await writeFile(join(directory, "link.key"), pinned.key, { mode: 0o600 });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

async function tls12Server() {
  const child = Bun.spawn(
    [
      node as string,
      join(import.meta.dir, "support", "tls12-server.mjs"),
      join(directory, "link.crt"),
      join(directory, "link.key"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const reader = child.stdout.getReader();
  let output = "";
  while (!/PORT \d+/.test(output)) {
    const { value, done } = await reader.read();
    if (done) throw new Error(`the TLS 1.2 server didn't start: ${output}`);
    output += new TextDecoder().decode(value);
  }
  const port = Number(/PORT (\d+)/.exec(output)?.[1]);
  return {
    port,
    /** Stops the server and returns everything it reported. */
    async stop(): Promise<string> {
      child.stdin.end();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      await child.exited;
      return output;
    },
  };
}

describe("pinned links are TLS 1.3 only (C4-15)", () => {
  if (!node)
    console.log("link-tls.test.ts: no node on this machine, so the TLS 1.2 test is skipped");

  test.skipIf(!node)(
    "a TLS 1.2 server with the pinned certificate gets nothing: no request, no WebSocket, no renegotiation",
    async () => {
      const server = await tls12Server();
      const link = { url: `https://127.0.0.1:${server.port}`, fingerprint: pinned.fingerprint };
      const check = await checkCredential(link.url, "nzr1.runner.SECRET", linkFetch(link));
      expect(check.result).toBe("unreachable");
      expect(check.message).toContain("TLS 1.3");
      const socket = openLinkSocket(link, "/api/v1/runner/connect", {
        authorization: "Bearer nzr1.runner.SECRET",
      });
      let why = "";
      socket.addEventListener("error", (event) => {
        why = (event as unknown as { message?: string }).message ?? why;
      });
      await new Promise((resolve) => socket.addEventListener("close", resolve));
      expect(why).toContain("TLS 1.3");
      const report = await server.stop();
      // The handshakes happened, over TLS 1.2, and not one application byte followed.
      expect(report).toContain("handshake TLSv1.2");
      expect(report).not.toContain("read ");
      expect(report).not.toContain("renegotiated");
    },
  );
});
