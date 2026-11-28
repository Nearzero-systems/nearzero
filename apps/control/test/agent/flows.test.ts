import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { configureAgent } from "../../src/agent/settings.ts";
import { removeServicesJob } from "../../src/deletion/job.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { JobWorker } from "../../src/jobs/worker.ts";
import { silentLogger } from "../../src/log.ts";
import { FakeGitHosts, type FakeRepository } from "../support/fake-git-hosts.ts";
import type { Browser } from "../support/harness.ts";
import { setUpNamedOwner } from "../support/harness.ts";
import { addMember, FakeTeardown, makeProject, makeService } from "../support/projects.ts";
import {
  type AgentHarness,
  call,
  createAgentHarness,
  everythingStored,
  savedEvents,
  saveModelKey,
  say,
  send,
  waitClosed,
} from "./support.ts";

/**
 * The guided flows of spec 19.7 against a real control plane: the scripted model (never a real
 * provider) and pretend Git hosts (never a real one). Deploys are settled by writing the
 * deployment's outcome and log, as the deploy job would.
 */

setDefaultTimeout(400_000);

let a: AgentHarness;
let hosts: FakeGitHosts;

beforeAll(async () => {
  a = await createAgentHarness("nz_m11c_");
  const outside = a.h.services.http;
  a.h.services.http = (input, init) =>
    hosts.handles(String(input)) ? hosts.fetch(String(input), init) : outside(input, init);
});

afterAll(async () => {
  await a.drop();
});

beforeEach(async () => {
  await a.reset();
  hosts = new FakeGitHosts();
});

async function owner(withKey = true) {
  const browser = await setUpNamedOwner(a.h);
  if (withKey) await saveModelKey(browser);
  return browser;
}

async function allowDeletes(browser: Browser) {
  const saved = await browser.put("/workspace/agent-policies", {
    switches: { "projects.delete-without-production": true },
  });
  expect(saved.status).toBe(200);
}

async function connectGitea(browser: Browser) {
  const reply = await browser.post("/git-providers/gitea", {
    name: "Team Gitea",
    url: hosts.gitea.base,
    accessToken: hosts.gitea.accessToken,
  });
  expect(reply.status).toBe(201);
}

function repo(fullName: string, files: Record<string, string>, id = 40): FakeRepository {
  return {
    fullName,
    id,
    defaultBranch: "main",
    private: true,
    branches: ["main"],
    files,
    pushedAt: new Date(Date.UTC(2026, 10, 2) + id * 1000).toISOString(),
  };
}

// biome-ignore lint/suspicious/noExplicitAny: tests read whatever was saved.
type Saved = { seq: number; type: string; data: any };

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined>, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

/** The next form the turn waits on (after `after`, when given). */
async function nextForm(turnId: string, after: string | null = null) {
  return waitFor(`a form on ${turnId}`, async () => {
    const turn = await a.db
      .selectFrom("agent_turn")
      .select(["state"])
      .where("id", "=", turnId)
      .executeTakeFirst();
    const events = (await savedEvents(a.db, turnId)) as Saved[];
    const form = events.filter((event) => event.type === "form.requested").at(-1);
    if (turn && !["working", "waiting"].includes(turn.state)) {
      throw new Error(`the turn ended (${turn.state}) instead of asking: ${textOf(events)}`);
    }
    if (turn?.state !== "waiting" || !form || form.data.formId === after) return null;
    // biome-ignore lint/suspicious/noExplicitAny: tests read whatever form was asked.
    return form.data as { formId: string; form: Record<string, any> };
  });
}

async function answer(
  browser: Browser,
  turnId: string,
  formId: string,
  body: Record<string, unknown>,
) {
  const reply = await browser.post(`/agent/turns/${turnId}/forms/${formId}`, body);
  expect(reply.status).toBe(202);
}

function textOf(events: Saved[]): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => event.data.delta)
    .join("");
}

function rows(events: Saved[]) {
  return events.filter((event) => event.type === "step.finished").map((event) => event.data);
}

/** Settles the service's newest waiting deployment the way the deploy job would. */
async function settleDeploy(
  serviceId: string,
  status: "active" | "failed" | "cancelled",
  log: string,
  error: string | null = null,
) {
  const deployment = await waitFor("a queued deployment", () =>
    a.db
      .selectFrom("deployment")
      .select(["id"])
      .where("service_id", "=", serviceId)
      .where("status", "=", "queued")
      .orderBy("created_at", "desc")
      .executeTakeFirst(),
  );
  await a.db
    .insertInto("deployment_log")
    .values({ deployment_id: deployment.id, seq: 1, text: log })
    .execute();
  await a.db
    .updateTable("deployment")
    .set({ status, error, finished_at: new Date() })
    .where("id", "=", deployment.id)
    .execute();
}

async function projectNames(): Promise<string[]> {
  return (await a.db.selectFrom("project").select("name").orderBy("name").execute()).map(
    (row) => row.name,
  );
}

function deleteWorker() {
  const teardown = new FakeTeardown();
  const worker = new JobWorker({
    db: a.db,
    queue: new JobQueue(a.db, { workerId: "flows-test" }),
    definitions: [removeServicesJob(teardown)],
    log: silentLogger,
  });
  return { teardown, worker };
}

async function closeWithWorker(turnId: string, worker: JobWorker) {
  await waitFor("the turn to close", async () => {
    await worker.runOnce();
    const row = await a.db
      .selectFrom("agent_turn")
      .select("closed_at")
      .where("id", "=", turnId)
      .executeTakeFirst();
    return row?.closed_at ?? null;
  });
}

describe("create a project (spec 19.7)", () => {
  test("a usable name creates it before the model, as a row and a streamed reply", async () => {
    const browser = await owner();
    const sent = await send(browser, "Please create a project called shop");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(rows(events)).toEqual([
      expect.objectContaining({ state: "succeeded", label: "Created project", target: "shop" }),
    ]);
    expect(textOf(events)).toBe("Created **shop** with a **development** environment.");
    expect(a.model.turns).toHaveLength(0);
    expect(await projectNames()).toEqual(["shop"]);
    const audit = await a.db
      .selectFrom("audit_event")
      .select(["action", "actor_kind"])
      .where("action", "=", "agent.create-project")
      .execute();
    expect(audit).toEqual([{ action: "agent.create-project", actor_kind: "agent" }]);
    // Guided rows are saved like every other step (spec 19.12), with a footer.
    expect(
      events.at(-1)?.type === "turn.finished" || events.some((e) => e.type === "turn.finished"),
    ).toBe(true);
    expect(events.find((event) => event.type === "turn.finished")?.data.footer).toMatch(
      /· 1 step$/,
    );
  });

  test('"create a project and start it again": the name form, then the rest goes to the model; never "it again"', async () => {
    const browser = await owner();
    a.model.queue.push(say("A new project has nothing to start yet."));
    const sent = await send(browser, "create a project and start it again");
    const form = await nextForm(sent.turn.id);
    expect(form.form).toEqual({ kind: "project_name", label: "Project name", suggestion: null });
    expect(a.model.turns).toHaveLength(0);
    await answer(browser, sent.turn.id, form.formId, { outcome: "named", name: "shop" });
    await waitClosed(a.db, sent.turn.id);
    expect(await projectNames()).toEqual(["shop"]);
    expect(a.model.turns).toHaveLength(1);
    const asked = JSON.stringify(a.model.turns[0]?.body.messages);
    expect(asked).toContain("Now handle only the rest of what the person asked");
    expect(asked).toContain('\\"start it again\\"');
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(textOf(events)).toContain("Created **shop** with a **development** environment.");
    expect(textOf(events)).toContain("A new project has nothing to start yet.");
  });

  test("a generic name asks for a real one; a refused policy is plain text with the settings hint", async () => {
    const browser = await owner();
    const sent = await send(browser, "create a project called new project");
    const form = await nextForm(sent.turn.id);
    await answer(browser, sent.turn.id, form.formId, { outcome: "named", name: "untitled" });
    const again = await nextForm(sent.turn.id, form.formId);
    expect(again.form.kind).toBe("project_name");
    await answer(browser, sent.turn.id, again.formId, { outcome: "named", name: "billing" });
    await waitClosed(a.db, sent.turn.id);
    expect(await projectNames()).toEqual(["billing"]);

    await browser.put("/workspace/agent-policies", { switches: { "projects.create": false } });
    const refused = await send(browser, "create a project called shop", sent.session.id);
    await waitClosed(a.db, refused.turn.id);
    const events = (await savedEvents(a.db, refused.turn.id)) as Saved[];
    expect(textOf(events)).toContain('"Create projects" is off');
    expect(textOf(events)).toContain("Settings → Agent policies");
    expect(events.some((event) => event.type === "permission.needed")).toBe(false);
    expect(await projectNames()).toEqual(["billing"]);
  });
});

describe("delete a project (spec 19.7)", () => {
  test('"remove the sdrever" never deletes a project; inexact names without "project" go to the model', async () => {
    const browser = await owner();
    await allowDeletes(browser);
    await makeProject(browser, "server");
    a.model.queue.push(say("Which server did you mean?"));
    const sent = await send(browser, "remove the sdrever");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(events.some((event) => event.type === "form.requested")).toBe(false);
    expect(a.model.turns).toHaveLength(1);
    expect(await projectNames()).toEqual(["server"]);
  });

  test("policy first; near, several and no matches answered in words; never production", async () => {
    const browser = await owner();
    await makeProject(browser, "shop");
    await makeProject(browser, "live", ["production"]);
    const off = await send(browser, "delete the shop project");
    await waitClosed(a.db, off.turn.id);
    expect(textOf((await savedEvents(a.db, off.turn.id)) as Saved[])).toContain(
      '"Delete projects without production" is off',
    );
    const refusals = await a.db
      .selectFrom("audit_event")
      .select(["details"])
      .where("action", "=", "agent.refused")
      .execute();
    expect(refusals[0]?.details).toMatchObject({ policy: "projects.delete-without-production" });

    await allowDeletes(browser);
    const near = await send(browser, "delete project shpo", off.session.id);
    await waitClosed(a.db, near.turn.id);
    expect(textOf((await savedEvents(a.db, near.turn.id)) as Saved[])).toBe(
      'Did you mean **shop**? To delete it, say "delete shop".',
    );
    const none = await send(browser, "delete project nothing", off.session.id);
    await waitClosed(a.db, none.turn.id);
    expect(textOf((await savedEvents(a.db, none.turn.id)) as Saved[])).toBe(
      'There is no project called "nothing". Your projects: **shop**, **live**.',
    );
    const live = await send(browser, "delete live", off.session.id);
    await waitClosed(a.db, live.turn.id);
    expect(textOf((await savedEvents(a.db, live.turn.id)) as Saved[])).toContain(
      "**live** has a production environment, so the Agent never deletes it.",
    );
    expect(a.model.turns).toHaveLength(0);
    expect(await projectNames()).toEqual(["live", "shop"]);
  });

  test("the confirmation lists the exact services, is shown again when they changed, then each is removed as a row", async () => {
    const browser = await owner();
    await allowDeletes(browser);
    const project = await makeProject(browser, "shop");
    const development = project.environments.development as string;
    await makeService(browser, development, { kind: "redis", name: "cache" });
    const { teardown, worker } = deleteWorker();
    const sent = await send(browser, "delete shop");
    const form = await nextForm(sent.turn.id);
    expect(form.form).toMatchObject({
      kind: "project_delete",
      project: { name: "shop" },
      confirmLabel: "Delete shop and 1 service",
      confirmHint: "Wipes their data from the servers",
      keepLabel: "Keep it",
    });
    expect(form.form.services).toEqual([{ line: "cache — Redis on Nearzero host (development)" }]);

    // A service appears before the answer: the person confirms the new list.
    await makeService(browser, development, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:1" },
    });
    await answer(browser, sent.turn.id, form.formId, { outcome: "delete" });
    const again = await nextForm(sent.turn.id, form.formId);
    expect(again.form.summary).toStartWith("The services of shop changed");
    expect(again.form.services).toHaveLength(2);
    expect(again.form.confirmLabel).toBe("Delete shop and 2 services");
    await answer(browser, sent.turn.id, again.formId, { outcome: "delete" });
    await closeWithWorker(sent.turn.id, worker);

    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    const removing = rows(events).filter((row) => row.label === "Removed service");
    expect(removing.map((row) => row.target).sort()).toEqual([
      "cache on Nearzero host",
      "web on Nearzero host",
    ]);
    const text = textOf(events);
    expect(text).toContain("Deleted **shop** and removed its 2 services from their servers.");
    expect(text).toContain("| Service | Server | Result | Notes |");
    expect(text).toContain("| cache | Nearzero host | Already gone | It was never deployed. |");
    expect(teardown.calls.map((call) => call.target.name).sort()).toEqual(["cache", "web"]);
    expect(await projectNames()).toEqual([]);
    expect(a.model.turns).toHaveLength(0);
  });

  test("a service that couldn't be removed keeps the project, with the reason in the table", async () => {
    const browser = await owner();
    await allowDeletes(browser);
    const project = await makeProject(browser, "keepme");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    const { teardown, worker } = deleteWorker();
    teardown.failures.set("cache", "The server couldn't be reached.");
    const sent = await send(browser, "delete the keepme project");
    const form = await nextForm(sent.turn.id);
    await answer(browser, sent.turn.id, form.formId, { outcome: "delete" });
    await closeWithWorker(sent.turn.id, worker);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    const text = textOf(events);
    expect(text).toContain("I kept **keepme**: 1 service couldn't be removed");
    expect(text).toContain(
      "| cache | Nearzero host | Not removed | The server couldn't be reached. |",
    );
    expect(rows(events).find((row) => row.target === "cache on Nearzero host")?.state).toBe(
      "failed",
    );
    expect(await projectNames()).toEqual(["keepme"]);
  });

  test("clauses run in order: an empty project is deleted at once, then the next clause runs", async () => {
    const browser = await owner();
    await allowDeletes(browser);
    await makeProject(browser, "old");
    const { worker } = deleteWorker();
    const sent = await send(browser, "delete old and then create a project called web");
    await closeWithWorker(sent.turn.id, worker);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(textOf(events)).toBe(
      "Deleted **old**. It had no services.\n\nCreated **web** with a **development** environment.",
    );
    expect(await projectNames()).toEqual(["web"]);
    expect(a.model.turns).toHaveLength(0);
  });
});

describe('"deploy <name>" and keeping going (spec 19.7)', () => {
  test('"deploy github.com/acme/web" is checked before anything is promised, never the model (30d R4-01)', async () => {
    const browser = await owner();
    await connectGitea(browser);
    configureAgent(a.h.services, {
      publicRepositories: {
        refs: async () => ({ kind: "private" }),
        inspect: async () => ({ files: [], manifests: [] }),
      },
    });
    const sent = await send(browser, "deploy github.com/acme/web");
    const card = await nextForm(sent.turn.id);
    expect(card.form.title).toBe("Give Nearzero access to acme/web");
    expect(a.model.turns).toHaveLength(0);
    expect(await projectNames()).toEqual([]);
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);
  });

  test("a missing DATABASE_URL shows the variables form for exactly that, then redeploys; no value is stored anywhere", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    const app = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:1" },
    });
    const serviceId = app.service.id as string;
    const sent = await send(browser, "deploy web");
    // Never deployed, no variables: the variables form comes first.
    const first = await nextForm(sent.turn.id);
    expect(first.form).toMatchObject({
      kind: "variables",
      names: [],
      skipLabel: "Deploy without them",
    });
    expect(first.form.reason).toStartWith("Does it need environment variables?");
    await answer(browser, sent.turn.id, first.formId, { outcome: "skipped" });
    await settleDeploy(
      serviceId,
      "failed",
      "Starting web\nError: DATABASE_URL is not set\n",
      "The container exited.",
    );
    const missing = await nextForm(sent.turn.id, first.formId);
    expect(missing.form.names).toEqual(["DATABASE_URL"]);
    expect(missing.form.deployLabel).toBe("Save 1 variable and deploy");
    const marker = "postgres://app:MARKER-M11C-4471@db:5432/app";
    const saved = await browser.put(`/services/${serviceId}/variables`, {
      rows: [{ name: "DATABASE_URL", value: marker }],
    });
    expect(saved.status).toBe(200);
    await answer(browser, sent.turn.id, missing.formId, {
      outcome: "saved",
      names: ["DATABASE_URL"],
    });
    await settleDeploy(serviceId, "active", "Deployment complete.\n");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    const text = textOf(events);
    expect(text).toContain("needs a variable that isn't set: `DATABASE_URL`");
    expect(text).toContain("**web** is deployed");
    expect(rows(events).filter((row) => row.label === "Started deploy")).toHaveLength(2);
    expect(rows(events).filter((row) => row.label === "Deployed")).toHaveLength(1);
    expect(await everythingStored(a.db)).not.toContain("MARKER-M11C-4471");
    expect(a.model.allText()).not.toContain("MARKER-M11C-4471");
    expect(a.model.turns).toHaveLength(0);
  });

  test("anything else: the end of the log, then the model takes over in the same turn with the hidden note", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    const app = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "api",
      settings: { image: "node:24" },
      variables: [{ name: "LOG_LEVEL", value: "debug" }],
    });
    const serviceId = app.service.id as string;
    a.model.queue.push(say("The start command is wrong; fixing it."));
    const sent = await send(browser, "deploy api");
    const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    lines.push(
      "using GITHUB token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123",
      "Error: Cannot find module '/app/server.js'",
    );
    await settleDeploy(serviceId, "failed", `${lines.join("\n")}\n`, "The container exited.");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    const text = textOf(events);
    expect(text).toContain("The deployment failed. The end of its log:");
    expect(text).toContain("I'm finding the cause and fixing it.");
    expect(text).toContain("line 18");
    expect(text).not.toContain("line 17\n");
    expect(text).toContain("The start command is wrong; fixing it.");
    expect(a.model.turns).toHaveLength(1);
    const note = JSON.stringify(a.model.turns[0]?.body.messages);
    expect(note).toContain('guided deploy of the service \\"api\\"');
    expect(note).toContain("Builders tried:");
    expect(note).toContain("Deploys of this service in this request: 1 of 6");
    expect(note).toContain("line 3");
    expect(note).toContain("Cannot find module");
    // The note is the model's alone, and no secret from the log is kept or sent.
    expect(text).not.toContain("Builders tried");
    expect(await everythingStored(a.db)).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
    expect(a.model.allText()).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123");
  });

  test("without a model key, the failure text is the answer", async () => {
    const browser = await owner(false);
    const project = await makeProject(browser, "shop");
    const app = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "api",
      settings: { image: "node:24" },
      variables: [{ name: "LOG_LEVEL", value: "debug" }],
    });
    const sent = await send(browser, "deploy api");
    await settleDeploy(app.service.id, "failed", "boom\n", "The container exited.");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(textOf(events)).toBe("The deployment failed. The end of its log:\n\n```\nboom\n```");
    expect(events.find((event) => event.type === "turn.finished")?.data.state).toBe("finished");
    expect(a.model.requests).toHaveLength(0);
  });

  test("several services by that name: a picker labelled project / environment", async () => {
    const browser = await owner();
    for (const name of ["shop", "blog"]) {
      const project = await makeProject(browser, name);
      await makeService(browser, project.environments.development as string, {
        kind: "application",
        name: "web",
        settings: { image: "nginx:1" },
      });
    }
    const sent = await send(browser, "redeploy the web app");
    const form = await nextForm(sent.turn.id);
    expect(form.form).toMatchObject({
      kind: "picker",
      purpose: "service",
      title: 'More than one service is called "web". Which one should I deploy?',
    });
    expect(form.form.options.map((option: { label: string }) => option.label).sort()).toEqual([
      "blog / development",
      "shop / development",
    ]);
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);
  });

  test("no service by that name: a repository of that name, else the repository picker by closeness", async () => {
    const browser = await owner();
    await connectGitea(browser);
    const sent = await send(browser, "deploy wbe");
    const form = await nextForm(sent.turn.id);
    expect(form.form).toMatchObject({
      kind: "picker",
      purpose: "repository",
      searchable: true,
      title: 'No service or repository is called "wbe". Choose the repository to deploy',
    });
    expect(form.form.options[0].value).toBe("team/web");
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);
  });
});

describe("import from Git (spec 19.7)", () => {
  test("a Dockerfile and a Compose file: it asks which; the variables form comes before the first deploy", async () => {
    const browser = await owner();
    hosts.gitea.repositories.splice(
      0,
      hosts.gitea.repositories.length,
      repo("team/web", {
        Dockerfile: "FROM node:24-alpine\n",
        "docker-compose.yml": "services:\n  web:\n    build: .\n",
        "package.json": '{"scripts":{"start":"node index.js"}}',
        ".env.example": "DATABASE_URL=\nSECRET_KEY=\n",
      }),
    );
    await connectGitea(browser);
    const sent = await send(browser, "import team/web");
    const how = await nextForm(sent.turn.id);
    expect(how.form).toMatchObject({
      kind: "picker",
      purpose: "how_to_run",
      title: "How should team/web run?",
    });
    expect(how.form.options).toEqual([
      {
        value: "compose:docker-compose.yml",
        label: "Compose file (docker-compose.yml)",
        description: "Every service in the compose file",
      },
      {
        value: "dockerfile:",
        label: "Dockerfile",
        description: "Build this Dockerfile as one app",
      },
    ]);
    // Read through the provider's API, never cloned.
    expect(hosts.calls.some((call) => call.url.includes("/api/v1/repos/team/web/"))).toBe(true);
    await answer(browser, sent.turn.id, how.formId, {
      outcome: "chosen",
      option: "dockerfile:",
      label: "Dockerfile",
    });
    const variables = await nextForm(sent.turn.id, how.formId);
    expect(variables.form).toMatchObject({
      kind: "variables",
      names: ["DATABASE_URL", "SECRET_KEY"],
    });
    const service = await a.db
      .selectFrom("service")
      .select(["id", "name", "settings", "server_id"])
      .executeTakeFirstOrThrow();
    expect(service.name).toBe("web");
    expect(service.server_id).toBeNull();
    expect((service.settings as { build?: { type: string } }).build?.type).toBe("dockerfile");
    expect((service.settings as { source?: { repository: string } }).source?.repository).toBe(
      "team/web",
    );
    await answer(browser, sent.turn.id, variables.formId, { outcome: "skipped" });
    await settleDeploy(service.id, "active", "Deployment complete.\n");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    const text = textOf(events);
    expect(text).toContain(
      "No server is ready for deployments yet, so I'm putting it on the Nearzero host",
    );
    expect(text).toContain(
      "Created **web** in **web** / development on Nearzero host, from team/web (main)",
    );
    expect(text).toContain("**web** is deployed");
    expect(await projectNames()).toEqual(["web"]);
    expect(rows(events).map((row) => row.label)).toEqual(
      expect.arrayContaining([
        "Listed repositories",
        "Inspected repository",
        "Created project",
        "Created app",
        "Started deploy",
        "Deployed",
      ]),
    );
    expect(a.model.turns).toHaveLength(0);
  });

  test("only a package.json: it builds automatically; never the only project silently; just import doesn't deploy", async () => {
    const browser = await owner();
    hosts.gitea.repositories.splice(
      0,
      hosts.gitea.repositories.length,
      repo("team/docs", {
        "package.json": '{"scripts":{"start":"node index.js"}}',
        "index.js": "",
      }),
    );
    await connectGitea(browser);
    await makeProject(browser, "shop");
    const sent = await send(browser, "just import my docs repo");
    const project = await nextForm(sent.turn.id);
    expect(project.form.purpose).toBe("project");
    expect(project.form.options[0]).toEqual({ value: "new", label: 'New project "docs"' });
    const shop = project.form.options.find((option: { label: string }) => option.label === "shop");
    await answer(browser, sent.turn.id, project.formId, {
      outcome: "chosen",
      option: shop.value,
      label: "shop",
    });
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(events.filter((event) => event.type === "form.requested")).toHaveLength(1);
    const service = await a.db.selectFrom("service").select(["settings"]).executeTakeFirstOrThrow();
    expect((service.settings as { build?: { type: string } }).build?.type ?? "automatic").toBe(
      "automatic",
    );
    expect(textOf(events)).toContain("built with automatic language detection");
    expect(textOf(events)).toContain("I didn't deploy it, as you asked.");
    expect(await a.db.selectFrom("deployment").select("id").execute()).toHaveLength(0);
  });

  test("no usable account: Connect buttons that come back to the chat, and the import resumes there", async () => {
    const browser = await owner();
    const sent = await send(browser, "Deploy a Git repository");
    const connect = await nextForm(sent.turn.id);
    expect(connect.form).toMatchObject({ kind: "picker", purpose: "provider" });
    expect(connect.form.options.map((option: { label: string }) => option.label)).toEqual([
      "Connect GitHub",
      "Connect GitLab",
      "Connect Bitbucket",
      "Connect Gitea",
    ]);
    const href = connect.form.options[0].href as string;
    expect(href).toContain("/dashboard/settings/git-providers?connect=github&return=");
    expect(decodeURIComponent(href)).toContain(`/dashboard/agent?session=${sent.session.id}`);
    // Opening the chat again without an account changes nothing.
    await browser.get(`/agent/sessions/${sent.session.id}`);
    expect((await nextForm(sent.turn.id)).formId).toBe(connect.formId);
    await connectGitea(browser);
    await browser.get(`/agent/sessions/${sent.session.id}`);
    const repository = await nextForm(sent.turn.id, connect.formId);
    expect(repository.form).toMatchObject({
      purpose: "repository",
      title: "Choose the repository to deploy",
    });
    expect(repository.form.options.map((option: { value: string }) => option.value).sort()).toEqual(
      ["team/docs", "team/web"],
    );
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);
  });

  test("a member who may not connect accounts is told to ask an owner or admin", async () => {
    const browser = await owner();
    const member = await addMember(a.h, browser, "mia@example.com");
    const sent = await send(member, "Deploy a Git repository");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(textOf(events)).toStartWith(
      "You don't have a Git account you can use here. Ask an owner or admin",
    );
    expect(events.some((event) => event.type === "form.requested")).toBe(false);
  });
});

describe("what a refusal names (spec 22.4 rule 3)", () => {
  async function keyNamed(browser: Browser, name: string): Promise<string> {
    const generated = await browser.post("/ssh-keys/generate", { type: "ed25519", name });
    const saved = await browser.post("/ssh-keys", {
      name,
      publicKey: generated.body.publicKey,
      privateKey: generated.body.privateKey,
    });
    expect(saved.status).toBe(201);
    return saved.body.key.id as string;
  }

  test("B1-59: an unmatched key names the workspace's keys only to someone who may use them", async () => {
    const browser = await owner();
    await keyNamed(browser, "billing-box-key");
    const policies = await browser.put("/workspace/agent-policies", {
      switches: { "ssh-keys.read": true },
    });
    expect(policies.status).toBe(200);
    const member = await addMember(a.h, browser, "mia@example.com");
    a.model.queue.push(
      call("add_server", {
        name: "edge",
        address: "203.0.113.20",
        sshUser: "root",
        sshKey: "nope",
      }),
      say("I couldn't find that key."),
    );
    const sent = await send(member, "add my server edge");
    await waitClosed(a.db, sent.turn.id);
    expect(a.model.allText()).not.toContain("billing-box-key");

    // Someone who may use the keys is told which exist.
    a.model.reset();
    a.model.queue.push(
      call("add_server", {
        name: "edge",
        address: "203.0.113.20",
        sshUser: "root",
        sshKey: "nope",
      }),
      say("Which key?"),
    );
    const own = await send(browser, "add my server edge");
    await waitClosed(a.db, own.turn.id);
    expect(a.model.allText()).toContain("billing-box-key");
  });

  test("B1-60: remove_server checks the person's right before naming what runs there", async () => {
    const browser = await owner();
    const keyId = await keyNamed(browser, "k");
    const server = await browser.post("/servers", {
      name: "edge-1",
      sshKeyId: keyId,
      address: "203.0.113.21",
      sshUser: "root",
    });
    expect(server.status).toBe(201);
    const serverId = server.body.server.id as string;
    const { environments } = await makeProject(browser, "Private");
    const hidden = await makeService(browser, environments.development as string, {
      kind: "application",
      name: "payroll-secret",
    });
    await a.db
      .updateTable("service")
      .set({ server_id: serverId, status: "running" })
      .where("id", "=", (hidden.service as { id: string }).id)
      .execute();
    const policies = await browser.put("/workspace/agent-policies", {
      switches: { "servers.remove": true },
    });
    expect(policies.status).toBe(200);
    // Sees the server, may not manage it, and can't see the service.
    const member = await addMember(a.h, browser, "sam@example.com", {
      scope: { serverIds: [serverId] } as never,
    });
    a.model.queue.push(call("remove_server", { server: "edge-1" }), say("I can't remove it."));
    const sent = await send(member, "remove the server edge-1");
    await waitClosed(a.db, sent.turn.id);
    expect(a.model.allText()).not.toContain("payroll-secret");
    expect(
      await a.db.selectFrom("server").select("id").where("id", "=", serverId).executeTakeFirst(),
    ).toBeTruthy();
  });
});
