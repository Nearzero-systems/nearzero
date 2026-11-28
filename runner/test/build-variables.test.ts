// biome-ignore-all lint/suspicious/noTemplateCurlyInString: these strings are shell parameter expansions.
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { commandParamsSchemas, NEARZERO_LABELS } from "@nearzero/shared";
import {
  type BuildContext,
  buildApp,
  nixpacksOwnArguments,
  secretsAsMounts,
  staticDockerfile,
  withSecrets,
} from "../src/builds/build.ts";
import { looksTransient, retryTiming } from "../src/builds/transient.ts";
import { pnpmWorkspacePatterns, workspacePlan } from "../src/builds/workspaces.ts";
import { defaultRelease } from "../tools/pins.ts";
import { type Call, type FakeBuilders, installFakeBuilders } from "./support/fake-builders.ts";

// Every build starts several small stand-in programs.
setDefaultTimeout(60_000);
/**
 * How a service's variables reach its build (spec 23.4, 05 5.5, 30b R2-05, B2-15): never on a
 * command line, never in the image unless the name says the value is public; and the build's
 * resilience (R2-08: passing failures tried again, Railpack falling back to Nixpacks) and monorepo
 * apps (R2-04). The real buildApp runs against stand-ins for Docker and the builder tools that
 * record every call's arguments and environment.
 */

const SECRET = "postgres://app:s3cret-Passw0rd@db:5432/app";
const PUBLIC = "https://api.example.com";
const EVIL = "/var/lib/nearzero-runner/work/apps/x/source/evil.so";

let root: string;
let fakes: FakeBuilders;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nz-build-variables-"));
  fakes = await installFakeBuilders(root);
  retryTiming.scale = 0;
});

afterAll(async () => {
  retryTiming.scale = 1;
  await rm(root, { recursive: true, force: true });
});

interface BuildOptions {
  builder?: Record<string, unknown>;
  commands?: { install: string; build: string; start: string };
  arch?: string;
  buildersDir?: string;
  downloads?: BuildContext["downloads"];
  freeBytes?: number;
  buildEnv?: Record<string, string>;
  buildPath?: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
}

async function build(options: BuildOptions = {}) {
  await fakes.resetStore();
  const folder = join(root, "apps", crypto.randomUUID());
  const source = join(folder, "source");
  await mkdir(source, { recursive: true });
  const files = options.files ?? {
    "package.json": JSON.stringify({ name: "web", scripts: { start: "node server.js" } }),
    Dockerfile: "FROM node:24-alpine\nEXPOSE 8080\n",
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(source, name)), { recursive: true });
    await writeFile(join(source, name), content);
  }
  const params = commandParamsSchemas["app.build"].parse({
    appKey: "web-x1y2z3",
    builder: options.builder ?? { type: "dockerfile" },
    buildPath: options.buildPath ?? "",
    buildEnv: options.buildEnv ?? {
      DATABASE_URL: SECRET,
      NEXT_PUBLIC_API_URL: PUBLIC,
      LD_PRELOAD: EVIL,
    },
    tags: ["nearzero/web-x1y2z3:abcd1234"],
    labels: { [NEARZERO_LABELS.service]: "svc_1", [NEARZERO_LABELS.deployment]: "dep_1" },
    ...(options.commands ? { commands: options.commands } : {}),
  });
  let output = "";
  const context: BuildContext = {
    folder,
    buildersDir: options.buildersDir ?? fakes.buildersDir,
    ...(options.downloads ? { downloads: options.downloads } : {}),
    ...(options.freeBytes !== undefined ? { freeBytes: options.freeBytes } : {}),
    containerized: false,
    env: {
      PATH: `${fakes.binDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
      ...options.env,
    },
    signal: new AbortController().signal,
    out: (text) => {
      output += text;
    },
    // An amd64 server unless the test says otherwise, whatever machine runs the tests.
    arch: options.arch ?? "x64",
  };
  const run = async () => {
    try {
      return { result: await buildApp(params, context), error: null };
    } catch (error) {
      return { result: null, error: error as Error };
    }
  };
  const { result, error } = await run();
  const store = await fakes.readStore();
  return { result, error, output, calls: store.calls, folder, source };
}

/** No program the build ran had a secret's value on its command line. */
function expectNoValueOnCommandLines(calls: Call[], ...values: string[]) {
  for (const call of calls) {
    for (const value of values) {
      expect(call.args.join(" ")).not.toContain(value);
    }
  }
}

const buildxOf = (calls: Call[]) =>
  calls.filter((call) => call.tool === "docker" && call.args[1] === "build");

afterEach(() => {
  retryTiming.scale = 0;
});

describe("build variables never reach a command line or the image (R2-05, B2-15)", () => {
  test("Dockerfile: every variable is a build secret; public names are build arguments taken from the environment", async () => {
    const { error, calls, output, folder, result } = await build();
    expect(error).toBeNull();
    // The port the image declares is reported for the service port (R2-01).
    expect(result?.exposedPorts).toEqual(["8080/tcp"]);
    expectNoValueOnCommandLines(calls, SECRET, PUBLIC, EVIL);
    const [buildx] = buildxOf(calls);
    expect(buildx).toBeDefined();
    const args = buildx?.args ?? [];
    expect(args.join(" ")).toContain("--secret id=DATABASE_URL,src=");
    expect(buildx?.secrets?.DATABASE_URL).toBe(SECRET);
    expect(buildx?.secrets?.LD_PRELOAD).toBe(EVIL);
    expect(args[args.indexOf("NEXT_PUBLIC_API_URL") - 1]).toBe("--build-arg");
    expect(args).not.toContain("--build-arg DATABASE_URL");
    expect(args.filter((item) => item.startsWith("DATABASE_URL"))).toEqual([]);
    // buildx's own environment: the public value only, nothing that steers the loader.
    expect(buildx?.env.NEXT_PUBLIC_API_URL).toBe(PUBLIC);
    expect(buildx?.env.DATABASE_URL).toBeUndefined();
    expect(buildx?.env.LD_PRELOAD).toBeUndefined();
    expect(output).toContain("Variables reach the Dockerfile as build secrets");
    // The secret files are gone once the build ends.
    expect(await readdir(join(folder, "build-secrets")).catch(() => [])).toEqual([]);
  });

  test("Railpack plans with the values from its environment and builds with secret files", async () => {
    const { error, calls } = await build({ builder: { type: "railpack" } });
    expect(error).toBeNull();
    expectNoValueOnCommandLines(calls, SECRET, PUBLIC, EVIL);
    const prepare = calls.find((call) => call.tool === "railpack");
    expect(prepare?.args.join(" ")).toContain("--env DATABASE_URL --env NEXT_PUBLIC_API_URL");
    expect(prepare?.env.DATABASE_URL).toBe(SECRET);
    expect(prepare?.env.LD_PRELOAD).toBeUndefined();
    expect(prepare?.args).not.toContain("LD_PRELOAD");
    const [buildx] = buildxOf(calls);
    expect(buildx?.secrets?.DATABASE_URL).toBe(SECRET);
    expect(buildx?.env.DATABASE_URL).toBeUndefined();
    expect(buildx?.env.LD_PRELOAD).toBeUndefined();
  });

  test("a Railpack plan that carries a secret's value stops the build and names the variable", async () => {
    const { error, calls } = await build({
      builder: { type: "railpack" },
      buildEnv: { LEAK_TOKEN: "tok_9f8e7d6c5b4a" },
    });
    expect(error?.message).toContain(
      "Railpack generated a plan containing protected build material (key=LEAK_TOKEN)",
    );
    expect(error?.message).not.toContain("tok_9f8e7d6c5b4a");
    expect(buildxOf(calls)).toEqual([]);
  });

  test("Nixpacks: its Dockerfile loses the secrets' ARG and ENV entries and mounts them per step; its build script goes", async () => {
    const { error, calls, source } = await build({ builder: { type: "nixpacks" } });
    expect(error).toBeNull();
    expectNoValueOnCommandLines(calls, SECRET, PUBLIC, EVIL);
    const nixpacks = calls.find((call) => call.tool === "nixpacks");
    expect(nixpacks?.env.DATABASE_URL).toBe(SECRET);
    expect(nixpacks?.env.LD_PRELOAD).toBeUndefined();
    const dockerfile = await readFile(join(source, ".nixpacks", "Dockerfile"), "utf8");
    expect(dockerfile).not.toMatch(/ARG .*DATABASE_URL/);
    expect(dockerfile).not.toContain("DATABASE_URL=$DATABASE_URL");
    expect(dockerfile).toContain("NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL");
    // Mounted as files and exported for the step, which Docker 20.10 and later read (C2-04).
    for (const line of dockerfile.split("\n").filter((item) => item.startsWith("RUN "))) {
      expect(line).toStartWith(
        "RUN --mount=type=secret,id=DATABASE_URL,target=/run/secrets/DATABASE_URL ",
      );
      expect(line).not.toContain("env=");
      expect(line).toContain(
        'if [ -f /run/secrets/DATABASE_URL ]; then DATABASE_URL="$(cat /run/secrets/DATABASE_URL; printf x)"; DATABASE_URL="${DATABASE_URL%x}"; export DATABASE_URL; fi;',
      );
    }
    expect(await stat(join(source, ".nixpacks", "build.sh")).catch(() => null)).toBeNull();
    const [buildx] = buildxOf(calls);
    const args = buildx?.args ?? [];
    for (const own of ["CI=true", "NODE_ENV=production", "NIXPACKS_METADATA=node"]) {
      expect(args[args.indexOf(own) - 1]).toBe("--build-arg");
    }
    expect(args[args.indexOf("NEXT_PUBLIC_API_URL") - 1]).toBe("--build-arg");
    expect(buildx?.secrets?.DATABASE_URL).toBe(SECRET);
    expect(buildx?.env.NEXT_PUBLIC_API_URL).toBe(PUBLIC);
  });

  test("amd64-only builders are refused on arm64 servers, naming what works there (C2-11)", async () => {
    const paketo = await build({ builder: { type: "paketo" }, arch: "arm64" });
    expect(paketo.error?.message).toBe(
      "Paketo's builder is published for amd64 servers only, so it can't build on this arm64 server. Pick Railpack, Nixpacks, a Dockerfile, or Heroku with stack 24, which builds on arm64.",
    );
    expect(paketo.calls.some((call) => call.tool === "pack")).toBe(false);
    const heroku22 = await build({ builder: { type: "heroku", stack: "22" }, arch: "arm64" });
    expect(heroku22.error?.message).toContain("Heroku's stack 22 builder is published for amd64");
    // Heroku 24 is multi-architecture, and amd64 servers build with either.
    expect(
      (await build({ builder: { type: "heroku", stack: "24" }, arch: "arm64" })).error,
    ).toBeNull();
    expect((await build({ builder: { type: "paketo" }, arch: "x64" })).error).toBeNull();
  });

  test("buildpacks: pack reads the values from its environment", async () => {
    const { error, calls, output } = await build({ builder: { type: "heroku" } });
    expect(error).toBeNull();
    expectNoValueOnCommandLines(calls, SECRET, PUBLIC, EVIL);
    const pack = calls.find((call) => call.tool === "pack");
    expect(pack?.args.join(" ")).toContain("--env DATABASE_URL --env NEXT_PUBLIC_API_URL");
    expect(pack?.env.DATABASE_URL).toBe(SECRET);
    expect(pack?.env.LD_PRELOAD).toBeUndefined();
    expect(output).toContain("LD_PRELOAD isn't given to the build");
  });

  test("the Nixpacks helpers on their own", () => {
    expect(
      nixpacksOwnArguments(
        "docker build /app -f x -t y --build-arg CI=true --build-arg DATABASE_URL=postgres://a --build-arg 'NODE_ENV=production'",
        { DATABASE_URL: "postgres://a" },
      ),
    ).toEqual({ CI: "true", NODE_ENV: "production" });
    const exportB =
      'if [ -f /run/secrets/B ]; then B="$(cat /run/secrets/B; printf x)"; B="${B%x}"; export B; fi;';
    expect(
      secretsAsMounts("ARG A B\nENV A=$A B=$B\nENV PATH=/x:$PATH\nRUN echo hi\nCMD x", ["B"]),
    ).toBe(
      `ARG A\nENV A=$A\nENV PATH=/x:$PATH\nRUN --mount=type=secret,id=B,target=/run/secrets/B ${exportB} echo hi\nCMD x`,
    );
    // A step's own flags stay in front of its command; an exec-form step gets the files only.
    expect(withSecrets("--mount=type=cache,id=npm,target=/root/.npm npm ci", ["B"])).toBe(
      `RUN --mount=type=secret,id=B,target=/run/secrets/B --mount=type=cache,id=npm,target=/root/.npm ${exportB} npm ci`,
    );
    expect(withSecrets('["npm", "ci"]', ["B"])).toBe(
      'RUN --mount=type=secret,id=B,target=/run/secrets/B ["npm", "ci"]',
    );
    expect(withSecrets("npm ci", [])).toBe("RUN npm ci");
  });

  test("Static: the install and build commands get the variables, public ones as build arguments (C2-05)", async () => {
    const { error, calls, folder } = await build({
      builder: { type: "static", spa: true },
      commands: { install: "npm ci", build: "npm run build", start: "" },
      buildEnv: { VITE_API_URL: PUBLIC, API_TOKEN: SECRET, LD_PRELOAD: EVIL },
      files: { "package.json": JSON.stringify({ name: "site" }), "index.html": "<p>x</p>" },
    });
    expect(error).toBeNull();
    expectNoValueOnCommandLines(calls, SECRET, PUBLIC, EVIL);
    const [buildx] = buildxOf(calls);
    const args = buildx?.args ?? [];
    expect(args[args.indexOf("VITE_API_URL") - 1]).toBe("--build-arg");
    expect(buildx?.env.VITE_API_URL).toBe(PUBLIC);
    expect(buildx?.env.API_TOKEN).toBeUndefined();
    expect(buildx?.secrets?.API_TOKEN).toBe(SECRET);
    // Names that steer the build never reach its steps.
    expect(buildx?.secrets?.LD_PRELOAD).toBeUndefined();
    expect(args.join(" ")).not.toContain("--build-context");
    const dockerfile = await readFile(join(folder, "static-build", "Dockerfile"), "utf8");
    expect(dockerfile).toContain("ARG VITE_API_URL\n");
    expect(dockerfile).not.toContain("LD_PRELOAD");
  });

  test("the Static builder's Dockerfile (C2-04, C2-05)", () => {
    const dockerfile = staticDockerfile(
      { commands: { install: "npm ci", build: "npm run build", start: "" }, servicePort: 8080 },
      true,
      { public: ["VITE_API_URL"], secret: ["API_TOKEN"] },
      { build: "node:24-alpine", server: "nginx:alpine" },
    );
    const lines = dockerfile.split("\n");
    expect(lines.slice(0, 4)).toEqual([
      "FROM node:24-alpine AS build",
      "WORKDIR /app",
      "ARG VITE_API_URL",
      "COPY . .",
    ]);
    expect(lines[4]).toStartWith(
      "RUN --mount=type=secret,id=API_TOKEN,target=/run/secrets/API_TOKEN ",
    );
    expect(lines[4]).toEndWith(" npm ci");
    expect(lines[5]).toEndWith(" npm run build");
    // The server's settings are written in the Dockerfile: no named build context, which Docker
    // 20.10's builder doesn't read.
    expect(dockerfile).not.toContain("--from=nearzero");
    expect(dockerfile).toContain(
      "RUN printf '%s\\n' 'server {' '  listen 8080;' '  listen [::]:8080;' '  root /usr/share/nginx/html;' '  index index.html;' '  location / {' '    try_files $uri $uri/ /index.html;' '  }' '}' > /etc/nginx/conf.d/nearzero-static.conf",
    );
    // Without commands there is nothing to build, so no variables are used.
    expect(
      staticDockerfile(
        { commands: { install: "", build: "", start: "" }, servicePort: 80 },
        false,
        { public: ["VITE_API_URL"], secret: ["API_TOKEN"] },
        { build: "node", server: "nginx" },
      ),
    ).not.toContain("API_TOKEN");
  });
});

describe("the build machine is checked first (31c G3-04)", () => {
  test("a server with under 2 GB free stops before building, naming the free space", async () => {
    const { error, calls } = await build({
      builder: { type: "nixpacks" },
      freeBytes: 1.3 * 1024 ** 3,
    });
    expect(error?.message).toBe(
      "This server has only 1.30 GB of free disk space where builds work, and a build needs at least 2 GB. Free some space (unused images and build cache go with docker system prune), then deploy again.",
    );
    expect(calls).toEqual([]);
    expect(
      (await build({ builder: { type: "nixpacks" }, freeBytes: 3 * 1024 ** 3 })).error,
    ).toBeNull();
  });

  test("a pinned builder the server lacks is installed, logged, and the build goes on", async () => {
    const release = defaultRelease("nixpacks");
    // The release's archive, as its host serves it: here the stand-in Nixpacks.
    const staging = await mkdtemp(join(root, "release-"));
    await copyFile(
      join(fakes.buildersDir, "nixpacks", release.version, release.binary),
      join(staging, release.binary),
    );
    const archive = join(root, `nixpacks-${crypto.randomUUID()}.tar.gz`);
    expect(Bun.spawnSync(["tar", "-czf", archive, "-C", staging, release.binary]).exitCode).toBe(0);
    const bytes = new Uint8Array(await readFile(archive));
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const pinned = {
      ...release,
      assets: {
        amd64: { url: "https://releases.example.test/nixpacks.tar.gz", sha256 },
        arm64: { url: "https://releases.example.test/nixpacks.tar.gz", sha256 },
      },
    };
    const fetched: string[] = [];
    const download = (async (url: string) => {
      fetched.push(String(url));
      return new Response(bytes);
    }) as unknown as typeof fetch;
    const empty = await mkdtemp(join(root, "builders-"));
    const { error, output, calls } = await build({
      builder: { type: "nixpacks" },
      buildersDir: empty,
      downloads: { fetch: download, releases: [pinned] },
    });
    expect(error).toBeNull();
    expect(fetched).toEqual(["https://releases.example.test/nixpacks.tar.gz"]);
    expect(output).toContain(
      `Server capability repair started: nixpacks ${release.version} is missing, so it is installed now.`,
    );
    expect(output).toContain(`Installed nixpacks ${release.version}.`);
    expect(calls.some((call) => call.tool === "nixpacks")).toBe(true);
    expect((await stat(join(empty, "nixpacks", release.version, release.binary))).isFile()).toBe(
      true,
    );
    // A download that doesn't match its pin installs nothing and says so.
    const tampered = await mkdtemp(join(root, "builders-"));
    const bad = await build({
      builder: { type: "nixpacks" },
      buildersDir: tampered,
      downloads: {
        fetch: (async () => new Response(new Uint8Array([1, 2, 3]))) as unknown as typeof fetch,
        releases: [pinned],
      },
    });
    expect(bad.error?.message).toBe(
      `The download of nixpacks ${release.version} doesn't match its pinned checksum, so it wasn't installed.`,
    );
    expect(await stat(join(tampered, "nixpacks", release.version)).catch(() => null)).toBeNull();
  });
});

describe("passing failures are tried again; Railpack falls back to Nixpacks (R2-08)", () => {
  test("a build that fails on a 503 from a registry is tried again and succeeds", async () => {
    const failures = join(root, `failures-${crypto.randomUUID()}`);
    await writeFile(failures, "1");
    const { error, output, calls } = await build({ env: { FAKE_BUILD_FAILURES: failures } });
    expect(error).toBeNull();
    expect(buildxOf(calls)).toHaveLength(2);
    expect(output).toContain(
      "It looks like a passing network or registry problem; trying again in 2 seconds (attempt 2 of 3).",
    );
  });

  test("after three passing failures the build fails", async () => {
    const failures = join(root, `failures-${crypto.randomUUID()}`);
    await writeFile(failures, "5");
    const { error, calls } = await build({ env: { FAKE_BUILD_FAILURES: failures } });
    expect(error?.message).toContain("The Docker build failed");
    expect(buildxOf(calls)).toHaveLength(3);
  });

  test("what counts as passing", () => {
    expect(
      looksTransient(
        "#7 ERROR: unexpected status from GET request to https://r/: 503 Service Unavailable",
      ),
    ).toBe(true);
    expect(
      looksTransient("fatal: unable to access 'https://x/': The requested URL returned error: 502"),
    ).toBe(true);
    expect(looksTransient("fatal: the remote end hung up unexpectedly")).toBe(true);
    expect(looksTransient("npm ERR! code ETIMEDOUT")).toBe(true);
    expect(
      looksTransient("toomanyrequests: You have reached your pull rate limit. Too Many Requests"),
    ).toBe(true);
    expect(looksTransient("src/app.ts(500,3): error TS2304: Cannot find name 'x'.")).toBe(false);
    expect(
      looksTransient(
        'ERROR: process "/bin/sh -c npm run build" did not complete successfully: exit code: 2',
      ),
    ).toBe(false);
  });

  test("automatic mode: a Railpack plan that can't be made goes on with Nixpacks and says so", async () => {
    const { error, output, result, calls } = await build({
      builder: { type: "automatic" },
      files: {
        "package.json": JSON.stringify({ name: "web", dependencies: { next: "15.0.0" } }),
      },
      env: { FAKE_RAILPACK_FAIL: "1" },
    });
    expect(error).toBeNull();
    expect(output).toContain(
      "Railpack plan was not usable before compilation. Continuing with Nixpacks.",
    );
    expect(result?.builder).toBe("nixpacks");
    expect(calls.some((call) => call.tool === "nixpacks")).toBe(true);
  });

  test("a Railpack plan failure when Railpack was picked by hand still fails", async () => {
    const { error } = await build({
      builder: { type: "railpack" },
      env: { FAKE_RAILPACK_FAIL: "1" },
    });
    expect(error?.message).toContain("Railpack's plan failed");
  });
});

const PNPM_MONOREPO: Record<string, string> = {
  "package.json": JSON.stringify({ name: "acme", private: true }),
  "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - packages/*\n",
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "apps/web/package.json": JSON.stringify({
    name: "@acme/web",
    dependencies: { "@acme/ui": "workspace:*", next: "15.0.0" },
    scripts: { build: "next build", start: "next start" },
  }),
  "packages/ui/package.json": JSON.stringify({
    name: "@acme/ui",
    dependencies: { "@acme/tokens": "workspace:^" },
    scripts: { build: "tsc" },
  }),
  "packages/tokens/package.json": JSON.stringify({ name: "@acme/tokens" }),
  "packages/other/package.json": JSON.stringify({ name: "@acme/other", scripts: { build: "x" } }),
};

describe("monorepo apps build from the repository root (R2-04)", () => {
  test("a pnpm app that depends on workspace packages builds them first, from the root, with Nixpacks", async () => {
    const { error, output, calls, source, result } = await build({
      builder: { type: "automatic" },
      buildPath: "apps/web",
      files: PNPM_MONOREPO,
    });
    expect(error).toBeNull();
    expect(result?.builder).toBe("nixpacks");
    expect(output).toContain(
      "apps/web depends on other packages of this repository (packages/tokens, packages/ui). Building from the repository root with Nixpacks: installing with pnpm, building those packages first, then starting apps/web.",
    );
    const nixpacks = calls.find((call) => call.tool === "nixpacks");
    const args = nixpacks?.args ?? [];
    expect(args[1]).toBe(source);
    expect(args[args.indexOf("--install-cmd") + 1]).toBe("pnpm install --frozen-lockfile");
    expect(args[args.indexOf("--build-cmd") + 1]).toBe(
      "(cd 'packages/ui' && pnpm run build) && (cd 'apps/web' && pnpm run build)",
    );
    expect(args[args.indexOf("--start-cmd") + 1]).toBe("cd 'apps/web' && pnpm run start");
    expect(buildxOf(calls)[0]?.args.at(-1)).toBe(source);
  });

  test("with Turborepo the build goes through Turbo; plain apps and Dockerfiles are left alone", async () => {
    const plan = async (files: Record<string, string>, path: string) => {
      const folder = join(root, `ws-${crypto.randomUUID()}`);
      for (const [name, content] of Object.entries(files)) {
        await mkdir(dirname(join(folder, name)), { recursive: true });
        await writeFile(join(folder, name), content);
      }
      return workspacePlan(folder, path);
    };
    const turbo = await plan({ ...PNPM_MONOREPO, "turbo.json": "{}" }, "apps/web");
    expect(turbo?.commands.build).toBe("pnpm exec turbo run build --filter='@acme/web...'");
    // npm workspaces link siblings by name, without the workspace: protocol.
    const npm = await plan(
      {
        "package.json": JSON.stringify({ name: "acme", workspaces: ["apps/*", "libs/*"] }),
        "package-lock.json": "{}",
        "apps/api/package.json": JSON.stringify({
          name: "api",
          dependencies: { shared: "*" },
          main: "index.js",
        }),
        "libs/shared/package.json": JSON.stringify({ name: "shared", scripts: { build: "tsc" } }),
      },
      "apps/api",
    );
    expect(npm?.commands).toEqual({
      install: "npm ci",
      build: "(cd 'libs/shared' && npm run build)",
      start: "cd 'apps/api' && node 'index.js'",
    });
    expect(await plan(PNPM_MONOREPO, "packages/tokens")).toBeNull();
    expect(await plan(PNPM_MONOREPO, "")).toBeNull();
    const withDockerfile = await build({
      builder: { type: "automatic" },
      buildPath: "apps/web",
      files: { ...PNPM_MONOREPO, "apps/web/Dockerfile": "FROM node:24-alpine\n" },
    });
    expect(withDockerfile.result?.builder).toBe("dockerfile");
  });

  test("pnpm-workspace.yaml's package list", () => {
    expect(
      pnpmWorkspacePatterns(
        "packages:\n  - 'apps/*'\n  - \"packages/**\" # all\n  - '!**/test/**'\ncatalog:\n  x: 1\n",
      ),
    ).toEqual(["apps/*", "packages/**", "!**/test/**"]);
    expect(pnpmWorkspacePatterns("packages: [apps/*, 'libs/*']\n")).toEqual(["apps/*", "libs/*"]);
  });
});

describe("builders and their caches (B2-18, B2-22)", () => {
  test("two first Railpack builds at once on one server both build; BuildKit is started once", async () => {
    await fakes.resetStore();
    const builds = await Promise.all(
      [1, 2].map(async (index) => {
        const folder = join(root, "apps", `first-${index}-${crypto.randomUUID()}`);
        await mkdir(join(folder, "source"), { recursive: true });
        await writeFile(join(folder, "source", "package.json"), JSON.stringify({ name: "web" }));
        const params = commandParamsSchemas["app.build"].parse({
          appKey: `web-${index}`,
          builder: { type: "railpack" },
          tags: [`nearzero/web-${index}:abcd000${index}`],
          labels: { [NEARZERO_LABELS.service]: `svc_${index}` },
        });
        let output = "";
        try {
          await buildApp(params, {
            folder,
            buildersDir: fakes.buildersDir,
            containerized: false,
            env: {
              PATH: `${fakes.binDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
              FAKE_CLASSIC_STORE: "1",
            },
            signal: new AbortController().signal,
            out: (text) => {
              output += text;
            },
          });
          return { ok: true, output };
        } catch (error) {
          return { ok: false, output: `${output}\n${(error as Error).message}` };
        }
      }),
    );
    expect(builds.map((item) => item.ok)).toEqual([true, true]);
    const store = await fakes.readStore();
    const runs = store.calls.filter((call) => call.tool === "docker" && call.args[0] === "run");
    expect(runs).toHaveLength(1);
    // The BuildKit container and its cache carry the edition label, so uninstall finds them.
    const run = runs[0]?.args ?? [];
    expect(run).toContain("dev.nearzero.edition=1");
    const create = store.calls.find(
      (call) =>
        call.tool === "docker" &&
        call.args[0] === "volume" &&
        call.args[1] === "create" &&
        call.args.includes("nearzero-buildkit-state"),
    );
    expect(create?.args).toContain("dev.nearzero.edition=1");
  });

  test("a BuildKit cache volume from before the edition label is made again", async () => {
    await fakes.resetStore();
    const store = await fakes.readStore();
    await writeFile(
      fakes.storeFile,
      JSON.stringify({
        ...store,
        volumes: { "nearzero-buildkit-state": { "dev.nearzero.managed": "true" } },
      }),
    );
    const folder = join(root, "apps", crypto.randomUUID());
    await mkdir(join(folder, "source"), { recursive: true });
    await writeFile(join(folder, "source", "package.json"), JSON.stringify({ name: "web" }));
    await buildApp(
      commandParamsSchemas["app.build"].parse({
        appKey: "web-old",
        builder: { type: "railpack" },
        tags: ["nearzero/web-old:abcd0009"],
      }),
      {
        folder,
        buildersDir: fakes.buildersDir,
        containerized: false,
        env: {
          PATH: `${fakes.binDirectory}:${dirname(process.execPath)}:/usr/bin:/bin`,
          FAKE_CLASSIC_STORE: "1",
        },
        signal: new AbortController().signal,
        out: () => {},
      },
    );
    const after = (await fakes.readStore()) as unknown as {
      volumes: Record<string, Record<string, string>>;
    };
    expect(after.volumes["nearzero-buildkit-state"]?.["dev.nearzero.edition"]).toBe("1");
  });

  test("buildpacks keep their caches in the service's own labelled volumes", async () => {
    const { error, calls } = await build({ builder: { type: "paketo" } });
    expect(error).toBeNull();
    const created = calls.filter((call) => call.tool === "docker" && call.args[1] === "create");
    for (const name of ["nearzero-pack-web-x1y2z3-build", "nearzero-pack-web-x1y2z3-launch"]) {
      const call = created.find((item) => item.args.at(-1) === name);
      expect(call?.args).toContain("dev.nearzero.component=build-cache");
      expect(call?.args).toContain("dev.nearzero.service=svc_1");
      expect(call?.args).toContain("dev.nearzero.edition=1");
    }
    const pack = calls.find((call) => call.tool === "pack")?.args ?? [];
    // Paketo's full Jammy builder, with PHP among its languages (R2-14).
    expect(pack[pack.indexOf("--builder") + 1]).toBe("paketobuildpacks/builder-jammy-full");
    expect(pack[pack.indexOf("--cache") + 1]).toBe(
      "type=build;format=volume;name=nearzero-pack-web-x1y2z3-build;type=launch;format=volume;name=nearzero-pack-web-x1y2z3-launch",
    );
  });
});
