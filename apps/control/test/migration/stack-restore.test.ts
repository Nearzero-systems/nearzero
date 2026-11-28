import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CliIo } from "../../src/cli/commands.ts";
import { runCommand } from "../../src/cli/commands.ts";
import { type BundleContent, createBundle, openBundle } from "../../src/migration/bundle.ts";
import { importBundle } from "../../src/migration/importer.ts";
import { rollbackServerScript } from "../../src/migration/legacy.ts";
import { stackFiles } from "../../src/migration/legacy-fields.ts";
import { runnerMoveDriver } from "../../src/migration/move-job.ts";
import { type LegacyWorkload, movedNotFinalized } from "../../src/migration/moves.ts";
import { generateKeyPair } from "../../src/ssh-keys/format.ts";
import { createMigrationHarness, type MigrationHarness } from "./support.ts";

/**
 * A moved Compose stack keeps its 0.1.x project name, so 1.0's deploy may replace 0.1.x's stopped
 * containers. Its 0.1.x copy comes back from its own files (spec 29.5, 29a.9 `legacy`), never
 * from containers that may be gone, and 1.0 keeps Compose's orphans until finalize.
 */

const PASSPHRASE = "stack restore passphrase";

function stack(
  ref: string,
  appName: string,
  legacy: Record<string, unknown>,
  place: Record<string, unknown> = { host: true },
) {
  return {
    ref,
    environmentRef: "env_1",
    copyGroupRef: `grp_${ref}`,
    kind: "Compose",
    name: ref.replace("svc_", ""),
    appName,
    place,
    variables: "",
    settings: {
      source: { type: "Pasted Compose file" },
      format: "Compose",
      composeFile: "services:\n  web:\n    image: nginx:1.27\n",
      randomizeNames: false,
    },
    volumes: [`${appName}_data`],
    legacy,
  };
}

function content(hash: string, key: { publicKey: string; privateKey: string }): BundleContent {
  const deployed = (ref: string, n: number) => ({
    ref: `dep_${ref}`,
    serviceRef: ref,
    status: "Running",
    title: "Deploy",
    createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    finishedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    log: "",
    logMissing: true,
  });
  return {
    sourceVersion: "0.1.80",
    installId: "stack-restore-install",
    records: {
      "people.jsonl": [
        {
          ref: "per_owner",
          email: "owner@example.com",
          firstName: "Owner",
          password: { algorithm: "bcrypt", encoded: hash },
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
          ref: "srv_1",
          workspaceRef: "wsp_1",
          name: "edge",
          address: "198.51.100.7",
          sshKeyRef: "key_1",
          hostnameLabel: "edge",
        },
      ],
      "projects.jsonl": [{ ref: "prj_1", workspaceRef: "wsp_1", name: "Shop" }],
      "environments.jsonl": [
        { ref: "env_1", projectRef: "prj_1", name: "production", default: true },
      ],
      "services.jsonl": [
        // The export writes the folder as a path on the service's server; used as it is.
        stack("svc_shop", "shop", {
          kind: "compose-project",
          name: "shop",
          folder: "/srv/stacks/shop/",
          composeFiles: ["docker-compose.prod.yml", "docker-compose.local-db.yml", "../escape.yml"],
          envFile: ".env",
        }),
        stack("svc_blog", "blog", { kind: "compose-project", name: "blog" }),
        // 0.1.x keeps this stack's env file outside its folder, under its data folders.
        stack("svc_wiki", "wiki", {
          kind: "compose-project",
          name: "wiki",
          folder: "/srv/stacks/wiki",
          composeFiles: ["docker-compose.yml"],
          envFile: "/var/lib/nearzero-data/secrets/compose-env/wiki.env",
        }),
        // On a remote server 0.1.x keeps app, Compose and secret files in /etc/nearzero.
        stack(
          "svc_remote",
          "remote",
          {
            kind: "compose-project",
            name: "remote",
            folder: "/etc/nearzero/compose/remote",
            composeFiles: ["docker-compose.yml"],
            envFile: "/etc/nearzero/secrets/compose-env/remote.env",
          },
          { serverRef: "srv_1" },
        ),
        stack("svc_mail", "mail", {
          kind: "compose-project",
          name: "mail",
          folder: "/srv/stacks/mail",
          envFile: "/var/lib/nearzero-data/../../etc/shadow",
        }),
      ],
      "deployments.jsonl": [
        deployed("svc_shop", 1),
        deployed("svc_blog", 2),
        deployed("svc_wiki", 3),
        deployed("svc_mail", 4),
        deployed("svc_remote", 5),
      ],
    },
    extra: {
      "install.json": {
        controlPlaneDetails: { composeProject: "nearzero", folder: "/var/lib/nearzero-data" },
        controlPlaneVolumes: ["nearzero_data"],
      },
    },
  };
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
let report: Awaited<ReturnType<typeof importBundle>>["report"];

beforeAll(async () => {
  h = await createMigrationHarness();
  const hash = await Bun.password.hash("owner-password-1", { algorithm: "bcrypt", cost: 4 });
  const pair = await generateKeyPair("ed25519", "k");
  const bytes = await createBundle(content(hash, pair), PASSPHRASE, { N: 2 ** 14 });
  const result = await importBundle(h.services, await openBundle(bytes, PASSPHRASE), {
    dryRun: false,
    inPlace: true,
  });
  report = result.report;
}, 120_000);

afterAll(async () => {
  await h?.drop();
});

async function legacyOf(name: string): Promise<LegacyWorkload> {
  const row = await h.db
    .selectFrom("migration_move as m")
    .innerJoin("service as s", "s.id", "m.service_id")
    .select("m.legacy")
    .where("s.name", "=", name)
    .executeTakeFirstOrThrow();
  return row.legacy as LegacyWorkload;
}

describe("a moved stack's own files (29a.9 legacy)", () => {
  test("are kept with its move: the folder as given, files in order, nothing outside it", async () => {
    expect(await legacyOf("shop")).toEqual({
      kind: "compose-project",
      name: "shop",
      folder: "/srv/stacks/shop",
      composeFiles: ["docker-compose.prod.yml", "docker-compose.local-db.yml"],
      envFile: ".env",
    });
    expect(await legacyOf("blog")).toEqual({ kind: "compose-project", name: "blog" });
    // An env file outside the folder comes with the install's data folders it must be under;
    // one with a way back up is dropped.
    expect(await legacyOf("wiki")).toEqual({
      kind: "compose-project",
      name: "wiki",
      folder: "/srv/stacks/wiki",
      composeFiles: ["docker-compose.yml"],
      envFile: "/var/lib/nearzero-data/secrets/compose-env/wiki.env",
      dataFolders: ["/opt/nearzero", "/etc/nearzero", "/var/lib/nearzero-data"],
      dataVolumes: ["nearzero_data"],
    });
    // A remote server's stack: only the data folders every server has (29a.9).
    expect(await legacyOf("remote")).toEqual({
      kind: "compose-project",
      name: "remote",
      folder: "/etc/nearzero/compose/remote",
      composeFiles: ["docker-compose.yml"],
      envFile: "/etc/nearzero/secrets/compose-env/remote.env",
      dataFolders: ["/opt/nearzero", "/etc/nearzero"],
      dataVolumes: [],
    });
    expect(await legacyOf("mail")).toEqual({
      kind: "compose-project",
      name: "mail",
      folder: "/srv/stacks/mail",
      composeFiles: [],
    });
    expect(stackFiles({ folder: "relative" })).toBeNull();
  });

  test("a stack without its folder is listed as one that can't be restored from its files", () => {
    const changed = report.changed.map((line) => line.message);
    expect(changed).toContain(
      "Service blog: its 0.1.x Compose project blog can't be restored from its files (the export doesn't name its folder), so a failed move or a rollback starts its stopped containers again.",
    );
    expect(changed.some((line) => line.includes("Compose project shop"))).toBe(false);
  });

  test("the rollback plan names them, so the host's rollback runs them", async () => {
    const io = memoryIo();
    expect(await runCommand(["migrate", "rollback-plan"], h.services, io)).toBe(0);
    expect(io.stdout).toEqual([
      "compose-project shop",
      "stackfolder shop /srv/stacks/shop",
      "stackfile shop docker-compose.prod.yml",
      "stackfile shop docker-compose.local-db.yml",
      "stackenv shop .env",
      "compose-project blog",
      "compose-project wiki",
      "stackfolder wiki /srv/stacks/wiki",
      "stackfile wiki docker-compose.yml",
      "stackenv wiki /var/lib/nearzero-data/secrets/compose-env/wiki.env",
      "compose-project mail",
      "stackfolder mail /srv/stacks/mail",
    ]);
  });

  test("a failed move's restart and a remote server's rollback start it from its files", async () => {
    const sent: { kind: string; params: unknown }[] = [];
    const driver = runnerMoveDriver({
      db: h.db,
      runners: {
        command: async (_target: string, kind: string, params: unknown) => {
          sent.push({ kind, params });
          return { found: true, running: true };
        },
      },
    } as never);
    expect(await driver.legacy("host", "start", await legacyOf("shop"))).toEqual({ ok: true });
    expect(await driver.legacy("host", "start", await legacyOf("blog"))).toEqual({ ok: true });
    expect(sent).toEqual([
      {
        kind: "legacy.workload",
        params: {
          action: "start",
          kind: "compose-project",
          name: "shop",
          folder: "/srv/stacks/shop",
          composeFiles: ["docker-compose.prod.yml", "docker-compose.local-db.yml"],
          envFile: ".env",
          dataFolders: [],
          dataVolumes: [],
        },
      },
      {
        kind: "legacy.workload",
        params: { action: "start", kind: "compose-project", name: "blog" },
      },
    ]);
    expect(await driver.legacy("host", "start", await legacyOf("wiki"))).toEqual({ ok: true });
    expect(sent[2]?.params).toMatchObject({
      envFile: "/var/lib/nearzero-data/secrets/compose-env/wiki.env",
      dataFolders: ["/opt/nearzero", "/etc/nearzero", "/var/lib/nearzero-data"],
      dataVolumes: ["nearzero_data"],
    });
    sent.length = 2;
    const wiki = rollbackServerScript([await legacyOf("wiki")]);
    expect(wiki).toContain(
      "nz_compose_files 'wiki' '/srv/stacks/wiki' '/var/lib/nearzero-data/secrets/compose-env/wiki.env' '/opt/nearzero /etc/nearzero /var/lib/nearzero-data' 'nearzero_data' 'docker-compose.yml'",
    );
    expect(wiki).toContain("nz_env_allowed");
    // A remote stack's rollback checks its env file against /etc/nearzero there.
    const remote = rollbackServerScript([await legacyOf("remote")]);
    expect(remote).toContain(
      "nz_compose_files 'remote' '/etc/nearzero/compose/remote' '/etc/nearzero/secrets/compose-env/remote.env' '/opt/nearzero /etc/nearzero' '' 'docker-compose.yml'",
    );
    expect(remote).toContain('roots="/opt/nearzero /etc/nearzero $roots"');
    const script = rollbackServerScript([await legacyOf("shop"), await legacyOf("blog")]);
    expect(script).toContain(
      "nz_compose_files 'shop' '/srv/stacks/shop' '.env' '' '' 'docker-compose.prod.yml' 'docker-compose.local-db.yml'",
    );
    expect(script).toContain("nz_compose start 'blog'");
    // 1.0's labelled containers in the project go first, with their anonymous volumes.
    expect(script).toContain('--filter "label=dev.nearzero.edition=1")');
    expect(script).toContain("docker rm -fv $ids");
  });

  test("Compose's orphans stay while the move isn't finalized", async () => {
    const shop = await h.db
      .selectFrom("service")
      .select("id")
      .where("name", "=", "shop")
      .executeTakeFirstOrThrow();
    expect(await movedNotFinalized(h.db, shop.id)).toBe(true);
    await h.db.updateTable("migration_state").set({ phase: "finalized" }).execute();
    expect(await movedNotFinalized(h.db, shop.id)).toBe(false);
    expect(await movedNotFinalized(h.db, crypto.randomUUID())).toBe(false);
  });
});
