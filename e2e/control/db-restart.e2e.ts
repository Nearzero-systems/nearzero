import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $, SQL, type Subprocess } from "bun";

/**
 * The control plane outlives PostgreSQL restarting (spec 23.2, punch list 0a): it waits for the
 * database at start, keeps running while the database restarts or crashes under load, says
 * "degraded" meanwhile, and recovers on its own, jobs included.
 *
 *   bun run --cwd e2e test:db-restart
 *
 * It runs the control plane from source against a PostgreSQL container of its own (named by
 * NZ1_E2E_DB_CONTAINER, nz1-e2e-db-restart by default, on a random local port), never the
 * development database. Logs go to e2e/.work/.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `db-restart-${Date.now().toString(36)}`);
const CONTAINER = process.env.NZ1_E2E_DB_CONTAINER ?? "nz1-e2e-db-restart";
const POSTGRES_IMAGE = "postgres:18.1-alpine";
const PASSWORD = "nz1-restart-password";
const PRUNE = "maintenance.prune-finished-jobs";

let control: Subprocess | null = null;
let apiPort = 0;
let dbPort = 0;

function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error("No free port was found.");
  return port;
}

function databaseUrl(): string {
  return `postgres://postgres:${PASSWORD}@127.0.0.1:${dbPort}/postgres`;
}

async function health(): Promise<{ status: number; body: { status?: string } | null }> {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/api/v1/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return { status: response.status, body: (await response.json().catch(() => null)) as never };
  } catch {
    return { status: 0, body: null };
  }
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await Bun.sleep(250);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** A fresh client each time: the old one may have lost its connection in the restart. */
async function query<T>(text: string): Promise<T[]> {
  const client = new SQL(databaseUrl());
  try {
    return (await client.unsafe(text)) as T[];
  } finally {
    await client.close().catch(() => {});
  }
}

async function controlLog(): Promise<string> {
  const out = await Bun.file(join(WORK, "control.out.log"))
    .text()
    .catch(() => "");
  const err = await Bun.file(join(WORK, "control.err.log"))
    .text()
    .catch(() => "");
  return out + err;
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  await $`docker rm -fv ${CONTAINER}`.quiet().nothrow();
  // A fixed local port, so the database is at the same address after every restart. Created,
  // not started: the control plane starts first and has to wait for it.
  dbPort = freePort();
  apiPort = freePort();
  await $`docker create --name ${CONTAINER} --label nz1-e2e=true -e POSTGRES_PASSWORD=${PASSWORD} -p 127.0.0.1:${dbPort}:5432 ${POSTGRES_IMAGE}`.quiet();
}, 120_000);

afterAll(async () => {
  control?.kill();
  await control?.exited;
  await $`docker rm -fv ${CONTAINER}`.quiet().nothrow();
}, 60_000);

describe("PostgreSQL restarting (spec 23.2)", () => {
  test("a start waits for the database to answer, then updates it", async () => {
    control = Bun.spawn(["bun", "apps/control/src/main.ts"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        NEARZERO_ENV: "production",
        DATABASE_URL: databaseUrl(),
        NEARZERO_AUTH_SECRET: new Bun.CryptoHasher("sha256")
          .update(crypto.randomUUID())
          .digest("hex"),
        NEARZERO_CONTROL_PORT: String(apiPort),
        NEARZERO_MANAGEMENT_BIND_ADDRESS: "127.0.0.1",
        NEARZERO_DATABASE_WAIT_SECONDS: "120",
        NEARZERO_JOB_POLL_INTERVAL_MS: "200",
      },
      stdout: Bun.file(join(WORK, "control.out.log")),
      stderr: Bun.file(join(WORK, "control.err.log")),
    });
    await waitFor(
      "the control plane to wait for its database",
      async () => {
        if (control?.exitCode !== null) throw new Error(`It stopped:\n${await controlLog()}`);
        return (await controlLog()).includes("waiting for the database");
      },
      60_000,
    );
    expect(control.exitCode).toBeNull();
    await $`docker start ${CONTAINER}`.quiet();
    await waitFor(
      "the control plane to be healthy",
      async () => (await health()).status === 200,
      120_000,
    );
    expect(await controlLog()).toContain("database is up to date");
  }, 240_000);

  test("a restart and a crash under load: it keeps running, says degraded, and recovers", async () => {
    const seen = new Set<string>();
    let loading = true;
    // Load: health checks and job inserts as fast as they go, whatever the database does.
    const load = (async () => {
      while (loading) {
        const reply = await health();
        seen.add(reply.status === 200 ? "ok" : (reply.body?.status ?? `http-${reply.status}`));
        await query(
          `insert into job (kind, payload) values ('${PRUNE}', '{"olderThanDays": 7}')`,
        ).catch(() => {});
        await Bun.sleep(25);
      }
    })();
    const alive = () => control?.exitCode === null;
    try {
      for (const how of ["restart", "crash"] as const) {
        await Bun.sleep(2_000);
        if (how === "restart") await $`docker restart -t 5 ${CONTAINER}`.quiet();
        else {
          // A crash: no shutdown, so PostgreSQL recovers from its log when it starts again.
          await $`docker kill -s KILL ${CONTAINER}`.quiet();
          await Bun.sleep(3_000);
          expect(alive()).toBe(true);
          await $`docker start ${CONTAINER}`.quiet();
        }
        expect(alive()).toBe(true);
        await waitFor(
          `the control plane to recover after the ${how}`,
          async () => (await health()).status === 200,
          120_000,
        );
        expect(alive()).toBe(true);
      }
    } finally {
      loading = false;
      await load;
    }
    expect(alive()).toBe(true);
    // Meanwhile the health endpoint said so.
    expect(seen.has("ok")).toBe(true);
    expect(seen.has("degraded")).toBe(true);
    // Jobs resume: everything queued before, during and after the outages runs.
    await query(`insert into job (kind, payload) values ('${PRUNE}', '{"olderThanDays": 7}')`);
    await waitFor(
      "every job to finish",
      async () => {
        const rows = await query<{ open: string | number }>(
          `select count(*) as open from job where kind = '${PRUNE}' and state in ('queued', 'running')`,
        ).catch(() => [{ open: 1 }]);
        return Number(rows[0]?.open) === 0;
      },
      120_000,
    );
    const failed = await query<{ count: string | number }>(
      `select count(*) as count from job where kind = '${PRUNE}' and state = 'failed'`,
    );
    expect(Number(failed[0]?.count)).toBe(0);
    // The outages were noticed and lived through, not hidden.
    expect(await controlLog()).toMatch(
      /lost a database connection|can't reach the database|lost the database/,
    );
    expect(alive()).toBe(true);
  }, 600_000);
});
