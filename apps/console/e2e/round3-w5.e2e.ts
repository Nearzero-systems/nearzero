import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $, SQL } from "bun";
import { type Browser, chromium, type Page } from "playwright";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * Round 3's console fixes in the browser, on the production build (spec 31a, the C3 report):
 * - G1-03, G1-04: 0.1.79's own page addresses, /setup and /register?token=… go where they should;
 * - G1-13: the cookies the console sets are Secure over HTTPS;
 * - C3-07: "Invitation declined." reaches the page after the redirect through "/";
 * - G1-08: a used invitation link keeps its details and says what is left to do;
 * - G1-09: the bell shows an invitation's expiry as a full date;
 * - G1-05, G1-06: capabilities with their explanations, under 0.1.79's groups and names;
 * - R1-02, G1-02: without server email, Profile offers no confirmation link, and an instance
 *   administrator changes a member's address in Members.
 *
 *   bun test e2e/round3-w5.e2e.ts      (builds the console and runs the production build)
 *
 * Needs the development PostgreSQL; uses ports 4270 and 4570 (or NEARZERO_TEST_CONTROL_PORT and
 * NEARZERO_TEST_CONSOLE_PORT) and a database nz_r3w5_… (or NEARZERO_TEST_DATABASE_PREFIX).
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const ADMIN_URL =
  process.env.NEARZERO_TEST_DATABASE_URL ??
  "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";
const OWNER = { email: "olivia@example.com", password: "olivia's long password" };
const MEMBER = { email: "mia@example.com", password: "mia's long password 1" };

let stack: Stack;
let browser: Browser;
let db: SQL;
let owner: ApiSession;
let workspace = "";

async function signedInPage(session: ApiSession, path: string): Promise<Page> {
  const context = await browser.newContext();
  await context.addCookies([
    { name: "nz_session", value: session.sessionToken(), url: stack.consoleUrl },
    { name: "nz_theme", value: "light", url: stack.consoleUrl },
  ]);
  const page = await context.newPage();
  await page.goto(`${stack.consoleUrl}${path}`);
  return page;
}

function located(response: Response): string {
  const at = response.headers.get("location") ?? "";
  return at.startsWith("http") ? new URL(at).pathname + new URL(at).search : at;
}

async function invite(email: string): Promise<string> {
  const created = await owner.call<{ delivery: { link: string } }>(
    "POST",
    "/workspace/invitations",
    { email, role: "member", policyIds: [] },
  );
  return new URL(created.delivery.link).searchParams.get("token") ?? "";
}

beforeAll(async () => {
  await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  stack = await startStack({
    console: "built",
    label: "r3w5",
    controlPort: 4270,
    consolePort: 4570,
    databasePrefix: "nz_r3w5",
    // Loopback is the proxy in front of the console here, so its X-Forwarded-Proto counts.
    env: { NEARZERO_TRUSTED_PROXIES: "127.0.0.1/32", NEARZERO_DNS_RESOLVERS: "127.0.0.1:9" },
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  const named = await owner.call<{ workspace: { slug: string } }>("POST", "/onboarding/workspace", {
    name: "Olivia Owner",
    workspaceName: "Acme",
  });
  workspace = named.workspace.slug;
  await owner.call("POST", "/onboarding/skip-invitations");
  await owner.call("POST", "/workspace/members", {
    email: MEMBER.email,
    role: "member",
    policyIds: [],
    password: MEMBER.password,
  });
  const member = await ApiSession.signIn(stack.consoleUrl, MEMBER.email, MEMBER.password);
  await member.call("POST", "/onboarding/name", { name: "Mia Member" });
  const url = new URL(ADMIN_URL);
  url.pathname = `/${stack.databaseName}`;
  db = new SQL(url.toString());
  browser = await chromium.launch();
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await db?.close();
  await stack?.stop();
}, 120_000);

describe("old addresses (G1-03, G1-04)", () => {
  test("0.1.79's page addresses, the setup wizard and a registration link", async () => {
    const get = (path: string, cookie = "") =>
      fetch(`${stack.consoleUrl}${path}`, { redirect: "manual", headers: { cookie } });
    for (const path of ["/setup", "/setup/owner"]) {
      const reply = await get(path);
      expect(reply.status).toBe(301);
      expect(located(reply)).toBe("/sign-in");
    }
    const register = await get("/register?token=abcdefghijklmnopqrstuvwx&email=new%40example.com");
    expect(located(register)).toBe(
      "/invitation?token=abcdefghijklmnopqrstuvwx&email=new%40example.com",
    );
    expect(located(await get("/sign-up?token=abcdefghijklmnopqrstuvwx"))).toBe(
      "/invitation?token=abcdefghijklmnopqrstuvwx",
    );
    const pages: [string, string][] = [
      [`/${workspace}/dashboard/about-nearzero`, `/${workspace}/dashboard/settings`],
      [`/${workspace}/dashboard/monitoring`, `/${workspace}/dashboard/settings`],
      [
        `/${workspace}/dashboard/traefik?server=host`,
        `/${workspace}/dashboard/settings/router-files?server=host`,
      ],
      [`/${workspace}/dashboard/home`, `/${workspace}/dashboard/agent`],
      [`/${workspace}/dashboard/get-started`, `/${workspace}/dashboard/agent`],
      ["/dashboard/about-nearzero", `/${workspace}/dashboard/settings`],
    ];
    for (const [from, to] of pages) {
      const reply = await get(from, owner.cookie);
      expect({ from, status: reply.status, to: located(reply) }).toEqual({ from, status: 301, to });
    }
  }, 60_000);
});

describe("cookies the console sets are Secure over HTTPS (G1-13)", () => {
  test("the invitation link's cookie, by the same rule as the session cookie", async () => {
    const token = await invite("secure@example.com");
    const over = (proto: string) =>
      fetch(`${stack.consoleUrl}/invitation?token=${token}&proof=abc`, {
        redirect: "manual",
        headers: { "x-forwarded-proto": proto, "x-forwarded-for": "198.51.100.9" },
      });
    const https = (await over("https")).headers.getSetCookie().join("\n");
    expect(https).toMatch(/nz_invitation=[^\n]*; Secure/i);
    const http = (await over("http")).headers.getSetCookie().join("\n");
    expect(http).toContain("nz_invitation=");
    expect(http).not.toMatch(/Secure/i);
  }, 60_000);
});

describe("an invitation declined, and the bell (C3-07, G1-09)", () => {
  test("the bell shows a full expiry date; Decline's message reaches the page after /", async () => {
    const side = await owner.call<{ workspace: { id: string } }>("POST", "/workspaces", {
      name: "Side projects",
    });
    await owner.call("POST", `/workspaces/${side.workspace.id}/switch`);
    await invite(MEMBER.email);
    const member = await ApiSession.signIn(stack.consoleUrl, MEMBER.email, MEMBER.password);
    const page = await signedInPage(member, `/${workspace}/dashboard/projects`);
    // Sent to the invitation once; then the bell lists it.
    await page.locator("text=Join Side projects").first().waitFor({ timeout: 30_000 });
    await page.goto(`${stack.consoleUrl}/${workspace}/dashboard/projects`);
    await page.locator("[data-bell-button]").click();
    const card = page.locator(".nz-bell-card", { hasText: "Side projects" });
    await card.waitFor();
    const expires = (await card.locator("p.nz-dim").textContent()) ?? "";
    expect(expires).toMatch(/Expires: \d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2} [AP]M/);
    expect(expires).not.toContain(" in ");

    const id = (
      (
        await db`select id from invitation where email = ${MEMBER.email} and status = 'pending'`
      )[0] as {
        id: string;
      }
    ).id;
    await page.goto(`${stack.consoleUrl}/invitation?id=${id}`);
    await page.getByRole("button", { name: "Decline" }).click();
    await page.waitForURL(/\/dashboard\/agent/, { timeout: 30_000 });
    await page.locator(".nz-toast", { hasText: "Invitation declined." }).waitFor({
      timeout: 15_000,
    });
    await page.context().close();
  }, 120_000);
});

describe("a used invitation link (G1-08)", () => {
  test("keeps Workspace, Role and Invited email, and says what is left to do", async () => {
    const acme = (
      (await db`select id from workspace where slug = ${workspace}`)[0] as { id: string }
    ).id;
    await owner.call("POST", `/workspaces/${acme}/switch`);
    const token = await invite("used@example.com");
    await db`update invitation set status = 'accepted', closed_at = now() where email = 'used@example.com'`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${stack.consoleUrl}/invitation?token=${token}`);
    await page.locator("text=This invitation was already accepted").first().waitFor();
    const text = (await page.locator("body").textContent()) ?? "";
    expect(text).toContain("Sign in to open Acme.");
    expect(text).toContain("Invited email");
    expect(text).toContain("used@example.com");
    expect(await page.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/sign-in?email=used%40example.com",
    );
    await context.close();
    // Signed in: nothing left to do, and who is signed in.
    const signed = await signedInPage(owner, `/invitation?token=${token}`);
    await signed.locator("text=There's nothing left to do with this link.").waitFor();
    expect(await signed.locator(".nz-signed-in-as").textContent()).toBe(
      `Signed in as ${OWNER.email}`,
    );
    await signed.context().close();
  }, 120_000);
});

describe("Members & access without server email (G1-05, G1-06, R1-02, G1-02)", () => {
  test("capabilities explain themselves; an administrator changes a member's address", async () => {
    const page = await signedInPage(owner, `/${workspace}/dashboard/settings/members`);
    await page.locator("[data-people]").waitFor({ timeout: 30_000 });
    const html = await page.content();
    expect(html).toContain("Workspace settings");
    expect(html).toContain("See Traefik files");
    expect(html).toContain("Manage DNS");
    expect(html).toContain("Start new projects. They get access to the projects they create.");
    expect(html).toContain(
      "Members with this policy can open and deploy the projects and services below. These add more.",
    );
    const row = page.locator("[data-people-row]", { hasText: MEMBER.email });
    await row.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Change email" }).click();
    const dialog = page.locator("#nz-member-email");
    await dialog.locator("input[name=email]").fill("mia.member@example.com");
    await dialog.getByRole("button", { name: "Save email" }).click();
    await page
      .locator(".nz-toast", { hasText: "Email changed to mia.member@example.com." })
      .waitFor({ timeout: 15_000 });
    await page.context().close();

    // An unconfirmed account's Profile offers no link this server can't send.
    await db`update person set email_verified_at = null where email = 'mia.member@example.com'`;
    const mia = await ApiSession.signIn(
      stack.consoleUrl,
      "mia.member@example.com",
      MEMBER.password,
    );
    const profile = await signedInPage(mia, `/${workspace}/dashboard/profile`);
    await profile.locator("[data-profile-form]").waitFor();
    expect(await profile.locator("[data-email-send-link]").count()).toBe(0);
    expect((await profile.locator("body").textContent()) ?? "").toContain(
      "Not confirmed yet. This server can't send email, so ask a Nearzero administrator to confirm it in Members.",
    );
    await profile.context().close();
  }, 120_000);
});
