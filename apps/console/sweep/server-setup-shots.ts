/**
 * Screenshots of the Server setup and Server details dialogs (M6, spec 09 9.3–9.5) in Dusk and
 * Light at 1440 and 375px, on a throwaway stack (control plane on 4211, console dev server on
 * 4510, database nz_m6_shots_*). Servers and their runs are written straight into the database,
 * so nothing is signed in to over SSH; a pretend runner connects for the ready server.
 *
 *   bun sweep/server-setup-shots.ts     (from apps/console)
 *
 * Fails on a script error in the page, horizontal scroll, or a dialog wider than the screen.
 * Writes test-artifacts/m6/<dialog>-<theme>-<width>.png.
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SQL } from "bun";
import { chromium, type Page } from "playwright";
import { connectFakeHost } from "../test-support/fake-runner-link.ts";
import { ApiSession, startStack } from "../test-support/stack.ts";

const OUT = resolve(import.meta.dir, "..", "test-artifacts", "m6");
const EMAIL = "owner@example.com";
const PASSWORD = "shots-password-1";
const FINGERPRINT = "SHA256:mJxR0lW6c3o8q2hA9kV4sT7uY1eB5nD0fG3iK6lP8zQ";

const failures: string[] = [];

const stack = await startStack({
  console: "dev",
  controlPort: 4211,
  consolePort: 4510,
  label: "shots",
  databasePrefix: "nz_m6",
  // DNS lookups go to a closed local port, so the card answers at once ("Couldn't check").
  env: { NEARZERO_PLATFORM_DOMAIN: "apps.example.com", NEARZERO_DNS_RESOLVERS: "127.0.0.1:9" },
});

try {
  await mkdir(OUT, { recursive: true });
  await stack.createOwner(EMAIL, PASSWORD);
  const owner = await ApiSession.signIn(stack.consoleUrl, EMAIL, PASSWORD);
  await owner.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await owner.call("POST", "/onboarding/skip-invitations").catch(() => {});
  const pair = await owner.call<{ publicKey: string; privateKey: string }>(
    "POST",
    "/ssh-keys/generate",
    {
      type: "ed25519",
      name: "deploy",
    },
  );
  const key = await owner.call<{ key: { id: string } }>("POST", "/ssh-keys", {
    name: "deploy",
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
  });
  const server = async (name: string, address: string, sshUser: string) =>
    (
      await owner.call<{ server: { id: string } }>("POST", "/servers", {
        name,
        description: name === "prod-1" ? "Shop and API, Frankfurt." : "",
        sshKeyId: key.key.id,
        address,
        sshUser,
      })
    ).server.id;
  const building = await server("build-1", "203.0.113.21", "ubuntu");
  const refused = await server("edge-1", "203.0.113.22", "root");
  const ready = await server("prod-1", "203.0.113.10", "ubuntu");

  const db = new SQL(stack.env.DATABASE_URL as string);
  const workspace = (await db`select id from workspace order by created_at limit 1`)[0]
    .id as string;
  const steps = (states: string[]) =>
    JSON.stringify(
      Array.from({ length: 15 }, (_, index) => ({
        state: states[index] ?? "waiting",
        note: null,
      })),
    );
  const addRun = async (
    serverId: string,
    fields: {
      state: string;
      step: number | null;
      steps: string;
      failure?: unknown;
      user: string;
      job?: boolean;
    },
    lines: string[],
  ) => {
    let jobId: number | null = null;
    if (fields.job) {
      const job =
        await db`insert into job (kind, payload, state, locked_by, locked_until, started_at)
        values ('servers.setup', '{}'::jsonb, 'running', 'screenshots', now() + interval '2 hours', now())
        returning id`;
      jobId = Number(job[0].id);
    }
    const run =
      await db`insert into server_setup_run (server_id, workspace_id, state, step, steps, failure, ssh_user, job_id, log_seq, finished_at)
      values (${serverId}, ${workspace}, ${fields.state}, ${fields.step}, ${fields.steps}::text::jsonb,
        ${fields.failure ? JSON.stringify(fields.failure) : null}::text::jsonb, ${fields.user}, ${jobId}, ${lines.length},
        ${fields.state === "running" ? null : new Date()})
      returning id`;
    const runId = run[0].id as string;
    for (const [index, text] of lines.entries()) {
      await db`insert into server_setup_log (run_id, seq, text) values (${runId}, ${index + 1}, ${text})`;
    }
  };

  const head = (user: string, address: string) => [
    "Initializing server setup (Nearzero 1.0.0-dev)",
    `Connecting to ${user}@${address}:22`,
    `Host key ${FINGERPRINT} (first connection: recorded; compare it with the host key in your provider's console).`,
  ];
  await db`update server set setup_state = 'running', setup_started_at = now(), host_key_fingerprint = ${FINGERPRINT} where id = ${building}`;
  await addRun(
    building,
    {
      state: "running",
      step: 5,
      steps: steps(["done", "done", "done", "done", "running"]),
      user: "ubuntu",
      job: true,
    },
    [
      ...head("ubuntu", "203.0.113.21"),
      "Signed in as ubuntu; passwordless sudo works.",
      "System: Ubuntu 24.04.3 LTS (amd64, glibc, systemd)",
      "",
      "[1/15] Clean up leftovers from an earlier run",
      "  · Removing temporary files from an earlier run",
      "  Nothing was left over.",
      "  Running apps, databases and the router's routes are kept.",
      "  Done (1s)",
      "",
      "[2/15] Install basic tools",
      "  · Checking which basic tools are missing",
      "  · Installing basic tools: jq unzip",
      "  Installed: jq unzip.",
      "  Done (14s)",
      "",
      "[3/15] Check ports 80 and 443",
      "  · Looking at what listens on ports 80 and 443",
      "  Ports 80 and 443 are free.",
      "  Done (1s)",
      "",
      "[4/15] Install rclone",
      "  · Downloading rclone 1.71.2",
      "  · Checking rclone's checksum",
      "  · Installing rclone 1.71.2",
      "  Installed rclone 1.71.2.",
      "  Done (6s)",
      "",
      "[5/15] Install Docker",
      "  · Checking how Docker is installed",
      "  · Adding Docker's signed apt repository",
      "  · Installing Docker from Docker's repository",
    ],
  );
  const wrongUser = {
    kind: "wrong_user",
    message:
      'This server does not allow logging in as "root". It asks for the user "ubuntu": change the server\'s SSH user to "ubuntu" and run setup again.',
    hints: [],
    suggestedUser: "ubuntu",
    fixCommand: null,
    presentedFingerprint: null,
  };
  await db`update server set setup_state = 'failed', setup_error = ${wrongUser.message}, host_key_fingerprint = ${FINGERPRINT} where id = ${refused}`;
  await addRun(
    refused,
    { state: "failed", step: null, steps: steps([]), failure: wrongUser, user: "root" },
    [...head("root", "203.0.113.22"), "", wrongUser.message],
  );

  await db`update server set setup_state = 'ready', setup_started_at = now() - interval '9 minutes', setup_finished_at = now(), host_key_fingerprint = ${FINGERPRINT}, docker_cleanup = true where id = ${ready}`;
  await addRun(
    ready,
    { state: "succeeded", step: 15, steps: steps(Array(15).fill("done")), user: "ubuntu" },
    [...head("ubuntu", "203.0.113.10"), "Setup Server: ✅", "Server setup completed"],
  );
  const check = (
    id: string,
    label: string,
    state: string,
    value: string | null,
    mandatory = true,
  ) => ({
    id,
    label,
    mandatory,
    state,
    value,
  });
  const validation = {
    checkedAt: new Date().toISOString(),
    ok: true,
    verdict: "All mandatory checks passed and the server is ready for deployments.",
    checks: [
      check("docker", "Docker", "version", "28.5.1 (Compose 2.40.0, buildx 0.29.1)"),
      check("folders", "Nearzero's folders", "ready", null),
      check(
        "builders",
        "Builders",
        "version",
        "railpack 0.43.0, railpack 0.42.0, nixpacks 1.41.0, pack 0.40.10",
      ),
      check("rclone", "rclone", "version", "1.71.2"),
      check("runtime", "Container runtime", "ready", "Docker Engine"),
      check("sudo", "Passwordless sudo", "ready", null),
      check("docker_group", "Docker group", "ready", "ubuntu is a member"),
      check("network", "Private network", "ready", "nearzero-edge"),
      check("router", "Router", "ready", "Running as ubuntu (traefik:v3.7.18)"),
      check("runner", "Runner", "ready", "Connected (1.0.0-dev)"),
      check("swap", "Swap", "ready", "4.00 GB", false),
      check("monitoring", "Monitoring", "ready", "CPU, memory and disk every 5 seconds", false),
    ],
  };
  const audit = {
    checkedAt: new Date().toISOString(),
    error: null,
    items: [
      {
        id: "firewall",
        label: "Firewall",
        state: "attention",
        value: "No host firewall is active",
        recommendation:
          "Turn on a host firewall that allows only SSH, 80/tcp, 443/tcp and 443/udp (for example ufw: allow OpenSSH, 80/tcp and 443, then enable it), or make sure your cloud provider's firewall does.",
      },
      {
        id: "ssh_password",
        label: "SSH password sign-in",
        state: "good",
        value: "Off: only keys can sign in",
        recommendation: "Nothing to do.",
      },
      {
        id: "ssh_root",
        label: "SSH root sign-in",
        state: "good",
        value: "Root only with a key",
        recommendation: "Nothing to do. A dedicated non-root user with sudo is safer still.",
      },
      {
        id: "intrusion_ban",
        label: "Intrusion-ban service",
        state: "attention",
        value: "None running",
        recommendation:
          "Install fail2ban (or sshguard) so addresses that keep failing to sign in are blocked for a while.",
      },
    ],
  };
  await db`insert into server_inspection (server_id, validation, validation_at, audit, audit_at)
    values (${ready}, ${JSON.stringify(validation)}::text::jsonb, now(), ${JSON.stringify(audit)}::text::jsonb, now())`;
  await db`insert into docker_cleanup (target, last_local_date, last_at, last_freed_bytes)
    values (${ready}, '2026-11-24', now() - interval '8 hours', ${1_288_490_189})`;

  // A pretend runner for prod-1, so it reads Ready.
  const joinCommand = await owner.call<{ token: string }>("POST", `/servers/${ready}/join-command`);
  const folder = await mkdtemp(join(tmpdir(), "nz-m6-shots-"));
  await writeFile(join(folder, "host-join-token"), `${joinCommand.token}\n`);
  const runner = await connectFakeHost(stack.controlUrl, folder);
  await db.close();

  const browser = await chromium.launch();
  try {
    for (const theme of ["dusk", "light"] as const) {
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 375, height: 812 },
      ]) {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
        await context.addCookies([
          { name: "nz_session", value: owner.sessionToken(), url: stack.consoleUrl },
          { name: "nz_theme", value: theme, url: stack.consoleUrl },
        ]);
        const page = await context.newPage();
        page.on("pageerror", (error) =>
          failures.push(`${theme} ${viewport.width}: ${error.message}`),
        );
        // Opening the setup dialog starts setup; here it only shows the run already stored.
        await page.route("**/api/v1/servers/*/setup", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          await route.fulfill({
            response: await route.fetch({ method: "GET", postData: undefined }),
          });
        });
        const servers = `${stack.consoleUrl}/acme/dashboard/servers`;
        await page.goto(servers, { waitUntil: "networkidle" });
        // Other work in this checkout can make the dev server reload the page; try again then.
        const attempt = async (name: string, serverId: string, kind: "setup" | "details") => {
          for (let tries = 1; ; tries++) {
            try {
              await shot(page, name, serverId, kind, theme, viewport.width);
              return;
            } catch (error) {
              if (tries >= 4) throw error;
              await page.goto(servers, { waitUntil: "networkidle" });
            }
          }
        };
        await attempt("setup-running", building, "setup");
        await attempt("setup-wrong-user", refused, "setup");
        await attempt("details", ready, "details");
        await context.close();
      }
    }
  } finally {
    await browser.close();
    await runner.close();
  }
} finally {
  await stack.stop();
}

async function shot(
  page: Page,
  name: string,
  serverId: string,
  kind: "setup" | "details",
  theme: string,
  width: number,
): Promise<void> {
  const dialogId = kind === "setup" ? "#nz-server-setup" : "#nz-server-details";
  await page.evaluate(
    ({ kind, serverId }) => {
      document.dispatchEvent(
        new CustomEvent(`nz:server-${kind}`, {
          detail: { serverId, server: null },
          cancelable: true,
        }),
      );
    },
    { kind, serverId },
  );
  await page.waitForSelector(`${dialogId}[open]`, { timeout: 15_000 });
  if (kind === "setup")
    await page.waitForSelector(`${dialogId} [data-setup-log] .nz-log-line:not(.nz-dim)`, {
      timeout: 15_000,
    });
  else await page.waitForSelector(`${dialogId} .nz-check-item`, { timeout: 15_000 });
  await page.waitForTimeout(2500);
  const box = await page.evaluate((selector) => {
    const dialog = document.querySelector(selector) as HTMLElement;
    const rect = dialog.getBoundingClientRect();
    return { right: rect.right, scroll: document.documentElement.scrollWidth, width: innerWidth };
  }, dialogId);
  if (box.right > box.width + 1 || box.scroll > box.width + 1) {
    failures.push(`${name} ${theme} ${width}: wider than the screen (${JSON.stringify(box)})`);
  }
  await page.screenshot({ path: join(OUT, `${name}-${theme}-${width}.png`) });
  if (kind === "details") {
    await page.evaluate((selector) => {
      const dialog = document.querySelector(selector) as HTMLElement;
      dialog.scrollTop = dialog.scrollHeight;
      (dialog.querySelector(".nz-dialog-body") as HTMLElement | null)?.scrollTo?.(0, 99_999);
    }, dialogId);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, `${name}-lower-${theme}-${width}.png`) });
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`Saved the dialogs to ${OUT}`);
