import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { connectFakeHost, type FakeHost, handoffFolder } from "../test-support/fake-runner-link.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * Deploys, domains, servers and deployments end to end (spec 6.1–6.3, 10.5, 9.2, 9.7, 11.1–11.2)
 * against a running control plane with a pretend host runner that speaks the real protocol
 * (test-support/fake-runner-link.ts), so deploys finish without Docker:
 * - an app from a container image is created with Create & deploy; the build panel follows it to
 *   "Deployment complete. It's live at: …", the service page shows the "Live at" banner once, and
 *   the Deployments list's log dialog has the whole log;
 * - a hostname is added through the Domains page's wizard, inside a managed DNS zone;
 * - an SSH key is generated and saved, and a server is added after the API refused a bad address;
 * - the Deployments page lists the deploy and its detail shows the build log.
 *
 *   bun test e2e/operations.e2e.ts --timeout=300000      (builds the console first)
 *   E2E_CONSOLE=dev bun test e2e/operations.e2e.ts ...   (uses the dev server)
 *
 * Needs the development PostgreSQL; uses ports 4200 and 4500 (E2E_CONTROL_PORT and
 * E2E_CONSOLE_PORT change them) and a database nz_m2d_ops_*.
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const BUILD = "test-artifacts/m2d-build";
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;

let stack: Stack;
let host: FakeHost;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let base = "";
const problems: string[] = [];

function watch(target: Page): void {
  target.on("request", (request) => {
    const url = new URL(request.url());
    for (const name of ["password", "privateKey", "registry.password"]) {
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
  // Its own build folder, so another flow rebuilding dist/ can't swap files under this one.
  if (process.env.E2E_CONSOLE !== "dev") {
    await $`bun --bun astro build --outDir ${BUILD}`
      .cwd(CONSOLE_ROOT)
      .env({ ...process.env, ASTRO_TELEMETRY_DISABLED: "1" })
      .quiet();
  }
  const handoff = await handoffFolder("ops");
  stack = await startStack({
    console: process.env.E2E_CONSOLE === "dev" ? "dev" : "built",
    consoleEntry: `./${BUILD}/server/entry.mjs`,
    label: "ops",
    databasePrefix: "nz_m2d",
    controlPort: Number(process.env.E2E_CONTROL_PORT) || 4200,
    consolePort: Number(process.env.E2E_CONSOLE_PORT) || 4500,
    env: {
      NEARZERO_RUNNER_HANDOFF_DIR: handoff,
      NEARZERO_PLATFORM_DOMAIN: "apps.e2e.test",
      NEARZERO_PUBLIC_IP: "203.0.113.10",
      NEARZERO_DNS_RESOLVERS: "127.0.0.1:9",
    },
  });
  base = `${stack.consoleUrl}/acme/dashboard`;
  await stack.createOwner(OWNER.email, OWNER.password);
  host = await connectFakeHost(stack.controlUrl, handoff);
  const api = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  await api.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await api.call("POST", "/onboarding/skip-invitations");
  // The project (its own flow is projects.e2e.ts) and a managed zone, so the wizard can add a
  // hostname without waiting for public DNS.
  await api.call("POST", "/projects", { name: "storefront" });
  await api.call("POST", "/domains/zones", {
    domain: "e2e-zone.test",
    adminEmail: "dns@e2e-zone.test",
  });
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INSECURE_CONTEXT);
  await context.addCookies([
    { name: "nz_session", value: api.sessionToken(), url: stack.consoleUrl },
    { name: "nz_theme", value: "dusk", url: stack.consoleUrl },
  ]);
  page = await context.newPage();
  watch(page);
}, 400_000);

afterAll(async () => {
  await browser?.close();
  await host?.close();
  await stack?.stop();
});

describe("deploys, domains, servers and deployments, end to end", () => {
  let serviceUrl = "";
  let liveUrl = "";

  test("Create & deploy follows the build to its address, and the service page shows Live at", async () => {
    await page.goto(`${base}/projects`);
    await page.locator(".nz-project-card", { hasText: "storefront" }).first().click();
    await page.waitForURL(/\/overview$/, { waitUntil: "commit" });
    await page.getByRole("button", { name: "Add New" }).click();
    await page.getByRole("menuitem", { name: "Application" }).click();
    await page.waitForURL(/\/new-application$/, { waitUntil: "commit" });
    await page.locator("[data-app-without-git]").waitFor();
    await page.locator("[data-app-without-git]").check();
    const form = page.locator("[data-app-image]");
    await form.locator('input[name="name"]').fill("web");
    await form.locator('input[name="settings.image"]').fill("nginx:alpine");
    await form.getByRole("button", { name: "Create & deploy" }).click();

    const panel = page.locator("[data-build-panel]");
    await panel.waitFor({ state: "visible", timeout: 20_000 });
    await panel
      .locator("[data-log-state]", { hasText: "Deployment complete" })
      .waitFor({ timeout: 90_000 });
    await panel.locator("[data-build-url]:not([hidden])").waitFor({ timeout: 20_000 });
    expect(await panel.locator("[data-build-message]").textContent()).toBe(
      "Deployment complete. It's live at:",
    );
    liveUrl = (await panel.locator("[data-build-url-text]").textContent()) ?? "";
    // The managed zone is every environment's default, so the app is named after itself in it
    // (spec 10.1), rather than a random label under the platform domain.
    expect(liveUrl).toBe("https://web.e2e-zone.test");
    const log = (await panel.locator("[data-log-lines]").textContent()) ?? "";
    expect(log).toContain("Initializing deployment (Nearzero");
    expect(log).toContain(`It's live at: ${liveUrl}`);

    await panel.getByRole("link", { name: "Open service" }).click();
    // In-app navigation: the address changes without a new document.
    await page.waitForURL(/\/services\/[^/]+$/, { waitUntil: "commit" });
    await page.locator(".nz-service-head").waitFor();
    serviceUrl = page.url();
    const banner = page.locator("[data-live-at]");
    await banner.waitFor({ state: "visible" });
    expect(await banner.locator("[data-live-at-url]").textContent()).toBe(liveUrl);
    await banner.getByRole("button", { name: "Dismiss" }).click();
    expect(await banner.isHidden()).toBe(true);

    // The Deployments list (spec 6.3) and its log dialog.
    const row = page.locator(".nz-deploy-row").first();
    expect(await row.locator(".nz-pill").textContent()).toBe("Active");
    await row.click();
    const dialog = page.locator("#nz-deployment-log");
    await dialog.locator(".nz-log-line", { hasText: "Deployment complete" }).waitFor();
    await dialog.locator(".nz-dialog-foot").getByRole("button", { name: "Close" }).click();

    // The banner shows once: not again after a reload.
    await page.reload();
    expect(await page.locator("[data-live-at]").isHidden()).toBe(true);
  }, 180_000);

  test("the terminal opens through the console's WebSocket bridge", async () => {
    await page.goto(serviceUrl);
    await page.getByRole("button", { name: "Terminal" }).click();
    const terminal = page.locator("#nz-terminal");
    await terminal
      .locator("[data-terminal-container] option")
      .first()
      .waitFor({ state: "attached" });
    await terminal.getByRole("button", { name: "Connect" }).click();
    // The pretend runner's shell ends at once: the exit frame came back through the bridge.
    await terminal
      .locator("[data-terminal-status]", { hasText: "The shell ended" })
      .waitFor({ timeout: 20_000 });
    await terminal.getByRole("button", { name: "Close" }).click();
    // Closed at once; it fades out over 120ms (spec 21.7).
    expect(await terminal.evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(false);
    await terminal.waitFor({ state: "hidden", timeout: 2_000 });
  }, 60_000);

  test("a hostname is added through the Add domain wizard", async () => {
    await page.goto(`${base}/domains`);
    await page.locator("[data-automatic-card]").waitFor();
    await page.getByRole("button", { name: "Add domain" }).first().click();
    const wizard = page.locator("#nz-domain-wizard");
    await wizard.locator("[data-wizard-host]").fill("http://shop.e2e-zone.test");
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.locator("text=Leave out http:// or https://.").waitFor();
    await wizard.locator("[data-wizard-host]").fill("shop.e2e-zone.test");
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.locator('[data-wizard-step="service"]:not([hidden])').waitFor();
    await wizard
      .locator('[data-pick="service"] option', { hasText: "web" })
      .waitFor({ state: "attached" });
    await wizard.getByRole("button", { name: "Next" }).click();
    await wizard.locator('[data-wizard-step="dns"]:not([hidden])').waitFor();
    await wizard.locator("[data-wizard-managed]:not([hidden])").waitFor();
    const add = wizard.locator("[data-wizard-add]");
    await expect(add.isDisabled()).resolves.toBe(false);
    await add.click();
    await wizard.locator('[data-wizard-step="https"]:not([hidden])').waitFor({ timeout: 30_000 });
    expect(await toast("Added shop.e2e-zone.test")).toContain("Added shop.e2e-zone.test");
    await wizard.locator("[data-wizard-done]").click();
    await page
      .locator("[data-hostname-row] a", { hasText: "shop.e2e-zone.test" })
      .first()
      .waitFor();
  }, 120_000);

  test("App Settings → Domains: the Hostnames block runs the card's width, left-aligned (B3-05)", async () => {
    await page.goto(`${serviceUrl}/settings`);
    await page.locator(".nz-fold-row--block").first().waitFor({ state: "attached" });
    const edges = await page.evaluate(() => {
      for (const fold of document.querySelectorAll("details")) fold.open = true;
      const rect = (element: Element | null) => {
        if (!element) throw new Error("A Domains row isn't on the page.");
        const { left, right } = element.getBoundingClientRect();
        return { left: Math.round(left), right: Math.round(right) };
      };
      const block = document.querySelector(".nz-fold-row--block");
      const rows = block?.closest(".nz-fold-rows") ?? block?.parentElement ?? null;
      const sibling = [...(rows?.children ?? [])].find(
        (row) => row.classList.contains("nz-fold-row") && row !== block,
      );
      return {
        block: rect(block),
        head: rect(block?.querySelector(".nz-fold-row-head") ?? null),
        sibling: rect(sibling ?? null),
      };
    });
    expect(edges.block).toEqual(edges.sibling);
    expect(edges.head).toEqual(edges.sibling);
  }, 60_000);

  test("the console answers 0.1.x's /api/health with the version (R4-11)", async () => {
    const answer = await fetch(`${stack.consoleUrl}/api/health`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ status: "ok", version: expect.any(String) });
  });

  test("an SSH key is generated and saved, then a server is added", async () => {
    await page.goto(`${base}/servers?tab=ssh-keys`);
    await page.locator("text=No SSH keys yet").first().waitFor();
    await page.getByRole("button", { name: "Add SSH Key" }).first().click();
    const keyDialog = page.locator("#nz-ssh-key-add");
    await keyDialog.locator("#nz-ssh-name").fill("deploy");
    await keyDialog.getByRole("button", { name: "Generate ED25519 key" }).click();
    expect(await toast("SSH key generated")).toContain("SSH key generated");
    expect(await keyDialog.locator("#nz-ssh-public").inputValue()).toMatch(/^ssh-ed25519 /);
    const publicKey = await keyDialog.locator("#nz-ssh-public").inputValue();
    await keyDialog.getByRole("button", { name: "Add SSH key" }).click();
    await page.locator("[data-ssh-key]", { hasText: "deploy" }).waitFor({ timeout: 20_000 });
    // Edit shows the saved key's public half, with Copy and Download (R3-03).
    await page.getByRole("button", { name: "Actions for deploy" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const editKey = page.locator("#nz-ssh-key-edit");
    await editKey.locator("#nz-ssh-edit-public").waitFor();
    expect(await editKey.locator("#nz-ssh-edit-public").inputValue()).toBe(publicKey);
    expect(await editKey.locator("text=Stored private keys cannot be displayed").count()).toBe(1);
    const download = page.waitForEvent("download");
    await editKey.getByRole("button", { name: "Download public key" }).click();
    expect((await download).suggestedFilename()).toBe("deploy.pub");
    await page.keyboard.press("Escape");

    await page.goto(`${base}/servers`);
    await page.getByRole("button", { name: "Add Server" }).first().click();
    const serverDialog = page.locator("#nz-server-add");
    await serverDialog.locator("#nz-server-add-name").fill("prod-1");
    await serverDialog.locator("#nz-server-add-key").selectOption({ label: "deploy" });
    await serverDialog.locator("#nz-server-add-address").fill("https://203.0.113.50/");
    await serverDialog.locator("#nz-server-add-user").fill("ubuntu");
    await serverDialog.getByRole("button", { name: "Create" }).click();
    // The API's own words, under the field (spec 9.2).
    await serverDialog
      .locator("text=Enter an IP address or hostname without a protocol, path, or port")
      .waitFor();
    await serverDialog.locator("#nz-server-add-address").fill("203.0.113.50");
    await serverDialog.getByRole("button", { name: "Create" }).click();
    expect(await toast("Added prod-1")).toContain("Added prod-1");
    await page.locator("[data-server-card]", { hasText: "prod-1" }).waitFor({ timeout: 20_000 });
    // Creating opens server setup (the server setup milestone's dialog, or the join command).
    await page.locator("dialog[open]").first().waitFor({ timeout: 20_000 });
    await page.keyboard.press("Escape");
    // Edit takes a public IPv4 for servers reached by a hostname or a private address (R3-10).
    await page.getByRole("button", { name: "Actions for prod-1" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const edit = page.locator("#nz-server-edit");
    await edit.locator("#nz-server-edit-public-ip").fill("10.0.0.9");
    await edit.getByRole("button", { name: "Update" }).click();
    await edit.locator("text=Use the server's public IPv4 address, or leave it blank").waitFor();
    await edit.locator("#nz-server-edit-public-ip").fill("93.184.215.60");
    await edit.getByRole("button", { name: "Update" }).click();
    await edit.waitFor({ state: "hidden", timeout: 20_000 });
    // The page reloads its cards after the dialog closes; on a busy machine that takes a moment.
    const card = async () =>
      JSON.parse(
        (await page
          .locator("[data-server-card]", { hasText: "prod-1" })
          .getAttribute("data-server")) ?? "{}",
      ) as { publicIPv4: string | null };
    for (let i = 0; i < 100 && (await card()).publicIPv4 !== "93.184.215.60"; i++)
      await page.waitForTimeout(200);
    expect((await card()).publicIPv4).toBe("93.184.215.60");
  }, 120_000);

  /** A member with only the given capabilities, signed in in a browser context of their own. */
  async function memberPage(email: string, capabilities: string[]) {
    const owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
    const added = await owner.call<{ member: { person: { id: string } } }>(
      "POST",
      "/workspace/members",
      { email, role: "member", password: "member-password-1" },
    );
    await owner.call("PUT", `/workspace/members/${added.member.person.id}/access`, {
      capabilities,
    });
    const member = await ApiSession.signIn(stack.consoleUrl, email, "member-password-1");
    await member.call("POST", "/onboarding/name", { name: "Mia" }).catch(() => {});
    const own = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await own.addInitScript(INSECURE_CONTEXT);
    await own.addCookies([
      { name: "nz_session", value: member.sessionToken(), url: stack.consoleUrl },
      { name: "nz_theme", value: "dusk", url: stack.consoleUrl },
    ]);
    const target = await own.newPage();
    watch(target);
    return { context: own, page: target };
  }

  test("R3-03: a member who may only use SSH keys opens a key read-only, copies and downloads its public half", async () => {
    const { context: own, page: theirs } = await memberPage("keys@example.com", ["ssh-keys.use"]);
    try {
      await theirs.goto(`${base}/servers?tab=ssh-keys`);
      await theirs.locator("[data-ssh-key]", { hasText: "deploy" }).waitFor();
      await theirs.getByRole("button", { name: "Actions for deploy" }).click();
      expect(
        (await theirs.getByRole("menuitem").allTextContents()).map((item) => item.trim()),
      ).toEqual(["View"]);
      await theirs.getByRole("menuitem", { name: "View" }).click();
      const view = theirs.locator("#nz-ssh-key-view");
      await view.locator("#nz-ssh-view-public").waitFor();
      expect(await view.locator("#nz-ssh-view-public").inputValue()).toMatch(/^ssh-ed25519 /);
      expect(await view.locator("#nz-ssh-view-name").inputValue()).toBe("deploy");
      // No Save and no Delete: Copy, Download public key and Close only.
      expect(await view.getByRole("button", { name: "Save" }).count()).toBe(0);
      expect(await view.getByRole("button", { name: /Delete/ }).count()).toBe(0);
      await view.getByRole("button", { name: "Copy" }).click();
      expect(
        await theirs
          .locator(".nz-toast", { hasText: /Copied|copy/i })
          .last()
          .textContent(),
      ).toBeTruthy();
      const download = theirs.waitForEvent("download");
      await view.getByRole("button", { name: "Download public key" }).click();
      expect((await download).suggestedFilename()).toBe("deploy.pub");
    } finally {
      await own.close();
    }
  }, 120_000);

  test('G3-06: a member with only "Add and remove servers" chooses a saved key in Add server', async () => {
    const { context: own, page: theirs } = await memberPage("servers@example.com", [
      "servers.manage",
    ]);
    try {
      await theirs.goto(`${base}/servers`);
      await theirs.getByRole("button", { name: "Add Server" }).first().click();
      const dialog = theirs.locator("#nz-server-add");
      await dialog.locator("#nz-server-add-name").fill("mia-1");
      expect(await dialog.locator("#nz-server-add-key option").allTextContents()).toContain(
        "deploy",
      );
      await dialog.locator("#nz-server-add-key").selectOption({ label: "deploy" });
      await dialog.locator("#nz-server-add-address").fill("203.0.113.77");
      await dialog.locator("#nz-server-add-user").fill("ubuntu");
      await dialog.getByRole("button", { name: "Create" }).click();
      await theirs.locator("[data-server-card]", { hasText: "mia-1" }).waitFor({ timeout: 20_000 });
      // The keys tab stays for people who may use keys.
      expect(await theirs.getByRole("link", { name: "SSH keys" }).count()).toBe(0);
    } finally {
      await own.close();
      // Only prod-1 is left for the delete test below.
      const owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
      const listed = await owner.call<{ servers: { id: string; name: string }[] }>(
        "GET",
        "/servers",
      );
      for (const server of listed.servers.filter((item) => item.name === "mia-1"))
        await owner.call("DELETE", `/servers/${server.id}`);
    }
  }, 120_000);

  test("the Deployments page lists the deploy, and its detail shows the build log", async () => {
    await page.goto(`${base}/deployments`, { waitUntil: "load" });
    const row = page.locator("[data-deployment-row]", { hasText: "web" }).first();
    await row.waitFor();
    expect(await row.locator("[data-status-cell] .nz-pill").textContent()).toBe("Active");
    expect(await page.locator("[data-deployments-total]").textContent()).toBe("1 total");
    await row.locator("a").first().click();
    await page.waitForURL(/\/deployments\/[^/]+$/, { waitUntil: "commit" });
    await page.locator(".nz-log-line", { hasText: "Deployment complete" }).waitFor();
    await page.getByRole("link", { name: "Open service" }).click();
    await page.waitForURL(serviceUrl, { waitUntil: "commit" });
  }, 90_000);

  test("a server without services is deleted from its card", async () => {
    await page.goto(`${base}/servers`);
    await page.getByRole("button", { name: "Actions for prod-1" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = page.locator("#nz-server-delete");
    await dialog.locator("text=This will delete the server and all associated data.").waitFor();
    await dialog.getByRole("button", { name: "Delete server" }).click();
    expect(await toast("Server deleted")).toContain("Server deleted");
    await page.locator("text=No servers yet").first().waitFor({ timeout: 20_000 });
  }, 60_000);

  test("no page logged a script error or put a secret in an address", () => {
    expect(problems).toEqual([]);
  });
});
