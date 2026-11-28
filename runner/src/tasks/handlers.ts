import { hostname } from "node:os";
import {
  NEARZERO_LABELS,
  type ParsedCommandParams,
  TASK_RUN_MARKER,
  type TaskCheckAnswer,
  type TaskCommandKind,
  type TaskRunAnswer,
} from "@nearzero/shared";
import { type CommandContext, CommandError } from "../commands.ts";
import type { DockerClient } from "../docker/client.ts";
import { demuxDockerStream } from "../docker/demux.ts";
import type { RunnerStream } from "../streams/stream.ts";
import { hostHelperConfig } from "./host-helper.ts";
import { KILL_AFTER_MS, type ShellOutcome, startShell } from "./process.ts";
import { serverTaskUser, type TaskUser, TaskUserError } from "./user.ts";

/**
 * The runner's task commands (spec 12): `task.check` (the shell reads the script without
 * running it), `task.run` (the script runs and its output streams into the run's log) and
 * `task.stop`. commands.ts adds them to its table.
 *
 * - In a service's container: Docker exec of `<shell> -c <script>`, standard input closed. Every
 *   process of the run carries NEARZERO_TASK_RUN=<run id>, which is how Stop finds them.
 * - On a server: the shell runs as the user the server was set up with, in its home folder
 *   (R3-28), as its own process group, so Stop reaches what it started.
 * - On the Nearzero host, whose runner runs in a container, a short-lived helper container from
 *   the runner's own image enters the host's namespaces (nsenter) and runs the shell there.
 */

type Handler<K extends TaskCommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

const CHECK_TIMEOUT_MS = 30_000;
const CHECK_OUTPUT_BYTES = 8 * 1024;

/** Runs in progress here, by run id, so `task.stop` (or a cancel) can reach them. */
const running = new Map<string, () => Promise<void>>();

function requireStream(context: CommandContext): RunnerStream {
  if (!context.stream) throw new CommandError("invalid", "This command needs a stream id.");
  return context.stream;
}

/** Tasks never run in Nearzero's own containers. */
async function serviceContainer(docker: DockerClient, id: string | undefined): Promise<string> {
  if (!id) throw new CommandError("invalid", "A task in a container needs the container.");
  const details = await docker.findContainer(id);
  if (!details)
    throw new CommandError("not_found", "The service's container isn't on this server any more.");
  if (details.Config.Labels?.[NEARZERO_LABELS.component]) {
    throw new CommandError(
      "conflict",
      "That container is part of Nearzero itself, so tasks can't run in it.",
    );
  }
  if (!details.State.Running) {
    throw new CommandError(
      "conflict",
      "The service's container isn't running. Start it, then try again.",
    );
  }
  return details.Id;
}

// ---- Inside a container

async function execIn(
  docker: DockerClient,
  container: string,
  command: string[],
  env: Record<string, string>,
  onOutput: (bytes: Uint8Array) => void,
  timeoutMs: number,
): Promise<number | null> {
  // Standard input isn't attached at all: a script that reads it gets end-of-file (spec 23.1).
  // (Half-closing an attached stdin instead can make Docker drop the output.)
  const created = await docker.json<{ Id: string }>(
    "POST",
    `/containers/${encodeURIComponent(container)}/exec`,
    {
      body: {
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: command,
        Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      },
    },
  );
  const execId = created.Id;
  const connection = await docker.startExec(execId, false);
  const timer = setTimeout(() => connection.close(), timeoutMs);
  try {
    for await (const chunk of demuxDockerStream(connection.output)) onOutput(chunk);
  } finally {
    clearTimeout(timer);
    connection.close();
  }
  // The output can end a moment before Docker records the exit code.
  for (let attempt = 0; attempt < 50; attempt++) {
    const finished = await docker.inspectExec(execId).catch(() => null);
    if (!finished) return null;
    if (!finished.Running && finished.ExitCode !== null) return finished.ExitCode;
    await Bun.sleep(100);
  }
  return null;
}

/** Signals every process in the container that carries the run's marker. */
const KILLER = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, not a template.
  'for d in /proc/[0-9]*; do pid="${d#/proc/}"; [ "$pid" = "$$" ] && continue;',
  `if tr '\\000' '\\n' < "$d/environ" 2>/dev/null | grep -qx "${TASK_RUN_MARKER}=$1"; then kill -s "$2" "$pid" 2>/dev/null; fi;`,
  "done; exit 0",
].join(" ");

async function signalInContainer(
  docker: DockerClient,
  container: string,
  runId: string,
  signal: "TERM" | "KILL",
): Promise<void> {
  await execIn(docker, container, ["sh", "-c", KILLER, "sh", runId, signal], {}, () => {}, 15_000);
}

async function runInContainer(
  params: ParsedCommandParams<"task.run">,
  context: CommandContext,
  stream: RunnerStream,
): Promise<TaskRunAnswer> {
  const docker = context.docker;
  const container = await serviceContainer(docker, params.container);
  let stopped = false;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await signalInContainer(docker, container, params.runId, "TERM").catch(() => {});
    killTimer = setTimeout(() => {
      void signalInContainer(docker, container, params.runId, "KILL").catch(() => {});
    }, KILL_AFTER_MS);
  };
  running.set(params.runId, stop);
  const timer = setTimeout(() => {
    timedOut = true;
    void stop();
  }, params.timeoutSeconds * 1000);
  try {
    const exitCode = await execIn(
      docker,
      container,
      [params.shell, "-c", params.script],
      { [TASK_RUN_MARKER]: params.runId },
      (bytes) => stream.write(bytes),
      params.timeoutSeconds * 1000 + 60_000,
    );
    return { exitCode: stopped ? null : exitCode, stopped: stopped && !timedOut, timedOut };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    running.delete(params.runId);
  }
}

// ---- On the Nearzero host, through a helper container

let ownImage: string | null = null;

/** The image this runner runs from (its own container's), which has nsenter (BusyBox). */
async function runnerImage(docker: DockerClient): Promise<string> {
  if (ownImage) return ownImage;
  const self = await docker.findContainer(process.env.HOSTNAME ?? hostname()).catch(() => null);
  const image = self?.Image || self?.Config.Image;
  if (!image) {
    throw new CommandError(
      "failed",
      "The runner couldn't find its own container, so it can't reach the host to run this task.",
    );
  }
  ownImage = image;
  return image;
}

interface HostRun {
  done: Promise<ShellOutcome>;
  stop(): Promise<void>;
}

async function startOnHost(
  docker: DockerClient,
  spec: { runId: string; shell: string; flags: string[]; script: string; timeoutMs: number },
  onOutput: (bytes: Uint8Array) => void,
): Promise<HostRun> {
  const image = await runnerImage(docker);
  const name = `nearzero-task-${spec.runId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`;
  const id = await docker.createContainer(name, hostHelperConfig(image, spec));
  let stopped = false;
  let timedOut = false;
  const kill = (signal: string) =>
    docker
      .call("POST", `/containers/${encodeURIComponent(id)}/kill`, { query: { signal } })
      .catch(() => {});
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await kill("SIGTERM");
    setTimeout(() => void kill("SIGKILL"), KILL_AFTER_MS).unref?.();
  };
  const done = (async (): Promise<ShellOutcome> => {
    const timer = setTimeout(() => {
      timedOut = true;
      void stop();
    }, spec.timeoutMs);
    try {
      await docker.startContainer(id);
      const output = await docker.logs(id, { follow: true, tail: "all", timestamps: false });
      for await (const chunk of output) onOutput(chunk);
      const result = await docker.waitContainer(id, "not-running");
      return {
        exitCode: stopped ? null : result.StatusCode,
        timedOut,
        stopped: stopped && !timedOut,
        error: null,
      };
    } finally {
      clearTimeout(timer);
      await docker.removeContainer(id, { force: true }).catch(() => {});
    }
  })();
  return { done, stop };
}

// ---- On a server, as its setup user

async function taskUser(): Promise<TaskUser> {
  try {
    return await serverTaskUser();
  } catch (error) {
    if (error instanceof TaskUserError) throw new CommandError("failed", error.message);
    throw error;
  }
}

// ---- Handlers

export const taskHandlers: { [K in TaskCommandKind]: Handler<K> } = {
  "task.check": async (params, context): Promise<TaskCheckAnswer> => {
    let output = "";
    const collect = (bytes: Uint8Array) => {
      if (output.length < CHECK_OUTPUT_BYTES) {
        output = (output + new TextDecoder().decode(bytes)).slice(0, CHECK_OUTPUT_BYTES);
      }
    };
    let exitCode: number | null;
    if (params.place === "container") {
      const container = await serviceContainer(context.docker, params.container);
      exitCode = await execIn(
        context.docker,
        container,
        [params.shell, "-n", "-c", params.script],
        {},
        collect,
        CHECK_TIMEOUT_MS,
      );
    } else if (context.containerized) {
      const run = await startOnHost(
        context.docker,
        {
          runId: crypto.randomUUID(),
          shell: params.shell,
          flags: ["-n"],
          script: params.script,
          timeoutMs: CHECK_TIMEOUT_MS,
        },
        collect,
      );
      exitCode = (await run.done).exitCode;
    } else {
      const shell = startShell({
        shell: params.shell,
        flags: ["-n"],
        script: params.script,
        env: {},
        timeoutMs: CHECK_TIMEOUT_MS,
        onOutput: collect,
        user: await taskUser(),
      });
      const outcome = await shell.done;
      if (outcome.error) throw new CommandError("failed", outcome.error);
      exitCode = outcome.exitCode;
    }
    return { ok: exitCode === 0, exitCode, output: output.trim() };
  },

  "task.run": async (params, context): Promise<TaskRunAnswer> => {
    const stream = requireStream(context);
    if (running.has(params.runId)) {
      throw new CommandError("conflict", "This run is already going on this server.");
    }
    if (params.place === "container") {
      const stopOnClose = () => void running.get(params.runId)?.();
      stream.onClose(stopOnClose);
      context.signal.addEventListener("abort", stopOnClose, { once: true });
      return runInContainer(params, context, stream);
    }
    const timeoutMs = params.timeoutSeconds * 1000;
    if (context.containerized) {
      const run = await startOnHost(
        context.docker,
        { runId: params.runId, shell: params.shell, flags: [], script: params.script, timeoutMs },
        (bytes) => stream.write(bytes),
      );
      running.set(params.runId, run.stop);
      const stop = () => void run.stop();
      stream.onClose(stop);
      context.signal.addEventListener("abort", stop, { once: true });
      try {
        const outcome = await run.done;
        return { exitCode: outcome.exitCode, stopped: outcome.stopped, timedOut: outcome.timedOut };
      } finally {
        running.delete(params.runId);
      }
    }
    const shell = startShell({
      shell: params.shell,
      script: params.script,
      env: { [TASK_RUN_MARKER]: params.runId },
      timeoutMs,
      onOutput: (bytes) => stream.write(bytes),
      user: await taskUser(),
    });
    running.set(params.runId, async () => shell.stop());
    const stop = () => shell.stop();
    stream.onClose(stop);
    context.signal.addEventListener("abort", stop, { once: true });
    try {
      const outcome = await shell.done;
      if (outcome.error) throw new CommandError("failed", outcome.error);
      return { exitCode: outcome.exitCode, stopped: outcome.stopped, timedOut: outcome.timedOut };
    } finally {
      running.delete(params.runId);
    }
  },

  "task.stop": async (params, context) => {
    const stop = running.get(params.runId);
    if (stop) {
      await stop();
      return { stopped: true };
    }
    // Not running here (any more): a container run might still have processes left.
    if (params.place === "container" && params.container) {
      await signalInContainer(context.docker, params.container, params.runId, "KILL").catch(
        () => {},
      );
    }
    return { stopped: false };
  },
};
