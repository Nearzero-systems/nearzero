import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { MigrationError, migrate, readMigrations } from "../src/db/migrate.ts";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "./support/database.ts";

// Throwaway databases can take seconds to create and migrate on a busy machine.
setDefaultTimeout(120_000);

const folders: string[] = [];

async function migrationFolder(files: Record<string, string>): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "nearzero-migrations-"));
  folders.push(folder);
  for (const [name, text] of Object.entries(files)) await writeFile(join(folder, name), text);
  return folder;
}

async function tableExists(test: TestDatabase, table: string): Promise<boolean> {
  const { rows } = await sql<{
    found: string | null;
  }>`select to_regclass(${table})::text as found`.execute(test.db);
  return rows[0]?.found != null;
}

async function appliedVersions(test: TestDatabase): Promise<number[]> {
  const rows = await test.db
    .selectFrom("applied_migration")
    .select("version")
    .orderBy("version")
    .execute();
  return rows.map((row) => row.version);
}

async function expectMigrationError(run: Promise<unknown>): Promise<MigrationError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationError);
    return error as MigrationError;
  }
  throw new Error("expected a MigrationError");
}

let current: TestDatabase;

beforeAll(async () => {
  current = await createTestDatabase();
});

afterAll(async () => {
  await current.drop();
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("the shipped migrations", () => {
  test("apply to an empty database and record each file with its checksum", async () => {
    const result = await migrate(current.db, { directory: MIGRATIONS_DIR });
    // Every file in the folder, in order; later milestones add theirs after these.
    const shipped = (await readdir(MIGRATIONS_DIR))
      .filter((name) => name.endsWith(".sql"))
      .map((name) => name.slice(0, -4))
      .sort();
    expect(result.applied).toEqual(shipped);
    expect(shipped.slice(0, 4)).toEqual([
      "0001_job_queue",
      "0002_people_and_sessions",
      "0003_workspaces_and_access",
      "0004_audit_events",
    ]);
    expect(await tableExists(current, "job")).toBe(true);
    expect(await tableExists(current, "person")).toBe(true);
    expect(await tableExists(current, "audit_event")).toBe(true);

    const rows = await current.db
      .selectFrom("applied_migration")
      .selectAll()
      .orderBy("version")
      .execute();
    expect(rows).toHaveLength(shipped.length);
    expect(rows[0]?.name).toBe("0001_job_queue");
    for (const row of rows) expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a second run applies nothing", async () => {
    const result = await migrate(current.db, { directory: MIGRATIONS_DIR });
    expect(result.applied).toEqual([]);
  });
});

describe("the migration runner", () => {
  let scratch: TestDatabase;

  beforeAll(async () => {
    scratch = await createTestDatabase();
  });

  afterAll(async () => {
    await scratch.drop();
  });

  afterEach(async () => {
    await sql`drop schema public cascade; create schema public`.execute(scratch.db);
  });

  test("applies files by number, not by how the folder lists them", async () => {
    const folder = await migrationFolder({
      "0010_second.sql": "alter table widget add column colour text;",
      "0002_first.sql": "create table widget (id integer primary key);",
    });
    const result = await migrate(scratch.db, { directory: folder });
    expect(result.applied).toEqual(["0002_first", "0010_second"]);
    expect(await appliedVersions(scratch)).toEqual([2, 10]);
  });

  test("runs a file with several statements as one unit", async () => {
    const folder = await migrationFolder({
      "0001_many.sql": `
        create table a (id integer primary key);
        create table b (id integer primary key, a_id integer references a (id));
        insert into a values (1);
      `,
    });
    await migrate(scratch.db, { directory: folder });
    expect(await tableExists(scratch, "a")).toBe(true);
    expect(await tableExists(scratch, "b")).toBe(true);
  });

  test("a failing file is rolled back, not recorded, and named in a clear message", async () => {
    const folder = await migrationFolder({
      "0001_good.sql": "create table good (id integer primary key);",
      "0002_bad.sql": "create table half_done (id integer); select * from no_such_table;",
      "0003_later.sql": "create table later (id integer);",
    });
    const error = await expectMigrationError(migrate(scratch.db, { directory: folder }));
    expect(error.message).toContain("0002_bad.sql failed");
    expect(error.message).toContain("rolled back and changed nothing");
    expect(error.message).toContain("no_such_table");
    expect(error.message).toContain("start Nearzero again");

    expect(await appliedVersions(scratch)).toEqual([1]);
    expect(await tableExists(scratch, "good")).toBe(true);
    expect(await tableExists(scratch, "half_done")).toBe(false);
    expect(await tableExists(scratch, "later")).toBe(false);
  });

  test("refuses to start when an applied file was changed", async () => {
    const folder = await migrationFolder({ "0001_first.sql": "create table t (id integer);" });
    await migrate(scratch.db, { directory: folder });
    await writeFile(join(folder, "0001_first.sql"), "create table t (id bigint);");
    const error = await expectMigrationError(migrate(scratch.db, { directory: folder }));
    expect(error.message).toContain("0001_first.sql changed after it was applied");
    expect(error.message).toContain("new numbered migration");
  });

  test("refuses a database migrated by a newer version", async () => {
    const newer = await migrationFolder({
      "0001_first.sql": "create table t (id integer);",
      "0002_newer.sql": "create table u (id integer);",
    });
    await migrate(scratch.db, { directory: newer });
    const older = await migrationFolder({ "0001_first.sql": "create table t (id integer);" });
    const error = await expectMigrationError(migrate(scratch.db, { directory: older }));
    expect(error.message).toContain("updated by a newer version of Nearzero");
    expect(error.message).toContain("0002_newer");
  });

  test("rejects badly named and duplicate-numbered files before touching the database", async () => {
    const badName = await migrationFolder({ "1_first.sql": "select 1;" });
    expect((await expectMigrationError(readMigrations(badName))).message).toContain(
      "is not named like 0002_add_projects.sql",
    );

    const duplicate = await migrationFolder({
      "0001_one.sql": "select 1;",
      "0001_other.sql": "select 1;",
    });
    expect((await expectMigrationError(readMigrations(duplicate))).message).toContain(
      "share the number 0001",
    );
  });

  test("processes starting together apply each file exactly once", async () => {
    const folder = await migrationFolder({
      "0001_a.sql": "create table counter (n integer); insert into counter values (1);",
      "0002_b.sql": "update counter set n = n + 1;",
      "0003_c.sql": "update counter set n = n + 1;",
    });
    const runs = await Promise.all(
      Array.from({ length: 4 }, () => migrate(scratch.db, { directory: folder })),
    );
    const appliedTotal = runs.flatMap((run) => run.applied).sort();
    expect(appliedTotal).toEqual(["0001_a", "0002_b", "0003_c"]);
    const { rows } = await sql<{ n: number }>`select n from counter`.execute(scratch.db);
    expect(rows[0]?.n).toBe(3);
  });
});
