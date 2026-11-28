import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupCommandSchemas, RUNNER_PROTOCOL_VERSION } from "@nearzero/shared";
import {
  backupHandlers,
  startLeftStopped,
  stoppedLedgerDirectory,
} from "../src/backups/handlers.ts";
import type { CommandContext } from "../src/commands.ts";
import type { DockerClient } from "../src/docker/client.ts";
import { silentLog } from "../src/log.ts";
import { Router } from "../src/router/router.ts";
import { RunnerSession } from "../src/session.ts";

/**
 * A runner that is stopped while a backup has a service stopped (C2-02, spec 17.3, 23.3): the
 * stopped commands get to clean up before the process ends, and anything still noted as stopped
 * by a backup is started at the runner's next start.
 */

class FakeSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  readonly sent: Record<string, unknown>[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000): void {
    if (this.readyState === WebSocket.CLOSED) return;
    this.readyState = WebSocket.CLOSED;
    queueMicrotask(() => this.dispatchEvent(new CloseEvent("close", { code })));
  }
  receive(message: Record<string, unknown>): void {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

async function until(what: string, check: () => boolean): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

async function sessionWith(cleanupMs: number) {
  const directory = await mkdtemp(join(tmpdir(), "nz-runner-stop-"));
  const state = { started: false, cleaned: false };
  const docker = {
    negotiate: async () => {
      throw new Error("no docker");
    },
    info: async () => {
      throw new Error("no docker");
    },
    findNetwork: async () => null,
    listContainers: async () => {
      throw new Error("no docker");
    },
    async *events(signal: AbortSignal) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    },
    // Long work whose clean-up takes a while once it is aborted (a backup starting a service).
    waitContainer: (_id: string, _condition: string, signal: AbortSignal) => {
      state.started = true;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            setTimeout(() => {
              state.cleaned = true;
              reject(new Error("aborted"));
            }, cleanupMs),
          { once: true },
        );
      });
    },
  };
  let socket: FakeSocket | null = null;
  const session = new RunnerSession({
    controlUrl: "http://control.test",
    // Like the Nearzero host's runner on its private network: no remote runner uses plain HTTP.
    allowPlain: true,
    credential: async () => "nzr1.fake",
    onCredentialRefused: async () => null,
    check: async () => ({ result: "accepted", message: "" }),
    connect: () => {
      const made = new FakeSocket();
      socket = made;
      queueMicrotask(() => {
        made.readyState = WebSocket.OPEN;
        made.dispatchEvent(new Event("open"));
      });
      return made as unknown as WebSocket;
    },
    docker: docker as unknown as DockerClient,
    router: new Router(
      docker as unknown as DockerClient,
      {
        directory,
        hostDirectory: directory,
        image: "x",
        acmeEmail: "",
        httpPort: 80,
        httpsPort: 443,
        network: "n",
      } as never,
      silentLog,
    ),
    manageRouter: false,
    log: silentLog,
    workDirectory: join(directory, "work"),
    dockerSocket: "/nowhere",
    containerized: false,
  } as never);
  const running = session.run();
  await until("the hello", () => (socket?.sent ?? []).some((message) => message.type === "hello"));
  const link = socket as unknown as FakeSocket;
  link.receive({
    type: "welcome",
    protocol: RUNNER_PROTOCOL_VERSION,
    controlVersion: "1.0.0-dev",
    serverId: "host",
    serverName: "Nearzero host",
    publicIPv4: null,
    heartbeatIntervalMs: 10_000,
    resume: [],
    close: [],
    received: [],
  });
  link.receive({
    type: "command",
    commandId: "11111111-1111-4111-8111-111111111111",
    kind: "container.wait",
    params: { id: "job", condition: "not-running" },
  });
  await until("the work to start", () => state.started);
  return { session, running, state, directory };
}

describe("stopping the runner during work (C2-02)", () => {
  test("waits for the stopped commands to clean up before it ends", async () => {
    const { session, running, state, directory } = await sessionWith(300);
    session.stop();
    await running;
    expect(state.cleaned).toBe(false);
    const started = Date.now();
    await session.drain(5_000);
    expect(state.cleaned).toBe(true);
    expect(Date.now() - started).toBeLessThan(3_000);
    await rm(directory, { recursive: true, force: true });
  });

  test("never waits past its limit", async () => {
    const { session, running, directory } = await sessionWith(10_000);
    session.stop();
    await running;
    const started = Date.now();
    await session.drain(200);
    expect(Date.now() - started).toBeLessThan(2_000);
    await rm(directory, { recursive: true, force: true });
  });
});

describe("services a backup stopped when the runner was killed (C2-02)", () => {
  test("are noted while down, and started at the next start", async () => {
    const workDirectory = await mkdtemp(join(tmpdir(), "nz-runner-ledger-"));
    const containers = new Map([["web", { running: true }]]);
    const calls: string[] = [];
    let hang: () => void = () => {};
    const docker = {
      findVolume: async (name: string) => ({ Name: name, Labels: {} }),
      createVolume: async () => {},
      removeVolume: async () => {},
      json: async () => [
        {
          Id: "web",
          Names: ["/web"],
          State: "running",
          Labels: {},
          Mounts: [{ Type: "volume", Name: "web-data", Destination: "/d" }],
        },
      ],
      findContainer: async (id: string) => {
        const item = containers.get(id);
        return item
          ? { Id: id, Name: `/${id}`, State: { Running: item.running }, Config: { Labels: {} } }
          : null;
      },
      stopContainer: async (id: string) => {
        calls.push(`stop ${id}`);
        const item = containers.get(id);
        if (item) item.running = false;
      },
      startContainer: async (id: string) => {
        calls.push(`start ${id}`);
        const item = containers.get(id);
        if (item) item.running = true;
      },
      // The archive step's helper never comes back: the runner is killed meanwhile.
      imageExists: () =>
        new Promise((resolve) => {
          hang = () => resolve(true);
        }),
    };
    const params = backupCommandSchemas["backup.volume"].parse({
      runId: "22222222-3333-4444-8555-666666666666",
      volume: "web-data",
      stop: ["web"],
      destination: {
        provider: "minio",
        endpoint: "http://minio.internal:9000",
        bucket: "b",
        region: "us-east-1",
        accessKeyId: "AKID",
        secretAccessKey: "SECRET",
      },
      key: "web/daily/web-data-2026-01-01T00-00-00.tar.gz",
    });
    const context = {
      docker,
      signal: new AbortController().signal,
      stream: { text: () => {} },
      workDirectory,
    } as unknown as CommandContext;
    void backupHandlers["backup.volume"](params, context).catch(() => {});
    await until("web to be stopped", () => calls.includes("stop web"));
    // What the killed runner left: web is down, and noted.
    const ledger = stoppedLedgerDirectory(workDirectory);
    const [noted] = await readdir(ledger);
    expect(JSON.parse(await readFile(join(ledger, noted as string), "utf8"))).toEqual({
      containers: ["web"],
    });
    expect(containers.get("web")?.running).toBe(false);
    // The next runner process starts it before anything else.
    const started = await startLeftStopped(
      docker as unknown as DockerClient,
      workDirectory,
      silentLog,
    );
    expect(started).toEqual(["web"]);
    expect(containers.get("web")?.running).toBe(true);
    expect(await readdir(ledger)).toEqual([]);
    // A second start finds nothing to do.
    expect(
      await startLeftStopped(docker as unknown as DockerClient, workDirectory, silentLog),
    ).toEqual([]);
    hang();
    await rm(workDirectory, { recursive: true, force: true });
  });
});
