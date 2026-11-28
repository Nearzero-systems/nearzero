import { readFile, stat } from "node:fs/promises";
import { runCommand } from "../exec/command.ts";

/**
 * Who a task on a remote server runs as (30c R3-28; spec 30 "Decisions, part 2", 12.2, 12.3):
 * the user the server was set up with, in that user's home folder, with that user's HOME, USER,
 * LOGNAME and SHELL. Setup writes the user into the runner's settings as NEARZERO_SERVER_USER;
 * on a server set up before that, the owner of the router's folder is the setup user (setup
 * gives it that folder, spec 9.3 step 9). A server set up as root runs tasks as root in /root.
 */

export interface TaskUser {
  name: string;
  uid: number;
  gid: number;
  /** Supplementary groups (the docker group, for one), the primary group included. */
  groups: number[];
  home: string;
  /** The user's login shell, for SHELL. */
  shell: string;
}

/** The PATH tasks get, as on a login shell: /usr/local/bin and /usr/local/sbin first. */
export const TASK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

interface PasswdEntry {
  name: string;
  uid: number;
  gid: number;
  home: string;
  shell: string;
}

export function parsePasswd(text: string): PasswdEntry[] {
  const entries: PasswdEntry[] = [];
  for (const line of text.split("\n")) {
    const fields = line.split(":");
    if (fields.length < 7 || line.startsWith("#")) continue;
    const [name, , uid, gid, , home, shell] = fields as [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) continue;
    entries.push({ name, uid: Number(uid), gid: Number(gid), home, shell: shell.trim() });
  }
  return entries;
}

/** Group ids whose member list names the user (the /etc/group fallback for `id -G`). */
export function groupsFromFile(text: string, user: string): number[] {
  const ids: number[] = [];
  for (const line of text.split("\n")) {
    const [, , gid, members = ""] = line.split(":");
    if (!gid || !/^\d+$/.test(gid)) continue;
    if (
      members
        .split(",")
        .map((member) => member.trim())
        .includes(user)
    )
      ids.push(Number(gid));
  }
  return ids;
}

/** How the runner reads the system's user database; tests give their own. */
export interface UserDatabase {
  /** `getent passwd <key>` (a name or uid), or null when getent isn't there or doesn't know it. */
  getent(key: string): Promise<string | null>;
  /** `id -G <name>`, or null when it fails. */
  groupIds(name: string): Promise<string | null>;
  readFile(path: string): Promise<string | null>;
  ownerUid(path: string): Promise<number | null>;
}

async function run(argv: string[]): Promise<string | null> {
  try {
    const result = await runCommand({ argv, timeoutMs: 10_000 });
    return result.exitCode === 0 ? result.output : null;
  } catch {
    return null;
  }
}

export const systemUsers: UserDatabase = {
  getent: (key) => run(["getent", "passwd", key]),
  groupIds: (name) => run(["id", "-G", name]),
  readFile: (path) => readFile(path, "utf8").catch(() => null),
  ownerUid: async (path) => (await stat(path).catch(() => null))?.uid ?? null,
};

async function passwdEntry(db: UserDatabase, key: string): Promise<PasswdEntry | null> {
  const viaGetent = await db.getent(key);
  const fromGetent = viaGetent ? parsePasswd(viaGetent)[0] : undefined;
  if (fromGetent) return fromGetent;
  const file = parsePasswd((await db.readFile("/etc/passwd")) ?? "");
  return (
    file.find((entry) => entry.name === key) ??
    (/^\d+$/.test(key) ? file.find((entry) => entry.uid === Number(key)) : undefined) ??
    null
  );
}

export class TaskUserError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskUserError";
  }
}

/**
 * The user tasks on this server run as. `env` is the runner's settings (its environment);
 * `currentUid` is the runner's own: a runner that isn't root can only run tasks as itself.
 */
export async function resolveTaskUser(
  env: Record<string, string | undefined>,
  options: { db?: UserDatabase; currentUid?: number } = {},
): Promise<TaskUser> {
  const db = options.db ?? systemUsers;
  const currentUid = options.currentUid ?? process.getuid?.() ?? 0;
  let key: string;
  if (currentUid !== 0) {
    key = String(currentUid);
  } else {
    const set = env.NEARZERO_SERVER_USER?.trim();
    if (set) key = set;
    else {
      const owner = await db.ownerUid(env.NEARZERO_ROUTER_DIR?.trim() || "/etc/nearzero/router");
      key = owner === null ? "root" : String(owner);
    }
  }
  const entry = await passwdEntry(db, key);
  if (!entry) {
    throw new TaskUserError(
      `The user "${key}" this server was set up with doesn't exist on it, so the task can't run as that user. Run setup again.`,
    );
  }
  const listed = await db.groupIds(entry.name);
  let groups = (listed ?? "")
    .trim()
    .split(/\s+/)
    .filter((id) => /^\d+$/.test(id))
    .map(Number);
  if (listed === null || groups.length === 0) {
    groups = groupsFromFile((await db.readFile("/etc/group")) ?? "", entry.name);
  }
  if (!groups.includes(entry.gid)) groups.unshift(entry.gid);
  return {
    name: entry.name,
    uid: entry.uid,
    gid: entry.gid,
    groups: [...new Set(groups)],
    home: entry.home || "/",
    shell: entry.shell || "/bin/sh",
  };
}

/** The environment a task runs with as the user: its own variables, never the runner's. */
export function taskEnvironment(
  user: TaskUser,
  extra: Record<string, string>,
): Record<string, string> {
  return {
    PATH: TASK_PATH,
    HOME: user.home,
    USER: user.name,
    LOGNAME: user.name,
    SHELL: user.shell,
    LANG: "C.UTF-8",
    ...extra,
  };
}

let cached: { at: number; user: Promise<TaskUser> } | null = null;

/** The server's task user, looked up at most once a minute. */
export function serverTaskUser(): Promise<TaskUser> {
  if (cached && Date.now() - cached.at < 60_000) return cached.user;
  const user = resolveTaskUser(process.env);
  cached = { at: Date.now(), user };
  user.catch(() => {
    if (cached?.user === user) cached = null;
  });
  return user;
}
