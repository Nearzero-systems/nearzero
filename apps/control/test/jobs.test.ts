import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "kysely";
import { z } from "zod";
import { migrate } from "../src/db/migrate.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import {
  type AnyJobDefinition,
  DeferJob,
  defaultRetryDelayMs,
  defineJob,
  PermanentJobError,
  RETRY_MAX_MS,
} from "../src/jobs/definition.ts";
import { pruneFinishedJobs } from "../src/jobs/prune-finished-jobs.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { controlSchedules, keepSchedules } from "../src/jobs/schedules.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import type { ControlServices } from "../src/services.ts";
import { createTestDatabase, MIGRATIONS_DIR, type TestDatabase } from "./support/database.ts";

// Throwaway databases can take seconds to create and migrate on a busy machine.
setDefaultTimeout(120_000);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
  await migrate(testDb.db, { directory: MIGRATIONS_DIR });
});

afterAll(async () => {
  await testDb.drop();
});

beforeEach(async () => {
  await sql`truncate job restart identity`.execute(testDb.db);
});

function queue(workerId = "worker-a", leaseMs?: number): JobQueue {
  return new JobQueue(testDb.db, { workerId, ...(leaseMs === undefined ? {} : { leaseMs }) });
}

function worker(
  definitions: readonly AnyJobDefinition[],
  jobQueue = queue(),
  concurrency = 1,
): JobWorker {
  return new JobWorker({
    db: testDb.db,
    queue: jobQueue,
    definitions,
    log: silentLogger,
    concurrency,
    pollIntervalMs: 20,
  });
}

async function jobRow(id: number) {
  return testDb.db.selectFrom("job").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
}

const echo = defineJob({
  kind: "test.echo",
  payload: z.object({ text: z.string() }),
  async run() {},
});

describe("enqueue and claim", () => {
  test("a claimed job is running, holds a lease and counts the attempt", async () => {
    const q = queue();
    const { id, created } = await q.add(echo, { text: "hi" });
    expect(created).toBe(true);

    const job = await q.claim([echo.kind]);
    expect(job).toEqual({
      id,
      kind: "test.echo",
      payload: { text: "hi" },
      attempt: 1,
      maxAttempts: 5,
    });
    const row = await jobRow(id);
    expect(row.state).toBe("running");
    expect(row.locked_by).toBe("worker-a");
    expect(row.locked_until).toBeInstanceOf(Date);
    expect(await q.claim([echo.kind])).toBeNull();
  });

  test("payloads keep arrays and nesting exactly", async () => {
    const q = queue();
    const payload = { list: [1, "two", { three: [3] }], empty: [] };
    await q.enqueue({ kind: "test.shape", payload });
    expect((await q.claim(["test.shape"]))?.payload).toEqual(payload);
  });

  test("the same idempotency key returns the existing job instead of adding one", async () => {
    const q = queue();
    const first = await q.add(echo, { text: "a" }, { idempotencyKey: "deploy:42" });
    const second = await q.add(echo, { text: "a" }, { idempotencyKey: "deploy:42" });
    expect(second).toEqual({ id: first.id, created: false });
    const count = await testDb.db
      .selectFrom("job")
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow();
    expect(count.n).toBe(1);
  });

  test("jobs wait until they are due, and run oldest first", async () => {
    const q = queue();
    await q.enqueue({ kind: "test.echo", payload: { text: "later" }, delayMs: 60_000 });
    const first = await q.enqueue({ kind: "test.echo", payload: { text: "1" } });
    const second = await q.enqueue({ kind: "test.echo", payload: { text: "2" } });
    expect((await q.claim(["test.echo"]))?.id).toBe(first.id);
    expect((await q.claim(["test.echo"]))?.id).toBe(second.id);
    expect(await q.claim(["test.echo"])).toBeNull();
  });

  test("workers only claim kinds they know", async () => {
    const q = queue();
    await q.enqueue({ kind: "test.from-a-newer-version" });
    expect(await q.claim([echo.kind])).toBeNull();
    expect(await q.claim([])).toBeNull();
  });

  test("a payload that doesn't fit the kind is refused when it is added", async () => {
    // @ts-expect-error: the wrong payload type is the point of this test
    await expect(queue().add(echo, { text: 5 })).rejects.toThrow();
  });
});

describe("running jobs", () => {
  test("a successful job is marked succeeded", async () => {
    const seen: string[] = [];
    const job = defineJob({
      kind: "test.record",
      payload: z.object({ text: z.string() }),
      async run({ text }) {
        seen.push(text);
      },
    });
    const q = queue();
    const { id } = await q.add(job, { text: "done" });
    expect(await worker([job], q).runOnce()).toBe(true);
    expect(seen).toEqual(["done"]);
    const row = await jobRow(id);
    expect(row.state).toBe("succeeded");
    expect(row.finished_at).toBeInstanceOf(Date);
    expect(row.locked_by).toBeNull();
    expect(await worker([job], q).runOnce()).toBe(false);
  });

  test("a failed attempt is retried after the backoff, then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    const flaky = defineJob({
      kind: "test.flaky",
      payload: z.object({}),
      retryDelayMs: (attempt) => {
        delays.push(attempt);
        return 30_000;
      },
      async run() {
        calls += 1;
        if (calls === 1) throw new Error("The registry was busy.");
      },
    });
    const q = queue();
    const w = worker([flaky], q);
    const { id } = await q.add(flaky, {});

    await w.runOnce();
    let row = await jobRow(id);
    expect(row.state).toBe("queued");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("The registry was busy.");
    expect(delays).toEqual([1]);
    const waitMs = row.run_at.getTime() - row.updated_at.getTime();
    expect(waitMs).toBeGreaterThanOrEqual(29_000);
    expect(waitMs).toBeLessThanOrEqual(31_000);

    // Not due yet: nothing runs.
    expect(await w.runOnce()).toBe(false);

    await testDb.db
      .updateTable("job")
      .set({ run_at: sql<Date>`now()` })
      .where("id", "=", id)
      .execute();
    expect(await w.runOnce()).toBe(true);
    row = await jobRow(id);
    expect(row.state).toBe("succeeded");
    expect(row.attempts).toBe(2);
    expect(calls).toBe(2);
  });

  test("a job that keeps failing is marked failed after its last attempt", async () => {
    const broken = defineJob({
      kind: "test.broken",
      payload: z.object({}),
      maxAttempts: 3,
      retryDelayMs: () => 0,
      async run() {
        throw new Error("The server refused the connection.");
      },
    });
    const q = queue();
    const w = worker([broken], q);
    const { id } = await q.add(broken, {});
    for (let attempt = 0; attempt < 3; attempt++) expect(await w.runOnce()).toBe(true);
    const row = await jobRow(id);
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(3);
    expect(row.last_error).toBe("The server refused the connection.");
    expect(await w.runOnce()).toBe(false);
  });

  test("a permanent error fails the job without retrying", async () => {
    const hopeless = defineJob({
      kind: "test.hopeless",
      payload: z.object({}),
      async run() {
        throw new PermanentJobError("The repository doesn't exist.");
      },
    });
    const q = queue();
    const { id } = await q.add(hopeless, {});
    await worker([hopeless], q).runOnce();
    const row = await jobRow(id);
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
  });

  test("a stored payload that no longer fits fails at once with the reason", async () => {
    const q = queue();
    const { id } = await q.enqueue({ kind: echo.kind, payload: { text: 7 } });
    await worker([echo], q).runOnce();
    const row = await jobRow(id);
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("The job's data is not valid");
    expect(row.last_error).toContain("text");
  });
});

describe("several workers", () => {
  test("two workers never claim the same job", async () => {
    const total = 60;
    const runs: number[] = [];
    const tracked = defineJob({
      kind: "test.tracked",
      payload: z.object({ n: z.number() }),
      async run(_payload, { job }) {
        runs.push(job.id);
        await Bun.sleep(2);
      },
    });
    const setup = queue("setup");
    for (let n = 0; n < total; n++) await setup.add(tracked, { n });

    const a = worker([tracked], queue("worker-a"), 4);
    const b = worker([tracked], queue("worker-b"), 4);
    a.start();
    b.start();
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const left = await testDb.db
        .selectFrom("job")
        .select((eb) => eb.fn.countAll<number>().as("n"))
        .where("state", "!=", "succeeded")
        .executeTakeFirstOrThrow();
      if (left.n === 0) break;
      await Bun.sleep(25);
    }
    await Promise.all([a.stop(), b.stop()]);

    expect(runs).toHaveLength(total);
    expect(new Set(runs).size).toBe(total);
    const attempts = await testDb.db.selectFrom("job").select("attempts").execute();
    expect(attempts.every((row) => row.attempts === 1)).toBe(true);
  });

  test("concurrent claims from two processes split the jobs without overlap", async () => {
    const setup = queue("setup");
    for (let n = 0; n < 20; n++) await setup.enqueue({ kind: "test.split" });
    const a = queue("worker-a");
    const b = queue("worker-b");
    const claims = await Promise.all(
      Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? a : b).claim(["test.split"])),
    );
    const ids = claims.filter((job) => job !== null).map((job) => job.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
  });

  test("a job whose worker stopped mid-run goes back to the queue, then fails when out of attempts", async () => {
    const crashed = queue("crashed-worker", 50);
    const { id } = await crashed.enqueue({
      kind: "test.echo",
      payload: { text: "x" },
      maxAttempts: 2,
    });
    expect(await crashed.claim(["test.echo"])).not.toBeNull();
    await Bun.sleep(120);

    const survivor = queue("survivor");
    expect(await survivor.recoverExpired()).toBe(1);
    let row = await jobRow(id);
    expect(row.state).toBe("queued");
    expect(row.last_error).toBe("The control plane stopped while this job was running.");

    const again = await survivor.claim(["test.echo"]);
    expect(again?.attempt).toBe(2);
    // The crashed worker can no longer record a result for the job it lost.
    expect(
      await crashed.complete({ id, kind: "test.echo", payload: {}, attempt: 1, maxAttempts: 2 }),
    ).toBe(false);

    await testDb.db
      .updateTable("job")
      .set({ locked_until: sql<Date>`now() - interval '1 second'` })
      .where("id", "=", id)
      .execute();
    expect(await survivor.recoverExpired()).toBe(1);
    row = await jobRow(id);
    expect(row.state).toBe("failed");
    expect(row.finished_at).toBeInstanceOf(Date);
  });

  test("a running job's lease is renewed while it works", async () => {
    const q = queue("slow-worker", 150);
    const slow = defineJob({
      kind: "test.slow",
      payload: z.object({}),
      async run() {
        await Bun.sleep(400);
      },
    });
    const { id } = await q.add(slow, {});
    const running = worker([slow], q).runOnce();
    await Bun.sleep(250);
    expect(await queue("other").recoverExpired()).toBe(0);
    await running;
    expect((await jobRow(id)).state).toBe("succeeded");
  });
});

describe("backoff", () => {
  test("doubles from 5 seconds and stops growing at 10 minutes", () => {
    expect([1, 2, 3, 4].map(defaultRetryDelayMs)).toEqual([5_000, 10_000, 20_000, 40_000]);
    expect(defaultRetryDelayMs(30)).toBe(RETRY_MAX_MS);
  });
});

describe("the prune job", () => {
  test("deletes only finished jobs older than the limit", async () => {
    const q = queue();
    const old = await q.enqueue({ kind: "test.echo", payload: { text: "old" } });
    const oldFailed = await q.enqueue({ kind: "test.echo", payload: { text: "old failed" } });
    const recent = await q.enqueue({ kind: "test.echo", payload: { text: "recent" } });
    const waiting = await q.enqueue({ kind: "test.echo", payload: { text: "waiting" } });
    await testDb.db
      .updateTable("job")
      .set({ state: "succeeded", finished_at: sql<Date>`now() - interval '10 days'` })
      .where("id", "=", old.id)
      .execute();
    await testDb.db
      .updateTable("job")
      .set({ state: "failed", finished_at: sql<Date>`now() - interval '9 days'` })
      .where("id", "=", oldFailed.id)
      .execute();
    await testDb.db
      .updateTable("job")
      .set({ state: "succeeded", finished_at: sql<Date>`now() - interval '1 day'` })
      .where("id", "=", recent.id)
      .execute();
    await testDb.db
      .updateTable("job")
      .set({ created_at: sql<Date>`now() - interval '30 days'` })
      .where("id", "=", waiting.id)
      .execute();

    const prune = await q.add(pruneFinishedJobs, { olderThanDays: 7 });
    expect(await worker([pruneFinishedJobs], q).runOnce()).toBe(true);

    const left = await testDb.db.selectFrom("job").select("id").orderBy("id").execute();
    expect(left.map((row) => row.id)).toEqual([recent.id, waiting.id, prune.id]);
    expect((await jobRow(prune.id)).state).toBe("succeeded");
  });

  test("refuses a nonsensical age when it is added", async () => {
    await expect(queue().add(pruneFinishedJobs, { olderThanDays: 0 })).rejects.toThrow();
  });
});

describe("lanes (R2-15, R4-03, B1-12)", () => {
  test("while every long-work lane is busy, a scheduler tick and a deploy still start at once", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started: string[] = [];
    const long = defineJob({
      kind: "test.long",
      payload: z.object({ n: z.number() }),
      async run({ n }) {
        started.push(`long ${n}`);
        await held;
      },
    });
    const tick = defineJob({
      kind: "test.tick",
      payload: z.object({}),
      lane: "schedule",
      async run() {
        started.push("tick");
      },
    });
    const deploy = defineJob({
      kind: "test.deploy",
      payload: z.object({}),
      lane: "deploy",
      async run() {
        started.push("deploy");
      },
    });
    const q = queue();
    for (let n = 1; n <= 6; n++) await q.add(long, { n });
    const w = new JobWorker({
      db: testDb.db,
      queue: q,
      definitions: [long, tick, deploy],
      log: silentLogger,
      concurrency: 4,
      deployConcurrency: 1,
      scheduleConcurrency: 1,
      pollIntervalMs: 20,
    });
    expect(w.kindsOf("schedule")).toEqual(["test.tick"]);
    expect(w.kindsOf("deploy")).toEqual(["test.deploy"]);
    w.start();
    try {
      for (let i = 0; i < 500 && started.length < 4; i++) await Bun.sleep(10);
      expect(started.filter((item) => item.startsWith("long"))).toHaveLength(4);
      // The review's case: four long jobs hold every lane, then a tick and a deploy fall due.
      await q.add(tick, {});
      await q.add(deploy, {});
      for (let i = 0; i < 500 && !(started.includes("tick") && started.includes("deploy")); i++) {
        await Bun.sleep(10);
      }
      expect(started).toContain("tick");
      expect(started).toContain("deploy");
      // The two long jobs beyond the four lanes are still waiting their turn.
      expect(started.filter((item) => item.startsWith("long"))).toHaveLength(4);
    } finally {
      release();
      await w.stop({ graceMs: 5_000 });
    }
  });

  /**
   * The real catalog's kinds and lanes, with each run replaced by one that waits until it is
   * let go, so a test can fill a kind's lanes and see what still starts (R4-03, C1-09).
   */
  function heldCatalog() {
    const started: string[] = [];
    const releases: (() => void)[] = [];
    const definitions = createJobCatalog({} as ControlServices).map((definition) => ({
      ...definition,
      payload: z.unknown(),
      async run() {
        started.push(definition.kind);
        await new Promise<void>((resolve) => releases.push(resolve));
      },
    })) as AnyJobDefinition[];
    const release = () => {
      for (const go of releases.splice(0)) go();
    };
    return { started, definitions, release };
  }

  async function startsWithin(
    started: string[],
    kind: string,
    count: number,
    ms: number,
  ): Promise<number> {
    const from = Date.now();
    while (Date.now() - from < ms) {
      if (started.filter((item) => item === kind).length >= count) return Date.now() - from;
      await Bun.sleep(10);
    }
    throw new Error(`${kind} didn't start ${count} times within ${ms} ms: ${started.join(", ")}`);
  }

  test("every kind of long work has lanes of its own in the real catalog", () => {
    const w = new JobWorker({
      db: testDb.db,
      queue: queue(),
      definitions: createJobCatalog({} as ControlServices),
      log: silentLogger,
    });
    expect(w.kindsOf("backup")).toEqual(["backups.run"]);
    expect(w.kindsOf("task")).toEqual(["tasks.run"]);
    expect(w.kindsOf("setup")).toEqual(["servers.setup"]);
    expect([...w.kindsOf("delete")].sort()).toEqual([
      "deletion.remove-services",
      "servers.remove",
      "servers.uninstall-runner",
    ]);
    expect(w.kindsOf("cleanup")).toEqual(["servers.docker-cleanup"]);
    expect(w.kindsOf("deploy")).toEqual(["deploys.run"]);
    expect(w.kindsOf("work")).toEqual(["migration.move", "migration.finalize"]);
    // Every lane group but the scheduler's has the configured count, its own.
    for (const group of ["backup", "task", "setup", "delete", "cleanup", "work"] as const)
      expect(w.lanesOf(group)).toBe(4);
    expect(w.lanesOf("schedule")).toBe(2);
  });

  test("while 4 task runs are running, a database backup due now starts at once (R4-03)", async () => {
    const { started, definitions, release } = heldCatalog();
    const q = queue();
    const w = new JobWorker({
      db: testDb.db,
      queue: q,
      definitions,
      log: silentLogger,
      pollIntervalMs: 20,
    });
    w.start();
    try {
      // Four 30-minute task runs hold the task lanes, and a fifth waits for one of them.
      for (let n = 0; n < 5; n++) await q.enqueue({ kind: "tasks.run", payload: { n } });
      await startsWithin(started, "tasks.run", 4, 10_000);
      // Setups, deletes and cleanups fill their own lanes too, as the review's mix did.
      for (let n = 0; n < 4; n++) {
        await q.enqueue({ kind: "servers.setup", payload: { n } });
        await q.enqueue({ kind: "deletion.remove-services", payload: { n } });
        await q.enqueue({ kind: "servers.docker-cleanup", payload: { n } });
      }
      await startsWithin(started, "servers.setup", 4, 10_000);
      await startsWithin(started, "deletion.remove-services", 4, 10_000);
      await startsWithin(started, "servers.docker-cleanup", 4, 10_000);
      // The backup due this minute starts well within the minute.
      await q.enqueue({ kind: "backups.run", payload: {} });
      expect(await startsWithin(started, "backups.run", 1, 10_000)).toBeLessThan(10_000);
      // The fifth task run still waits: raising nothing else's count made room for it.
      expect(started.filter((kind) => kind === "tasks.run")).toHaveLength(4);
    } finally {
      release();
      const stopping = w.stop({ graceMs: 5_000 });
      // Jobs that started while stopping are let go too.
      for (let i = 0; i < 20; i++) {
        release();
        await Bun.sleep(25);
      }
      await stopping;
    }
  });

  test("while 4 server setups are running, a task due now starts at once (R4-03)", async () => {
    const { started, definitions, release } = heldCatalog();
    const q = queue();
    const w = new JobWorker({
      db: testDb.db,
      queue: q,
      definitions,
      log: silentLogger,
      pollIntervalMs: 20,
    });
    w.start();
    try {
      for (let n = 0; n < 4; n++) {
        await q.enqueue({ kind: "servers.setup", payload: { n } });
        await q.enqueue({ kind: "backups.run", payload: { n } });
      }
      await startsWithin(started, "servers.setup", 4, 10_000);
      await startsWithin(started, "backups.run", 4, 10_000);
      await q.enqueue({ kind: "tasks.run", payload: {} });
      expect(await startsWithin(started, "tasks.run", 1, 10_000)).toBeLessThan(10_000);
    } finally {
      release();
      const stopping = w.stop({ graceMs: 5_000 });
      for (let i = 0; i < 20; i++) {
        release();
        await Bun.sleep(25);
      }
      await stopping;
    }
  });

  test("idle lanes of a group take turns: four idle lanes ask the database about once per poll", async () => {
    let claims = 0;
    const counting = new JobQueue(testDb.db, { workerId: "counting" });
    const claim = counting.claim.bind(counting);
    counting.claim = async (kinds) => {
      claims++;
      return claim(kinds);
    };
    const idle = defineJob({ kind: "test.idle", payload: z.object({}), async run() {} });
    const w = new JobWorker({
      db: testDb.db,
      queue: counting,
      definitions: [idle],
      log: silentLogger,
      concurrency: 4,
      pollIntervalMs: 100,
    });
    w.start();
    await Bun.sleep(1_050);
    await w.stop();
    // Ten polls a second would be 40 with each lane asking for itself.
    expect(claims).toBeGreaterThanOrEqual(3);
    expect(claims).toBeLessThanOrEqual(16);
    // A job added while they are idle is still picked up.
    const fresh = new JobQueue(testDb.db, { workerId: "fresh" });
    const { id } = await fresh.add(idle, {});
    const again = new JobWorker({
      db: testDb.db,
      queue: fresh,
      definitions: [idle],
      log: silentLogger,
      concurrency: 4,
      pollIntervalMs: 20,
    });
    again.start();
    for (let i = 0; i < 200 && (await jobRow(id)).state !== "succeeded"; i++) await Bun.sleep(10);
    await again.stop();
    expect((await jobRow(id)).state).toBe("succeeded");
  });

  test("a job that defers waits again without using an attempt", async () => {
    let calls = 0;
    const waiting = defineJob({
      kind: "test.waits",
      payload: z.object({}),
      maxAttempts: 1,
      async run() {
        calls++;
        if (calls < 3) throw new DeferJob(0, "busy");
      },
    });
    const q = queue();
    const { id } = await q.add(waiting, {});
    const w = worker([waiting], q);
    for (let i = 0; i < 3; i++) await w.runOnce();
    const row = await jobRow(id);
    expect(calls).toBe(3);
    expect(row.state).toBe("succeeded");
    expect(row.attempts).toBe(1);
  });
});

describe("the schedule keeper (B1-13, spec 23.2)", () => {
  test("every schedule gets its next job; asking again books nothing twice; the next day books the daily ones again", async () => {
    const schedules = controlSchedules();
    const day = new Date("2026-11-27T10:00:00Z");
    await keepSchedules(testDb.db, silentLogger, schedules, day);
    const kinds = async () =>
      (
        await testDb.db
          .selectFrom("job")
          .select("kind")
          .where("state", "=", "queued")
          .orderBy("kind")
          .execute()
      ).map((row) => row.kind);
    const first = await kinds();
    for (const kind of [
      "tasks.tick",
      "backups.tick",
      "maintenance.prune-finished-jobs",
      "maintenance.prune-identity-records",
      "deploys.prune",
      "runners.prune-server-metrics",
    ]) {
      expect(first).toContain(kind);
    }
    await keepSchedules(testDb.db, silentLogger, schedules, day);
    expect(await kinds()).toEqual(first);
    // A chain whose job failed for good, and a day with no restart, are booked again.
    await testDb.db
      .updateTable("job")
      .set({ state: "failed" })
      .where("kind", "in", ["tasks.tick", "maintenance.prune-identity-records"])
      .execute();
    await keepSchedules(testDb.db, silentLogger, schedules, new Date("2026-11-28T00:05:00Z"));
    const after = await kinds();
    expect(after.filter((kind) => kind === "tasks.tick")).toHaveLength(1);
    expect(after.filter((kind) => kind === "maintenance.prune-identity-records")).toHaveLength(1);
    expect(after.filter((kind) => kind === "maintenance.prune-finished-jobs")).toHaveLength(2);
  });
});
