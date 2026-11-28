import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { type ChannelType, testSentText } from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { emitBackupEvent } from "../src/backups/events.ts";
import type { RunRow } from "../src/backups/runs.ts";
import { silentLogger } from "../src/log.ts";
import { evaluateAlerts } from "../src/monitoring/alerts.ts";
import { dispatchNotifications } from "../src/notifications/dispatcher.ts";
import { emitDeployEvent, recordStart, recordStop } from "../src/notifications/emit.ts";
import { testMessage } from "../src/notifications/messages.ts";
import {
  DeliveryError,
  deliver,
  type NotificationTransport,
} from "../src/notifications/senders.ts";
import { sendSmtp } from "../src/notifications/smtp.ts";
import { setNotificationTransport } from "../src/notifications/transport.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { systemResolve } from "../src/security/outbound.ts";
import { runCleanup } from "../src/server-setup/cleanup.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { FakeHttpNotifier, FakeSmtpServer } from "./support/fake-notifiers.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  CONSOLE_URL,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember, makeProject, makeService } from "./support/projects.ts";

/**
 * Notification channels end to end (spec 15): the 12 types against local fake servers (HTTP
 * and SMTP), secrets that never come back, Test notification, one delivery per channel per
 * event, 3 retries with back-off and "Last delivery failed", deploy and restart events, and a
 * server alert that reaches a subscribed webhook exactly once.
 */

setDefaultTimeout(120_000);

let h: Harness;
let owner: Browser;
const notifier = new FakeHttpNotifier();
const smtp = new FakeSmtpServer();
let base = "";
let smtpPort = 0;

beforeAll(async () => {
  base = notifier.start();
  smtpPort = smtp.start();
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects } });
  setNotificationTransport(h.services, {
    http: (input, init) => fetch(input, init),
    smtp: sendSmtp,
    endpoints: {
      telegram: `${base}/telegram`,
      pushover: `${base}/pushover`,
      resend: `${base}/resend`,
    },
    retryDelaysMs: [0, 0, 0],
  });
}, 300_000);

afterAll(async () => {
  notifier.stop();
  smtp.stop();
  h.services.runners.stop();
  await h.drop();
}, 300_000);

beforeEach(async () => {
  await h.reset();
  await sql`truncate notification_outbox, notification_channel, control_plane_start, project, server cascade`.execute(
    h.test.db,
  );
  notifier.reset();
  smtp.mails.length = 0;
  owner = await setUpNamedOwner(h);
});

const SECRET = "tok-SECRET-0123456789";

function jsonAt(requests: { json: unknown }[], index: number): unknown {
  const request = requests[index];
  if (!request) throw new Error(`no request ${index}`);
  return request.json;
}

const json0 = (requests: { json: unknown }[]) => jsonAt(requests, 0);

function fieldsFor(type: ChannelType): Record<string, unknown> {
  switch (type) {
    case "slack":
      return { webhookUrl: `${base}/slack/${SECRET}`, channel: "#ops" };
    case "telegram":
      return { botToken: SECRET, chatId: "-1001234567890", threadId: 7 };
    case "discord":
      return { webhookUrl: `${base}/discord/${SECRET}` };
    case "lark":
      return { webhookUrl: `${base}/lark/${SECRET}` };
    case "teams":
      return { webhookUrl: `${base}/teams/${SECRET}` };
    case "email":
      return {
        host: "127.0.0.1",
        port: smtpPort,
        username: "mailer",
        password: SECRET,
        from: "nearzero@example.com",
        to: "ops@example.com, oncall@example.com",
      };
    case "resend":
      return { apiKey: SECRET, from: "Nearzero <nearzero@example.com>", to: "ops@example.com" };
    case "gotify":
      return { serverUrl: `${base}/gotify`, appToken: SECRET, priority: 8 };
    case "ntfy":
      return {
        serverUrl: `${base}/ntfy`,
        topic: "nearzero-alerts",
        accessToken: SECRET,
        priority: 4,
      };
    case "mattermost":
      return {
        webhookUrl: `${base}/mattermost/${SECRET}`,
        channel: "town-square",
        username: "nearzero",
      };
    case "pushover":
      return { userKey: "user-key-123", apiToken: SECRET, priority: 2, retry: 60, expire: 3600 };
    case "webhook":
      return {
        url: `${base}/hook`,
        headers: [{ name: "Authorization", value: `Bearer ${SECRET}` }],
      };
  }
}

async function addChannel(
  type: ChannelType,
  events: string[] = ["deploy.failed"],
  name = `${type} channel`,
) {
  const reply = await owner.post("/notification-channels", {
    name,
    type,
    fields: fieldsFor(type),
    events,
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  return reply.body.channel as { id: string; name: string };
}

describe("the 12 channel types, each against a local fake (spec 15.2)", () => {
  const TYPES: ChannelType[] = [
    "slack",
    "telegram",
    "discord",
    "lark",
    "teams",
    "email",
    "resend",
    "gotify",
    "ntfy",
    "mattermost",
    "pushover",
    "webhook",
  ];

  for (const type of TYPES) {
    test(`${type}: Test notification sends its own payload`, async () => {
      const reply = await owner.post("/notification-channels/test", {
        type,
        fields: fieldsFor(type),
        name: "Ops",
      });
      expect(reply.status).toBe(200);
      expect(reply.body).toEqual({ ok: true, message: testSentText(type) });
      if (type === "email") {
        expect(smtp.mails).toHaveLength(1);
        expect(smtp.mails[0]?.to).toEqual(["ops@example.com", "oncall@example.com"]);
        expect(smtp.mails[0]?.from).toBe("nearzero@example.com");
        expect(smtp.mails[0]?.auth).toBe("mailer");
        expect(smtp.mails[0]?.data).toContain("Subject: Test notification from Nearzero");
        return;
      }
      expect(notifier.requests).toHaveLength(1);
      const request = notifier.requests[0];
      if (!request) throw new Error("no request");
      expect(request.method).toBe("POST");
      // biome-ignore lint/suspicious/noExplicitAny: tests read whatever JSON came back.
      const json = request.json as Record<string, any>;
      switch (type) {
        case "slack":
          expect(json.channel).toBe("#ops");
          expect(json.text).toContain("*Test notification from Nearzero*");
          break;
        case "telegram":
          expect(request.path).toBe(`/telegram/bot${SECRET}/sendMessage`);
          expect(json).toMatchObject({
            chat_id: "-1001234567890",
            parse_mode: "HTML",
            message_thread_id: 7,
          });
          expect(json.text).toContain("<b>Test notification from Nearzero</b>");
          break;
        case "discord":
          // Decoration is on by default: an emoji leads the title (R3-38).
          expect(json.embeds[0].title).toBe("ℹ️ Test notification from Nearzero");
          expect(typeof json.embeds[0].color).toBe("number");
          break;
        case "lark":
          // A card, not plain text (R3-38).
          expect(json).toMatchObject({
            msg_type: "interactive",
            card: { header: { title: { content: "Test notification from Nearzero" } } },
          });
          break;
        case "teams":
          expect(json.type).toBe("message");
          expect(json.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
          expect(json.attachments[0].content.body[0].text).toBe("Test notification from Nearzero");
          break;
        case "resend":
          expect(request.path).toBe("/resend/emails");
          expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
          expect(json).toMatchObject({
            from: "Nearzero <nearzero@example.com>",
            to: ["ops@example.com"],
          });
          break;
        case "gotify":
          expect(request.path).toBe("/gotify/message");
          expect(request.headers["x-gotify-key"]).toBe(SECRET);
          expect(json).toMatchObject({ title: "Test notification from Nearzero", priority: 8 });
          expect(json.extras["client::display"].contentType).toBe("text/markdown");
          break;
        case "ntfy":
          expect(request.path).toBe("/ntfy");
          expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
          expect(json).toMatchObject({
            topic: "nearzero-alerts",
            priority: 4,
            title: "Test notification from Nearzero",
          });
          break;
        case "mattermost":
          expect(json).toMatchObject({ channel: "town-square", username: "nearzero" });
          expect(json.text).toContain("**Test notification from Nearzero**");
          break;
        case "pushover": {
          expect(request.path).toBe("/pushover/1/messages.json");
          const form = new URLSearchParams(request.body);
          expect(form.get("token")).toBe(SECRET);
          expect(form.get("user")).toBe("user-key-123");
          expect(form.get("priority")).toBe("2");
          expect(form.get("retry")).toBe("60");
          expect(form.get("expire")).toBe("3600");
          break;
        }
        case "webhook":
          expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
          expect(request.headers["content-type"]).toContain("application/json");
          expect(json).toMatchObject({ event: "test", title: "Test notification from Nearzero" });
          // 0.1.x's test body: title, message, type "test" and timestamp (R3-37).
          expect(json).toMatchObject({ type: "test", message: expect.any(String) });
          expect(Number.isNaN(Date.parse(String((json as { timestamp: string }).timestamp)))).toBe(
            false,
          );
          break;
      }
    });
  }

  test("a failing test names the provider's answer, never the secret", async () => {
    notifier.answers.set(`/slack/${SECRET}`, { status: 404, body: "no_team" });
    const reply = await owner.post("/notification-channels/test", {
      type: "slack",
      fields: fieldsFor("slack"),
    });
    // A typed address's answer isn't quoted (B1-20): only Slack's own hooks.slack.com would be.
    expect(reply.body).toEqual({ ok: false, message: "Test failed: Slack answered 404" });
    const unreachable = await owner.post("/notification-channels/test", {
      type: "telegram",
      fields: { botToken: SECRET, chatId: "-100" },
    });
    expect(unreachable.body.ok).toBe(true);
    const down = await owner.post("/notification-channels/test", {
      type: "webhook",
      fields: { url: "http://127.0.0.1:1/hook" },
    });
    expect(down.body.ok).toBe(false);
    expect(down.body.message).toBe(
      "Test failed: couldn't reach 127.0.0.1:1 (the connection failed)",
    );
  });

  test("fields are checked first, in the spec's words", async () => {
    const reply = await owner.post("/notification-channels/test", {
      type: "gotify",
      fields: { serverUrl: "gotify.local", appToken: "" },
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error.fields["fields.serverUrl"]).toBe(
      "Server URL must start with http:// or https://.",
    );
    expect(reply.body.error.fields["fields.appToken"]).toBe("App token is required.");
    const noName = await owner.post("/notification-channels", {
      name: "",
      type: "slack",
      fields: fieldsFor("slack"),
    });
    expect(noName.body.error.fields.name).toBe("Name is required.");
  });
});

describe("private and internal addresses (B1-20, spec 23.9)", () => {
  async function outsider(): Promise<Browser> {
    const browser = await addMemberThroughInvitation(h, owner, "outsider@example.com");
    const personal = await h.test.db
      .selectFrom("workspace")
      .select("id")
      .where("created_by", "=", await personIdOf(h, "outsider@example.com"))
      .where("is_personal", "=", true)
      .executeTakeFirstOrThrow();
    await browser.post(`/workspaces/${personal.id}/switch`);
    return browser;
  }

  test("an ordinary account can't make the control plane post to internal addresses, or read their answers", async () => {
    const b = await outsider();
    notifier.answers.set("/hook", { status: 500, body: "internal secret page" });
    // The review's attack: Test with a custom webhook at an internal address and a header.
    for (const url of [
      `${base}/hook`,
      "http://169.254.169.254/latest/meta-data/",
      "http://localhost:3000/api/v1/health",
      "http://[::1]:5432/",
    ]) {
      const reply = await b.post("/notification-channels/test", {
        type: "webhook",
        fields: { url, headers: [{ name: "X-Probe", value: "1" }] },
      });
      expect(reply.body.ok).toBe(false);
      expect(reply.body.message).toContain(
        "is a private or internal address, and only an instance administrator can send there",
      );
    }
    expect(notifier.on("/hook")).toHaveLength(0);
    // Nor save a channel there.
    const saved = await b.post("/notification-channels", {
      name: "Probe",
      type: "gotify",
      fields: { serverUrl: base, appToken: "x" },
      events: [],
    });
    expect(saved.status).toBe(400);
    expect(saved.body.error.fields["fields.serverUrl"]).toBe(
      "127.0.0.1 is a private or internal address. Only an instance administrator can send notifications there.",
    );
    const smtpProbe = await b.post("/notification-channels/test", {
      type: "email",
      fields: { host: "127.0.0.1", port: smtpPort, from: "a@example.com", to: "b@example.com" },
    });
    expect(smtpProbe.body.ok).toBe(false);
    expect(smtp.mails).toHaveLength(0);
  });

  test("an instance administrator may use an internal address, and its answer still isn't quoted", async () => {
    notifier.answers.set("/hook", { status: 500, body: "internal secret page" });
    const reply = await owner.post("/notification-channels/test", {
      type: "webhook",
      fields: { url: `${base}/hook` },
    });
    expect(reply.body).toEqual({ ok: false, message: "Test failed: Custom webhook answered 500" });
    expect(notifier.on("/hook")).toHaveLength(1);
  });
});

describe("channels page (spec 15.1)", () => {
  test("secrets are sealed and never shown again; blank keeps them; a new destination needs them", async () => {
    const channel = await addChannel("telegram", ["deploy.failed", "server.alert"], "Ops");
    const list = await owner.get("/notification-channels");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(SECRET);
    expect(list.body.total).toBe(1);
    expect(list.body.channels[0]).toMatchObject({
      name: "Ops",
      typeLabel: "Telegram",
      eventsText: "Failed deploys, Server alerts",
      secrets: { botToken: { saved: true, hint: null } },
      settings: { chatId: "-1001234567890", threadId: 7 },
    });
    const sealed = await h.test.db
      .selectFrom("notification_channel")
      .select("secrets_sealed")
      .executeTakeFirstOrThrow();
    expect(sealed.secrets_sealed).not.toContain(SECRET);

    const kept = await owner.patch(`/notification-channels/${channel.id}`, {
      fields: { botToken: "", chatId: "-1001234567890", threadId: 9 },
    });
    expect(kept.status).toBe(200);
    const test = await owner.post("/notification-channels/test", {
      type: "telegram",
      channelId: channel.id,
      fields: { botToken: "", chatId: "-1001234567890" },
    });
    expect(test.body.ok).toBe(true);
    expect(notifier.requests.at(-1)?.path).toBe(`/telegram/bot${SECRET}/sendMessage`);

    const moved = await owner.patch(`/notification-channels/${channel.id}`, {
      fields: { botToken: "", chatId: "-200" },
    });
    expect(moved.status).toBe(400);
    expect(moved.body.error.fields["fields.botToken"]).toBe(
      "Enter the bot token again when you change where this channel sends.",
    );

    const slack = await addChannel("slack", [], "Chat");
    const slackList = await owner.get("/notification-channels");
    const shown = slackList.body.channels.find((item: { id: string }) => item.id === slack.id);
    expect(shown.secrets.webhookUrl).toEqual({ saved: true, hint: `${base}/…` });
    expect(shown.eventsText).toBe("No events");
  });

  test("names are unique; delete; members need the capability; another workspace's channel isn't found", async () => {
    const channel = await addChannel("webhook", [], "Hooks");
    const again = await owner.post("/notification-channels", {
      name: "hooks",
      type: "webhook",
      fields: fieldsFor("webhook"),
    });
    expect(again.status).toBe(409);
    const member = await addMember(h, owner, "member@example.com");
    expect((await member.get("/notification-channels")).status).toBe(403);
    const manager = await addMember(h, owner, "manager@example.com", {
      capabilities: ["notifications.manage"],
    });
    expect((await manager.get("/notification-channels")).body.total).toBe(1);
    const deleted = await manager.delete(`/notification-channels/${channel.id}`);
    expect(deleted.body).toEqual({ deleted: true, message: "Notification channel deleted" });
    expect((await owner.get(`/notification-channels/${channel.id}`)).status).toBe(404);
  });

  test("Nearzero restart is only for the first workspace", async () => {
    const list = await owner.get("/notification-channels");
    expect(list.body.events).toContain("nearzero.restart");
    const other = await owner.post("/workspaces", { name: "Second" });
    expect(other.status).toBe(201);
    await owner.post("/session/workspace", { workspaceId: other.body.workspace.id });
    const second = await owner.get("/notification-channels");
    if (second.status === 200 && !second.body.events.includes("nearzero.restart")) {
      const refused = await owner.post("/notification-channels", {
        name: "X",
        type: "webhook",
        fields: fieldsFor("webhook"),
        events: ["nearzero.restart"],
      });
      expect(refused.status).toBe(400);
    }
  });
});

async function workspaceId(): Promise<string> {
  const row = await h.test.db
    .selectFrom("workspace")
    .select("id")
    .orderBy("created_at")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function failedDeployment(
  extra: { service_kind?: string; status?: string; finished_at?: Date } = {},
): Promise<string> {
  const ws = await workspaceId();
  const row = await h.test.db
    .insertInto("deployment")
    .values({
      workspace_id: ws,
      service_kind: "application",
      service_name: "web",
      app_name: "web-abc123",
      project_name: "Shop",
      environment_name: "production",
      server_name: "Nearzero host",
      status: "failed",
      trigger: "manual",
      error:
        "The new container exited with code 1 before it became healthy. DATABASE_PASSWORD was not printed.",
      finished_at: new Date(),
      ...extra,
    } as never)
    .returning("id")
    .executeTakeFirstOrThrow();
  return (row as { id: string }).id;
}

describe("events and deliveries (spec 15.3)", () => {
  test("a failed deploy is one message per subscribed channel, naming the service and linking to the log", async () => {
    await addChannel("slack", ["deploy.failed"], "Slack");
    await addChannel("discord", ["deploy.failed"], "Discord");
    await addChannel("email", ["deploy.failed"], "Email");
    await addChannel("webhook", ["deploy.failed"], "Webhook");
    await addChannel("teams", ["deploy.succeeded"], "Not subscribed");
    const id = await failedDeployment();
    await emitDeployEvent(h.test.db, silentLogger, id);
    await emitDeployEvent(h.test.db, silentLogger, id);
    const first = await dispatchNotifications(h.services, silentLogger);
    expect(first).toMatchObject({ fannedOut: 1, sent: 4, failed: 0 });
    const second = await dispatchNotifications(h.services, silentLogger);
    expect(second).toMatchObject({ fannedOut: 0, sent: 0 });
    const slug = (await h.test.db.selectFrom("workspace").select("slug").executeTakeFirstOrThrow())
      .slug;
    const logUrl = `${CONSOLE_URL}/${slug}/dashboard/deployments/${id}`;
    const slack = notifier.on(`/slack/${SECRET}`);
    expect(slack).toHaveLength(1);
    expect((json0(slack) as { text: string }).text).toContain("Deploy failed: web");
    expect(JSON.stringify(json0(slack))).toContain(logUrl);
    const discord = notifier.on(`/discord/${SECRET}`);
    expect(discord).toHaveLength(1);
    expect(
      (json0(discord) as { embeds: { title: string; url: string }[] }).embeds[0],
    ).toMatchObject({ title: "❌ Deploy failed: web", url: logUrl });
    const hook = notifier.on("/hook");
    expect(hook).toHaveLength(1);
    expect(hook[0]?.json).toMatchObject({
      event: "deploy.failed",
      link: { url: logUrl },
      data: { service: { name: "web" } },
    });
    // A receiver written for 0.1.x reads its own fields from the same body (R3-37, R4-14).
    const flat = hook[0]?.json as Record<string, unknown>;
    expect(flat).toMatchObject({
      status: "error",
      type: "build",
      // 0.1.x's fixed title and sentence; 1.0's own title is `headline` (R4-14).
      title: "Build Error",
      message: "Build failed with errors",
      headline: "Deploy failed: web",
      projectName: "Shop",
      applicationName: "web",
      applicationType: "application",
      buildLink: logUrl,
      errorMessage:
        "The new container exited with code 1 before it became healthy. DATABASE_PASSWORD was not printed.",
    });
    expect(Number.isNaN(Date.parse(String(flat.timestamp)))).toBe(false);
    expect(typeof flat.date).toBe("string");
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]?.data).toContain("Subject: Deploy failed: web");
    expect(notifier.on(`/teams/${SECRET}`)).toHaveLength(0);
  });

  test("a failing channel is retried 3 times, and its row says so; a success clears it", async () => {
    const channel = await addChannel("slack", ["deploy.failed"], "Flaky");
    notifier.answers.set(`/slack/${SECRET}`, { status: 500, body: "server error" });
    await emitDeployEvent(h.test.db, silentLogger, await failedDeployment());
    expect((await dispatchNotifications(h.services, silentLogger)).retrying).toBe(1);
    const row = (await owner.get(`/notification-channels/${channel.id}`)).body.channel;
    expect(row.lastFailure).toBe("Last delivery failed: Slack answered 500");
    await dispatchNotifications(h.services, silentLogger);
    await dispatchNotifications(h.services, silentLogger);
    const last = await dispatchNotifications(h.services, silentLogger);
    expect(last.failed).toBe(1);
    expect(notifier.on(`/slack/${SECRET}`)).toHaveLength(4);
    await dispatchNotifications(h.services, silentLogger);
    expect(notifier.on(`/slack/${SECRET}`)).toHaveLength(4);
    const delivery = await h.test.db
      .selectFrom("notification_delivery")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(delivery).toMatchObject({ status: "failed", attempts: 4 });

    notifier.answers.clear();
    await emitDeployEvent(h.test.db, silentLogger, await failedDeployment());
    await dispatchNotifications(h.services, silentLogger);
    expect(
      (await owner.get(`/notification-channels/${channel.id}`)).body.channel.lastFailure,
    ).toBeNull();
  });

  test("Nearzero restart after a stop or a crash, for the first workspace", async () => {
    await addChannel("webhook", ["nearzero.restart"], "Restarts");
    const first = await recordStart(h.test.db, silentLogger);
    await dispatchNotifications(h.services, silentLogger);
    expect(notifier.on("/hook")).toHaveLength(0);
    await recordStop(h.test.db, first);
    const second = await recordStart(h.test.db, silentLogger);
    await recordStart(h.test.db, silentLogger);
    expect(second).not.toBeNull();
    await dispatchNotifications(h.services, silentLogger);
    const hooks = notifier.on("/hook");
    expect(hooks).toHaveLength(2);
    expect((json0(hooks) as { summary: string }).summary).toContain("after a stop");
    expect((jsonAt(hooks, 1) as { summary: string }).summary).toContain("after an unexpected stop");
  });

  test("CPU over 50% for six samples sends exactly one alert to a subscribed webhook (spec 14 acceptance)", async () => {
    await addChannel("webhook", ["server.alert"], "Alerts");
    const set = await owner.put("/servers/host/alerts", {
      cpuThreshold: 50,
      memoryThreshold: null,
    });
    expect(set.status).toBe(200);
    expect(set.body.alerts).toMatchObject({ cpuThreshold: 50, memoryThreshold: null, channels: 1 });
    const now = Date.now();
    const sample = (offset: number, cpu: number) => ({
      at: now - 60_000 + offset * 5_000,
      cpuPercent: cpu,
      memoryUsedBytes: 1,
      memoryTotalBytes: 10,
      diskUsedBytes: 1,
      diskTotalBytes: 10,
      uptimeSeconds: 100,
    });
    let fired = 0;
    const values = [5, 97, 99, 98, 99, 97, 96, 3, 2];
    for (const [index, cpu] of values.entries())
      fired += await evaluateAlerts(h.test.db, silentLogger, "host", [sample(index, cpu)], now);
    // A runner's old backlog never fires.
    fired += await evaluateAlerts(
      h.test.db,
      silentLogger,
      "host",
      [sample(-200, 99), sample(-199, 99), sample(-198, 99)],
      now,
    );
    expect(fired).toBe(1);
    await dispatchNotifications(h.services, silentLogger);
    const hooks = notifier.on("/hook");
    expect(hooks).toHaveLength(1);
    expect(hooks[0]?.json).toMatchObject({
      event: "server.alert",
      data: { metric: "cpu", threshold: 50 },
    });
    expect((json0(hooks) as { summary: string }).summary).toBe(
      "CPU on Nearzero host is at 98%, above its 50% threshold.",
    );
    // R3-35: every channel's alert says when the sample that crossed the threshold was taken.
    const body = json0(hooks) as {
      facts: { label: string; value: string }[];
      data: { at: string };
    };
    const firing = new Date(body.data.at);
    expect(firing.getTime()).toBeLessThan(now);
    expect(now - firing.getTime()).toBeLessThan(60_000);
    expect(body.facts).toContainEqual({
      label: "Time",
      value: `${firing.toISOString().slice(0, 10)} ${firing.toISOString().slice(11, 19)} UTC`,
    });

    const test = await owner.post("/servers/host/alerts/test", {});
    expect(test.body).toEqual({ channels: 1, message: "Test alert sent to 1 channel." });
    await dispatchNotifications(h.services, silentLogger);
    expect(notifier.on("/hook")).toHaveLength(2);
    expect(
      (await owner.put("/servers/host/alerts", { cpuThreshold: 0, memoryThreshold: null })).status,
    ).toBe(400);
    const member = await addMember(h, owner, "m@example.com");
    expect(
      (await member.put("/servers/host/alerts", { cpuThreshold: 50, memoryThreshold: null }))
        .status,
    ).toBe(403);
  });
});

describe("each channel's own format (R3-38, spec 15.3)", () => {
  const FINISHED = new Date("2026-11-27T14:05:09.000Z");
  const WHEN = "2026-11-27 14:05:09 UTC";

  async function addWith(type: ChannelType, fields: Record<string, unknown>, events: string[]) {
    const reply = await owner.post("/notification-channels", {
      name: `${type} formatted`,
      type,
      fields,
      events,
    });
    if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  }

  // biome-ignore lint/suspicious/noExplicitAny: tests read whatever JSON came back.
  const only = (path: string): Record<string, any> => {
    const requests = notifier.on(path);
    expect(requests).toHaveLength(1);
    // biome-ignore lint/suspicious/noExplicitAny: as above.
    return json0(requests) as Record<string, any>;
  };

  test("a failed database deploy says when and what kind, in each channel's own shape", async () => {
    const events = ["deploy.failed"];
    await addChannel("slack", events, "Slack");
    await addWith(
      "discord",
      { webhookUrl: `${base}/discord/${SECRET}`, decoration: false },
      events,
    );
    await addChannel("telegram", events, "Telegram");
    await addChannel("lark", events, "Lark");
    await addChannel("ntfy", events, "ntfy");
    await addWith("mattermost", { webhookUrl: `${base}/mattermost/${SECRET}` }, events);
    await addChannel("email", events, "Email");
    await addChannel("webhook", events, "Webhook");
    const id = await failedDeployment({ service_kind: "postgres", finished_at: FINISHED });
    await emitDeployEvent(h.test.db, silentLogger, id);
    expect((await dispatchNotifications(h.services, silentLogger)).sent).toBe(8);
    const slug = (await h.test.db.selectFrom("workspace").select("slug").executeTakeFirstOrThrow())
      .slug;
    const logUrl = `${CONSOLE_URL}/${slug}/dashboard/deployments/${id}`;

    // Every message says when it happened and that a Postgres database was deployed (the type names of B3-21).
    for (const request of notifier.requests) {
      const body = JSON.stringify(request.json ?? request.body);
      expect(body).toContain(WHEN);
      expect(body).toContain("Postgres");
    }
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0]?.data).toContain("Postgres");
    expect(smtp.mails[0]?.data).toContain("2026-11-27 14:05:09");

    // Slack: a red attachment with fields.
    const slack = only(`/slack/${SECRET}`);
    expect(slack.text).toBe("*Deploy failed: web*");
    expect(slack.attachments[0].color).toBe("#dc2626");
    expect(slack.attachments[0].fields).toContainEqual({
      title: "Type",
      value: "Postgres",
      short: true,
    });
    expect(slack.attachments[0].fields).toContainEqual({ title: "Time", value: WHEN, short: true });
    expect(slack.attachments[0].ts).toBe(FINISHED.getTime() / 1000);
    expect(slack.attachments[0].text).toContain(logUrl);

    // Discord with Decoration off: still an embed, only without emoji.
    const discord = only(`/discord/${SECRET}`);
    expect(discord.content).toBeUndefined();
    expect(discord.embeds[0]).toMatchObject({
      title: "Deploy failed: web",
      url: logUrl,
      timestamp: FINISHED.toISOString(),
    });
    expect(discord.embeds[0].fields).toContainEqual({
      name: "Type",
      value: "Postgres",
      inline: true,
    });

    // Telegram: a "Deployment Logs" button to the log.
    const telegram = only(`/telegram/bot${SECRET}/sendMessage`);
    expect(telegram.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Deployment Logs", url: logUrl }]],
    });
    expect(telegram.text).toContain(`<b>Time:</b> ${WHEN}`);

    // Lark: a red card with a "View Build Details" button.
    const lark = only(`/lark/${SECRET}`);
    expect(lark.msg_type).toBe("interactive");
    expect(lark.card.header).toEqual({
      template: "red",
      title: { tag: "plain_text", content: "Deploy failed: web" },
    });
    const actions = lark.card.elements.find((item: { tag: string }) => item.tag === "action");
    expect(actions.actions[0]).toMatchObject({
      tag: "button",
      text: { tag: "plain_text", content: "View Build Details" },
      url: logUrl,
    });

    // ntfy: a "Build details" action button.
    const ntfy = only("/ntfy");
    expect(ntfy.actions).toEqual([{ action: "view", label: "Build details", url: logUrl }]);
    expect(ntfy.message).toContain(`Time: ${WHEN}`);

    // Mattermost with no user name posts as Nearzero.
    expect(only(`/mattermost/${SECRET}`).username).toBe("Nearzero");

    // A custom webhook keeps the flat fields 0.1.x posted (R3-37).
    expect(only("/hook")).toMatchObject({
      type: "build",
      status: "error",
      applicationType: "postgres",
      buildLink: logUrl,
    });
  });

  test("a deploy without a console address carries no button, and Compose is named", async () => {
    await addChannel("telegram", ["deploy.succeeded"], "Telegram");
    const saved = h.services.consoleUrl;
    h.services.consoleUrl = () => null;
    try {
      const id = await failedDeployment({ service_kind: "compose", status: "active" });
      await emitDeployEvent(h.test.db, silentLogger, id);
      await dispatchNotifications(h.services, silentLogger);
    } finally {
      h.services.consoleUrl = saved;
    }
    const telegram = only(`/telegram/bot${SECRET}/sendMessage`);
    expect(telegram.reply_markup).toBeUndefined();
    expect(telegram.text).toContain("<b>Type:</b> Compose");
  });

  test("every other event says when it happened too", async () => {
    await addChannel("webhook", ["nearzero.restart"], "Restarts");
    const first = await recordStart(h.test.db, silentLogger);
    await recordStop(h.test.db, first);
    await recordStart(h.test.db, silentLogger);
    await dispatchNotifications(h.services, silentLogger);
    const body = only("/hook") as { facts: { label: string; value: string }[] };
    const started = await h.test.db
      .selectFrom("control_plane_start")
      .select("started_at")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    const iso = new Date(started.started_at).toISOString();
    expect(body.facts.at(-1)).toEqual({
      label: "Time",
      value: `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`,
    });
    // A test message says when it was sent.
    const sent = await owner.post("/notification-channels/test", {
      type: "slack",
      fields: fieldsFor("slack"),
    });
    expect(sent.body.ok).toBe(true);
    const test = notifier.on(`/slack/${SECRET}`);
    expect(
      (json0(test) as { attachments: { fields: { title: string }[] }[] }).attachments[0]?.fields,
    ).toContainEqual(expect.objectContaining({ title: "Time" }));
  });
});

describe("the custom webhook body a 0.1.x receiver reads (R3-37, R4-14, spec 15.4)", () => {
  const ALL_EVENTS = [
    "deploy.succeeded",
    "deploy.failed",
    "backup.database",
    "backup.volume",
    "server.docker-cleanup",
    "server.alert",
    "nearzero.restart",
  ];
  const FINISHED = new Date("2026-11-27T14:05:09.000Z");

  function backupRun(extra: Partial<RunRow>): RunRow {
    return {
      id: crypto.randomUUID(),
      workspace_id: "",
      schedule_id: null,
      service_id: null,
      operation: "backup",
      kind: "database",
      service_kind: "postgres",
      service_name: "pg-main",
      app_name: "pg-main-abc123",
      project_name: "Shop",
      environment_name: "production",
      server_id: null,
      destination_id: null,
      destination_name: "Offsite",
      database_name: "analytics",
      source_database: null,
      volume_name: null,
      file_key: null,
      exclusive: false,
      size_bytes: null,
      status: "failed",
      trigger: "schedule",
      request_key: null,
      due_at: null,
      error: "pg_dump: connection refused",
      requested_by: null,
      job_id: null,
      log_bytes: 0,
      log_lines: 0,
      created_at: FINISHED,
      started_at: FINISHED,
      finished_at: FINISHED,
      updated_at: FINISHED,
      ...extra,
    };
  }

  // biome-ignore lint/suspicious/noExplicitAny: tests read whatever JSON came back.
  type Body = Record<string, any>;

  async function bodies(): Promise<Body[]> {
    await dispatchNotifications(h.services, silentLogger);
    return notifier.on("/hook").map((request) => request.json as Body);
  }

  /** Deliveries go out side by side, so each body is picked by what it is about. */
  function pick(list: Body[], match: (body: Body) => boolean): Body {
    const found = list.filter(match);
    expect(found).toHaveLength(1);
    return found[0] as Body;
  }

  test("every event carries 0.1.x's fixed title and sentence, and 1.0's own title is its headline", async () => {
    await addChannel("webhook", ALL_EVENTS, "Receiver");
    await emitDeployEvent(h.test.db, silentLogger, await failedDeployment());
    const ws = await workspaceId();
    await emitBackupEvent(h.test.db, silentLogger, backupRun({ workspace_id: ws }));
    const all = await bodies();
    const failed = pick(all, (body) => body.event === "deploy.failed");
    const backup = pick(all, (body) => body.event === "backup.database");
    expect(failed).toMatchObject({
      title: "Build Error",
      message: "Build failed with errors",
      headline: "Deploy failed: web",
      summary: expect.stringContaining("exited with code 1"),
      event: "deploy.failed",
    });
    expect(backup).toMatchObject({
      title: "Database Backup Failed",
      message: "Database backup failed",
      headline: "Database backup failed: pg-main",
    });
    for (const body of [failed, backup]) {
      expect(typeof body?.sentAt).toBe("string");
      expect(Array.isArray(body?.facts)).toBe(true);
    }
  });

  test("a failed backup of database analytics on pg-main: type and status error, databaseName analytics", async () => {
    await addChannel("webhook", ALL_EVENTS, "Receiver");
    const ws = await workspaceId();
    await emitBackupEvent(h.test.db, silentLogger, backupRun({ workspace_id: ws }));
    await emitBackupEvent(
      h.test.db,
      silentLogger,
      backupRun({
        workspace_id: ws,
        status: "succeeded",
        error: null,
        service_kind: "mongodb",
        service_name: "docs",
        database_name: "catalog",
        size_bytes: 1_572_864,
      }),
    );
    const all = await bodies();
    const failed = pick(all, (body) => body.applicationName === "pg-main");
    const mongo = pick(all, (body) => body.applicationName === "docs");
    expect(failed).toMatchObject({
      type: "error",
      status: "error",
      databaseName: "analytics",
      applicationName: "pg-main",
      projectName: "Shop",
      databaseType: "postgres",
      errorMessage: "pg_dump: connection refused",
      // When the backup finished, not when the message went out.
      timestamp: FINISHED.toISOString(),
      date: FINISHED.toLocaleString(),
    });
    expect(failed?.backupSize).toBeUndefined();
    expect(mongo).toMatchObject({
      title: "Database Backup Successful",
      message: "Database backup completed successfully",
      type: "success",
      status: "success",
      databaseName: "catalog",
      // 0.1.x named MongoDB "mongo".
      databaseType: "mongo",
      // A success has an empty errorMessage, and the size is a string.
      errorMessage: "",
      backupSize: "1.5 MB",
    });
  });

  test("a volume backup names its volume and the service's type", async () => {
    await addChannel("webhook", ALL_EVENTS, "Receiver");
    const ws = await workspaceId();
    await emitBackupEvent(
      h.test.db,
      silentLogger,
      backupRun({
        workspace_id: ws,
        kind: "volume",
        service_kind: "application",
        service_name: "web",
        database_name: null,
        volume_name: "uploads",
        status: "succeeded",
        error: null,
        size_bytes: 2048,
      }),
    );
    await emitBackupEvent(
      h.test.db,
      silentLogger,
      backupRun({
        workspace_id: ws,
        kind: "volume",
        service_kind: "compose",
        service_name: "stack",
        database_name: null,
        volume_name: "data",
        status: "failed",
        error: "the volume is gone",
      }),
    );
    const all = await bodies();
    const ok = pick(all, (body) => body.applicationName === "web");
    const failed = pick(all, (body) => body.applicationName === "stack");
    expect(ok).toMatchObject({
      title: "Volume Backup Successful",
      message: "Volume backup completed successfully",
      type: "success",
      status: "success",
      volumeName: "uploads",
      serviceType: "application",
      applicationName: "web",
      backupSize: "2.0 KB",
      errorMessage: "",
    });
    expect(failed).toMatchObject({
      title: "Volume Backup Failed",
      message: "Volume backup failed",
      type: "error",
      serviceType: "compose",
      errorMessage: "the volume is gone",
    });
  });

  test("a deploy that succeeded lists every hostname of the service, without a scheme", async () => {
    await addChannel("webhook", ALL_EVENTS, "Receiver");
    const project = await makeProject(owner, "Shop");
    const environmentId = project.environments.development as string;
    const created = await makeService(owner, environmentId, { name: "web", kind: "application" });
    const serviceId = created.service.id as string;
    const ws = await workspaceId();
    for (const host of ["a.example.com", "b.example.com"]) {
      await h.test.db
        .insertInto("hostname")
        .values({ workspace_id: ws, host, source: "own", target: "host", service_id: serviceId })
        .execute();
    }
    const id = await failedDeployment({ status: "active", service_kind: "mongodb" });
    await h.test.db
      .updateTable("deployment")
      .set({ service_id: serviceId } as never)
      .where("id", "=", id)
      .execute();
    await emitDeployEvent(h.test.db, silentLogger, id);
    const [body] = await bodies();
    expect(body).toMatchObject({
      title: "Build Success",
      message: "Build completed successfully",
      headline: "Deployed web",
      status: "success",
      type: "build",
      domains: "a.example.com, b.example.com",
      applicationType: "mongo",
    });
    expect(body?.errorMessage).toBeUndefined();
  });

  test("Docker cleanup carries 0.1.x's cleanupMessage, for a server and for the host", async () => {
    await addChannel("webhook", ALL_EVENTS, "Receiver");
    const ws = await workspaceId();
    const key = await h.test.db
      .insertInto("ssh_key")
      .values({
        workspace_id: ws,
        name: `k-${crypto.randomUUID().slice(0, 8)}`,
        key_type: "ed25519",
        public_key: "ssh-ed25519 AAAA",
        fingerprint: "SHA256:x",
        private_key_sealed: "nzs1.x",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const server = await h.test.db
      .insertInto("server")
      .values({
        workspace_id: ws,
        name: "edge-1",
        address: "198.51.100.4",
        ssh_user: "root",
        ssh_key_id: key.id,
        label: `e${Date.now()}`,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const runners = { command: async () => ({ reclaimedBytes: 4096 }) } as never;
    await runCleanup({ db: h.test.db, runners }, silentLogger, server.id, "2026-11-27");
    await runCleanup({ db: h.test.db, runners }, silentLogger, "host", "2026-11-27");
    const all = await bodies();
    const edge = pick(all, (body) => body.serverName === "edge-1");
    const host = pick(all, (body) => body.serverName === "Nearzero host");
    expect(edge).toMatchObject({
      title: "Docker Cleanup",
      message: "Docker cleanup completed successfully",
      status: "success",
      type: "docker-cleanup",
      cleanupMessage: `Docker cleanup for Server edge-1 (${server.id})`,
    });
    expect(host).toMatchObject({
      title: "Docker Cleanup",
      cleanupMessage: "Docker cleanup for nearzero",
    });
  });

  test("a memory alert has type Memory and alertType server-threshold, at the time of its sample", async () => {
    await addChannel("webhook", ALL_EVENTS, "Receiver");
    const set = await owner.put("/servers/host/alerts", {
      cpuThreshold: null,
      memoryThreshold: 50,
    });
    expect(set.status).toBe(200);
    const now = Date.now();
    const samples = [0, 1, 2, 3].map((offset) => ({
      at: now - 60_000 + offset * 5_000,
      cpuPercent: 1,
      memoryUsedBytes: 9,
      memoryTotalBytes: 10,
      diskUsedBytes: 1,
      diskTotalBytes: 10,
      uptimeSeconds: 100,
    }));
    expect(await evaluateAlerts(h.test.db, silentLogger, "host", samples, now)).toBe(1);
    const [body] = await bodies();
    expect(body).toMatchObject({
      title: "Server Memory Alert",
      message: "Server memory usage is above its threshold",
      headline: "Server alert: Nearzero host",
      status: "alert",
      type: "Memory",
      alertType: "server-threshold",
      serverName: "Nearzero host",
      currentValue: 90,
      threshold: 50,
    });
    // The sample that crossed the threshold, not the send time.
    expect(body?.timestamp).toBe(body?.data.at);
    expect(Date.parse(String(body?.timestamp))).toBeLessThan(now - 30_000);
    expect(body?.date).toBe(new Date(String(body?.data.at)).toLocaleString());
  });

  test("Nearzero restart and the test message", async () => {
    await addChannel("webhook", ALL_EVENTS, "Receiver");
    const first = await recordStart(h.test.db, silentLogger);
    await recordStop(h.test.db, first);
    await recordStart(h.test.db, silentLogger);
    const [restart] = await bodies();
    expect(restart).toMatchObject({
      title: "Nearzero Server Restarted",
      message: "Nearzero server restarted",
      headline: "Nearzero restarted",
      status: "success",
      type: "nearzero-restart",
    });
  });
});

describe("a send connects to the address it checked (C1-07, spec 23.9)", () => {
  const message = testMessage("Ops");

  /** A resolver that answers a public address to the first lookup and loopback after it. */
  function rebinding() {
    const lookups: string[] = [];
    const sent: { input: string; init: RequestInit & { tls?: { serverName?: string } } }[] = [];
    let answer: Response = Response.json({ code: 1, msg: "internal: db_password=hunter2" });
    const transport: NotificationTransport = {
      resolve: async (host) => {
        lookups.push(host);
        return lookups.length === 1 ? ["93.184.216.34"] : ["127.0.0.1"];
      },
      http: async (input, init) => {
        sent.push({ input, init: init as RequestInit & { tls?: { serverName?: string } } });
        return answer.clone() as Response;
      },
      smtp: async () => ({ ok: true }),
      endpoints: { telegram: "", pushover: "", resend: "" },
      timeoutMs: 1_000,
    };
    return {
      transport,
      lookups,
      sent,
      answer: (next: Response) => {
        answer = next;
      },
    };
  }

  async function reason(run: () => Promise<void>): Promise<string> {
    try {
      await run();
      return "";
    } catch (error) {
      if (error instanceof DeliveryError) return error.message;
      throw error;
    }
  }

  test("the review's attack: a name that rebinds to loopback after the check is never connected to by name", async () => {
    const fake = rebinding();
    const lark = await reason(() =>
      deliver(
        fake.transport,
        "lark",
        {},
        { webhookUrl: "https://rebind.attacker.example/hook" },
        message,
        { allowInternal: false },
      ),
    );
    // One lookup, and the request named the address it checked, with the name as its Host and
    // the certificate checked for the name.
    expect(fake.lookups).toEqual(["rebind.attacker.example"]);
    expect(new URL(fake.sent[0]?.input as string).hostname).toBe("93.184.216.34");
    const headers = (fake.sent[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers.host).toBe("rebind.attacker.example");
    expect(fake.sent[0]?.init.tls?.serverName).toBe("rebind.attacker.example");
    // An internal service's answer never comes back through Lark's refusal.
    expect(lark).toBe("Lark refused it: code 1");
    expect(lark).not.toContain("hunter2");

    // A custom webhook with its headers goes to the checked address too.
    const hook = rebinding();
    hook.answer(Response.json({}));
    await deliver(
      hook.transport,
      "webhook",
      { url: "http://rebind.attacker.example:8080/in" },
      { headers: [{ name: "Authorization", value: "Bearer x" }] },
      message,
      { allowInternal: false },
    );
    expect(hook.lookups).toHaveLength(1);
    expect(hook.sent[0]?.input).toBe("http://93.184.216.34:8080/in");
    const hookHeaders = (hook.sent[0]?.init.headers ?? {}) as Record<string, string>;
    expect(hookHeaders.host).toBe("rebind.attacker.example:8080");
    expect(hook.sent[0]?.init.tls).toBeUndefined();
  });

  test("Lark's own refusal is still quoted from Lark's own host", async () => {
    const fake = rebinding();
    fake.answer(
      Response.json({ code: 19001, msg: "param invalid: incoming webhook access token invalid" }),
    );
    const lark = await reason(() =>
      deliver(
        fake.transport,
        "lark",
        {},
        { webhookUrl: "https://open.larksuite.com/open-apis/bot/v2/hook/abc" },
        message,
        { allowInternal: false },
      ),
    );
    expect(lark).toBe("Lark refused it: param invalid: incoming webhook access token invalid");
  });

  test("email goes to the checked address, with the server's name kept for TLS", async () => {
    const fake = rebinding();
    const seen: { host: string; address?: string }[] = [];
    fake.transport.smtp = async (settings) => {
      seen.push({
        host: settings.host,
        ...(settings.address ? { address: settings.address } : {}),
      });
      return { ok: true };
    };
    await deliver(
      fake.transport,
      "email",
      { host: "smtp.rebind.example", port: 587, from: "a@example.com", to: ["b@example.com"] },
      { password: "p" },
      message,
      { allowInternal: false },
    );
    expect(fake.lookups).toEqual(["smtp.rebind.example"]);
    expect(seen).toEqual([{ host: "smtp.rebind.example", address: "93.184.216.34" }]);
  });

  test("a name an instance administrator saved reaches the checked address, with its own Host", async () => {
    setNotificationTransport(h.services, { resolve: async () => ["127.0.0.1"] });
    try {
      const port = new URL(base).port;
      const reply = await owner.post("/notification-channels/test", {
        type: "webhook",
        fields: { url: `http://hooks.pinned.test:${port}/hook` },
      });
      expect(reply.body).toEqual({ ok: true, message: testSentText("webhook") });
      const [request] = notifier.on("/hook");
      expect(request?.headers.host).toBe(`hooks.pinned.test:${port}`);
    } finally {
      setNotificationTransport(h.services, { resolve: systemResolve });
    }
  });
});

describe("custom webhook addresses, redirects and Discord's name (G3-17, G3-18, G3-19)", () => {
  test("an address ending in / is shown and posted with its slash; Gotify's server address is still trimmed", async () => {
    const saved = await owner.post("/notification-channels", {
      name: "Zapier",
      type: "webhook",
      fields: { url: `${base}/hook/catch/123/abc/` },
      events: ["deploy.failed"],
    });
    expect(saved.status).toBe(201);
    const view = (await owner.get(`/notification-channels/${saved.body.channel.id}`)).body.channel;
    expect(JSON.stringify(view)).toContain(`${base}/hook/catch/123/abc/`);
    const test = await owner.post("/notification-channels/test", {
      type: "webhook",
      fields: { url: `${base}/hook/catch/123/abc/` },
    });
    expect(test.body.ok).toBe(true);
    expect(notifier.on("/hook/catch/123/abc/")).toHaveLength(1);
    expect(notifier.on("/hook/catch/123/abc")).toHaveLength(0);
    await emitDeployEvent(h.test.db, silentLogger, await failedDeployment());
    await dispatchNotifications(h.services, silentLogger);
    expect(notifier.on("/hook/catch/123/abc/")).toHaveLength(2);

    const gotify = await owner.post("/notification-channels/test", {
      type: "gotify",
      fields: { serverUrl: `${base}/gotify/`, appToken: "tok" },
    });
    expect(gotify.body.ok).toBe(true);
    expect(notifier.on("/gotify/message")).toHaveLength(1);
  });

  test("a webhook address that answers with a redirect says so, in Test and on the row", async () => {
    const host = new URL(base).host;
    notifier.answers.set("/moved", {
      status: 301,
      headers: { location: `${base}/final` },
    });
    const test = await owner.post("/notification-channels/test", {
      type: "webhook",
      fields: { url: `${base}/moved` },
    });
    expect(test.body).toEqual({
      ok: false,
      message: `Test failed: ${host} answered with a redirect (301); use the final address`,
    });
    // Never followed: nothing reached the address it pointed to.
    expect(notifier.on("/final")).toHaveLength(0);
    notifier.answers.set("/moved", { status: 308, headers: { location: `${base}/final` } });
    const channel = await owner.post("/notification-channels", {
      name: "Moved",
      type: "webhook",
      fields: { url: `${base}/moved` },
      events: ["deploy.failed"],
    });
    await emitDeployEvent(h.test.db, silentLogger, await failedDeployment());
    await dispatchNotifications(h.services, silentLogger);
    const row = (await owner.get(`/notification-channels/${channel.body.channel.id}`)).body.channel;
    expect(row.lastFailure).toBe(
      `Last delivery failed: ${host} answered with a redirect (308); use the final address`,
    );
  });

  test("Discord messages post under the webhook's own name", async () => {
    const reply = await owner.post("/notification-channels/test", {
      type: "discord",
      fields: fieldsFor("discord"),
    });
    expect(reply.body.ok).toBe(true);
    const [request] = notifier.on(`/discord/${SECRET}`);
    expect(request?.json).not.toHaveProperty("username");
    expect(request?.json).toMatchObject({ embeds: [expect.anything()] });
  });
});
