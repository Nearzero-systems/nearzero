import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandContext } from "../src/commands.ts";
import {
  checkBindPath,
  readInside,
  removeTree,
  stackFolder,
  syncRepository,
  writeInside,
} from "../src/compose/folder.ts";
import { connectAll } from "../src/compose/handlers.ts";
import type { DockerClient } from "../src/docker/client.ts";
import type { RunnerStream } from "../src/streams/stream.ts";

/**
 * The Compose stack's folder on a server (spec 07, 24 G3): a repository copied in without links
 * that leave it, files the stack made itself kept, bind sources and the runner's own writes never
 * going through a symbolic link a container could plant.
 */

let work: string;

beforeEach(async () => {
  work = await mkdtemp(join(tmpdir(), "nz-compose-"));
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function repository(files: Record<string, string>): Promise<string> {
  const source = join(work, "apps", "shop", "source");
  await rm(source, { recursive: true, force: true });
  await mkdir(source, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), content);
  }
  return source;
}

describe("the stack's folder", () => {
  test("a repository is copied in; removed files go, the stack's own data stays", async () => {
    const stack = stackFolder(work, "shop-a1b2c3");
    await mkdir(stack, { recursive: true });
    let source = await repository({
      "deploy/compose.yml": "services: {}\n",
      "site/index.html": "v1",
      "site/old.html": "old",
    });
    await symlink("../site/index.html", join(source, "deploy", "inside-link"));
    await symlink("/etc/passwd", join(source, "deploy", "outside-link"));
    await symlink("../../../../etc", join(source, "escape"));
    const first = await syncRepository(source, stack);
    expect(first.skippedLinks.sort()).toEqual(["deploy/outside-link", "escape"]);
    expect(await readFile(join(stack, "repo", "site", "index.html"), "utf8")).toBe("v1");
    expect((await lstat(join(stack, "repo", "deploy", "inside-link"))).isSymbolicLink()).toBe(true);
    await writeFile(join(stack, "repo", "site", "data.db"), "made by the stack");

    source = await repository({ "deploy/compose.yml": "services: {}\n", "site/index.html": "v2" });
    await syncRepository(source, stack);
    expect(await readFile(join(stack, "repo", "site", "index.html"), "utf8")).toBe("v2");
    expect(await stat(join(stack, "repo", "site", "old.html")).catch(() => null)).toBeNull();
    expect(await readFile(join(stack, "repo", "site", "data.db"), "utf8")).toBe(
      "made by the stack",
    );
  });

  test("a chain of links that leads out is left out too (B2-14)", async () => {
    const stack = stackFolder(work, "shop-a1b2c3");
    await mkdir(stack, { recursive: true });
    const source = await repository({ "compose.yml": "services: {}\n" });
    await symlink(".", join(source, "l1"));
    await symlink("l1/..", join(source, "l2"));
    await symlink("l2/..", join(source, "l3"));
    const synced = await syncRepository(source, stack);
    expect(synced.skippedLinks.sort()).toEqual(["l2", "l3"]);
    expect(await lstat(join(stack, "repo", "l2")).catch(() => null)).toBeNull();
    expect(await lstat(join(stack, "repo", "l3")).catch(() => null)).toBeNull();
  });

  test("a link a container planted is never written through", async () => {
    const stack = stackFolder(work, "shop-a1b2c3");
    const outside = join(work, "outside");
    await mkdir(outside, { recursive: true });
    await mkdir(stack, { recursive: true });
    await symlink(outside, join(stack, ".nearzero"));
    await writeInside(stack, ".nearzero/env", "SECRET=1\n", 0o600);
    expect((await lstat(join(stack, ".nearzero"))).isDirectory()).toBe(true);
    expect(await stat(join(outside, "env")).catch(() => null)).toBeNull();
    expect((await stat(join(stack, ".nearzero", "env"))).mode & 0o777).toBe(0o600);

    // The repository's folder replaced by a link: the next copy makes it a real folder again.
    await symlink(outside, join(stack, "repo"));
    const source = await repository({ "compose.yml": "services: {}\n" });
    await syncRepository(source, stack);
    expect((await lstat(join(stack, "repo"))).isSymbolicLink()).toBe(false);
    expect(await stat(join(outside, "compose.yml")).catch(() => null)).toBeNull();
  });

  test("bind sources: made when missing, refused through a link", async () => {
    const stack = stackFolder(work, "shop-a1b2c3");
    await mkdir(stack, { recursive: true });
    expect(await checkBindPath(stack, "data/pg")).toBeNull();
    expect((await stat(join(stack, "data", "pg"))).isDirectory()).toBe(true);
    await symlink("/", join(stack, "data", "root"));
    expect(await checkBindPath(stack, "data/root/etc")).toContain(
      "goes through a link (./data/root)",
    );
    expect(await checkBindPath(stack, "../x")).toContain("leaves the service's folder");
  });

  test("files are read only inside the repository", async () => {
    const repo = join(work, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(work, "secret"), "outside");
    await writeFile(join(repo, "compose.yml"), "services: {}\n");
    await symlink("../secret", join(repo, "leak.yml"));
    expect(await readInside(repo, "compose.yml", 1024)).toBe("services: {}\n");
    expect(await readInside(repo, "leak.yml", 1024)).toBeNull();
    expect(await readInside(repo, "missing.yml", 1024)).toBeNull();
    await writeFile(join(repo, "big.yml"), "x".repeat(2048));
    await expect(readInside(repo, "big.yml", 1024)).rejects.toThrow("larger than 1 KB");
  });
});

describe("folders a container took over (B2-06, spec 23.1)", () => {
  // A folder its owner can't read stands in for Postgres's 999:999 0700 data folder, which the
  // host's runner (root without CAP_DAC_OVERRIDE) can't read either.
  test("a redeploy leaves the repository's files in it out instead of failing", async () => {
    const stack = stackFolder(work, "shop-a1b2c3");
    await mkdir(join(stack, "repo", "pgdata"), { recursive: true });
    await chmod(join(stack, "repo", "pgdata"), 0o000);
    try {
      const source = await repository({
        "compose.yml": "services: {}\n",
        "pgdata/.gitkeep": "",
        "pgdata/sub/x": "y",
      });
      const synced = await syncRepository(source, stack);
      expect(synced.skippedFiles.sort()).toEqual(["pgdata/.gitkeep", "pgdata/sub/"]);
      expect(await readFile(join(stack, "repo", "compose.yml"), "utf8")).toBe("services: {}\n");
    } finally {
      await chmod(join(stack, "repo", "pgdata"), 0o755);
    }
  });

  test("deleting the stack empties it through a helper container of the runner's own image", async () => {
    const stack = stackFolder(work, "shop-a1b2c3");
    const locked = join(stack, "pgdata");
    await mkdir(join(locked, "base"), { recursive: true });
    await writeFile(join(locked, "base", "1"), "data");
    await chmod(locked, 0o000);
    const calls: { kind: string; value: unknown }[] = [];
    const docker = {
      findContainer: async () => ({
        Image: "sha256:runner-image",
        Mounts: [{ Source: "/srv/nearzero/work", Destination: work }],
      }),
      createContainer: async (name: string, config: Record<string, unknown>) => {
        calls.push({ kind: "create", value: { name, config } });
        return "helper-1";
      },
      // The helper empties the folder (here: gives it back so the test can remove it).
      startContainer: async () => {
        await chmod(locked, 0o755);
        await rm(locked, { recursive: true, force: true });
        calls.push({ kind: "start", value: null });
      },
      waitContainer: async () => ({ StatusCode: 1 }),
      removeContainer: async (id: string) => {
        calls.push({ kind: "remove", value: id });
      },
    } as unknown as DockerClient;
    // Elsewhere the runner has its normal rights: a failure is a real one.
    if (process.getuid?.() !== 0) {
      await expect(removeTree(docker, false, stack)).rejects.toThrow();
      expect(calls).toEqual([]);
    }
    await removeTree(docker, true, stack);
    expect(await stat(stack).catch(() => null)).toBeNull();
    const create = calls[0]?.value as { name: string; config: Record<string, unknown> };
    expect(create.name).toStartWith("nearzero-cleanup-");
    expect(create.config).toMatchObject({
      Image: "sha256:runner-image",
      Entrypoint: ["rm"],
      Cmd: ["-rf", "/target"],
      HostConfig: {
        NetworkMode: "none",
        Mounts: [
          {
            Type: "bind",
            Source: `/srv/nearzero/work${stack.slice(work.length)}`,
            Target: "/target",
          },
        ],
      },
    });
    expect(calls.map((call) => call.kind)).toEqual(["create", "start", "remove"]);
  });
});

describe("the private network (30b R2-11)", () => {
  test("only the inner services hostnames route to join it", async () => {
    const joined: { container: string; aliases: string[] }[] = [];
    const docker = {
      inspectContainer: async (id: string) => ({
        HostConfig: { NetworkMode: "shop_default" },
        NetworkSettings: { Networks: {} },
        Id: id,
      }),
      connectNetwork: async (_network: string, container: string, aliases: string[]) => {
        joined.push({ container, aliases });
      },
    } as unknown as DockerClient;
    const text: string[] = [];
    const stream = { text: (value: string) => text.push(value) } as unknown as RunnerStream;
    const containers = [
      { id: "c-web", name: "shop-web-1", service: "web", state: "running" },
      { id: "c-redis", name: "shop-redis-1", service: "redis", state: "running" },
    ];
    await connectAll(
      { docker } as unknown as CommandContext,
      containers,
      { name: "nearzero-edge", aliasPrefix: "shop-a1b2c3", services: ["web"] },
      stream,
    );
    expect(joined).toEqual([{ container: "c-web", aliases: ["shop-a1b2c3-web"] }]);
    expect(text.join("")).toBe("Joined nearzero-edge: shop-a1b2c3-web\n");
    // An older control plane names none: all join, as before.
    joined.length = 0;
    await connectAll(
      { docker } as unknown as CommandContext,
      containers,
      { name: "nearzero-edge", aliasPrefix: "shop-a1b2c3" },
      stream,
    );
    expect(joined.map((item) => item.container)).toEqual(["c-web", "c-redis"]);
  });
});

describe("a moved stack's orphans (spec 29.5)", () => {
  test("are kept while the move isn't finalized, removed otherwise", async () => {
    const { composeUpArgs } = await import("../src/compose/handlers.ts");
    expect(composeUpArgs(true)).toContain("--remove-orphans");
    expect(composeUpArgs(false)).not.toContain("--remove-orphans");
    expect(composeUpArgs(false)).toEqual([
      "up",
      "--detach",
      "--no-build",
      "--pull",
      "missing",
      "--quiet-pull",
    ]);
  });
});
