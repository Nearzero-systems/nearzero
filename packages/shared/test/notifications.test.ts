import { describe, expect, test } from "bun:test";
import {
  CHANNEL_TYPE_INFO,
  CHANNEL_TYPES,
  checkChannel,
  deleteChannelText,
  eventsText,
  maskedUrl,
  NOTIFICATION_EVENTS,
  testFailedText,
  testSentText,
} from "../src/index.ts";

/** Channel fields and their checks (spec 15.2), events in words (15.1, 15.3). */

describe("the 12 channel types", () => {
  test("each has its label and fields", () => {
    expect(CHANNEL_TYPES).toHaveLength(12);
    expect(CHANNEL_TYPES.map((type) => CHANNEL_TYPE_INFO[type].label)).toEqual([
      "Slack",
      "Telegram",
      "Discord",
      "Lark",
      "Microsoft Teams",
      "Email (SMTP)",
      "Resend",
      "Gotify",
      "ntfy",
      "Mattermost",
      "Pushover",
      "Custom webhook",
    ]);
  });
});

describe("checks in plain words", () => {
  test("required fields", () => {
    expect(checkChannel("telegram", {}).problems).toMatchObject({
      botToken: "Bot token is required.",
      chatId: "Chat ID is required.",
    });
    expect(
      checkChannel("email", { host: "smtp.example.com", from: "a@example.com" }).problems.to,
    ).toBe("To addresses is required.");
  });
  test("URLs start with http:// or https://", () => {
    expect(checkChannel("slack", { webhookUrl: "hooks.slack.com/x" }).problems.webhookUrl).toBe(
      "Webhook URL must start with http:// or https://.",
    );
    expect(
      checkChannel("gotify", { serverUrl: "ftp://x", appToken: "t" }).problems.serverUrl,
    ).toContain("http://");
  });
  test("numbers in their ranges", () => {
    expect(
      checkChannel("gotify", { serverUrl: "https://g.example.com", appToken: "t", priority: 11 })
        .problems.priority,
    ).toBe("Priority must be a number from 1 to 10.");
    expect(
      checkChannel("ntfy", { serverUrl: "https://ntfy.sh", topic: "t", priority: 0 }).problems
        .priority,
    ).toBe("Priority must be a number from 1 to 5.");
    expect(
      checkChannel("email", { host: "h", port: 70000, from: "a@b.co", to: "c@d.co" }).problems.port,
    ).toBe("Port must be a number from 1 to 65535.");
    expect(
      checkChannel("telegram", { botToken: "1:x", chatId: "-100", threadId: "abc" }).problems
        .threadId,
    ).toContain("number");
  });
  test("defaults: Gotify priority 5, ntfy 3, Pushover 0, decoration on", () => {
    expect(
      checkChannel("gotify", { serverUrl: "https://g.example.com/", appToken: "t" }).settings,
    ).toEqual({
      serverUrl: "https://g.example.com",
      priority: 5,
      decoration: true,
    });
    expect(
      checkChannel("ntfy", { serverUrl: "https://ntfy.sh", topic: "alerts" }).settings.priority,
    ).toBe(3);
    expect(checkChannel("pushover", { userKey: "u", apiToken: "a" }).settings.priority).toBe(0);
    expect(
      checkChannel("discord", {
        webhookUrl: "https://discord.com/api/webhooks/1/x",
        decoration: false,
      }).settings.decoration,
    ).toBe(false);
  });
  test("Pushover priority 2 needs Retry (at least 30) and Expire (1 to 10800)", () => {
    const missing = checkChannel("pushover", { userKey: "u", apiToken: "a", priority: 2 });
    expect(Object.keys(missing.problems).sort()).toEqual(["expire", "retry"]);
    expect(
      checkChannel("pushover", { userKey: "u", apiToken: "a", priority: 2, retry: 10, expire: 60 })
        .problems.retry,
    ).toContain("at least 30");
    expect(
      checkChannel("pushover", {
        userKey: "u",
        apiToken: "a",
        priority: 2,
        retry: 30,
        expire: 20000,
      }).problems.expire,
    ).toContain("10800");
    expect(
      checkChannel("pushover", { userKey: "u", apiToken: "a", priority: 2, retry: 30, expire: 600 })
        .problems,
    ).toEqual({});
  });
  test("email addresses: at least one, each valid", () => {
    const ok = checkChannel("resend", {
      apiKey: "re_1",
      from: "Nearzero <n@example.com>",
      to: "a@example.com, b@example.com",
    });
    expect(ok.problems).toEqual({});
    expect(ok.settings.to).toEqual(["a@example.com", "b@example.com"]);
    expect(
      checkChannel("resend", { apiKey: "re_1", from: "n@example.com", to: "a@example.com, nope" })
        .problems.to,
    ).toBe('"nope" isn\'t a valid email address.');
  });
  test("custom webhook headers are rows; secrets are kept apart from settings", () => {
    const checked = checkChannel("webhook", {
      url: "https://example.com/hook",
      headers: [
        { name: "Authorization", value: "Bearer s3cret" },
        { name: "", value: "" },
      ],
    });
    expect(checked.problems).toEqual({});
    expect(checked.settings).toEqual({ url: "https://example.com/hook" });
    expect(checked.secrets).toEqual({
      headers: [{ name: "Authorization", value: "Bearer s3cret" }],
    });
    expect(
      checkChannel("webhook", { url: "https://e.com", headers: [{ name: "bad name", value: "x" }] })
        .problems.headers,
    ).toContain("isn't a header name");
  });
  test("Telegram chat ids", () => {
    expect(checkChannel("telegram", { botToken: "1:x", chatId: "-1001234" }).problems).toEqual({});
    expect(checkChannel("telegram", { botToken: "1:x", chatId: "@mychannel" }).problems).toEqual(
      {},
    );
    expect(
      checkChannel("telegram", { botToken: "1:x", chatId: "my chat" }).problems.chatId,
    ).toContain("Chat ID must be");
  });
});

describe("secrets on edit (spec 15.2)", () => {
  const saved = {
    settings: { chatId: "-100", threadId: 5 },
    secrets: { botToken: "123:abc" },
  };
  test("blank secrets keep the saved ones", () => {
    const checked = checkChannel("telegram", { botToken: "", chatId: "-100", threadId: 7 }, saved);
    expect(checked.problems).toEqual({});
    expect(checked.secrets).toEqual({ botToken: "123:abc" });
    expect(checked.settings.threadId).toBe(7);
  });
  test("changing where it sends needs the secrets again", () => {
    const checked = checkChannel("telegram", { botToken: "", chatId: "-200" }, saved);
    expect(checked.problems.botToken).toBe(
      "Enter the bot token again when you change where this channel sends.",
    );
    expect(
      checkChannel("telegram", { botToken: "456:def", chatId: "-200" }, saved).problems,
    ).toEqual({});
  });
  test("a new provider webhook URL is itself the secret", () => {
    const slack = {
      settings: { channel: "" },
      secrets: { webhookUrl: "https://hooks.slack.com/services/A/B/C" },
    };
    expect(checkChannel("slack", { webhookUrl: "", channel: "#ops" }, slack).secrets).toEqual(
      slack.secrets,
    );
    expect(
      checkChannel("slack", { webhookUrl: "https://hooks.slack.com/services/X/Y/Z" }, slack).secrets
        .webhookUrl,
    ).toBe("https://hooks.slack.com/services/X/Y/Z");
  });
  test("a custom webhook's new URL needs its headers again", () => {
    const webhook = {
      settings: { url: "https://a.example.com" },
      secrets: { headers: [{ name: "X-Key", value: "k" }] },
    };
    expect(
      checkChannel("webhook", { url: "https://b.example.com", headers: [] }, webhook).problems
        .headers,
    ).toContain("again");
    expect(
      checkChannel("webhook", { url: "https://a.example.com", headers: [] }, webhook).secrets,
    ).toEqual(webhook.secrets);
  });
  test("masked webhook URLs show only the host", () => {
    expect(maskedUrl("https://hooks.slack.com/services/A/B/C")).toBe("https://hooks.slack.com/…");
  });
});

describe("events and words", () => {
  test("short labels, or No events", () => {
    expect(NOTIFICATION_EVENTS).toHaveLength(7);
    expect(eventsText([])).toBe("No events");
    expect(eventsText(["deploy.failed", "deploy.succeeded", "server.alert"])).toBe(
      "Deploys, Failed deploys, Server alerts",
    );
    expect(eventsText([...NOTIFICATION_EVENTS])).toBe(
      "Deploys, Failed deploys, Database backups, Volume backups, Docker cleanup, Server alerts, Nearzero restarts",
    );
  });
  test("the spec's messages", () => {
    expect(deleteChannelText("Ops")).toBe(
      "Delete Ops? It stops getting notifications. This can't be undone.",
    );
    expect(testSentText("discord")).toBe("Test sent. Check Discord for the message.");
    expect(testFailedText("Discord answered 401")).toBe("Test failed: Discord answered 401");
  });
});
