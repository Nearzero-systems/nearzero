import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processSpecs } from "../../container/supervise.ts";
import { checksumLine, PATHS, sha256 } from "../scripts/files.ts";
import { releaseFiles } from "../scripts/release.ts";
import { runBash } from "./support/bash.ts";

/** The nearzero command and uninstall.sh without root (spec 03 3.3, 3.4), and the release layout. */

async function run(file: string, args: string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["bash", file, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: out + err };
}

const asRoot = process.getuid?.() === 0;

describe("the nearzero command", () => {
  test("help lists every command, and says update never moves to a newer version", async () => {
    const result = await run(PATHS.command, ["help"]);
    expect(result.code).toBe(0);
    for (const command of [
      "status",
      "logs",
      "audit [--since DATE] [--until DATE]",
      "restart",
      "update",
      "create-owner",
      "reset-password",
      "set-email <old> <new>",
      "reset-2fa",
      "backup-db",
      "restore-db",
      "import [--dry-run] <file>",
      "migrate status",
      "migrate retry",
      "migrate rollback",
      "migrate finalize",
      "runner-link status",
      "runner-link rotate",
      "runner-link switch [--force]",
      "runner-link cancel",
      "help",
    ]) {
      expect(result.out).toContain(`  ${command}`);
    }
    expect(result.out).toContain("It never moves to a");
  });

  test("an unknown command prints usage and exits 1", async () => {
    const result = await run(PATHS.command, ["deploy"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Unknown command: deploy");
    expect(result.out).toContain("Usage: sudo nearzero [command]");
  });

  test("export says it runs on 0.1.x; import and migrate need root (spec 29)", async () => {
    const exported = await run(PATHS.command, ["export"]);
    expect(exported.code).toBe(1);
    expect(exported.out).toContain("This server runs Nearzero 1.0, so there is nothing to export.");
    expect(exported.out).toContain("then run: sudo nearzero import <file>");
    if (!asRoot) {
      for (const command of [
        ["import", "x.nzx"],
        ["migrate", "status"],
        ["migrate", "rollback"],
      ]) {
        const result = await run(PATHS.command, command);
        expect(result.code).toBe(1);
        expect(result.out).toContain(`This command needs root. Run: sudo nearzero ${command[0]}`);
      }
    }
  });

  test.skipIf(asRoot)("commands that touch the install need root", async () => {
    // The audit record export (30d R4-16) reads the control plane's database.
    const audit = await run(PATHS.command, ["audit", "--since", "2026-11-01"]);
    expect(audit.code).toBe(1);
    expect(audit.out).toContain("This command needs root. Run: sudo nearzero audit");
    const status = await run(PATHS.command, []);
    expect(status.code).toBe(1);
    expect(status.out).toContain("This command needs root. Run: sudo nearzero status");
    const owner = await run(PATHS.command, ["create-owner"]);
    expect(owner.out).toContain("Run: sudo nearzero create-owner");
  });
});

describe("nearzero runner-link (C4-10)", () => {
  /** Runs nzc_runner_link with the container and the restart stood in for. */
  async function runnerLink(args: string, controlExit = 0) {
    const source = (await Bun.file(PATHS.command).text()).replace(/\nnzc_main "\$@"\n$/, "\n");
    const stubs = [
      "nzc_running() { return 0; }",
      `nzc_control() { echo "control $*"; return ${controlExit}; }`,
      'nzc_restart() { echo "restarted"; }',
    ].join("\n");
    const run = await runBash(`${source}\n${stubs}\nnzc_runner_link ${args}`, {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    });
    return { code: run.code, out: run.stdout + run.stderr };
  }

  test("each step runs in the control plane's container; a switch that went through restarts it", async () => {
    expect(await runnerLink("rotate")).toEqual({ code: 0, out: "control runner-link rotate\n" });
    expect(await runnerLink("status --json")).toEqual({
      code: 0,
      out: "control runner-link status --json\n",
    });
    expect(await runnerLink("switch")).toEqual({
      code: 0,
      out: "control runner-link switch\nrestarted\n",
    });
    // Refused (a server doesn't hold the new fingerprint yet): nothing restarts.
    expect(await runnerLink("switch", 1)).toEqual({ code: 1, out: "control runner-link switch\n" });
    const unknown = await runnerLink("delete");
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("Unknown runner-link command: delete");
  });

  test.skipIf(asRoot)("it needs root", async () => {
    const result = await run(PATHS.command, ["runner-link", "status"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("This command needs root. Run: sudo nearzero runner-link");
  });
});

describe("nearzero logs with 0.1.x's service names (R4-10)", () => {
  async function logsOf(service: string) {
    const bin = await mkdtemp(join(tmpdir(), "nz1-logs-"));
    await Bun.write(join(bin, "docker"), '#!/bin/sh\necho "docker $*"\n');
    await Bun.$`chmod 0755 ${join(bin, "docker")}`.quiet();
    const source = (await Bun.file(PATHS.command).text()).replace(/\nnzc_main "\$@"\n$/, "\n");
    const run = await runBash(`${source}\nnzc_logs ${service}`, {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
    });
    await rm(bin, { recursive: true, force: true });
    return run.stdout + run.stderr;
  }

  test("platform and console follow the control plane, traefik the router", async () => {
    for (const name of ["platform", "console"]) {
      expect(await logsOf(name)).toMatch(/docker compose .* logs --follow --tail 200 control$/m);
    }
    expect(await logsOf("traefik")).toContain("docker logs --follow --tail 200 nearzero-router");
  });

  test("monitoring and schedules say who does that work now", async () => {
    expect(await logsOf("monitoring")).toBe(
      "The runner collects metrics now; see them with: sudo nearzero logs runner\n",
    );
    expect(await logsOf("schedules")).toBe(
      "The control plane runs schedules now; see them with: sudo nearzero logs control\n",
    );
    expect(await logsOf("nope")).toContain("There's no Nearzero service called nope.");
  });
});

/**
 * Runs one of the nearzero command's account functions with the control plane faked: each call
 * of nzc_control prints its arguments and the lines it was given, so a test sees exactly what
 * reached the control plane. Without a terminal unless `terminal` lines are given.
 */
async function accountCommand(
  call: string,
  input: string,
  options: { adminEmail?: string; owner?: string } = {},
): Promise<string> {
  const source = (await Bun.file(PATHS.command).text()).replace(/\nnzc_main "\$@"\n$/, "\n");
  const fakes = [
    "nzc_require_running() { :; }",
    "nzc_has_terminal() { return 1; }",
    `nzc_value() { [ "$1" = NEARZERO_ADMIN_EMAIL ] && printf '%s' '${options.adminEmail ?? ""}'; }`,
    `nzc_control() {
      if [ "$1" = owner-status ]; then
        ${options.owner === "" ? `printf '{"owner":"missing"}\n'` : `printf '{"owner":"exists","email":"${options.owner ?? "owner@example.com"}"}\n'`}
        return 0
      fi
      printf 'control:'; printf ' [%s]' "$@"; printf '\n'
      while IFS= read -r line; do printf 'line: [%s]\n' "$line"; done
    }`,
  ].join("\n");
  const run = await runBash(`${source}\n${fakes}\n${call}`, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: new Blob([input]),
  });
  return run.stdout + run.stderr;
}

describe("account commands' input lines (31a G1-01, G1-14, spec 03 3.4)", () => {
  test("reset-password reads 0.1.x's two lines: the email, then the password", async () => {
    // printf 'bob@example.com\nNewPass123\n' | sudo nearzero reset-password
    expect(await accountCommand("nzc_reset_password", "bob@example.com\nNewPass123\n")).toBe(
      "control: [reset-password] [bob@example.com]\nline: [NewPass123]\n",
    );
  });

  test("an empty first line means the owner", async () => {
    // printf '\nNewPass123\n' | sudo nearzero reset-password
    expect(await accountCommand("nzc_reset_password", "\nNewPass123\n")).toBe(
      "control: [reset-password]\nline: []\nline: [NewPass123]\n",
    );
  });

  test("with an email argument only the password line is read", async () => {
    // printf 'NewPass123\n' | sudo nearzero reset-password bob@example.com
    expect(await accountCommand("nzc_reset_password bob@example.com", "NewPass123\n")).toBe(
      "control: [reset-password] [bob@example.com]\nline: [NewPass123]\n",
    );
  });

  test("create-owner takes the settings' admin email for an empty first line", async () => {
    const out = await accountCommand("nzc_create_owner", "\nOwnerPass1\n", {
      adminEmail: "admin@corp.example",
      owner: "",
    });
    expect(out).toContain("line: [admin@corp.example]\nline: [OwnerPass1]");
  });

  test("set-email passes both addresses and refuses anything else", async () => {
    expect(await accountCommand("nzc_set_email old@x.example new@x.example", "")).toBe(
      "control: [set-email] [old@x.example] [new@x.example]\n",
    );
    expect(await accountCommand("nzc_set_email old@x.example", "")).toBe(
      "Usage: sudo nearzero set-email <current email> <new email>\n",
    );
  });
});

describe("nearzero logs: several services, Docker's options, the runner's DNS server (G4-23, C2-20)", () => {
  /** nzc_logs (or another function) with a stand-in docker that says what it was asked. */
  async function command(call: string, dns: "runner" | "compose" | "none" = "none") {
    const bin = await mkdtemp(join(tmpdir(), "nz1-logs-"));
    await Bun.write(
      join(bin, "docker"),
      `#!/bin/sh
case "$*" in
  *"com.docker.compose.project"*nearzero1-dns)
    [ "$FAKE_DNS" = runner ] && { echo ""; exit 0; }
    [ "$FAKE_DNS" = compose ] && { echo nearzero1; exit 0; }
    exit 1 ;;
  "inspect --format {{.State.Status}} nearzero1-dns") echo running; exit 0 ;;
  "ps -a --filter name=^nearzero1-dns$ --format {{.Status}}") echo "Up 2 hours"; exit 0 ;;
  "inspect nearzero-router" | "inspect nearzero1-dns") exit 0 ;;
esac
echo "docker $*"
`,
    );
    await Bun.$`chmod 0755 ${join(bin, "docker")}`.quiet();
    const source = (await Bun.file(PATHS.command).text()).replace(/\nnzc_main "\$@"\n$/, "\n");
    const run = await runBash(`${source}\n${call}`, {
      env: { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`, FAKE_DNS: dns },
    });
    await rm(bin, { recursive: true, force: true });
    return { out: run.stdout + run.stderr, code: run.code };
  }

  test("several services are followed together, and --tail, --since and --timestamps are Docker's", async () => {
    expect((await command("nzc_logs control runner")).out).toMatch(
      /docker compose .* logs --follow --tail 200 control runner$/m,
    );
    expect((await command("nzc_logs --tail 50 control")).out).toMatch(
      /docker compose .* logs --follow --tail 50 control$/m,
    );
    expect(
      (await command("nzc_logs --tail 100 platform --since 10m --timestamps postgres")).out,
    ).toMatch(
      /docker compose .* logs --follow --tail 100 --since 10m --timestamps control postgres$/m,
    );
    expect((await command("nzc_logs --tail=all --since=2026-11-28 runner")).out).toMatch(
      /logs --follow --tail all --since 2026-11-28 runner$/m,
    );
    // The router with a compose service: both, the router's lines marked with its name.
    const mixed = await command("nzc_logs control router --tail 5");
    expect(mixed.out).toMatch(/docker compose .* logs --follow --tail 5 control$/m);
    expect(mixed.out).toContain("router   | docker logs --follow --tail 5 nearzero-router");
    const bad = await command("nzc_logs --tail lots control");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain('--tail needs a number of lines, or all; it is "lots".');
    expect((await command("nzc_logs --color control")).out).toContain("logs doesn't know --color.");
  });

  test("C2-20: the DNS server the runner started is followed and listed; compose's still goes to compose", async () => {
    expect((await command("nzc_logs dns", "runner")).out).toContain(
      "docker logs --follow --tail 200 nearzero1-dns",
    );
    expect((await command("nzc_logs dns", "compose")).out).toMatch(
      /docker compose .* logs --follow --tail 200 dns$/m,
    );
    const all = await command("nzc_logs", "runner");
    expect(all.out).toMatch(/docker compose .* logs --follow --tail 200$/m);
    expect(all.out).toContain("router   | docker logs --follow --tail 200 nearzero-router");
    expect(all.out).toContain("dns      | docker logs --follow --tail 200 nearzero1-dns");
    expect((await command("nzc_dns_status", "runner")).out).toBe(
      "dns        running    Up 2 hours (started by the runner for a zone)\n",
    );
    expect((await command("nzc_dns_status", "compose")).out).toBe("");
  });
});

describe("uninstall.sh", () => {
  test.skipIf(asRoot)("runs only as root", async () => {
    const result = await run(PATHS.uninstall, ["--yes"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Run the uninstaller as root:");
  });

  test("refuses unknown options", async () => {
    const result = await run(PATHS.uninstall, ["--force"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("Unknown option: --force");
  });
});

/**
 * The uninstaller's own steps against a pretend server in a temporary folder: its paths point
 * there, and `id`, `docker` and the rest are shell functions the test defines.
 */
async function uninstallWith(
  root: string,
  script: string,
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const source = (await Bun.file(PATHS.uninstall).text()).replace(/\nmain "\$@"\n$/, "\n");
  const paths = `
NZU_DIR=${root}/opt/nearzero
NZU_ETC=${root}/etc/nearzero
NZU_BIN=${root}/usr/local/bin/nearzero
NZU_BIN_LINK=${root}/usr/bin/nearzero
NZU_RUNNER_BIN=${root}/usr/local/bin/nearzero-runner
NZU_RUNNER_STATE_DIR=${root}/var/lib/nearzero-runner
NZU_SETUP_DIR=${root}/var/lib/nearzero
NZU_LIB_DIR=${root}/usr/local/lib/nearzero
NZU_RUNNER_LOG=${root}/var/log/nearzero-runner.log
NZU_RUNNER_PID=${root}/run/nearzero-runner.pid
NZU_KEEP_DIR=${root}/var/backups/nearzero
id() { echo 0; }
`;
  const run = await runBash(`${source}\n${paths}\n${script}`, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    stdin: "ignore",
  });
  return { code: run.code, out: run.stdout + run.stderr };
}

async function pretendServer(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nz1-uninstall-"));
  await Bun.$`mkdir -p ${root}/opt/nearzero ${root}/etc/nearzero/router ${root}/usr/local/bin ${root}/var/lib/nearzero-runner/work ${root}/var/lib/nearzero/setup ${root}/usr/local/lib/nearzero ${root}/var/log ${root}/run`.quiet();
  await Bun.write(join(root, "opt/nearzero/.env"), "NEARZERO_VERSION=1.0.0\nNEARZERO_EDITION=1\n");
  await Bun.write(join(root, "opt/nearzero/nearzero-db-20261127-101500.sql"), "-- dump\n");
  await Bun.write(join(root, "var/lib/nearzero-runner/credential"), "secret");
  await Bun.write(join(root, "var/log/nearzero-runner.log"), "log");
  await Bun.write(join(root, "usr/local/bin/nearzero-runner"), "binary");
  await Bun.write(join(root, "usr/local/bin/nearzero"), "command");
  await Bun.$`mkdir -p ${root}/usr/bin && ln -s ${root}/usr/local/bin/nearzero ${root}/usr/bin/nearzero`.quiet();
  return root;
}

const NO_DOCKER = `nzu_has() { [ "$1" != docker ] && command -v "$1" >/dev/null 2>&1; }`;

describe("uninstall.sh: Compose stacks' networks and Docker's build cache (C2-13, C2-12)", () => {
  /** A stand-in Docker with one Nearzero stack (web), the person's own stack (mine), and cache. */
  const DOCKER = `calls=""
docker() {
  calls="$calls
docker $*"
  case "$*" in
    "info") return 0 ;;
    'ps -a --filter label=dev.nearzero.edition=1 --format {{.Label "com.docker.compose.project"}}') printf 'nearzero1\nweb\n\n' ;;
    'volume ls --filter label=dev.nearzero.edition=1 --format {{.Label "com.docker.compose.project"}}') printf 'web\nnz-db\n' ;;
    "network ls -q --filter label=com.docker.compose.project=web") printf 'net-web-default\nnet-web-back\n' ;;
    "network ls -q --filter label=com.docker.compose.project=nz-db") printf 'net-db\n' ;;
    "network ls -q --filter label=com.docker.compose.project=mine") printf 'net-mine\n' ;;
    "system df --format {{.Type}} {{.Size}}") printf 'Images 2GB\nBuild Cache 3.4GB\n' ;;
  esac
  return 0
}`;

  test("the networks of the stacks Nearzero deployed go; nobody else's", async () => {
    const run = await uninstallWith(
      await pretendServer(),
      `${DOCKER}
nzu_remove_docker_objects
printf '%s\n' "$calls" | grep 'network rm'`,
    );
    expect(run.out).toContain("docker network rm net-web-default net-web-back");
    expect(run.out).toContain("docker network rm net-db");
    expect(run.out).not.toContain("net-mine");
  });

  test("Docker's build cache, which can't be told apart, is named with its size and the command", async () => {
    const run = await uninstallWith(await pretendServer(), `${DOCKER}\nnzu_build_cache_note`);
    expect(run.out).toContain("Docker's build cache (3.4GB) was kept");
    expect(run.out).toContain("  docker builder prune");
    expect(run.out).not.toContain("calls");
    const empty = await uninstallWith(
      await pretendServer(),
      `${DOCKER.replace("Build Cache 3.4GB", "Build Cache 0B")}\nnzu_build_cache_note`,
    );
    expect(empty.out).toBe("");
  });
});

describe("uninstall.sh's steps (spec 03 3.3)", () => {
  test("B2-08: database backups made before uninstalling are kept, and the last lines say where", async () => {
    const root = await pretendServer();
    try {
      const result = await uninstallWith(root, `${NO_DOCKER}\nmain --yes`);
      expect(result.code).toBe(0);
      expect(result.out).toContain("✓ Removed Nearzero");
      expect(result.out).toContain(
        `Your database backups were kept in ${root}/var/backups/nearzero:`,
      );
      expect(result.out).toContain(
        `  ${root}/var/backups/nearzero/nearzero-db-20261127-101500.sql`,
      );
      expect(
        await Bun.file(join(root, "var/backups/nearzero/nearzero-db-20261127-101500.sql")).text(),
      ).toBe("-- dump\n");
      expect((await stat(join(root, "var/backups/nearzero"))).mode & 0o777).toBe(0o700);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("B2-23: a server set up from Nearzero keeps none of its files, credential or log", async () => {
    const root = await pretendServer();
    try {
      expect((await uninstallWith(root, `${NO_DOCKER}\nmain --yes`)).code).toBe(0);
      for (const path of [
        "opt/nearzero",
        "etc/nearzero",
        "var/lib/nearzero-runner",
        "var/lib/nearzero",
        "usr/local/lib/nearzero",
        "var/log/nearzero-runner.log",
        "usr/local/bin/nearzero-runner",
        "usr/local/bin/nearzero",
        "usr/bin/nearzero",
      ]) {
        expect(await Bun.file(join(root, path)).exists()).toBe(false);
        expect((await Bun.$`test -e ${join(root, path)}`.nothrow().quiet()).exitCode).not.toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("B2-12: a runner started without an init system is stopped from its pid file", async () => {
    const root = await pretendServer();
    try {
      const result = await uninstallWith(
        root,
        `${NO_DOCKER}
sleep 300 &
pid=$!
echo "$pid" > "$NZU_RUNNER_PID"
main --yes >/dev/null
sleep 0.2
if kill -0 "$pid" 2>/dev/null; then echo still-running; else echo stopped; fi`,
      );
      expect(result.out).toContain("stopped");
      expect(result.out).not.toContain("still-running");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("NEARZERO_UNINSTALL_YES=true skips the question like --yes (R4-02)", async () => {
    const root = await pretendServer();
    try {
      const result = await uninstallWith(root, `${NO_DOCKER}\nmain`, {
        NEARZERO_UNINSTALL_YES: "true",
      });
      expect(result.code).toBe(0);
      expect(result.out).toContain("✓ Removed Nearzero");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("B2-23: with Docker installed but stopped, nothing is removed", async () => {
    const root = await pretendServer();
    try {
      const result = await uninstallWith(root, `docker() { return 1; }\nmain --yes`);
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        "Docker is installed but isn't running, so Nearzero's containers, volumes and images can't be removed, and nothing was.",
      );
      expect(await Bun.file(join(root, "opt/nearzero/.env")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("R4-02: with Nearzero 0.1.x still on the server, nothing is removed and it says what to run", async () => {
    const root = await pretendServer();
    try {
      // A 0.1.x control plane, its container without 1.0's labels.
      const running = await uninstallWith(
        root,
        `docker() {
  case "$1" in
    info) return 0 ;;
    ps) printf 'nearzero-api||\nnearzero-control|true|control\n' ;;
    service) return 1 ;;
  esac
}
main --yes`,
      );
      expect(running.code).toBe(1);
      expect(running.out).toContain(
        "Nearzero 0.1.x is still on this server: the container nearzero-api. This uninstaller removes only 1.0, so nothing was removed.",
      );
      // R4-02: the address the final 0.1.x release publishes its uninstaller at, with its checksum.
      expect(running.out).toContain(
        "Remove 0.1.x with its own uninstaller first: curl -fsSL https://cdn.nearzero.dev/releases/0.1.80/uninstall.sh | sudo bash",
      );
      expect(running.out).toContain(
        "That uninstaller's SHA-256 checksum is published beside it: https://cdn.nearzero.dev/releases/0.1.80/uninstall.sh.sha256",
      );
      // A move that isn't finalized.
      await Bun.$`mkdir -p ${root}/opt/nearzero/migration`.quiet();
      await Bun.write(join(root, "opt/nearzero/migration/state"), "moved 2026-11-27\n");
      const moving = await uninstallWith(root, `${NO_DOCKER}\nmain --yes`);
      expect(moving.code).toBe(1);
      expect(moving.out).toContain("a move from 0.1.x that is not finalized (moved)");
      expect(moving.out).toContain("sudo nearzero migrate finalize");
      // C2-19: after a rollback the server runs 0.1.x again, so it is named with its own
      // uninstaller, not the move commands that can't run any more.
      await Bun.write(join(root, "opt/nearzero/migration/state"), "rolled-back 2026-11-27\n");
      const back = await uninstallWith(root, `${NO_DOCKER}\nmain --yes`);
      expect(back.code).toBe(1);
      expect(back.out).toContain(
        "Nearzero 0.1.x is still on this server: Nearzero 0.1.x, which this server went back to with migrate rollback.",
      );
      expect(back.out).toContain("https://cdn.nearzero.dev/releases/0.1.80/uninstall.sh");
      expect(back.out).not.toContain("migrate finalize");
      expect(await Bun.file(join(root, "opt/nearzero/.env")).exists()).toBe(true);
      expect(await Bun.file(join(root, "var/lib/nearzero-runner/credential")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("B2-26: an install kept in another folder is removed from there, its backups kept", async () => {
    const root = await pretendServer();
    try {
      // Installed with NEARZERO_INSTALL_DIR: the command names the folder (install.sh writes it).
      await Bun.$`rm -rf ${root}/opt/nearzero && mkdir -p ${root}/srv/nearzero/router`.quiet();
      await Bun.write(
        join(root, "srv/nearzero/.env"),
        "NEARZERO_VERSION=1.0.0\nNEARZERO_EDITION=1\n",
      );
      await Bun.write(join(root, "srv/nearzero/compose.yml"), "name: nearzero1\n");
      await Bun.write(join(root, "srv/nearzero/nearzero-db-20261127-111500.sql"), "-- dump\n");
      await Bun.write(
        join(root, "usr/local/bin/nearzero"),
        `#!/usr/bin/env bash\nNZC_DIR="\${NEARZERO_INSTALL_DIR:-${root}/srv/nearzero}"\n`,
      );
      const result = await uninstallWith(root, `${NO_DOCKER}\nmain --yes`);
      expect(result.code).toBe(0);
      expect(result.out).toContain("✓ Removed Nearzero");
      expect((await Bun.$`test -e ${root}/srv/nearzero`.nothrow().quiet()).exitCode).not.toBe(0);
      expect(
        await Bun.file(join(root, "var/backups/nearzero/nearzero-db-20261127-111500.sql")).text(),
      ).toBe("-- dump\n");
      expect(await Bun.file(join(root, "usr/local/bin/nearzero")).exists()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("B2-26: NEARZERO_INSTALL_DIR naming a folder without Nearzero's files removes nothing", async () => {
    const root = await pretendServer();
    try {
      await Bun.$`mkdir -p ${root}/home/someone`.quiet();
      await Bun.write(join(root, "home/someone/notes.txt"), "mine\n");
      const result = await uninstallWith(root, `${NO_DOCKER}\nmain --yes`, {
        NEARZERO_INSTALL_DIR: `${root}/home/someone`,
      });
      expect(result.code).toBe(1);
      expect(result.out).toContain(
        `NEARZERO_INSTALL_DIR names ${root}/home/someone, which doesn't hold Nearzero's files (.env or compose.yml), so nothing was removed.`,
      );
      expect(await Bun.file(join(root, "home/someone/notes.txt")).text()).toBe("mine\n");
      expect(await Bun.file(join(root, "opt/nearzero/.env")).exists()).toBe(true);
      const relative = await uninstallWith(root, `${NO_DOCKER}\nmain --yes`, { INSTALL_DIR: "/" });
      expect(relative.code).toBe(1);
      expect(relative.out).toContain("NEARZERO_INSTALL_DIR must be a plain absolute folder path");
      expect(await Bun.file(join(root, "opt/nearzero/.env")).exists()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("release files", () => {
  test("stamps the version and repository and lays out latest and pinned copies", () => {
    const install = 'NZ_VERSION="1.0.0-dev"\nNZ_IMAGE_REPOSITORY="ghcr.io/a/b"\necho hi\n';
    const files = releaseFiles({
      version: "1.2.3",
      imageRepository: "ghcr.io/owner/nearzero",
      installText: install,
      uninstallText: "echo bye\n",
    });
    expect(files.map((file) => file.path)).toEqual([
      "install.sh",
      "install.sh.sha256",
      "uninstall.sh",
      "uninstall.sh.sha256",
      "v1.2.3/install.sh",
      "v1.2.3/install.sh.sha256",
      "v1.2.3/uninstall.sh",
      "v1.2.3/uninstall.sh.sha256",
    ]);
    const stamped = files[0]?.content ?? "";
    expect(stamped).toContain('NZ_VERSION="1.2.3"');
    expect(stamped).toContain('NZ_IMAGE_REPOSITORY="ghcr.io/owner/nearzero"');
    expect(files[1]?.content).toBe(`${sha256(stamped)}  install.sh\n`);
    expect(files[5]?.content).toBe(files[1]?.content);
  });

  test("refuses a version that isn't a release version", () => {
    expect(() =>
      releaseFiles({
        version: "latest",
        imageRepository: "ghcr.io/owner/nearzero",
        installText: 'NZ_VERSION="x"\nNZ_IMAGE_REPOSITORY="y"\n',
        uninstallText: "",
      }),
    ).toThrow("isn't a release version");
  });

  test("the release script writes files sha256sum can check", async () => {
    const out = await mkdtemp(join(tmpdir(), "nz1-release-test-"));
    try {
      const child = Bun.spawn(
        [
          "bun",
          join(PATHS.install, "..", "scripts", "release.ts"),
          "--out",
          out,
          "--version",
          "1.0.0",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(await child.exited).toBe(0);
      expect((await readdir(out)).sort()).toEqual([
        "install.sh",
        "install.sh.sha256",
        "uninstall.sh",
        "uninstall.sh.sha256",
        "v1.0.0",
      ]);
      const pinned = await Bun.file(join(out, "v1.0.0", "install.sh")).text();
      expect(pinned).toContain('NZ_VERSION="1.0.0"');
      expect(pinned).toContain('NZ_IMAGE_REPOSITORY="ghcr.io/nearzero-systems/nearzero"');
      expect(await Bun.file(join(out, "v1.0.0", "install.sh.sha256")).text()).toBe(
        checksumLine("install.sh", pinned),
      );
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("the image's supervisor", () => {
  test("runs the API and the console on fixed ports inside the container", () => {
    const [control, consoleSpec] = processSpecs("/app", "/usr/local/bin/bun", {
      NEARZERO_MANAGEMENT_BIND_ADDRESS: "127.0.0.1",
      NEARZERO_CONTROL_PORT: "9999",
      NEARZERO_CONSOLE_PORT: "8080",
      UNSET: undefined,
    });
    expect(control?.command).toEqual([
      "/usr/local/bin/bun",
      "--no-install",
      "/app/control/main.js",
    ]);
    expect(control?.env.NEARZERO_CONTROL_PORT).toBe("3000");
    expect(control?.env.NEARZERO_MANAGEMENT_BIND_ADDRESS).toBe("0.0.0.0");
    // The public console port stays as configured: the control plane builds addresses with it.
    expect(control?.env.NEARZERO_CONSOLE_PORT).toBe("8080");
    expect(consoleSpec?.command).toEqual([
      "/usr/local/bin/bun",
      "--no-install",
      "/app/console/server/entry.mjs",
    ]);
    expect(consoleSpec?.env.PORT).toBe("4321");
    expect(consoleSpec?.env.NEARZERO_CONTROL_URL).toBe("http://127.0.0.1:3000");
    expect("UNSET" in (control?.env ?? {})).toBe(false);
  });
});

describe("migrate rollback and finalize (spec 29.5)", () => {
  // Each one waits a few seconds for what the stand-ins never bring back.
  setDefaultTimeout(60_000);
  /**
   * Runs one of the nearzero command's functions against a stand-in install folder, with docker,
   * curl and the control plane replaced by stand-ins that log what they are asked.
   */
  async function withStandIns(
    script: string,
    setup: (dir: string) => Promise<void>,
    scriptFor?: (dir: string) => string,
  ) {
    const { mkdir, writeFile, readFile } = await import("node:fs/promises");
    const dir = await mkdtemp(join(tmpdir(), "nz1-rollback-"));
    const migration = join(dir, "migration");
    await mkdir(join(migration, "0.1", "files"), { recursive: true });
    await writeFile(join(migration, "0.1", "env"), "NEARZERO_VERSION=0.1.80\n");
    await writeFile(join(migration, "0.1", "version"), "0.1.80\n");
    await writeFile(join(migration, "0.1", "files", "compose.yml"), "services: {}\n");
    await writeFile(join(dir, ".env"), "NEARZERO_EDITION=1\n");
    await writeFile(join(dir, "compose.yml"), "name: nearzero1\n");
    await mkdir(join(dir, "legacy"));
    await setup(dir);
    const source = (await Bun.file(PATHS.command).text()).replace(/\nnzc_main "\$@"\n$/, "\n");
    const standIns = `
log() { printf '%s\\n' "$*" >> "$NZ1_LOG"; }
docker() {
  log "docker $*"
  case "$*" in
    "ps -aq --filter label=dev.nearzero.edition=1") echo "c1 c2" ;;
    "volume ls -q --filter label=dev.nearzero.edition=1 --filter label=dev.nearzero.migration-attempt=move-1")
      printf '%s\\n' nearzero-postgres-data web-move-html nearzero-router-certificates ;;
    "network ls -q --filter label=dev.nearzero.edition=1 --filter label=dev.nearzero.migration-attempt=move-1")
      echo nearzero-internal ;;
    "ps -aq --filter label=com.docker.compose.project=nearzero") [ -f "$NZ1_GONE" ] || echo pg1 ;;
    "ps -q --filter label=com.docker.compose.project=nearzero") echo pg1 ;;
    "inspect --format {{.Config.Image}} pg1") echo postgres:16 ;;
    "exec pg1 pg_isready -q") return 0 ;;
    "service inspect shop_pg") [ -f "$NZ1_GONE" ] && return 1; return 0 ;;
    "info") return 0 ;;
  esac
  return 0
}
curl() { log "curl $*"; printf 200; }
nzc_control() { log "control $*"; case "$*" in "migrate rollback-plan") echo "swarm-service shop_pg" ;; esac; return 0; }
`;
    const body = scriptFor ? scriptFor(dir) : script;
    const run = await runBash(`${source}\n${standIns}\n${body}`, {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        NEARZERO_INSTALL_DIR: dir,
        NZ1_LOG: join(dir, "calls.log"),
        NZ1_GONE: join(dir, "gone"),
        NZC_ROLLBACK_WAIT_SECONDS: "3",
        NZC_FINALIZE_WAIT_SECONDS: "3",
      },
      stdin: "ignore",
    });
    const calls = (await readFile(join(dir, "calls.log"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
    await rm(dir, { recursive: true, force: true });
    return { code: run.code, out: run.stdout + run.stderr, calls };
  }

  const controlPlane = (dir: string) =>
    [
      "compose-project nearzero",
      "volume nearzero_nearzero-postgres",
      "project nearzero",
      `folder ${join(dir, "legacy")}`,
      "port 4321",
      "keep nearzero_nearzero-postgres",
      "keep web-move-html",
      "",
    ].join("\n");

  test("rollback removes only what carries 1.0's label, never a volume the bundle names", async () => {
    const { writeFile } = await import("node:fs/promises");
    const result = await withStandIns(
      "nzc_running() { return 1; }; nzc_rollback --yes",
      async (dir) => {
        await writeFile(join(dir, "migration", "control-plane.txt"), controlPlane(dir));
        await writeFile(join(dir, "migration", "attempt"), "move-1\n");
      },
    );
    expect(result.out).toContain("Nearzero 0.1.80 is back. The move to 1.0 was undone.");
    expect(result.code).toBe(0);
    const docker = result.calls.filter((call) => call.startsWith("docker "));
    // 1.0's containers go; then only the volumes and networks this attempt made.
    // With their anonymous volumes, never a named one.
    expect(docker).toContain("docker rm -fv c1 c2");
    expect(docker).toContain("docker volume rm nearzero-postgres-data");
    expect(docker).toContain("docker volume rm nearzero-router-certificates");
    expect(docker).toContain("docker network rm nearzero-internal");
    expect(docker.filter((call) => call.startsWith("docker volume rm"))).toEqual([
      "docker volume rm nearzero-postgres-data",
      "docker volume rm nearzero-router-certificates",
    ]);
    // Every volume listing asks for 1.0's label; nothing sweeps by project or without it.
    for (const call of docker.filter((item) => item.startsWith("docker volume ls"))) {
      expect(call).toContain("label=dev.nearzero.edition=1");
    }
    expect(docker.some((call) => call.includes("down --volumes"))).toBe(false);
    // 0.1.x's Compose project is created and started from its folder, then its workloads.
    expect(docker).toContain("docker compose -p nearzero up -d");
    expect(docker).toContain("docker start pg1");
    expect(docker).toContain("docker exec pg1 pg_isready -q");
  });

  test("rollback says what didn't come back and exits 1", async () => {
    const { writeFile } = await import("node:fs/promises");
    const result = await withStandIns(
      "nzc_running() { return 1; }; curl() { printf 000; }; nzc_rollback --yes",
      async (dir) => {
        await writeFile(join(dir, "migration", "control-plane.txt"), controlPlane(dir));
        await writeFile(join(dir, "migration", "attempt"), "move-1\n");
      },
    );
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      "Nearzero 0.1.80 didn't come back within 5 minutes. Not back: its console (ports 4321 )",
    );
    expect(result.out).not.toContain("The move to 1.0 was undone.");
  });

  test("finalize removes the host's 0.1.x workloads and says what is still being removed", async () => {
    const { writeFile } = await import("node:fs/promises");
    const still = await withStandIns(
      "nzc_running() { return 0; }; nzc_finalize --yes",
      async (dir) => {
        await writeFile(join(dir, "migration", "control-plane.txt"), controlPlane(dir));
      },
    );
    expect(still.code).toBe(0);
    expect(still.calls).toContain("docker service rm shop_pg");
    expect(still.calls).toContain("docker volume rm nearzero_nearzero-postgres");
    expect(still.out).toContain(
      "Finalized: the 0.1.x data is deleted and Nearzero 1.0 keeps running. Still being removed: nearzero shop_pg.",
    );
    const done = await withStandIns(
      "nzc_running() { return 0; }; nzc_finalize --yes",
      async (dir) => {
        await writeFile(join(dir, "migration", "control-plane.txt"), controlPlane(dir));
        await writeFile(join(dir, "gone"), "");
      },
    );
    expect(done.out).toContain("Finalized: the 0.1.x data is deleted. Nearzero 1.0 keeps running.");
  });

  test("rollback brings 0.1.x's Compose project up with its own files and env file", async () => {
    const { writeFile } = await import("node:fs/promises");
    let folder = "";
    const result = await withStandIns(
      "nzc_running() { return 1; }; nzc_rollback --yes",
      async (dir) => {
        folder = join(dir, "legacy");
        await writeFile(
          join(dir, "migration", "control-plane.txt"),
          `${controlPlane(dir)}composefile docker-compose.prod.yml\ncomposefile docker-compose.local-db.yml\nenvfile .env\n`,
        );
        await writeFile(join(dir, "migration", "attempt"), "move-1\n");
      },
    );
    expect(result.code).toBe(0);
    expect(result.calls).toContain(
      `docker compose --project-directory ${folder} -p nearzero -f ${folder}/docker-compose.prod.yml -f ${folder}/docker-compose.local-db.yml --env-file ${folder}/.env up -d`,
    );
    expect(result.calls).not.toContain("docker compose -p nearzero up -d");
    expect(result.out).toContain("Nearzero 0.1.80 is back. The move to 1.0 was undone.");
  });

  /** Stand-ins for a host after a move: 0.1.x's and 1.0's containers in one Compose project. */
  const afterMove = `
docker() {
  log "docker $*"
  case "$*" in
    "ps -aq --filter label=com.docker.compose.project=shop") [ -f "$NZ1_GONE.old1" ] && echo new1 || echo "old1 new1" ;;
    "rm -fv old1") : >"$NZ1_GONE.old1" ;;
    "rm -fv legacy-console") : >"$NZ1_GONE.console" ;;
    "inspect legacy-console") [ -f "$NZ1_GONE.console" ] && return 1; return 0 ;;
    *'index .Config.Labels "dev.nearzero.edition"'*' new1') echo 1 ;;
    *'index .Labels "dev.nearzero.edition"'*' nearzero-traefik-control') echo 1 ;;
    *'.NetworkSettings.Networks'*' old1') echo "shop_default nearzero-network nearzero-traefik-control bridge " ;;
    *'.NetworkSettings.Networks'*' legacy-console') echo "nearzero_default " ;;
    *'len .Containers'*' nearzero-network') echo 1 ;;
    *'len .Containers'*) echo 0 ;;
    "network inspect "*) return 0 ;;
    "service inspect "* | "inspect "*) return 1 ;;
  esac
  return 0
}
nzc_control() { log "control $*"; case "$*" in "migrate rollback-plan") echo "compose-project shop" ;; esac; return 0; }
nzc_running() { return 0; }
`;
  const finalizePlane = "container legacy-console\nvolume legacy-data\nkeep shop_data\n";

  test("finalize goes item by item: a moved stack's 1.0 container in the same Compose project stays", async () => {
    const { writeFile } = await import("node:fs/promises");
    const result = await withStandIns(`${afterMove}\nnzc_finalize --yes`, async (dir) => {
      await writeFile(join(dir, "migration", "control-plane.txt"), finalizePlane);
    });
    expect(result.code).toBe(0);
    const removals = result.calls.filter((call) =>
      /^docker (rm|service rm|compose .*down)/.test(call),
    );
    // 0.1.x's container of the stack goes, with its anonymous volumes; 1.0's never.
    expect(removals).toContain("docker rm -fv old1");
    expect(removals.some((call) => call.includes("new1"))).toBe(false);
    expect(removals.some((call) => call.includes("down"))).toBe(false);
    expect(removals).toContain("docker rm -fv legacy-console");
    // Every container removal takes its anonymous volumes; the only named volume removed is the
    // control plane's own, which the bundle lists for finalize.
    for (const call of removals) expect(call).toMatch(/^docker (rm -fv|service rm) /);
    expect(result.calls.filter((call) => call.startsWith("docker volume rm"))).toEqual([
      "docker volume rm legacy-data",
    ]);
  });

  test("finalize removes 0.1.x's networks only once unused and without 1.0's label", async () => {
    const { writeFile } = await import("node:fs/promises");
    const result = await withStandIns(`${afterMove}\nnzc_finalize --yes`, async (dir) => {
      await writeFile(join(dir, "migration", "control-plane.txt"), finalizePlane);
    });
    const removed = result.calls.filter((call) => call.startsWith("docker network rm"));
    expect(removed.sort()).toEqual([
      "docker network rm nearzero_default",
      "docker network rm shop_default",
    ]);
    // In use, 1.0's, or Docker's own: kept.
    expect(removed.some((call) => call.endsWith("nearzero-network"))).toBe(false);
    expect(removed.some((call) => call.endsWith("nearzero-traefik-control"))).toBe(false);
    expect(removed.some((call) => call.endsWith(" bridge"))).toBe(false);
  });

  test("rollback brings a moved stack's 0.1.x copy back from its own files", async () => {
    const { writeFile, mkdir } = await import("node:fs/promises");
    let folder = "";
    const script = (dir: string) => `
nzc_running() { [ "$1" = nearzero-control ]; }
nzc_control() {
  log "control $*"
  case "$*" in
    "migrate rollback-plan") printf '%s\\n' "compose-project shop" "stackfolder shop ${join(dir, "stack")}" "stackfile shop docker-compose.prod.yml" "stackenv shop .env" "compose-project blog" ;;
  esac
  return 0
}
docker() {
  log "docker $*"
  case "$*" in
    "ps -aq --filter label=com.docker.compose.project=shop --filter label=dev.nearzero.edition=1") echo new1 ;;
    "ps -aq --filter label=com.docker.compose.project=blog") echo old-blog ;;
  esac
  return 0
}
nzc_rollback --yes`;
    let dirSeen = "";
    const result = await withStandIns(
      "",
      async (dir) => {
        dirSeen = dir;
        folder = join(dir, "stack");
        await mkdir(folder);
        await writeFile(join(dir, "migration", "control-plane.txt"), controlPlane(dir));
        await writeFile(join(dir, "migration", "attempt"), "move-1\n");
      },
      (dir) => script(dir),
    );
    expect(dirSeen).not.toBe("");
    const docker = result.calls.filter((call) => call.startsWith("docker "));
    // 1.0's containers in the project go first, with their anonymous volumes; then 0.1.x's files.
    const removed = docker.indexOf("docker rm -fv new1");
    const up = docker.indexOf(
      `docker compose --project-directory ${folder} -p shop -f ${folder}/docker-compose.prod.yml --env-file ${folder}/.env up -d`,
    );
    expect(removed).toBeGreaterThan(-1);
    expect(up).toBeGreaterThan(removed);
    // A stack the plan names no folder for is started as before, from its stopped containers.
    expect(docker).toContain("docker start old-blog");
  });

  test("rollback uses a stack's env file outside its folder only under the install's data folders", async () => {
    const { writeFile, mkdir, realpath } = await import("node:fs/promises");
    const run = (env: (dir: string) => Promise<string>) => {
      let folder = "";
      let envFile = "";
      return withStandIns(
        "",
        async (dir) => {
          folder = join(dir, "stack");
          await mkdir(folder);
          envFile = await env(dir);
          await writeFile(join(dir, "migration", "control-plane.txt"), controlPlane(dir));
          await writeFile(join(dir, "migration", "attempt"), "move-1\n");
        },
        () => `
nzc_running() { [ "$1" = nearzero-control ]; }
nzc_control() {
  log "control $*"
  case "$*" in
    "migrate rollback-plan") printf '%s\\n' "compose-project shop" "stackfolder shop ${folder}" "stackfile shop docker-compose.prod.yml" "stackenv shop ${envFile}" ;;
  esac
  return 0
}
nzc_rollback --yes`,
      ).then((result) => ({ ...result, folder, envFile }));
    };
    // Under the install folder (a data folder): used as it is.
    const inside = await run(async (dir) => {
      const secrets = join(await realpath(dir), "secrets", "compose-env");
      await mkdir(secrets, { recursive: true });
      await writeFile(join(secrets, "shop.env"), "GREETING=hello\n");
      return join(secrets, "shop.env");
    });
    expect(inside.calls).toContain(
      `docker compose --project-directory ${inside.folder} -p shop -f ${inside.folder}/docker-compose.prod.yml --env-file ${inside.envFile} up -d`,
    );
    // Outside every data folder: the stack isn't started without its variables.
    const outside = await run(async () => "/etc/hosts");
    expect(outside.calls.some((call) => call.includes("-p shop"))).toBe(false);
    expect(outside.out).toContain(
      "The env file /etc/hosts isn't a regular file under the 0.1.x install's data folders, so shop wasn't started.",
    );
    expect(outside.code).toBe(1);
  });
});
