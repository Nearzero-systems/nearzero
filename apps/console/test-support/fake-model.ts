/**
 * A scripted, OpenAI-compatible model server for the Agent chat's browser checks (M11b). The
 * control plane is pointed at it with NEARZERO_AGENT_PROVIDER_URL, so no real model provider is
 * ever called. It answers:
 * - GET /models with what the test model takes (text and images);
 * - small, non-streamed requests: a title, three follow-ups, or a log analysis;
 * - streamed requests from a script picked by a word in the person's last message, one reply
 *   per round (a round ends when the Agent sends the action results back).
 * Tests can also push replies in front of the scripts (`queue`), and every request is recorded
 * so a test can search what the Agent sent (`allText`).
 */

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Reply {
  status?: number;
  deltas?: string[];
  delayMs?: number;
  toolCalls?: ToolCall[];
}

export interface Recorded {
  raw: string;
  // biome-ignore lint/suspicious/noExplicitAny: whatever the Agent sent.
  body: any;
  stream: boolean;
}

interface ChatMessage {
  role: string;
  content?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === "object" && "text" in part ? String(part.text) : ""))
      .join(" ");
  }
  return "";
}

const MARKERS = [
  "keep going",
  "three steps",
  "slow",
  "variables",
  "ssh key",
  "list my keys",
  "permission",
  "which project",
  "code",
  "broken",
];

/**
 * The person's message the script follows and how many rounds the Agent already ran for it:
 * the latest message with a script word (Nearzero may add its own notes after it), else the
 * latest message.
 */
export function conversationState(messages: ChatMessage[]): { ask: string; round: number } {
  let chosen = -1;
  let latest = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role !== "user") continue;
    if (latest === -1) latest = index;
    const text = textOf(messages[index]?.content).toLowerCase();
    // "Allowed "Read SSH keys". Please continue." names a policy, not a new request.
    if (/^allowed ".*"\. please continue\.$/.test(text.trim())) continue;
    if (MARKERS.some((marker) => text.includes(marker))) {
      chosen = index;
      break;
    }
  }
  const at = chosen === -1 ? latest : chosen;
  const ask = at === -1 ? "" : textOf(messages[at]?.content).toLowerCase();
  // "Allowed … Please continue." starts the same script again from its first round.
  const resumed = latest !== at && /please continue/i.test(textOf(messages[latest]?.content));
  const from = resumed ? latest : at;
  const round = messages.slice(from + 1).filter((message) => message.role === "assistant").length;
  return { ask, round };
}

const ANSWER = [
  "Here is what I found.\n\n",
  "| Project | Environments | Services |\n|---|---|---|\n| Shop | development | web |\n\n",
  "Your servers:\n\n- **Nearzero host**: ready for deployments\n\n",
  "To check the app yourself:\n\n```bash\ncurl -I https://web.apps.acme.test\n```\n",
];

const LONG_CODE = Array.from({ length: 30 }, (_, index) => `echo "line ${index + 1}"`).join("\n");

/** The built-in scripts, by a word in the person's message. */
export function scripted(ask: string, round: number, lastTool = ""): Reply {
  if (ask.includes("three steps")) {
    const steps: Reply[] = [
      {
        deltas: ["Let me look at your projects and servers first.\n\n"],
        toolCalls: [{ name: "list_projects", arguments: {} }],
      },
      { toolCalls: [{ name: "list_servers", arguments: {} }] },
      { toolCalls: [{ name: "read_project", arguments: { project: "Shop" } }] },
    ];
    return steps[round] ?? { deltas: ANSWER, delayMs: 30 };
  }
  if (ask.includes("keep going")) {
    // A turn that runs for a long time (the sweep's "running" state); Stop ends it.
    if (round === 0) {
      return {
        deltas: ["Working on it.\n\n"],
        toolCalls: [{ name: "list_projects", arguments: {} }],
      };
    }
    return {
      deltas: Array.from({ length: 3_000 }, (_, index) => `Part ${index + 1} of a long reply. `),
      delayMs: 400,
    };
  }
  if (ask.includes("slow")) {
    if (round === 0) {
      return { deltas: ["Starting.\n\n"], toolCalls: [{ name: "list_projects", arguments: {} }] };
    }
    return {
      deltas: Array.from({ length: 120 }, (_, index) => `Word ${index + 1} of a long answer. `),
      delayMs: 250,
    };
  }
  if (ask.includes("variables")) {
    if (round === 0) {
      return {
        deltas: ["The app needs two variables before it can start.\n\n"],
        toolCalls: [
          {
            name: "request_variables",
            arguments: {
              service: "web",
              names: ["DATABASE_URL", "API_TOKEN"],
              reason: "web reads these when it starts.",
              deployAfter: false,
            },
          },
        ],
      };
    }
    return { deltas: ["Saved. Deploy **web** when you're ready and I'll follow it."] };
  }
  if (ask.includes("ssh key")) {
    if (round === 0) {
      return {
        toolCalls: [
          {
            name: "request_ssh_key",
            arguments: { name: "prod-1 key", reason: "The server needs a key to log in with." },
          },
        ],
      };
    }
    return { deltas: ["The key is saved. Next, give me the server's address and SSH user."] };
  }
  if (ask.includes("list my keys") || ask.includes("permission")) {
    if (round === 0) return { toolCalls: [{ name: "list_ssh_keys", arguments: {} }] };
    return /permission|polic/i.test(lastTool)
      ? { deltas: ['I need the "Read SSH keys" permission to list your keys.'] }
      : { deltas: ["You have no SSH keys yet."] };
  }
  if (ask.includes("which project")) {
    if (round === 0)
      return { toolCalls: [{ name: "create_project", arguments: { name: "new project" } }] };
    return { deltas: ["Created the project."] };
  }
  if (ask.includes("code")) {
    return {
      deltas: [
        "A long script:\n\n```bash\n",
        LONG_CODE,
        "\n```\n\nRun it on the server. Internal id 3f2a9c1e-4b5d-4e6f-8a7b-9c0d1e2f3a4b is not shown.",
      ],
    };
  }
  if (ask.includes("broken")) return { status: 500 };
  return { deltas: ["Hello! ", "How can I help with your deployments today?"], delayMs: 20 };
}

export class FakeModel {
  readonly requests: Recorded[] = [];
  readonly queue: Reply[] = [];
  #server: ReturnType<typeof Bun.serve> | null = null;

  get url(): string {
    return `http://127.0.0.1:${this.#server?.port}/api/v1`;
  }

  start(port = 0): this {
    this.#server = Bun.serve({
      port,
      hostname: "127.0.0.1",
      idleTimeout: 0,
      fetch: (request) => this.#handle(request),
    });
    return this;
  }

  stop(): void {
    this.#server?.stop(true);
  }

  allText(): string {
    return this.requests.map((request) => request.raw).join("\n");
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      return Response.json({
        data: [
          { id: "test/model", architecture: { input_modalities: ["text", "image", "file"] } },
          { id: "test/small", architecture: { input_modalities: ["text"] } },
        ],
      });
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      return new Response("not found", { status: 404 });
    }
    const raw = await request.text();
    const body = JSON.parse(raw);
    const stream = body.stream === true;
    this.requests.push({ raw, body, stream });
    if (!stream) return this.#small(body);
    const messages: ChatMessage[] = body.messages ?? [];
    const { ask, round } = conversationState(messages);
    const lastTool = textOf(messages.findLast((message) => message.role === "tool")?.content);
    const reply = this.queue.shift() ?? scripted(ask, round, lastTool);
    return this.#stream(reply, request.signal);
  }

  #small(body: { messages: ChatMessage[] }): Response {
    const system = textOf(body.messages[0]?.content);
    const content = system.includes("Write a title")
      ? "Checking projects and servers"
      : system.includes("Suggest up to 3")
        ? "Deploy web\nShow the logs of web\nWhich servers are ready?"
        : "The app can't reach its database: DATABASE_URL is missing.";
    return Response.json({ choices: [{ message: { role: "assistant", content } }] });
  }

  #stream(reply: Reply, signal: AbortSignal): Response {
    if (reply.status && reply.status !== 200) {
      return Response.json(
        { error: { code: reply.status, message: "The provider failed." } },
        { status: reply.status },
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
          controller.enqueue(encoder.encode(": PROCESSING\n\n"));
          for (const delta of reply.deltas ?? []) {
            if (reply.delayMs) await wait(reply.delayMs);
            if (signal.aborted) return controller.close();
            controller.enqueue(line({ choices: [{ delta: { content: delta } }] }));
          }
          (reply.toolCalls ?? []).forEach((call, index) => {
            controller.enqueue(
              line({
                choices: [
                  {
                    delta: {
                      tool_calls: [
                        {
                          index,
                          id: `call_${index}_${Math.random().toString(36).slice(2, 8)}`,
                          type: "function",
                          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
                        },
                      ],
                    },
                  },
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
          // The Agent went away (Stop).
        }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }
}
