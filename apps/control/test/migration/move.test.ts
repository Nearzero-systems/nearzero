import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CliIo } from "../../src/cli/commands.ts";
import { runCommand } from "../../src/cli/commands.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { silentLogger } from "../../src/log.ts";
import { type BundleContent, createBundle, openBundle } from "../../src/migration/bundle.ts";
import { importBundle } from "../../src/migration/importer.ts";
import { legacyScript, rollbackServerScript } from "../../src/migration/legacy.ts";
import { runnerMoveDriver } from "../../src/migration/move-job.ts";
import {
  type LegacyWorkload,
  type MoveDriver,
  type MoveLine,
  type PublishedPort,
  removeLegacyWorkloads,
  retryFailed,
  runMove,
  type StepResult,
  type VolumeArchive,
} from "../../src/migration/moves.ts";
import { initialSteps, SETUP_JOB } from "../../src/server-setup/runs.ts";
import { generateKeyPair } from "../../src/ssh-keys/format.ts";
import { createMigrationHarness, type MigrationHarness, selfSigned } from "./support.ts";

/**
 * The move onto the 1.0 runner (spec 29.2 step 5, 29.5) with a fake driver standing in for the
 * runners, setup and the deploy engine: the order of every step, what happens when a server or
 * a deploy fails, a retry, a repeat after an interruption, and the commands people run.
 */

const PASSPHRASE = "moving-day passphrase";

class FakeDriver implements MoveDriver {
  readonly calls: string[] = [];
  failDeploy = new Map<string, string>();
  failSetup = new Map<string, string>();
  failLegacyStop = new Set<string>();
  failRestore = new Map<string, string>();
  deployments = 0;
  constructor(private readonly names: Map<string, string>) {}

  #name(id: string): string {
    return this.names.get(id) ?? id;
  }

  async setUpServer(serverId: string): Promise<StepResult> {
    this.calls.push(`setup ${this.#name(serverId)}`);
    const failure = this.failSetup.get(this.#name(serverId));
    return failure ? { ok: false, reason: failure } : { ok: true };
  }
  async runnerReady(target: string): Promise<StepResult> {
    this.calls.push(`runner ${this.#name(target)}`);
    return { ok: true };
  }
  async placeCertificates(target: string, store: unknown): Promise<StepResult> {
    const count = (store as { letsencrypt: { Certificates: unknown[] } }).letsencrypt.Certificates
      .length;
    this.calls.push(`certificates ${this.#name(target)} ${count}`);
    return { ok: true };
  }
  async pushUploads(target: string): Promise<StepResult> {
    this.calls.push(`uploads ${this.#name(target)}`);
    return { ok: true };
  }
  async legacy(target: string, action: string, workload: LegacyWorkload): Promise<StepResult> {
    this.calls.push(`legacy ${action} ${workload.name} on ${this.#name(target)}`);
    if (action === "stop" && this.failLegacyStop.has(workload.name))
      return { ok: false, reason: "no such service" };
    return { ok: true };
  }
  async waitPortsFree(target: string, ports: PublishedPort[]): Promise<StepResult> {
    this.calls.push(
      `ports ${ports.map((item) => `${item.port}/${item.protocol}`).join(",")} on ${this.#name(target)}`,
    );
    return { ok: true };
  }
  async removeServiceContainers(target: string, serviceId: string): Promise<StepResult> {
    this.calls.push(`remove 1.0 ${this.#name(serviceId)} on ${this.#name(target)}`);
    return { ok: true };
  }
  async restoreVolume(target: string, archive: VolumeArchive): Promise<StepResult> {
    this.calls.push(`restore ${archive.volume} on ${this.#name(target)}`);
    const failure = this.failRestore.get(archive.volume);
    return failure ? { ok: false, reason: failure } : { ok: true };
  }
  async serverLegacy(
    serverId: string,
    action: string,
    workloads: LegacyWorkload[],
  ): Promise<StepResult> {
    this.calls.push(
      `server ${action} ${workloads.map((item) => item.name).join(",")} on ${this.#name(serverId)}`,
    );
    return { ok: true };
  }
  async deploy(
    serviceId: string,
    existing: string | null,
    requested: (id: string) => Promise<void>,
  ): Promise<StepResult> {
    const name = this.#name(serviceId);
    this.calls.push(existing ? `deploy ${name} (waiting on ${existing})` : `deploy ${name}`);
    if (!existing) {
      this.deployments++;
      await requested(crypto.randomUUID());
    }
    const failure = this.failDeploy.get(name);
    return failure ? { ok: false, reason: failure } : { ok: true };
  }
}

let h: MigrationHarness;
let driver: FakeDriver;
const lines: MoveLine[] = [];
const names = new Map<string, string>();

function memoryIo(): CliIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    interactive: false,
    stdout,
    stderr,
    readLine: async () => null,
    readSecret: async () => null,
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
  };
}

async function bundleBytes(): Promise<Uint8Array> {
  const key = await generateKeyPair("ed25519", "k");
  const issued = await selfSigned(["app.apps.example.com"]);
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();
  const app = (name: string, server: string | null, legacy: LegacyWorkload | null) => ({
    ref: `svc_${name}`,
    environmentRef: "env_1",
    copyGroupRef: `grp_${name}`,
    kind: "Application",
    name,
    appName: `${name}-aaaaaa`,
    place: server ? { serverRef: server } : { host: true },
    variables: "",
    settings: { source: { type: "Container image", image: `example/${name}:1` } },
    volumes: [],
    ...(legacy ? { legacy } : {}),
  });
  const deployed = (name: string, n: number) => ({
    ref: `dep_${name}`,
    serviceRef: `svc_${name}`,
    status: "Succeeded",
    title: "Deploy",
    createdAt: day(n),
    finishedAt: day(n),
    log: "",
    logTruncated: false,
    logMissing: true,
  });
  const store = (certificates: unknown[]) => ({
    letsencrypt: {
      Account: { Email: "a@example.com", Registration: { uri: "u" }, PrivateKey: "pk" },
      Certificates: certificates,
    },
  });
  const content: BundleContent = {
    sourceVersion: "0.1.80",
    records: {
      "people.jsonl": [
        {
          ref: "per_owner",
          email: "owner@example.com",
          firstName: "Owner",
          password: {
            algorithm: "bcrypt",
            encoded: await Bun.password.hash("x-password", { algorithm: "bcrypt", cost: 4 }),
          },
        },
      ],
      "workspaces.jsonl": [{ ref: "wsp_1", name: "Acme", slug: "acme", firstWorkspace: true }],
      "memberships.jsonl": [
        { ref: "mem_1", personRef: "per_owner", workspaceRef: "wsp_1", role: "Owner" },
      ],
      "ssh-keys.jsonl": [
        {
          ref: "key_1",
          workspaceRef: "wsp_1",
          name: "Key",
          publicKey: key.publicKey,
          privateKey: key.privateKey,
        },
      ],
      "servers.jsonl": [
        {
          ref: "srv_a",
          workspaceRef: "wsp_1",
          name: "edge-a",
          address: "198.51.100.1",
          sshKeyRef: "key_1",
          hostnameLabel: "edgea",
          // 29a.9: the router on it, by container name.
          legacy: { container: "old-router-a" },
        },
        {
          ref: "srv_b",
          workspaceRef: "wsp_1",
          name: "edge-b",
          address: "198.51.100.2",
          sshKeyRef: "key_1",
          hostnameLabel: "edgeb",
        },
      ],
      "projects.jsonl": [{ ref: "prj_1", workspaceRef: "wsp_1", name: "Shop" }],
      "environments.jsonl": [
        { ref: "env_1", projectRef: "prj_1", name: "production", default: true },
      ],
      "services.jsonl": [
        app("late", null, { kind: "swarm-service", name: "late-svc" }),
        app("early", null, { kind: "swarm-service", name: "early-svc" }),
        app("broken", null, { kind: "container", name: "broken-ctr" }),
        app("gone", null, { kind: "swarm-service", name: "gone-svc" }),
        app("alpha", "srv_a", { kind: "compose-project", name: "alpha-proj" }),
        app("beta", "srv_b", { kind: "swarm-service", name: "beta-svc" }),
        // No legacy field: its 0.1.x Swarm service is found by its internal app name.
        app("gamma", "srv_b", null),
      ],
      "deployments.jsonl": [
        deployed("late", 20),
        deployed("early", 2),
        deployed("broken", 10),
        deployed("gone", 11),
        deployed("alpha", 5),
        deployed("beta", 1),
        deployed("gamma", 3),
      ],
      "certificates.jsonl": [
        {
          ref: "crt_1",
          workspaceRef: "wsp_1",
          name: "Mine",
          place: { serverRef: "srv_a" },
          certificatePem: issued.certificate,
          privateKeyPem: issued.key,
        },
      ],
    },
    extra: {
      "acme/host/acme.json": store([
        {
          domain: { main: "app.apps.example.com" },
          certificate: b64(issued.certificate),
          key: b64(issued.key),
        },
      ]),
      "acme/srv_a/acme.json": store([]),
      "install.json": {
        // 29a.9: what runs it ({ kind, name } each; a stack isn't one of its kinds), then the
        // Compose project, folder and ports it uses.
        controlPlane: [
          { kind: "swarm-service", name: "nearzero_app" },
          { kind: "compose-project", name: "nearzero" },
          { kind: "swarm-stack", name: "not-a-control-plane-kind" },
        ],
        controlPlaneDetails: {
          composeProject: "nearzero",
          folder: "/opt/nearzero/",
          ports: [3000, 4321],
        },
        controlPlaneVolumes: ["nearzero_db-data"],
      },
    },
  };
  return createBundle(content, PASSPHRASE, { N: 2 ** 14 });
}

let bytes: Uint8Array;

beforeAll(async () => {
  h = await createMigrationHarness();
  bytes = await bundleBytes();
  const bundle = await openBundle(bytes, PASSPHRASE);
  await importBundle(h.services, bundle, { dryRun: false, inPlace: true });
  for (const row of await h.db.selectFrom("service").select(["id", "name"]).execute())
    names.set(row.id, row.name);
  for (const row of await h.db.selectFrom("server").select(["id", "name"]).execute())
    names.set(row.id, row.name);
  names.set("host", "host");
  driver = new FakeDriver(names);
}, 120_000);

afterAll(async () => {
  await h?.drop();
});

function move(signal = new AbortController().signal) {
  return runMove({
    db: h.db,
    secrets: h.services.secrets,
    log: silentLogger,
    driver,
    signal,
    onService: (line) => lines.push(line),
  });
}

async function states(): Promise<Record<string, string>> {
  const rows = await h.db
    .selectFrom("migration_move as m")
    .innerJoin("service as s", "s.id", "m.service_id")
    .select(["s.name", "m.state"])
    .execute();
  return Object.fromEntries(rows.map((row) => [row.name, row.state]));
}

describe("the move", () => {
  test("server by server, oldest deployed first; a failed deploy restarts the 0.1.x workload; a failed server leaves its services", async () => {
    driver.failDeploy.set("broken", "The image example/broken:1 couldn't be pulled");
    driver.failLegacyStop.add("gone-svc");
    driver.failSetup.set("edge-b", "Nearzero couldn't sign in to 198.51.100.2 as root");
    const result = await move();
    expect(result).toEqual({ moved: 3, failed: 4 });
    expect(driver.calls).toEqual([
      "runner host",
      "certificates host 1",
      "legacy stop early-svc on host",
      "deploy early",
      "legacy stop broken-ctr on host",
      "deploy broken",
      "remove 1.0 broken on host",
      "legacy start broken-ctr on host",
      "legacy stop gone-svc on host",
      "legacy stop late-svc on host",
      "deploy late",
      // edge-b's oldest service (beta, day 1) comes before edge-a's (alpha, day 5).
      "setup edge-b",
      "server stop old-router-a on edge-a",
      "setup edge-a",
      "certificates edge-a 0",
      "uploads edge-a",
      "legacy stop alpha-proj on edge-a",
      "deploy alpha",
    ]);
    expect(await states()).toEqual({
      early: "moved",
      broken: "failed",
      gone: "failed",
      late: "moved",
      alpha: "moved",
      beta: "failed",
      gamma: "failed",
    });
    const reasons = Object.fromEntries(
      (
        await h.db
          .selectFrom("migration_move as m")
          .innerJoin("service as s", "s.id", "m.service_id")
          .select(["s.name", "m.reason", "m.legacy_stopped"])
          .execute()
      ).map((row) => [row.name, [row.reason, row.legacy_stopped]]),
    );
    expect(reasons.broken).toEqual([
      "The image example/broken:1 couldn't be pulled; its 0.1.x workload is running again",
      false,
    ]);
    expect(reasons.gone).toEqual([
      "its 0.1.x workload couldn't be stopped (no such service), so it keeps running there",
      false,
    ]);
    expect(reasons.beta).toEqual([
      "its server couldn't be prepared: Nearzero couldn't sign in to 198.51.100.2 as root",
      false,
    ]);
    expect(reasons.early).toEqual([null, true]);
    expect(lines.map((line) => `${line.service} on ${line.server}: ${line.state}`)).toContain(
      "broken on the Nearzero host: failed",
    );
    // Certificates are placed once, before the first route switches.
    const acme = await h.db
      .selectFrom("migration_acme_state")
      .select(["target", "placed_at"])
      .execute();
    expect(acme.every((row) => row.placed_at !== null)).toBe(true);
    expect(
      (await h.db.selectFrom("migration_state").select("phase").executeTakeFirstOrThrow()).phase,
    ).toBe("moved");
  });

  test("the commands show the outcome and only allow finalize when nothing is moving", async () => {
    const io = memoryIo();
    expect(await runCommand(["migrate", "status"], h.services, io)).toBe(0);
    expect(io.stdout).toEqual(
      expect.arrayContaining([
        "3 of 7 services moved, 4 failed.",
        "  edge-b: couldn't be prepared: Nearzero couldn't sign in to 198.51.100.2 as root",
        "  early on the Nearzero host: moved",
        "  broken on the Nearzero host: failed: The image example/broken:1 couldn't be pulled; its 0.1.x workload is running again",
        "Services that failed keep running on 0.1.x. Fix the cause, then run: sudo nearzero migrate retry",
        "To go back to 0.1.x: sudo nearzero migrate rollback",
      ]),
    );
    const plan = memoryIo();
    expect(await runCommand(["migrate", "rollback-plan"], h.services, plan)).toBe(0);
    expect(plan.stdout.sort()).toEqual([
      "container broken-ctr",
      "swarm-service early-svc",
      "swarm-service gone-svc",
      "swarm-service late-svc",
    ]);
  });

  test("retry tries the failed services again, and a repeat never stops a workload twice", async () => {
    driver.failDeploy.clear();
    driver.failLegacyStop.clear();
    driver.failSetup.clear();
    driver.calls.length = 0;
    // An interruption after gamma's deploy was requested: it waits on the same deployment.
    const gamma = [...names].find(([, name]) => name === "gamma")?.[0] as string;
    const io = memoryIo();
    expect(await runCommand(["migrate", "retry"], h.services, io)).toBe(0);
    expect(io.stdout).toEqual([
      "Trying 4 services again. Follow it with: sudo nearzero migrate status",
    ]);
    await h.db
      .updateTable("migration_move")
      .set({ state: "moving", deployment_id: "11111111-1111-4111-8111-111111111111" })
      .where("service_id", "=", gamma)
      .execute();
    const result = await move();
    expect(result).toEqual({ moved: 4, failed: 0 });
    expect(driver.calls).toEqual([
      "legacy stop broken-ctr on host",
      "deploy broken",
      "legacy stop gone-svc on host",
      "deploy gone",
      "setup edge-b",
      "legacy stop beta-svc on edge-b",
      "deploy beta",
      "legacy stop gamma-aaaaaa on edge-b",
      "deploy gamma (waiting on 11111111-1111-4111-8111-111111111111)",
    ]);
    expect(Object.values(await states()).every((state) => state === "moved")).toBe(true);
  });

  test("finalize marks the move done and removes every 0.1.x workload; rollback is refused after", async () => {
    const io = memoryIo();
    expect(await runCommand(["migrate", "finalize"], h.services, io)).toBe(1);
    expect(io.stderr).toEqual([
      "Run it as: sudo nearzero migrate finalize (it asks you to confirm first).",
    ]);
    const yes = memoryIo();
    expect(await runCommand(["migrate", "finalize", "--yes"], h.services, yes)).toBe(0);
    const job = await h.db
      .selectFrom("job")
      .select("kind")
      .where("kind", "=", "migration.finalize")
      .execute();
    expect(job).toHaveLength(1);
    driver.calls.length = 0;
    const removed = await removeLegacyWorkloads(h.db, driver);
    expect(removed).toEqual({ removed: 7, problems: [] });
    expect(driver.calls.sort()).toEqual([
      "legacy remove alpha-proj on edge-a",
      "legacy remove beta-svc on edge-b",
      "legacy remove broken-ctr on host",
      "legacy remove early-svc on host",
      "legacy remove gamma-aaaaaa on edge-b",
      "legacy remove gone-svc on host",
      "legacy remove late-svc on host",
    ]);
    expect((await removeLegacyWorkloads(h.db, driver)).removed).toBe(0);
    const refused = memoryIo();
    expect(await runCommand(["migrate", "rollback-plan"], h.services, refused)).toBe(4);
    expect(refused.stderr).toEqual([
      "The move is finalized: the 0.1.x data is deleted, so it can't be rolled back.",
    ]);
    expect(await retryFailed(h.db)).toBe(0);
  });
});

describe("the import and control-plane commands", () => {
  test("import --dry-run prints the report; a wrong passphrase is refused; control-plane lists the old workloads", async () => {
    const io = memoryIo();
    const options = {
      env: { NEARZERO_MIGRATION_PASSPHRASE: PASSPHRASE },
      readFile: async () => bytes,
    };
    expect(
      await runCommand(
        ["import", "--dry-run", "/opt/nearzero/migration/x.nzx"],
        h.services,
        io,
        options,
      ),
    ).toBe(0);
    expect(io.stdout[0]).toBe("Dry run of the import from Nearzero 0.1.80. Nothing was changed.");
    expect(io.stdout).toContain("  services               0 to import, 7 already imported");
    const wrong = memoryIo();
    expect(
      await runCommand(["import", "x.nzx"], h.services, wrong, {
        env: { NEARZERO_MIGRATION_PASSPHRASE: "nope" },
        readFile: async () => bytes,
      }),
    ).toBe(1);
    expect(wrong.stderr).toEqual(["Wrong passphrase, or the bundle was changed."]);
    const none = memoryIo();
    expect(
      await runCommand(["import", "x.nzx"], h.services, none, {
        env: {},
        readFile: async () => bytes,
      }),
    ).toBe(1);
    expect(none.stderr).toEqual([
      "Set NEARZERO_MIGRATION_PASSPHRASE to the export's passphrase, or run this on a terminal.",
    ]);
    const plane = memoryIo();
    expect(
      await runCommand(["migrate", "control-plane", "x.nzx"], h.services, plane, options),
    ).toBe(0);
    expect(plane.stdout).toEqual([
      "swarm-service nearzero_app",
      "compose-project nearzero",
      "volume nearzero_db-data",
      "project nearzero",
      "folder /opt/nearzero",
      "port 3000",
      "port 4321",
      // Every volume the bundle names, which rollback never removes.
      "keep nearzero_db-data",
    ]);
    expect(io.stdout).toContain(
      "  - The 0.1.x control plane (Compose project nearzero, in /opt/nearzero, holding ports 3000, 4321): swarm-service nearzero_app, compose-project nearzero stop when the move starts, and rollback starts them again.",
    );
  });

  test("the scripts for servers name every workload and quote nothing they shouldn't", () => {
    const script = legacyScript("stop", [
      { kind: "swarm-service", name: "web-1" },
      { kind: "compose-project", name: "stack.2" },
    ]);
    expect(script).toContain("nz_swarm stop 'web-1'");
    expect(script).toContain("nz_compose stop 'stack.2'");
    expect(script).toContain("dev.nearzero.migration.replicas");
    expect(() => legacyScript("stop", [{ kind: "container", name: "x; rm -rf /" }])).toThrow();
    const back = rollbackServerScript([{ kind: "container", name: "old-router" }]);
    expect(back).toContain("systemctl stop nearzero-runner");
    expect(back).toContain("nz_container start 'old-router'");
  });
});

describe("a setup the console started on a moved server (B1-62)", () => {
  test("the move waits for that setup's own job instead of running the same steps beside it", async () => {
    const server = await h.db
      .selectFrom("server")
      .select(["id", "workspace_id", "ssh_user"])
      .executeTakeFirstOrThrow();
    const run = await h.db
      .insertInto("server_setup_run")
      .values({
        server_id: server.id,
        workspace_id: server.workspace_id,
        steps: JSON.stringify(initialSteps()),
        ssh_user: server.ssh_user,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const job = await new JobQueue(h.db, { workerId: "console" }).enqueue({
      kind: SETUP_JOB,
      payload: { runId: run.id },
    });
    await h.db
      .updateTable("server_setup_run")
      .set({ job_id: job.id })
      .where("id", "=", run.id)
      .execute();
    const real = runnerMoveDriver({
      ...h.services,
      runners: { isOnline: () => true },
    } as never);
    let settled: unknown = null;
    const moving = real.setUpServer(server.id, new AbortController().signal).then((result) => {
      settled = result;
      return result;
    });
    await Bun.sleep(2_500);
    // Still waiting, and the run is untouched: nothing ran its steps a second time.
    expect(settled).toBeNull();
    const meanwhile = await h.db
      .selectFrom("server_setup_run")
      .select(["state", "log_seq"])
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    expect(meanwhile).toMatchObject({ state: "running", log_seq: 0 });
    await h.db
      .updateTable("server_setup_run")
      .set({ state: "succeeded", finished_at: new Date() })
      .where("id", "=", run.id)
      .execute();
    expect(await moving).toEqual({ ok: true });
    await h.db.deleteFrom("server_setup_run").where("id", "=", run.id).execute();
  }, 30_000);
});
