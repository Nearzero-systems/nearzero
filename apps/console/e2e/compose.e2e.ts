import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type FakeCompose, installFakeCompose } from "../../control/test/support/fake-compose.ts";
import { connectFakeHost, type FakeHost, handoffFolder } from "../test-support/fake-runner-link.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * A Compose stack end to end through the console (spec 07 7.1, 7.2): the owner pastes a
 * three-service Compose file in Add New → Compose, lands on its Compose page, deploys it from
 * the header and follows the live deploy log to "Deployment complete", sees the three
 * containers in the Containers table, opens a container's logs from its row menu, and opens
 * Preview Compose to see their file and Nearzero's additions. The server is the pretend host
 * runner with a pretend Docker Compose (apps/control/test/support/fake-compose.ts); the DinD
 * suite in e2e/compose covers real Docker.
 *
 *   bun test e2e/compose.e2e.ts             (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...        (uses the dev server instead)
 *
 * Needs the development PostgreSQL; uses ports 4220 and 4520 and a database named nz_m7_….
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const SHOTS = resolve(CONSOLE_ROOT, "test-artifacts", "m7");
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const FILE = `services:
  web:
    image: nginx:1.29-alpine
    expose: ["80"]
    depends_on: [api]
  api:
    image: busybox:1.37
    command: ["sh", "-c", "while true; do sleep 5; done"]
  cache:
    image: redis:8-alpine
`;

let stack: Stack;
let host: FakeHost;
let compose: FakeCompose;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let api: ApiSession;
let envPath = "";
const problems: string[] = [];

async function toast(text: string | RegExp): Promise<string> {
  const match = page.locator(".nz-toast", { hasText: text }).last();
  await match.waitFor({ timeout: 30_000 });
  return ((await match.textContent()) ?? "").trim();
}

beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  if (process.env.E2E_CONSOLE !== "dev") {
    await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  }
  const handoff = await handoffFolder("m7-e2e");
  stack = await startStack({
    console: process.env.E2E_CONSOLE === "dev" ? "dev" : "built",
    label: "compose",
    controlPort: 4220,
    consolePort: 4520,
    databasePrefix: "nz_m7",
    env: { NEARZERO_RUNNER_HANDOFF_DIR: handoff, NEARZERO_DNS_RESOLVERS: "127.0.0.1:9" },
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  api = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  await api.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await api.call("POST", "/onboarding/skip-invitations");
  host = await connectFakeHost(stack.controlUrl, handoff);
  compose = installFakeCompose(host.runner);
  const workspace = await api.call<{ workspace: { slug: string } }>("GET", "/workspace");
  const project = await api.call<{ project: { id: string }; environmentId: string }>(
    "POST",
    "/projects",
    { name: "Shop" },
  );
  envPath = `/${workspace.workspace.slug}/dashboard/projects/${project.project.id}/${project.environmentId}`;
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies([
    { name: "nz_session", value: api.sessionToken(), url: stack.consoleUrl },
    { name: "nz_theme", value: "dusk", url: stack.consoleUrl },
  ]);
  page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (4\d\d)/.test(message.text())) {
      problems.push(`console error: ${message.text()}`);
    }
  });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await host?.close();
  await stack?.stop();
});

describe("a pasted Compose stack through the console", () => {
  test("Add New → Compose, then Deploy, follows the live log to the running containers", async () => {
    await page.goto(`${stack.consoleUrl}${envPath}/overview`, {
      waitUntil: "load",
      timeout: 120_000,
    });
    await page.evaluate(() =>
      (document.getElementById("nz-compose-create") as HTMLDialogElement).showModal(),
    );
    await page.locator("#nz-compose-name").fill("shop");
    await page.locator("#nz-compose-file").fill(FILE);
    await page.getByRole("button", { name: "Create Compose service" }).click();
    await page.locator("[data-compose-page]").waitFor({ timeout: 30_000 });
    expect(await page.locator(".nz-service-head .nz-badge").textContent()).toBe("Compose");
    // The header names the service (spec 7.2; B3-25).
    expect(await page.locator("#nz-compose-title").textContent()).toBe("shop");
    // The Variables and Volume backups cards line up with the other sections' content, 24px in
    // from both edges (B3-26). Measured in one go, once the page has settled.
    await page.waitForLoadState("networkidle");
    const edges = await page.evaluate(() => {
      const rect = (selector: string) => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`${selector} isn't on the page.`);
        const { left, right } = element.getBoundingClientRect();
        return { left: Math.round(left), right: Math.round(right) };
      };
      return {
        section: rect("#nz-compose-source"),
        variables: rect("#nz-compose-variables .nz-vars-card"),
        backups: rect("#nz-compose-backups .nz-backups-panel"),
      };
    });
    for (const card of [edges.variables, edges.backups]) {
      expect(card).toEqual({ left: edges.section.left + 24, right: edges.section.right - 24 });
    }

    // Preview before the first deploy: the file as it is and Nearzero's additions.
    await page.locator("[data-compose-preview]").click();
    await page
      .locator("#nz-compose-preview[open] [data-compose-preview-files]:not([hidden])")
      .waitFor({ timeout: 15_000 });
    const tabs = await page.locator("[data-compose-file-tab]").allTextContents();
    expect(tabs).toEqual(["Your Compose file", "Nearzero's additions"]);
    // The create form saves the file without its last newline.
    expect((await page.locator("[data-compose-file-content]").textContent())?.trimEnd()).toBe(
      FILE.trimEnd(),
    );
    await page.locator("[data-compose-file-tab]").nth(1).click();
    expect(await page.locator("[data-compose-file-content]").textContent()).toContain(
      "dev.nearzero.service",
    );
    await page.screenshot({ path: resolve(SHOTS, "e2e-preview.png") });
    await page.locator("#nz-compose-preview [data-dialog-close]").last().click();

    // Deploy from the header, confirmed.
    await page.locator('[data-service-action="deploy"]').click();
    await page.locator("[data-confirm-action-go]").click();
    expect(await toast("Deployment complete")).toContain("Deployment complete");
    expect(compose.deploys.length).toBe(1);
    const sent = compose.deploys[0] as { files: { content: string }[] };
    expect(sent.files[0]?.content.trimEnd()).toBe(FILE.trimEnd());

    // The page refreshes itself when the deploy ends; let it settle, then load it fresh.
    await page.waitForTimeout(2_000);
    await page.reload({ waitUntil: "load" });
    // Three containers, each with its inner service.
    await page.locator("[data-compose-rows] tr").nth(2).waitFor({ timeout: 30_000 });
    const services = await page
      .locator("[data-compose-rows] tr td:first-child .font-medium")
      .allTextContents();
    expect(services).toEqual(["api", "cache", "web"]);
    await page.screenshot({ path: resolve(SHOTS, "e2e-deployed.png"), fullPage: true });

    // View logs from a container's row menu: the Logs section follows that container.
    await page.locator("[data-compose-row-menu]").nth(2).click();
    await page.locator('#nz-compose-container-menu [data-compose-row-action="logs"]').click();
    await page
      .locator("[data-runtime-logs] [data-logs-lines]", { hasText: "web is up" })
      .waitFor({ timeout: 20_000 });

    // A deployment row opens its log.
    await page.locator("[data-deployment-log-open]").first().click();
    await page
      .locator("#nz-deployment-log[open] [data-log-lines]", { hasText: "Deployment complete" })
      .waitFor({ timeout: 20_000 });
    expect(problems).toEqual([]);
  }, 300_000);
});
