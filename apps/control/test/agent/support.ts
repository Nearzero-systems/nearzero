import { sql } from "kysely";
import { ObjectRegistry } from "../../src/access/objects.ts";
import { configureAgent } from "../../src/agent/settings.ts";
import { createApp } from "../../src/app.ts";
import { createDatabase, type Db } from "../../src/db/database.ts";
import { migrate } from "../../src/db/migrate.ts";
import { registerGitAccountObjects } from "../../src/git-providers/records.ts";
import { createLogger } from "../../src/log.ts";
import { registerProjectObjects } from "../../src/projects/objects.ts";
import { TEST_HASHING } from "../../src/security/passwords.ts";
import { registerServerObjects } from "../../src/servers/servers.ts";
import { createServices } from "../../src/services.ts";
import { MIGRATIONS_DIR, TEST_DATABASE_URL } from "../support/database.ts";
import {
  Browser,
  CONSOLE_URL,
  FakeObjects,
  type Harness,
  INSTANCE_RESEND,
  Outside,
  TEST_SECRET,
} from "../support/harness.ts";

/**
 * The Agent's test world: a control plane on its own throwaway database (named nz_m11_*), the
 * real permission objects, and two fake outside services that never reach a real provider: a
 * scripted OpenAI-compatible model server (streaming, action calls, errors, delays, silence) and
 * a Firecrawl-compatible research server.
 */

// ---- The scripted model

export interface ToolCallSpec {
  name: string;
  arguments: string | Record<string, unknown>;
  id?: string;
}

export interface Reply {
  /** An HTTP refusal instead of an answer. */
  status?: number;
  errorMessage?: string;
  headers?: Record<string, string>;
  deltas?: string[];
  /** Wait between deltas (and before the first). */
  delayMs?: number;
  toolCalls?: ToolCallSpec[];
  /** Send headers, then nothing at all. */
  hang?: boolean;
  /** After the deltas, an error inside the stream. */
  streamError?: { code: number; message: string };
}

export interface RecordedRequest {
  raw: string;
  // biome-ignore lint/suspicious/noExplicitAny: tests read whatever the Agent sent.
  body: any;
  stream: boolean;
}

export type Script = Reply | ((request: RecordedRequest, index: number) => Reply);

export class FakeModel {
  readonly requests: RecordedRequest[] = [];
  readonly queue: Script[] = [];
  /** When the queue is empty. */
  fallback: Script = { deltas: ["Done."] };
  title = "Deploying the web app";
  suggestions = "Deploy web again\nShow the logs of web\nOpen a firewall port for web";
  analysis = "The app can't reach its database: DATABASE_URL is missing.";
  inputModalities = ["text", "image", "file"];
  modelsStatus = 200;
  #server: ReturnType<typeof Bun.serve> | null = null;
  #streamIndex = 0;

  get url(): string {
    return `http://127.0.0.1:${this.#server?.port}/api/v1`;
  }

  /** Requests of the main, streamed conversation (not titles or follow-ups). */
  get turns(): RecordedRequest[] {
    return this.requests.filter((request) => request.stream);
  }

  start(): this {
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (request) => this.#handle(request),
    });
    return this;
  }

  stop(): void {
    this.#server?.stop(true);
  }

  reset(): void {
    this.requests.length = 0;
    this.queue.length = 0;
    this.fallback = { deltas: ["Done."] };
    this.title = "Deploying the web app";
    this.suggestions = "Deploy web again\nShow the logs of web\nOpen a firewall port for web";
    this.inputModalities = ["text", "image", "file"];
    this.modelsStatus = 200;
    this.#streamIndex = 0;
  }

  /** Every byte the Agent ever sent the model, for secret searches. */
  allText(): string {
    return this.requests.map((request) => request.raw).join("\n");
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      if (this.modelsStatus !== 200) return new Response("no", { status: this.modelsStatus });
      return Response.json({
        data: [
          { id: "test/model", architecture: { input_modalities: this.inputModalities } },
          { id: "test/small", architecture: { input_modalities: ["text"] } },
        ],
      });
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    const raw = await request.text();
    const body = JSON.parse(raw);
    const recorded: RecordedRequest = { raw, body, stream: body.stream === true };
    this.requests.push(recorded);
    if (!recorded.stream) return this.#complete(body);
    const index = this.#streamIndex++;
    const script = this.queue.shift() ?? this.fallback;
    const reply = typeof script === "function" ? script(recorded, index) : script;
    return this.#stream(reply, request.signal);
  }

  #complete(body: { messages: { role: string; content: string }[] }): Response {
    const system = String(body.messages[0]?.content ?? "");
    const content = system.includes("Write a title")
      ? this.title
      : system.includes("Suggest up to 3")
        ? this.suggestions
        : this.analysis;
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  }

  #stream(reply: Reply, signal: AbortSignal): Response {
    if (reply.status && reply.status !== 200) {
      return Response.json(
        { error: { code: reply.status, message: reply.errorMessage ?? "refused" } },
        { status: reply.status, headers: reply.headers ?? {} },
      );
    }
    const encoder = new TextEncoder();
    const line = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const wait = (ms: number) =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              resolve();
            });
          });
        try {
          controller.enqueue(encoder.encode(": OPENROUTER PROCESSING\n\n"));
          if (reply.hang) {
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
            controller.close();
            return;
          }
          for (const delta of reply.deltas ?? []) {
            if (reply.delayMs) await wait(reply.delayMs);
            if (signal.aborted) return controller.close();
            controller.enqueue(line({ choices: [{ delta: { content: delta } }] }));
          }
          if (reply.streamError) {
            controller.enqueue(line({ error: reply.streamError }));
            controller.close();
            return;
          }
          (reply.toolCalls ?? []).forEach((call, index) => {
            const args =
              typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments);
            // Arguments arrive in two pieces, as real providers send them.
            const half = Math.floor(args.length / 2);
            controller.enqueue(
              line({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: call.id ?? `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
                          type: "function",
                          function: { name: call.name, arguments: args.slice(0, half) },
                        },
                      ],
                    },
                  },
                ],
              }),
            );
            controller.enqueue(
              line({
                choices: [
                  { delta: { tool_calls: [{ index, function: { arguments: args.slice(half) } }] } },
                ],
              }),
            );
          });
          controller.enqueue(
            line({
              choices: [
                { delta: {}, finish_reason: reply.toolCalls?.length ? "tool_calls" : "stop" },
              ],
            }),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          // The Agent went away.
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
}

// ---- The research server

export class FakeResearch {
  status = 200;
  readonly calls: { path: string; body: unknown; key: string }[] = [];
  #server: ReturnType<typeof Bun.serve> | null = null;

  get url(): string {
    return `http://127.0.0.1:${this.#server?.port}`;
  }

  start(): this {
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const path = new URL(request.url).pathname;
        const body = await request.json().catch(() => ({}));
        this.calls.push({
          path,
          body,
          key: (request.headers.get("authorization") ?? "").replace(/^Bearer /, ""),
        });
        if (this.status !== 200)
          return Response.json({ success: false, error: "no" }, { status: this.status });
        if (path === "/v1/search") {
          return Response.json({
            success: true,
            data: [
              {
                url: "https://docs.example.com/deploy",
                title: "Deploying",
                description: "How to deploy.",
              },
              { url: "https://example.com/blog", title: "Blog", description: "A post." },
            ],
          });
        }
        if (path === "/v1/scrape") {
          return Response.json({
            success: true,
            data: {
              markdown: `# Docs\n\n${"word ".repeat(4_000)}`,
              metadata: { title: "Docs", sourceURL: (body as { url: string }).url },
            },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    return this;
  }

  stop(): void {
    this.#server?.stop(true);
  }

  reset(): void {
    this.status = 200;
    this.calls.length = 0;
  }
}

// ---- The harness

export interface AgentHarness {
  h: Harness;
  db: Db;
  model: FakeModel;
  research: FakeResearch;
  reset(): Promise<void>;
  drop(): Promise<void>;
}

async function createAgentDatabase(prefix: string) {
  const admin = createDatabase(TEST_DATABASE_URL, {
    maxConnections: 1,
    applicationName: "nearzero-test",
  });
  const name = `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;
  const db = createDatabase(url.toString(), {
    maxConnections: 6,
    applicationName: "nearzero-test",
  });
  return {
    db,
    url: url.toString(),
    async drop() {
      await db.destroy();
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    },
  };
}

export const FAST = {
  textFlushMs: 5,
  heartbeatMs: 1_000,
  stopPollMs: 500,
  staleAfterMs: 30_000,
  sweepMs: 1_000_000_000,
  followPollMs: 200,
  followDeployIntervalMs: 25,
  retryDelaysMs: [20, 60],
  retryAfterMaxMs: 300,
  titleTimeoutMs: 2_000,
  providerSilenceMs: 5_000,
};

/** `prefix` names the throwaway database (each milestone's suite has its own). */
export async function createAgentHarness(prefix = "nz_m11_"): Promise<AgentHarness> {
  const test = await createAgentDatabase(prefix);
  await migrate(test.db, { directory: MIGRATIONS_DIR });
  const outside = new Outside();
  const registry = new ObjectRegistry();
  registerProjectObjects(registry);
  registerServerObjects(registry);
  registerGitAccountObjects(registry);
  // Errors go to standard error, so a failing test shows the control plane's own words.
  const log = createLogger({
    level: "error",
    write: (line) => process.stderr.write(`[control] ${line}\n`),
  });
  const services = createServices({
    db: test.db,
    log,
    authSecret: TEST_SECRET,
    consoleUrl: CONSOLE_URL,
    instanceEmail: INSTANCE_RESEND,
    http: outside.http,
    smtp: outside.smtp,
    passwordHashing: TEST_HASHING,
    objects: registry,
  });
  const model = new FakeModel().start();
  const research = new FakeResearch().start();
  const configure = () =>
    configureAgent(services, {
      ...FAST,
      disabled: false,
      provider: null,
      model: "test/model",
      smallModel: "test/small",
      providerUrl: model.url,
      researchUrl: research.url,
      fetch: (input, init) => fetch(input, init),
      promptAppend: null,
      greeting: null,
      attachmentsMaxBytes: 25 * 1024 * 1024,
    });
  configure();
  const app = createApp({ db: test.db, log, services });
  const h: Harness = {
    test,
    services,
    outside,
    fakes: new FakeObjects(),
    app,
    restart: () => createApp({ db: test.db, log, services }),
    browser: (options) => new Browser(app, options),
    async reset() {
      await waitAllClosed(test.db);
      await sql`
        truncate person, workspace, install_state, attempt_record, audit_event,
          workspace_old_slug, sign_in_challenge, job restart identity cascade
      `.execute(test.db);
      outside.emails.length = 0;
      outside.firecrawl = 200;
    },
    drop: () => test.drop(),
  };
  return {
    h,
    db: test.db,
    model,
    research,
    async reset() {
      await h.reset();
      model.reset();
      research.reset();
      configure();
    },
    async drop() {
      await waitAllClosed(test.db).catch(() => {});
      model.stop();
      research.stop();
      await test.drop();
    },
  };
}

/** Waits until no turn is working (tests never leave one behind). */
export async function waitAllClosed(db: Db, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await db
      .selectFrom("agent_turn")
      .select("id")
      .where("state", "=", "working")
      .execute()
      .catch(() => []);
    if (open.length === 0) return;
    if (Date.now() > deadline)
      throw new Error(`turns still working: ${open.map((row) => row.id).join(", ")}`);
    await Bun.sleep(20);
  }
}

export interface SseEvent {
  id: string | null;
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: tests read whatever came back.
  data: any;
}

export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    let type = "message";
    let id: string | null = null;
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trim());
    }
    if (data.length > 0) events.push({ id, type, data: JSON.parse(data.join("\n")) });
  }
  return events;
}

/** Follows a turn's stream until it ends (or `stopAfter` events, to simulate a dropped connection). */
export async function follow(
  h: Harness,
  browser: Browser,
  turnId: string,
  options: { lastEventId?: string; stopAfter?: number; timeoutMs?: number } = {},
): Promise<SseEvent[]> {
  const headers = new Headers();
  headers.set("cookie", [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  if (options.lastEventId) headers.set("last-event-id", options.lastEventId);
  const controller = new AbortController();
  const response = await h.app.request(
    `/api/v1/agent/turns/${turnId}/events`,
    { headers, signal: controller.signal },
    { peerAddress: "127.0.0.1" },
  );
  if (response.status !== 200)
    throw new Error(`stream refused: ${response.status} ${await response.text()}`);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + (options.timeoutMs ?? 150_000);
  for (;;) {
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(Math.max(1, deadline - Date.now())).then(() => "timeout" as const),
    ]);
    if (next === "timeout") {
      controller.abort();
      throw new Error(`the stream didn't end: ${text.slice(-2000)}`);
    }
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
    const events = parseSse(text);
    if (options.stopAfter !== undefined && events.length >= options.stopAfter) {
      await reader.cancel().catch(() => {});
      controller.abort();
      return events.slice(0, options.stopAfter);
    }
    if (events.some((event) => event.type === "end")) {
      await reader.cancel().catch(() => {});
      return events;
    }
  }
  return parseSse(text);
}

export async function waitClosed(db: Db, turnId: string, timeoutMs = 150_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db
      .selectFrom("agent_turn")
      .select(["closed_at", "state"])
      .where("id", "=", turnId)
      .executeTakeFirst();
    if (row?.closed_at) return;
    if (Date.now() > deadline) throw new Error(`turn ${turnId} didn't close (state ${row?.state})`);
    await Bun.sleep(15);
  }
}

export async function waitState(
  db: Db,
  turnId: string,
  state: string,
  timeoutMs = 150_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await db
      .selectFrom("agent_turn")
      .select(["state"])
      .where("id", "=", turnId)
      .executeTakeFirst();
    if (row?.state === state) return;
    if (Date.now() > deadline) throw new Error(`turn ${turnId} is ${row?.state}, not ${state}`);
    await Bun.sleep(15);
  }
}

/** Saved events of a turn, by type. */
export async function savedEvents(db: Db, turnId: string) {
  const rows = await db
    .selectFrom("agent_event")
    .select(["seq", "type", "data"])
    .where("turn_id", "=", turnId)
    .orderBy("seq")
    .execute();
  // biome-ignore lint/suspicious/noExplicitAny: tests read whatever was saved.
  return rows.map((row) => ({ seq: row.seq, type: row.type, data: row.data as any }));
}

/** Every text column of every Agent table and the audit record, for secret searches. */
export async function everythingStored(db: Db): Promise<string> {
  const tables = [
    "agent_session",
    "agent_message",
    "agent_turn",
    "agent_event",
    "agent_model_item",
    "audit_event",
  ];
  const parts: string[] = [];
  for (const table of tables) {
    const rows = await sql<{
      row: string;
    }>`select row_to_json(t)::text as row from ${sql.table(table)} t`.execute(db);
    for (const row of rows.rows) parts.push(row.row);
  }
  const files = await sql<{
    row: string;
  }>`select coalesce(text_content, '') || coalesce(pages::text, '') || name as row from agent_file`.execute(
    db,
  );
  for (const row of files.rows) parts.push(row.row);
  return parts.join("\n");
}

/** Saves the workspace's model key through the normal API, as the console would. */
export async function saveModelKey(
  browser: Browser,
  key = "sk-or-v1-test-key-0123456789",
): Promise<void> {
  const reply = await browser.put("/workspace/keys/model", { key });
  if (reply.status !== 200) throw new Error(JSON.stringify(reply.body));
}

export async function send(
  browser: Browser,
  text: string,
  sessionId?: string,
  extra: Record<string, unknown> = {},
) {
  const reply = await browser.post(
    sessionId ? `/agent/sessions/${sessionId}/messages` : "/agent/messages",
    { text, ...extra },
  );
  if (reply.status !== 202)
    throw new Error(`send refused: ${reply.status} ${JSON.stringify(reply.body)}`);
  return reply.body as {
    session: { id: string };
    message: { id: string; text: string };
    turn: { id: string; lastEventId: string };
  };
}

export function call(name: string, args: Record<string, unknown> = {}): Reply {
  return { toolCalls: [{ name, arguments: args }] };
}

export function say(...deltas: string[]): Reply {
  return { deltas };
}
