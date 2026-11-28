import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  BUILD_CACHE_COMPONENT,
  editionLabels,
  isBuildToolName,
  isPublicBuildVariable,
  NEARZERO_LABELS,
  type ParsedCommandParams,
} from "@nearzero/shared";
import {
  BUILDKIT_CONTAINER,
  BUILDKIT_IMAGE,
  BUILDKIT_OWN_TAG,
  BUILDKIT_PIN_LABEL,
  BUILDKIT_VOLUME,
  HEROKU_BUILDERS,
  PAKETO_BUILDER,
  RAILPACK_BUILDER_NAME,
  RAILPACK_FRONTENDS,
  STATIC_BUILD_IMAGE,
  STATIC_SERVER_IMAGE,
} from "../../tools/pins.ts";
import { runCommand } from "../exec/command.ts";
import { dropOutsideLinks, isInside, resolvePath } from "../sources/links.ts";
import { within } from "../sources/zip.ts";
import { automaticBuilder, detect, findDockerfile } from "./detect.ts";
import { BUILDER_OVERRIDES } from "./overrides.ts";
import { ensureLabelled, ownLabels, pullAsOwn } from "./own-image.ts";
import { localImageLabels, recordPulledImages, runImagesOf } from "./pulled-images.ts";
import { ensureTool, freeSpaceProblem, requireBuildx, type ToolContext } from "./tools.ts";
import { looksTransient, MAX_ATTEMPTS, pause, retryDelaySeconds, retryWords } from "./transient.ts";
import { workspacePlan } from "./workspaces.ts";

/**
 * Building a service's source into an image on its own server (spec 6.4): Dockerfile with
 * BuildKit, Railpack (its plan built by the Railpack BuildKit frontend), Nixpacks (its generated
 * Dockerfile built with BuildKit, optionally served as static files), Heroku and Paketo
 * buildpacks through `pack`, and Static (a small file server image). Automatic picks one from the
 * files and falls back to a repository Dockerfile when a language build fails.
 *
 * Every program runs through the one command runner: arguments as arrays, no shell, a timeout,
 * cancellation, and the build variables' values cut out of the log.
 */

export type BuildParams = ParsedCommandParams<"app.build">;

export interface BuildContext extends ToolContext {
  /** The service's folder in the runner's work folder (source/ is inside it). */
  folder: string;
  out: (text: string) => void;
  /**
   * Where images pulled for builds that can't carry Nearzero's label are recorded for the
   * uninstaller (pulled-images.ts); nothing is recorded without it.
   */
  pulledImagesFile?: string;
  /** The server's processor (Node's names: x64, arm64); the runner's own when left out. */
  arch?: string;
  /** The free bytes where builds work, instead of measuring them (tests). */
  freeBytes?: number;
}

/**
 * Builders published for amd64 only (C2-11): Docker Hub has paketobuildpacks/builder-jammy-full
 * and heroku/builder:22 as single linux/amd64 images, so on an arm64 server their lifecycle stops
 * partway with an exec format error. They are refused up front instead, naming what works there.
 */
export function amd64OnlyBuilder(image: string, arch: string): string | null {
  if (arch !== "arm64") return null;
  if (image === PAKETO_BUILDER) {
    return "Paketo's builder is published for amd64 servers only, so it can't build on this arm64 server. Pick Railpack, Nixpacks, a Dockerfile, or Heroku with stack 24, which builds on arm64.";
  }
  if (image === HEROKU_BUILDERS["22"]) {
    return "Heroku's stack 22 builder is published for amd64 servers only, so it can't build on this arm64 server. Pick stack 24, which builds on arm64.";
  }
  return null;
}

export interface BuildResult {
  image: string;
  builder: string;
  framework: string | null;
  language: string | null;
  notes: string[];
  /** The ports the built image declares (EXPOSE), like "8080/tcp" (R2-01). */
  exposedPorts: string[];
}

export class BuildError extends Error {
  /** The failing program's output ends like a passing network or registry problem. */
  transient = false;
  constructor(message: string) {
    super(message);
    this.name = "BuildError";
  }
}

/** The planning step itself failed (Railpack couldn't make a plan). */
export class PlanError extends BuildError {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

interface BuildInputs {
  values: BuildValues;
  /** The build secrets' files, by name. */
  secretFiles: Record<string, string>;
}

const BUILD_TIMEOUT_MS = 60 * 60_000;

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then((info) => info.isDirectory())
    .catch(() => false);
}

function secretsOf(params: BuildParams): string[] {
  return Object.values(params.buildEnv).filter((value) => value.length >= 4);
}

function labelsOf(params: BuildParams): Record<string, string> {
  return ownLabels(params.labels);
}

/**
 * How the service's variables reach a build (spec 23.4, 30b R2-05): never on a command line,
 * never in the built image unless the name says the value is public.
 *
 * - `secret`: every variable, as a BuildKit secret file (`--secret id=NAME,src=<file>`), written
 *   outside the source and removed after the build.
 * - `public`: names meant to be public (NEXT_PUBLIC_, VITE_ and so on, PORT, NODE_ENV), also as
 *   build arguments; their values reach buildx through its environment (`--build-arg NAME`).
 * - `tool`: what planning tools (Railpack, Nixpacks, pack) may read from their environment:
 *   everything except names that steer the tool or the system itself (PATH, LD_*, DOCKER_* …).
 */
interface BuildValues {
  secret: Record<string, string>;
  public: Record<string, string>;
  tool: Record<string, string>;
  /** Names left out of the planning tools' environment. */
  toolLeftOut: string[];
}

function buildValues(params: BuildParams): BuildValues {
  const values: BuildValues = { secret: {}, public: {}, tool: {}, toolLeftOut: [] };
  for (const [name, value] of Object.entries(params.buildEnv)) {
    values.secret[name] = value;
    if (isBuildToolName(name)) {
      values.toolLeftOut.push(name);
      continue;
    }
    values.tool[name] = value;
    if (isPublicBuildVariable(name)) values.public[name] = value;
  }
  return values;
}

/** Values that would be worth hiding: long enough, and not a plain word like "production". */
function protectedValues(params: BuildParams): [string, string][] {
  return Object.entries(params.buildEnv).filter(
    ([name, value]) => !isPublicBuildVariable(name) && value.length >= 8 && /[^a-z]/.test(value),
  );
}

/**
 * A generated plan that carries a secret's value would put it into the image: the build stops
 * first and names the variable (never the value).
 */
function refuseProtected(params: BuildParams, tool: string, texts: string[]): void {
  for (const [name, value] of protectedValues(params)) {
    if (texts.some((text) => text.includes(value))) {
      throw new BuildError(
        `${tool} generated a plan containing protected build material (key=${name}), so the build stopped before the value could reach the image. If the value is meant to be public, give the variable a public name, like NEXT_PUBLIC_${name}.`,
      );
    }
  }
}

/** The build's secrets as files only root can read, outside the source (and the build context). */
class SecretFiles {
  private constructor(
    readonly directory: string,
    readonly files: Record<string, string>,
  ) {}

  static async write(folder: string, values: Record<string, string>): Promise<SecretFiles> {
    const directory = join(folder, "build-secrets", crypto.randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const files: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const path = join(directory, name);
      await writeFile(path, value, { mode: 0o600, flag: "wx" });
      files[name] = path;
    }
    return new SecretFiles(directory, files);
  }

  async remove(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function run(
  argv: string[],
  context: BuildContext,
  options: {
    cwd?: string;
    env?: Record<string, string>;
    secrets: string[];
    what: string;
    /** A failure is the plan step's (PlanError). */
    plan?: boolean;
  },
): Promise<void> {
  const result = await runCommand({
    argv,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: { ...context.env, ...options.env },
    timeoutMs: BUILD_TIMEOUT_MS,
    secrets: options.secrets,
    signal: context.signal,
    onOutput: (text) => context.out(text),
  });
  if (result.cancelled) throw new BuildError("The build was cancelled.");
  if (result.timedOut)
    throw new BuildError(`${options.what} ran for more than an hour and was stopped.`);
  if (result.exitCode !== 0) {
    const message = `${options.what} failed (exit code ${result.exitCode ?? "none"}).`;
    const error = options.plan ? new PlanError(message) : new BuildError(message);
    error.transient = looksTransient(result.output);
    throw error;
  }
}

/** Names whose values a tool reads from its environment: never one that steers the tool. */
function toolEnv(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([name]) => !isBuildToolName(name)));
}

interface BuildxSpec {
  context: string;
  dockerfile: string;
  tags: string[];
  labels: Record<string, string>;
  /** Build arguments that are Nearzero's or a builder's own, never a service's values. */
  buildArgs?: Record<string, string>;
  /** Public variables: build arguments whose values buildx takes from its environment. */
  envArgs?: Record<string, string>;
  /** BuildKit secrets, by id, as files. */
  secretFiles?: Record<string, string>;
  target?: string;
  namedContexts?: Record<string, string>;
  noCache: boolean;
  /** A buildx builder other than Docker's own. */
  builder?: string;
}

async function buildx(spec: BuildxSpec, context: BuildContext, secrets: string[], what: string) {
  const argv = ["docker", "buildx", "build", "--progress=plain", "--load"];
  if (spec.builder) argv.push("--builder", spec.builder);
  argv.push("--file", spec.dockerfile);
  if (spec.target) argv.push("--target", spec.target);
  if (spec.noCache) argv.push("--no-cache");
  for (const tag of spec.tags) argv.push("--tag", tag);
  for (const [key, value] of Object.entries(spec.labels)) argv.push("--label", `${key}=${value}`);
  for (const [key, value] of Object.entries(spec.buildArgs ?? {})) {
    argv.push("--build-arg", `${key}=${value}`);
  }
  const envArgs = toolEnv(spec.envArgs ?? {});
  for (const key of Object.keys(envArgs)) argv.push("--build-arg", key);
  for (const [id, path] of Object.entries(spec.secretFiles ?? {})) {
    argv.push("--secret", `id=${id},src=${path}`);
  }
  for (const [name, path] of Object.entries(spec.namedContexts ?? {})) {
    argv.push("--build-context", `${name}=${path}`);
  }
  argv.push(spec.context);
  await run(argv, context, {
    cwd: spec.context,
    env: { DOCKER_BUILDKIT: "1", ...envArgs },
    secrets,
    what,
  });
}

function staticServerConfig(port: number, spa: boolean): string {
  return [
    "server {",
    `  listen ${port};`,
    `  listen [::]:${port};`,
    "  root /usr/share/nginx/html;",
    "  index index.html;",
    "  location / {",
    `    try_files $uri $uri/ ${spa ? "/index.html" : "=404"};`,
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * A command on one line: line breaks of every kind (YAML and Dockerfiles also break lines at a
 * lone carriage return, NEL and the Unicode separators) become spaces, and other control
 * characters are dropped, so a command can never add lines to a file it is written into.
 */
export function oneLine(command: string): string {
  return (
    command
      .replace(/[\r\n\u0085\u2028\u2029]+/g, " ")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters dropped.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
  );
}

/** A file's lines as one RUN step that writes them, each line single-quoted for the shell. */
function writeFileStep(path: string, text: string): string {
  const lines = text.replace(/\n$/, "").split("\n");
  return `RUN printf '%s\\n' ${lines.map(shellQuote).join(" ")} > ${path}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The Static builder (spec 6.4): the install and build commands run in a Node image first, with
 * the service's variables as the other builds get them (C2-05): public names (VITE_, NEXT_PUBLIC_
 * and so on) as build arguments, the others as build secrets exported for those steps only. The
 * built folder is served by nginx. The Dockerfile needs nothing newer than Docker 20.10 (C2-04).
 */
export function staticDockerfile(
  params: Pick<BuildParams, "commands" | "servicePort">,
  spa: boolean,
  values: { public: readonly string[]; secret: readonly string[] },
  images: { build: string; server: string } = {
    build: STATIC_BUILD_IMAGE,
    server: BUILDER_OVERRIDES.staticServer ?? STATIC_SERVER_IMAGE,
  },
): string {
  const lines: string[] = [];
  const hasBuild = params.commands.install !== "" || params.commands.build !== "";
  if (hasBuild) {
    lines.push(`FROM ${images.build} AS build`, "WORKDIR /app");
    // Public values are build arguments, which RUN steps see in their environment.
    if (values.public.length > 0) lines.push(`ARG ${values.public.join(" ")}`);
    lines.push("COPY . .");
    for (const command of [params.commands.install, params.commands.build]) {
      if (command) lines.push(withSecrets(oneLine(command), values.secret));
    }
    // The built files: the first of the usual output folders, else the whole folder.
    lines.push(
      'RUN mkdir -p /site && for d in dist build out public; do if [ -d "$d" ]; then cp -a "$d"/. /site/ && exit 0; fi; done; cp -a . /site/',
    );
  }
  lines.push(`FROM ${images.server}`);
  lines.push("RUN rm -f /etc/nginx/conf.d/default.conf");
  lines.push(
    writeFileStep(
      "/etc/nginx/conf.d/nearzero-static.conf",
      staticServerConfig(params.servicePort, spa),
    ),
  );
  lines.push(
    hasBuild ? "COPY --from=build /site/ /usr/share/nginx/html/" : "COPY . /usr/share/nginx/html/",
  );
  lines.push(`EXPOSE ${params.servicePort}`);
  return `${lines.join("\n")}\n`;
}

async function buildStatic(
  params: BuildParams,
  folder: string,
  context: BuildContext,
  spa: boolean,
  inputs: BuildInputs,
) {
  const scratch = join(context.folder, "static-build");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  const publicNames = Object.keys(toolEnv(inputs.values.public));
  const secretNames = Object.keys(inputs.values.tool).filter(
    (name) => !Object.hasOwn(inputs.values.public, name),
  );
  await writeFile(
    join(scratch, "Dockerfile"),
    staticDockerfile(params, spa, { public: publicNames, secret: secretNames }),
  );
  await buildx(
    {
      context: folder,
      dockerfile: join(scratch, "Dockerfile"),
      tags: params.tags,
      labels: labelsOf(params),
      envArgs: inputs.values.public,
      secretFiles: Object.fromEntries(
        Object.entries(inputs.secretFiles).filter(([name]) => secretNames.includes(name)),
      ),
      noCache: params.noCache,
    },
    context,
    secretsOf(params),
    "The static build",
  );
}

async function buildDockerfile(
  params: BuildParams,
  sourceRoot: string,
  folder: string,
  settings: { dockerfilePath: string; contextPath: string; stage: string },
  context: BuildContext,
  inputs: BuildInputs,
) {
  const buildContext = within(sourceRoot, join(relative(sourceRoot, folder), settings.contextPath));
  const dockerfile = within(
    sourceRoot,
    join(relative(sourceRoot, folder), settings.dockerfilePath || "Dockerfile"),
  );
  // Through links, both must stay in the source: buildx reads the Dockerfile as root.
  const realRoot = await realpath(sourceRoot);
  for (const [path, what] of [
    [dockerfile, "The Dockerfile path"],
    [buildContext, "The build context"],
  ] as const) {
    const real = await resolvePath(path);
    if (real === null || !isInside(realRoot, real)) {
      throw new BuildError(
        `${what} leads outside the source through a link. Nearzero doesn't follow links out of the source; point it at a file inside the repository.`,
      );
    }
  }
  const found = await stat(dockerfile).catch(() => null);
  if (!found?.isFile()) {
    throw new BuildError(
      `There's no Dockerfile at ${relative(sourceRoot, dockerfile) || "the build path"}. Check the Dockerfile path in the Build settings.`,
    );
  }
  if (!(await isDirectory(buildContext))) {
    throw new BuildError("The build context folder doesn't exist. Check the Build settings.");
  }
  await buildx(
    {
      context: buildContext,
      dockerfile,
      tags: params.tags,
      labels: labelsOf(params),
      envArgs: inputs.values.public,
      secretFiles: inputs.secretFiles,
      ...(settings.stage ? { target: settings.stage } : {}),
      noCache: params.noCache,
    },
    context,
    secretsOf(params),
    "The Docker build",
  );
}

/**
 * The builder for Railpack plans. Its frontend uses BuildKit's merge operations, which Docker's
 * built-in builder has only with the containerd image store; elsewhere a BuildKit container
 * (pinned) is created once and reused.
 */
/** One BuildKit setup at a time on a server: two first builds at once share it (B2-18). */
let builderSetup: Promise<unknown> = Promise.resolve();

function railpackBuilder(context: BuildContext): Promise<string | undefined> {
  const turn = builderSetup.then(() => setUpRailpackBuilder(context));
  builderSetup = turn.catch(() => {});
  return turn;
}

async function setUpRailpackBuilder(context: BuildContext): Promise<string | undefined> {
  const quiet = { env: context.env, timeoutMs: 30_000, signal: context.signal };
  const docker = (args: string[], timeoutMs = 30_000) =>
    runCommand({ ...quiet, timeoutMs, argv: ["docker", ...args] });
  const info = await docker(["info", "--format", "{{json .DriverStatus}}"]);
  if (info.output.includes("io.containerd.snapshotter")) return undefined;
  // BuildKit runs in a container of Nearzero's own, labelled like everything else it creates,
  // with its cache in a labelled volume; buildx reaches it through its "remote" driver.
  const label = (name: string, value: string) => ["--label", `${name}=${value}`];
  const present = await docker([
    "inspect",
    "--format",
    `{{.State.Running}} {{index .Config.Labels "${BUILDKIT_PIN_LABEL}"}} {{index .Config.Labels "${NEARZERO_LABELS.edition}"}}`,
    BUILDKIT_CONTAINER,
  ]);
  const [running, pin, editionLabel] = present.output.trim().split(" ");
  // Made before its cache carried the edition label (B2-22): made again, so uninstall finds it.
  const volume = await docker([
    "volume",
    "inspect",
    "--format",
    `{{index .Labels "${NEARZERO_LABELS.edition}"}}`,
    BUILDKIT_VOLUME,
  ]);
  const unlabelled = volume.exitCode === 0 && volume.output.trim() !== "1";
  if (present.exitCode !== 0 || pin !== BUILDKIT_IMAGE || editionLabel !== "1" || unlabelled) {
    context.out("Starting a BuildKit builder for Railpack (once per server)\n");
    if (present.exitCode === 0) await docker(["rm", "--force", BUILDKIT_CONTAINER]);
    if (unlabelled) await docker(["volume", "rm", "--force", BUILDKIT_VOLUME]);
    const own = {
      env: context.env,
      workDirectory: join(context.folder, "..", ".."),
      signal: context.signal,
      out: context.out,
    };
    await pullAsOwn(own, BUILDKIT_IMAGE, BUILDKIT_OWN_TAG, {
      [NEARZERO_LABELS.component]: "builder",
    }).catch((error: unknown) => {
      throw new BuildError((error as Error).message);
    });
    const edition = Object.entries(editionLabels()).flatMap(([name, value]) => label(name, value));
    await docker([
      "volume",
      "create",
      ...label(NEARZERO_LABELS.managed, "true"),
      ...label(NEARZERO_LABELS.component, "builder"),
      ...edition,
      BUILDKIT_VOLUME,
    ]);
    const started = await docker(
      [
        "run",
        "--detach",
        "--name",
        BUILDKIT_CONTAINER,
        "--privileged",
        "--restart",
        "unless-stopped",
        ...label(NEARZERO_LABELS.managed, "true"),
        ...label(NEARZERO_LABELS.component, "builder"),
        ...label(BUILDKIT_PIN_LABEL, BUILDKIT_IMAGE),
        ...edition,
        "--volume",
        `${BUILDKIT_VOLUME}:/var/lib/buildkit`,
        BUILDKIT_OWN_TAG,
      ],
      120_000,
    );
    // Another runner process (or a setup this one didn't wait for) may have made it meanwhile.
    const raced =
      started.exitCode !== 0 &&
      /already in use/i.test(started.output) &&
      (await docker(["inspect", "--format", "{{.State.Running}}", BUILDKIT_CONTAINER])).exitCode ===
        0;
    if (started.exitCode !== 0 && !raced) {
      context.out(started.output);
      throw new BuildError("The BuildKit builder for Railpack couldn't be started.");
    }
    await docker(["buildx", "rm", RAILPACK_BUILDER_NAME]);
  } else if (running !== "true") {
    await docker(["start", BUILDKIT_CONTAINER]);
  }
  const found = await docker(["buildx", "inspect", RAILPACK_BUILDER_NAME]);
  if (found.exitCode !== 0) {
    const created = await docker([
      "buildx",
      "create",
      "--name",
      RAILPACK_BUILDER_NAME,
      "--driver",
      "remote",
      `docker-container://${BUILDKIT_CONTAINER}`,
    ]);
    if (created.exitCode !== 0) {
      const again = await docker(["buildx", "inspect", RAILPACK_BUILDER_NAME]);
      if (again.exitCode !== 0) {
        context.out(created.output);
        throw new BuildError("The BuildKit builder for Railpack couldn't be set up.");
      }
    }
  }
  return RAILPACK_BUILDER_NAME;
}

async function buildRailpack(
  params: BuildParams,
  folder: string,
  version: string,
  context: BuildContext,
  inputs: BuildInputs,
) {
  const railpack = await ensureTool("railpack", version, context, context.out);
  const frontend = BUILDER_OVERRIDES.railpackFrontend ?? RAILPACK_FRONTENDS[version];
  if (!frontend) throw new BuildError(`Railpack ${version} isn't supported by this runner.`);
  const scratch = join(context.folder, "railpack");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  // Railpack reads the variables from its environment (`--env NAME` with no value): it plans
  // with them and lists them as the build's secrets, never writing their values on a command line.
  const variables: Record<string, string> = { ...inputs.values.tool };
  if (params.commands.install) variables.RAILPACK_INSTALL_CMD = params.commands.install;
  if (params.commands.build) variables.RAILPACK_BUILD_CMD = params.commands.build;
  if (params.commands.start) variables.RAILPACK_START_CMD = params.commands.start;
  const plan = join(scratch, "railpack-plan.json");
  const prepare = [
    railpack,
    "prepare",
    folder,
    "--plan-out",
    plan,
    "--info-out",
    join(scratch, "railpack-info.json"),
  ];
  for (const key of Object.keys(variables)) prepare.push("--env", key);
  context.out(`Planning the build with Railpack ${version}\n`);
  await run(prepare, context, {
    cwd: folder,
    env: variables,
    secrets: secretsOf(params),
    what: "Railpack's plan",
    plan: true,
  });
  refuseProtected(params, "Railpack", [await readFile(plan, "utf8").catch(() => "")]);
  const builder = await railpackBuilder(context);
  const hash = createHash("sha256");
  for (const [key, value] of Object.entries(params.buildEnv).sort()) {
    hash.update(`${key}=${value}\n`);
  }
  await buildx(
    {
      context: folder,
      dockerfile: plan,
      tags: params.tags,
      labels: labelsOf(params),
      buildArgs: {
        BUILDKIT_SYNTAX: frontend,
        "secrets-hash": hash.digest("hex"),
        "cache-key": params.appKey,
      },
      secretFiles: inputs.secretFiles,
      noCache: params.noCache,
      ...(builder ? { builder } : {}),
    },
    context,
    secretsOf(params),
    "The Railpack build",
  );
}

/**
 * Nixpacks' own build arguments (CI, NODE_ENV, NIXPACKS_METADATA …) from the build script it
 * writes; the service's variables in it are left out (they arrive as secrets or from buildx's
 * environment instead).
 */
export function nixpacksOwnArguments(
  script: string,
  variables: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of script.matchAll(/--build-arg\s+(?:'([^']*)'|"([^"]*)"|(\S+))/g)) {
    const pair = match[1] ?? match[2] ?? match[3] ?? "";
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const name = pair.slice(0, at);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || Object.hasOwn(variables, name)) continue;
    out[name] = pair.slice(at + 1);
  }
  return out;
}

/** Where a RUN step finds a build secret's file. */
export function secretPath(name: string): string {
  return `/run/secrets/${name}`;
}

/**
 * A RUN step with these build secrets (C2-04): each is mounted as a file, which every BuildKit
 * reads (Docker 20.10 and later, the Debian and Amazon Linux engines included; the `env=` form
 * needs Dockerfile 1.10), and a shell-form step exports it into its own environment first, value
 * kept exactly, trailing line breaks included. Nothing reaches the image or its history.
 */
export function withSecrets(step: string, names: readonly string[]): string {
  if (names.length === 0) return `RUN ${step}`;
  const mounts = names
    .map((name) => `--mount=type=secret,id=${name},target=${secretPath(name)}`)
    .join(" ");
  // The step's own flags (--mount=type=cache… , --network=…) stay in front of its command.
  const [, flags = "", command = ""] = /^((?:--\S+\s+)*)([\s\S]*)$/.exec(step) ?? [];
  if (command.startsWith("[")) return `RUN ${mounts} ${flags}${command}`;
  const exports = names
    .map((name) => {
      const path = secretPath(name);
      return `if [ -f ${path} ]; then ${name}="$(cat ${path}; printf x)"; ${name}="\${${name}%x}"; export ${name}; fi;`;
    })
    .join(" ");
  return `RUN ${mounts} ${flags}${exports} ${command}`;
}

/**
 * Nixpacks' Dockerfile turns every variable into a build argument and an ENV entry, which would
 * put secrets into the image (R2-05). The secrets' ARG and ENV entries are taken out, and each
 * RUN step mounts them and exports them for that step only (withSecrets).
 */
export function secretsAsMounts(dockerfile: string, names: readonly string[]): string {
  if (names.length === 0) return dockerfile;
  const secret = new Set(names);
  const out: string[] = [];
  for (const line of dockerfile.split("\n")) {
    const arg = /^ARG\s+(.*)$/.exec(line);
    if (arg) {
      const kept = (arg[1] as string).split(/\s+/).filter((item) => {
        const name = item.split("=")[0] ?? "";
        return item !== "" && !secret.has(name);
      });
      if (kept.length > 0) out.push(`ARG ${kept.join(" ")}`);
      continue;
    }
    const env = /^ENV\s+(.*)$/.exec(line);
    if (env) {
      const items = (env[1] as string).split(/\s+/).filter(Boolean);
      const own = items.every((item) => /^([A-Za-z_][A-Za-z0-9_]*)=\$\{?\1\}?$/.test(item));
      if (own) {
        const kept = items.filter((item) => !secret.has(item.split("=")[0] ?? ""));
        if (kept.length > 0) out.push(`ENV ${kept.join(" ")}`);
        continue;
      }
      out.push(line);
      continue;
    }
    const step = /^RUN\s+(.*)$/.exec(line);
    if (step) {
      out.push(withSecrets(step[1] as string, names));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

async function buildNixpacks(
  params: BuildParams,
  folder: string,
  publishDirectory: string,
  context: BuildContext,
  inputs: BuildInputs,
) {
  const nixpacks = await ensureTool("nixpacks", null, context, context.out);
  const out = join(folder, ".nixpacks");
  await rm(out, { recursive: true, force: true });
  const argv = [nixpacks, "build", folder, "--out", folder];
  if (params.commands.install) argv.push("--install-cmd", params.commands.install);
  if (params.commands.build) argv.push("--build-cmd", params.commands.build);
  if (params.commands.start) argv.push("--start-cmd", params.commands.start);
  // Nixpacks reads the values from its environment (`--env NAME` with no value).
  for (const key of Object.keys(inputs.values.tool)) argv.push("--env", key);
  context.out("Planning the build with Nixpacks\n");
  await run(argv, context, {
    cwd: folder,
    env: inputs.values.tool,
    secrets: secretsOf(params),
    what: "Nixpacks' plan",
  });
  const dockerfile = join(out, "Dockerfile");
  if (!(await stat(dockerfile).catch(() => null))) {
    throw new BuildError("Nixpacks didn't write a build plan for this source.");
  }
  // Its build script holds every value as a build argument, and sits in the build context: its
  // own settings are read from it, then it goes.
  const script = await readFile(join(out, "build.sh"), "utf8").catch(() => "");
  await rm(join(out, "build.sh"), { force: true });
  const own = nixpacksOwnArguments(script, params.buildEnv);
  const secretNames = Object.keys(inputs.values.tool).filter(
    (name) => !Object.hasOwn(inputs.values.public, name),
  );
  await writeFile(dockerfile, secretsAsMounts(await readFile(dockerfile, "utf8"), secretNames));
  const planFiles = await readdir(out).catch(() => [] as string[]);
  refuseProtected(
    params,
    "Nixpacks",
    await Promise.all(planFiles.map((name) => readFile(join(out, name), "utf8").catch(() => ""))),
  );
  const appTag = publishDirectory ? `${params.tags[0]}-nixpacks` : null;
  await buildx(
    {
      context: folder,
      dockerfile,
      tags: appTag ? [appTag] : params.tags,
      labels: labelsOf(params),
      buildArgs: own,
      envArgs: inputs.values.public,
      secretFiles: inputs.secretFiles,
      noCache: params.noCache,
    },
    context,
    secretsOf(params),
    "The Nixpacks build",
  );
  if (!appTag) return;
  // A publish directory: its files are served by the static server instead of the app.
  const publish = within("/app", publishDirectory);
  const scratch = join(context.folder, "publish-build");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  await writeFile(
    join(scratch, "nearzero-static.conf"),
    staticServerConfig(params.servicePort, true),
  );
  await writeFile(
    join(scratch, "Dockerfile"),
    [
      `FROM ${appTag} AS app`,
      `FROM ${BUILDER_OVERRIDES.staticServer ?? STATIC_SERVER_IMAGE}`,
      "RUN rm -f /etc/nginx/conf.d/default.conf",
      "COPY nearzero-static.conf /etc/nginx/conf.d/nearzero-static.conf",
      `COPY --from=app ${publish}/ /usr/share/nginx/html/`,
      `EXPOSE ${params.servicePort}`,
      "",
    ].join("\n"),
  );
  context.out(`Serving ${publishDirectory} with the static server\n`);
  await buildx(
    {
      context: scratch,
      dockerfile: join(scratch, "Dockerfile"),
      tags: params.tags,
      labels: labelsOf(params),
      noCache: false,
    },
    context,
    [],
    "Packaging the publish directory",
  );
  await runCommand({
    argv: ["docker", "image", "rm", appTag],
    env: context.env,
    timeoutMs: 60_000,
  });
}

/** The volumes pack keeps its build and launch caches in, made first with Nearzero's labels. */
export async function packCaches(
  params: BuildParams,
  context: BuildContext,
): Promise<{ build: string; launch: string }> {
  const caches = {
    build: `nearzero-pack-${params.appKey}-build`,
    launch: `nearzero-pack-${params.appKey}-launch`,
  };
  const labels: Record<string, string> = {
    [NEARZERO_LABELS.managed]: "true",
    [NEARZERO_LABELS.component]: BUILD_CACHE_COMPONENT,
    ...editionLabels(),
    ...(params.labels[NEARZERO_LABELS.service]
      ? { [NEARZERO_LABELS.service]: params.labels[NEARZERO_LABELS.service] }
      : {}),
  };
  for (const name of Object.values(caches)) {
    const argv = ["docker", "volume", "create"];
    for (const [key, value] of Object.entries(labels)) argv.push("--label", `${key}=${value}`);
    argv.push(name);
    await run(argv, context, { secrets: [], what: `Making the build cache ${name}` });
  }
  return caches;
}

async function buildBuildpacks(
  params: BuildParams,
  sourceRoot: string,
  folder: string,
  builderImage: string,
  context: BuildContext,
  notes: string[],
  inputs: BuildInputs,
) {
  const refused = amd64OnlyBuilder(builderImage, context.arch ?? process.arch);
  if (refused) throw new BuildError(refused);
  const pack = await ensureTool("pack", null, context, context.out);
  if (params.commands.start) {
    // Never through a link: the runner is root, and a link could lead anywhere on the server.
    const procfile = join(folder, "Procfile");
    const existing = await lstat(procfile).catch(() => null);
    if (existing?.isSymbolicLink()) {
      // A link to a Procfile inside the source is a Procfile; anything else is refused.
      const real = await resolvePath(procfile);
      const target =
        real && isInside(await realpath(sourceRoot), real)
          ? await stat(real).catch(() => null)
          : null;
      if (!target?.isFile()) {
        throw new BuildError(
          "The source's Procfile is a link to nothing in the source. Nearzero doesn't write through links: make Procfile a regular file, or remove it so the start command is used.",
        );
      }
      notes.push("The repository has a Procfile, so the start command was not used.");
    } else if (existing === null) {
      // wx: created here or not at all; it never follows a link that appeared meanwhile.
      await writeFile(procfile, `web: ${oneLine(params.commands.start)}\n`, {
        flag: "wx",
        mode: 0o644,
      });
      context.out("Wrote a Procfile with the start command\n");
    } else notes.push("The repository has a Procfile, so the start command was not used.");
  }
  if (params.commands.install || params.commands.build) {
    notes.push(
      "Buildpacks run their own install and build steps, so the Install and Build commands were not used.",
    );
  }
  const argv = [
    pack,
    "build",
    params.tags[0] as string,
    "--path",
    folder,
    "--builder",
    builderImage,
    "--trust-builder",
    "--pull-policy",
    "if-not-present",
    "--no-color",
  ];
  for (const tag of params.tags.slice(1)) argv.push("--tag", tag);
  // pack's caches are volumes it would name at random, without labels: they get the service's
  // own names and Nearzero's labels, so teardown and uninstall find them (B2-22).
  const caches = await packCaches(params, context);
  argv.push(
    "--cache",
    `type=build;format=volume;name=${caches.build};type=launch;format=volume;name=${caches.launch}`,
  );
  if (params.noCache) argv.push("--clear-cache");
  // pack reads the values from its environment (`--env NAME` with no value).
  for (const key of Object.keys(inputs.values.tool)) argv.push("--env", key);
  // pack runs the builder image and the run image it names by their own names, so they can't
  // be given Nearzero's label; the ones this build brings onto the server are recorded instead,
  // for the uninstaller (spec 3.3). The builder is pulled first so its run image is known.
  const pulled: string[] = [];
  let builderLabels = await localImageLabels(context, builderImage);
  if (builderLabels === null) {
    context.out(`Pulling the builder image ${builderImage}\n`);
    await run(["docker", "pull", "--quiet", builderImage], context, {
      secrets: [],
      what: `Pulling ${builderImage}`,
    });
    pulled.push(builderImage);
    builderLabels = await localImageLabels(context, builderImage);
  }
  const runImages = runImagesOf(builderLabels);
  const missingRunImages: string[] = [];
  for (const image of runImages) {
    if ((await localImageLabels(context, image)) === null) missingRunImages.push(image);
  }
  try {
    await run(argv, context, {
      cwd: folder,
      env: inputs.values.tool,
      secrets: secretsOf(params),
      what: "The buildpacks build",
    });
  } finally {
    for (const image of missingRunImages) {
      if ((await localImageLabels(context, image)) !== null) pulled.push(image);
    }
    if (context.pulledImagesFile && pulled.length > 0) {
      await recordPulledImages(context.pulledImagesFile, pulled).catch((error: unknown) =>
        context.out(`Couldn't record the pulled images: ${(error as Error).message}\n`),
      );
    }
  }
}

/** A size as Docker's CLI prints it ("1.234GB", "512MB", "0B"; decimal units), in bytes. */
export function parseDockerSize(text: string): number {
  const match = /^([\d.]+)\s*([kKMGTP]?)i?B$/.exec(text.trim());
  if (!match) return 0;
  const power = { "": 0, k: 1, K: 1, M: 2, G: 3, T: 4, P: 5 }[match[2] as string] ?? 0;
  return Math.round(Number(match[1]) * 1000 ** power);
}

/**
 * Empties the cache of Nearzero's BuildKit builder for Railpack (its own volume, which Docker's
 * own prune never sees), when the server has one (spec 9.4, R3-04). Returns the bytes freed, from
 * the "Total:" line buildx prints.
 */
export async function pruneRailpackCache(
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<number> {
  const docker = (args: string[], timeoutMs = 30_000) =>
    runCommand({ argv: ["docker", ...args], env, timeoutMs, signal });
  // Without the Docker CLI or the builder there is nothing of Railpack's to remove.
  const found = await docker(["buildx", "inspect", RAILPACK_BUILDER_NAME]).catch(() => null);
  if (found?.exitCode !== 0) return 0;
  const pruned = await docker(
    ["buildx", "prune", "--builder", RAILPACK_BUILDER_NAME, "--all", "--force"],
    30 * 60_000,
  );
  if (pruned.exitCode !== 0) {
    throw new Error(`Railpack's build cache couldn't be removed: ${pruned.output.trim()}`);
  }
  const total = /^Total:\s*(\S+)\s*$/m.exec(pruned.output)?.[1];
  return total ? parseDockerSize(total) : 0;
}

export async function buildApp(params: BuildParams, context: BuildContext): Promise<BuildResult> {
  const sourceRoot = join(context.folder, "source");
  if (!(await isDirectory(sourceRoot))) {
    throw new BuildError("There's no source to build. Fetch the source first.");
  }
  // Before anything is built: enough disk to build on (G3-04).
  const lowDisk = await freeSpaceProblem(context.folder, context.freeBytes);
  if (lowDisk) throw new BuildError(lowDisk);
  // Sources are cleaned when they are fetched; a folder from before that is cleaned here.
  for (const link of await dropOutsideLinks(sourceRoot)) {
    context.out(`Left out ${link}: it is a link to somewhere outside the source.\n`);
  }
  const folder = within(sourceRoot, params.buildPath);
  const realFolder = await resolvePath(folder);
  if (realFolder === null || !isInside(await realpath(sourceRoot), realFolder)) {
    throw new BuildError(
      "The build path leads outside the source through a link. Pick a folder inside the repository.",
    );
  }
  if (!(await isDirectory(folder))) {
    throw new BuildError(
      `The build path ${params.buildPath || "/"} doesn't exist in the source. Check the build path.`,
    );
  }
  const detection = await detect(folder);
  const notes: string[] = [];
  const automatic = params.builder.type === "automatic";
  let builder = automatic ? automaticBuilder(detection) : params.builder.type;
  // A monorepo app that needs its sibling packages builds from the repository root (R2-04).
  const workspace =
    automatic && builder !== "dockerfile"
      ? await workspacePlan(sourceRoot, relative(sourceRoot, folder))
      : null;
  if (workspace) {
    builder = "nixpacks";
    context.out(
      `Automatic build: ${workspace.folder} depends on other packages of this repository (${workspace.dependencies.join(", ")}). Building from the repository root with Nixpacks: installing with ${workspace.packageManager}, building ${workspace.turbo ? "through Turborepo" : "those packages first"}, then starting ${workspace.folder}.\n`,
    );
  } else if (automatic) {
    const why =
      builder === "dockerfile"
        ? `found ${detection.dockerfile}`
        : detection.framework
          ? `detected ${detection.framework}`
          : detection.language
            ? `detected ${detection.language}, no known framework`
            : "no known language";
    context.out(
      `Automatic build: using ${builder === "dockerfile" ? "the Dockerfile" : builder} (${why})\n`,
    );
  }
  if (builder !== "heroku" && builder !== "paketo") await requireBuildx(context);

  const values = buildValues(params);
  if (values.toolLeftOut.length > 0 && builder !== "dockerfile") {
    context.out(
      `${values.toolLeftOut.join(", ")} ${values.toolLeftOut.length === 1 ? "isn't" : "aren't"} given to the build: names like these steer the build tools and the server, not the app. A Dockerfile build can still mount ${values.toolLeftOut.length === 1 ? "it" : "them"} as a build secret.\n`,
    );
  }
  if (builder === "dockerfile" && Object.keys(values.secret).length > 0) {
    context.out(
      "Variables reach the Dockerfile as build secrets: RUN --mount=type=secret,id=NAME reads one from /run/secrets/NAME. Public ones like NEXT_PUBLIC_… are also build arguments.\n",
    );
  }
  const secretFiles = await SecretFiles.write(context.folder, values.secret);
  const inputs: BuildInputs = { values, secretFiles: secretFiles.files };
  const monorepoParams: BuildParams | null = workspace
    ? {
        ...params,
        commands: {
          install: params.commands.install || workspace.commands.install,
          build: params.commands.build || workspace.commands.build,
          start: params.commands.start || workspace.commands.start,
        },
      }
    : null;

  const attemptOnce = async (choice: string) => {
    switch (choice) {
      case "dockerfile": {
        const settings =
          params.builder.type === "dockerfile"
            ? params.builder
            : { dockerfilePath: detection.dockerfile ?? "Dockerfile", contextPath: "", stage: "" };
        await buildDockerfile(params, sourceRoot, folder, settings, context, inputs);
        return;
      }
      case "railpack":
        await buildRailpack(
          params,
          folder,
          params.builder.type === "railpack" ? params.builder.version : "0.43.0",
          context,
          inputs,
        );
        return;
      case "nixpacks":
        await buildNixpacks(
          monorepoParams ?? params,
          monorepoParams ? sourceRoot : folder,
          params.builder.type === "nixpacks" ? params.builder.publishDirectory : "",
          context,
          inputs,
        );
        return;
      case "heroku":
        await buildBuildpacks(
          params,
          sourceRoot,
          folder,
          BUILDER_OVERRIDES.heroku ??
            (HEROKU_BUILDERS[
              params.builder.type === "heroku" ? params.builder.stack : "24"
            ] as string),
          context,
          notes,
          inputs,
        );
        return;
      case "paketo":
        await buildBuildpacks(
          params,
          sourceRoot,
          folder,
          BUILDER_OVERRIDES.paketo ?? PAKETO_BUILDER,
          context,
          notes,
          inputs,
        );
        return;
      case "static":
        await buildStatic(
          params,
          folder,
          context,
          params.builder.type === "static" && params.builder.spa,
          inputs,
        );
        return;
    }
  };
  // A failure that looks like a passing network problem is tried again (R2-08).
  const attempt = async (choice: string) => {
    for (let next = 2; ; next++) {
      try {
        await attemptOnce(choice);
        return;
      } catch (error) {
        if (
          !(error instanceof BuildError) ||
          !error.transient ||
          next > MAX_ATTEMPTS ||
          context.signal.aborted
        ) {
          throw error;
        }
        context.out(
          `\n${error.message} It looks like a passing network or registry problem; ${retryWords(next)}.\n`,
        );
        await pause(retryDelaySeconds(next), context.signal);
      }
    }
  };

  try {
    try {
      await attempt(builder);
    } catch (error) {
      // Automatic mode: a Railpack plan that can't be made goes on with Nixpacks (R2-08).
      if (
        !(automatic && builder === "railpack" && error instanceof PlanError) ||
        context.signal.aborted
      ) {
        throw error;
      }
      context.out("Railpack plan was not usable before compilation. Continuing with Nixpacks.\n");
      notes.push("Railpack couldn't plan this build, so Nixpacks built it.");
      builder = "nixpacks";
      await attempt(builder);
    }
  } catch (error) {
    // A language build that fails falls back to a Dockerfile in the repository (spec 6.4).
    const fallback =
      automatic &&
      (builder === "railpack" || builder === "nixpacks") &&
      !context.signal.aborted &&
      folder !== sourceRoot &&
      (await findDockerfile(sourceRoot));
    if (!fallback) {
      await secretFiles.remove();
      throw error;
    }
    context.out(
      `\nThe ${builder} build failed: ${(error as Error).message}\nBuilding with the repository's ${fallback} instead.\n`,
    );
    notes.push(`The ${builder} build failed, so the repository's ${fallback} was used.`);
    builder = "dockerfile";
    try {
      await buildDockerfile(
        params,
        sourceRoot,
        sourceRoot,
        { dockerfilePath: fallback, contextPath: "", stage: "" },
        context,
        inputs,
      );
    } finally {
      await secretFiles.remove();
    }
  }
  await secretFiles.remove();
  // Every image the runner builds is Nearzero's, so uninstall finds it (spec 3.3), whichever
  // builder made it: Railpack's frontend and the buildpacks leave the labels off.
  if (context.signal.aborted) throw new BuildError("The build was cancelled.");
  await ensureLabelled(
    { env: context.env, workDirectory: context.folder, signal: context.signal, out: context.out },
    params.tags,
    params.labels,
  ).catch((error: unknown) => {
    throw new BuildError((error as Error).message);
  });
  return {
    image: params.tags[0] as string,
    builder,
    framework: detection.framework,
    language: detection.language,
    notes,
    exposedPorts: await exposedPortsOf(context, params.tags[0] as string),
  };
}

/** The ports an image declares, from `docker image inspect`; none when it can't be read. */
async function exposedPortsOf(context: BuildContext, image: string): Promise<string[]> {
  const result = await runCommand({
    argv: ["docker", "image", "inspect", "--format", "{{json .Config.ExposedPorts}}", image],
    env: context.env,
    timeoutMs: 30_000,
    signal: context.signal,
  });
  if (result.exitCode !== 0) return [];
  try {
    const parsed = JSON.parse(result.output.trim().split("\n").at(-1) ?? "null") as Record<
      string,
      unknown
    > | null;
    return Object.keys(parsed ?? {});
  } catch {
    return [];
  }
}
