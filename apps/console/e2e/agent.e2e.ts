import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { $, SQL } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { type AgentStack, startAgentStack } from "../test-support/agent-stack.ts";

/**
 * The Agent chat end to end (spec 19.3–19.9) against a real control plane and the scripted
 * model server (test-support/fake-model.ts; no real provider is called):
 * - a turn with three steps shows three rows in order with their targets, and the same after a
 *   reload;
 * - Stop mid-turn, and Retry on a failed turn;
 * - closing the page mid-turn and opening the session again replays, then follows live;
 * - the variables form saves straight to the service, and no stored message, model request or
 *   audit record holds the values;
 * - the permission card's "Allow and continue";
 * - a Git import with no provider: Connect links that come back to the chat's own address;
 * - attachments (a text file, a refused env file);
 * - renaming, moving (menu and drag) and deleting sessions;
 * - the phone slide-over.
 *
 *   bun test e2e/agent.e2e.ts             (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...      (uses the dev server instead)
 *
 * Needs the development PostgreSQL; uses ports 4250 and 4550 and a database named nz_m11b_….
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const SHOTS = resolve(CONSOLE_ROOT, "test-artifacts", "m11b");
const ADMIN_URL =
  process.env.NEARZERO_TEST_DATABASE_URL ??
  "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";

let agent: AgentStack;
let browser: Browser;
let page: Page;
let base = "";
let agentPath = "";
const problems: string[] = [];
const serverFailures: string[] = [];

function watch(target: Page): void {
  target.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() !== "error") return;
    // 4xx are expected refusals. A 5xx is the server failing (the shared development database
    // times out under load); it is counted and printed, while the page's own errors fail.
    if (/Failed to load resource: .*status of 5\d\d/.test(message.text())) {
      serverFailures.push(message.text());
      return;
    }
    if (!/status of 4\d\d/.test(message.text())) problems.push(`console error: ${message.text()}`);
  });
}

/** Opens the Agent page, trying again while the control plane is briefly unreachable. */
async function open(target: Page, path = agentPath): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await target
      .goto(`${base}${path}`, { waitUntil: "load", timeout: 120_000 })
      .catch(() => null);
    if (response && response.status() < 500 && (await target.locator(".nz-agent").count()) > 0) {
      return;
    }
    await target.waitForTimeout(3_000);
  }
  throw new Error(`The Agent page didn't load at ${path}.`);
}

async function newPage(
  width = 1440,
  theme = "dusk",
): Promise<{ context: BrowserContext; page: Page }> {
  const created = await browser.newContext({
    viewport: { width, height: width < 700 ? 812 : 900 },
  });
  await created.addInitScript(`(() => {
    for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
      try { delete owner[name]; } catch {}
    }
  })();`);
  await created.addCookies([
    { name: "nz_session", value: agent.owner.sessionToken(), url: base },
    { name: "nz_theme", value: theme, url: base },
  ]);
  const opened = await created.newPage();
  watch(opened);
  return { context: created, page: opened };
}

async function send(target: Page, text: string): Promise<void> {
  const box = target.locator("#nz-composer-input");
  await box.fill(text);
  await box.press("Enter");
}

async function lastTurnDone(target: Page, timeout = 120_000): Promise<void> {
  await target.locator(".nz-turn").last().locator(".nz-turn-foot").waitFor({ timeout });
}

function sessionIdOf(target: Page): string {
  const id = new URL(target.url()).searchParams.get("session");
  if (!id) throw new Error(`no session in ${target.url()}`);
  return id;
}

/** Every text column of the Agent's tables and the audit record (spec 19.8 acceptance). */
async function everythingStored(): Promise<string> {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${agent.stack.databaseName}`;
  const db = new SQL(url.toString());
  try {
    const parts: string[] = [];
    for (const table of [
      "agent_session",
      "agent_message",
      "agent_turn",
      "agent_event",
      "agent_model_item",
      "audit_event",
    ]) {
      const rows = (await db.unsafe(`select row_to_json(t)::text as row from ${table} t`)) as {
        row: string;
      }[];
      for (const row of rows) parts.push(row.row);
    }
    return parts.join("\n");
  } finally {
    await db.close();
  }
}

beforeAll(async () => {
  await mkdir(SHOTS, { recursive: true });
  const dev = process.env.E2E_CONSOLE === "dev";
  if (!dev) await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  agent = await startAgentStack({ console: dev ? "dev" : "built", label: "e2e" });
  base = agent.stack.consoleUrl;
  agentPath = `/${agent.workspace}/dashboard/agent`;
  browser = await chromium.launch();
  ({ page } = await newPage());
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await agent?.stop();
}, 300_000);

describe("the Agent chat", () => {
  test("a three-step turn shows three rows in order with targets, and the same after a reload", async () => {
    await open(page);
    await page.locator(".nz-greeting").waitFor();
    // The thinking line shows within 200ms of sending (spec 23.5), measured inside the page.
    await page.locator("#nz-composer-input").fill("Please do three steps for me");
    const shownAfter = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          const box = document.querySelector("#nz-composer-input") as HTMLTextAreaElement;
          const start = performance.now();
          const observer = new MutationObserver(() => {
            if (!document.querySelector(".nz-status")) return;
            observer.disconnect();
            done(performance.now() - start);
          });
          observer.observe(document.body, { childList: true, subtree: true });
          box.dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
          );
        }),
    );
    expect(shownAfter).toBeLessThan(200);
    expect(await page.locator(".nz-mark").count()).toBe(1);
    await lastTurnDone(page);
    const rows = await page.locator(".nz-action-row").allTextContents();
    expect(rows).toEqual([
      "Listed projects1 project",
      "Listed servers1 server",
      "Read projectShop",
    ]);
    const order = await page
      .locator(".nz-answer > *")
      .evaluateAll((nodes) => nodes.map((node) => node.className.split(" ")[0]));
    expect(order.indexOf("nz-answer-text")).toBeLessThan(order.indexOf("nz-action"));
    expect(order.lastIndexOf("nz-answer-text")).toBeGreaterThan(order.lastIndexOf("nz-action"));
    const footer = await page.locator(".nz-turn-footer").last().textContent();
    expect(footer).toMatch(/^Worked for \d+s · 3 steps$/);
    expect(await page.locator(".nz-turn-actions button", { hasText: "Retry" }).count()).toBe(0);
    expect(await page.locator(".nz-turn-actions button", { hasText: "Edit" }).count()).toBe(1);
    await page.waitForTimeout(400);
    expect(await page.locator(".nz-mark").count()).toBe(0);
    await page.locator(".nz-md-table table").waitFor();
    await page.locator(".nz-suggested").waitFor({ timeout: 15_000 });
    await page.screenshot({ path: resolve(SHOTS, "e2e-three-steps.png") });

    await open(page, `${agentPath}?session=${sessionIdOf(page)}`);
    await page.locator(".nz-action-row").first().waitFor();
    expect(await page.locator(".nz-action-row").allTextContents()).toEqual(rows);
    expect(await page.locator(".nz-turn-footer").last().textContent()).toBe(footer);
    expect(rows.join(" ")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  }, 300_000);

  test("Stop ends a running answer; a failed one offers Retry", async () => {
    await open(page);
    await send(page, "Give me a slow answer");
    await page.locator(".nz-answer-text").nth(1).waitFor({ timeout: 90_000 });
    await page.locator("[data-stop]").click();
    await lastTurnDone(page, 90_000);
    expect(await page.locator(".nz-turn-footer").last().textContent()).toMatch(
      /^Stopped after \d+s$/,
    );
    expect(await page.locator(".nz-turn-actions button", { hasText: "Retry" }).count()).toBe(1);

    await open(page);
    await send(page, "This one is broken");
    await page.locator(".nz-answer-error").waitFor({ timeout: 90_000 });
    await lastTurnDone(page);
    expect(await page.locator(".nz-turn-actions button", { hasText: "Retry" }).count()).toBe(1);
    // Errors stay red after a reload.
    await open(page, `${agentPath}?session=${sessionIdOf(page)}`);
    await page.locator(".nz-answer-error").waitFor();
  }, 300_000);

  test("closing the page mid-turn and opening the session again replays, then follows live", async () => {
    const first = await newPage();
    await open(first.page);
    await send(first.page, "Another slow answer please");
    await first.page.locator(".nz-answer-text").nth(1).waitFor({ timeout: 90_000 });
    const sessionId = sessionIdOf(first.page);
    const before = (await first.page.locator(".nz-answer-text").nth(1).textContent()) ?? "";
    await first.context.close();

    const second = await newPage();
    await open(second.page, `${agentPath}?session=${sessionId}`);
    const text = second.page.locator(".nz-answer-text").nth(1);
    await text.waitFor();
    expect(((await text.textContent()) ?? "").startsWith(before.slice(0, 30))).toBe(true);
    await second.page.locator(".nz-status").waitFor();
    const replayed = ((await text.textContent()) ?? "").length;
    await second.page.waitForFunction(
      (count) =>
        (document.querySelectorAll(".nz-answer-text")[1]?.textContent ?? "").length > count + 40,
      replayed,
      { timeout: 60_000 },
    );
    await second.page.screenshot({ path: resolve(SHOTS, "e2e-rejoined.png") });
    await second.page.locator("[data-stop]").click();
    await lastTurnDone(second.page, 90_000);
    await second.context.close();
  }, 300_000);

  test("the variables form saves to the service and no stored message holds the values", async () => {
    await open(page);
    await send(page, "Set the variables for web");
    const form = page.locator(".nz-chatform-card", { hasText: "Variables for web" });
    await form.waitFor({ timeout: 90_000 });
    expect(await page.locator(".nz-status-label").textContent()).toBe("Waiting for the variables");
    const values = form.locator(".nz-chatvar-value");
    expect(await values.first().getAttribute("type")).toBe("password");
    // A pasted env file fills the rows and reports by line number only.
    await values.first().focus();
    await page.evaluate(() => {
      const target = document.activeElement as HTMLInputElement;
      const data = new DataTransfer();
      data.setData(
        "text",
        "DATABASE_URL=postgres://u:MARKER-PASTED-7731@db/app\nbroken line\nEXTRA_FLAG=on\n",
      );
      target.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    });
    await form.locator(".nz-inline-note").waitFor();
    expect(await form.locator(".nz-inline-note").textContent()).toBe(
      "Filled 1 value and added 1 variable from the paste. Skipped line 2: not one-line NAME=value.",
    );
    await values.nth(1).fill("tok-MARKER-TYPED-5512");
    expect(await form.locator(".nz-chatvar-counter").textContent()).toBe("3 of 3 set");
    await form.locator("button", { hasText: "Show values" }).click();
    expect(await values.first().getAttribute("type")).toBe("text");
    await page.screenshot({ path: resolve(SHOTS, "e2e-variables-form.png") });
    await form.locator("button", { hasText: "Save 3 variables" }).click();
    await page
      .locator(".nz-chatform-done", { hasText: "Saved 3 variables" })
      .waitFor({ timeout: 90_000 });
    await lastTurnDone(page);

    const saved = await agent.owner.call<{ own: { variables: { name: string }[] } }>(
      "GET",
      `/services/${agent.serviceId}/variables`,
    );
    expect(saved.own.variables.map((variable) => variable.name).sort()).toEqual([
      "API_TOKEN",
      "DATABASE_URL",
      "EXTRA_FLAG",
    ]);
    const stored = await everythingStored();
    expect(stored).toContain("DATABASE_URL");
    for (const marker of ["MARKER-PASTED-7731", "MARKER-TYPED-5512"]) {
      expect(stored).not.toContain(marker);
      expect(agent.model.allText()).not.toContain(marker);
    }
    // The page forgot them too.
    expect(await page.content()).not.toContain("MARKER-");
  }, 300_000);

  test("the permission card: Allow and continue", async () => {
    await open(page);
    await send(page, "Please list my keys");
    const card = page.locator(".nz-permission");
    await card.waitFor({ timeout: 90_000 });
    await lastTurnDone(page);
    expect(await page.locator(".nz-action-chip--needs_permission").count()).toBe(1);
    expect(await card.textContent()).toContain("Read SSH keys");
    await page.screenshot({ path: resolve(SHOTS, "e2e-permission-card.png") });
    await card.locator("button", { hasText: "Allow and continue" }).click();
    await page
      .locator(".nz-bubble", { hasText: 'Allowed "Read SSH keys". Please continue.' })
      .waitFor();
    await card.locator(".nz-chatform-done", { hasText: "Allowed" }).waitFor();
    await lastTurnDone(page);
    expect(await page.locator(".nz-turn").last().textContent()).toContain(
      "You have no SSH keys yet.",
    );
    const policies = await agent.owner.call<{ switches: Record<string, boolean> }>(
      "GET",
      "/workspace/agent-policies",
    );
    expect(policies.switches["ssh-keys.read"]).toBe(true);
  }, 300_000);

  test("a Git import without a provider shows Connect links that come back to this chat", async () => {
    await open(page);
    await page.locator(".nz-starter", { hasText: "Deploy a Git repository" }).click();
    const links = page.locator(".nz-picker a.nz-picker-option");
    await links.first().waitFor({ timeout: 90_000 });
    expect(await links.allTextContents()).toEqual([
      "Connect GitHub",
      "Connect GitLab",
      "Connect Bitbucket",
      "Connect Gitea",
    ]);
    const sessionId = sessionIdOf(page);
    const href = (await links.first().getAttribute("href")) ?? "";
    expect(href).toStartWith(`/${agent.workspace}/dashboard/settings/git-providers?connect=github`);
    const back = new URL(href, base).searchParams.get("return");
    expect(back).toBe(`${agentPath}?session=${sessionId}`);
    // The chat's own address opens that chat, still waiting on the Connect form.
    const other = await newPage();
    await open(other.page, back as string);
    await other.page.locator(".nz-picker a.nz-picker-option").first().waitFor();
    expect(
      await other.page
        .locator('.nz-sessions--column .nz-session-row[aria-current="page"]')
        .evaluate((row) => row.closest(".nz-session")?.getAttribute("data-session")),
    ).toBe(sessionId);
    expect(await other.page.locator(".nz-bubble").first().textContent()).toBe(
      "Deploy a Git repository",
    );
    await other.context.close();
  }, 300_000);

  test("attachments: a text file uploads, an env file is refused with its reason", async () => {
    await open(page);
    const input = page.locator(".nz-composer input[type=file]");
    await input.setInputFiles([
      { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Deploy notes\n") },
      { name: ".env", mimeType: "text/plain", buffer: Buffer.from("SECRET=1\n") },
    ]);
    await page.locator('.nz-attach-chip[data-state="done"]').waitFor({ timeout: 20_000 });
    const refused = page.locator('.nz-attach-chip[data-state="failed"]');
    expect(await refused.getAttribute("title")).toContain("Env files can hold secrets");
    await refused.locator("button").click();
    await send(page, "What do these notes say?");
    await page.locator(".nz-question .nz-file-chip", { hasText: "notes.txt" }).waitFor();
    await lastTurnDone(page);
  }, 300_000);

  test("sessions: rename, move, drag and delete", async () => {
    await open(page);
    const list = page.locator(".nz-sessions--column .nz-session-items").first();
    const rows = list.locator(":scope > .nz-session");
    const ids = async () =>
      rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-session")));
    const before = await ids();
    expect(before.length).toBeGreaterThanOrEqual(5);

    // Rename by double-click: the name opens selected; Enter saves; empty is refused.
    const first = rows.first();
    await first.locator(".nz-session-link").dblclick();
    const field = first.locator(".nz-session-rename input");
    await field.fill("");
    await field.press("Enter");
    expect(await first.locator(".nz-field-error").textContent()).toBe(
      "Enter a name for the session.",
    );
    await field.fill("Renamed in the browser");
    await field.press("Enter");
    await first.locator(".nz-session-title", { hasText: "Renamed in the browser" }).waitFor();
    const listed = await agent.owner.call<{ sessions: { id: string; title: string }[] }>(
      "GET",
      "/agent/sessions",
    );
    expect(listed.sessions[0]?.title).toBe("Renamed in the browser");

    // Move down from the ⋯ menu.
    await first.hover();
    await first.locator(".nz-session-more").click();
    const moved = page.waitForResponse((response) =>
      response.url().endsWith("/agent/sessions/order"),
    );
    await page.locator(".nz-session-menu [role=menuitem]", { hasText: "Move down" }).click();
    expect((await moved).status()).toBe(200);
    await page.waitForFunction(
      (id) =>
        document
          .querySelectorAll(".nz-sessions--column .nz-session-items")[0]
          ?.children[1]?.getAttribute("data-session") === id,
      before[0],
    );
    const afterMove = await agent.owner.call<{ sessions: { id: string }[] }>(
      "GET",
      "/agent/sessions",
    );
    expect(afterMove.sessions.slice(0, 2).map((session) => session.id)).toEqual([
      before[1] as string,
      before[0] as string,
    ]);

    // Drag the last row to the top; Escape during a drag puts it back.
    const current = await ids();
    const lastRow = rows.last().locator(".nz-session-row");
    const box = (await lastRow.boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const topBox = (await rows.first().boundingBox()) as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2 - 2);
    await page.mouse.move(box.x + 60, topBox.y + 2, { steps: 8 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    expect(await ids()).toEqual(current);
    await page.mouse.move(box.x + 60, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2 - 2);
    await page.mouse.move(box.x + 60, topBox.y + 2, { steps: 8 });
    const dragged = page.waitForResponse((response) =>
      response.url().endsWith("/agent/sessions/order"),
    );
    await page.mouse.up();
    expect((await dragged).status()).toBe(200);
    await page.waitForFunction(
      (id) =>
        document
          .querySelector(".nz-sessions--column .nz-session-items > .nz-session")
          ?.getAttribute("data-session") === id,
      current.at(-1),
    );
    const afterDrag = await agent.owner.call<{ sessions: { id: string }[] }>(
      "GET",
      "/agent/sessions",
    );
    expect(afterDrag.sessions[0]?.id).toBe(current.at(-1) as string);

    // Delete with the inline confirm.
    const victim = rows.nth(1);
    const victimId = await victim.getAttribute("data-session");
    const title = (await victim.locator(".nz-session-title").textContent()) ?? "";
    await victim.hover();
    await victim.locator(".nz-session-more").click();
    await page.locator(".nz-session-menu [role=menuitem]", { hasText: "Delete…" }).click();
    expect(await victim.locator(".nz-session-confirm p").textContent()).toBe(
      `Delete "${title}"? Its messages and files are deleted. This can't be undone.`,
    );
    await victim.locator(".nz-session-confirm button", { hasText: "Delete" }).click();
    await page
      .locator(`.nz-sessions--column [data-session="${victimId}"]`)
      .waitFor({ state: "detached" });
    const afterDelete = await agent.owner.call<{ sessions: { id: string }[] }>(
      "GET",
      "/agent/sessions",
    );
    expect(afterDelete.sessions.some((session) => session.id === victimId)).toBe(false);
  }, 300_000);

  test("phones: the list slides over the chat and picking a session closes it", async () => {
    const phone = await newPage(375);
    await open(phone.page);
    expect(await phone.page.locator(".nz-secondary--sessions").isVisible()).toBe(false);
    await phone.page.locator(".nz-chat-bar button", { hasText: "Chat history" }).click();
    const layer = phone.page.locator(".nz-sheet-layer");
    await phone.page.waitForFunction(
      () => document.querySelector(".nz-sheet-layer")?.getAttribute("data-open") === "true",
    );
    await phone.page.waitForTimeout(260);
    const panel = (await phone.page.locator(".nz-sheet-panel").boundingBox()) as { width: number };
    expect(panel.width).toBeLessThanOrEqual(Math.min(288, 375 * 0.85) + 1);
    await phone.page.screenshot({ path: resolve(SHOTS, "e2e-phone-history.png") });
    await phone.page.mouse.click(360, 400);
    expect(await layer.getAttribute("data-open")).toBe("false");
    await phone.page.locator(".nz-chat-bar button", { hasText: "Chat history" }).click();
    await phone.page.locator(".nz-sheet-panel .nz-session-link").first().click();
    expect(await layer.getAttribute("data-open")).toBe("false");
    await phone.page.locator(".nz-turn").first().waitFor();
    const width = await phone.page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(width[0]).toBeLessThanOrEqual((width[1] as number) + 1);
    await phone.context.close();
  }, 300_000);

  test("no script or console errors along the way", () => {
    if (serverFailures.length > 0) {
      console.log(`${serverFailures.length} request(s) failed on the server side during the run.`);
    }
    expect(problems).toEqual([]);
  });
});
