/**
 * The Git provider pages' browser sweep (spec 16, 06 6.1, 6.3, 07 7.1, 21.2, 21.8, 21.9). Starts
 * its own throwaway Nearzero (control plane on 4190, console on 4490, database nz_m8_*), a fake
 * Gitea on a free port, seeds providers and a project with provider sources, and loads Settings →
 * Git providers (as the owner and as a member who only uses shared accounts), the
 * new-application page's Provider and Repository steps, an application's and a Compose
 * service's Source panel, and the connect dialogs, in Light, Dark and Dusk at 375, 768, 1024
 * and 1440px, with the insecure-context APIs removed (as on plain HTTP). It fails on a script or
 * console error, horizontal page scroll, a wrong status, or a code or token in an address.
 * Screenshots (Dusk and Light, 375 and 1440) go to test-artifacts/m8/.
 *
 * Usage: bun ./sweep/git-providers.ts (from apps/console). E2E_CONSOLE=built uses the build.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import {
  addPlainMember,
  type FakeGitea,
  seedGit,
  startFakeGitea,
} from "../test-support/git-seed.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";
import { controlProblems, hoverProblems } from "./controls.ts";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS = resolve(ROOT, "test-artifacts", "m8");
const THEMES = ["light", "dark", "dusk"] as const;
const VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;
const OWNER = { email: "owner@example.com", password: "sweep-password-1" };

interface Route {
  path: string;
  as: "owner" | "member";
  status?: number;
  shot?: string;
  /** Runs after load, before checks and the screenshot (open a dialog, pick a step). */
  act?: (page: Page) => Promise<void>;
}

const failures: string[] = [];
let loads = 0;

function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

async function checkPage(page: Page, where: string, attempt = 0): Promise<void> {
  // The dev server may reload a page once while it optimizes dependencies; check it again then.
  const problems = await page
    .evaluate(() => {
      const out: string[] = [];
      const scroller = document.scrollingElement ?? document.documentElement;
      if (scroller.scrollWidth > scroller.clientWidth + 1) {
        out.push(`horizontal page scroll (${scroller.scrollWidth}px in ${scroller.clientWidth}px)`);
      }
      for (const dialog of document.querySelectorAll("dialog[open]")) {
        const box = dialog.getBoundingClientRect();
        if (box.right > window.innerWidth + 1 || box.left < -1)
          out.push("an open dialog is off screen");
        if (dialog.scrollWidth > dialog.clientWidth + 1)
          out.push("an open dialog scrolls sideways");
      }
      return out;
    })
    .catch(async (error: Error) => {
      if (attempt > 1 || !/context was destroyed/.test(error.message)) throw error;
      await page.waitForLoadState("load");
      await page.waitForTimeout(300);
      return null;
    });
  if (problems === null) return checkPage(page, where, attempt + 1);
  for (const problem of problems) fail(where, problem);
}

async function sweep(
  browser: Browser,
  stack: Stack,
  routes: Route[],
  sessions: Record<string, string>,
) {
  for (const theme of THEMES) {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript(INSECURE_CONTEXT);
      const page = await context.newPage();
      let current = "";
      page.on("pageerror", (error) => fail(current, `script error: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && !/status of (4\d\d)/.test(message.text())) {
          fail(current, `console error: ${message.text()}`);
        }
      });
      page.on("response", (response) => {
        if (response.status() >= 500) {
          fail(current, `${response.status()} from ${new URL(response.url()).pathname}`);
        }
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== stack.consoleUrl) return;
        for (const name of ["code", "token", "password", "secret"]) {
          if (url.searchParams.has(name)) fail(current, `${name} in an address: ${url.pathname}`);
        }
      });
      for (const route of routes) {
        current = `${route.path} as ${route.as} (${theme}, ${viewport.width}px)`;
        await context.clearCookies();
        await context.addCookies([
          { name: "nz_session", value: sessions[route.as] as string, url: stack.consoleUrl },
          { name: "nz_theme", value: theme, url: stack.consoleUrl },
        ]);
        const response = await page.goto(`${stack.consoleUrl}${route.path}`, {
          waitUntil: "load",
          // The dev server compiles pages on first load; a busy machine can take a while.
          timeout: 120_000,
        });
        loads++;
        const status = response?.status() ?? 0;
        if (status !== (route.status ?? 200))
          fail(current, `status ${status}, not ${route.status ?? 200}`);
        await page.waitForTimeout(150);
        if (route.act) {
          try {
            await route.act(page);
          } catch (error) {
            fail(current, `couldn't act on the page: ${(error as Error).message.split("\n")[0]}`);
          }
        }
        // Dialogs fade in; let them finish before checking and taking pictures.
        if (route.act) await page.waitForTimeout(450);
        await checkPage(page, current);
        if (
          route.shot &&
          (theme === "dusk" || theme === "light") &&
          (viewport.width === 375 || viewport.width === 1440)
        ) {
          await page.screenshot({
            path: resolve(SHOTS, `${route.shot}-${theme}-${viewport.width}.png`),
            fullPage: !route.act,
          });
        }
        // Spec 21.9a: 4px by 8px fields and buttons with 6px corners, none taller than its
        // content, and no shadows at rest, focused or hovered.
        const controls = await page.evaluate(controlProblems, { dialogs: true });
        for (const problem of [...controls.problems, ...controls.shadows]) fail(current, problem);
        for (const rule of controls.shadowRules)
          fail("stylesheets", `a rule draws a shadow: ${rule}`);
        if (viewport.width === 1440) {
          for (const problem of await hoverProblems(page)) fail(current, problem);
        }
      }
      await context.close();
    }
  }
}

async function main(): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  let stack: Stack | null = null;
  let gitea: FakeGitea | null = null;
  let browser: Browser | null = null;
  try {
    gitea = startFakeGitea();
    stack = await startStack({
      console: process.env.E2E_CONSOLE === "built" ? "built" : "dev",
      label: "sweep",
      databasePrefix: "nz_m8",
      ...(process.env.CONSOLE_ENTRY ? { consoleEntry: process.env.CONSOLE_ENTRY } : {}),
      controlPort: 4190,
      consolePort: 4490,
    });
    await stack.createOwner(OWNER.email, OWNER.password);
    const owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
    await owner.call("POST", "/onboarding/workspace", {
      name: "Maya Lopez",
      workspaceName: "Acme",
    });
    await owner.call("POST", "/onboarding/skip-invitations");
    const seeded = await seedGit(stack, owner, gitea);
    const member = await addPlainMember(stack, owner, "sam@example.com", "member-password-1");
    const W = `/${seeded.workspace}/dashboard`;
    const env = `${W}/projects/${seeded.project}/${seeded.environment}`;
    const sessions = { owner: owner.sessionToken(), member: member.sessionToken() };
    const routes: Route[] = [
      { path: `${W}/settings/git-providers`, as: "owner", shot: "settings-git-providers" },
      { path: `${W}/settings/git-providers`, as: "member", shot: "settings-git-providers-member" },
      {
        path: `${W}/settings/git-providers?connect=gitlab`,
        as: "owner",
        shot: "connect-gitlab",
        act: async (page) => {
          await page.locator("#nz-git-connect-gitlab[open]").waitFor({ timeout: 5000 });
        },
      },
      {
        path: `${W}/settings/git-providers`,
        as: "owner",
        shot: "connect-github",
        act: async (page) => {
          await page.getByRole("button", { name: "GitHub" }).first().click();
          await page.locator("#nz-git-connect-github[open]").waitFor({ timeout: 5000 });
        },
      },
      {
        path: `${W}/settings/git-providers`,
        as: "owner",
        shot: "connect-bitbucket",
        act: async (page) => {
          await page.getByRole("button", { name: "Bitbucket" }).first().click();
          await page.locator("#nz-git-connect-bitbucket[open]").waitFor({ timeout: 5000 });
        },
      },
      {
        path: `${W}/settings/git-providers`,
        as: "owner",
        shot: "delete-provider",
        act: async (page) => {
          await page.locator(`[popovertarget="nz-git-menu-${seeded.giteaProvider}"]`).click();
          await page.locator(`[data-git-delete="${seeded.giteaProvider}"]`).click();
          await page
            .locator("[data-git-delete-understood]:not([hidden])")
            .waitFor({ timeout: 5000 });
        },
      },
      { path: `${env}/new-application`, as: "owner", shot: "new-application-provider" },
      {
        path: `${env}/new-application?provider=gitea`,
        as: "owner",
        shot: "new-application-repository",
        act: async (page) => {
          await page.locator("[data-git-repo]").first().waitFor({ timeout: 8000 });
        },
      },
      {
        path: `${env}/new-application?provider=gitea`,
        as: "owner",
        shot: "new-application-configure",
        act: async (page) => {
          await page.locator("[data-git-repo]").first().click();
          await page.locator('[data-step="configure"]:not([hidden])').waitFor({ timeout: 5000 });
          await page.waitForFunction(
            () =>
              (document.querySelector("[data-git-build-path]") as HTMLSelectElement | null)?.options
                .length !== 2,
            null,
            { timeout: 8000 },
          );
        },
      },
      { path: `${env}/services/${seeded.app}`, as: "owner", shot: "service-source-gitea" },
      {
        path: `${env}/services/${seeded.compose}`,
        as: "owner",
        shot: "compose-source-gitea",
      },
      {
        path: `${env}/overview`,
        as: "owner",
        shot: "compose-from-repository",
        act: async (page) => {
          await page.evaluate(() =>
            (document.getElementById("nz-compose-create") as HTMLDialogElement).showModal(),
          );
          await page
            .locator('#nz-compose-create input[name="source"][value="repository"]')
            .check({ force: true });
        },
      },
    ];
    browser = await chromium.launch();
    await sweep(browser, stack, routes, sessions);
  } finally {
    await browser?.close();
    await stack?.stop();
    gitea?.stop();
  }
  console.info(`Loaded ${loads} pages.`);
  if (failures.length > 0) {
    console.error(`${failures.length} problems:\n${[...new Set(failures)].join("\n")}`);
    process.exit(1);
  }
  console.info("No problems found.");
}

await main();
