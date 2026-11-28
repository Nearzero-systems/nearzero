import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { healthResponseSchema, VERSION } from "@nearzero/shared";
import { $, SQL, type Subprocess } from "bun";

/**
 * M0 smoke run: builds the control plane and the console exactly as they ship, starts them in
 * production mode against a throwaway database, and checks them from outside over HTTP.
 *
 * Needs the development PostgreSQL (docker-compose.dev.yml) or NEARZERO_TEST_DATABASE_URL.
 * Logs go to e2e/.work/<run>/, which is never copied into images.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const ADMIN_URL =
  process.env.NEARZERO_TEST_DATABASE_URL ??
  "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";
const RUN_ID = `smoke-${Date.now().toString(36)}`;
const WORK_DIR = join(ROOT, "e2e", ".work", RUN_ID);
const DATABASE_NAME = `nearzero_e2e_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

const admin = new SQL(ADMIN_URL);
const children: Subprocess[] = [];

function databaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${DATABASE_NAME}`;
  return url.toString();
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("No free port was found.");
  return port;
}

function start(name: string, command: string[], env: Record<string, string>): Subprocess {
  const child = Bun.spawn(command, {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdout: Bun.file(join(WORK_DIR, `${name}.out.log`)),
    stderr: Bun.file(join(WORK_DIR, `${name}.err.log`)),
  });
  children.push(child);
  return child;
}

async function waitForHealth(url: string, timeoutMs = 20_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error;
    }
    await Bun.sleep(200);
  }
  throw new Error(`${url} did not become healthy in ${timeoutMs}ms (last: ${String(last)})`);
}

beforeAll(async () => {
  await mkdir(WORK_DIR, { recursive: true });
  // The harness builds what it tests; it never runs a stale build.
  await $`bun run --cwd apps/control build`.cwd(ROOT).quiet();
  await $`bun run --cwd apps/console build`.cwd(ROOT).quiet();
  await admin.unsafe(`create database "${DATABASE_NAME}"`);
}, 120_000);

afterAll(async () => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  await Promise.all(children.map((child) => child.exited));
  await admin.unsafe(`drop database if exists "${DATABASE_NAME}" with (force)`);
  await admin.close();
});

describe("the built control plane in production mode", () => {
  test("refuses to start without a generated secret and says how to fix it", async () => {
    const child = Bun.spawn(["bun", "apps/control/dist/main.js"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        NEARZERO_ENV: "production",
        DATABASE_URL: databaseUrl(),
        NEARZERO_CONTROL_PORT: String(freePort()),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toContain("Nearzero did not start because of its settings");
    expect(stderr).toContain("NEARZERO_AUTH_SECRET is not set");
    expect(stderr).toContain("openssl rand -hex 32");
  });

  test("migrates, serves health with its version, proxies through the console, and stops cleanly", async () => {
    const controlPort = freePort();
    const consolePort = freePort();
    const control = start("control", ["bun", "apps/control/dist/main.js"], {
      NEARZERO_ENV: "production",
      NEARZERO_AUTH_SECRET: randomHex(32),
      DATABASE_URL: databaseUrl(),
      NEARZERO_CONTROL_PORT: String(controlPort),
      NEARZERO_MANAGEMENT_BIND_ADDRESS: "127.0.0.1",
    });
    const consoleProcess = start("console", ["bun", "apps/console/dist/server/entry.mjs"], {
      NEARZERO_CONTROL_URL: `http://127.0.0.1:${controlPort}`,
      HOST: "127.0.0.1",
      PORT: String(consolePort),
    });

    const direct = await waitForHealth(`http://127.0.0.1:${controlPort}/api/v1/health`);
    expect(healthResponseSchema.parse(await direct.json())).toEqual({
      status: "ok",
      version: VERSION,
      checks: { database: "ok" },
    });
    expect(direct.headers.get("x-request-id")).toMatch(/^req_/);

    const proxied = await waitForHealth(`http://127.0.0.1:${consolePort}/api/v1/health`);
    expect(healthResponseSchema.parse(await proxied.json()).version).toBe(VERSION);

    // The root sends someone signed out to sign-in (spec 04 4.1), and sign-in shows the line
    // for an install without an owner, which it learns from the control plane.
    const root = await fetch(`http://127.0.0.1:${consolePort}/`, { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location") ?? "").toMatch(/\/sign-in$/);
    const signIn = await fetch(`http://127.0.0.1:${consolePort}/sign-in`);
    expect(signIn.status).toBe(200);
    expect(await signIn.text()).toContain("No admin account yet");

    const db = new SQL(databaseUrl());
    try {
      const applied = await db`select name from applied_migration order by version`;
      expect(applied.map((row: { name: string }) => row.name)).toContain("0001_job_queue");
    } finally {
      await db.close();
    }

    control.kill("SIGTERM");
    expect(await control.exited).toBe(0);
    consoleProcess.kill("SIGTERM");
    await consoleProcess.exited;

    const log = await Bun.file(join(WORK_DIR, "control.out.log")).text();
    const lines = log
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(
      lines.every((line) => typeof line.time === "string" && typeof line.level === "string"),
    ).toBe(true);
    expect(lines.some((line) => line.msg === "stopped")).toBe(true);
    expect(log).not.toContain("NEARZERO_AUTH_SECRET=");
  }, 60_000);
});
