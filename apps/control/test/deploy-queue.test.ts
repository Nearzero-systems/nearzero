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
import { ObjectRegistry } from "../src/access/objects.ts";
import { HostnameProviders } from "../src/deploys/hostnames.ts";
import { RECORD_RETRY_MS } from "../src/deploys/job.ts";
import { cutover } from "../src/deploys/pipeline.ts";
import {
  cancelDeployment,
  enqueueRun,
  RUN_DEPLOY_JOB,
  requestDeploy,
  startBuilding,
} from "../src/deploys/queue.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { FakeRunner } from "./support/fake-runner.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { makeProject, makeService } from "./support/projects.ts";

/**
 * The deploy queue's edges (spec 23.1, "Pushes are never lost"; 6.5): a push that lands while
 * someone cancels the waiting deploy (B1-37), a failure while recording a deploy that already
 * went live (B1-38), one deployment never run by two jobs at once (B1-39), and the old version
 * kept running until the router had time to switch (B2-19).
 */

setDefaultTimeout(240_000);

let h: Harness;
let runner: FakeRunner;
let worker: JobWorker;
let owner: Browser;
const retries = [...RECORD_RETRY_MS];

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects } });
  runner = await FakeRunner.connect(h.test.db, h.services.runners);
  worker = new JobWorker({
    db: h.test.db,
    queue: new JobQueue(h.test.db, { workerId: "test-worker" }),
    definitions: createJobCatalog(h.services),
    log: silentLogger,
  });
});

afterAll(async () => {
  RECORD_RETRY_MS.splice(0, RECORD_RETRY_MS.length, ...retries);
  h.services.runners.stop();
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  await sql`truncate job, deployment, project cascade`.execute(h.test.db);
  await sql`drop trigger if exists test_record_failure on deployment`.execute(h.test.db);
  runner.containers.clear();
  runner.images.clear();
  runner.volumes.clear();
  runner.routes.clear();
  runner.commands.length = 0;
  h.services.hostnameProviders = new HostnameProviders();
  RECORD_RETRY_MS.splice(0, RECORD_RETRY_MS.length, 10, 10, 10);
  owner = await setUpNamedOwner(h);
});

async function runJobs(): Promise<number> {
  let ran = 0;
  while (await worker.runOnce()) ran++;
  return ran;
}

async function eventually<T>(what: string, check: () => Promise<T | null | undefined | false>) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function gitApp() {
  const { environments } = await makeProject(owner, "Shop");
  const created = await makeService(owner, environments.development as string, {
    kind: "application",
    name: "web",
    settings: { servicePort: 3000 },
  });
  const id = created.service.id as string;
  await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
  const saved = await owner.put(`/services/${id}/source`, {
    type: "git",
    url: "https://git.example.test/acme/web.git",
    branch: "main",
  });
  expect(saved.status).toBe(200);
  const row = await h.test.db
    .selectFrom("service")
    .select("workspace_id")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return { id, workspaceId: row.workspace_id };
}

async function deploymentsOf(serviceId: string) {
  return h.test.db
    .selectFrom("deployment")
    .select(["id", "status", "trigger", "requested_commit"])
    .where("service_id", "=", serviceId)
    .orderBy("created_at")
    .execute();
}

/** Backends of this test database waiting for a row lock. */
async function lockWaiters(): Promise<number> {
  const row = await sql<{ count: string }>`
    select count(*)::text as count from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock'`.execute(h.test.db);
  return Number(row.rows[0]?.count ?? 0);
}

describe("a push while the waiting deploy is cancelled (B1-37, spec 23.1)", () => {
  test("a cancel landing between the push's read and its replace leaves the push its own deploy", async () => {
    const app = await gitApp();
    const waiting = await requestDeploy(h.test.db, {
      serviceId: app.id,
      workspaceId: app.workspaceId,
      trigger: "manual",
      requestedBy: null,
    });
    expect(waiting.deployment.status).toBe("queued");

    // Someone holds the waiting deploy's row and cancels it once the push is past its read.
    let locked = () => {};
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let pushBlocked = () => {};
    const blocked = new Promise<void>((resolve) => {
      pushBlocked = resolve;
    });
    const cancel = h.test.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom("deployment")
        .select("id")
        .where("id", "=", waiting.deployment.id)
        .forUpdate()
        .execute();
      locked();
      await blocked;
      await trx
        .updateTable("deployment")
        .set({ status: "cancelled", finished_at: new Date() })
        .where("id", "=", waiting.deployment.id)
        .execute();
    });
    await isLocked;
    const push = requestDeploy(h.test.db, {
      serviceId: app.id,
      workspaceId: app.workspaceId,
      trigger: "push",
      requestedBy: null,
      commit: "abcdef1234567",
    });
    await eventually("the push to wait on the row", async () => (await lockWaiters()) > 0);
    pushBlocked();
    await cancel;
    const result = await push;

    expect(result.replaced).toBe(false);
    expect(result.deployment.id).not.toBe(waiting.deployment.id);
    expect(result.deployment.requested_commit).toBe("abcdef1234567");
    const rows = await deploymentsOf(app.id);
    expect(rows).toEqual([
      { id: waiting.deployment.id, status: "cancelled", trigger: "manual", requested_commit: null },
      {
        id: result.deployment.id,
        status: "queued",
        trigger: "push",
        requested_commit: "abcdef1234567",
      },
    ]);
    // It has a job, so it runs.
    await runJobs();
    expect((await deploymentsOf(app.id))[1]?.status).toBe("active");
  });

  test("cancel and a push at once: either the push is cancelled where it shows, or it gets its own deploy", async () => {
    const app = await gitApp();
    for (let round = 0; round < 5; round++) {
      await sql`truncate job, deployment cascade`.execute(h.test.db);
      const waiting = await requestDeploy(h.test.db, {
        serviceId: app.id,
        workspaceId: app.workspaceId,
        trigger: "manual",
        requestedBy: null,
      });
      const commit = `${round}`.repeat(12);
      const [push] = await Promise.all([
        requestDeploy(h.test.db, {
          serviceId: app.id,
          workspaceId: app.workspaceId,
          trigger: "push",
          requestedBy: null,
          commit,
        }),
        cancelDeployment(h.test.db, waiting.deployment.id).catch(() => "finished"),
      ]);
      const rows = await deploymentsOf(app.id);
      const carrying = rows.find((row) => row.requested_commit === commit);
      // The commit is on a deployment that is waiting, or on the one the cancel ended (and the
      // list shows it there), never written onto a deployment cancelled before it arrived.
      expect(carrying).toBeDefined();
      if (push.replaced) {
        expect(carrying?.id).toBe(waiting.deployment.id);
      } else {
        expect(carrying?.status).toBe("queued");
      }
    }
  });
});

describe("one deployment, one job (B1-39)", () => {
  test("enqueueing a deployment from two places at once gives it one job", async () => {
    const app = await gitApp();
    const row = await h.test.db
      .insertInto("deployment")
      .values({
        workspace_id: app.workspaceId,
        service_id: app.id,
        service_kind: "application",
        service_name: "web",
        app_name: "web",
        project_name: "Shop",
        environment_name: "development",
        server_name: "Nearzero host",
        trigger: "manual",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await Promise.all(Array.from({ length: 12 }, () => enqueueRun(h.test.db, row.id)));
    const jobs = await h.test.db
      .selectFrom("job")
      .select("id")
      .where("kind", "=", RUN_DEPLOY_JOB)
      .where("idempotency_key", "like", `deploy:${row.id}:%`)
      .execute();
    expect(jobs).toHaveLength(1);
  });

  test("a second job finds the deployment taken; only its own job picks it up again", async () => {
    const app = await gitApp();
    const queued = await requestDeploy(h.test.db, {
      serviceId: app.id,
      workspaceId: app.workspaceId,
      trigger: "manual",
      requestedBy: null,
    });
    const first = await startBuilding(h.test.db, queued.deployment.id, { jobId: 101 });
    expect(first).toMatchObject({ start: true, resumed: false });
    // Another job for the same deployment (an enqueue that raced) must not run it as well.
    expect(await startBuilding(h.test.db, queued.deployment.id, { jobId: 202 })).toEqual({
      start: false,
    });
    // The job that started it, on its next attempt after a restart, does.
    expect(await startBuilding(h.test.db, queued.deployment.id, { jobId: 101 })).toMatchObject({
      start: true,
      resumed: true,
    });
  });
});

describe("recording a finished deploy (B1-38)", () => {
  /** Makes the update that records a live deploy fail this many times, like a dropped connection. */
  async function failRecording(times: number) {
    await sql`drop sequence if exists test_record_failures`.execute(h.test.db);
    await sql.raw(`create sequence test_record_failures`).execute(h.test.db);
    await sql
      .raw(`create or replace function test_record_failure() returns trigger as $$
      begin
        if old.status = 'building' and new.status = 'active' then
          if nextval('test_record_failures') <= ${times} then
            raise exception 'terminating connection due to administrator command';
          end if;
        end if;
        return new;
      end $$ language plpgsql`)
      .execute(h.test.db);
    await sql
      .raw(`create trigger test_record_failure before update on deployment
      for each row execute function test_record_failure()`)
      .execute(h.test.db);
  }

  function containersCreated(): number {
    return runner.commandsOf("container.create").length;
  }

  test("a failure while recording a live deploy is retried; the deploy itself runs once", async () => {
    const app = await gitApp();
    await failRecording(2);
    const reply = await owner.post(`/services/${app.id}/deployments`, {});
    expect(reply.status).toBe(202);
    await runJobs();
    const row = await h.test.db
      .selectFrom("deployment")
      .select(["status", "pipeline_outcome"])
      .where("id", "=", reply.body.deployment.id)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("active");
    expect(row.pipeline_outcome).toMatchObject({ status: "active" });
    expect(containersCreated()).toBe(1);
    expect(runner.commandsOf("app.build")).toHaveLength(1);
  });

  test("when recording keeps failing, the job's next attempt records the saved outcome without deploying again", async () => {
    const app = await gitApp();
    await failRecording(4);
    const reply = await owner.post(`/services/${app.id}/deployments`, {});
    await runJobs();
    expect(
      (
        await h.test.db
          .selectFrom("deployment")
          .select("status")
          .where("id", "=", reply.body.deployment.id)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe("building");
    // The job's retry, once its pause has passed.
    await h.test.db.updateTable("job").set({ run_at: sql<Date>`now()` }).execute();
    await runJobs();
    const detail = (await owner.get(`/deployments/${reply.body.deployment.id}`)).body.deployment;
    expect(detail.status).toBe("active");
    expect(containersCreated()).toBe(1);
    expect(runner.commandsOf("app.build")).toHaveLength(1);
    const log = (await owner.get(`/deployments/${reply.body.deployment.id}/log?lines=all`)).body
      .text as string;
    expect(log).not.toContain("Nearzero stopped during this deploy");
  });

  test("a waiting deploy still starts when the run that ended the previous one stopped first", async () => {
    const app = await gitApp();
    const first = await requestDeploy(h.test.db, {
      serviceId: app.id,
      workspaceId: app.workspaceId,
      trigger: "manual",
      requestedBy: null,
    });
    await runJobs();
    const next = await requestDeploy(h.test.db, {
      serviceId: app.id,
      workspaceId: app.workspaceId,
      trigger: "manual",
      requestedBy: null,
    });
    // Its job is lost, as if the run before it stopped before starting it.
    await h.test.db.deleteFrom("job").execute();
    await h.test.db
      .updateTable("deployment")
      .set({ job_id: null })
      .where("id", "=", next.deployment.id)
      .execute();
    // The first deployment's job runs again (an attempt after a restart).
    await new JobQueue(h.test.db, { workerId: "x" }).enqueue({
      kind: RUN_DEPLOY_JOB,
      payload: { deploymentId: first.deployment.id },
      idempotencyKey: `deploy:${first.deployment.id}:again`,
    });
    await runJobs();
    const rows = await deploymentsOf(app.id);
    expect(rows.map((row) => row.status)).toEqual(["previous", "active"]);
  });
});

describe("switching traffic (B2-19, spec 6.5)", () => {
  test("the old version keeps running until the router has had time to apply the new route", async () => {
    const app = await gitApp();
    h.services.hostnameProviders.register("test", async () => ({
      routes: [{ host: "web.example.test", path: "/", port: 3000, https: false }],
      notes: [],
    }));
    await owner.post(`/services/${app.id}/deployments`, {});
    await runJobs();
    const before = runner.commands.length;
    const saved = cutover.routeSwitchMs;
    cutover.routeSwitchMs = 400;
    const times: Record<string, number> = {};
    const watch = setInterval(() => {
      for (const command of runner.commands.slice(before)) {
        if (times[command.kind] === undefined) times[command.kind] = Date.now();
      }
    }, 5);
    try {
      await owner.post(`/services/${app.id}/deployments`, {});
      await runJobs();
    } finally {
      clearInterval(watch);
      cutover.routeSwitchMs = saved;
    }
    const kinds = runner.commands.slice(before).map((command) => command.kind);
    const written = kinds.lastIndexOf("router.write");
    const stopped = kinds.findIndex(
      (kind, index) =>
        index > written && (kind === "container.stop" || kind === "container.remove"),
    );
    expect(written).toBeGreaterThan(-1);
    expect(stopped).toBeGreaterThan(written);
    const firstStop = Math.min(
      ...["container.stop", "container.remove"].map(
        (kind) => times[kind] ?? Number.POSITIVE_INFINITY,
      ),
    );
    expect(firstStop - (times["router.write"] as number)).toBeGreaterThanOrEqual(350);
  });
});
