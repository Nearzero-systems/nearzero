import { resolve } from "node:path";
import { sql } from "kysely";
import { createDatabase, type Db } from "../../src/db/database.ts";

/**
 * Tests run against a real PostgreSQL: the development one from docker-compose.dev.yml, or the
 * one in NEARZERO_TEST_DATABASE_URL. Each test file gets its own throwaway database, so files
 * never see each other's rows and nothing touches the development data.
 */

export const TEST_DATABASE_URL =
  process.env.NEARZERO_TEST_DATABASE_URL ??
  "postgres://nearzero:nearzero-dev@127.0.0.1:55440/nearzero";

export const MIGRATIONS_DIR = resolve(import.meta.dir, "..", "..", "migrations");

export interface TestDatabase {
  db: Db;
  url: string;
  drop(): Promise<void>;
}

function withDatabase(url: string, name: string): string {
  const next = new URL(url);
  next.pathname = `/${name}`;
  return next.toString();
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const admin = createDatabase(TEST_DATABASE_URL, {
    maxConnections: 1,
    applicationName: "nearzero-test",
  });
  const name = `nearzero_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  try {
    await sql`create database ${sql.id(name)}`.execute(admin);
  } catch (error) {
    await admin.destroy();
    throw new Error(
      "These tests need PostgreSQL. Start the development database with " +
        "`docker compose -f docker-compose.dev.yml up -d`, or set NEARZERO_TEST_DATABASE_URL. " +
        `(${(error as Error).message})`,
    );
  }
  const url = withDatabase(TEST_DATABASE_URL, name);
  const db = createDatabase(url, { maxConnections: 12, applicationName: "nearzero-test" });
  return {
    db,
    url,
    async drop() {
      await db.destroy();
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    },
  };
}
