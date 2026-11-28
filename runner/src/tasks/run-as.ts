import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * `nearzero-runner run-as --uid U --gid G --groups A,B --cwd DIR -- PROGRAM ARGS…`: runs one
 * program as another user (30c R3-28). The runner (root on a server) starts it for a task: it
 * sets the user's supplementary groups, then its group, then its user, and runs the program in
 * the user's home folder with the environment it was given, waiting for it and ending with its
 * exit code. Everything stays in the process group the runner made, so Stop and the timeout
 * reach the program and what it starts.
 *
 * Doing this in the runner's own binary needs no su, runuser or setpriv, whose presence and
 * options differ between Debian, the Red Hat family, Arch, SUSE and Alpine's BusyBox, and no
 * PAM session (su and runuser open one, and its modules can stall or log in a service). Groups
 * come from the system's user database (`id -G`), so the docker group applies as at a login.
 */

export interface RunAsPlan {
  uid: number;
  gid: number;
  groups: number[];
  cwd: string;
  argv: string[];
}

export function runAsArguments(plan: RunAsPlan): string[] {
  return [
    "run-as",
    "--uid",
    String(plan.uid),
    "--gid",
    String(plan.gid),
    "--groups",
    plan.groups.join(","),
    "--cwd",
    plan.cwd,
    "--",
    ...plan.argv,
  ];
}

export function parseRunAs(args: readonly string[]): RunAsPlan | { error: string } {
  const split = args.indexOf("--");
  if (split < 0 || split === args.length - 1) return { error: "run-as needs -- and a program." };
  const options = new Map<string, string>();
  const head = args.slice(0, split);
  for (let index = 0; index < head.length; index += 2) {
    const name = head[index];
    const value = head[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      return { error: `run-as can't read its option ${name ?? ""}.` };
    }
    options.set(name.slice(2), value);
  }
  const number = (name: string) => {
    const value = options.get(name) ?? "";
    return /^\d+$/.test(value) ? Number(value) : null;
  };
  const uid = number("uid");
  const gid = number("gid");
  const groupsText = options.get("groups") ?? "";
  const groups = groupsText === "" ? [] : groupsText.split(",");
  if (uid === null || gid === null || groups.some((group) => !/^\d+$/.test(group))) {
    return { error: "run-as needs a numeric --uid, --gid and --groups." };
  }
  return {
    uid,
    gid,
    groups: groups.map(Number),
    cwd: options.get("cwd") || "/",
    argv: args.slice(split + 1),
  };
}

/** The command line that starts this runner again: its binary, or Bun and main.ts from source. */
export function selfCommand(): string[] {
  if (Bun.main.includes("$bunfs")) return [process.execPath];
  return [process.execPath, fileURLToPath(new URL("../main.ts", import.meta.url))];
}

export async function runAs(args: readonly string[]): Promise<number> {
  const plan = parseRunAs(args);
  if ("error" in plan) {
    console.error(plan.error);
    return 2;
  }
  if (process.getuid?.() === 0) {
    try {
      if (!process.setgroups || !process.setgid || !process.setuid) {
        throw new Error("this system can't switch users");
      }
      process.setgroups(plan.groups.length > 0 ? plan.groups : [plan.gid]);
      process.setgid(plan.gid);
      process.setuid(plan.uid);
    } catch (error) {
      console.error(`The task couldn't switch to user ${plan.uid}: ${(error as Error).message}`);
      return 126;
    }
  } else if (process.getuid?.() !== plan.uid) {
    console.error("Only a runner running as root can run a task as another user.");
    return 126;
  }
  const [program, ...rest] = plan.argv as [string, ...string[]];
  return new Promise<number>((resolve) => {
    const child = spawn(program, rest, {
      cwd: existsSync(plan.cwd) ? plan.cwd : "/",
      env: process.env,
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      console.error(
        error.code === "ENOENT"
          ? `${program} isn't installed on this server.`
          : `${program} couldn't start: ${error.message}`,
      );
      resolve(127);
    });
    child.on("close", (code, signal) => {
      resolve(code ?? 128 + (signal ? (constants.signals[signal] ?? 0) : 0));
    });
  });
}
