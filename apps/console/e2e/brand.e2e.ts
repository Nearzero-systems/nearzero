import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $, type Server } from "bun";
import { type Browser, chromium } from "playwright";
import { PAGE_COLORS, type ThemeName } from "../src/lib/theme.ts";
import { BRAND_URLS, brandUrlProblems, headTags } from "../test-support/brand.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * Brand files, tab icon and page metadata end to end (spec 21.9b), on the production build
 * (Astro's Node adapter, which serves dist/client as the image does) by default:
 * - every icon address, the manifest, og.png and /robots.txt answer 200 with the right content
 *   type and the committed file, straight from the console (as on http://<ip>:4321) and through
 *   a stand-in for the router (a domain over HTTPS: Host, X-Forwarded-Proto/-For/-Host, as
 *   Traefik sends them);
 * - public pages carry the link preview with an absolute og:image at the address the console was
 *   reached at, in both cases; dashboard pages carry none;
 * - every page has the "<Page> · Nearzero" title ("Nearzero" on the home), a description, robots
 *   noindex, the icon and manifest links, and theme-color equal to the theme's page token, which
 *   follows the theme picker and in-app navigation in a browser;
 * - the 404 and 500 pages are in the person's theme, show the mark, and give a way back.
 *
 *   bun test e2e/brand.e2e.ts                       (builds and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/brand.e2e.ts       (the dev server)
 *
 * Needs the development PostgreSQL; uses ports 4240 and 4540 (or NEARZERO_TEST_CONTROL_PORT and
 * NEARZERO_TEST_CONSOLE_PORT) and a database nz_brand_e2e_* (or NEARZERO_TEST_DATABASE_PREFIX).
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const DOMAIN = "nearzero.example.test";
const IP = "203.0.113.10:4321";
const dev = process.env.E2E_CONSOLE === "dev";

let stack: Stack;
let router: Server<undefined>;
let routerUrl = "";
let owner: ApiSession;
let browser: Browser;
/** The link cookie of an invitation for a new address: registration opens from it (spec 4.2). */
let invitationCookie = "";

/**
 * The router in front of the console once a domain is set (spec 10.1): it terminates HTTPS and
 * passes the request on with the original Host and the forwarded headers. Here it listens on a
 * free port over plain HTTP and says the browser used HTTPS for DOMAIN.
 */
function startRouter(upstream: string): Server<undefined> {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, server) {
      const url = new URL(request.url);
      const headers = new Headers(request.headers);
      headers.set("host", DOMAIN);
      headers.set("x-forwarded-host", DOMAIN);
      headers.set("x-forwarded-proto", "https");
      headers.set("x-forwarded-port", "443");
      headers.set("x-forwarded-for", server.requestIP(request)?.address ?? "198.51.100.7");
      const answer = await fetch(`${upstream}${url.pathname}${url.search}`, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
      });
      return new Response(answer.body, { status: answer.status, headers: answer.headers });
    },
  });
}

async function page(
  path: string,
  options: { base?: string; theme?: ThemeName; session?: boolean; host?: string } = {},
) {
  const cookies = [
    ...(options.theme ? [`nz_theme=${options.theme}`] : []),
    ...(options.session ? [`nz_session=${owner.sessionToken()}`] : []),
    // Registration opens only from an invitation link.
    ...(path === "/sign-up" ? [invitationCookie] : []),
  ];
  const response = await fetch(`${options.base ?? stack.consoleUrl}${path}`, {
    headers: {
      ...(cookies.length > 0 ? { cookie: cookies.join("; ") } : {}),
      ...(options.host ? { host: options.host } : {}),
    },
    redirect: "manual",
  });
  const html = await response.text();
  return { status: response.status, html, head: headTags(html) };
}

/** A POST whose form body can't be read: the page fails on the server and the 500 page shows. */
async function failingPage(options: { theme: ThemeName; session: boolean }) {
  const cookies = [`nz_theme=${options.theme}`];
  if (options.session) cookies.push(`nz_session=${owner.sessionToken()}`);
  const response = await fetch(`${stack.consoleUrl}/sign-in`, {
    method: "POST",
    headers: {
      cookie: cookies.join("; "),
      // Same-site, as a browser says for the console's own forms (Astro refuses cross-site ones).
      "sec-fetch-site": "same-origin",
      "content-type": "multipart/form-data; boundary=nz-e2e",
    },
    body: "not a form",
    redirect: "manual",
  });
  const html = await response.text();
  return { status: response.status, html, head: headTags(html) };
}

beforeAll(async () => {
  if (!dev) await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  stack = await startStack({
    console: dev ? "dev" : "built",
    label: "e2e",
    databasePrefix: "nz_brand",
    controlPort: 4240,
    consolePort: 4540,
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  await owner.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await owner.call("POST", "/onboarding/skip-invitations");
  const invited = await owner.call<{ delivery: { link: string } }>(
    "POST",
    "/workspace/invitations",
    { email: "kim@example.com", role: "member" },
  );
  const token = new URL(invited.delivery.link).searchParams.get("token") ?? "";
  invitationCookie = `nz_invitation=${encodeURIComponent(JSON.stringify({ t: token }))}`;
  router = startRouter(stack.consoleUrl);
  routerUrl = `http://127.0.0.1:${router.port}`;
  browser = await chromium.launch();
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await router?.stop(true);
  await stack?.stop();
});

describe("brand files and page metadata (spec 21.9b)", () => {
  test("every icon address and /robots.txt answer 200 with their content type, straight from the console", async () => {
    expect(BRAND_URLS.map((url) => url.path)).toContain("/favicon.ico");
    expect(await brandUrlProblems(stack.consoleUrl)).toEqual([]);
    // As a browser on the server's address and console port would ask for them.
    expect(await brandUrlProblems(stack.consoleUrl, { host: IP })).toEqual([]);
  });

  test("…and through the router, on a domain over HTTPS", async () => {
    expect(await brandUrlProblems(routerUrl)).toEqual([]);
  });

  test("public pages carry the link preview with an absolute og:image at the console's own address", async () => {
    // Signed out; registration (/sign-up) with the invitation link's cookie.
    for (const path of ["/sign-in", "/sign-up", "/invitation"]) {
      const direct = await page(path, { host: IP });
      expect(direct.status).toBe(200);
      expect(direct.head.metas.get("og:image")).toBe(`http://${IP}/og.png`);
      expect(direct.head.metas.get("twitter:card")).toBe("summary_large_image");
      expect(direct.head.metas.get("og:title")).toBe(direct.head.title ?? "");
      expect(direct.head.metas.get("og:description")).toBe(
        direct.head.metas.get("description") ?? "",
      );
      const routed = await page(path, { base: routerUrl });
      expect(routed.status).toBe(200);
      expect(routed.head.metas.get("og:image")).toBe(`https://${DOMAIN}/og.png`);
      expect(routed.head.metas.get("og:url")).toBe(`https://${DOMAIN}${path}`);
    }
    // The address a preview crawler fetches answers too.
    const image = await fetch(`${routerUrl}/og.png`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
  });

  test("every page has the title format, a description, robots noindex, the icons, the manifest and theme-color", async () => {
    const pages: { path: string; title: string; session: boolean; preview: boolean }[] = [
      { path: "/sign-in", title: "Sign in · Nearzero", session: false, preview: true },
      { path: "/sign-up", title: "Sign up · Nearzero", session: false, preview: true },
      { path: "/invitation", title: "Invitation · Nearzero", session: false, preview: true },
      { path: "/acme/dashboard/agent", title: "Nearzero", session: true, preview: false },
      {
        path: "/acme/dashboard/projects",
        title: "Projects · Nearzero",
        session: true,
        preview: false,
      },
      {
        path: "/acme/dashboard/settings",
        title: "About Nearzero · Nearzero",
        session: true,
        preview: false,
      },
      {
        path: "/acme/dashboard/profile",
        title: "Profile · Nearzero",
        session: true,
        preview: false,
      },
    ];
    for (const theme of ["light", "dark", "dusk"] as const) {
      for (const item of pages) {
        const { status, head } = await page(item.path, { theme, session: item.session });
        expect(`${item.path} ${status}`).toBe(`${item.path} 200`);
        expect(head.title).toBe(item.title);
        expect(head.metas.get("description")).toMatch(/^[A-Z].*\.$/);
        expect(head.metas.get("robots")).toBe("noindex, nofollow");
        expect(head.metas.get("theme-color")).toBe(PAGE_COLORS[theme]);
        const links = head.links.map((link) => `${link.rel} ${link.href}`);
        expect(links).toContain("icon /favicon.svg");
        expect(links).toContain("icon /favicon.ico");
        expect(links).toContain("apple-touch-icon /apple-touch-icon.png");
        expect(links.filter((link) => link.startsWith("manifest "))).toEqual([
          "manifest /manifest.webmanifest",
        ]);
        const previews = [...head.metas.keys()].filter((key) => /^(og|twitter):/.test(key));
        expect(previews.length > 0).toBe(item.preview);
      }
    }
  });

  test("the 404 page is in the person's theme, shows the mark, and leads back", async () => {
    const signedOut = await page("/no-such-page", { theme: "dusk" });
    expect(signedOut.status).toBe(404);
    expect(signedOut.html).toMatch(/<html[^>]*data-theme="dusk"/);
    expect(signedOut.head.title).toBe("Page not found · Nearzero");
    expect(signedOut.head.metas.get("theme-color")).toBe(PAGE_COLORS.dusk);
    expect(signedOut.html).toContain('src="/icon.svg"');
    expect(signedOut.html).toMatch(/href="\/sign-in"[^>]*>\s*Sign in\s*</);

    const signedIn = await page("/no-such-page", { theme: "light", session: true });
    expect(signedIn.status).toBe(404);
    expect(signedIn.html).toMatch(/<html[^>]*data-theme="light"/);
    expect(signedIn.html).toMatch(
      /href="\/acme\/dashboard\/projects"[^>]*>\s*Go to your projects\s*</,
    );

    const inShell = await page("/acme/dashboard/no-such-page", { theme: "dark", session: true });
    expect(inShell.status).toBe(404);
    expect(inShell.html).toContain('src="/logo.svg"');
    expect(inShell.html).toMatch(/href="\/acme\/dashboard\/projects"[^>]*>\s*Go to your projects/);
  });

  test("the 500 page is in the person's theme, shows the mark, and leads back", async () => {
    const signedOut = await failingPage({ theme: "dusk", session: false });
    expect(signedOut.status).toBe(500);
    expect(signedOut.html).toMatch(/<html[^>]*data-theme="dusk"/);
    expect(signedOut.head.title).toBe("Something went wrong · Nearzero");
    expect(signedOut.head.metas.get("robots")).toBe("noindex, nofollow");
    expect(signedOut.html).toContain('src="/icon.svg"');
    expect(signedOut.html).toMatch(/href="\/sign-in"[^>]*>\s*Sign in\s*</);
    expect(signedOut.html).not.toContain("not a form");

    const signedIn = await failingPage({ theme: "light", session: true });
    expect(signedIn.status).toBe(500);
    expect(signedIn.html).toMatch(/<html[^>]*data-theme="light"/);
    expect(signedIn.html).toMatch(/href="\/dashboard\/projects"[^>]*>\s*Go to your projects\s*</);
  });

  test("in a browser, theme-color follows the theme picker and in-app navigation, and the mark shows", async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([
      { name: "nz_session", value: owner.sessionToken(), url: stack.consoleUrl },
      { name: "nz_theme", value: "dark", url: stack.consoleUrl },
    ]);
    const tab = await context.newPage();
    const errors: string[] = [];
    tab.on("pageerror", (error) => errors.push(error.message));
    const color = () =>
      tab.evaluate(() =>
        Array.from(document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'))
          .map((meta) => meta.content)
          .join(","),
      );
    await tab.goto(`${stack.consoleUrl}/acme/dashboard/projects`, { waitUntil: "networkidle" });
    expect(await color()).toBe(PAGE_COLORS.dark);
    const mark = tab.locator(".nz-brand img");
    expect(await mark.getAttribute("src")).toBe("/logo.svg");
    expect(await mark.evaluate((img: HTMLImageElement) => img.naturalWidth > 0)).toBe(true);
    await tab.locator(".nz-nav .nz-user-trigger").click();
    await tab.locator("#nz-user-menu input[value='dusk']").check();
    expect(await color()).toBe(PAGE_COLORS.dusk);
    await tab.keyboard.press("Escape");
    await tab.locator(".nz-nav a[href$='/agent']").click();
    await tab.waitForURL(/\/agent$/);
    await tab.waitForLoadState("networkidle");
    expect(await color()).toBe(PAGE_COLORS.dusk);
    expect(await tab.title()).toBe("Nearzero");
    const icons = await tab.evaluate(
      () => Array.from(document.head.querySelectorAll("link[rel~='icon']")).length,
    );
    expect(icons).toBe(2);
    expect(errors).toEqual([]);
    await context.close();
  });
});
