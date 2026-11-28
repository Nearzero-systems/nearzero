import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type Stack, startStack } from "../test-support/stack.ts";

/**
 * The people-and-access flow end to end (spec 04): the owner made by the control CLI signs in
 * and finishes onboarding, invites a member, the member accepts in a second browser, the owner
 * gives them a policy, and the member sees only what a member should. Then two-factor sign-in
 * with a code and with a backup code that works once.
 *
 *   bun test e2e/people.e2e.ts            (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...      (uses the dev server instead, faster while building)
 *
 * Needs the development PostgreSQL (docker-compose.dev.yml); uses ports 4150 and 4450.
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const MEMBER = { email: "sam@example.com", password: "member-password-1" };
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;

let stack: Stack;
let browser: Browser;
let owner: BrowserContext;
let member: BrowserContext;
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

async function newContext(): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INSECURE_CONTEXT);
  context.on("page", (page) => watch(page));
  return context;
}

function watch(page: Page): void {
  // Secrets never ride in an address (spec 21.9, 23.4).
  page.on("request", (request) => {
    const url = new URL(request.url());
    for (const name of ["password", "currentPassword", "newPassword", "code", "key", "apiKey"]) {
      if (url.searchParams.has(name)) problems.push(`${name} in an address: ${url.pathname}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error" && !/status of (4\d\d)/.test(message.text())) {
      problems.push(`console error: ${message.text()}`);
    }
  });
}

async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${stack.consoleUrl}/sign-in`);
  await page.fill("#nz-sign-in-email", email);
  await page.fill("#nz-sign-in-password", password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

/** The workspace slug in a dashboard page's address. */
function slug(page: Page): string {
  return new URL(page.url()).pathname.split("/")[1] ?? "";
}

/** Waits for a toast that says `text` (toasts stack, so the last one may be older). */
async function toast(page: Page, text: string): Promise<string> {
  const match = page.locator(".nz-toast", { hasText: text }).last();
  await match.waitFor();
  return ((await match.textContent()) ?? "").trim();
}

beforeAll(async () => {
  if (process.env.E2E_CONSOLE !== "dev") {
    await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  }
  stack = await startStack({
    console: process.env.E2E_CONSOLE === "dev" ? "dev" : "built",
    label: "e2e",
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  browser = await chromium.launch();
  owner = await newContext();
  member = await newContext();
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await stack?.stop();
});

describe("people and access, end to end", () => {
  test("the owner signs in, finishes onboarding and is greeted by name", async () => {
    const page = await owner.newPage();
    await page.goto(`${stack.consoleUrl}/`);
    expect(new URL(page.url()).pathname).toBe("/sign-in");
    await signIn(page, OWNER.email, OWNER.password);
    await page.waitForURL(/\/onboarding\/workspace$/);
    await page.fill("#nz-onboarding-name", "Maya Lopez");
    await page.fill("#nz-onboarding-workspace", "Acme");
    await page.getByRole("button", { name: "Continue" }).click();
    await page.waitForURL(/\/onboarding\/team$/);
    await page.getByRole("button", { name: "Skip for now" }).click();
    await page.waitForURL(/\/acme\/dashboard\/agent$/);
    expect(await page.locator(".nz-greeting").textContent()).toContain("Maya");
  }, 60_000);

  let link = "";
  test("the owner invites a member and gets a link to send (email is off)", async () => {
    const page = owner.pages()[0] as Page;
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/members`);
    await expect(page.locator("[data-email-strip]").textContent()).resolves.toContain(
      "Invitation emails are off",
    );
    await page.getByRole("button", { name: "Add user" }).click();
    await page.fill("#nz-add-user-email", MEMBER.email);
    await page.locator("[data-add-submit]").click();
    const result = page.locator("[data-add-result]");
    await result.waitFor({ state: "visible" });
    expect(await result.textContent()).toContain(`Invitation created for ${MEMBER.email}`);
    link = ((await result.locator("code").first().textContent()) ?? "").trim();
    expect(link).toContain("/invitation?token=");
    await result.getByRole("button", { name: "Copy link" }).click();
    expect(await toast(page, "Copied to clipboard")).toContain("Copied to clipboard");
    await result.getByRole("button", { name: "Done" }).click();
    await page.locator("[data-people] table").nth(1).waitFor();
    expect(await page.locator("[data-people]").textContent()).toContain(MEMBER.email);
  }, 60_000);

  test("the member accepts in a second browser, signs up with the email locked, and names themselves", async () => {
    const page = await member.newPage();
    await page.goto(link);
    await page.waitForURL(/\/sign-up$/);
    expect(page.url()).not.toContain("token");
    expect(await page.locator("#nz-sign-up-email").inputValue()).toBe(MEMBER.email);
    expect(await page.locator("#nz-sign-up-email").getAttribute("readonly")).not.toBeNull();
    await page.fill("#nz-sign-up-password", MEMBER.password);
    await page.getByRole("button", { name: "Create an account" }).click();
    await page.waitForURL(/\/onboarding\/welcome$/);
    await page.fill("#nz-welcome-name", "Sam Rivera");
    await page.getByRole("button", { name: "Finish" }).click();
    await page.waitForURL(/\/dashboard\/agent$/);
    expect(await page.locator(".nz-greeting").textContent()).toContain("Sam");
  }, 60_000);

  test("the owner makes a policy and gives it to the member", async () => {
    const page = owner.pages()[0] as Page;
    // Two projects, so the policy can reach one and not the other.
    for (const name of ["storefront", "internal-tools"]) {
      const made = await page.request.post(`${stack.consoleUrl}/api/v1/projects`, {
        data: { name },
      });
      expect(made.status()).toBe(201);
    }
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/members?tab=policies`);
    await page.getByRole("button", { name: "New policy" }).first().click();
    const dialog = page.locator("#nz-policy");
    await dialog.locator("#nz-policy-name").fill("Developers");
    await dialog.getByLabel("Create projects").check();
    await dialog.getByLabel("All servers, including new ones").check();
    // Ticking an environment ticks its project too.
    const tree = dialog.locator("[data-tree]");
    await tree.locator("li", { hasText: "storefront" }).getByLabel("development").check();
    expect(await tree.getByLabel("storefront").isChecked()).toBe(true);
    await dialog.getByRole("button", { name: "Save policy" }).click();
    expect(await toast(page, "Policy created")).toContain("Policy created");
    const card = page.locator(".nz-policy-card", { hasText: "Developers" });
    await card.waitFor();
    expect(await card.textContent()).toContain("Create projects");
    expect(await card.textContent()).toContain("All servers");
    expect(await card.textContent()).toContain("1 project, 1 environment");
    expect(await card.textContent()).toContain("Not given to anyone yet.");

    await page.getByRole("tab", { name: /People/ }).click();
    const row = page.locator("tr", { hasText: MEMBER.email });
    await row.getByRole("button", { name: /Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Access" }).click();
    const access = page.locator("#nz-member-access");
    await access.locator("[data-access-body]").waitFor({ state: "visible" });
    expect(await access.locator(".nz-dialog-title").textContent()).toBe("Access for Sam Rivera");
    await access.getByLabel("Developers").check();
    const mark = access.locator('[data-from="capability:projects.create"]');
    expect(await mark.textContent()).toBe("From Developers");
    await access.getByRole("button", { name: "Save access" }).click();
    expect(await toast(page, "Access saved for Sam Rivera")).toContain(
      "Access saved for Sam Rivera",
    );
    // The table reloads in place with the member's policy under their role.
    await page
      .locator("tr", { hasText: MEMBER.email })
      .locator(".nz-access-note", { hasText: "Developers" })
      .waitFor();
    await page.getByRole("tab", { name: /Access policies/ }).click();
    expect(
      await page.locator(".nz-policy-card", { hasText: "Developers" }).textContent(),
    ).toContain("Given to Sam Rivera");
  }, 60_000);

  test("the member sees only what a member should", async () => {
    const page = member.pages()[0] as Page;
    await page.goto(`${stack.consoleUrl}/`);
    await page.waitForURL(/\/dashboard\/agent$/);
    const slug = new URL(page.url()).pathname.split("/")[1];
    expect(slug).toBe("acme");
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings`);
    const entries = await page.locator(".nz-settings-links a").allTextContents();
    expect(entries.map((entry) => entry.trim())).toEqual(["About Nearzero"]);
    for (const entry of ["members", "api-keys", "agent-policies", "channels"]) {
      const response = await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/${entry}`);
      expect(response?.status()).toBe(403);
      expect(await page.locator(".nz-empty-title").textContent()).toBe(
        "You do not have access to this section.",
      );
    }
    await page.locator('[popovertarget="nz-workspace-menu"]').click();
    expect(await page.locator("#nz-workspace-menu").textContent()).not.toContain(
      "Add organization",
    );
    await page.keyboard.press("Escape");
    const api = await page.request.get(`${stack.consoleUrl}/api/v1/workspace/members`);
    expect(api.status()).toBe(403);
    // The policy reaches one project: the API lists only that one to the member.
    const listed = await page.request.get(`${stack.consoleUrl}/api/v1/projects`);
    const names = ((await listed.json()) as { projects: { name: string }[] }).projects.map(
      (project) => project.name,
    );
    expect(names).toEqual(["storefront"]);
  }, 60_000);

  test("the owner's settings: email, API keys, Agent policies and a workspace rename", async () => {
    const page = owner.pages()[0] as Page;
    // Invitation emails: a key that isn't a Resend key is refused under its field.
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/members`);
    await page.getByRole("button", { name: "Set up email" }).click();
    const email = page.locator("#nz-email-dialog");
    await email.locator("#nz-email-api-key").fill("not-a-resend-key");
    await email.locator("#nz-email-from").fill("Acme <team@example.com>");
    await email.getByRole("button", { name: "Save and send a test" }).click();
    await email.locator("#nz-email-api-key-error").waitFor({ state: "visible" });
    expect(await email.locator("#nz-email-api-key-error").textContent()).toContain("re_");
    await page.keyboard.press("Escape");

    // API keys: added, shown masked, then removed with a second click.
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/api-keys`);
    await page.locator("#nz-key-input-model").fill("sk-or-v1-0123456789abcdef");
    await page.locator('[data-key-card="model"]').getByRole("button", { name: "Add key" }).click();
    await toast(page, "Saved.");
    const card = page.locator('[data-key-card="model"]');
    await card.getByText("Added", { exact: true }).waitFor();
    expect(await card.locator(".nz-code").textContent()).toBe("sk-…cdef");
    expect(await page.content()).not.toContain("0123456789abcdef");
    const remove = card.getByRole("button", { name: "Remove" });
    await remove.click();
    await card.getByRole("button", { name: "Confirm remove" }).click();
    await toast(page, "Key removed");
    await card.getByText("Not added").waitFor();

    // Agent policies: the dependency, and production needs the typed phrase.
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings/agent-policies`);
    await page.getByLabel("Create and configure services").uncheck();
    // Rows show the policy names without their bracketed notes (spec 21.10).
    const importFromGit = page.getByLabel(/^Import from Git/);
    expect(await importFromGit.isChecked()).toBe(false);
    await importFromGit.check();
    expect(await page.getByLabel("Create and configure services").isChecked()).toBe(true);
    await page.getByLabel("Change production environments").check();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await page.locator("#nz-agent-production-phrase-error").waitFor({ state: "visible" });
    await page.locator("#nz-agent-production-phrase").fill("ALLOW PRODUCTION AGENT ACTIONS");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await toast(page, "Agent policies saved");
    await page.getByText(/Saved .* by Maya Lopez/).waitFor();
    expect(await page.getByLabel("Change production environments").isChecked()).toBe(true);

    // Rename: the address follows the new name, and the old one still leads here.
    await page.locator('[popovertarget="nz-workspace-menu"]').click();
    await page.getByRole("menuitem", { name: "Rename organization" }).click();
    await page.locator("#nz-rename-workspace-name").fill("Acme Labs");
    await page.getByRole("button", { name: "Save name" }).click();
    await page.waitForURL(/\/acme-labs\/dashboard\/settings\/agent-policies$/);
    await page.goto(`${stack.consoleUrl}/acme/dashboard/settings`);
    await page.waitForURL(/\/acme-labs\/dashboard\/settings$/);
    await page.locator('[popovertarget="nz-workspace-menu"]').click();
    await page.getByRole("menuitem", { name: "Rename organization" }).click();
    await page.locator("#nz-rename-workspace-name").fill("Acme");
    await page.getByRole("button", { name: "Save name" }).click();
    await page.waitForURL(/\/acme(-\d+)?\/dashboard\/settings$/);
  }, 90_000);

  test("two-factor sign-in needs a code, and a backup code works only once", async () => {
    const page = owner.pages()[0] as Page;
    await page.goto(`${stack.consoleUrl}/`);
    await page.waitForURL(/\/dashboard\/agent$/);
    await page.goto(`${stack.consoleUrl}/${slug(page)}/dashboard/profile`);
    await page.getByRole("button", { name: "Enable 2FA", exact: true }).click();
    const dialog = page.locator("#nz-2fa-enable");
    await dialog.locator("#nz-2fa-setup-password").fill(OWNER.password);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.locator("[data-2fa-secret]").waitFor({ state: "visible" });
    const secret = ((await dialog.locator("[data-2fa-secret]").textContent()) ?? "").trim();
    const codes = (await dialog.locator("[data-2fa-codes] li").allTextContents()).map((code) =>
      code.trim(),
    );
    expect(codes).toHaveLength(10);
    expect(codes[0]).toMatch(/^[a-z0-9]{5}-[a-z0-9]{5}$/i);
    expect(await dialog.locator("[data-2fa-qr]").getAttribute("src")).toStartWith(
      "data:image/svg+xml",
    );
    await dialog.locator("#nz-2fa-enable-code").fill(totp(secret));
    await dialog.getByRole("button", { name: "Enable 2FA" }).click();
    expect(await toast(page, "2FA configured successfully")).toContain(
      "2FA configured successfully",
    );

    const fresh = await newContext();
    const other = await fresh.newPage();
    await signIn(other, OWNER.email, OWNER.password);
    await other.locator("#nz-sign-in-code").waitFor();
    expect(new URL(other.url()).pathname).toBe("/sign-in");
    await other.fill("#nz-sign-in-code", codes[0] ?? "");
    await other.getByRole("button", { name: "Verify" }).click();
    await other.waitForURL(/\/dashboard\/agent$/);
    await fresh.close();

    const again = await newContext();
    const third = await again.newPage();
    await signIn(third, OWNER.email, OWNER.password);
    await third.locator("#nz-sign-in-code").waitFor();
    await third.fill("#nz-sign-in-code", codes[0] ?? "");
    await third.getByRole("button", { name: "Verify" }).click();
    await third.locator(".nz-inline-error").waitFor();
    expect(await third.locator(".nz-inline-error").textContent()).toContain(
      "That code is not valid. Try again.",
    );
    await again.close();

    // Manage → Regenerate shows ten new codes; the old ones stop working.
    await page.goto(`${stack.consoleUrl}/${slug(page)}/dashboard/profile`);
    await page.getByRole("button", { name: "Manage 2FA" }).click();
    const manage = page.locator("#nz-2fa-manage");
    await manage.locator("#nz-2fa-manage-password").fill(OWNER.password);
    await manage.getByRole("button", { name: "Continue" }).click();
    await manage.getByRole("button", { name: "Regenerate backup codes" }).click();
    await manage.locator('[data-2fa-step="codes"]').waitFor({ state: "visible" });
    const fresh2 = (await manage.locator('[data-2fa-step="codes"] li').allTextContents()).map(
      (code) => code.trim(),
    );
    expect(fresh2).toHaveLength(10);
    expect(fresh2).not.toContain(codes[1]);
    await manage.getByRole("button", { name: "Done" }).click();

    const fourth = await newContext();
    const last = await fourth.newPage();
    await signIn(last, OWNER.email, OWNER.password);
    await last.locator("#nz-sign-in-code").waitFor();
    await last.fill("#nz-sign-in-code", codes[1] ?? "");
    await last.getByRole("button", { name: "Verify" }).click();
    await last.locator(".nz-inline-error").waitFor();
    await last.fill("#nz-sign-in-code", fresh2[0] ?? "");
    await last.getByRole("button", { name: "Verify" }).click();
    await last.waitForURL(/\/dashboard\/agent$/);
    await fourth.close();
  }, 120_000);

  test("no page logged a script error or used a missing browser API", () => {
    expect(problems).toEqual([]);
  });
});
