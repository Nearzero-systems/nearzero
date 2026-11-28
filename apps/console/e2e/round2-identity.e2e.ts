import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { resolve } from "node:path";
import { $, SQL } from "bun";
import { type Browser, chromium } from "playwright";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * W1's round 2 identity and request-security fixes, end to end on the production build:
 * - R1-01: plain-HTTP visits to the server's IP address move to the console's HTTPS address;
 * - R1-02: Profile shows a waiting email change, and /confirm-email opens its link;
 * - R1-04: half-made server email doesn't stop the start, and the Members strip names it;
 * - R1-09: the invitation page names who sent it;
 * - B1-26: a change sent from another site through the console's proxy is refused.
 *
 *   bun test e2e/round2-identity.e2e.ts      (builds the console and runs the production build)
 *
 * Needs the development PostgreSQL; uses ports 4260 and 4560 (or NEARZERO_TEST_CONTROL_PORT and
 * NEARZERO_TEST_CONSOLE_PORT) and a database nz_r2id_… (or NEARZERO_TEST_DATABASE_PREFIX).
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const ADMIN_URL =
  process.env.NEARZERO_TEST_DATABASE_URL ??
  "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";
const HTTPS_ADDRESS = "https://console.example.com";
const OWNER = { email: "olivia@example.com", password: "olivia's long password" };
const MEMBER = { email: "mia@example.com", password: "mia's long password 1" };

let stack: Stack;
let browser: Browser;
let db: SQL;
let owner: ApiSession;
let member: ApiSession;
let workspace = "";

/** A raw request to the console with any Host header, as a browser on the server's IP sends. */
function raw(
  method: string,
  path: string,
  host: string,
): Promise<{ status: number; location: string | null }> {
  const url = new URL(stack.consoleUrl);
  return new Promise((done, fail) => {
    const req = httpRequest(
      { host: url.hostname, port: url.port, method, path, headers: { host } },
      (res) => {
        res.resume();
        done({ status: res.statusCode ?? 0, location: res.headers.location ?? null });
      },
    );
    req.on("error", fail);
    req.end();
  });
}

beforeAll(async () => {
  await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  stack = await startStack({
    console: "built",
    label: "r2id",
    controlPort: 4260,
    consolePort: 4560,
    databasePrefix: "nz_r2id",
    env: {
      NEARZERO_CONSOLE_URL: HTTPS_ADDRESS,
      // A key without a sender: the start goes on without server email (R1-04).
      RESEND_API_KEY: "re_half_made_key_123",
      NEARZERO_DNS_RESOLVERS: "127.0.0.1:9",
    },
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  owner = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  const named = await owner.call<{ workspace: { slug: string } }>("POST", "/onboarding/workspace", {
    name: "Olivia Owner",
    workspaceName: "Acme",
  });
  workspace = named.workspace.slug;
  await owner.call("POST", "/onboarding/skip-invitations");
  const added = await owner.call("POST", "/workspace/members", {
    email: MEMBER.email,
    role: "member",
    policyIds: [],
    password: MEMBER.password,
  });
  expect(added).toBeTruthy();
  member = await ApiSession.signIn(stack.consoleUrl, MEMBER.email, MEMBER.password);
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

describe("plain HTTP on the server's IP address (R1-01)", () => {
  test("a page moves to the HTTPS address with its path and query; API, POST and loopback stay", async () => {
    const port = new URL(stack.consoleUrl).port;
    const moved = await raw("GET", "/sign-in?next=/x", `203.0.113.10:${port}`);
    expect(moved.status).toBe(302);
    expect(moved.location).toBe(`${HTTPS_ADDRESS}/sign-in?next=/x`);
    expect((await raw("HEAD", "/sign-in", `203.0.113.10:${port}`)).status).toBe(302);
    expect((await raw("GET", "/api/v1/health", `203.0.113.10:${port}`)).status).toBe(200);
    expect((await raw("POST", "/sign-in", `203.0.113.10:${port}`)).status).not.toBe(302);
    expect((await raw("GET", "/sign-in", `127.0.0.1:${port}`)).status).toBe(200);
  }, 60_000);
});

describe("server email that is half made (R1-04)", () => {
  test("the control plane started, and the Members strip says why email is off", async () => {
    const context = await browser.newContext();
    await context.addCookies([
      { name: "nz_session", value: owner.sessionToken(), url: stack.consoleUrl },
      { name: "nz_theme", value: "light", url: stack.consoleUrl },
    ]);
    const page = await context.newPage();
    await page.goto(`${stack.consoleUrl}/${workspace}/dashboard/settings/members`);
    const problem = page.locator("[data-server-email-problem]");
    await problem.waitFor({ timeout: 30_000 });
    expect(await problem.textContent()).toContain("NEARZERO_EMAIL_FROM is not set");
    await context.close();
  }, 120_000);
});

describe("a waiting email change and its link (R1-02)", () => {
  test("Profile shows the waiting address; opening the link makes it the account's", async () => {
    const people = await db`select id from person where email = ${MEMBER.email}`;
    const personId = (people[0] as { id: string }).id;
    const token = "e2e-confirmation-token-0123456789abcdef";
    const hash = createHash("sha256").update(token, "utf8").digest();
    await db`insert into email_confirmation (person_id, email, token_hash, expires_at)
      values (${personId}, ${"mia.new@example.com"}, ${hash}, now() + interval '1 hour')`;
    const context = await browser.newContext();
    await context.addCookies([
      { name: "nz_session", value: member.sessionToken(), url: stack.consoleUrl },
      { name: "nz_theme", value: "light", url: stack.consoleUrl },
    ]);
    const page = await context.newPage();
    await page.goto(`${stack.consoleUrl}/${workspace}/dashboard/profile`);
    const status = page.locator("[data-email-status]");
    await status.waitFor({ timeout: 30_000 });
    expect(await status.textContent()).toContain(
      `Open the link sent to mia.new@example.com to make it your address. Until then ${MEMBER.email} stays in use.`,
    );
    expect(await page.locator("[data-email-send-link]").textContent()).toContain("Send link again");
    expect(await page.locator("#nz-profile-email").inputValue()).toBe(MEMBER.email);

    await page.goto(`${stack.consoleUrl}/confirm-email?token=${token}`);
    await page.locator('[data-confirm-email="confirmed"]').waitFor({ timeout: 30_000 });
    expect(await page.locator("h1").first().textContent()).toContain("Email address changed");
    await page.goto(`${stack.consoleUrl}/${workspace}/dashboard/profile`);
    expect(await page.locator("#nz-profile-email").inputValue()).toBe("mia.new@example.com");
    expect(await page.locator("[data-email-status]").count()).toBe(0);
    // The link works once.
    await page.goto(`${stack.consoleUrl}/confirm-email?token=${token}`);
    await page.locator('[data-confirm-email="refused"]').waitFor({ timeout: 30_000 });

    // Signed out, the link goes through sign-in and comes back.
    const signedOut = await browser.newContext();
    const visitor = await signedOut.newPage();
    await visitor.goto(`${stack.consoleUrl}/confirm-email?token=${token}`);
    expect(new URL(visitor.url()).pathname).toBe("/sign-in");
    expect(new URL(visitor.url()).searchParams.get("next")).toBe(`/confirm-email?token=${token}`);
    await signedOut.close();
    await context.close();
  }, 120_000);
});

describe("the invitation page names the inviter (R1-09)", () => {
  test("signed in as another account, the page says who invited whom", async () => {
    const created = await owner.call<{ delivery: { link: string } }>(
      "POST",
      "/workspace/invitations",
      { email: "dev@example.com", role: "member", policyIds: [] },
    );
    const token = new URL(created.delivery.link).searchParams.get("token") ?? "";
    const context = await browser.newContext();
    const session = await ApiSession.signIn(
      stack.consoleUrl,
      "mia.new@example.com",
      MEMBER.password,
    );
    await context.addCookies([
      { name: "nz_session", value: session.sessionToken(), url: stack.consoleUrl },
      { name: "nz_theme", value: "light", url: stack.consoleUrl },
    ]);
    const page = await context.newPage();
    await page.goto(`${stack.consoleUrl}/invitation?token=${token}`);
    await page.locator("text=This invitation is for another email").first().waitFor();
    expect(await page.locator(".nz-gate-note").textContent()).toBe(
      "Olivia Owner invited you to join Acme as dev@example.com. You're signed in as mia.new@example.com.",
    );
    await context.close();
  }, 120_000);
});

describe("changes from another site through the console (B1-26)", () => {
  test("a bodyless cross-site POST is refused before it reaches the API; the console's own works", async () => {
    const invitation = await owner.call<{ invitations: { id: string }[] }>(
      "GET",
      "/workspace/invitations",
    );
    const id = invitation.invitations[0]?.id ?? "";
    const send = (headers: Record<string, string>) =>
      fetch(`${stack.consoleUrl}/api/v1/workspace/invitations/${id}/resend`, {
        method: "POST",
        headers: { cookie: owner.cookie, ...headers },
      });
    // Bodyless, the console's form check refuses it first; with a JSON body, its proxy does.
    expect((await send({ "sec-fetch-site": "same-site" })).status).toBe(403);
    const json = await send({
      "sec-fetch-site": "same-site",
      "content-type": "application/json",
    });
    expect(json.status).toBe(403);
    expect(((await json.json()) as { error: { message: string } }).error.message).toBe(
      "This request came from another site, so Nearzero refused it. Make the change from Nearzero's own pages.",
    );
    expect((await send({ origin: "http://127.0.0.1:8080" })).status).toBe(403);
    // The console's own pages get the API's own answer, whatever it is.
    const answerOf = async (headers: Record<string, string>) => {
      const reply = await send({ "content-type": "application/json", ...headers });
      const text = await reply.text();
      return `${reply.status} ${text}`;
    };
    const owns: Record<string, string>[] = [
      { origin: stack.consoleUrl },
      { "sec-fetch-site": "same-origin" },
    ];
    for (const own of owns) {
      const said = await answerOf(own);
      expect(said).not.toContain("This request came from another site");
      expect(said).not.toStartWith("403 Cross-site");
    }
  }, 60_000);
});
