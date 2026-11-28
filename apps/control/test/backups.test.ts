import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  BACKUP_MESSAGES,
  destinationNotPublicMessage,
  SERVICE_KIND_LABELS,
} from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { setResolver } from "../src/backups/addresses.ts";
import { startDueSchedules } from "../src/backups/scheduler.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { buildMessage } from "../src/notifications/messages.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { BackupRunner } from "./support/backup-runner.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember, giveAccess, makeProject, makeService } from "./support/projects.ts";

/**
 * Backups end to end against a fake runner that speaks the real protocol (spec 08 8.3, 15.3,
 * 17, 22.3, 23.1, 23.4, 24 G1, G2, P5): destinations and their keys, schedules in the server's
 * time zone, runs in the background with logs, keep N, the overlap rules, the one scheduler,
 * finding and restoring only a service's own backups, volume backups, and the permission rows.
 */

setDefaultTimeout(60_000);

const SECRET = "secret-KEY-do-not-show-0123456789";
const ACCESS = "AKIA-TEST-ACCESS-1234";

let h: Harness;
let runner: BackupRunner;
let worker: JobWorker;
let owner: Browser;

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects } });
  runner = await BackupRunner.connect(h.test.db, h.services.runners, null, "Asia/Kolkata");
  worker = new JobWorker({
    db: h.test.db,
    queue: new JobQueue(h.test.db, { workerId: "test-worker" }),
    definitions: createJobCatalog(h.services),
    log: silentLogger,
  });
});

afterAll(async () => {
  h.services.runners.stop();
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  await sql`truncate job, backup_run, project, notification_outbox cascade`.execute(h.test.db);
  runner.reset();
  await runner.ensureRow(h.test.db);
  owner = await setUpNamedOwner(h);
});

async function runJobs(): Promise<number> {
  let ran = 0;
  while (await worker.runOnce()) ran++;
  return ran;
}

async function addDestination(browser = owner, name = "Offsite", bucket = "acme-backups") {
  const reply = await browser.post("/backup-destinations", {
    name,
    provider: "minio",
    endpoint: "http://minio.internal:9000",
    bucket,
    region: "us-east-1",
    accessKeyId: ACCESS,
    secretAccessKey: SECRET,
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  return reply.body.destination as { id: string; name: string };
}

async function database(name = "db", kind = "postgres") {
  const { environments, projectId } = await makeProject(owner, `Shop ${name}`);
  const created = await makeService(owner, environments.development as string, { kind, name });
  const service = created.service as { id: string; appName: string; name: string };
  return { ...service, projectId, environmentId: environments.development as string };
}

async function schedule(serviceId: string, body: Record<string, unknown>, browser = owner) {
  return browser.post(`/services/${serviceId}/backup-schedules`, {
    folder: "daily",
    cron: "0 3 * * *",
    keep: null,
    ...body,
  });
}

async function runNow(scheduleId: string, browser = owner) {
  const reply = await browser.post(`/backup-schedules/${scheduleId}/run`, {});
  expect(reply.status).toBe(202);
  return reply.body as { run: { id: string; status: string }; message: string };
}

async function run(id: string) {
  return (await owner.get(`/backup-runs/${id}`)).body.run;
}

async function logOf(id: string): Promise<string> {
  return (await owner.get(`/backup-runs/${id}/log`)).body.text as string;
}

describe("destinations (spec 17.1)", () => {
  test("keys are sealed, never returned, and blank keys keep the saved ones", async () => {
    const destination = await addDestination();
    const list = await owner.get("/backup-destinations");
    expect(list.status).toBe(200);
    const text = JSON.stringify(list.body);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(ACCESS);
    expect(list.body.destinations[0].providerLabel).toBe("MinIO");
    expect(list.body.destinations[0].keys.readable).toBe(true);
    const row = await h.test.db
      .selectFrom("backup_destination")
      .select("keys_sealed")
      .executeTakeFirstOrThrow();
    expect(row.keys_sealed).not.toContain(SECRET);

    const renamed = await owner.patch(`/backup-destinations/${destination.id}`, {
      name: "Offsite 2",
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.destination.name).toBe("Offsite 2");
    const tested = await owner.post(`/backup-destinations/${destination.id}/test`, {});
    expect(tested.body).toMatchObject({
      ok: true,
      message: "Connected. Nearzero can list acme-backups.",
    });
    const sent = runner.commandsOf("backup.test").at(-1)?.params.destination as Record<
      string,
      string
    >;
    expect(sent.secretAccessKey).toBe(SECRET);
    expect(sent.accessKeyId).toBe(ACCESS);

    await owner.patch(`/backup-destinations/${destination.id}`, {
      secretAccessKey: "new-secret-value-99",
    });
    await owner.post(`/backup-destinations/${destination.id}/test`, {});
    const again = runner.commandsOf("backup.test").at(-1)?.params.destination as Record<
      string,
      string
    >;
    expect(again.secretAccessKey).toBe("new-secret-value-99");
    expect(again.accessKeyId).toBe(ACCESS);
  });

  test("Test connection before saving uses the typed values; on edit blank keys use the saved ones (17.1)", async () => {
    const typed = {
      provider: "minio",
      endpoint: "https://minio.example.com",
      bucket: "fresh-bucket",
      region: "auto",
      accessKeyId: "typed-access",
      secretAccessKey: "typed-secret",
    };
    const before = await h.test.db.selectFrom("backup_destination").select("id").execute();
    const fresh = await owner.post("/backup-destinations/test", typed);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({
      ok: true,
      message: "Connected. Nearzero can list fresh-bucket.",
    });
    expect(runner.commandsOf("backup.test").at(-1)?.params.destination).toMatchObject({
      bucket: "fresh-bucket",
      accessKeyId: "typed-access",
      secretAccessKey: "typed-secret",
    });
    // Nothing was saved.
    expect(await h.test.db.selectFrom("backup_destination").select("id").execute()).toEqual(before);
    const missing = await owner.post("/backup-destinations/test", {
      ...typed,
      secretAccessKey: "",
    });
    expect(missing.status).toBe(400);
    expect(missing.body.error.fields.secretAccessKey).toBe("Paste the secret access key.");

    const destination = await addDestination();
    const edited = await owner.post("/backup-destinations/test", {
      ...typed,
      destinationId: destination.id,
      bucket: "renamed-bucket",
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(edited.body.ok).toBe(true);
    expect(runner.commandsOf("backup.test").at(-1)?.params.destination).toMatchObject({
      bucket: "renamed-bucket",
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
    runner.testFails = true;
    const failing = await owner.post("/backup-destinations/test", typed);
    expect(failing.body).toMatchObject({
      ok: false,
      message: "Could not reach the bucket. Check the endpoint, bucket, region and keys.",
    });
    runner.testFails = false;
    const member = await addMember(h, owner, "dee@example.com");
    expect((await member.post("/backup-destinations/test", typed)).status).toBe(403);
  });

  test("a failing test says what to check; duplicate names are refused", async () => {
    const destination = await addDestination();
    runner.testFails = true;
    const tested = await owner.post(`/backup-destinations/${destination.id}/test`, {});
    expect(tested.body.ok).toBe(false);
    expect(tested.body.message).toBe(
      "Could not reach the bucket. Check the endpoint, bucket, region and keys.",
    );
    const duplicate = await owner.post("/backup-destinations", {
      name: "offsite",
      provider: "aws",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      bucket: "other",
      accessKeyId: "a",
      secretAccessKey: "b",
    });
    expect(duplicate.status).toBe(409);
  });

  test("bad fields are refused in the spec's words", async () => {
    const reply = await owner.post("/backup-destinations", {
      name: "",
      provider: "aws",
      endpoint: "ftp://nope",
      bucket: "",
      accessKeyId: "",
      secretAccessKey: "",
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error.fields.name).toBe("Enter a name for this destination.");
    expect(reply.body.error.fields.bucket).toBe("Enter the bucket's name.");
    expect(reply.body.error.fields.endpoint).toContain("https://");
  });

  test("deleting one removes the schedules that write to it; the files stay", async () => {
    const destination = await addDestination();
    const db = await database();
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id });
    expect(made.status).toBe(201);
    await runNow(made.body.schedule.id);
    await runJobs();
    const deleted = await owner.delete(`/backup-destinations/${destination.id}`);
    expect(deleted.body.schedulesRemoved).toBe(1);
    expect(deleted.body.message).toContain("Files already in the bucket stay there.");
    expect(runner.bucket("acme-backups").size).toBe(1);
    const panel = await owner.get(`/services/${db.id}/backups`);
    expect(panel.body.schedules).toEqual([]);
    expect(panel.body.notice).toEqual({
      text: "Add a destination first",
      action: "add-destination",
    });
  });

  test("keys never appear in any service's details", async () => {
    const destination = await addDestination();
    const db = await database();
    await schedule(db.id, { destinationId: destination.id });
    for (const path of [
      `/services/${db.id}`,
      `/services/${db.id}/backups`,
      `/environments/${db.environmentId}/services`,
    ]) {
      const text = JSON.stringify((await owner.get(path)).body);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ACCESS);
    }
  });
});

describe("database backups (spec 08 8.3, 17.2)", () => {
  test("a schedule reads in words, writes to <app name>/<folder>/ and follows the server's time zone", async () => {
    const destination = await addDestination();
    const db = await database();
    const made = await schedule(db.id, { destinationId: destination.id, keep: 7 });
    expect(made.status).toBe(201);
    const view = made.body.schedule;
    expect(view.scheduleText).toBe("Every day at 03:00");
    expect(view.prefix).toBe(`${db.appName}/daily/`);
    expect(view.keepText).toBe("Keeps last 7");
    expect(view.stateLabel).toBe("On");
    expect(view.lastRunText).toBe("Not run yet");
    // 03:00 in Asia/Kolkata is 21:30 UTC.
    expect(new Date(view.nextRunAt).getUTCHours()).toBe(21);
    expect(new Date(view.nextRunAt).getUTCMinutes()).toBe(30);
    const panel = await owner.get(`/services/${db.id}/backups`);
    expect(panel.body.timeZoneHint).toBe("Times are in the server's time zone (Asia/Kolkata).");
    expect(panel.body.kind).toBe("database");

    const paused = await owner.patch(`/backup-schedules/${view.id}`, {
      enabled: false,
      cron: "15 4 * * MON",
    });
    expect(paused.body.schedule.stateLabel).toBe("Paused");
    expect(paused.body.schedule.scheduleText).toBe("Every Monday at 04:15");
    expect(paused.body.schedule.nextRunAt).toBeNull();
    const bad = await owner.patch(`/backup-schedules/${view.id}`, { cron: "61 * * * *", keep: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.keep).toBe(BACKUP_MESSAGES.keepProblem);
  });

  test("Run now answers at once; the run records a log and uploads a timestamped dump", async () => {
    const destination = await addDestination();
    const db = await database();
    const container = runner.addContainer(db.id);
    runner.data.set(container, "rows: 1,2,3");
    const made = await schedule(db.id, { destinationId: destination.id });
    const started = await runNow(made.body.schedule.id);
    expect(started.run.status).toBe("queued");
    expect(started.message).toBe(BACKUP_MESSAGES.runStarted);
    await runJobs();
    const done = await run(started.run.id);
    expect(done.status).toBe("succeeded");
    expect(done.statusLabel).toBe("Succeeded");
    expect(done.file.name).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.sql\.gz$/);
    expect(done.file.key.startsWith(`${db.appName}/daily/`)).toBe(true);
    const text = await logOf(started.run.id);
    expect(text.split("\n")[0]).toBe("Initializing backup (Nearzero 1.0.0-dev)");
    expect(text).toContain("Backup finished.");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[redacted]");
    const command = runner.commandsOf("backup.database").at(-1)?.params as Record<string, unknown>;
    expect(command.kind).toBe("postgres");
    expect(command.database).toBe("postgres");
    expect(command.container).toBe(container);
    const panel = await owner.get(`/services/${db.id}/backups`);
    expect(panel.body.schedules[0].lastRunText).toBe("Succeeded");
  });

  test("with Keep 2, three runs leave exactly two files", async () => {
    const destination = await addDestination();
    const db = await database();
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id, keep: 2 });
    const bucket = runner.bucket("acme-backups");
    // Another folder of the same service and someone's own file are never pruned.
    bucket.set(`${db.appName}/weekly/2020-01-01T00-00-00.sql.gz`, {
      size: 5,
      modifiedAt: "",
      content: "",
    });
    bucket.set(`${db.appName}/daily/notes.txt`, { size: 5, modifiedAt: "", content: "" });
    for (let index = 0; index < 3; index++) {
      const started = await runNow(made.body.schedule.id);
      await runJobs();
      expect((await run(started.run.id)).status).toBe("succeeded");
      // File names carry the second; keep them apart.
      await Bun.sleep(1100);
    }
    const daily = [...bucket.keys()].filter(
      (key) => key.startsWith(`${db.appName}/daily/`) && key.endsWith(".sql.gz"),
    );
    expect(daily).toHaveLength(2);
    expect(bucket.has(`${db.appName}/weekly/2020-01-01T00-00-00.sql.gz`)).toBe(true);
    expect(bucket.has(`${db.appName}/daily/notes.txt`)).toBe(true);
  });

  test("a failed step marks the run Failed with the reason, and nothing is pruned", async () => {
    const destination = await addDestination();
    const db = await database();
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id, keep: 1 });
    const first = await runNow(made.body.schedule.id);
    await runJobs();
    expect((await run(first.run.id)).status).toBe("succeeded");
    runner.dumpFails = "Dumping the database (pg_dump) failed (exit code 1).";
    const second = await runNow(made.body.schedule.id);
    await runJobs();
    const failed = await run(second.run.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("pg_dump");
    expect(runner.commandsOf("backup.prune")).toHaveLength(0);
    expect(runner.bucket("acme-backups").size).toBe(1);
    runner.dumpFails = null;
    runner.emptyDump = true;
    const third = await runNow(made.body.schedule.id);
    await runJobs();
    const empty = await run(third.run.id);
    expect(empty.status).toBe("failed");
    expect(empty.error).toContain("nothing was uploaded");
  });

  test("a database that isn't running fails with what to do", async () => {
    const destination = await addDestination();
    const db = await database();
    const made = await schedule(db.id, { destinationId: destination.id });
    const started = await runNow(made.body.schedule.id);
    await runJobs();
    const done = await run(started.run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe(BACKUP_MESSAGES.notRunning);
    expect(runner.commandsOf("backup.database")).toHaveLength(0);
  });

  test("runs of one schedule never overlap: a new one replaces a waiting one, never a running one", async () => {
    const destination = await addDestination();
    const db = await database();
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id });
    const id = made.body.schedule.id as string;
    runner.hold();
    const first = await runNow(id);
    const working = worker.runOnce();
    await Bun.sleep(100);
    expect((await run(first.run.id)).status).toBe("running");
    const second = await owner.post(`/backup-schedules/${id}/run`, {});
    expect(second.body.message).toBe(BACKUP_MESSAGES.runQueued);
    // A request retried with its Idempotency-Key gets the run it started, not another one.
    const keyed = await owner.request(
      "POST",
      `/backup-schedules/${id}/run`,
      {},
      { "idempotency-key": "retry-key-123" },
    );
    const repeat = await owner.request(
      "POST",
      `/backup-schedules/${id}/run`,
      {},
      { "idempotency-key": "retry-key-123" },
    );
    expect(repeat.body.run.id).toBe(keyed.body.run.id);
    expect((await run(second.body.run.id)).status).toBe("cancelled");
    // A scheduled run replaces the waiting one; the running one is untouched.
    await h.test.db
      .updateTable("backup_schedule")
      .set({ next_run_at: new Date(Date.now() - 1000) })
      .where("id", "=", id)
      .execute();
    expect(await startDueSchedules(h.services)).toBe(1);
    expect((await run(keyed.body.run.id)).status).toBe("cancelled");
    expect((await run(first.run.id)).status).toBe("running");
    runner.release();
    await working;
    await runJobs();
    const runs = (await owner.get(`/services/${db.id}/backup-runs`)).body.runs as {
      status: string;
      trigger: string;
    }[];
    expect(runs.map((item) => item.status).sort()).toEqual([
      "cancelled",
      "cancelled",
      "succeeded",
      "succeeded",
    ]);
    expect(runner.commandsOf("backup.database")).toHaveLength(2);
  });

  test("the one scheduler starts a due schedule once, even when two ticks race (P5)", async () => {
    const destination = await addDestination();
    const db = await database();
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id, cron: "*/5 * * * *" });
    await h.test.db
      .updateTable("backup_schedule")
      .set({ next_run_at: new Date(Date.now() - 60_000) })
      .where("id", "=", made.body.schedule.id)
      .execute();
    const [a, b] = await Promise.all([
      startDueSchedules(h.services),
      startDueSchedules(h.services),
    ]);
    expect(a + b).toBe(1);
    const runs = await h.test.db.selectFrom("backup_run").selectAll().execute();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("schedule");
    const after = await h.test.db
      .selectFrom("backup_schedule")
      .select("next_run_at")
      .where("id", "=", made.body.schedule.id)
      .executeTakeFirstOrThrow();
    expect(new Date(after.next_run_at as Date).getTime()).toBeGreaterThan(Date.now());
    expect(await startDueSchedules(h.services)).toBe(0);
    await runJobs();
    expect(runs[0] && (await run(runs[0].id)).status).toBe("succeeded");
  });

  test("a due time that passed while the control plane was stopped is skipped, not run at start (R3-30)", async () => {
    const destination = await addDestination();
    const db = await database();
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id, cron: "*/5 * * * *" });
    // The control plane started a few seconds ago.
    const startedAt = new Date(Date.now() - 5_000);
    await h.test.db
      .updateTable("backup_schedule")
      .set({ next_run_at: new Date(startedAt.getTime() - 10 * 60_000) })
      .where("id", "=", made.body.schedule.id)
      .execute();
    // The tick at start: the missed time is skipped and the schedule waits for its next one.
    expect(await startDueSchedules(h.services, new Date(), startedAt)).toBe(0);
    expect(await h.test.db.selectFrom("backup_run").selectAll().execute()).toEqual([]);
    const after = await h.test.db
      .selectFrom("backup_schedule")
      .select("next_run_at")
      .where("id", "=", made.body.schedule.id)
      .executeTakeFirstOrThrow();
    const next = new Date(after.next_run_at as Date).getTime();
    expect(next).toBeGreaterThan(Date.now());
    expect(next).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
    // A time that comes due once it is running runs as usual.
    await h.test.db
      .updateTable("backup_schedule")
      .set({ next_run_at: new Date(Date.now() - 1000) })
      .where("id", "=", made.body.schedule.id)
      .execute();
    expect(await startDueSchedules(h.services, new Date(), startedAt)).toBe(1);
    const runs = await h.test.db.selectFrom("backup_run").selectAll().execute();
    expect(runs).toHaveLength(1);
    expect(runs[0]?.trigger).toBe("schedule");
    await runJobs();
  });

  test("each finished backup writes one notification event (15.3)", async () => {
    const destination = await addDestination();
    const db = await database();
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id });
    await runNow(made.body.schedule.id);
    await runJobs();
    const events = await h.test.db.selectFrom("notification_outbox").selectAll().execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("backup.database");
    expect(events[0]?.payload).toMatchObject({
      result: "succeeded",
      destination: "Offsite",
      service: { name: "db" },
      project: "Shop db",
      environment: "development",
      database: "postgres",
      databaseType: SERVICE_KIND_LABELS.postgres,
    });
    expect(JSON.stringify(events[0]?.payload)).not.toContain(SECRET);
    // The message names the project, environment, database type and database (R3-47).
    const message = buildMessage("backup.database", events[0]?.payload ?? {}, {
      consoleUrl: null,
      workspaceSlug: null,
    });
    expect(message.facts.map((fact) => `${fact.label}: ${fact.value}`)).toEqual([
      "Project: Shop db",
      "Environment: development",
      "Service: db",
      `Database type: ${SERVICE_KIND_LABELS.postgres}`,
      "Database: postgres",
      "Destination: Offsite",
      "Result: Succeeded",
      expect.stringMatching(/^Size: /),
      // Every message also says when it happened (R3-38).
      expect.stringMatching(/^Time: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/),
    ]);
  });
});

describe("finding and restoring (spec 08 8.3, 24 G1, G2)", () => {
  async function twoDatabases() {
    const destination = await addDestination();
    const a = await database("alpha");
    const b = await database("beta");
    const containerA = runner.addContainer(a.id);
    const containerB = runner.addContainer(b.id);
    runner.data.set(containerA, "alpha data");
    runner.data.set(containerB, "beta data");
    for (const service of [a, b]) {
      const made = await schedule(service.id, { destinationId: destination.id });
      await runNow(made.body.schedule.id);
    }
    await runJobs();
    return { destination, a, b, containerA, containerB };
  }

  test("a service lists only its own backups, on its own server", async () => {
    const { destination, a, b } = await twoDatabases();
    const listed = await owner.get(
      `/services/${a.id}/backup-files?destinationId=${destination.id}&folder=daily`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.prefix).toBe(`${a.appName}/daily/`);
    expect(listed.body.files).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(b.appName);
    const sent = runner.commandsOf("backup.files").at(-1)?.params as { prefix: string };
    expect(sent.prefix).toBe(`${a.appName}/daily/`);
  });

  test("restoring another service's file is refused before anything runs", async () => {
    const { destination, a, b } = await twoDatabases();
    const ofB = [...runner.bucket("acme-backups").keys()].find((key) => key.startsWith(b.appName));
    const refused = await owner.post(`/services/${a.id}/restores`, {
      destinationId: destination.id,
      key: ofB,
      confirm: a.name,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe("This backup belongs to another service.");
    const sneaky = await owner.post(`/services/${a.id}/restores`, {
      destinationId: destination.id,
      key: `${a.appName}/../${ofB}`,
      confirm: a.name,
    });
    expect(sneaky.status).toBe(403);
    expect(runner.commandsOf("restore.database")).toHaveLength(0);
  });

  test("a restore needs the typed name, runs in the background and puts the data back", async () => {
    const { destination, a, containerA } = await twoDatabases();
    const key = [...runner.bucket("acme-backups").keys()].find((item) =>
      item.startsWith(a.appName),
    );
    const wrong = await owner.post(`/services/${a.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "nope",
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields.confirm).toBe(`Type the service name, ${a.name}, to confirm.`);
    runner.data.set(containerA, "dropped");
    const started = await owner.post(`/services/${a.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: a.name,
    });
    expect(started.status).toBe(202);
    const twice = await owner.post(`/services/${a.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: a.name,
    });
    expect(twice.status).toBe(409);
    await runJobs();
    const done = await run(started.body.run.id);
    expect(done.statusLabel).toBe("Restored");
    expect(runner.data.get(containerA)).toBe("alpha data");
    // Restores are not backups: no notification event for them.
    const events = await h.test.db.selectFrom("notification_outbox").select("event").execute();
    expect(events).toHaveLength(2);
  });

  test("a member with access to one service can't list or see the other's backups", async () => {
    const { destination, a, b } = await twoDatabases();
    const member = await addMember(h, owner, "mia@example.com", {
      capabilities: ["backups.use-destinations"],
      scope: { serviceIds: [a.id], projectIds: [a.projectId], environmentIds: [a.environmentId] },
    });
    const mine = await member.get(
      `/services/${a.id}/backup-files?destinationId=${destination.id}&folder=daily`,
    );
    expect(mine.status).toBe(200);
    const theirs = await member.get(
      `/services/${b.id}/backup-files?destinationId=${destination.id}&folder=daily`,
    );
    expect(theirs.status).toBe(404);
    const runsOfB = await h.test.db
      .selectFrom("backup_run")
      .select("id")
      .where("service_id", "=", b.id)
      .execute();
    expect((await member.get(`/backup-runs/${runsOfB[0]?.id}`)).status).toBe(404);
  });
});

describe("volume backups (spec 17.3)", () => {
  async function appWithVolume() {
    const { environments } = await makeProject(owner, "Site");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const id = created.service.id as string;
    const appName = created.service.appName as string;
    const mounts = await owner.put(`/services/${id}/mounts`, {
      mounts: [{ type: "volume", name: "html", containerPath: "/usr/share/nginx/html" }],
    });
    expect(mounts.status).toBe(200);
    const volume = `${appName}-html`;
    const container = runner.addContainer(id, [
      { name: volume, destination: "/usr/share/nginx/html" },
    ]);
    runner.volumeData.set(volume, "index.html");
    return { id, appName, volume, container, environmentId: environments.development as string };
  }

  test("the panel says which volumes it found; an unmounted volume is refused", async () => {
    const destination = await addDestination();
    const app = await appWithVolume();
    const panel = await owner.get(`/services/${app.id}/backups`);
    expect(panel.body.kind).toBe("volume");
    const found = panel.body.volumes.volumes.find(
      (item: { name: string }) => item.name === app.volume,
    );
    expect(found.sourceLabels).toEqual(["Saved mount", "Mounted by its container"]);
    const refused = await schedule(app.id, {
      destinationId: destination.id,
      volume: "someone-elses",
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(BACKUP_MESSAGES.notMounted);
  });

  test("backs up, restores in place, and refuses a volume another service uses", async () => {
    const destination = await addDestination();
    const app = await appWithVolume();
    const made = await schedule(app.id, {
      destinationId: destination.id,
      volume: app.volume,
      stopService: true,
    });
    expect(made.status).toBe(201);
    expect(made.body.schedule.prefix).toBe(`${app.appName}/daily/`);
    const started = await runNow(made.body.schedule.id);
    await runJobs();
    expect((await run(started.run.id)).status).toBe("succeeded");
    const sent = runner.commandsOf("backup.volume").at(-1)?.params as {
      stop: string[];
      volume: string;
    };
    expect(sent.stop).toEqual([app.container]);
    expect(sent.volume).toBe(app.volume);
    const key = [...runner.bucket("acme-backups").keys()][0] as string;
    expect(key).toEndWith(".tar.gz");

    runner.volumeData.set(app.volume, "deleted");
    const restored = await owner.post(`/services/${app.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "web",
      volume: app.volume,
    });
    expect(restored.status).toBe(202);
    await runJobs();
    expect((await run(restored.body.run.id)).status).toBe("succeeded");
    expect(runner.volumeData.get(app.volume)).toBe("index.html");

    // Another service's container mounting the same volume blocks a restore.
    runner.addContainer("00000000-0000-4000-8000-000000000000", [
      { name: app.volume, destination: "/data" },
    ]);
    const shared = await owner.post(`/services/${app.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "web",
      volume: app.volume,
    });
    expect(shared.status).toBe(409);
    expect(shared.body.error.message).toBe(BACKUP_MESSAGES.sharedVolume);
  });

  test("Redis backs up its data volume", async () => {
    const destination = await addDestination();
    const redis = await database("cache", "redis");
    const panel = await owner.get(`/services/${redis.id}/backups`);
    expect(panel.body.kind).toBe("volume");
    expect(panel.body.volumes.volumes.map((item: { name: string }) => item.name)).toEqual([
      `${redis.appName}-data`,
    ]);
    runner.volumes.set(`${redis.appName}-data`, {});
    const made = await schedule(redis.id, {
      destinationId: destination.id,
      volume: `${redis.appName}-data`,
    });
    expect(made.status).toBe(201);
  });
});

describe("only a service's own volumes (B1-03, spec 17.3, 22.4, 24 G1 to G3)", () => {
  async function attack() {
    const destination = await addDestination();
    const victim = await database("victim");
    const victimVolume = `${victim.appName}-data`;
    runner.addContainer(victim.id, [{ name: victimVolume, destination: "/var/lib/postgresql" }]);
    // The control plane's own database container on the host.
    runner.addContainer("00000000-0000-4000-8000-0000000000aa", [
      { name: "nearzero-postgres-data", destination: "/var/lib/postgresql/data" },
    ]);
    const { environments } = await makeProject(owner, "Stack");
    const stackFile = `services:
  s:
    image: alpine
    volumes: ["a:/a", "b:/b", "own:/own"]
volumes:
  a: { external: true, name: ${victimVolume} }
  b: { external: true, name: nearzero-postgres-data }
  own: {}
  elsewhere: { name: someone-elses-cache }
`;
    const created = await makeService(owner, environments.development as string, {
      kind: "compose",
      name: "s",
      settings: { format: "compose", composeFile: stackFile },
    });
    const stack = created.service as { id: string; appName: string; name: string };
    runner.volumes.set(`${stack.appName}_own`, {});
    return { destination, victim, victimVolume, stack };
  }

  test("a saved Compose file can't point a backup at the control plane's database or another service's volume", async () => {
    const { destination, victimVolume, stack } = await attack();
    const panel = (await owner.get(`/services/${stack.id}/backups`)).body;
    expect(panel.volumes.volumes.map((item: { name: string }) => item.name)).toEqual([
      `${stack.appName}_own`,
    ]);
    expect(panel.volumes.excluded).toEqual(
      [
        { name: "nearzero-postgres-data", reason: BACKUP_MESSAGES.reservedVolume },
        { name: "someone-elses-cache", reason: BACKUP_MESSAGES.foreignNamedVolume },
        { name: victimVolume, reason: BACKUP_MESSAGES.externalVolume },
      ].sort((a, b) => a.name.localeCompare(b.name)),
    );
    const control = await schedule(stack.id, {
      destinationId: destination.id,
      volume: "nearzero-postgres-data",
    });
    expect(control.status).toBe(403);
    expect(control.body.error.message).toBe(BACKUP_MESSAGES.reservedVolume);
    const other = await schedule(stack.id, { destinationId: destination.id, volume: victimVolume });
    expect(other.status).toBe(403);
    expect(other.body.error.message).toBe(BACKUP_MESSAGES.externalVolume);
    const own = await schedule(stack.id, {
      destinationId: destination.id,
      volume: `${stack.appName}_own`,
    });
    expect(own.status).toBe(201);
    expect(runner.commandsOf("backup.volume")).toHaveLength(0);
  });

  test("a restore over another service's volume is refused before anything runs", async () => {
    const { destination, victim, victimVolume, stack } = await attack();
    const key = `${stack.appName}_s/daily/2026-01-01T00-00-00.tar.gz`;
    runner.bucket("acme-backups").set(key, { size: 10, modifiedAt: "2026-01-01", content: "x" });
    // The victim stopped: no container of it uses the volume while the restore is asked for.
    runner.containers.clear();
    runner.volumes.set(victimVolume, {});
    const refused = await owner.post(`/services/${stack.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "s",
      volume: victimVolume,
    });
    expect(refused.status).toBe(403);
    const control = await owner.post(`/services/${stack.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "s",
      volume: "nearzero-postgres-data",
    });
    expect(control.status).toBe(403);
    expect(control.body.error.message).toBe(BACKUP_MESSAGES.reservedVolume);
    expect(runner.commandsOf("restore.volume")).toHaveLength(0);
    expect(victim.id).toBeTruthy();
  });

  test("a stack's container mounting another service's volume doesn't make it the stack's", async () => {
    const destination = await addDestination();
    const victim = await database("victim");
    const victimVolume = `${victim.appName}-data`;
    const { environments } = await makeProject(owner, "Stack");
    const created = await makeService(owner, environments.development as string, {
      kind: "compose",
      name: "s",
      settings: { format: "compose", composeFile: "services:\n  s:\n    image: alpine\n" },
    });
    const stack = created.service as { id: string; appName: string };
    // Left from an earlier version of the file, or started by hand with the stack's labels.
    runner.addContainer(stack.id, [{ name: victimVolume, destination: "/steal" }], {
      "com.docker.compose.project": stack.appName,
      "com.docker.compose.service": "s",
    });
    const panel = (await owner.get(`/services/${stack.id}/backups`)).body;
    expect(panel.volumes.excluded).toEqual([
      { name: victimVolume, reason: BACKUP_MESSAGES.foreignVolume },
    ]);
    const refused = await schedule(stack.id, {
      destinationId: destination.id,
      volume: victimVolume,
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe(BACKUP_MESSAGES.foreignVolume);
  });

  test("a run refuses a volume another service's container also uses", async () => {
    const destination = await addDestination();
    const { environments } = await makeProject(owner, "Site");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const id = created.service.id as string;
    const appName = created.service.appName as string;
    await owner.put(`/services/${id}/mounts`, {
      mounts: [{ type: "volume", name: "html", containerPath: "/html" }],
    });
    const volume = `${appName}-html`;
    runner.addContainer(id, [{ name: volume, destination: "/html" }]);
    const made = await schedule(id, { destinationId: destination.id, volume });
    expect(made.status).toBe(201);
    runner.addContainer("00000000-0000-4000-8000-000000000001", [
      { name: volume, destination: "/x" },
    ]);
    const started = await runNow(made.body.schedule.id);
    await runJobs();
    const done = await run(started.run.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe(BACKUP_MESSAGES.sharedVolumeBackup);
    expect(runner.commandsOf("backup.volume")).toHaveLength(0);
  });
});

describe("restoring into the database a backup came from (R3-45, B1-19)", () => {
  test("a schedule of a non-default database restores into it, or into the database typed", async () => {
    const destination = await addDestination();
    const db = await database("pg");
    runner.addContainer(db.id);
    const made = await schedule(db.id, { destinationId: destination.id, database: "analytics" });
    await runNow(made.body.schedule.id);
    await runJobs();
    const dumped = runner.commandsOf("backup.database").at(-1)?.params as { database: string };
    expect(dumped.database).toBe("analytics");
    const key = [...runner.bucket("acme-backups").keys()][0] as string;
    // The listing says what each file restores into, for the confirm step to name.
    const listed = await owner.get(
      `/services/${db.id}/backup-files?destinationId=${destination.id}&folder=daily`,
    );
    expect(listed.body.files.map((file: { database: string }) => file.database)).toEqual([
      "analytics",
    ]);

    const plain = await owner.post(`/services/${db.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: db.name,
    });
    expect(plain.status).toBe(202);
    expect(plain.body.run.database).toBe("analytics");
    await runJobs();
    const sent = runner.commandsOf("restore.database").at(-1)?.params as {
      database: string;
      sourceDatabase: string;
    };
    expect(sent).toMatchObject({ database: "analytics", sourceDatabase: "analytics" });
    expect(await logOf(plain.body.run.id)).toContain("into the database analytics of pg");

    const typed = await owner.post(`/services/${db.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: db.name,
      database: "analytics_copy",
    });
    expect(typed.status).toBe(202);
    await runJobs();
    expect(runner.commandsOf("restore.database").at(-1)?.params).toMatchObject({
      database: "analytics_copy",
      sourceDatabase: "analytics",
    });
    const system = await owner.post(`/services/${db.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: db.name,
      database: "bad name;",
    });
    expect(system.status).toBe(400);
  });

  test("MongoDB: a backup of every database restores every database, not only the service's", async () => {
    const destination = await addDestination();
    const mongo = await database("docs", "mongodb");
    runner.addContainer(mongo.id);
    const made = await schedule(mongo.id, { destinationId: destination.id });
    await runNow(made.body.schedule.id);
    await runJobs();
    const key = [...runner.bucket("acme-backups").keys()][0] as string;
    // The service names a database of its own, which the restore must not narrow to.
    await h.test.db
      .updateTable("service")
      .set({ settings: sql`settings || '{"databaseName":"shop"}'::jsonb` })
      .where("id", "=", mongo.id)
      .execute();
    const restored = await owner.post(`/services/${mongo.id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: mongo.name,
    });
    expect(restored.status).toBe(202);
    await runJobs();
    expect(runner.commandsOf("restore.database").at(-1)?.params).toMatchObject({
      database: null,
      sourceDatabase: null,
    });
  });
});

describe("libSQL with namespaces (R3-51)", () => {
  test("is backed up as an archive of its data folder, every namespace in it", async () => {
    const destination = await addDestination();
    const lite = await database("lite", "libsql");
    await h.test.db
      .updateTable("service")
      .set({ settings: sql`settings || '{"namespaces":true}'::jsonb` })
      .where("id", "=", lite.id)
      .execute();
    runner.addContainer(lite.id);
    const made = await schedule(lite.id, { destinationId: destination.id });
    const started = await runNow(made.body.schedule.id);
    await runJobs();
    expect((await run(started.run.id)).status).toBe("succeeded");
    const sent = runner.commandsOf("backup.database").at(-1)?.params as {
      archive: boolean;
      dataVolume: string;
      key: string;
    };
    expect(sent).toMatchObject({ archive: true, dataVolume: `${lite.appName}-data` });
    expect(sent.key).toEndWith(".tar.gz");
    // The file lists and restores like the dumps.
    const listed = await owner.get(
      `/services/${lite.id}/backup-files?destinationId=${destination.id}&folder=daily`,
    );
    expect(listed.body.files).toHaveLength(1);
    const restored = await owner.post(`/services/${lite.id}/restores`, {
      destinationId: destination.id,
      key: sent.key,
      confirm: lite.name,
    });
    expect(restored.status).toBe(202);
    await runJobs();
    expect(runner.commandsOf("restore.database").at(-1)?.params).toMatchObject({
      dataVolume: `${lite.appName}-data`,
      database: null,
    });
  });
});

describe("0.1.x's backups after a move (R2-06, R3-44)", () => {
  const LEGACY = [
    "2026-11-20T03-00-00-123Z.sql.gz",
    "2026-11-21T03-00-00-456Z.sql.gz",
    "2026-11-22T03-00-00-789Z.sql.gz",
  ];

  async function moved(folder: string, keep: number | null) {
    const destination = await addDestination();
    const db = await database("pg");
    runner.addContainer(db.id);
    // What the import writes for a 0.1.x schedule (migration 0750).
    const row = await h.test.db
      .insertInto("backup_schedule")
      .values({
        workspace_id: (
          await h.test.db
            .selectFrom("service")
            .select("workspace_id")
            .where("id", "=", db.id)
            .executeTakeFirstOrThrow()
        ).workspace_id,
        service_id: db.id,
        destination_id: destination.id,
        kind: "database",
        folder,
        cron: "0 3 * * *",
        keep,
        legacy_files: true,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const prefix = folder === "" ? `${db.appName}/` : `${db.appName}/${folder}/`;
    for (const [index, name] of LEGACY.entries()) {
      runner.bucket("acme-backups").set(`${prefix}${name}`, {
        size: 100 + index,
        modifiedAt: `2026-11-2${index}T03:00:00Z`,
        content: `legacy ${index}`,
      });
    }
    return { destination, db, scheduleId: row.id, prefix };
  }

  test("they are listed in their folder, an empty one included, newest first, and restore", async () => {
    const { destination, db, prefix } = await moved("", null);
    // A 1.0 file of another folder and a stray object are never listed here.
    runner.bucket("acme-backups").set(`${db.appName}/daily/2026-11-23T03-00-00.sql.gz`, {
      size: 5,
      modifiedAt: "2026-11-23T03:00:00Z",
      content: "x",
    });
    runner.bucket("acme-backups").set(`${db.appName}/notes.txt`, {
      size: 5,
      modifiedAt: "2026-11-23T03:00:00Z",
      content: "x",
    });
    const listed = await owner.get(
      `/services/${db.id}/backup-files?destinationId=${destination.id}&folder=`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.prefix).toBe(prefix);
    expect(listed.body.files.map((file: { name: string }) => file.name)).toEqual(
      [...LEGACY].reverse(),
    );
    const restored = await owner.post(`/services/${db.id}/restores`, {
      destinationId: destination.id,
      key: `${prefix}${LEGACY[0]}`,
      confirm: db.name,
    });
    expect(restored.status).toBe(202);
    await runJobs();
    expect((await run(restored.body.run.id)).status).toBe("succeeded");
  });

  test("Keep N counts and prunes them with the new ones", async () => {
    const { scheduleId, prefix } = await moved("nightly", 2);
    await runNow(scheduleId);
    await runJobs();
    const left = [...runner.bucket("acme-backups").keys()].sort();
    expect(left).toHaveLength(2);
    expect(left).toContain(`${prefix}${LEGACY[2]}`);
    expect(left.some((key) => /T\d{2}-\d{2}-\d{2}\.sql\.gz$/.test(key))).toBe(true);
  });
});

describe("Keep N prunes only its own schedule's files (B1-52, spec 17.2)", () => {
  test("two destinations on the same bucket and folder never prune each other's backups", async () => {
    const hourly = await addDestination(owner, "R2 hourly", "shared-bucket");
    const daily = await addDestination(owner, "R2 daily", "shared-bucket");
    const db = await database("pg");
    runner.addContainer(db.id);
    const fast = await schedule(db.id, { destinationId: hourly.id, folder: "backups", keep: 1 });
    const slow = await schedule(db.id, { destinationId: daily.id, folder: "backups", keep: 30 });
    expect(fast.status).toBe(201);
    expect(slow.status).toBe(201);
    for (const id of [slow.body.schedule.id, slow.body.schedule.id]) {
      await runNow(id);
      await runJobs();
      await Bun.sleep(1100);
    }
    for (const id of [fast.body.schedule.id, fast.body.schedule.id]) {
      await runNow(id);
      await runJobs();
      await Bun.sleep(1100);
    }
    const runs = await h.test.db
      .selectFrom("backup_run")
      .select(["schedule_id", "file_key", "status"])
      .where("operation", "=", "backup")
      .execute();
    expect(runs.every((item) => item.status === "succeeded")).toBe(true);
    const slowFiles = runs.filter((item) => item.schedule_id === slow.body.schedule.id);
    const fastFiles = runs.filter((item) => item.schedule_id === fast.body.schedule.id);
    const bucket = runner.bucket("shared-bucket");
    for (const item of slowFiles) expect(bucket.has(item.file_key as string)).toBe(true);
    expect(fastFiles.filter((item) => bucket.has(item.file_key as string))).toHaveLength(1);
  });
});

describe("volume schedules sharing a folder (31c G3-20, C1-12)", () => {
  async function appWithVolumes() {
    const destination = await addDestination();
    const { environments } = await makeProject(owner, "Site");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const id = created.service.id as string;
    const appName = created.service.appName as string;
    await owner.put(`/services/${id}/mounts`, {
      mounts: [
        { type: "volume", name: "data", containerPath: "/data" },
        { type: "volume", name: "uploads", containerPath: "/uploads" },
      ],
    });
    runner.addContainer(id, [
      { name: `${appName}-data`, destination: "/data" },
      { name: `${appName}-uploads`, destination: "/uploads" },
    ]);
    return { destination, id, appName };
  }

  test("two volumes' schedules share a folder; each keeps and prunes only its own files", async () => {
    const { destination, id, appName } = await appWithVolumes();
    const data = await schedule(id, {
      destinationId: destination.id,
      volume: `${appName}-data`,
      folder: "nightly",
      keep: 1,
    });
    const uploads = await schedule(id, {
      destinationId: destination.id,
      volume: `${appName}-uploads`,
      folder: "nightly",
      keep: 1,
    });
    expect(data.status).toBe(201);
    expect(uploads.status).toBe(201);
    // The same volume twice in one folder is still refused, in words that say why.
    const twice = await schedule(id, {
      destinationId: destination.id,
      volume: `${appName}-data`,
      folder: "nightly",
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.message).toBe(
      "Another backup schedule of this service already backs up this volume to this folder on this destination. Pick another folder, or change that schedule.",
    );
    // Both run at the same second: their files are named after their volumes, so they never meet.
    for (let round = 0; round < 2; round++) {
      await runNow(data.body.schedule.id);
      await runNow(uploads.body.schedule.id);
      await runJobs();
      await Bun.sleep(1100);
    }
    const keys = [...runner.bucket("acme-backups").keys()].sort();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(
      new RegExp(`^${appName}/nightly/${appName}-data-\\d{4}-.*\\.tar\\.gz$`),
    );
    expect(keys[1]).toMatch(
      new RegExp(`^${appName}/nightly/${appName}-uploads-\\d{4}-.*\\.tar\\.gz$`),
    );
    // Both are listed for restoring.
    const listed = await owner.get(
      `/services/${id}/backup-files?destinationId=${destination.id}&folder=nightly`,
    );
    expect(listed.body.files).toHaveLength(2);
  });

  test("a moved volume schedule's Keep N prunes only its own volume's 0.1.x archives (C1-12)", async () => {
    const { destination, id, appName } = await appWithVolumes();
    const workspaceId = (
      await h.test.db
        .selectFrom("service")
        .select("workspace_id")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).workspace_id;
    // What the move writes for 0.1.x's two schedules in one folder, both kept (G3-20).
    const moved = async (volume: string) =>
      (
        await h.test.db
          .insertInto("backup_schedule")
          .values({
            workspace_id: workspaceId,
            service_id: id,
            destination_id: destination.id,
            kind: "volume",
            volume_name: volume,
            folder: "vols",
            cron: "0 3 * * *",
            keep: 1,
            legacy_files: true,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id;
    const dataSchedule = await moved(`${appName}-data`);
    await moved(`${appName}-uploads`);
    const prefix = `${appName}/vols/`;
    const legacy = [
      `${appName}-data-2026-11-20T03-00-00-123Z.tar`,
      `${appName}-data-2026-11-21T03-00-00-123Z.tar`,
      `${appName}-uploads-2026-11-22T03-00-00-123Z.tar`,
      `${appName}-uploads-2026-11-23T03-00-00-123Z.tar`,
    ];
    for (const name of legacy) {
      runner.bucket("acme-backups").set(`${prefix}${name}`, {
        size: 10,
        modifiedAt: "2026-11-23T03:00:00Z",
        content: name,
      });
    }
    // The report's case: the data schedule, keep 1, runs.
    await runNow(dataSchedule);
    await runJobs();
    const left = [...runner.bucket("acme-backups").keys()].map((key) => key.slice(prefix.length));
    const [oldData, newData, oldUploads, newUploads] = legacy as [string, string, string, string];
    expect(left).toContain(oldUploads);
    expect(left).toContain(newUploads);
    expect(left).not.toContain(oldData);
    expect(left).not.toContain(newData);
    expect(left.filter((name) => name.startsWith(`${appName}-data-`))).toHaveLength(1);
  });
});

describe("Nearzero's own backup helpers on a volume (C1-11)", () => {
  async function appWithVolume() {
    const destination = await addDestination();
    const second = await addDestination(owner, "Offsite two", "other-bucket");
    const { environments } = await makeProject(owner, "Site");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const id = created.service.id as string;
    const appName = created.service.appName as string;
    await owner.put(`/services/${id}/mounts`, {
      mounts: [{ type: "volume", name: "data", containerPath: "/data" }],
    });
    runner.addContainer(id, [{ name: `${appName}-data`, destination: "/data" }]);
    return { destination, second, id, appName, volume: `${appName}-data` };
  }

  test("a resumed run that finds its own helper on the volume goes on", async () => {
    const { destination, id, volume } = await appWithVolume();
    const made = await schedule(id, { destinationId: destination.id, volume, folder: "nightly" });
    const started = await runNow(made.body.schedule.id);
    // The control plane stopped while this run's helper was archiving; the job runs again.
    const helper = runner.addHelper(started.run.id, volume);
    await runJobs();
    runner.containers.delete(helper);
    const done = await run(started.run.id);
    expect(done.error).toBeNull();
    expect(done.status).toBe("succeeded");
  });

  test("a second schedule of the volume runs while the first's helper archives, and a restore waits for them", async () => {
    const { destination, second, id, volume } = await appWithVolume();
    const a = await schedule(id, { destinationId: destination.id, volume, folder: "a" });
    const b = await schedule(id, { destinationId: second.id, volume, folder: "b" });
    // A finished backup to restore later.
    await runNow(a.body.schedule.id);
    await runJobs();
    const key = [...runner.bucket("acme-backups").keys()][0] as string;
    runner.hold();
    const first = await runNow(a.body.schedule.id);
    const worker2 = new JobWorker({
      db: h.test.db,
      queue: new JobQueue(h.test.db, { workerId: "second-worker" }),
      definitions: createJobCatalog(h.services),
      log: silentLogger,
    });
    const held = worker.runOnce();
    await Bun.sleep(300);
    expect((await run(first.run.id)).status).toBe("running");
    // The report's second case: schedule B on the same volume, another destination.
    const other = await runNow(b.body.schedule.id);
    const heldToo = worker2.runOnce();
    await Bun.sleep(300);
    expect((await run(other.run.id)).status).toBe("running");
    expect(runner.commandsOf("backup.volume")).toHaveLength(3);
    // The third: a restore asked for meanwhile is accepted and waits for the backups.
    const restore = await owner.post(`/services/${id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "web",
      volume,
    });
    expect(restore.status).toBe(202);
    while (await worker2.runOnce()) {}
    expect((await run(restore.body.run.id)).status).toBe("queued");
    runner.release();
    await held;
    await heldToo;
    await runJobs();
    expect((await run(first.run.id)).status).toBe("succeeded");
    expect((await run(other.run.id)).status).toBe("succeeded");
    const restored = await run(restore.body.run.id);
    expect(restored.error).toBeNull();
    expect(restored.status).toBe("succeeded");
  });
});

describe("one stop-while-copying run per service at a time (R3-48)", () => {
  test("a second schedule's copy waits until the first has started the service again", async () => {
    const destination = await addDestination();
    const { environments } = await makeProject(owner, "Site");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const id = created.service.id as string;
    const appName = created.service.appName as string;
    await owner.put(`/services/${id}/mounts`, {
      mounts: [
        { type: "volume", name: "html", containerPath: "/html" },
        { type: "volume", name: "logs", containerPath: "/logs" },
      ],
    });
    runner.addContainer(id, [
      { name: `${appName}-html`, destination: "/html" },
      { name: `${appName}-logs`, destination: "/logs" },
    ]);
    const first = await schedule(id, {
      destinationId: destination.id,
      volume: `${appName}-html`,
      stopService: true,
      folder: "html",
    });
    const second = await schedule(id, {
      destinationId: destination.id,
      volume: `${appName}-logs`,
      stopService: true,
      folder: "logs",
    });
    runner.hold();
    const a = await runNow(first.body.schedule.id);
    const b = await runNow(second.body.schedule.id);
    const worker2 = new JobWorker({
      db: h.test.db,
      queue: new JobQueue(h.test.db, { workerId: "second-worker" }),
      definitions: createJobCatalog(h.services),
      log: silentLogger,
    });
    // The first run is claimed and held on the server; the second, on another worker, waits.
    const held = worker.runOnce();
    await Bun.sleep(300);
    while (await worker2.runOnce()) {}
    expect((await run(a.run.id)).status).toBe("running");
    expect((await run(b.run.id)).status).toBe("queued");
    expect(runner.commandsOf("backup.volume")).toHaveLength(1);
    runner.release();
    await held;
    await runJobs();
    expect((await run(a.run.id)).status).toBe("succeeded");
    expect((await run(b.run.id)).status).toBe("succeeded");
    expect(runner.commandsOf("backup.volume")).toHaveLength(2);
  });
});

describe("restoring into a volume that isn't on the server yet (R3-52)", () => {
  test("the restore makes it with the service's labels and unpacks into it", async () => {
    const destination = await addDestination();
    const { environments } = await makeProject(owner, "Site");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const id = created.service.id as string;
    const appName = created.service.appName as string;
    await owner.put(`/services/${id}/mounts`, {
      mounts: [{ type: "volume", name: "html", containerPath: "/html" }],
    });
    const key = `${appName}/nightly/2026-11-25T03-00-00.tar.gz`;
    runner.bucket("acme-backups").set(key, { size: 50, modifiedAt: "x", content: "site" });
    // No container and no volume on the server: a service set up again before its first deploy.
    const restored = await owner.post(`/services/${id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "web",
      volume: `${appName}-html`,
    });
    expect(restored.status).toBe(202);
    await runJobs();
    expect((await run(restored.body.run.id)).status).toBe("succeeded");
    expect(runner.commandsOf("restore.volume").at(-1)?.params).toMatchObject({
      volume: `${appName}-html`,
      create: { labels: { "dev.nearzero.service": id } },
    });
    // A volume the service doesn't mount is still refused.
    const other = await owner.post(`/services/${id}/restores`, {
      destinationId: destination.id,
      key,
      confirm: "web",
      volume: "someone-elses",
    });
    expect(other.status).toBe(403);
  });
});

describe("testing a destination without a server (R3-49, spec 17.1)", () => {
  test("a workspace with no server and no host access tests from the host, public endpoints only", async () => {
    // Mia owns her personal workspace, with no server, and isn't allowed on the host.
    const mia = await addMember(h, owner, "mia@example.com");
    const personal = await h.test.db
      .selectFrom("workspace")
      .select("id")
      .where("created_by", "=", await personIdOf(h, "mia@example.com"))
      .executeTakeFirstOrThrow();
    await mia.post(`/workspaces/${personal.id}/switch`, {});
    const values = {
      provider: "other",
      bucket: "mia-backups",
      region: "auto",
      accessKeyId: "AKIA-MIA",
      secretAccessKey: "secret-of-mia",
    };
    setResolver(async (host) => (host === "s3.example.com" ? ["93.184.216.34"] : ["10.0.0.5"]));
    try {
      const ok = await mia.post("/backup-destinations/test", {
        ...values,
        endpoint: "https://s3.example.com",
      });
      expect(ok.body).toMatchObject({
        ok: true,
        message: "Connected. Nearzero can list mia-backups.",
        server: "Nearzero host",
      });
      expect(runner.commandsOf("backup.test").at(-1)?.params).toMatchObject({
        pinnedHosts: [{ host: "s3.example.com", address: "93.184.216.34" }],
      });
      const tests = runner.commandsOf("backup.test").length;
      for (const endpoint of [
        "https://minio.internal",
        "http://169.254.169.254",
        "http://[::1]:9000",
      ]) {
        const refused = await mia.post("/backup-destinations/test", { ...values, endpoint });
        expect(refused.status).toBe(200);
        expect(refused.body.ok).toBe(false);
        expect(refused.body.detail).toBe(
          destinationNotPublicMessage(new URL(endpoint).hostname.replace(/^\[|\]$/g, "")),
        );
      }
      // Nothing reached the host's runner for those.
      expect(runner.commandsOf("backup.test")).toHaveLength(tests);
    } finally {
      setResolver(null);
    }
  });
});

describe("permissions (spec 17.5, 22.3)", () => {
  test("members need the destination capabilities; owners see everything", async () => {
    const destination = await addDestination();
    const db = await database();
    const scope = {
      serviceIds: [db.id],
      projectIds: [db.projectId],
      environmentIds: [db.environmentId],
    };
    const plain = await addMember(h, owner, "pat@example.com", { scope });
    expect((await plain.get("/backup-destinations")).status).toBe(403);
    const panel = await plain.get(`/services/${db.id}/backups`);
    expect(panel.status).toBe(200);
    expect(panel.body.destinations).toEqual([]);
    expect(panel.body.notice.action).toBe("ask-permission");
    const refused = await schedule(db.id, { destinationId: destination.id }, plain);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("Back up to the workspace's destinations");

    await giveAccess(h, owner, "pat@example.com", {
      capabilities: ["backups.use-destinations"],
      scope,
    });
    expect((await plain.get("/backup-destinations")).status).toBe(200);
    expect((await plain.post("/backup-destinations", { name: "x" })).status).toBe(400);
    const add = await plain.post("/backup-destinations", {
      name: "Mine",
      provider: "aws",
      endpoint: "https://s3.us-east-1.amazonaws.com",
      bucket: "mine",
      accessKeyId: "a1",
      secretAccessKey: "b1",
    });
    expect(add.status).toBe(403);
    const allowed = await schedule(db.id, { destinationId: destination.id }, plain);
    expect(allowed.status).toBe(201);

    // A service out of the member's reach looks like nothing at all.
    const other = await database("other");
    expect((await plain.get(`/services/${other.id}/backups`)).status).toBe(404);
  });

  test("another workspace's destination can't be used (spec 22.4 rule 1)", async () => {
    const db = await database();
    const created = await owner.post("/workspaces", { name: "Side projects" });
    expect(created.status).toBe(201);
    const side = created.body.workspace.id as string;
    const home = (await owner.get("/workspace")).body.workspace.id as string;
    await owner.post(`/workspaces/${side}/switch`, {});
    const elsewhere = await addDestination(owner, "Elsewhere", "side-bucket");
    await owner.post(`/workspaces/${home}/switch`, {});
    expect((await owner.get(`/backup-destinations/${elsewhere.id}`)).status).toBe(404);
    const refused = await schedule(db.id, { destinationId: elsewhere.id });
    expect(refused.status).toBe(400);
    expect(refused.body.error.fields.destinationId).toBe("Pick a destination from the list.");
    const theirs = await owner.post(`/services/${db.id}/restores`, {
      destinationId: elsewhere.id,
      key: `${db.appName}/daily/2026-01-01T00-00-00.sql.gz`,
      confirm: db.name,
    });
    expect(theirs.status).toBe(404);
  });
});
