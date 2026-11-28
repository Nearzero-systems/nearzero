import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { resolve } from "node:path";
import { sql } from "kysely";
import { createDatabase, type Db } from "../src/db/database.ts";
import { MigrationError } from "../src/db/migrate.ts";
import {
  DatabaseRefusedError,
  DatabaseWaitError,
  databaseRefusal,
  isDatabaseConnectionError,
  migrateWhenReachable,
} from "../src/db/resilience.ts";
import { type Logger, silentLogger } from "../src/log.ts";
import {
  createTestDatabase,
  MIGRATIONS_DIR,
  TEST_DATABASE_URL,
  type TestDatabase,
} from "./support/database.ts";

/**
 * PostgreSQL restarting doesn't stop the control plane (spec 23.2, punch list 0a): broken
 * connections are reported and replaced instead of crashing the process, connection errors are
 * told apart from real failures, and a start waits (bounded) for the database. The restart of a
 * real server under load is e2e/control/db-restart.e2e.ts.
 */

setDefaultTimeout(120_000);

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database.drop();
});

function recordingLog(): Logger & { lines: { message: string; fields: unknown }[] } {
  const lines: { message: string; fields: unknown }[] = [];
  const log = {
    ...silentLogger,
    lines,
    warn: (message: string, fields?: unknown) => lines.push({ message, fields }),
  };
  return log as never;
}

describe("telling a lost database from a real failure", () => {
  test("PostgreSQL's shutdown and recovery codes and the network's errors count", () => {
    for (const code of ["57P01", "57P03", "08006", "ECONNREFUSED", "ECONNRESET"]) {
      expect(isDatabaseConnectionError(Object.assign(new Error("x"), { code }))).toBe(true);
    }
    expect(isDatabaseConnectionError(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isDatabaseConnectionError(new Error("the database system is in recovery mode"))).toBe(
      true,
    );
    // Wrapped, as migrations wrap them.
    const wrapped = new MigrationError("Nearzero can't prepare its database", {
      cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), {
        code: "ECONNREFUSED",
      }),
    });
    expect(isDatabaseConnectionError(wrapped)).toBe(true);
  });

  test("SQL mistakes, constraint violations and other errors don't", () => {
    expect(isDatabaseConnectionError(Object.assign(new Error("x"), { code: "23505" }))).toBe(false);
    expect(isDatabaseConnectionError(new Error('relation "nope" does not exist'))).toBe(false);
    expect(isDatabaseConnectionError(new TypeError("undefined is not a function"))).toBe(false);
    expect(isDatabaseConnectionError(null)).toBe(false);
  });
});

describe("a start waits for the database", () => {
  test("an unreachable database is waited for with growing pauses, then refused clearly", async () => {
    const db = createDatabase("postgres://nobody:nothing@127.0.0.1:9/none", {
      maxConnections: 1,
    });
    let clock = 0;
    const pauses: number[] = [];
    const log = recordingLog();
    try {
      await expect(
        migrateWhenReachable(
          db,
          { directory: MIGRATIONS_DIR },
          {
            waitMs: 30_000,
            log,
            now: () => clock,
            sleep: async (ms) => {
              pauses.push(ms);
              clock += ms;
            },
          },
        ),
      ).rejects.toThrow(
        /^its database didn't answer within 30 seconds \(.*ECONNREFUSED.*\)\. Check DATABASE_URL and that PostgreSQL is running/,
      );
    } finally {
      await db.destroy();
    }
    expect(pauses).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 5_000]);
    expect(log.lines.every((line) => line.message === "waiting for the database")).toBe(true);
    expect(log.lines).toHaveLength(6);
  });

  test("a reachable database is updated at once", async () => {
    const result = await migrateWhenReachable(
      database.db,
      { directory: MIGRATIONS_DIR },
      { waitMs: 10_000, log: silentLogger },
    );
    expect(result.applied.length).toBeGreaterThan(0);
  });

  test("a real migration problem stops the start without waiting", async () => {
    let slept = false;
    await expect(
      migrateWhenReachable(
        database.db,
        { directory: resolve(MIGRATIONS_DIR, "no-such-folder") },
        {
          waitMs: 60_000,
          log: silentLogger,
          sleep: async () => {
            slept = true;
          },
        },
      ),
    ).rejects.toBeInstanceOf(MigrationError);
    expect(slept).toBe(false);
  });

  /** Runs a start against `url` and fails if it waits even once. */
  async function startAgainst(url: string): Promise<unknown> {
    const db = createDatabase(url, { maxConnections: 1 });
    let slept = false;
    try {
      await migrateWhenReachable(
        db,
        { directory: MIGRATIONS_DIR },
        {
          waitMs: 120_000,
          log: silentLogger,
          sleep: async () => {
            slept = true;
          },
        },
      );
      return null;
    } catch (error) {
      return error;
    } finally {
      expect(slept).toBe(false);
      await db.destroy();
    }
  }

  test("a refused password stops the start at once and points to the settings (punch list 40)", async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.password = "not-the-password";
    const error = await startAgainst(url.toString());
    expect(error).toBeInstanceOf(DatabaseRefusedError);
    const message = (error as Error).message;
    expect(message).toStartWith("its database refused the password (PostgreSQL said: ");
    expect(message).toContain("password authentication failed for user");
    expect(message).toContain("NEARZERO_DATABASE_PASSWORD and DATABASE_URL in /opt/nearzero/.env");
    expect(message).not.toContain("not-the-password");
  });

  test("a missing database stops the start at once too", async () => {
    const url = new URL(TEST_DATABASE_URL);
    url.pathname = "/nz_verify_no_such_database";
    const error = await startAgainst(url.toString());
    expect(error).toBeInstanceOf(DatabaseRefusedError);
    expect((error as Error).message).toStartWith(
      'the database named in DATABASE_URL doesn\'t exist (PostgreSQL said: database "nz_verify_no_such_database" does not exist)',
    );
  });

  test("refusals are told apart from a database that doesn't answer", () => {
    const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });
    expect(
      databaseRefusal(pgError("28P01", 'password authentication failed for user "nearzero"'))?.kind,
    ).toBe("password");
    expect(databaseRefusal(pgError("28000", 'role "nearzero" does not exist'))?.kind).toBe("login");
    expect(databaseRefusal(pgError("3D000", 'database "nearzero" does not exist'))?.kind).toBe(
      "database",
    );
    // No password at all in DATABASE_URL: the driver refuses before PostgreSQL does.
    expect(
      databaseRefusal(
        new Error("SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string"),
      )?.kind,
    ).toBe("password");
    expect(
      databaseRefusal(new Error("x", { cause: pgError("28P01", "password authentication failed") }))
        ?.kind,
    ).toBe("password");
    for (const unreachable of [
      Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }),
      pgError("57P03", "the database system is starting up"),
      new Error("timeout exceeded when trying to connect"),
      null,
    ]) {
      expect(databaseRefusal(unreachable)).toBeNull();
    }
    expect(new DatabaseRefusedError("login", 'role "x" does not exist').message).toContain(
      "Check the user in DATABASE_URL (in /opt/nearzero/.env on a Nearzero server).",
    );
  });

  test("the wait error names the setting", () => {
    expect(new DatabaseWaitError(120, "no answer").message).toContain(
      "NEARZERO_DATABASE_WAIT_SECONDS",
    );
  });
});

describe("connections the server drops", () => {
  async function terminate(admin: Db, pid: number) {
    await sql`select pg_terminate_backend(${pid})`.execute(admin);
  }

  test("idle and in-use connections that break are reported, not fatal, and replaced", async () => {
    const errors: Error[] = [];
    const db = createDatabase(database.url, {
      maxConnections: 2,
      applicationName: "nearzero-resilience-test",
      onConnectionError: (error) => errors.push(error),
    });
    try {
      // An idle connection in the pool.
      const idle = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
      await terminate(database.db, idle.rows[0]?.pid as number);
      // The pool notices on its own and drops it.
      await Bun.sleep(300);
      // One in use, between two queries (as in a transaction waiting on something else).
      await db.connection().execute(async (connection) => {
        const busy = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(connection);
        await terminate(database.db, busy.rows[0]?.pid as number);
        await Bun.sleep(300);
        await expect(sql`select 1`.execute(connection)).rejects.toThrow();
      });
      await Bun.sleep(300);
      expect(errors.length).toBeGreaterThanOrEqual(2);
      expect(errors.every((error) => isDatabaseConnectionError(error))).toBe(true);
      // New connections take their place.
      const again = await sql<{ one: number }>`select 1 as one`.execute(db);
      expect(again.rows[0]?.one).toBe(1);
    } finally {
      await db.destroy();
    }
  });
});
