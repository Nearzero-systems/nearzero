import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type FakeGitea, startFakeGitea } from "../test-support/git-seed.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * Git providers end to end in a browser (spec 16.1, 16.5, 6.1, 6.3, 6.6): on the new-application
 * page the owner has no Gitea account, chooses "Connect account", lands on Settings → Git
 * providers with the Gitea dialog open, saves an OAuth application, goes through Gitea's
 * authorization (a fake Gitea that consents at once) and comes back to the new-application page
 * on the Repository step; filters, picks a repository, sees its branch and app folders, creates
 * the application, and finds the Gitea tab of its Source panel filled in with the webhook Nearzero
 * registered. Then "Gitea" pushes, signed with that webhook's secret, and a deploy is queued.
 *
 *   bun test e2e/git-providers.e2e.ts             (the dev console)
 *   E2E_CONSOLE=built bun test e2e/git-providers.e2e.ts   (builds and runs the production build)
 *   E2E_CONSOLE=built CONSOLE_ENTRY=./.m8/dist/server/entry.mjs …   (a build made elsewhere)
 *
 * Needs the development PostgreSQL; uses ports 4190 and 4490 and a database nz_m8_e2e_*.
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;

let stack: Stack;
let gitea: FakeGitea;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let api: ApiSession;
let projectId = "";
let environmentId = "";
const problems: string[] = [];

beforeAll(async () => {
  const built = process.env.E2E_CONSOLE === "built";
  if (built && !process.env.CONSOLE_ENTRY) await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  gitea = startFakeGitea();
  stack = await startStack({
    console: built ? "built" : "dev",
    label: "e2e",
    databasePrefix: "nz_m8",
    ...(process.env.CONSOLE_ENTRY ? { consoleEntry: process.env.CONSOLE_ENTRY } : {}),
    controlPort: 4190,
    consolePort: 4490,
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  api = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  await api.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await api.call("POST", "/onboarding/skip-invitations");
  const project = await api.call<{ project: { id: string }; environmentId: string }>(
    "POST",
    "/projects",
    { name: "Shop" },
  );
  projectId = project.project.id;
  environmentId = project.environmentId;
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INSECURE_CONTEXT);
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
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== stack.consoleUrl || url.pathname.startsWith("/git-providers/")) return;
    for (const name of ["code", "token", "secret", "password"]) {
      if (url.searchParams.has(name)) problems.push(`${name} in an address: ${url.pathname}`);
    }
  });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
  gitea?.stop();
});

async function toast(text: string | RegExp): Promise<void> {
  await page.locator(".nz-toast", { hasText: text }).last().waitFor({ timeout: 15_000 });
}

describe("connecting Gitea and importing a repository", () => {
  const newApp = () =>
    `${stack.consoleUrl}/acme/dashboard/projects/${projectId}/${environmentId}/new-application`;

  test("with no account, Connect account opens the Gitea dialog and remembers where to come back", async () => {
    await page.goto(newApp());
    const card = page.locator('[data-provider-card="gitea"]');
    await expect(card.textContent()).resolves.toContain(
      "No Gitea accounts connected. Connect one to import repositories.",
    );
    await card.getByRole("link", { name: "Connect account" }).click();
    await page.locator("#nz-git-connect-gitea[open]").waitFor();
    expect(page.url()).toContain("connect=gitea");
    const returnTo = await page
      .locator('#nz-git-connect-gitea input[name="returnTo"]')
      .inputValue();
    expect(returnTo).toBe(
      `/acme/dashboard/projects/${projectId}/${environmentId}/new-application?provider=gitea`,
    );
  });

  test("Save and connect goes through Gitea's authorization and comes back to the import", async () => {
    const dialog = page.locator("#nz-git-connect-gitea");
    await dialog.locator('input[name="name"]').fill("Team Gitea");
    await dialog.locator('input[name="url"]').fill(gitea.base);
    await dialog.locator('input[name="clientId"]').fill(gitea.hosts.gitea.clientId);
    await dialog.locator('input[name="clientSecret"]').fill(gitea.hosts.gitea.clientSecret);
    await Promise.all([
      page.waitForURL(/new-application\?provider=gitea/, { timeout: 30_000 }),
      dialog.getByRole("button", { name: "Save and connect" }).click(),
    ]);
    await toast("Gitea connected");
    await page.locator('[data-step="repository"]:not([hidden])').waitFor();
    await page.locator("[data-git-repo]").first().waitFor();
    const names = await page.locator(".nz-git-repo-name").allTextContents();
    expect(names.sort()).toEqual(["team/docs", "team/web"]);
  });

  test("filter, pick, configure and create the application", async () => {
    await page.fill("[data-git-filter]", "web");
    await page.waitForFunction(() => document.querySelectorAll("[data-git-repo]").length === 1);
    await page.locator("[data-git-repo]").first().click();
    await page.locator('[data-step="configure"]:not([hidden])').waitFor();
    expect(await page.inputValue('input[name="repository"]')).toBe("team/web");
    expect(await page.inputValue("[data-git-branch]")).toBe("main");
    await page.waitForFunction(() =>
      Array.from(
        (document.querySelector("[data-git-build-path]") as HTMLSelectElement).options,
      ).some((option) => option.value === "apps/api"),
    );
    expect(await page.inputValue('input[name="name"]')).toBe("web");
    await Promise.all([
      page.waitForURL(/\/services\/[0-9a-f-]{36}$/, { timeout: 30_000 }),
      page.getByRole("button", { name: "Create application" }).click(),
    ]);
    // The Source section starts closed, as in the reference (spec 21.10); open it.
    const source = page.locator('details[id^="nz-source-fold-"]');
    expect(await source.evaluate((fold) => (fold as HTMLDetailsElement).open)).toBe(false);
    await source.locator("> summary").click();
    const tab = page.locator('[role="tab"][aria-selected="true"]', { hasText: "Gitea" });
    await tab.waitFor();
    const panel = page.locator('[data-git-source-tab="gitea"]');
    expect(await panel.locator("[data-git-source-repo]").inputValue()).toBe("team/web");
    await expect(panel.locator("[data-git-push]").textContent()).resolves.toContain(
      "Nearzero added a webhook to team/web on Gitea",
    );
    expect(gitea.hosts.hooks).toHaveLength(1);
  });

  test("a push Gitea signs with the webhook's secret queues a deploy; a wrong signature doesn't", async () => {
    const hook = gitea.hosts.hooks[0];
    if (!hook) throw new Error("No webhook was registered.");
    const body = JSON.stringify({
      ref: "refs/heads/main",
      before: "1".repeat(40),
      after: "2".repeat(40),
      repository: { id: 21, full_name: "team/web" },
      commits: [{ added: [], modified: ["src/index.ts"], removed: [] }],
      head_commit: { message: "Push from Gitea" },
    });
    const send = (secret: string) =>
      fetch(hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-gitea-event": "push",
          "x-gitea-signature": createHmac("sha256", secret).update(body).digest("hex"),
        },
        body,
      });
    expect((await send("not-the-secret")).status).toBe(401);
    const accepted = await send(hook.secret);
    expect(accepted.status).toBe(202);
    const answer = (await accepted.json()) as { deployed: boolean; deploymentId: string };
    expect(answer.deployed).toBe(true);
    const deployment = await api.call<{ deployment: { title: string; trigger: string } }>(
      "GET",
      `/deployments/${answer.deploymentId}`,
    );
    expect(deployment.deployment).toMatchObject({ title: "Push from Gitea", trigger: "push" });
  });

  test("no script errors, and no code or token in any address", () => {
    expect(problems).toEqual([]);
  });
});
