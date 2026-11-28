import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { NEARZERO_LABELS, nextTaskRun, TASK_MESSAGES } from "@nearzero/shared";
import { sql } from "kysely";
import { loadGrants, WorkspaceAccess } from "../src/access/grants.ts";
import { ObjectRegistry } from "../src/access/objects.ts";
import type { WorkspaceActor } from "../src/http/actor.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { forgetSchedulesStarted, markSchedulesStarted } from "../src/jobs/started.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { createTask, listTasks, reviewTask } from "../src/tasks/area.ts";
import { pruneRuns, startRun } from "../src/tasks/runs.ts";
import { startDueTasks } from "../src/tasks/scheduler.ts";
import { isInstanceAdmin, resolveActiveWorkspace } from "../src/workspaces/workspaces.ts";
import { FakeRunner } from "./support/fake-runner.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember, makeProject, makeService, workspaceIdOf } from "./support/projects.ts";

/**
 * Tasks end to end against a fake runner speaking the real protocol (spec 12, 20.12): places and
 * who may use them, "Check and save" with the shell's own syntax check (the fake runs a real
 * `sh -n`), warnings and "Save anyway", the schedule (every minute in Asia/Kolkata), a skipped
 * due time while a run is going, Run in the background with its log, Stop, 100 runs kept, the
 * list's filters, and the functions the Agent calls.
 */

setDefaultTimeout(120_000);

let h: Harness;
let runner: FakeRunner;
let worker: JobWorker;
let owner: Browser;
/** Runs the fake is carrying out, by run id; task.stop resolves them. */
const live = new Map<string, () => void>();
let holdRuns = false;
let keepAlive: ReturnType<typeof setInterval> | null = null;

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects } });
  runner = await FakeRunner.connect(h.test.db, h.services.runners, null);
  runner.extraHandlers.set("task.check", async (params) => {
    const child = Bun.spawn(["sh", "-n", "-c", String(params.script)], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const output =
      (await new Response(child.stderr).text()) + (await new Response(child.stdout).text());
    const exitCode = await child.exited;
    // Report it the way bash words it, so the line is named like on a server.
    const line = /(\d+):/.exec(output)?.[1];
    return {
      ok: exitCode === 0,
      exitCode,
      output:
        exitCode === 0 ? "" : `bash: -c: line ${line ?? "?"}: syntax error near unexpected token`,
    };
  });
  runner.extraHandlers.set("task.run", async (params, write) => {
    write(
      `ran ${String(params.shell)} in ${params.place === "container" ? `container ${String(params.container)}` : "the server"}\n`,
    );
    write("line two\n");
    if (!holdRuns)
      return {
        exitCode: String(params.script).includes("exit 4") ? 4 : 0,
        stopped: false,
        timedOut: false,
      };
    await new Promise<void>((resolve) => live.set(String(params.runId), resolve));
    return { exitCode: null, stopped: true, timedOut: false };
  });
  runner.extraHandlers.set("task.stop", async (params) => {
    const stop = live.get(String(params.runId));
    live.delete(String(params.runId));
    stop?.();
    return { stopped: Boolean(stop) };
  });
  // The fake runner sends no heartbeats; a cheap command now and then keeps its link from going
  // quiet (35 seconds) on a slow machine.
  keepAlive = setInterval(() => {
    if (!h.services.runners.isOnline("host")) void runner.reconnect().catch(() => {});
    else void h.services.runners.command("host", "router.ensure", {}).catch(() => {});
  }, 5_000);
  worker = new JobWorker({
    db: h.test.db,
    queue: new JobQueue(h.test.db, { workerId: "test-worker" }),
    definitions: createJobCatalog(h.services),
    log: silentLogger,
  });
}, 300_000);

afterAll(async () => {
  if (keepAlive) clearInterval(keepAlive);
  h.services.runners.stop();
  await h.drop();
}, 300_000);

beforeEach(async () => {
  await h.reset();
  await sql`truncate job, task, project, server cascade`.execute(h.test.db);
  runner.containers.clear();
  if (!h.services.runners.isOnline("host")) await runner.reconnect();
  holdRuns = false;
  live.clear();
  owner = await setUpNamedOwner(h);
});

/** The person as the Agent acts for them: the same access an API request gets. */
async function actorOf(email: string): Promise<WorkspaceActor> {
  const person = await h.test.db
    .selectFrom("person")
    .select("id")
    .where("email", "=", email)
    .executeTakeFirstOrThrow();
  const workspace = await resolveActiveWorkspace(h.test.db, {
    id: crypto.randomUUID(),
    personId: person.id,
    activeWorkspaceId: null,
  });
  if (!workspace) throw new Error("no workspace");
  const admin = await isInstanceAdmin(h.test.db, person.id);
  const grants = await loadGrants(h.test.db, {
    personId: person.id,
    workspaceId: workspace.id,
    role: workspace.role,
    isInstanceAdmin: admin,
  });
  return {
    personId: person.id,
    email,
    sessionId: "agent",
    clientAddress: "127.0.0.1",
    secure: false,
    userAgent: null,
    workspace,
    role: workspace.role,
    isInstanceAdmin: admin,
    access: new WorkspaceAccess(h.test.db, h.services.objects, grants),
  };
}

async function runJobs(): Promise<number> {
  let ran = 0;
  while (await worker.runOnce()) ran++;
  return ran;
}

async function app(name = "web") {
  const { environments, projectId } = await makeProject(owner, `Shop ${name}`);
  const created = await makeService(owner, environments.development as string, {
    kind: "application",
    name,
    source: { type: "image", image: "nginx:1" },
  }).catch(async () =>
    makeService(owner, environments.development as string, { kind: "application", name }),
  );
  const service = created.service as { id: string; name: string };
  runner.containers.set(`c-${service.id}`, {
    id: `c-${service.id}`,
    name: `${name}-container`,
    image: "nginx:1",
    labels: { [NEARZERO_LABELS.service]: service.id, [NEARZERO_LABELS.managed]: "true" },
    env: {},
    state: "running",
    exitCode: 0,
    startedAt: new Date().toISOString(),
    restartCount: 0,
    output: "",
    ports: [],
    files: [],
    createdAt: Date.now(),
  });
  return { ...service, projectId, environmentId: environments.development as string };
}

const BASE = { cron: "* * * * *", timeZone: "Asia/Kolkata" };

describe("Check and save (spec 12.2)", () => {
  test("a syntax error on line 3 is refused with its line", async () => {
    const web = await app();
    const reply = await owner.post("/tasks", {
      ...BASE,
      name: "Broken",
      place: "container",
      serviceId: web.id,
      shell: "sh",
      script: "echo one\necho two\nif true; then\n",
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error.fields.script).toContain("line 3");
    expect(await h.test.db.selectFrom("task").select("id").execute()).toHaveLength(0);
  });

  test("warnings need Save anyway; Windows line endings are converted; the next run is shown in the zone", async () => {
    const web = await app();
    const body = {
      ...BASE,
      name: "Py",
      place: "container",
      serviceId: web.id,
      shell: "bash",
      script: "#!/usr/bin/env python3\r\necho hi\r\n",
    };
    const first = await owner.post("/tasks", body);
    expect(first.status).toBe(200);
    expect(first.body.saved).toBe(false);
    expect(first.body.check.warnings[0].message).toContain("still runs under bash");
    expect(first.body.check.converted).toBe(true);
    const saved = await owner.post("/tasks", { ...body, force: true });
    expect(saved.status).toBe(201);
    expect(saved.body.message).toBe(TASK_MESSAGES.created);
    expect(saved.body.task).toMatchObject({
      name: "Py",
      place: "container",
      timeZone: "Asia/Kolkata",
      scheduleText: "Every minute",
      statusLabel: "Enabled",
    });
    const stored = await h.test.db
      .selectFrom("task")
      .select(["script", "next_run_at"])
      .executeTakeFirstOrThrow();
    expect(stored.script).toBe("#!/usr/bin/env python3\necho hi\n");
    const expected = nextTaskRun("* * * * *", "Asia/Kolkata", Date.now() - 60_000);
    expect(stored.next_run_at?.getTime()).toBeGreaterThanOrEqual(expected ?? 0);
    expect(saved.body.task.nextRunText).toContain("(Asia/Kolkata)");
  });

  test("a container task's two-line command warns that only the last line decides; servers don't (G3-15)", async () => {
    const web = await app();
    const body = {
      ...BASE,
      name: "Two lines",
      place: "container",
      serviceId: web.id,
      shell: "sh",
      script: "false\necho done\n",
    };
    const first = await owner.post("/tasks", body);
    expect(first.status).toBe(200);
    expect(first.body.saved).toBe(false);
    expect(first.body.check.warnings).toContainEqual({
      field: "script",
      line: null,
      message:
        "It runs as one shell command; lines run one after another and the task fails only if the last one does. Join them with && to stop at the first failure.",
    });
    const saved = await owner.post("/tasks", { ...body, force: true });
    expect(saved.status).toBe(201);
    // Joined with &&, it is one line and saves at once.
    const joined = await owner.post("/tasks", {
      ...body,
      name: "Joined",
      script: "false && echo done",
    });
    expect(joined.status).toBe(201);
    // A server's script gets no such warning.
    const server = await owner.post("/tasks/check", {
      ...BASE,
      place: "host",
      script: "false\necho done\n",
    });
    expect(
      server.body.check.warnings.map((note: { message: string }) => note.message),
    ).not.toContainEqual(expect.stringContaining("runs as one shell command"));
  });

  test("cron and zone errors name their field; a stopped service only warns that it couldn't be checked", async () => {
    const web = await app();
    const bad = await owner.post("/tasks/check", {
      place: "container",
      serviceId: web.id,
      cron: "* * *",
      timeZone: "Mars/Base",
      script: "echo",
    });
    expect(bad.status).toBe(200);
    expect(bad.body.check.ok).toBe(false);
    expect(bad.body.check.errors.map((note: { field: string }) => note.field).sort()).toEqual([
      "cron",
      "timeZone",
    ]);
    runner.containers.clear();
    const unchecked = await owner.post("/tasks/check", {
      place: "container",
      serviceId: web.id,
      ...BASE,
      script: "echo",
    });
    expect(unchecked.body.check.syntax).toBe("unchecked");
    expect(unchecked.body.check.warnings[0].message).toContain("isn't running");
  });

  test("the cron forms 0.1.x ran save and run on their rhythm: L, #, nL and ? (G3-14)", async () => {
    const web = await app();
    for (const [cron, words] of [
      ["0 0 L * *", "Every month on the last day at 00:00"],
      ["0 9 * * 1#1", "Every month on the first Monday at 09:00"],
      ["0 9 ? * 5L", "Every month on the last Friday at 09:00"],
    ] as const) {
      const saved = await owner.post("/tasks", {
        name: `Rhythm ${cron}`,
        place: "container",
        serviceId: web.id,
        cron,
        timeZone: "UTC",
        script: "echo",
      });
      expect(saved.status).toBe(201);
      expect(saved.body.task.scheduleText).toBe(words);
      expect(saved.body.task.nextRunAt).toBe(
        new Date(nextTaskRun(cron, "UTC", Date.now()) as number).toISOString(),
      );
      const next = new Date(saved.body.task.nextRunAt);
      const monthEnd = new Date(
        Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
      ).getUTCDate();
      if (cron === "0 0 L * *") expect(next.getUTCDate()).toBe(monthEnd);
      if (cron === "0 9 * * 1#1") {
        expect(next.getUTCDay()).toBe(1);
        expect(next.getUTCDate()).toBeLessThanOrEqual(7);
      }
      if (cron === "0 9 ? * 5L") {
        expect(next.getUTCDay()).toBe(5);
        expect(next.getUTCDate() + 7).toBeGreaterThan(monthEnd);
      }
    }
    const refused = await owner.post("/tasks/check", {
      place: "container",
      serviceId: web.id,
      cron: "0 9 * * 1#6",
      timeZone: "UTC",
      script: "echo",
    });
    expect(refused.body.check.errors).toContainEqual({
      field: "cron",
      line: null,
      message: 'In "1#6", the number after "#" must be from 1 to 5 (1#1 is the first Monday).',
    });
  });

  test("the place is fixed after creation; other fields change", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Job",
      place: "container",
      serviceId: web.id,
      script: "echo",
    });
    const id = created.body.task.id;
    const moved = await owner.patch(`/tasks/${id}`, { place: "host" });
    expect(moved.status).toBe(400);
    expect(moved.body.error.message).toBe(TASK_MESSAGES.placeFixed);
    const renamed = await owner.patch(`/tasks/${id}`, {
      name: "Nightly",
      cron: "0 0 * * *",
      enabled: false,
    });
    expect(renamed.body).toMatchObject({
      saved: true,
      message: "Task updated",
      task: { name: "Nightly", enabled: false, statusLabel: "Disabled", nextRunAt: null },
    });
  });
});

describe("running (spec 12.3)", () => {
  test("every minute in Asia/Kolkata: the due run starts, streams its log and succeeds; the schedule moves on", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Tick",
      place: "container",
      serviceId: web.id,
      script: "echo tick",
    });
    const id = created.body.task.id;
    await h.test.db
      .updateTable("task")
      .set({ next_run_at: new Date(Date.now() - 1000) })
      .execute();
    expect(await startDueTasks(h.test.db)).toEqual({ started: 1, skipped: 0 });
    expect(await startDueTasks(h.test.db)).toEqual({ started: 0, skipped: 0 });
    // Only the run itself; the scheduler's own ticks aren't part of this test.
    await h.test.db.deleteFrom("job").where("kind", "=", "tasks.tick").execute();
    await runJobs();
    const runs = (await owner.get(`/tasks/${id}/runs`)).body.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "succeeded",
      statusLabel: "Succeeded",
      trigger: "schedule",
      exitCode: 0,
    });
    const one = (await owner.get(`/task-runs/${runs[0].id}`)).body.run;
    expect(one.log).toContain(`in container c-${web.id}`);
    expect(one.log).toContain("line two");
    const task = (await owner.get(`/tasks/${id}`)).body.task;
    expect(new Date(task.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(task.lastRun.statusLabel).toBe("Succeeded");
  });

  test("a run still going when the next is due is skipped, not doubled, and the skip is recorded", async () => {
    holdRuns = true;
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Slow",
      place: "container",
      serviceId: web.id,
      script: "sleep 600",
    });
    const id = created.body.task.id;
    const started = await owner.post(`/tasks/${id}/run`, {});
    expect(started.status).toBe(202);
    expect(started.body.message).toBe("Task started");
    const jobs = runJobs();
    await Bun.sleep(300);
    await h.test.db
      .updateTable("task")
      .set({ next_run_at: new Date(Date.now() - 1000) })
      .execute();
    expect(await startDueTasks(h.test.db)).toEqual({ started: 0, skipped: 1 });
    const again = await owner.post(`/tasks/${id}/run`, {});
    expect(again.status).toBe(409);
    // The list says it's running, not "Skipped" from the due time after it (B1-53).
    const listed = (await owner.get("/tasks")).body.tasks.find(
      (task: { id: string }) => task.id === id,
    );
    expect(listed).toMatchObject({ running: true, lastRun: { status: "running" } });
    const stopped = await owner.post(`/task-runs/${started.body.run.id}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.message).toBe("Run stopped");
    // Stopping is audited in the task's workspace, like its other events (B1-54).
    const audit = await h.test.db
      .selectFrom("audit_event")
      .select("workspace_id")
      .where("action", "=", "task.run-stopped")
      .executeTakeFirstOrThrow();
    expect(audit.workspace_id).toBe(await workspaceIdOf(owner));
    await jobs;
    const runs = (await owner.get(`/tasks/${id}/runs`)).body.runs;
    expect(runs.map((run: { status: string }) => run.status).sort()).toEqual([
      "skipped",
      "stopped",
    ]);
    const skip = runs.find((run: { status: string }) => run.status === "skipped");
    expect(skip.error).toBe(TASK_MESSAGES.skipped);
    expect(runner.commandsOf("task.stop").length).toBeGreaterThan(0);
  });

  test("a due run waiting for a task lane is queued, not running: the next due time says so, and its time starts when it starts (C1-09)", async () => {
    holdRuns = true;
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Every five",
      place: "container",
      serviceId: web.id,
      script: "sleep 600",
    });
    const id = created.body.task.id as string;
    const due = async () => {
      await h.test.db
        .updateTable("task")
        .set({ next_run_at: new Date(Date.now() - 1000) })
        .where("id", "=", id)
        .execute();
      return startDueTasks(h.test.db);
    };
    expect(await due()).toEqual({ started: 1, skipped: 0 });
    // Every task lane is busy: the run is queued, and no lane has taken it yet.
    const [queued] = (await owner.get(`/tasks/${id}/runs`)).body.runs;
    expect(queued).toMatchObject({
      status: "queued",
      statusLabel: "Queued",
      durationMs: null,
      open: true,
    });
    const listed = (await owner.get("/tasks")).body.tasks.find(
      (task: { id: string }) => task.id === id,
    );
    expect(listed).toMatchObject({ running: true, lastRun: { status: "queued" } });
    expect((await owner.post(`/tasks/${id}/run`, {})).status).toBe(409);
    // The next due time is skipped for what it is: the run before it never started.
    expect(await due()).toEqual({ started: 0, skipped: 1 });
    const waiting = (await owner.get(`/tasks/${id}/runs`)).body.runs.find(
      (run: { status: string }) => run.status === "skipped",
    );
    expect(waiting.error).toBe(TASK_MESSAGES.skippedQueued);
    expect(waiting.error).not.toBe(TASK_MESSAGES.skipped);
    // It waited ten minutes for a lane; its start time and duration leave the wait out.
    await h.test.db
      .updateTable("task_run")
      .set({ started_at: new Date(Date.now() - 10 * 60_000) })
      .where("id", "=", queued.id)
      .execute();
    await h.test.db.deleteFrom("job").where("kind", "=", "tasks.tick").execute();
    const jobs = runJobs();
    let running: { status: string; startedAt: string; durationMs: number } | null = null;
    for (let i = 0; i < 300 && running?.status !== "running"; i++) {
      await Bun.sleep(20);
      running = (await owner.get(`/task-runs/${queued.id}`)).body.run;
    }
    expect(running?.status).toBe("running");
    expect(Date.now() - Date.parse(String(running?.startedAt))).toBeLessThan(60_000);
    expect(Number(running?.durationMs)).toBeLessThan(60_000);
    // From now on it is going, and a due time says so.
    expect(await due()).toEqual({ started: 0, skipped: 1 });
    const skips = (await owner.get(`/tasks/${id}/runs`)).body.runs
      .filter((run: { status: string }) => run.status === "skipped")
      .map((run: { error: string }) => run.error)
      .sort();
    expect(skips).toEqual([TASK_MESSAGES.skipped, TASK_MESSAGES.skippedQueued].sort());
    expect((await owner.post(`/task-runs/${queued.id}/stop`, {})).status).toBe(200);
    await jobs;
  });

  test("Run pressed while the scheduler records a due run waits for it instead of deadlocking", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Racing",
      place: "container",
      serviceId: web.id,
      script: "echo hi",
    });
    const taskId = created.body.task.id as string;
    // The tick's transaction: it locks the task, then records the due run a moment later.
    let pressed: Promise<unknown> | null = null;
    await h.test.db.transaction().execute(async (trx) => {
      await trx.selectFrom("task").select("id").where("id", "=", taskId).forUpdate().execute();
      pressed = startRun(h.test.db, taskId, "manual", null);
      await Bun.sleep(400);
      await trx
        .insertInto("task_run")
        .values({ task_id: taskId, trigger: "schedule", status: "queued", due_at: new Date() })
        .execute();
    });
    // Run sees the tick's run once the tick commits: "running already", not a deadlock.
    expect(await pressed).toBeNull();
    const open = await h.test.db
      .selectFrom("task_run")
      .select("trigger")
      .where("task_id", "=", taskId)
      .execute();
    expect(open).toEqual([{ trigger: "schedule" }]);
  });

  test("Stop on a queued run ends it before it starts", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Never started",
      place: "container",
      serviceId: web.id,
      script: "echo hi",
    });
    const before = runner.commandsOf("task.run").length;
    const started = await owner.post(`/tasks/${created.body.task.id}/run`, {});
    expect(started.status).toBe(202);
    expect(started.body.run.status).toBe("queued");
    const stopped = await owner.post(`/task-runs/${started.body.run.id}/stop`, {});
    expect(stopped.status).toBe(200);
    expect(stopped.body.run.status).toBe("stopped");
    await runJobs();
    expect(runner.commandsOf("task.run")).toHaveLength(before);
  });

  test("a due time that passed while the control plane was stopped is skipped, not run at start (R3-30)", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Missed",
      place: "container",
      serviceId: web.id,
      script: "echo missed",
    });
    const id = created.body.task.id as string;
    // The control plane started a few seconds ago.
    const startedAt = new Date(Date.now() - 5_000);
    await h.test.db
      .updateTable("task")
      .set({ next_run_at: new Date(startedAt.getTime() - 10 * 60_000) })
      .where("id", "=", id)
      .execute();
    // The first tick after the start: nothing runs, and the task waits for its next time.
    expect(await startDueTasks(h.test.db, new Date(), startedAt)).toEqual({
      started: 0,
      skipped: 0,
    });
    expect(await h.test.db.selectFrom("task_run").selectAll().execute()).toEqual([]);
    const waiting = (await owner.get(`/tasks/${id}`)).body.task;
    expect(new Date(waiting.nextRunAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(waiting.nextRunAt).getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(waiting.lastRun).toBeNull();
    // The control plane's own start is what counts: a due time before it is skipped by the
    // tick's default too.
    markSchedulesStarted(h.test.db, startedAt);
    try {
      await h.test.db
        .updateTable("task")
        .set({ next_run_at: new Date(startedAt.getTime() - 60_000) })
        .where("id", "=", id)
        .execute();
      expect(await startDueTasks(h.test.db)).toEqual({ started: 0, skipped: 0 });
      // A due time once it is running runs as usual.
      await h.test.db
        .updateTable("task")
        .set({ next_run_at: new Date(Date.now() - 1000) })
        .where("id", "=", id)
        .execute();
      expect(await startDueTasks(h.test.db)).toEqual({ started: 1, skipped: 0 });
    } finally {
      forgetSchedulesStarted(h.test.db);
    }
    await h.test.db.deleteFrom("job").where("kind", "=", "tasks.tick").execute();
    await runJobs();
    const runs = (await owner.get(`/tasks/${id}/runs`)).body.runs;
    expect(runs.map((item: { status: string }) => item.status)).toEqual(["succeeded"]);
  });

  test("a failing script ends Failed with its exit code", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Fails",
      place: "container",
      serviceId: web.id,
      script: "exit 4",
    });
    const run = (await owner.post(`/tasks/${created.body.task.id}/run`, {})).body.run;
    await runJobs();
    const done = (await owner.get(`/task-runs/${run.id}`)).body.run;
    expect(done).toMatchObject({
      status: "failed",
      exitCode: 4,
      error: "The script exited with code 4.",
    });
  });

  test("a service that isn't running fails the run with the reason", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Off",
      place: "container",
      serviceId: web.id,
      script: "echo",
    });
    runner.containers.clear();
    const run = (await owner.post(`/tasks/${created.body.task.id}/run`, {})).body.run;
    await runJobs();
    const done = (await owner.get(`/task-runs/${run.id}`)).body.run;
    expect(done.status).toBe("failed");
    expect(done.error).toContain("isn't running");
  });

  test("each task keeps its last 100 runs", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Many",
      place: "container",
      serviceId: web.id,
      script: "echo",
    });
    const id = created.body.task.id as string;
    await h.test.db
      .insertInto("task_run")
      .values(
        Array.from({ length: 105 }, (_, index) => ({
          task_id: id,
          trigger: "schedule" as const,
          status: "succeeded" as const,
          started_at: new Date(Date.now() - (200 - index) * 60_000),
          finished_at: new Date(),
        })),
      )
      .execute();
    expect(await pruneRuns(h.test.db, id)).toBe(5);
    expect((await owner.get(`/tasks/${id}/runs`)).body.runs).toHaveLength(100);
  });
});

describe("a run when the control plane restarts (B2-20)", () => {
  test("its job's next attempt follows the script on its server and never starts it again", async () => {
    const web = await app();
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Long",
      place: "container",
      serviceId: web.id,
      script: "sleep 3600",
    });
    const run = (await owner.post(`/tasks/${created.body.task.id}/run`, {})).body.run;
    // The first attempt was under way in a process that stopped; its lease ran out.
    const job = await h.test.db
      .selectFrom("job")
      .select(["id", "max_attempts"])
      .where("kind", "=", "tasks.run")
      .executeTakeFirstOrThrow();
    expect(job.max_attempts).toBe(2);
    await h.test.db.updateTable("job").set({ attempts: 1 }).where("id", "=", job.id).execute();
    const startedBefore = runner.commandsOf("task.run").length;
    await runJobs();
    // The fake runner has nothing going for it, so nothing is started and the run says why.
    expect(runner.commandsOf("task.run")).toHaveLength(startedBefore);
    const done = (await owner.get(`/task-runs/${run.id}`)).body.run;
    expect(done).toMatchObject({ status: "failed", error: TASK_MESSAGES.restarted });
    expect(done.log).toContain("Nearzero restarted while this ran; following it again.");
  });
});

describe("who may use each place (spec 12.4)", () => {
  test("members: their services only; servers need manage rights; the host is for instance administrators", async () => {
    const web = await app("web");
    const other = await app("other");
    const member = await addMember(h, owner, "member@example.com", {
      scope: { serviceIds: [web.id] } as never,
    });
    const places = (await member.get("/tasks/places")).body.places;
    expect(places.services.map((item: { id: string }) => item.id)).toEqual([web.id]);
    expect(places).toMatchObject({ servers: [], host: false });
    const ok = await member.post("/tasks", {
      ...BASE,
      name: "Mine",
      place: "container",
      serviceId: web.id,
      script: "echo",
    });
    expect(ok.status).toBe(201);
    const theirs = await member.post("/tasks", {
      ...BASE,
      name: "Theirs",
      place: "container",
      serviceId: other.id,
      script: "echo",
    });
    expect(theirs.status).toBe(404);
    const host = await member.post("/tasks", {
      ...BASE,
      name: "Host",
      place: "host",
      script: "echo",
    });
    expect(host.status).toBe(403);
    expect(host.body.error.message).toBe(TASK_MESSAGES.hostOnly);
    const ownerTask = await owner.post("/tasks", {
      ...BASE,
      name: "Owner's",
      place: "container",
      serviceId: other.id,
      script: "echo",
    });
    expect((await member.get(`/tasks/${ownerTask.body.task.id}`)).status).toBe(404);
    expect(
      (await member.get("/tasks")).body.tasks.map((task: { name: string }) => task.name),
    ).toEqual(["Mine"]);
  }, 400_000);

  test("the instance owner can create host tasks; they show in the list as Nearzero host", async () => {
    const created = await owner.post("/tasks", {
      ...BASE,
      name: "Host job",
      place: "host",
      script: "echo hi",
    });
    expect(created.status).toBe(201);
    expect(created.body.task.runsOn.label).toBe("Nearzero host");
    expect(runner.commandsOf("task.check").at(-1)?.params).toMatchObject({
      place: "server",
      shell: "bash",
    });
    const list = (await owner.get("/tasks?place=host")).body;
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0].placeLabel).toBe("Nearzero host");
  });
});

describe("host tasks belong to their creator (spec 12.4, spec 30 R3-29)", () => {
  test("another instance administrator doesn't see it and is refused 403 for every change", async () => {
    const mine = await owner.post("/tasks", {
      ...BASE,
      name: "Owner's host job",
      place: "host",
      script: "echo mine",
    });
    expect(mine.status).toBe(201);
    const id = mine.body.task.id as string;
    const run = (await owner.post(`/tasks/${id}/run`, {})).body.run;
    // An admin of the first workspace is an instance administrator too.
    const other = await addMember(h, owner, "admin2@example.com", { role: "admin" });
    expect((await other.get("/tasks/places")).body.places.host).toBe(true);
    expect((await other.get("/tasks?place=host")).body.tasks).toEqual([]);
    expect((await other.get("/tasks")).body.tasks).toEqual([]);
    const refusals = [
      await other.get(`/tasks/${id}`),
      await other.patch(`/tasks/${id}`, { name: "Taken" }),
      await other.post(`/tasks/${id}/run`, {}),
      await other.get(`/tasks/${id}/runs`),
      await other.get(`/task-runs/${run.id}`),
      await other.post(`/task-runs/${run.id}/stop`, {}),
      await other.request("DELETE", `/tasks/${id}`),
    ];
    for (const reply of refusals) {
      expect(reply.status).toBe(403);
      expect(reply.body.error.message).toBe("You can only manage your own host-level schedules.");
    }
    // A member who isn't an administrator is refused the same way.
    const member = await addMember(h, owner, "plain@example.com");
    const asMember = await member.post(`/tasks/${id}/run`, {});
    expect(asMember.status).toBe(403);
    expect(asMember.body.error.message).toBe(TASK_MESSAGES.notYourHostTask);
    // Nothing changed, and the owner still manages it.
    const kept = await h.test.db
      .selectFrom("task")
      .select(["name", "owner_id"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(kept.name).toBe("Owner's host job");
    expect((await owner.get(`/tasks/${id}`)).status).toBe(200);
    // Each administrator's own host tasks are theirs alone.
    const theirs = await other.post("/tasks", {
      ...BASE,
      name: "Admin's host job",
      place: "host",
      script: "echo theirs",
    });
    expect(theirs.status).toBe(201);
    expect(
      (await other.get("/tasks?place=host")).body.tasks.map((task: { name: string }) => task.name),
    ).toEqual(["Admin's host job"]);
    expect(
      (await owner.get("/tasks?place=host")).body.tasks.map((task: { name: string }) => task.name),
    ).toEqual(["Owner's host job"]);
    expect((await owner.request("DELETE", `/tasks/${theirs.body.task.id}`)).status).toBe(403);
    // The Agent acts as the person, with the same rule.
    const agentList = await listTasks(h.services, await actorOf("admin2@example.com"), {});
    expect(agentList.tasks.map((task) => task.name)).toEqual(["Admin's host job"]);
  }, 400_000);

  test("a host task is deleted with its owner's account", async () => {
    const other = await addMember(h, owner, "leaver@example.com", { role: "admin" });
    const theirs = await other.post("/tasks", {
      ...BASE,
      name: "Leaver's host job",
      place: "host",
      script: "echo bye",
    });
    expect(theirs.status).toBe(201);
    const mine = await owner.post("/tasks", {
      ...BASE,
      name: "Stays",
      place: "host",
      script: "echo stay",
    });
    expect(mine.status).toBe(201);
    const leaver = await h.test.db
      .selectFrom("person")
      .select("id")
      .where("email", "=", "leaver@example.com")
      .executeTakeFirstOrThrow();
    await h.test.db.deleteFrom("person").where("id", "=", leaver.id).execute();
    const left = await h.test.db.selectFrom("task").select("name").orderBy("name").execute();
    expect(left.map((row) => row.name)).toEqual(["Stays"]);
  }, 400_000);
});

describe("who sees Tasks (spec 12.1, 24 G8, spec 30 R3-31)", () => {
  test("a member with no app, Compose service or server to use doesn't get Tasks; one with a service does", async () => {
    const web = await app("web");
    expect((await owner.get("/workspace")).body.can.tasks).toBe(true);
    const nothing = await addMember(h, owner, "nothing@example.com", {
      scope: { serviceIds: [] } as never,
    });
    expect((await nothing.get("/workspace")).body.can.tasks).toBe(false);
    const withService = await addMember(h, owner, "service@example.com", {
      scope: { serviceIds: [web.id] } as never,
    });
    expect((await withService.get("/workspace")).body.can.tasks).toBe(true);
    // An admin always may (they reach every place), as does an instance administrator.
    const admin = await addMember(h, owner, "admin3@example.com", { role: "admin" });
    expect((await admin.get("/workspace")).body.can.tasks).toBe(true);
  }, 400_000);
});

describe("the list (spec 12.1) and the Agent's functions (spec 20.12)", () => {
  test("filters, search, sort and paging", async () => {
    const web = await app();
    for (const [name, cron, enabled] of [
      ["Backup", "0 0 * * *", true],
      ["Cleanup", "*/15 * * * *", false],
      ["Audit", "0 * * * *", true],
    ] as const) {
      const reply = await owner.post("/tasks", {
        name,
        cron,
        enabled,
        place: "container",
        serviceId: web.id,
        script: "echo",
        timeZone: "",
      });
      expect(reply.status).toBe(201);
    }
    const byName = (await owner.get("/tasks?sort=name&order=asc")).body;
    expect(byName.tasks.map((task: { name: string }) => task.name)).toEqual([
      "Audit",
      "Backup",
      "Cleanup",
    ]);
    expect(byName.tasks[0].timeZone).toBe("UTC");
    expect(
      (await owner.get("/tasks?status=disabled")).body.tasks.map(
        (task: { name: string }) => task.name,
      ),
    ).toEqual(["Cleanup"]);
    expect(
      (await owner.get("/tasks?search=every%2015")).body.tasks.map(
        (task: { name: string }) => task.name,
      ),
    ).toEqual(["Cleanup"]);
    expect((await owner.get("/tasks?place=servers")).body.total).toBe(0);
    const paged = (await owner.get("/tasks?pageSize=10&page=1")).body;
    expect(paged).toMatchObject({ total: 3, page: 1, pageSize: 10 });
    expect(paged.tasks[0].lastRun).toBeNull();
  });

  test("a task the Agent creates appears on the Tasks page with the same fields; review shows its script and runs", async () => {
    const web = await app();
    const actor = await actorOf("owner@example.com");
    const saved = await createTask(
      h.services,
      actor,
      {
        ...BASE,
        name: "From the Agent",
        place: "container",
        serviceId: web.id,
        script: "echo agent",
      },
      { via: "agent" },
    );
    expect(saved.saved).toBe(true);
    const page = (await owner.get("/tasks")).body;
    expect(page.tasks[0]).toMatchObject({
      name: "From the Agent",
      createdVia: "agent",
      scheduleText: "Every minute",
      timeZone: "Asia/Kolkata",
    });
    const list = await listTasks(h.services, actor, {});
    expect(list.tasks[0]?.runsOn).toEqual(page.tasks[0].runsOn);
    const review = await reviewTask(h.services, actor, list.tasks[0]?.id as string);
    expect(review.task.script).toBe("echo agent");
    expect(review.scriptTruncated).toBe(false);
    expect(review.runs).toEqual([]);
  });
});
