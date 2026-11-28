import type { InstanceEmailConfig } from "@nearzero/shared";
import type { Hono } from "hono";
import { sql } from "kysely";
import type { AccessTarget } from "../../src/access/objects.ts";
import { ObjectRegistry } from "../../src/access/objects.ts";
import { createApp } from "../../src/app.ts";
import { type CliIo, runCommand } from "../../src/cli/commands.ts";
import { migrate } from "../../src/db/migrate.ts";
import type { SmtpConnector, SmtpSettings } from "../../src/email/smtp.ts";
import type { OutgoingEmail } from "../../src/email/transport.ts";
import type { AppEnv } from "../../src/http/context.ts";
import { silentLogger } from "../../src/log.ts";
import { TEST_HASHING } from "../../src/security/passwords.ts";
import {
  type ControlServices,
  createServices,
  type HttpFetch,
  type ServiceOptions,
} from "../../src/services.ts";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "./database.ts";

/**
 * A control plane on a throwaway database, driven over HTTP like the console would, with fake
 * outbound connections (Resend, Firecrawl, SMTP) that record what was sent.
 */

export const TEST_SECRET = "4f1c9a0be27d83c6a5f04e19b7d2c8a3e6f5b1d09c4a7e2f8b3d6c1a5e9f0b47";
export const CONSOLE_URL = "http://console.test:4321";
export const PASSWORD = "correct horse battery";

export interface SentEmail extends OutgoingEmail {
  from: string;
  via: "resend" | "smtp";
  apiKey?: string;
  smtp?: SmtpSettings;
}

/** A fake world outside the control plane. */
export class Outside {
  readonly emails: SentEmail[] = [];
  /** What Resend answers; a function may look at the request. */
  resendStatus = 200;
  resendBody: unknown = { id: "email_1" };
  /** What Firecrawl's credit endpoint answers, or "down" for a network error. */
  firecrawl: number | "down" = 200;
  firecrawlCalls = 0;
  smtpResult: { sent: true } | { sent: false; reason: string } = { sent: true };

  readonly http: HttpFetch = async (input, init) => {
    const url = String(input);
    if (url === "https://api.resend.com/emails") {
      const body = JSON.parse(String(init?.body)) as {
        from: string;
        to: string[];
        subject: string;
        text: string;
        html: string;
      };
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (this.resendStatus >= 200 && this.resendStatus < 300) {
        this.emails.push({
          to: body.to[0] ?? "",
          from: body.from,
          subject: body.subject,
          text: body.text,
          html: body.html,
          via: "resend",
          apiKey: auth.replace(/^Bearer /, ""),
        });
      }
      return Response.json(this.resendBody, { status: this.resendStatus });
    }
    if (url.startsWith("https://api.firecrawl.dev/")) {
      this.firecrawlCalls++;
      if (this.firecrawl === "down") throw new TypeError("fetch failed");
      return Response.json({}, { status: this.firecrawl });
    }
    throw new Error(`The test made an unexpected outbound call to ${url}`);
  };

  readonly smtp: SmtpConnector = async (settings, mail) => {
    if (this.smtpResult.sent) {
      this.emails.push({ ...mail, via: "smtp", smtp: settings });
    }
    return this.smtpResult;
  };

  /**
   * DNS for names people type (a workspace's SMTP server): `dns` first, then every name under
   * .test, .example or example.com answers one public address; anything else doesn't resolve.
   */
  readonly dns = new Map<string, string[]>();
  readonly resolveHost = async (host: string): Promise<string[]> => {
    const given = this.dns.get(host);
    if (given) return given;
    if (/(\.test|\.example|(^|\.)example\.(com|org|net))$/.test(host)) return ["34.120.0.10"];
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
  };

  lastEmailTo(address: string): SentEmail | undefined {
    return this.emails.filter((email) => email.to === address).at(-1);
  }

  /** The first link in an email's text. */
  linkIn(email: SentEmail | undefined): string {
    const match = email?.text.match(/https?:\/\/\S+/);
    if (!match) throw new Error("The email has no link.");
    return match[0];
  }
}

/** Fake projects, environments, services, servers and Git accounts for permission tests. */
export class FakeObjects {
  readonly objects: (AccessTarget & { workspaceId: string })[] = [];

  add(target: AccessTarget & { workspaceId: string }): AccessTarget {
    this.objects.push(target);
    return target;
  }

  register(registry: ObjectRegistry): void {
    for (const kind of ["project", "environment", "service", "server", "git_account"] as const) {
      registry.register(kind, {
        resolve: async (_db, workspaceId, ids) =>
          this.objects.filter(
            (item) =>
              item.kind === kind && item.workspaceId === workspaceId && ids.includes(item.id),
          ),
      });
    }
  }
}

export interface Harness {
  test: TestDatabase;
  services: ControlServices;
  outside: Outside;
  fakes: FakeObjects;
  app: Hono<AppEnv>;
  /** A new app on the same database: what a restart looks like. */
  restart(): Hono<AppEnv>;
  browser(options?: BrowserOptions): Browser;
  reset(): Promise<void>;
  drop(): Promise<void>;
}

export interface HarnessOptions {
  consoleUrl?: string | null;
  instanceEmail?: InstanceEmailConfig | null;
  extra?: Partial<Omit<ServiceOptions, "db" | "log">>;
}

export const INSTANCE_RESEND: Extract<InstanceEmailConfig, { provider: "resend" }> = {
  provider: "resend",
  from: "Nearzero <nearzero@example.com>",
  apiKey: "re_instance_key_123456",
};

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const test = await createTestDatabase();
  await migrate(test.db, { directory: MIGRATIONS_DIR });
  const outside = new Outside();
  const fakes = new FakeObjects();
  const registry = new ObjectRegistry();
  fakes.register(registry);
  const services = createServices({
    db: test.db,
    log: silentLogger,
    authSecret: TEST_SECRET,
    consoleUrl: options.consoleUrl === undefined ? CONSOLE_URL : options.consoleUrl,
    instanceEmail: options.instanceEmail ?? null,
    http: outside.http,
    smtp: outside.smtp,
    resolveHost: outside.resolveHost,
    passwordHashing: TEST_HASHING,
    objects: registry,
    ...options.extra,
  });
  const harness: Harness = {
    test,
    services,
    outside,
    fakes,
    app: createApp({ db: test.db, log: silentLogger, services }),
    restart: () => createApp({ db: test.db, log: silentLogger, services }),
    browser: (browserOptions) => new Browser(harness.app, browserOptions),
    async reset() {
      await sql`
        truncate person, workspace, install_state, attempt_record, audit_event,
          workspace_old_slug, sign_in_challenge restart identity cascade
      `.execute(test.db);
      outside.emails.length = 0;
      outside.resendStatus = 200;
      outside.firecrawl = 200;
      outside.smtpResult = { sent: true };
      fakes.objects.length = 0;
    },
    drop: () => test.drop(),
  };
  return harness;
}

export interface BrowserOptions {
  /** The TCP peer the control plane sees (the console's proxy is 127.0.0.1). */
  peer?: string;
  /** Headers on every request, like X-Forwarded-For set by the console. */
  headers?: Record<string, string>;
}

export interface Reply {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: tests read whatever JSON came back.
  body: any;
  headers: Headers;
  setCookies: string[];
}

/** One browser: keeps its cookies like a real one, and talks JSON. */
export class Browser {
  readonly cookies = new Map<string, string>();
  constructor(
    private app: Hono<AppEnv>,
    private readonly options: BrowserOptions = {},
  ) {}

  use(app: Hono<AppEnv>): this {
    this.app = app;
    return this;
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const all = new Headers({ ...this.options.headers, ...headers });
    if (this.cookies.size > 0) {
      all.set("cookie", [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    let payload: Uint8Array | string | undefined;
    if (body instanceof Uint8Array) {
      payload = body;
    } else if (body !== undefined) {
      all.set("content-type", "application/json");
      payload = JSON.stringify(body);
    }
    const response = await this.app.request(
      `/api/v1${path}`,
      { method, headers: all, ...(payload === undefined ? {} : { body: payload }) },
      { peerAddress: this.options.peer ?? "127.0.0.1" },
    );
    const setCookies = response.headers.getSetCookie();
    for (const line of setCookies) {
      const [pair] = line.split(";");
      const [name, ...rest] = (pair ?? "").split("=");
      const value = rest.join("=");
      if (!name) continue;
      if (value === "" || /max-age=0/i.test(line)) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    const type = response.headers.get("content-type") ?? "";
    const parsed = type.includes("json") ? await response.json() : await response.arrayBuffer();
    return { status: response.status, body: parsed, headers: response.headers, setCookies };
  }

  get(path: string) {
    return this.request("GET", path);
  }
  post(path: string, body: unknown = {}) {
    return this.request("POST", path, body);
  }
  put(path: string, body: unknown = {}) {
    return this.request("PUT", path, body);
  }
  patch(path: string, body: unknown = {}) {
    return this.request("PATCH", path, body);
  }
  delete(path: string) {
    return this.request("DELETE", path);
  }

  async signIn(email: string, password = PASSWORD): Promise<Reply> {
    return this.post("/auth/sign-in", { email, password });
  }
}

/** Command-line input and output held in memory. */
export function fakeIo(
  lines: string[],
  interactive = false,
): CliIo & { output: string[]; errors: string[] } {
  const queue = [...lines];
  const output: string[] = [];
  const errors: string[] = [];
  return {
    interactive,
    output,
    errors,
    readLine: async () => queue.shift() ?? null,
    readSecret: async () => queue.shift() ?? null,
    out: (line) => output.push(line),
    err: (line) => errors.push(line),
  };
}

/** Creates the instance owner through the command and returns a signed-in browser. */
export async function setUpOwner(
  harness: Harness,
  email = "owner@example.com",
  password = PASSWORD,
): Promise<Browser> {
  const io = fakeIo([email, password]);
  const code = await runCommand(["create-owner"], harness.services, io);
  if (code !== 0) throw new Error(`create-owner failed: ${io.errors.join(" ")}`);
  const browser = harness.browser();
  const reply = await browser.signIn(email, password);
  if (reply.status !== 200) throw new Error(`owner sign-in failed: ${JSON.stringify(reply.body)}`);
  return browser;
}

/** Owner sign-up finished: named, workspace named, invite step skipped. */
export async function setUpNamedOwner(
  harness: Harness,
  workspaceName = "Acme Inc.",
  email = "owner@example.com",
): Promise<Browser> {
  const owner = await setUpOwner(harness, email);
  const named = await owner.post("/onboarding/workspace", { name: "Olivia Owner", workspaceName });
  if (named.status !== 200) throw new Error(JSON.stringify(named.body));
  await owner.post("/onboarding/skip-invitations");
  return owner;
}

/**
 * Invites someone into the owner's active workspace and signs them up through the emailed link.
 * Needs email set up (instance or workspace) so the link carries its proof.
 */
export async function addMemberThroughInvitation(
  harness: Harness,
  inviter: Browser,
  email: string,
  options: { role?: "admin" | "member"; policyIds?: string[]; name?: string } = {},
): Promise<Browser> {
  const invited = await inviter.post("/workspace/invitations", {
    email,
    role: options.role ?? "member",
    policyIds: options.policyIds ?? [],
  });
  if (invited.status !== 201) throw new Error(JSON.stringify(invited.body));
  const link = new URL(harness.outside.linkIn(harness.outside.lastEmailTo(email)));
  // Each person signs up from their own machine: sign-ups are limited per client address.
  const browser = harness.browser({ peer: nextPeer() });
  const registered = await browser.post("/auth/register", {
    token: link.searchParams.get("token"),
    proof: link.searchParams.get("proof"),
    password: PASSWORD,
  });
  if (registered.status !== 201) throw new Error(JSON.stringify(registered.body));
  const named = await browser.post("/onboarding/name", { name: options.name ?? "Mia Member" });
  if (named.status !== 200) throw new Error(JSON.stringify(named.body));
  return browser;
}

let peers = 0;

/** A client address of its own (TEST-NET-3), for a person who joins from their own machine. */
export function nextPeer(): string {
  peers = (peers % 250) + 1;
  return `203.0.113.${peers}`;
}

export async function personIdOf(harness: Harness, email: string): Promise<string> {
  const row = await harness.test.db
    .selectFrom("person")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  return row.id;
}
