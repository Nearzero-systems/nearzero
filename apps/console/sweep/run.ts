/**
 * The console's browser sweep (spec 21.2, 21.8, 21.9, 23.7, 18.1). Starts its own throwaway
 * Nearzero (control plane on 4150, console dev server on 4450, a fresh database), seeds an owner,
 * members and invitations through the API, and loads every page as each of them in Light, Dark
 * and Dusk at 375, 768, 1024 and 1440px in headless Chromium with the three insecure-context
 * APIs removed (as on plain HTTP). It fails on:
 * - a script error or console error (any direct use of a removed API throws);
 * - horizontal page scroll, a clipped header, or a control narrower than its label;
 * - text under 2.6:1 contrast, or a large light surface, in Dark and Dusk;
 * - a page not rendered in the saved theme (sign-in, invitation and onboarding included);
 * - a field or button that isn't 4px by 8px with 6px corners, or is taller than its own content,
 *   and any shadow, at rest, focused or under the pointer (spec 21.9a; see controls.ts);
 * - Dusk-only fonts downloaded outside Dusk;
 * - a title not "<Page> · Nearzero" ("Nearzero" on the home), a missing or multi-sentence
 *   description, robots meta, icon or manifest link, a theme-color that isn't the theme's page
 *   token, link-preview tags anywhere but the public pages, or an error page without the mark
 *   (spec 21.9b; see metadataProblems in controls.ts);
 * - a wrong status (hidden settings entries answer 403) or a password or code in any address.
 * Then it drives the behaviors: copy without the clipboard API (also inside a dialog), dialogs,
 * menus kept on screen, in-app navigation, the theme picker, the sidebar choice, the phone sheet,
 * the pixel glow, reduced motion, the sign-in address scrub, the workspace address redirect, the
 * people dialogs on a phone, one theme from sign-in through onboarding to the dashboard, the brand
 * files' addresses and content types, the link preview's absolute address, and theme-color
 * following the picker and in-app navigation.
 *
 * Usage: bun run sweep (from apps/console). SWEEP_ONLY=pages or SWEEP_ONLY=behaviors runs one
 * half. Screenshots go to test-artifacts/ (the Agent home and projects), test-artifacts/m2b/
 * (sign-in, onboarding, profile with two-factor setup, Members & access and the policy dialog)
 * and test-artifacts/m2c/ (a project's Overview, the new-application page, a database page and
 * its Connection card, and the variables editor), and test-artifacts/brand/ (sign-in, the 404
 * and 500 pages, and the header's mark, in Light and Dusk). NEARZERO_TEST_CONTROL_ROOT runs the control
 * plane from another checkout (see test-support/stack.ts).
 */

import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { brandUrlProblems, headTags } from "../test-support/brand.ts";
import { connectFakeHost, type FakeHost, handoffFolder } from "../test-support/fake-runner-link.ts";
import { shadowsMidway } from "../test-support/motion-probe.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";
import { controlProblems, hoverProblems, metadataProblems } from "./controls.ts";
import { operationsRoutes, seedOperations } from "./operations.ts";
import { OWNER_EMAIL, PASSWORD, type People, Seeder } from "./seed.ts";

const ROOT = resolve(import.meta.dir, "..");
const ARTIFACTS = resolve(ROOT, "test-artifacts");
let BASE = "";
const ALL_THEMES = ["light", "dark", "dusk"] as const;
type Theme = (typeof ALL_THEMES)[number];
const ALL_VIEWPORTS = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 },
];
// SWEEP_THEMES=light,dusk and SWEEP_WIDTHS=1440 narrow a run while working on something; a full
// sweep (both unset) is what counts.
const THEMES = ALL_THEMES.filter(
  (theme) => !process.env.SWEEP_THEMES || process.env.SWEEP_THEMES.split(",").includes(theme),
);
const VIEWPORTS = ALL_VIEWPORTS.filter(
  (viewport) =>
    !process.env.SWEEP_WIDTHS ||
    process.env.SWEEP_WIDTHS.split(",").includes(String(viewport.width)),
);
const CONTRAST_FLOOR = 2.6;

/** Who a route is loaded as: a role's session cookie, or nobody. */
type As = "owner" | "ownerSide" | "member" | "lee" | "anon";

interface Route {
  path: string;
  as: As;
  /** Sign-in, sign-up and invitation pages (in the saved theme like every page, spec 21.2). */
  public?: boolean;
  cookies?: Record<string, string>;
  status?: number;
  /** Saved at 375 and 1440px; names in a folder ("m2b/", "m2c/") are saved in Dusk and Light only. */
  shot?: string;
  /** The page keeps a live stream open (logs, deploys), so it never goes network-idle. */
  live?: boolean;
  /**
   * Loads the 500 page: the address is requested as a POST whose form body can't be read, so
   * the page fails on the server (the console's way to show its 500 page without a fault).
   */
  crash?: boolean;
  /** The page must show the owner's mark (the 404 and 500 pages, spec 21.9b). */
  mark?: boolean;
}

const sessions: Record<As, string | null> = {
  owner: null,
  ownerSide: null,
  member: null,
  lee: null,
  anon: null,
};

const W = "/acme/dashboard";

function mainRoutes(people: People): Route[] {
  const ids = people.projects;
  const P = `${W}/projects/${ids.project}`;
  const dev = `${P}/${ids.development}`;
  const prod = `${P}/${ids.production}`;
  const service = (id: string, tab = "") => `${dev}/services/${id}${tab ? `/${tab}` : ""}`;
  return [
    { path: `${W}/agent`, as: "owner", shot: "agent" },
    { path: `${W}/projects`, as: "owner", shot: "projects" },
    { path: `${W}/projects?q=zzz-nothing`, as: "owner" },
    { path: "/side-projects/dashboard/projects", as: "ownerSide" },
    { path: "/side-projects/dashboard/settings/members", as: "ownerSide" },
    { path: `${dev}/overview`, as: "owner", shot: "m2c/project-overview" },
    { path: `${prod}/overview`, as: "owner" },
    { path: `${dev}/services`, as: "owner" },
    { path: `${dev}/variables`, as: "owner" },
    { path: `${prod}/variables`, as: "owner" },
    { path: `${dev}/new-application`, as: "owner", shot: "m2c/new-application" },
    { path: `${W}/projects/${ids.emptyProject}/${ids.emptyEnvironment}/overview`, as: "owner" },
    { path: service(ids.app), as: "owner" },
    { path: service(ids.app, "logs"), as: "owner" },
    { path: service(ids.app, "variables"), as: "owner" },
    { path: service(ids.app, "advanced"), as: "owner" },
    { path: service(ids.app, "backups"), as: "owner", shot: "m5/app-backups" },
    { path: service(ids.app, "settings"), as: "owner" },
    { path: service(ids.database), as: "owner", shot: "m2c/database" },
    { path: service(ids.database, "variables"), as: "owner" },
    { path: service(ids.database, "backups"), as: "owner", shot: "m5/database-backups" },
    { path: service(ids.database, "settings"), as: "owner" },
    { path: service(ids.redis, "backups"), as: "owner", shot: "m5/redis-backups" },
    { path: service(ids.compose), as: "owner" },
    { path: `${dev}/overview`, as: "member" },
    { path: `${dev}/services`, as: "member" },
    { path: `${dev}/variables`, as: "member" },
    { path: service(ids.database), as: "member" },
    { path: service(ids.app, "variables"), as: "member" },
    { path: service(ids.compose), as: "member" },
    { path: `${W}/deployments/dep_1`, as: "owner", status: 404 },
    { path: `${W}/tasks`, as: "owner" },
    { path: `${W}/analytics`, as: "owner" },

    { path: `${W}/profile`, as: "owner" },
    { path: `${W}/settings`, as: "owner" },
    { path: `${W}/settings/members`, as: "owner", shot: "m2b/members-people" },
    { path: `${W}/settings/members?tab=policies`, as: "owner", shot: "m2b/members-policies" },
    { path: `${W}/settings/agent-policies`, as: "owner" },
    { path: `${W}/settings/api-keys`, as: "owner" },
    { path: `${W}/settings/backups`, as: "owner", shot: "m5/settings-backups" },
    { path: `${W}/settings/channels`, as: "owner" },
    { path: `${W}/no-such-page`, as: "owner", status: 404 },
    { path: "/no-such-page", as: "owner", status: 404, mark: true },
    { path: "/no-such-page", as: "anon", status: 404, mark: true },
    { path: "/sign-in?fail=1", as: "anon", status: 500, crash: true, mark: true },
    { path: "/sign-in?fail=1", as: "owner", status: 500, crash: true, mark: true },
    { path: "/dev/components", as: "owner" },
    { path: `${W}/agent`, as: "member" },
    { path: `${W}/projects`, as: "member" },
    { path: `${W}/profile`, as: "member" },
    { path: `${W}/settings`, as: "member" },
    { path: `${W}/settings/members`, as: "member", status: 403 },
    { path: `${W}/settings/agent-policies`, as: "member", status: 403 },
    { path: `${W}/settings/api-keys`, as: "member", status: 403 },
    { path: `${W}/settings/backups`, as: "member", status: 403 },
    { path: service(ids.database, "backups"), as: "member" },
    { path: `${W}/settings/router-files`, as: "member", status: 403 },
    {
      path: `${W}/agent`,
      as: "lee",
      cookies: { nz_invitation_seen: people.leeInvitationId },
    },
    { path: `/invitation?id=${people.leeInvitationId}`, as: "lee", public: true },
    { path: "/sign-in", as: "anon", public: true, shot: "m2b/sign-in" },
    { path: "/sign-in?next=%2Facme%2Fdashboard%2Fsettings", as: "anon", public: true },
    { path: "/invitation", as: "anon", public: true },
    // Registration, open from kim's invitation link (the cookie the invitation page sets).
    {
      path: "/sign-up",
      as: "anon",
      public: true,
      cookies: { nz_invitation: encodeURIComponent(JSON.stringify({ t: people.tokens.kim })) },
    },
    { path: "/invitation?token=no-such-invitation-token", as: "anon", public: true },
    { path: `/invitation?token=${people.tokens.cancelled}`, as: "anon", public: true },
    { path: `/invitation?token=${people.tokens.kim}`, as: "anon", public: true },
    { path: `/invitation?token=${people.tokens.lee}`, as: "anon", public: true },
    { path: `/invitation?token=${people.tokens.lee}`, as: "owner", public: true },
  ];
}

/** Runs before any page script: removes what plain HTTP hides (spec 21.9). */
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;

const failures: string[] = [];
const notes: string[] = [];
let loads = 0;
let swept = 0;
let lowestContrast = { ratio: Number.POSITIVE_INFINITY, where: "" };
/** Clickable things the control check of spec 21.9a leaves out (tabs, menu items, rows…). */
const unchecked = new Set<string>();
/** Shadowed elements found (page, theme, width and element), and style rules that draw one. */
const shadowed = new Set<string>();
const shadowRules = new Set<string>();

function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

function cookiesFor(route: Pick<Route, "as" | "cookies">): Record<string, string> {
  const session = sessions[route.as];
  return { ...(session ? { nz_session: session } : {}), ...route.cookies };
}

/** Everything checked inside the page after it loads. Returns problems and the lowest ratio. */
function inspectPage(args: { contrast: boolean; floor: number }) {
  const problems: string[] = [];
  const describe = (el: Element) => {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
    const cls =
      typeof el.className === "string"
        ? el.className.split(" ").filter(Boolean).slice(0, 2).join(".")
        : "";
    return `<${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}> "${text}"`;
  };
  const visible = (el: Element) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    el.getBoundingClientRect().width > 0 &&
    el.getBoundingClientRect().height > 0;

  const scroller = document.scrollingElement ?? document.documentElement;
  if (scroller.scrollWidth > scroller.clientWidth + 1) {
    problems.push(
      `horizontal page scroll (${scroller.scrollWidth}px wide in ${scroller.clientWidth}px)`,
    );
  }

  const header = document.querySelector(".nz-header");
  if (header && visible(header)) {
    const box = header.getBoundingClientRect();
    if (Math.round(box.height) !== 42) problems.push(`header is ${box.height}px tall, not 42px`);
    if (header.scrollWidth > header.clientWidth + 1) problems.push("header content overflows");
    for (const el of header.querySelectorAll("a, button, .nz-crumb-name, .nz-badge")) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.right > window.innerWidth + 0.5 || rect.left < -0.5) {
        problems.push(`header item off screen: ${describe(el)}`);
      }
    }
  }

  for (const el of document.querySelectorAll(".nz-btn, .nz-tab, .nz-nav-item, .nz-starter")) {
    if (!visible(el) || el.closest(".nz-nav[data-state='closed']")) continue;
    if (el.scrollWidth > el.clientWidth + 1)
      problems.push(`control narrower than its label: ${describe(el)}`);
  }

  type Rgba = [number, number, number, number];
  const parse = (value: string): Rgba | null => {
    let match = value.match(/^rgba?\(([^)]+)\)$/);
    if (match?.[1]) {
      const parts = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 1];
    }
    match = value.match(/^color\(srgb\s+([^)]+)\)$/);
    if (match?.[1]) {
      const [rgb = "", alpha] = match[1].split("/");
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
  const over = (top: Rgba, bottom: Rgba): Rgba => {
    const a = top[3];
    return [
      top[0] * a + bottom[0] * (1 - a),
      top[1] * a + bottom[1] * (1 - a),
      top[2] * a + bottom[2] * (1 - a),
      1,
    ];
  };
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
  const pageColor = parse(getComputedStyle(document.documentElement).backgroundColor) ?? [
    255, 255, 255, 1,
  ];
  const backgroundOf = (el: Element): Rgba => {
    const chain: Element[] = [];
    for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
    let color: Rgba = pageColor[3] >= 1 ? pageColor : over(pageColor, [255, 255, 255, 1]);
    for (const node of chain.reverse()) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg[3] > 0) color = over(bg, color);
    }
    return color;
  };

  let lowest = { ratio: Number.POSITIVE_INFINITY, what: "" };
  if (args.contrast) {
    const skip =
      ".nz-sky, .nz-visually-hidden, [aria-hidden='true'], :disabled, [aria-disabled='true'], .nz-btn--danger:disabled";
    for (const el of document.body.querySelectorAll("*")) {
      const hasText = Array.from(el.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? "").trim().length > 0,
      );
      if (!hasText || !visible(el) || el.closest(skip)) continue;
      // Text clipped to a pixel is for screen readers only (rail labels, hidden headings).
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) continue;
      const style = getComputedStyle(el);
      const text = parse(style.color);
      if (!text) continue;
      let alpha = text[3];
      for (let node: Element | null = el; node; node = node.parentElement) {
        alpha *= Number(getComputedStyle(node).opacity);
      }
      const background = backgroundOf(el);
      const value = ratio(over([text[0], text[1], text[2], alpha], background), background);
      if (value < lowest.ratio) lowest = { ratio: value, what: describe(el) };
      if (value < args.floor) problems.push(`contrast ${value.toFixed(2)}:1 for ${describe(el)}`);
    }
    // No large light surface in Dark and Dusk (spec 21.2).
    const area = window.innerWidth * window.innerHeight;
    for (const el of document.body.querySelectorAll("*")) {
      const bg = parse(getComputedStyle(el).backgroundColor);
      if (!bg || bg[3] < 0.5 || !visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width * rect.height > area * 0.15 && luminance(over(bg, pageColor)) > 0.35) {
        problems.push(`large light surface: ${describe(el)}`);
      }
    }
  }
  return {
    problems,
    lowest,
    theme: document.documentElement.getAttribute("data-theme"),
    tone: document.documentElement.getAttribute("data-tone"),
  };
}

async function newContext(
  browser: Browser,
  theme: Theme | null,
  viewport: { width: number; height: number },
  extra: Record<string, string> = {},
) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(INSECURE_CONTEXT);
  const cookies = { ...(theme ? { nz_theme: theme } : {}), ...extra };
  if (Object.keys(cookies).length > 0) {
    await context.addCookies(
      Object.entries(cookies).map(([name, value]) => ({ name, value, url: BASE })),
    );
  }
  return context;
}

/** A form body the server can't read, which makes a page fail (see Route.crash). */
const BROKEN_FORM = {
  // Same-site, as a browser says for the console's own forms (Astro refuses cross-site ones).
  headers: {
    "content-type": "multipart/form-data; boundary=nz-sweep",
    "sec-fetch-site": "same-origin",
  },
  body: "not a form",
};

/** The HTML exactly as the server sent it, to check the theme is in the first byte. */
async function serverHtml(path: string, cookie: string, crash = false): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        ...(crash ? { method: "POST", body: BROKEN_FORM.body } : {}),
        headers: { cookie, ...(crash ? BROKEN_FORM.headers : {}) },
        signal: AbortSignal.timeout(15_000),
      });
      return await response.text();
    } catch {
      // A dev server busy compiling can stall one request; try once more.
    }
  }
  return "";
}

/** Secrets never ride in an address (spec 21.9, 23.4). */
const SECRET_PARAMS = ["password", "currentPassword", "newPassword", "code", "key", "apiKey"];

function watchErrors(page: Page, where: () => string, expectStatus = false): void {
  page.on("pageerror", (error) => fail(where(), `script error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // The browser logs the status of a page that is meant to be missing, refused or failing.
    if (expectStatus && /status of (40[34]|500)/.test(message.text())) return;
    fail(where(), `console error: ${message.text()}`);
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/sign-in" && url.searchParams.has("password")) return; // the scrub check
    for (const name of SECRET_PARAMS) {
      if (url.searchParams.has(name)) fail(where(), `"${name}" in an address: ${url.pathname}`);
    }
  });
}

async function sweepCombination(
  browser: Browser,
  theme: Theme,
  viewport: { width: number; height: number },
  routes: Route[],
) {
  const fontRequests: string[] = [];
  for (const route of routes) {
    try {
      await sweepRoute(browser, theme, viewport, route, fontRequests);
    } catch (error) {
      fail(
        `${route.path} as ${route.as} [${theme} ${viewport.width}px]`,
        error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
      );
    }
  }
  if (theme !== "dusk" && fontRequests.length > 0) {
    fail(`[${theme} ${viewport.width}px]`, `Dusk-only fonts were downloaded: ${fontRequests[0]}`);
  }
  if (
    theme === "dusk" &&
    viewport.width === 1440 &&
    fontRequests.length === 0 &&
    routes.length > 5
  ) {
    notes.push("Dusk at 1440px did not download Geist Mono or Instrument Serif (expected it to).");
  }
}

async function sweepRoute(
  browser: Browser,
  theme: Theme,
  viewport: { width: number; height: number },
  route: Route,
  fontRequests: string[],
): Promise<void> {
  const extra = cookiesFor(route);
  const context = await newContext(browser, theme, viewport, extra);
  const page = await context.newPage();
  const where = `${route.path} as ${route.as} [${theme} ${viewport.width}px]`;
  watchErrors(page, () => where, route.status !== undefined);
  page.on("request", (request) => {
    // Font files only: the stylesheets that declare them are fine to load everywhere.
    const url = request.url();
    if (/(geist-mono|instrument-serif)[^/]*\.(woff2?|ttf|otf)(\?|$)/i.test(url)) {
      fontRequests.push(`${route.path}: ${url}`);
    }
  });
  if (route.crash) await crashOnLoad(page, route.path);
  const response = await page.goto(`${BASE}${route.path}`, {
    waitUntil: route.live ? "load" : "networkidle",
  });
  if (route.live) await page.waitForTimeout(600);
  loads++;
  const status = response?.status() ?? 0;
  if (status !== (route.status ?? 200)) fail(where, `HTTP ${status}`);
  const cookie = Object.entries({ nz_theme: theme, ...extra })
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const html = await serverHtml(route.path, cookie, route.crash);
  const expected = theme;
  if (html === "") {
    // Not the theme's fault: say so, so a slow dev server isn't read as a flash (W3's report).
    fail(where, "the server's own HTML didn't arrive within two tries of 15 seconds");
  } else if (!new RegExp(`<html[^>]*data-theme="${expected}"`).test(html)) {
    fail(where, `the server didn't render data-theme="${expected}" (the first paint would flash)`);
  }
  await page.waitForTimeout(220);
  const args = { contrast: theme !== "light", floor: CONTRAST_FLOOR };
  // The dev server can reload a page once while it optimizes dependencies; check it again.
  const result = await page.evaluate(inspectPage, args).catch(async (error: Error) => {
    if (!error.message.includes("Execution context was destroyed")) throw error;
    await page.waitForLoadState("networkidle");
    return page.evaluate(inspectPage, args);
  });
  if (result.theme !== expected) fail(where, `rendered in ${result.theme}, expected ${expected}`);
  for (const problem of result.problems) fail(where, problem);
  // Spec 21.9b: titles, description, robots, icon and manifest links, theme-color, link
  // previews on public pages only, and the mark on the error pages.
  const meta = await page.evaluate(metadataProblems, {
    home: isHome(route.path),
    preview: route.public === true,
    mark: route.mark === true,
  });
  for (const problem of meta) fail(where, problem);
  // Spec 21.9a: every field and button is 4px by 8px with 6px corners and no taller than its
  // own content, and nothing has a shadow, at rest or focused; the page's dialogs are opened one
  // at a time and checked too. The pointer goes over each button at desktop width.
  const controls = await page.evaluate(controlProblems, { dialogs: true });
  for (const problem of controls.problems) fail(where, problem);
  for (const shadow of controls.shadows) {
    shadowed.add(`${where} ${shadow}`);
    fail(where, `shadow: ${shadow}`);
  }
  for (const rule of controls.shadowRules) shadowRules.add(rule);
  for (const name of controls.unchecked) unchecked.add(name);
  if (viewport.width === 1440) {
    for (const problem of await hoverProblems(page)) {
      shadowed.add(`${where} ${problem}`);
      fail(where, `shadow: ${problem}`);
    }
  }
  if (result.lowest.ratio < lowestContrast.ratio) {
    lowestContrast = { ratio: result.lowest.ratio, where: `${where} ${result.lowest.what}` };
  }
  const wantsShot =
    route.shot &&
    (viewport.width === 1440 || viewport.width === 375) &&
    !(route.shot.includes("/") && theme === "dark");
  if (wantsShot) {
    await page.screenshot({
      path: resolve(ARTIFACTS, `${route.shot}-${theme}-${viewport.width}.png`),
    });
  }
  await context.close();
}

/** The console's home: the Agent's page, titled "Nearzero" alone (spec 21.9b). */
function isHome(path: string): boolean {
  return /^\/[^/]+\/dashboard\/agent(\?|$)/.test(path);
}

/** Makes the page's first load of `path` the broken POST of Route.crash. */
async function crashOnLoad(page: Page, path: string): Promise<void> {
  const target = `${BASE}${path}`;
  let done = false;
  await page.route(
    (url) => !done && url.toString() === target,
    async (request) => {
      done = true;
      await request.continue({
        method: "POST",
        postData: BROKEN_FORM.body,
        headers: { ...request.request().headers(), ...BROKEN_FORM.headers },
      });
    },
  );
}

async function sweepAll(browser: Browser, routes: Route[]): Promise<void> {
  swept += routes.length;
  const queue = THEMES.flatMap((theme) => VIEWPORTS.map((viewport) => ({ theme, viewport })));
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        await sweepCombination(browser, job.theme, job.viewport, routes);
      }
    }),
  );
}

async function warm(browser: Browser, routes: Route[]): Promise<void> {
  // Warm the dev server (server compiles and the browser's first module requests) so they
  // don't count against page loads.
  for (const route of routes) {
    const context = await newContext(
      browser,
      "dusk",
      { width: 1440, height: 900 },
      cookiesFor(route),
    );
    const page = await context.newPage();
    await page
      .goto(`${BASE}${route.path}`, { waitUntil: route.live ? "load" : "networkidle" })
      .catch(() => null);
    await context.close();
  }
}

async function check(name: string, run: () => Promise<void>): Promise<void> {
  // SWEEP_CHECKS=backup runs only the behaviors whose name contains it.
  const only = process.env.SWEEP_CHECKS;
  if (only && !name.includes(only)) return;
  try {
    await run();
    notes.push(`ok   ${name}`);
  } catch (error) {
    fail(name, error instanceof Error ? error.message : String(error));
  }
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function behaviors(browser: Browser, people: People): Promise<void> {
  const ids = people.projects;
  const dev = `${W}/projects/${ids.project}/${ids.development}`;
  const prod = `${W}/projects/${ids.project}/${ids.production}`;
  const open = async (
    theme: Theme,
    width: number,
    path: string,
    extra?: Record<string, string>,
    as: As = "owner",
    /** The check visits pages meant to answer 404 or 500. */
    expectStatus = false,
  ) => {
    const context = await newContext(
      browser,
      theme,
      { width, height: width < 700 ? 812 : 900 },
      { ...cookiesFor({ as }), ...extra },
    );
    const page = await context.newPage();
    watchErrors(page, () => `behavior ${path} [${theme} ${width}px]`, expectStatus);
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
    return { context, page };
  };
  const toastText = async (page: Page) =>
    ((await page.locator(".nz-toast").last().textContent()) ?? "").trim();

  await check("copy works without the clipboard API, on the page and inside a dialog", async () => {
    const { context, page } = await open("dusk", 1440, "/dev/components");
    expect(
      (await page.evaluate(() => "clipboard" in navigator)) === false,
      "clipboard API still present",
    );
    await page.locator("section[aria-labelledby='guide-urls'] [data-copy]").first().click();
    expect(
      (await toastText(page)).includes("Copied to clipboard"),
      `toast said "${await toastText(page)}"`,
    );
    await page.getByRole("button", { name: "Open dialog" }).click();
    await page.locator("#guide-dialog [data-copy]").first().click();
    const inside = await page.evaluate(() =>
      Boolean(document.querySelector("#guide-dialog #nz-toasts .nz-toast")),
    );
    expect(inside, "the toast inside an open dialog was not shown above it");
    expect(
      (await toastText(page)).includes("Copied to clipboard"),
      "copy inside the dialog failed",
    );
    await context.close();
  });

  await check(
    "an image app's Settings offer Autodeploy and the deploy webhook (30b R2-03)",
    async () => {
      const { context, page } = await open("dusk", 1440, `${dev}/services/${ids.app}/settings`);
      await page.locator("#nz-deploy-settings > summary").click();
      const box = page.locator("#nz-deploy-settings");
      // The fold opens with its motion (spec 21.7): wait for the switch rather than look at once.
      await box
        .locator("#nz-autodeploy")
        .waitFor({ state: "visible", timeout: 5_000 })
        .catch(() => {});
      expect(await box.locator("#nz-autodeploy").isVisible(), "no Autodeploy switch");
      const hook = box.locator("[data-webhook]");
      expect(await hook.isVisible(), "no Deploy webhook");
      expect(
        ((await hook.textContent()) ?? "").includes("webhook at your registry"),
        "the webhook hint isn't the registry's",
      );
      await hook.locator("[data-webhook-replace]").click();
      await page.locator(".nz-toast", { hasText: /Webhook URL (created|replaced)/ }).waitFor();
      await page.waitForLoadState("networkidle");
      if (
        !(await page
          .locator("#nz-deploy-settings")
          .evaluate((el) => (el as HTMLDetailsElement).open))
      ) {
        await page.locator("#nz-deploy-settings > summary").click();
      }
      // The URL stays masked until Show URL; it only needs to be there.
      const url = page.locator("#nz-deploy-settings [data-webhook-url]");
      await url.waitFor({ state: "attached" });
      expect(
        ((await url.getAttribute("data-url")) ?? "").includes("/api/v1/webhooks/deploy/nzw1."),
        "the webhook URL wasn't shown after Create URL",
      );
      await context.close();
    },
  );

  await check(
    "dialogs: Escape, backdrop, re-render under the pointer, focus trap and return",
    async () => {
      const { context, page } = await open("light", 1440, "/dev/components");
      const opener = page.getByRole("button", { name: "Open dialog" });
      const dialog = page.locator("#guide-dialog");
      await opener.click();
      expect(await dialog.evaluate((d: HTMLDialogElement) => d.open), "did not open");
      await page.keyboard.press("Escape");
      expect(!(await dialog.evaluate((d: HTMLDialogElement) => d.open)), "Escape did not close it");
      expect(
        await opener.evaluate((el) => el === document.activeElement),
        "focus did not return to the opener",
      );
      await opener.click();
      await page.locator("[data-guide-rerender-button]").click();
      expect(
        await dialog.evaluate((d: HTMLDialogElement) => d.open),
        "closed when its content re-rendered under the pointer",
      );
      for (let i = 0; i < 12; i++) await page.keyboard.press("Tab");
      expect(
        await dialog.evaluate((d) => d.contains(document.activeElement)),
        "focus left the dialog",
      );
      await page.mouse.click(8, 8);
      expect(
        !(await dialog.evaluate((d: HTMLDialogElement) => d.open)),
        "a backdrop click did not close it",
      );
      await context.close();
    },
  );

  await check("menus open inside the screen on a phone", async () => {
    const { context, page } = await open("dusk", 375, `${prod}/overview`);
    for (const target of [
      "nz-workspace-menu",
      "nz-bell-panel",
      "nz-environment-menu",
      "nz-add-new",
    ]) {
      await page.locator(`[popovertarget="${target}"]`).first().click();
      const box = await page.locator(`#${target}`).boundingBox();
      expect(box, `${target} did not open`);
      expect(
        box.x >= 0 && box.x + box.width <= 375,
        `${target} spills off screen (${box.x}..${box.x + box.width})`,
      );
      await page.keyboard.press("Escape");
    }
    await context.close();
  });

  await check("in-app navigation swaps pages without a reload and keeps the theme", async () => {
    const { context, page } = await open("dark", 1440, `${W}/agent`);
    await page.evaluate(() => {
      (window as unknown as { __kept: boolean }).__kept = true;
    });
    await page.locator(".nz-nav a[href$='/projects']").click();
    await page.waitForURL(/\/projects$/);
    await page.locator(".nz-project-grid").waitFor();
    expect(
      await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true),
      "the page fully reloaded",
    );
    expect(
      (await page.getAttribute("html", "data-theme")) === "dark",
      "theme changed on navigation",
    );
    expect(await page.locator(".nz-progress").count(), "no progress bar");
    expect(
      !(await page.evaluate(() => document.documentElement.hasAttribute("data-navigating"))),
      "page left locked",
    );
    await context.close();
  });

  await check(
    "the theme picker applies at once, survives navigation and reload, and reaches the public pages",
    async () => {
      const { context, page } = await open("dusk", 1440, `${W}/agent`);
      await page.locator(".nz-nav .nz-user-trigger").click();
      await page.locator("#nz-user-menu input[value='light']").check();
      expect((await page.getAttribute("html", "data-theme")) === "light", "not applied at once");
      await page.keyboard.press("Escape");
      await page.locator(".nz-nav a[href$='/projects']").click();
      await page.waitForURL(/\/projects$/);
      expect(
        (await page.getAttribute("html", "data-theme")) === "light",
        "lost on in-app navigation",
      );
      await page.reload({ waitUntil: "networkidle" });
      expect((await page.getAttribute("html", "data-theme")) === "light", "lost on reload");
      await page
        .locator("#nz-user-menu input[value='dusk']")
        .evaluate((input: HTMLInputElement) => input.click());
      // Signed in, sign-in moves on to the Agent; the invitation page is public and stays put.
      await page.goto(`${BASE}/invitation`);
      expect(
        (await page.getAttribute("html", "data-theme")) === "dusk",
        "the invitation page was not in the chosen Dusk",
      );
      const fresh = await newContext(
        browser,
        null,
        { width: 1440, height: 900 },
        cookiesFor({ as: "owner" }),
      );
      const other = await fresh.newPage();
      await other.goto(`${BASE}${W}/agent`);
      expect(
        (await other.getAttribute("html", "data-theme")) === "light",
        "a new browser did not start in Light",
      );
      await fresh.close();
      await context.close();
    },
  );

  await check(
    "theme-color follows the theme picker and in-app navigation (spec 21.9b)",
    async () => {
      const { context, page } = await open("dark", 1440, `${W}/agent`);
      const color = () =>
        page.evaluate(() => {
          const tags = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]');
          return `${tags.length}:${tags[0]?.content ?? ""}`;
        });
      expect((await color()) === "1:#050506", `Dark started with ${await color()}`);
      await page.locator(".nz-nav .nz-user-trigger").click();
      await page.locator("#nz-user-menu input[value='dusk']").check();
      expect((await color()) === "1:#050507", `picking Dusk left ${await color()}`);
      await page.keyboard.press("Escape");
      await page.locator(".nz-nav a[href$='/projects']").click();
      await page.waitForURL(/\/projects$/);
      await page.locator(".nz-project-grid").waitFor();
      expect((await color()) === "1:#050507", `after in-app navigation: ${await color()}`);
      const title = await page.title();
      expect(title === "Projects · Nearzero", `the swapped-in page's title was "${title}"`);
      await page.locator(".nz-nav .nz-user-trigger").click();
      await page.locator("#nz-user-menu input[value='light']").check();
      expect((await color()) === "1:#f3f4f6", `picking Light left ${await color()}`);
      await page.keyboard.press("Escape");
      await page.locator(".nz-nav a[href$='/agent']").click();
      await page.waitForURL(/\/agent$/);
      expect((await color()) === "1:#f3f4f6", `back on the Agent: ${await color()}`);
      expect((await page.title()) === "Nearzero", `the home's title was "${await page.title()}"`);
      await context.close();
    },
  );

  await check(
    "brand files answer 200 with their content types, and the link preview is absolute (spec 21.9b)",
    async () => {
      const problems = await brandUrlProblems(BASE);
      expect(problems.length === 0, problems.join("; "));
      // As a browser that reached the console at its IP and port: the preview image is there too.
      // Registration opens from kim's invitation link (its cookie).
      const invitation = encodeURIComponent(JSON.stringify({ t: people.tokens.kim }));
      for (const path of ["/sign-in", "/sign-up", "/invitation"]) {
        const response = await fetch(`${BASE}${path}`, {
          headers: {
            host: "203.0.113.10:4321",
            ...(path === "/sign-up" ? { cookie: `nz_invitation=${invitation}` } : {}),
          },
          redirect: "manual",
        });
        expect(response.status === 200, `${path} answered ${response.status}`);
        const html = await response.text();
        const image = headTags(html).metas.get("og:image");
        expect(
          image === "http://203.0.113.10:4321/og.png",
          `${path} gave og:image ${image} for http://203.0.113.10:4321`,
        );
      }
    },
  );

  await check("brand screenshots: sign-in, the 404 and 500 pages, the header", async () => {
    for (const theme of ["light", "dusk"] as const) {
      const signedOut = await open(theme, 1440, "/sign-in", {}, "anon", true);
      await signedOut.page.screenshot({ path: resolve(ARTIFACTS, `brand/sign-in-${theme}.png`) });
      await signedOut.page.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
      await signedOut.page.screenshot({
        path: resolve(ARTIFACTS, `brand/404-signed-out-${theme}.png`),
      });
      await signedOut.context.close();
      const signedIn = await open(theme, 1440, `${W}/projects`, {}, "owner", true);
      await signedIn.page.locator(".nz-header").screenshot({
        path: resolve(ARTIFACTS, `brand/header-${theme}.png`),
      });
      await signedIn.page.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
      const back = signedIn.page.getByRole("link", { name: "Go to your projects" });
      expect(
        (await back.getAttribute("href")) === `${W}/projects`,
        "the 404 page's way back isn't the projects",
      );
      await signedIn.page.screenshot({ path: resolve(ARTIFACTS, `brand/404-${theme}.png`) });
      await crashOnLoad(signedIn.page, "/sign-in?fail=1");
      await signedIn.page.goto(`${BASE}/sign-in?fail=1`, { waitUntil: "networkidle" });
      expect(
        (await signedIn.page.locator("h1").textContent())?.trim() === "Something went wrong",
        "the 500 page didn't show",
      );
      await signedIn.page.screenshot({ path: resolve(ARTIFACTS, `brand/500-${theme}.png`) });
      await signedIn.context.close();
    }
  });

  await check("the primary sidebar keeps the person's choice on first paint", async () => {
    const { context, page } = await open("dark", 1440, `${W}/agent`);
    expect(
      (await page.getAttribute("[data-primary-nav]", "data-state")) === "open",
      "not open by default on the Agent page",
    );
    await page.locator("[data-nav-toggle]").click();
    expect(
      (await page.getAttribute("[data-primary-nav]", "data-state")) === "closed",
      "did not close",
    );
    const html = await (await page.request.get(`${BASE}${dev}/overview`)).text();
    expect(
      /data-primary-nav[^>]*data-state="closed"/.test(html),
      "the server did not render the saved choice",
    );
    await page.locator("[data-nav-toggle]").click();
    const reopened = await (await page.request.get(`${BASE}${dev}/overview`)).text();
    expect(
      /data-primary-nav[^>]*data-state="open"/.test(reopened),
      "an opened sidebar did not stay open on project pages",
    );
    await context.close();
  });

  await check("the phone navigation sheet closes on in-app navigation", async () => {
    const { context, page } = await open("dusk", 375, `${W}/agent`);
    await page.getByRole("button", { name: "Open menu" }).click();
    expect(
      await page.locator("#nz-nav-sheet").evaluate((d: HTMLDialogElement) => d.open),
      "sheet did not open",
    );
    await page.locator("#nz-nav-sheet a[href$='/projects']").click();
    await page.waitForURL(/\/projects$/);
    expect(
      !(await page.locator("#nz-nav-sheet").evaluate((d: HTMLDialogElement) => d.open)),
      "sheet stayed open",
    );
    await context.close();
  });

  // Spec 21.7: nothing shows a shadow (or logs an error) while any part of the interface moves.
  for (const theme of THEMES) {
    await check(`no console error and no shadow while the interface moves [${theme}]`, async () => {
      const found: string[] = [];
      const note = (what: string, list: string[]) => {
        for (const item of list) found.push(`${what}: ${item}`);
      };
      const { context, page } = await open(theme, 1440, `${W}/agent`);
      const toggle = () => page.locator("[data-nav-toggle]").click();
      note("sidebar collapsing", await shadowsMidway(page, toggle));
      note("sidebar expanding", await shadowsMidway(page, toggle));
      note(
        "menu opening",
        await shadowsMidway(page, async () => {
          await page.locator('[popovertarget="nz-workspace-menu"]').click();
          await page.waitForFunction(
            () => !document.querySelector("#nz-workspace-menu")?.hasAttribute("data-motion"),
          );
        }),
      );
      note("menu closing", await shadowsMidway(page, () => page.keyboard.press("Escape")));
      await page.goto(`${BASE}/dev/components`, { waitUntil: "networkidle" });
      note(
        "dialog opening",
        await shadowsMidway(page, () => page.getByRole("button", { name: "Open dialog" }).click()),
      );
      note("dialog closing", await shadowsMidway(page, () => page.keyboard.press("Escape")));
      note(
        "toast",
        await shadowsMidway(page, () => page.locator("[data-guide-toast='info']").click()),
      );
      note(
        "tabs",
        await shadowsMidway(page, () =>
          page.locator("section[aria-labelledby='guide-tabs'] [role='tab']").nth(1).click(),
        ),
      );
      await context.close();
      const phone = await open(theme, 375, `${W}/agent`);
      note(
        "sheet opening",
        await shadowsMidway(phone.page, () =>
          phone.page.getByRole("button", { name: "Open menu" }).click(),
        ),
      );
      note(
        "sheet closing",
        await shadowsMidway(phone.page, () => phone.page.keyboard.press("Escape")),
      );
      note(
        "sessions slide-over",
        await shadowsMidway(phone.page, () =>
          phone.page.locator(".nz-chat-bar button[title='Chat history']").click(),
        ),
      );
      await phone.context.close();
      expect(found.length === 0, `shadows mid-animation: ${found.slice(0, 6).join("; ")}`);
    });
  }

  await check(
    "the Dusk pixel glow lights dots near the pointer, also inside dialogs, and idles",
    async () => {
      const { context, page } = await open("dusk", 1440, "/dev/components");
      const lit = (selector: string) =>
        page.evaluate((within) => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            within ? `${within} canvas` : "canvas",
          );
          if (!canvas) return 0;
          const data =
            canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
          let count = 0;
          for (let i = 3; i < data.length; i += 4) if ((data[i] ?? 0) > 0) count++;
          return count;
        }, selector);
      const button = page
        .locator("section[aria-labelledby='guide-buttons'] .nz-btn--primary")
        .first();
      await button.hover();
      await page.waitForTimeout(60);
      expect((await lit("")) > 0, "no dots lit while hovering a primary button");
      expect(
        await button.evaluate((el) => el.querySelectorAll("canvas, [data-glow]").length === 0),
        "the glow changed the button's markup",
      );
      await page.mouse.move(5, 890);
      await page.waitForTimeout(60);
      expect((await lit("")) === 0, "the canvas kept drawing with nothing hovered");
      await page.getByRole("button", { name: "Open dialog" }).click();
      await page.locator("#guide-dialog .nz-btn--primary").hover();
      await page.waitForTimeout(60);
      expect((await lit("#guide-dialog")) > 0, "no glow inside the open dialog");
      await context.close();

      const reduced = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce",
      });
      await reduced.addCookies([
        { name: "nz_theme", value: "dusk", url: BASE },
        { name: "nz_session", value: sessions.owner ?? "", url: BASE },
      ]);
      const quiet = await reduced.newPage();
      await quiet.goto(`${BASE}/dev/components`, { waitUntil: "networkidle" });
      await quiet
        .locator("section[aria-labelledby='guide-buttons'] .nz-btn--primary")
        .first()
        .hover();
      await quiet.waitForTimeout(60);
      const drawn = await quiet.evaluate(() => {
        const canvas = document.querySelector("canvas");
        if (!canvas) return 0;
        const data =
          canvas.getContext("2d")?.getImageData(0, 0, canvas.width, canvas.height).data ?? [];
        return data.some((value, index) => index % 4 === 3 && value > 0) ? 1 : 0;
      });
      expect(drawn === 0, "the glow ran under reduced motion");
      const animation = await quiet.evaluate(() => {
        const star = document.querySelector(".nz-star");
        const content = document.querySelector("[data-page-content]");
        return [
          star && getComputedStyle(star).animationName,
          content && getComputedStyle(content).animationName,
        ];
      });
      expect(
        animation.every((name) => name === "none"),
        `animations still on under reduced motion: ${animation}`,
      );
      await reduced.close();
    },
  );

  // Pictures of the 21.9a controls in Light and Dusk at desktop width: sign-in, the projects list,
  // a service page, an open dialog, the Agent page and Settings (test-artifacts/px2py1/).
  await check("21.9a screenshots in Light and Dusk", async () => {
    const shots: { name: string; path: string; as: As; dialog?: string }[] = [
      { name: "sign-in", path: "/sign-in", as: "anon" },
      { name: "projects", path: `${W}/projects`, as: "owner" },
      { name: "service", path: `${dev}/services/${ids.app}`, as: "owner" },
      {
        name: "dialog-add-project",
        path: `${W}/projects`,
        as: "owner",
        dialog: "nz-create-project",
      },
      { name: "agent", path: `${W}/agent`, as: "owner" },
      { name: "settings", path: `${W}/settings`, as: "owner" },
    ];
    for (const theme of ["light", "dusk"] as const) {
      for (const shot of shots) {
        const { context, page } = await open(theme, 1440, shot.path, {}, shot.as);
        if (shot.dialog) {
          await page.locator(`[data-dialog-open="${shot.dialog}"]`).first().click();
          await page.locator(`#${shot.dialog}`).waitFor({ state: "visible" });
          await page.waitForTimeout(250);
        }
        await page.screenshot({
          path: resolve(ARTIFACTS, `px2py1/${shot.name}-${theme}-1440.png`),
        });
        await context.close();
      }
    }
  });

  // Spec 21.2: a fresh browser keeps one theme from sign-in through onboarding to the dashboard:
  // Light when nothing was picked, Dusk when Dusk was saved. Each run signs in a new member who
  // still has the name step to do.
  for (const saved of [null, "dusk"] as const) {
    await check(
      `one theme from sign-in through onboarding to the dashboard (${saved ?? "nothing saved"})`,
      async () => {
        const wanted = saved ?? "light";
        const email = `journey-${saved ?? "default"}@example.com`;
        const owner = await ApiSession.signIn(BASE, OWNER_EMAIL, PASSWORD);
        await owner.call("POST", "/workspace/members", {
          email,
          role: "member",
          policyIds: [],
          password: PASSWORD,
        });
        const context = await newContext(browser, saved, { width: 1440, height: 900 });
        const page = await context.newPage();
        watchErrors(page, () => `behavior theme journey [${wanted}]`);
        const seen: string[] = [];
        const look = async (step: string) => {
          const theme = await page.getAttribute("html", "data-theme");
          seen.push(`${step}: ${theme}`);
          // The server's own HTML, so the first paint is already right.
          const html = await (await page.request.get(page.url())).text();
          expect(
            new RegExp(`<html[^>]*data-theme="${wanted}"`).test(html),
            `${step} was not rendered in ${wanted} by the server`,
          );
          const controls = await page.evaluate(controlProblems, { dialogs: false });
          for (const problem of [...controls.problems, ...controls.shadows]) {
            fail(`theme journey ${step} [${wanted}]`, problem);
          }
        };
        await page.goto(`${BASE}/sign-in`, { waitUntil: "networkidle" });
        await look("sign-in");
        if (wanted === "dusk") {
          await page.screenshot({ path: resolve(ARTIFACTS, "px2py1/sign-in-dusk-1440.png") });
        }
        await page.fill("#nz-sign-in-email", email);
        await page.fill("#nz-sign-in-password", PASSWORD);
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.waitForURL(/\/onboarding\//);
        await page.waitForLoadState("networkidle");
        await look("onboarding");
        if (wanted === "dusk") {
          await page.screenshot({ path: resolve(ARTIFACTS, "px2py1/onboarding-dusk-1440.png") });
        }
        await page.fill("#nz-welcome-name", "Jo Rivera");
        await page.getByRole("button", { name: "Finish" }).click();
        await page.waitForURL(/\/dashboard\//);
        await page.waitForLoadState("networkidle");
        await look("dashboard");
        expect(
          seen.every((entry) => entry.endsWith(`: ${wanted}`)),
          `the theme changed on the way in: ${seen.join(", ")}`,
        );
        await context.close();
      },
    );
  }

  await check("sign-in removes a password or code from its address on load", async () => {
    const { context, page } = await open(
      "dusk",
      1440,
      "/sign-in?email=a%40b.co&password=hunter22&code=123456",
      {},
      "anon",
    );
    const search = await page.evaluate(() => location.search);
    expect(!/password|code/.test(search), `address still has ${search}`);
    expect(search.includes("email"), "removed more than the secrets");
    await context.close();
  });

  await check("in-browser validation uses the spec's words", async () => {
    const { context, page } = await open("light", 1440, "/sign-in", {}, "anon");
    await page.getByRole("button", { name: "Sign in" }).click();
    const first = (
      (await page.locator("[data-field-error]:not([hidden])").first().textContent()) ?? ""
    ).trim();
    expect(first === "Enter your email address.", `got "${first}"`);
    await page.fill("#nz-sign-in-email", "owner@");
    await page.fill("#nz-sign-in-password", "short");
    await page.getByRole("button", { name: "Sign in" }).click();
    const errors = (await page.locator("[data-field-error]:not([hidden])").allTextContents()).map(
      (text) => text.trim(),
    );
    expect(
      errors.includes("Use a valid email address.") &&
        errors.includes("Password must be at least 8 characters."),
      `got ${JSON.stringify(errors)}`,
    );
    await context.close();
  });

  await check(
    "a workspace address that isn't the active one keeps the page under the active one",
    async () => {
      const { context, page } = await open("dusk", 1440, "/side-projects/dashboard/settings");
      expect(new URL(page.url()).pathname === `${W}/settings`, `ended on ${page.url()}`);
      await context.close();
    },
  );

  await check("the member access dialog marks what a policy already gives", async () => {
    const { context, page } = await open("dusk", 1440, `${W}/settings/members`);
    const row = page.locator("tr", { hasText: "sam@example.com" });
    await row.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Access" }).click();
    const dialog = page.locator("#nz-member-access");
    await dialog.locator("[data-access-body]").waitFor({ state: "visible" });
    const mark =
      (await dialog.locator('[data-from="capability:projects.create"]').textContent()) ?? "";
    expect(mark === "From Developers", `the mark said "${mark}"`);
    expect(
      await dialog.locator('[data-capability][value="dns.manage"]').isChecked(),
      "a direct grant was not ticked",
    );
    await dialog
      .locator(".nz-option-list label", { hasText: "Builds and deploys" })
      .locator("input")
      .uncheck();
    expect(
      await dialog.locator('[data-from="capability:projects.create"]').isHidden(),
      "the mark stayed after detaching the policy",
    );
    await context.close();
  });

  await check("a member with a one-project policy sees that project only", async () => {
    const { context, page } = await open("dusk", 1440, `${W}/projects`, {}, "member");
    const names = (await page.locator(".nz-project-name").allTextContents()).map((name) =>
      name.trim(),
    );
    expect(names.join(",") === "storefront", `the member saw ${JSON.stringify(names)}`);
    await page.goto(`${BASE}${W}/projects/${ids.emptyProject}/${ids.emptyEnvironment}/overview`);
    expect(
      new URL(page.url()).pathname === `${W}/projects`,
      `another project's page did not send the member back: ${page.url()}`,
    );
    await context.close();
  });

  await check(
    "the environment switcher keeps the section, and a service page goes to Overview",
    async () => {
      const { context, page } = await open("light", 1440, `${dev}/variables`);
      await page.locator('[popovertarget="nz-environment-menu"]').click();
      await page.getByRole("menuitemradio", { name: "production" }).click();
      await page.waitForURL(new RegExp(`${ids.production}/variables$`));
      await page.goto(`${BASE}${dev}/services/${ids.database}`);
      await page.locator('[popovertarget="nz-environment-menu"]').click();
      const href = await page
        .locator("#nz-environment-menu a", { hasText: "production" })
        .getAttribute("href");
      expect(href?.endsWith(`${ids.production}/overview`), `the switcher led to ${href}`);
      await context.close();
    },
  );

  for (const theme of ["dusk", "light"] as const) {
    for (const width of [1440, 375]) {
      await check(
        `project dialogs and the variables editor fit and are captured [${theme} ${width}px]`,
        async () => {
          const fits = async (page: Page, selector: string) => {
            const box = await page.locator(selector).boundingBox();
            expect(box, `${selector} did not open`);
            expect(
              box.x >= 0 && box.x + box.width <= width + 0.5,
              `${selector} spills off screen (${box.x}..${box.x + box.width})`,
            );
            const overflow = await page
              .locator(selector)
              .evaluate((el) => el.scrollWidth - el.clientWidth);
            expect(overflow <= 1, `${selector} scrolls sideways by ${overflow}px`);
          };
          const { context, page } = await open(
            theme,
            width,
            `${dev}/services/${ids.app}/variables`,
          );
          const own = page.locator(`#nz-own-variables-${ids.app}`);
          await own.getByRole("button", { name: "Edit" }).click();
          await own.locator("[data-row-name]").first().waitFor();
          await own.getByRole("button", { name: "Add variable" }).click();
          await page.waitForTimeout(200);
          await fits(page, `#nz-own-variables-${ids.app}`);
          await own.scrollIntoViewIfNeeded();
          await page.screenshot({
            path: resolve(ARTIFACTS, `m2c/variables-editor-${theme}-${width}.png`),
          });

          await page.goto(`${BASE}${dev}/services/${ids.database}`, { waitUntil: "networkidle" });
          const card = page.locator("[data-connection]");
          await card.getByRole("button", { name: "Show password" }).first().click();
          await card.locator('[data-conn-reveal][aria-pressed="true"]').first().waitFor();
          await fits(page, "[data-connection]");
          await card.screenshot({
            path: resolve(ARTIFACTS, `m2c/connection-card-${theme}-${width}.png`),
          });

          await page.goto(`${BASE}${dev}/overview`, { waitUntil: "networkidle" });
          await page.getByRole("button", { name: "Add New" }).click();
          await page.getByRole("menuitem", { name: "Database" }).click();
          await page.waitForTimeout(200);
          await fits(page, "#nz-database-create");
          await page.keyboard.press("Escape");
          await page.locator('[popovertarget="nz-environment-menu"]').click();
          await page.getByRole("menuitem", { name: "Add environment" }).click();
          await page.locator("#nz-env-add-name").fill("QA Team");
          const hint = (await page.locator("#nz-env-add [data-env-hint]").textContent()) ?? "";
          expect(hint === "It will be called qa-team.", `the hint said "${hint}"`);
          await fits(page, "#nz-env-add");
          await page.keyboard.press("Escape");
          await page.goto(`${BASE}${dev}/services`, { waitUntil: "networkidle" });
          await page.locator("[data-service-select-all]").check();
          // Development holds the four seeded services and the operations seed's "api".
          const ticked = await page.locator("[data-service-select]:checked").count();
          await page.locator("[data-bulk-delete]").click();
          await page.locator("#nz-teardown [data-teardown-plan]").waitFor({ state: "visible" });
          await page.waitForTimeout(150);
          await fits(page, "#nz-teardown");
          const submitText = ((await page.locator("[data-teardown-submit]").textContent()) ?? "")
            .replace(/\s+/g, " ")
            .trim();
          expect(
            ticked === 5 && submitText.includes(`Delete ${ticked} services`),
            `the bulk delete button said "${submitText}" for ${ticked} ticked services`,
          );
          await context.close();
        },
      );
    }
  }

  for (const theme of ["dusk", "light"] as const) {
    for (const width of [1440, 375]) {
      await check(
        `people dialogs fit the screen and are captured [${theme} ${width}px]`,
        async () => {
          const inside = async (page: Page, selector: string) => {
            const box = await page.locator(selector).boundingBox();
            expect(box, `${selector} did not open`);
            expect(
              box.x >= 0 && box.x + box.width <= width + 0.5,
              `${selector} spills off screen (${box.x}..${box.x + box.width})`,
            );
            const overflow = await page
              .locator(`${selector} .nz-dialog-body`)
              .evaluate((el) => el.scrollWidth - el.clientWidth);
            expect(overflow <= 1, `${selector} scrolls sideways by ${overflow}px`);
          };
          const { context, page } = await open(theme, width, `${W}/profile`);
          await page.getByRole("button", { name: "Enable 2FA", exact: true }).click();
          await page.locator("#nz-2fa-setup-password").fill(PASSWORD);
          await page.locator("#nz-2fa-enable").getByRole("button", { name: "Continue" }).click();
          await page.locator("#nz-2fa-enable [data-2fa-secret]").waitFor({ state: "visible" });
          await page.waitForTimeout(250);
          await inside(page, "#nz-2fa-enable");
          await page.screenshot({
            path: resolve(ARTIFACTS, `m2b/profile-2fa-${theme}-${width}.png`),
          });
          await page.keyboard.press("Escape");

          await page.goto(`${BASE}${W}/settings/members?tab=policies`, {
            waitUntil: "networkidle",
          });
          await page.locator("[data-policy-edit]").first().click();
          await page.waitForTimeout(250);
          await inside(page, "#nz-policy");
          await page.screenshot({
            path: resolve(ARTIFACTS, `m2b/policy-dialog-${theme}-${width}.png`),
          });
          await page.keyboard.press("Escape");

          await page.getByRole("tab", { name: /People/ }).click();
          await page.getByRole("button", { name: "Add user" }).click();
          await page.waitForTimeout(150);
          await inside(page, "#nz-add-user");
          await context.close();
        },
      );
    }
  }

  // Backups (spec 17.1, 8.3): the destination, schedule and restore dialogs fit on a phone and
  // on a desktop, in Dusk and Light, and are captured.
  for (const theme of ["dusk", "light"] as const) {
    for (const width of [1440, 375]) {
      await check(
        `backup dialogs fit the screen and are captured [${theme} ${width}px]`,
        async () => {
          const fits = async (page: Page, selector: string) => {
            const box = await page.locator(selector).boundingBox();
            expect(box, `${selector} did not open`);
            expect(
              box.x >= 0 && box.x + box.width <= width + 0.5,
              `${selector} spills off screen (${box.x}..${box.x + box.width})`,
            );
            const overflow = await page
              .locator(`${selector} .nz-dialog-body`)
              .evaluate((el) => el.scrollWidth - el.clientWidth);
            expect(overflow <= 1, `${selector} scrolls sideways by ${overflow}px`);
          };
          const { context, page } = await open(theme, width, `${W}/settings/backups`);
          await page.getByRole("button", { name: "Add destination" }).click();
          await page.locator("#nz-destination").waitFor({ state: "visible" });
          await page.locator("#nz-destination-provider").selectOption("cloudflare-r2");
          expect(
            (await page.locator("#nz-destination-endpoint").inputValue()).includes(
              "r2.cloudflarestorage.com",
            ),
            "picking Cloudflare R2 didn't fill its sample endpoint",
          );
          await page.waitForTimeout(150);
          await fits(page, "#nz-destination");
          await page.screenshot({
            path: resolve(ARTIFACTS, `m5/destination-dialog-${theme}-${width}.png`),
          });
          await page.keyboard.press("Escape");
          await page.locator("[data-destination-open=edit]").first().click();
          expect(
            (await page.locator("#nz-destination-secret").getAttribute("placeholder")) ===
              "Saved, leave blank to keep",
            "editing a destination didn't say blank keys are kept",
          );
          await page.keyboard.press("Escape");

          await page.goto(`${BASE}${dev}/services/${ids.database}/backups`, {
            waitUntil: "networkidle",
          });
          await page.getByRole("button", { name: "Add backup" }).click();
          await page.locator("#nz-schedule").waitFor({ state: "visible" });
          await page.locator("#nz-schedule-preset").selectOption("custom");
          expect(
            await page.locator("#nz-schedule-cron").isVisible(),
            "the cron field didn't show for Custom",
          );
          await page.waitForTimeout(150);
          await fits(page, "#nz-schedule");
          await page.screenshot({
            path: resolve(ARTIFACTS, `m5/schedule-dialog-${theme}-${width}.png`),
          });
          await page.keyboard.press("Escape");
          // The header's Restore…, not a schedule row's Restore (30c R3-46).
          await page.getByRole("button", { name: "Restore…", exact: true }).click();
          await page.locator("#nz-restore").waitFor({ state: "visible" });
          await page.waitForTimeout(150);
          await fits(page, "#nz-restore");
          await page.screenshot({
            path: resolve(ARTIFACTS, `m5/restore-dialog-${theme}-${width}.png`),
          });
          await context.close();
        },
      );
    }
  }
}

async function main(): Promise<void> {
  await mkdir(resolve(ARTIFACTS, "m2b"), { recursive: true });
  await mkdir(resolve(ARTIFACTS, "m2c"), { recursive: true });
  await mkdir(resolve(ARTIFACTS, "m5"), { recursive: true });
  await mkdir(resolve(ARTIFACTS, "m2d"), { recursive: true });
  await mkdir(resolve(ARTIFACTS, "px2py1"), { recursive: true });
  await mkdir(resolve(ARTIFACTS, "brand"), { recursive: true });
  const only = process.env.SWEEP_ONLY;
  // SWEEP_CONTROL_PORT, SWEEP_CONSOLE_PORT and SWEEP_DB_PREFIX let builders run side by side.
  const controlPort = Number(process.env.SWEEP_CONTROL_PORT) || 4150;
  const consolePort = Number(process.env.SWEEP_CONSOLE_PORT) || 4450;
  console.log(
    `Starting a throwaway Nearzero (control plane on ${controlPort}, console on ${consolePort})…`,
  );
  const handoff = await handoffFolder("sweep");
  let host: FakeHost | null = null;
  const stack: Stack = await startStack({
    console: "dev",
    label: "sweep",
    controlPort,
    consolePort,
    ...(process.env.SWEEP_DB_PREFIX ? { databasePrefix: process.env.SWEEP_DB_PREFIX } : {}),
    // A pretend host runner (deploys finish without Docker) and a platform domain (spec 10.1).
    env: {
      NEARZERO_RUNNER_HANDOFF_DIR: handoff,
      NEARZERO_PLATFORM_DOMAIN: "apps.acme.test",
      NEARZERO_PUBLIC_IP: "203.0.113.10",
      NEARZERO_DNS_RESOLVERS: "127.0.0.1:9",
    },
  });
  BASE = stack.consoleUrl;
  const browser = await chromium.launch();
  try {
    const seeder = new Seeder(stack);
    // The owner from create-owner, on onboarding step 1.
    sessions.owner = await seeder.ownerOnWorkspaceStep();
    const stepOne: Route[] = [
      { path: "/onboarding/workspace", as: "owner", shot: "m2b/onboarding" },
    ];
    if (only !== "behaviors") {
      await warm(browser, stepOne);
      await sweepAll(browser, stepOne);
    }
    // Step 2 for the owner, and a member added with a password on the name step.
    const second = await seeder.ownerOnInviteStepAndMemberOnName();
    sessions.owner = second.owner;
    sessions.member = second.member;
    const stepTwo: Route[] = [
      { path: "/onboarding/team", as: "owner", shot: "m2b/onboarding-team" },
      { path: "/onboarding/welcome", as: "member" },
    ];
    if (only !== "behaviors") {
      await warm(browser, stepTwo);
      await sweepAll(browser, stepTwo);
    }
    const people = await seeder.everyone();
    sessions.owner = people.owner;
    sessions.ownerSide = people.ownerSide;
    sessions.member = people.member;
    sessions.lee = people.lee;
    // SWEEP_MATCH=backups sweeps only the routes whose address contains it.
    const match = process.env.SWEEP_MATCH;
    host = await connectFakeHost(stack.controlUrl, handoff);
    const operations = await seedOperations(BASE, people.projects, host);
    // SWEEP_OPS_ONLY=1 sweeps only the operations pages (deploys, domains, servers, About).
    const all = process.env.SWEEP_OPS_ONLY
      ? operationsRoutes(people.projects, operations)
      : [...mainRoutes(people), ...operationsRoutes(people.projects, operations)];
    const routes = all.filter((route) => !match || route.path.includes(match));
    await warm(browser, routes);
    if (only !== "behaviors") await sweepAll(browser, routes);
    if (only !== "pages") await behaviors(browser, people);
  } finally {
    await browser.close();
    host?.runner.releaseBuilds();
    await host?.close();
    await stack.stop();
  }

  console.log(
    `\nSwept ${swept} pages × ${THEMES.length} themes × ${VIEWPORTS.length} widths (${loads} loads), signed in as ${OWNER_EMAIL}, a member and an invitee.`,
  );
  console.log(
    `Lowest text contrast in Dark and Dusk: ${lowestContrast.ratio.toFixed(2)}:1 at ${lowestContrast.where}`,
  );
  for (const note of notes) console.log(note);
  if (unchecked.size > 0) {
    console.log(
      `Clickable things outside the 21.9a control check: ${[...unchecked].sort().join(", ")}`,
    );
  }
  console.log(
    `Shadowed elements found: ${shadowed.size}; style rules that draw a shadow: ${shadowRules.size}.`,
  );
  for (const rule of shadowRules) fail("stylesheets", `a rule draws a shadow: ${rule}`);
  // Every problem goes to a file too, since the console shows the first 200.
  await Bun.write(resolve(ARTIFACTS, "sweep-problems.txt"), `${failures.join("\n")}\n`);
  if (failures.length > 0) {
    console.log(`\n${failures.length} problem(s):`);
    for (const failure of failures.slice(0, 200)) console.log(`  ✗ ${failure}`);
    process.exit(1);
  }
  console.log("\nNo problems found.");
}

await main();
