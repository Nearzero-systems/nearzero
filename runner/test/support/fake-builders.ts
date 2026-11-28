import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defaultRelease } from "../../tools/pins.ts";

/**
 * Stand-ins for the Docker CLI and the builder tools, for build tests that run the real
 * buildApp. They keep an image store in a JSON file and behave like the real ones where it
 * matters: `FROM` keeps the base image's labels, a build through a custom frontend (a
 * BUILDKIT_SYNTAX build argument) gets none of --label's, pack makes images with the lifecycle's
 * labels only, Nixpacks writes a Dockerfile and a build script from its --env names. Every call
 * is recorded with its arguments and environment, and buildx records the BuildKit secret files
 * it was given (their contents, read while the build runs).
 */

export interface Call {
  tool: "docker" | "railpack" | "nixpacks" | "pack";
  args: string[];
  env: Record<string, string>;
  /** buildx only: the contents of each --secret src= file, by id. */
  secrets?: Record<string, string>;
}

export interface Store {
  images: Record<string, { labels: Record<string, string>; exposed?: string[] }>;
  tags: Record<string, string>;
  builds: string[][];
  calls: Call[];
}

const RECORD = (tool: Call["tool"]) => `
import { mkdirSync as lockMake, rmdirSync as lockDrop } from "node:fs";
// Builds may run at once: every read-modify-write of the store holds this lock.
const locked = (work) => {
  for (;;) {
    try {
      lockMake(STORE + ".lock");
      break;
    } catch {
      Bun.sleepSync(5);
    }
  }
  try {
    return work();
  } finally {
    lockDrop(STORE + ".lock");
  }
};
const recordCall = (extra = {}) => locked(() => {
  const state = JSON.parse(readFileSync(STORE, "utf8"));
  state.calls = state.calls ?? [];
  state.calls.push({ tool: ${JSON.stringify(tool)}, args: process.argv.slice(2), env: { ...process.env }, ...extra });
  writeFileSync(STORE, JSON.stringify(state));
});
`;

const FAKE_DOCKER = (store: string) => `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const STORE = ${JSON.stringify(store)};
${RECORD("docker")}
const args = process.argv.slice(2);
const secrets = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--secret") {
    const spec = Object.fromEntries(args[i + 1].split(",").map((part) => part.split("=")));
    try { secrets[spec.id] = readFileSync(spec.src, "utf8"); } catch { secrets[spec.id] = null; }
  }
}
recordCall(args[0] === "buildx" && args[1] === "build" ? { secrets } : {});
const state = JSON.parse(readFileSync(STORE, "utf8"));
const removed = {
  images: new Set(),
  tags: new Set(),
  containers: new Set(),
  volumes: new Set(),
  builders: new Set(),
};
// Builds may run at once: what another call wrote meanwhile is kept.
const save = () => locked(() => {
  const now = JSON.parse(readFileSync(STORE, "utf8"));
  for (const key of ["images", "tags", "containers", "volumes", "builders"]) {
    const merged = { ...(now[key] ?? {}), ...(state[key] ?? {}) };
    for (const name of removed[key] ?? []) delete merged[name];
    now[key] = merged;
  }
  now.builds = [...(now.builds ?? []), ...state.builds.slice(startBuilds)];
  writeFileSync(STORE, JSON.stringify(now));
});
const startBuilds = state.builds.length;
const resolve = (ref) => (state.images[ref] ? ref : state.tags[ref]);
const fail = (message) => { console.error(message); process.exit(1); };
if (process.env.FAKE_BUILD_FAILURES && args[0] === "buildx" && args[1] === "build") {
  const left = Number(readFileSync(process.env.FAKE_BUILD_FAILURES, "utf8"));
  if (left > 0) {
    writeFileSync(process.env.FAKE_BUILD_FAILURES, String(left - 1));
    console.log("#7 ERROR: failed to fetch https://registry.npmjs.org/x: 503 Service Unavailable");
    process.exit(1);
  }
}
if (args[0] === "buildx" && args[1] === "version") {
  console.log("github.com/docker/buildx v0.29.1");
  process.exit(0);
}
if (args[0] === "info") {
  console.log(process.env.FAKE_CLASSIC_STORE ? '[["Backing Filesystem","extfs"]]' : '[["driver-type","io.containerd.snapshotter.v1"]]');
  process.exit(0);
}
state.containers = state.containers ?? {};
state.volumes = state.volumes ?? {};
state.builders = state.builders ?? {};
const labelsOf = (list) => {
  const labels = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "--label") {
      const [key, ...rest] = list[++i].split("=");
      labels[key] = rest.join("=");
    }
  }
  return labels;
};
const template = (format, labels) => format.replace(/{{index .(?:Config.)?Labels "([^"]+)"}}/g, (_, key) => labels[key] ?? "<no value>");
if (args[0] === "volume" && args[1] === "create") {
  const name = args[args.length - 1];
  if (!state.volumes[name]) state.volumes[name] = labelsOf(args);
  save();
  console.log(name);
  process.exit(0);
}
if (args[0] === "volume" && args[1] === "inspect") {
  const volume = state.volumes[args[args.length - 1]];
  if (!volume) fail("Error: No such volume");
  console.log(template(args[args.indexOf("--format") + 1], volume));
  process.exit(0);
}
if (args[0] === "volume" && args[1] === "rm") {
  delete state.volumes[args[args.length - 1]];
  removed.volumes.add(args[args.length - 1]);
  save();
  process.exit(0);
}
if (args[0] === "inspect") {
  const container = state.containers[args[args.length - 1]];
  if (!container) fail("Error: No such object");
  console.log(template(args[args.indexOf("--format") + 1].replace("{{.State.Running}}", String(container.running)), container.labels));
  process.exit(0);
}
if (args[0] === "run") {
  // Slow enough that two first builds at once both find no builder before either makes one.
  await Bun.sleep(400);
  const name = args[args.indexOf("--name") + 1];
  const made = locked(() => {
    const now = JSON.parse(readFileSync(STORE, "utf8"));
    if (now.containers?.[name]) return false;
    now.containers = now.containers ?? {};
    now.containers[name] = { labels: labelsOf(args), running: true };
    writeFileSync(STORE, JSON.stringify(now));
    return true;
  });
  if (!made) {
    console.error('docker: Error response from daemon: Conflict. The container name "/' + name + '" is already in use.');
    process.exit(125);
  }
  process.exit(0);
}
if (args[0] === "rm" || args[0] === "start") {
  if (args[0] === "rm") {
    delete state.containers[args[args.length - 1]];
    removed.containers.add(args[args.length - 1]);
  }
  save();
  process.exit(0);
}
if (args[0] === "buildx" && ["rm", "inspect", "create"].includes(args[1])) {
  const name = args[1] === "create" ? args[args.indexOf("--name") + 1] : args[2];
  if (args[1] === "rm") {
    delete state.builders[name];
    removed.builders.add(name);
  }
  else if (args[1] === "create") state.builders[name] = true;
  else if (!state.builders[name]) fail("ERROR: no builder " + name + " found");
  save();
  process.exit(0);
}
if (args[0] === "buildx" && args[1] === "build") {
  state.builds.push(args);
  const tags = [];
  const labels = {};
  let customFrontend = false;
  let file = "";
  for (let i = 2; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--tag") tags.push(args[++i]);
    else if (flag === "--label") {
      const [key, ...rest] = args[++i].split("=");
      labels[key] = rest.join("=");
    } else if (flag === "--build-arg") {
      if (args[++i].startsWith("BUILDKIT_SYNTAX=")) customFrontend = true;
    } else if (flag === "--file") file = args[++i];
    else if (["--builder", "--target", "--secret", "--build-context"].includes(flag)) i++;
  }
  let base = {};
  let exposed = [];
  if (file === "-") {
    const from = /^FROM\\s+(\\S+)/m.exec(readFileSync(0, "utf8"));
    const id = from && resolve(from[1]);
    if (!id) fail("ERROR: failed to resolve the base image");
    base = state.images[id].labels;
    exposed = state.images[id].exposed ?? [];
  } else {
    try {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/^EXPOSE\\s+(.+)$/gm)) {
        for (const port of match[1].trim().split(/\\s+/)) exposed.push(port.includes("/") ? port : port + "/tcp");
      }
    } catch {}
  }
  const id = "sha256:" + crypto.randomUUID().replaceAll("-", "");
  state.images[id] = { labels: { ...base, ...(customFrontend ? {} : labels) }, exposed };
  for (const tag of tags) state.tags[tag] = id;
  save();
  process.exit(0);
}
if (args[0] === "image" && args[1] === "inspect") {
  const id = resolve(args[args.length - 1]);
  if (!id) fail("Error: No such image: " + args[args.length - 1]);
  if (args.includes("{{json .Config.ExposedPorts}}")) {
    const ports = state.images[id].exposed ?? [];
    console.log(ports.length ? JSON.stringify(Object.fromEntries(ports.map((port) => [port, {}]))) : "null");
    process.exit(0);
  }
  const labels = state.images[id].labels;
  const labelsOnly = args.includes("{{json .Config.Labels}}");
  if (!labelsOnly) console.log(id);
  console.log(Object.keys(labels).length ? JSON.stringify(labels) : "null");
  process.exit(0);
}
if (args[0] === "pull") {
  // A buildpacks builder names its run image in its metadata, as the real ones do.
  const ref = args[args.length - 1];
  const id = "sha256:" + crypto.randomUUID().replaceAll("-", "");
  state.images[id] = {
    labels: ref.includes("builder")
      ? { "io.buildpacks.builder.metadata": JSON.stringify({ runImages: [{ image: "heroku/heroku:24" }] }) }
      : {},
  };
  state.tags[ref] = id;
  save();
  process.exit(0);
}
if (args[0] === "image" && args[1] === "rm") {
  const ref = args[2];
  if (state.images[ref]) {
    if (Object.values(state.tags).includes(ref)) fail("conflict: the image has tags");
    delete state.images[ref];
    removed.images.add(ref);
  } else if (state.tags[ref]) {
    delete state.tags[ref];
    removed.tags.add(ref);
  } else fail("Error: No such image: " + ref);
  save();
  process.exit(0);
}
fail("fake docker: unsupported command: " + args.join(" "));
`;

/**
 * Railpack's plan step: writes the plan and info files. A variable whose name starts with LEAK_
 * goes into the plan's variables with its value, the way a plan carrying a secret would. With
 * FAKE_RAILPACK_FAIL set, planning fails.
 */
const FAKE_RAILPACK = (store: string) => `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const STORE = ${JSON.stringify(store)};
${RECORD("railpack")}
recordCall();
const args = process.argv.slice(2);
if (process.env.FAKE_RAILPACK_FAIL) {
  console.error("Error: no provider matched this app");
  process.exit(1);
}
const names = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--env") names.push(args[i + 1]);
const variables = {};
for (const name of names) if (name.startsWith("LEAK_")) variables[name] = process.env[name];
writeFileSync(args[args.indexOf("--plan-out") + 1], JSON.stringify({ deploy: { variables }, secrets: names }));
writeFileSync(args[args.indexOf("--info-out") + 1], "{}");
`;

/** Nixpacks' plan step: a Dockerfile and a build script holding every value, as the real one. */
const FAKE_NIXPACKS = (store: string) => `#!/usr/bin/env bun
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const STORE = ${JSON.stringify(store)};
${RECORD("nixpacks")}
recordCall();
const args = process.argv.slice(2);
const out = join(args[args.indexOf("--out") + 1], ".nixpacks");
const names = ["CI", "NIXPACKS_METADATA", "NODE_ENV"];
for (let i = 0; i < args.length; i++) if (args[i] === "--env") names.push(args[i + 1]);
names.sort();
const own = { CI: "true", NIXPACKS_METADATA: "node", NODE_ENV: "production" };
const value = (name) => process.env[name] ?? own[name] ?? "";
const install = args.includes("--install-cmd") ? args[args.indexOf("--install-cmd") + 1] : "npm ci";
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "Dockerfile"), [
  "FROM ghcr.io/railwayapp/nixpacks:ubuntu-1745885067",
  "WORKDIR /app/",
  "RUN nix-env -if .nixpacks/nixpkgs.nix && nix-collect-garbage -d",
  "ARG " + names.join(" "),
  "ENV " + names.map((name) => name + "=$" + name).join(" "),
  "ENV NIXPACKS_PATH=/app/node_modules/.bin:$NIXPACKS_PATH",
  "COPY . /app/.",
  "RUN --mount=type=cache,id=x,target=/root/.npm " + install,
  "EXPOSE 3000",
  'CMD ["npm run start"]',
  "",
].join("\\n"));
writeFileSync(join(out, "build.sh"), "docker build /app -f /app/.nixpacks/Dockerfile -t x " + names.map((name) => "--build-arg " + name + "=" + value(name)).join(" ") + "\\n");
`;

/** pack build: the image it makes carries the lifecycle's labels only. */
const FAKE_PACK = (store: string) => `#!/usr/bin/env bun
import { readFileSync, writeFileSync } from "node:fs";
const STORE = ${JSON.stringify(store)};
${RECORD("pack")}
recordCall();
locked(() => {
  const state = JSON.parse(readFileSync(STORE, "utf8"));
  const args = process.argv.slice(2);
  const tags = [args[1]];
  for (let i = 2; i < args.length; i++) if (args[i] === "--tag") tags.push(args[++i]);
  const id = "sha256:" + crypto.randomUUID().replaceAll("-", "");
  state.images[id] = { labels: { "io.buildpacks.lifecycle.metadata": "{}" } };
  for (const tag of tags) state.tags[tag] = id;
  // pack pulls the builder's run image when the server lacks it.
  if (!state.tags["heroku/heroku:24"]) {
    const run = "sha256:" + crypto.randomUUID().replaceAll("-", "");
    state.images[run] = { labels: {} };
    state.tags["heroku/heroku:24"] = run;
  }
  writeFileSync(STORE, JSON.stringify(state));
});
`;

async function executable(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

export interface FakeBuilders {
  buildersDir: string;
  binDirectory: string;
  storeFile: string;
  readStore(): Promise<Store>;
  resetStore(start?: Pick<Store, "images" | "tags">): Promise<void>;
}

/** Puts the fake docker on a PATH folder and the fake tools where locateTool finds them. */
export async function installFakeBuilders(root: string): Promise<FakeBuilders> {
  const buildersDir = join(root, "builders");
  const binDirectory = join(root, "bin");
  const storeFile = join(root, "store.json");
  await executable(join(binDirectory, "docker"), FAKE_DOCKER(storeFile));
  const railpack = defaultRelease("railpack");
  await executable(
    join(buildersDir, "railpack", railpack.version, railpack.binary),
    FAKE_RAILPACK(storeFile),
  );
  const nixpacks = defaultRelease("nixpacks");
  await executable(
    join(buildersDir, "nixpacks", nixpacks.version, nixpacks.binary),
    FAKE_NIXPACKS(storeFile),
  );
  const pack = defaultRelease("pack");
  await executable(join(buildersDir, "pack", pack.version, pack.binary), FAKE_PACK(storeFile));
  return {
    buildersDir,
    binDirectory,
    storeFile,
    readStore: async () => JSON.parse(await readFile(storeFile, "utf8")) as Store,
    resetStore: async (start = { images: {}, tags: {} }) => {
      await writeFile(storeFile, JSON.stringify({ ...start, builds: [], calls: [] }));
    },
  };
}
