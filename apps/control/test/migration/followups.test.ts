import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import type { CliIo } from "../../src/cli/commands.ts";
import { runCommand } from "../../src/cli/commands.ts";
import { silentLogger } from "../../src/log.ts";
import { type BundleContent, createBundle, openBundle } from "../../src/migration/bundle.ts";
import { findConsolePath } from "../../src/migration/console-paths.ts";
import { archiveBytes, ImportRefused, OTHER_INSTALL } from "../../src/migration/import-extras.ts";
import { importBundle } from "../../src/migration/importer.ts";
import {
  type LegacyWorkload,
  type MoveDriver,
  runMove,
  type StepResult,
  type VolumeArchive,
} from "../../src/migration/moves.ts";
import { createJoinToken, redeemJoinToken } from "../../src/runners/credentials.ts";
import { generateKeyPair } from "../../src/ssh-keys/format.ts";
import { createMigrationHarness, type MigrationHarness } from "./support.ts";

/**
 * What a move keeps working besides the records (spec 29.5, 29a.9, 29a.9.1), on another machine:
 * a bundle from another 0.1.x install is refused, the 0.1.x webhook paths keep answering, volume
 * archives are kept sealed and restored before the first deploy, and old console addresses find
 * the object they showed.
 */

const PASSPHRASE = "another machine passphrase";
const TOKEN = "legacy-deploy-token-0123456789abcdef";
const GITHUB_SECRET = "gh-old-webhook-secret";
const ARCHIVE = new TextEncoder().encode(`plain volume data ${"x".repeat(5000)}`);
const OLD = {
  project: "/acme/project/p-1",
  environment: "/acme/project/p-1/environment/e-1",
  service: "/acme/project/p-1/environment/e-1/services/application/s-1",
  deployment: "/acme/project/p-1/environment/e-1/services/application/s-1/deployments/d-1",
};

interface Keys {
  passwordHash: string;
  publicKey: string;
  privateKey: string;
}

function content(installId: string, keys: Keys): BundleContent {
  return {
    sourceVersion: "0.1.80",
    installId,
    records: {
      "people.jsonl": [
        {
          ref: "per_owner",
          email: "owner@example.com",
          firstName: "Owner",
          password: { algorithm: "bcrypt", encoded: keys.passwordHash },
        },
      ],
      "ssh-keys.jsonl": [
        {
          ref: "key_1",
          workspaceRef: "wsp_1",
          name: "Key",
          publicKey: keys.publicKey,
          privateKey: keys.privateKey,
        },
      ],
      "servers.jsonl": [
        {
          ref: "srv_1",
          workspaceRef: "wsp_1",
          name: "elsewhere",
          address: "198.51.100.9",
          sshKeyRef: "key_1",
          hostnameLabel: "elsewhere",
        },
      ],
      "workspaces.jsonl": [{ ref: "wsp_1", name: "Acme", slug: "acme", firstWorkspace: true }],
      "memberships.jsonl": [
        { ref: "mem_1", personRef: "per_owner", workspaceRef: "wsp_1", role: "Owner" },
      ],
      "git-providers.jsonl": [
        {
          ref: "git_1",
          workspaceRef: "wsp_1",
          ownerRef: "per_owner",
          shared: true,
          kind: "GitHub",
          name: "Acme GitHub",
          connection: "Own app",
          urls: { web: "https://github.com/apps/acme", internal: null, redirect: null },
          app: {
            appId: 424242,
            appName: "acme",
            clientId: "Iv1.x",
            clientSecret: "client-secret",
            privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n",
            webhookSecret: GITHUB_SECRET,
          },
          oauth: null,
          installationIds: [],
          tokens: null,
          account: null,
        },
      ],
      "projects.jsonl": [
        { ref: "prj_1", workspaceRef: "wsp_1", name: "Shop", legacyConsolePath: OLD.project },
      ],
      "environments.jsonl": [
        {
          ref: "env_1",
          projectRef: "prj_1",
          name: "production",
          default: true,
          legacyConsolePath: OLD.environment,
        },
      ],
      "services.jsonl": [
        {
          ref: "svc_web",
          environmentRef: "env_1",
          copyGroupRef: "grp_web",
          kind: "Application",
          name: "web",
          appName: "web-q1w2e3",
          place: { host: true },
          variables: "",
          settings: {
            source: { type: "Container image", image: "example/web:1" },
            webhookToken: TOKEN,
            mounts: [
              { type: "Volume", containerPath: "/data", volume: "web-q1w2e3-data" },
              { type: "File", containerPath: "/etc/web.conf", content: "listen 8080" },
            ],
          },
          volumes: ["web-q1w2e3-data"],
          legacy: { kind: "container", name: "web-old" },
          servicePort: 8080,
          legacyConsolePath: `${OLD.service}/`,
        },
      ],
      "deployments.jsonl": [
        {
          ref: "dep_1",
          serviceRef: "svc_web",
          status: "Succeeded",
          title: "Deploy",
          createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
          finishedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
          log: "",
          logMissing: true,
          legacyConsolePath: `${OLD.deployment}?tab=logs`,
        },
      ],
    },
    extra: {
      "install.json": {
        legacyWebhookPaths: { deploy: "/api/deploy/{token}", github: "/api/deploy/github" },
      },
      "volumes/svc_web/web-q1w2e3-data.tar": ARCHIVE,
    },
  };
}

class Driver implements MoveDriver {
  readonly calls: string[] = [];
  failRestore: string | null = null;
  async setUpServer(): Promise<StepResult> {
    return { ok: true };
  }
  async runnerReady(target: string): Promise<StepResult> {
    this.calls.push(`runner ${target}`);
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
  async waitPortsFree(): Promise<StepResult> {
    return { ok: true };
  }
  async removeServiceContainers(target: string): Promise<StepResult> {
    this.calls.push(`remove 1.0 web on ${target}`);
    return { ok: true };
  }
  async restoreVolume(target: string, archive: VolumeArchive): Promise<StepResult> {
    this.calls.push(`restore ${archive.volume} (${archive.sizeBytes} bytes) on ${target}`);
    return this.failRestore ? { ok: false, reason: this.failRestore } : { ok: true };
  }
  async deploy(
    _serviceId: string,
    existing: string | null,
    requested: (id: string) => Promise<void>,
  ): Promise<StepResult> {
    this.calls.push("deploy web");
    if (!existing) await requested(crypto.randomUUID());
    return { ok: true };
  }
}

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

let h: MigrationHarness;
let keys: Keys;
let bytesA: Uint8Array;
let serviceId = "";

beforeAll(async () => {
  h = await createMigrationHarness();
  const pair = await generateKeyPair("ed25519", "k");
  keys = {
    passwordHash: await Bun.password.hash("owner-password-123", { algorithm: "bcrypt", cost: 4 }),
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  };
  bytesA = await createBundle(content("install-a", keys), PASSPHRASE, { N: 2 ** 14 });
  const bundle = await openBundle(bytesA, PASSPHRASE);
  const result = await importBundle(h.services, bundle, { dryRun: false, inPlace: false });
  expect(result.report.install.map((line) => line.name)).toEqual(
    expect.arrayContaining(["webhooks", "volumes", "console addresses"]),
  );
  serviceId = (
    await h.db
      .selectFrom("service")
      .select("id")
      .where("name", "=", "web")
      .executeTakeFirstOrThrow()
  ).id;
}, 120_000);

afterAll(async () => {
  await h?.drop();
});

describe("29a.9 fields", () => {
  test("servicePort and containerPath mounts are used as the export gives them", async () => {
    const row = await h.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow();
    const text = JSON.stringify(row);
    expect(text).toContain("8080");
    expect(text).toContain("/data");
    expect(text).toContain("/etc/web.conf");
  });

  test("a bundle from another 0.1.x install is refused; the same install imports again", async () => {
    const other = await openBundle(
      await createBundle(content("install-b", keys), PASSPHRASE, { N: 2 ** 14 }),
      PASSPHRASE,
    );
    await expect(
      importBundle(h.services, other, { dryRun: true, inPlace: false }),
    ).rejects.toBeInstanceOf(ImportRefused);
    const io = memoryIo();
    const code = await runCommand(["import", "/tmp/other.nzx"], h.services, io, {
      env: { NEARZERO_MIGRATION_PASSPHRASE: PASSPHRASE },
      readFile: async () => createBundle(content("install-b", keys), PASSPHRASE, { N: 2 ** 14 }),
    });
    expect(code).toBe(1);
    expect(io.stderr).toEqual([OTHER_INSTALL]);
    const again = await importBundle(h.services, await openBundle(bytesA, PASSPHRASE), {
      dryRun: true,
      inPlace: false,
    });
    expect(again.report).toBeDefined();
  });
});

describe("old webhook paths (spec 29.5)", () => {
  test("a deploy webhook's old path reaches its service; a wrong token or unknown path doesn't", async () => {
    const browser = h.browser();
    const ok = await browser.post(`/webhooks/legacy/api/deploy/${TOKEN}`, {});
    expect([200, 202]).toContain(ok.status);
    const row = await h.db
      .selectFrom("deploy_webhook")
      .select("last_called_at")
      .where("service_id", "=", serviceId)
      .executeTakeFirstOrThrow();
    expect(row.last_called_at).not.toBeNull();
    expect(
      (await browser.post("/webhooks/legacy/api/deploy/not-the-token-0123456789", {})).status,
    ).toBe(401);
    expect((await browser.post("/webhooks/legacy/somewhere/else", {})).status).toBe(404);
    // 1.0's own addresses are never reached through the old-path route.
    expect(
      (await browser.post(`/webhooks/legacy/api/v1/webhooks/deploy/${TOKEN}`, {})).status,
    ).toBe(404);
    // 0.1.x also deployed on a GET: a kept address now says to use POST and deploys nothing
    // (G4-17); a path that isn't one stays not found.
    const before = await h.db
      .selectFrom("deployment")
      .select("id")
      .where("service_id", "=", serviceId)
      .execute();
    const get = await browser.get(`/webhooks/legacy/api/deploy/${TOKEN}`);
    expect(get.status).toBe(405);
    expect(get.body.error.message).toBe("Call this webhook with POST.");
    expect(get.headers.get("allow")).toBe("POST");
    expect((await browser.get("/webhooks/legacy/somewhere/else")).status).toBe(404);
    const after = await h.db
      .selectFrom("deployment")
      .select("id")
      .where("service_id", "=", serviceId)
      .execute();
    expect(after.length).toBe(before.length);
  });

  test("the GitHub App's old path checks the signature with the imported app's secret", async () => {
    const body = new TextEncoder().encode(JSON.stringify({ zen: "Keep it simple." }));
    const sign = (secret: string) =>
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const browser = h.browser();
    const ok = await browser.request("POST", "/webhooks/legacy/api/deploy/github", body, {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-github-hook-installation-target-id": "424242",
      "x-hub-signature-256": sign(GITHUB_SECRET),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, message: "Pong" });
    // Without the app's id, each imported app is tried; a wrong signature is still refused.
    const bad = await browser.request("POST", "/webhooks/legacy/api/deploy/github", body, {
      "content-type": "application/json",
      "x-github-event": "ping",
      "x-hub-signature-256": sign("someone else's secret"),
    });
    expect(bad.status).toBe(401);
  });
});

describe("volume archives (moving to another machine)", () => {
  test("are kept sealed, and only this service's runner downloads the plain archive", async () => {
    const archive = await h.db
      .selectFrom("migration_volume_archive")
      .selectAll()
      .where("service_id", "=", serviceId)
      .executeTakeFirstOrThrow();
    expect(Number(archive.size_bytes)).toBe(ARCHIVE.length);
    expect(archive.restored_at).toBeNull();
    const parts = await h.db
      .selectFrom("migration_volume_archive_part")
      .select("bytes")
      .where("archive_id", "=", archive.id)
      .execute();
    const stored = Buffer.concat(parts.map((part) => part.bytes));
    expect(stored.includes(Buffer.from("plain volume data"))).toBe(false);
    const opened: Buffer[] = [];
    for await (const piece of archiveBytes(h.db, h.services.secrets, archive.id))
      opened.push(piece);
    expect(Buffer.concat(opened).equals(Buffer.from(ARCHIVE))).toBe(true);

    const path = `/api/v1/runner/migration-archives/${archive.id}`;
    const host = await redeemJoinToken(h.db, (await createJoinToken(h.db, null)).token);
    const download = await h.app.request(path, {
      headers: { authorization: `Bearer ${host.credential}` },
    });
    expect(download.status).toBe(200);
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(ARCHIVE);
    expect((await h.app.request(path)).status).toBe(401);
    const server = await h.db
      .selectFrom("server")
      .select("id")
      .where("name", "=", "elsewhere")
      .executeTakeFirstOrThrow();
    const other = await redeemJoinToken(h.db, (await createJoinToken(h.db, server.id)).token);
    const refused = await h.app.request(path, {
      headers: { authorization: `Bearer ${other.credential}` },
    });
    expect(refused.status).toBe(404);
  });

  test("are restored before the first deploy; a failed restore leaves the service failed until retry", async () => {
    const driver = new Driver();
    driver.failRestore = "no space left on device";
    const context = {
      db: h.db,
      secrets: h.services.secrets,
      log: silentLogger,
      driver,
      signal: new AbortController().signal,
    };
    expect(await runMove(context)).toEqual({ moved: 0, failed: 1 });
    expect(driver.calls).toEqual(["runner host", "restore web-q1w2e3-data (5018 bytes) on host"]);
    const failed = await h.db
      .selectFrom("migration_move")
      .select(["state", "reason"])
      .where("service_id", "=", serviceId)
      .executeTakeFirstOrThrow();
    expect(failed).toEqual({
      state: "failed",
      reason:
        "its data couldn't be restored into the volume web-q1w2e3-data (no space left on device)",
    });

    await h.db
      .updateTable("migration_move")
      .set({ state: "waiting" })
      .where("service_id", "=", serviceId)
      .execute();
    driver.failRestore = null;
    driver.calls.length = 0;
    expect(await runMove(context)).toEqual({ moved: 1, failed: 0 });
    // The host was prepared on the first run; only the service's own steps run again.
    expect(driver.calls).toEqual(["restore web-q1w2e3-data (5018 bytes) on host", "deploy web"]);
    const archive = await h.db
      .selectFrom("migration_volume_archive")
      .select("restored_at")
      .where("service_id", "=", serviceId)
      .executeTakeFirstOrThrow();
    expect(archive.restored_at).not.toBeNull();
  });
});

describe("old console addresses (29a.9.1)", () => {
  test("each kept path finds its object, with or without the old workspace prefix", async () => {
    const kinds = async (path: string) => (await findConsolePath(h.db, path))?.kind ?? null;
    expect(await kinds(OLD.project)).toBe("project");
    expect(await kinds(OLD.project.replace("/acme", ""))).toBe("project");
    expect(await kinds(OLD.environment)).toBe("environment");
    expect(await kinds(`${OLD.service}?tab=logs`)).toBe("service");
    expect(await kinds(OLD.service.replace("/acme", "/renamed"))).toBe("service");
    expect(await kinds(OLD.deployment)).toBe("deployment");
    expect(await kinds("/acme/project/p-2")).toBeNull();
  });

  test("the lookup asks signed-out people to sign in and gives members the object's page", async () => {
    const browser = h.browser();
    const ask = (path: string) =>
      browser.get(`/migration/console-path?path=${encodeURIComponent(path)}`);
    expect((await ask(OLD.service)).body).toEqual({ signIn: true });
    expect((await ask("/acme/project/unknown")).status).toBe(404);
    expect((await browser.signIn("owner@example.com", "owner-password-123")).status).toBe(200);
    const service = await ask(OLD.service.replace("/acme", ""));
    const ids = await h.db
      .selectFrom("service")
      .select(["project_id", "environment_id"])
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow();
    expect(service.body).toEqual({
      target: {
        kind: "service",
        workspace: "acme",
        projectId: ids.project_id,
        environmentId: ids.environment_id,
        serviceId,
      },
    });
    const project = await ask(OLD.project);
    expect(project.body.target).toMatchObject({
      kind: "project",
      projectId: ids.project_id,
      environmentId: ids.environment_id,
    });
    const deployment = await ask(OLD.deployment);
    expect(deployment.body.target.kind).toBe("deployment");
    expect(typeof deployment.body.target.deploymentId).toBe("string");
  });
});
