import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "kysely";
import { pruneUnsentFiles } from "../../src/agent/files.ts";
import { intentOf, repositoryLink } from "../../src/agent/flows/parse.ts";
import type { PublicInspection, PublicRefs } from "../../src/agent/flows/public-repo.ts";
import { configureAgent } from "../../src/agent/settings.ts";
import { removeServicesJob } from "../../src/deletion/job.ts";
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
 * W1's round 2 Agent fixes: deletes checked again when they run (B1-21, B1-55), production left
 * out of the Agent's copies (B1-56), shared sessions filtered by the viewer (B1-22), bounded
 * uploads (B1-23, B1-58), Retry and Edit only on the last turn (B1-57), the server picker on the
 * model's path (30d R4-08) and pasted repository links checked before anything is promised
 * (30d R4-01).
 */

setDefaultTimeout(400_000);

let a: AgentHarness;
let hosts: FakeGitHosts;

beforeAll(async () => {
  a = await createAgentHarness("nz_w1_agent_");
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
    queue: new JobQueue(a.db, { workerId: "w1-test" }),
    definitions: [removeServicesJob(teardown)],
    log: silentLogger,
  });
  return { teardown, worker };
}

async function projectNames(): Promise<string[]> {
  return (await a.db.selectFrom("project").select("name").orderBy("name").execute()).map(
    (row) => row.name,
  );
}

async function readyServer(browser: Browser, name: string): Promise<string> {
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
      address: "198.51.100.4",
      ssh_user: "root",
      ssh_key_id: key.id,
      label: `${name}${Date.now().toString(36)}`,
      setup_state: "ready",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

describe("a project delete is checked again when it runs (B1-21, B1-55)", () => {
  test("a production environment added while the form waited: nothing is deleted", async () => {
    const browser = await owner();
    await allowDeletes(browser);
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    const { worker } = deleteWorker();
    const sent = await send(browser, "delete shop");
    const form = await nextForm(sent.turn.id);
    // Someone adds production meanwhile (and the cache is copied into it).
    const added = await browser.post(`/projects/${project.projectId}/environments`, {
      name: "production",
    });
    expect(added.status).toBe(201);
    await answer(browser, sent.turn.id, form.formId, { outcome: "delete" });
    await waitClosed(a.db, sent.turn.id);
    await worker.runOnce();
    expect(textOf((await savedEvents(a.db, sent.turn.id)) as Saved[])).toContain(
      "has a production environment, so the Agent never deletes it.",
    );
    expect(await projectNames()).toEqual(["shop"]);
    const jobs = await a.db.selectFrom("job").select("kind").execute();
    expect(jobs.some((job) => job.kind.includes("remove"))).toBe(false);
  });

  test('"Delete projects without production" turned off while the form waited: refused', async () => {
    const browser = await owner();
    await allowDeletes(browser);
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    const sent = await send(browser, "delete shop");
    const form = await nextForm(sent.turn.id);
    await allowDeletes(browser, false);
    await answer(browser, sent.turn.id, form.formId, { outcome: "delete" });
    await waitClosed(a.db, sent.turn.id);
    expect(textOf((await savedEvents(a.db, sent.turn.id)) as Saved[])).toContain(
      '"Delete projects without production" is off',
    );
    expect(await projectNames()).toEqual(["shop"]);

    // The model's own delete is checked the same way when its form is answered.
    await allowDeletes(browser);
    a.model.queue.push(call("delete_project", { project: "shop" }), say("Asked."));
    const modelled = await send(
      browser,
      "please remove the shop project and its cache",
      sent.session.id,
    );
    const asked = await nextForm(modelled.turn.id);
    await allowDeletes(browser, false);
    a.model.queue.push(say("It was refused."));
    await answer(browser, modelled.turn.id, asked.formId, { outcome: "delete" });
    await waitClosed(a.db, modelled.turn.id);
    expect(await projectNames()).toEqual(["shop"]);
  });
});

describe("production is left out of the Agent's copies while production changes are off (B1-56)", () => {
  test("a database created in development isn't copied into production", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop", ["staging", "production"]);
    a.model.queue.push(
      call("create_database", { kind: "redis", project: "shop", name: "cache" }),
      say("Created."),
    );
    const sent = await send(browser, "create a redis called cache in shop");
    await waitClosed(a.db, sent.turn.id);
    const copies = await a.db
      .selectFrom("service")
      .select(["environment_id"])
      .where("name", "=", "cache")
      .execute();
    const where = new Set(copies.map((row) => row.environment_id));
    expect(where.has(project.environments.development as string)).toBe(true);
    expect(where.has(project.environments.staging as string)).toBe(true);
    expect(where.has(project.environments.production as string)).toBe(false);
    const told = JSON.stringify(a.model.turns.at(-1)?.body.messages);
    expect(told).toContain("production: Not copied");
  });
});

describe("Retry and Edit only on the last turn (B1-57)", () => {
  test("an older page never marks its newest turn editable, and an older turn can't be retried", async () => {
    const browser = await owner();
    let sessionId: string | undefined;
    const turns: string[] = [];
    for (let i = 0; i < 32; i++) {
      a.model.queue.push(say(`answer ${i}`));
      const sent = await send(browser, `question number ${i}`, sessionId);
      sessionId = sent.session.id;
      turns.push(sent.turn.id);
      await waitClosed(a.db, sent.turn.id);
    }
    const first = await browser.get(`/agent/sessions/${sessionId}`);
    expect(first.body.more).toBe(true);
    const oldest = first.body.turns[0].id;
    const older = await browser.get(`/agent/sessions/${sessionId}?before=${oldest}`);
    expect(older.body.turns.length).toBeGreaterThan(0);
    expect(older.body.turns.some((turn: { canEdit: boolean }) => turn.canEdit)).toBe(false);
    expect(older.body.turns.some((turn: { canRetry: boolean }) => turn.canRetry)).toBe(false);
    expect(first.body.turns.at(-1).canEdit).toBe(true);
    const retried = await browser.post(`/agent/sessions/${sessionId}/messages`, {
      text: "",
      retryOf: turns[3],
    });
    expect(retried.status).toBe(409);
    expect(retried.body.error.message).toBe(
      "Only the last message in a chat can be retried or edited. Send a new message instead.",
    );
  });
});

describe("attachments (B1-23, B1-58)", () => {
  const upload = (browser: Browser, name: string, body: string | Uint8Array, sessionId?: string) =>
    browser.request(
      "POST",
      `/agent/files?name=${encodeURIComponent(name)}${sessionId ? `&sessionId=${sessionId}` : ""}`,
      typeof body === "string" ? new TextEncoder().encode(body) : body,
      {
        "content-type": name.endsWith(".docx")
          ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          : "text/plain",
      },
    );

  test("a damaged Word document is refused with a reason, not an internal error", async () => {
    const browser = await owner();
    // A ZIP whose document.xml claims deflate but holds garbage.
    const name = new TextEncoder().encode("word/document.xml");
    const data = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x13, 0x37]);
    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, 1000, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, 1000, true);
    cv.setUint16(28, name.length, true);
    central.set(name, 46);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, local.length, true);
    const docx = new Uint8Array([...local, ...central, ...end]);
    const reply = await upload(browser, "broken.docx", docx);
    expect(reply.status).toBe(400);
    expect(reply.body.error.message).toBe(
      "This Word document couldn't be read. Save it again as .docx or PDF.",
    );
  });

  test("unsent uploads are bounded per person, kept with their chat, and pruned after a day", async () => {
    const browser = await owner();
    a.model.queue.push(say("Hi."));
    const chat = await send(browser, "hello");
    await waitClosed(a.db, chat.turn.id);
    const kept = await upload(browser, "notes.txt", "remember this", chat.session.id);
    expect(kept.status).toBe(201);
    const replies = await Promise.all(
      Array.from({ length: 24 }, (_, i) => upload(browser, `n${i}.txt`, `note ${i}`)),
    );
    expect(replies.filter((reply) => reply.status === 201).length).toBe(19);
    const refused = replies.find((reply) => reply.status === 409);
    expect(refused?.body.error.message).toContain("waiting to be sent");
    // Deleting the chat deletes the file attached to it before it was sent.
    expect((await browser.delete(`/agent/sessions/${chat.session.id}`)).status).toBe(200);
    expect(
      await a.db
        .selectFrom("agent_file")
        .select("id")
        .where("id", "=", kept.body.file.id)
        .executeTakeFirst(),
    ).toBeUndefined();
    // A day later, nothing unsent is left.
    await a.db
      .updateTable("agent_file")
      .set({ created_at: sql<Date>`now() - interval '25 hours'` })
      .execute();
    expect(await pruneUnsentFiles(a.db)).toBe(19);
    expect((await upload(browser, "again.txt", "fine")).status).toBe(201);
  });
});

describe("a shared chat shows others only what they may see (B1-22)", () => {
  test("SSH key lists, guided rows and forms are the author's", async () => {
    const browser = await owner();
    await browser.put("/workspace/agent-policies", { switches: { "ssh-keys.read": true } });
    await readyServer(browser, "prod-1");
    const member = await addMember(a.h, browser, "mia@example.com");
    expect((await member.get("/ssh-keys")).status).toBe(403);
    a.model.queue.push(call("list_ssh_keys", {}), say("You have one key."));
    const listed = await send(browser, "which ssh keys do we have");
    await waitClosed(a.db, listed.turn.id);
    await allowDeletes(browser);
    await makeProject(browser, "shop").then((project) =>
      makeService(browser, project.environments.development as string, {
        kind: "redis",
        name: "secret-cache",
      }),
    );
    const asked = await send(browser, "delete shop", listed.session.id);
    await nextForm(asked.turn.id);
    expect(
      (await browser.post(`/agent/sessions/${listed.session.id}/share`, { shared: true })).status,
    ).toBe(200);

    const seen = await member.get(`/agent/sessions/${listed.session.id}`);
    expect(seen.status).toBe(200);
    const text = JSON.stringify(seen.body.turns.map((turn: { events: unknown }) => turn.events));
    expect(text).not.toContain("SHA256:prod-1");
    expect(text).not.toContain("prod-1-key");
    expect(text).not.toContain("secret-cache");
    expect(text).toContain("form.requested");
    // The author still sees everything.
    const own = JSON.stringify((await browser.get(`/agent/sessions/${listed.session.id}`)).body);
    expect(own).toContain("prod-1-key");
    expect(own).toContain("secret-cache");
    await answer(browser, asked.turn.id, (await nextForm(asked.turn.id)).formId, {
      outcome: "keep",
    });
    await waitClosed(a.db, asked.turn.id);
  });
});

describe("the model asks which server, never placing silently (30d R4-08)", () => {
  test("with exactly one ready server, the person picks it (or the Nearzero host)", async () => {
    const browser = await owner();
    const serverId = await readyServer(browser, "prod-1");
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_image", { project: "shop", name: "web", image: "nginx:1" }),
      say("Created web."),
    );
    const sent = await send(browser, "run nginx as web in shop");
    const form = await nextForm(sent.turn.id);
    expect(form.form).toMatchObject({ kind: "picker", purpose: "server" });
    expect(form.form.options.map((option: { value: string }) => option.value)).toEqual([
      serverId,
      "host",
    ]);
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);
    await answer(browser, sent.turn.id, form.formId, { outcome: "chosen", option: serverId });
    await waitClosed(a.db, sent.turn.id);
    const created = await a.db
      .selectFrom("service")
      .select(["name", "server_id"])
      .where("name", "=", "web")
      .execute();
    expect(created).toEqual([{ name: "web", server_id: serverId }]);
  });
});

describe("pasted repository links are checked before anything is promised (30d R4-01)", () => {
  test("link shapes: https, bare, .git, /tree/<branch>; questions, SSH and other hosts are the model's", () => {
    expect(repositoryLink("https://github.com/acme/web")).toEqual({
      host: "github.com",
      fullName: "acme/web",
      branch: null,
    });
    expect(repositoryLink("gitlab.com/acme/web.git")?.fullName).toBe("acme/web");
    expect(repositoryLink("https://github.com/acme/web/tree/dev")?.branch).toBe("dev");
    expect(repositoryLink("https://codeberg.org/acme/web")?.host).toBe("codeberg.org");
    expect(intentOf("deploy https://github.com/acme/web")).toMatchObject({
      flow: "git_link",
      deploy: true,
    });
    expect(intentOf("github.com/acme/web")).toMatchObject({ flow: "git_link" });
    expect(intentOf("just import bitbucket.org/acme/web")).toMatchObject({
      flow: "git_link",
      deploy: false,
    });
    expect(intentOf("what does github.com/acme/web do?")).toBeNull();
    expect(intentOf("deploy git@github.com:acme/web.git")).toBeNull();
    expect(intentOf("deploy https://git.example.com/acme/web")).toBeNull();
    expect(intentOf("fork github.com/acme/web and rewrite it in rust")).toBeNull();
  });

  test("a public repository no account can see: deployed from its URL on its real default branch, the server picked", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "master", branches: ["master", "dev"] };
    const browser = await owner();
    const serverId = await readyServer(browser, "prod-1");
    const sent = await send(browser, "deploy https://github.com/acme/web");
    const server = await nextForm(sent.turn.id);
    expect(server.form).toMatchObject({ kind: "picker", purpose: "server" });
    await answer(browser, sent.turn.id, server.formId, { outcome: "chosen", option: serverId });
    const variables = await nextForm(sent.turn.id, server.formId);
    expect(variables.form.kind).not.toBe("picker");
    expect(publicHost.calls).toEqual([
      "refs https://github.com/acme/web.git",
      "inspect https://github.com/acme/web.git master",
    ]);
    const service = await a.db
      .selectFrom("service")
      .select(["id", "settings", "server_id"])
      .where("name", "=", "web")
      .executeTakeFirstOrThrow();
    expect(service.server_id).toBe(serverId);
    expect(JSON.stringify(service.settings)).toContain("https://github.com/acme/web.git");
    expect(JSON.stringify(service.settings)).toContain("master");
    expect(a.model.turns).toHaveLength(0);
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);
  });

  test("a /tree/dev link deploys dev, only because the repository has it", async () => {
    usePublicHost();
    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main", "dev"] };
    const browser = await owner();
    const sent = await send(browser, "deploy github.com/acme/web/tree/dev");
    await nextForm(sent.turn.id);
    expect(publicHost.calls).toContain("inspect https://github.com/acme/web.git dev");
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);

    publicHost.calls = [];
    const missing = await send(browser, "deploy github.com/acme/web/tree/nope", sent.session.id);
    // The first import made a project, so this one asks where it goes first.
    const project = await nextForm(missing.turn.id);
    expect(project.form.purpose).toBe("project");
    await answer(browser, missing.turn.id, project.formId, { outcome: "chosen", option: "new" });
    await nextForm(missing.turn.id, project.formId);
    expect(publicHost.calls).toContain("inspect https://github.com/acme/web.git main");
    await browser.post(`/agent/turns/${missing.turn.id}/stop`);
    await waitClosed(a.db, missing.turn.id);
  });

  test("a private or missing repository: the access card, nothing created; Check again continues once it can be read", async () => {
    usePublicHost();
    const browser = await owner();
    const sent = await send(browser, "deploy https://github.com/acme/secret");
    const card = await nextForm(sent.turn.id);
    const events = (await savedEvents(a.db, sent.turn.id)) as Saved[];
    expect(textOf(events)).toContain(
      "I can't open acme/secret. It's private or doesn't exist, and no GitHub account is connected to Nearzero.",
    );
    expect(textOf(events)).toContain("Give Nearzero access to it, then check again.");
    expect(card.form.options.map((option: { label: string }) => option.label)).toEqual([
      "Connect GitHub",
      "Check again",
    ]);
    expect(await projectNames()).toEqual([]);
    expect(await a.db.selectFrom("service").select("id").execute()).toEqual([]);
    const turn = await a.db
      .selectFrom("agent_turn")
      .select("wait")
      .where("id", "=", sent.turn.id)
      .executeTakeFirstOrThrow();
    expect(JSON.stringify(turn.wait)).toContain("Waiting for access to the repository");

    publicHost.refs = { kind: "public", defaultBranch: "main", branches: ["main"] };
    await answer(browser, sent.turn.id, card.formId, { outcome: "chosen", option: "check" });
    await nextForm(sent.turn.id, card.formId);
    expect(publicHost.calls).toContain("inspect https://github.com/acme/secret.git main");
    expect(await projectNames()).toEqual(["secret"]);
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    await waitClosed(a.db, sent.turn.id);
  });

  test("a host that can't be reached says so, and a public repository with no branches too", async () => {
    usePublicHost();
    publicHost.refs = { kind: "unreachable", reason: "the connection failed." };
    const browser = await owner();
    const down = await send(browser, "deploy github.com/acme/web");
    await waitClosed(a.db, down.turn.id);
    expect(textOf((await savedEvents(a.db, down.turn.id)) as Saved[])).toBe(
      "I couldn't reach github.com to check **acme/web**: the connection failed. Nothing was created. Try again in a moment.",
    );
    publicHost.refs = { kind: "public", defaultBranch: null, branches: [] };
    const empty = await send(browser, "deploy github.com/acme/web", down.session.id);
    await waitClosed(a.db, empty.turn.id);
    expect(textOf((await savedEvents(a.db, empty.turn.id)) as Saved[])).toBe(
      "**acme/web** on GitHub is public, but it has no branches yet. Push some code to it, then ask again.",
    );
    expect(await projectNames()).toEqual([]);
  });

  test("someone who may not connect accounts is told to ask an owner or admin", async () => {
    usePublicHost();
    const browser = await owner();
    const member = await addMember(a.h, browser, "mia@example.com", {
      capabilities: ["services.create"],
    });
    const sent = await send(member, "deploy github.com/acme/secret");
    await waitClosed(a.db, sent.turn.id);
    expect(textOf((await savedEvents(a.db, sent.turn.id)) as Saved[])).toContain(
      "ask an owner or admin to connect the GitHub account that owns it (Settings → Git providers). Nothing was created.",
    );
  });
});
