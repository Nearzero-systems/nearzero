import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VERSION } from "@nearzero/shared";
import { $ } from "bun";
import { createBundle } from "../../apps/control/src/migration/bundle.ts";
import {
  HOST,
  inHost,
  mustInHost,
  PLATFORM,
  plain,
  pushToHostRegistry,
  REGISTRY_IMAGE,
  removeHost,
  startHost,
  TerminalSession,
} from "./host.ts";

/**
 * The install suite (spec 03 3.1–3.4, 26.3), run locally against a Docker-in-Docker host:
 *
 *   bun run --cwd e2e test:install          (NZ1_E2E_KEEP=1 keeps the host for a look afterwards;
 *                                            NZ1_E2E_HOST and NZ1_E2E_IMAGE rename the host and image;
 *                                            NZ1_E2E_PREBUILT=1 tests an image built just before)
 *
 * It builds the production image (linux/arm64), puts it in a registry inside the host, and runs
 * the real install.sh there with `cat install.sh | bash`, typing answers only once each prompt
 * shows. Scenarios, in order: an interactive install without a domain, the nearzero command,
 * an interactive rerun that upgrades in place, uninstall, an unattended install with only an
 * email, a final uninstall, and moving a stand-in 0.1.x install to 1.0, back, and again
 * (spec 29). Logs go to e2e/.work/, which never reaches an image.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `install-${Date.now().toString(36)}`);
const IMAGE = process.env.NZ1_E2E_IMAGE ?? "nz1-nearzero:e2e";
const HOST_IMAGE = `localhost:5000/nz1/nearzero:${VERSION}`;
const PUBLIC_IP = "192.0.3.10";
const OWNER = "owner@nz1-e2e.example.com";
const OWNER_PASSWORD = "first-Password-for-e2e";
const KEEP = process.env.NZ1_E2E_KEEP === "1";
// 1.0's own label and Compose project (spec 29.5 "No shared names with 0.1.x").
const LABEL = "dev.nearzero.edition=1";

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

/** Proves an account's password works, by signing in through the console's API. */
async function passwordWorks(email: string, password: string): Promise<boolean> {
  const result = await inHost(
    "curl -sS -o /dev/null -w '%{http_code}' -H 'content-type: application/json' --data @- http://127.0.0.1:4321/api/v1/auth/sign-in",
    { stdin: JSON.stringify({ email, password }) },
  );
  return result.out.trim() === "200";
}

/** SHA-256 of the certificate the runner link's TLS port (3443) serves, from the port itself. */
async function servedLinkFingerprint(): Promise<string> {
  return (
    await mustInHost(
      "openssl s_client -connect 127.0.0.1:3443 </dev/null 2>/dev/null | openssl x509 -outform der | sha256sum | cut -d' ' -f1",
    )
  ).trim();
}

async function savedLinkFingerprint(): Promise<string> {
  return (
    await mustInHost("docker exec nearzero-control cat /var/lib/nearzero/runner-link/fingerprint")
  ).trim();
}

async function containerId(name: string): Promise<string> {
  return (await mustInHost(`docker inspect --format '{{.Id}}' ${name}`)).trim();
}

async function nothingLabeledLeft(): Promise<string> {
  return (
    await mustInHost(
      `docker ps -aq --filter label=${LABEL}; docker volume ls -q --filter label=${LABEL}; docker network ls -q --filter label=${LABEL}; docker ps -aq --filter label=com.docker.compose.project=nearzero1`,
    )
  ).trim();
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  // The harness builds what it tests; it never runs a stale build. NZ1_E2E_PREBUILT=1 uses an
  // image built from this checkout just before (a busy machine, where a second build is slow).
  if (process.env.NZ1_E2E_PREBUILT !== "1") {
    await $`docker build --platform ${PLATFORM} -t ${IMAGE} ${ROOT}`.quiet();
  }
  // The owner commands are the control plane's own (create-owner, reset-password, reset-2fa).
  const accountCommands =
    await $`docker run --rm --platform ${PLATFORM} --entrypoint sh ${IMAGE} -c "test -f /app/control/cli.js"`
      .quiet()
      .nothrow();
  if (accountCommands.exitCode !== 0) {
    throw new Error("The image has no /app/control/cli.js, so the owner commands can't be tested.");
  }

  await startHost();
  await mustInHost("apk add --no-cache -q bash curl util-linux-misc shellcheck openssl >/dev/null");
  await mustInHost(
    `docker run -d --name nz1-registry --restart always -p 127.0.0.1:5000:5000 ${REGISTRY_IMAGE} >/dev/null`,
  );
  await pushToHostRegistry(IMAGE, HOST_IMAGE);
  // Unrelated things that must survive an uninstall.
  await mustInHost(
    `docker volume create nz1-unrelated-data >/dev/null && docker create --name nz1-unrelated -v nz1-unrelated-data:/data ${REGISTRY_IMAGE} >/dev/null && docker run --rm -v nz1-unrelated-data:/data --entrypoint sh ${REGISTRY_IMAGE} -c 'echo keep > /data/marker'`,
  );
  // Make the host lack the Compose plugin, so the installer must fetch and check its own.
  await mustInHost(
    "mv /usr/local/libexec/docker/cli-plugins/docker-compose /root/compose-from-image",
  );
  await mustInHost("mkdir -p /root/nz1");
  // The host's time zone, as Debian and Ubuntu keep it; the installer passes it to the runner.
  await mustInHost("echo Europe/Berlin > /etc/timezone");
  for (const file of [
    "installer/install.sh",
    "installer/uninstall.sh",
    "installer/nearzero",
    "container/nearzero-control",
  ]) {
    await $`docker cp ${join(ROOT, file)} ${HOST}:/root/nz1/`.quiet();
  }
  // Loading the image into the host takes long on a busy machine.
}, 1_800_000);

afterAll(async () => {
  if (KEEP) {
    console.log(`Kept ${HOST} for inspection; remove it with: docker rm -fv ${HOST}`);
    return;
  }
  await removeHost();
  await $`docker image rm ${IMAGE}`.quiet().nothrow();
}, 120_000);

describe("the image", () => {
  test("carries the runner for every server, matching SHA256SUMS (spec 09 9.3 step 6)", async () => {
    // Server setup reads them from NEARZERO_RUNNER_BINARIES_DIR, by default /app/runner-binaries.
    const listing =
      await $`docker run --rm --platform ${PLATFORM} --entrypoint sh ${IMAGE} -c ${'cd /app/runner-binaries && ls && for f in *.gz; do gunzip -c "$f" > "/tmp/$(basename "$f" .gz)"; done && cd /tmp && sha256sum -c /app/runner-binaries/SHA256SUMS'}`
        .quiet()
        .nothrow();
    const out = listing.stdout.toString();
    expect(listing.exitCode).toBe(0);
    for (const file of [
      "nearzero-runner-linux-x64",
      "nearzero-runner-linux-arm64",
      "nearzero-runner-linux-x64-musl",
      "nearzero-runner-linux-arm64-musl",
    ]) {
      expect(out).toContain(`${file}.gz`);
      expect(out).toContain(`${file}: OK`);
    }
    expect(out).toContain("SHA256SUMS");
    // Each starts on its own C library: glibc builds must not ask for musl's loader.
    const loaders =
      await $`docker run --rm --platform ${PLATFORM} --entrypoint sh ${IMAGE} -c ${'cd /app/runner-binaries && for f in *.gz; do printf "%s " "$f"; gunzip -c "$f" | head -c 65536 | grep -a -o "/ld-[a-z0-9_-]*" | head -n 1; done'}`
        .quiet()
        .nothrow();
    const lines = loaders.stdout.toString();
    expect(lines).toContain("nearzero-runner-linux-x64.gz /ld-linux-x86-64");
    expect(lines).toContain("nearzero-runner-linux-arm64.gz /ld-linux-aarch64");
    expect(lines).toContain("nearzero-runner-linux-x64-musl.gz /ld-musl-x86_64");
    expect(lines).toContain("nearzero-runner-linux-arm64-musl.gz /ld-musl-aarch64");
  }, 300_000);
});

describe("installer scripts", () => {
  test("pass shellcheck", async () => {
    for (const file of ["install.sh", "uninstall.sh", "nearzero", "nearzero-control"]) {
      const result = await inHost(`shellcheck -S warning /root/nz1/${file}`);
      expect(result.out).toBe("");
      expect(result.code).toBe(0);
    }
  });
});

describe("an interactive install without a domain", () => {
  let session: TerminalSession;

  test("asks its questions on the terminal, checks every answer, and installs", async () => {
    session = new TerminalSession("cat /root/nz1/install.sh | bash", {
      NEARZERO_IMAGE: HOST_IMAGE,
      NEARZERO_PUBLIC_IP: PUBLIC_IP,
    });
    await session.expect("Self-hosted Platform as a Service · Community Edition");
    await session.expect("Create your admin account");
    await session.expect("Email: ");
    session.type("not-an-email");
    await session.expect("Enter a valid email address, like you@company.com.");
    await session.expect("Email: ");
    session.type(OWNER);
    await session.expect("Password (8+ characters): ");
    session.type("short");
    await session.expect("Use 8 to 128 characters.");
    await session.expect("Password (8+ characters): ");
    session.type(OWNER_PASSWORD);
    await session.expect("Confirm password: ");
    session.type("something-else-entirely");
    await session.expect("The passwords don't match. Try again.");
    await session.expect("Password (8+ characters): ");
    session.type(OWNER_PASSWORD);
    await session.expect("Confirm password: ");
    session.type(OWNER_PASSWORD);

    await session.expect("Add a domain for HTTPS on the dashboard and your apps? [y/N] ");
    session.type("maybe");
    await session.expect("Answer y or n.");
    await session.expect("[y/N] ");
    session.type("y");
    await session.expect("Domain, like example.com or apps.example.com (Enter to skip): ");
    session.type("203.0.113.9");
    await session.expect("Enter a domain name only, like example.com.");
    await session.expect("(Enter to skip): ");
    session.type("*.nz1-e2e-check.example.com");
    await session.expect("Dashboard address [nearzero.nz1-e2e-check.example.com]: ");
    session.type("");
    await session.expect(`*.nz1-e2e-check.example.com`);
    await session.expect(
      "and allow inbound TCP 80 and 443, and UDP 443 for HTTP/3, to this server.",
    );
    await session.expect('Press Enter once they exist, or "skip": ');
    session.type("");
    await session.expect(`, not ${PUBLIC_IP}.`);
    await session.expect("Once a domain is set you sign in there, so DNS has to be right first.");
    await session.expect('"skip" to go on without a domain, or "use" to keep it anyway: ');
    session.type("skip");
    await session.expect("Skipped. Run this install command again to add one.");

    const code = await session.exit();
    await log("1-interactive-install", session.output);
    expect(code).toBe(0);
    const out = session.output;
    expect(out).toContain("✓ Saved the configuration in /opt/nearzero");
    expect(out).toContain("✓ Docker is installed");
    expect(out).toMatch(/Downloading Nearzero: \d+% · \d of 3 images · \dm \d\ds/);
    expect(out).toContain("✓ Downloaded Nearzero");
    expect(out).toContain("✓ Nearzero is running");
    expect(out).toContain("✓ Created your admin account");
    expect(out).toContain("Nearzero is ready.");
    expect(out).toContain(`Open      http://${PUBLIC_IP}:4321`);
    expect(out).toContain(`Sign in   ${OWNER}`);
    expect(out).toContain("Then add your name and your workspace name when you first sign in.");
    expect(out).toContain("Firewall: allow TCP 4321");
    // Servers reach Nearzero over its own encrypted port, never 3000 (G3-01, C2-09).
    expect(out).toContain(
      "Servers you add reach Nearzero over an encrypted link on TCP 3443: allow it from them.",
    );
    expect(out).toMatch(
      /Its certificate's SHA-256 fingerprint: [0-9a-f]{64} \(setup and join commands carry it\)\./,
    );
    expect(out).toContain("Add a domain with HTTPS any time: run this install command again.");
    // Passwords are never echoed or printed.
    expect(out).not.toContain(OWNER_PASSWORD);
  }, 900_000);

  test("installed the pinned Compose plugin after checking its checksum", async () => {
    const version = await mustInHost("docker compose version --short");
    expect(version.trim()).toMatch(/^v?5\.7\.0$/);
    expect(await mustInHost("ls /usr/local/lib/docker/cli-plugins/")).toContain("docker-compose");
  });

  test("keeps secrets in owner-only files and never writes the password anywhere", async () => {
    expect(
      (await mustInHost("stat -c %a /opt/nearzero/.env /opt/nearzero/install.log")).trim(),
    ).toBe("600\n600");
    const env = await mustInHost("cat /opt/nearzero/.env");
    expect(env).toMatch(/^NEARZERO_AUTH_SECRET=[0-9a-f]{64}$/m);
    expect(env).toMatch(/^NEARZERO_DATABASE_PASSWORD=[0-9a-f]{48}$/m);
    expect(env).toContain(`NEARZERO_IMAGE=${HOST_IMAGE}`);
    expect(env).not.toContain("NEARZERO_PLATFORM_DOMAIN=");
    const leaks = await inHost(
      'grep -rlF -- "$(cat)" /opt/nearzero /usr/local/bin/nearzero /root /tmp /var/log 2>/dev/null; docker inspect nearzero-control | grep -cF -- "$(printf %s "$P")" || true',
      { stdin: OWNER_PASSWORD, env: { P: OWNER_PASSWORD } },
    );
    expect(leaks.out.trim()).toBe("0");
  });

  test("serves the API and the console on their ports, with the release version", async () => {
    const health = JSON.parse(await mustInHost("curl -fsS http://127.0.0.1:3000/api/v1/health"));
    expect(health).toMatchObject({ status: "ok", version: VERSION });
    const proxied = JSON.parse(await mustInHost("curl -fsS http://127.0.0.1:4321/api/v1/health"));
    expect(proxied.version).toBe(VERSION);
    expect(
      (await mustInHost("curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4321/")).trim(),
    ).toMatch(/^(200|30\d)$/);
    const listening = await mustInHost("netstat -ltn");
    expect(listening).toMatch(/0\.0\.0\.0:4321 /);
    expect(listening).toMatch(/0\.0\.0\.0:3000 /);
    expect(listening).toMatch(/:80 /);
    expect(listening).toMatch(/:443 /);
    // The bundled database is never published.
    expect(listening).not.toMatch(/:5432 /);
  });

  test("G3-01: serves the runner link on 3443 with the certificate it made and keeps", async () => {
    expect(await mustInHost("netstat -ltn")).toMatch(/0\.0\.0\.0:3443 /);
    const fingerprint = await savedLinkFingerprint();
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(await servedLinkFingerprint()).toBe(fingerprint);
    // The runner's routes and the health check only; nothing a browser uses.
    const health = JSON.parse(await mustInHost("curl -fsSk https://127.0.0.1:3443/api/v1/health"));
    expect(health.version).toBe(VERSION);
    expect(
      (
        await mustInHost(
          "curl -sk -o /dev/null -w '%{http_code}' https://127.0.0.1:3443/api/v1/auth/session",
        )
      ).trim(),
    ).toBe("404");
    // Its key is the control plane's alone; the certificate survives a restart.
    expect(
      (
        await mustInHost(
          "docker exec nearzero-control stat -c '%u %a' /var/lib/nearzero/runner-link/link.key",
        )
      ).trim(),
    ).toBe("10001 600");
    await mustInHost("docker restart nearzero-control >/dev/null");
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await inHost("curl -fsSk https://127.0.0.1:3443/api/v1/health")).code === 0) break;
      await Bun.sleep(2000);
    }
    expect(await servedLinkFingerprint()).toBe(fingerprint);
  }, 300_000);

  test("the admin account works and nobody can sign up without an invitation", async () => {
    expect(await passwordWorks(OWNER, OWNER_PASSWORD)).toBe(true);
    expect(await passwordWorks(OWNER, "not-the-password")).toBe(false);
    const register = await inHost(
      'curl -s -o /dev/null -w \'%{http_code}\' -H \'content-type: application/json\' --data \'{"email":"intruder@example.com","password":"intruder-password","name":"Intruder"}\' http://127.0.0.1:4321/api/v1/auth/register',
    );
    expect(register.out.trim()).toMatch(/^4\d\d$/);
  });

  test("the console renders the Agent page, its React chat included (spec 19.1)", async () => {
    // The image carries no node_modules: the console's server build must hold React, the
    // Markdown renderer and everything else the Agent page imports. Sign in, finish the owner's
    // onboarding through the API, then load the page the root address leads to.
    const jar = "/tmp/nz1-agent-cookies";
    const api = (path: string, body: string) =>
      mustInHost(
        `curl -fsS -c ${jar} -b ${jar} -H 'content-type: application/json' --data @- http://127.0.0.1:4321/api/v1/${path}`,
        { stdin: body },
      );
    await api("auth/sign-in", JSON.stringify({ email: OWNER, password: OWNER_PASSWORD }));
    const named = JSON.parse(
      await api(
        "onboarding/workspace",
        JSON.stringify({ name: "Maya Lopez", workspaceName: "Install Check" }),
      ),
    ) as { workspace: { slug: string } };
    await api("onboarding/skip-invitations", "{}");
    const root = await mustInHost(
      `curl -sS -b ${jar} -o /dev/null -w '%{http_code} %{redirect_url}' http://127.0.0.1:4321/`,
    );
    expect(root).toContain(`/${named.workspace.slug}/dashboard/agent`);
    const page = await inHost(
      `curl -sS -b ${jar} -w '\\n%{http_code}' http://127.0.0.1:4321/${named.workspace.slug}/dashboard/agent`,
    );
    await log("1-agent-page", page.out);
    expect(page.out.trim().split("\n").pop()).toBe("200");
    // The chat island was rendered on the server, not only shipped to the browser.
    expect(page.out).toContain("<astro-island");
    expect(page.out).toContain("Maya");
    const logs = await mustInHost("docker logs nearzero-control 2>&1 | tail -n 300");
    expect(logs).not.toContain("Cannot find package");
    expect(logs).not.toContain("SyntaxError");
    await mustInHost(`rm -f ${jar}`);
  });
});

describe("the host's runner", () => {
  async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await Bun.sleep(2000);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  test("enrolls itself and stays connected, with every capability dropped", async () => {
    const runner = JSON.parse(await mustInHost("docker inspect nearzero-runner"))[0];
    expect(runner.State.Running).toBe(true);
    expect(runner.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(runner.HostConfig.ReadonlyRootfs).toBe(true);
    await waitFor(
      "the host's runner to connect",
      async () =>
        (
          await inHost(
            `docker exec nearzero1-postgres psql -tA -U nearzero -d nearzero -c "select (credential_hash is not null)::text || (connected_at is not null)::text || (disconnected_at is null)::text from runner where server_id is null"`,
          )
        ).out.trim() === "truetruetrue",
      120_000,
    );
    // The join token was used once; the credential lives only in the runner's own volume.
    const credential = await mustInHost(
      "docker run --rm -v nearzero-runner-state:/state --entrypoint stat traefik:v3.7.18 -c %a /state/credential",
    );
    expect(credential.trim()).toBe("600");
  }, 180_000);

  test("reports the host's time zone by name, not a fixed offset (spec 08 8.3)", async () => {
    expect(await mustInHost("grep '^NEARZERO_TIME_ZONE=' /opt/nearzero/.env")).toBe(
      "NEARZERO_TIME_ZONE=Europe/Berlin\n",
    );
    expect(await mustInHost("docker exec nearzero-runner printenv TZ")).toBe("Europe/Berlin\n");
    expect(
      (
        await mustInHost(
          `docker exec nearzero1-postgres psql -tA -U nearzero -d nearzero -c "select system->>'timeZone' from runner where server_id is null"`,
        )
      ).trim(),
    ).toBe("Europe/Berlin");
  });

  test("runs a host task as root on the host itself (spec 12; B2-03)", async () => {
    // The API through the console, signed in as the owner, with a cookie jar inside the host.
    const api = async (method: string, path: string, body?: unknown) => {
      const result = await inHost(
        `curl -sS -b /tmp/nz-e2e-cookies -c /tmp/nz-e2e-cookies -X ${method} -H 'content-type: application/json' ${body === undefined ? "" : "--data @-"} http://127.0.0.1:4321/api/v1${path}`,
        body === undefined ? {} : { stdin: JSON.stringify(body) },
      );
      return JSON.parse(result.out || "{}");
    };
    await api("POST", "/auth/sign-in", { email: OWNER, password: OWNER_PASSWORD });
    const created = await api("POST", "/tasks", {
      name: "Who runs host tasks",
      place: "host",
      shell: "bash",
      cron: "0 3 * * *",
      script: "id -u\ntest -d /proc/1/root && echo host-namespaces",
      force: true,
    });
    expect(created.task?.id).toBeTruthy();
    const started = await api("POST", `/tasks/${created.task.id}/run`);
    const runId = started.run?.id as string;
    expect(runId).toBeTruthy();
    let run: { status: string; log?: string; open?: boolean } = { status: "running", open: true };
    await waitFor(
      "the host task to finish",
      async () => {
        run = (await api("GET", `/task-runs/${runId}`)).run ?? run;
        // Queued, then running: both are open (C1-09).
        return run.open === false;
      },
      120_000,
    );
    expect(run.status).toBe("succeeded");
    expect(run.log).toContain("host-namespaces");
    expect(run.log?.split("\n")).toContain("0");
    await api("DELETE", `/tasks/${created.task.id}`);
  }, 180_000);

  test("gives the router its certificate store (B2-02)", async () => {
    const user = (
      await mustInHost("docker inspect --format '{{.Config.User}}' nearzero-router")
    ).trim();
    expect(
      (await mustInHost("docker exec nearzero-router stat -c '%u:%g %a' /certificates")).trim(),
    ).toBe(`${user} 700`);
  });

  test("owns the router: created by the runner, not by compose, and restarted when stopped", async () => {
    const router = JSON.parse(await mustInHost("docker inspect nearzero-router"))[0];
    expect(router.Config.Labels["dev.nearzero.component"]).toBe("router");
    expect(router.Config.Labels["dev.nearzero.router-config"]).toMatch(/^[0-9a-f]{16}$/);
    expect(router.Config.Labels["com.docker.compose.project"]).toBeUndefined();
    expect(router.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(router.HostConfig.ReadonlyRootfs).toBe(true);
    expect(Object.keys(router.NetworkSettings.Networks)).toContain("nearzero-edge");
    // A stopped router is started again (spec 23.2).
    await mustInHost("docker stop nearzero-router >/dev/null");
    await waitFor(
      "the runner to start the router again",
      async () =>
        (
          await inHost("docker inspect --format '{{.State.Running}}' nearzero-router")
        ).out.trim() === "true",
      120_000,
    );
  }, 180_000);
});

describe("the nearzero command", () => {
  test("status shows the services; no argument means status", async () => {
    // Also reachable from /usr/bin, which sudo's secure_path keeps on RHEL (B2-11).
    expect((await mustInHost("readlink /usr/bin/nearzero")).trim()).toBe("/usr/local/bin/nearzero");
    const status = await mustInHost("nearzero status");
    expect(status).toContain(`Console: http://${PUBLIC_IP}:4321`);
    expect(status).toMatch(/control\s+running/);
    expect(status).toMatch(/postgres\s+running/);
    expect(status).toMatch(/runner\s+running/);
    expect(status).toMatch(/router\s+running/);
    expect(await mustInHost("nearzero")).toMatch(/control\s+running/);
  });

  test("refuses to run without root", async () => {
    await mustInHost("id nz1user >/dev/null 2>&1 || adduser -D nz1user");
    const result = await inHost("nearzero status", { user: "nz1user" });
    expect(result.code).toBe(1);
    expect(result.out).toContain("This command needs root. Run: sudo nearzero status");
  });

  test("help, unknown commands, unknown services and the 0.1.x placeholders", async () => {
    expect(await mustInHost("nearzero help")).toContain("Usage: sudo nearzero [command]");
    const unknown = await inHost("nearzero frobnicate");
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("Unknown command: frobnicate");
    const service = await inHost("nearzero logs nope");
    expect(service.out).toContain("There's no Nearzero service called nope.");
    const exported = await inHost("nearzero export");
    expect(exported.code).toBe(1);
    expect(exported.out).toContain("This server runs Nearzero 1.0, so there is nothing to export.");
    const nothing = await inHost("nearzero migrate rollback --yes");
    expect(nothing.code).toBe(1);
    expect(nothing.out).toContain("This server has no 0.1.x install to go back to.");
  });

  test("the owner commands answer scripts in JSON", async () => {
    const status = await mustInHost(
      "docker exec nearzero-control nearzero-control owner-status --json 2>/dev/null",
    );
    expect(JSON.parse(status)).toEqual({ owner: "exists", email: OWNER });
    const again = await inHost(
      "docker exec nearzero-control nearzero-control create-owner --json </dev/null 2>/dev/null",
    );
    expect(again.code).toBe(3);
    expect(JSON.parse(again.out)).toEqual({ result: "owner_exists", email: OWNER });
  });

  test("create-owner without a terminal reads stdin and refuses a second owner", async () => {
    const result = await inHost("nearzero create-owner", {
      stdin: "second@nz1-e2e.example.com\nanother-password-123\n",
    });
    expect(result.code).toBe(1);
    expect(result.out).toContain(`This server already has an owner: ${OWNER}`);
    expect(result.out).not.toContain("another-password-123");
  });

  test("reset-password reads the new password from stdin and never prints it", async () => {
    // Without a terminal it reads two lines: the account (empty: the owner), then the password.
    const result = await inHost("nearzero reset-password", { stdin: "\nreset-Password-e2e-2\n" });
    expect(result.out).toContain(`Password updated for ${OWNER}.`);
    expect(result.out).not.toContain("reset-Password-e2e-2");
    expect(await passwordWorks(OWNER, "reset-Password-e2e-2")).toBe(true);
    const short = await inHost("nearzero reset-password", { stdin: "\nshort\n" });
    expect(short.code).not.toBe(0);
    expect(short.out).toContain("Use a password between 8 and 128 characters.");
    const nobody = await inHost("nearzero reset-password nobody@example.com", {
      stdin: "whatever-password\n",
    });
    expect(nobody.out).toContain("No account exists for nobody@example.com.");
    await inHost("nearzero reset-password", { stdin: `\n${OWNER_PASSWORD}\n` });
  });

  test("backup-db writes an owner-only dump and restore-db brings the data back", async () => {
    await mustInHost(
      `docker exec nearzero1-postgres psql -q -U nearzero -d nearzero -c "create table nz1_marker (value int); insert into nz1_marker values (42);"`,
    );
    const path = (await mustInHost("nearzero backup-db")).trim();
    expect(path).toMatch(/^\/opt\/nearzero\/nearzero-db-\d{8}-\d{6}\.sql$/);
    expect((await mustInHost(`stat -c %a ${path}`)).trim()).toBe("600");
    expect(await mustInHost(`head -n 5 ${path}`)).toContain("PostgreSQL database dump");
    const missing = await inHost("nearzero backup-db /nowhere/dump.sql");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("backup destination directory does not exist: /nowhere");

    // What a newer version would add after the dump: a table referring to one the dump holds
    // (B2-09: the restore used to fail on it, or keep it and fail the next start).
    await mustInHost(
      `docker exec nearzero1-postgres psql -q -U nearzero -d nearzero -c "drop table nz1_marker; create table nz1_newer (id serial primary key, person_id uuid references person (id)); insert into nz1_newer (person_id) select id from person limit 1;"`,
    );
    const unconfirmed = await inHost(`nearzero restore-db ${path}`);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.out).toContain("No terminal to confirm on, so nothing was restored.");
    const restored = await inHost(`nearzero restore-db ${path} --yes`);
    expect(restored.out).toContain(`Restored the database from ${path}.`);
    expect(restored.code).toBe(0);
    expect(
      await mustInHost(
        `docker exec nearzero1-postgres psql -tA -U nearzero -d nearzero -c "select value from nz1_marker"`,
      ),
    ).toContain("42");
    // The newer table is gone: the dump replaced the data exactly.
    expect(
      (
        await mustInHost(
          `docker exec nearzero1-postgres psql -tA -U nearzero -d nearzero -c "select to_regclass('public.nz1_newer') is null"`,
        )
      ).trim(),
    ).toBe("t");
    expect(await passwordWorks(OWNER, OWNER_PASSWORD)).toBe(true);
    await mustInHost(`rm -f ${path}`);
  }, 300_000);

  test("a broken configuration file stops every command before it runs", async () => {
    await mustInHost(
      "cp -p /opt/nearzero/.env /root/env.saved && echo NEARZERO_IMAGE=other >> /opt/nearzero/.env",
    );
    const duplicate = await inHost("nearzero status");
    await mustInHost("cp -p /root/env.saved /opt/nearzero/.env");
    expect(duplicate.code).toBe(1);
    expect(duplicate.out).toContain(
      "duplicate NEARZERO_IMAGE in /opt/nearzero/.env; rerun the installer",
    );
    await mustInHost("grep -v '^NEARZERO_AUTH_SECRET=' /root/env.saved > /opt/nearzero/.env");
    const missing = await inHost("nearzero status");
    await mustInHost("cp -p /root/env.saved /opt/nearzero/.env && rm /root/env.saved");
    expect(missing.out).toContain(
      "missing NEARZERO_AUTH_SECRET in /opt/nearzero/.env; rerun the installer",
    );
  });
});

describe("running the install command again", () => {
  test("stops on a malformed line in .env, naming it", async () => {
    await mustInHost("echo 'this line is broken' >> /opt/nearzero/.env");
    const lines = Number.parseInt((await mustInHost("wc -l < /opt/nearzero/.env")).trim(), 10);
    const result = await inHost("cat /root/nz1/install.sh | bash");
    await mustInHost("sed -i '$d' /opt/nearzero/.env");
    expect(result.code).toBe(1);
    expect(result.out).toContain(`Line ${lines} of /opt/nearzero/.env isn't a KEY=value line.`);
    expect(result.out).not.toContain("this line is broken");
  }, 120_000);

  test("upgrades in place: only new questions, same data, owner and secrets", async () => {
    await mustInHost("echo NZ1_EXTRA_SETTING=keep-me >> /opt/nearzero/.env");
    const before = await mustInHost(
      "grep -E '^(NEARZERO_AUTH_SECRET|NEARZERO_DATABASE_PASSWORD)=' /opt/nearzero/.env",
    );
    const postgresId = await containerId("nearzero1-postgres");
    const routerId = await containerId("nearzero-router");
    const linkFingerprint = await savedLinkFingerprint();

    const session = new TerminalSession("cat /root/nz1/install.sh | bash");
    await session.expect(
      "Found Nearzero in /opt/nearzero: this run upgrades it and keeps its settings.",
    );
    // The domain is still unset, so that question is offered again; the account isn't asked.
    await session.expect("Add a domain for HTTPS on the dashboard and your apps? [y/N] ");
    session.type("");
    const code = await session.exit();
    await log("2-rerun", session.output);
    expect(code).toBe(0);
    expect(session.output).not.toContain("Create your admin account");
    expect(session.output).toContain("✓ Kept your admin account");
    expect(session.output).toContain(`Sign in   ${OWNER}`);

    expect(
      await mustInHost(
        "grep -E '^(NEARZERO_AUTH_SECRET|NEARZERO_DATABASE_PASSWORD)=' /opt/nearzero/.env",
      ),
    ).toBe(before);
    expect(await mustInHost("tail -n 1 /opt/nearzero/.env")).toBe("NZ1_EXTRA_SETTING=keep-me\n");
    expect(await containerId("nearzero1-postgres")).toBe(postgresId);
    expect(await containerId("nearzero-router")).toBe(routerId);
    // Every server pinned to the runner link's certificate keeps connecting (G3-01).
    expect(await savedLinkFingerprint()).toBe(linkFingerprint);
    expect(await servedLinkFingerprint()).toBe(linkFingerprint);
    expect(
      await mustInHost(
        `docker exec nearzero1-postgres psql -tA -U nearzero -d nearzero -c "select value from nz1_marker"`,
      ),
    ).toContain("42");
    expect(await passwordWorks(OWNER, OWNER_PASSWORD)).toBe(true);
    // The person's own line reaches the control plane.
    expect(await mustInHost("docker exec nearzero-control printenv NZ1_EXTRA_SETTING")).toBe(
      "keep-me\n",
    );
  }, 600_000);
});

describe("running the install command again without root", () => {
  test("re-runs itself through sudo, keeping the install settings", async () => {
    await mustInHost(
      "apk add --no-cache -q sudo >/dev/null && echo 'nz1user ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/nz1user && cp /root/nz1/install.sh /tmp/nz1-install.sh && chmod 0644 /tmp/nz1-install.sh",
    );
    const result = await inHost("cat /tmp/nz1-install.sh | bash", {
      user: "nz1user",
      env: { NEARZERO_STARTUP_TIMEOUT: "240" },
    });
    await log("2b-rerun-through-sudo", result.out);
    expect(result.code).toBe(0);
    expect(result.out).toContain("✓ Kept your admin account");
    expect(await mustInHost("grep '^NEARZERO_STARTUP_TIMEOUT=' /opt/nearzero/.env")).toBe(
      "NEARZERO_STARTUP_TIMEOUT=240\n",
    );
    // The temporary copy sudo ran is gone.
    expect((await mustInHost("ls /tmp")).includes("nearzero-install.")).toBe(false);
    await mustInHost("rm -f /tmp/nz1-install.sh");
  }, 600_000);
});

describe("adding a managed DNS zone on a rerun", () => {
  test("checks port 53, starts the built-in DNS server and serves the zone", async () => {
    const zone = "nz1-zone.example.com";
    const result = await inHost("cat /root/nz1/install.sh | bash", {
      env: { NEARZERO_MANAGED_DNS_ZONE: zone },
    });
    await log("2c-managed-dns", result.out);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      `Delegate ${zone} to ns1.${zone} and ns2.${zone} (glue ${PUBLIC_IP}) and allow TCP and UDP 53.`,
    );
    expect(await mustInHost("grep '^COMPOSE_PROFILES=' /opt/nearzero/.env")).toBe(
      "COMPOSE_PROFILES=database,router,dns\n",
    );
    expect(await mustInHost("nearzero status")).toMatch(/dns\s+running/);
    expect(await mustInHost(`nslookup ns1.${zone} 127.0.0.1`)).toContain(PUBLIC_IP);
    expect(await mustInHost(`nslookup -type=soa ${zone} 127.0.0.1`)).toContain(`ns1.${zone}`);
  }, 600_000);
});

describe("uninstall", () => {
  test("asks first, and without a terminal or --yes removes nothing", async () => {
    const noTerminal = await inHost("bash /root/nz1/uninstall.sh");
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.out).toContain("No terminal to confirm on, so nothing was removed.");
    const session = new TerminalSession("cat /root/nz1/uninstall.sh | bash");
    await session.expect("This cannot be undone.");
    await session.expect("Remove Nearzero? [y/N] ");
    session.type("n");
    expect(await session.exit(60_000)).toBe(1);
    expect(session.output).toContain("Nothing was removed.");
    expect(await mustInHost("docker inspect --format '{{.State.Running}}' nearzero-control")).toBe(
      "true\n",
    );
  }, 120_000);

  test("removes everything Nearzero created and nothing else", async () => {
    // An image the runner recorded pulling for a buildpacks build (it can't carry the label).
    await mustInHost(
      `printf 'FROM ${REGISTRY_IMAGE}\nLABEL nz1.e2e=buildpacks\n' | docker build -q -t nz1-e2e/buildpacks-builder:test - >/dev/null && dir=$(docker volume inspect --format '{{.Mountpoint}}' nearzero-runner-state) && mkdir -p "$dir/work" && echo nz1-e2e/buildpacks-builder:test >> "$dir/work/pulled-images"`,
    );
    // A backup made first, as the install guide says, survives the uninstall (B2-08).
    const dump = (await mustInHost("nearzero backup-db")).match(
      /\/opt\/nearzero\/(nearzero-db-[\w-]+\.sql)/,
    )?.[1];
    expect(dump).toBeTruthy();
    const result = await inHost("cat /root/nz1/uninstall.sh | bash -s -- --yes");
    await log("3-uninstall", result.out);
    expect(result.code).toBe(0);
    expect(result.out).toContain("✓ Removed Nearzero");
    expect(result.out).toContain(`  /var/backups/nearzero/${dump}`);
    expect(await mustInHost(`head -c 200 /var/backups/nearzero/${dump}`)).toContain("PostgreSQL");
    await mustInHost("rm -rf /var/backups/nearzero");
    expect(await nothingLabeledLeft()).toBe("");
    expect(
      (await inHost("ls -d /opt/nearzero /etc/nearzero /usr/local/bin/nearzero")).code,
    ).not.toBe(0);
    // The command's link for sudo's secure_path goes too (B2-11).
    expect((await inHost("test -L /usr/bin/nearzero || test -e /usr/bin/nearzero")).code).not.toBe(
      0,
    );
    for (const image of [
      HOST_IMAGE,
      "postgres:18.6-alpine",
      "traefik:v3.7.18",
      "nz1-e2e/buildpacks-builder:test",
    ]) {
      expect((await inHost(`docker image inspect ${image}`)).code).not.toBe(0);
    }
    // Unrelated things stay.
    expect(await mustInHost("docker inspect --format '{{.State.Running}}' nz1-registry")).toBe(
      "true\n",
    );
    expect((await inHost("docker inspect nz1-unrelated")).code).toBe(0);
    expect(
      await mustInHost(
        `docker run --rm -v nz1-unrelated-data:/data --entrypoint cat ${REGISTRY_IMAGE} /data/marker`,
      ),
    ).toBe("keep\n");
    expect((await inHost(`docker image inspect ${REGISTRY_IMAGE}`)).code).toBe(0);
  }, 300_000);
});

describe("an unattended install with only an email", () => {
  let password = "";

  test("generates a password, prints it once, and asks nothing", async () => {
    const result = await inHost("cat /root/nz1/install.sh | bash", {
      env: { NEARZERO_ADMIN_EMAIL: OWNER, NEARZERO_IMAGE: HOST_IMAGE },
    });
    await log("4-unattended-install", result.out);
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("Email: ");
    expect(result.out).not.toContain("[y/N]");
    expect(result.out).toContain("✓ Created your admin account");
    const match = /Password\s+([A-Za-z0-9]{24}) \(shown once; change it after you sign in\)/.exec(
      result.out,
    );
    expect(match).not.toBeNull();
    password = match?.[1] ?? "";
    expect(result.out.split(password).length - 1).toBe(1);
  }, 900_000);

  test("the password works and is on no disk, log, settings file or container", async () => {
    expect(await passwordWorks(OWNER, password)).toBe(true);
    const leaks = await inHost(
      'grep -rlF -- "$(cat)" /opt/nearzero /usr/local/bin/nearzero /root /tmp /var/log 2>/dev/null; docker inspect nearzero-control | grep -cF -- "$P" || true',
      { stdin: password, env: { P: password } },
    );
    expect(leaks.out.trim()).toBe("0");
  });

  test("with its settings file gone and its data kept, a rerun stops before starting anything (spec 03 3.4)", async () => {
    // The owner's case (punch list 39): /opt/nearzero lost, Docker's volumes kept.
    await mustInHost("cd /opt/nearzero && docker compose down >/dev/null 2>&1");
    await mustInHost("mv /opt/nearzero /root/nz1/opt-nearzero-kept");
    const before = await mustInHost("docker ps -q | sort");
    const result = await inHost("cat /root/nz1/install.sh | bash", {
      env: { NEARZERO_ADMIN_EMAIL: OWNER, NEARZERO_IMAGE: HOST_IMAGE },
    });
    await log("4b-data-without-settings", result.out);
    expect(result.code).toBe(1);
    expect(plain(result.out)).toContain(
      "Found Nearzero's data (nearzero-postgres-data) but not its settings file /opt/nearzero/.env. Put the settings file back and run this command again, or run the uninstall command to remove the old data and start fresh.",
    );
    // Nothing was written or started: no settings, no new secrets, the same containers.
    expect((await inHost("ls -d /opt/nearzero")).code).not.toBe(0);
    expect(await mustInHost("docker ps -q | sort")).toBe(before);
    expect((await inHost("docker inspect nearzero-control")).code).not.toBe(0);
    // C2-18: only the settings file lost, the folder's other files kept: the same stop and advice,
    // not "already holds other files" pointing at /opt/nearzero/nearzero.
    await mustInHost(
      "mv /root/nz1/opt-nearzero-kept /opt/nearzero && mv /opt/nearzero/.env /root/nz1/kept.env",
    );
    const onlyEnv = await inHost("cat /root/nz1/install.sh | bash", {
      env: { NEARZERO_ADMIN_EMAIL: OWNER, NEARZERO_IMAGE: HOST_IMAGE },
    });
    await log("4c-settings-file-lost", onlyEnv.out);
    expect(onlyEnv.code).toBe(1);
    expect(plain(onlyEnv.out)).toContain(
      "Found Nearzero's data (nearzero-postgres-data) but not its settings file /opt/nearzero/.env.",
    );
    expect(plain(onlyEnv.out)).not.toContain("already holds other files");
    // Putting the settings back brings the same install back, password and all.
    await mustInHost("mv /root/nz1/kept.env /opt/nearzero/.env && nearzero restart >/dev/null");
    expect(await passwordWorks(OWNER, password)).toBe(true);
  }, 600_000);

  test("a final uninstall leaves nothing behind", async () => {
    const result = await inHost("bash /root/nz1/uninstall.sh --yes");
    expect(result.code).toBe(0);
    expect(await nothingLabeledLeft()).toBe("");
    expect((await inHost("ls -d /opt/nearzero /usr/local/bin/nearzero")).code).not.toBe(0);
  }, 300_000);
});

describe("moving a 0.1.x install (spec 29)", () => {
  // A stand-in for a 0.1.x server: its settings file, a final-release `nearzero` command whose
  // export writes a bundle made here (spec 29.2a), a control plane holding the console's port, and
  // an app with data in a volume. The bundle is written from spec 29.3 and 29.4 alone.
  const LEGACY_OWNER = "owner@legacy.example.com";
  const LEGACY_PASSWORD = "legacy-Password-123";
  const PASSPHRASE = "install-suite passphrase 2026";
  const APP_IMAGE = "localhost:5000/nz1/legacy-app:1";
  // The stand-in 0.1.x control plane: a container named nearzero… without 1.0's labels.
  const CONSOLE = "nearzero-legacy-console";
  const DEPLOY_TOKEN = "legacy-deploy-token-0123456789abcdef";
  // Moved databases with data, on their exact public ports (spec 29.5), from the outer Docker.
  const PG_IMAGE = "localhost:5000/nz1/postgres:16-alpine";
  const REDIS_IMAGE = "localhost:5000/nz1/redis:7-alpine";
  // The app's volume isn't named after the app: the move must mount it as it is.
  const APP_VOLUME = "web-move-html";
  // Like 0.1.x's own database volume: no 1.0 label, so rollback never removes it.
  const LEGACY_DB_VOLUME = "nearzero_nearzero-postgres";
  // A Compose stack keeps its project name when moved, so its 0.1.x and 1.0 containers share it.
  const STACK = "stack-aaaaaa";
  // 0.1.x's own files for the stack, which rollback brings its copy back from (spec 29.5).
  const STACK_FOLDER = "/root/nz1/stack";
  // 0.1.x keeps a stack's env file outside its folder, under its own data folders (29a.9).
  const STACK_ENV = "/opt/nearzero/secrets/compose-env/stack-aaaaaa.env";
  const STUB = `#!/usr/bin/env bash
# A stand-in for the final 0.1.x release's nearzero command (spec 29.2a), for the install suite.
case "\${1:-}" in
  export)
    shift
    if [ "\${1:-}" = --version ]; then echo 1; exit 0; fi
    out=""
    while [ $# -gt 0 ]; do case "$1" in --out) out="$2"; shift 2 ;; *) shift ;; esac; done
    [ "\${#NEARZERO_MIGRATION_PASSPHRASE}" -ge 16 ] || { echo "The passphrase must be at least 16 characters." >&2; exit 1; }
    [ "$NEARZERO_MIGRATION_PASSPHRASE" = "$(cat /root/nz1/legacy/passphrase)" ] || { echo "Not the fixture's passphrase." >&2; exit 1; }
    mkdir -p -m 0700 /opt/nearzero/migration
    out="\${out:-/opt/nearzero/migration/nearzero-export-$(date -u +%Y%m%dT%H%M%SZ).nzx}"
    install -m 0600 /root/nz1/legacy/fixture.nzx "$out"
    echo "Exported to $out."
    echo "NEARZERO_EXPORT_OK $out $(sha256sum "$out" | cut -d' ' -f1)"
    ;;
  *) echo "Nearzero 0.1.80 (stand-in)" ;;
esac
`;

  /** The settings file and command of a 0.1.x server; releases before the final one write no version. */
  async function legacyServer(version: string | null, command = STUB): Promise<void> {
    const line = version ? `NEARZERO_VERSION=${version}\\n` : "";
    await mustInHost(
      `mkdir -p /opt/nearzero && printf '${line}NEARZERO_PUBLIC_IP=${PUBLIC_IP}\\n' > /opt/nearzero/.env && chmod 0600 /opt/nearzero/.env`,
    );
    await mustInHost("cat > /usr/local/bin/nearzero && chmod 0755 /usr/local/bin/nearzero", {
      stdin: command,
    });
  }

  async function running(name: string): Promise<boolean> {
    return (
      (await inHost(`docker inspect --format '{{.State.Running}}' ${name}`)).out.trim() === "true"
    );
  }

  async function moveUnattended(name: string): Promise<string> {
    const result = await inHost("cat /root/nz1/install.sh | bash", {
      env: {
        NEARZERO_IMAGE: HOST_IMAGE,
        NEARZERO_MIGRATE: "yes",
        NEARZERO_MIGRATION_PASSPHRASE: PASSPHRASE,
      },
    });
    await log(name, result.out);
    if (result.code !== 0) throw new Error(`The move failed:\n${result.out}`);
    return result.out;
  }

  test("prepares a 0.1.x server and refuses one older than the final release", async () => {
    const bcrypt = await Bun.password.hash(LEGACY_PASSWORD, { algorithm: "bcrypt", cost: 4 });
    const bundle = await createBundle(
      {
        sourceVersion: "0.1.80",
        installId: "legacy-install-0001",
        records: {
          "people.jsonl": [
            {
              ref: "per_lee",
              email: LEGACY_OWNER,
              emailVerified: true,
              firstName: "Lee",
              lastName: "",
              password: {
                algorithm: "bcrypt",
                encoded: bcrypt,
                params: { variant: "2b", cost: 4 },
              },
              twoFactor: null,
              avatar: null,
              otherSignIns: [],
              banned: false,
              createdAt: null,
            },
          ],
          "workspaces.jsonl": [
            {
              ref: "wsp_legacy",
              name: "Legacy",
              slug: "legacy",
              oldSlugs: [],
              ownerRef: "per_lee",
              personal: false,
              firstWorkspace: true,
              hostsAllowed: true,
              agentPolicies: {},
            },
          ],
          "memberships.jsonl": [
            {
              ref: "mem_lee",
              personRef: "per_lee",
              workspaceRef: "wsp_legacy",
              role: "Owner",
              capabilities: [],
              policyRefs: [],
              defaultWorkspace: true,
            },
          ],
          "projects.jsonl": [
            {
              ref: "prj_shop",
              workspaceRef: "wsp_legacy",
              name: "Shop",
              legacyConsolePath: "/dashboard/project/old-shop",
            },
          ],
          "environments.jsonl": [
            {
              ref: "env_prod",
              projectRef: "prj_shop",
              name: "production",
              default: true,
              sharedVariables: "",
            },
          ],
          "services.jsonl": [
            {
              ref: "svc_web",
              environmentRef: "env_prod",
              copyGroupRef: "grp_web",
              kind: "Application",
              name: "web",
              appName: "web-aaaaaa",
              place: { host: true },
              variables: "",
              settings: {
                source: { type: "Container image", image: APP_IMAGE },
                webhookToken: DEPLOY_TOKEN,
                mounts: [
                  { type: "Volume", containerPath: "/var/lib/registry", volume: APP_VOLUME },
                ],
              },
              volumes: [APP_VOLUME],
              legacy: { kind: "container", name: "legacy-web" },
              servicePort: 5000,
              legacyConsolePath: "/legacy/project/old-shop/services/application/old-web",
            },
            {
              ref: "svc_pg",
              environmentRef: "env_prod",
              copyGroupRef: "grp_pg",
              kind: "Postgres",
              name: "pg",
              appName: "pg-aaaaaa",
              place: { host: true },
              variables: "",
              settings: {
                image: PG_IMAGE,
                credentials: { database: "shop", user: "app", password: "pg-pass-123" },
                publicPort: 5433,
              },
              volumes: ["nearzero_shop-pg"],
              legacy: { kind: "container", name: "legacy-pg" },
            },
            {
              ref: "svc_cache",
              environmentRef: "env_prod",
              copyGroupRef: "grp_cache",
              kind: "Redis",
              name: "cache",
              appName: "cache-aaaaaa",
              place: { host: true },
              variables: "",
              settings: {
                image: REDIS_IMAGE,
                credentials: { password: "re-pass-123" },
                publicPort: 6380,
                persistence: "Snapshot",
              },
              volumes: ["nearzero_shop-redis"],
              legacy: { kind: "container", name: "legacy-redis" },
            },
            {
              ref: "svc_stack",
              environmentRef: "env_prod",
              copyGroupRef: "grp_stack",
              kind: "Compose",
              name: "stack",
              appName: STACK,
              place: { host: true },
              variables: "",
              settings: {
                source: { type: "Pasted Compose file" },
                format: "Compose",
                composeFile: `services:\n  web:\n    image: ${APP_IMAGE}\n    volumes:\n      - data:/var/lib/registry\nvolumes:\n  data: {}\n`,
                randomizeNames: false,
              },
              volumes: [`${STACK}_data`],
              legacy: {
                kind: "compose-project",
                name: STACK,
                folder: STACK_FOLDER,
                composeFiles: ["stack.prod.yml"],
                envFile: STACK_ENV,
              },
            },
          ],
          "deployments.jsonl": [
            ...(["pg", "cache", "stack"] as const).map((name, index) => ({
              ref: `dep_${name}`,
              serviceRef: `svc_${name}`,
              status: "Running",
              title: "Deploy",
              createdAt: `2026-05-0${index + 1}T00:00:00.000Z`,
              finishedAt: `2026-05-0${index + 1}T00:00:00.000Z`,
              log: "",
              logTruncated: false,
              logMissing: true,
            })),
            {
              ref: "dep_web",
              serviceRef: "svc_web",
              status: "Running",
              title: "Deploy",
              createdAt: "2026-06-01T00:00:00.000Z",
              finishedAt: "2026-06-01T00:00:00.000Z",
              log: "",
              logTruncated: false,
              logMissing: true,
            },
          ],
        },
        extra: {
          "install.json": {
            sourceVersion: "0.1.80",
            publicIp: PUBLIC_IP,
            controlPlane: [{ kind: "container", name: CONSOLE }],
            controlPlaneDetails: { folder: "/opt/nearzero", ports: [4321] },
            controlPlaneVolumes: ["legacy-console-data", LEGACY_DB_VOLUME],
            legacyWebhookPaths: { deploy: "/api/deploy/{token}", github: "/api/deploy/github" },
          },
        },
      },
      PASSPHRASE,
    );
    await writeFile(join(WORK, "legacy.nzx"), bundle);
    await mustInHost("mkdir -p /root/nz1/legacy && chmod 0700 /root/nz1/legacy");
    await $`docker cp ${join(WORK, "legacy.nzx")} ${HOST}:/root/nz1/legacy/fixture.nzx`.quiet();
    await mustInHost("cat > /root/nz1/legacy/passphrase", { stdin: PASSPHRASE });
    // The app's image, its data, the running app and the control plane on the console's port.
    await mustInHost(
      `docker tag ${REGISTRY_IMAGE} ${APP_IMAGE} && docker push -q ${APP_IMAGE} >/dev/null`,
    );
    await mustInHost(
      `docker volume create ${APP_VOLUME} >/dev/null && docker run --rm -v ${APP_VOLUME}:/data --entrypoint sh ${REGISTRY_IMAGE} -c 'echo kept > /data/marker'`,
    );
    await mustInHost(
      `docker run -d --name legacy-web -v ${APP_VOLUME}:/var/lib/registry ${REGISTRY_IMAGE} >/dev/null`,
    );
    // The control plane, with its database's volume beside it (no 1.0 label).
    await mustInHost(
      `docker volume create ${LEGACY_DB_VOLUME} >/dev/null && docker run --rm -v ${LEGACY_DB_VOLUME}:/data --entrypoint sh ${REGISTRY_IMAGE} -c 'echo legacy-db > /data/marker'`,
    );
    await mustInHost(
      `docker run -d --name ${CONSOLE} -p 4321:5000 -v legacy-console-data:/var/lib/registry -v ${LEGACY_DB_VOLUME}:/legacy-db ${REGISTRY_IMAGE} >/dev/null`,
    );
    // The stack as 0.1.x's Compose project runs it, with its data in the project's volume.
    await mustInHost(
      `docker volume create ${STACK}_data >/dev/null && docker run --rm -v ${STACK}_data:/data --entrypoint sh ${REGISTRY_IMAGE} -c 'echo stack-kept > /data/marker'`,
    );
    // 0.1.x runs it from its own files (not Compose's default names), with its env file.
    await mustInHost(`mkdir -p ${STACK_FOLDER}`);
    await mustInHost(`cat > ${STACK_FOLDER}/stack.prod.yml`, {
      stdin: `services:\n  web:\n    image: localhost:5000/nz1/legacy-app:\${STACK_TAG}\n    environment:\n      STACK_GREETING: \${STACK_GREETING}\n    volumes:\n      - data:/var/lib/registry\nvolumes:\n  data: {}\n`,
    });
    await mustInHost(
      `mkdir -p $(dirname ${STACK_ENV}) && printf 'STACK_TAG=1\\nSTACK_GREETING=hello-from-0.1\\n' > ${STACK_ENV}`,
    );
    await mustInHost(
      `/root/compose-from-image --project-directory ${STACK_FOLDER} -p ${STACK} -f ${STACK_FOLDER}/stack.prod.yml --env-file ${STACK_ENV} up -d`,
    );
    // Postgres and Redis as 0.1.x runs them: their data in volumes, on public ports outside the
    // range 1.0 picks new ones from; Redis writes only snapshots.
    await pushToHostRegistry("postgres:16-alpine", PG_IMAGE);
    await pushToHostRegistry("redis:7-alpine", REDIS_IMAGE);
    await mustInHost(
      `docker run -d --name legacy-pg -p 5433:5432 -e POSTGRES_USER=app -e POSTGRES_PASSWORD=pg-pass-123 -e POSTGRES_DB=shop -v nearzero_shop-pg:/var/lib/postgresql/data ${PG_IMAGE} >/dev/null`,
    );
    await mustInHost(
      // Postgres restarts once after its first start, so the write is retried until it lands.
      `ok=0; for i in $(seq 1 120); do docker exec legacy-pg psql -U app -d shop -qc "create table if not exists marker (v text); delete from marker; insert into marker values ('kept');" >/dev/null 2>&1 && ok=1 && break; sleep 1; done; [ "$ok" = 1 ]`,
    );
    await mustInHost(
      `docker run -d --name legacy-redis -p 6380:6379 -v nearzero_shop-redis:/data ${REDIS_IMAGE} redis-server --requirepass re-pass-123 >/dev/null`,
    );
    await mustInHost(
      `for i in $(seq 1 30); do docker exec legacy-redis redis-cli -a re-pass-123 --no-auth-warning ping | grep -q PONG && break; sleep 1; done; docker exec legacy-redis redis-cli -a re-pass-123 --no-auth-warning set marker kept >/dev/null && docker exec legacy-redis redis-cli -a re-pass-123 --no-auth-warning save >/dev/null`,
    );

    // A release before the final one writes no version; its 0.1.x control plane gives it away.
    await legacyServer(null, '#!/usr/bin/env bash\necho "Unknown command: $1" >&2; exit 1\n');
    const unversioned = await inHost("cat /root/nz1/install.sh | bash", {
      env: { NEARZERO_IMAGE: HOST_IMAGE },
    });
    expect(unversioned.code).toBe(1);
    expect(unversioned.out).toContain(
      "This server runs Nearzero an older 0.1.x release. Update it to 0.1.80 first:",
    );
    await legacyServer("0.1.70");
    const old = await inHost("cat /root/nz1/install.sh | bash", {
      env: { NEARZERO_IMAGE: HOST_IMAGE },
    });
    expect(old.code).toBe(1);
    expect(old.out).toContain(
      "This server runs Nearzero 0.1.70. Update it to 0.1.80 first: curl -fsSL https://cdn.nearzero.dev/releases/0.1.80/install.sh | sudo bash. Then run this install command again.",
    );
    await legacyServer("0.1.80");
    const unattended = await inHost("cat /root/nz1/install.sh | bash", {
      env: { NEARZERO_IMAGE: HOST_IMAGE },
    });
    expect(unattended.code).toBe(1);
    expect(unattended.out).toContain("set NEARZERO_MIGRATE=yes and NEARZERO_MIGRATION_PASSPHRASE");
    // On a terminal it explains and asks first; "n" changes nothing.
    const session = new TerminalSession("cat /root/nz1/install.sh | bash", {
      NEARZERO_IMAGE: HOST_IMAGE,
    });
    await session.expect(
      "This server runs Nearzero 0.1.80. This install command moves it to Nearzero 1.0:",
    );
    await session.expect(
      "Move this install to Nearzero 1.0? Your apps restart once, briefly; data, addresses and passwords are kept. [y/N] ",
    );
    session.type("n");
    expect(await session.exit(120_000)).toBe(1);
    expect(session.output).toContain(
      "Nothing was changed. This server still runs Nearzero 0.1.80.",
    );
    expect(await running(CONSOLE)).toBe(true);
    expect((await inHost("ls /opt/nearzero/migration")).code).not.toBe(0);
  }, 900_000);

  test("exports, checks, stops the 0.1.x control plane, installs 1.0, imports and moves the app", async () => {
    const out = await moveUnattended("5-migration");
    expect(out).toContain("✓ Exported Nearzero 0.1.80 to /opt/nearzero/migration/nearzero-export-");
    expect(out).toContain("✓ Checked the export");
    expect(out).toContain("Dry run of the import from Nearzero 0.1.80. Nothing was changed.");
    expect(out).toContain(
      "4 services will be redeployed on the 1.0 runner, oldest deployed first.",
    );
    expect(out).toContain(
      `The 0.1.x control plane (in /opt/nearzero, holding port 4321): container ${CONSOLE} stops when the move starts, and rollback starts it again.`,
    );
    expect(out).toContain("✓ Stopped the 0.1.x console and API; your apps keep running");
    expect(out).toContain("✓ Nearzero is running");
    expect(out).toContain("✓ Imported Nearzero 0.1.80");
    expect(out).toContain("web on the Nearzero host: moved");
    expect(out).toContain("Moved from Nearzero 0.1.80. Everyone signs in with their old password.");
    expect(out).toContain("Go back to 0.1.x: sudo nearzero migrate rollback");
    // The passphrase was given, so it is never printed.
    expect(out).not.toContain(PASSPHRASE);
  }, 1_800_000);

  test("the app runs on 1.0 with its data; the old one and the old control plane are stopped", async () => {
    expect(await running(CONSOLE)).toBe(false);
    expect(await running("legacy-web")).toBe(false);
    const moved = (
      await mustInHost("docker ps -q --filter label=dev.nearzero.service --filter name=web-aaaaaa-")
    ).trim();
    expect(moved).not.toBe("");
    // The volume the bundle names, not a new one (spec 29.5 "Volumes").
    expect(
      await mustInHost(`docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' ${moved}`),
    ).toContain(APP_VOLUME);
    expect(await mustInHost(`docker exec ${moved} cat /var/lib/registry/marker`)).toBe("kept\n");
    expect(await passwordWorks(LEGACY_OWNER, LEGACY_PASSWORD)).toBe(true);
    const status = await mustInHost("nearzero migrate status");
    expect(status).toContain("4 of 4 services moved.");
    expect(status).toContain("web on the Nearzero host: moved");
    expect(status).toContain("pg on the Nearzero host: moved");
    expect(status).toContain("cache on the Nearzero host: moved");
    // The databases answer on their exact public ports with the data they had.
    expect(await running("legacy-pg")).toBe(false);
    expect(await running("legacy-redis")).toBe(false);
    const pg = (
      await mustInHost("docker ps -q --filter label=dev.nearzero.service --filter name=pg-aaaaaa-")
    ).trim();
    const redis = (
      await mustInHost(
        "docker ps -q --filter label=dev.nearzero.service --filter name=cache-aaaaaa-",
      )
    ).trim();
    expect(await mustInHost(`docker port ${pg} 5432/tcp`)).toContain(":5433");
    expect(await mustInHost(`docker port ${redis} 6379/tcp`)).toContain(":6380");
    expect(
      await mustInHost(`docker exec ${pg} psql -U app -d shop -tAc "select v from marker"`),
    ).toBe("kept\n");
    expect(
      await mustInHost(
        `docker exec ${redis} redis-cli -a re-pass-123 --no-auth-warning get marker`,
      ),
    ).toBe("kept\n");
    // It loaded the snapshot, then turned on its own append-only persistence from it.
    let appendonly = "";
    for (let i = 0; i < 30 && !appendonly.includes("yes"); i++) {
      appendonly = await mustInHost(
        `docker exec ${redis} redis-cli -a re-pass-123 --no-auth-warning config get appendonly`,
      );
      if (!appendonly.includes("yes")) await Bun.sleep(1000);
    }
    expect(appendonly).toContain("yes");
    // 1.0's control plane has names and labels of its own; 0.1.x's database volume is untouched.
    expect(await running("nearzero1-postgres")).toBe(true);
    expect(
      await mustInHost(
        "docker inspect --format '{{index .Config.Labels \"dev.nearzero.edition\"}}' nearzero-control",
      ),
    ).toBe("1\n");
    expect(
      await mustInHost(
        `docker run --rm -v ${LEGACY_DB_VOLUME}:/data --entrypoint cat ${REGISTRY_IMAGE} /data/marker`,
      ),
    ).toBe("legacy-db\n");
    expect(await mustInHost("cat /opt/nearzero/migration/0.1/env")).toContain(
      "NEARZERO_VERSION=0.1.80",
    );
    expect(await mustInHost("grep NEARZERO_VERSION /opt/nearzero/.env")).toContain(
      `NEARZERO_VERSION=${VERSION}`,
    );
    // 1.0's marker, so a later run never takes this install for 0.1.x.
    expect(await mustInHost("grep NEARZERO_EDITION /opt/nearzero/.env")).toBe(
      "NEARZERO_EDITION=1\n",
    );
  });

  test("the 0.1.x webhook and console addresses keep working through the console", async () => {
    const post = (path: string) =>
      inHost(
        `curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' --data '{}' http://127.0.0.1:4321${path}`,
      );
    expect(["200", "202"]).toContain((await post(`/api/deploy/${DEPLOY_TOKEN}`)).out.trim());
    expect((await post("/api/deploy/not-the-token-0123456789")).out.trim()).toBe("401");
    expect((await post("/api/somewhere-else")).out.trim()).toBe("404");
    // The webhook's deploy ends before the next step goes back to 0.1.x.
    let pending = "1";
    for (let i = 0; i < 90 && pending !== "0"; i++) {
      pending = (
        await inHost(
          `docker exec nearzero1-postgres psql -U nearzero -d nearzero -tAc "select count(*) from deployment where status in ('queued', 'building')"`,
        )
      ).out.trim();
      if (pending !== "0") await Bun.sleep(2000);
    }
    expect(pending).toBe("0");
    // Signed out, an old console address asks for sign-in and comes back to it.
    const old = "/legacy/project/old-shop/services/application/old-web";
    const signedOut = await mustInHost(
      `curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' http://127.0.0.1:4321${old}`,
    );
    expect(signedOut).toBe(`302 http://127.0.0.1:4321/sign-in?next=${encodeURIComponent(old)}`);
  }, 300_000);

  test("rollback brings 0.1.x back from its untouched data", async () => {
    const result = await inHost("nearzero migrate rollback --yes");
    await log("5-rollback", result.out);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Nearzero 0.1.80 is back. The move to 1.0 was undone.");
    expect(await running(CONSOLE)).toBe(true);
    expect(await running("legacy-web")).toBe(true);
    expect(await running("legacy-pg")).toBe(true);
    expect(await running("legacy-redis")).toBe(true);
    // Only what carries 1.0's label went: every volume the bundle names is still there.
    for (const volume of [
      APP_VOLUME,
      LEGACY_DB_VOLUME,
      "nearzero_shop-pg",
      "nearzero_shop-redis",
      "legacy-console-data",
    ]) {
      expect((await inHost(`docker volume inspect ${volume}`)).code).toBe(0);
    }
    expect(
      await mustInHost(
        `docker run --rm -v ${LEGACY_DB_VOLUME}:/data --entrypoint cat ${REGISTRY_IMAGE} /data/marker`,
      ),
    ).toBe("legacy-db\n");
    expect((await mustInHost("docker ps -aq --filter label=dev.nearzero.edition=1")).trim()).toBe(
      "",
    );
    expect((await inHost("docker volume inspect nearzero-postgres-data")).code).not.toBe(0);
    for (let i = 0; i < 30; i++) {
      if ((await inHost("docker exec legacy-pg pg_isready -U app -d shop -q")).code === 0) break;
      await Bun.sleep(1000);
    }
    expect(
      await mustInHost(`docker exec legacy-pg psql -U app -d shop -tAc "select v from marker"`),
    ).toBe("kept\n");
    expect(
      await mustInHost(
        "docker exec legacy-redis redis-cli -a re-pass-123 --no-auth-warning get marker",
      ),
    ).toBe("kept\n");
    // The stack's 0.1.x copy is back from its own files (1.0's deploy replaced its containers),
    // with the same data.
    const legacyStack = (
      await mustInHost(
        `docker ps -q --filter label=com.docker.compose.project=${STACK} --filter status=running`,
      )
    ).trim();
    expect(legacyStack).not.toBe("");
    const legacyStackId = legacyStack.split("\n")[0] as string;
    expect(
      await mustInHost(
        `docker inspect --format '{{index .Config.Labels "dev.nearzero.edition"}}|{{index .Config.Labels "com.docker.compose.project.config_files"}}' ${legacyStackId}`,
      ),
    ).toBe(`|${STACK_FOLDER}/stack.prod.yml\n`);
    expect(await mustInHost(`docker exec ${legacyStackId} cat /var/lib/registry/marker`)).toBe(
      "stack-kept\n",
    );
    // It read its variables from the env file 0.1.x keeps outside the stack's folder.
    expect(
      await mustInHost(
        `docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' ${legacyStackId}`,
      ),
    ).toContain("STACK_GREETING=hello-from-0.1");
    expect(await running("nearzero-control")).toBe(false);
    expect((await mustInHost("docker ps -aq --filter label=dev.nearzero.service")).trim()).toBe("");
    expect(await mustInHost("grep NEARZERO_VERSION /opt/nearzero/.env")).toBe(
      "NEARZERO_VERSION=0.1.80\n",
    );
    expect(await mustInHost("nearzero")).toContain("(stand-in)");
    expect(await mustInHost("docker exec legacy-web cat /var/lib/registry/marker")).toBe("kept\n");
  }, 300_000);

  test("moving again, then finalize deletes the 0.1.x data and rollback is refused", async () => {
    const out = await moveUnattended("5-migration-again");
    expect(out).toContain("web on the Nearzero host: moved");
    const noTerminal = await inHost("nearzero migrate finalize");
    expect(noTerminal.code).toBe(1);
    expect(noTerminal.out).toContain("No terminal to confirm on, so nothing was deleted.");
    const result = await inHost("nearzero migrate finalize --yes");
    await log("5-finalize", result.out);
    expect(result.code).toBe(0);
    expect(result.out).toContain(
      "Finalized: the 0.1.x data is deleted. Nearzero 1.0 keeps running.",
    );
    expect((await inHost(`docker inspect ${CONSOLE}`)).code).not.toBe(0);
    expect((await inHost("docker volume inspect legacy-console-data")).code).not.toBe(0);
    // The stopped 0.1.x workloads are gone by the time it says so (spec 29.5 "Finalize").
    for (const name of ["legacy-web", "legacy-pg", "legacy-redis"]) {
      expect((await inHost(`docker inspect ${name}`)).code).not.toBe(0);
    }
    expect((await inHost(`docker volume inspect ${LEGACY_DB_VOLUME}`)).code).not.toBe(0);
    // The moved stack shares its Compose project name with 0.1.x's: it still runs, with its data,
    // and the status says so (spec 29.5 "Finalize").
    const stack = (
      await mustInHost(
        `docker ps -q --filter label=com.docker.compose.project=${STACK} --filter label=dev.nearzero.edition=1 --filter status=running`,
      )
    ).trim();
    expect(stack).not.toBe("");
    expect(
      await mustInHost(`docker exec ${stack.split("\n")[0]} cat /var/lib/registry/marker`),
    ).toBe("stack-kept\n");
    const after = await mustInHost("nearzero migrate status");
    expect(after).toContain("stack on the Nearzero host: moved");
    expect(after).not.toContain("nothing of it is running");
    // Their data stays: the 1.0 services use it.
    for (const volume of [APP_VOLUME, "nearzero_shop-pg", "nearzero_shop-redis", `${STACK}_data`]) {
      expect((await inHost(`docker volume inspect ${volume}`)).code).toBe(0);
    }
    const refused = await inHost("nearzero migrate rollback --yes");
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      "The move is finalized: the 0.1.x data is deleted, so it can't be rolled back.",
    );
    const removed = await inHost("bash /root/nz1/uninstall.sh --yes");
    expect(removed.code).toBe(0);
    expect(await nothingLabeledLeft()).toBe("");
  }, 1_800_000);
});
