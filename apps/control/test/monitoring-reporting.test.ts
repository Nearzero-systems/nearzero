import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { storagePercent } from "@nearzero/shared";
import { ObjectRegistry } from "../src/access/objects.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { type Browser, createHarness, type Harness, setUpNamedOwner } from "./support/harness.ts";

/**
 * Monitoring answers (spec 14.1, 14.2): storage as df counts it, from runners that send what is
 * available and from older ones that don't (30c R3-34), and a server that stopped reporting,
 * whose last sample is history, not its current state (30c R3-33).
 */

let harness: Harness;
let owner: Browser;
let serverId = "";
let runnerId = "";
/** How far the control plane's clock is ahead of the real one. */
let ahead = 0;

const GB = 1024 ** 3;

function hello(): string {
  return JSON.stringify({
    type: "hello",
    runnerVersion: "1.0.0-dev",
    protocol: 1,
    minProtocol: 1,
    startedAt: Date.now(),
    system: {
      hostname: "h",
      os: "Linux",
      kernel: "6",
      architecture: "x86_64",
      cpuModel: "x",
      cpuCores: 1,
      cpuThreads: 1,
      cpuMhz: 0,
      memoryTotalBytes: 1,
      dockerVersion: "28.0.0",
      containerized: false,
    },
    checks: { docker: true, network: true, router: true, routerDirectory: true },
    streams: [],
    commands: [],
  });
}

function attach() {
  const link = harness.services.runners.attach({ send() {}, close() {} }, { runnerId, serverId });
  link.message(hello());
  return link;
}

async function until(what: string, check: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (await check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function metrics(target = serverId) {
  const reply = await owner.get(`/servers/${target}/metrics?points=50`);
  expect(reply.status).toBe(200);
  return reply.body;
}

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({ extra: { objects, now: () => Date.now() + ahead } });
  owner = await setUpNamedOwner(harness);
  const generated = await owner.post("/ssh-keys/generate", { type: "ed25519", name: "k" });
  const key = await owner.post("/ssh-keys", {
    name: "k",
    publicKey: generated.body.publicKey,
    privateKey: generated.body.privateKey,
  });
  const created = await owner.post("/servers", {
    name: "Prod 1",
    sshKeyId: key.body.key.id,
    address: "198.51.100.30",
    sshUser: "root",
  });
  serverId = created.body.server.id;
  runnerId = (
    await harness.test.db
      .insertInto("runner")
      .values({ server_id: serverId })
      .returning("id")
      .executeTakeFirstOrThrow()
  ).id;
}, 60_000);

afterAll(async () => {
  harness?.services.runners.stop();
  await harness?.drop();
}, 60_000);

describe("storage usage (30c R3-34)", () => {
  test("a sample with df's available figure is kept and read as df counts it; an older runner's still shows", async () => {
    const link = attach();
    await until("the runner to connect", () => harness.services.runners.isOnline(serverId));
    const at = Date.now() - 10_000;
    link.message(
      JSON.stringify({
        type: "metrics",
        samples: [
          // An older runner's sample: no available figure.
          {
            at,
            cpuPercent: 5,
            memoryUsedBytes: 1,
            memoryTotalBytes: 2,
            diskUsedBytes: 40 * GB,
            diskTotalBytes: 100 * GB,
            uptimeSeconds: 10,
          },
          // A full disk with 5% reserved for root: df says 100%, used / total says 95%.
          {
            at: at + 5_000,
            cpuPercent: 5,
            memoryUsedBytes: 1,
            memoryTotalBytes: 2,
            diskUsedBytes: 95 * GB,
            diskTotalBytes: 100 * GB,
            diskAvailableBytes: 0,
            uptimeSeconds: 15,
          },
        ],
      }),
    );
    await until("both samples", async () => ((await metrics()).samples as unknown[]).length === 2);
    const body = await metrics();
    const [older, newer] = body.samples;
    expect(older.diskAvailableBytes).toBeUndefined();
    expect(storagePercent(older)).toBe(40);
    expect(newer.diskAvailableBytes).toBe(0);
    expect(storagePercent(newer)).toBe(100);
    expect(body.latest).toEqual(newer);
    expect(body.reporting).toEqual({
      current: true,
      lastSampleAt: new Date(at + 5_000).toISOString(),
      message: null,
    });
  }, 30_000);
});

describe("a server that stopped reporting (30c R3-33)", () => {
  test("its last sample stays history once its runner has been gone over a minute", async () => {
    // Still connected from the test above, then the link drops.
    expect(harness.services.runners.isOnline(serverId)).toBe(true);
    const sampled = await metrics();
    const lastAt = sampled.samples.at(-1).at as number;
    harness.services.runners.disconnect(serverId);
    await until(
      "the runner row to say it's gone",
      async () =>
        (
          await harness.test.db
            .selectFrom("runner")
            .select("disconnected_at")
            .where("id", "=", runnerId)
            .executeTakeFirstOrThrow()
        ).disconnected_at !== null,
    );
    // A moment later it is still current: a runner reconnects by itself.
    ahead = 0;
    expect((await metrics()).reporting.current).toBe(true);
    expect((await metrics()).latest).not.toBeNull();

    // Over a minute later it isn't: no current-looking figures, and when the last one was taken.
    ahead = 61_000;
    const stale = await metrics();
    expect(stale.latest).toBeNull();
    expect(stale.samples).toHaveLength(2);
    const when = `${new Date(lastAt).toISOString().slice(0, 19).replace("T", " ")} UTC`;
    expect(stale.reporting).toEqual({
      current: false,
      lastSampleAt: new Date(lastAt).toISOString(),
      message: `Prod 1 isn't reporting. The last sample was taken ${when}.`,
    });

    // Back again: current at once.
    attach();
    await until("the runner to reconnect", () => harness.services.runners.isOnline(serverId));
    const back = await metrics();
    expect(back.reporting.current).toBe(true);
    expect(back.latest).not.toBeNull();
    ahead = 0;
  }, 30_000);

  test("the host says so in its own name, and a runner that never sent a sample gets no message", async () => {
    ahead = 10 * 60_000;
    // The host never connected here and has no samples: the panel's "No samples yet" covers it.
    const host = await metrics("host");
    expect(host.samples).toEqual([]);
    expect(host.latest).toBeNull();
    expect(host.reporting).toEqual({ current: false, lastSampleAt: null, message: null });
    await harness.test.db
      .insertInto("server_metric")
      .values({
        target: "host",
        at: new Date(Date.now() - 5 * 60_000),
        cpu_percent: 1,
        memory_used_bytes: 1,
        memory_total_bytes: 2,
        disk_used_bytes: 1,
        disk_total_bytes: 2,
        uptime_seconds: 1,
      })
      .execute();
    const old = await metrics("host");
    expect(old.latest).toBeNull();
    expect(old.reporting.message).toStartWith("The Nearzero host isn't reporting. The last sample");
    ahead = 0;
  }, 30_000);
});
