import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { AppError, apiErrorBodySchema, healthResponseSchema, VERSION } from "@nearzero/shared";
import { createApp } from "../src/app.ts";
import { createDatabase } from "../src/db/database.ts";
import { createLogger } from "../src/log.ts";
import { createTestDatabase, type TestDatabase } from "./support/database.ts";

// Throwaway databases can take seconds to create and migrate on a busy machine.
setDefaultTimeout(120_000);

let testDb: TestDatabase;
const lines: Record<string, unknown>[] = [];
const log = createLogger({ level: "debug", write: (line) => lines.push(JSON.parse(line)) });

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.drop();
});

function app() {
  const created = createApp({ db: testDb.db, log });
  created.get("/api/v1/test/known-error", () => {
    throw new AppError("conflict", "A project named web already exists. Pick another name.");
  });
  created.get("/api/v1/test/unknown-error", () => {
    throw new Error("socket hang up at 10.0.0.4 with password=hunter2");
  });
  return created;
}

describe("GET /api/v1/health", () => {
  test("reports ok and the running version", async () => {
    const response = await app().request("/api/v1/health");
    expect(response.status).toBe(200);
    const body = healthResponseSchema.parse(await response.json());
    expect(body).toEqual({ status: "ok", version: VERSION, checks: { database: "ok" } });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("R4-11: 0.1.x's /api/health answers the same, for uptime monitors", async () => {
    const response = await app().request("/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      version: VERSION,
      checks: { database: "ok" },
    });
  });

  test("reports degraded, still with the version, when the database is unreachable", async () => {
    const unreachable = createDatabase("postgres://nobody:nothing@127.0.0.1:1/none");
    try {
      const response = await createApp({ db: unreachable, log }).request("/api/v1/health");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        status: "degraded",
        version: VERSION,
        checks: { database: "unreachable" },
      });
    } finally {
      await unreachable.destroy();
    }
  });
});

describe("request ids and errors", () => {
  test("every response carries a request id, and a well-formed incoming one is kept", async () => {
    const fresh = await app().request("/api/v1/health");
    expect(fresh.headers.get("x-request-id")).toMatch(/^req_[a-z2-9]{12}$/);

    const kept = await app().request("/api/v1/health", {
      headers: { "x-request-id": "console_abc123XYZ" },
    });
    expect(kept.headers.get("x-request-id")).toBe("console_abc123XYZ");

    const replaced = await app().request("/api/v1/health", {
      headers: { "x-request-id": "bad id with spaces\n" },
    });
    expect(replaced.headers.get("x-request-id")).toMatch(/^req_/);
  });

  test("an unknown endpoint gets a not_found error that says what to check", async () => {
    const response = await app().request("/api/v1/nothing-here", { method: "POST" });
    expect(response.status).toBe(404);
    const body = apiErrorBodySchema.parse(await response.json());
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("POST /api/v1/nothing-here");
    expect(body.error.reference).toBe(response.headers.get("x-request-id") ?? "missing");
  });

  test("a known error keeps its code, status and words", async () => {
    const response = await app().request("/api/v1/test/known-error");
    expect(response.status).toBe(409);
    const body = apiErrorBodySchema.parse(await response.json());
    expect(body.error).toEqual({
      code: "conflict",
      message: "A project named web already exists. Pick another name.",
      reference: response.headers.get("x-request-id") ?? "missing",
    });
  });

  test("an unexpected error hides its details and gives a reference found in the log", async () => {
    lines.length = 0;
    const response = await app().request("/api/v1/test/unknown-error");
    expect(response.status).toBe(500);
    const body = apiErrorBodySchema.parse(await response.json());
    const reference = response.headers.get("x-request-id") ?? "missing";
    expect(body.error.code).toBe("internal");
    expect(body.error.reference).toBe(reference);
    expect(body.error.message).toContain(reference);
    expect(body.error.message).not.toContain("hunter2");
    expect(body.error.message).not.toContain("10.0.0.4");

    const logged = lines.find((line) => line.msg === "unexpected error");
    expect(logged?.requestId).toBe(reference);
    const access = lines.find((line) => line.msg === "request");
    expect(access).toMatchObject({ requestId: reference, status: 500, method: "GET" });
  });

  test("the access log leaves out the query string", async () => {
    lines.length = 0;
    await app().request("/api/v1/health?token=abc123");
    const access = lines.find((line) => line.msg === "request");
    expect(access?.path).toBe("/api/v1/health");
    expect(JSON.stringify(lines)).not.toContain("abc123");
  });
});
