import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type ComposeCommandKind,
  type ComposeContainer,
  type ComposeDeployed,
  type ComposePrepared,
  type ComposeStage,
  NEARZERO_LABELS,
  type ParsedCommandParams,
  SERVICE_FOLDER_VARIABLE,
} from "@nearzero/shared";
import type { CommandContext } from "../commands.ts";
import { DockerError } from "../docker/client.ts";
import { runCommand } from "../exec/command.ts";
import type { RunnerStream } from "../streams/stream.ts";
import {
  checkBindPath,
  engineView,
  readInside,
  realFolders,
  stackFolder,
  syncRepository,
  writeInside,
} from "./folder.ts";

/**
 * The runner's handlers for Compose stacks (spec 07; docs/api/compose.md). `compose.deploy` runs
 * Docker Compose in steps (validate, pull, build, up), so a file Compose refuses, an image that
 * can't be pulled or a build that fails never touches the running stack. commands.ts adds these
 * handlers to its table.
 */

type Handler<K extends ComposeCommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

const COMPOSE_FILE_MAX_BYTES = 1024 * 1024;
const COMPOSE_PROJECT = "com.docker.compose.project";
const COMPOSE_SERVICE = "com.docker.compose.service";
/** Nearzero's own containers the runner never stops, restarts or kills. */
const PROTECTED_COMPONENTS = new Set(["control", "database", "runner", "dns"]);

function composeEnv(context: CommandContext, extra: Record<string, string> = {}) {
  const home = join(context.workDirectory, "home");
  return {
    DOCKER_HOST: `unix://${context.dockerSocket}`,
    HOME: home,
    DOCKER_CONFIG: join(home, ".docker"),
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    BUILDKIT_PROGRESS: "plain",
    ...extra,
  };
}

async function composeVersion(context: CommandContext): Promise<string | null> {
  const result = await runCommand({
    argv: ["docker", "compose", "version", "--short"],
    env: composeEnv(context),
    timeoutMs: 30_000,
    signal: context.signal,
  }).catch(() => null);
  if (result?.exitCode !== 0) return null;
  const version = result.output.trim().split(/\s+/).at(-1)?.replace(/^v/, "") ?? "";
  return /^\d+\.\d+/.test(version) ? version : null;
}

async function guard(context: CommandContext, id: string, action: string): Promise<void> {
  const details = await context.docker.inspectContainer(id);
  const component = details.Config.Labels?.[NEARZERO_LABELS.component];
  if (component && PROTECTED_COMPONENTS.has(component)) {
    throw new Error(`That container is part of Nearzero itself, so the runner won't ${action} it.`);
  }
}

/** NAME=value lines of an env file (comments, blank lines and `export` dropped, quotes taken off). */
function readEnvNames(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = (match[2] as string).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    out[match[1] as string] = value;
  }
  return out;
}

function lastLines(text: string, count = 20): string {
  return text.trim().split("\n").slice(-count).join("\n");
}

async function stackContainers(
  context: CommandContext,
  project: string,
): Promise<ComposeContainer[]> {
  const list = await context.docker.listContainers({
    all: true,
    labels: [`${COMPOSE_PROJECT}=${project}`],
  });
  return list.map((item) => ({
    id: item.Id,
    name: (item.Names[0] ?? "").replace(/^\//, ""),
    service: item.Labels?.[COMPOSE_SERVICE] ?? "",
    state: item.State,
  }));
}

/**
 * Joins the stack's routed containers to the private network with their <prefix>-<service>
 * alias (30b R2-11): only the inner services hostnames go to, so a database or cache inside a
 * stack stays reachable from that stack alone, never from every app on the server.
 */
export async function connectAll(
  context: CommandContext,
  containers: ComposeContainer[],
  network: { name: string; aliasPrefix: string; services?: string[] | undefined },
  stream: RunnerStream,
): Promise<string[]> {
  const notConnected: string[] = [];
  const wanted = network.services ? new Set(network.services) : null;
  containers = containers.filter((container) => !wanted || wanted.has(container.service));
  for (const container of containers) {
    const details = await context.docker.inspectContainer(container.id);
    const mode = (details.HostConfig as { NetworkMode?: string }).NetworkMode ?? "";
    if (
      mode === "host" ||
      mode === "none" ||
      mode.startsWith("container:") ||
      mode.startsWith("service:")
    ) {
      notConnected.push(container.service || container.name);
      continue;
    }
    const alias = `${network.aliasPrefix}-${container.service.toLowerCase()}`;
    const existing = details.NetworkSettings.Networks?.[network.name];
    if (existing) {
      if (existing.Aliases?.includes(alias)) continue;
      // Joined by the file itself: join again with Nearzero's alias added.
      await context.docker.call(
        "POST",
        `/networks/${encodeURIComponent(network.name)}/disconnect`,
        {
          body: { Container: container.id, Force: true },
        },
      );
      await context.docker.connectNetwork(network.name, container.id, [
        ...(existing.Aliases ?? []),
        alias,
      ]);
    } else {
      try {
        await context.docker.connectNetwork(network.name, container.id, [alias]);
      } catch (error) {
        if (!(error instanceof DockerError && /already exists/i.test(error.message))) throw error;
      }
    }
  }
  if (containers.length > notConnected.length) {
    stream.text(
      `Joined ${network.name}: ${containers
        .filter((item) => !notConnected.includes(item.service || item.name))
        .map((item) => `${network.aliasPrefix}-${item.service.toLowerCase()}`)
        .join(", ")}\n`,
    );
  }
  return notConnected;
}

/**
 * Compose's `up` for a stack: orphans are removed, except while a moved stack shares its project
 * name with 0.1.x's copy and the move isn't finalized (spec 29.5).
 */
export function composeUpArgs(removeOrphans: boolean): string[] {
  return [
    "up",
    "--detach",
    ...(removeOrphans ? ["--remove-orphans"] : []),
    "--no-build",
    "--pull",
    "missing",
    "--quiet-pull",
  ];
}

export const composeHandlers: { [K in ComposeCommandKind]: Handler<K> } = {
  "compose.prepare": async (params, context): Promise<ComposePrepared> => {
    await mkdir(join(context.workDirectory, "compose"), { recursive: true, mode: 0o700 });
    const folder = stackFolder(context.workDirectory, params.project);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await realFolders(folder, ".nearzero", 0o700);
    const version = await composeVersion(context);
    let composeFile: string | null = null;
    const envFiles: string[] = [];
    const envValues: Record<string, string> = {};
    let skippedLinks: string[] = [];
    let skippedFiles: string[] = [];
    if (params.repository) {
      const source = join(context.workDirectory, "apps", params.repository.appKey, "source");
      const synced = await syncRepository(source, folder).catch((error: Error) => {
        throw new Error(
          `The repository couldn't be copied into the stack's folder: ${error.message}`,
        );
      });
      skippedLinks = synced.skippedLinks;
      skippedFiles = synced.skippedFiles;
      const repo = join(folder, "repo");
      composeFile = await readInside(repo, params.repository.composePath, COMPOSE_FILE_MAX_BYTES);
      const directory = params.repository.composePath.split("/").slice(0, -1).join("/");
      for (const name of params.repository.envFiles) {
        const path = directory ? `${directory}/${name}` : name;
        const text = await readInside(repo, path, COMPOSE_FILE_MAX_BYTES).catch(() => null);
        if (text === null) continue;
        envFiles.push(name);
        Object.assign(envValues, readEnvNames(text));
      }
    }
    return {
      folder,
      hostFolder: await engineView(context.docker, context.containerized, folder),
      composeVersion: version,
      composeFile,
      envFiles,
      envValues,
      skippedLinks,
      skippedFiles,
    };
  },

  "compose.deploy": async (params, context): Promise<ComposeDeployed> => {
    if (!context.stream) throw new Error("This command needs a stream id.");
    const stream = context.stream;
    const folder = stackFolder(context.workDirectory, params.project);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await realFolders(folder, ".nearzero", 0o700);
    const projectDirectory = await realFolders(folder, params.directory);
    await mkdir(join(context.workDirectory, "home", ".docker"), { recursive: true, mode: 0o700 });
    const fail = (stage: ComposeStage, message: string, touched = false): ComposeDeployed => ({
      ok: false,
      stage,
      message,
      touched,
      containers: [],
      notConnected: [],
    });

    const files: string[] = [];
    for (const file of params.files) {
      files.push(await writeInside(folder, `.nearzero/${file.name}`, file.content, 0o600));
    }
    const envPath = await writeInside(folder, ".nearzero/env", params.envFile, 0o600);
    if (params.writeDotEnv) {
      const relativeEnv = params.directory ? `${params.directory}/.env` : ".env";
      await writeInside(folder, relativeEnv, params.envFile, 0o600);
    }
    for (const path of params.bindPaths) {
      const problem = await checkBindPath(folder, path);
      if (problem) return fail("validate", problem);
    }

    const hostFolder = await engineView(context.docker, context.containerized, folder);
    const base = [
      "docker",
      "compose",
      "--ansi",
      "never",
      "--project-name",
      params.project,
      "--project-directory",
      projectDirectory,
    ];
    for (const file of files) base.push("--file", file);
    for (const extra of params.extraEnvFiles)
      base.push("--env-file", join(projectDirectory, extra));
    base.push("--env-file", envPath);
    const env = composeEnv(context, { [SERVICE_FOLDER_VARIABLE]: hostFolder });
    const run = (args: string[], timeoutMs: number) =>
      runCommand({
        argv: [...base, ...args],
        cwd: projectDirectory,
        env,
        timeoutMs,
        secrets: params.secrets,
        signal: context.signal,
        onOutput: (text) => stream.text(text),
      });
    /** "<what>:" and the last lines Compose printed (secrets already cut out). */
    const explain = (what: string, result: Awaited<ReturnType<typeof run>>) => {
      if (result.timedOut) return `${what}: it took too long and was stopped.`;
      const tail = lastLines(result.output, 12);
      return tail ? `${what}:\n${tail}` : `${what} (exit code ${result.exitCode ?? "none"}).`;
    };

    stream.text("Checking the Compose file with Docker Compose\n");
    const validated = await run(["config", "--quiet"], 2 * 60_000);
    if (validated.cancelled) throw new Error("The command was cancelled.");
    if (validated.exitCode !== 0)
      return fail("validate", explain("Docker Compose refused the file", validated));

    if (params.pull) {
      stream.text("Pulling images\n");
      const pulled = await run(["pull", "--ignore-buildable"], 30 * 60_000);
      if (pulled.cancelled) throw new Error("The command was cancelled.");
      if (pulled.exitCode !== 0) return fail("pull", explain("Pulling the images failed", pulled));
    }
    if (params.build) {
      stream.text(`Building images${params.noCache ? ", without cached layers" : ""}\n`);
      const built = await run(["build", ...(params.noCache ? ["--no-cache"] : [])], 60 * 60_000);
      if (built.cancelled) throw new Error("The command was cancelled.");
      if (built.exitCode !== 0) return fail("build", explain("Building the images failed", built));
    }

    stream.text("Starting the stack\n");
    const up = await run(composeUpArgs(params.removeOrphans), 15 * 60_000);
    if (up.cancelled) throw new Error("The command was cancelled.");
    if (up.exitCode !== 0) return fail("up", explain("docker compose up failed", up), true);

    const containers = await stackContainers(context, params.project);
    let notConnected: string[] = [];
    if (params.network) {
      try {
        notConnected = await connectAll(context, containers, params.network, stream);
      } catch (error) {
        return {
          ...fail(
            "connect",
            `The containers couldn't join ${params.network.name}: ${(error as Error).message}`,
            true,
          ),
          containers,
        };
      }
    }
    return { ok: true, stage: null, message: null, touched: true, containers, notConnected };
  },

  "container.restart": async (params, context) => {
    await guard(context, params.id, "restart");
    await context.docker.call("POST", `/containers/${encodeURIComponent(params.id)}/restart`, {
      query: { t: params.timeoutSeconds },
    });
    return {};
  },

  "container.kill": async (params, context) => {
    await guard(context, params.id, "kill");
    await context.docker.call("POST", `/containers/${encodeURIComponent(params.id)}/kill`, {
      query: { signal: params.signal },
    });
    return {};
  },
};
