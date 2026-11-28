import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDockerSize, pruneRailpackCache } from "../src/builds/build.ts";
import { DockerClient } from "../src/docker/client.ts";

/** The daily Docker cleanup's build cache part (spec 9.4, 14.4; R3-04). */

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nz-cleanup-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("the daily cleanup removes all unused build cache (R3-04)", () => {
  test("Docker's own builder is asked for every unused record, not only dangling ones", async () => {
    const socketPath = join(dir, "docker.sock");
    const seen: string[] = [];
    const server = Bun.serve({
      unix: socketPath,
      fetch(request) {
        const url = new URL(request.url);
        seen.push(`${request.method} ${url.pathname}${url.search}`);
        if (url.pathname === "/_ping") {
          return new Response("OK", { headers: { "api-version": "1.47" } });
        }
        return Response.json({ SpaceReclaimed: 2_000_000 });
      },
    });
    try {
      const docker = new DockerClient({ socketPath });
      expect(await docker.pruneBuildCache()).toEqual({ SpaceReclaimed: 2_000_000 });
      expect(seen.at(-1)).toBe("POST /v1.47/build/prune?all=true");
    } finally {
      server.stop(true);
    }
  });

  test("Railpack's BuildKit builder is pruned too, and what it freed counts", async () => {
    const bin = join(dir, "bin");
    await Bun.write(join(bin, ".keep"), "");
    const calls = join(dir, "calls.txt");
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh
echo "$*" >> ${calls}
case "$*" in
  "buildx inspect nearzero-railpack") exit 0 ;;
  "buildx prune --builder nearzero-railpack --all --force") printf 'ID\\tRECLAIMABLE\\tSIZE\\nabc\\ttrue\\t1.5GB\\nTotal:\\t1.5GB\\n'; exit 0 ;;
esac
exit 1
`,
    );
    await chmod(join(bin, "docker"), 0o755);
    const freed = await pruneRailpackCache(
      { PATH: `${bin}:/usr/bin:/bin` },
      new AbortController().signal,
    );
    expect(freed).toBe(1_500_000_000);
    expect((await Bun.file(calls).text()).trim().split("\n")).toEqual([
      "buildx inspect nearzero-railpack",
      "buildx prune --builder nearzero-railpack --all --force",
    ]);
  });

  test("a server that never built with Railpack has nothing more to prune", async () => {
    expect(await pruneRailpackCache({ PATH: "/nonexistent" }, new AbortController().signal)).toBe(
      0,
    );
  });

  test("sizes as Docker prints them", () => {
    expect(parseDockerSize("1.234GB")).toBe(1_234_000_000);
    expect(parseDockerSize("512MB")).toBe(512_000_000);
    expect(parseDockerSize("12.3kB")).toBe(12_300);
    expect(parseDockerSize("0B")).toBe(0);
    expect(parseDockerSize("n/a")).toBe(0);
  });
});
