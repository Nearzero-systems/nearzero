import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { type AppEnv, loggedPath, requestContext } from "../src/http/context.ts";
import { createLogger } from "../src/log.ts";

function capture(level: "debug" | "info" | "warn" | "error" = "debug") {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ level, write: (line) => lines.push(JSON.parse(line)) });
  return { log, lines };
}

describe("structured logs", () => {
  test("writes one JSON object per line with time, level and message", () => {
    const { log, lines } = capture();
    log.info("listening", { port: 4100 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "listening", port: 4100 });
    expect(typeof lines[0]?.time).toBe("string");
  });

  test("drops lines below the configured level", () => {
    const { log, lines } = capture("warn");
    log.debug("noise");
    log.info("noise");
    log.warn("kept");
    log.error("kept");
    expect(lines.map((line) => line.level)).toEqual(["warn", "error"]);
  });

  test("child loggers add their fields to every line", () => {
    const { log, lines } = capture();
    log.child({ requestId: "req_abc" }).child({ jobId: 7 }).info("step");
    expect(lines[0]).toMatchObject({ requestId: "req_abc", jobId: 7, msg: "step" });
  });

  test("fields that look like secrets are redacted, however deep", () => {
    const { log, lines } = capture();
    log.info("saved", {
      password: "hunter2",
      server: { sshPrivateKey: "-----BEGIN KEY-----", name: "web-1" },
      headers: { Authorization: "Bearer abc", cookie: "session=1" },
      list: [{ apiKey: "sk-123" }],
      authSecret: "f00",
    });
    const text = JSON.stringify(lines[0]);
    for (const secret of ["hunter2", "BEGIN KEY", "Bearer abc", "session=1", "sk-123", "f00"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("web-1");
  });

  test("errors keep their name, message and stack", () => {
    const { log, lines } = capture();
    log.error("failed", { error: new TypeError("bad input", { cause: new Error("root") }) });
    const error = lines[0]?.error as Record<string, unknown>;
    expect(error.name).toBe("TypeError");
    expect(error.message).toBe("bad input");
    expect(String(error.stack)).toContain("TypeError");
    expect((error.cause as Record<string, unknown>).message).toBe("root");
  });
});

describe("webhook secrets in the access log (31d G4-11)", () => {
  const ID = "0b8f5e2a-4c1d-4e7f-9a3b-2d6c8e1f0a4b";
  const SECRET = "s3cretPartOfTheToken_abcdefghij";

  test("a deploy webhook's address is logged with its secret replaced", () => {
    expect(loggedPath(`/api/v1/webhooks/deploy/nzw1.${ID}.${SECRET}`)).toBe(
      `/api/v1/webhooks/deploy/nzw1.${ID}.[redacted]`,
    );
    // A moved 0.1.x token answered at 1.0's address, and a 0.1.x address a move kept.
    expect(loggedPath("/api/v1/webhooks/deploy/old-0.1.x-token-value-123")).toBe(
      "/api/v1/webhooks/deploy/[redacted]",
    );
    expect(loggedPath("/api/v1/webhooks/legacy/api/deploy/old-0.1.x-token-value-123")).toBe(
      "/api/v1/webhooks/legacy/api/deploy/[redacted]",
    );
    expect(loggedPath("/api/v1/webhooks/legacy/api/deploy/github")).toBe(
      "/api/v1/webhooks/legacy/api/deploy/github",
    );
    expect(loggedPath("/api/v1/services/abc/deployments")).toBe("/api/v1/services/abc/deployments");
  });

  test("no line a webhook call writes holds the secret", async () => {
    const { log, lines } = capture();
    const app = new Hono<AppEnv>();
    app.use("*", requestContext(log));
    app.all("*", (c) => c.json({ ok: true }));
    await app.request(`/api/v1/webhooks/deploy/nzw1.${ID}.${SECRET}`, { method: "POST" });
    await app.request("/api/v1/webhooks/legacy/api/deploy/old-0.1.x-token-value-123", {
      method: "GET",
    });
    expect(lines).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain(SECRET);
    expect(JSON.stringify(lines)).not.toContain("old-0.1.x-token-value-123");
    expect(lines[0]?.path).toBe(`/api/v1/webhooks/deploy/nzw1.${ID}.[redacted]`);
  });
});
