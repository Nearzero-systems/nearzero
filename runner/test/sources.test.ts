import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { buildApp } from "../src/builds/build.ts";
import { automaticBuilder, detect } from "../src/builds/detect.ts";
import { locateTool, MissingToolError } from "../src/builds/tools.ts";
import { createTar } from "../src/docker/tar.ts";
import { fetchRepository } from "../src/sources/git.ts";
import { dropOutsideLinks, resolvePath } from "../src/sources/links.ts";
import { ArchiveError, safeEntryPath, unzipInto } from "../src/sources/zip.ts";

/**
 * Safe unzipping (spec 6.3), the automatic builder's choice (spec 6.4), tool checks (spec 23.1)
 * and the tar writer for file mounts.
 */

interface ZipItem {
  name: string;
  content?: string;
  mode?: number;
  link?: string;
  method?: 0 | 8;
  flags?: number;
  badCrc?: boolean;
}

/** A small zip writer (stored and deflate), enough to make test archives. */
function makeZip(items: ZipItem[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of items) {
    const directory = item.name.endsWith("/");
    const data = Buffer.from(item.link ?? item.content ?? "");
    const method = directory ? 0 : (item.method ?? 8);
    const body = method === 8 ? deflateRawSync(data) : data;
    const crc = item.badCrc ? 1 : Bun.hash.crc32(data) >>> 0;
    const name = Buffer.from(item.name);
    const mode = item.link ? 0o120777 : directory ? 0o040755 : (item.mode ?? 0o100644);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE((item.flags ?? 0) | 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE((item.flags ?? 0) | 0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(items.length, 8);
  end.writeUInt16LE(items.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

let work: string;
let count = 0;

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "nz-sources-"));
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

async function fresh(): Promise<string> {
  const folder = join(work, `t${count++}`);
  await mkdir(folder, { recursive: true });
  return folder;
}

describe("unzipping uploads (spec 6.3)", () => {
  test("unpacks files with their modes, links inside the folder, and strips one top folder", async () => {
    const folder = await fresh();
    const result = await unzipInto(
      makeZip([
        { name: "site-main/" },
        { name: "site-main/index.html", content: "<h1>hi</h1>" },
        { name: "site-main/bin/run.sh", content: "#!/bin/sh\n", mode: 0o100755, method: 0 },
        { name: "site-main/latest", link: "bin/run.sh" },
        { name: "__MACOSX/site-main/._index.html", content: "junk" },
      ]),
      folder,
    );
    expect(result).toMatchObject({ files: 2, links: 1, strippedFolder: "site-main" });
    expect(await readFile(join(folder, "index.html"), "utf8")).toBe("<h1>hi</h1>");
    expect((await lstat(join(folder, "bin/run.sh"))).mode & 0o777).toBe(0o755);
    expect(await readlink(join(folder, "latest"))).toBe("bin/run.sh");
  });

  test.each([
    ["../evil.sh", "points outside"],
    ["/etc/passwd", "absolute path"],
    ["C:/windows/x", "absolute path"],
    ["a/../../b", "points outside"],
    ["a\\..\\..\\b", "points outside"],
  ])("refuses %s", async (name, message) => {
    const folder = await fresh();
    await expect(unzipInto(makeZip([{ name, content: "x" }]), folder)).rejects.toThrow(message);
  });

  test("refuses links outside the folder, encrypted entries, damaged data and odd methods", async () => {
    await expect(
      unzipInto(makeZip([{ name: "l", link: "../../etc" }]), await fresh()),
    ).rejects.toThrow("points outside");
    await expect(
      unzipInto(makeZip([{ name: "l", link: "/etc/shadow" }]), await fresh()),
    ).rejects.toThrow("points outside");
    await expect(
      unzipInto(makeZip([{ name: "a.txt", content: "x", flags: 1 }]), await fresh()),
    ).rejects.toThrow("encrypted");
    await expect(
      unzipInto(makeZip([{ name: "a.txt", content: "hello", badCrc: true }]), await fresh()),
    ).rejects.toThrow("checksum");
    await expect(unzipInto(Buffer.from("not a zip"), await fresh())).rejects.toBeInstanceOf(
      ArchiveError,
    );
  });

  test("a file can't be written through a link", async () => {
    const folder = await fresh();
    await expect(
      unzipInto(
        makeZip([
          { name: "out", link: "." },
          { name: "out/x", content: "x" },
        ]),
        folder,
      ),
    ).rejects.toThrow();
    expect(safeEntryPath("./a//b/")).toBe("a/b");
  });
});

describe("links can't lead out of a source, also through other links (B2-01, B2-14)", () => {
  test("the report's chain l1 -> ., l2 -> l1/.., l3 -> l2/.. is refused, and nothing is left", async () => {
    const parent = await fresh();
    const folder = join(parent, "app");
    await mkdir(folder);
    await expect(
      unzipInto(
        makeZip([
          { name: "index.html", content: "hi" },
          { name: "l1", link: "." },
          { name: "l2", link: "l1/.." },
          { name: "l3", link: "l2/.." },
        ]),
        folder,
      ),
    ).rejects.toThrow('The link "l2" points outside the archive\'s folder through another link.');
    expect((await readdir(folder)).sort()).toEqual(["index.html"]);
  });

  test("a link is never made inside another link", async () => {
    const parent = await fresh();
    const folder = join(parent, "app");
    await mkdir(folder);
    await expect(
      unzipInto(
        makeZip([
          { name: "l1", link: "." },
          { name: "l2", link: "l1/.." },
          { name: "l2/planted", link: "x" },
        ]),
        folder,
      ),
    ).rejects.toThrow("inside another link");
    expect(await readdir(parent)).toEqual(["app"]);
  });

  test("links inside the folder, also to links, still unpack", async () => {
    const folder = await fresh();
    await unzipInto(
      makeZip([
        { name: "lib/libfoo.so.1.2", content: "elf" },
        { name: "lib/libfoo.so.1", link: "libfoo.so.1.2" },
        { name: "lib/libfoo.so", link: "libfoo.so.1" },
        { name: "current", link: "lib" },
        { name: "up", link: "current/../lib/libfoo.so" },
      ]),
      folder,
    );
    expect(await readFile(join(folder, "up"), "utf8")).toBe("elf");
  });

  test("where a link leads is followed part by part", async () => {
    const root = await realpath(await fresh());
    await mkdir(join(root, "a"));
    await symlink(".", join(root, "l1"));
    await symlink("l1/..", join(root, "l2"));
    await symlink("missing/../..", join(root, "unknown"));
    await symlink("a/missing", join(root, "dangling"));
    expect(await resolvePath(join(root, "l2"))).toBe(join(root, ".."));
    expect(await resolvePath(join(root, "unknown"))).toBeNull();
    expect(await resolvePath(join(root, "dangling"))).toBe(join(root, "a", "missing"));
    expect((await dropOutsideLinks(root)).sort()).toEqual(["l2", "unknown"]);
    expect((await readdir(root)).sort()).toEqual(["a", "dangling", "l1"]);
  });

  test("a fetched repository loses its links out of the folder, and the log names them", async () => {
    const base = await fresh();
    const repo = join(base, "repo");
    const git = async (...args: string[]) => {
      const proc = Bun.spawn(["git", ...args], {
        cwd: repo,
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: base },
        stdout: "pipe",
        stderr: "pipe",
      });
      if ((await proc.exited) !== 0) throw new Error(await new Response(proc.stderr).text());
    };
    await mkdir(repo);
    await git("init", "--quiet", "-b", "main");
    await writeFile(join(repo, "server.js"), "console.log(1)\n");
    await symlink("/etc/nearzero/router/zz.yml", join(repo, "Procfile"));
    await symlink("..", join(repo, "parent"));
    await symlink("server.js", join(repo, "main.js"));
    await git("add", ".");
    await git("-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-qm", "links");
    const folder = join(base, "service");
    await mkdir(folder);
    let output = "";
    await fetchRepository(
      { url: `file://${repo}`, branch: "main", submodules: false },
      {
        folder,
        home: join(base, "home"),
        signal: new AbortController().signal,
        onOutput: (text) => {
          output += text;
        },
      },
    );
    expect((await readdir(join(folder, "source"))).sort()).toEqual(["main.js", "server.js"]);
    expect(output).toContain(
      "Left out Procfile: it is a link to somewhere outside the repository.",
    );
    expect(output).toContain("Left out parent: it is a link to somewhere outside the repository.");
  });
});

describe("the automatic builder (spec 6.4)", () => {
  test("a Dockerfile wins, a known framework goes to Railpack, anything else to Nixpacks", async () => {
    const withDockerfile = await fresh();
    await writeFile(join(withDockerfile, "Dockerfile"), "FROM scratch\n");
    await writeFile(
      join(withDockerfile, "package.json"),
      JSON.stringify({ dependencies: { next: "15" } }),
    );
    expect(automaticBuilder(await detect(withDockerfile))).toBe("dockerfile");

    const next = await fresh();
    await writeFile(join(next, "package.json"), JSON.stringify({ dependencies: { next: "15" } }));
    const detected = await detect(next);
    expect(detected).toMatchObject({ framework: "Next.js", language: "Node.js" });
    expect(automaticBuilder(detected)).toBe("railpack");

    const plain = await fresh();
    await writeFile(join(plain, "go.mod"), "module x\n");
    expect(await detect(plain)).toMatchObject({ framework: null, language: "Go" });
    expect(automaticBuilder(await detect(plain))).toBe("nixpacks");

    const django = await fresh();
    await writeFile(join(django, "requirements.txt"), "Django==5.1\n");
    expect((await detect(django)).framework).toBe("Django");
  });

  test("a missing tool stops the build with the fix", async () => {
    const context = {
      buildersDir: await fresh(),
      containerized: false,
      env: { PATH: "/nonexistent" },
      signal: new AbortController().signal,
    };
    const missing = await locateTool("nixpacks", null, context).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(MissingToolError);
    expect((missing as Error).message).toBe(
      "nixpacks is not installed on the build machine. Run setup again on this server's page to install it.",
    );
    const host = await locateTool("railpack", "0.42.0", { ...context, containerized: true }).catch(
      (error: unknown) => error,
    );
    expect((host as Error).message).toContain(
      "railpack 0.42.0 is not installed on the build machine. Run the Nearzero install command again",
    );
  });

  test("a build path that isn't in the source is refused before anything runs", async () => {
    const folder = await fresh();
    await mkdir(join(folder, "source"), { recursive: true });
    await expect(
      buildApp(
        {
          appKey: "web-abc123",
          buildPath: "apps/missing",
          builder: { type: "automatic" },
          commands: { install: "", build: "", start: "" },
          buildEnv: {},
          servicePort: 3000,
          tags: ["nearzero/web-abc123:1"],
          labels: {},
          noCache: false,
        },
        {
          folder,
          buildersDir: folder,
          containerized: false,
          env: {},
          signal: new AbortController().signal,
          out: () => {},
        },
      ),
    ).rejects.toThrow("The build path apps/missing doesn't exist in the source");
  });
});

test("the tar writer makes archives tar can read", async () => {
  const folder = await fresh();
  const archive = join(folder, "files.tar");
  await writeFile(
    archive,
    createTar([
      { path: "etc", type: "directory", mode: 0o755, uid: 0, gid: 0 },
      {
        path: "etc/app.json",
        type: "file",
        content: new TextEncoder().encode("{}\n"),
        mode: 0o400,
        uid: 999,
        gid: 999,
      },
    ]),
  );
  const listed = Bun.spawnSync(["tar", "-tvf", archive]);
  const text = listed.stdout.toString();
  expect(listed.exitCode).toBe(0);
  expect(text).toContain("etc/app.json");
  expect(text).toMatch(/^-r-------- .*999/m);
});
