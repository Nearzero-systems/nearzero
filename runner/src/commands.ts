import { mkdir } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import {
  type CommandKind,
  isBuildToolName,
  NEARZERO_LABELS,
  type ParsedCommandParams,
  type RunnerError,
  type RunnerErrorCode,
} from "@nearzero/shared";
import { accessLogHandlers } from "./access-log/handlers.ts";
import { backupHandlers } from "./backups/handlers.ts";
import { BuildError, buildApp, pruneRailpackCache } from "./builds/build.ts";
import { labelledCopy } from "./builds/own-image.ts";
import { PULLED_IMAGES_FILE } from "./builds/pulled-images.ts";
import { MissingToolError, requireGit } from "./builds/tools.ts";
import {
  looksTransient,
  MAX_ATTEMPTS,
  pause,
  retryDelaySeconds,
  retryWords,
} from "./builds/transient.ts";
import { removeTree } from "./compose/folder.ts";
import { composeHandlers } from "./compose/handlers.ts";
import { type DockerClient, DockerError, DockerUnavailableError } from "./docker/client.ts";
import { demuxDockerStream } from "./docker/demux.ts";
import { createTar, type TarEntry } from "./docker/tar.ts";
import { domainHandlers } from "./domains/handlers.ts";
import { redact, runCommand } from "./exec/command.ts";
import { firewallHandlers } from "./firewall/handlers.ts";
import type { Log } from "./log.ts";
import { systemInfo } from "./metrics.ts";
import { migrationHandlers } from "./migration/handlers.ts";
import type { Router } from "./router/router.ts";
import { type ControlFetch, fetchArchive } from "./sources/archive.ts";
import { fetchRepository, GitError } from "./sources/git.ts";
import { ArchiveError } from "./sources/zip.ts";
import { LineChunker } from "./streams/buffer.ts";
import type { RunnerStream } from "./streams/stream.ts";
import { taskHandlers } from "./tasks/handlers.ts";

/**
 * What the runner does for each command (docs/runner-protocol.md lists them). Handlers get
 * checked parameters, a signal that aborts when the control plane cancels or the command times
 * out, and for streaming commands the stream their output goes to.
 */

export class CommandError extends Error {
  readonly code: RunnerErrorCode;
  constructor(code: RunnerErrorCode, message: string) {
    super(message);
    this.name = "CommandError";
    this.code = code;
  }
}

export interface CommandContext {
  docker: DockerClient;
  router: Router;
  log: Log;
  workDirectory: string;
  dockerSocket: string;
  containerized: boolean;
  /** Where the pinned builder tools live (runner/tools/pins.ts). */
  buildersDir: string;
  /** A request to the control plane with this runner's credential (uploaded archives). */
  controlFetch: ControlFetch;
  signal: AbortSignal;
  stream: RunnerStream | null;
}

type Handler<K extends CommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

/** Nearzero's own containers the runner never stops, removes or opens a shell in. */
const PROTECTED_COMPONENTS = new Set(["control", "database", "runner", "dns"]);

async function guardReserved(docker: DockerClient, id: string, action: string): Promise<void> {
  const details = await docker.inspectContainer(id);
  const component = details.Config.Labels?.[NEARZERO_LABELS.component];
  if (component && PROTECTED_COMPONENTS.has(component)) {
    throw new CommandError(
      "conflict",
      `That container is part of Nearzero itself, so the runner won't ${action} it.`,
    );
  }
}

function requireStream(context: CommandContext): RunnerStream {
  if (!context.stream) throw new CommandError("invalid", "This command needs a stream id.");
  return context.stream;
}

/** Docker CLIs (compose, buildx) get the same socket the runner uses. */
function dockerEnv(context: CommandContext, extra: Record<string, string> = {}) {
  return { DOCKER_HOST: `unix://${context.dockerSocket}`, ...extra };
}

/** A service's own folder in the work folder: its source, known hosts and build scratch. */
function appFolder(context: CommandContext, appKey: string): string {
  return join(context.workDirectory, "apps", appKey);
}

/**
 * The environment builder tools run with: Docker's socket, and a home folder of their own
 * inside the work folder (the host's runner has a read-only root filesystem).
 */
function builderEnv(context: CommandContext): Record<string, string> {
  const home = join(context.workDirectory, "home");
  return {
    DOCKER_HOST: `unix://${context.dockerSocket}`,
    HOME: home,
    DOCKER_CONFIG: join(home, ".docker"),
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  };
}

/** Puts files into a created container, making missing parent folders (root-owned, 0755). */
async function putFiles(
  docker: DockerClient,
  id: string,
  files: { path: string; content: string; mode: number; uid: number; gid: number }[],
): Promise<void> {
  for (const file of files) {
    const path = posix.normalize(file.path);
    if (!path.startsWith("/") || path.split("/").includes("..") || path === "/") {
      throw new CommandError("invalid", `${file.path} isn't a file path inside the container.`);
    }
    // The deepest folder that already exists; the rest are made by the archive.
    let base = posix.dirname(path);
    const missing: string[] = [];
    while (base !== "/" && !(await docker.containerPathExists(id, base))) {
      missing.unshift(posix.basename(base));
      base = posix.dirname(base);
    }
    const entries: TarEntry[] = [];
    for (let index = 0; index < missing.length; index++) {
      entries.push({
        path: missing.slice(0, index + 1).join("/"),
        type: "directory",
        mode: 0o755,
        uid: 0,
        gid: 0,
      });
    }
    entries.push({
      path: [...missing, posix.basename(path)].join("/"),
      type: "file",
      content: new Uint8Array(Buffer.from(file.content, "base64")),
      mode: file.mode,
      uid: file.uid,
      gid: file.gid,
    });
    await docker.putArchive(id, base, createTar(entries));
  }
}

function insideWorkDirectory(context: CommandContext, path: string): string {
  const full = resolve(context.workDirectory, path);
  if (full !== context.workDirectory && !full.startsWith(`${context.workDirectory}/`)) {
    throw new CommandError("invalid", "The build folder must be inside the runner's work folder.");
  }
  return full;
}

async function pipeText(
  source: AsyncIterable<Uint8Array>,
  stream: RunnerStream,
  signal: AbortSignal,
): Promise<void> {
  const chunker = new LineChunker((bytes) => stream.write(bytes));
  try {
    for await (const chunk of source) {
      if (signal.aborted) break;
      chunker.push(chunk);
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    chunker.flush();
  }
}

const handlers: { [K in CommandKind]: Handler<K> } = {
  "system.info": async (_params, context) => systemInfo(context.docker, context.containerized),

  "image.pull": async (params, context) => {
    const stream = requireStream(context);
    let lastPercent = -1;
    let lastAt = 0;
    // The control plane's log already says "Pulling <image>" (spec 6.5: one line, not two), and
    // the meter's percentage never goes down, so the lines below only ever count up.
    const existedBefore = params.ownTag
      ? await context.docker.imageExists(params.image).catch(() => true)
      : true;
    // A registry that answers 503 or a connection that drops for a moment is tried again (R2-08).
    for (let next = 2; ; next++) {
      try {
        await context.docker.pullImage(params.image, {
          ...(params.platform ? { platform: params.platform } : {}),
          ...(params.registryAuth ? { registryAuth: params.registryAuth } : {}),
          signal: context.signal,
          onProgress: (progress) => {
            if (progress.line) stream.text(`${progress.line}\n`);
            const now = Date.now();
            if (progress.percent > lastPercent && now - lastAt >= 1000) {
              lastPercent = progress.percent;
              lastAt = now;
              stream.text(`Downloading ${params.image}: ${progress.percent}%\n`);
            }
          },
        });
        break;
      } catch (error) {
        const message = (error as Error)?.message ?? String(error);
        if (context.signal.aborted || next > MAX_ATTEMPTS || !looksTransient(message)) throw error;
        stream.text(
          `Pulling ${params.image} failed: ${message.trim()} It looks like a passing network or registry problem; ${retryWords(next)}.\n`,
        );
        await pause(retryDelaySeconds(next), context.signal);
      }
    }
    stream.text(`Pulled ${params.image}\n`);
    // The ports the image declares, for the service port when nobody set one (R2-01).
    const exposedPorts = await context.docker.imageExposedPorts(params.image).catch(() => []);
    if (!params.ownTag) return { image: params.image, exposedPorts };
    await labelledCopy(
      {
        env: builderEnv(context),
        workDirectory: context.workDirectory,
        signal: context.signal,
        out: (text) => stream.text(text),
      },
      params.image,
      params.ownTag,
      params.labels,
    ).catch((error: unknown) => {
      throw new CommandError("failed", (error as Error).message);
    });
    if (!existedBefore) await context.docker.removeImage(params.image).catch(() => {});
    return { image: params.ownTag, exposedPorts };
  },

  "image.build": async (params, context) => {
    const stream = requireStream(context);
    const directory = insideWorkDirectory(context, params.contextDirectory);
    const argv = ["docker", "buildx", "build", "--progress=plain", "--load"];
    if (params.dockerfile) argv.push("--file", insideWorkDirectory(context, params.dockerfile));
    for (const tag of params.tags) argv.push("--tag", tag);
    // Values reach buildx through its environment, never its command line (spec 23.4); names
    // that would steer buildx or the system itself are refused.
    for (const key of Object.keys(params.buildArgs)) {
      if (isBuildToolName(key)) {
        throw new CommandError("invalid", `${key} can't be a build argument here.`);
      }
      argv.push("--build-arg", key);
    }
    for (const [key, value] of Object.entries({
      ...params.labels,
      [NEARZERO_LABELS.managed]: "true",
    })) {
      argv.push("--label", `${key}=${value}`);
    }
    argv.push(directory);
    const result = await runCommand({
      argv,
      cwd: directory,
      env: dockerEnv(context, { ...params.buildArgs, DOCKER_BUILDKIT: "1" }),
      timeoutMs: 60 * 60_000,
      secrets: params.secrets,
      signal: context.signal,
      onOutput: (text) => stream.text(text),
    });
    if (result.timedOut)
      throw new CommandError("timeout", "The build ran for more than an hour and was stopped.");
    if (result.exitCode !== 0) {
      throw new CommandError(
        "failed",
        `The build failed (exit code ${result.exitCode ?? "none"}).`,
      );
    }
    return { tags: params.tags };
  },

  "image.remove": async (params, context) => {
    await context.docker.removeImage(params.image, params.force);
    return {};
  },

  "container.create": async (params, context) => {
    const exposed: Record<string, object> = {};
    const bindings: Record<string, { HostPort: string; HostIp?: string }[]> = {};
    for (const port of params.ports) {
      const key = `${port.containerPort}/${port.protocol}`;
      exposed[key] = {};
      const binding = {
        HostPort: String(port.hostPort),
        ...(port.hostIp ? { HostIp: port.hostIp } : {}),
      };
      bindings[key] = [...(bindings[key] ?? []), binding];
    }
    const config: Record<string, unknown> = {
      Image: params.image,
      Env: Object.entries(params.env).map(([key, value]) => `${key}=${value}`),
      Labels: { ...params.labels, [NEARZERO_LABELS.managed]: "true" },
      Tty: params.tty,
      ExposedPorts: exposed,
      HostConfig: {
        RestartPolicy: { Name: params.restartPolicy },
        PortBindings: bindings,
        Mounts: params.mounts.map((mount) => ({
          Type: mount.type,
          Source: mount.source,
          Target: mount.target,
          ReadOnly: mount.readOnly,
        })),
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "5" } },
      },
      ...(params.command ? { Cmd: params.command } : {}),
      ...(params.entrypoint ? { Entrypoint: params.entrypoint } : {}),
      ...(params.workingDir ? { WorkingDir: params.workingDir } : {}),
      ...(params.user ? { User: params.user } : {}),
      ...(params.network
        ? {
            NetworkingConfig: {
              EndpointsConfig: {
                [params.network]: params.networkAliases.length
                  ? { Aliases: params.networkAliases }
                  : {},
              },
            },
          }
        : {}),
    };
    const id = await context.docker.createContainer(params.name, {
      ...config,
      ...(params.stopTimeoutSeconds === undefined
        ? {}
        : { StopTimeout: params.stopTimeoutSeconds }),
    });
    if (params.files.length > 0) {
      try {
        await putFiles(context.docker, id, params.files);
      } catch (error) {
        await context.docker.removeContainer(id, { force: true }).catch(() => {});
        throw error;
      }
    }
    return { id };
  },

  "container.start": async (params, context) => {
    await context.docker.startContainer(params.id);
    return {};
  },

  "container.stop": async (params, context) => {
    await guardReserved(context.docker, params.id, "stop");
    await context.docker.stopContainer(params.id, params.timeoutSeconds);
    return {};
  },

  "container.remove": async (params, context) => {
    await guardReserved(context.docker, params.id, "remove");
    // With its anonymous volumes, always; named ones never (spec 29.5).
    await context.docker.removeContainer(params.id, { force: params.force });
    return {};
  },

  "container.inspect": async (params, context) => {
    const details = await context.docker.inspectContainer(params.id);
    return {
      id: details.Id,
      name: details.Name.replace(/^\//, ""),
      image: details.Config.Image,
      state: details.State.Status,
      running: details.State.Running,
      exitCode: details.State.ExitCode,
      startedAt: details.State.StartedAt,
      finishedAt: details.State.FinishedAt ?? null,
      oomKilled: details.State.OOMKilled ?? false,
      restartCount: details.RestartCount ?? 0,
      health: details.State.Health?.Status ?? null,
      labels: details.Config.Labels ?? {},
      tty: details.Config.Tty,
      networks: Object.keys(details.NetworkSettings.Networks ?? {}),
    };
  },

  "container.wait": async (params, context) => {
    const result = await context.docker.waitContainer(params.id, params.condition, context.signal);
    return { exitCode: result.StatusCode };
  },

  "container.list": async (params, context) => {
    const list = await context.docker.listContainers({ all: params.all, labels: params.labels });
    return list.map((item) => ({
      id: item.Id,
      name: (item.Names[0] ?? "").replace(/^\//, ""),
      image: item.Image,
      state: item.State,
      status: item.Status,
      labels: item.Labels ?? {},
      createdAt: item.Created,
    }));
  },

  "container.logs": async (params, context) => {
    const stream = requireStream(context);
    const source = await context.docker.logs(params.id, {
      follow: params.follow,
      tail: params.tail,
      timestamps: params.timestamps,
      signal: context.signal,
      ...(params.since === undefined ? {} : { since: params.since }),
    });
    await pipeText(source, stream, context.signal);
    return {};
  },

  "container.exec": async (params, context) => {
    const stream = requireStream(context);
    await guardReserved(context.docker, params.id, "open a shell in");
    const execId = await context.docker.createExec(params.id, {
      command: params.command,
      tty: params.tty,
      env: params.env,
      ...(params.user ? { user: params.user } : {}),
      ...(params.workingDir ? { workingDir: params.workingDir } : {}),
    });
    const connection = await context.docker.startExec(execId, params.tty);
    stream.onInput = (bytes) => connection.write(bytes);
    stream.onResize = (cols, rows) => {
      void context.docker.resizeExec(execId, cols, rows).catch(() => {});
    };
    stream.onClose(() => connection.close());
    context.signal.addEventListener("abort", () => connection.close(), { once: true });
    if (params.tty)
      await context.docker.resizeExec(execId, params.cols, params.rows).catch(() => {});
    const output = params.tty ? connection.output : demuxDockerStream(connection.output);
    for await (const chunk of output) stream.write(chunk);
    const finished = await context.docker.inspectExec(execId).catch(() => null);
    return { exitCode: finished?.ExitCode ?? null };
  },

  "container.exec-capture": async (params, context) => {
    await guardReserved(context.docker, params.id, "run a command in");
    const execId = await context.docker.createExec(params.id, {
      command: params.command,
      tty: false,
      env: params.env,
      ...(params.user ? { user: params.user } : {}),
    });
    const connection = await context.docker.startExec(execId, false);
    const timer = setTimeout(() => connection.close(), params.timeoutSeconds * 1000);
    const onAbort = () => connection.close();
    context.signal.addEventListener("abort", onAbort, { once: true });
    const decoder = new TextDecoder();
    let output = "";
    try {
      for await (const chunk of demuxDockerStream(connection.output)) {
        output = (output + decoder.decode(chunk, { stream: true })).slice(-64 * 1024);
      }
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
      connection.close();
    }
    const finished = await context.docker.inspectExec(execId).catch(() => null);
    return {
      exitCode: finished?.ExitCode ?? null,
      output: redact(output, params.secrets),
    };
  },

  "image.list": async (params, context) => {
    const images = await context.docker.listImages({
      labels: params.labels,
      reference: params.reference,
    });
    return images.map((image) => ({
      id: image.Id,
      tags: image.RepoTags ?? [],
      labels: image.Labels ?? {},
      size: image.Size,
    }));
  },

  "source.git": async (params, context) => {
    const stream = requireStream(context);
    const env = builderEnv(context);
    await requireGit({
      buildersDir: context.buildersDir,
      containerized: context.containerized,
      env,
      signal: context.signal,
    });
    const folder = appFolder(context, params.appKey);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    return fetchRepository(
      {
        url: params.url,
        branch: params.branch,
        ...(params.commit ? { commit: params.commit } : {}),
        ...(params.tag ? { tag: params.tag } : {}),
        ...(params.sshPrivateKey ? { sshPrivateKey: params.sshPrivateKey } : {}),
        ...(params.httpAuth ? { httpAuth: params.httpAuth } : {}),
        submodules: params.submodules,
      },
      {
        folder,
        home: env.HOME as string,
        signal: context.signal,
        onOutput: (text) => stream.text(text),
      },
    );
  },

  "source.archive": async (params, context) => {
    const stream = requireStream(context);
    const folder = appFolder(context, params.appKey);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const result = await fetchArchive(
      { uploadId: params.uploadId, sha256: params.sha256, sizeBytes: params.sizeBytes },
      folder,
      context.controlFetch,
      context.signal,
      (text) => stream.text(text),
    );
    return { files: result.files, bytes: result.bytes, strippedFolder: result.strippedFolder };
  },

  "app.build": async (params, context) => {
    const stream = requireStream(context);
    const folder = appFolder(context, params.appKey);
    const env = builderEnv(context);
    await mkdir(env.HOME as string, { recursive: true, mode: 0o700 });
    return buildApp(params, {
      folder,
      buildersDir: context.buildersDir,
      containerized: context.containerized,
      env,
      signal: context.signal,
      out: (text) => stream.text(text),
      pulledImagesFile: join(context.workDirectory, PULLED_IMAGES_FILE),
    });
  },

  "workdir.remove": async (params, context) => {
    // A container may have taken over parts of these folders through bind mounts (B2-06).
    await removeTree(context.docker, context.containerized, appFolder(context, params.appKey));
    await removeTree(
      context.docker,
      context.containerized,
      join(context.workDirectory, "compose", params.appKey),
    );
    return {};
  },

  "network.ensure": async (params, context) => {
    await context.router.ensureNetwork(params.name, params.labels);
    return {};
  },

  "network.connect": async (params, context) => {
    try {
      await context.docker.connectNetwork(params.network, params.container, params.aliases);
    } catch (error) {
      // Already connected is what was asked for.
      if (!(error instanceof DockerError && /already exists/i.test(error.message))) throw error;
    }
    return {};
  },

  "network.remove": async (params, context) => {
    await context.docker.removeNetwork(params.name);
    return {};
  },

  "volume.create": async (params, context) => {
    await context.docker.createVolume(params.name, {
      ...params.labels,
      [NEARZERO_LABELS.managed]: "true",
    });
    return {};
  },

  "volume.remove": async (params, context) => {
    await context.docker.removeVolume(params.name, params.force);
    return {};
  },

  "volume.list": async (params, context) => context.docker.listVolumes(params.labels),

  "system.prune": async (params, context) => {
    const images = await context.docker.pruneImages(params.images === "unused");
    const cache = params.buildCache
      ? await context.docker.pruneBuildCache()
      : { SpaceReclaimed: 0 };
    // Railpack's BuildKit builder keeps its cache in a volume of its own (R3-04).
    const railpack = params.buildCache
      ? await pruneRailpackCache(builderEnv(context), context.signal)
      : 0;
    return {
      reclaimedBytes: (images.SpaceReclaimed ?? 0) + (cache.SpaceReclaimed ?? 0) + railpack,
    };
  },

  "compose.up": async (params, context) => {
    const stream = requireStream(context);
    const directory = join(context.workDirectory, "compose", params.project);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const argv = [
      "docker",
      "compose",
      "--project-name",
      params.project,
      "--project-directory",
      directory,
    ];
    for (const file of params.files) {
      await Bun.write(join(directory, file.name), file.content);
      argv.push("--file", join(directory, file.name));
    }
    argv.push(
      "up",
      "--detach",
      ...(params.removeOrphans ? ["--remove-orphans"] : []),
      "--no-color",
    );
    const result = await runCommand({
      argv,
      cwd: directory,
      env: dockerEnv(context, params.env),
      timeoutMs: 60 * 60_000,
      secrets: [...params.secrets, ...Object.values(params.env)],
      signal: context.signal,
      onOutput: (text) => stream.text(text),
    });
    if (result.exitCode !== 0) {
      throw new CommandError(
        "failed",
        `docker compose up failed (exit code ${result.exitCode ?? "none"}).`,
      );
    }
    return {};
  },

  "compose.down": async (params, context) => {
    const stream = requireStream(context);
    const directory = join(context.workDirectory, "compose", params.project);
    // The anonymous volumes of 1.0's own containers in the project go with them (spec 29.5);
    // Compose's down keeps them unless told to remove named volumes too. A moved stack shares its
    // project name with 0.1.x's, whose containers aren't 1.0's and aren't looked at.
    const ours = await context.docker.listContainers({
      all: true,
      labels: [`com.docker.compose.project=${params.project}`, `${NEARZERO_LABELS.edition}=1`],
    });
    const anonymous = (
      await Promise.all(ours.map((item) => context.docker.anonymousVolumesOf(item.Id)))
    ).flat();
    const argv = [
      "docker",
      "compose",
      "--project-name",
      params.project,
      "down",
      // Never while a moved stack shares its project name with 0.1.x's copy (spec 29.5).
      ...(params.removeOrphans ? ["--remove-orphans"] : []),
    ];
    if (params.volumes) argv.push("--volumes");
    const result = await runCommand({
      argv,
      env: dockerEnv(context),
      timeoutMs: 10 * 60_000,
      signal: context.signal,
      onOutput: (text) => stream.text(text),
    });
    if (result.exitCode !== 0) {
      throw new CommandError(
        "failed",
        `docker compose down failed (exit code ${result.exitCode ?? "none"}).`,
      );
    }
    for (const volume of anonymous) {
      await context.docker.removeVolume(volume).catch(() => {});
    }
    await removeTree(context.docker, context.containerized, directory, context.signal);
    return {};
  },

  "router.write": async (params, context) => context.router.write(params.routes),
  "router.remove": async (params, context) => context.router.remove(params.keys),
  "router.sync": async (params, context) => context.router.sync(params.routes),
  // The folder's files, and the router's main settings read-only beside them (R3-23).
  "router.files": async (_params, context) => ({
    files: await context.router.files.list(),
    mainSettings: await context.router.mainSettings().catch(() => null),
  }),
  "router.file-write": async (params, context) => {
    try {
      return await context.router.files.writeOwn(params.name, params.contents);
    } catch (error) {
      throw new CommandError("invalid", (error as Error).message);
    }
  },
  // The control plane's 5-minute check brings the server's public IPv4 as it is now (R3-10).
  "router.check-holds": async (params, context) => {
    const changed =
      params.publicIPv4 !== undefined
        ? context.router.setPublicIPv4(params.publicIPv4, { lookupFailed: params.lookupFailed })
        : false;
    return context.router.checkHolds({ addressChanged: changed });
  },
  "router.ensure": async (_params, context) => {
    await context.router.ensure();
    return context.router.state();
  },
  // Certificates and the built-in DNS server (spec 10.7, 10.8).
  ...domainHandlers,
  // Backups and restores (spec 08 8.3, 17).
  ...backupHandlers,
  // Tasks and the router's request log (spec 12, 13).
  ...taskHandlers,
  ...accessLogHandlers,
  // Compose stacks (spec 07).
  ...composeHandlers,
  // Moving a 0.1.x install to 1.0 (spec 29.5).
  ...migrationHandlers,
  // Published ports in a remote server's host firewall (30b R2-13).
  ...firewallHandlers,
};

export function handlerFor<K extends CommandKind>(kind: K): Handler<K> {
  return handlers[kind];
}

/** Turns anything a handler threw into the protocol's error, in plain words. */
export function toRunnerError(error: unknown, signal: AbortSignal): RunnerError {
  if (error instanceof CommandError) return { code: error.code, message: error.message };
  if (signal.aborted && (error instanceof BuildError || error instanceof GitError)) {
    return { code: "cancelled", message: "The command was cancelled." };
  }
  if (
    error instanceof BuildError ||
    error instanceof GitError ||
    error instanceof ArchiveError ||
    error instanceof MissingToolError
  ) {
    return { code: "failed", message: error.message };
  }
  if (error instanceof DockerUnavailableError) {
    return { code: "docker_unavailable", message: error.message };
  }
  if (error instanceof DockerError) {
    if (error.status === 404) return { code: "not_found", message: error.message };
    if (error.status === 409) return { code: "conflict", message: error.message };
    if (error.status === 400) return { code: "invalid", message: error.message };
    return { code: "failed", message: error.message };
  }
  if (signal.aborted) {
    const reason = signal.reason as { code?: RunnerErrorCode } | undefined;
    return reason?.code === "timeout"
      ? { code: "timeout", message: "The command took too long and was stopped." }
      : { code: "cancelled", message: "The command was cancelled." };
  }
  return { code: "failed", message: (error as Error)?.message ?? String(error) };
}
