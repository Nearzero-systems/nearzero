import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { copyFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { migrate } from "../src/db/migrate.ts";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "./support/database.ts";

/**
 * Migration 0820 (spec 12.4, spec 30 "Host tasks belong to their creator", R3-29): host tasks
 * that exist before it get their maker as their owner, or the install's owner when the maker's
 * account is already gone; from then on every host task has an owner and goes with its account.
 */

setDefaultTimeout(120_000);

let current: TestDatabase;
let folder = "";

beforeAll(async () => {
  current = await createTestDatabase();
  folder = await mkdtemp(join(tmpdir(), "nearzero-0820-"));
  for (const name of await readdir(MIGRATIONS_DIR)) {
    const version = Number(name.slice(0, 4));
    if (name.endsWith(".sql") && version < 820)
      await copyFile(join(MIGRATIONS_DIR, name), join(folder, name));
  }
  await migrate(current.db, { directory: folder });
});

afterAll(async () => {
  await current?.drop();
  if (folder) await rm(folder, { recursive: true, force: true });
});

async function person(email: string): Promise<string> {
  const { rows } = await sql<{
    id: string;
  }>`insert into person (email) values (${email}) returning id`.execute(current.db);
  return (rows[0] as { id: string }).id;
}

async function hostTask(name: string, createdBy: string | null): Promise<void> {
  await sql`insert into task (name, place, cron, script, created_by)
    values (${name}, 'host', '0 * * * *', 'echo', ${createdBy})`.execute(current.db);
}

describe("0820: host task owners", () => {
  test("existing host tasks get their maker, or the install's owner; new ones need an owner and go with it", async () => {
    const owner = await person("owner@example.com");
    const admin = await person("admin@example.com");
    const { rows } = await sql<{
      id: string;
    }>`insert into workspace (name, slug, created_by) values ('Acme', 'acme', ${owner}) returning id`.execute(
      current.db,
    );
    const workspace = (rows[0] as { id: string }).id;
    await sql`insert into membership (workspace_id, person_id, role) values (${workspace}, ${owner}, 'owner'), (${workspace}, ${admin}, 'admin')`.execute(
      current.db,
    );
    await sql`insert into install_state (first_workspace_id) values (${workspace})`.execute(
      current.db,
    );
    await hostTask("Admin's", admin);
    // Its maker's account was deleted before 0820 (created_by was set to null then).
    await hostTask("Orphan", null);

    await migrate(current.db, { directory: MIGRATIONS_DIR });

    const owners = await sql<{
      name: string;
      owner_id: string | null;
    }>`select name, owner_id from task order by name`.execute(current.db);
    expect(owners.rows).toEqual([
      { name: "Admin's", owner_id: admin },
      { name: "Orphan", owner_id: owner },
    ]);
    // A host task can't be without an owner any more.
    await expect(hostTask("No owner", admin)).rejects.toThrow(/task_host_owner/);
    // It is deleted with its owner's account.
    await sql`delete from membership where person_id = ${admin}`.execute(current.db);
    await sql`delete from person where id = ${admin}`.execute(current.db);
    const left = await sql<{ name: string }>`select name from task order by name`.execute(
      current.db,
    );
    expect(left.rows).toEqual([{ name: "Orphan" }]);
  });
});
