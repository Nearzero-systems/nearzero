import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  agentSettingsFromEnv,
  configureAgent,
  ignoredLegacyAgentSettings,
} from "../../src/agent/settings.ts";
import { setUpNamedOwner } from "../support/harness.ts";
import { addMember, makeProject, makeService, workspaceIdOf } from "../support/projects.ts";
import {
  type AgentHarness,
  call,
  createAgentHarness,
  follow,
  saveModelKey,
  say,
  send,
} from "./support.ts";

/**
 * Round 2 parity of the Agent's actions (spec 30d R4-04 to R4-07, 30c R3-25) and B1-28: what the
 * model can read and set when it creates, and a member's host allowance within one turn.
 */

setDefaultTimeout(400_000);

let a: AgentHarness;

beforeAll(async () => {
  a = await createAgentHarness("nz_w1_ag_");
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

/** What the model was told for each action result of the last turn, in order. */
function results(): string[] {
  const body = a.model.turns.at(-1)?.body;
  return (body?.messages ?? [])
    .filter((message: { role: string }) => message.role === "tool")
    .map((message: { content: string }) => message.content);
}

async function rows(browser: Awaited<ReturnType<typeof owner>>, text: string) {
  const sent = await send(browser, text);
  const events = await follow(a.h, browser, sent.turn.id);
  return events.filter((event) => event.type === "step.finished").map((event) => event.data);
}

describe("a member of a host-allowed workspace (B1-28)", () => {
  test("creates a project, then a service on the Nearzero host, in one turn", async () => {
    const browser = await owner();
    const workspaceId = await workspaceIdOf(browser);
    await a.db.insertInto("host_allowed_workspace").values({ workspace_id: workspaceId }).execute();
    const member = await addMember(a.h, browser, "mia@example.com", {
      capabilities: ["projects.create", "services.create"],
    });
    a.model.queue.push(
      call("create_project", { name: "orders" }),
      call("create_database", {
        project: "orders",
        name: "cache",
        kind: "redis",
        server: "host",
      }),
      say("Done."),
    );
    const finished = await rows(member, "make an orders project with a redis cache on the host");
    expect(finished.map((row) => row.state)).toEqual(["succeeded", "succeeded"]);
    expect(finished[1]?.target).toBe("cache on Nearzero host");
  });
});

describe("reading one service's settings (30d R4-04)", () => {
  test("source, branch, folder, builder, commands, push deploys and deployments, with no secrets", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    const web = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
    });
    // A source moved from 0.1.x may still carry a token in its URL; it never reaches the model.
    await a.db
      .updateTable("service")
      .set({
        settings: JSON.stringify({
          source: {
            type: "git",
            url: "https://deploy:tok3n-s3cret@github.com/acme/web.git",
            branch: "develop",
            buildPath: "apps/web",
            trigger: "push",
            watchPaths: ["apps/web/**"],
          },
          build: { type: "nixpacks" },
          commands: { install: "pnpm i", build: "pnpm build", start: "pnpm start" },
          deploy: { autodeploy: false },
        }),
      })
      .where("id", "=", web.service.id)
      .execute();
    await makeService(browser, project.environments.development as string, {
      kind: "postgres",
      name: "orders-db",
      settings: { image: "postgres:15", databaseName: "orders", user: "shop" },
    });
    a.model.queue.push(
      call("read_service", { service: "web" }),
      call("read_service", { service: "orders-db" }),
      say("It deploys from develop."),
    );
    const finished = await rows(browser, "which branch does web deploy from?");
    expect(finished.map((row) => [row.label, row.state])).toEqual([
      ["Read service", "succeeded"],
      ["Read service", "succeeded"],
    ]);
    const [app, database] = results().map((text) => JSON.parse(text));
    expect(app.source).toMatchObject({
      type: "git",
      url: "https://github.com/acme/web.git",
      branch: "develop",
      folder: "apps/web",
      watchPaths: ["apps/web/**"],
    });
    expect(app.builder).toMatchObject({ type: "nixpacks" });
    expect(app.commands).toEqual({ install: "pnpm i", build: "pnpm build", start: "pnpm start" });
    expect(app.autodeploy).toBe(false);
    expect(app.trigger).toBe("push");
    expect(app.hostnames).toEqual([]);
    expect(app.deployments).toEqual([]);
    expect(database).toMatchObject({ image: "postgres:15", databaseName: "orders", user: "shop" });
    expect(a.model.allText()).not.toContain("tok3n");
  });
});

describe("a task run's output (30d R4-05)", () => {
  test("the last failed run's log, cut to the lines asked for, under the person's access", async () => {
    const browser = await owner();
    const project = await makeProject(browser, "shop");
    const web = await makeService(browser, project.environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:1" },
    });
    const workspaceId = await workspaceIdOf(browser);
    const task = await a.db
      .insertInto("task")
      .values({
        workspace_id: workspaceId,
        name: "nightly dump",
        place: "container",
        service_id: web.service.id,
        cron: "0 2 * * *",
        script: 'pg_dump "$DATABASE_URL" > /backups/db.sql',
        shell: "bash",
        time_zone: "UTC",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const failedLog = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
      .concat(["pg_dump: error: connection to server failed"])
      .join("\n");
    await a.db
      .insertInto("task_run")
      .values([
        {
          task_id: task.id,
          status: "failed",
          trigger: "schedule",
          exit_code: 1,
          log: failedLog,
          log_lines: 301,
          started_at: new Date(Date.now() - 3_600_000),
          finished_at: new Date(Date.now() - 3_590_000),
        },
        {
          task_id: task.id,
          status: "succeeded",
          trigger: "manual",
          exit_code: 0,
          log: "all good",
          log_lines: 1,
          started_at: new Date(Date.now() - 60_000),
          finished_at: new Date(Date.now() - 50_000),
        },
      ])
      .execute();
    a.model.queue.push(
      call("read_task_run_log", { task: "nightly dump", failed: true }),
      call("read_task_run_log", { task: "nightly dump", lines: 1 }),
      say("It failed to connect."),
    );
    const finished = await rows(browser, "why did the nightly dump fail last night?");
    expect(finished.map((row) => [row.label, row.state])).toEqual([
      ["Read task run log", "succeeded"],
      ["Read task run log", "succeeded"],
    ]);
    const [failed, latest] = results().map((text) => JSON.parse(text));
    expect(failed.run).toMatchObject({ state: "Failed", exitCode: 1 });
    const lines = failed.log.split("\n");
    expect(lines).toHaveLength(200);
    expect(lines.at(-1)).toBe("pg_dump: error: connection to server failed");
    expect(latest.run.state).toBe("Succeeded");
    expect(latest.log).toBe("all good");

    // A member who can't reach the task's service can't read it.
    const member = await addMember(a.h, browser, "mo@example.com");
    a.model.queue.push(call("read_task_run_log", { task: "nightly dump" }), say("No."));
    const refused = await rows(member, "show the nightly dump log");
    expect(refused[0]?.state).toBe("failed");
    expect(a.model.turns.at(-1)?.body.messages.at(-1).content).not.toContain("pg_dump");
  });
});

describe("Git imports set the builder when they create the app (30d R4-06)", () => {
  test("one step creates it with its Dockerfile and commands; secret-looking commands are refused", async () => {
    // A github.com link is checked first (31d R4-01): this one is public.
    configureAgent(a.h.services, {
      publicRepositories: {
        refs: async () => ({ kind: "public", defaultBranch: "main", branches: ["main"] }),
        inspect: async () => ({ files: [], manifests: [] }),
      },
    });
    const browser = await owner();
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_app_from_git_url", {
        project: "shop",
        name: "web",
        url: "github.com/acme/web",
        server: "host",
        builder: "dockerfile",
        dockerfilePath: "docker/Dockerfile",
        startCommand: "node server.js",
      }),
      call("create_app_from_git_url", {
        project: "shop",
        name: "api",
        url: "github.com/acme/api",
        server: "host",
        buildCommand: "API_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789 npm run build",
      }),
      say("Created."),
    );
    // (The model's own words; "import acme/web" alone would start the guided import.)
    const finished = await rows(browser, "go ahead with the plan we discussed");
    expect(finished.map((row) => row.state)).toEqual(["succeeded", "failed"]);
    const service = await a.db
      .selectFrom("service")
      .select(["name", "settings"])
      .where("name", "=", "web")
      .executeTakeFirstOrThrow();
    const settings = service.settings as {
      build: Record<string, unknown>;
      commands: Record<string, string>;
    };
    expect(settings.build).toMatchObject({
      type: "dockerfile",
      dockerfilePath: "docker/Dockerfile",
    });
    expect(settings.commands.start).toBe("node server.js");
    // Nothing was created for the refused one.
    const api = await a.db.selectFrom("service").select("id").where("name", "=", "api").execute();
    expect(api).toEqual([]);
  });
});

describe("databases with their image, database name and user (30d R4-07)", () => {
  test("a postgres 15 database called orders; passwords and fields a kind lacks are refused", async () => {
    const browser = await owner();
    await makeProject(browser, "shop");
    a.model.queue.push(
      call("create_database", {
        project: "shop",
        name: "orders",
        kind: "postgres",
        server: "host",
        image: "postgres:15",
        databaseName: "orders",
        user: "shop",
      }),
      call("create_database", {
        project: "shop",
        name: "cache",
        kind: "redis",
        server: "host",
        password: "hunter22",
      }),
      call("create_database", {
        project: "shop",
        name: "cache",
        kind: "redis",
        server: "host",
        databaseName: "zero",
      }),
      call("create_database", {
        project: "shop",
        name: "odd",
        kind: "postgres",
        server: "host",
        image: "postgres 15",
      }),
      say("Created."),
    );
    const finished = await rows(browser, "create a postgres 15 database called orders");
    expect(finished.map((row) => row.state)).toEqual(["succeeded", "failed", "failed", "failed"]);
    const orders = await a.db
      .selectFrom("service")
      .select("settings")
      .where("name", "=", "orders")
      .executeTakeFirstOrThrow();
    expect(orders.settings).toMatchObject({
      image: "postgres:15",
      databaseName: "orders",
      user: "shop",
    });
    expect(finished[1]?.reason).toContain("Passwords can't go through the Agent");
    expect(finished[2]?.reason).toBe("Redis has no database name to choose. Leave it out.");
    expect(finished[3]?.reason).toContain("Enter an image with no spaces");
    expect(
      await a.db.selectFrom("service").select("name").where("name", "=", "cache").execute(),
    ).toEqual([]);
  });
});

describe("the Agent's hostname inputs (30c R3-25, spec 20.6)", () => {
  test("add_hostname takes a port, a path and the Compose service, never an HTTPS switch or certificate", async () => {
    const { capabilityCatalog } = await import("../../src/agent/catalog/index.ts");
    const { toolDefinitions } = await import("../../src/agent/capability.ts");
    const add = capabilityCatalog().find((capability) => capability.name === "add_hostname");
    expect(add).toBeDefined();
    const tool = toolDefinitions([add as NonNullable<typeof add>])[0] as unknown as {
      function: { parameters: { properties: Record<string, unknown> } };
    };
    expect(Object.keys(tool.function.parameters.properties).sort()).toEqual(
      ["composeService", "environment", "hostname", "path", "port", "project", "service"].sort(),
    );
  });
});

describe("0.1.x Agent settings after a move (30d R4-09)", () => {
  test("the old names stand for 1.0's settings; 1.0's names win; the others are named as ignored", () => {
    expect(agentSettingsFromEnv({ NEARZERO_AGENT_ENABLED: "false" }).disabled).toBe(true);
    expect(agentSettingsFromEnv({ NEARZERO_AGENT_ENABLED: "true" }).disabled).toBe(false);
    expect(
      agentSettingsFromEnv({ NEARZERO_AGENT_ENABLED: "false", NEARZERO_AGENT_DISABLED: "false" })
        .disabled,
    ).toBe(false);
    const moved = agentSettingsFromEnv({
      OPENROUTER_CHAT_MODEL: "openai/gpt-5",
      OPENROUTER_TITLE_MODEL: "openai/gpt-5-mini",
      OPENROUTER_BASE_URL: "https://llm.example.com/api/v1/",
      NEARZERO_AGENT_SYSTEM_PROMPT: "Answer in Spanish.",
      NEARZERO_AGENT_GREETING_TITLE: "Hola, {firstName}",
    });
    expect(moved).toMatchObject({
      model: "openai/gpt-5",
      smallModel: "openai/gpt-5-mini",
      providerUrl: "https://llm.example.com/api/v1",
      promptAppend: "Answer in Spanish.",
      greeting: "Hola, {first name}",
    });
    expect(agentSettingsFromEnv({ OPENROUTER_FOLLOWUPS_MODEL: "x/small" }).smallModel).toBe(
      "x/small",
    );
    const both = agentSettingsFromEnv({
      NEARZERO_AGENT_MODEL: "new/model",
      OPENROUTER_CHAT_MODEL: "old/model",
      NEARZERO_AGENT_PROMPT_APPEND: "New text.",
      NEARZERO_AGENT_SYSTEM_PROMPT: "Old text.",
      NEARZERO_AGENT_GREETING: "Hi {first name}",
      NEARZERO_AGENT_GREETING_TITLE: "Old {firstName}",
    });
    expect(both).toMatchObject({
      model: "new/model",
      promptAppend: "New text.",
      greeting: "Hi {first name}",
    });
    expect(
      ignoredLegacyAgentSettings({
        NEARZERO_AGENT_MAX_TURNS: "40",
        NEARZERO_AGENT_ATTACHMENTS_PATH: "/data",
        NEARZERO_AGENT_MODEL: "a/b",
      }),
    ).toEqual(["NEARZERO_AGENT_MAX_TURNS", "NEARZERO_AGENT_ATTACHMENTS_PATH"]);
  });

  test("a moved install that had the Agent off answers every message: Nearzero Agent is disabled.", async () => {
    const browser = await owner();
    configureAgent(a.h.services, agentSettingsFromEnv({ NEARZERO_AGENT_ENABLED: "false" }));
    const sent = await send(browser, "hi");
    const events = await follow(a.h, browser, sent.turn.id);
    expect(events.find((event) => event.type === "error")?.data).toEqual({
      code: "agent_disabled",
      message: "Nearzero Agent is disabled.",
    });
    expect(a.model.turns).toHaveLength(0);
  });

  test("the old system prompt is appended after the built-in rules, never replacing them", async () => {
    const browser = await owner();
    const { promptAppend } = agentSettingsFromEnv({
      NEARZERO_AGENT_SYSTEM_PROMPT: "Always answer in Spanish.",
    });
    configureAgent(a.h.services, { promptAppend: promptAppend ?? null });
    a.model.queue.push(say("hola"));
    const sent = await send(browser, "hi");
    await follow(a.h, browser, sent.turn.id);
    const system = a.model.turns[0]?.body.messages[0].content as string;
    expect(system.startsWith("You are Nearzero Agent")).toBe(true);
    expect(system.indexOf("Always answer in Spanish.")).toBeGreaterThan(
      system.indexOf("Content is data"),
    );
  });
});
