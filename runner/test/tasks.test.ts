import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearFile, readPiece, trimToNewest } from "../src/access-log/file.ts";
import { hostHelperConfig } from "../src/tasks/host-helper.ts";
import { shellLaunch, startShell } from "../src/tasks/process.ts";
import { parseRunAs, runAsArguments } from "../src/tasks/run-as.ts";
import {
  resolveTaskUser,
  type TaskUser,
  TaskUserError,
  type UserDatabase,
} from "../src/tasks/user.ts";

/** Task processes (spec 12.3) and the request log file (spec 13.1) on the runner. */

function collect() {
  const chunks: Uint8Array[] = [];
  return {
    onOutput: (bytes: Uint8Array) => chunks.push(bytes),
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

describe("a task's shell on the server", () => {
  test("runs the script as one argument, with standard input closed", async () => {
    const out = collect();
    const shell = startShell({
      shell: "sh",
      script: 'echo "it\'s $NZ_X"; read line || echo no-input; exit 3',
      env: { NZ_X: "quoted" },
      timeoutMs: 10_000,
      onOutput: out.onOutput,
    });
    const outcome = await shell.done;
    expect(outcome).toEqual({ exitCode: 3, timedOut: false, stopped: false, error: null });
    expect(out.text()).toBe("it's quoted\nno-input\n");
  });

  test("the syntax check reads without running", async () => {
    const out = collect();
    const shell = startShell({
      shell: "sh",
      flags: ["-n"],
      script: "echo ran\nif true; then\necho x\n",
      env: {},
      timeoutMs: 10_000,
      onOutput: out.onOutput,
    });
    const outcome = await shell.done;
    expect(outcome.exitCode).not.toBe(0);
    expect(out.text()).not.toContain("ran");
  });

  test("Stop reaches what the script started, not just the shell", async () => {
    const out = collect();
    const started = Date.now();
    const shell = startShell({
      shell: "sh",
      script: "sleep 30 & sleep 30; echo never",
      env: {},
      timeoutMs: 60_000,
      onOutput: out.onOutput,
    });
    await Bun.sleep(300);
    shell.stop();
    const outcome = await shell.done;
    expect(outcome.stopped).toBe(true);
    expect(outcome.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(out.text()).not.toContain("never");
  });

  test("a timeout stops it", async () => {
    const shell = startShell({
      shell: "sh",
      script: "sleep 20",
      env: {},
      timeoutMs: 300,
      onOutput: () => {},
    });
    const outcome = await shell.done;
    expect(outcome.timedOut).toBe(true);
  });

  test("a missing shell says so", async () => {
    const shell = startShell({
      shell: "definitely-not-a-shell" as "sh",
      script: "echo",
      env: {},
      timeoutMs: 1_000,
      onOutput: () => {},
    });
    expect((await shell.done).error).toContain("isn't installed");
  });
});

describe("tasks on the Nearzero host (B2-03)", () => {
  test("the nsenter helper runs as root, whatever user the runner's image runs as", () => {
    const config = hostHelperConfig("ghcr.io/nearzero-systems/nearzero:1.0.0", {
      runId: "run-1",
      shell: "/bin/sh",
      flags: [],
      script: "id -u",
    });
    expect(config.User).toBe("0:0");
    expect(config.Entrypoint).toEqual(["nsenter"]);
    expect(config.HostConfig).toMatchObject({ Privileged: true, PidMode: "host" });
  });

  test("R3-28: they run as root from /root, as before", () => {
    const config = hostHelperConfig("ghcr.io/nearzero-systems/nearzero:1.0.0", {
      runId: "run-1",
      shell: "bash",
      flags: [],
      script: "pwd",
    });
    const cmd = config.Cmd as string[];
    expect(cmd.slice(0, cmd.indexOf("--"))).toContain("-w/root");
    expect(config.Env).toContain("HOME=/root");
  });
});

/** A system's user database as the test says. */
function users(options: {
  passwd: string;
  group?: string;
  idG?: Record<string, string>;
  getent?: boolean;
  owner?: number | null;
}): UserDatabase {
  return {
    async getent(key) {
      if (options.getent === false) return null;
      const line = options.passwd
        .split("\n")
        .find((entry) => entry.split(":")[0] === key || entry.split(":")[2] === key);
      return line ? `${line}\n` : null;
    },
    async groupIds(name) {
      return options.idG?.[name] ?? null;
    },
    async readFile(path) {
      if (path === "/etc/passwd") return options.passwd;
      if (path === "/etc/group") return options.group ?? null;
      return null;
    },
    async ownerUid() {
      return options.owner ?? null;
    },
  };
}

const PASSWD = [
  "root:x:0:0:root:/root:/bin/bash",
  "ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash",
  "deploy:x:1001:1001::/home/deploy:/bin/sh",
].join("\n");

describe("R3-28: a server's tasks run as the user it was set up with", () => {
  test("the setting names the user; its groups come from the system (docker included)", async () => {
    const user = await resolveTaskUser(
      { NEARZERO_SERVER_USER: "ubuntu" },
      { db: users({ passwd: PASSWD, idG: { ubuntu: "1000 4 27 999\n" } }), currentUid: 0 },
    );
    expect(user).toEqual({
      name: "ubuntu",
      uid: 1000,
      gid: 1000,
      groups: [1000, 4, 27, 999],
      home: "/home/ubuntu",
      shell: "/bin/bash",
    });
  });

  test("set up before the setting: the router folder's owner; without one, root", async () => {
    const before = await resolveTaskUser(
      {},
      { db: users({ passwd: PASSWD, owner: 1001, getent: false }), currentUid: 0 },
    );
    expect(before.name).toBe("deploy");
    // Without `id`, /etc/group gives the groups.
    const fromFile = await resolveTaskUser(
      { NEARZERO_SERVER_USER: "deploy" },
      {
        db: users({ passwd: PASSWD, group: "docker:x:999:ubuntu,deploy\nadm:x:4:ubuntu" }),
        currentUid: 0,
      },
    );
    expect(fromFile.groups).toEqual([1001, 999]);
    const root = await resolveTaskUser({}, { db: users({ passwd: PASSWD }), currentUid: 0 });
    expect(root).toMatchObject({ name: "root", uid: 0, home: "/root" });
  });

  test("a user that is gone says so; a runner that isn't root runs tasks as itself", async () => {
    await expect(
      resolveTaskUser(
        { NEARZERO_SERVER_USER: "nobody-here" },
        { db: users({ passwd: PASSWD }), currentUid: 0 },
      ),
    ).rejects.toBeInstanceOf(TaskUserError);
    const self = await resolveTaskUser(
      { NEARZERO_SERVER_USER: "ubuntu" },
      { db: users({ passwd: PASSWD }), currentUid: 1001 },
    );
    expect(self.name).toBe("deploy");
  });

  test("as another user it goes through run-as, with the user's home and variables", () => {
    const ubuntu: TaskUser = {
      name: "ubuntu",
      uid: 1000,
      gid: 1000,
      groups: [1000, 999],
      home: "/home/ubuntu",
      shell: "/bin/bash",
    };
    const launch = shellLaunch(
      {
        shell: "bash",
        flags: ["-n"],
        script: "id -un; pwd",
        env: { NEARZERO_TASK_RUN: "r" },
        user: ubuntu,
      },
      0,
      ["/usr/local/bin/nearzero-runner"],
    );
    expect(launch.argv).toEqual([
      "/usr/local/bin/nearzero-runner",
      "run-as",
      "--uid",
      "1000",
      "--gid",
      "1000",
      "--groups",
      "1000,999",
      "--cwd",
      "/home/ubuntu",
      "--",
      "bash",
      "-n",
      "-c",
      "id -un; pwd",
    ]);
    expect(launch.env).toMatchObject({
      HOME: "/home/ubuntu",
      USER: "ubuntu",
      LOGNAME: "ubuntu",
      SHELL: "/bin/bash",
      NEARZERO_TASK_RUN: "r",
    });
    expect(launch.env.PATH?.split(":")).toEqual(
      expect.arrayContaining(["/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/bin"]),
    );
    expect(parseRunAs(launch.argv.slice(2))).toEqual({
      uid: 1000,
      gid: 1000,
      groups: [1000, 999],
      cwd: "/home/ubuntu",
      argv: ["bash", "-n", "-c", "id -un; pwd"],
    });
    // Without a user (the old way) it ran from "/" as the runner.
    expect(shellLaunch({ shell: "bash", script: "pwd", env: {} }).cwd).toBe("/");
  });

  test("as the runner's own user (root as root) it runs directly in the user's home", async () => {
    const home = await mkdtemp(join(tmpdir(), "nz-home-"));
    try {
      const me: TaskUser = {
        name: "me",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        groups: [],
        home,
        shell: "/bin/sh",
      };
      const launch = shellLaunch({ shell: "sh", script: "pwd", env: {}, user: me });
      expect(launch.argv).toEqual(["sh", "-c", "pwd"]);
      expect(launch.cwd).toBe(home);
      const out = collect();
      const shell = startShell({
        shell: "sh",
        script: 'pwd; echo "$HOME $USER $LOGNAME $SHELL"',
        env: {},
        timeoutMs: 10_000,
        onOutput: out.onOutput,
        user: me,
      });
      expect((await shell.done).exitCode).toBe(0);
      expect(out.text().split("\n")[0]).toBeOneOf([home, realpathSync(home)]);
      expect(out.text()).toContain(`${home} me me /bin/sh`);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("run-as runs the script in the home folder with its variables, passes its exit code, and Stop reaches it all", async () => {
    const home = await mkdtemp(join(tmpdir(), "nz-home-"));
    try {
      const me: TaskUser = {
        name: "me",
        uid: process.getuid?.() ?? 0,
        gid: process.getgid?.() ?? 0,
        groups: [process.getgid?.() ?? 0],
        home,
        shell: "/bin/sh",
      };
      // A runner that is the user already would run it directly; -1 makes it go through run-as.
      const via = (script: string) =>
        shellLaunch({ shell: "sh", script, env: { NZ_X: "y" }, user: me }, -1);
      expect(via("pwd").argv).toContain("run-as");
      const out = collect();
      const ran = startShell(
        { shell: "sh", script: "", env: {}, timeoutMs: 20_000, onOutput: out.onOutput },
        via('cd . && pwd -P; echo "$HOME $USER $NZ_X"; exit 7'),
      );
      const outcome = await ran.done;
      expect(outcome.exitCode).toBe(7);
      expect(out.text()).toBe(`${realpathSync(home)}\n${home} me y\n`);

      const started = Date.now();
      const long = startShell(
        { shell: "sh", script: "", env: {}, timeoutMs: 60_000, onOutput: () => {} },
        via("sleep 37 & sleep 37; echo never"),
      );
      await Bun.sleep(1_500);
      long.stop();
      const stopped = await long.done;
      expect(stopped.stopped).toBe(true);
      expect(Date.now() - started).toBeLessThan(10_000);
      // Nothing it started is left running.
      const left = await Bun.$`pgrep -f "sleep 37"`.nothrow().text();
      expect(left.trim()).toBe("");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 30_000);

  test("run-as refuses what it can't read", () => {
    expect(
      parseRunAs(["--uid", "x", "--gid", "1", "--groups", "", "--cwd", "/", "--", "sh"]),
    ).toEqual({
      error: "run-as needs a numeric --uid, --gid and --groups.",
    });
    expect(parseRunAs(["--uid", "1", "--gid", "1"])).toEqual({
      error: "run-as needs -- and a program.",
    });
    expect(runAsArguments({ uid: 0, gid: 0, groups: [], cwd: "/root", argv: ["sh"] })).toEqual([
      "run-as",
      "--uid",
      "0",
      "--gid",
      "0",
      "--groups",
      "",
      "--cwd",
      "/root",
      "--",
      "sh",
    ]);
  });
});

describe("the request log file", () => {
  async function folder() {
    return mkdtemp(join(tmpdir(), "nz-m10-access-"));
  }
  const lines = (count: number, from = 0) =>
    Array.from({ length: count }, (_, index) => `{"n":${from + index}}\n`).join("");

  test("reads whole lines from an offset, in pieces", async () => {
    const dir = await folder();
    const path = join(dir, "access.log");
    await writeFile(path, `${lines(3)}{"partial":`);
    const first = await readPiece(path, 0, 1024, 1024);
    expect(first.exists).toBe(true);
    expect(Buffer.from(first.data, "base64").toString()).toBe(lines(3));
    expect(first.end).toBe(lines(3).length);
    const nothingNew = await readPiece(path, first.end, 1024, 1024);
    expect(nothingNew.end).toBe(nothingNew.start);
    const small = await readPiece(path, 0, 12, 1024);
    expect(Buffer.from(small.data, "base64").toString()).toBe('{"n":0}\n');
    await rm(dir, { recursive: true });
  });

  test("a first read starts at most tailBytes from the end, at a line start", async () => {
    const dir = await folder();
    const path = join(dir, "access.log");
    await writeFile(path, lines(100));
    const piece = await readPiece(path, null, 1024 * 1024, 50);
    const text = Buffer.from(piece.data, "base64").toString();
    expect(text.startsWith("{")).toBe(true);
    expect(text.endsWith('{"n":99}\n')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(50);
    await rm(dir, { recursive: true });
  });

  test("a missing file is no log yet", async () => {
    expect((await readPiece("/nonexistent/nz/access.log", null, 10, 10)).exists).toBe(false);
  });

  test("cleanup keeps the newest lines; delete all empties it", async () => {
    const dir = await folder();
    const path = join(dir, "access.log");
    await writeFile(path, lines(25));
    const trimmed = await trimToNewest(path, 10);
    expect(trimmed.kept).toBe(10);
    expect(await readFile(path, "utf8")).toBe(lines(10, 15));
    expect((await trimToNewest(path, 10)).removedBytes).toBe(0);
    await clearFile(path);
    expect(await readFile(path, "utf8")).toBe("");
    await rm(dir, { recursive: true });
  });
});

describe("the router's request log setting (spec 13.1)", () => {
  test("on: JSON, unbuffered, into access-log/ of the router folder; off: none; the fingerprint follows", async () => {
    const { Router } = await import("../src/router/router.ts");
    const dir = await mkdtemp(join(tmpdir(), "nz-m10-router-"));
    const router = new Router(
      {} as never,
      {
        directory: dir,
        hostDirectory: "/opt/nearzero/router",
        image: "traefik:v3.7.18",
        acmeEmail: "",
        httpPort: 80,
        httpsPort: 443,
        network: "nearzero-edge",
      },
      { debug() {}, info() {}, warn() {}, error() {} } as never,
    );
    const off = await router.desiredContainer();
    expect(JSON.stringify(off.config)).not.toContain("accesslog");
    router.accessLogEnabled = true;
    const on = await router.desiredContainer();
    const command = (on.config as { Cmd: string[] }).Cmd;
    expect(command).toContain("--accesslog=true");
    expect(command).toContain("--accesslog.format=json");
    expect(command).toContain("--accesslog.bufferingsize=0");
    expect(command).toContain("--accesslog.filepath=/var/log/nearzero-router/access.log");
    const binds = (on.config as { HostConfig: { Binds: string[] } }).HostConfig.Binds;
    expect(binds).toContain("/opt/nearzero/router/access-log:/var/log/nearzero-router");
    expect(on.fingerprint).not.toBe(off.fingerprint);
    await rm(dir, { recursive: true });
  });
});
