import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ControlMessage, RUNNER_CLOSE, VERSION } from "@nearzero/shared";
import type { DockerClient } from "../../../runner/src/docker/client.ts";
import { LINK_HIGH_WATER_BYTES } from "../../../runner/src/link/socket.ts";
import { silentLog as silentRunnerLog } from "../../../runner/src/log.ts";
import { Router } from "../../../runner/src/router/router.ts";
import { RunnerSession } from "../../../runner/src/session.ts";
import { PushQueue } from "../../../runner/src/streams/queue.ts";
import { migrate } from "../src/db/migrate.ts";
import { silentLogger } from "../src/log.ts";
import { HOST_TARGET, HubStopping, RunnerHub, type SocketLike } from "../src/runners/hub.ts";
import type { StreamEvent } from "../src/runners/streams.ts";
import { HubStream } from "../src/runners/streams.ts";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "./support/database.ts";

/**
 * The runner and the control plane talking through the real protocol code on both ends, with
 * the WebSocket replaced by an in-memory pair and Docker by a fake: commands and results, the
 * version window, metrics, and a log stream that survives a dropped link without a gap.
 */

let database: TestDatabase;
let hub: RunnerHub;
let routerDir: string;

/** A WebSocket stand-in for the runner's side, wired to the hub's side. */
class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  /** What the link holds unsent; a test raises it to stand for a slow control plane (C4-07). */
  bufferedAmount = 0;
  onSend: (data: string) => void = () => {};
  onClose: (code: number) => void = () => {};

  send(data: string): void {
    if (this.readyState !== WebSocket.OPEN) throw new Error("not open");
    const deliver = this.onSend;
    queueMicrotask(() => deliver(data));
  }

  close(code = 1000): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    const notify = this.onClose;
    queueMicrotask(() => {
      notify(code);
      this.dispatchEvent(new CloseEvent("close", { code }));
    });
  }

  receive(data: string): void {
    if (this.readyState !== WebSocket.OPEN) return;
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

/** Every message the control plane sent a runner, newest last. */
const toRunner: ControlMessage[] = [];
/** The type of every message the runner sent, newest last, and its latest socket. */
const fromRunner: string[] = [];
let lastClient: FakeSocket | null = null;

function connector(runnerId: string, serverId: string | null) {
  return () => {
    const client = new FakeSocket();
    const serverSide: SocketLike = {
      send: (data) => {
        toRunner.push(JSON.parse(data) as ControlMessage);
        queueMicrotask(() => client.receive(data));
      },
      close: (code) => client.close(code),
    };
    const link = hub.attach(serverSide, { runnerId, serverId });
    lastClient = client;
    client.onSend = (data) => {
      fromRunner.push((JSON.parse(data) as { type: string }).type);
      link.message(data);
    };
    client.onClose = (code) => link.closed(code);
    queueMicrotask(() => {
      client.readyState = WebSocket.OPEN;
      client.dispatchEvent(new Event("open"));
    });
    return client as unknown as WebSocket;
  };
}

/** Docker as far as these tests need it: no engine, and a log stream the test writes into. */
/** A log stream's lines; a stream that stops ends its queue, so a later test starts a new one. */
let logLines = new PushQueue<Uint8Array>();
const fakeDocker = {
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
  logs: async () => logLines,
} as unknown as DockerClient;

async function eventually<T>(what: string, check: () => T | null | false | undefined, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

let session: RunnerSession;
let hostRunnerId = "";

beforeAll(async () => {
  database = await createTestDatabase();
  await migrate(database.db, { directory: MIGRATIONS_DIR });
  hub = new RunnerHub(database.db, silentLogger);
  routerDir = await mkdtemp(join(tmpdir(), "nz-link-"));
  const row = await database.db
    .insertInto("runner")
    .values({ server_id: null, credential_hash: "0".repeat(64) })
    .returning("id")
    .executeTakeFirstOrThrow();
  hostRunnerId = row.id;
  const router = new Router(
    fakeDocker,
    {
      directory: routerDir,
      hostDirectory: routerDir,
      image: "traefik:v3.7.18",
      acmeEmail: "",
      httpPort: 80,
      httpsPort: 443,
      network: "nearzero-edge",
    },
    silentRunnerLog,
  );
  session = new RunnerSession({
    controlUrl: "http://control.test",
    // The Nearzero host's runner, on the host's private network.
    allowPlain: true,
    credential: async () => "nzr1.fake",
    onCredentialRefused: async () => null,
    check: async () => ({ result: "accepted", message: "" }),
    connect: connector(hostRunnerId, null),
    docker: fakeDocker,
    router,
    manageRouter: false,
    log: silentRunnerLog,
    workDirectory: join(routerDir, "work"),
    dockerSocket: "/nowhere.sock",
    containerized: false,
  });
  void session.run();
  await eventually("the runner to connect", () => hub.isOnline(HOST_TARGET));
}, 60_000);

afterAll(async () => {
  session?.stop();
  hub?.stop();
  await rm(routerDir, { recursive: true, force: true });
  await database?.drop();
});

describe("commands", () => {
  test("a command goes out, is acknowledged, and its result comes back", async () => {
    const result = await hub.command(HOST_TARGET, "router.write", {
      routes: [{ key: "web", hostnames: ["web.localhost"], upstream: { host: "web", port: 80 } }],
    });
    expect(result).toEqual({ written: ["web"] });
    expect(await readFile(join(routerDir, "route-web.yml"), "utf8")).toContain(
      "Host(`web.localhost`)",
    );
  });

  test("a failing command reports the runner's reason", async () => {
    const failed = hub.command(HOST_TARGET, "container.inspect", { id: "nope" });
    await expect(failed).rejects.toThrow();
  });

  test("an unknown command is refused by the runner, in words that say to update it", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: a command this runner doesn't know.
    const unknown = hub.command(HOST_TARGET, "future.thing" as any, {} as never);
    await expect(unknown).rejects.toThrow('doesn\'t know the command "future.thing"');
  });

  test("an offline target is refused at once", async () => {
    await expect(
      hub.command("00000000-0000-4000-8000-000000000001", "system.info", {}),
    ).rejects.toThrow("isn't connected");
  });
});

describe("a log stream across a dropped link (resume without gaps)", () => {
  test("every line arrives once, in order, with no gap", async () => {
    const { stream } = await hub.openStream(HOST_TARGET, "container.logs", { id: "web" });
    const events: StreamEvent[] = [];
    stream.subscribe((event) => events.push(event));
    const line = (n: number) => new TextEncoder().encode(`line ${n}\n`);
    for (let n = 1; n <= 3; n++) logLines.push(line(n));
    await eventually("the first lines", () => stream.received === 21);

    // The link drops; the container keeps logging.
    expect(hub.disconnect(HOST_TARGET)).toBe(true);
    for (let n = 4; n <= 10; n++) logLines.push(line(n));
    await Bun.sleep(100);
    expect(hub.isOnline(HOST_TARGET)).toBe(false);
    await eventually("the runner to reconnect", () => hub.isOnline(HOST_TARGET), 15_000);
    const total = Array.from({ length: 10 }, (_, i) => `line ${i + 1}\n`).join("");
    await eventually("the rest of the lines", () => stream.received === total.length);

    const text = events
      .filter((event) => event.type === "output")
      .map((event) => new TextDecoder().decode((event as { bytes: Uint8Array }).bytes))
      .join("");
    expect(text).toBe(total);
    expect(stream.gaps).toEqual([]);
    expect(events.filter((event) => event.type === "link")).toEqual([
      { type: "link", connected: false },
      { type: "link", connected: true },
    ]);
    // A viewer who reconnects from an offset gets exactly the rest.
    const replay: string[] = [];
    stream.subscribe((event) => {
      if (event.type === "output") replay.push(new TextDecoder().decode(event.bytes));
    }, 14);
    expect(replay.join("")).toBe(total.slice(14));
    hub.closeStream(stream.id);
  }, 30_000);
});

describe("flow control on the link (C4-07)", () => {
  test("stream output waits in its own buffer while the link is backed up, and follows on drain", async () => {
    logLines = new PushQueue<Uint8Array>();
    const { stream } = await hub.openStream(HOST_TARGET, "container.logs", { id: "web" });
    const line = (n: number) => new TextEncoder().encode(`line ${n}\n`);
    logLines.push(line(1));
    await eventually("the first line", () => stream.received === 7);
    const client = lastClient as FakeSocket;
    // The control plane reads slower than the output comes: the link holds more than 4 MB.
    client.bufferedAmount = LINK_HIGH_WATER_BYTES + 1;
    const sentBefore = fromRunner.filter((type) => type === "stream.data").length;
    for (let n = 2; n <= 40; n++) logLines.push(line(n));
    await Bun.sleep(600);
    // Nothing more was handed to the link; heartbeats and the link itself carry on.
    expect(fromRunner.filter((type) => type === "stream.data").length).toBe(sentBefore);
    expect(hub.isOnline(HOST_TARGET)).toBe(true);
    // It drains: everything held follows, in order and without a gap.
    client.bufferedAmount = 0;
    client.dispatchEvent(new Event("drain"));
    const total = Array.from({ length: 40 }, (_, i) => `line ${i + 1}\n`).join("");
    await eventually("the rest of the lines", () => stream.received === total.length);
    expect(stream.gaps).toEqual([]);
    hub.closeStream(stream.id);
  }, 30_000);
});

describe("long work across a control-plane restart (B2-20)", () => {
  const encoder = new TextEncoder();
  const textOf = (events: StreamEvent[]) =>
    events
      .filter((event) => event.type === "output")
      .map((event) => new TextDecoder().decode((event as { bytes: Uint8Array }).bytes))
      .join("");
  /** Writes a log line until the check passes (an earlier, stopped reader may take one). */
  const writeUntil = (what: string, line: string, check: () => boolean) =>
    eventually(what, () => {
      if (check()) return true;
      logLines.push(encoder.encode(`${line}\n`));
      return false;
    });

  /** Stops the hub like a restarting control plane; the runner comes back to a new one. */
  async function restart(options: { orphanGraceMs?: number } = {}): Promise<RunnerHub> {
    const old = hub;
    hub = new RunnerHub(database.db, silentLogger, {}, options);
    old.stop();
    await eventually(
      "the runner to reach the new control plane",
      () => hub.isOnline(HOST_TARGET),
      20_000,
    );
    return old;
  }

  test("keyed work goes on through the restart, and its job follows it again", async () => {
    logLines = new PushQueue<Uint8Array>();
    const before = await hub.openStream(
      HOST_TARGET,
      "container.logs",
      { id: "web" },
      { key: "test:logs" },
    );
    const first: StreamEvent[] = [];
    before.stream.subscribe((event) => first.push(event));
    await writeUntil("output before the restart", "before", () => textOf(first).includes("before"));
    const waiting = before.done.catch((error: unknown) => error);
    const sent = toRunner.length;
    const old = await restart();
    // The stopping process stops waiting, and its job's clean-up doesn't stop the work.
    expect(await waiting).toBeInstanceOf(HubStopping);
    old.closeStream(before.stream.id);

    const after = await hub.resumeStream(HOST_TARGET, "container.logs", "test:logs");
    expect(after).not.toBeNull();
    if (!after) return;
    const events: StreamEvent[] = [];
    after.stream.subscribe((event) => events.push(event));
    await writeUntil("output after the restart", "after", () => textOf(events).includes("after"));
    expect(events.some((event) => event.type === "gap")).toBe(false);
    // Still the same work, still running: the runner had it, so following it started nothing.
    const settled = await Promise.race([
      after.done.then(
        () => "finished",
        () => "failed",
      ),
      Bun.sleep(300).then(() => "running"),
    ]);
    expect(settled).toBe("running");
    expect(
      toRunner
        .slice(sent)
        .filter(
          (message) =>
            (message.type === "cancel" && message.commandId === "w:test:logs") ||
            (message.type === "stream.close" && message.streamId === "w:test:logs.out"),
        ),
    ).toEqual([]);
    hub.closeStream(after.stream.id);
    void after.done.catch(() => {});
    // The fake log stream only ends with its queue.
    logLines.end();
  }, 60_000);

  test("work no job follows again is stopped once its grace is over", async () => {
    logLines = new PushQueue<Uint8Array>();
    const started = await hub.openStream(
      HOST_TARGET,
      "container.logs",
      { id: "web" },
      { key: "test:forgotten" },
    );
    started.stream.subscribe(() => {});
    await writeUntil("its output", "forgotten", () => started.stream.received > 0);
    void started.done.catch(() => {});
    const sent = toRunner.length;
    await restart({ orphanGraceMs: 300 });
    await eventually("the runner to be told to stop it", () =>
      toRunner
        .slice(sent)
        .some((message) => message.type === "cancel" && message.commandId === "w:test:forgotten"),
    );
    expect(
      await hub.resumeStream(HOST_TARGET, "container.logs", "test:forgotten", { waitMs: 0 }),
    ).toBeNull();
  }, 60_000);

  test("following work again never starts it", async () => {
    expect(
      await hub.resumeStream(HOST_TARGET, "container.logs", "test:never", { waitMs: 0 }),
    ).toBeNull();
    // Sent to be followed only, a command the runner doesn't have is refused, not started.
    await expect(
      hub.command(HOST_TARGET, "system.info", {}, { commandId: "w:test:never", resumeOnly: true }),
    ).rejects.toThrow("isn't running on the server any more");
  });
});

describe("the hub's stream bookkeeping", () => {
  test("repeats are dropped, overlaps trimmed and jumps reported as gaps", () => {
    const stream = new HubStream("s", "host", "container.logs");
    const b = (text: string) => new TextEncoder().encode(text);
    expect(stream.accept(0, b("abcd"))).toBe(true);
    expect(stream.accept(0, b("abcd"))).toBe(false);
    expect(stream.accept(2, b("cdef"))).toBe(true);
    expect(stream.received).toBe(6);
    expect(stream.accept(10, b("kl"))).toBe(true);
    expect(stream.gaps).toEqual([{ from: 6, to: 10 }]);
  });
});

describe("the version window and reports", () => {
  async function rawRunner(serverId: string | null) {
    const row = await database.db
      .insertInto("runner")
      .values({ server_id: serverId, credential_hash: "1".repeat(64) })
      .returning("id")
      .executeTakeFirstOrThrow();
    const received: ControlMessage[] = [];
    let closedWith: number | null = null;
    const link = hub.attach(
      {
        send: (data) => received.push(JSON.parse(data)),
        close: (code) => {
          closedWith = code ?? 1000;
        },
      },
      { runnerId: row.id, serverId },
    );
    return { row, received, link, closed: () => closedWith };
  }

  const hello = (protocol: number, minProtocol: number) =>
    JSON.stringify({
      type: "hello",
      runnerVersion: "9.9.9",
      protocol,
      minProtocol,
      startedAt: Date.now(),
      system: {
        hostname: "h",
        os: "Linux",
        kernel: "6",
        architecture: "aarch64",
        cpuModel: "x",
        cpuCores: 1,
        cpuThreads: 1,
        cpuMhz: 0,
        memoryTotalBytes: 1,
        dockerVersion: null,
        containerized: false,
      },
      checks: { docker: true, network: true, router: true, routerDirectory: true },
      streams: [],
      commands: [],
    });

  test("a runner that needs a newer control plane is refused with a clear message", async () => {
    const server = await database.db
      .insertInto("workspace")
      .values({ name: "w", slug: `w-${Date.now()}` })
      .returning("id")
      .executeTakeFirstOrThrow();
    const key = await database.db
      .insertInto("ssh_key")
      .values({
        workspace_id: server.id,
        name: "k",
        key_type: "ed25519",
        public_key: "ssh-ed25519 AAAA",
        fingerprint: "SHA256:x",
        private_key_sealed: "nzs1.x",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const row = await database.db
      .insertInto("server")
      .values({
        workspace_id: server.id,
        name: "s",
        address: "198.51.100.4",
        ssh_user: "root",
        ssh_key_id: key.id,
        label: `s${Date.now()}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const raw = await rawRunner(row.id);
    raw.link.message(hello(1, 99));
    await eventually("the refusal", () => raw.closed() !== null);
    expect(raw.closed()).toBe(RUNNER_CLOSE.versionRefused);
    expect(raw.received[0]).toMatchObject({ type: "refused", reason: "control_outdated" });
    expect(hub.isOnline(row.id)).toBe(false);
    const stored = await database.db
      .selectFrom("runner")
      .select("refusal")
      .where("id", "=", raw.row.id)
      .executeTakeFirstOrThrow();
    expect(stored.refusal).toContain("needs a newer Nearzero");

    // Only one runner row can be the host's.
    expect(await rawRunner(null).catch(() => null)).toBeNull();
    // The same server's runner, updated, is welcomed with the server's address for DNS checks.
    const updated = hub.attach(
      { send: (data) => raw.received.push(JSON.parse(data)), close: () => {} },
      { runnerId: raw.row.id, serverId: row.id },
    );
    updated.message(hello(1, 1));
    const welcome = await eventually("the welcome", () =>
      raw.received.find((message) => message.type === "welcome"),
    );
    expect(welcome).toMatchObject({
      serverId: row.id,
      serverName: "s",
      publicIPv4: "198.51.100.4",
      controlVersion: VERSION,
    });
    updated.message(
      JSON.stringify({
        type: "metrics",
        samples: [
          {
            at: Date.now(),
            cpuPercent: 12.5,
            memoryUsedBytes: 1024,
            memoryTotalBytes: 4096,
            diskUsedBytes: 10,
            diskTotalBytes: 100,
            uptimeSeconds: 60,
          },
        ],
      }),
    );
    await Bun.sleep(200);
    const samples = await database.db
      .selectFrom("server_metric")
      .selectAll()
      .where("target", "=", row.id)
      .execute();
    expect(samples).toHaveLength(1);
    expect(samples[0]?.cpu_percent).toBe(12.5);
    // A frame outside the protocol closes the link.
    const closes: number[] = [];
    const broken = hub.attach(
      {
        send: () => {},
        close: (code) => {
          closes.push(code ?? 1000);
        },
      },
      { runnerId: raw.row.id, serverId: row.id },
    );
    broken.message("{not json");
    expect(closes).toEqual([RUNNER_CLOSE.protocolError]);
  });
});
