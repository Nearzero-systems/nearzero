import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { $ } from "bun";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { connectFakeHost, type FakeHost, handoffFolder } from "../test-support/fake-runner-link.ts";
import { ApiSession, type Stack, startStack } from "../test-support/stack.ts";

/**
 * The project area end to end (spec 05, 06 6.1, 08 8.1–8.2): the owner creates a project, adds
 * an environment, renames it, is refused "prod", deletes it; adds production, then a Postgres
 * database whose copy in production has its own password and port; reveals the password; edits
 * the service's and the environment's variables with comments and sees "(its own wins)"; is
 * blocked by a name set twice; deletes the service with its copy; deletes the project. The
 * Nearzero host is a pretend runner over the real WebSocket (test-support/fake-runner-link.ts),
 * so the database's first deploy finishes and deleting it reaches its server.
 *
 *   bun test e2e/projects.e2e.ts            (builds the console and runs the production build)
 *   E2E_CONSOLE=dev bun test e2e/...        (uses the dev server instead)
 *
 * Needs the development PostgreSQL (docker-compose.dev.yml); uses ports 4150 and 4450.
 */

const CONSOLE_ROOT = resolve(import.meta.dir, "..");
const OWNER = { email: "owner@example.com", password: "owner-password-1" };
const INSECURE_CONTEXT = `(() => {
  for (const [owner, name] of [[Crypto.prototype, "randomUUID"], [Crypto.prototype, "subtle"], [Navigator.prototype, "clipboard"]]) {
    try { delete owner[name]; } catch {}
  }
})();`;

let stack: Stack;
let host: FakeHost | undefined;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let api: ApiSession;
const problems: string[] = [];

function watch(target: Page): void {
  target.on("request", (request) => {
    const url = new URL(request.url());
    for (const name of ["password", "rootPassword", "confirm", "text", "value"]) {
      if (url.searchParams.has(name)) problems.push(`${name} in an address: ${url.pathname}`);
    }
  });
  target.on("pageerror", (error) => problems.push(`script error: ${error.message}`));
  target.on("console", (message) => {
    if (message.type() === "error" && !/status of (4\d\d)/.test(message.text())) {
      problems.push(`console error: ${message.text()}`);
    }
  });
}

async function toast(text: string | RegExp): Promise<string> {
  const match = page.locator(".nz-toast", { hasText: text }).last();
  await match.waitFor({ timeout: 15_000 });
  return ((await match.textContent()) ?? "").trim();
}

/** /<ws>/dashboard/projects/<project>/<environment>/… → the ids in the address. */
function idsOf(url: string): { project: string; environment: string; service?: string } {
  const parts = new URL(url).pathname.split("/");
  return { project: parts[4] ?? "", environment: parts[5] ?? "", service: parts[7] };
}

async function openEnvironmentMenu(): Promise<void> {
  await page.locator('[popovertarget="nz-environment-menu"]').click();
  await page.locator("#nz-environment-menu").waitFor({ state: "visible" });
}

/** Pastes text into an element the way a browser does (a ClipboardEvent with its data). */
async function paste(selector: string, text: string): Promise<void> {
  await page
    .locator(selector)
    .first()
    .evaluate((element, value) => {
      const data = new DataTransfer();
      data.setData("text/plain", value);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, text);
}

beforeAll(async () => {
  if (process.env.E2E_CONSOLE !== "dev") {
    await $`bun run build`.cwd(CONSOLE_ROOT).quiet();
  }
  const handoff = await handoffFolder("e2e");
  stack = await startStack({
    console: process.env.E2E_CONSOLE === "dev" ? "dev" : "built",
    label: "e2e",
    env: {
      NEARZERO_RUNNER_HANDOFF_DIR: handoff,
      // The host's public address, as an install knows it, so a database has a public URL (8.2).
      NEARZERO_PUBLIC_IP: "203.0.113.10",
    },
  });
  await stack.createOwner(OWNER.email, OWNER.password);
  host = await connectFakeHost(stack.controlUrl, handoff);
  // Onboarding is the people flow's business (people.e2e.ts); here it is done through the API.
  api = await ApiSession.signIn(stack.consoleUrl, OWNER.email, OWNER.password);
  await api.call("POST", "/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await api.call("POST", "/onboarding/skip-invitations");
  browser = await chromium.launch();
  context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(INSECURE_CONTEXT);
  await context.addCookies([
    { name: "nz_session", value: api.sessionToken(), url: stack.consoleUrl },
    { name: "nz_theme", value: "dusk", url: stack.consoleUrl },
  ]);
  page = await context.newPage();
  watch(page);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await host?.close();
  await stack?.stop();
});

describe("projects, environments, services and variables, end to end", () => {
  let project = "";
  let development = "";

  test("the owner creates a project and lands in its development environment", async () => {
    await page.goto(`${stack.consoleUrl}/acme/dashboard/projects`);
    await page.locator("text=No projects found").first().waitFor();
    await page.getByRole("button", { name: "Create project" }).first().click();
    await page.fill("#nz-project-name", "storefront");
    await page.fill("#nz-project-description", "The shop and its database.");
    await page
      .locator("#nz-create-project")
      .getByRole("button", { name: "Create project" })
      .click();
    await page.waitForURL(/\/projects\/[^/]+\/[^/]+\/overview$/);
    expect(await toast("Project created")).toContain("Project created");
    ({ project, environment: development } = idsOf(page.url()));
    expect(await page.locator(".nz-crumb", { hasText: "development" }).count()).toBe(1);
    await page.locator("text=No active services").waitFor();
  }, 90_000);

  test("a public repository whose branch can't be looked up continues with main (B3-29, spec 6.1)", async () => {
    const overview = page.url();
    await page.goto(overview.replace(/\/overview$/, "/new-application"));
    const url = page.locator("#nz-app-repo-url");
    await url.waitFor();
    // An address that isn't a repository URL still stays on this step.
    await url.fill("not a url");
    await page.locator("[data-app-public-url]").getByRole("button", { name: "Continue" }).click();
    await page.locator("[data-app-public-url] [data-field-error]:not([hidden])").waitFor();
    // A host that can't be asked (here one that doesn't exist): main, editable, and a note.
    await url.fill("https://git.invalid/acme/web");
    await page.locator("[data-app-public-url]").getByRole("button", { name: "Continue" }).click();
    const configure = page.locator("[data-app-configure]");
    await configure.waitFor({ state: "visible", timeout: 20_000 });
    expect(await configure.locator("#nz-app-branch").inputValue()).toBe("main");
    expect(await configure.locator("#nz-app-branch").isEditable()).toBe(true);
    expect(await configure.locator("[data-branch-note]").textContent()).toBe(
      "The default branch couldn't be looked up, so the branch is main. Change it if the repository uses another.",
    );
    expect(await configure.locator("#nz-app-repo").inputValue()).toBe(
      "https://git.invalid/acme/web",
    );
    await page.goto(overview);
  }, 60_000);

  test("an environment is added with the live hint, renamed, refused as prod, and deleted", async () => {
    await openEnvironmentMenu();
    await page.getByRole("menuitem", { name: "Add environment" }).click();
    const add = page.locator("#nz-env-add");
    await add.locator("#nz-env-add-name").fill("QA Team");
    expect(await add.locator("[data-env-hint]").textContent()).toBe("It will be called qa-team.");
    await add.locator("#nz-env-add-name").fill("prod");
    expect(await add.locator("[data-env-hint]").textContent()).toContain(
      'Name it "production" instead',
    );
    await add.getByRole("button", { name: "Create environment" }).click();
    expect(await add.evaluate((dialog: HTMLDialogElement) => dialog.open)).toBe(true);
    await add.locator("#nz-env-add-name").fill("development");
    expect(await add.locator("[data-env-hint]").textContent()).toBe(
      'This project already has an environment called "development".',
    );
    await add.locator("#nz-env-add-name").fill("QA Team");
    await add.getByRole("button", { name: "Create environment" }).click();
    expect(await toast("Created qa-team")).toContain("Created qa-team");
    await page.waitForURL((url) => idsOf(url.toString()).environment !== development);
    await page.locator(".nz-crumb", { hasText: "qa-team" }).waitFor();

    await openEnvironmentMenu();
    await page.getByRole("menuitem", { name: "Rename qa-team" }).click();
    const rename = page.locator("#nz-env-rename");
    await rename.locator("#nz-env-rename-name").fill("Staging");
    expect(await rename.locator("[data-env-hint]").textContent()).toBe(
      "It will be called staging.",
    );
    await rename.getByRole("button", { name: "Rename environment" }).click();
    expect(await toast("Renamed to staging")).toContain("Renamed to staging");
    await page.locator(".nz-crumb", { hasText: "staging" }).waitFor();

    await openEnvironmentMenu();
    await page.getByRole("menuitem", { name: "Delete staging" }).click();
    const remove = page.locator("#nz-env-delete");
    const submit = remove.getByRole("button", { name: "Delete environment" });
    expect(await submit.isDisabled()).toBe(true);
    await remove.locator("#nz-env-delete-confirm").fill("staging");
    await submit.click();
    expect(await toast("Deleted staging")).toContain("Deleted staging");
    await page.waitForURL((url) => idsOf(url.toString()).environment === development);

    // A production environment, so the database below gets a copy there.
    await openEnvironmentMenu();
    await page.getByRole("menuitem", { name: "Add environment" }).click();
    await page.locator("#nz-env-add-name").fill("production");
    expect(await page.locator("#nz-env-add [data-env-hint]").textContent()).toBe(
      "This is your production environment.",
    );
    await page.locator("#nz-env-add").getByRole("button", { name: "Create environment" }).click();
    await toast("Created production");
    await page.locator(".nz-badge--prod").first().waitFor();
    await page.goto(
      `${stack.consoleUrl}/acme/dashboard/projects/${project}/${development}/overview`,
    );
  }, 120_000);

  let database = "";
  let developmentPort = "";
  let developmentPassword = "";

  test("a Postgres database is added, says where else it went, and its page opens", async () => {
    await page.getByRole("button", { name: "Add New" }).click();
    await page.getByRole("menuitem", { name: "Database" }).click();
    const dialog = page.locator("#nz-database-create");
    expect(await dialog.locator('input[name="kind"][value="postgres"]').isChecked()).toBe(true);
    // The type's defaults show as placeholders, never "true" (B3-04, spec 8.1).
    const placeholders = async () => [
      await dialog.locator("#nz-db-database").getAttribute("placeholder"),
      await dialog.locator("#nz-db-user").getAttribute("placeholder"),
    ];
    expect(await placeholders()).toEqual(["Default postgres", "Default postgres"]);
    await dialog.locator('label:has(input[name="kind"][value="mysql"])').click();
    expect(await placeholders()).toEqual(["Default app", "Default mysql"]);
    await dialog.locator('label:has(input[name="kind"][value="postgres"])').click();
    expect(await placeholders()).toEqual(["Default postgres", "Default postgres"]);
    await dialog.locator("#nz-db-name").fill("db");
    expect(await dialog.locator("#nz-db-app-name").inputValue()).toBe("storefront-db");
    expect(await dialog.locator("#nz-db-root-password").isHidden()).toBe(true);
    await dialog.locator("#nz-db-password").fill("has a space");
    await dialog.getByRole("button", { name: "Create database" }).click();
    expect(
      await dialog.locator("[data-field-error]:not([hidden])").first().textContent(),
    ).toContain("Leave out");
    await dialog.locator("#nz-db-password").fill("");
    await dialog.getByRole("button", { name: "Create database" }).click();
    expect(await toast("Also added to production")).toContain(
      "Also added to production, not deployed yet. Each environment has its own variables and URL.",
    );
    // The console starts the first deploy and opens the database's page (spec 08 8.1).
    expect(await toast("Deployment started")).toContain("Deployment started");
    await page.waitForURL(/\/services\/[^/]+$/);
    database = idsOf(page.url()).service ?? "";
    // The page follows the deploy and refreshes when it ends: the database is then running.
    await page
      .locator(".nz-fact", { hasText: "Status" })
      .locator("span", { hasText: /^Running$/ })
      .waitFor({ timeout: 60_000 });
    await page.locator("[data-connection]").waitFor();
    expect(
      await page.locator("text=Works once the database is deployed and running.").count(),
    ).toBe(0);
    developmentPort =
      (await page
        .locator(".nz-fact", { hasText: "External port" })
        .locator("span")
        .last()
        .textContent()) ?? "";
    expect(Number(developmentPort)).toBeGreaterThanOrEqual(20000);
    // The original's type name (B3-21), and no Deploy while it runs (B3-22, spec 8.2).
    expect(
      await page.locator(".nz-fact", { hasText: "Type" }).locator("span").last().textContent(),
    ).toBe("Postgres");
    expect(
      await page
        .locator('[data-service-action="deploy"], [data-service-action="redeploy"]')
        .count(),
    ).toBe(0);
    expect(await page.locator('[data-service-action="stop"]').count()).toBe(1);
  }, 120_000);

  test("Show password reveals it in the rows and URLs, percent-encoded", async () => {
    const card = page.locator("[data-connection]");
    expect(await card.locator('[data-conn-secret="password"]').textContent()).toBe("••••••••");
    await card.getByRole("button", { name: "Show password" }).first().click();
    await card.locator('[data-conn-reveal][aria-pressed="true"]').first().waitFor();
    developmentPassword = (await card.locator('[data-conn-secret="password"]').textContent()) ?? "";
    expect(developmentPassword).toMatch(/^[A-Za-z0-9]{24}$/);
    const internal = (await card.locator('[data-conn-url="internal"]').textContent()) ?? "";
    expect(internal).toMatch(
      new RegExp(
        `^postgresql://postgres:${developmentPassword}@storefront-db-[a-z0-9]{6}:5432/postgres$`,
      ),
    );
    const outside = (await card.locator('[data-conn-url="public"]').textContent()) ?? "";
    expect(outside).toContain(`:${developmentPort}/postgres`);
    await card.getByRole("button", { name: "Copy internal URL" }).click();
    expect(await toast("Copied to clipboard")).toContain("Copied");
  }, 60_000);

  test("the copy in production has its own password and public port", async () => {
    await openEnvironmentMenu();
    await page.getByRole("menuitemradio", { name: "production" }).click();
    await page.waitForURL(/\/overview$/);
    await page
      .locator(".nz-service-row", { hasText: "db" })
      .getByRole("link", { name: "db" })
      .click();
    await page.waitForURL(/\/services\/[^/]+$/);
    expect(idsOf(page.url()).service).not.toBe(database);
    // Copies are never deployed automatically (spec 05 5.4).
    await page.locator("text=Works once the database is deployed and running.").waitFor();
    const port =
      (await page
        .locator(".nz-fact", { hasText: "External port" })
        .locator("span")
        .last()
        .textContent()) ?? "";
    expect(Number(port)).toBeGreaterThanOrEqual(20000);
    expect(port).not.toBe(developmentPort);
    await page
      .locator("[data-connection]")
      .getByRole("button", { name: "Show password" })
      .first()
      .click();
    await page.locator('[data-conn-reveal][aria-pressed="true"]').first().waitFor();
    const password = (await page.locator('[data-conn-secret="password"]').textContent()) ?? "";
    expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(password).not.toBe(developmentPassword);
  }, 60_000);

  const OWN =
    "# The API this service calls\nAPI_URL=https://own.example.com\n\n# Kept as written\nRETRIES=3\n";
  const SHARED = "# Shared by every service\nAPI_URL=https://shared.example.com\nLOG_LEVEL=info\n";

  test("the service's own variables keep their comments byte for byte; pasting merges rows", async () => {
    await page.goto(
      `${stack.consoleUrl}/acme/dashboard/projects/${project}/${development}/services/${database}/variables`,
    );
    const own = page.locator(`#nz-own-variables-${database}`);
    await own.locator("text=No variables of its own yet.").waitFor();
    await own.getByRole("button", { name: "Add variable" }).click();
    await own.locator("[data-row-name]").first().waitFor();
    // Pasting an env file into a box fills the rows.
    await paste(
      `#nz-own-variables-${database} [data-row-name]`,
      "FIRST=1\n# note\nSECOND=2\nnot a line\n",
    );
    await own.locator("text=Added 2 variables and updated 0 from the paste.").waitFor();
    await own.locator("text=Left out line 4: not one-line NAME=value.").waitFor();
    await own.locator("text=Comments in the paste were left out.").waitFor();
    expect(await own.locator("[data-row-name]").count()).toBe(2);

    await own.getByRole("button", { name: "Edit as .env" }).click();
    await own.locator("[data-vars-text]").fill(OWN);
    await own.getByRole("button", { name: "Save variables" }).click();
    expect(await toast("Variables saved")).toContain("They reach the service on its next deploy.");
    await page.locator(`#nz-own-variables-${database} [data-var-name="RETRIES"]`).waitFor();

    await page
      .locator(`#nz-own-variables-${database}`)
      .getByRole("button", { name: "Edit" })
      .click();
    const editor = page.locator(`#nz-own-variables-${database}`);
    await editor
      .locator("text=Comments are kept as they are. To change them, use Edit as .env.")
      .waitFor();
    await editor.getByRole("button", { name: "Edit as .env" }).click();
    expect(await editor.locator("[data-vars-text]").inputValue()).toBe(OWN);

    // A name set twice blocks saving, with its lines.
    await editor.locator("[data-vars-text]").fill("A=1\nA=2\n");
    await editor.getByRole("button", { name: "Save variables" }).click();
    await editor.locator("text=A is set twice, on lines 1 and 2. Keep one.").waitFor();
    await editor.getByRole("button", { name: "Cancel" }).click();
  }, 90_000);

  test("shared variables are edited on their page and the service's own API_URL wins", async () => {
    await page.goto(
      `${stack.consoleUrl}/acme/dashboard/projects/${project}/${development}/variables`,
    );
    await page
      .locator("text=Every service in development gets these on each deploy.")
      .first()
      .waitFor();
    const shared = page.locator("#nz-shared-variables");
    await shared.getByRole("button", { name: "Add variable" }).click();
    await shared.getByRole("button", { name: "Edit as .env" }).click();
    await shared.locator("[data-vars-text]").fill(SHARED);
    await shared.getByRole("button", { name: "Save variables" }).click();
    await toast("Variables saved");
    await page.locator('#nz-shared-variables [data-var-name="LOG_LEVEL"]').waitFor();
    await page.locator(".nz-var-row", { hasText: "db" }).getByRole("link").click();
    await page.waitForURL(/\/variables$/);
    const inherited = page.locator(`#nz-shared-of-${database}`);
    expect(await inherited.locator('[data-var-name="API_URL"]').textContent()).toContain(
      "(its own wins)",
    );
    expect(await inherited.locator('[data-var-name="LOG_LEVEL"]').textContent()).not.toContain(
      "(its own wins)",
    );
  }, 60_000);

  test("the service is deleted together with its copy in production", async () => {
    await page.goto(
      `${stack.consoleUrl}/acme/dashboard/projects/${project}/${development}/services/${database}/settings`,
    );
    // Delete service sits in the Danger zone, the last fold of Settings, closed (spec 21.10).
    await page.locator("#nz-danger > summary").click();
    await page.getByRole("button", { name: "Delete service" }).click();
    const dialog = page.locator("#nz-service-delete");
    await dialog.locator("text=The same service in other environments").waitFor();
    const copy = dialog.locator("label", { hasText: "production (db)" }).locator("input");
    expect(await copy.isChecked()).toBe(false);
    await copy.check();
    await dialog.locator("#nz-sd-confirm").fill("db");
    await dialog.getByRole("button", { name: "Delete service" }).click();
    expect(await toast(/services? removed/)).toMatch(/2 services removed|Service removed/);
    await page.waitForURL(/\/services$/);
    await page.locator("text=No services yet").waitFor();
    const api = (await (
      await page.request.get(`${stack.consoleUrl}/api/v1/projects/${project}`)
    ).json()) as { project: { serviceCount: number } };
    expect(api.project.serviceCount).toBe(0);
  }, 90_000);

  test("an image app's deploy webhook: Create and Replace keep the fold open, in a registry's words (C3-03, C3-04)", async () => {
    const created = await api.call<{ service: { id: string } }>(
      "POST",
      `/environments/${development}/services`,
      {
        serverId: "host",
        kind: "application",
        name: "imaged",
        settings: { image: "nginx:alpine", servicePort: 80 },
      },
    );
    const back = page.url();
    await page.goto(
      `${stack.consoleUrl}/acme/dashboard/projects/${project}/${development}/services/${created.service.id}/settings`,
    );
    const fold = page.locator("#nz-deploy-settings");
    await fold.locator("summary").click();
    const open = () => fold.evaluate((element) => (element as HTMLDetailsElement).open);
    expect(await open()).toBe(true);
    const card = fold.locator("[data-webhook]");
    expect(await card.textContent()).toContain(
      "Create one for your registry to call when a new image is pushed.",
    );
    expect(await card.textContent()).not.toContain("when you push.");
    await card.getByRole("button", { name: "Create URL" }).click();
    await toast(/Webhook URL/);
    // The page is drawn again with the fold as the person left it, showing the new URL.
    await fold.locator("[data-webhook-url]").waitFor({ state: "visible", timeout: 15_000 });
    expect(await open()).toBe(true);
    const first = await fold.locator("[data-webhook-url]").getAttribute("data-url");
    await fold.getByRole("button", { name: "Replace URL" }).click();
    const dialog = page.locator("#nz-replace-webhook");
    await dialog.waitFor({ state: "visible" });
    expect(await dialog.textContent()).toContain("like your registry's webhook settings.");
    await dialog.getByRole("button", { name: "Replace URL" }).click();
    await toast(/Webhook URL replaced/);
    await page.waitForFunction(
      (old) => document.querySelector("[data-webhook-url]")?.getAttribute("data-url") !== old,
      first,
    );
    expect(await open()).toBe(true);
    // A fold the person closed stays closed too.
    const domains = page.locator("#nz-domains-settings");
    await domains.locator("summary").click();
    await fold.getByRole("button", { name: "Replace URL" }).click();
    await dialog.getByRole("button", { name: "Replace URL" }).click();
    await toast(/Webhook URL replaced/);
    await page.waitForTimeout(500);
    expect(await domains.evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
    // Deleted with its copies, so the project has no services again.
    const plan = await api.call<{ plan: { copies: { id: string }[] } }>(
      "GET",
      `/services/${created.service.id}/delete-plan`,
    );
    await api.call("POST", `/services/${created.service.id}/delete`, {
      confirm: "imaged",
      alsoDeleteCopyIds: plan.plan.copies.map((copy) => copy.id),
    });
    for (let tries = 0; tries < 60; tries++) {
      const left = await api.call<{ project: { serviceCount: number } }>(
        "GET",
        `/projects/${project}`,
      );
      if (left.project.serviceCount === 0) break;
      await Bun.sleep(500);
    }
    await page.goto(back);
  }, 90_000);

  test("an app mounts another app's volume from its Advanced tab (G2-08)", async () => {
    const make = (name: string) =>
      api.call<{ service: { id: string } }>("POST", `/environments/${development}/services`, {
        serverId: "host",
        kind: "application",
        name,
        settings: { image: "nginx:alpine", servicePort: 80 },
      });
    const web = (await make("site")).service.id;
    const worker = (await make("jobs")).service.id;
    await api.call("PUT", `/services/${web}/mounts`, {
      mounts: [{ type: "volume", name: "uploads", containerPath: "/srv/uploads" }],
    });
    const back = page.url();
    await page.goto(
      `${stack.consoleUrl}/acme/dashboard/projects/${project}/${development}/services/${worker}/advanced`,
    );
    const form = page.locator("[data-mounts-form]");
    await form.getByRole("button", { name: "Add mount" }).click();
    const row = form.locator('[data-row="mount"]').last();
    await row.locator("[data-mount-kind]").selectOption("shared");
    expect(await row.locator('[name="share"] option').allTextContents()).toEqual([
      "site: uploads (/srv/uploads)",
    ]);
    await row.locator('[name="containerPath"]').fill("/uploads");
    await form.getByRole("button", { name: "Save mounts" }).click();
    await toast(/Deploy to apply the change/);
    await form.locator(".nz-badge", { hasText: "Volume of site" }).waitFor();
    const saved = await api.call<{ service: { settings: { mounts: Record<string, unknown>[] } } }>(
      "GET",
      `/services/${worker}`,
    );
    expect(saved.service.settings.mounts).toMatchObject([
      { type: "volume", name: "uploads", containerPath: "/uploads", sharedFrom: web },
    ]);
    // Cleaned up with their copies, so the project has no services again.
    for (const id of [worker, web]) {
      const plan = await api.call<{ plan: { copies: { id: string }[] } }>(
        "GET",
        `/services/${id}/delete-plan`,
      );
      await api.call("POST", `/services/${id}/delete`, {
        confirm: id === web ? "site" : "jobs",
        alsoDeleteCopyIds: plan.plan.copies.map((copy) => copy.id),
      });
    }
    for (let tries = 0; tries < 60; tries++) {
      const left = await api.call<{ project: { serviceCount: number } }>(
        "GET",
        `/projects/${project}`,
      );
      if (left.project.serviceCount === 0) break;
      await Bun.sleep(500);
    }
    await page.goto(back);
  }, 90_000);

  test("the project is deleted from its card, in the background", async () => {
    await page.goto(`${stack.consoleUrl}/acme/dashboard/projects`);
    await page.getByRole("button", { name: "Actions for storefront" }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const dialog = page.locator("#nz-teardown");
    await dialog.locator("text=Delete storefront? It has no services.").waitFor();
    const submit = dialog.locator("[data-teardown-submit]");
    expect(await submit.isDisabled()).toBe(true);
    await dialog.locator("#nz-teardown-confirm").fill("storefront");
    await submit.click();
    await dialog.locator("text=storefront was deleted.").waitFor({ timeout: 30_000 });
    await dialog.locator("[data-teardown-run]").getByRole("button", { name: "Close" }).click();
    await page.locator("text=No projects found").first().waitFor();
  }, 90_000);

  test("no page logged a script error or put a secret in an address", () => {
    expect(problems).toEqual([]);
  });
});
