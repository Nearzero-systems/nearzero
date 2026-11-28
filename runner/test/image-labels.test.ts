import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandParamsSchemas, NEARZERO_LABELS } from "@nearzero/shared";
import { type BuildContext, buildApp } from "../src/builds/build.ts";
import { recordPulledImages, runImagesOf } from "../src/builds/pulled-images.ts";
import { type FakeBuilders, installFakeBuilders, type Store } from "./support/fake-builders.ts";

// Every build starts several small stand-in programs.
setDefaultTimeout(60_000);
/**
 * Every image the runner builds carries Nearzero's labels, whichever builder made it, so
 * teardown and uninstall find it (spec 3.3, 6.4). Builders that can't set labels (Railpack's
 * BuildKit frontend ignores --label; buildpacks have no option for them) get a labelled copy
 * under the same tag, and the unlabelled original is removed.
 *
 * The builds run against stand-ins for the Docker CLI and the builder tools
 * (support/fake-builders.ts).
 */

let root: string;
let fakes: FakeBuilders;
let pulledFile: string;

async function readStore(): Promise<Store> {
  return fakes.readStore();
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nz-image-labels-"));
  fakes = await installFakeBuilders(root);
  pulledFile = join(root, "work", "pulled-images");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function build(
  builder: Record<string, unknown>,
  tag: string,
  start: Pick<Store, "images" | "tags"> = { images: {}, tags: {} },
  extra: {
    commands?: Record<string, string>;
    setup?: (source: string) => Promise<void>;
    folder?: string;
  } = {},
) {
  await fakes.resetStore(start);
  await rm(pulledFile, { force: true });
  const folder = extra.folder ?? join(root, "apps", crypto.randomUUID());
  await mkdir(join(folder, "source"), { recursive: true });
  await writeFile(
    join(folder, "source", "package.json"),
    JSON.stringify({ name: "web", scripts: { start: "node server.js" } }),
  );
  await writeFile(join(folder, "source", "Dockerfile"), "FROM node:24-alpine\n");
  await extra.setup?.(join(folder, "source"));
  const params = commandParamsSchemas["app.build"].parse({
    appKey: "web-x1y2z3",
    builder,
    ...(extra.commands ? { commands: extra.commands } : {}),
    tags: [tag],
    labels: { [NEARZERO_LABELS.service]: "svc_1", [NEARZERO_LABELS.deployment]: "dep_1" },
  });
  let output = "";
  const context: BuildContext = {
    folder,
    buildersDir: fakes.buildersDir,
    containerized: false,
    env: { PATH: `${fakes.binDirectory}:${dirname(process.execPath)}:/usr/bin:/bin` },
    signal: new AbortController().signal,
    out: (text) => {
      output += text;
    },
    pulledImagesFile: pulledFile,
    // An amd64 server, whatever machine runs the tests (C2-11 refuses Paketo on arm64).
    arch: "x64",
  };
  const result = await buildApp(params, context);
  return { result, output, store: await readStore() };
}

/** What the build recorded pulling for the uninstaller. */
async function pulledRecord(): Promise<string[]> {
  const text = await readFile(pulledFile, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean);
}

function expectOwned(store: Store, tag: string, tracked: string[] = []) {
  const id = store.tags[tag];
  expect(id).toBeDefined();
  expect(store.images[id as string]?.labels).toMatchObject({
    [NEARZERO_LABELS.managed]: "true",
    [NEARZERO_LABELS.service]: "svc_1",
    [NEARZERO_LABELS.deployment]: "dep_1",
  });
  // Nothing unlabelled is left behind under any name, or without one, except images recorded
  // for the uninstaller (the buildpacks' builder and run images).
  const trackedIds = new Set(tracked.map((name) => store.tags[name]));
  for (const [id, image] of Object.entries(store.images)) {
    if (trackedIds.has(id)) continue;
    expect(image.labels[NEARZERO_LABELS.managed]).toBe("true");
  }
}

describe("built images carry Nearzero's labels (spec 3.3)", () => {
  test("Railpack: its frontend ignores --label, so the image gets a labelled copy", async () => {
    const { result, output, store } = await build({ type: "railpack" }, "nearzero/web:aaaa1111");
    expect(result.builder).toBe("railpack");
    expectOwned(store, "nearzero/web:aaaa1111");
    expect(output).toContain("Added Nearzero's labels to nearzero/web:aaaa1111");
    expect(Object.keys(store.images)).toHaveLength(1);
  });

  test("buildpacks: pack has no labels option, so the image gets a labelled copy", async () => {
    const { store } = await build({ type: "heroku" }, "nearzero/web:bbbb2222");
    expectOwned(store, "nearzero/web:bbbb2222", ["heroku/builder:24", "heroku/heroku:24"]);
    // The buildpacks' own metadata stays on the copy.
    const id = store.tags["nearzero/web:bbbb2222"] as string;
    expect(store.images[id]?.labels["io.buildpacks.lifecycle.metadata"]).toBe("{}");
  });

  test("buildpacks: the builder and run images pack brought are recorded for uninstall", async () => {
    const { output } = await build({ type: "heroku" }, "nearzero/web:dddd4444");
    expect(output).toContain("Pulling the builder image heroku/builder:24");
    expect(await pulledRecord()).toEqual(["heroku/builder:24", "heroku/heroku:24"]);
  });

  test("buildpacks: images that were on the server before are never recorded", async () => {
    const builder = JSON.stringify({ runImages: [{ image: "heroku/heroku:24" }] });
    const { output } = await build({ type: "heroku" }, "nearzero/web:eeee5555", {
      images: {
        "sha256:b1": { labels: { "io.buildpacks.builder.metadata": builder } },
        "sha256:r1": { labels: {} },
      },
      tags: { "heroku/builder:24": "sha256:b1", "heroku/heroku:24": "sha256:r1" },
    });
    expect(output).not.toContain("Pulling the builder image");
    expect(await pulledRecord()).toEqual([]);
  });

  test("Dockerfile: the build sets the labels itself, so no copy is made", async () => {
    const { output, store } = await build({ type: "dockerfile" }, "nearzero/web:cccc3333");
    expectOwned(store, "nearzero/web:cccc3333");
    expect(store.builds).toHaveLength(1);
    expect(output).not.toContain("Added Nearzero's labels");
  });
});

describe("builds never write or read through a link out of the source (B2-01, spec 22.2, 24 G3)", () => {
  test("a dangling Procfile link to the router's folder: nothing is written outside, and \\r can't add lines", async () => {
    // The report's attack: Procfile -> <router>/zz.yml, and a start command carrying \r, which
    // YAML reads as a line break, to smuggle a Traefik router in.
    const outside = join(root, "router-folder");
    await mkdir(outside, { recursive: true });
    const target = join(outside, "zz.yml");
    const { output } = await build({ type: "heroku" }, "nearzero/web:ffff6666", undefined, {
      commands: { start: "node server.js\rhttp:\r  routers:\r    evil: {}" },
      setup: async (source) => {
        await symlink(target, join(source, "Procfile"));
      },
    });
    expect(await stat(target).catch(() => null)).toBeNull();
    expect(output).toContain("Left out Procfile: it is a link to somewhere outside the source.");
    expect(output).toContain("Wrote a Procfile with the start command");
  });

  test("the Procfile written is a regular file on one line", async () => {
    const folder = join(root, "apps", crypto.randomUUID());
    await build({ type: "paketo" }, "nearzero/web:abab0101", undefined, {
      folder,
      commands: { start: "node server.js\r\nexit 0\u2028x" },
    });
    const procfile = join(folder, "source", "Procfile");
    expect((await lstat(procfile)).isFile()).toBe(true);
    expect(await readFile(procfile, "utf8")).toBe("web: node server.js exit 0 x\n");
  });

  test("a Procfile link to a file inside the source is the repository's Procfile", async () => {
    const folder = join(root, "apps", crypto.randomUUID());
    const { result } = await build({ type: "heroku" }, "nearzero/web:abab0202", undefined, {
      folder,
      commands: { start: "node server.js" },
      setup: async (source) => {
        await mkdir(join(source, "deploy"), { recursive: true });
        await writeFile(join(source, "deploy", "Procfile"), "web: npm start\n");
        await symlink("deploy/Procfile", join(source, "Procfile"));
      },
    });
    expect(result.notes).toContain(
      "The repository has a Procfile, so the start command was not used.",
    );
    expect(await readFile(join(folder, "source", "deploy", "Procfile"), "utf8")).toBe(
      "web: npm start\n",
    );
  });

  test("a Procfile link that leads nowhere inside the source is refused", async () => {
    await expect(
      build({ type: "heroku" }, "nearzero/web:abab0303", undefined, {
        commands: { start: "node server.js" },
        setup: async (source) => {
          await symlink("missing/Procfile", join(source, "Procfile"));
        },
      }),
    ).rejects.toThrow("Procfile is a link to nothing in the source");
  });

  test("a Dockerfile or build path that leads out through a link is never read", async () => {
    const secret = join(root, "runner-credential");
    await writeFile(secret, "FROM scratch\nSECRET runner credential\n");
    const { output } = await build(
      { type: "dockerfile", dockerfilePath: "Dockerfile.real", contextPath: "", stage: "" },
      "nearzero/web:abab0404",
      undefined,
      {
        setup: async (source) => {
          await symlink(secret, join(source, "Dockerfile.real"));
        },
      },
    ).catch((error: Error) => ({ output: error.message }));
    expect(output).toContain("There's no Dockerfile at Dockerfile.real");
    // A folder link out of the source is dropped before anything reads it.
    const { output: second } = await build(
      { type: "dockerfile" },
      "nearzero/web:abab0505",
      undefined,
      {
        setup: async (source) => {
          await mkdir(join(source, "apps"), { recursive: true });
          await symlink(root, join(source, "apps", "web"));
        },
      },
    );
    expect(second).toContain("Left out apps/web: it is a link to somewhere outside the source.");
  });
});

describe("the record of pulled images", () => {
  test("run images come from either form of the builder's metadata", () => {
    const label = (value: unknown) => ({ "io.buildpacks.builder.metadata": JSON.stringify(value) });
    expect(runImagesOf(label({ runImages: [{ image: "heroku/heroku:24" }] }))).toEqual([
      "heroku/heroku:24",
    ]);
    expect(
      runImagesOf(label({ stack: { runImage: { image: "paketobuildpacks/run-jammy-base" } } })),
    ).toEqual(["paketobuildpacks/run-jammy-base"]);
    expect(runImagesOf({ "io.buildpacks.builder.metadata": "not json" })).toEqual([]);
    expect(runImagesOf(null)).toEqual([]);
  });

  test("references are kept once, owner-only", async () => {
    const file = join(root, "record", "pulled-images");
    await recordPulledImages(file, ["a:1", "b:2"]);
    await recordPulledImages(file, ["b:2", "c:3", "has space"]);
    expect(await readFile(file, "utf8")).toBe("a:1\nb:2\nc:3\n");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
