/**
 * The Agent page's browser sweep (spec 19, 21.2, 21.5, 21.8, 21.9, 23.7). Starts its own
 * throwaway Nearzero (control plane on 4250, console on 4550, database nz_m11b_*) with the
 * scripted model server (test-support/fake-model.ts), seeds chats through the API as a browser
 * would, and loads the Agent page in Light, Dark and Dusk at 375, 768, 1024 and 1440px with the
 * insecure-context APIs removed (as on plain HTTP):
 * - the empty chat (the owner's home, a member's home);
 * - a finished turn with three steps, a table, a code card and suggestions;
 * - a turn still running (status line, Stop);
 * - a turn waiting on the variables form;
 * - the permission card;
 * - a long code card (folded) and a shared session seen read-only by a member;
 * - under 720px, the sessions slide-over opened.
 * It fails on a script or console error, a 5xx, horizontal page scroll, a clipped header, a
 * control narrower than its label, text under 2.6:1 contrast or a large light surface in Dark and
 * Dusk, Dusk-only fonts outside Dusk, a secret in an address, or missing page metadata (the
 * home's "Nearzero" title, description, robots, icon and manifest links, theme-color; spec
 * 21.9b). Screenshots (Dusk and Light, 375 and 1440) go to test-artifacts/m11b/.
 *
 * Usage: bun ./sweep/agent.ts (from apps/console). E2E_CONSOLE=built uses the production build.
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { type AgentStack, startAgentStack } from "../test-support/agent-stack.ts";
import { settled, shadowsMidway } from "../test-support/motion-probe.ts";
import type { ApiSession } from "../test-support/stack.ts";
import { controlProblems, hoverProblems, metadataProblems } from "./controls.ts";

const ROOT = resolve(import.meta.dir, "..");
const SHOTS = resolve(ROOT, "test-artifacts", "m11b");
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
const FLOOR = 2.6;

interface Route {
  name: string;
  path: string;
  as: "owner" | "member";
  /** Saved at 375 and 1440px in Dusk and Light as test-artifacts/m11b/<shot>-<theme>-<width>.png. */
  shot?: string;
  /** Wait for this before checking (a form, a card, a running status line). */
  ready?: string;
  act?: (page: Page, width: number) => Promise<void>;
}

const failures: string[] = [];
let loads = 0;
let lowest = { ratio: Number.POSITIVE_INFINITY, where: "" };

function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

/** Checks inside the page: layout, header, controls, and contrast in Dark and Dusk. */
function inspect(args: { contrast: boolean; floor: number }) {
  const problems: string[] = [];
  const describe = (el: Element) =>
    `<${el.tagName.toLowerCase()}.${String(el.className).split(" ")[0]}> "${(el.textContent ?? "").trim().slice(0, 32)}"`;
  const visible = (el: Element) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    el.getBoundingClientRect().width > 0 &&
    el.getBoundingClientRect().height > 0;
  const scroller = document.scrollingElement ?? document.documentElement;
  if (scroller.scrollWidth > scroller.clientWidth + 1) {
    problems.push(
      `horizontal page scroll (${scroller.scrollWidth}px in ${scroller.clientWidth}px)`,
    );
  }
  const header = document.querySelector(".nz-header");
  if (header && visible(header) && header.scrollWidth > header.clientWidth + 1) {
    problems.push("the header overflows");
  }
  for (const el of document.querySelectorAll(".nz-btn, .nz-starter, .nz-tab")) {
    if (!visible(el) || el.closest(".nz-nav[data-state='closed'], [inert]")) continue;
    if (el.scrollWidth > el.clientWidth + 1)
      problems.push(`control narrower than its label: ${describe(el)}`);
  }
  for (const el of document.querySelectorAll(
    ".nz-chat, .nz-thread, .nz-dock, .nz-chatform-card, .nz-permission",
  )) {
    if (!visible(el)) continue;
    const box = el.getBoundingClientRect();
    if (box.right > window.innerWidth + 1) problems.push(`off the right edge: ${describe(el)}`);
  }
  type Rgba = [number, number, number, number];
  const parse = (value: string): Rgba | null => {
    const match = value.match(/^rgba?\(([^)]+)\)$/);
    if (match?.[1]) {
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    }
    const srgb = value.match(/^color\(srgb\s+([^)]+)\)$/);
    if (srgb?.[1]) {
      const [rgb = "", alpha] = srgb[1].split("/");
      const parts = rgb.trim().split(/\s+/).map(Number);
      return [
        (parts[0] ?? 0) * 255,
        (parts[1] ?? 0) * 255,
        (parts[2] ?? 0) * 255,
        alpha ? Number(alpha) : 1,
      ];
    }
    return null;
  };
  const over = (top: Rgba, bottom: Rgba): Rgba => [
    top[0] * top[3] + bottom[0] * (1 - top[3]),
    top[1] * top[3] + bottom[1] * (1 - top[3]),
    top[2] * top[3] + bottom[2] * (1 - top[3]),
    1,
  ];
  const luminance = (c: Rgba) => {
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  };
  const ratio = (a: Rgba, b: Rgba) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const page = parse(getComputedStyle(document.documentElement).backgroundColor) ?? [
    255, 255, 255, 1,
  ];
  const backgroundOf = (el: Element): Rgba => {
    const chain: Element[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
    let color: Rgba = page[3] >= 1 ? page : over(page, [255, 255, 255, 1]);
    for (const node of chain.reverse()) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg[3] > 0) color = over(bg, color);
    }
    return color;
  };
  let low = { ratio: Number.POSITIVE_INFINITY, what: "" };
  if (args.contrast) {
    for (const el of document.body.querySelectorAll(".nz-agent *")) {
      const hasText = Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim() !== "",
      );
      if (
        !hasText ||
        !visible(el) ||
        el.closest(".nz-visually-hidden, [aria-hidden='true'], :disabled, [inert]")
      )
        continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      const text = parse(getComputedStyle(el).color);
      if (!text) continue;
      let alpha = text[3];
      for (let node: Element | null = el; node; node = node.parentElement)
        alpha *= Number(getComputedStyle(node).opacity);
      const background = backgroundOf(el);
      const value = ratio(over([text[0], text[1], text[2], alpha], background), background);
      if (value < low.ratio) low = { ratio: value, what: describe(el) };
      if (value < args.floor) problems.push(`contrast ${value.toFixed(2)}:1 for ${describe(el)}`);
    }
    const area = window.innerWidth * window.innerHeight;
    for (const el of document.body.querySelectorAll(".nz-agent *")) {
      const bg = parse(getComputedStyle(el).backgroundColor);
      if (!bg || bg[3] < 0.5 || !visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height > area * 0.15 && luminance(over(bg, page)) > 0.35) {
        problems.push(`large light surface: ${describe(el)}`);
      }
    }
  }
  return { problems, low, theme: document.documentElement.getAttribute("data-theme") };
}

async function sweep(
  browser: Browser,
  agent: AgentStack,
  routes: Route[],
  sessions: Record<string, string>,
) {
  const base = agent.stack.consoleUrl;
  const jobs = THEMES.flatMap((theme) => VIEWPORTS.map((viewport) => ({ theme, viewport })));
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      for (let job = jobs.shift(); job; job = jobs.shift()) {
        const { theme, viewport } = job;
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
        await context.addInitScript(INSECURE_CONTEXT);
        const page = await context.newPage();
        let current = "";
        const fonts: string[] = [];
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
          if (/(geist-mono|instrument-serif)[^/]*\.(woff2?|ttf|otf)/i.test(url.pathname))
            fonts.push(url.pathname);
          for (const name of ["password", "key", "apiKey", "token", "value", "privateKey"]) {
            if (url.searchParams.has(name))
              fail(current, `"${name}" in an address: ${url.pathname}`);
          }
        });
        for (const route of routes) {
          current = `${route.name} as ${route.as} (${theme}, ${viewport.width}px)`;
          await context.clearCookies();
          await context.addCookies([
            { name: "nz_session", value: sessions[route.as] as string, url: base },
            { name: "nz_theme", value: theme, url: base },
          ]);
          try {
            const go = () =>
              page.goto(`${base}${route.path}`, { waitUntil: "load", timeout: 120_000 });
            const response = await go().catch(async (error: Error) => {
              if (!/ERR_ABORTED|interrupted/.test(error.message)) throw error;
              await page.waitForTimeout(500);
              return go();
            });
            loads++;
            if ((response?.status() ?? 0) !== 200) fail(current, `status ${response?.status()}`);
            if (route.ready) await page.locator(route.ready).first().waitFor({ timeout: 30_000 });
            await page.waitForTimeout(350);
            if (route.act) await route.act(page, viewport.width);
            const result = await page.evaluate(inspect, {
              contrast: theme !== "light",
              floor: FLOOR,
            });
            if (result.theme !== theme) fail(current, `rendered in ${result.theme}`);
            for (const problem of result.problems) fail(current, problem);
            // Spec 21.9a: 4px by 8px fields and buttons (the message box included) with 6px
            // corners, none taller than its content, and no shadows at rest, focused or hovered.
            const controls = await page.evaluate(controlProblems, { dialogs: true });
            for (const problem of [...controls.problems, ...controls.shadows]) {
              fail(current, problem);
            }
            for (const rule of controls.shadowRules)
              fail("stylesheets", `a rule draws a shadow: ${rule}`);
            // Spec 21.9b: the Agent page is the home ("Nearzero" alone), with a description,
            // robots noindex, the icon and manifest links, theme-color on the theme's page
            // token, the mark in the header's brand, and no link-preview tags.
            for (const problem of await page.evaluate(metadataProblems, {
              home: true,
              preview: false,
            })) {
              fail(current, problem);
            }
            if (viewport.width === 1440) {
              for (const problem of await hoverProblems(page)) fail(current, problem);
            }
            if (result.low.ratio < lowest.ratio)
              lowest = { ratio: result.low.ratio, where: `${current} ${result.low.what}` };
            if (
              route.shot &&
              theme !== "dark" &&
              (viewport.width === 375 || viewport.width === 1440)
            ) {
              await page.screenshot({
                path: resolve(SHOTS, `${route.shot}-${theme}-${viewport.width}.png`),
              });
            }
          } catch (error) {
            fail(current, (error as Error).message.split("\n")[0] ?? String(error));
          }
        }
        if (theme !== "dusk" && fonts.length > 0)
          fail(`${theme} ${viewport.width}px`, `Dusk-only fonts downloaded: ${fonts[0]}`);
        await context.close();
      }
    }),
  );
}

/** Sends a message as the owner and waits until its turn finished, waits on a form, or streams. */
async function sendAndWait(
  owner: ApiSession,
  text: string,
  until: "finished" | "waiting" | "working",
) {
  const sent = await owner.call<{ session: { id: string }; turn: { id: string } }>(
    "POST",
    "/agent/messages",
    { text },
  );
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    const detail = await owner.call<{ turns: { state: string; events: { type: string }[] }[] }>(
      "GET",
      `/agent/sessions/${sent.session.id}`,
    );
    const turn = detail.turns.at(-1);
    const types = turn?.events.map((event) => event.type) ?? [];
    const done =
      until === "finished"
        ? types.includes("turn.finished") &&
          (types.includes("suggestions") ||
            turn?.state !== "finished" ||
            Date.now() - started > 15_000)
        : until === "waiting"
          ? turn?.state === "waiting"
          : types.filter((type) => type === "text").length > 3;
    if (done) return { sessionId: sent.session.id, turnId: sent.turn.id };
    await Bun.sleep(300);
  }
  throw new Error(`"${text}" never reached ${until}.`);
}

async function main(): Promise<void> {
  await mkdir(SHOTS, { recursive: true });
  console.log("Starting a throwaway Nearzero (control plane on 4250, console on 4550)…");
  const agent = await startAgentStack({
    console: process.env.E2E_CONSOLE === "built" ? "built" : "dev",
    label: "sweep",
  });
  const browser = await chromium.launch();
  let running: string | null = null;
  try {
    const owner = agent.owner;
    const finished = await sendAndWait(owner, "Please do three steps for me", "finished");
    const code = await sendAndWait(owner, "Show me the code for it", "finished");
    const permission = await sendAndWait(owner, "Please list my keys", "finished");
    const form = await sendAndWait(owner, "I need to set variables for web", "waiting");
    await owner.call("POST", `/agent/sessions/${code.sessionId}/share`, { shared: true });
    const live = await sendAndWait(owner, "Please keep going on this", "working");
    running = live.turnId;
    const W = `/${agent.workspace}/dashboard/agent`;
    const routes: Route[] = [
      { name: "home", path: W, as: "owner", shot: "home", ready: ".nz-greeting" },
      { name: "member home", path: W, as: "member", ready: ".nz-greeting" },
      {
        name: "finished turn",
        path: `${W}?session=${finished.sessionId}`,
        as: "owner",
        shot: "finished-turn",
        ready: ".nz-turn-foot",
        // Spec 21.7: a step opening and closing shows no shadow midway; it ends closed again.
        act: async (page) => {
          const row = page.locator("button.nz-action-row").first();
          const found = [
            ...(await shadowsMidway(page, () => row.click())),
            ...(await shadowsMidway(page, () => row.click())),
          ];
          await settled(page);
          if (found.length > 0) throw new Error(`shadows while a step moves: ${found[0]}`);
        },
      },
      {
        name: "running turn",
        path: `${W}?session=${live.sessionId}`,
        as: "owner",
        shot: "running-turn",
        ready: "[data-stop]",
      },
      {
        name: "variables form",
        path: `${W}?session=${form.sessionId}`,
        as: "owner",
        shot: "variables-form",
        ready: ".nz-chatvar-row",
      },
      {
        name: "permission card",
        path: `${W}?session=${permission.sessionId}`,
        as: "owner",
        shot: "permission-card",
        ready: ".nz-permission",
      },
      {
        name: "long code",
        path: `${W}?session=${code.sessionId}`,
        as: "owner",
        ready: ".nz-code-card",
      },
      {
        name: "shared, read-only",
        path: `${W}?session=${code.sessionId}`,
        as: "member",
        ready: ".nz-thread-note",
      },
      {
        name: "slide-over",
        path: `${W}?session=${finished.sessionId}`,
        as: "owner",
        shot: "slide-over",
        ready: ".nz-turn",
        act: async (page, width) => {
          if (width >= 720) return;
          await page.locator(".nz-chat-bar button", { hasText: "Chat history" }).click();
          await page.waitForTimeout(300);
        },
      },
    ];
    const sessions = { owner: owner.sessionToken(), member: agent.member.sessionToken() };
    await sweep(browser, agent, routes, sessions);
    console.log(
      `\nSwept ${routes.length} Agent page states × ${THEMES.length} themes × ${VIEWPORTS.length} widths (${loads} loads).`,
    );
    console.log(
      `Lowest text contrast in Dark and Dusk: ${lowest.ratio.toFixed(2)}:1 at ${lowest.where}`,
    );
  } finally {
    if (running) await agent.owner.call("POST", `/agent/turns/${running}/stop`).catch(() => null);
    await browser.close();
    await agent.stop();
  }
  if (failures.length > 0) {
    const unique = [...new Set(failures)];
    failures.length = 0;
    failures.push(...unique);
    console.log(`\n${failures.length} problem(s):`);
    for (const failure of failures.slice(0, 200)) console.log(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log("\nNo problems found.");
}

await main();
