import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ControlMessage,
  type RunnerLinkAddress,
  type RunnerMessage,
  VERSION,
} from "@nearzero/shared";
import type { DockerClient } from "../../../runner/src/docker/client.ts";
import type { ControlLink } from "../../../runner/src/link/link.ts";
import { SAVED_LINK_FILE, saveLinks } from "../../../runner/src/link/link.ts";
import { silentLog as silentRunnerLog } from "../../../runner/src/log.ts";
import { systemInfo } from "../../../runner/src/metrics.ts";
import { Router } from "../../../runner/src/router/router.ts";
import { RunnerSession } from "../../../runner/src/session.ts";
import { migrate } from "../src/db/migrate.ts";
import { silentLogger } from "../src/log.ts";
import {
  HOST_TARGET,
  LOST_TO_RUNNER_RESTART,
  RunnerHub,
  type SocketLike,
} from "../src/runners/hub.ts";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "./support/database.ts";

/**
 * The runner link between real hub and real runner sessions over an in-memory socket:
 *
 * - C2-01: a command a runner acknowledged is never started again in a restarted runner; it is
 *   reported lost, while the same runner reconnecting keeps it running.
 * - Spec 31 "Remote runners are always encrypted" (G3-01, C2-07, C4-02 to C4-06, C4-09,
 *   C4-10): a remote runner never connects, falls back or moves to a plain or unpinned address,
 *   and one that reaches Nearzero over plain HTTP anyway gets no work; it is moved between
 *   encrypted addresses, keeps the pinned TLS port as its fallback also when it was set up on
 *   the domain, isn't cut off to retry an address it declined but checks it in the background,
 *   and is given the next certificate fingerprint over its current link. The Nearzero host's
 *   runner never moves.
 */

// A busy machine makes the database slow to create and drop.
setDefaultTimeout(120_000);
let database: TestDatabase;
let root: string;
const FINGERPRINT = "ab".repeat(32);
const PINNED: RunnerLinkAddress = { url: "https://203.0.113.10:3443", fingerprint: FINGERPRINT };
const DOMAIN: RunnerLinkAddress = { url: "https://nz.example.com", fingerprint: null };

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  onSend: (data: string) => void = () => {};
  onClose: (code: number) => void = () => {};
  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error("not open");
    const deliver = this.onSend;
    queueMicrotask(() => deliver(data));
  }
  close(code = 1000, reason = ""): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    const notify = this.onClose;
    queueMicrotask(() => {
      notify(code);
      this.dispatchEvent(new CloseEvent("close", { code, reason }));
    });
  }
  receive(data: string): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

async function eventually<T>(what: string, check: () => T | null | false | undefined, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** One hub and what crossed its links. */
class Rig {
  readonly hub: RunnerHub;
  preferred: RunnerLinkAddress | null = null;
  /** The runner link's own TLS port, every remote runner's fallback (C4-06). */
  fallback: RunnerLinkAddress | null = null;
  /** The next certificate's fingerprint while the pair is replaced (C4-10). */
  next: string | null = null;
  /** Every address a credential check went to. */
  readonly checked: string[] = [];
  /** Origins that don't answer (a blocked port). */
  readonly unreachable = new Set<string>();
  /** Every connection: the address used, and every frame each way. */
  readonly connections: { url: string; toRunner: ControlMessage[]; fromRunner: RunnerMessage[] }[] =
    [];
  waitStarts = 0;

  constructor() {
    this.hub = new RunnerHub(database.db, silentLogger, {
      preferredLink: async () => this.preferred,
      fallbackLink: async () => this.fallback,
      nextFingerprint: () => this.next,
    });
  }

  connector(runnerId: string, serverId: string | null) {
    return (_url: string, _credential: string, link: ControlLink) => {
      const client = new FakeSocket();
      if (this.unreachable.has(link.url)) {
        queueMicrotask(() => client.close(1006, "connection refused"));
        return client as unknown as WebSocket;
      }
      const record = {
        url: link.url,
        toRunner: [] as ControlMessage[],
        fromRunner: [] as RunnerMessage[],
      };
      this.connections.push(record);
      const serverSide: SocketLike = {
        send: (data) => {
          record.toRunner.push(JSON.parse(data) as ControlMessage);
          queueMicrotask(() => client.receive(data));
        },
        close: (code) => client.close(code),
      };
      const attached = this.hub.attach(serverSide, {
        runnerId,
        serverId,
        encrypted: link.url.startsWith("https:"),
      });
      client.onSend = (data) => {
        record.fromRunner.push(JSON.parse(data) as RunnerMessage);
        attached.message(data);
      };
      client.onClose = (code) => attached.closed(code);
      queueMicrotask(() => {
        client.readyState = WebSocket.OPEN;
        client.dispatchEvent(new Event("open"));
      });
      return client as unknown as WebSocket;
    };
  }

  docker(): DockerClient {
    return {
      negotiate: async () => {
        throw new Error("no docker here");
      },
      info: async () => {
        throw new Error("no docker here");
      },
      findNetwork: async () => null,
      listContainers: async () => {
        throw new Error("no docker here");
      },
      async *events(signal: AbortSignal) {
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      },
      // Long work: a wait that ends only when it is aborted (the runner process stopping).
      waitContainer: (_id: string, _condition: string, signal?: AbortSignal) => {
        this.waitStarts++;
        return new Promise((_resolve, reject) =>
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      },
    } as unknown as DockerClient;
  }

  session(
    runnerId: string,
    serverId: string | null,
    options: {
      controlUrl: string;
      fingerprint?: string | null;
      stateDirectory: string;
      fallback?: RunnerLinkAddress | null;
      allowPlain?: boolean;
      connect?: (url: string, credential: string, link: ControlLink) => WebSocket;
    },
  ): RunnerSession {
    const docker = this.docker();
    return new RunnerSession({
      controlUrl: options.controlUrl,
      controlFingerprint: options.fingerprint ?? null,
      controlFallback: options.fallback ?? null,
      allowPlain: options.allowPlain ?? false,
      stateDirectory: options.stateDirectory,
      credential: async () => "nzr1.fake",
      onCredentialRefused: async () => null,
      check: async (_credential, link) => {
        this.checked.push(link.url);
        return this.unreachable.has(link.url)
          ? { result: "unreachable", message: "connection refused" }
          : { result: "accepted", message: "" };
      },
      connect: options.connect ?? this.connector(runnerId, serverId),
      retryDelay: () => 20,
      declineRecheckMs: 150,
      docker,
      router: new Router(
        docker,
        {
          directory: options.stateDirectory,
          hostDirectory: options.stateDirectory,
          image: "traefik:v3.7.18",
          acmeEmail: "",
          httpPort: 80,
          httpsPort: 443,
          network: "nearzero-edge",
        },
        silentRunnerLog,
      ),
      manageRouter: false,
      log: silentRunnerLog,
      workDirectory: join(options.stateDirectory, "work"),
      dockerSocket: "/nowhere.sock",
      containerized: false,
    });
  }

  commandsSent(): ControlMessage[] {
    return this.connections.flatMap((item) => item.toRunner).filter((m) => m.type === "command");
  }
}

let serverCount = 0;
let workspaceId = "";
let keyId = "";
async function newServer(): Promise<{ serverId: string; runnerId: string; state: string }> {
  serverCount++;
  if (!workspaceId) {
    workspaceId = (
      await database.db
        .insertInto("workspace")
        .values({ name: "Acme", slug: "acme-links" })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
    keyId = (
      await database.db
        .insertInto("ssh_key")
        .values({
          workspace_id: workspaceId,
          name: "deploy",
          key_type: "ed25519",
          public_key: "ssh-ed25519 AAAA test",
          fingerprint: "SHA256:test",
          private_key_sealed: "sealed",
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  }
  const server = await database.db
    .insertInto("server")
    .values({
      workspace_id: workspaceId,
      name: `prod-${serverCount}`,
      address: `198.51.100.${serverCount}`,
      ssh_user: "root",
      ssh_key_id: keyId,
      label: `prod-${serverCount}`,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const runner = await database.db
    .insertInto("runner")
    .values({ server_id: server.id, credential_hash: "0".repeat(64) })
    .returning("id")
    .executeTakeFirstOrThrow();
  const state = await mkdtemp(join(root, "runner-"));
  return { serverId: server.id, runnerId: runner.id, state };
}

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.db, { directory: MIGRATIONS_DIR });
  root = await mkdtemp(join(tmpdir(), "nz-link-moves-"));
}, 60_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await database?.drop();
});

describe("a command the runner acknowledged, across a runner restart (C2-01)", () => {
  test("a restarted runner never starts it again: the caller hears it was lost", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    const options = { controlUrl: PINNED.url, fingerprint: FINGERPRINT, stateDirectory: state };
    rig.preferred = PINNED;
    const first = rig.session(runnerId, serverId, options);
    void first.run();
    await eventually("the runner to connect", () => rig.hub.isOnline(serverId));
    const waiting = rig.hub.command(
      serverId,
      "container.wait",
      { id: "job", condition: "not-running" },
      { timeoutMs: 600_000 },
    );
    const outcome = waiting.then(
      () => "finished",
      (error: Error) => error.message,
    );
    await eventually("the work to start", () => rig.waitStarts === 1);
    // The runner process restarts (setup again, a reboot, a crash): a new process, no memory.
    first.stop();
    await eventually("the runner to go", () => !rig.hub.isOnline(serverId));
    const second = rig.session(runnerId, serverId, options);
    void second.run();
    await eventually("the new runner to connect", () => rig.hub.isOnline(serverId));
    expect(await outcome).toBe(LOST_TO_RUNNER_RESTART);
    await Bun.sleep(300);
    expect(rig.waitStarts).toBe(1);
    expect(
      rig.commandsSent().filter((m) => m.type === "command" && m.kind === "container.wait"),
    ).toHaveLength(1);
    second.stop();
    rig.hub.stop();
  }, 60_000);

  test("the same runner reconnecting keeps it running, and its result still arrives", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = PINNED;
    const session = rig.session(runnerId, serverId, {
      controlUrl: PINNED.url,
      fingerprint: FINGERPRINT,
      stateDirectory: state,
    });
    void session.run();
    await eventually("the runner to connect", () => rig.hub.isOnline(serverId));
    const waiting = rig.hub.command(
      serverId,
      "container.wait",
      { id: "job", condition: "not-running" },
      { timeoutMs: 600_000 },
    );
    let settled = false;
    waiting.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await eventually("the work to start", () => rig.waitStarts === 1);
    session.dropConnection();
    await eventually("the runner to go", () => !rig.hub.isOnline(serverId));
    await eventually("the runner to come back", () => rig.hub.isOnline(serverId));
    await Bun.sleep(300);
    expect(settled).toBe(false);
    expect(rig.waitStarts).toBe(1);
    session.stop();
    rig.hub.stop();
  }, 60_000);

  test("a command that changes nothing is simply asked again of a restarted runner", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = PINNED;
    const options = { controlUrl: PINNED.url, fingerprint: FINGERPRINT, stateDirectory: state };
    const first = rig.session(runnerId, serverId, options);
    void first.run();
    await eventually("the runner to connect", () => rig.hub.isOnline(serverId));
    // A read the runner is slow to answer: its link goes before the answer comes.
    const asked = rig.hub.command(serverId, "router.files", {});
    first.stop();
    await eventually("the runner to go", () => !rig.hub.isOnline(serverId));
    const second = rig.session(runnerId, serverId, options);
    void second.run();
    const answer = (await asked) as { files: unknown[] };
    expect(Array.isArray(answer.files)).toBe(true);
    second.stop();
    rig.hub.stop();
  }, 60_000);
});

describe("remote runners are always encrypted (spec 31; G3-01, C2-07, C4-02 to C4-06, C4-09, C4-10)", () => {
  const PLAIN = "http://198.51.100.1:3000";
  const OTHER_PIN: RunnerLinkAddress = {
    url: "https://203.0.113.20:3443",
    fingerprint: "ef".repeat(32),
  };

  async function linkRow(runnerId: string) {
    return database.db
      .selectFrom("runner")
      .select(["link_url", "link_problem", "link_next"])
      .where("id", "=", runnerId)
      .executeTakeFirstOrThrow();
  }

  /** A hello as a runner of any version sends it. */
  async function hello(rig: Rig, link?: { url: string }) {
    return JSON.stringify({
      type: "hello",
      runnerVersion: VERSION,
      protocol: 1,
      minProtocol: 1,
      startedAt: Date.now(),
      system: await systemInfo(rig.docker(), false),
      checks: { docker: true, network: true, router: true, routerDirectory: true },
      streams: [],
      commands: [],
      ...(link ? { link } : {}),
    });
  }

  test("C4-02, C4-04: a runner whose address is plain http:// doesn't connect at all", async () => {
    const rig = new Rig();
    const { runnerId, serverId, state } = await newServer();
    rig.preferred = PINNED;
    const session = rig.session(runnerId, serverId, { controlUrl: PLAIN, stateDirectory: state });
    // run() returns by itself: nothing is checked or opened, so the credential never leaves.
    await session.run();
    expect(rig.checked).toEqual([]);
    expect(rig.connections).toEqual([]);
    rig.hub.stop();
  }, 30_000);

  test("C4-02: a saved encrypted address that stops answering never gives way to a plain configured one", async () => {
    // probe-downgrade: set up on plain before, moved to the pinned port; the pinned port is
    // blocked (an attacker drops it). The old runner went back to the plain address after five
    // failures, sent its credential there, and followed the answer's move for good.
    const rig = new Rig();
    const { runnerId, serverId, state } = await newServer();
    await saveLinks(
      state,
      { link: PINNED, fallback: null, retired: [] },
      { link: { url: PLAIN, fingerprint: null }, fallback: null },
    );
    rig.unreachable.add(PINNED.url);
    const session = rig.session(runnerId, serverId, { controlUrl: PLAIN, stateDirectory: state });
    void session.run();
    await eventually("a dozen failed attempts", () => rig.checked.length >= 12);
    expect(new Set(rig.checked)).toEqual(new Set([PINNED.url]));
    expect(rig.connections).toEqual([]);
    expect(session.link).toEqual(PINNED);
    session.stop();
    rig.hub.stop();
  }, 60_000);

  test("C4-04: a move to a plain address, or to an IP address without its pin, is refused", async () => {
    for (const offered of [
      { url: "http://203.0.113.66:80", fingerprint: null },
      { url: "http://203.0.113.66", fingerprint: "a".repeat(64) },
      { url: "https://203.0.113.66:3443", fingerprint: null },
    ]) {
      const rig = new Rig();
      const { runnerId, serverId, state } = await newServer();
      const closes: number[] = [];
      const attempts: string[] = [];
      // Someone who can answer on the runner's link sends a welcome that moves it.
      const forger = (_url: string, _credential: string, link: ControlLink) => {
        attempts.push(link.url);
        const client = new FakeSocket();
        client.onSend = (data) => {
          if ((JSON.parse(data) as RunnerMessage).type !== "hello") return;
          client.receive(
            JSON.stringify({
              type: "welcome",
              protocol: 1,
              controlVersion: VERSION,
              serverId,
              serverName: "one",
              publicIPv4: null,
              heartbeatIntervalMs: 10_000,
              resume: [],
              close: [],
              received: [],
              link: offered,
            }),
          );
        };
        client.onClose = (code) => closes.push(code);
        queueMicrotask(() => {
          client.readyState = WebSocket.OPEN;
          client.dispatchEvent(new Event("open"));
        });
        return client as unknown as WebSocket;
      };
      const session = rig.session(runnerId, serverId, {
        controlUrl: PINNED.url,
        fingerprint: FINGERPRINT,
        stateDirectory: state,
        connect: forger,
      });
      void session.run();
      await eventually("three refused welcomes", () => closes.length >= 3);
      session.stop();
      // It never went to the offered address, didn't keep it, and closed as a protocol error.
      expect(new Set(attempts)).toEqual(new Set([PINNED.url]));
      expect(new Set(rig.checked)).toEqual(new Set([PINNED.url]));
      expect(session.link).toEqual(PINNED);
      expect(closes[0]).toBe(4003);
      await expect(readFile(join(state, SAVED_LINK_FILE), "utf8")).rejects.toThrow();
      rig.hub.stop();
    }
  }, 60_000);

  test("C4-05: a remote runner on plain HTTP gets no work, even with no encrypted address to move it to", async () => {
    // plain-served.test: with no domain and no TLS port, the old hub served it over plain HTTP.
    for (const preferred of [null, PINNED]) {
      const rig = new Rig();
      const { serverId, runnerId, state } = await newServer();
      rig.preferred = preferred;
      // A runner built to connect over plain HTTP anyway (an older or changed binary).
      const session = rig.session(runnerId, serverId, {
        controlUrl: PLAIN,
        stateDirectory: state,
        allowPlain: true,
      });
      void session.run();
      await eventually("the refusal", () =>
        rig.connections.some((item) => item.toRunner.some((m) => m.type === "refused")),
      );
      expect(rig.hub.isOnline(serverId)).toBe(false);
      // Refused, never welcomed, never moved, and no command crossed the plain link.
      for (const connection of rig.connections) {
        expect(connection.url).toBe(PLAIN);
        expect(connection.toRunner.map((m) => m.type)).toEqual(["refused"]);
      }
      await expect(
        rig.hub.command(serverId, "router.files", {}, { timeoutMs: 200 }),
      ).rejects.toThrow();
      expect(rig.commandsSent()).toEqual([]);
      const row = await eventually("the problem on the server's page", async () => true).then(() =>
        linkRow(runnerId),
      );
      expect(row.link_problem).toContain("Run setup again on the server");
      session.stop();
      rig.hub.stop();
    }
  }, 60_000);

  test("C4-05: an older runner on plain HTTP, which doesn't say where it is, is refused too", async () => {
    const rig = new Rig();
    const { serverId, runnerId } = await newServer();
    rig.preferred = PINNED;
    const sent: ControlMessage[] = [];
    const closes: number[] = [];
    const link = rig.hub.attach(
      {
        send: (data) => sent.push(JSON.parse(data) as ControlMessage),
        close: (code) => closes.push(code ?? 0),
      },
      { runnerId, serverId, encrypted: false },
    );
    link.message(await hello(rig));
    await eventually("the refusal", () => closes.length > 0);
    expect(sent.map((m) => m.type)).toEqual(["refused"]);
    expect(sent[0]).toMatchObject({ reason: "unencrypted" });
    expect(closes).toEqual([4007]);
    expect(rig.hub.isOnline(serverId)).toBe(false);
    link.closed(4007);
    // Encrypted (the TLS port, or HTTPS through the router), the same older runner is served.
    const served: ControlMessage[] = [];
    const again = rig.hub.attach(
      { send: (data) => served.push(JSON.parse(data) as ControlMessage), close: () => {} },
      { runnerId, serverId, encrypted: true },
    );
    again.message(await hello(rig));
    await eventually("the welcome", () => served.find((m) => m.type === "welcome"));
    expect(served.find((m) => m.type === "welcome")).not.toHaveProperty("link");
    expect(rig.hub.isOnline(serverId)).toBe(true);
    again.closed(1000);
    rig.hub.stop();
  }, 30_000);

  test("setup run again with a new address wins over the saved one", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = DOMAIN;
    const first = rig.session(runnerId, serverId, {
      controlUrl: PINNED.url,
      fingerprint: FINGERPRINT,
      stateDirectory: state,
    });
    void first.run();
    await eventually("the move", () => first.link.url === DOMAIN.url && rig.hub.isOnline(serverId));
    first.stop();
    await eventually("the runner to go", () => !rig.hub.isOnline(serverId));
    rig.preferred = OTHER_PIN;
    const second = rig.session(runnerId, serverId, {
      controlUrl: OTHER_PIN.url,
      fingerprint: OTHER_PIN.fingerprint,
      stateDirectory: state,
    });
    void second.run();
    await eventually("the runner to connect", () => rig.hub.isOnline(serverId));
    expect(rig.connections.at(-1)?.url).toBe(OTHER_PIN.url);
    second.stop();
    rig.hub.stop();
  }, 60_000);

  test("once the console's domain has its certificate, connected runners move to it", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = PINNED;
    const session = rig.session(runnerId, serverId, {
      controlUrl: PINNED.url,
      fingerprint: FINGERPRINT,
      stateDirectory: state,
    });
    void session.run();
    await eventually("the runner to connect", () => rig.hub.isOnline(serverId));
    expect(await rig.hub.refreshLinks()).toBe(0);
    rig.preferred = DOMAIN;
    expect(await rig.hub.refreshLinks()).toBe(1);
    await eventually("the runner on the domain", () => session.link.url === DOMAIN.url);
    await eventually("the runner to connect there", () => rig.hub.isOnline(serverId));
    expect(rig.connections.at(-1)?.url).toBe(DOMAIN.url);
    // With the TLS port blocked, it stays connected through the domain.
    rig.unreachable.add(PINNED.url);
    session.dropConnection();
    await eventually("the runner to come back", () => rig.hub.isOnline(serverId));
    expect(rig.connections.at(-1)?.url).toBe(DOMAIN.url);
    session.stop();
    rig.hub.stop();
  }, 60_000);

  test("C4-09: a declined address isn't retried by cutting the link; the runner checks it and moves once it answers", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = DOMAIN;
    rig.unreachable.add(DOMAIN.url);
    const session = rig.session(runnerId, serverId, {
      controlUrl: PINNED.url,
      fingerprint: FINGERPRINT,
      stateDirectory: state,
    });
    void session.run();
    await eventually(
      "the runner to settle",
      () => rig.hub.isOnline(serverId) && rig.connections.length === 2,
    );
    expect(session.link).toEqual(PINNED);
    const hello = rig.connections.at(-1)?.fromRunner.find((m) => m.type === "hello");
    expect(hello).toMatchObject({
      link: { url: PINNED.url, declined: [{ url: DOMAIN.url }] },
    });
    const row = await linkRow(runnerId);
    expect(row.link_problem).toContain(`can't use ${DOMAIN.url}`);
    // Neither the hub nor the runner drops the link to try again: the runner asks the domain
    // with a check request alone, every few minutes (150 ms here).
    const checksBefore = rig.checked.filter((url) => url === DOMAIN.url).length;
    for (let round = 0; round < 3; round++) expect(await rig.hub.refreshLinks()).toBe(0);
    await eventually(
      "background checks of the domain",
      () => rig.checked.filter((url) => url === DOMAIN.url).length >= checksBefore + 3,
    );
    expect(rig.connections).toHaveLength(2);
    expect(rig.hub.isOnline(serverId)).toBe(true);
    // The domain answers now: the runner moves there by itself.
    rig.unreachable.delete(DOMAIN.url);
    await eventually("the move to the domain", () => session.link.url === DOMAIN.url);
    await eventually("online there", () => rig.hub.isOnline(serverId));
    expect(rig.connections.at(-1)?.url).toBe(DOMAIN.url);
    session.stop();
    rig.hub.stop();
  }, 60_000);

  test("C4-06: a runner set up on the domain learns the pinned port as its fallback and uses it", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = DOMAIN;
    rig.fallback = PINNED;
    const first = rig.session(runnerId, serverId, {
      controlUrl: DOMAIN.url,
      stateDirectory: state,
    });
    void first.run();
    await eventually("the runner on the domain", () => rig.hub.isOnline(serverId));
    const welcome = rig.connections.at(-1)?.toRunner.find((m) => m.type === "welcome");
    expect(welcome).toMatchObject({ fallback: PINNED });
    await eventually("the fallback kept", () => first.fallback?.url === PINNED.url);
    expect(first.fallback).toMatchObject(PINNED);
    await eventually("the fallback saved", async () => true);
    const saved = JSON.parse(await readFile(join(state, SAVED_LINK_FILE), "utf8"));
    expect(saved).toMatchObject({ url: DOMAIN.url, fallback: PINNED, from: DOMAIN.url });
    first.stop();
    await eventually("the runner to go", () => !rig.hub.isOnline(serverId));
    // The domain stops answering (DNS moved, the certificate lapsed): after a few failures the
    // runner, started again, reaches Nearzero on its own TLS port.
    rig.unreachable.add(DOMAIN.url);
    const second = rig.session(runnerId, serverId, {
      controlUrl: DOMAIN.url,
      stateDirectory: state,
    });
    void second.run();
    await eventually("the runner on the pinned port", () => rig.hub.isOnline(serverId));
    expect(second.link).toMatchObject(PINNED);
    expect(rig.connections.at(-1)?.url).toBe(PINNED.url);
    second.stop();
    rig.hub.stop();
  }, 60_000);

  test("C4-06: the fallback setup writes is used before any welcome gave one", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = DOMAIN;
    rig.unreachable.add(DOMAIN.url);
    const session = rig.session(runnerId, serverId, {
      controlUrl: DOMAIN.url,
      fallback: PINNED,
      stateDirectory: state,
    });
    void session.run();
    await eventually("the runner on the pinned port", () => rig.hub.isOnline(serverId));
    expect(rig.connections.at(-1)?.url).toBe(PINNED.url);
    expect(rig.checked.filter((url) => url === DOMAIN.url).length).toBeGreaterThanOrEqual(5);
    session.stop();
    rig.hub.stop();
  }, 60_000);

  test("C4-10: the next fingerprint reaches every connected runner over its current link", async () => {
    const rig = new Rig();
    const { serverId, runnerId, state } = await newServer();
    rig.preferred = PINNED;
    rig.fallback = PINNED;
    const session = rig.session(runnerId, serverId, {
      controlUrl: PINNED.url,
      fingerprint: FINGERPRINT,
      stateDirectory: state,
    });
    void session.run();
    await eventually("the runner to connect", () => rig.hub.isOnline(serverId));
    expect(await rig.hub.refreshLinks()).toBe(0);
    // `nearzero runner-link rotate` made the next pair: the runner is reconnected once.
    const NEXT = "cd".repeat(32);
    rig.next = NEXT;
    expect(await rig.hub.refreshLinks()).toBe(1);
    await eventually("the next pin taken", () => session.link.nextFingerprint === NEXT);
    expect(session.link).toEqual({ ...PINNED, nextFingerprint: NEXT });
    await eventually("online again", () => rig.hub.isOnline(serverId));
    expect(await rig.hub.refreshLinks()).toBe(0);
    // It says so in its next hello (and heartbeats), which `runner-link status` reads.
    session.dropConnection();
    await eventually("the next pin recorded", async () => true);
    await eventually("the runner to report it", () =>
      rig.connections.at(-1)?.fromRunner.some((m) => m.type === "hello" && m.link?.next === NEXT),
    );
    await eventually("online", () => rig.hub.isOnline(serverId));
    await Bun.sleep(100);
    expect((await linkRow(runnerId)).link_next).toBe(NEXT);
    const saved = JSON.parse(await readFile(join(state, SAVED_LINK_FILE), "utf8"));
    expect(saved).toMatchObject({ nextFingerprint: NEXT, fallback: PINNED });
    // After the switch, the control plane's certificate is the next one: its welcome gives the
    // new fingerprint, and the runner drops the old one.
    rig.next = null;
    rig.fallback = { url: PINNED.url, fingerprint: NEXT };
    session.dropConnection();
    await eventually("the new pin", () => session.link.fingerprint === NEXT);
    expect(session.link).toEqual({ url: PINNED.url, fingerprint: NEXT });
    session.stop();
    rig.hub.stop();
  }, 60_000);

  test("the Nearzero host's runner stays on the private network", async () => {
    const rig = new Rig();
    rig.preferred = PINNED;
    rig.fallback = PINNED;
    const state = await mkdtemp(join(root, "host-"));
    const row = await database.db
      .insertInto("runner")
      .values({ server_id: null, credential_hash: "1".repeat(64) })
      .returning("id")
      .executeTakeFirstOrThrow();
    const session = rig.session(row.id, null, {
      controlUrl: "http://nearzero-control:3000",
      stateDirectory: state,
      allowPlain: true,
    });
    void session.run();
    await eventually("the host's runner", () => rig.hub.isOnline(HOST_TARGET));
    expect(rig.connections).toHaveLength(1);
    expect(rig.connections[0]?.toRunner[0]).not.toHaveProperty("link");
    expect(rig.connections[0]?.toRunner[0]).not.toHaveProperty("fallback");
    expect(await rig.hub.refreshLinks()).toBe(0);
    session.stop();
    rig.hub.stop();
  }, 60_000);
});
