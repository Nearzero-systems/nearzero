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
import { sweepTurns } from "../../src/agent/restart.ts";
import { removeServicesJob } from "../../src/deletion/job.ts";
import { JobQueue } from "../../src/jobs/queue.ts";
import { JobWorker } from "../../src/jobs/worker.ts";
import { silentLogger } from "../../src/log.ts";
import { setUpNamedOwner } from "../support/harness.ts";
import {
  addMember,
  FakeTeardown,
  giveAccess,
  makeProject,
  makeService,
} from "../support/projects.ts";
import {
  type AgentHarness,
  call,
  createAgentHarness,
  everythingStored,
  follow,
  savedEvents,
  saveModelKey,
  say,
  send,
  waitClosed,
  waitState,
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

async function owner(withKey = true) {
  const browser = await setUpNamedOwner(a.h);
  if (withKey) await saveModelKey(browser);
  return browser;
}

function formOf(events: { type: string; data: { formId?: string; form?: unknown } }[]) {
  // biome-ignore lint/suspicious/noExplicitAny: tests read the form.
  return events.find((event) => event.type === "form.requested")?.data as any;
}

describe("policies and the permission card (spec 19.9)", () => {
  test("a refusal shows a lock row and a card; Allow and continue turns it on and sends the message", async () => {
    const browser = await owner();
    await browser.put("/workspace/agent-policies", { switches: { "projects.create": false } });
    a.model.queue.push(
      call("create_project", { name: "shop" }),
      say("I need permission to create projects."),
    );
    // Not a guided "create a project" message: the model's own call meets the policy.
    const sent = await send(browser, "shop needs a home of its own");
    const events = await follow(a.h, browser, sent.turn.id);
    const row = events.find((event) => event.type === "step.finished");
    expect(row?.data).toMatchObject({ state: "needs_permission", label: "Creating project" });
    expect(row?.data.reason).toContain('"Create projects"');
    const card = events.find((event) => event.type === "permission.needed");
    expect(card?.data).toMatchObject({
      policy: "projects.create",
      policyLabel: "Create projects",
      canAllow: true,
      production: false,
    });
    // The model said one sentence with actions off, and the turn ended.
    expect(a.model.turns).toHaveLength(2);
    expect(a.model.turns[1]?.body.tools).toBeUndefined();
    expect(events.some((event) => event.type === "suggestions")).toBe(false);
    const refused = await a.db
      .selectFrom("audit_event")
      .selectAll()
      .where("action", "=", "agent.refused")
      .execute();
    expect(refused).toHaveLength(1);
    expect(refused[0]?.actor_kind).toBe("agent");
    expect(refused[0]?.details).toMatchObject({
      policy: "projects.create",
      role: "owner",
      sessionId: sent.session.id,
    });
    expect(await a.db.selectFrom("project").select("id").execute()).toHaveLength(0);

    a.model.queue.push(call("create_project", { name: "shop" }), say("Created shop."));
    const allowed = await browser.post(`/agent/turns/${sent.turn.id}/permission`, {
      policy: "projects.create",
    });
    expect(allowed.status).toBe(202);
    expect(allowed.body.message.text).toBe('Allowed "Create projects". Please continue.');
    const next = await follow(a.h, browser, allowed.body.turn.id);
    expect(next.find((event) => event.type === "step.finished")?.data).toMatchObject({
      state: "succeeded",
      label: "Created project",
      target: "shop",
    });
    expect((await browser.get("/workspace/agent-policies")).body.switches["projects.create"]).toBe(
      true,
    );
    const changes = await a.db
      .selectFrom("audit_event")
      .selectAll()
      .where("action", "in", ["agent.create-project", "project.created"])
      .execute();
    expect(changes.map((change) => change.actor_kind).sort()).toEqual(["agent", "agent"]);
    const own = changes.find((change) => change.action === "agent.create-project");
    expect(own?.details).toMatchObject({
      role: "owner",
      sessionId: sent.session.id,
      target: "shop",
    });
  });

  test("production needs its own policy, which the card can't allow and the platform checks the phrase for", async () => {
    const browser = await owner();
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_environment", { project: "shop", name: "prod" }),
      call("create_environment", { project: "shop", name: "production" }),
      say("Need production."),
    );
    const sent = await send(browser, "add production to shop");
    const events = await follow(a.h, browser, sent.turn.id);
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows[0]?.data.state).toBe("failed");
    expect(rows[0]?.data.reason).toContain("production");
    expect(rows[1]?.data.state).toBe("needs_permission");
    const card = events.find((event) => event.type === "permission.needed");
    expect(card?.data).toMatchObject({ policy: "production", production: true, canAllow: false });
    expect(card?.data.message).toContain(AGENT_MESSAGES.productionCard);
    const allow = await browser.post(`/agent/turns/${sent.turn.id}/permission`, {
      policy: "production",
    });
    expect(allow.status).toBe(403);
    expect(allow.body.error.message).toBe(AGENT_MESSAGES.productionCard);
    const noPhrase = await browser.put("/workspace/agent-policies", {
      switches: { production: true },
    });
    expect(noPhrase.status).toBe(400);
  });

  test("members see the card without Allow, and the endpoint refuses them", async () => {
    const browser = await owner();
    await browser.put("/workspace/agent-policies", { switches: { "projects.create": false } });
    const member = await addMember(a.h, browser, "mia@example.com", {
      capabilities: ["projects.create"],
    });
    a.model.queue.push(call("create_project", { name: "shop" }), say("Need permission."));
    const sent = await send(member, "create shop");
    const events = await follow(a.h, member, sent.turn.id);
    const card = events.find((event) => event.type === "permission.needed");
    expect(card?.data.canAllow).toBe(false);
    expect(card?.data.message).toContain(AGENT_MESSAGES.membersCard);
    const allow = await member.post(`/agent/turns/${sent.turn.id}/permission`, {
      policy: "projects.create",
    });
    expect(allow.status).toBe(403);
  });

  test("a person's own permissions still apply: a refused action is an ordinary red row", async () => {
    const browser = await owner();
    const member = await addMember(a.h, browser, "mo@example.com");
    a.model.queue.push(call("create_project", { name: "shop" }), say("You can't."));
    const sent = await send(member, "create shop");
    const events = await follow(a.h, member, sent.turn.id);
    const row = events.find((event) => event.type === "step.finished");
    expect(row?.data.state).toBe("failed");
    expect(row?.data.reason).toContain('"Create projects" permission');
    expect(events.some((event) => event.type === "permission.needed")).toBe(false);
  });
});

describe("secure forms (spec 19.8)", () => {
  test("variables: values go to the normal API; the model learns only the names", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    const app = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:1" },
    });
    a.model.queue.push(
      call("request_variables", {
        service: "web",
        names: ["DATABASE_URL"],
        reason: "The app needs its database.",
      }),
    );
    const sent = await send(browser, "set variables for web");
    await waitState(a.db, sent.turn.id, "waiting");
    const events = await savedEvents(a.db, sent.turn.id);
    const form = formOf(events);
    expect(form.form).toMatchObject({
      kind: "variables",
      names: ["DATABASE_URL"],
      saveTo: `/api/v1/services/${app.service.id}/variables`,
      deployLabel: "Save 1 variable and deploy",
    });
    expect(events.find((event) => event.type === "waiting")?.data.label).toBe(
      "Waiting for the variables",
    );
    // While it waits there is no working stretch; one that works says when it began (19.4).
    const waiting = await browser.get(`/agent/sessions/${sent.session.id}`);
    expect(waiting.body.turns[0]).toMatchObject({ state: "waiting", workingSince: null });
    const resumedAt = new Date(Date.now() - 4_000);
    await a.db
      .updateTable("agent_turn")
      .set({ state: "working", work_started_at: resumedAt })
      .where("id", "=", sent.turn.id)
      .execute();
    const working = await browser.get(`/agent/sessions/${sent.session.id}`);
    expect(working.body.turns[0].workingSince).toBe(resumedAt.toISOString());
    await a.db
      .updateTable("agent_turn")
      .set({ state: "waiting", work_started_at: null })
      .where("id", "=", sent.turn.id)
      .execute();
    const marker = "postgres://u:MARKER-VAR-7731@db:5432/app";
    const saved = await browser.put(`/services/${app.service.id}/variables`, {
      rows: [{ name: "DATABASE_URL", value: marker }],
    });
    expect(saved.status).toBe(200);
    const refused = await browser.post(`/agent/turns/${sent.turn.id}/forms/${form.formId}`, {
      outcome: "saved",
      names: ["DATABASE_URL"],
      values: { DATABASE_URL: marker },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(AGENT_MESSAGES.secretInput);
    a.model.queue.push(say("Saved. I'll redeploy next."));
    const answered = await browser.post(`/agent/turns/${sent.turn.id}/forms/${form.formId}`, {
      outcome: "saved",
      names: ["DATABASE_URL", "NOT_SAVED"],
    });
    expect(answered.status).toBe(202);
    await waitClosed(a.db, sent.turn.id);
    const result = a.model.turns[1]?.body.messages.at(-1);
    expect(result.role).toBe("tool");
    expect(result.content).toContain("DATABASE_URL");
    expect(result.content).not.toContain("NOT_SAVED");
    expect(a.model.allText()).not.toContain("MARKER-VAR-7731");
    expect(await everythingStored(a.db)).not.toContain("MARKER-VAR-7731");
    // The same form can't be answered twice.
    const twice = await browser.post(`/agent/turns/${sent.turn.id}/forms/${form.formId}`, {
      outcome: "saved",
      names: [],
    });
    expect(twice.status).toBe(409);
    // Waiting time doesn't count.
    const footer = (await savedEvents(a.db, sent.turn.id)).find(
      (event) => event.type === "turn.finished",
    );
    expect(footer?.data.footer).toMatch(/^Worked for \d+s · 1 step$/);
  });

  test("every form path with marker values: nothing reaches a stored message, a model request or the audit", async () => {
    const browser = await owner(false);
    // Model key, through the key form.
    const sent = await send(browser, "hello");
    await waitState(a.db, sent.turn.id, "waiting");
    let events = await savedEvents(a.db, sent.turn.id);
    const keyForm = formOf(events);
    expect(keyForm.form).toMatchObject({ kind: "model_key", canSave: true });
    expect(events.find((event) => event.type === "waiting")?.data.label).toBe(
      AGENT_MESSAGES.waitingForKey,
    );
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.data.delta)
        .join(""),
    ).toBe(AGENT_MESSAGES.noKeyAdmin);
    await saveModelKey(browser, "sk-or-v1-MARKERMODELKEY0001");
    a.model.queue.push(say("Hello!"));
    const rerun = await browser.post(`/agent/turns/${sent.turn.id}/forms/${keyForm.formId}`, {
      outcome: "saved",
    });
    expect(rerun.status).toBe(202);
    const replaced = (await savedEvents(a.db, sent.turn.id)).find(
      (event) => event.type === "turn.replaced",
    );
    expect(replaced?.data.turnId).toBe(rerun.body.turn.id);
    await waitClosed(a.db, rerun.body.turn.id);
    const detail = await browser.get(`/agent/sessions/${sent.session.id}`);
    expect(detail.body.turns).toHaveLength(1);
    expect(detail.body.turns[0].id).toBe(rerun.body.turn.id);
    expect(detail.body.turns[0].message.text).toBe("hello");
    expect(JSON.stringify(a.model.turns[0]?.body.messages)).not.toContain("OpenRouter API key");

    // Research key.
    const research = await browser.put("/workspace/keys/research", {
      key: "fc-MARKERRESEARCHKEY0002",
    });
    expect(research.status).toBe(200);

    // SSH key, through the key form.
    a.model.queue.push(
      call("request_ssh_key", { name: "prod-1 key", reason: "To sign in to prod-1." }),
    );
    const askKey = await send(browser, "add a server", sent.session.id);
    await waitState(a.db, askKey.turn.id, "waiting");
    events = await savedEvents(a.db, askKey.turn.id);
    const sshForm = formOf(events);
    expect(sshForm.form).toMatchObject({ kind: "ssh_key", suggestedName: "prod-1 key" });
    const generated = await browser.post("/ssh-keys/generate", {
      type: "ed25519",
      name: "prod-1 key",
    });
    const privateKey = generated.body.privateKey as string;
    const keyMarker = privateKey.split("\n")[2] as string;
    const savedKey = await browser.post("/ssh-keys", {
      name: "prod-1 key",
      publicKey: generated.body.publicKey,
      privateKey,
    });
    expect(savedKey.status).toBe(201);
    a.model.queue.push(
      call("add_server", {
        name: "prod-1",
        address: "203.0.113.10",
        sshUser: "ubuntu",
        sshKey: savedKey.body.key.id,
      }),
      say("Added prod-1."),
    );
    await browser.post(`/agent/turns/${askKey.turn.id}/forms/${sshForm.formId}`, {
      outcome: "saved",
      keyId: savedKey.body.key.id,
    });
    const addEvents = await follow(a.h, browser, askKey.turn.id);
    // A key added in this chat works without "Read SSH keys" (off by default).
    expect(
      addEvents.find(
        (event) => event.type === "step.finished" && event.data.label === "Added server",
      )?.data.target,
    ).toBe("prod-1");
    const learned = a.model.turns.at(-2)?.body.messages.at(-1).content as string;
    expect(learned).toContain("prod-1 key");

    // Variables, through the variables form.
    const project = await makeProject(browser, "shop");
    const app = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:1" },
    });
    a.model.queue.push(
      call("request_variables", { service: "web", names: ["API_TOKEN"], reason: "Needed." }),
    );
    const askVars = await send(browser, "set vars", sent.session.id);
    await waitState(a.db, askVars.turn.id, "waiting");
    const varsForm = formOf(await savedEvents(a.db, askVars.turn.id));
    await browser.put(`/services/${app.service.id}/variables`, {
      rows: [{ name: "API_TOKEN", value: "MARKERVARIABLE0003" }],
    });
    a.model.queue.push(say("ok"));
    await browser.post(`/agent/turns/${askVars.turn.id}/forms/${varsForm.formId}`, {
      outcome: "saved",
      names: ["API_TOKEN"],
    });
    await waitClosed(a.db, askVars.turn.id);

    // Task script, through the task form (the host is the instance administrator's).
    a.model.queue.push(
      call("create_task", { name: "nightly", schedule: "0 2 * * *", server: "host" }),
    );
    const askTask = await send(browser, "schedule nightly", sent.session.id);
    await waitState(a.db, askTask.turn.id, "waiting");
    const taskForm = formOf(await savedEvents(a.db, askTask.turn.id));
    expect(taskForm.form).toMatchObject({
      kind: "task_script",
      mode: "create",
      saveTo: "/api/v1/tasks",
    });
    expect(taskForm.form.draft).toMatchObject({
      name: "nightly",
      place: "host",
      cron: "0 2 * * *",
    });
    const task = await browser.post("/tasks", {
      ...taskForm.form.draft,
      script: "echo MARKERSCRIPT0004\n",
      force: true,
    });
    expect(task.status).toBe(201);
    await browser.post(`/agent/turns/${askTask.turn.id}/forms/${taskForm.formId}`, {
      outcome: "saved",
      taskId: task.body.task.id,
    });
    const taskEvents = await follow(a.h, browser, askTask.turn.id);
    const reply = taskEvents
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(reply).toContain("Scheduled **nightly**");
    expect(reply).toContain("Want me to run it once now?");

    // Secret answers and messages are refused at the chat endpoint.
    const secretMessage = await browser.post(`/agent/sessions/${sent.session.id}/messages`, {
      text: "MARKERMESSAGE0005",
      secret: true,
    });
    expect(secretMessage.status).toBe(400);
    expect(secretMessage.body.error.message).toBe(AGENT_MESSAGES.secretInput);

    const stored = await everythingStored(a.db);
    const sentToModel = a.model.allText();
    for (const marker of [
      "MARKERMODELKEY0001",
      "MARKERRESEARCHKEY0002",
      keyMarker,
      "MARKERVARIABLE0003",
      "MARKERSCRIPT0004",
      "MARKERMESSAGE0005",
    ]) {
      expect(stored).not.toContain(marker);
      expect(sentToModel).not.toContain(marker);
    }
  });

  test("a member's question waits for an admin's key and is answered once it is saved", async () => {
    const browser = await owner(false);
    const member = await addMember(a.h, browser, "meg@example.com");
    const sent = await send(member, "which servers are ready?");
    await waitState(a.db, sent.turn.id, "waiting");
    const events = await savedEvents(a.db, sent.turn.id);
    expect(events.find((event) => event.type === "waiting")?.data).toEqual({
      formId: null,
      label: AGENT_MESSAGES.waitingForAdminKey,
    });
    expect(formOf(events)).toBeUndefined();
    expect((await sweepTurns(a.h.services)).resumed).toBe(0);
    await saveModelKey(browser);
    a.model.queue.push(say("None yet."));
    expect((await sweepTurns(a.h.services)).resumed).toBe(1);
    const replaced = (await savedEvents(a.db, sent.turn.id)).find(
      (event) => event.type === "turn.replaced",
    );
    await waitClosed(a.db, replaced?.data.turnId);
    const detail = await member.get(`/agent/sessions/${sent.session.id}`);
    expect(detail.body.turns[0].answerText).toBe("None yet.");
  });

  test("a rejected key gives the same prompt, prefixed", async () => {
    const browser = await owner();
    a.model.queue.push({ status: 401, errorMessage: "No auth credentials found" });
    const sent = await send(browser, "hi");
    await waitState(a.db, sent.turn.id, "waiting");
    const events = await savedEvents(a.db, sent.turn.id);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text.startsWith(AGENT_MESSAGES.keyRejectedPrefix)).toBe(true);
    expect(formOf(events).form.kind).toBe("model_key");
  });

  test("deleting a project goes through the confirmation; each service is its own row", async () => {
    const browser = await owner();
    await browser.put("/workspace/agent-policies", {
      switches: { "projects.delete-without-production": true },
    });
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    await makeProject(browser, "live", ["production"]);
    const teardown = new FakeTeardown();
    const worker = new JobWorker({
      db: a.db,
      queue: new JobQueue(a.db, { workerId: "agent-test" }),
      definitions: [removeServicesJob(teardown)],
      log: silentLogger,
    });
    a.model.queue.push(
      call("delete_project", { project: "live" }),
      call("delete_project", { project: "shop" }),
    );
    // The model's own delete goes through the same confirmation (spec 19.7).
    const sent = await send(browser, "clean up live and shop");
    await waitState(a.db, sent.turn.id, "waiting");
    const events = await savedEvents(a.db, sent.turn.id);
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows[0]?.data.state).toBe("failed");
    expect(rows[0]?.data.reason).toContain("production environment");
    const form = formOf(events);
    expect(form.form).toMatchObject({
      kind: "project_delete",
      project: { name: "shop" },
      confirmLabel: "Delete shop and 1 service",
      keepLabel: "Keep it",
    });
    expect(form.form.services[0].line).toContain("cache — Redis");
    a.model.queue.push(say("Deleted shop."));
    await browser.post(`/agent/turns/${sent.turn.id}/forms/${form.formId}`, { outcome: "delete" });
    // The delete job runs while the Agent follows it.
    const deadline = Date.now() + 60_000;
    while (
      !(
        await a.db
          .selectFrom("agent_turn")
          .select("closed_at")
          .where("id", "=", sent.turn.id)
          .executeTakeFirst()
      )?.closed_at
    ) {
      await worker.runOnce();
      if (Date.now() > deadline) throw new Error("the delete never finished");
      await Bun.sleep(30);
    }
    const after = await savedEvents(a.db, sent.turn.id);
    const answered = after.find((event) => event.type === "form.answered");
    expect(answered?.data).toMatchObject({
      outcome: "delete",
      label: "Delete it",
      asMessage: true,
    });
    const removing = after.filter(
      (event) => event.type === "step.finished" && event.data.target === "cache on Nearzero host",
    );
    expect(removing.at(-1)?.data).toMatchObject({ state: "succeeded", label: "Removed service" });
    expect(teardown.calls.map((item) => item.target.name)).toEqual(["cache"]);
    expect(await a.db.selectFrom("project").select("name").execute()).toEqual([{ name: "live" }]);
    const audit = await a.db
      .selectFrom("audit_event")
      .select(["action", "actor_kind"])
      .where("action", "=", "agent.delete-project")
      .execute();
    expect(audit).toEqual([{ action: "agent.delete-project", actor_kind: "agent" }]);
  });
});

describe("shared sessions (spec 25 D4, 24 G6)", () => {
  test("private by default; shared ones are readable, with steps the viewer can't see blanked", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "secret-proj");
    const member = await addMember(a.h, browser, "sam@example.com");
    a.model.queue.push(
      call("read_project", { project: "secret-proj" }),
      call("list_servers"),
      say("Done."),
    );
    const sent = await send(browser, "look at secret-proj");
    await waitClosed(a.db, sent.turn.id);
    expect((await member.get(`/agent/sessions/${sent.session.id}`)).status).toBe(404);
    expect((await member.get("/agent/sessions")).body.shared).toEqual([]);
    const shared = await browser.post(`/agent/sessions/${sent.session.id}/share`, { shared: true });
    expect(shared.body.message).toBe("Shared with workspace");
    const list = await member.get("/agent/sessions");
    expect(list.body.shared.map((session: { id: string }) => session.id)).toEqual([
      sent.session.id,
    ]);
    const seen = await member.get(`/agent/sessions/${sent.session.id}`);
    expect(seen.status).toBe(200);
    const finished = seen.body.turns[0].events.filter(
      (event: { type: string }) => event.type === "step.finished",
    );
    expect(finished[0].data).toMatchObject({ label: "Read project", target: "", result: null });
    // A row that names nothing it touched (a list) shows only its label and state to others,
    // since it may list what they can't see (B1-22).
    expect(finished[1].data).toMatchObject({ label: "Listed servers", target: "", result: null });
    expect(JSON.stringify(seen.body)).not.toContain(project.projectId);
    // Viewers can read but not send, rename or delete.
    expect(
      (await member.post(`/agent/sessions/${sent.session.id}/messages`, { text: "hi" })).status,
    ).toBe(403);
    expect(
      (await member.patch(`/agent/sessions/${sent.session.id}`, { title: "Mine" })).status,
    ).toBe(403);
    expect((await member.delete(`/agent/sessions/${sent.session.id}`)).status).toBe(403);
    // With access, the same row shows.
    await giveAccess(a.h, browser, "sam@example.com", {
      scope: { projectIds: [project.projectId] },
    });
    const again = await member.get(`/agent/sessions/${sent.session.id}`);
    const rows = again.body.turns[0].events.filter(
      (event: { type: string }) => event.type === "step.finished",
    );
    expect(rows[0].data.target).toBe("secret-proj");
  });
});
