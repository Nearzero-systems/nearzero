import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STEP_PRELUDE } from "../src/server-setup/scripts.ts";

/**
 * C2-06: setup waits for another package job only while one really runs. Ubuntu (and Debian with
 * unattended-upgrades) keeps unattended-upgrade-shutdown waiting all the time, under the process
 * name "unattended-upgr"; it used to make every package install wait the full 5 minutes. A job
 * now counts while it holds a package manager's lock (in /proc/locks) or a package manager runs.
 */

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nz-pkg-wait-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Runs the real prelude with a stand-in ps and /proc/locks, then the script. */
async function prelude(
  script: string,
  options: { processes: string[]; locks?: string },
): Promise<{ code: number; out: string; ms: number }> {
  const lockFile = join(dir, `lock-frontend-${Math.random().toString(36).slice(2)}`);
  await writeFile(lockFile, "");
  const procLocks = join(dir, `proc-locks-${Math.random().toString(36).slice(2)}`);
  const inode = String((await stat(lockFile)).ino);
  await writeFile(procLocks, (options.locks ?? "").replaceAll("INODE", inode));
  const fakePs = `ps() { printf '%s\\n' ${options.processes.map((name) => `'${name}'`).join(" ")}; }`;
  const started = Date.now();
  const child = Bun.spawn(["bash", "-c", `${STEP_PRELUDE}\n${fakePs}\nsleep() { :; }\n${script}`], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NZ_PROC_LOCKS: procLocks,
      NZ_PKG_LOCKS: lockFile,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: out + err, ms: Date.now() - started };
}

describe("waiting for another package job (C2-06)", () => {
  test("Ubuntu's idle unattended-upgrade-shutdown is no job: nothing waits", async () => {
    const run = await prelude(
      'nz_pkg_busy && echo busy || echo free; nz_pkg true && echo "installed"',
      {
        processes: ["systemd", "unattended-upgr", "sshd", "apt.systemd.dai", "packagekitd"],
      },
    );
    expect(run.out).toContain("free");
    expect(run.out).toContain("installed");
    expect(run.out).not.toContain("Another package job is running");
  });

  test("a held package lock is a job, whatever runs; so is a package manager at work", async () => {
    // As dpkg holds it (POSIX), and as a waiter shows it ("->" shifts the fields).
    for (const locks of [
      "1: POSIX  ADVISORY  WRITE 4242 fd:01:INODE 0 EOF\n",
      "1: FLOCK  ADVISORY  WRITE 4242 00:2c:999 0 EOF\n1: -> POSIX  ADVISORY  WRITE 4243 00:2c:INODE 0 EOF\n",
    ]) {
      const run = await prelude("nz_pkg_busy && echo busy || echo free", {
        processes: ["systemd", "unattended-upgr"],
        locks,
      });
      expect(run.out).toContain("busy");
    }
    const other = await prelude("nz_pkg_busy && echo busy || echo free", {
      processes: ["systemd"],
      locks: "1: POSIX  ADVISORY  WRITE 4242 fd:01:12345678 0 EOF\n",
    });
    expect(other.out).toContain("free");
    for (const manager of ["apt-get", "dpkg", "dnf", "zypper", "pacman", "apk"]) {
      const run = await prelude("nz_pkg_busy && echo busy || echo free", {
        processes: ["systemd", manager],
      });
      expect(run.out).toContain("busy");
    }
  });

  test("a real job still makes the install wait, with the note, then go on", async () => {
    const run = await prelude('nz_pkg true && echo "installed"', {
      processes: ["systemd", "dpkg"],
    });
    expect(run.out).toContain("Another package job is running");
    expect(run.out).toContain("installed");
  });
});

describe("a kernel replaced by a full upgrade (C2-22, Arch)", () => {
  async function gone(folders: string[]): Promise<string> {
    const root = await mkdtemp(join(dir, "root-"));
    for (const folder of folders) await Bun.$`mkdir -p ${join(root, folder)}`.quiet();
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        `${STEP_PRELUDE}\nuname() { echo 6.10.3-arch1-1; }\nnz_kernel_modules_gone && echo gone || echo fine`,
      ],
      { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NZ_ROOT: root }, stdout: "pipe" },
    );
    return (await new Response(child.stdout).text()).trim();
  }

  test("the running kernel's modules gone with a newer one installed means a reboot", async () => {
    expect(await gone(["usr/lib/modules/6.12.1-arch1-1"])).toBe("gone");
    expect(await gone(["usr/lib/modules/6.12.1-arch1-1", "usr/lib/modules/6.10.3-arch1-1"])).toBe(
      "fine",
    );
    // A container: no modules at all for the host's kernel, and nothing to reboot into.
    expect(await gone([])).toBe("fine");
    expect(await gone(["usr/lib/modules"])).toBe("fine");
  });

  test("asking leaves no step-failure line behind (the step's ERR trap reads every failure)", async () => {
    const child = Bun.spawn(
      [
        "bash",
        "-c",
        `${STEP_PRELUDE}\nps() { printf 'bash\\n'; }\nif nz_kernel_modules_gone; then echo gone; fi\nnz_pkg_busy || echo free`,
      ],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NZ_ROOT: dir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(out).toBe("free\n");
    expect(err).not.toContain("::nz-failed::");
  });

  test("setup stops with the reboot, not a bare timeout, when Docker can't start then", async () => {
    const { dockerScript } = await import("../src/server-setup/scripts.ts");
    const script = dockerScript({
      facts: {
        family: "arch",
        init: "systemd",
        arch: "x86_64",
        libc: "glibc",
      },
    } as unknown as Parameters<typeof dockerScript>[0]);
    expect(script).toContain("nz_kernel_modules_gone");
    expect(script).toContain(
      "Docker can't start until this server reboots: the package upgrade installed a new kernel",
    );
    expect(script).toContain("Reboot the server, then run setup again.");
  });
});
