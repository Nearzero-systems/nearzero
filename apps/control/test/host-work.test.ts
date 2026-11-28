import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { hostWork, runCommand } from "../src/cli/commands.ts";
import { createHarness, fakeIo, type Harness } from "./support/harness.ts";

/**
 * C2-10: the installer asks, before it replaces the host's runner on an upgrade, what long work
 * runs on the host (task runs, backups, restores), and waits for it.
 */

setDefaultTimeout(120_000);

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h.drop();
});

describe("long work on the Nearzero host (C2-10)", () => {
  test("running host task runs, backups and restores are counted; finished ones aren't", async () => {
    expect(await hostWork(h.services)).toEqual({ taskRuns: 0, backups: 0, restores: 0 });
    const person = await h.test.db
      .insertInto("person")
      .values({ email: "admin@example.com" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const task = await h.test.db
      .insertInto("task")
      .values({
        name: "nightly",
        place: "host",
        cron: "0 3 * * *",
        script: "echo hi",
        shell: "bash",
        time_zone: "UTC",
        owner_id: person.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await h.test.db
      .insertInto("task_run")
      .values([
        { task_id: task.id, trigger: "manual", status: "running" },
        { task_id: task.id, trigger: "manual", status: "succeeded" },
      ])
      .execute();
    const workspace = await h.test.db
      .insertInto("workspace")
      .values({ name: "Acme", slug: "acme-host-work" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const run = (operation: "backup" | "restore", status: "running" | "succeeded") => ({
      workspace_id: workspace.id,
      operation,
      kind: "database" as const,
      service_kind: "postgres",
      service_name: "db",
      app_name: "db",
      project_name: "p",
      environment_name: "production",
      destination_name: "s3",
      status,
      trigger: "manual" as const,
    });
    await h.test.db
      .insertInto("backup_run")
      .values([run("backup", "running"), run("restore", "running"), run("backup", "succeeded")])
      .execute();
    expect(await hostWork(h.services)).toEqual({ taskRuns: 1, backups: 1, restores: 1 });
    const io = fakeIo([]);
    expect(await runCommand(["host-work", "--json"], h.services, io)).toBe(0);
    expect(JSON.parse(io.output.at(-1) ?? "")).toEqual({ taskRuns: 1, backups: 1, restores: 1 });
  });
});
