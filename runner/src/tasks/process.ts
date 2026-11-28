import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { runAsArguments, selfCommand } from "./run-as.ts";
import { type TaskUser, taskEnvironment } from "./user.ts";

/**
 * A task's script as a process on this server (spec 12). It follows the command runner's rules
 * (exec/command.ts): the program and its arguments as an array, no shell of the runner's own,
 * standard input closed, a timeout, and a small environment that never includes the runner's.
 * Unlike the command runner it starts the shell in a process group of its own, so Stop (and a
 * timeout) reach everything the script started, not just the shell.
 */

/** How long a run gets to stop after TERM before everything it started is killed. */
export const KILL_AFTER_MS = 5_000;

export interface ShellSpec {
  shell: "bash" | "sh";
  /** Extra arguments before `-c` (the syntax check passes `-n`). */
  flags?: string[];
  script: string;
  env: Record<string, string>;
  timeoutMs: number;
  onOutput: (bytes: Uint8Array) => void;
  /**
   * Run as this user, in its home folder, with its HOME, USER, LOGNAME and SHELL (R3-28). Without
   * it the shell runs as the runner, from "/".
   */
  user?: TaskUser;
}

export interface ShellOutcome {
  exitCode: number | null;
  timedOut: boolean;
  stopped: boolean;
  /** Set when the shell couldn't start (not installed). */
  error: string | null;
}

export interface ShellProcess {
  done: Promise<ShellOutcome>;
  /** TERM to the whole group, KILL after 5 seconds. */
  stop(): void;
}

function environment(extra: Record<string, string>): Record<string, string> {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME && process.env.HOME !== "" ? process.env.HOME : "/root",
    LANG: "C.UTF-8",
    ...extra,
  };
}

export interface ShellLaunch {
  argv: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * How the shell starts (R3-28): as the runner from "/" without a user; as the user in its home
 * folder when the runner already is that user (root on a server set up as root); otherwise
 * through the runner's own `run-as`, which takes the user's groups, group and user first.
 */
export function shellLaunch(
  spec: Pick<ShellSpec, "shell" | "flags" | "script" | "env" | "user">,
  currentUid: number | undefined = process.getuid?.(),
  self: readonly string[] = selfCommand(),
): ShellLaunch {
  const program = [spec.shell, ...(spec.flags ?? []), "-c", spec.script];
  const user = spec.user;
  if (!user) return { argv: program, env: environment(spec.env), cwd: "/" };
  const env = taskEnvironment(user, spec.env);
  const home = existsSync(user.home) ? user.home : "/";
  if (user.uid === currentUid) return { argv: program, env, cwd: home };
  return {
    argv: [
      ...self,
      ...runAsArguments({
        uid: user.uid,
        gid: user.gid,
        groups: user.groups,
        cwd: user.home,
        argv: program,
      }),
    ],
    env,
    cwd: "/",
  };
}

/** Starts the shell; `launch` is how (tests give their own to go through run-as). */
export function startShell(spec: ShellSpec, launch: ShellLaunch = shellLaunch(spec)): ShellProcess {
  let stopped = false;
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | null = null;
  // A missing shell is said plainly, also when run-as would be the one to find out.
  if (!Bun.which(spec.shell, { PATH: launch.env.PATH ?? "" })) {
    return {
      done: Promise.resolve({
        exitCode: null,
        timedOut: false,
        stopped: false,
        error: `${spec.shell} isn't installed on this server.`,
      }),
      stop() {},
    };
  }
  const [program, ...args] = launch.argv as [string, ...string[]];
  const child = spawn(program, args, {
    cwd: launch.cwd,
    env: launch.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone.
      }
    }
  };
  const terminate = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    signalGroup("SIGTERM");
    killTimer ??= setTimeout(() => signalGroup("SIGKILL"), KILL_AFTER_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, spec.timeoutMs);
  child.stdout?.on("data", (chunk: Buffer) => spec.onOutput(new Uint8Array(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => spec.onOutput(new Uint8Array(chunk)));
  const done = new Promise<ShellOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: ShellOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A stopped run's leftovers in its group go too; a run that ended by itself keeps what
      // it started on purpose (nohup … &).
      if (stopped || timedOut) signalGroup("SIGKILL");
      if (killTimer) clearTimeout(killTimer);
      resolve(outcome);
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        exitCode: null,
        timedOut: false,
        stopped: false,
        error:
          error.code === "ENOENT"
            ? `${spec.shell} isn't installed on this server.`
            : `${spec.shell} couldn't start: ${error.message}`,
      });
    });
    child.on("close", (code) => {
      finish({
        exitCode: stopped || timedOut ? null : code,
        timedOut,
        stopped,
        error: null,
      });
    });
  });
  return {
    done,
    stop() {
      stopped = true;
      terminate();
    },
  };
}
