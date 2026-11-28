import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBEDS, PATHS, readEmbedded, readSources } from "../scripts/files.ts";
import { runBash } from "./support/bash.ts";

/**
 * install.sh in dry-run mode (spec 03 3.1, 3.2): settings checks, the saved-settings rules on
 * reruns and the plan it would write. Dry runs change nothing and need neither root nor Docker.
 */

// Each dry run starts bash on the whole installer, about half a second on an idle machine; a few
// in one test go past bun's 5-second default when the machine is busy.
setDefaultTimeout(30_000);

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nz1-install-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Run {
  code: number;
  out: string;
}

async function dryRun(env: Record<string, string>, savedEnv?: string): Promise<Run> {
  const installDir = await mkdtemp(join(dir, "run-"));
  if (savedEnv !== undefined) await writeFile(join(installDir, ".env"), savedEnv);
  const child = Bun.spawn(["bash", PATHS.install], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      NEARZERO_DRY_RUN: "true",
      NEARZERO_UNATTENDED: "true",
      NEARZERO_INSTALL_DIR: installDir,
      NEARZERO_PUBLIC_IP: "192.0.3.10",
      ...env,
    },
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

/** Runs one of install.sh's functions without running main. */
async function callFunction(script: string): Promise<Run> {
  const source = (await Bun.file(PATHS.install).text()).replace(/\nmain "\$@"\n$/, "\n");
  const run = await runBash(`${source}\n${script}`, {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
  });
  return { code: run.code, out: run.stdout };
}

const SAVED = `# Nearzero settings
NEARZERO_VERSION=0.9.0
NEARZERO_IMAGE=ghcr.io/nearzero-systems/nearzero:0.9.0
NEARZERO_DATA_MODE=local
NEARZERO_DATABASE_PASSWORD=kept-database-password-0123456789
NEARZERO_AUTH_SECRET=kept-auth-secret-0123456789abcdefghijklmnop
DATABASE_URL=postgres://nearzero:kept-database-password-0123456789@nearzero-postgres:5432/nearzero
COMPOSE_PROFILES=database,router
NEARZERO_PUBLIC_IP=192.0.3.10
NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com
# Added by hand:
MY_OWN_SETTING=secret-value-that-is-never-printed
`;

describe("the embedded files", () => {
  test("install.sh carries the current compose file and nearzero command", async () => {
    const install = await Bun.file(PATHS.install).text();
    const sources = await readSources();
    for (const { delimiter, source } of EMBEDS) {
      expect(readEmbedded(install, delimiter)).toBe(sources[source]);
    }
  });

  test("B2-31: Arch gets a full upgrade with its packages, never a partial one", async () => {
    const install = await Bun.file(PATHS.install).text();
    expect(install).toContain("pacman -Syu --noconfirm --needed docker");
    expect(install).not.toMatch(/pacman -Sy(?!u)\b/);
  });

  test("the compose file's default images match the installer's", async () => {
    const install = await Bun.file(PATHS.install).text();
    const compose = await Bun.file(PATHS.compose).text();
    for (const [constant, variable] of [
      ["NZ_DEFAULT_POSTGRES_IMAGE", "NEARZERO_POSTGRES_IMAGE"],
      ["NZ_DEFAULT_ROUTER_IMAGE", "NEARZERO_ROUTER_IMAGE"],
      ["NZ_DEFAULT_DNS_IMAGE", "NEARZERO_DNS_IMAGE"],
    ] as const) {
      const value = new RegExp(`^${constant}="([^"]+)"$`, "m").exec(install)?.[1];
      expect(value).toBeTruthy();
      expect(compose).toContain(`\${${variable}:-${value}}`);
    }
  });
});

describe("a first install", () => {
  test("an email alone gets a generated password and fresh secrets", async () => {
    const run = await dryRun({ NEARZERO_ADMIN_EMAIL: "owner@example.com" });
    expect(run.code).toBe(0);
    expect(run.out).toContain("Self-hosted Platform as a Service · Community Edition");
    expect(run.out).toContain("Admin account: owner@example.com with a generated password");
    expect(run.out).toContain("NEARZERO_AUTH_SECRET=(generated)");
    expect(run.out).toContain("NEARZERO_DATABASE_PASSWORD=(generated)");
    // 1.0's own database container, never 0.1.x's name (spec 29.5).
    expect(run.out).toContain("DATABASE_URL=postgres://nearzero:********@nearzero1-postgres");
    expect(run.out).toContain("COMPOSE_PROFILES=database,router");
    expect(run.out).toContain("NEARZERO_IMAGE=ghcr.io/nearzero-systems/nearzero:");
    expect(run.out).toContain("Console: http://192.0.3.10:4321");
    // Server metrics are kept for 2 days unless the install says otherwise (spec 14.1).
    expect(run.out).toMatch(/NEARZERO_METRICS_RETENTION_DAYS=2$/m);
  });

  test("a password without an email stops and says it needs the email", async () => {
    const run = await dryRun({ NEARZERO_ADMIN_PASSWORD: "long-enough-password" });
    expect(run.code).toBe(1);
    expect(run.out).toContain("NEARZERO_ADMIN_PASSWORD needs NEARZERO_ADMIN_EMAIL too");
    expect(run.out).not.toContain("long-enough-password");
  });

  test("bad values are refused together, naming each setting", async () => {
    const run = await dryRun({
      NEARZERO_CONSOLE_PORT: "70000",
      NEARZERO_PLATFORM_DOMAIN: "exa mple.com",
      NEARZERO_ENABLE_MANAGED_DNS: "maybe",
      NEARZERO_ADMIN_EMAIL: "not-an-email",
      NEARZERO_DATA_MODE: "cloud",
    });
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "NEARZERO_PLATFORM_DOMAIN contains a space, a quote, #, $ or a backslash",
    );
    expect(run.out).toContain("NEARZERO_CONSOLE_PORT must be a port from 1 to 65535.");
    expect(run.out).toContain("NEARZERO_ENABLE_MANAGED_DNS must be true or false.");
    expect(run.out).toContain("NEARZERO_ADMIN_EMAIL must be an email address");
    expect(run.out).toContain(
      "NEARZERO_DATA_MODE must be local (the bundled database) or external.",
    );
  });

  test("a dashboard hostname needs a publicly routable address", async () => {
    const run = await dryRun({
      NEARZERO_PUBLIC_IP: "10.0.0.5",
      NEARZERO_MANAGEMENT_HOSTNAME: "nearzero.example.com",
    });
    expect(run.code).toBe(1);
    expect(run.out).toContain("10.0.0.5, isn't publicly routable");
  });

  test("an external database needs its URL, and a URL needs external mode", async () => {
    const noUrl = await dryRun({ NEARZERO_DATA_MODE: "external" });
    expect(noUrl.code).toBe(1);
    expect(noUrl.out).toContain("NEARZERO_DATA_MODE=external needs DATABASE_URL too");

    const noMode = await dryRun({ DATABASE_URL: "postgres://u:p@db.example.com:5432/nz" });
    expect(noMode.code).toBe(1);
    expect(noMode.out).toContain("DATABASE_URL is set, but NEARZERO_DATA_MODE isn't external.");

    const both = await dryRun({
      NEARZERO_DATA_MODE: "external",
      DATABASE_URL: "postgres://u:p%40ss@db.example.com:5432/nz",
    });
    expect(both.code).toBe(0);
    expect(both.out).toContain("COMPOSE_PROFILES=router");
    expect(both.out).toContain("DATABASE_URL=postgres://u:********@db.example.com:5432/nz");
    expect(both.out).not.toContain("NEARZERO_DATABASE_PASSWORD=");
  });

  test("a managed zone turns the built-in DNS server on; no zone keeps it off", async () => {
    const zone = await dryRun({
      NEARZERO_MANAGED_DNS_ZONE: "dns.example.com",
      NEARZERO_ADMIN_EMAIL: "owner@example.com",
    });
    expect(zone.code).toBe(0);
    expect(zone.out).toContain("COMPOSE_PROFILES=database,router,dns");
    expect(zone.out).toContain("NEARZERO_ENABLE_MANAGED_DNS=true");
    expect(zone.out).toContain("NEARZERO_MANAGED_DNS_SOA_EMAIL=owner@example.com");

    const noZone = await dryRun({ NEARZERO_ENABLE_MANAGED_DNS: "true" });
    expect(noZone.code).toBe(0);
    expect(noZone.out).not.toContain("NEARZERO_ENABLE_MANAGED_DNS=");
    expect(noZone.out).not.toContain(",dns");
  });

  test("a zone added on a rerun starts the DNS server even after a saved false", async () => {
    const run = await dryRun(
      { NEARZERO_MANAGED_DNS_ZONE: "dns.example.com" },
      `${SAVED}NEARZERO_ENABLE_MANAGED_DNS=false\n`,
    );
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_ENABLE_MANAGED_DNS=true");
    expect(run.out).toContain("COMPOSE_PROFILES=database,router,dns");
  });
});

describe("optional control-plane settings", () => {
  test("are passed through to .env, with secrets kept out of the output", async () => {
    const run = await dryRun({
      NEARZERO_CONSOLE_URL: "https://console.example.com/",
      NEARZERO_TRUSTED_PROXIES: "127.0.0.1,10.0.0.0/8",
      NEARZERO_EMAIL_FROM: "nearzero@example.com",
      NEARZERO_SMTP_URL: "smtp://mailer:smtp-secret-123@smtp.example.com:587",
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_TRUSTED_PROXIES=127.0.0.1,10.0.0.0/8");
    expect(run.out).toContain("NEARZERO_EMAIL_FROM=nearzero@example.com");
    expect(run.out).toContain("NEARZERO_SMTP_URL=smtp://mailer:********@smtp.example.com:587");
    expect(run.out).not.toContain("smtp-secret-123");
    expect(run.out).toContain("Console: https://console.example.com");

    const resend = await dryRun({ NEARZERO_RESEND_API_KEY: "re_secret_key_0123456789" });
    expect(resend.out).toContain("NEARZERO_RESEND_API_KEY=(set)");
    expect(resend.out).not.toContain("re_secret_key_0123456789");
  });

  test("are checked, and only one email provider can be set", async () => {
    const run = await dryRun({
      NEARZERO_CONSOLE_URL: "console.example.com",
      NEARZERO_TRUSTED_PROXIES: "everyone",
      NEARZERO_RESEND_API_KEY: "re_key",
      NEARZERO_SMTP_URL: "smtp://smtp.example.com:587",
    });
    expect(run.code).toBe(1);
    expect(run.out).toContain("NEARZERO_CONSOLE_URL must be the console's address");
    expect(run.out).toContain("NEARZERO_TRUSTED_PROXIES must list IP addresses or ranges");
    expect(run.out).toContain("NEARZERO_RESEND_API_KEY and NEARZERO_SMTP_URL are both set.");
  });
});

describe("a rerun (upgrade)", () => {
  test("keeps secrets, the hostname and extra lines, and moves an older official image forward", async () => {
    const run = await dryRun({}, SAVED);
    expect(run.code).toBe(0);
    expect(run.out).toContain("this run upgrades it and keeps its settings");
    expect(run.out).toContain("NEARZERO_AUTH_SECRET=(kept)");
    expect(run.out).toContain("NEARZERO_DATABASE_PASSWORD=(kept)");
    expect(run.out).toContain("NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com");
    expect(run.out).toContain("and 1 line(s) of your own, carried forward");
    expect(run.out).not.toContain("NEARZERO_IMAGE=ghcr.io/nearzero-systems/nearzero:0.9.0");
    expect(run.out).not.toContain("secret-value-that-is-never-printed");
    expect(run.out).not.toContain("kept-auth-secret");
  });

  test("keeps a newer official image and any custom image", async () => {
    const newer = await dryRun(
      {},
      SAVED.replace(
        "ghcr.io/nearzero-systems/nearzero:0.9.0",
        "ghcr.io/nearzero-systems/nearzero:99.0.0",
      ),
    );
    expect(newer.out).toContain("NEARZERO_IMAGE=ghcr.io/nearzero-systems/nearzero:99.0.0");
    const custom = await dryRun(
      {},
      SAVED.replace("ghcr.io/nearzero-systems/nearzero:0.9.0", "registry.example.com/mine:7"),
    );
    expect(custom.out).toContain("NEARZERO_IMAGE=registry.example.com/mine:7");
  });

  test("B2-24: an older official router image moves forward; a newer or custom one stays", async () => {
    const install = await Bun.file(PATHS.install).text();
    const current = /^NZ_DEFAULT_ROUTER_IMAGE="([^"]+)"$/m.exec(install)?.[1] as string;
    const older = await dryRun({}, `${SAVED}NEARZERO_ROUTER_IMAGE=traefik:v3.0.1\n`);
    expect(older.out).toContain(`NEARZERO_ROUTER_IMAGE=${current}`);
    const newer = await dryRun({}, `${SAVED}NEARZERO_ROUTER_IMAGE=traefik:v3.99.0\n`);
    expect(newer.out).toContain("NEARZERO_ROUTER_IMAGE=traefik:v3.99.0");
    const custom = await dryRun(
      {},
      `${SAVED}NEARZERO_ROUTER_IMAGE=registry.example.com/traefik:1\n`,
    );
    expect(custom.out).toContain("NEARZERO_ROUTER_IMAGE=registry.example.com/traefik:1");
  });

  test("C2-16: another variant of the official Postgres image is a custom choice and stays", async () => {
    const pick = (saved: string) =>
      callFunction(
        `NZ_SAVED_NEARZERO_POSTGRES_IMAGE=${saved}\nnz_newer_official_image NEARZERO_POSTGRES_IMAGE postgres:18.6-alpine postgres`,
      );
    expect((await pick("postgres:18.1")).out).toBe("postgres:18.1");
    expect((await pick("postgres:18.1-bookworm")).out).toBe("postgres:18.1-bookworm");
    expect((await pick(`postgres:18@sha256:${"a".repeat(64)}`)).out).toBe(
      `postgres:18@sha256:${"a".repeat(64)}`,
    );
    // The same variant still moves forward, and another major version stays.
    expect((await pick("postgres:18.1-alpine")).out).toBe("postgres:18.6-alpine");
    expect((await pick("postgres:17.4-alpine")).out).toBe("postgres:17.4-alpine");
  });

  test("refuses to change a saved hostname without the migration steps", async () => {
    const run = await dryRun({ NEARZERO_MANAGEMENT_HOSTNAME: "console.example.org" }, SAVED);
    expect(run.code).toBe(1);
    expect(run.out).toContain("requires a migration, so nothing was changed");
    expect(run.out).toContain("NEARZERO_CONFIRM_ADDRESS_CHANGE=true");
  });

  test("stops on a duplicate line, naming both lines but no value", async () => {
    const run = await dryRun({}, `${SAVED}NEARZERO_AUTH_SECRET=another-secret-0123456789abcdef\n`);
    expect(run.code).toBe(1);
    expect(run.out).toContain("NEARZERO_AUTH_SECRET is set twice in");
    expect(run.out).toContain("(lines 6 and 13)");
    expect(run.out).not.toContain("another-secret");
  });

  test("stops on a line that isn't KEY=value, naming the line", async () => {
    const run = await dryRun({}, `${SAVED}export BROKEN secret-ish\n`);
    expect(run.code).toBe(1);
    expect(run.out).toContain("Line 13 of");
    expect(run.out).toContain("isn't a KEY=value line");
    expect(run.out).not.toContain("secret-ish");
  });
});

describe("address checks", () => {
  test("only publicly routable IPv4 addresses count as public", async () => {
    const cases: Record<string, boolean> = {
      "8.8.8.8": true,
      "203.0.114.1": true,
      "10.1.2.3": false,
      "100.64.0.1": false,
      "127.0.0.1": false,
      "169.254.1.1": false,
      "172.16.0.1": false,
      "172.32.0.1": true,
      "192.0.2.10": false,
      "192.31.196.1": false,
      "192.52.193.255": false,
      "192.88.99.2": false,
      "192.168.1.1": false,
      "192.175.48.6": false,
      "192.175.49.1": true,
      "198.18.0.1": false,
      "198.51.100.7": false,
      "203.0.113.7": false,
      "224.0.0.1": false,
      "255.255.255.255": false,
      "1.2.3": false,
      "300.1.1.1": false,
    };
    const script = Object.keys(cases)
      .map((ip) => `nz_is_public_ipv4 '${ip}' && echo '${ip} yes' || echo '${ip} no'`)
      .join("\n");
    const run = await callFunction(script);
    for (const [ip, expected] of Object.entries(cases)) {
      expect(run.out).toContain(`${ip} ${expected ? "yes" : "no"}`);
    }
  });

  test("versions compare by release, with pre-releases before their release", async () => {
    const run = await callFunction(
      [
        "nz_version_newer 1.0.0 0.9.9 && echo a",
        "nz_version_newer 1.0.0 1.0.0-rc.1 && echo b",
        "nz_version_newer 1.0.0-rc.1 1.0.0 || echo c",
        "nz_version_newer 1.10.0 1.9.0 && echo d",
        "nz_version_newer 1.0.0 1.0.0 || echo e",
        "nz_version_newer 2.24.0 2.40.3 || echo f",
      ].join("\n"),
    );
    expect(run.out.split("\n").filter(Boolean)).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  test("hostnames need a dot and DNS-safe labels", async () => {
    const run = await callFunction(
      ["example.com", "a-b.example.co", "localhost", "-bad.com", "bad-.com", "1.2.3.4", "a..b"]
        .map((name) => `nz_is_hostname '${name}' && echo '${name} yes' || echo '${name} no'`)
        .join("\n"),
    );
    expect(run.out).toContain("example.com yes");
    expect(run.out).toContain("a-b.example.co yes");
    expect(run.out).toContain("localhost no");
    expect(run.out).toContain("-bad.com no");
    expect(run.out).toContain("bad-.com no");
    expect(run.out).toContain("1.2.3.4 no");
    expect(run.out).toContain("a..b no");
  });

  test("generated passwords are 24 letters and digits", async () => {
    const run = await callFunction("nz_random_password; echo; nz_random_password; echo");
    const [first, second] = run.out.trim().split("\n");
    expect(first).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(second).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(first).not.toBe(second);
  });
});

describe("data without its settings (spec 03 3.4, punch list 39)", () => {
  /**
   * A docker stand-in: `volume inspect` finds the volumes in VOLUMES ("name=labels;..."), and
   * `volume ls --filter label=dev.nearzero.edition=1` lists LABELLED. Anything else that changes
   * the server is recorded in CALLS, which must stay empty.
   */
  const docker = `
nz_has() { return 0; }
nz_docker_running() { return 0; }
docker() {
  case "$1 $2" in
    "volume inspect")
      local name="\${!#}"
      case ";$VOLUMES;" in *";$name="*)
        if [ "$3" = --format ]; then local rest="\${VOLUMES#*$name=}"; printf '%s' "\${rest%%;*}"; fi
        return 0 ;;
      esac
      return 1 ;;
    "volume ls") printf '%s' "$LABELLED"; return 0 ;;
    "info "*) return 0 ;;
  esac
  printf '%s\n' "docker $*" >> "$CALLS"
  return 0
}
NZ_ENV_FILE=/opt/nearzero/.env; NZ_DRY_RUN=0; NZ_MIGRATING=0; CALLS=$(mktemp)`;
  const message =
    "Found Nearzero's data (nearzero-postgres-data) but not its settings file /opt/nearzero/.env. Put the settings file back and run this command again, or run the uninstall command to remove the old data and start fresh.";

  test("1.0's database volume without /opt/nearzero/.env stops the run before anything changes", async () => {
    const run = await callFunction(
      `${docker}
NZ_HAVE_SAVED=0
VOLUMES="nearzero-postgres-data=dev.nearzero.edition=1 dev.nearzero.managed=true "
(nz_check_data_without_settings) 2>&1; code=$?; echo "calls: $(cat "$CALLS")"; exit $code`,
    );
    expect(run.code).toBe(1);
    expect(run.out).toContain(message);
    expect(run.out).toContain("calls: \n");
  });

  test("another volume with 1.0's label counts too, and is named", async () => {
    const run = await callFunction(
      `${docker}
NZ_HAVE_SAVED=0
LABELLED="nearzero-runner-state"
nz_check_data_without_settings 2>&1`,
    );
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "Found Nearzero's data (nearzero-runner-state) but not its settings file /opt/nearzero/.env.",
    );
  });

  test("a settings file, a move from 0.1.x, no data, or someone else's volume of that name pass", async () => {
    const volume = 'VOLUMES="nearzero-postgres-data=dev.nearzero.edition=1 "';
    for (const [setup, why] of [
      [`NZ_HAVE_SAVED=1; ${volume}`, "settings saved"],
      [`NZ_HAVE_SAVED=0; NZ_MIGRATING=1; ${volume}`, "moving from 0.1.x"],
      ["NZ_HAVE_SAVED=0", "no data"],
      // Not 1.0's (no label): the name check that follows names it instead.
      ['NZ_HAVE_SAVED=0; VOLUMES="nearzero-postgres-data=com.example=1 "', "unlabelled"],
    ]) {
      const run = await callFunction(`${docker}
${setup}
nz_check_data_without_settings && echo "passed: ${why}"`);
      expect(run.out).toContain(`passed: ${why}`);
    }
  });

  test("the check runs before any question, file or container", async () => {
    const source = await Bun.file(PATHS.install).text();
    const main = source.slice(source.indexOf("\nmain() {"));
    const check = main.indexOf("nz_check_data_without_settings");
    expect(check).toBeGreaterThan(0);
    // The account and domain questions are asked by nz_decide_account and nz_offer_domain.
    for (const later of [
      "nz_open_terminal",
      "nz_decide_account",
      "nz_offer_domain",
      "nz_write_env_file",
      "nz_start",
    ]) {
      expect(main.indexOf(later)).toBeGreaterThan(check);
    }
  });
});

describe("the host's time zone (spec 08 8.3)", () => {
  test("zone names come from the localtime link, and only zone-shaped names count", async () => {
    const run = await callFunction(
      [
        "nz_zone_from_link ../usr/share/zoneinfo/Europe/Berlin; echo",
        "nz_zone_from_link /usr/share/zoneinfo/posix/America/New_York; echo",
        "nz_zone_from_link /var/db/timezone/zoneinfo/Asia/Kolkata; echo",
        "nz_zone_from_link /etc/nothing || echo none",
        "nz_is_time_zone UTC && echo utc",
        "nz_is_time_zone 'Not a zone' || echo spaced",
        "nz_is_time_zone '' || echo empty",
      ].join("\n"),
    );
    expect(run.out.split("\n").filter(Boolean)).toEqual([
      "Europe/Berlin",
      "America/New_York",
      "Asia/Kolkata",
      "none",
      "utc",
      "spaced",
      "empty",
    ]);
  });

  test("a given zone is saved for the runner; a bad one is refused", async () => {
    const given = await dryRun({ NEARZERO_TIME_ZONE: "America/Sao_Paulo" });
    expect(given.code).toBe(0);
    expect(given.out).toContain("NEARZERO_TIME_ZONE=America/Sao_Paulo");
    const bad = await dryRun({ NEARZERO_TIME_ZONE: "Mars/Olympus;rm" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain(
      "NEARZERO_TIME_ZONE must be a time zone name, like Europe/Berlin or UTC.",
    );
    // A rerun keeps the saved zone.
    const kept = await dryRun({}, `${SAVED}NEARZERO_TIME_ZONE=Asia/Tokyo\n`);
    expect(kept.out).toContain("NEARZERO_TIME_ZONE=Asia/Tokyo");
  });

  test("the compose file gives it to the runner as TZ", async () => {
    const compose = await Bun.file(PATHS.compose).text();
    expect(compose).toContain(`TZ: \${NEARZERO_TIME_ZONE:-}`);
  });
});

describe("the control plane's JSON answers", () => {
  test("fields are read from the JSON line, not from the messages around it", async () => {
    const run = await callFunction(
      [
        `out=$(printf '%s\\n' 'Admin account created. Sign in at x as a@b.co' '{"result":"created","email":"a@b.co"}')`,
        `line=$(nz_json_line "$out")`,
        `nz_json_field "$line" result; echo`,
        `nz_json_field "$line" email; echo`,
        `nz_json_field '{"owner":"missing"}' owner; echo`,
        `echo "[$(nz_json_field '{"owner":"missing"}' email)]"`,
      ].join("\n"),
    );
    expect(run.out.split("\n").filter(Boolean)).toEqual(["created", "a@b.co", "missing", "[]"]);
  });

  test("the installer never matches the owner command's wording", async () => {
    const install = await Bun.file(PATHS.install).text();
    expect(install).not.toContain("already has an owner");
    expect(install).toContain("owner-status --json");
    expect(install).toContain("create-owner --json");
  });
});

describe("finding a 0.1.x install (spec 29.2)", () => {
  const LEGACY = (version: string) =>
    `NEARZERO_VERSION=${version}\nNEARZERO_PUBLIC_IP=192.0.3.10\nNEARZERO_PLATFORM_DOMAIN=apps.example.com\nREDIS_URL=redis://redis:6379\n`;

  test("one older than the final 0.1.x release stops with the update command", async () => {
    const run = await dryRun({}, LEGACY("0.1.70"));
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "This server runs Nearzero 0.1.70. Update it to 0.1.80 first: curl -fsSL https://cdn.nearzero.dev/releases/0.1.80/install.sh | sudo bash. Then run this install command again.",
    );
    // G4-02: the versioned address 0.1.x publishes, with its checksum beside it; never /v0.1.80/.
    expect(run.out).toContain(
      "That installer's SHA-256 checksum is published beside it: https://cdn.nearzero.dev/releases/0.1.80/install.sh.sha256",
    );
    expect(run.out).not.toContain("cdn.nearzero.dev/v0.1");
  });

  test("the final release is found, its public settings carried, and nothing changes in a dry run", async () => {
    const run = await dryRun({}, LEGACY("0.1.80"));
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_PLATFORM_DOMAIN=apps.example.com");
    // Its internal settings are made fresh for 1.0; the 0.1.x ones stay in its own file.
    expect(run.out).not.toContain("REDIS_URL");
    expect(run.out).toContain("NEARZERO_AUTH_SECRET=(generated)");
    expect(run.out).toContain(
      "Nearzero 0.1.80 was found: a real run would export it, check the export, and move it to 1.0.",
    );
    expect(run.out).toContain("Accounts: from the 0.1.x export");
  });

  test("a 1.0 settings file is an upgrade, not a move", async () => {
    const run = await callFunction(
      [
        // No 0.1.x control plane on this machine, unless a line below says there is one.
        'nz_legacy_control_plane_present() { [ "$PLANE" = 1 ]; }',
        'f=$(mktemp); printf "NEARZERO_VERSION=1.0.0\\nCOMPOSE_PROFILES=database\\n" > "$f"',
        'nz_is_legacy_settings "$f" && echo legacy || echo current',
        'printf "NEARZERO_VERSION=0.1.80\\n" > "$f"; nz_is_legacy_settings "$f" && echo legacy || echo current',
        // Releases before the final one write no version: a 0.1.x control plane decides.
        'printf "NEARZERO_PLATFORM_DOMAIN=x.example.com\\n" > "$f"; nz_is_legacy_settings "$f" && echo legacy || echo current',
        'PLANE=1; nz_is_legacy_settings "$f" && echo legacy || echo current',
        // 1.0's own marker is never taken for 0.1.x, even beside a 0.1.x container.
        'printf "NEARZERO_EDITION=1\\nNEARZERO_PLATFORM_DOMAIN=x.example.com\\n" > "$f"; nz_is_legacy_settings "$f" && echo legacy || echo current',
        'rm -f "$f"',
      ].join("\n"),
    );
    expect(run.out.split("\n").filter(Boolean)).toEqual([
      "current",
      "legacy",
      "current",
      "legacy",
      "current",
    ]);
  });

  test("a 0.1.x control plane is a nearzero… container or service without 1.0's labels", async () => {
    const run = await callFunction(
      [
        "nz_has() { return 0; }",
        'docker() { case "$1 $2" in "ps -a") printf "%s\\n" "$CONTAINERS" ;; "service ls") printf "%s\\n" "$SERVICES" ;; esac; }',
        'CONTAINERS="nearzero-control||control"; SERVICES=""; nz_legacy_control_plane_present && echo yes || echo no',
        'CONTAINERS="nearzero-restore-1|true|"; nz_legacy_control_plane_present && echo yes || echo no',
        'CONTAINERS="web-app||"; nz_legacy_control_plane_present && echo yes || echo no',
        'CONTAINERS="nearzero-console||"; nz_legacy_control_plane_present && echo yes || echo no',
        'CONTAINERS=""; SERVICES="nearzero_api"; nz_legacy_control_plane_present && echo yes || echo no',
      ].join("\n"),
    );
    expect(run.out.split("\n").filter(Boolean)).toEqual(["no", "no", "no", "yes", "yes"]);
  });

  test("1.0 writes its marker, NEARZERO_EDITION=1", async () => {
    const run = await dryRun({});
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_EDITION=1");
  });

  test("control-plane lines other than workloads are never treated as workloads", async () => {
    const run = await callFunction(
      [
        'for k in container swarm-service swarm-stack compose-project volume project folder port; do nz_is_workload_kind "$k" && echo "$k"; done',
      ].join("\n"),
    );
    expect(run.out.split("\n").filter(Boolean)).toEqual([
      "container",
      "swarm-service",
      "swarm-stack",
      "compose-project",
    ]);
  });

  test("without a terminal, a move needs NEARZERO_MIGRATE=yes and a passphrase of 16+ characters", async () => {
    const missing = await callFunction(
      'NZ_INTERACTIVE=0; NZ_LEGACY_VERSION=0.1.80; NZ_ENV_NEARZERO_MIGRATE=""; NZ_ENV_NEARZERO_MIGRATION_PASSPHRASE=""; nz_migration_confirm 2>&1',
    );
    expect(missing.code).toBe(1);
    expect(missing.out).toContain(
      "To move it to Nearzero 1.0 without a terminal, set NEARZERO_MIGRATE=yes and NEARZERO_MIGRATION_PASSPHRASE (at least 16 characters)",
    );
    const short = await callFunction(
      "NZ_INTERACTIVE=0; NZ_ENV_NEARZERO_MIGRATE=yes; NZ_ENV_NEARZERO_MIGRATION_PASSPHRASE=short; nz_migration_confirm 2>&1",
    );
    expect(short.out).toContain("NEARZERO_MIGRATION_PASSPHRASE must be at least 16 characters.");
    const ok = await callFunction(
      'NZ_INTERACTIVE=0; NZ_ENV_NEARZERO_MIGRATE=yes; NZ_ENV_NEARZERO_MIGRATION_PASSPHRASE="sixteen chars or more"; nz_migration_confirm && echo "confirmed $NZ_MIGRATION_PASSPHRASE"',
    );
    expect(ok.out).toContain("confirmed sixteen chars or more");
  });
});

describe("0.1.x setting names (spec 03 3.5)", () => {
  const digest = `sha256:${"b".repeat(64)}`;

  /** A dry run started only with 0.1.x names for the dry run and its folder. */
  async function legacyDryRun(env: Record<string, string>): Promise<Run> {
    const installDir = await mkdtemp(join(dir, "legacy-"));
    const child = Bun.spawn(["bash", PATHS.install], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        DRY_RUN: "true",
        NEARZERO_NONINTERACTIVE: "true",
        INSTALL_DIR: installDir,
        NEARZERO_PUBLIC_IP: "192.0.3.10",
        ...env,
      },
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

  test("old names stand for their 1.0 settings, and DRY_RUN and INSTALL_DIR keep their meaning", async () => {
    const run = await legacyDryRun({
      NEARZERO_PLATFORM_PORT: "3100",
      NEARZERO_STARTUP_TIMEOUT_SECONDS: "600",
      PUBLIC_BACKEND_URL: "https://old.example.com",
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain("Dry run: nothing was changed.");
    expect(run.out).toContain("NEARZERO_API_PORT=3100");
    expect(run.out).toContain("NEARZERO_STARTUP_TIMEOUT=600");
    expect(run.out).toContain("NEARZERO_CONSOLE_URL=https://old.example.com");
    expect(run.out).toContain("Console: https://old.example.com");
  });

  test("the 1.0 name wins when both are given", async () => {
    const run = await dryRun({
      NEARZERO_API_PORT: "3200",
      NEARZERO_PLATFORM_PORT: "3100",
      CONSOLE_URL: "https://old.example.com",
      NEARZERO_CONSOLE_URL: "https://new.example.com",
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_API_PORT=3200");
    expect(run.out).toContain("NEARZERO_CONSOLE_URL=https://new.example.com");
    expect(run.out).not.toContain("old.example.com");
  });

  test("EXTERNAL_SERVICES=true is external data mode, which needs DATABASE_URL", async () => {
    const missing = await dryRun({ EXTERNAL_SERVICES: "true" });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("NEARZERO_DATA_MODE=external needs DATABASE_URL too");
    const given = await dryRun({
      EXTERNAL_SERVICES: "true",
      DATABASE_URL: "postgres://nearzero:pw@db.example.com:5432/nearzero",
    });
    expect(given.code).toBe(0);
    expect(given.out).toContain("NEARZERO_DATA_MODE=external");
    const bad = await dryRun({ EXTERNAL_SERVICES: "sometimes" });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("EXTERNAL_SERVICES must be true or false");
  });

  test("settings 0.1.x had are kept as themselves; open registration behaves as bootstrap", async () => {
    const run = await dryRun({
      NEARZERO_TRUSTED_ORIGINS: "https://a.example.com,http://203.0.113.7:4321",
      NEARZERO_REGISTRATION_MODE: "open",
      NEARZERO_HEROKU_BUILDER_IMAGE: `heroku/builder:24@${digest}`,
      NEARZERO_PAKETO_BUILDER_IMAGE: `paketobuildpacks/builder-jammy-base@${digest}`,
      NEARZERO_RAILPACK_FRONTEND_IMAGE: `ghcr.io/railwayapp/railpack-frontend@${digest}`,
      NEARZERO_STATIC_NGINX_IMAGE: `nginx@${digest}`,
      NEARZERO_METRICS_REFRESH_SECONDS: "15",
      NEARZERO_METRICS_RETENTION_DAYS: "7",
      NEARZERO_DNS_BIND_ADDRESS: "127.0.0.1",
      NEARZERO_DNS_PORT: "5353",
    });
    expect(run.code).toBe(0);
    for (const line of [
      "NEARZERO_TRUSTED_ORIGINS=https://a.example.com,http://203.0.113.7:4321",
      "NEARZERO_REGISTRATION_MODE=bootstrap",
      `NEARZERO_HEROKU_BUILDER_IMAGE=heroku/builder:24@${digest}`,
      `NEARZERO_PAKETO_BUILDER_IMAGE=paketobuildpacks/builder-jammy-base@${digest}`,
      `NEARZERO_RAILPACK_FRONTEND_IMAGE=ghcr.io/railwayapp/railpack-frontend@${digest}`,
      `NEARZERO_STATIC_NGINX_IMAGE=nginx@${digest}`,
      "NEARZERO_METRICS_REFRESH_SECONDS=15",
      "NEARZERO_METRICS_RETENTION_DAYS=7",
      "NEARZERO_DNS_PORT=5353",
    ]) {
      expect(run.out).toContain(line);
    }
  });

  test("registration mode invite_only, as 0.1.x wrote it, is accepted as invite-only (30a R1-03)", async () => {
    const given = await dryRun({ NEARZERO_REGISTRATION_MODE: "invite_only" });
    expect(given.code).toBe(0);
    expect(given.out).toContain("NEARZERO_REGISTRATION_MODE=invite-only");
    const saved = await dryRun({}, "NEARZERO_REGISTRATION_MODE=invite_only\n");
    expect(saved.code).toBe(0);
    expect(saved.out).toContain("NEARZERO_REGISTRATION_MODE=invite-only");
  });

  test("0.1.x names for this server's email stand for the 1.0 settings (30a R1-04)", async () => {
    const run = await dryRun({ RESEND_API_KEY: "re_old_key", RESEND_FROM_EMAIL: "nz@example.com" });
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_RESEND_API_KEY=(set)");
    expect(run.out).toContain("NEARZERO_EMAIL_FROM=nz@example.com");
    expect(run.out).not.toContain("re_old_key");
    const auth = await dryRun({
      NEARZERO_RESEND_API_KEY: "re_new_key",
      NEARZERO_AUTH_FROM_EMAIL: "auth@example.com",
      RESEND_FROM_EMAIL: "other@example.com",
    });
    expect(auth.code).toBe(0);
    expect(auth.out).toContain("NEARZERO_EMAIL_FROM=auth@example.com");
  });

  test("their values are checked, naming each setting", async () => {
    const run = await dryRun({
      NEARZERO_TRUSTED_ORIGINS: "a.example.com",
      NEARZERO_REGISTRATION_MODE: "everyone",
      NEARZERO_HEROKU_BUILDER_IMAGE: "heroku/builder:24",
      NEARZERO_METRICS_REFRESH_SECONDS: "0",
      NEARZERO_DNS_PORT: "70000",
    });
    expect(run.code).toBe(1);
    expect(run.out).toContain("NEARZERO_TRUSTED_ORIGINS must list addresses separated by commas");
    expect(run.out).toContain("NEARZERO_REGISTRATION_MODE must be bootstrap or invite-only.");
    expect(run.out).toContain("NEARZERO_HEROKU_BUILDER_IMAGE must be pinned by digest");
    expect(run.out).toContain(
      "NEARZERO_METRICS_REFRESH_SECONDS must be a number of seconds from 1 to 3600.",
    );
    expect(run.out).toContain("NEARZERO_DNS_PORT must be a port from 1 to 65535.");
  });

  test("the metrics port and schedule are accepted and ignored, with one note", async () => {
    const run = await dryRun({
      NEARZERO_METRICS_PORT: "9100",
      NEARZERO_METRICS_CRON: "*/5 * * * *",
    });
    expect(run.code).toBe(0);
    const note =
      "Note: NEARZERO_METRICS_PORT and NEARZERO_METRICS_CRON are ignored: Nearzero 1.0's runner collects metrics itself.";
    expect(run.out.split(note).length - 1).toBe(1);
    expect(run.out).not.toContain("NEARZERO_METRICS_PORT=");
    const one = await dryRun({ NEARZERO_METRICS_CRON: "*/5 * * * *" });
    expect(one.out).toContain(
      "Note: NEARZERO_METRICS_CRON is ignored: Nearzero 1.0's runner collects metrics itself.",
    );
    const none = await dryRun({});
    expect(none.out).not.toContain("collects metrics itself");
  });

  test("G4-19: the router's, the auth and the Git addresses' 0.1.x names are read; the rest named once as ignored", async () => {
    const run = await dryRun({
      TRAEFIK_IMAGE: "traefik:v3.6.17",
      TRAEFIK_PORT: "8080",
      TRAEFIK_SSL_PORT: "8443",
      BETTER_AUTH_URL: "https://auth.example.com",
      PUBLIC_GIT_PROVIDER_BASE_URL: "https://git-hooks.example.com",
      NEARZERO_MONITORING_IMAGE: "nearzero/monitoring:0.1",
      NEARZERO_SCHEDULE_IMAGE: "nearzero/schedules:0.1",
      JOBS_URL: "http://jobs:3001",
      API_KEY: "jobs-api-key",
      TRAEFIK_HTTP3_PORT: "8443",
      POSTGRES_USER: "nearzero",
      POSTGRES_DB: "nearzero",
    });
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_ROUTER_IMAGE=traefik:v3.6.17");
    expect(run.out).toContain("NEARZERO_HTTP_PORT=8080");
    expect(run.out).toContain("NEARZERO_HTTPS_PORT=8443");
    expect(run.out).toContain("NEARZERO_CONSOLE_URL=https://auth.example.com");
    expect(run.out).toContain("NEARZERO_GIT_PUBLIC_URL=https://git-hooks.example.com");
    for (const note of [
      "Note: NEARZERO_MONITORING_IMAGE is ignored: 1.0 has no separate monitoring service.",
      "Note: NEARZERO_SCHEDULE_IMAGE is ignored: the control plane runs schedules itself.",
      "Note: JOBS_URL and API_KEY are ignored: the control plane runs jobs itself.",
      "Note: TRAEFIK_HTTP3_PORT is ignored: HTTP/3 uses the HTTPS port (UDP).",
      "Note: POSTGRES_USER and POSTGRES_DB are ignored: the bundled database's user and name are fixed; an external database is given by DATABASE_URL.",
    ]) {
      expect(run.out.split(note).length - 1).toBe(1);
    }
    expect(run.out).not.toContain("jobs-api-key");
    // The 1.0 names win, and the console's own 0.1.x names come before the auth address.
    const both = await dryRun({
      CONSOLE_URL: "https://console.example.com",
      BETTER_AUTH_URL: "https://auth.example.com",
      TRAEFIK_PORT: "8080",
      NEARZERO_HTTP_PORT: "8081",
    });
    expect(both.out).toContain("NEARZERO_CONSOLE_URL=https://console.example.com");
    expect(both.out).toContain("NEARZERO_HTTP_PORT=8081");
  });

  test("SKIP_DOCKER_INSTALL stops instead of installing Docker", async () => {
    const run = await callFunction(
      'SKIP_DOCKER_INSTALL=true; nz_has() { return 1; }; nz_install_docker_packages() { echo "installing"; }; nz_ensure_docker 2>&1',
    );
    expect(run.code).not.toBe(0);
    expect(run.out).toContain(
      "Docker isn't installed, and SKIP_DOCKER_INSTALL says not to install it.",
    );
    expect(run.out).not.toContain("installing");
  });

  test("sudo keeps the 0.1.x names without the NEARZERO_ prefix", async () => {
    const install = await Bun.file(PATHS.install).text();
    expect(install).toContain(
      'NZ_PLAIN_LEGACY_NAMES="CONSOLE_URL PUBLIC_BACKEND_URL BETTER_AUTH_URL PUBLIC_GIT_PROVIDER_BASE_URL TRAEFIK_IMAGE\nTRAEFIK_PORT TRAEFIK_SSL_PORT TRAEFIK_HTTP3_PORT TRAEFIK_SOCKET_PROXY_IMAGE JOBS_URL API_KEY POSTGRES_USER\nPOSTGRES_DB DRY_RUN INSTALL_DIR SKIP_DOCKER_INSTALL NO_COLOR\nEXTERNAL_SERVICES RESEND_API_KEY RESEND_FROM_EMAIL"',
    );
    expect(install).toContain("for plain in $NZ_PLAIN_LEGACY_NAMES; do");
  });

  test("a 0.1.x settings file's old names are read as the 1.0 settings on a move", async () => {
    const run = await callFunction(
      [
        'NZ_ENV_FILE=$(mktemp); printf "NEARZERO_VERSION=0.1.80\\nNEARZERO_PLATFORM_PORT=3100\\nCONSOLE_URL=https://old.example.com\\nNEARZERO_DNS_PORT=5353\\n" > "$NZ_ENV_FILE"',
        "nz_read_legacy_settings",
        'echo "api=$NZ_SAVED_NEARZERO_API_PORT console=$NZ_SAVED_NEARZERO_CONSOLE_URL dns=$NZ_SAVED_NEARZERO_DNS_PORT"',
        'rm -f "$NZ_ENV_FILE"',
      ].join("\n"),
    );
    expect(run.out).toContain("api=3100 console=https://old.example.com dns=5353");
  });

  test("the compose file gives the DNS port, builder overrides and metrics interval to the runner", async () => {
    const compose = await Bun.file(PATHS.compose).text();
    const dollar = "$";
    const port = `${dollar}{NEARZERO_DNS_PORT:-53}`;
    expect(compose).toContain(`NEARZERO_DNS_PORT: ${port}`);
    expect(compose).toContain(`"${dollar}{NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}:${port}:1053/udp"`);
    for (const name of [
      "NEARZERO_HEROKU_BUILDER_IMAGE",
      "NEARZERO_PAKETO_BUILDER_IMAGE",
      "NEARZERO_RAILPACK_FRONTEND_IMAGE",
      "NEARZERO_STATIC_NGINX_IMAGE",
      "NEARZERO_METRICS_REFRESH_SECONDS",
    ]) {
      expect(compose).toContain(`${name}: \${${name}:-}`);
    }
  });

  test("the runner measures the host's root filesystem through one read-only file (30c R3-34)", async () => {
    const compose = await Bun.file(PATHS.compose).text();
    const runner = compose.slice(compose.indexOf("\n  runner:"), compose.indexOf("\n  dns:"));
    expect(runner).toContain("NEARZERO_HOST_ROOT_PATH: /run/nearzero-host-root");
    expect(runner).toContain("- /etc/passwd:/run/nearzero-host-root:ro");
    // Nothing else of the host's filesystem is mounted into the runner, so it gains no new
    // writable access there: only its own folders, the Docker socket, and that one file.
    const hostPaths = [...runner.matchAll(/^ {6}- (\/[^:\n]+):/gm)].map((match) => match[1]);
    expect(hostPaths).toEqual(["/var/run/docker.sock", "/etc/passwd"]);
  });
});

describe('1.0\'s own names (spec 29.5 "No shared names with 0.1.x")', () => {
  /** A docker stand-in: `inspect` finds the objects listed in OBJECTS ("kind:name=labels;..."). */
  const docker = `
nz_has() { return 0; }
nz_docker_running() { return 0; }
docker() {
  printf '%s\\n' "docker $*" >> "\${NZ1_LOG:-/dev/null}"
  local kind="$1" name
  case "$1 $2" in
    "ps -aq") printf '%s' "$PROJECT_IDS"; return 0 ;;
    "container inspect" | "network inspect" | "volume inspect")
      name="\${!#}"
      case ";$OBJECTS;" in *";$kind:$name="*)
        if [ "$3" = --format ]; then
          local rest="\${OBJECTS#*$kind:$name=}"; printf '%s' "\${rest%%;*}"
        fi
        return 0 ;;
      esac
      return 1 ;;
  esac
  return 0
}`;

  test("a 1.0 name taken by something without 1.0's label stops the run, naming it", async () => {
    const run = await callFunction(
      `${docker}
NZ_HAVE_SAVED=0; NZ_MIGRATING=1
OBJECTS="container:nearzero-control=dev.nearzero.edition=1 ;volume:nearzero-postgres-data=com.docker.compose.project=nearzero ;network:nearzero-edge="
nz_check_name_collisions 2>&1`,
    );
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "Nearzero 1.0 needs these names, and this server already has them without Nearzero 1.0's label, so nothing was changed:",
    );
    expect(run.out).toContain("- the network nearzero-edge");
    expect(run.out).toContain("- the volume nearzero-postgres-data");
    expect(run.out).not.toContain("the container nearzero-control");
  });

  test("1.0's own objects, and none at all, pass; a rerun of an older 1.0 install counts its own", async () => {
    const ours = await callFunction(
      `${docker}
NZ_HAVE_SAVED=0; NZ_MIGRATING=0
OBJECTS="container:nearzero1-postgres=dev.nearzero.edition=1 dev.nearzero.managed=true "
nz_check_name_collisions && echo passed`,
    );
    expect(ours.out).toContain("passed");
    const older = await callFunction(
      `${docker}
NZ_HAVE_SAVED=1; NZ_MIGRATING=0
OBJECTS="network:nearzero-internal=dev.nearzero.managed=true "
nz_check_name_collisions && echo passed`,
    );
    expect(older.out).toContain("passed");
    // While moving, only 1.0's label counts: 0.1.x's things never pass for 1.0's.
    const moving = await callFunction(
      `${docker}
NZ_HAVE_SAVED=1; NZ_MIGRATING=1
OBJECTS="network:nearzero-internal=dev.nearzero.managed=true "
nz_check_name_collisions 2>&1`,
    );
    expect(moving.code).toBe(1);
    expect(moving.out).toContain("- the network nearzero-internal");
  });

  test("the compose file's names are 1.0's own, never 0.1.x's", async () => {
    const compose = await Bun.file(PATHS.compose).text();
    expect(compose).toContain("name: nearzero1\n");
    expect(compose).toContain("container_name: nearzero1-postgres");
    expect(compose).toContain("container_name: nearzero1-dns");
    expect(compose).not.toMatch(/container_name: nearzero-(postgres|dns)\n/);
    expect(compose).toContain('dev.nearzero.edition: "1"');
    // Networks and volumes are the installer's, so compose never adopts or deletes one.
    expect(compose.match(/external: true/g)?.length).toBe(6);
  });

  test("networks and volumes are created with 1.0's labels and the move attempt; old containers retire", async () => {
    const created = await callFunction(
      `${docker}
NZ_RUN_LOG=""; nz_run() { "$@"; }
NZ1_LOG=$(mktemp); trap 'cat "$NZ1_LOG"; rm -f "$NZ1_LOG"' EXIT; OBJECTS=""
NZ_FINAL_NEARZERO_MIGRATION_ATTEMPT=move-20261127T000000Z
nz_ensure_shared_objects`,
    );
    expect(created.out).toContain(
      "docker network create --label dev.nearzero.managed=true --label dev.nearzero.edition=1 --label dev.nearzero.migration-attempt=move-20261127T000000Z nearzero-internal",
    );
    expect(created.out).toContain(
      "docker volume create --label dev.nearzero.managed=true --label dev.nearzero.edition=1 --label dev.nearzero.migration-attempt=move-20261127T000000Z nearzero-postgres-data",
    );
    const retired = await callFunction(
      `${docker}
nz_run() { "$@"; }
NZ1_LOG=$(mktemp); trap 'cat "$NZ1_LOG"; rm -f "$NZ1_LOG"' EXIT; NZ_HAVE_SAVED=1; NZ_MIGRATING=0; PROJECT_IDS="old1"
OBJECTS="container:old1=dev.nearzero.component=database dev.nearzero.managed=true "
nz_retire_old_names`,
    );
    expect(retired.out).toContain("docker rm -fv old1");
    const moving = await callFunction(
      `${docker}
nz_run() { "$@"; }
NZ1_LOG=$(mktemp); trap 'cat "$NZ1_LOG"; rm -f "$NZ1_LOG"' EXIT; NZ_HAVE_SAVED=1; NZ_MIGRATING=1; PROJECT_IDS="old1"
nz_retire_old_names`,
    );
    expect(moving.out).not.toContain("docker rm");
  });

  test("a Swarm service lets go of its published ports when stopped and gets them back on start", async () => {
    const stub = `
docker() {
  printf '%s\\n' "docker $*" >> "$NZ1_LOG"
  case "$*" in
    *"{{range .Spec.EndpointSpec.Ports}}"*) printf '5433:5432:tcp:ingress 9000:9000:udp:host ' ;;
    *'migration.replicas"}}'*) printf 2 ;;
    *'migration.ports"}}'*) printf '5433:5432:tcp:ingress 9000:9000:udp:host' ;;
  esac
}`;
    const log = 'NZ1_LOG=$(mktemp); trap \'cat "$NZ1_LOG"; rm -f "$NZ1_LOG"\' EXIT';
    const stopped = await callFunction(`${stub}\n${log}\nnz_swarm_stop shop_pg 2`);
    expect(stopped.out).toContain(
      "docker service update --detach --label-add dev.nearzero.migration.replicas=2 --label-add dev.nearzero.migration.ports=5433:5432:tcp:ingress 9000:9000:udp:host --publish-rm 5432/tcp --publish-rm 9000/udp --replicas 0 shop_pg",
    );
    const started = await callFunction(`${stub}\n${log}\nnz_swarm_start shop_pg 0`);
    expect(started.out).toContain(
      "docker service update --detach --label-rm dev.nearzero.migration.replicas --replicas 2 --label-rm dev.nearzero.migration.ports --publish-add published=5433,target=5432,protocol=tcp,mode=ingress --publish-add published=9000,target=9000,protocol=udp,mode=host shop_pg",
    );
  });
});

describe("the built-in DNS server on a rerun (B2-10, B2-13)", () => {
  const zoneSettings = (root: string) => `
NZ_DIR=${root}
NZ_FINAL_NEARZERO_MANAGED_DNS_ZONE=install.example
NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS=true
NZ_FINAL_NEARZERO_MANAGED_DNS_SOA_EMAIL=dns@install.example
NZ_PUBLIC_IP=192.0.3.10
`;

  test("B2-10: zones connected in the console stay in the Corefile; the install's zone is added once", async () => {
    const root = await mkdtemp(join(dir, "dns-"));
    const published = `# Written by Nearzero. Changes here are replaced the next time zones are applied.
console.example:1053 {
    file /etc/nearzero/dns/zones/console.example.zone {
        reload 2s
    }
    reload 3s 1s
    errors
}
`;
    await Bun.write(join(root, "dns/Corefile"), published);
    const run = await callFunction(`${zoneSettings(root)}
nz_write_dns_files && nz_write_dns_files && cat "$NZ_DIR/dns/Corefile"`);
    expect(run.code).toBe(0);
    expect(run.out).toStartWith(published);
    expect(run.out).toContain("install.example:1053 {");
    expect(run.out.split("install.example:1053 {").length - 1).toBe(1);
    // A Corefile that already serves the install's zone is left exactly as it is.
    const again = await callFunction(`${zoneSettings(root)}
before=$(cat "$NZ_DIR/dns/Corefile"); nz_write_dns_files; [ "$(cat "$NZ_DIR/dns/Corefile")" = "$before" ] && echo same`);
    expect(again.out.trim()).toBe("same");
  });

  test("B2-29: a busy port is found however many listeners come before or after it", async () => {
    // More than a pipe holds, with the busy port early: the old check stopped reading there.
    const lines = Array.from({ length: 20_000 }, (_, n) => `tcp 0.0.0.0:${10000 + n}`);
    lines.splice(100, 0, "tcp 0.0.0.0:443");
    const listing = lines.join("\\n");
    const run = await callFunction(`set -o pipefail
nz_listeners() { printf '${listing}\\n'; }
found=0
for i in 1 2 3 4 5 6 7 8 9 10; do nz_port_busy 443 tcp && found=$((found + 1)); done
echo "found=$found"
nz_port_busy 80 tcp || echo "80 is free"`);
    expect(run.out).toContain("found=10");
    expect(run.out).toContain("80 is free");
  });

  test("B2-13: with a resolver on loopback port 53 and no zone yet, the server's own address is saved for the DNS server", async () => {
    const run = await callFunction(`
NZ_DRY_RUN=0
NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS=
NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS=
NZ_FINAL_NEARZERO_HTTP_PORT=80 NZ_FINAL_NEARZERO_HTTPS_PORT=443 NZ_FINAL_NEARZERO_CONSOLE_PORT=4321 NZ_FINAL_NEARZERO_API_PORT=3000
nz_has() { [ "$1" != docker ] && command -v "$1" >/dev/null 2>&1; }
nz_listeners() { printf 'udp 127.0.0.53%%lo:53\\ntcp 127.0.0.53%%lo:53\\ntcp 0.0.0.0:22\\n'; }
nz_local_ipv4() { printf '10.0.0.5'; }
nz_check_ports
echo "bind=$NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS"`);
    expect(run.out).toContain("bind=10.0.0.5");
  });
});

describe("ports on a rerun and the runner link (C2-14, G3-01, C2-09)", () => {
  const ports = `NZ_DRY_RUN=0
NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS=
NZ_FINAL_NEARZERO_DNS_BIND_ADDRESS=10.0.0.5
NZ_FINAL_NEARZERO_HTTP_PORT=80 NZ_FINAL_NEARZERO_HTTPS_PORT=443 NZ_FINAL_NEARZERO_CONSOLE_PORT=4321 NZ_FINAL_NEARZERO_API_PORT=3000 NZ_FINAL_NEARZERO_RUNNER_LINK_PORT=3443`;

  test("C2-14: a rerun with the control plane stopped isn't refused for Nearzero's own router", async () => {
    // The control plane was stopped (docker stop, compose down, an interrupted restore-db);
    // the runner still keeps nearzero-router on 80 and 443.
    const run = await callFunction(`${ports}
NZ_HAVE_SAVED=1
nz_has() { [ "$1" != docker ]; }
nz_listeners() { printf 'tcp 0.0.0.0:80\ntcp 0.0.0.0:443\n'; }
nz_port_holders() { printf 'the container nearzero-router'; }
nz_check_ports && echo "passed"`);
    expect(run.out).toContain("passed");
    // A first install with something else on 80 is still stopped, naming it; one of
    // Nearzero's own containers (left by an earlier install) isn't counted.
    const first = await callFunction(`${ports}
NZ_HAVE_SAVED=0
nz_has() { [ "$1" != docker ]; }
nz_listeners() { printf 'tcp 0.0.0.0:80\ntcp 0.0.0.0:443\n'; }
nz_port_holders() { [ "$1" = 80 ] && printf 'nginx' || printf 'the container nearzero-router'; }
(nz_check_ports) 2>&1; echo "exit=$?"`);
    expect(first.out).toContain("these are already in use on this server: 80 (nginx).");
    expect(first.out).not.toContain("443 (");
  });

  test("an upgrade that adds the runner link's port stops when something else holds it", async () => {
    const run = await callFunction(`${ports}
NZ_HAVE_SAVED=1
nz_has() { [ "$1" != docker ]; }
nz_listeners() { printf 'tcp 0.0.0.0:80\ntcp 0.0.0.0:3443\n'; }
nz_port_holders() { [ "$1" = 3443 ] && printf 'haproxy' || printf 'the container nearzero-router'; }
(nz_check_ports) 2>&1; echo "exit=$?"`);
    expect(run.out).toContain(
      "Nearzero now gives servers an encrypted link on TCP port 3443, and it is already in use on this server: 3443 (haproxy).",
    );
    expect(run.out).toContain("NEARZERO_RUNNER_LINK_PORT");
  });

  test("the link's port and certificate volume are in the compose file and the plan", async () => {
    const compose = await Bun.file(PATHS.compose).text();
    const published =
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose's own variables, not a template.
      '"${NEARZERO_RUNNER_LINK_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_RUNNER_LINK_PORT:-3443}:3443"';
    expect(compose).toContain(published);
    expect(compose).toContain("NEARZERO_RUNNER_TLS_DIR: /var/lib/nearzero/runner-link");
    expect(compose).toContain("- runner-link:/var/lib/nearzero/runner-link");
    expect(compose).toMatch(/runner-link:\n {4}name: nearzero-runner-link\n {4}external: true/);
    const install = await Bun.file(PATHS.install).text();
    expect(install).toMatch(/^NZ_CREATED_VOLUMES="[^"]*nearzero-runner-link/m);
    const run = await dryRun({ NEARZERO_ADMIN_EMAIL: "owner@example.com" });
    expect(run.code).toBe(0);
    expect(run.out).toContain("NEARZERO_RUNNER_LINK_PORT=3443");
    const bad = await dryRun({ NEARZERO_RUNNER_LINK_PORT: "70000" });
    expect(bad.out).toContain("NEARZERO_RUNNER_LINK_PORT must be a port from 1 to 65535.");
  });

  test("C2-09: the summary names the link's port for servers, even with the console on localhost", async () => {
    const summary = (settings: string) =>
      callFunction(`${settings}
NZ_FINAL_NEARZERO_RUNNER_LINK_PORT=3443 NZ_FINAL_NEARZERO_CONSOLE_PORT=4321 NZ_FINAL_NEARZERO_API_PORT=3000
NZ_PUBLIC_IP=203.0.113.10 NZ_OWNER_STATE=kept NZ_OWNER_EMAIL=owner@example.com
nz_runner_link_fingerprint() { printf '${"ab".repeat(32)}'; }
nz_summary`);
    const local = await summary("NZ_FINAL_NEARZERO_MANAGEMENT_BIND_ADDRESS=127.0.0.1");
    expect(local.out).toContain(
      "Servers you add reach Nearzero over an encrypted link on TCP 3443: allow it from them.",
    );
    expect(local.out).toContain(`fingerprint: ${"ab".repeat(32)}`);
    const domain = await summary(
      "NZ_FINAL_NEARZERO_MANAGEMENT_BIND_ADDRESS=0.0.0.0 NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME=nz.example.com",
    );
    expect(domain.out).toContain("Ports 3000 and 4321 are plain HTTP: block them");
    expect(domain.out).toContain("Servers you add reach Nearzero through https://nz.example.com");
  });
});

describe("the account and the summary's wording (G4-22, G4-24)", () => {
  /** nz_decide_account with answers typed at a stand-in terminal. */
  const account = (env: string, answers: string[]) =>
    callFunction(`${env}
NZ_HAVE_SAVED=0 NZ_MIGRATING=0
nz_probe_owner() { NZ_OWNER_STATE=unknown; }
answers=(${answers.map((answer) => `'${answer}'`).join(" ")})
nz_ask() { printf '%s' "$1"; NZ_ANSWER="\${answers[0]}"; answers=("\${answers[@]:1}"); }
nz_ask_secret() { nz_ask "$1"; }
nz_decide_account
printf '\nemail=%s generated=%s same=%s\n' "$NZ_ADMIN_EMAIL" "$NZ_PASSWORD_GENERATED" "$([ "$NZ_ADMIN_PASSWORD" = typed-password-1 ] && echo yes)"`);

  test("G4-22: at a terminal with only an email, it asks for the password, the email offered", async () => {
    const run = await account("NZ_INTERACTIVE=1 NZ_ENV_NEARZERO_ADMIN_EMAIL=owner@example.com", [
      "",
      "typed-password-1",
      "typed-password-1",
    ]);
    expect(run.out).toContain("Email [owner@example.com]: ");
    expect(run.out).toContain("Password (8+ characters): ");
    expect(run.out).toContain("Confirm password: ");
    expect(run.out).toContain("email=owner@example.com generated=0 same=yes");
    // Another address can be typed instead.
    const other = await account("NZ_INTERACTIVE=1 NZ_ENV_NEARZERO_ADMIN_EMAIL=owner@example.com", [
      "admin@example.com",
      "typed-password-1",
      "typed-password-1",
    ]);
    expect(other.out).toContain("email=admin@example.com");
    // Unattended, a password is still generated, as spec 3.1 says.
    const unattended = await account(
      "NZ_INTERACTIVE=0 NZ_ENV_NEARZERO_ADMIN_EMAIL=owner@example.com",
      [],
    );
    expect(unattended.out).not.toContain("Password (8+");
    expect(unattended.out).toContain("email=owner@example.com generated=1");
  });

  test("G4-24: a rerun names the existing account and the reset command; Apps is an example", async () => {
    const run = await callFunction(`
NZ_FINAL_NEARZERO_RUNNER_LINK_PORT=3443 NZ_FINAL_NEARZERO_CONSOLE_PORT=4321 NZ_FINAL_NEARZERO_API_PORT=3000
NZ_FINAL_NEARZERO_MANAGEMENT_BIND_ADDRESS=0.0.0.0 NZ_FINAL_NEARZERO_MANAGEMENT_HOSTNAME=nz.example.com
NZ_FINAL_NEARZERO_PLATFORM_DOMAIN=apps.example.com NZ_PUBLIC_IP=203.0.113.10
NZ_OWNER_STATE=exists NZ_OWNER_EMAIL=owner@example.com
nz_runner_link_fingerprint() { :; }
nz_summary`);
    expect(run.out).toContain(
      "  Sign in   owner@example.com  (the existing account and its password)\n  Forgot that password? Run: sudo nearzero reset-password\n",
    );
    expect(run.out).toContain("  Apps get addresses like https://<label>.apps.example.com\n");
    expect(run.out).not.toMatch(/https:\/\/[a-z0-9]{8}\.apps\.example\.com/);
  });

  test("G4-24: answering n or Enter at the domain question says how to add one later", async () => {
    for (const answer of ["", "n", "no"]) {
      const run = await callFunction(`
nz_ask() { printf '%s' "$1"; NZ_ANSWER='${answer}'; }
nz_ask_domain`);
      expect(run.out).toContain("Skipped. Run this install command again to add one.");
    }
  });
});

describe("a hostname saved under About Nearzero, on a rerun (G4-20)", () => {
  test("the domain question isn't asked again", async () => {
    const offer = (saved: string) =>
      callFunction(`NZ_INTERACTIVE=1 NZ_PUBLIC_IP=93.184.215.9 NZ_CONSOLE_SAVED_HOSTNAME=${saved}
nz_ask_domain() { echo "asked"; }
nz_offer_domain; echo "done"`);
    expect((await offer("nz.example.com")).out).toBe("done\n");
    expect((await offer("")).out).toBe("asked\ndone\n");
  });

  test("another NEARZERO_MANAGEMENT_HOSTNAME is refused with the steps, unless confirmed", async () => {
    const decide = (confirm: string) =>
      callFunction(`NZ_CONSOLE_SAVED_HOSTNAME=nz.example.com NZ_PUBLIC_IP=93.184.215.9
NZ_ENV_NEARZERO_MANAGEMENT_HOSTNAME=other.example.com ${confirm}
(nz_decide_settings) 2>&1 | head -n 3`);
    const refused = await decide("");
    expect(refused.out).toContain(
      "This server's NEARZERO_MANAGEMENT_HOSTNAME is nz.example.com. Changing it to other.example.com requires a migration, so nothing was changed.",
    );
    const confirmed = await decide("NZ_ENV_NEARZERO_CONFIRM_ADDRESS_CHANGE=true");
    expect(confirmed.out).not.toContain("requires a migration");
    // The same hostname is no change.
    const same =
      await callFunction(`NZ_CONSOLE_SAVED_HOSTNAME=nz.example.com NZ_PUBLIC_IP=93.184.215.9
NZ_ENV_NEARZERO_MANAGEMENT_HOSTNAME=nz.example.com
(nz_decide_settings) 2>&1 | head -n 3`);
    expect(same.out).not.toContain("requires a migration");
  });
});

describe("ports after 0.1.x stops, on a move (C2-21)", () => {
  test("what still holds a port is named, with the ports this install uses", async () => {
    const run = await callFunction(`
NZ_FINAL_NEARZERO_HTTP_PORT=8080 NZ_FINAL_NEARZERO_HTTPS_PORT=8443 NZ_FINAL_NEARZERO_CONSOLE_PORT=4321 NZ_FINAL_NEARZERO_API_PORT=3000 NZ_FINAL_NEARZERO_RUNNER_LINK_PORT=3443
nz_listeners() { printf 'tcp 0.0.0.0:8443\ntcp 0.0.0.0:22\n'; }
nz_port_holders() { printf 'the Swarm service nearzero_traefik'; }
nz_migration_undo() { echo "undo: $1"; exit 1; }
nz_migration_ports_free`);
    expect(run.out).toContain(
      "undo: Nearzero 1.0 needs TCP ports 8080, 8443, 4321, 3000 and 3443, and these are still in use after 0.1.x stopped: 8443 (the Swarm service nearzero_traefik).",
    );
    const free = await callFunction(`
NZ_FINAL_NEARZERO_HTTP_PORT=80 NZ_FINAL_NEARZERO_HTTPS_PORT=443 NZ_FINAL_NEARZERO_CONSOLE_PORT=4321 NZ_FINAL_NEARZERO_API_PORT=3000 NZ_FINAL_NEARZERO_RUNNER_LINK_PORT=3443
nz_listeners() { printf 'tcp 0.0.0.0:22\n'; }
nz_migration_undo() { echo "undo"; exit 1; }
nz_migration_ports_free && echo "free"`);
    expect(free.out).toContain("free");
  });
});

describe("Docker after a full upgrade replaced the kernel (C2-22, Arch)", () => {
  test("Docker that can't start then is reported as needing a reboot, not just as not running", async () => {
    const root = await mkdtemp(join(dir, "kernel-"));
    await Bun.$`mkdir -p ${root}/usr/lib/modules/6.12.1-arch1-1`.quiet();
    const run = await callFunction(`
export NZ_ROOT=${root}
uname() { echo 6.10.3-arch1-1; }
nz_has() { [ "$1" = docker ]; }
nz_docker_running() { return 1; }
nz_start_docker_service() { return 1; }
nz_step_start() { :; }
nz_ensure_compose_plugin() { :; }
(nz_ensure_docker) 2>&1`);
    expect(run.out).toContain(
      "Docker is installed but can't start until this server reboots: the package upgrade installed a new kernel and removed the running kernel's modules (6.10.3-arch1-1), which Docker needs.",
    );
    expect(run.out).toContain("Reboot the server, then run the install command again.");
    // With the running kernel's modules in place, the usual message.
    await Bun.$`mkdir -p ${root}/usr/lib/modules/6.10.3-arch1-1`.quiet();
    const plainFailure = await callFunction(`
export NZ_ROOT=${root}
uname() { echo 6.10.3-arch1-1; }
nz_has() { [ "$1" = docker ]; }
nz_docker_running() { return 1; }
nz_start_docker_service() { return 1; }
nz_step_start() { :; }
(nz_ensure_docker) 2>&1`);
    expect(plainFailure.out).toContain(
      "Docker is installed but isn't running, and it couldn't be started.",
    );
  });
});

describe("a rerun updates the host's runner after its long work (C2-10)", () => {
  async function start(answers: string[], saved = 1) {
    const file = join(await mkdtemp(join(dir, "host-work-")), "answers");
    await writeFile(file, `${answers.join("\n")}\n`);
    return callFunction(`NZ_HAVE_SAVED=${saved} NZ_FINAL_COMPOSE_PROFILES=database,router NZ_FINAL_NEARZERO_STARTUP_TIMEOUT=300
NZ_FINAL_NEARZERO_ENABLE_MANAGED_DNS=
NZ_HOST_WORK_WAIT=2
nz_step_start() { :; }
nz_step_done() { :; }
nz_retire_old_names() { :; }
nz_ensure_shared_objects() { :; }
nz_container_running() { [ "$1" = nearzero-runner ] || [ "$1" = nearzero-router ]; }
nz_run() { echo "run: $*"; }
sleep() { command sleep 0.1; }
docker() { case "$*" in *Health*) echo healthy ;; *) echo 0 ;; esac; }
nz_compose() {
  case "$*" in
    "exec -T control nearzero-control host-work --json")
      head -n 1 ${file}; [ "$(wc -l < ${file})" -gt 1 ] && sed -i.bak 1d ${file} ;;
    *) echo "compose $*" ;;
  esac
}
nz_start
echo "note=$NZ_HOST_WORK_NOTE"`);
  }

  test("the control plane first, the runner once the host's task runs and backups are done", async () => {
    const run = await start([
      '{"taskRuns":1,"backups":1,"restores":0}',
      '{"taskRuns":1,"backups":0,"restores":0}',
      '{"taskRuns":0,"backups":0,"restores":0}',
    ]);
    const lines = run.out.split("\n");
    const control = lines.indexOf("run: nz_compose up -d --no-build postgres control");
    const runner = lines.indexOf("run: nz_compose up -d --no-build runner");
    expect(control).toBeGreaterThanOrEqual(0);
    expect(runner).toBeGreaterThan(control);
    expect(run.out).toContain(
      "Starting Nearzero (waiting for 1 task run, 1 backup on this server to finish before updating its runner, up to 0 minutes)",
    );
    expect(run.out).toContain("note=\n");
  });

  test("work still running after the wait is said in the summary; a first install doesn't wait", async () => {
    const run = await start(['{"taskRuns":2,"backups":0,"restores":1}']);
    expect(run.out).toContain(
      "note=The host's runner was updated while 2 task runs, 1 restore still ran on this server; they stopped there, and their runs say so.",
    );
    const first = await start(['{"taskRuns":2,"backups":0,"restores":0}'], 0);
    expect(first.out).toContain("run: nz_compose up -d --no-build postgres control runner");
    expect(first.out).not.toContain("waiting for");
    // A control plane that can't count isn't waited for.
    const old = await start(["Unknown command: host-work"]);
    expect(old.out).toContain("run: nz_compose up -d --no-build runner");
    expect(old.out).not.toContain("waiting for");
  });
});

describe("images from a private registry, and Docker Hub with a login (C2-17)", () => {
  test("an image whose registry has a docker login is pulled with the CLI and that login", async () => {
    const home = await mkdtemp(join(dir, "home-"));
    await Bun.$`mkdir -p ${home}/.docker`.quiet();
    await writeFile(
      join(home, ".docker/config.json"),
      JSON.stringify({
        auths: {
          "registry.example.com": { auth: "dTpw" },
          "https://index.docker.io/v1/": { auth: "dTpw" },
        },
      }),
    );
    const which = (ref: string) =>
      callFunction(`HOME=${home}; nz_login_config_for '${ref}' && echo " login" || echo "none"`);
    expect((await which("registry.example.com/team/nearzero:1.0.0")).out).toBe(
      `${home}/.docker login\n`,
    );
    expect((await which("postgres:18.6-alpine")).out).toBe(`${home}/.docker login\n`);
    expect((await which("ghcr.io/nearzero-systems/nearzero:1.0.0")).out).toBe("none\n");
    expect(
      (
        await callFunction(
          "nz_registry_of localhost:5000/nz1/nearzero:1; echo; nz_registry_of traefik:v3.7.18; echo; nz_registry_of library/postgres:18; echo",
        )
      ).out,
    ).toBe("localhost:5000\ndocker.io\ndocker.io\n");
    // A credential store holds logins outside the file: the CLI is used.
    await writeFile(join(home, ".docker/config.json"), JSON.stringify({ credsStore: "pass" }));
    expect((await which("ghcr.io/nearzero-systems/nearzero:1.0.0")).out).toBe(
      `${home}/.docker login\n`,
    );
  });

  test("an image that can't be downloaded but is already on this server is used", async () => {
    const run = await callFunction(`
NZ_DIR=$(mktemp -d)
NZ_LOG=/dev/null
NZ_IMAGES="private.example.com/team/nearzero:1.0.0 traefik:v3.7.18"
nz_images_for_profiles() { :; }
nz_docker_socket() { :; }
nz_login_config_for() { return 1; }
docker() {
  case "$*" in
    "image inspect private.example.com/team/nearzero:1.0.0") return 0 ;;
    "image inspect "*) return 1 ;;
    "pull private.example.com/"*) echo "unauthorized" >&2; return 1 ;;
    pull*) return 0 ;;
  esac
}
(nz_pull_images) 2>&1; echo "exit=$?"`);
    expect(run.out).toContain("Downloaded Nearzero");
    expect(run.out).toContain("exit=0");
  });
});

describe("SELinux on the Nearzero host (C2-08)", () => {
  test("the runner isn't confined (it holds the Docker socket); the DNS server's folder is relabelled", async () => {
    const compose = await Bun.file(PATHS.compose).text();
    const runner = compose.slice(compose.indexOf("\n  runner:\n"), compose.indexOf("\n  dns:\n"));
    expect(runner).toMatch(/security_opt:\n {6}- no-new-privileges:true\n {6}- label=disable\n/);
    expect(runner).toContain("- /var/run/docker.sock:/var/run/docker.sock");
    const dns = compose.slice(compose.indexOf("\n  dns:\n"));
    expect(dns).toContain("- ./dns:/etc/nearzero/dns:ro,z");
    // The control plane and the database use named volumes only, which Docker labels itself.
    const control = compose.slice(
      compose.indexOf("\n  control:\n"),
      compose.indexOf("\n  postgres:\n"),
    );
    expect(control).not.toMatch(/- \.\//);
    expect(control).not.toContain("label=disable");
  });
});

describe("the nearzero command's place (B2-11)", () => {
  test("it is linked into /usr/bin, which sudo's secure_path keeps on RHEL and Amazon Linux", async () => {
    const root = await mkdtemp(join(dir, "command-"));
    await Bun.$`mkdir -p ${root}/usr/local/bin ${root}/usr/bin`.quiet();
    const run = await callFunction(`
NZ_COMMAND_PATH=${root}/usr/local/bin/nearzero
NZ_COMMAND_LINK=${root}/usr/bin/nearzero
nz_install_command && nz_install_command && readlink "$NZ_COMMAND_LINK" && "$NZ_COMMAND_LINK" help | head -n 1`);
    expect(run.code).toBe(0);
    expect(run.out).toContain(`${root}/usr/local/bin/nearzero`);
    expect(run.out).toContain("Usage: sudo nearzero [command]");
    // Someone else's /usr/bin/nearzero is left alone.
    await Bun.$`rm -f ${root}/usr/bin/nearzero`.quiet();
    await Bun.write(join(root, "usr/bin/nearzero"), "#!/bin/sh\necho theirs\n");
    const kept = await callFunction(`
NZ_COMMAND_PATH=${root}/usr/local/bin/nearzero
NZ_COMMAND_LINK=${root}/usr/bin/nearzero
nz_install_command && cat "$NZ_COMMAND_LINK"`);
    expect(kept.out).toContain("echo theirs");
  });
});

describe("the public IP on a rerun (B2-25)", () => {
  const decide = (saved: string) =>
    callFunction(`${saved}
nz_local_ipv4() { printf '93.184.215.9'; }
nz_decide_public_ip
echo "ip=$NZ_PUBLIC_IP detected=$NZ_FINAL_NEARZERO_PUBLIC_IP_DETECTED"`);

  test("a detected address is detected again; one a person set is kept; the environment wins", async () => {
    const detectedBefore = await decide(
      "NZ_SAVED_NEARZERO_PUBLIC_IP=93.184.215.1\nNZ_SAVED_NEARZERO_PUBLIC_IP_DETECTED=true",
    );
    expect(detectedBefore.out).toContain("ip=93.184.215.9 detected=true");
    const setBefore = await decide("NZ_SAVED_NEARZERO_PUBLIC_IP=93.184.215.1");
    expect(setBefore.out).toContain("ip=93.184.215.1 detected=");
    const given = await decide(
      "NZ_ENV_NEARZERO_PUBLIC_IP=93.184.215.2\nNZ_SAVED_NEARZERO_PUBLIC_IP_DETECTED=true",
    );
    expect(given.out).toContain("ip=93.184.215.2 detected=");
  });

  test("C2-15: a saved detected address is kept when detecting it again fails or finds a private one", async () => {
    const saved =
      "NZ_SAVED_NEARZERO_PUBLIC_IP=34.120.1.2\nNZ_SAVED_NEARZERO_PUBLIC_IP_DETECTED=true";
    const failed = await callFunction(`${saved}
nz_local_ipv4() { printf '10.0.0.5'; }
nz_lookup_public_ipv4() { return 1; }
nz_decide_public_ip
echo "ip=$NZ_PUBLIC_IP detected=$NZ_FINAL_NEARZERO_PUBLIC_IP_DETECTED"`);
    expect(failed.out).toContain("ip=34.120.1.2 detected=true");
    const privateOnly = await callFunction(`${saved}
nz_local_ipv4() { printf '10.0.0.5'; }
nz_lookup_public_ipv4() { printf '100.64.0.9'; }
nz_decide_public_ip
echo "ip=$NZ_PUBLIC_IP"`);
    expect(privateOnly.out).toContain("ip=34.120.1.2");
    // A new public address found now still wins.
    const moved = await callFunction(`${saved}
nz_local_ipv4() { printf '10.0.0.5'; }
nz_lookup_public_ipv4() { printf '34.120.9.9'; }
nz_decide_public_ip
echo "ip=$NZ_PUBLIC_IP"`);
    expect(moved.out).toContain("ip=34.120.9.9");
  });
});

describe("the install folder on a real run (B2-26)", () => {
  /**
   * main up to the point where the folder is chosen, as a real run (no dry run): root and the
   * platform checks are shell functions, and the platform check prints the folder and stops.
   */
  async function chosenFolder(env: Record<string, string>, before = ""): Promise<Run> {
    const source = (await Bun.file(PATHS.install).text()).replace(/\nmain "\$@"\n$/, "\n");
    const run = await runBash(
      `${source}
nz_require_root() { :; }
${before}
nz_detect_platform() { printf 'dir=%s env=%s\\n' "$NZ_DIR" "$NZ_ENV_FILE"; exit 0; }
main`,
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", NEARZERO_UNATTENDED: "true", ...env },
        stdin: "ignore",
      },
    );
    return { code: run.code, out: run.stdout + run.stderr };
  }

  test("C2-18: Nearzero's own folder without its settings file isn't called someone else's", async () => {
    const root = await mkdtemp(join(dir, "lost-env-"));
    await Bun.$`mkdir -p ${root}/opt/nearzero/router`.quiet();
    await Bun.write(join(root, "opt/nearzero/compose.yml"), "# Nearzero\nname: nearzero1\n");
    await Bun.write(join(root, "opt/nearzero/install.log"), "");
    const run = await chosenFolder({ NEARZERO_INSTALL_DIR: `${root}/opt/nearzero` });
    expect(run.out).not.toContain("which already holds other files");
    expect(run.out).toContain(`dir=${root}/opt/nearzero`);
    // Someone else's files are still refused.
    const other = await mkdtemp(join(dir, "other-"));
    await Bun.write(join(other, "notes.txt"), "mine");
    const refused = await chosenFolder({ NEARZERO_INSTALL_DIR: other });
    expect(refused.out).toContain("which already holds other files");
  });

  test("NEARZERO_INSTALL_DIR and 0.1.x's INSTALL_DIR choose the folder, not only in dry runs", async () => {
    const root = await mkdtemp(join(dir, "folder-"));
    const named = await chosenFolder({ NEARZERO_INSTALL_DIR: `${root}/srv/nearzero/` });
    expect(named.code).toBe(0);
    expect(named.out).toContain(`dir=${root}/srv/nearzero env=${root}/srv/nearzero/.env`);
    const legacy = await chosenFolder({ INSTALL_DIR: `${root}/data/nearzero` });
    expect(legacy.out).toContain(`dir=${root}/data/nearzero env=${root}/data/nearzero/.env`);
  });

  test("a 0.1.x install kept elsewhere is found there, other files and all", async () => {
    const root = await mkdtemp(join(dir, "folder-"));
    await Bun.$`mkdir -p ${root}/srv/nearzero/postgres`.quiet();
    await Bun.write(join(root, "srv/nearzero/.env"), "NEARZERO_VERSION=0.1.80\n");
    const run = await chosenFolder({ INSTALL_DIR: `${root}/srv/nearzero` });
    expect(run.out).toContain(`dir=${root}/srv/nearzero env=${root}/srv/nearzero/.env`);
  });

  test("the installed command is written for the folder, and a rerun without the setting finds it", async () => {
    const root = await mkdtemp(join(dir, "folder-"));
    await Bun.$`mkdir -p ${root}/usr/local/bin ${root}/usr/bin ${root}/srv/nearzero`.quiet();
    const paths = `NZ_COMMAND_PATH=${root}/usr/local/bin/nearzero\nNZ_COMMAND_LINK=${root}/usr/bin/nearzero`;
    const installed = await callFunction(`${paths}
NZ_DIR=${root}/srv/nearzero
nz_install_command && grep '^NZC_DIR=' "$NZ_COMMAND_PATH" && "$NZ_COMMAND_PATH" help | grep backup-db`);
    expect(installed.code).toBe(0);
    expect(installed.out).toContain(`NZC_DIR="\${NEARZERO_INSTALL_DIR:-${root}/srv/nearzero}"`);
    expect(installed.out).toContain(`(default: ${root}/srv/nearzero/nearzero-db-<time>.sql)`);
    // The default folder leaves the command as it is embedded.
    const plain = await callFunction(`${paths}
nz_install_command && grep '^NZC_DIR=' "$NZ_COMMAND_PATH"`);
    expect(plain.out).toContain(`NZC_DIR="\${NEARZERO_INSTALL_DIR:-/opt/nearzero}"`);
    // A rerun with no setting uses the folder the installed command names.
    await callFunction(`${paths}\nNZ_DIR=${root}/srv/nearzero\nnz_install_command`);
    await Bun.write(join(root, "srv/nearzero/.env"), "NEARZERO_EDITION=1\n");
    const rerun = await chosenFolder({}, paths);
    expect(rerun.out).toContain(`dir=${root}/srv/nearzero env=${root}/srv/nearzero/.env`);
  });

  test("a folder that isn't Nearzero's alone, or isn't a plain absolute path, is refused", async () => {
    const root = await mkdtemp(join(dir, "folder-"));
    await Bun.$`mkdir -p ${root}/home/someone`.quiet();
    await Bun.write(join(root, "home/someone/notes.txt"), "mine\n");
    await Bun.write(join(root, "afile"), "x\n");
    const busy = await chosenFolder({ NEARZERO_INSTALL_DIR: `${root}/home/someone` });
    expect(busy.code).toBe(1);
    expect(busy.out).toContain(
      `NEARZERO_INSTALL_DIR is ${root}/home/someone, which already holds other files. Nearzero needs a folder of its own (uninstalling deletes it): name a new or empty folder, such as ${root}/home/someone/nearzero.`,
    );
    const file = await chosenFolder({ NEARZERO_INSTALL_DIR: `${root}/afile` });
    expect(file.code).toBe(1);
    expect(file.out).toContain(
      `NEARZERO_INSTALL_DIR is ${root}/afile, which is a file, not a folder.`,
    );
    for (const given of ["/", "relative/nearzero", "//srv"]) {
      const run = await chosenFolder({ NEARZERO_INSTALL_DIR: given });
      expect(run.code).toBe(1);
      expect(run.out).toContain(
        "NEARZERO_INSTALL_DIR must be an absolute folder path such as /opt/nearzero",
      );
    }
    for (const given of ["/srv/a/../b", "/srv/a|b", "/srv/./x", "/srv/x@y"]) {
      const run = await chosenFolder({ NEARZERO_INSTALL_DIR: given });
      expect(run.code).toBe(1);
      expect(run.out).toContain("NEARZERO_INSTALL_DIR must be a plain absolute folder path");
    }
  });
});

describe("the admin account after a first install that stopped early (B2-27)", () => {
  // Docker as shell functions: running, with or without the database volume and the control plane.
  const docker = (volume: boolean, control: boolean) => `
docker() {
  case "$1 $2" in
    "info "*) return 0 ;;
    "volume inspect") ${volume ? "return 0" : "return 1"} ;;
    "inspect --format") ${control ? "echo true" : "echo false"} ;;
  esac
  return 0
}
nz_compose() { printf '{"owner":"exists","email":"kept@example.com"}\\n'; }
NZ_HAVE_SAVED=1
NZ_DRY_RUN=0`;

  test("a rerun with no database volume yet knows no account exists, so it asks", async () => {
    const run = await callFunction(`${docker(false, false)}
nz_probe_owner; echo "state=$NZ_OWNER_STATE"`);
    expect(run.out).toContain("state=missing");
    // Without Docker at all, the first run stopped before installing it.
    const noDocker = await callFunction(`NZ_HAVE_SAVED=1
NZ_DRY_RUN=0
nz_has() { [ "$1" != docker ] && command -v "$1" >/dev/null 2>&1; }
nz_probe_owner; echo "state=$NZ_OWNER_STATE"`);
    expect(noDocker.out).toContain("state=missing");
  });

  test("data that may hold an account keeps the answer to the running control plane", async () => {
    const stopped = await callFunction(`${docker(true, false)}
nz_probe_owner; echo "state=$NZ_OWNER_STATE"`);
    expect(stopped.out).toContain("state=unknown");
    const running = await callFunction(`${docker(true, true)}
nz_probe_owner; echo "state=$NZ_OWNER_STATE email=$NZ_OWNER_EMAIL"`);
    expect(running.out).toContain("state=exists email=kept@example.com");
    // An external database may hold accounts whatever is on this server.
    const external = await callFunction(`${docker(false, false)}
NZ_SAVED_NEARZERO_DATA_MODE=external
nz_probe_owner; echo "state=$NZ_OWNER_STATE"`);
    expect(external.out).toContain("state=unknown");
  });

  test("when it couldn't tell before starting and there is none, it asks once Nearzero runs", async () => {
    // create-owner --json: no input gives exit 2, an email and password create the account.
    const createOwner = `
nz_compose() {
  local email password
  IFS= read -r email || { printf '{"result":"no_input"}\\n'; return 2; }
  IFS= read -r password
  [ -n "$email" ] || { printf '{"result":"no_input"}\\n'; return 2; }
  printf '{"result":"created","email":"%s"}\\n' "$email"
}
nz_log() { :; }
nz_ask_account() { echo "asked for the account"; NZ_ADMIN_EMAIL=owner@example.com; NZ_ADMIN_PASSWORD=typed-password-123; }
`;
    const interactive = await callFunction(`${createOwner}
NZ_INTERACTIVE=1
nz_owner_step; echo "state=$NZ_OWNER_STATE email=$NZ_OWNER_EMAIL"`);
    expect(interactive.code).toBe(0);
    expect(interactive.out).toContain("asked for the account");
    expect(interactive.out).toContain("✓ Created your admin account");
    expect(interactive.out).toContain("state=created email=owner@example.com");
    expect(interactive.out).not.toContain("No admin account yet");
    // Unattended, it still says so and the summary names create-owner.
    const unattended = await callFunction(`${createOwner}
NZ_INTERACTIVE=0
nz_owner_step; echo "state=$NZ_OWNER_STATE"`);
    expect(unattended.out).not.toContain("asked for the account");
    expect(unattended.out).toContain("- No admin account yet");
    expect(unattended.out).toContain("state=missing");
  });
});

describe("the domain check asks public DNS (B2-28)", () => {
  // /etc/hosts on Debian and Ubuntu: the machine's hostname, the dashboard name here, is 127.0.1.1.
  const hosts = `getent() { printf '127.0.1.1       %s\\n' "$3"; }`;

  test("dig asks the public resolvers, never the machine's own lookup", async () => {
    const run = await callFunction(`${hosts}
dig() { printf '%s\\n' "$*" >>"$CALLS"; case "$*" in *@1.1.1.1*) echo 192.0.3.10 ;; esac; }
CALLS=$(mktemp)
NZ_PUBLIC_IP=192.0.3.10
nz_check_dns example.com nearzero.example.com && echo "points here"
cat "$CALLS"; rm -f "$CALLS"`);
    expect(run.out).toContain("points here");
    expect(run.out).not.toContain("127.0.1.1");
    expect(run.out).toMatch(/A nearzero\.example\.com @1\.1\.1\.1/);
  });

  test("the next resolver is asked when one doesn't answer", async () => {
    const run = await callFunction(`${hosts}
dig() { case "$*" in *@1.1.1.1*) echo ';; connection timed out; no servers could be reached' ;; *@8.8.8.8*) echo 192.0.3.10 ;; esac; }
nz_resolve nearzero.example.com`);
    expect(run.out.trim()).toBe("192.0.3.10");
  });

  test("without dig, nslookup asks them; without either, their HTTPS answer is read", async () => {
    const nslookup = await callFunction(`${hosts}
nz_has() { [ "$1" != dig ] && command -v "$1" >/dev/null 2>&1; }
nslookup() {
  [ "$2" = 1.1.1.1 ] || return 1
  printf 'Server:\\t\\t1.1.1.1\\nAddress:\\t1.1.1.1#53\\n\\nNon-authoritative answer:\\nName:\\t%s\\nAddress: 192.0.3.10\\n' "$1"
}
nz_resolve nearzero.example.com`);
    expect(nslookup.out.trim()).toBe("192.0.3.10");
    const https = await callFunction(`${hosts}
nz_has() { [ "$1" = curl ] || [ "$1" = getent ]; }
curl() {
  case "$*" in *"https://cloudflare-dns.com/dns-query?name=nearzero.example.com&type=A"*) ;; *) return 1 ;; esac
  printf '{"Status":0,"Answer":[{"name":"nearzero.example.com","type":5,"TTL":300,"data":"edge.example.net."},{"name":"edge.example.net","type":1,"TTL":300,"data":"192.0.3.10"}]}'
}
nz_resolve nearzero.example.com`);
    expect(https.out.trim()).toBe("192.0.3.10");
    // With nothing but the system's lookup, its loopback answers are left out.
    const only = await callFunction(`${hosts}
nz_has() { [ "$1" = getent ]; }
nz_resolve nearzero.example.com; echo "end"`);
    expect(only.out.trim()).toBe("end");
  });
});

describe("the public IP lookup (B2-32)", () => {
  test("the HTTPS address echo is asked only when no DNS tool is installed", async () => {
    const curl = `curl() { echo "echo service asked" >&2; echo 203.0.113.9; }`;
    const silent = await callFunction(`${curl}
dig() { :; }
nslookup() { return 1; }
nz_lookup_public_ipv4; echo "end"`);
    expect(silent.out.trim()).toBe("end");
    const noTools = await callFunction(`${curl}
nz_has() { [ "$1" = curl ]; }
nz_lookup_public_ipv4; echo; echo "end"`);
    expect(noTools.out).toContain("203.0.113.9");
  });
});

describe("a port in use is named with what holds it (B2-30)", () => {
  // Port 80 is nginx's, 443 Docker's proxy for a container, 4321 a program root can't see.
  const server = `
ss() {
  case "$*" in
    "-H -lntu")
      printf 'tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:*\\ntcp LISTEN 0 4096 0.0.0.0:443 0.0.0.0:*\\ntcp LISTEN 0 5 [::]:4321 [::]:*\\nudp UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:*\\n' ;;
    *"sport = :80") echo 'LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1234,fd=6),("nginx",pid=1235,fd=6))' ;;
    *"sport = :443") echo 'LISTEN 0 4096 0.0.0.0:443 0.0.0.0:* users:(("docker-proxy",pid=2001,fd=7))' ;;
    *"sport = :4321") echo 'LISTEN 0 5 [::]:4321 [::]:*' ;;
    "-H -lnp -u sport = :53") echo 'UNCONN 0 0 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=500,fd=13))' ;;
    "-H -lnp -t sport = :53") echo 'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=500,fd=14))' ;;
  esac
}
docker() {
  case "$1 $2" in
    "info "*) return 0 ;;
    "inspect --format") echo false ;;
    "ps --filter") [ "$3" = "publish=443/tcp" ] && echo web ;;
  esac
  return 0
}
nz_stop() { printf '%s\\n' "$@"; exit 1; }
NZ_DRY_RUN=0
NZ_FINAL_NEARZERO_HTTP_PORT=80
NZ_FINAL_NEARZERO_HTTPS_PORT=443
NZ_FINAL_NEARZERO_CONSOLE_PORT=4321
NZ_FINAL_NEARZERO_API_PORT=3000
NZ_FINAL_NEARZERO_RUNNER_LINK_PORT=3443`;

  test("ss names the program, or the container Docker's proxy publishes the port for", async () => {
    const run = await callFunction(`${server}\nnz_check_ports`);
    expect(run.code).toBe(1);
    expect(run.out).toContain(
      "Nearzero needs TCP ports 80, 443, 4321, 3000 and 3443, and these are already in use on this server: 80 (nginx), 443 (the container web), 4321.",
    );
  });

  test("netstat names it where ss isn't installed (BusyBox, older systems)", async () => {
    const run = await callFunction(`${server}
nz_has() { [ "$1" != ss ] && command -v "$1" >/dev/null 2>&1; }
netstat() {
  case "$*" in
    "-lntu") printf 'Active Internet connections (only servers)\\nProto Recv-Q Send-Q Local Address Foreign Address State\\ntcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN\\n' ;;
    "-lnp -t") printf 'Active Internet connections (only servers)\\nProto Recv-Q Send-Q Local Address Foreign Address State PID/Program name\\ntcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN 1234/caddy\\ntcp 0 0 0.0.0.0:8080 0.0.0.0:* LISTEN 99/other\\n' ;;
  esac
}
nz_check_ports`);
    expect(run.code).toBe(1);
    expect(run.out).toContain("already in use on this server: 80 (caddy).");
  });

  test("port 53 names its holder over UDP and TCP once", async () => {
    const run = await callFunction(`${server}\nnz_stop_port_53`);
    expect(run.out).toContain(
      "The built-in DNS server needs TCP and UDP port 53, and systemd-resolve already listens there.",
    );
  });
});
