import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { FakeRunner } from "../test-support/fake-runner.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * Backups end to end through the console (spec 08 8.3, 17.1, 17.2): the owner adds a
 * destination in Settings → Backups and tests it, adds a backup to a Postgres database, runs it
 * now and watches its row turn Succeeded without a reload, then restores it with the typed
 * name and follows the live log to "Restored". The server is a pretend runner that speaks the
 * real protocol over a real WebSocket (test-support/fake-runner.ts); the DinD suite in
 * e2e/backups covers real databases and MinIO.
 *
 *   bun test e2e/backups.e2e.ts             (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...        (uses the dev server instead)
 *
 * Needs the development PostgreSQL; uses ports 4180 and 4480 and a database named nz_m5_….
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const SHOTS = resolve(CONSOLE_ROOT, "test-artifacts", "m5");
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;

let stack: Stack;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let runner: FakeRunner;
let api: ApiSession;
let databasePath = "";
const problems: string[] = [];

function watch(target: Page): void {
  target.on("request", (request) => {
    const url = new URL(request.url());
    for (const name of ["secretAccessKey", "accessKeyId", "password", "confirm"]) {
      if (url.searchParams.has(name)) problems.push(`${name} in an address: ${url.pathname}`);
    }
  });
  target.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() === "error" && !/status of (4\d\d)/.test(message.text())) {
      problems.push(`console error: ${message.text()}`);
    }
  });
}

async function toast(text: string | RegExp): Promise<string> {
  const match = page.locator(".nz-toast", { hasText: text }).last();
  await match.waitFor({ timeout: 20_000 });
  return ((await match.textContent()) ?? "").trim();
}

beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  if (process.env.E2E_CONSOLE !== "dev") {
    await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  }
  stack = await startStack({
    console: process.env.E2E_CONSOLE === "dev" ? "dev" : "built",
    label: "backups",
    controlPort: 4180,
    consolePort: 4480,
    databasePrefix: "nz_m5",
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  api = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  await api.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await api.call("POST", "/onboarding/skip-invitations");
  // A server whose runner is the pretend one, and a Postgres database on it.
  const generated = await api.call<{ publicKey: string; privateKey: string }>(
    "POST",
    "/ssh-keys/generate",
    { type: "ed25519", name: "fake" },
  );
  const key = await api.call<{ key: { id: string } }>("POST", "/ssh-keys", {
    name: "fake",
    publicKey: generated.publicKey,
    privateKey: generated.privateKey,
  });
  const server = await api.call<{ server: { id: string } }>("POST", "/servers", {
    name: "Fake server",
    sshKeyId: key.key.id,
    address: "203.0.113.10",
    port: 22,
    sshUser: "root",
  });
  const join = await api.call<{ token: string }>(
    "POST",
    `/servers/${server.server.id}/join-command`,
  );
  runner = await FakeRunner.join(stack.controlUrl, join.token);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const view = await api.call<{ server: { readiness: string } }>(
      "GET",
      `/servers/${server.server.id}`,
    );
    if (view.server.readiness === "ready") break;
    if (Date.now() > deadline)
      throw new Error(`the fake server never became ready (${view.server.readiness})`);
    await Bun.sleep(300);
  }
  const project = await api.call<{ project: { id: string }; environmentId: string }>(
    "POST",
    "/projects",
    {
      name: "storefront",
    },
  );
  const database = await api.call<{ service: { id: string } }>(
    "POST",
    `/environments/${project.environmentId}/services`,
    { kind: "postgres", name: "db", serverId: server.server.id },
  );
  runner.services.add(database.service.id);
  databasePath = `/acme/dashboard/projects/${project.project.id}/${project.environmentId}/services/${database.service.id}/backups`;

  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INSECURE_CONTEXT);
  await context.addCookies([
    { name: "nz_session", value: api.sessionToken(), url: stack.consoleUrl },
    { name: "nz_theme", value: "dusk", url: stack.consoleUrl },
  ]);
  page = await context.newPage();
  watch(page);
}, 600_000);

afterAll(async () => {
  runner?.stop();
  await browser?.close();
  await stack?.stop();
});

describe("backups through the console", () => {
  test("a destination is added in Settings → Backups and tests as connected", async () => {
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/backups`);
    expect(await page.locator("h1.nz-title").textContent()).toBe("Backup destinations");
    await page.getByRole("button", { name: "Add destination" }).click();
    const dialog = page.locator("#nz-destination");
    await dialog.waitFor({ state: "visible" });
    await dialog.locator("#nz-destination-name").fill("Offsite");
    await dialog.locator("#nz-destination-provider").selectOption("minio");
    expect(await dialog.locator("#nz-destination-endpoint").inputValue()).toBe(
      "https://minio.example.com:9000",
    );
    await dialog.locator("#nz-destination-endpoint").fill("http://minio.internal:9000");
    await dialog.locator("#nz-destination-bucket").fill("acme-backups");
    await dialog.locator("#nz-destination-access").fill("e2e-access-key");
    await dialog.locator("#nz-destination-secret").fill("e2e-secret-key-value");
    await dialog.getByRole("button", { name: "Add destination" }).click();
    expect(await toast("Destination added")).toContain("Destination added");
    await page.locator("[data-destination-row]", { hasText: "Offsite" }).waitFor();
    expect(await page.content()).not.toContain("e2e-secret-key-value");
    await page.getByRole("button", { name: "Test" }).click();
    expect(await toast("Connected. Nearzero can list acme-backups.")).toContain("acme-backups");
    expect(runner.commands).toContain("backup.test");
    await page.screenshot({ path: resolve(SHOTS, "e2e-settings-backups.png") });
  }, 120_000);

  test("a backup is added, run now, and its row turns Succeeded without a reload", async () => {
    await page.goto(`${stack.consoleUrl}${databasePath}`);
    await page.getByRole("button", { name: "Add backup" }).click();
    const dialog = page.locator("#nz-schedule");
    await dialog.waitFor({ state: "visible" });
    expect(await dialog.locator("#nz-schedule-cron-hint").textContent()).toContain(
      "Times are in the server's time zone (Europe/Berlin).",
    );
    await dialog.locator("#nz-schedule-keep").fill("2");
    await dialog.getByRole("button", { name: "Add backup" }).click();
    expect(await toast("Backup schedule added")).toContain("added");
    const row = page.locator("[data-schedule-row]").first();
    await row.waitFor();
    expect(await row.textContent()).toContain("Every day at 03:00");
    expect(await row.textContent()).toContain("Keeps last 2");
    expect(await row.textContent()).toContain("Not run yet");
    const marker = await page.evaluate(() => {
      (window as unknown as { nzMarker: number }).nzMarker = 42;
      return 42;
    });
    await row.getByRole("button", { name: "Run now" }).click();
    expect(await toast(/Backup started/)).toContain("Backup started");
    await row
      .locator("[data-run-pill] .nz-pill", { hasText: "Succeeded" })
      .waitFor({ timeout: 30_000 });
    // Still the same page: nothing reloaded.
    expect(await page.evaluate(() => (window as unknown as { nzMarker?: number }).nzMarker)).toBe(
      marker,
    );
    expect(runner.bucket.size).toBe(1);
    await page.screenshot({ path: resolve(SHOTS, "e2e-database-backups.png") });
    // The run's log, from the row's menu.
    await row.getByRole("button", { name: /More for/ }).click();
    await page.getByRole("menuitem", { name: "Show last run's log" }).click();
    const log = page.locator("#nz-run-log [data-run-log-text]");
    await page
      .locator("#nz-run-log [data-run-log-state]", { hasText: "Succeeded" })
      .waitFor({ timeout: 15_000 });
    expect(await log.textContent()).toContain("Initializing backup (Nearzero");
    await page.keyboard.press("Escape");
  }, 120_000);

  test("a restore lists this service's backups, needs the typed name, and ends Restored", async () => {
    // A schedule row's Restore opens on its destination and folder (R3-46).
    const row = page.locator("[data-schedule-row]").first();
    await row.getByRole("button", { name: "Restore", exact: true }).click();
    const dialog = page.locator("#nz-restore");
    await dialog.waitFor({ state: "visible" });
    expect(await dialog.locator("#nz-restore-folder").inputValue()).toBe("nightly");
    await dialog.getByRole("button", { name: "Find backups" }).click();
    await dialog.locator('input[name="restoreKey"]').first().waitFor();
    expect(await dialog.locator('input[name="restoreKey"]').count()).toBe(1);
    await dialog.getByRole("button", { name: "Restore into database" }).first().click();
    // The confirm step names the database the backup goes into, and it can be changed (R3-45).
    const into = dialog.locator("#nz-restore-database");
    expect(await into.inputValue()).toBe("postgres");
    expect(await dialog.locator("[data-restore-into]").textContent()).toBe("postgres");
    expect(await dialog.locator("[data-restore-warning]").textContent()).toBe(
      "The restore overwrites the data in postgres. It can't be undone.",
    );
    await into.fill("postgres_copy");
    expect(await dialog.locator("[data-restore-into]").textContent()).toBe("postgres_copy");
    const go = dialog.locator("[data-restore-go]");
    expect(await go.isDisabled()).toBe(true);
    await dialog.locator("#nz-restore-confirm").fill("dbx");
    expect(await go.isDisabled()).toBe(true);
    await dialog.locator("#nz-restore-confirm").fill("db");
    await go.click();
    await dialog
      .locator("[data-restore-state]", { hasText: "Restored" })
      .waitFor({ timeout: 30_000 });
    expect(await dialog.locator("[data-restore-log]").textContent()).toContain(
      "Loading the dump (psql)",
    );
    await page.screenshot({ path: resolve(SHOTS, "e2e-restore.png") });
    expect(runner.commands).toContain("restore.database");
    expect(runner.lastParams.get("restore.database")).toMatchObject({
      database: "postgres_copy",
      sourceDatabase: "postgres",
    });
    expect(problems).toEqual([]);
  }, 120_000);
});
