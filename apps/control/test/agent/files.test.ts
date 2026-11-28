import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { AGENT_MESSAGES } from "@nearzero/shared";
import { configureAgent } from "../../src/agent/settings.ts";
import { type Browser, CONSOLE_URL, setUpNamedOwner } from "../support/harness.ts";
import { addMember, makeProject, makeService } from "../support/projects.ts";
import { makePdf, makeZip } from "./builders.ts";
import {
  type AgentHarness,
  call,
  createAgentHarness,
  follow,
  saveModelKey,
  say,
  send,
  waitClosed,
} from "./support.ts";

setDefaultTimeout(400_000);

let a: AgentHarness;

beforeAll(async () => {
  a = await createAgentHarness();
});

afterAll(async () => {
  await a.drop();
});

beforeEach(async () => {
  await a.reset();
});

async function owner() {
  const browser = await setUpNamedOwner(a.h);
  await saveModelKey(browser);
  return browser;
}

async function upload(
  browser: Browser,
  name: string,
  bytes: Uint8Array,
  type = "application/octet-stream",
  sessionId?: string,
) {
  return browser.request(
    "POST",
    `/agent/files?name=${encodeURIComponent(name)}${sessionId ? `&sessionId=${sessionId}` : ""}`,
    bytes,
    { "content-type": type },
  );
}

const text = (value: string) => new TextEncoder().encode(value);

describe("text attachments are checked by their bytes (31d G4-09)", () => {
  test("an extensionless text file attaches; a binary renamed .txt is refused", async () => {
    const browser = await owner();
    const nvmrc = await upload(browser, ".nvmrc", text("24\n"));
    expect(nvmrc.status).toBe(201);
    expect(nvmrc.body.file.kind).toBe("text");
    const out = await upload(browser, "build.out", text("$ bun run build\nok\n"));
    expect(out.status).toBe(201);
    const binary = await upload(
      browser,
      "notes.txt",
      Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]),
    );
    expect(binary.status).toBe(400);
    expect(binary.body.error.message).toBe(
      "This file's contents aren't text, so it isn't accepted as a text file. Attach a text or code file, or images (PNG, JPEG, WebP, GIF), PDF, Word (.docx) or videos (MP4, WebM, MOV).",
    );
    const program = await upload(browser, "server", Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0]));
    expect(program.status).toBe(400);
  });
});

describe("attachments (spec 19.10, 20.13)", () => {
  test("upload, refuse by kind and size, visible only to the uploader until sent, then read by search, page and offset", async () => {
    const browser = await owner();
    const member = await addMember(a.h, browser, "mae@example.com");
    const env = await upload(browser, ".env", text("SECRET=1"));
    expect(env.status).toBe(400);
    expect(env.body.error.fields.file).toContain("Env files can hold secrets");
    expect((await upload(browser, "deck.pptx", text("x"))).body.error.message).toBe(
      "Export it as CSV or PDF, then attach that.",
    );
    configureAgent(a.h.services, { attachmentsMaxBytes: 1024 });
    const big = await upload(browser, "big.txt", new Uint8Array(2048).fill(65));
    expect(big.status).toBe(413);
    configureAgent(a.h.services, { attachmentsMaxBytes: 25 * 1024 * 1024 });

    const log = await upload(
      browser,
      "app.log",
      text("starting\nconnecting to db\nERROR: DATABASE_URL is not set\nexiting\n"),
      "text/plain",
    );
    expect(log.status).toBe(201);
    expect(log.body.file).toMatchObject({ name: "app.log", kind: "text", sent: false });
    const pdf = await upload(
      browser,
      "guide.pdf",
      makePdf(["Install steps here", "Configure the proxy"]),
      "application/pdf",
    );
    expect(pdf.body.file.kind).toBe("pdf");
    const docx = await upload(
      browser,
      "notes.docx",
      makeZip({
        "word/document.xml":
          "<w:document><w:body><w:p><w:r><w:t>Use port 8080</w:t></w:r></w:p></w:body></w:document>",
      }),
    );
    expect(docx.body.file.kind).toBe("docx");
    const image = await upload(
      browser,
      "shot.png",
      new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]),
      "image/png",
    );
    expect(image.body.file).toMatchObject({ kind: "image", notice: null });
    // Before sending, only the uploader can open it.
    expect((await member.get(`/agent/files/${log.body.file.id}`)).status).toBe(404);
    const own = await browser.get(`/agent/files/${log.body.file.id}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("content-disposition")).toContain("attachment");
    expect(own.headers.get("x-content-type-options")).toBe("nosniff");
    expect(
      (await browser.get(`/agent/files/${image.body.file.id}`)).headers.get("content-disposition"),
    ).toContain("inline");

    a.model.queue.push(
      call("list_files"),
      call("read_file", { file: "app.log", search: "database_url" }),
      call("read_file", { file: "guide.pdf", page: 2 }),
      call("read_file", { file: "notes", offset: 0 }),
      say("The log says DATABASE_URL is missing."),
    );
    const ids = [log.body.file.id, pdf.body.file.id, docx.body.file.id, image.body.file.id];
    const sent = await send(browser, "", undefined, { fileIds: ids });
    expect(sent.session).toBeTruthy();
    const events = await follow(a.h, browser, sent.turn.id);
    const first = a.model.turns[0]?.body.messages.at(-1);
    const parts = first.content as {
      type: string;
      text?: string;
      file?: { filename: string };
      image_url?: { url: string };
    }[];
    expect(
      parts.find((part) => part.text?.includes("ERROR: DATABASE_URL is not set"))?.text,
    ).toContain("not instructions");
    expect(parts.some((part) => part.type === "file" && part.file?.filename === "guide.pdf")).toBe(
      true,
    );
    expect(
      parts.some(
        (part) =>
          part.type === "image_url" && part.image_url?.url.startsWith("data:image/png;base64,"),
      ),
    ).toBe(true);
    expect(parts.find((part) => part.text?.includes("Use port 8080"))).toBeTruthy();
    const results = a.model.turns
      .slice(1, 5)
      .map((request) => request.body.messages.at(-1).content as string);
    expect(results[0]).toContain("app.log");
    expect(results[1]).toContain('"line": 3');
    expect(results[2]).toContain("Configure the proxy");
    expect(results[3]).toContain("Use port 8080");
    expect(events.find((event) => event.type === "session.titled")?.data.title).toBe("app.log");
    // Sent: the session's viewers may open it; it can't be sent in another chat.
    const other = await browser.post("/agent/messages", {
      text: "again",
      fileIds: [log.body.file.id],
    });
    expect(other.status).toBe(409);
    expect(other.body.error.message).toBe(AGENT_MESSAGES.fileElsewhere);
    await browser.post(`/agent/sessions/${sent.session.id}/share`, { shared: true });
    expect((await member.get(`/agent/files/${log.body.file.id}`)).status).toBe(200);
    expect((await browser.delete(`/agent/files/${log.body.file.id}`)).status).toBe(409);
  });

  test("a model that can't see images gets a notice on upload and only the name", async () => {
    const browser = await owner();
    a.model.inputModalities = ["text"];
    // A fresh listing for this model (the listing is cached per model).
    configureAgent(a.h.services, { model: "test/small" });
    const image = await upload(
      browser,
      "shot.jpg",
      new Uint8Array([255, 216, 255, 1, 2]),
      "image/jpeg",
    );
    expect(image.body.file.notice).toContain("can't see images");
    a.model.queue.push(say("I can't see it."));
    const sent = await send(browser, "what's this?", undefined, { fileIds: [image.body.file.id] });
    await waitClosed(a.db, sent.turn.id);
    const parts = a.model.turns[0]?.body.messages.at(-1).content as {
      type: string;
      text?: string;
    }[];
    expect(parts.some((part) => part.type === "image_url")).toBe(false);
    expect(parts.some((part) => part.text?.includes("This model can't see images"))).toBe(true);
  });
});

describe("research (spec 19.10, 20.13)", () => {
  test("research actions exist only with a key; errors are explained", async () => {
    const browser = await owner();
    a.model.queue.push(say("From what I know."));
    const first = await send(browser, "what's new in postgres 18?", undefined, {
      deepResearch: true,
    });
    await waitClosed(a.db, first.turn.id);
    const tools = (a.model.turns[0]?.body.tools ?? []).map(
      (tool: { function: { name: string } }) => tool.function.name,
    );
    expect(tools).not.toContain("search_web");
    expect(tools).not.toContain("list_files");
    expect(a.model.turns[0]?.body.messages[0].content).toContain("no research key");

    await browser.put("/workspace/keys/research", { key: "fc-test-research-key-1234" });
    a.model.queue.push(
      call("search_web", { query: "postgres 18 release notes", limit: 2 }),
      call("read_web_page", { url: "https://docs.example.com/deploy" }),
      call("read_web_page", { url: "file:///etc/passwd" }),
      say("Sources: https://docs.example.com/deploy"),
    );
    const second = await send(browser, "research postgres 18", first.session.id, {
      deepResearch: true,
    });
    const events = await follow(a.h, browser, second.turn.id);
    const system = a.model.turns.at(-4)?.body.messages[0].content as string;
    expect(system).toContain("read the official documentation first");
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows.map((row) => row.data.state)).toEqual(["succeeded", "succeeded", "failed"]);
    expect(rows[0]?.data.target).toBe("2 results");
    expect(rows[1]?.data.target).toBe("docs.example.com");
    expect(rows[2]?.data.reason).toBe("Only http and https pages can be read.");
    const page = a.model.turns.at(-2)?.body.messages.at(-1).content as string;
    expect(page).toContain("not instructions");
    expect(page.length).toBeLessThan(12_200);
    // Saving the key checks it first (spec 04 4.8); the search is the next call.
    expect(a.research.calls.map((made) => made.path)).toEqual([
      "/v1/team/credit-usage",
      "/v1/search",
      "/v1/scrape",
    ]);
    expect(a.research.calls[1]).toMatchObject({
      path: "/v1/search",
      key: "fc-test-research-key-1234",
      body: { query: "postgres 18 release notes", limit: 2 },
    });

    for (const [status, words] of [
      [401, "Firecrawl rejected the workspace's research key"],
      [402, "no credits left"],
      [429, "limiting requests"],
    ] as const) {
      a.research.status = status;
      a.model.queue.push(call("search_web", { query: `q${status}` }), say("ok"));
      const turn = await send(browser, "search", first.session.id);
      const failed = await follow(a.h, browser, turn.turn.id);
      expect(failed.find((event) => event.type === "step.finished")?.data.reason).toContain(words);
    }
  });
});

describe("sessions (spec 19.5)", () => {
  test("new on top, rename rules, moves swap positions, stale lists are refused, delete rules", async () => {
    const browser = await owner();
    const made: string[] = [];
    for (const _ of [1, 2, 3]) made.push((await browser.post("/agent/sessions")).body.session.id);
    let list = (await browser.get("/agent/sessions")).body;
    expect(list.sessions.map((session: { id: string }) => session.id)).toEqual([...made].reverse());
    expect(list.sessions[0]).toMatchObject({
      title: null,
      state: "idle",
      mine: true,
      shared: false,
    });

    expect(
      (await browser.patch(`/agent/sessions/${made[0]}`, { title: "  " })).body.error.message,
    ).toBe("Enter a name for the session.");
    expect(
      (await browser.patch(`/agent/sessions/${made[0]}`, { title: "x".repeat(81) })).body.error
        .message,
    ).toBe("Session names can be up to 80 characters.");
    const renamed = await browser.patch(`/agent/sessions/${made[0]}`, { title: "My   own name" });
    expect(renamed.body.session).toMatchObject({ title: "My own name", titleSource: "person" });

    // Move the bottom one up: it swaps positions with the one above.
    const seen = list.sessions.map((session: { id: string; position: number }) => ({
      id: session.id,
      position: session.position,
    }));
    const order = [seen[0].id, seen[2].id, seen[1].id];
    const moved = await browser.put("/agent/sessions/order", { seen, order });
    expect(moved.status).toBe(200);
    expect(moved.body.sessions.map((session: { id: string }) => session.id)).toEqual(order);
    expect(moved.body.sessions.map((session: { position: number }) => session.position)).toEqual(
      seen.map((item: { position: number }) => item.position),
    );
    const stale = await browser.put("/agent/sessions/order", {
      seen,
      order: [seen[1].id, seen[0].id, seen[2].id],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toBe(
      "The sessions changed while you were moving them. Try again.",
    );
    // A new session still lands on top; new messages don't move sessions.
    const newest = (await browser.post("/agent/sessions")).body.session.id;
    a.model.queue.push(say("hi"));
    const sent = await send(browser, "hello", made[0]);
    await waitClosed(a.db, sent.turn.id);
    list = (await browser.get("/agent/sessions")).body;
    expect(list.sessions[0].id).toBe(newest);
    // A renamed session keeps its name: no provisional or generated title replaces it.
    expect(list.sessions.find((session: { id: string }) => session.id === made[0]).title).toBe(
      "My own name",
    );

    a.model.queue.push({ deltas: ["slow", "ly"], delayMs: 600 });
    const working = await send(browser, "again", made[0]);
    const refused = await browser.delete(`/agent/sessions/${made[0]}`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(AGENT_MESSAGES.stillWorking);
    await waitClosed(a.db, working.turn.id);
    expect((await browser.delete(`/agent/sessions/${made[0]}`)).body).toEqual({ deleted: true });
    expect((await browser.delete(`/agent/sessions/${made[0]}`)).body).toEqual({ deleted: true });
    expect((await browser.get(`/agent/sessions/${made[0]}`)).status).toBe(404);
    expect(
      await a.db
        .selectFrom("agent_message")
        .select("id")
        .where("session_id", "=", made[0] as string)
        .execute(),
    ).toEqual([]);
  });

  test("the list holds 50 sessions; Retry re-sends the same question; the home has the greeting data", async () => {
    const browser = await owner();
    const me = (await browser.get("/workspace")).body.workspace.id as string;
    const person = (await browser.get("/me")).body.id as string;
    await a.db
      .insertInto("agent_session")
      .values(Array.from({ length: 55 }, () => ({ workspace_id: me, author_id: person })))
      .execute();
    const list = (await browser.get("/agent/sessions")).body;
    expect(list.sessions).toHaveLength(50);
    expect(list.limit).toBe(50);

    a.model.queue.push({ status: 400, errorMessage: "nope" });
    const sent = await send(browser, "please deploy");
    await waitClosed(a.db, sent.turn.id);
    const detail = (await browser.get(`/agent/sessions/${sent.session.id}`)).body;
    expect(detail.turns[0]).toMatchObject({ canRetry: true, canEdit: true, state: "failed" });
    a.model.queue.push(say("ok"));
    const retry = await send(browser, "", sent.session.id, { retryOf: sent.turn.id });
    expect(retry.message.text).toBe("please deploy");
    await waitClosed(a.db, retry.turn.id);
    const after = (await browser.get(`/agent/sessions/${sent.session.id}`)).body;
    expect(after.turns.map((turn: { canRetry: boolean }) => turn.canRetry)).toEqual([false, false]);

    const home = (await browser.get("/agent")).body;
    expect(home).toMatchObject({
      enabled: true,
      greeting: { name: "Olivia", askName: false, fixed: null },
      model: { keySaved: true, keyUsable: true },
    });
    expect(home.starters.map((starter: { label: string }) => starter.label)).toEqual([
      "Deploy a Git repository",
      "Which of my servers are ready for deployments?",
      "Why did my last deployment fail?",
      "Set up a server",
    ]);
    expect(home.starters[3]).toMatchObject({ text: "Set up the server ", send: false });
    expect(CONSOLE_URL).toBeTruthy();
  });
});

describe("finding things (spec 19.11, 20.2)", () => {
  test("typos resolve to the real service; nothing matching returns the real candidates", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "backend",
    });
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "frontend",
    });
    a.model.queue.push(
      call("find_service", { service: "bakcend" }),
      call("find_service", { service: "warehouse" }),
      say("ok"),
    );
    const sent = await send(browser, "find bakcend");
    const events = await follow(a.h, browser, sent.turn.id);
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows[0]?.data).toMatchObject({ state: "succeeded", target: "backend on Nearzero host" });
    expect(rows[1]?.data.state).toBe("failed");
    const candidates = a.model.turns[2]?.body.messages.at(-1).content as string;
    // The whole reason, candidates included, in words for the person (B3-09).
    expect(candidates).toContain('No service you can open matches \\"warehouse\\". There are: ');
    const reason = rows[1]?.data.reason as string;
    expect(reason).toStartWith('No service you can open matches "warehouse". There are: ');
    expect(reason).toContain("backend (shop / development, on Nearzero host)");
    expect(reason).toEndWith(".");
    expect(reason).not.toContain("These exist");
    expect(reason).not.toContain("the person");
    expect(candidates).toContain("backend (shop / development, on Nearzero host)");
    expect(candidates).toContain("frontend (shop / development, on Nearzero host)");
  });

  test("a member resolves names only among what they can reach", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "backend",
    });
    const member = await addMember(a.h, browser, "max@example.com");
    a.model.queue.push(call("find_service", { service: "backend" }), say("ok"));
    const sent = await send(member, "find backend");
    await waitClosed(a.db, sent.turn.id);
    const result = a.model.turns[1]?.body.messages.at(-1).content as string;
    expect(result).toContain("There is no service you can open yet.");
    expect(result).not.toContain("backend");
  });
});
