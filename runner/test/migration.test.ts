import { afterAll, describe, expect, test } from "bun:test";
import { mergeRouterStores } from "../src/migration/handlers.ts";

/**
 * Merging an imported certificate authority state into the router's store (spec 29.5): the
 * router's own account stays, and for each name the certificate that lasts longer stays.
 */

async function certificate(name: string, days: number): Promise<string> {
  const work = `${process.env.TMPDIR ?? "/tmp"}/nz-mig-runner-${crypto.randomUUID()}`;
  await Bun.spawn(["mkdir", "-p", work]).exited;
  await Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      String(days),
      "-subj",
      `/CN=${name}`,
      "-keyout",
      `${work}/k.pem`,
      "-out",
      `${work}/c.pem`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  ).exited;
  const pem = await Bun.file(`${work}/c.pem`).text();
  await Bun.spawn(["rm", "-rf", work]).exited;
  return Buffer.from(pem).toString("base64");
}

describe("mergeRouterStores", () => {
  test("keeps the router's account, adds new names, and keeps the longer certificate for a name", async () => {
    const short = await certificate("a.example.com", 10);
    const long = await certificate("a.example.com", 80);
    const other = await certificate("b.example.com", 30);
    const merged = mergeRouterStores(
      {
        letsencrypt: {
          Account: { Email: "router@example.com" },
          Certificates: [{ domain: { main: "a.example.com" }, certificate: short, key: "k1" }],
        },
      },
      {
        letsencrypt: {
          Account: { Email: "old@example.com" },
          Certificates: [
            { domain: { main: "a.example.com" }, certificate: long, key: "k2" },
            { domain: { main: "b.example.com" }, certificate: other, key: "k3" },
          ],
        },
      },
    );
    expect(merged.certificates).toBe(2);
    expect(merged.store.letsencrypt?.Account).toEqual({ Email: "router@example.com" });
    const byName = Object.fromEntries(
      (merged.store.letsencrypt?.Certificates ?? []).map((item) => [item.domain?.main, item.key]),
    );
    expect(byName).toEqual({ "a.example.com": "k2", "b.example.com": "k3" });
  });

  test("an empty router store takes the imported account and certificates", () => {
    const merged = mergeRouterStores(
      {},
      { letsencrypt: { Account: { Email: "old@example.com" }, Certificates: [] } },
    );
    expect(merged.store).toEqual({
      letsencrypt: { Account: { Email: "old@example.com" }, Certificates: [] },
    });
  });
});

describe("settings 0.1.x had (spec 03 3.5)", () => {
  test("builder overrides count only when pinned by digest", async () => {
    const { builderOverrides } = await import("../src/builds/overrides.ts");
    const digest = `sha256:${"a".repeat(64)}`;
    expect(
      builderOverrides({
        NEARZERO_HEROKU_BUILDER_IMAGE: `heroku/builder:24@${digest}`,
        NEARZERO_PAKETO_BUILDER_IMAGE: "paketobuildpacks/builder-jammy-base:latest",
        NEARZERO_RAILPACK_FRONTEND_IMAGE: ` ghcr.io/railwayapp/railpack-frontend@${digest} `,
      }),
    ).toEqual({
      heroku: `heroku/builder:24@${digest}`,
      paketo: null,
      railpackFrontend: `ghcr.io/railwayapp/railpack-frontend@${digest}`,
      staticServer: null,
    });
  });

  test("the metrics interval follows NEARZERO_METRICS_REFRESH_SECONDS within 1 to 3600 seconds", async () => {
    const { metricsIntervalMs } = await import("../src/metrics.ts");
    expect(metricsIntervalMs({ NEARZERO_METRICS_REFRESH_SECONDS: "15" })).toBe(15_000);
    expect(metricsIntervalMs({})).toBe(5_000);
    expect(metricsIntervalMs({ NEARZERO_METRICS_REFRESH_SECONDS: "0" })).toBe(5_000);
    expect(metricsIntervalMs({ NEARZERO_METRICS_REFRESH_SECONDS: "99999" })).toBe(5_000);
  });
});

describe("volume.restore (moving to another machine, spec 29.5)", () => {
  const archiveId = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const folders: string[] = [];

  afterAll(async () => {
    const { rm } = await import("node:fs/promises");
    for (const folder of folders) await rm(folder, { recursive: true, force: true });
  });

  async function setUp(bytes: Uint8Array, existing: boolean) {
    const { createHash } = await import("node:crypto");
    const { mkdtemp, readdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { migrationHandlers } = await import("../src/migration/handlers.ts");
    const work = await mkdtemp(join(tmpdir(), "nz1-mig-restore-"));
    folders.push(work);
    const calls: string[] = [];
    let uploaded: Uint8Array | null = null;
    const docker = {
      findVolume: async (name: string) => (existing ? { Name: name } : null),
      createVolume: async (name: string, labels: Record<string, string>) => {
        calls.push(`create volume ${name} ${labels["dev.nearzero.managed"]}`);
      },
      imageExists: async () => true,
      pullImage: async () => {
        calls.push("pull");
      },
      createContainer: async (_name: string, config: { HostConfig: { Mounts: unknown[] } }) => {
        calls.push(`holder ${JSON.stringify(config.HostConfig.Mounts)}`);
        return "holder-1";
      },
      call: async (
        method: string,
        path: string,
        options: { query: Record<string, unknown>; rawBody: { bytes: Blob } },
      ) => {
        calls.push(`${method} ${path} ${JSON.stringify(options.query)}`);
        uploaded = new Uint8Array(await options.rawBody.bytes.arrayBuffer());
      },
      removeContainer: async (id: string) => {
        calls.push(`remove ${id}`);
      },
    };
    const context = {
      docker,
      router: { settings: { image: "traefik:v3" } },
      workDirectory: work,
      signal: new AbortController().signal,
      controlFetch: async (path: string) => {
        calls.push(`download ${path}`);
        return new Response(bytes);
      },
    };
    const run = (sha256 = createHash("sha256").update(bytes).digest("hex")) =>
      migrationHandlers["volume.restore"](
        { volume: "web-data", archiveId, sha256, sizeBytes: bytes.length },
        context as never,
      );
    const leftovers = async () => readdir(join(work, "migration"));
    return { run, calls, uploaded: () => uploaded, leftovers };
  }

  test("downloads, checks and unpacks the archive into a new volume, keeping its owners", async () => {
    const bytes = new TextEncoder().encode("a tar archive, rooted at the volume");
    const t = await setUp(bytes, false);
    expect(await t.run()).toEqual({ volume: "web-data", bytes: bytes.length });
    expect(t.calls).toEqual([
      `download /api/v1/runner/migration-archives/${archiveId}`,
      "create volume web-data true",
      'holder [{"Type":"volume","Source":"web-data","Target":"/restore"}]',
      'PUT /containers/holder-1/archive {"path":"/restore","noOverwriteDirNonDir":true}',
      "remove holder-1",
    ]);
    expect(t.uploaded()).toEqual(bytes);
    expect(await t.leftovers()).toEqual([]);
  });

  test("an archive that doesn't match the export's checksum is never unpacked", async () => {
    const t = await setUp(new TextEncoder().encode("changed on the way"), true);
    await expect(t.run("0".repeat(64))).rejects.toThrow(
      "The downloaded volume archive doesn't match the export's checksum.",
    );
    expect(t.calls).toEqual([`download /api/v1/runner/migration-archives/${archiveId}`]);
    expect(await t.leftovers()).toEqual([]);
  });
});

describe('ports a moved service needs (spec 29.5 "Public ports")', () => {
  const swarm = (ports: { PublishedPort: number; TargetPort: number }[], replicas: number) => ({
    ID: "svc1",
    Version: { Index: 7 },
    Spec: {
      Name: "shop_pg",
      Labels: {},
      Mode: { Replicated: { Replicas: replicas } },
      EndpointSpec: {
        Mode: "vip",
        Ports: ports.map((port) => ({ ...port, Protocol: "tcp", PublishMode: "ingress" })),
      },
    },
    Endpoint: { Ports: ports.map((port) => ({ ...port, Protocol: "tcp" })) },
  });

  function fakeDocker(services: ReturnType<typeof swarm>[], containers: unknown[] = []) {
    const updates: { body: Record<string, unknown> }[] = [];
    return {
      updates,
      docker: {
        json: async (_method: string, path: string) => {
          if (path === "/containers/json") return containers;
          if (path === "/services") return services;
          if (path.startsWith("/services/")) return services[0];
          throw new Error(`unexpected ${path}`);
        },
        call: async (_method: string, path: string, options: { body: Record<string, unknown> }) => {
          updates.push({ body: options.body });
          const spec = services[0]?.Spec as Record<string, unknown>;
          if (spec && path.endsWith("/update")) Object.assign(spec, options.body);
        },
      },
    };
  }

  test("stopping a Swarm service lets go of its published ports; starting publishes them again", async () => {
    const { migrationHandlers } = await import("../src/migration/handlers.ts");
    const fake = fakeDocker([swarm([{ PublishedPort: 5433, TargetPort: 5432 }], 1)]);
    const context = { docker: fake.docker } as never;
    await migrationHandlers["legacy.workload"](
      {
        action: "stop",
        kind: "swarm-service",
        name: "shop_pg",
        composeFiles: [],
        dataFolders: [],
        dataVolumes: [],
      },
      context,
    );
    const stopped = fake.updates[0]?.body as {
      Mode: unknown;
      EndpointSpec: { Ports: unknown[] };
      Labels: Record<string, string>;
    };
    expect(stopped.Mode).toEqual({ Replicated: { Replicas: 0 } });
    expect(stopped.EndpointSpec.Ports).toEqual([]);
    // The same words the installer's shell functions read and write.
    expect(stopped.Labels["dev.nearzero.migration.ports"]).toBe("5433:5432:tcp:ingress");
    await migrationHandlers["legacy.workload"](
      {
        action: "start",
        kind: "swarm-service",
        name: "shop_pg",
        composeFiles: [],
        dataFolders: [],
        dataVolumes: [],
      },
      context,
    );
    const started = fake.updates[1]?.body as {
      Mode: unknown;
      EndpointSpec: { Ports: unknown[] };
      Labels: Record<string, string>;
    };
    expect(started.Mode).toEqual({ Replicated: { Replicas: 1 } });
    expect(started.EndpointSpec.Ports).toEqual([
      { PublishedPort: 5433, TargetPort: 5432, Protocol: "tcp", PublishMode: "ingress" },
    ]);
    expect(started.Labels).toEqual({});
  });

  test("what holds a port: a running container or a Swarm service", async () => {
    const { portHolders } = await import("../src/migration/handlers.ts");
    const fake = fakeDocker(
      [swarm([{ PublishedPort: 5433, TargetPort: 5432 }], 0)],
      [
        {
          Names: ["/stray-redis"],
          Ports: [{ PublicPort: 6380, Type: "tcp" }, { PrivatePort: 6379 }],
        },
      ],
    );
    expect(
      await portHolders(fake.docker as never, [
        { port: 5433, protocol: "tcp" },
        { port: 6380, protocol: "tcp" },
        { port: 8080, protocol: "tcp" },
        { port: 6380, protocol: "udp" },
      ]),
    ).toEqual([
      { port: 6380, protocol: "tcp", holder: "the container stray-redis" },
      { port: 5433, protocol: "tcp", holder: "the Swarm service shop_pg" },
    ]);
  });
});

describe('0.1.x workloads never include 1.0\'s own (spec 29.5 "Finalize")', () => {
  test("a Compose project's 1.0 containers are left running; 0.1.x's go with their anonymous volumes", async () => {
    const { migrationHandlers } = await import("../src/migration/handlers.ts");
    const removed: { id: string; options: unknown }[] = [];
    const docker = {
      findContainer: async () => null,
      listContainers: async () => [
        { Id: "old1", Labels: { "com.docker.compose.project": "shop" }, State: "exited" },
        {
          Id: "new1",
          Labels: { "com.docker.compose.project": "shop", "dev.nearzero.edition": "1" },
          State: "running",
        },
      ],
      removeContainer: async (id: string, options: unknown) => {
        removed.push({ id, options });
      },
      call: async () => {},
    };
    const result = await migrationHandlers["legacy.workload"](
      {
        action: "remove",
        kind: "compose-project",
        name: "shop",
        composeFiles: [],
        dataFolders: [],
        dataVolumes: [],
      },
      { docker } as never,
    );
    expect(result).toEqual({ found: true, running: false });
    expect(removed).toEqual([{ id: "old1", options: { force: true } }]);
    // A name that is 1.0's own counts as nothing of 0.1.x's.
    const ours = await migrationHandlers["legacy.workload"](
      {
        action: "remove",
        kind: "container",
        name: "new1",
        composeFiles: [],
        dataFolders: [],
        dataVolumes: [],
      },
      {
        docker: {
          findContainer: async () => ({
            Id: "new1",
            Config: { Labels: { "dev.nearzero.edition": "1" } },
            State: { Running: true },
          }),
          removeContainer: async (id: string) => removed.push({ id, options: null }),
        },
      } as never,
    );
    expect(ours).toEqual({ found: false, running: false });
    expect(removed).toHaveLength(1);
  });

  test("the Docker client removes a container's anonymous volumes, always", async () => {
    const { DockerClient } = await import("../src/docker/client.ts");
    const sent: { method: string; path: string; query: unknown }[] = [];
    const client = Object.create(DockerClient.prototype) as InstanceType<typeof DockerClient>;
    (client as unknown as { call: unknown }).call = async (
      method: string,
      path: string,
      options: { query: unknown },
    ) => {
      sent.push({ method, path, query: options.query });
    };
    await client.removeContainer("abc", { force: true });
    expect(sent).toEqual([
      { method: "DELETE", path: "/containers/abc", query: { force: true, v: true } },
    ]);
  });
});

describe("a moved stack's 0.1.x copy comes back from its own files (spec 29.5)", () => {
  const params = {
    action: "start" as const,
    kind: "compose-project" as const,
    name: "shop",
    folder: "/opt/stacks/shop",
    composeFiles: ["docker-compose.prod.yml", "docker-compose.local-db.yml"],
    envFile: ".env",
    dataFolders: [] as string[],
    dataVolumes: [] as string[],
  };

  function fake(containerized: boolean) {
    const removed: string[] = [];
    const ran: { argv: string[]; cwd?: string }[] = [];
    const listed: string[][] = [];
    const context = {
      containerized,
      dockerSocket: "/var/run/docker.sock",
      signal: new AbortController().signal,
      docker: {
        listContainers: async (filter: { labels: string[] }) => {
          listed.push(filter.labels);
          return [{ Id: "ours1" }];
        },
        removeContainer: async (id: string) => {
          removed.push(id);
        },
        json: async () => ({ Config: { Image: "ghcr.io/nearzero-systems/nearzero:1.0.0" } }),
      },
    };
    const run = async (spec: { argv: string[]; cwd?: string }) => {
      ran.push({ argv: spec.argv, ...(spec.cwd ? { cwd: spec.cwd } : {}) });
      return { exitCode: 0 };
    };
    return { context, removed, ran, listed, run };
  }

  test("1.0's labelled containers in the project go first, then 0.1.x's files run", async () => {
    const { startStackFromFiles } = await import("../src/migration/handlers.ts");
    const f = fake(false);
    await startStackFromFiles(params, f.context as never, f.run);
    expect(f.listed).toEqual([["com.docker.compose.project=shop", "dev.nearzero.edition=1"]]);
    expect(f.removed).toEqual(["ours1"]);
    expect(f.ran).toEqual([
      {
        argv: [
          "docker",
          "compose",
          "--project-directory",
          "/opt/stacks/shop",
          "-p",
          "shop",
          "-f",
          "/opt/stacks/shop/docker-compose.prod.yml",
          "-f",
          "/opt/stacks/shop/docker-compose.local-db.yml",
          "--env-file",
          "/opt/stacks/shop/.env",
          "up",
          "-d",
        ],
        cwd: "/opt/stacks/shop",
      },
    ]);
  });

  test("without named files, Compose's own lookup in the folder; in a container, through its image", async () => {
    const { startStackFromFiles, stackUpArgs } = await import("../src/migration/handlers.ts");
    expect(stackUpArgs({ name: "shop", folder: "/srv/shop", composeFiles: [] })).toEqual([
      "compose",
      "--project-directory",
      "/srv/shop",
      "-p",
      "shop",
      "up",
      "-d",
    ]);
    const f = fake(true);
    await startStackFromFiles(
      { ...params, composeFiles: [], envFile: undefined },
      f.context as never,
      f.run,
    );
    expect(f.ran[0]?.argv.slice(0, 2)).toEqual(["docker", "run"]);
    // As root, so it can open the Docker socket (B2-03).
    const argv = f.ran[0]?.argv ?? [];
    expect(argv[argv.indexOf("--user") + 1]).toBe("0:0");
    expect(f.ran[0]?.argv).toContain("/opt/stacks/shop:/opt/stacks/shop:ro");
    expect(f.ran[0]?.argv).toContain("dev.nearzero.edition=1");
    expect(f.ran[0]?.argv).toContain("ghcr.io/nearzero-systems/nearzero:1.0.0");
    // No env file outside the folder: the script gets an empty one and runs Compose as given.
    expect(f.ran[0]?.argv.slice(-8)).toEqual([
      "",
      "compose",
      "--project-directory",
      "/opt/stacks/shop",
      "-p",
      "shop",
      "up",
      "-d",
    ]);
  });

  test("an env file outside the folder is used only under the install's data folders (29a.9)", async () => {
    const { mkdtemp, mkdir, writeFile, symlink, rm, realpath } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { startStackFromFiles } = await import("../src/migration/handlers.ts");
    const root = await realpath(await mkdtemp(join(tmpdir(), "nz1-envfile-")));
    const env = join(root, "secrets", "compose-env", "shop.env");
    await mkdir(join(root, "secrets", "compose-env"), { recursive: true });
    await writeFile(env, "GREETING=hello\n");
    const linked = join(root, "secrets", "compose-env", "linked.env");
    await symlink(env, linked);
    try {
      // Under a data folder: used as it is, never through the stack's folder.
      const ok = fake(false);
      await startStackFromFiles(
        { ...params, envFile: env, dataFolders: [root] },
        ok.context as never,
        ok.run,
      );
      expect(ok.ran[0]?.argv).toEqual(expect.arrayContaining(["--env-file", env]));
      // Under a data volume's folder on this server.
      const volume = fake(false);
      (volume.context.docker as { json: unknown }).json = async () => ({ Mountpoint: root });
      await startStackFromFiles(
        { ...params, envFile: env, dataVolumes: ["nearzero_data"] },
        volume.context as never,
        volume.run,
      );
      expect(volume.ran).toHaveLength(1);
      // Outside every data folder, or reached through a link: refused, nothing started.
      for (const [file, folders] of [
        ["/etc/hostname", [root]],
        [env, ["/srv/elsewhere"]],
        [linked, [root]],
      ] as const) {
        const refused = fake(false);
        await expect(
          startStackFromFiles(
            { ...params, envFile: file, dataFolders: [...folders] },
            refused.context as never,
            refused.run,
          ),
        ).rejects.toThrow("isn't");
        expect(refused.ran).toEqual([]);
      }
      // In a container, the file's folder is mounted read-only; it must exist already.
      const inContainer = fake(true);
      await startStackFromFiles(
        { ...params, envFile: env, dataFolders: [root] },
        inContainer.context as never,
        inContainer.run,
      );
      expect(inContainer.ran[0]?.argv).toEqual(
        expect.arrayContaining([
          "--mount",
          `type=bind,source=${join(root, "secrets", "compose-env")},target=${join(root, "secrets", "compose-env")},readonly`,
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a remote stack's env file under /etc/nearzero is a data folder on every server", async () => {
    const { startStackFromFiles } = await import("../src/migration/handlers.ts");
    const env = "/etc/nearzero/secrets/compose-env/remote.env";
    // The runner sees no files of its own here (in a container): the folders decide, and the
    // file's folder is mounted read-only for Compose.
    const f = fake(true);
    await startStackFromFiles(
      { ...params, name: "remote", folder: "/etc/nearzero/compose/remote", envFile: env },
      f.context as never,
      f.run,
    );
    expect(f.ran[0]?.argv).toEqual(
      expect.arrayContaining([
        "--mount",
        "type=bind,source=/etc/nearzero/secrets/compose-env,target=/etc/nearzero/secrets/compose-env,readonly",
        "--env-file",
        env,
      ]),
    );
    // Beside it, but outside both data folders: refused.
    const refused = fake(true);
    await expect(
      startStackFromFiles(
        {
          ...params,
          name: "remote",
          folder: "/etc/nearzero/compose/remote",
          envFile: "/etc/nearzero-other/remote.env",
        },
        refused.context as never,
        refused.run,
      ),
    ).rejects.toThrow("isn't under the 0.1.x install's data folders");
    expect(refused.ran).toEqual([]);
  });

  test("the command refuses an env file with a way back up, and Compose file paths", async () => {
    const { migrationCommandSchemas } = await import("@nearzero/shared");
    const schema = migrationCommandSchemas["legacy.workload"];
    const base = { action: "start", kind: "compose-project", name: "shop", folder: "/srv/shop" };
    expect(schema.safeParse({ ...base, envFile: "/opt/nearzero/secrets/shop.env" }).success).toBe(
      true,
    );
    expect(schema.safeParse({ ...base, envFile: "/opt/nearzero/../etc/shadow" }).success).toBe(
      false,
    );
    expect(schema.safeParse({ ...base, envFile: "../shop.env" }).success).toBe(false);
    expect(schema.safeParse({ ...base, composeFiles: ["/srv/shop/compose.yml"] }).success).toBe(
      false,
    );
  });
});
