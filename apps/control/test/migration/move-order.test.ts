import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { silentLogger } from "../../src/log.ts";
import { type BundleContent, createBundle, openBundle } from "../../src/migration/bundle.ts";
import { importBundle } from "../../src/migration/importer.ts";
import { runnerMoveDriver } from "../../src/migration/move-job.ts";
import {
  type LegacyWorkload,
  type MoveDriver,
  type PublishedPort,
  runMove,
  type StepResult,
} from "../../src/migration/moves.ts";
import { createMigrationHarness, type MigrationHarness } from "./support.ts";

/**
 * Each service's move in the order spec 29.5 gives it, on the server the export came from: its
 * 0.1.x workload stops, its published ports are waited on until free, the 1.0 container starts
 * with the exact ports and the volumes the bundle names, and any failed step removes the 1.0
 * container and starts the 0.1.x workload again as it was.
 */

const PASSPHRASE = "move order passphrase";

function content(passwordHash: string): BundleContent {
  const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();
  const deployed = (ref: string, n: number) => ({
    ref: `dep_${ref}`,
    serviceRef: `svc_${ref}`,
    status: "Running",
    title: "Deploy",
    createdAt: day(n),
    finishedAt: day(n),
    log: "",
    logMissing: true,
  });
  return {
    sourceVersion: "0.1.80",
    installId: "move-order-install",
    records: {
      "people.jsonl": [
        {
          ref: "per_owner",
          email: "owner@example.com",
          firstName: "Owner",
          password: { algorithm: "bcrypt", encoded: passwordHash },
        },
      ],
      "workspaces.jsonl": [{ ref: "wsp_1", name: "Acme", slug: "acme", firstWorkspace: true }],
      "memberships.jsonl": [
        { ref: "mem_1", personRef: "per_owner", workspaceRef: "wsp_1", role: "Owner" },
      ],
      "projects.jsonl": [{ ref: "prj_1", workspaceRef: "wsp_1", name: "Shop" }],
      "environments.jsonl": [
        { ref: "env_1", projectRef: "prj_1", name: "production", default: true },
      ],
      "services.jsonl": [
        {
          ref: "svc_pg",
          environmentRef: "env_1",
          copyGroupRef: "grp_pg",
          kind: "Postgres",
          name: "pg",
          appName: "pg-move",
          place: { host: true },
          variables: "",
          settings: {
            image: "postgres:16",
            credentials: { database: "shop", user: "app", password: "pg-pass" },
            // Outside the range 1.0 picks new public ports from: kept exactly.
            publicPort: 5433,
          },
          // Not named after the app: used as it is.
          volumes: ["nearzero_pg-data"],
          legacy: { kind: "swarm-service", name: "shop_pg" },
        },
        {
          ref: "svc_cache",
          environmentRef: "env_1",
          copyGroupRef: "grp_cache",
          kind: "Redis",
          name: "cache",
          appName: "cache-move",
          place: { host: true },
          variables: "",
          settings: { credentials: { password: "re-pass" }, publicPort: 6380 },
          volumes: ["cache-move-data"],
          legacy: { kind: "container", name: "cache-old" },
        },
        {
          ref: "svc_web",
          environmentRef: "env_1",
          copyGroupRef: "grp_web",
          kind: "Application",
          name: "web",
          appName: "web-move-a1b2c3",
          place: { host: true },
          variables: "",
          settings: {
            source: { type: "Container image", image: "nginx:1.27" },
            ports: [{ published: 8080, target: 80, protocol: "TCP" }],
            mounts: [
              { type: "Volume", containerPath: "/usr/share/nginx/html", volume: "web-move-html" },
              { type: "Volume", containerPath: "/cache", volume: "web-move-a1b2c3-cache" },
            ],
          },
          volumes: ["web-move-html", "web-move-a1b2c3-cache", "web-move-unmounted"],
          legacy: { kind: "container", name: "web-old" },
        },
      ],
      "deployments.jsonl": [deployed("pg", 1), deployed("cache", 2), deployed("web", 3)],
    },
  };
}

class Driver implements MoveDriver {
  readonly calls: string[] = [];
  held = new Map<number, string>();
  failDeploy = new Map<string, string>();
  constructor(private readonly names: Map<string, string>) {}
  #name(id: string): string {
    return this.names.get(id) ?? id;
  }
  async setUpServer(): Promise<StepResult> {
    return { ok: true };
  }
  async runnerReady(): Promise<StepResult> {
    return { ok: true };
  }
  async placeCertificates(): Promise<StepResult> {
    return { ok: true };
  }
  async pushUploads(): Promise<StepResult> {
    return { ok: true };
  }
  async legacy(_target: string, action: string, workload: LegacyWorkload): Promise<StepResult> {
    this.calls.push(`legacy ${action} ${workload.name}`);
    return { ok: true };
  }
  async serverLegacy(): Promise<StepResult> {
    return { ok: true };
  }
  async restoreVolume(): Promise<StepResult> {
    return { ok: true };
  }
  async waitPortsFree(_target: string, ports: PublishedPort[]): Promise<StepResult> {
    this.calls.push(`ports ${ports.map((item) => `${item.port}/${item.protocol}`).join(",")}`);
    const held = ports.filter((item) => this.held.has(item.port));
    if (held.length === 0) return { ok: true };
    return {
      ok: false,
      reason: `${held.map((item) => `port ${item.port}/${item.protocol} is still held by ${this.held.get(item.port)}`).join("; ")}, so it can't be published here`,
    };
  }
  async removeServiceContainers(_target: string, serviceId: string): Promise<StepResult> {
    this.calls.push(`remove 1.0 ${this.#name(serviceId)}`);
    return { ok: true };
  }
  async deploy(
    serviceId: string,
    existing: string | null,
    requested: (id: string) => Promise<void>,
  ): Promise<StepResult> {
    const name = this.#name(serviceId);
    this.calls.push(`deploy ${name}`);
    if (!existing) await requested(crypto.randomUUID());
    const failure = this.failDeploy.get(name);
    return failure ? { ok: false, reason: failure } : { ok: true };
  }
}

let h: MigrationHarness;
const names = new Map<string, string>();

beforeAll(async () => {
  h = await createMigrationHarness();
  const hash = await Bun.password.hash("owner-password-1", { algorithm: "bcrypt", cost: 4 });
  const bytes = await createBundle(content(hash), PASSPHRASE, { N: 2 ** 14 });
  await importBundle(h.services, await openBundle(bytes, PASSPHRASE), {
    dryRun: false,
    inPlace: true,
  });
  for (const row of await h.db.selectFrom("service").select(["id", "name"]).execute()) {
    names.set(row.id, row.name);
  }
}, 120_000);

afterAll(async () => {
  await h?.drop();
});

async function service(name: string) {
  return h.db
    .selectFrom("service")
    .select(["id", "public_port", "settings", "app_name"])
    .where("name", "=", name)
    .executeTakeFirstOrThrow();
}

describe("the import keeps what the move needs exactly (spec 29.5)", () => {
  test("public ports are the bundle's, even outside the range new ones come from", async () => {
    expect((await service("pg")).public_port).toBe(5433);
    expect((await service("cache")).public_port).toBe(6380);
    const web = (await service("web")).settings as { ports: { publishedPort: number }[] };
    expect(web.ports.map((port) => port.publishedPort)).toEqual([8080]);
  });

  test("volume mounts use the volumes the bundle names, never new ones", async () => {
    const pg = (await service("pg")).settings as { dataVolume: string };
    expect(pg.dataVolume).toBe("nearzero_pg-data");
    const web = await service("web");
    const mounts = (web.settings as { mounts: Record<string, unknown>[] }).mounts;
    expect(mounts).toEqual([
      expect.objectContaining({
        type: "volume",
        name: "web-move-html",
        volume: "web-move-html",
        containerPath: "/usr/share/nginx/html",
      }),
      expect.objectContaining({ type: "volume", name: "cache", containerPath: "/cache" }),
    ]);
    expect(mounts[1]).not.toHaveProperty("volume");
    for (const mount of mounts) expect(String(mount.id)).toMatch(/^[a-z0-9]{1,16}$/);
  });
});

describe("each service's move (spec 29.5)", () => {
  test("stop, wait for its ports, deploy; a held port or a failed deploy gives 0.1.x back", async () => {
    const driver = new Driver(names);
    driver.held.set(6380, "the container stray-redis");
    driver.failDeploy.set("web", "it deployed but isn't running");
    const result = await runMove({
      db: h.db,
      secrets: h.services.secrets,
      log: silentLogger,
      driver,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ moved: 1, failed: 2 });
    expect(driver.calls).toEqual([
      "legacy stop shop_pg",
      "ports 5433/tcp",
      "deploy pg",
      "legacy stop cache-old",
      "ports 6380/tcp",
      "remove 1.0 cache",
      "legacy start cache-old",
      "legacy stop web-old",
      "ports 8080/tcp",
      "deploy web",
      "remove 1.0 web",
      "legacy start web-old",
    ]);
    const reasons = Object.fromEntries(
      (
        await h.db
          .selectFrom("migration_move as m")
          .innerJoin("service as s", "s.id", "m.service_id")
          .select(["s.name", "m.state", "m.reason"])
          .execute()
      ).map((row) => [row.name, [row.state, row.reason]]),
    );
    expect(reasons).toEqual({
      pg: ["moved", null],
      cache: [
        "failed",
        "port 6380/tcp is still held by the container stray-redis, so it can't be published here; its 0.1.x workload is running again",
      ],
      web: ["failed", "it deployed but isn't running; its 0.1.x workload is running again"],
    });
  });
});

describe("migrate status reports what actually runs (spec 29.5)", () => {
  test("a moved service with no running container on its server's latest report says so", async () => {
    const { createJoinToken, redeemJoinToken } = await import("../../src/runners/credentials.ts");
    const { migrationStatus, statusText } = await import("../../src/migration/status.ts");
    const pg = (await service("pg")).id;
    // Before any report, nothing is claimed either way.
    expect(
      (await migrationStatus(h.db)).services.find((item) => item.service === "pg")?.running,
    ).toBeNull();
    const host = await redeemJoinToken(h.db, (await createJoinToken(h.db, null)).token);
    await h.db
      .updateTable("runner")
      .set({
        containers: JSON.stringify([{ id: "c1", state: "exited", service: pg }]),
        containers_at: new Date(),
      })
      .where("id", "=", host.runnerId)
      .execute();
    const stopped = await migrationStatus(h.db);
    expect(stopped.services.find((item) => item.service === "pg")?.running).toBe(false);
    const text = statusText(stopped);
    expect(text).toContain("  pg on the Nearzero host: moved, but nothing of it is running now");
    expect(text).toContain(
      "A moved service isn't running now: pg. Start or redeploy it from the console.",
    );
    await h.db
      .updateTable("runner")
      .set({
        containers: JSON.stringify([{ id: "c1", state: "running", service: pg }]),
        containers_at: new Date(),
      })
      .where("id", "=", host.runnerId)
      .execute();
    const running = await migrationStatus(h.db);
    expect(running.services.find((item) => item.service === "pg")?.running).toBe(true);
    expect(statusText(running)).toContain("  pg on the Nearzero host: moved");
    // A report older than three minutes says nothing about now.
    await h.db
      .updateTable("runner")
      .set({ containers_at: new Date(Date.now() - 10 * 60_000) })
      .where("id", "=", host.runnerId)
      .execute();
    expect(
      (await migrationStatus(h.db)).services.find((item) => item.service === "pg")?.running,
    ).toBeNull();
  });
});

describe("rollback's list of volumes to keep", () => {
  test("names every volume the bundle names: services', mounts' and the control plane's", async () => {
    const { runCommand } = await import("../../src/cli/commands.ts");
    const hash = await Bun.password.hash("owner-password-1", { algorithm: "bcrypt", cost: 4 });
    const bytes = await createBundle(content(hash), PASSPHRASE, { N: 2 ** 14 });
    const stdout: string[] = [];
    const io = {
      interactive: false,
      readLine: async () => null,
      readSecret: async () => null,
      out: (line: string) => stdout.push(line),
      err: () => {},
    };
    const code = await runCommand(["migrate", "control-plane", "-"], h.services, io, {
      env: { NEARZERO_MIGRATION_PASSPHRASE: PASSPHRASE },
      readFile: async () => bytes,
    });
    expect(code).toBe(0);
    expect(stdout.filter((line) => line.startsWith("keep "))).toEqual([
      "keep cache-move-data",
      "keep nearzero_pg-data",
      "keep web-move-a1b2c3-cache",
      "keep web-move-html",
      "keep web-move-unmounted",
    ]);
  });
});

describe("the runner driver's port and clean-up steps", () => {
  test("says what holds a port, and removes only the service's own containers", async () => {
    const sent: { kind: string; params: unknown }[] = [];
    const answers: Record<string, unknown> = {
      "ports.wait-free": {
        free: false,
        held: [{ port: 5433, protocol: "tcp", holder: "the Swarm service shop_pg" }],
      },
      "container.list": [{ id: "c1" }, { id: "c2" }],
      "container.remove": {},
    };
    const driver = runnerMoveDriver({
      db: h.db,
      runners: {
        command: async (_target: string, kind: string, params: unknown) => {
          sent.push({ kind, params });
          return answers[kind];
        },
      },
    } as never);
    expect(await driver.waitPortsFree("host", [{ port: 5433, protocol: "tcp" }])).toEqual({
      ok: false,
      reason:
        "port 5433/tcp is still held by the Swarm service shop_pg, so it can't be published here",
    });
    expect(await driver.removeServiceContainers("host", "svc-1")).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        kind: "ports.wait-free",
        params: { ports: [{ port: 5433, protocol: "tcp" }], timeoutSeconds: 60 },
      },
      { kind: "container.list", params: { all: true, labels: ["dev.nearzero.service=svc-1"] } },
      { kind: "container.remove", params: { id: "c1", force: true, volumes: false } },
      { kind: "container.remove", params: { id: "c2", force: true, volumes: false } },
    ]);
  });
});
