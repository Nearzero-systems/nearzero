import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinkCertificate } from "../../apps/control/src/runners/link-certificate.ts";
import { checkCredential } from "../src/credentials.ts";
import type { DockerClient } from "../src/docker/client.ts";
import { type ControlLink, linkFetch, SAVED_LINK_FILE } from "../src/link/link.ts";
import { silentLog } from "../src/log.ts";
import { Router } from "../src/router/router.ts";
import { RunnerSession } from "../src/session.ts";

/**
 * A replaced link pin is never accepted again (C4-12), and the host's own runner follows nothing
 * its plain link offers (C4-16), with the real session, its TLS clients and credential check
 * against stand-in control planes. Each attacker holds a key the runner once trusted, or a pinned
 * address of its own, and must receive nothing: no check, no WebSocket, no credential.
 */

setDefaultTimeout(60_000);

const CREDENTIAL = "nzr1.server-one.TOPSECRET-0123456789";
const OLD = createLinkCertificate(["127.0.0.1"]);
const NEW = createLinkCertificate(["127.0.0.1"]);
let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nz-rotation-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const docker = {
  negotiate: async () => {
    throw new Error("no docker here");
  },
  info: async () => {
    throw new Error("no docker here");
  },
  findNetwork: async () => null,
  listContainers: async () => [],
  async *events(signal: AbortSignal) {
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  },
} as unknown as DockerClient;

function welcome(extra: Record<string, unknown>) {
  return JSON.stringify({
    type: "welcome",
    protocol: 1,
    controlVersion: "1.0.0",
    serverId: "s1",
    serverName: "one",
    publicIPv4: null,
    heartbeatIntervalMs: 10_000,
    resume: [],
    close: [],
    received: [],
    ...extra,
  });
}

/**
 * A control plane stand-in: answers the check, takes the WebSocket, welcomes with `extra()` and
 * sends one command. `seen` lists every request, with whether it carried the credential.
 */
function controlPlane(
  identity: { cert: string; key: string } | null,
  extra: () => Record<string, unknown> = () => ({}),
  port = 0,
) {
  const seen: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    ...(identity ? { tls: identity } : {}),
    fetch(request, bun) {
      const credential = request.headers.get("authorization")?.includes(CREDENTIAL);
      seen.push(`${new URL(request.url).pathname}${credential ? " with the credential" : ""}`);
      if (bun.upgrade(request, { data: undefined })) return undefined;
      return Response.json({ ok: true });
    },
    websocket: {
      message(ws, data) {
        const message = JSON.parse(String(data)) as { type: string; commandId?: string };
        if (message.type === "hello") {
          ws.send(welcome(extra()));
          ws.send(
            JSON.stringify({ type: "command", commandId: "c-1", kind: "system.info", params: {} }),
          );
        }
        if (message.type === "result") seen.push(`the result of ${message.commandId}`);
      },
    },
  });
  return { server, seen, port: server.port as number };
}

function session(
  state: string,
  configured: ControlLink,
  more: { fallback?: ControlLink | null; allowPlain?: boolean } = {},
) {
  return new RunnerSession({
    controlUrl: configured.url,
    controlFingerprint: configured.fingerprint,
    controlFallback: more.fallback ?? null,
    allowPlain: more.allowPlain ?? false,
    retryDelay: () => 40,
    stateDirectory: state,
    credential: async () => CREDENTIAL,
    onCredentialRefused: async () => null,
    check: (credential, link) => checkCredential(link.url, credential, linkFetch(link)),
    docker,
    router: new Router(
      docker,
      {
        directory: state,
        hostDirectory: state,
        image: "traefik:v3.7.18",
        acmeEmail: "",
        httpPort: 80,
        httpsPort: 443,
        network: "nearzero-edge",
      },
      silentLog,
    ),
    manageRouter: false,
    log: silentLog,
    workDirectory: join(state, "work"),
    dockerSocket: "/nowhere.sock",
    containerized: false,
  });
}

async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

describe("a replaced pin is never accepted again (C4-12)", () => {
  test("after a switch, the settings' old pin isn't tried when the new one stops answering", async () => {
    // recheck-session C: setup wrote {P, OLD} into runner.env; after `runner-link switch` the
    // runner saved {P, NEW}. Someone on the path holds the OLD key (the reason to rotate) and
    // answers at P. The runner at aceef92 failed five times with NEW, then tried the settings'
    // {P, OLD} and gave that attacker its credential and its commands.
    const attacker = controlPlane({ cert: OLD.certificate, key: OLD.key });
    const P = `https://127.0.0.1:${attacker.port}`;
    const state = await mkdtemp(join(root, "switch-"));
    // control-link.json as the runner kept it after the switch (aceef92's format).
    await writeFile(
      join(state, SAVED_LINK_FILE),
      JSON.stringify({
        url: P,
        fingerprint: NEW.fingerprint,
        fallback: { url: P, fingerprint: NEW.fingerprint },
        from: P,
        fromFingerprint: OLD.fingerprint,
      }),
    );
    const runner = session(state, { url: P, fingerprint: OLD.fingerprint });
    void runner.run();
    // Many more than five failed attempts.
    await Bun.sleep(2_500);
    runner.stop();
    attacker.server.stop(true);
    expect(attacker.seen).toEqual([]);
    expect(runner.link).toEqual({ url: P, fingerprint: NEW.fingerprint });
    expect(runner.retired).toContain(OLD.fingerprint);
  });

  test("through a real rotation: once the new pin is welcomed, the old key gets nothing", async () => {
    // The control plane serves OLD and announces NEW; then it switches and serves NEW; then an
    // attacker with the OLD key takes the address.
    const state = await mkdtemp(join(root, "rotation-"));
    const before = controlPlane({ cert: OLD.certificate, key: OLD.key }, () => ({
      fallback: { url: P, fingerprint: OLD.fingerprint },
      nextFingerprint: NEW.fingerprint,
    }));
    const P = `https://127.0.0.1:${before.port}`;
    const runner = session(state, { url: P, fingerprint: OLD.fingerprint });
    void runner.run();
    await until(() => runner.link.nextFingerprint === NEW.fingerprint);
    before.server.stop(true);
    const after = controlPlane(
      { cert: NEW.certificate, key: NEW.key },
      () => ({ fallback: { url: P, fingerprint: NEW.fingerprint } }),
      before.port,
    );
    await until(() => runner.link.fingerprint === NEW.fingerprint);
    expect(after.seen).toContain("/api/v1/runner/connect with the credential");
    after.server.stop(true);
    const attacker = controlPlane({ cert: OLD.certificate, key: OLD.key }, () => ({}), before.port);
    await Bun.sleep(2_500);
    runner.stop();
    attacker.server.stop(true);
    expect(attacker.seen).toEqual([]);
    expect(runner.retired).toContain(OLD.fingerprint);
    // Kept beside the credential, so a restart doesn't bring the old pin back.
    const saved = JSON.parse(await readFile(join(state, SAVED_LINK_FILE), "utf8"));
    expect(saved.retired).toContain(OLD.fingerprint);
    expect(saved).toMatchObject({ url: P, fingerprint: NEW.fingerprint });
    const again = session(state, { url: P, fingerprint: OLD.fingerprint });
    const attackerAgain = controlPlane(
      { cert: OLD.certificate, key: OLD.key },
      () => ({}),
      before.port,
    );
    void again.run();
    await Bun.sleep(1_500);
    again.stop();
    attackerAgain.server.stop(true);
    expect(attackerAgain.seen).toEqual([]);
  });

  test("setup run again wins over the saved fallback: the old one isn't tried", async () => {
    // recheck-fallback E: the pair was made again (the old key leaked) and setup ran again on a
    // server set up on the domain, writing the NEW fallback; control-link.json still held the
    // OLD one, which won at aceef92, and with the domain down the attacker got the credential.
    const attacker = controlPlane({ cert: OLD.certificate, key: OLD.key });
    const P = `https://127.0.0.1:${attacker.port}`;
    const gone = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const domain = { url: `https://localhost:${gone.port}`, fingerprint: null };
    gone.stop(true);
    const state = await mkdtemp(join(root, "fallback-"));
    await writeFile(
      join(state, SAVED_LINK_FILE),
      JSON.stringify({
        url: domain.url,
        fingerprint: null,
        fallback: { url: P, fingerprint: OLD.fingerprint },
        from: domain.url,
        fromFingerprint: null,
      }),
    );
    const runner = session(state, domain, {
      fallback: { url: P, fingerprint: NEW.fingerprint },
    });
    void runner.run();
    await Bun.sleep(2_500);
    runner.stop();
    attacker.server.stop(true);
    expect(attacker.seen).toEqual([]);
    expect(runner.fallback).toEqual({ url: P, fingerprint: NEW.fingerprint });
  });
});

describe("the Nearzero host's own runner (C4-16)", () => {
  test("follows no move, fallback or pin its plain link offers, and saves nothing", async () => {
    // recheck-session D: whatever answered the host runner's internal address moved it to a
    // pinned server of its own, which then had the credential and ran commands, for good.
    const elsewhere = createLinkCertificate(["127.0.0.1"]);
    const attacker = controlPlane({ cert: elsewhere.certificate, key: elsewhere.key });
    const offered = {
      url: `https://127.0.0.1:${attacker.port}`,
      fingerprint: elsewhere.fingerprint,
    };
    const internal = controlPlane(null, () => ({
      link: offered,
      fallback: offered,
      nextFingerprint: NEW.fingerprint,
    }));
    const state = await mkdtemp(join(root, "host-"));
    const configured = { url: `http://localhost:${internal.port}`, fingerprint: null };
    const runner = session(state, configured, { allowPlain: true });
    void runner.run();
    await until(() => internal.seen.includes("the result of c-1"));
    await Bun.sleep(500);
    runner.stop();
    internal.server.stop(true);
    attacker.server.stop(true);
    expect(attacker.seen).toEqual([]);
    expect(runner.link).toEqual(configured);
    expect(runner.fallback).toBeNull();
    await expect(readFile(join(state, SAVED_LINK_FILE), "utf8")).rejects.toThrow();
  });
});
