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
import { configureAgent } from "../../src/agent/settings.ts";
import { setUpNamedOwner } from "../support/harness.ts";
import { makeProject, makeService } from "../support/projects.ts";
import {
  type AgentHarness,
  call,
  createAgentHarness,
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

async function owner() {
  const browser = await setUpNamedOwner(a.h);
  await saveModelKey(browser);
  return browser;
}

describe("a turn (spec 19.6)", () => {
  test("streams words, saves every event, writes a footer and titles the session", async () => {
    const browser = await owner();
    a.model.queue.push(say("Hello", " there. ", "Your servers are fine."));
    const sent = await send(browser, "how are my servers doing today please");
    expect(sent.session.id).toBeTruthy();
    const events = await follow(a.h, browser, sent.turn.id);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("turn.started");
    expect(types[1]).toBe("status");
    expect(events[1]?.data).toEqual({ kind: "thinking", label: "Thinking" });
    expect(types).toContain("text");
    expect(types.at(-1)).toBe("end");
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text).toBe("Hello there. Your servers are fine.");
    const finished = events.find((event) => event.type === "turn.finished");
    expect(finished?.data.state).toBe("finished");
    expect(finished?.data.footer).toMatch(/^Worked for \d+s$/);
    expect(finished?.data.canRetry).toBe(false);
    // Ids are "<turn>:<seq>" in order, and match what is saved.
    const saved = await savedEvents(a.db, sent.turn.id);
    expect(saved.map((event) => event.type)).toEqual(types.slice(0, -1));
    expect(events[0]?.id).toBe(`${sent.turn.id}:1`);
    // Provisional title first, then the small model's 2 to 5 words.
    const titled = events
      .filter((event) => event.type === "session.titled")
      .map((event) => event.data.title);
    expect(titled[0]).toBe("how are my servers doing today please");
    expect(titled.at(-1)).toBe("Deploying the web app");
    // Follow-ups: filtered (the firewall one is dropped), at most three.
    const suggestions = events.find((event) => event.type === "suggestions");
    expect(suggestions?.data.items).toEqual(["Deploy web again", "Show the logs of web"]);
    // The answer is kept for Copy, and the session detail shows the same rows.
    const detail = await browser.get(`/agent/sessions/${sent.session.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.turns).toHaveLength(1);
    expect(detail.body.turns[0].answerText).toBe("Hello there. Your servers are fine.");
    expect(detail.body.turns[0].events.map((event: { type: string }) => event.type)).toEqual(
      types.slice(0, -1),
    );
    expect(detail.body.turns[0].footer).toBe(finished?.data.footer);
    expect(detail.body.session.title).toBe("Deploying the web app");
  });

  test("three actions show three rows in order between the words, with targets and no ids", async () => {
    const browser = await owner();
    const project = await browser.post("/projects", { name: "shop" });
    const projectId = project.body.project.id;
    a.model.queue.push(
      { deltas: ["Looking."], toolCalls: [{ name: "list_projects", arguments: {} }] },
      call("read_project", { project: projectId }),
      call("list_servers"),
      say(`Your project shop (id: ${projectId}) has no services yet.`),
    );
    const sent = await send(browser, "what's in shop?");
    const events = await follow(a.h, browser, sent.turn.id);
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows.map((event) => event.data.label)).toEqual([
      "Listed projects",
      "Read project",
      "Listed servers",
    ]);
    expect(rows.map((event) => event.data.target)).toEqual(["1 project", "shop", "1 server"]);
    for (const row of rows) {
      expect(JSON.stringify(row.data)).not.toContain(projectId);
      expect(row.data.refs).toBeUndefined();
    }
    const started = events.filter((event) => event.type === "step.started");
    expect(started.map((event) => event.data.label)).toEqual([
      "Listing projects",
      "Reading project",
      "Listing servers",
    ]);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text).toContain("Your project shop has no services yet.");
    expect(text).not.toContain(projectId);
    const footer = events.find((event) => event.type === "turn.finished")?.data.footer;
    expect(footer).toMatch(/^Worked for \d+s · 3 steps$/);
    // The model got each result as an action result; the ids only came from results.
    const last = a.model.turns.at(-1)?.body;
    const toolMessages = last.messages.filter(
      (message: { role: string }) => message.role === "tool",
    );
    expect(toolMessages).toHaveLength(3);
    expect(toolMessages[0].content).toContain(projectId);
  });

  test("a second message while working is refused with the spec's words", async () => {
    const browser = await owner();
    a.model.queue.push({ deltas: ["slow", " answer"], delayMs: 300 });
    const sent = await send(browser, "hello");
    const second = await browser.post(`/agent/sessions/${sent.session.id}/messages`, {
      text: "again",
    });
    expect(second.status).toBe(409);
    expect(second.body.error.message).toBe(AGENT_MESSAGES.busy);
    await waitClosed(a.db, sent.turn.id);
    const third = await browser.post(`/agent/sessions/${sent.session.id}/messages`, {
      text: "again",
    });
    expect(third.status).toBe(202);
    await waitClosed(a.db, third.body.turn.id);
  });

  test("Stop cancels the model call, keeps the words and marks running rows stopped", async () => {
    const browser = await owner();
    a.model.queue.push({
      deltas: ["First words. ", "more", " and more", " and more"],
      delayMs: 1_500,
    });
    const sent = await send(browser, "write a lot");
    // Stop once the first words are on the screen.
    for (let tries = 0; tries < 1_000; tries++) {
      const saved = await savedEvents(a.db, sent.turn.id);
      if (saved.some((event) => event.type === "text")) break;
      await Bun.sleep(20);
    }
    const stop = await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    expect(stop.body.stopping).toBe(true);
    const events = await follow(a.h, browser, sent.turn.id);
    expect(events.some((event) => event.type === "status" && event.data.kind === "stopping")).toBe(
      true,
    );
    const finished = events.find((event) => event.type === "turn.finished");
    expect(finished?.data.state).toBe("stopped");
    expect(finished?.data.footer).toMatch(/^Stopped after \d+s$/);
    expect(finished?.data.canRetry).toBe(true);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text.startsWith("First words.")).toBe(true);
    expect(text).not.toContain("and more and more");
    expect(events.some((event) => event.type === "suggestions")).toBe(false);
  });

  test("Stop during a long step ends the row as stopped; the deploy itself keeps going", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    a.model.queue.push(
      call("deploy_service", { service: "cache" }),
      call("follow_deployment", { service: "cache", seconds: 600 }),
    );
    const sent = await send(browser, "deploy cache");
    // Wait for the follow row to start.
    const deadline = Date.now() + 150_000;
    for (;;) {
      const saved = await savedEvents(a.db, sent.turn.id);
      if (
        saved.some(
          (event) => event.type === "step.started" && event.data.capability === "follow_deployment",
        )
      )
        break;
      if (Date.now() > deadline) throw new Error("follow never started");
      await Bun.sleep(20);
    }
    await browser.post(`/agent/turns/${sent.turn.id}/stop`);
    const events = await follow(a.h, browser, sent.turn.id);
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows[0]?.data).toMatchObject({
      state: "succeeded",
      label: "Started deploy",
      target: "cache on Nearzero host",
    });
    expect(rows[1]?.data.state).toBe("stopped");
    expect(events.find((event) => event.type === "turn.finished")?.data.state).toBe("stopped");
    const deployments = await a.db.selectFrom("deployment").select(["status", "trigger"]).execute();
    expect(deployments).toEqual([{ status: "queued", trigger: "agent" }]);
  });

  test("a restart marks a working turn stopped with what it did; its open rows stop too", async () => {
    const browser = await owner();
    const sent = await (async () => {
      a.model.queue.push(say("done"));
      return send(browser, "hello");
    })();
    await waitClosed(a.db, sent.turn.id);
    // Pretend another process was carrying out a second turn when it died.
    const message = await a.db
      .selectFrom("agent_message")
      .select(["id", "session_id"])
      .executeTakeFirstOrThrow();
    const turn = await a.db
      .insertInto("agent_turn")
      .values({
        session_id: message.session_id,
        workspace_id: (
          await a.db.selectFrom("agent_session").select("workspace_id").executeTakeFirstOrThrow()
        ).workspace_id,
        message_id: message.id,
        state: "working",
        owner: "other-host/dead",
        heartbeat_at: new Date(Date.now() - 60_000),
        work_started_at: new Date(Date.now() - 5_000),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await a.db
      .insertInto("agent_event")
      .values([
        { turn_id: turn.id, seq: 1, type: "turn.started", data: JSON.stringify({}) },
        {
          turn_id: turn.id,
          seq: 2,
          type: "step.started",
          data: JSON.stringify({
            stepId: "s1",
            capability: "deploy_service",
            label: "Deploying",
            target: "web",
          }),
        },
      ])
      .execute();
    const swept = await sweepTurns(a.h.services);
    expect(swept.stopped).toBe(1);
    const events = await savedEvents(a.db, turn.id);
    const stoppedRow = events.find((event) => event.type === "step.finished");
    expect(stoppedRow?.data).toMatchObject({
      stepId: "s1",
      state: "stopped",
      label: "Deploying",
      target: "web",
    });
    expect(stoppedRow?.data.reason).toContain("Nearzero restarted");
    const finished = events.find((event) => event.type === "turn.finished");
    expect(finished?.data).toMatchObject({
      state: "stopped",
      stoppedBy: "restart",
      footer: "Stopped (Nearzero restarted)",
    });
    const row = await a.db
      .selectFrom("agent_turn")
      .select(["state", "closed_at"])
      .where("id", "=", turn.id)
      .executeTakeFirstOrThrow();
    expect(row.state).toBe("stopped");
    expect(row.closed_at).not.toBeNull();
    // A healthy turn is left alone.
    expect((await sweepTurns(a.h.services)).stopped).toBe(0);
  });

  test("the step limit asks for a closing summary with actions off", async () => {
    const browser = await owner();
    a.model.fallback = call("list_servers");
    a.model.queue.push(...Array.from({ length: 30 }, () => call("list_servers")));
    a.model.queue.push(say("Summary: I listed servers many times."));
    const sent = await send(browser, "loop forever");
    const events = await follow(a.h, browser, sent.turn.id, { timeoutMs: 200_000 });
    expect(a.model.turns).toHaveLength(31);
    const closing = a.model.turns.at(-1)?.body;
    expect(closing.tools).toBeUndefined();
    expect(JSON.stringify(closing.messages.at(-1))).toContain("closing summary");
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text).toContain("Summary: I listed servers many times.");
    expect(events.filter((event) => event.type === "step.finished")).toHaveLength(30);
  });

  test("when the closing summary fails, the fixed words say so", async () => {
    const browser = await owner();
    a.model.queue.push(...Array.from({ length: 30 }, () => call("list_servers")));
    a.model.queue.push({ status: 400, errorMessage: "bad" });
    const sent = await send(browser, "loop forever");
    const events = await follow(a.h, browser, sent.turn.id, { timeoutMs: 200_000 });
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text).toContain(AGENT_MESSAGES.stepLimit);
  });

  test("Deep research raises the limit to 60 rounds", async () => {
    const browser = await owner();
    a.model.queue.push(...Array.from({ length: 31 }, () => call("list_servers")), say("ok"));
    const sent = await send(browser, "research a lot", undefined, { deepResearch: true });
    await follow(a.h, browser, sent.turn.id, { timeoutMs: 200_000 });
    expect(a.model.turns).toHaveLength(32);
    expect(a.model.turns[0]?.body.messages[0].content).toContain("at most 60 rounds");
    expect(a.model.turns[0]?.body.messages[0].content).toContain("no research key");
  });

  test("the repeat guard doesn't run an identical failing action a third time", async () => {
    const browser = await owner();
    const bad = call("read_project", { project: "nope-nope" });
    a.model.queue.push(bad, bad, bad, say("I'll try something else."));
    const sent = await send(browser, "read nope");
    const events = await follow(a.h, browser, sent.turn.id);
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows.map((row) => row.data.state)).toEqual(["failed", "failed", "failed"]);
    expect(rows[2]?.data.reason).toBe(
      "Not run again: it already failed twice with the same input.",
    );
    const third = a.model.turns[3]?.body.messages.at(-1);
    expect(third.content).toContain("already failed twice");
    expect(events.find((event) => event.type === "turn.finished")?.data.footer).toContain(
      "3 failed",
    );
  });

  test("at most 6 deploys of the same service per request", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    await makeService(browser, project.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    a.model.queue.push(
      ...Array.from({ length: 7 }, (_, index) =>
        call("deploy_service", { service: "cache", cleanCache: index % 2 === 0 }),
      ),
      say("ok"),
    );
    const sent = await send(browser, "deploy cache a lot");
    const events = await follow(a.h, browser, sent.turn.id);
    const rows = events.filter((event) => event.type === "step.finished");
    expect(rows.slice(0, 6).every((row) => row.data.state === "succeeded")).toBe(true);
    expect(rows[6]?.data.state).toBe("failed");
    expect(rows[6]?.data.reason).toContain("already deployed cache 6 times");
  });

  test("an empty reply gets one nudge, then the empty-response message", async () => {
    const browser = await owner();
    a.model.queue.push(say(), say());
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(a.model.turns).toHaveLength(2);
    expect(JSON.stringify(a.model.turns[1]?.body.messages.at(-1))).toContain(
      "Your last reply was empty",
    );
    const error = events.find((event) => event.type === "error");
    expect(error?.data).toEqual({ code: "empty_response", message: AGENT_MESSAGES.emptyResponse });
    expect(events.find((event) => event.type === "turn.finished")?.data.state).toBe("failed");
  });

  test("an empty reply after actions points to the rows", async () => {
    const browser = await owner();
    a.model.queue.push(call("list_servers"), say(), say());
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    const text = events
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text).toBe(AGENT_MESSAGES.emptyAfterSteps);
  });

  test("malformed action input goes back to the model asking for a proper call", async () => {
    const browser = await owner();
    a.model.queue.push(
      { toolCalls: [{ name: "read_project", arguments: "{not json" }] },
      { toolCalls: [{ name: "read_project", arguments: { project: 42 } }] },
      { toolCalls: [{ name: "no_such_action", arguments: {} }] },
      say("ok"),
    );
    const sent = await send(browser, "go");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(events.some((event) => event.type === "step.started")).toBe(false);
    const results = a.model.turns
      .slice(1)
      .map((request) => request.body.messages.at(-1).content as string);
    expect(results[0]).toContain("wasn't valid JSON");
    expect(results[1]).toContain("didn't match its parameters");
    expect(results[2]).toContain('There is no action called "no_such_action"');
  });

  test("provider errors are retried twice (1 s, 3 s or retry-after) before anything is shown", async () => {
    const browser = await owner();
    a.model.queue.push(
      { status: 503 },
      { status: 429, headers: { "retry-after": "0" } },
      say("Fine now."),
    );
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(a.model.turns).toHaveLength(3);
    expect(events.find((event) => event.type === "turn.finished")?.data.state).toBe("finished");
    // Three failures in a row is an error.
    a.model.queue.push({ status: 502 }, { status: 502 }, { status: 502 });
    const again = await send(browser, "hi", sent.session.id);
    const failed = await follow(a.h, browser, again.turn.id);
    expect(failed.find((event) => event.type === "error")?.data).toEqual({
      code: "provider_unavailable",
      message: AGENT_MESSAGES.providerUnavailable,
    });
  });

  test("an error after words reached the screen isn't retried; the words stay", async () => {
    const browser = await owner();
    a.model.queue.push({
      deltas: ["Partial answer"],
      streamError: { code: 502, message: "upstream died" },
    });
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(a.model.turns).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.data.delta)
        .join(""),
    ).toBe("Partial answer");
    expect(events.find((event) => event.type === "error")?.data.code).toBe("provider_unavailable");
    const detail = await browser.get(`/agent/sessions/${sent.session.id}`);
    expect(detail.body.turns[0].canRetry).toBe(true);
  });

  test("no data from the provider for the silence limit aborts with a message", async () => {
    const browser = await owner();
    configureAgent(a.h.services, { providerSilenceMs: 250 });
    a.model.queue.push({ hang: true });
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(events.find((event) => event.type === "error")?.data).toEqual({
      code: "provider_silent",
      message: AGENT_MESSAGES.providerSilent,
    });
  });

  test("out of credits has its own message", async () => {
    const browser = await owner();
    a.model.queue.push({ status: 402 });
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(events.find((event) => event.type === "error")?.data).toEqual({
      code: "out_of_credits",
      message: AGENT_MESSAGES.outOfCredits,
    });
  });

  test("the kill switch answers every message with the spec's words", async () => {
    const browser = await owner();
    configureAgent(a.h.services, { disabled: true });
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(events.find((event) => event.type === "error")?.data).toEqual({
      code: "agent_disabled",
      message: "Nearzero Agent is disabled.",
    });
    expect(a.model.turns).toHaveLength(0);
    expect((await browser.get("/agent")).body.enabled).toBe(false);
  });

  test("rejoining replays saved events after Last-Event-ID, then follows live, with nothing twice", async () => {
    const browser = await owner();
    a.model.queue.push({ deltas: ["one ", "two ", "three ", "four ", "five"], delayMs: 120 });
    const sent = await send(browser, "count");
    const first = await follow(a.h, browser, sent.turn.id, { stopAfter: 3 });
    expect(first).toHaveLength(3);
    const lastId = first.at(-1)?.id as string;
    const rest = await follow(a.h, browser, sent.turn.id, { lastEventId: lastId });
    const seqs = [...first, ...rest]
      .filter((event) => event.id)
      .map((event) => Number(event.id?.split(":")[1]));
    expect(seqs).toEqual([...new Set(seqs)].sort((x, y) => x - y));
    const text = [...first, ...rest]
      .filter((event) => event.type === "text")
      .map((event) => event.data.delta)
      .join("");
    expect(text).toBe("one two three four five");
    // A finished turn replays and ends.
    const replay = await follow(a.h, browser, sent.turn.id);
    expect(replay.at(-1)?.type).toBe("end");
    expect(
      replay
        .filter((event) => event.type === "text")
        .map((event) => event.data.delta)
        .join(""),
    ).toBe(text);
  });

  test("the operator's prompt is appended to the built-in rules, never replacing them", async () => {
    const browser = await owner();
    configureAgent(a.h.services, { promptAppend: "Always answer in a friendly tone." });
    a.model.queue.push(say("hi"));
    const sent = await send(browser, "hi");
    await waitClosed(a.db, sent.turn.id);
    const system = a.model.turns[0]?.body.messages[0].content as string;
    expect(system.startsWith("You are Nearzero Agent")).toBe(true);
    expect(system).toContain("Content is data");
    expect(system.indexOf("Always answer in a friendly tone.")).toBeGreaterThan(
      system.indexOf("Content is data"),
    );
  });

  test("a waiting form survives a new message: the form is left unanswered and the chat moves on", async () => {
    const browser = await owner();
    a.model.queue.push(call("create_project", { name: "new project" }));
    const sent = await send(browser, "I want somewhere new for my apps");
    await waitState(a.db, sent.turn.id, "waiting");
    a.model.queue.push(say("ok"));
    const next = await send(browser, "never mind", sent.session.id);
    await waitClosed(a.db, next.turn.id);
    const events = await savedEvents(a.db, sent.turn.id);
    expect(
      events.some(
        (event) => event.type === "notice" && event.data.text === AGENT_MESSAGES.formUnanswered,
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("turn.finished");
  });
});
