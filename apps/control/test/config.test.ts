import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const DATABASE_URL = "postgres://nearzero:pw@127.0.0.1:5432/nearzero";

describe("loading the control plane's settings", () => {
  test("outside production, a missing secret becomes a random one for this process only", () => {
    const first = loadConfig({ DATABASE_URL, NEARZERO_ENV: "development" });
    const second = loadConfig({ DATABASE_URL, NEARZERO_ENV: "development" });
    if (!first.ok || !second.ok) throw new Error("expected development settings to load");
    expect(first.config.authSecretIsTemporary).toBe(true);
    expect(first.config.authSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(first.config.authSecret).not.toBe(second.config.authSecret);
  });

  test("a configured secret is used as is", () => {
    const secret = "9e2b7c41d0f8a3e6b5c4d2a1f0e9d8c7b6a5f4e3d2c1b0a9";
    const result = loadConfig({ DATABASE_URL, NEARZERO_AUTH_SECRET: secret });
    if (!result.ok) throw new Error(result.problems.join("\n"));
    expect(result.config.authSecret).toBe(secret);
    expect(result.config.authSecretIsTemporary).toBe(false);
    expect(result.config.mode).toBe("production");
  });

  test("production without a secret is refused, never given a temporary one", () => {
    const result = loadConfig({ DATABASE_URL, NEARZERO_ENV: "production" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems[0]).toContain("NEARZERO_AUTH_SECRET is not set");
  });
});
