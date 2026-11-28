import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type AgentStack, startAgentStack } from "../test-support/agent-stack.ts";
import {
  finiteAnimations,
  freezeAt as freeze,
  settled as settle,
  shadowedElements as shadows,
  thawAll as thaw,
} from "../test-support/motion-probe.ts";

/**
 * Interface motion end to end (spec 21.7) against a real control plane and console, in headless
 * Chromium:
 * - the acceptance line: the computed transition durations of the sidebar (200ms width), the
 *   phone navigation sheet (220ms in, 180ms out), a menu (140ms in, 100ms out), a dialog (180ms
 *   panel, 160ms backdrop, 120ms closing), a toast (180ms in, 140ms out), an Agent step (180ms
 *   height) and a tab strip (180ms slide) while each is moving, and 0 for every one of them under
 *   reduced motion, where nothing runs;
 * - nothing animates on a page's first paint, and no element has a shadow mid-animation;
 * - collapsing and expanding the sidebar keeps the person's choice (rendered on first paint),
 *   and fast clicks never queue up animations;
 * - keyboard focus and Escape work in menus and dialogs while they animate, and reopening one
 *   that is still closing turns it back from where it is.
 * Frames of the sidebar, a menu, a dialog and the phone sheet go to test-artifacts/motion/.
 *
 *   bun test e2e/motion.e2e.ts             (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...       (uses the dev server instead)
 *
 * Needs the development PostgreSQL; uses ports 4250 and 4550 (or NEARZERO_TEST_CONTROL_PORT and
 * NEARZERO_TEST_CONSOLE_PORT) and a database named nz_m11b_… (or NEARZERO_TEST_DATABASE_PREFIX).
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const FRAMES = resolve(CONSOLE_ROOT, "test-artifacts", "motion");

let agent: AgentStack;
let browser: Browser;
let base = "";
let agentPath = "";
let stepsSession = "";
const problems: string[] = [];

function watch(target: Page): void {
  target.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() === "error" && !/status of 4\d\d/.test(message.text())) {
      problems.push(`console error: ${message.text()}`);
    }
  });
}

async function newPage(
  options: { width?: number; theme?: string; reduced?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const width = options.width ?? 1440;
  const context = await browser.newContext({
    viewport: { width, height: width < 700 ? 812 : 900 },
    reducedMotion: options.reduced ? "reduce" : "no-preference",
  });
  await context.addCookies([
    { name: "nz_session", value: agent.owner.sessionToken(), url: base },
    { name: "nz_theme", value: options.theme ?? "light", url: base },
  ]);
  const page = await context.newPage();
  watch(page);
  return { context, page };
}

async function open(page: Page, path: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await page
      .goto(`${base}${path}`, { waitUntil: "networkidle", timeout: 120_000 })
      .catch(() => null);
    if (response && response.status() < 500) return;
    await page.waitForTimeout(2_000);
  }
  throw new Error(`${path} didn't load.`);
}

/** Durations of the CSS transitions running on the elements, per property, in milliseconds. */
function running(page: Page, selector: string, pseudo?: string) {
  return page.evaluate(
    ({ selector, pseudo }) => {
      const found: Record<string, number> = {};
      for (const element of document.querySelectorAll(selector)) {
        for (const animation of element.getAnimations({ subtree: Boolean(pseudo) })) {
          const effect = animation.effect as KeyframeEffect | null;
          if (pseudo && effect?.pseudoElement !== pseudo) continue;
          if (!pseudo && effect?.target !== element) continue;
          const name = (animation as CSSTransition).transitionProperty;
          if (!name || animation.playState === "finished") continue;
          found[name] = Number(effect?.getComputedTiming().duration ?? 0);
        }
      }
      return found;
    },
    { selector, pseudo },
  );
}

/** The computed transition-duration list of an element (or its ::backdrop). */
function durations(page: Page, selector: string, pseudo?: string): Promise<string> {
  return page.evaluate(
    ({ selector, pseudo }) => {
      const element = document.querySelector(selector);
      return element ? getComputedStyle(element, pseudo ?? null).transitionDuration : "missing";
    },
    { selector, pseudo },
  );
}

/**
 * Draws the motion just started at a quarter, half and three quarters of the way, as
 * <name>-25.png, -50.png and -75.png, then lets it go on.
 */
async function frames(page: Page, name: string, clip?: { width: number; height: number }) {
  for (const fraction of [0.25, 0.5, 0.75]) {
    await freeze(page, fraction);
    await page.screenshot({
      path: resolve(FRAMES, `${name}-${fraction * 100}.png`),
      clip: clip ? { x: 0, y: 0, ...clip } : undefined,
    });
  }
  await thaw(page);
}

async function sendAndWait(text: string): Promise<string> {
  const sent = await agent.owner.call<{ session: { id: string } }>("POST", "/agent/messages", {
    text,
  });
  for (let i = 0; i < 200; i++) {
    const detail = await agent.owner.call<{ turns: { state: string }[] }>(
      "GET",
      `/agent/sessions/${sent.session.id}`,
    );
    if (detail.turns.at(-1)?.state === "finished") return sent.session.id;
    await Bun.sleep(300);
  }
  throw new Error(`"${text}" never finished.`);
}

beforeAll(async () => {
  await mkdir(FRAMES, { recursive: true });
  const dev = process.env.E2E_CONSOLE === "dev";
  if (!dev) await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  agent = await startAgentStack({ console: dev ? "dev" : "built", label: "motion" });
  base = agent.stack.consoleUrl;
  agentPath = `/${agent.workspace}/dashboard/agent`;
  stepsSession = await sendAndWait("Please do three steps for me");
  browser = await chromium.launch();
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await agent?.stop();
}, 300_000);

describe("interface motion (spec 21.7)", () => {
  test("nothing animates on a page's first paint; content swapped in rises", async () => {
    const { context, page } = await newPage();
    await open(page, agentPath);
    expect(await finiteAnimations(page)).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector("[data-page-content]") as Element).animationName,
      ),
    ).toBe("none");
    expect(await page.getAttribute("[data-primary-nav]", "data-state")).toBe("open");
    await page.locator(".nz-nav a[href$='/projects']").click();
    await page.waitForURL(/\/projects$/);
    expect(
      await page.evaluate(
        () =>
          getComputedStyle(document.querySelector("[data-page-content]") as Element).animationName,
      ),
    ).toBe("nz-rise-in");
    await context.close();
  }, 120_000);

  test("acceptance: the durations while each part moves, with no shadow mid-animation", async () => {
    const { context, page } = await newPage();
    const midway: string[] = [];
    const checkMidway = async (what: string) => {
      await freeze(page, 0.5);
      for (const element of await shadows(page)) midway.push(`${what}: ${element}`);
      await thaw(page);
    };

    // The sidebar: its width over 200ms, labels out in the first 100ms.
    await open(page, agentPath);
    expect(await durations(page, "[data-primary-nav]")).toBe("0.2s");
    await page.locator("[data-nav-toggle]").click();
    expect(await running(page, "[data-primary-nav]")).toEqual({ width: 200 });
    expect(await running(page, "[data-primary-nav] .nz-nav-label")).toEqual({ opacity: 100 });
    await frames(page, "sidebar-collapse", { width: 720, height: 900 });
    await checkMidway("sidebar");
    await settle(page);
    await page.screenshot({ path: resolve(FRAMES, "sidebar-collapsed.png") });
    await page.locator("[data-nav-toggle]").click();
    await frames(page, "sidebar-expand", { width: 720, height: 900 });
    await settle(page);
    await page.screenshot({ path: resolve(FRAMES, "sidebar-open.png") });

    // A menu: in over 140ms with its drop, out over 100ms.
    await page.locator('[popovertarget="nz-workspace-menu"]').click();
    await page.waitForFunction(
      () => !document.querySelector("#nz-workspace-menu")?.hasAttribute("data-motion"),
    );
    expect(await running(page, "#nz-workspace-menu")).toEqual({ opacity: 140, transform: 140 });
    await frames(page, "menu-opening", { width: 720, height: 300 });
    await checkMidway("menu");
    await settle(page);
    await page.keyboard.press("Escape");
    expect((await running(page, "#nz-workspace-menu")).opacity).toBe(100);
    await settle(page);

    // A dialog: the panel over 180ms from 98%, the backdrop over 160ms, closing over 120ms.
    await page.locator('[popovertarget="nz-workspace-menu"]').click();
    await page.locator('#nz-workspace-menu [data-dialog-open="nz-rename-workspace"]').click();
    expect(await running(page, "#nz-rename-workspace")).toMatchObject({
      opacity: 180,
      transform: 180,
    });
    expect(await running(page, "#nz-rename-workspace", "::backdrop")).toMatchObject({
      opacity: 160,
    });
    await frames(page, "dialog-opening");
    await checkMidway("dialog");
    await settle(page);
    await page.keyboard.press("Escape");
    expect(await running(page, "#nz-rename-workspace")).toMatchObject({
      opacity: 120,
      transform: 120,
    });
    await settle(page);

    // A toast: in over 180ms with an 8px rise, out over 140ms.
    await open(page, `${agentPath}?session=${stepsSession}`);
    await page.locator(".nz-code-card [data-copy]").first().click();
    await page.locator(".nz-toast").waitFor();
    expect(await running(page, ".nz-toast")).toEqual({ opacity: 180, transform: 180 });
    await checkMidway("toast");
    await settle(page);
    await page.locator(".nz-toast button[aria-label='Dismiss']").first().click();
    expect(await running(page, ".nz-toast")).toEqual({ opacity: 140 });
    await settle(page);
    expect(await page.locator(".nz-toast").count()).toBe(0);

    // An Agent step: its details open and close by height over 180ms.
    await page.locator("button.nz-action-row").first().click();
    expect(await running(page, ".nz-action .nz-expand")).toEqual({ height: 180 });
    await checkMidway("step");
    await settle(page);
    await page.locator("button.nz-action-row").first().click();
    expect(await running(page, ".nz-action .nz-expand")).toEqual({ height: 180 });
    await settle(page);
    expect(await page.locator(".nz-action .nz-expand").count()).toBe(0);

    // A tab strip: the active tab's underline slides over 180ms.
    await open(page, `/${agent.workspace}/dashboard/settings/members`);
    await page.getByRole("tab", { name: /Access policies/ }).click();
    expect(await running(page, ".nz-tab-glider")).toEqual({ transform: 180 });
    expect(await durations(page, ".nz-tab-glider")).toBe("0.18s");
    await checkMidway("tabs");
    await settle(page);
    expect(await page.locator(".nz-tab-glider").count()).toBe(0);

    // Hover, press and focus: 120ms.
    expect(await durations(page, ".nz-btn")).toBe("0.12s, 0.12s, 0.12s, 0.12s, 0.12s");
    await context.close();

    // The phone navigation sheet: in from its edge over 220ms, out over 180ms.
    const phone = await newPage({ width: 375, theme: "dusk" });
    await open(phone.page, agentPath);
    await phone.page.getByRole("button", { name: "Open menu" }).click();
    expect(await running(phone.page, "#nz-nav-sheet")).toMatchObject({ transform: 220 });
    expect(await running(phone.page, "#nz-nav-sheet", "::backdrop")).toMatchObject({
      opacity: 220,
    });
    await freeze(phone.page, 0.5);
    for (const element of await shadows(phone.page)) midway.push(`sheet: ${element}`);
    await thaw(phone.page);
    await settle(phone.page);
    await phone.page.keyboard.press("Escape");
    await settle(phone.page);
    await phone.page.getByRole("button", { name: "Open menu" }).click();
    await frames(phone.page, "phone-sheet-opening");
    await settle(phone.page);
    await phone.page.screenshot({ path: resolve(FRAMES, "phone-sheet-open.png") });
    await phone.page.keyboard.press("Escape");
    expect(await running(phone.page, "#nz-nav-sheet")).toMatchObject({ transform: 180 });
    await settle(phone.page);
    // The Agent's sessions slide-over does the same.
    await phone.page.locator(".nz-chat-bar button[title='Chat history']").click();
    expect(await running(phone.page, ".nz-sheet-panel")).toEqual({ transform: 220 });
    expect(await running(phone.page, ".nz-sheet-backdrop")).toEqual({ opacity: 220 });
    await settle(phone.page);
    await phone.page.keyboard.press("Escape");
    expect(await running(phone.page, ".nz-sheet-panel")).toEqual({ transform: 180 });
    await phone.context.close();

    expect(midway).toEqual([]);
    expect(problems).toEqual([]);
  }, 180_000);

  test("acceptance: under reduced motion every one of them takes 0 and nothing runs", async () => {
    const { context, page } = await newPage({ reduced: true, theme: "dusk" });
    const zero = /^0s(, 0s)*$/;
    await open(page, `${agentPath}?session=${stepsSession}`);
    for (const [selector, pseudo] of [
      ["[data-primary-nav]"],
      ["[data-primary-nav] .nz-nav-label"],
      ["#nz-nav-sheet"],
      ["#nz-nav-sheet", "::backdrop"],
      ["#nz-workspace-menu"],
      ["#nz-rename-workspace"],
      ["#nz-rename-workspace", "::backdrop"],
      [".nz-btn"],
      [".nz-sheet-panel"],
      [".nz-sheet-backdrop"],
    ] as [string, string?][]) {
      const time = await durations(page, selector, pseudo);
      expect(`${selector}${pseudo ?? ""}: ${time}`).toMatch(/: 0s(, 0s)*$/);
    }
    await page.locator("[data-nav-toggle]").click();
    expect(await page.getAttribute("[data-primary-nav]", "data-state")).toBe("closed");
    await page.locator('[popovertarget="nz-workspace-menu"]').click();
    await page.locator('#nz-workspace-menu [data-dialog-open="nz-rename-workspace"]').click();
    expect(await durations(page, "#nz-rename-workspace")).toMatch(zero);
    await page.keyboard.press("Escape");
    await page.locator(".nz-code-card [data-copy]").first().click();
    await page.locator(".nz-toast").waitFor();
    expect(await durations(page, ".nz-toast")).toMatch(zero);
    await page.locator("button.nz-action-row").first().click();
    expect(await durations(page, ".nz-action .nz-expand")).toMatch(zero);
    expect(await finiteAnimations(page)).toEqual([]);

    // The tab strip's glider: none is made, and its rule takes no time either.
    await open(page, `/${agent.workspace}/dashboard/settings/members`);
    expect(await durations(page, ".nz-tab")).toMatch(zero);
    await page.getByRole("tab", { name: /Access policies/ }).click();
    expect(await page.locator(".nz-tab-glider").count()).toBe(0);
    expect(
      await page.evaluate(() => {
        const glider = document.createElement("span");
        glider.className = "nz-tab-glider";
        document.querySelector(".nz-tabs")?.prepend(glider);
        const time = getComputedStyle(glider).transitionDuration;
        glider.remove();
        return time;
      }),
    ).toBe("0s");
    expect(await finiteAnimations(page)).toEqual([]);
    await context.close();

    const phone = await newPage({ width: 375, reduced: true });
    await open(phone.page, agentPath);
    await phone.page.getByRole("button", { name: "Open menu" }).click();
    expect(await finiteAnimations(phone.page)).toEqual([]);
    expect(
      await phone.page.locator("#nz-nav-sheet").evaluate((d) => getComputedStyle(d).transform),
    ).toBe("none");
    await phone.context.close();
    expect(problems).toEqual([]);
  }, 180_000);

  test("collapsing and expanding the sidebar keeps the person's choice; fast clicks never queue", async () => {
    const { context, page } = await newPage({ theme: "dark" });
    await open(page, agentPath);
    const nav = page.locator("[data-primary-nav]");
    expect(await nav.getAttribute("data-state")).toBe("open");
    await page.locator("[data-nav-toggle]").click();
    expect(await nav.getAttribute("data-state")).toBe("closed");
    const cookie = async () =>
      (await context.cookies(base)).find((item) => item.name === "nz_nav")?.value;
    expect(await cookie()).toBe("closed");

    // The saved choice is on the first paint of every rail page, with no animation.
    await open(page, agentPath);
    expect(await nav.getAttribute("data-state")).toBe("closed");
    expect(await finiteAnimations(page)).toEqual([]);
    expect(await nav.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(60);
    const project = `/${agent.workspace}/dashboard/projects/${agent.projectId}/${agent.environmentId}/overview`;
    const html = await (await page.request.get(`${base}${project}`)).text();
    expect(html).toMatch(/data-primary-nav[^>]*data-state="closed"/);

    // Five fast clicks: one width transition at a time, ending open, saved as open.
    await open(page, project);
    for (let i = 0; i < 5; i++) {
      const moving = await page.evaluate(() => {
        (document.querySelector("[data-nav-toggle]") as HTMLElement).click();
        const nav = document.querySelector("[data-primary-nav]") as HTMLElement;
        return nav.getAnimations().filter((animation) => animation.playState === "running").length;
      });
      expect(moving).toBe(1);
      await page.waitForTimeout(30);
    }
    expect(await nav.getAttribute("data-state")).toBe("open");
    await settle(page);
    expect(await nav.getAttribute("data-motion")).toBeNull();
    expect(await nav.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(
      260,
    );
    expect(await cookie()).toBe("open");
    const reopened = await (await page.request.get(`${base}${project}`)).text();
    expect(reopened).toMatch(/data-primary-nav[^>]*data-state="open"/);

    // Reversing midway never jumps: the width carries on from where it was.
    await page.locator("[data-nav-toggle]").click();
    await freeze(page, 0.5);
    const before = await nav.evaluate((element) => element.getBoundingClientRect().width);
    await page.locator("[data-nav-toggle]").click({ force: true });
    const after = await nav.evaluate((element) => element.getBoundingClientRect().width);
    expect(Math.abs(after - before)).toBeLessThan(2);
    await thaw(page);
    await settle(page);
    expect(await nav.getAttribute("data-state")).toBe("open");
    await context.close();
    expect(problems).toEqual([]);
  }, 120_000);

  test("keyboard focus and Escape work in menus and dialogs while they animate", async () => {
    const { context, page } = await newPage();
    await open(page, agentPath);
    const trigger = page.locator('[popovertarget="nz-workspace-menu"]');
    const menu = page.locator("#nz-workspace-menu");
    const opacity = () => menu.evaluate((element) => Number(getComputedStyle(element).opacity));

    // Opened from the keyboard: focus is in the menu and the arrow keys move while it fades in.
    await trigger.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(() =>
      Boolean(document.activeElement?.closest("#nz-workspace-menu")),
    );
    await freeze(page, 0.3);
    expect(await opacity()).toBeLessThan(1);
    const first = await page.evaluate(() => document.activeElement?.textContent?.trim());
    await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() => document.activeElement?.textContent?.trim());
    expect(second).not.toBe(first);
    expect(
      await page.evaluate(() => Boolean(document.activeElement?.closest("#nz-workspace-menu"))),
    ).toBe(true);
    // Escape mid-animation closes it at once and gives focus back to its button.
    await page.keyboard.press("Escape");
    expect(await menu.evaluate((element) => element.matches(":popover-open"))).toBe(false);
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    await thaw(page);
    // Reopened while it fades out, it turns back from where it is.
    await page.waitForFunction(() => {
      const element = document.querySelector("#nz-workspace-menu");
      return element && Number(getComputedStyle(element).opacity) < 0.9;
    });
    await freeze(page, 0.5);
    const fading = await opacity();
    expect(fading).toBeGreaterThan(0);
    await thaw(page);
    await page.keyboard.press("Enter");
    const turned = await opacity();
    expect(turned).toBeGreaterThan(fading - 0.25);
    await settle(page);
    expect(await opacity()).toBe(1);
    await page.keyboard.press("Escape");
    await settle(page);

    // A dialog: focus moves in and stays in while it scales in; Escape closes it mid-animation.
    const dialog = page.locator("#nz-rename-workspace");
    await trigger.click();
    await page.locator('#nz-workspace-menu [data-dialog-open="nz-rename-workspace"]').click();
    await freeze(page, 0.3);
    expect(
      await dialog.evaluate((element) => Number(getComputedStyle(element).opacity)),
    ).toBeLessThan(1);
    expect(await page.evaluate(() => document.activeElement?.closest("dialog")?.id)).toBe(
      "nz-rename-workspace",
    );
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.closest("dialog")?.id)).toBe(
      "nz-rename-workspace",
    );
    await page.keyboard.press("Escape");
    expect(await dialog.evaluate((element: HTMLDialogElement) => element.open)).toBe(false);
    expect(await trigger.evaluate((element) => element === document.activeElement)).toBe(true);
    await thaw(page);
    // Reopened while it fades out: no jump back to nothing.
    await page.waitForFunction(() => {
      const element = document.querySelector("#nz-rename-workspace");
      return element && Number(getComputedStyle(element).opacity) < 0.9;
    });
    await freeze(page, 0.5);
    const closing = await dialog.evaluate((element) => Number(getComputedStyle(element).opacity));
    await page.evaluate(() =>
      (document.querySelector("#nz-rename-workspace") as HTMLDialogElement).showModal(),
    );
    const reopened = await dialog.evaluate((element) => Number(getComputedStyle(element).opacity));
    expect(reopened).toBeGreaterThan(closing - 0.25);
    await thaw(page);
    await settle(page);
    await page.keyboard.press("Escape");
    await settle(page);
    expect(await dialog.evaluate((element: HTMLDialogElement) => element.open)).toBe(false);
    await context.close();
    expect(problems).toEqual([]);
  }, 120_000);
});
