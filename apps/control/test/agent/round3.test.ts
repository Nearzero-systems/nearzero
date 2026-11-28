import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { serverSetupPort } from "../../src/agent/adapters/server-setup.ts";
import type { PublicInspection, PublicRefs } from "../../src/agent/flows/public-repo.ts";
import { systemPrompt } from "../../src/agent/prompt.ts";
import { OpenRouterProvider } from "../../src/agent/provider/openrouter.ts";
import { agentSettingsFromEnv, configureAgent, modelInputsFrom } from "../../src/agent/settings.ts";
import { removeServicesJob } from "../../src/deletion/job.ts";
import { type DnsLookup, LookupError } from "../../src/domains/settings.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { JobWorker } from "../../src/jobs/worker.ts";
import { silentLogger } from "../../src/log.ts";
import { FakeGitHosts } from "../support/fake-git-hosts.ts";
import type { Browser } from "../support/harness.ts";
import { setUpNamedOwner } from "../support/harness.ts";
import {
  addMember,
  FakeTeardown,
  makeProject,
  makeService,
  workspaceIdOf,
} from "../support/projects.ts";
import {
  type AgentHarness,
  call,
  createAgentHarness,
  savedEvents,
  saveModelKey,
  say,
  send,
  waitClosed,
} from "./support.ts";

/**
 * Round 3's Agent fixes (spec 31d, and the C1 and C3 bug reports): shared chats show viewers only
 * what they may see (C1-06, C1-15), guided flows re-check the Agent policies when a form is
 * answered (C1-16), server picker rows (C1-17), project deletes see every environment (C1-18),
 * no half-made apps (C1-19), servers with services are never removed (G4-01), and more.
 */

setDefaultTimeout(400_000);

let a: AgentHarness;
let hosts: FakeGitHosts;

beforeAll(async () => {
  a = await createAgentHarness("nz_w5_agent_");
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
  publicHost.refs = { kind: "private" };
  publicHost.files = { Dockerfile: "FROM nginx:1\n" };
  publicHost.calls = [];
});

// biome-ignore lint/suspicious/noExplicitAny: tests read whatever was saved.
type Saved = { seq: number; type: string; data: any };

/** A pretend public host for pasted links: what anyone may read, with no login. */
const publicHost = {
  refs: { kind: "private" } as PublicRefs,
  files: {} as Record<string, string>,
  calls: [] as string[],
};

function usePublicHost() {
  configureAgent(a.h.services, {
    publicRepositories: {
      refs: async (url) => {
        publicHost.calls.push(`refs ${url}`);
        return publicHost.refs;
      },
      inspect: async (url, branch): Promise<PublicInspection> => {
        publicHost.calls.push(`inspect ${url} ${branch}`);
        return {
          files: Object.keys(publicHost.files).map((path) => ({ path, type: "file", size: null })),
          manifests: Object.entries(publicHost.files).map(([path, content]) => ({ path, content })),
        };
      },
    },
  });
}

async function owner() {
  const browser = await setUpNamedOwner(a.h);
  await saveModelKey(browser);
  return browser;
}

async function waitFor<T>(what: string, probe: () => Promise<T | null | undefined>, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

function textOf(events: Saved[]): string {
  return events
    .filter((event) => event.type === "text")
    .map((event) => event.data.delta)
    .join("");
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

async function answer(browser: Browser, turnId: string, formId: string, body: object) {
  const reply = await browser.post(`/agent/turns/${turnId}/forms/${formId}`, body);
  expect(reply.status).toBe(202);
}

async function allowDeletes(browser: Browser, on = true) {
  const saved = await browser.put("/workspace/agent-policies", {
    switches: { "projects.delete-without-production": on },
  });
  expect(saved.status).toBe(200);
}

function deleteWorker() {
  const teardown = new FakeTeardown();
  const worker = new JobWorker({
    db: a.db,
    queue: new JobQueue(a.db, { workerId: "w5-test" }),
    definitions: [removeServicesJob(teardown)],
    log: silentLogger,
  });
  return { teardown, worker };
}

let addresses = 0;
function nextAddress(): number {
  addresses = (addresses % 250) + 1;
  return addresses;
}

async function readyServer(
  browser: Browser,
  name: string,
  setupState: "ready" | "not_started" | "running" | "failed" = "ready",
): Promise<string> {
  const workspaceId = await workspaceIdOf(browser);
  const key = await a.db
    .insertInto("ssh_key")
    .values({
      workspace_id: workspaceId,
      name: `${name}-key`,
      key_type: "ed25519",
      public_key: "ssh-ed25519 AAAA",
      fingerprint: `SHA256:${name}`,
      private_key_sealed: "nzs1.x",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  const row = await a.db
    .insertInto("server")
    .values({
      workspace_id: workspaceId,
      name,
      address: `198.51.100.${nextAddress()}`,
      ssh_user: "root",
      ssh_key_id: key.id,
      label: `${name}${Date.now().toString(36)}`,
      setup_state: setupState,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

/** What a viewer of someone else's chat is shown of every turn, as one string. */
async function seenBy(viewer: Browser, sessionId: string): Promise<string> {
  const seen = await viewer.get(`/agent/sessions/${sessionId}`);
  expect(seen.status).toBe(200);
  return JSON.stringify(seen.body.turns);
}

describe("a shared chat shows viewers only what they may see (C1-06, C1-15)", () => {
  test("list_projects and read_project name every environment and service, so a one-service member sees neither", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop", ["production"]);
    const web = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
    });
    await makeService(browser, project.environments.development as string, {
      kind: "postgres",
      name: "billing-db",
    });
    const member = await addMember(a.h, browser, "sam@example.com", {
      scope: { serviceIds: [web.service.id] },
    });
    // The member's own view of the project: one service, development only.
    const own = await member.get(`/projects/${project.projectId}`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(own.body)).not.toContain("billing-db");

    a.model.queue.push(
      call("list_projects"),
      call("read_project", { project: "shop" }),
      say("Done."),
    );
    const sent = await send(browser, "list my projects and read shop");
    await waitClosed(a.db, sent.turn.id);
    expect(
      (await browser.post(`/agent/sessions/${sent.session.id}/share`, { shared: true })).status,
    ).toBe(200);
    const seen = await seenBy(member, sent.session.id);
    expect(seen).not.toContain("billing-db");
    expect(seen).not.toContain(project.environments.production);
    // The author still reads both rows in full.
    const author = await seenBy(browser, sent.session.id);
    expect(author.match(/billing-db/g)?.length).toBeGreaterThanOrEqual(2);
    // A viewer who sees everything listed sees the rows too.
    const admin = await addMember(a.h, browser, "ann@example.com", { role: "admin" });
    expect(await seenBy(admin, sent.session.id)).toContain("billing-db");
  });
});

describe("guided flows' words in a shared chat (C1-15)", () => {
  test("a viewer with no access doesn't read the repository, project or server in the answer", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    const browser = await owner();
    const sent = await send(browser, "just import https://github.com/acme/payroll-internal");
    await waitClosed(a.db, sent.turn.id);
    expect(await a.db.selectFrom("service").select("name").execute()).toEqual([
      { name: "payroll-internal" },
    ]);
    await browser.post(`/agent/sessions/${sent.session.id}/share`, { shared: true });
    const member = await addMember(a.h, browser, "nobody@example.com");
    expect((await member.get("/projects")).body.projects).toEqual([]);
    const seen = await member.get(`/agent/sessions/${sent.session.id}`);
    const turn = seen.body.turns[0];
    // The person's own message is shared as written; nothing the Agent wrote names more.
    const written = (events: Saved[]) =>
      JSON.stringify(
        events.filter((event) => event.type !== "turn.started" && event.type !== "session.titled"),
      );
    expect(turn.answerText).not.toContain("payroll-internal");
    expect(turn.answerText).not.toContain("Nearzero host");
    expect(turn.answerText).toBe(
      "_This part of the answer is shown only to the person who asked: it may name things you don't have access to._\n\n_This part of the answer is shown only to the person who asked: it may name things you don't have access to._",
    );
    expect(written(turn.events)).not.toContain("payroll-internal");
    expect(written(turn.events)).not.toContain("Nearzero host");
    // The live stream gives the same words.
    const stream = await member.request("GET", `/agent/turns/${sent.turn.id}/events`, undefined, {
      "last-event-id": `${sent.turn.id}:3`,
    });
    const streamed = new TextDecoder().decode(stream.body as ArrayBuffer);
    expect(streamed).toContain("shown only to the person who asked");
    expect(streamed).not.toContain("payroll-internal");
    expect(streamed).not.toContain("Nearzero host");
    // The author reads every word.
    const own = (await browser.get(`/agent/sessions/${sent.session.id}`)).body.turns[0];
    expect(own.answerText).toContain("Created **payroll-internal**");
    expect(JSON.stringify(own.events)).not.toContain('"guided"');
  });
});

describe("removing a server through the Agent (G4-01, spec 9.6)", () => {
  test("a server with a stopped Postgres is refused, and nothing on it is removed", async () => {
    const browser = await owner();
    await browser.put("/workspace/agent-policies", { switches: { "servers.remove": true } });
    const serverId = await readyServer(browser, "edge-1");
    const project = await makeProject(browser, "shop");
    const db = await makeService(browser, project.environments.development as string, {
      kind: "postgres",
      name: "orders-db",
      serverId,
    });
    expect(db.service.status).not.toBe("running");
    const before = {
      services: await a.db.selectFrom("service").select("id").execute(),
      deletes: await a.db.selectFrom("delete_run").select("id").execute(),
    };
    a.model.queue.push(call("remove_server", { server: "edge-1" }), say("It still has a service."));
    const sent = await send(browser, "remove server edge-1");
    await waitClosed(a.db, sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    const row = events.find((event) => event.type === "step.finished");
    expect(row?.data.state).toBe("failed");
    expect(row?.data.reason).toBe(
      "edge-1 still has 1 service (orders-db). Delete those services or move them to another server first.",
    );
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual(before.services);
    expect(await a.db.selectFrom("delete_run").select("id").execute()).toEqual(before.deletes);
    expect(await a.db.selectFrom("server_removal").select("id").execute()).toEqual([]);
    expect(
      await a.db.selectFrom("server").select("name").where("id", "=", serverId).execute(),
    ).toEqual([{ name: "edge-1" }]);
  });

  test("the refusal names what the person can see and counts the rest", async () => {
    const browser = await owner();
    await browser.put("/workspace/agent-policies", { switches: { "servers.remove": true } });
    const serverId = await readyServer(browser, "edge-1");
    const project = await makeProject(browser, "shop");
    const env = project.environments.development as string;
    const web = await makeService(browser, env, { kind: "redis", name: "cache", serverId });
    await makeService(browser, env, { kind: "postgres", name: "payroll-db", serverId });
    const member = await addMember(a.h, browser, "ops@example.com", {
      capabilities: ["servers.manage"],
      scope: { serverIds: [serverId], serviceIds: [web.service.id] },
    });
    await saveModelKey(member).catch(() => {});
    a.model.queue.push(call("remove_server", { server: "edge-1" }), say("Refused."));
    const sent = await send(member, "remove server edge-1");
    await waitClosed(a.db, sent.turn.id);
    const row = ((await savedEvents(a.db, sent.turn.id)) as Saved[]).find(
      (event) => event.type === "step.finished",
    );
    expect(row?.data.reason).toBe(
      "edge-1 still has 2 services (cache, 1 other service). Delete those services or move them to another server first.",
    );
    expect(JSON.stringify(row)).not.toContain("payroll-db");
    expect((await a.db.selectFrom("service").select("id").execute()).length).toBe(2);
  });
});

/**
 * The whole GitHub App flow (manifest, conversion, install) against the pretend GitHub, which
 * needs the console (and the address Git providers call, which follows it) on HTTPS for the
 * app's addresses.
 */
async function connectGithub(browser: Browser): Promise<string> {
  const { consoleUrl, gitPublicUrl } = a.h.services;
  a.h.services.consoleUrl = () => "https://nz.example.com";
  a.h.services.gitPublicUrl = () => "https://nz.example.com";
  try {
    return await connectGithubApp(browser);
  } finally {
    a.h.services.consoleUrl = consoleUrl;
    a.h.services.gitPublicUrl = gitPublicUrl;
  }
}

async function connectGithubApp(browser: Browser): Promise<string> {
  const started = await browser.post("/git-providers/github/manifest", { organization: "acme" });
  expect(started.status).toBe(200);
  const state = new URL(started.body.action).searchParams.get("state") as string;
  const created = await browser.post("/git-providers/github/manifest/complete", {
    code: hosts.github.manifestCode,
    state,
  });
  expect(created.status).toBe(201);
  const installState = new URL(created.body.installUrl).searchParams.get("state");
  const installed = await browser.post("/git-providers/github/installations", {
    installationId: hosts.github.installationId,
    state: installState,
    setupAction: "install",
  });
  expect(installed.status).toBe(200);
  return installed.body.provider.id as string;
}

async function serviceSettings(name: string) {
  const row = await a.db
    .selectFrom("service")
    .select(["id", "name", "settings"])
    .where("name", "=", name)
    .executeTakeFirst();
  return row ? { ...row, text: JSON.stringify(row.settings) } : null;
}

describe("a pasted link with other words runs the checked import (31d R4-01, G4-06, G4-07)", () => {
  test('"with its Dockerfile" picks the Dockerfile builder without asking how it runs', async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    publicHost.files = {
      Dockerfile: "FROM nginx:1\n",
      "docker-compose.yml": "services: {}\n",
      "package.json": "{}",
    };
    const browser = await owner();
    const sent = await send(browser, "just import https://github.com/acme/web with its Dockerfile");
    await waitClosed(a.db, sent.turn.id);
    const web = await serviceSettings("web");
    expect(web?.text).toContain('"type":"dockerfile"');
    const text = textOf((await savedEvents(a.db, sent.turn.id)) as Saved[]);
    expect(text).toContain("built with its Dockerfile");
    // G4-07: pushes don't reach a repository no connected account can see.
    expect(text).toContain(
      "Pushes to the repository don't redeploy it on their own, because no connected account can see it. Connect the account that owns it, or ask me for its deploy webhook.",
    );
    expect(a.model.turns).toHaveLength(0);
  });

  test('"as api" names the service, and "with nixpacks from the apps/api folder" are both kept', async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    publicHost.files = {
      "apps/api/package.json": "{}",
      "apps/web/package.json": '{"scripts":{"start":"next start"}}',
    };
    const browser = await owner();
    const sent = await send(
      browser,
      "just import gitlab.com/acme/backend as api with nixpacks from the apps/api folder",
    );
    await waitClosed(a.db, sent.turn.id);
    const api = await serviceSettings("api");
    expect(api).not.toBeNull();
    expect(api?.text).toContain('"type":"nixpacks"');
    expect(api?.text).toContain('"buildPath":"apps/api"');
    expect(await serviceSettings("backend")).toBeNull();
  });

  test("a folder the repository doesn't have creates nothing, and says so", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    publicHost.files = { "package.json": "{}" };
    const browser = await owner();
    const sent = await send(browser, "just import github.com/acme/web from the apps/api folder");
    await waitClosed(a.db, sent.turn.id);
    expect(textOf((await savedEvents(a.db, sent.turn.id)) as Saved[])).toContain(
      "**acme/web** has no folder apps/api, so nothing was created.",
    );
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);
  });

  test("the guided Git import keeps a builder and a folder too (G4-06)", async () => {
    const browser = await owner();
    await connectGithub(browser);
    const sent = await send(browser, "just import acme/web with railpack from the apps/api folder");
    await waitClosed(a.db, sent.turn.id);
    const api = await serviceSettings("api");
    expect(api?.text).toContain('"type":"railpack"');
    expect(api?.text).toContain('"buildPath":"apps/api"');
    expect(api?.text).toContain('"type":"provider"');
  });
});

describe("the model's Git URL action is checked like a pasted link (31d R4-01)", () => {
  test("a connected account that can see the repository is used, so pushes redeploy it", async () => {
    usePublicHost();
    const browser = await owner();
    const providerId = await connectGithub(browser);
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_git_url", {
        project: "shop",
        name: "web",
        url: "https://github.com/acme/web",
        server: "host",
      }),
      say("Created."),
    );
    const sent = await send(
      browser,
      "create web in shop from https://github.com/acme/web on port 3000",
    );
    await waitClosed(a.db, sent.turn.id);
    const web = await serviceSettings("web");
    expect(web?.text).toContain('"type":"provider"');
    expect(web?.text).toContain(providerId);
    expect(publicHost.calls).toEqual([]);
  });

  test("a public repository no account can see is created on its real default branch", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "master", branches: ["master", "dev"] };
    const browser = await owner();
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_git_url", {
        project: "shop",
        name: "web",
        url: "https://github.com/acme/site",
        server: "host",
      }),
      say("Created."),
    );
    const sent = await send(browser, "create web from github.com/acme/site in shop on port 3000");
    await waitClosed(a.db, sent.turn.id);
    const web = await serviceSettings("web");
    expect(web?.text).toContain('"url":"https://github.com/acme/site.git"');
    expect(web?.text).toContain('"branch":"master"');
    const row = ((await savedEvents(a.db, sent.turn.id)) as Saved[]).find(
      (event) => event.type === "step.finished",
    );
    expect(row?.data.result).toContain("Pushes to the repository don't redeploy it");
  });

  test("a private or missing repository creates nothing and shows the access card; Check again creates it", async () => {
    usePublicHost();
    const browser = await owner();
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_git_url", {
        project: "shop",
        name: "web",
        url: "https://github.com/acme/secret",
        server: "host",
      }),
      say("Waiting for access."),
      say("Created it."),
    );
    const sent = await send(browser, "create web from github.com/acme/secret in shop on port 3000");
    const card = await nextForm(sent.turn.id);
    expect(card.form).toMatchObject({ kind: "picker", purpose: "access" });
    expect(card.form.options.map((option: { label: string }) => option.label)).toEqual([
      "Connect GitHub",
      "Check again",
    ]);
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);
    const rows = ((await savedEvents(a.db, sent.turn.id)) as Saved[]).filter(
      (event) => event.type === "step.finished",
    );
    expect(rows.map((row) => row.data.label)).toEqual(["Asked for access to the repository"]);
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    await answer(browser, sent.turn.id, card.formId, { outcome: "chosen", option: "check" });
    await waitClosed(a.db, sent.turn.id);
    expect((await serviceSettings("web"))?.text).toContain('"branch":"main"');
    const after = ((await savedEvents(a.db, sent.turn.id)) as Saved[]).filter(
      (event) => event.type === "step.finished",
    );
    expect(after.map((row) => [row.data.label, row.data.state])).toEqual([
      ["Asked for access to the repository", "succeeded"],
      ["Created app", "succeeded"],
    ]);
  });
});

describe("the repository access card (C3-01, C3-02)", () => {
  test("is buttons, and Give access on GitHub opens the install from the console, back to this chat", async () => {
    usePublicHost();
    const browser = await owner();
    const providerId = await connectGithub(browser);
    const sent = await send(browser, "deploy https://github.com/acme/secret");
    const card = await nextForm(sent.turn.id);
    expect(card.form.purpose).toBe("access");
    const give = card.form.options.find(
      (option: { label: string }) => option.label === "Give access on GitHub",
    );
    const slug = (await browser.get("/auth/session")).body.workspace.slug;
    expect(give.href).toBe(
      `/${slug}/dashboard/settings/git-providers?install=${providerId}&return=${encodeURIComponent(`/${slug}/dashboard/agent?session=${sent.session.id}`)}`,
    );
    // What that page posts: the install page opens, and GitHub comes back to the chat.
    const started = await browser.post(`/git-providers/${providerId}/install`, {
      returnTo: `/${slug}/dashboard/agent?session=${sent.session.id}`,
    });
    expect(started.status).toBe(200);
    expect(started.body.installUrl).toStartWith("https://github.com/apps/");
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);
  });
});

describe("guided imports check the Agent policies when they create (C1-16)", () => {
  test("Import from Git turned off while the server picker waits: nothing is created", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    const browser = await owner();
    const serverId = await readyServer(browser, "prod-1");
    const sent = await send(browser, "just import https://github.com/acme/web");
    const form = await nextForm(sent.turn.id);
    expect(form.form.purpose).toBe("server");
    const off = await browser.put("/workspace/agent-policies", {
      switches: { "services.import-git": false },
    });
    expect(off.status).toBe(200);
    await answer(browser, sent.turn.id, form.formId, { outcome: "chosen", option: serverId });
    await waitClosed(a.db, sent.turn.id);
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);
    expect(textOf((await savedEvents(a.db, sent.turn.id)) as Saved[])).toContain(
      'the Agent policy "Import from Git (needs Create and configure)" is off',
    );
  });
});

describe("the server picker's rows (C1-17)", () => {
  test("the row says it asked; closing leaves no action shown done, picking adds the create's row", async () => {
    const browser = await owner();
    const serverId = await readyServer(browser, "prod-1");
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_image", { project: "shop", name: "web", image: "nginx:1" }),
      say("Closed."),
    );
    const closed = await send(browser, "run nginx as web in shop");
    const picker = await nextForm(closed.turn.id);
    const rows = async (turnId: string) =>
      ((await savedEvents(a.db, turnId)) as Saved[])
        .filter((event) => event.type === "step.finished")
        .map((event) => [event.data.label, event.data.state, event.data.target]);
    expect(await rows(closed.turn.id)).toEqual([["Asked for a server", "succeeded", "web"]]);
    await answer(browser, closed.turn.id, picker.formId, { outcome: "closed" });
    await waitClosed(a.db, closed.turn.id);
    expect(await rows(closed.turn.id)).toEqual([["Asked for a server", "succeeded", "web"]]);
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);

    a.model.queue.push(
      call("create_app_from_image", { project: "shop", name: "web", image: "nginx:1" }),
      say("Created."),
    );
    const picked = await send(browser, "run nginx as web in shop", closed.session.id);
    const second = await nextForm(picked.turn.id);
    await answer(browser, picked.turn.id, second.formId, { outcome: "chosen", option: serverId });
    await waitClosed(a.db, picked.turn.id);
    expect(await rows(picked.turn.id)).toEqual([
      ["Asked for a server", "succeeded", "web"],
      ["Created app", "succeeded", "web on prod-1"],
    ]);
  });
});

describe("rows of answered forms say what happened (C1-17)", () => {
  test("a delete the person keeps shows only that it asked; nothing reads as deleted", async () => {
    const browser = await owner();
    await allowDeletes(browser);
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    a.model.queue.push(call("delete_project", { project: "shop" }), say("Kept."));
    // Words no guided flow takes, so the model asks for the delete.
    const sent = await send(browser, "time to tidy up: shop can go");
    const form = await nextForm(sent.turn.id);
    await answer(browser, sent.turn.id, form.formId, { outcome: "keep" });
    await waitClosed(a.db, sent.turn.id);
    const labels = ((await savedEvents(a.db, sent.turn.id)) as Saved[])
      .filter((event) => event.type === "step.finished")
      .map((event) => event.data.label);
    expect(labels).toEqual(["Asked for your confirmation"]);
    expect(await a.db.selectFrom("project").select("name").execute()).toEqual([{ name: "shop" }]);
  });
});

describe("no half-made app on a build error (C1-19)", () => {
  test("a two-line build command is refused before anything exists; the corrected call works", async () => {
    const browser = await owner();
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_git_url", {
        project: "shop",
        name: "web",
        url: "https://git.example.com/acme/web",
        server: "host",
        buildCommand: "npm ci\nnpm run build",
      }),
      call("create_app_from_git_url", {
        project: "shop",
        name: "web",
        url: "https://git.example.com/acme/web",
        server: "host",
        buildCommand: "npm ci && npm run build",
      }),
      say("Done."),
    );
    const sent = await send(browser, "import git.example.com/acme/web into shop, build with npm");
    await waitClosed(a.db, sent.turn.id);
    const rows = ((await savedEvents(a.db, sent.turn.id)) as Saved[])
      .filter((event) => event.type === "step.finished")
      .map((event) => [event.data.state, event.data.reason]);
    expect(rows[0]?.[0]).toBe("failed");
    expect(String(rows[0]?.[1])).toContain("Keep the command on one line");
    expect(rows[1]).toEqual(["succeeded", null]);
    const services = await a.db.selectFrom("service").select("name").execute();
    expect(services).toEqual([{ name: "web" }]);
    expect((await serviceSettings("web"))?.text).toContain("npm ci && npm run build");
  });

  test("the same refusal on a public-host link and a provider repository", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    const browser = await owner();
    await connectGithub(browser);
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_git_url", {
        project: "shop",
        name: "site",
        url: "https://github.com/acme/site",
        server: "host",
        startCommand: "node a.js\nnode b.js",
      }),
      call("create_app_from_provider", {
        project: "shop",
        name: "web",
        provider: "GitHub",
        repository: "acme/web",
        server: "host",
        installCommand: "npm ci\r\nrm -rf /",
      }),
      call("create_app_from_provider", {
        project: "shop",
        name: "nope",
        provider: "GitHub",
        repository: "acme/not-there",
        server: "host",
      }),
      say("Refused."),
    );
    const sent = await send(browser, "import them into shop");
    await waitClosed(a.db, sent.turn.id);
    const states = ((await savedEvents(a.db, sent.turn.id)) as Saved[])
      .filter((event) => event.type === "step.finished")
      .map((event) => event.data.state);
    expect(states).toEqual(["failed", "failed", "failed"]);
    expect(await a.db.selectFrom("service").select("name").execute()).toEqual([]);
  });
});

describe("the Agent never deletes a project with production (C1-18)", () => {
  test("not even when the person can't see its production environment", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop", ["production"]);
    await allowDeletes(browser);
    const member = await addMember(a.h, browser, "dev@example.com", {
      capabilities: ["projects.delete"],
      scope: { environmentIds: [project.environments.development as string] },
    });
    const view = await member.get(`/projects/${project.projectId}`);
    expect(JSON.stringify(view.body)).not.toContain(project.environments.production);
    const { worker } = deleteWorker();
    const sent = await send(member, "delete project shop");
    await waitClosed(a.db, sent.turn.id);
    await worker.runOnce();
    expect(textOf((await savedEvents(a.db, sent.turn.id)) as Saved[])).toContain(
      "has a production environment, so the Agent never deletes it.",
    );
    expect(
      (await a.db.selectFrom("environment").select("name").orderBy("name").execute()).map(
        (row) => row.name,
      ),
    ).toEqual(["development", "production"]);
    expect(await a.db.selectFrom("project").select("name").execute()).toEqual([{ name: "shop" }]);
  });
});

describe("servers that aren't set up take nothing (31d G4-03)", () => {
  test("creating on one is refused with setup's next step; deploying says the same", async () => {
    const browser = await owner();
    await readyServer(browser, "edge-2", "not_started");
    const failedId = await readyServer(browser, "edge-3", "failed");
    const project = await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_database", { project: "shop", name: "pg", kind: "postgres", server: "edge-2" }),
      say("Not set up."),
    );
    const sent = await send(browser, "create a postgres on edge-2 in shop");
    await waitClosed(a.db, sent.turn.id);
    const row = ((await savedEvents(a.db, sent.turn.id)) as Saved[]).find(
      (event) => event.type === "step.finished",
    );
    expect(row?.data.state).toBe("failed");
    expect(row?.data.reason).toBe(
      "Server \"edge-2\" isn't ready for deployments: it hasn't been set up yet, so nothing was created. Run setup from the server's page (or ask me to set it up), then ask again.",
    );
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);

    // A service already on a server whose setup failed: its deploy says so.
    await a.db
      .updateTable("server")
      .set({ setup_state: "ready" })
      .where("id", "=", failedId)
      .execute();
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
      serverId: failedId,
    });
    await a.db
      .updateTable("server")
      .set({ setup_state: "failed" })
      .where("id", "=", failedId)
      .execute();
    a.model.queue.push(call("deploy_service", { service: "cache" }), say("Not set up."));
    const deploy = await send(browser, "deploy the cache now please", sent.session.id);
    await waitClosed(a.db, deploy.turn.id);
    const deployRow = ((await savedEvents(a.db, deploy.turn.id)) as Saved[]).find(
      (event) => event.type === "step.finished",
    );
    expect(deployRow?.data.reason).toContain(
      'Server "edge-3" isn\'t ready for deployments: its setup failed, so nothing was deployed.',
    );
    expect(await a.db.selectFrom("deployment").select("id").execute()).toEqual([]);
  });

  test("the guided import with a named server that isn't set up creates nothing", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    const browser = await owner();
    await readyServer(browser, "edge-2", "not_started");
    const sent = await send(browser, "deploy https://github.com/acme/web on edge-2");
    await waitClosed(a.db, sent.turn.id);
    expect(textOf((await savedEvents(a.db, sent.turn.id)) as Saved[])).toContain(
      'Server "edge-2" isn\'t ready for deployments',
    );
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);
  });
});

describe("after setup, the Agent gives the server's app-address guide (31d G4-04)", () => {
  const dnsRecords = new Map<string, string[]>();
  const fakeDns: DnsLookup = {
    async resolve4(name) {
      const direct = dnsRecords.get(name);
      if (direct) return direct;
      const wildcard = dnsRecords.get(`*.${name.slice(name.indexOf(".") + 1)}`);
      if (wildcard) return wildcard;
      throw new LookupError("not_found", `${name} doesn't exist`);
    },
    async resolve6() {
      throw new LookupError("no_data", "none");
    },
    async resolveCname() {
      throw new LookupError("no_data", "none");
    },
    async resolveNs(name) {
      if (name === "example.com") return ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
      throw new LookupError("no_data", "none");
    },
    async soaSerialAt() {
      throw new LookupError("failed", "none");
    },
  };

  async function setUpWith(pointsHere: boolean) {
    const domains = a.h.services.domains;
    const saved = { platformDomain: domains.platformDomain, dns: domains.dns };
    const port = { start: serverSetupPort.start, progress: serverSetupPort.progress };
    Object.assign(domains, { platformDomain: "apps.example.com", dns: fakeDns });
    serverSetupPort.start = async () => ({ started: true });
    serverSetupPort.progress = async () => ({ state: "succeeded", step: null, failure: null });
    try {
      const browser = await owner();
      await browser.put("/workspace/agent-policies", { switches: { "servers.setup": true } });
      const serverId = await readyServer(browser, "edge-1", "not_started");
      const server = await a.db
        .selectFrom("server")
        .select(["label", "address"])
        .where("id", "=", serverId)
        .executeTakeFirstOrThrow();
      dnsRecords.clear();
      if (pointsHere) dnsRecords.set(`*.${server.label}.apps.example.com`, [server.address]);
      a.model.queue.push(call("run_server_setup", { server: "edge-1" }), say("Done."));
      const sent = await send(browser, "set up edge-1");
      await waitClosed(a.db, sent.turn.id);
      const row = ((await savedEvents(a.db, sent.turn.id)) as Saved[]).find(
        (event) => event.type === "step.finished",
      );
      return { result: String(row?.data.result ?? ""), server };
    } finally {
      Object.assign(domains, saved);
      Object.assign(serverSetupPort, port);
    }
  }

  test("a wildcard that already points at the server: addresses are ready, no record", async () => {
    const { result, server } = await setUpWith(true);
    expect(result).toContain(
      `Apps on edge-1 get their own address under ${server.label}.apps.example.com, with HTTPS, automatically.`,
    );
    expect(result).not.toContain("dnsRecord");
  });

  test("otherwise the record relative to the zone, the provider and its steps, and where it points", async () => {
    const { result, server } = await setUpWith(false);
    expect(result).toContain("Add one DNS record in Cloudflare");
    expect(result).toContain(`| A | *.${server.label}.apps | ${server.address} | DNS only |`);
    expect(result).toContain('"provider": "Cloudflare"');
    expect(result).toContain("steps");
    expect(result).toContain("pointsNow");
  });
});

describe("the model finishes the job (31d G4-05)", () => {
  test("the built-in rules ask it to fix and redeploy, prefer a connected account, and report pushes", () => {
    const prompt = systemPrompt({
      personName: "Olivia",
      role: "owner",
      workspaceName: "Acme",
      policies: {} as never,
      deepResearch: false,
      researchAvailable: false,
      hasFiles: false,
      modelSeesImages: false,
      today: "2026-11-28",
      operatorText: null,
    });
    expect(prompt).toContain("Finish the job. When a deploy fails, read its log");
    expect(prompt).toContain("prefer a connected Git account that can see it");
    expect(prompt).toContain("ask for the variables its example env file lists");
    expect(prompt).toContain("set it up first with run_server_setup");
    expect(prompt).toContain("check how pushes reach it (read_push_deploys)");
  });

  test("a failed deployment's result says to fix and deploy again, with the deploys left", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    const web = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine" },
    });
    await a.db
      .insertInto("deployment")
      .values({
        workspace_id: await workspaceIdOf(browser),
        service_id: web.service.id,
        service_kind: "application",
        service_name: "web",
        app_name: "web",
        project_name: "shop",
        environment_name: "development",
        server_name: "Nearzero host",
        trigger: "manual",
        status: "failed",
        error: "The app stopped right after it started.",
      })
      .execute();
    a.model.queue.push(
      call("follow_deployment", { service: "web", seconds: 5 }),
      say("It failed."),
    );
    const sent = await send(browser, "how did the web deploy go");
    await waitClosed(a.db, sent.turn.id);
    const row = ((await savedEvents(a.db, sent.turn.id)) as Saved[]).find(
      (event) => event.type === "step.finished",
    );
    expect(row?.data.result).toContain(
      "then deploy again and follow it. 6 more deploys of web are allowed",
    );
  });
});

describe("host-mode ports, the Railpack version and the Heroku stack (31d G4-08)", () => {
  test("set the same fields the console sets", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "game",
      settings: { image: "nginx:alpine" },
    });
    await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine" },
    });
    a.model.queue.push(
      call("add_port", {
        service: "game",
        containerPort: 9000,
        publishedPort: 9000,
        protocol: "udp",
        mode: "host",
      }),
      call("change_app_build", { service: "web", builder: "heroku", herokuStack: "22" }),
      call("change_app_build", { service: "game", builder: "railpack", railpackVersion: "0.42.0" }),
      say("Done."),
    );
    const sent = await send(browser, "publish UDP 9000 in host mode on game, and the builds");
    await waitClosed(a.db, sent.turn.id);
    const states = ((await savedEvents(a.db, sent.turn.id)) as Saved[])
      .filter((event) => event.type === "step.finished")
      .map((event) => [event.data.state, event.data.reason]);
    expect(states).toEqual([
      ["succeeded", null],
      ["succeeded", null],
      ["succeeded", null],
    ]);
    const game = (await serviceSettings("game"))?.settings as {
      ports: { containerPort: number; protocol: string; mode: string }[];
      build: Record<string, unknown>;
    };
    expect(game.ports).toEqual([
      expect.objectContaining({
        containerPort: 9000,
        publishedPort: 9000,
        protocol: "udp",
        mode: "host",
      }),
    ]);
    expect(game.build).toMatchObject({ type: "railpack", version: "0.42.0" });
    expect((await serviceSettings("web"))?.settings).toMatchObject({
      build: { type: "heroku", stack: "22" },
    });
  });
});

describe("0.1.x's other Agent settings (30d R4-09, 31d G4-10)", () => {
  test("the byte cap, model inputs, PDF parser and the provider's referer and title are read", () => {
    expect(agentSettingsFromEnv({ NEARZERO_AGENT_ATTACHMENT_MAX_BYTES: "5242880" })).toMatchObject({
      attachmentsMaxBytes: 5_242_880,
    });
    // 1.0's own setting wins when both are set.
    expect(
      agentSettingsFromEnv({
        NEARZERO_AGENT_ATTACHMENT_MAX_BYTES: "5242880",
        NEARZERO_AGENT_ATTACHMENTS_MAX_MB: "8",
      }).attachmentsMaxBytes,
    ).toBe(8 * 1024 * 1024);
    expect(agentSettingsFromEnv({ NEARZERO_AGENT_MODEL_INPUTS: "image,file" })).toMatchObject({
      modelInputsFallback: { images: true, pdfs: true, video: false },
    });
    expect(agentSettingsFromEnv({ NEARZERO_AGENT_PDF_ENGINE: "mistral-ocr" }).pdfEngine).toBe(
      "mistral-ocr",
    );
    expect(agentSettingsFromEnv({ NEARZERO_AGENT_PDF_ENGINE: "whatever" }).pdfEngine).toBe(
      undefined,
    );
    expect(
      agentSettingsFromEnv({
        OPENROUTER_HTTP_REFERER: "https://ops.example.com",
        OPENROUTER_X_TITLE: "Acme Ops",
      }),
    ).toMatchObject({ providerReferer: "https://ops.example.com", providerTitle: "Acme Ops" });
    expect(modelInputsFrom("")).toBeNull();
  });

  test("model requests carry HTTP-Referer and X-Title, and name the free PDF parser for a PDF", async () => {
    const seen: { headers: Headers; body: Record<string, unknown> }[] = [];
    const fetch = async (_input: unknown, init?: RequestInit) => {
      seen.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ choices: [{ message: { content: "ok" } }] });
    };
    const provider = new OpenRouterProvider(
      "https://openrouter.test/api/v1",
      fetch,
      Date.now,
      () => ({
        referer: "https://console.acme.test",
        title: "Nearzero",
      }),
    );
    const options = { signal: new AbortController().signal, silenceMs: 5_000 };
    await provider.complete(
      "key",
      { model: "m", messages: [{ role: "user", content: "hi" }], pdfEngine: "pdf-text" },
      options,
    );
    expect(seen[0]?.headers.get("http-referer")).toBe("https://console.acme.test");
    expect(seen[0]?.headers.get("x-title")).toBe("Nearzero");
    // No PDF in the request: no parser is named.
    expect(seen[0]?.body.plugins).toBeUndefined();
    await provider.complete(
      "key",
      {
        model: "m",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "read this" },
              {
                type: "file",
                file: { filename: "a.pdf", file_data: "data:application/pdf;base64,JVBERi0=" },
              },
            ],
          },
        ],
        pdfEngine: "pdf-text",
      },
      options,
    );
    expect(seen[1]?.body.plugins).toEqual([{ id: "file-parser", pdf: { engine: "pdf-text" } }]);
  });

  test("a turn with a PDF names the free parser for a model without native PDF input", async () => {
    const browser = await owner();
    const pdf = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
    const engineFor = async () => {
      const uploaded = await browser.request("POST", "/agent/files?name=spec.pdf", pdf, {
        "content-type": "application/pdf",
      });
      expect(uploaded.status).toBe(201);
      a.model.requests.length = 0;
      a.model.queue.push(say("Read it."));
      const sent = await send(browser, "read this pdf", undefined, {
        fileIds: [uploaded.body.file.id],
      });
      await waitClosed(a.db, sent.turn.id);
      const request = a.model.requests.find(
        (item) => item.stream && JSON.stringify(item.body).includes('"file_data"'),
      );
      return (request?.body.plugins as { pdf: { engine: string } }[] | undefined)?.[0]?.pdf.engine;
    };
    // The test model's listing says it reads files itself; the small one reads text only.
    expect(await engineFor()).toBe("native");
    configureAgent(a.h.services, { model: "test/small" });
    expect(await engineFor()).toBe("pdf-text");
    // The operator's choice wins.
    configureAgent(a.h.services, { pdfEngine: "mistral-ocr" });
    expect(await engineFor()).toBe("mistral-ocr");
  });
});
