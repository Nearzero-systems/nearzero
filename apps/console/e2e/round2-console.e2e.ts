import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { $, SQL } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type AgentStack, MEMBER, OWNER, startAgentStack } from "../test-support/agent-stack.ts";
import { ApiSession } from "../test-support/stack.ts";

/**
 * Round 2's console fixes, end to end on the production build (spec 30a, B3):
 * - forms: a second Enter never sends a page form twice (B3-01); the two-factor dialogs work
 *   again after a refusal (B3-02);
 * - sign-in: the two-factor step keeps the email and the hint, says so in a toast, and takes
 *   "123 456" (R1-07);
 *   0.1.x's callbackUrl, ?email= and /accept-invitation/<token> (R1-08); 0.1.x's stored theme
 *   (R1-10);
 * - the shell: the dashboard 404 highlights nothing (B3-12), Support mails support (B3-15), the
 *   phone crumbs aren't cut (B3-16), the bell reloads and keeps its cards in time order (R1-06,
 *   B3-20), a fresh invitation expires "in 7 days" (B3-18);
 * - Agent policies ask before unsaved changes are lost (B3-17); Profile says "My Account" with
 *   square avatar choices (B3-27);
 * - the Agent: a just-sent session reads "just now" (B3-06), titles keep their room (B3-07),
 *   "Ask Agent" is opaque (B3-08), a saved name reaches the user button (B3-10), the first
 *   greeting follows the browser's clock (B3-11), Escape cancels a delete (B3-24), and the
 *   phone greeting is left-aligned (B3-28).
 *
 *   bun test e2e/round2-console.e2e.ts       (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...         (uses the dev server instead)
 *
 * Needs the development PostgreSQL; uses ports 4250 and 4550 (or NEARZERO_TEST_CONTROL_PORT and
 * NEARZERO_TEST_CONSOLE_PORT) and a database nz_m11b_… (or NEARZERO_TEST_DATABASE_PREFIX).
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const ADMIN_URL =
  process.env.NEARZERO_TEST_DATABASE_URL ??
  "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;

let agent: AgentStack;
let browser: Browser;
let base = "";
let ws = "";
let db: SQL;
const problems: string[] = [];

/** RFC 6238 with SHA-1, 30-second steps, 6 digits: what an authenticator app shows. */
function totp(secret: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((byte) => Number.parseInt(byte, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const value = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(value).padStart(6, "0");
}

function watch(page: Page): void {
  page.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    if (/status of [45]\d\d/.test(message.text())) return;
    problems.push(`console error: ${message.text()}`);
  });
}

interface ContextOptions {
  width?: number;
  theme?: string | null;
  session?: string | null;
  timezoneId?: string;
  zoneCookie?: boolean;
}

async function newContext(options: ContextOptions = {}): Promise<BrowserContext> {
  const width = options.width ?? 1440;
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 812 : 900 },
    ...(options.timezoneId ? { timezoneId: options.timezoneId } : {}),
  });
  await context.addInitScript(INSECURE_CONTEXT);
  const cookies: { name: string; value: string; url: string }[] = [];
  const session = options.session === undefined ? agent.owner.sessionToken() : options.session;
  if (session) cookies.push({ name: "nz_session", value: session, url: base });
  const theme = options.theme === undefined ? "light" : options.theme;
  if (theme) cookies.push({ name: "nz_theme", value: theme, url: base });
  if (options.zoneCookie !== false && !options.timezoneId) {
    cookies.push({ name: "nz_tz", value: "UTC", url: base });
  }
  if (cookies.length > 0) await context.addCookies(cookies);
  context.on("page", (page) => watch(page));
  return context;
}

async function openPage(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${base}${path}`, { waitUntil: "load" });
  return page;
}

async function sendMessage(page: Page, text: string): Promise<void> {
  const box = page.locator("#nz-composer-input");
  await box.fill(text);
  await box.press("Enter");
}

async function lastTurnDone(page: Page): Promise<void> {
  await page.locator(".nz-turn").last().locator(".nz-turn-foot").waitFor({ timeout: 60_000 });
}

beforeAll(async () => {
  const dev = process.env.E2E_CONSOLE === "dev";
  if (!dev) await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  agent = await startAgentStack({ console: dev ? "dev" : "built", label: "r2" });
  base = agent.stack.consoleUrl;
  ws = agent.workspace;
  const url = new URL(ADMIN_URL);
  url.pathname = `/${agent.stack.databaseName}`;
  db = new SQL(url.toString());
  browser = await chromium.launch();
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await db?.close();
  await agent?.stop();
}, 120_000);

describe("forms", () => {
  test("B3-01: a second Enter in Add a project creates one project, not two", async () => {
    const context = await newContext();
    const page = await openPage(context, `/${ws}/dashboard/projects`);
    await page.locator('[data-dialog-open="nz-create-project"]').first().click();
    const name = page.locator("#nz-project-name");
    await name.fill("Enter twice");
    const posts: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes("/dashboard/projects")) {
        posts.push(request.url());
      }
    });
    const answered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/dashboard/projects"),
      { timeout: 60_000 },
    );
    await name.press("Enter");
    await page.waitForTimeout(150);
    await name.press("Enter").catch(() => {});
    await answered;
    await page.waitForLoadState("load");
    await page.waitForTimeout(1_000);
    const { projects } = await agent.owner.call<{ projects: { name: string }[] }>(
      "GET",
      "/projects",
    );
    expect(projects.filter((project) => project.name === "Enter twice")).toHaveLength(1);
    expect(posts).toHaveLength(1);
    await context.close();
  }, 120_000);

  test("B3-02: the 2FA dialogs' buttons work again after a wrong password or code", async () => {
    const context = await newContext({ session: agent.member.sessionToken() });
    const page = await openPage(context, `/${ws}/dashboard/profile`);
    await page.locator('[data-dialog-open="nz-2fa-enable"]').click();
    const dialog = page.locator("#nz-2fa-enable");
    const passwordStep = dialog.locator('[data-2fa-step="password"]');
    await page.fill("#nz-2fa-setup-password", "wrong-password-9");
    await passwordStep.getByRole("button", { name: "Continue" }).click();
    await expect(
      passwordStep.locator("[data-field-error]:not([hidden])").first().textContent(),
    ).resolves.toContain("Current password is incorrect");
    const proceed = passwordStep.getByRole("button", { name: "Continue" });
    expect(await proceed.getAttribute("aria-disabled")).toBeNull();
    await page.fill("#nz-2fa-setup-password", MEMBER.password);
    await proceed.click();
    const secretCell = dialog.locator("[data-2fa-secret]");
    await dialog.locator('[data-2fa-step="setup"]').waitFor({ state: "visible", timeout: 15_000 });
    await expect(secretCell.textContent()).resolves.toMatch(/^[A-Z2-7]{16,}/);
    const secret = ((await secretCell.textContent()) ?? "").trim();

    // The code step: a wrong code, then the right one, with the same button.
    const enable = dialog.getByRole("button", { name: "Enable 2FA" });
    await page.fill("#nz-2fa-enable-code", "000000");
    await enable.click();
    await dialog
      .locator(
        '[data-2fa-step-form="enable"] [data-field-error]:not([hidden]), [data-2fa-step-form="enable"] [data-form-error]:not([hidden])',
      )
      .first()
      .waitFor({ timeout: 15_000 });
    expect(await enable.getAttribute("aria-disabled")).toBeNull();
    await page.fill("#nz-2fa-enable-code", totp(secret));
    await enable.click();
    await page.waitForFunction(
      () => !document.querySelector("#nz-2fa-enable")?.hasAttribute("open"),
      null,
      {
        timeout: 20_000,
      },
    );
    const status = await agent.member.call<{ enabled: boolean }>("GET", "/me/two-factor");
    expect(status.enabled).toBe(true);

    // Manage: the password step after a wrong password.
    await page.waitForLoadState("load");
    await page.locator('[data-dialog-open="nz-2fa-manage"]').waitFor({ timeout: 20_000 });
    await page.locator('[data-dialog-open="nz-2fa-manage"]').click();
    const manage = page.locator("#nz-2fa-manage");
    await page.fill("#nz-2fa-manage-password", "wrong-password-9");
    const manageContinue = manage.getByRole("button", { name: "Continue" });
    await manageContinue.click();
    await manage.locator("[data-field-error]:not([hidden])").first().waitFor({ timeout: 15_000 });
    expect(await manageContinue.getAttribute("aria-disabled")).toBeNull();
    await page.fill("#nz-2fa-manage-password", MEMBER.password);
    await manageContinue.click();
    await manage.locator('[data-2fa-step="choose"]').waitFor({ state: "visible", timeout: 15_000 });
    await context.close();
    (globalThis as { memberSecret?: string }).memberSecret = secret;
  }, 180_000);
});

describe("sign-in", () => {
  test("R1-07: the code step keeps the email and the hint, and takes a spaced code", async () => {
    const secret = (globalThis as { memberSecret?: string }).memberSecret;
    expect(secret).toBeTruthy();
    const context = await newContext({ session: null });
    const page = await openPage(context, "/sign-in");
    await page.fill("#nz-sign-in-email", MEMBER.email);
    await page.fill("#nz-sign-in-password", MEMBER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator("#nz-sign-in-code").waitFor({ timeout: 20_000 });
    const email = page.locator("#nz-sign-in-email");
    expect(await email.inputValue()).toBe(MEMBER.email);
    expect(await email.getAttribute("readonly")).not.toBeNull();
    expect(await page.locator("#nz-sign-in-code-hint").textContent()).toBe(
      "Enter the code from your authenticator app, or one of your backup codes.",
    );
    // The switch to the code step also says so in a toast (spec 30, decisions part 2).
    await page
      .locator(".nz-toast", { hasText: "Enter the code from your authenticator app." })
      .waitFor({ state: "visible", timeout: 10_000 });
    // A wrong code keeps the email on screen.
    await page.fill("#nz-sign-in-code", "000 000");
    await page.getByRole("button", { name: "Verify" }).click();
    await page.locator(".nz-inline-error").waitFor({ timeout: 20_000 });
    expect(await page.locator("#nz-sign-in-email").inputValue()).toBe(MEMBER.email);
    // The next step's code (the server allows one step of drift), so it is one the account
    // hasn't used yet, typed with spaces.
    const code = totp(secret ?? "", Date.now() + 30_000);
    await page.fill("#nz-sign-in-code", ` ${code.slice(0, 3)} ${code.slice(3)} `);
    await page.getByRole("button", { name: "Verify" }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 30_000 });
    expect(new URL(page.url()).pathname).toContain("/dashboard");
    await context.close();
  }, 120_000);

  test("R1-08: callbackUrl opens its page after sign-in, and ?email= fills the form", async () => {
    const context = await newContext({ session: null });
    const page = await openPage(context, "/login?callbackUrl=/dashboard/projects");
    expect(new URL(page.url()).pathname).toBe("/sign-in");
    await page.fill("#nz-sign-in-email", OWNER.email);
    await page.fill("#nz-sign-in-password", OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(`**/${ws}/dashboard/projects`, { timeout: 30_000 });

    const fresh = await newContext({ session: null });
    const prefilled = await openPage(fresh, "/login?email=sam%40example.com");
    expect(await prefilled.locator("#nz-sign-in-email").inputValue()).toBe("sam@example.com");
    const direct = await openPage(fresh, "/sign-in?email=a%40b.co");
    expect(await direct.locator("#nz-sign-in-email").inputValue()).toBe("a@b.co");
    await fresh.close();
    await context.close();
  }, 120_000);

  test("R1-08: /accept-invitation/<token> opens the invitation page with that token", async () => {
    const response = await fetch(`${base}/accept-invitation/abcdefghijklmnop1234`, {
      redirect: "manual",
    });
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe("/invitation?token=abcdefghijklmnop1234");
  });

  test("R1-10: a browser with 0.1.x's stored Dark and no 1.0 cookie opens in Dark", async () => {
    const context = await newContext({ session: null, theme: null });
    const page = await context.newPage();
    await page.goto(`${base}/robots.txt`);
    await page.evaluate(() => localStorage.setItem("nearzero-theme", "dark"));
    await page.goto(`${base}/sign-in`, { waitUntil: "load" });
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
    const cookies = await context.cookies(base);
    expect(cookies.find((cookie) => cookie.name === "nz_theme")?.value).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("nearzero-theme"))).toBeNull();
    // From now on the server renders Dark itself.
    const html = await (await page.request.get(`${base}/sign-in`)).text();
    expect(html).toContain('data-theme="dark"');
    await context.close();
  }, 60_000);
});

describe("the shell", () => {
  test("B3-12: the dashboard 404 marks no sidebar item and links back to projects", async () => {
    const context = await newContext();
    const page = await openPage(context, `/${ws}/dashboard/no-such-page`);
    expect(await page.locator("h1", { hasText: "Page not found" }).count()).toBe(1);
    expect(await page.locator('.nz-nav-item[aria-current="page"]').count()).toBe(0);
    const back = page.getByRole("link", { name: "Go to your projects" });
    expect(await back.getAttribute("href")).toBe(`/${ws}/dashboard/projects`);
    await context.close();
  }, 60_000);

  test("B3-15: Support in the user menu writes to support@nearzero.dev", async () => {
    const context = await newContext();
    const page = await openPage(context, `/${ws}/dashboard/projects`);
    const support = page.locator(".nz-user-menu a", { hasText: "Support" }).first();
    expect(await support.getAttribute("href")).toBe("mailto:support@nearzero.dev");
    await context.close();
  }, 60_000);

  test("B3-16: phone crumbs at 375px are not cut", async () => {
    const project = await agent.owner.call<{ project: { id: string }; environmentId: string }>(
      "POST",
      "/projects",
      { name: "storefront", description: "" },
    );
    const { environments } = await agent.owner.call<{
      environments: { id: string; name: string }[];
    }>("GET", `/projects/${project.project.id}/environments`);
    const environmentId =
      environments.find((environment) => environment.name === "development")?.id ??
      (
        await agent.owner.call<{ environment: { id: string } }>(
          "POST",
          `/projects/${project.project.id}/environments`,
          { name: "development" },
        )
      ).environment.id;
    const context = await newContext({ width: 375, theme: "dusk" });
    const page = await openPage(
      context,
      `/${ws}/dashboard/projects/${project.project.id}/${environmentId}/overview`,
    );
    const crumbs = await page.$$eval(".nz-header .nz-crumb-name", (names) =>
      names
        .filter((name) => (name as HTMLElement).offsetParent !== null)
        .map((name) => ({
          text: name.textContent,
          cut: name.scrollWidth > name.clientWidth,
        })),
    );
    expect(crumbs.map((crumb) => crumb.text)).toEqual(["Acme", "storefront", "development"]);
    expect(crumbs.filter((crumb) => crumb.cut)).toEqual([]);
    await context.close();
  }, 60_000);

  test("R1-06 and B3-20: the bell reloads on the Agent page and orders cards by their time", async () => {
    const context = await newContext({ theme: "dusk" });
    const page = await context.newPage();
    await page.clock.install();
    await page.goto(`${base}/${ws}/dashboard/agent`, { waitUntil: "load" });
    // The bell was opened once: nothing is new.
    await page.locator("[data-bell-button]").click();
    await page.keyboard.press("Escape");
    const badge = page.locator("[data-bell-count]");
    expect(await badge.isHidden()).toBe(true);

    // While the page stays open, two deployments finish: one failed, one cancelled after a
    // long build that started before it.
    const [workspace] = await db`select id from workspace where slug = ${ws}`;
    const [service] = await db`select id, name from service where id = ${agent.serviceId}`;
    const insert = async (
      status: string,
      startedAgo: number,
      finishedAgo: number,
      title: string,
    ) => {
      await db`insert into deployment (workspace_id, service_id, project_id, environment_id, service_kind,
          service_name, app_name, project_name, environment_name, server_name, status, trigger, title,
          created_at, started_at, finished_at)
        values (${workspace.id}, null, ${agent.projectId}, ${agent.environmentId}, 'application',
          ${service.name}, 'web-app', 'Shop', 'production', 'Nearzero host', ${status}, 'manual', ${title},
          now() - make_interval(secs => ${startedAgo}), now() - make_interval(secs => ${startedAgo}),
          now() - make_interval(secs => ${finishedAgo}))`;
    };
    // Both finish after the bell was last opened; the cancelled one started first but ended last.
    await page.waitForTimeout(2_000);
    await insert("failed", 120, 1, "Broken build");
    await insert("cancelled", 600, 0, "Long build");
    await page.clock.fastForward(61_000);
    await badge.waitFor({ state: "visible", timeout: 20_000 });
    expect(await badge.textContent()).toBe("1");

    // Opening the panel shows both, in the order of the times they show.
    await page.clock.fastForward(16_000);
    await page.locator("[data-bell-button]").click();
    const titles = page.locator("[data-bell-deployments] .nz-bell-card-title");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-bell-deployments] .nz-bell-card").length >= 2,
      null,
      { timeout: 20_000 },
    );
    expect((await titles.allTextContents()).slice(0, 2)).toEqual(["Long build", "Broken build"]);
    const times = await page.$$eval("[data-bell-deployments] time", (items) =>
      items.map((item) => new Date((item as HTMLTimeElement).dateTime).getTime()),
    );
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    await context.close();
  }, 120_000);

  test("B3-18: a fresh invitation expires in 7 days", async () => {
    await agent.owner.call("POST", "/workspace/invitations", {
      email: "new-person@example.com",
      role: "member",
      policyIds: [],
    });
    const context = await newContext();
    const page = await openPage(context, `/${ws}/dashboard/settings/members`);
    const row = page.locator("tr", { hasText: "new-person@example.com" });
    await expect(row.textContent()).resolves.toContain("Expires in 7 days");
    await context.close();
  }, 60_000);
});

describe("settings pages", () => {
  test("B3-17: leaving Agent policies with unsaved changes asks first", async () => {
    const context = await newContext();
    const page = await openPage(context, `/${ws}/dashboard/settings/agent-policies`);
    const first = page.locator("[data-agent-policy]").first();
    await first.click();
    await page.locator("[data-agent-unsaved]").waitFor({ state: "visible" });
    const here = page.url();
    await page.locator(".nz-nav-item", { hasText: "Projects" }).first().click();
    const dialog = page.locator("#nz-leave-unsaved");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    expect(page.url()).toBe(here);
    await dialog.getByRole("button", { name: "Stay" }).click();
    await page.waitForTimeout(300);
    expect(page.url()).toBe(here);
    expect(await page.locator("[data-agent-unsaved]").isVisible()).toBe(true);

    await page.locator(".nz-nav-item", { hasText: "Projects" }).first().click();
    await dialog.waitFor({ state: "visible", timeout: 10_000 });
    await dialog.getByRole("button", { name: "Leave without saving" }).click();
    await page.waitForURL(`**/${ws}/dashboard/projects`, { timeout: 20_000 });
    await context.close();
  }, 60_000);

  test("B3-17: saving clears the warning, so the page reloads without asking", async () => {
    const context = await newContext();
    const page = await openPage(context, `/${ws}/dashboard/settings/agent-policies`);
    const first = page.locator("[data-agent-policy]").first();
    const before = await first.isChecked();
    await first.click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page
      .locator(".nz-toast", { hasText: "Agent policies saved" })
      .waitFor({ timeout: 15_000 });
    expect(await page.locator("#nz-leave-unsaved").isVisible()).toBe(false);
    await page.waitForFunction(
      () => document.querySelector("[data-agent-unsaved]")?.hasAttribute("hidden"),
      null,
      { timeout: 15_000 },
    );
    expect(await page.locator("[data-agent-policy]").first().isChecked()).toBe(!before);
    // Put it back.
    await page.locator("[data-agent-policy]").first().click();
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForFunction(
      () => document.querySelector("[data-agent-unsaved]")?.hasAttribute("hidden"),
      null,
      { timeout: 15_000 },
    );
    await context.close();
  }, 60_000);

  test("B3-27: Profile says My Account and its avatar choices are rounded squares", async () => {
    const context = await newContext();
    const page = await openPage(context, `/${ws}/dashboard/profile`);
    expect((await page.locator(".nz-account-title").textContent())?.trim()).toBe("My Account");
    const faces = await page.$$eval(".nz-avatar-face", (items) =>
      items.map((item) => getComputedStyle(item).borderRadius),
    );
    expect(faces.length).toBeGreaterThan(0);
    for (const radius of faces) expect(Number.parseFloat(radius)).toBeLessThan(16);
    const gravatar = await page.$eval(".nz-avatar-face--gravatar", (item) => item.innerHTML);
    expect(gravatar).not.toContain("#1e4fd0");
    await context.close();
  }, 60_000);
});

describe("the Agent", () => {
  let page: Page;
  let context: BrowserContext;
  let sessionId = "";

  beforeAll(async () => {
    context = await newContext({ theme: "dusk" });
    page = await openPage(context, `/${ws}/dashboard/agent`);
  }, 60_000);

  afterAll(async () => {
    await context?.close();
  });

  test("B3-06: a message sent a few seconds after the first reads just now", async () => {
    await sendMessage(page, "hello there");
    await lastTurnDone(page);
    sessionId = new URL(page.url()).searchParams.get("session") ?? "";
    expect(sessionId).not.toBe("");
    await page.waitForTimeout(6_000);
    await sendMessage(page, "hello again");
    await lastTurnDone(page);
    const time = page
      .locator(`[data-session="${sessionId}"]`)
      .filter({ visible: true })
      .locator(".nz-session-time [data-session-time]");
    await page.waitForTimeout(1_000);
    expect((await time.textContent())?.trim()).toBe("just now");
  }, 120_000);

  test("B3-08: Ask Agent over a selection has an opaque fill in Dusk and Light", async () => {
    for (const theme of ["dusk", "light"]) {
      await page.evaluate((name) => {
        document.documentElement.dataset.theme = name;
        document.documentElement.dataset.tone = name === "light" ? "light" : "dark";
      }, theme);
      await page.evaluate(() => {
        const text = document.querySelector(".nz-answer-text");
        if (!text?.firstChild) throw new Error("no answer text");
        const range = document.createRange();
        range.selectNodeContents(text);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });
      const ask = page.locator(".nz-ask-selection");
      await ask.waitFor({ state: "visible", timeout: 5_000 });
      const fill = await ask.evaluate((button) => getComputedStyle(button).backgroundColor);
      const alpha = fill.startsWith("rgba") ? Number(fill.split(",")[3]?.replace(")", "")) : 1;
      expect({ theme, fill, opaque: alpha === 1 && fill !== "transparent" }).toEqual({
        theme,
        fill,
        opaque: true,
      });
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
      await ask.waitFor({ state: "hidden", timeout: 5_000 });
    }
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dusk";
      document.documentElement.dataset.tone = "dark";
    });
  }, 60_000);

  test("B3-07, C3-05: an older session's title keeps its room, and its time stays whole", async () => {
    await db`update agent_session set title = 'Checking prices', title_source = 'person',
      last_message_at = now() - interval '33 minutes' where id = ${sessionId}`;
    await page.reload({ waitUntil: "load" });
    const row = page.locator(`[data-session="${sessionId}"]`).filter({ visible: true });
    await row.waitFor();
    const title = await row
      .locator(".nz-session-title")
      .evaluate((item) => ({ text: item.textContent, cut: item.scrollWidth > item.clientWidth }));
    expect(title).toEqual({ text: "Checking prices", cut: false });
    // C3-05: the time stays whole, in its short form, never cut mid-word.
    const time = await row.locator(".nz-session-time").evaluate((item) => ({
      text: item.querySelector("[data-session-time]")?.textContent?.trim(),
      cut: item.scrollWidth > item.clientWidth || item.getBoundingClientRect().width < 8,
    }));
    expect(time).toEqual({ text: "33m", cut: false });
  }, 60_000);

  test("B3-24: Escape cancels a session's delete confirm", async () => {
    const row = page.locator(`[data-session="${sessionId}"]`).filter({ visible: true });
    await row.hover();
    await row.locator(".nz-session-more").click();
    await page.locator(".nz-session-menu [role=menuitem]", { hasText: "Delete…" }).click();
    const confirm = row.locator(".nz-session-confirm");
    await confirm.waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await confirm.waitFor({ state: "detached", timeout: 5_000 });
    expect(
      await page.locator(`[data-session="${sessionId}"]`).filter({ visible: true }).count(),
    ).toBe(1);
    expect(
      await page.evaluate(() => document.activeElement?.classList.contains("nz-session-more")),
    ).toBe(true);
  }, 60_000);

  test("B3-10: a name saved on the Agent home reaches the user button at once", async () => {
    await agent.owner.call("POST", "/workspace/members", {
      email: "admin728@example.com",
      role: "member",
      password: "agent-password-3",
    });
    const person = await ApiSession.signIn(base, "admin728@example.com", "agent-password-3");
    await person.call("POST", "/onboarding/name", { name: "admin" });
    const own = await newContext({ session: person.sessionToken() });
    const home = await openPage(own, `/${ws}/dashboard/agent`);
    const trigger = home.locator(".nz-primary-nav .nz-user-trigger, .nz-user-trigger").first();
    expect((await trigger.locator(".nz-user-name").textContent())?.trim()).toBe(
      "admin728@example.com",
    );
    const prompt = home.locator(".nz-name-prompt");
    await prompt.locator("input").fill("Pat");
    await prompt.getByRole("button").click();
    await home.locator(".nz-greeting", { hasText: "Pat" }).waitFor({ timeout: 15_000 });
    await home.waitForFunction(
      () => document.querySelector(".nz-user-trigger .nz-user-name")?.textContent?.trim() === "Pat",
      null,
      { timeout: 10_000 },
    );
    expect((await trigger.locator(".nz-user-email").textContent())?.trim()).toBe(
      "admin728@example.com",
    );
    expect((await trigger.locator(".nz-avatar").textContent())?.trim()).toBe("P");
    await own.close();
  }, 120_000);

  test("B3-11: a first visit greets by the browser's clock, not the server's", async () => {
    const period = (hour: number) =>
      hour >= 5 && hour < 12 ? "morning" : hour < 18 && hour >= 12 ? "afternoon" : "evening";
    const serverPeriod = period(new Date().getHours());
    const zones = [
      "Pacific/Kiritimati",
      "Asia/Tokyo",
      "Europe/London",
      "America/New_York",
      "Pacific/Pago_Pago",
    ];
    const zone = zones.find((name) => {
      const hour = Number(
        new Intl.DateTimeFormat("en-US", {
          hour: "numeric",
          hourCycle: "h23",
          timeZone: name,
        }).format(new Date()),
      );
      return period(hour) !== serverPeriod;
    });
    expect(zone).toBeTruthy();
    const browserHour = Number(
      new Intl.DateTimeFormat("en-US", {
        hour: "numeric",
        hourCycle: "h23",
        timeZone: zone,
      }).format(new Date()),
    );
    const fresh = await newContext({ timezoneId: zone });
    const home = await openPage(fresh, `/${ws}/dashboard/agent`);
    await home.waitForTimeout(1_000);
    const line = ((await home.locator(".nz-greeting span").first().textContent()) ?? "").trim();
    if (!line.startsWith("Hi ")) expect(line).toContain(`Good ${period(browserHour)}`);
    expect(line).not.toContain(`Good ${serverPeriod}`);
    await fresh.close();
  }, 60_000);

  test("B3-28: on a phone the greeting is left-aligned in Dusk and Light", async () => {
    for (const theme of ["dusk", "light"]) {
      const phone = await newContext({ width: 375, theme });
      const home = await openPage(phone, `/${ws}/dashboard/agent`);
      const greeting = home.locator(".nz-greeting");
      await greeting.waitFor();
      const align = await greeting.evaluate((item) => getComputedStyle(item).textAlign);
      expect({ theme, align }).toEqual({ theme, align: "left" });
      const [greetingLeft, boxLeft] = await Promise.all([
        greeting
          .locator("span")
          .first()
          .evaluate((item) => {
            const range = document.createRange();
            range.selectNodeContents(item);
            return range.getBoundingClientRect().left;
          }),
        home
          .locator(".nz-composer")
          .first()
          .evaluate((item) => item.getBoundingClientRect().left),
      ]);
      expect(Math.abs(greetingLeft - boxLeft)).toBeLessThan(24);
      await phone.close();
    }
  }, 60_000);
});

describe("no page errors", () => {
  test("no script or console errors on any page visited", () => {
    expect(problems).toEqual([]);
  });
});
