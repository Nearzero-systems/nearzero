/**
 * The Compose page's browser sweep (spec 07 7.2, 21.2, 21.8, 21.9). Starts its own throwaway
 * Nearzero (control plane on 4220, console on 4520, database nz_m7_*) with a pretend host runner
 * that answers Docker Compose's commands (apps/control/test/support/fake-compose.ts), deploys a
 * three-service stack, and loads its Compose page (with Preview Compose open, and with a
 * container's row menu open), an idle Stack with privileged options (Preview's warnings), and the
 * same stack as a member (Preview's refusal on the Nearzero host), in Light, Dark and Dusk at
 * 375, 768, 1024 and 1440px, with the insecure-context APIs removed (as on plain HTTP). It fails
 * on a script or console error, horizontal page scroll, a dialog off screen, a wrong status, or a
 * secret in an address. Screenshots (Dusk and Light, 375 and 1440) go to test-artifacts/m7/.
 *
 * Usage: bun ./sweep/compose.ts (from apps/console). E2E_CONSOLE=built uses the build.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { installFakeCompose } from "../../control/test/support/fake-compose.ts";
import { connectFakeHost, type FakeHost, handoffFolder } from "../test-support/fake-runner-link.ts";
import { addPlainMember } from "../test-support/git-seed.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";
import { controlProblems, hoverProblems } from "./controls.ts";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS = resolve(ROOT, "test-artifacts", "m7");
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

export const SHOP_STACK = `services:
  web:
    image: nginx:1.29-alpine
    ports: ["8080:80"]
    depends_on: [api]
  api:
    image: node:24-alpine
    expose: ["3000"]
    depends_on: [db]
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes: ["pg:/var/lib/postgresql/data"]
volumes:
  pg: {}
`;

const EDGE_STACK = `services:
  agent:
    image: portainer/agent:2.27.0
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/lib/docker/volumes:/var/lib/docker/volumes
    cap_add: [SYS_ADMIN]
`;

interface Route {
  path: string;
  as: "owner" | "member";
  status?: number;
  shot?: string;
  act?: (page: Page) => Promise<void>;
}

const failures: string[] = [];
let loads = 0;

function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

async function checkPage(page: Page, where: string, attempt = 0): Promise<void> {
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
      for (const menu of document.querySelectorAll("[popover]:popover-open")) {
        const box = menu.getBoundingClientRect();
        if (box.right > window.innerWidth + 1 || box.left < -1)
          out.push("an open menu is off screen");
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
        if (response.status() >= 500)
          fail(current, `${response.status()} from ${new URL(response.url()).pathname}`);
      });
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin !== stack.consoleUrl) return;
        for (const name of ["token", "password", "secret"]) {
          if (url.searchParams.has(name)) fail(current, `${name} in an address: ${url.pathname}`);
        }
        if (url.search.includes("sweep-pg-secret"))
          fail(current, "a variable's value in an address");
      });
      for (const route of routes) {
        current = `${route.path} as ${route.as} (${theme}, ${viewport.width}px)`;
        await context.clearCookies();
        await context.addCookies([
          { name: "nz_session", value: sessions[route.as] as string, url: stack.consoleUrl },
          { name: "nz_theme", value: theme, url: stack.consoleUrl },
        ]);
        // The dev server may restart a navigation once while it optimizes dependencies.
        const go = () =>
          page.goto(`${stack.consoleUrl}${route.path}`, { waitUntil: "load", timeout: 120_000 });
        const response =
          (await go().catch(async (error: Error) => {
            if (!/ERR_ABORTED|interrupted/.test(error.message)) throw error;
            await page.waitForTimeout(500);
            return go();
          })) ?? (await page.reload({ waitUntil: "load", timeout: 120_000 }));
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
          await page.waitForTimeout(450);
        }
        const text = (await page.locator("body").textContent()) ?? "";
        if (text.includes("sweep-pg-secret")) fail(current, "a variable's value is on the page");
        await checkPage(page, current);
        if (
          route.shot &&
          (theme === "dusk" || theme === "light") &&
          (viewport.width === 375 || viewport.width === 1440)
        ) {
          await page.screenshot({
            path: resolve(SHOTS, `${route.shot}-${theme}-${viewport.width}.png`),
            fullPage: !route.act || route.shot === "compose-page",
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

async function waitDeployed(owner: ApiSession, deploymentId: string): Promise<string> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const answer = await owner.call<{ deployment: { status: string; error: string | null } }>(
      "GET",
      `/deployments/${deploymentId}`,
    );
    if (!["queued", "building"].includes(answer.deployment.status)) {
      if (answer.deployment.status !== "active") {
        throw new Error(
          `The seed deploy ended ${answer.deployment.status}: ${answer.deployment.error}`,
        );
      }
      return answer.deployment.status;
    }
    await Bun.sleep(500);
  }
  throw new Error("The seed deploy didn't finish within 2 minutes.");
}

export interface ComposeSeed {
  workspace: string;
  env: string;
  shop: string;
  edge: string;
}

/** A project with a deployed three-service stack and an idle privileged Stack on the host. */
export async function seedCompose(owner: ApiSession, host: FakeHost): Promise<ComposeSeed> {
  installFakeCompose(host.runner);
  const workspace = await owner.call<{ workspace: { slug: string } }>("GET", "/workspace");
  const project = await owner.call<{ project: { id: string }; environmentId: string }>(
    "POST",
    "/projects",
    {
      name: "Shop",
    },
  );
  const create = async (name: string, format: "compose" | "stack", composeFile: string) => {
    const created = await owner.call<{ service: { id: string } }>(
      "POST",
      `/environments/${project.environmentId}/services`,
      { kind: "compose", name, serverId: "host", settings: { format, composeFile } },
    );
    await owner.call("PATCH", `/services/${created.service.id}/deploy-settings`, {
      stabilitySeconds: 0,
    });
    return created.service.id;
  };
  const shop = await create("shop", "compose", SHOP_STACK);
  const edge = await create("edge-agent", "stack", EDGE_STACK);
  await owner.call("PUT", `/services/${shop}/variables`, {
    text: "POSTGRES_PASSWORD=sweep-pg-secret\n",
  });
  const started = await owner.call<{ deployment: { id: string } }>(
    "POST",
    `/services/${shop}/deployments`,
    {},
  );
  await waitDeployed(owner, started.deployment.id);
  return {
    workspace: workspace.workspace.slug,
    env: `/${workspace.workspace.slug}/dashboard/projects/${project.project.id}/${project.environmentId}`,
    shop,
    edge,
  };
}

export function composeRoutes(seed: ComposeSeed): Route[] {
  const page = (id: string) => `${seed.env}/services/${id}`;
  const preview = async (target: Page) => {
    await target.locator("[data-compose-preview]").first().click();
    await target
      .locator("#nz-compose-preview[open] [data-compose-preview-files]:not([hidden])")
      .waitFor({ timeout: 30_000 });
  };
  return [
    {
      path: page(seed.shop),
      as: "owner",
      shot: "compose-page",
      act: async (target) => {
        await target.locator("[data-compose-rows] tr").first().waitFor({ timeout: 10_000 });
      },
    },
    { path: page(seed.shop), as: "owner", shot: "compose-preview", act: preview },
    {
      // A fresh load (not a hash change), so no dialog from the route before stays open.
      path: `${page(seed.shop)}?section=containers`,
      as: "owner",
      shot: "compose-container-menu",
      act: async (target) => {
        await target.locator("[data-compose-row-menu]").first().waitFor({ timeout: 10_000 });
        await target.locator("[data-compose-row-menu]").first().scrollIntoViewIfNeeded();
        await target.locator("[data-compose-row-menu]").first().click();
        await target.locator("#nz-compose-container-menu:popover-open").waitFor({ timeout: 5_000 });
      },
    },
    { path: page(seed.edge), as: "owner", shot: "compose-idle-stack" },
    { path: page(seed.edge), as: "owner", shot: "compose-preview-warnings", act: preview },
    { path: page(seed.edge), as: "member", shot: "compose-preview-refused", act: preview },
  ];
}

async function main(): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  let stack: Stack | null = null;
  let host: FakeHost | null = null;
  let browser: Browser | null = null;
  try {
    const handoff = await handoffFolder("m7");
    stack = await startStack({
      console: process.env.E2E_CONSOLE === "built" ? "built" : "dev",
      label: "m7sweep",
      databasePrefix: "nz_m7",
      ...(process.env.CONSOLE_ENTRY ? { consoleEntry: process.env.CONSOLE_ENTRY } : {}),
      controlPort: 4220,
      consolePort: 4520,
      env: {
        NEARZERO_RUNNER_HANDOFF_DIR: handoff,
        NEARZERO_PLATFORM_DOMAIN: "apps.acme.test",
        NEARZERO_PUBLIC_IP: "203.0.113.10",
        NEARZERO_DNS_RESOLVERS: "127.0.0.1:9",
      },
    });
    await stack.createOwner(OWNER.email, OWNER.password);
    const owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
    await owner.call("POST", "/onboarding/workspace", {
      name: "Maya Lopez",
      workspaceName: "Acme",
    });
    await owner.call("POST", "/onboarding/skip-invitations");
    host = await connectFakeHost(stack.controlUrl, handoff);
    const seed = await seedCompose(owner, host);
    const member = await addPlainMember(stack, owner, "sam@example.com", "member-password-1");
    const members = await owner.call<{ members: { person: { id: string; email: string } }[] }>(
      "GET",
      "/workspace/members",
    );
    const sam = members.members.find((item) => item.person.email === "sam@example.com");
    await owner.call("PUT", `/workspace/members/${sam?.person.id}/access`, {
      policyIds: [],
      capabilities: [],
      scope: {
        allProjects: false,
        projectIds: [],
        environmentIds: [],
        serviceIds: [seed.edge],
        allServers: false,
        serverIds: [],
        allGitAccounts: false,
        gitAccountIds: [],
      },
    });
    const sessions = { owner: owner.sessionToken(), member: member.sessionToken() };
    browser = await chromium.launch();
    await sweep(browser, stack, composeRoutes(seed), sessions);
  } finally {
    await browser?.close();
    await host?.close();
    await stack?.stop();
  }
  console.info(`Loaded ${loads} pages.`);
  if (failures.length > 0) {
    console.error(`${failures.length} problems:\n${[...new Set(failures)].join("\n")}`);
    process.exit(1);
  }
  console.info("No problems found.");
}

if (import.meta.main) await main();
