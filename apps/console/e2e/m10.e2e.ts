import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { handoffFolder } from "../test-support/fake-runner-link.ts";
import { M10Runner } from "../test-support/m10-runner.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * Tasks, Analytics, monitoring and notification channels through the console (spec 12–15), and
 * a sweep of their pages in Light, Dark and Dusk at 375, 768, 1024 and 1440px:
 * - a task is added (a syntax error on line 3 is refused with its line first), run, and its run
 *   shows Succeeded with its log in the Run history panel;
 * - a Custom webhook channel is added and its Test notification reaches a local fake server;
 * - Analytics counts the host router's requests (a pretend request log) and opens a request;
 * - About Nearzero and a server's details show live monitoring, and alert thresholds save.
 * The servers are pretend runners over the real WebSocket (test-support/m10-runner.ts). The
 * sweep fails on script or console errors and on horizontal page scroll.
 *
 *   bun test e2e/m10.e2e.ts            (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...   (uses the dev server instead)
 *
 * Needs the development PostgreSQL; uses ports 4230 and 4530 and a database named nz_m10_….
 * Screenshots go to test-artifacts/m10/.
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const SHOTS = resolve(CONSOLE_ROOT, "test-artifacts", "m10");
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;
const THEMES = ["light", "dark", "dusk"] as const;
const WIDTHS = [375, 768, 1024, 1440];

let stack: Stack;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let host: M10Runner;
let server: M10Runner;
let api: ApiSession;
let serverId = "";
let hook: ReturnType<typeof Bun.serve>;
const hookRequests: unknown[] = [];
const problems: string[] = [];

function watch(target: Page): void {
  target.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() === "error" && !/status of (4\d\d)/.test(message.text())) {
      problems.push(`console error: ${message.text()}`);
    }
  });
}

async function toast(text: string | RegExp): Promise<string> {
  const match = page.locator(".nz-toast", { hasText: text }).last();
  await match.waitFor({ timeout: 40_000 });
  return ((await match.textContent()) ?? "").trim();
}

/** The page's own script runs before anything is clicked (slow machines load it late). */
async function settle(): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
}

async function setTheme(theme: string): Promise<void> {
  await context.addCookies([{ name: "nz_theme", value: theme, url: stack.consoleUrl }]);
}

async function shoot(name: string, path: string, ready?: () => Promise<void>): Promise<void> {
  for (const theme of ["dusk", "light"] as const) {
    await setTheme(theme);
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: width === 375 ? 812 : 900 });
      await page.goto(`${stack.consoleUrl}${path}`);
      await page.waitForLoadState("networkidle").catch(() => {});
      await ready?.();
      await page.screenshot({
        path: resolve(SHOTS, `${name}-${theme}-${width}.png`),
        fullPage: true,
      });
    }
  }
  await setTheme("dusk");
  await page.setViewportSize({ width: 1280, height: 900 });
}

beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  if (process.env.E2E_CONSOLE !== "dev") await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  const folder = await handoffFolder("m10");
  stack = await startStack({
    console: process.env.E2E_CONSOLE === "dev" ? "dev" : "built",
    label: "m10",
    controlPort: 4230,
    consolePort: 4530,
    databasePrefix: "nz_m10",
    env: { NEARZERO_RUNNER_HANDOFF_DIR: folder },
  });
  hook = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      hookRequests.push(await request.json().catch(() => null));
      return Response.json({ ok: true });
    },
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  api = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  await api.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await api.call("POST", "/onboarding/skip-invitations");
  host = await M10Runner.joinHost(stack.controlUrl, folder);
  host.addRequests(120, "shop.example.com");
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
  const created = await api.call<{ server: { id: string } }>("POST", "/servers", {
    name: "web-1",
    sshKeyId: key.key.id,
    address: "203.0.113.10",
    port: 22,
    sshUser: "root",
  });
  serverId = created.server.id;
  const join = await api.call<{ token: string }>("POST", `/servers/${serverId}/join-command`);
  server = await M10Runner.join(stack.controlUrl, join.token);
  const deadline = Date.now() + 30_000;
  for (;;) {
    const view = await api.call<{ server: { readiness: string } }>("GET", `/servers/${serverId}`);
    if (view.server.readiness === "ready") break;
    if (Date.now() > deadline)
      throw new Error(`the fake server never became ready (${view.server.readiness})`);
    await Bun.sleep(300);
  }
  const project = await api.call<{ project: { id: string }; environmentId: string }>(
    "POST",
    "/projects",
    { name: "storefront" },
  );
  const app = await api.call<{ service: { id: string } }>(
    "POST",
    `/environments/${project.environmentId}/services`,
    {
      kind: "application",
      name: "web",
      serverId,
    },
  );
  server.services.add(app.service.id);

  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INSECURE_CONTEXT);
  await context.addCookies([
    { name: "nz_session", value: api.sessionToken(), url: stack.consoleUrl },
    { name: "nz_theme", value: "dusk", url: stack.consoleUrl },
  ]);
  page = await context.newPage();
  watch(page);
}, 900_000);

afterAll(async () => {
  host?.stop();
  server?.stop();
  hook?.stop(true);
  await browser?.close();
  await stack?.stop();
});

describe("M10 through the console", () => {
  test("Tasks: Check and save refuses line 3, then saves; Run shows Succeeded with its log", async () => {
    await page.goto(`${stack.consoleUrl}/acme/dashboard/tasks`);
    await settle();
    expect(await page.locator(".nz-empty-title").textContent()).toBe("No tasks found");
    expect(await page.locator(".nz-empty-text").textContent()).toBe(
      "Create your first scheduled task to automate workflows.",
    );
    await page.getByRole("button", { name: "Add task" }).first().click();
    const dialog = page.locator("#nz-task");
    await dialog.waitFor({ state: "visible" });
    await dialog.locator("#nz-task-name").fill("Clear cache");
    expect(await dialog.locator("#nz-task-place option").allTextContents()).toEqual(
      expect.arrayContaining(["web (storefront / development)", "web-1", "Nearzero host"]),
    );
    await dialog
      .locator("#nz-task-place")
      .selectOption({ label: "web (storefront / development)" });
    await dialog.locator("#nz-task-preset").selectOption({ label: "Every minute" });
    await dialog.locator("#nz-task-zone").fill("Asia/Kolkata");
    expect(await dialog.locator("[data-task-next]").textContent()).toContain("(Asia/Kolkata)");
    await dialog.locator("#nz-task-script").fill("echo one\necho two\nif true; then\n");
    await dialog.getByRole("button", { name: "Check and save" }).click();
    await dialog.locator("#nz-task-script-error", { hasText: "line 3" }).waitFor();
    await page.screenshot({ path: resolve(SHOTS, "e2e-task-line-3.png") });
    await dialog.locator("#nz-task-script").fill("rm -rf /tmp/cache\necho cleared\n");
    await dialog.getByRole("button", { name: "Check and save" }).click();
    // A container's two-line command runs as one shell command: warned, then Save anyway (G3-15).
    await dialog
      .locator('[data-task-notes] [data-tone="warning"]', {
        hasText: "the task fails only if the last one does",
      })
      .waitFor();
    await dialog.getByRole("button", { name: "Save anyway" }).click();
    expect(await toast("Task created")).toContain("Task created");
    const row = page.locator("[data-task-row]", { hasText: "Clear cache" });
    await row.waitFor();
    // The Cron column shows the cron, with the schedule in words on hover (spec 21.10).
    expect(await row.textContent()).toContain("* * * * *");
    expect(await row.locator('[title^="Every minute"]').count()).toBe(1);
    expect(await row.textContent()).toContain("Asia/Kolkata");
    await row.getByRole("button", { name: "Run" }).click();
    expect(await toast("Task started")).toContain("Task started");
    const panel = page.locator("#nz-task-history");
    await panel.waitFor({ state: "visible" });
    await panel.locator(".nz-pill", { hasText: "Succeeded" }).first().waitFor({ timeout: 30_000 });
    await panel
      .locator("[data-run-log]", { hasText: "Done." })
      .first()
      .waitFor({ timeout: 15_000 });
    await page.screenshot({ path: resolve(SHOTS, "e2e-task-history.png") });
    await page.keyboard.press("Escape");
  }, 180_000);

  test("Channels: a Custom webhook channel's Test notification arrives", async () => {
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/channels`);
    await settle();
    expect(await page.locator("h1.nz-title").textContent()).toBe("Notifications");
    expect(await page.locator(".nz-empty-text").textContent()).toBe(
      "To send notifications, add at least one channel.",
    );
    await page.getByRole("button", { name: "Add notification" }).click();
    const dialog = page.locator("#nz-channel");
    await dialog.waitFor({ state: "visible" });
    await dialog.locator("#nz-channel-name").fill("Ops hook");
    await dialog.locator("#nz-channel-type").selectOption("webhook");
    await dialog.locator("#nz-ch-webhook-url").fill(`http://127.0.0.1:${hook.port}/nearzero`);
    await dialog.getByRole("button", { name: "Add header" }).click();
    await dialog.locator("[data-header-name]").fill("Authorization");
    await dialog.locator("[data-header-value]").fill("Bearer e2e-header-secret");
    await dialog.getByLabel("Deploy failed").check();
    await dialog.getByLabel("Server alert").check();
    await dialog.getByRole("button", { name: "Test notification" }).click();
    await dialog
      .locator("[data-channel-test-result]", {
        hasText: "Test sent. Check Custom webhook for the message.",
      })
      .waitFor();
    expect(hookRequests.length).toBe(1);
    await page.screenshot({ path: resolve(SHOTS, "e2e-channel-test.png") });
    await dialog.getByRole("button", { name: "Save" }).click();
    expect(await toast("Notification channel added")).toContain("added");
    const row = page.locator("[data-channel-row]", { hasText: "Ops hook" });
    await row.waitFor();
    expect(await row.textContent()).toContain("Failed deploys, Server alerts");
    expect(await page.content()).not.toContain("e2e-header-secret");
  }, 120_000);

  test("Analytics counts the host's requests, and a request opens in the drawer", async () => {
    await page.goto(`${stack.consoleUrl}/acme/dashboard/analytics`);
    await settle();
    await page.locator(".nz-stat-value").first().waitFor();
    expect((await page.locator(".nz-stat-value").first().textContent())?.trim()).toBe("120");
    expect(await page.locator(".nz-analytics-note").textContent()).toBe(
      "Requests to apps on other servers are not counted yet.",
    );
    expect(await page.locator(".nz-busy-hosts").textContent()).toContain("shop.example.com");
    await page.locator("[data-request]").first().click();
    const drawer = page.locator("#nz-request-drawer");
    await drawer.waitFor({ state: "visible" });
    expect(await drawer.locator("[data-request-json]").textContent()).toContain("RequestHost");
    await drawer.getByRole("button", { name: "Copy JSON" }).click();
    expect(await toast(/Copied/)).toContain("Copied");
    await page.screenshot({ path: resolve(SHOTS, "e2e-analytics-drawer.png") });
    await page.keyboard.press("Escape");
    // Closing gives focus back to the row a moment later (the close event is queued); focusing
    // the chart before that would lose focus to the row.
    await page.waitForFunction(() => document.activeElement?.matches("[data-request]") === true);
    // The chart's crosshair follows the keyboard.
    await page.locator(".nz-analytics-chart [data-line-chart]").focus();
    await page.keyboard.press("ArrowLeft");
    expect(await page.locator(".nz-analytics-chart .nz-chart-tip").isVisible()).toBe(true);
    // The confirms say what happens next, with logging on (G3-16).
    expect(await page.locator("#nz-analytics-delete").textContent()).toContain(
      "Request logging stays on, so new requests show up again right away.",
    );
    expect(await page.locator("#nz-analytics-logging").textContent()).toContain(
      "Requests already recorded stay until the next cleanup.",
    );
    // A status chip filters at once.
    await page.locator(".nz-status-chip", { hasText: "5xx" }).click();
    await page.waitForURL(/status=5xx/);
    expect(Number((await page.locator(".nz-stat-value").first().textContent())?.trim())).toBe(12);
  }, 120_000);

  test("monitoring on About Nearzero and in a server's details; alert thresholds save", async () => {
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings`);
    await settle();
    const panel = page.locator("[data-host-monitoring-mount] [data-monitoring]");
    await panel.locator('[data-metric="cpu"]', { hasText: "%" }).waitFor({ timeout: 20_000 });
    expect(await panel.textContent()).toContain(
      "Track host CPU, RAM, and storage usage for this Nearzero install.",
    );
    expect(await panel.locator('[data-metric="memory-detail"]').textContent()).toContain(
      "/ 8.0 GB",
    );
    await panel.locator(".nz-monitoring-charts .nz-chart").first().waitFor();
    await panel.locator('[name="cpuThreshold"]').fill("50");
    await panel.getByRole("button", { name: "Save alerts" }).click();
    expect(await toast("Alert settings saved")).toContain("saved");
    await panel.getByRole("button", { name: "Send a test alert" }).click();
    expect(await toast(/Test alert sent to 1 channel|No notification channel/)).toBeTruthy();

    await page.goto(`${stack.consoleUrl}/acme/dashboard/servers`);

    await settle();
    await page.evaluate(
      (id) =>
        document.dispatchEvent(
          new CustomEvent("nz:server-details", { detail: { serverId: id }, cancelable: true }),
        ),
      serverId,
    );
    const details = page.locator("#nz-server-details");
    await details.waitFor({ state: "visible" });
    await details
      .locator('[data-monitoring] [data-metric="cpu"]', { hasText: "%" })
      .waitFor({ timeout: 20_000 });
    await page.screenshot({
      path: resolve(SHOTS, "e2e-server-details-monitoring.png"),
      fullPage: true,
    });
  }, 120_000);

  test("screenshots in Dusk and Light at 1440 and 375", async () => {
    await shoot("tasks", "/acme/dashboard/tasks");
    await shoot("analytics", "/acme/dashboard/analytics");
    await shoot("channels", "/acme/dashboard/settings/channels");
    await shoot("about-monitoring", "/acme/dashboard/settings", async () => {
      await page
        .locator('[data-host-monitoring-mount] [data-metric="cpu"]', { hasText: "%" })
        .waitFor({ timeout: 20_000 });
    });
  }, 300_000);

  test("sweep: every M10 page in three themes and four widths, no horizontal scroll, no errors", async () => {
    const routes = [
      "/acme/dashboard/tasks",
      "/acme/dashboard/analytics",
      "/acme/dashboard/settings/channels",
      "/acme/dashboard/settings",
    ];
    const found: string[] = [];
    for (const theme of THEMES) {
      await setTheme(theme);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        for (const route of routes) {
          await page.goto(`${stack.consoleUrl}${route}`);
          await page.waitForLoadState("networkidle").catch(() => {});
          const check = await page.evaluate(() => ({
            theme: document.documentElement.dataset.theme ?? "",
            overflow: document.documentElement.scrollWidth - window.innerWidth,
          }));
          if (check.overflow > 1)
            found.push(`${route} ${theme} ${width}px scrolls sideways by ${check.overflow}px`);
          if (check.theme !== theme) found.push(`${route} rendered ${check.theme}, not ${theme}`);
        }
      }
    }
    await setTheme("dusk");
    expect([...found, ...problems]).toEqual([]);
  }, 600_000);
});
