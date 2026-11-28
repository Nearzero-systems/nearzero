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
  DEPLOYMENTS_KEPT_PER_SERVICE,
  NEARZERO_LABELS,
  TERMINAL_NEEDS_WEBSOCKET,
} from "@nearzero/shared";
import { sql } from "kysely";
import { loadGrants, WorkspaceAccess } from "../src/access/grants.ts";
import { ObjectRegistry } from "../src/access/objects.ts";
import { readServiceLogsCapability } from "../src/agent/catalog/deploys.ts";
import { composeBuilds } from "../src/compose-runtime/plan.ts";
import { healthWatch, watchHealth } from "../src/deploys/health-watch.ts";
import { HostnameProviders } from "../src/deploys/hostnames.ts";
import { DeployLog, readLogText } from "../src/deploys/log.ts";
import { pruneDeployments } from "../src/deploys/retention.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { runnerTeardown } from "../src/service-runtime/teardown.ts";
import { secretsContext } from "../src/services/records.ts";
import { storeUpload, uploadForRunner } from "../src/sources/uploads.ts";
import { isInstanceAdmin, resolveActiveWorkspace } from "../src/workspaces/workspaces.ts";
import { FakeRunner } from "./support/fake-runner.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember, makeProject, makeService } from "./support/projects.ts";

/**
 * The deploy engine end to end against a fake runner that speaks the real protocol (spec 6.5,
 * 6.6, 8.1, 11, 23.1, 24 G4, G11): the queue's one-running-one-waiting rule, the pipeline's
 * outcomes (live, failed build, crashing container, cancel), routes from hostname providers,
 * webhooks, runtime actions, permissions, teardown and retention.
 */

setDefaultTimeout(60_000);

let h: Harness;
let runner: FakeRunner;
let worker: JobWorker;
let owner: Browser;

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
  h.services.runners.stop();
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  await sql`truncate job, deployment, project cascade`.execute(h.test.db);
  runner.containers.clear();
  runner.images.clear();
  runner.volumes.clear();
  runner.routes.clear();
  runner.crashing.clear();
  runner.buildFailure = null;
  runner.commands.length = 0;
  h.services.hostnameProviders = new HostnameProviders();
  owner = await setUpNamedOwner(h);
});

/** Runs due jobs until none is left. */
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

async function app(settings: Record<string, unknown> = { image: "nginx:alpine", servicePort: 80 }) {
  const { environments } = await makeProject(owner, "Shop");
  const created = await makeService(owner, environments.development as string, {
    kind: "application",
    name: "web",
    settings,
  });
  const id = created.service.id as string;
  await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
  return {
    id,
    environmentId: environments.development as string,
    appName: created.service.appName as string,
  };
}

async function deploy(serviceId: string, browser = owner) {
  const reply = await browser.post(`/services/${serviceId}/deployments`, {});
  expect(reply.status).toBe(202);
  return reply.body.deployment as { id: string; status: string };
}

async function deployment(id: string) {
  return (await owner.get(`/deployments/${id}`)).body.deployment;
}

async function logOf(id: string): Promise<string> {
  return (await owner.get(`/deployments/${id}/log?lines=all`)).body.text as string;
}

describe("deploying an image (spec 6.5)", () => {
  test("a slow DNS lookup never holds a deploy up: its note follows in the log (punch list 18)", async () => {
    let answer: (lines: string[]) => void = () => {};
    const stalled = new Promise<string[]>((resolve) => {
      answer = resolve;
    });
    h.services.hostnameProviders.register("test", async (request) => ({
      routes: [{ host: "slow.example.test", path: "/", port: request.port, https: false }],
      notes: [],
      later: stalled,
    }));
    const service = await app();
    const started = await deploy(service.id);
    await runJobs();
    expect((await deployment(started.id)).status).toBe("active");
    expect(await logOf(started.id)).not.toContain("slow.example.test: no record");
    answer(["slow.example.test: no record yet."]);
    await eventually("the late note", async () =>
      (await logOf(started.id)).includes("slow.example.test: no record yet."),
    );
    const text = await logOf(started.id);
    expect(text.indexOf("Deployment complete")).toBeLessThan(
      text.indexOf("slow.example.test: no record yet."),
    );
  });

  test("goes live at the provider's hostname, with the version first in the log", async () => {
    h.services.hostnameProviders.register("test", async (request) => ({
      routes: [{ host: "web.example.test", path: "/", port: request.port, https: false }],
      notes: ["web.example.test is assigned, but it won't load until this DNS record exists."],
    }));
    const service = await app();
    const started = await deploy(service.id);
    expect(started.status).toBe("queued");
    await runJobs();
    const done = await deployment(started.id);
    expect(done.status).toBe("active");
    expect(done.urls).toEqual(["http://web.example.test"]);
    const text = await logOf(started.id);
    expect(text.split("\n")[0]).toBe("Initializing deployment (Nearzero 1.0.0-dev)");
    expect(text).toContain("won't load until this DNS record exists");
    expect(text).toContain("Deployment complete. It's live at: http://web.example.test");
    const containers = runner.serviceContainers(service.id);
    expect(containers.map((container) => container.state)).toEqual(["running"]);
    expect(containers[0]?.env.PORT).toBe("80");
    // The pulled image runs as Nearzero's labelled copy, which teardown and uninstall find.
    const pull = runner.commandsOf("image.pull").at(-1)?.params;
    expect(pull).toMatchObject({
      image: "nginx:alpine",
      ownTag: `nearzero/${service.appName}:${started.id.slice(0, 8)}`,
      labels: { [NEARZERO_LABELS.service]: service.id, [NEARZERO_LABELS.deployment]: started.id },
    });
    expect(containers[0]?.image).toBe(String(pull?.ownTag));
    const route = [...runner.routes.values()][0] as { upstream: unknown };
    expect(route.upstream).toEqual({ host: containers[0]?.name, port: 80, scheme: "http" });
    const view = (await owner.get(`/services/${service.id}`)).body.service;
    expect(view.status).toBe("running");
    expect(view.deploy).toMatchObject({
      last: { id: started.id, status: "active", succeeded: true },
      inProgress: null,
    });
    const listed = (await owner.get(`/environments/${service.environmentId}/services`)).body;
    expect(listed.services[0].deploy.last.succeeded).toBe(true);
  });

  test("B1-11: a hostname provider that fails keeps the live routes, sent to the new container", async () => {
    let broken = false;
    h.services.hostnameProviders.register("domains", async (request) => {
      if (broken) throw new Error("connection terminated unexpectedly");
      return {
        routes: [{ host: "shop.example.test", path: "/", port: request.port, https: false }],
        notes: [],
      };
    });
    const service = await app();
    await deploy(service.id);
    await runJobs();
    expect(runner.routes.size).toBe(1);
    // The next deploy meets a database blip in the provider.
    broken = true;
    const second = await deploy(service.id);
    await runJobs();
    expect((await deployment(second.id)).status).toBe("active");
    expect(await logOf(second.id)).toContain("Couldn't get this service's hostnames from domains");
    // The site stays up: the route is kept, and reaches the container that now runs.
    const [running] = runner
      .serviceContainers(service.id)
      .filter((container) => container.state === "running");
    const routes = [...runner.routes.values()] as {
      hostnames: string[];
      upstream: { host: string };
    }[];
    const shop = routes.filter((route) => route.hostnames.includes("shop.example.test"));
    expect(shop).toHaveLength(1);
    expect(shop[0]?.upstream.host).toBe(running?.name);
    const saved = (
      await h.test.db.selectFrom("router_route").select(["hostnames", "spec"]).execute()
    )
      .filter((row) => row.hostnames.includes("shop.example.test"))
      .map((row) => (row.spec as { upstream: { host: string } }).upstream.host);
    expect(saved).toEqual([running?.name as string]);
  });

  test("R2-15, G2-05: a server builds one app at a time; only builds wait, and their log says why", async () => {
    const first = await app();
    const gitApp = async (name: string) => {
      const made = (
        await makeService(owner, first.environmentId, {
          kind: "application",
          name,
          settings: { servicePort: 3000 },
        })
      ).service as { id: string };
      await owner.patch(`/services/${made.id}/deploy-settings`, { stabilitySeconds: 0 });
      await owner.put(`/services/${made.id}/source`, {
        type: "git",
        url: "https://git.example.test/acme/web.git",
        branch: "main",
      });
      return made.id;
    };
    const builder = await gitApp("builder");
    const second = await gitApp("api");
    // An image app that is live, to reload, and a Postgres database, to deploy and make public.
    const reloadable = await deploy(first.id);
    await runJobs();
    expect((await deployment(reloadable.id)).status).toBe("active");
    const { environments } = await makeProject(owner, "Data");
    const database = (
      await makeService(owner, environments.development as string, {
        kind: "postgres",
        name: "db",
        settings: { password: "pg-pass-1234" },
      })
    ).service as { id: string };

    // Another app's build is running on the host (its job is held aside here).
    const building = await deploy(builder);
    await h.test.db
      .updateTable("deployment")
      .set({ status: "building", builds: true })
      .where("id", "=", building.id)
      .execute();
    await h.test.db.updateTable("job").set({ state: "succeeded" }).execute();

    // These build nothing, so they start at once (G2-05).
    const pulled = await deploy(first.id);
    const dbDeploy = await deploy(database.id);
    await runJobs();
    expect((await deployment(pulled.id)).status).toBe("active");
    expect((await deployment(dbDeploy.id)).status).toBe("active");
    const reloaded = await owner.post(`/services/${first.id}/reload`, {});
    expect(reloaded.status).toBe(200);
    await runJobs();
    expect((await deployment(reloaded.body.deploymentId)).status).toBe("active");
    const madePublic = await owner.post(`/services/${database.id}/public`, { public: true });
    expect(madePublic.status).toBe(200);
    await runJobs();
    expect((await deployment(madePublic.body.deployment.id)).status).toBe("active");
    const reloadedRow = await h.test.db
      .selectFrom("deployment")
      .select("builds")
      .where("id", "=", reloaded.body.deploymentId)
      .executeTakeFirstOrThrow();
    expect(reloadedRow.builds).toBe(false);

    // A build waits for the server's build.
    const waiting = await deploy(second);
    await runJobs();
    expect((await deployment(waiting.id)).status).toBe("queued");
    expect(await logOf(waiting.id)).toContain(
      "Queued: this deploy builds, and Nearzero host builds one app at a time. It starts when the build running there ends.",
    );
    // Waiting used no attempt, and the job is back in the queue.
    const job = await h.test.db
      .selectFrom("job")
      .select(["state", "attempts"])
      .where("kind", "=", "deploys.run")
      .where("state", "=", "queued")
      .executeTakeFirstOrThrow();
    expect(job).toEqual({ state: "queued", attempts: 0 });
    // Once the other build is done, it goes ahead.
    await h.test.db
      .updateTable("deployment")
      .set({ status: "failed" })
      .where("id", "=", building.id)
      .execute();
    await h.test.db
      .updateTable("job")
      .set({ run_at: new Date(0) })
      .where("state", "=", "queued")
      .execute();
    await runJobs();
    expect((await deployment(waiting.id)).status).toBe("active");
  });

  test("the daily Docker cleanup and deploys never run at once on a server (G3-03)", async () => {
    const service = await app();
    const queue = new JobQueue(h.test.db, { workerId: "test" });
    // A deploy is going on the host when its 23:50 cleanup comes due.
    const building = await deploy(service.id);
    await h.test.db
      .updateTable("deployment")
      .set({ status: "building" })
      .where("id", "=", building.id)
      .execute();
    await h.test.db.updateTable("job").set({ state: "succeeded" }).execute();
    runner.commands.length = 0;
    await queue.enqueue({
      kind: "servers.docker-cleanup",
      payload: { target: "host", localDate: "2026-11-28" },
      idempotencyKey: "docker-cleanup:host:2026-11-28",
    });
    await runJobs();
    expect(runner.commands.some((command) => command.kind === "system.prune")).toBe(false);
    const waiting = await h.test.db
      .selectFrom("job")
      .select(["state", "attempts"])
      .where("kind", "=", "servers.docker-cleanup")
      .executeTakeFirstOrThrow();
    expect(waiting).toEqual({ state: "queued", attempts: 0 });
    // The deploy ends: the cleanup runs.
    await h.test.db
      .updateTable("deployment")
      .set({ status: "failed" })
      .where("id", "=", building.id)
      .execute();
    await h.test.db
      .updateTable("job")
      .set({ run_at: new Date(0) })
      .where("state", "=", "queued")
      .execute();
    await runJobs();
    expect(runner.commands.some((command) => command.kind === "system.prune")).toBe(true);

    // While a cleanup runs, a deploy started then waits for it, and says why.
    await h.test.db
      .updateTable("job")
      .set({
        state: "running",
        locked_by: "another-worker",
        locked_until: new Date(Date.now() + 600_000),
      })
      .where("kind", "=", "servers.docker-cleanup")
      .execute();
    const later = await deploy(service.id);
    await runJobs();
    expect((await deployment(later.id)).status).toBe("queued");
    expect(await logOf(later.id)).toContain(
      "Queued: the daily Docker cleanup is running on Nearzero host. This deploy starts when it ends, so the cleanup can't remove its image.",
    );
    await h.test.db
      .updateTable("job")
      .set({ state: "succeeded", locked_by: null, locked_until: null })
      .where("kind", "=", "servers.docker-cleanup")
      .execute();
    await h.test.db
      .updateTable("job")
      .set({ run_at: new Date(0) })
      .where("state", "=", "queued")
      .execute();
    await runJobs();
    expect((await deployment(later.id)).status).toBe("active");
  });

  test("a Compose stack builds only when one of its services has a build step (G2-05)", () => {
    expect(
      composeBuilds({
        source: { type: "raw", composeFile: "services:\n  web:\n    image: nginx\n" },
      }),
    ).toBe(false);
    expect(
      composeBuilds({ source: { type: "raw", composeFile: "services:\n  web:\n    build: .\n" } }),
    ).toBe(true);
    const repository = { type: "git", url: "https://git.example.test/a/b.git", branch: "main" };
    expect(composeBuilds({ source: repository })).toBe(true);
    expect(
      composeBuilds({
        source: repository,
        composeInventory: { services: [{ name: "web", build: false }] },
      }),
    ).toBe(false);
    expect(
      composeBuilds({
        source: repository,
        composeInventory: {
          services: [
            { name: "web", build: false },
            { name: "api", build: true },
          ],
        },
      }),
    ).toBe(true);
  });

  test("with no hostname provider the app deploys with no hostname and the log says so", async () => {
    const service = await app();
    const started = await deploy(service.id);
    await runJobs();
    expect((await deployment(started.id)).status).toBe("active");
    expect(await logOf(started.id)).toContain("This app has no domain yet");
    expect(runner.routes.size).toBe(0);
  });

  test("a redeploy replaces the old container only after the new one runs, and keeps history", async () => {
    const service = await app();
    const first = await deploy(service.id);
    await runJobs();
    const second = await deploy(service.id);
    await runJobs();
    expect((await deployment(first.id)).status).toBe("previous");
    expect((await deployment(second.id)).status).toBe("active");
    const containers = runner.serviceContainers(service.id);
    expect(containers).toHaveLength(1);
    expect(containers[0]?.labels[NEARZERO_LABELS.deployment]).toBe(second.id);
    const listed = (await owner.get(`/services/${service.id}/deployments`)).body.deployments;
    expect(listed.map((item: { statusLabel: string }) => item.statusLabel)).toEqual([
      "Active",
      "Previous version",
    ]);
  });

  test("each deployment records what started it: Manual, Redeploy (header or a deployment's page) (6.3)", async () => {
    const service = await app();
    const manual = await deploy(service.id);
    await runJobs();
    const header = await owner.post(`/services/${service.id}/deployments`, { redeploy: true });
    expect(header.status).toBe(202);
    await runJobs();
    const again = await owner.post(`/deployments/${manual.id}/redeploy`, {});
    expect(again.status).toBe(202);
    await runJobs();
    const listed = (await owner.get(`/services/${service.id}/deployments`)).body.deployments;
    expect(
      listed.map((item: { trigger: string; title: string }) => [item.trigger, item.title]),
    ).toEqual([
      ["redeploy", "Redeploy"],
      ["redeploy", "Redeploy"],
      ["manual", "Manual deployment"],
    ]);
  });

  test("a container that exits right after start fails the deploy with its last output; the old one keeps serving", async () => {
    const service = await app();
    const first = await deploy(service.id);
    await runJobs();
    await owner.patch(`/services/${service.id}`, { settings: { image: "broken:1" } });
    runner.crashing.set("broken:1", "Error: Cannot find module '/app/server.js'\n");
    const second = await deploy(service.id);
    await runJobs();
    const failed = await deployment(second.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("exited with code 1");
    const log = await owner.get(`/deployments/${second.id}/log`);
    expect(log.body.text).toContain("Cannot find module '/app/server.js'");
    expect(log.body.failure.message).toMatch(/^Failure detected on line \d+: /);
    expect((await deployment(first.id)).status).toBe("active");
    const containers = runner.serviceContainers(service.id);
    expect(containers.map((container) => container.labels[NEARZERO_LABELS.deployment])).toEqual([
      first.id,
    ]);
    expect(containers[0]?.state).toBe("running");
  });

  test("a crashed container's last output is cleaned before it reaches the log (G2-01)", async () => {
    const service = await app({ image: "printer:1", servicePort: 80 });
    await owner.put(`/services/${service.id}/variables`, {
      text: "DATABASE_URL=postgres://app:url-secret-value@db:5432/app\nAPI_TOKEN=tok-9f8e7d6c5b\n",
    });
    // The report's app: it prints its DATABASE_URL, a connection error and colour codes, exits 1.
    runner.crashing.set(
      "printer:1",
      [
        ...Array.from({ length: 80 }, (_, i) => `line ${i}`),
        "\u001b[32mstarting\u001b[0m",
        "DATABASE_URL is postgres://app:url-secret-value@db:5432/app",
        "token tok-9f8e7d6c5b",
        "connect failed: postgres://app:s3cret@db:5432/app",
        "\u001b]0;title\u0007bell\u0007 and a\rcarriage",
        "Error: exiting",
        "",
      ].join("\n"),
    );
    const started = await deploy(service.id);
    await runJobs();
    expect((await deployment(started.id)).status).toBe("failed");
    const text = await logOf(started.id);
    expect(text).toContain("Its last output:");
    expect(text).toContain("Error: exiting");
    expect(text).not.toContain("url-secret-value");
    expect(text).not.toContain("tok-9f8e7d6c5b");
    expect(text).not.toContain("s3cret");
    expect(text).toContain("connect failed: postgres://[credentials-redacted]@db:5432/app");
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).toContain("\nstarting\n");
    expect(text).toContain("DATABASE_URL is [redacted]");
    expect(text).toContain("bell and a\ncarriage");
    // Only the last 60 lines are kept.
    expect(text).not.toContain("line 25\n");
    expect(text).toContain("line 79");

    // A database container that fails to start is cleaned the same way.
    const { environments } = await makeProject(owner, "Data");
    const db = await makeService(owner, environments.development as string, {
      kind: "postgres",
      name: "db",
      settings: { password: "pg-pass-4242" },
    });
    const dbId = db.service.id as string;
    const image = (
      await h.test.db
        .selectFrom("service")
        .select("settings")
        .where("id", "=", dbId)
        .executeTakeFirstOrThrow()
    ).settings?.image as string;
    runner.crashing.set(image, "FATAL: password pg-pass-4242 rejected\n");
    const dbDeploy = await deploy(dbId);
    await runJobs();
    expect((await deployment(dbDeploy.id)).status).toBe("failed");
    const dbLog = await logOf(dbDeploy.id);
    expect(dbLog).toContain("FATAL: password [redacted] rejected");
    expect(dbLog).not.toContain("pg-pass-4242");
  });

  test("a build log over 5 MB keeps its beginning and its end, where the error is (G2-02)", async () => {
    const service = await app();
    const started = await deploy(service.id);
    await runJobs();
    await h.test.db
      .updateTable("deployment")
      .set({ status: "failed" })
      .where("id", "=", started.id)
      .execute();
    const log = await DeployLog.open(h.test.db, started.id);
    log.line("Building with Nixpacks");
    // The report's build: 8 MB of progress, a line of the pipeline's own in the middle, then
    // the compiler's error.
    const chunk = Array.from({ length: 800 }, (_, i) => `npm info progress step ${i} ok`).join(
      "\n",
    );
    for (let written = 0; written < 8 * 1024 * 1024; written += chunk.length + 1) {
      log.output(`${chunk}\n`);
      if (written > 4 * 1024 * 1024 && written < 4 * 1024 * 1024 + chunk.length + 1) {
        log.line("Still building.");
      }
    }
    log.output("src/index.ts:3:7 - compiling index.ts\n");
    log.output(
      "src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n",
    );
    log.line("The Nixpacks build failed (exit code 1).");
    await log.flush();
    const read = (await owner.get(`/deployments/${started.id}/log?lines=all`)).body;
    const text = read.text as string;
    expect(text).toContain("Building with Nixpacks");
    expect(text).toContain("npm info progress step 0 ok");
    expect(text).toContain("Still building.");
    expect(text).toContain(
      "src/index.ts:3:7 - compiling index.ts\nsrc/index.ts(3,7): error TS2322",
    );
    expect(text).toMatch(
      /… \d+\.\d MB of output \([\d,]+ lines\) from the middle of this log were left out here\./,
    );
    expect(text).not.toContain("the rest of this step's output is not stored");
    expect(Buffer.byteLength(text)).toBeLessThan(5.2 * 1024 * 1024);
    // Whole lines only on both sides of what was left out.
    expect(
      text.split("\n").filter((line) => line.startsWith("npm info") && !line.endsWith(" ok")),
    ).toEqual([]);
    expect(read.truncated).toBe(true);
    expect(read.failure.message).toBe(
      "Failure detected on line " +
        String(text.split("\n").findIndex((line) => line.includes("error TS2322")) + 1) +
        ": src/index.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    const row = await h.test.db
      .selectFrom("deployment")
      .select(["log_bytes", "log_lines"])
      .where("id", "=", started.id)
      .executeTakeFirstOrThrow();
    const stored = (await readLogText(h.test.db, started.id)).text;
    expect(row.log_bytes).toBe(Buffer.byteLength(stored));
    expect(row.log_lines).toBe((stored.match(/\n/g) ?? []).length);
  });

  test("a moved file mount over 1 MB fails the deploy plainly before anything runs (G4-16)", async () => {
    const service = await app();
    // What a move from 0.1.x keeps: the mount and its content, sealed (0.1.x had no limit).
    await h.test.db
      .updateTable("service")
      .set({
        settings: sql`settings || ${JSON.stringify({
          mounts: [{ type: "file", id: "m1", containerPath: "/etc/ssl/bundle.pem" }],
        })}::jsonb`,
        secrets_sealed: h.services.secrets.seal(
          JSON.stringify({ files: { m1: "x".repeat(1_500_000) } }),
          secretsContext(service.id),
        ),
      })
      .where("id", "=", service.id)
      .execute();
    runner.commands.length = 0;
    const started = await deploy(service.id);
    await runJobs();
    const failed = await deployment(started.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toBe(
      "The file mount at /etc/ssl/bundle.pem holds 1.4 MB. A file mount can hold up to 1 MB. Put the file in a volume, or make it smaller on the Advanced tab, then deploy.",
    );
    expect(runner.commands.some((command) => command.kind === "image.pull")).toBe(false);
    expect(runner.commands.some((command) => command.kind === "container.create")).toBe(false);
  });

  test("runtime log lines start with the time Docker recorded for them (G4-15)", async () => {
    const service = await app();
    const started = await deploy(service.id);
    await runJobs();
    expect((await deployment(started.id)).status).toBe("active");
    for (const container of runner.serviceContainers(service.id)) {
      container.output = "listening on 80\nGET / 200\n";
    }
    runner.commands.length = 0;
    const cookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const response = await h.app.request(`/api/v1/services/${service.id}/logs?follow=0&tail=100`, {
      headers: { cookie },
    });
    const text = await response.text();
    expect(text).toContain("2026-11-28T10:15:30.123456789Z listening on 80");
    expect(text).toContain("2026-11-28T10:15:30.123456789Z GET / 200");
    expect(
      runner.commands.find((command) => command.kind === "container.logs")?.params,
    ).toMatchObject({ timestamps: true });
    // The Agent's read has the times too.
    const person = await h.test.db
      .selectFrom("person")
      .select("id")
      .where("email", "=", "owner@example.com")
      .executeTakeFirstOrThrow();
    const workspace = await resolveActiveWorkspace(h.test.db, {
      id: crypto.randomUUID(),
      personId: person.id,
      activeWorkspaceId: null,
    });
    if (!workspace) throw new Error("no workspace");
    const isAdmin = await isInstanceAdmin(h.test.db, person.id);
    const actor = {
      personId: person.id,
      email: "owner@example.com",
      sessionId: "agent",
      clientAddress: "127.0.0.1",
      secure: false,
      userAgent: null,
      workspace,
      role: workspace.role,
      isInstanceAdmin: isAdmin,
      access: new WorkspaceAccess(
        h.test.db,
        h.services.objects,
        await loadGrants(h.test.db, {
          personId: person.id,
          workspaceId: workspace.id,
          role: workspace.role,
          isInstanceAdmin: isAdmin,
        }),
      ),
    };
    const read = await readServiceLogsCapability.run(
      { services: h.services, actor, signal: new AbortController().signal } as never,
      { service: "web" } as never,
    );
    expect(JSON.stringify(read)).toContain("2026-11-28T10:15:30.123456789Z GET / 200");
  });

  test("an app whose health check fails after its deploy gets a fresh container; one that keeps failing is reported (G2-06)", async () => {
    const service = await app();
    const first = await deploy(service.id);
    await runJobs();
    expect((await deployment(first.id)).status).toBe("active");
    const markUnhealthy = () => {
      for (const container of runner.serviceContainers(service.id)) {
        container.statusText = "Up 1 hour (unhealthy)";
      }
    };
    const watch = async () => {
      await runner.sendState();
      return watchHealth(h.services);
    };
    // Seen once: it may recover by itself, so nothing happens yet.
    markUnhealthy();
    const saved = { ...healthWatch };
    healthWatch.graceMs = 200;
    try {
      expect(await watch()).toEqual({ replaced: [], reported: [] });
      await Bun.sleep(250);
      expect(await watch()).toEqual({ replaced: [service.id], reported: [] });
      await runJobs();
      const listed = (await owner.get(`/services/${service.id}/deployments`)).body.deployments as {
        id: string;
        title: string;
        status: string;
      }[];
      const fresh = listed[0] as { id: string; title: string; status: string };
      expect(fresh.title).toBe("Health check failing: replaced with a fresh container");
      expect((await deployment(fresh.id)).status).toBe("active");
      expect(await logOf(fresh.id)).toContain(
        "The running container kept failing its health check, so Nearzero replaces it with a fresh one.",
      );
      const containers = runner.serviceContainers(service.id);
      expect(containers.map((item) => item.labels[NEARZERO_LABELS.deployment])).toEqual([fresh.id]);
      // A healthy container is left alone.
      expect(await watch()).toEqual({ replaced: [], reported: [] });
      // Two more replacements, then one that still fails: reported, not restarted again.
      for (let round = 0; round < 2; round++) {
        markUnhealthy();
        await watch();
        await Bun.sleep(250);
        expect((await watch()).replaced).toEqual([service.id]);
        await runJobs();
      }
      markUnhealthy();
      await watch();
      await Bun.sleep(250);
      expect(await watch()).toEqual({ replaced: [], reported: [service.id] });
      const after = (await owner.get(`/services/${service.id}/deployments`)).body.deployments as {
        title: string;
        status: string;
        error: string | null;
      }[];
      expect(after[0]).toMatchObject({
        title: "Health check still failing after replacements",
        status: "failed",
      });
      expect(after[0]?.error).toContain("web keeps failing its health check");
      const outbox = await h.test.db
        .selectFrom("notification_outbox")
        .select("payload")
        .where("event", "like", "%deploy%")
        .execute();
      expect(JSON.stringify(outbox)).toContain("keeps failing its health check");
      // Said once: the next check neither restarts nor reports it again.
      await Bun.sleep(250);
      expect(await watch()).toEqual({ replaced: [], reported: [] });
    } finally {
      Object.assign(healthWatch, saved);
    }
  });

  test("a missing variable reference fails the deploy with its name", async () => {
    const service = await app();
    await owner.put(`/services/${service.id}/variables`, {
      // A reference to a shared variable that doesn't exist.
      text: ["API=$", "{{environment.MISSING}}\n"].join(""),
    });
    const started = await deploy(service.id);
    await runJobs();
    const failed = await deployment(started.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("MISSING");
    expect(await logOf(started.id)).toContain("MISSING");
  });
});

describe("building from Git (spec 6.4, 6.5)", () => {
  async function gitApp() {
    const service = await app({ servicePort: 3000 });
    const saved = await owner.put(`/services/${service.id}/source`, {
      type: "git",
      url: "https://git.example.test/acme/web.git",
      branch: "main",
    });
    expect(saved.status).toBe(200);
    return service;
  }

  test("records the commit and builder, and a failed build leaves the old version serving", async () => {
    const service = await gitApp();
    const first = await deploy(service.id);
    await runJobs();
    const live = await deployment(first.id);
    expect(live.status).toBe("active");
    expect(live.shortCommit).toBe("0123456");
    expect(live.title).toBe("Add the home page");
    expect(live.builder).toBe("dockerfile");
    expect(live.source).toMatchObject({
      type: "git",
      branch: "main",
      provider: "git.example.test",
    });
    runner.buildFailure = "failed to solve: process did not complete successfully";
    const second = await deploy(service.id);
    await runJobs();
    expect((await deployment(second.id)).status).toBe("failed");
    expect((await deployment(first.id)).status).toBe("active");
    expect(runner.serviceContainers(service.id)).toHaveLength(1);
  });

  test("credentials inside the URL are refused", async () => {
    const service = await app();
    const reply = await owner.put(`/services/${service.id}/source`, {
      type: "git",
      url: "https://user:token@github.com/acme/web.git",
    });
    expect(reply.status).toBe(400);
    expect(reply.body.error.message).toContain("Credentials inside the URL are refused");
  });

  test("one runs, one waits: requests during a build queue exactly one more (spec 6.6)", async () => {
    const service = await gitApp();
    runner.holdBuilds();
    const first = await deploy(service.id);
    const running = worker.runOnce();
    await eventually("the build", async () => (await deployment(first.id)).status === "building");
    // Logs of a building or queued deployment are never "complete": clients follow the stream.
    const building = await owner.get(`/deployments/${first.id}/log`);
    expect(building.body.complete).toBe(false);
    const second = await owner.post(`/services/${service.id}/deployments`, {});
    const third = await owner.post(`/services/${service.id}/deployments`, {});
    expect(second.body.waiting).toBe(true);
    const queued = await owner.get(`/deployments/${second.body.deployment.id}/log`);
    expect(queued.body).toMatchObject({ complete: false, text: "" });
    expect(third.body.replaced).toBe(true);
    expect(third.body.deployment.id).toBe(second.body.deployment.id);
    runner.releaseBuilds();
    await running;
    await runJobs();
    const all = (await owner.get(`/services/${service.id}/deployments`)).body.deployments;
    expect(all).toHaveLength(2);
    expect(all.map((item: { status: string }) => item.status)).toEqual(["active", "previous"]);
    expect((await owner.get(`/deployments/${first.id}/log`)).body.complete).toBe(true);
  });

  test("cancel stops a building deployment and the running version keeps serving (spec 11.2)", async () => {
    const service = await gitApp();
    const first = await deploy(service.id);
    await runJobs();
    runner.holdBuilds();
    const second = await deploy(service.id);
    const running = worker.runOnce();
    await eventually("the build", async () => (await deployment(second.id)).status === "building");
    const cancelled = await owner.post(`/deployments/${second.id}/cancel`, {});
    expect(cancelled.body.stopping).toBe(true);
    await running;
    runner.releaseBuilds();
    expect((await deployment(second.id)).status).toBe("cancelled");
    expect((await deployment(first.id)).status).toBe("active");
    expect(await logOf(second.id)).toContain("Cancelled. The running version keeps serving.");
  });

  test("cancel of a queued deployment ends it at once", async () => {
    const service = await gitApp();
    const builds = runner.builds;
    const started = await deploy(service.id);
    const cancelled = await owner.post(`/deployments/${started.id}/cancel`, {});
    expect(cancelled.body.cancelled).toBe(true);
    await runJobs();
    expect((await deployment(started.id)).status).toBe("cancelled");
    expect(runner.builds).toBe(builds);
  });
});

describe('a volume kept by name (spec 29.5 "Volumes")', () => {
  test("is the volume the container mounts, and stays when the mounts are saved again", async () => {
    const service = await app();
    const row = await h.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", service.id)
      .executeTakeFirstOrThrow();
    const kept = {
      type: "volume",
      id: "keptmount1",
      name: "html",
      containerPath: "/usr/share/nginx/html",
      volume: "web-move-html",
    };
    await h.test.db
      .updateTable("service")
      .set({ settings: JSON.stringify({ ...(row.settings ?? {}), mounts: [kept] }) })
      .where("id", "=", service.id)
      .execute();
    runner.commands.length = 0;
    await deploy(service.id);
    await runJobs();
    expect(runner.volumes.has("web-move-html")).toBe(true);
    expect(runner.volumes.has(`${service.appName}-html`)).toBe(false);
    const created = runner.commands.find((command) => command.kind === "container.create");
    expect(created?.params.mounts).toEqual([
      { type: "volume", source: "web-move-html", target: "/usr/share/nginx/html", readOnly: false },
    ]);
    const saved = await owner.put(`/services/${service.id}/mounts`, {
      mounts: [{ type: "volume", id: "keptmount1", name: "html", containerPath: "/srv/html" }],
    });
    expect(saved.status).toBe(200);
    const after = await h.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", service.id)
      .executeTakeFirstOrThrow();
    expect((after.settings as { mounts: unknown[] }).mounts).toEqual([
      {
        type: "volume",
        id: "keptmount1",
        name: "html",
        containerPath: "/srv/html",
        volume: "web-move-html",
      },
    ]);
  });
});

describe("the live log (spec 11.2)", () => {
  test("streams the stored log and resumes after Last-Event-ID without repeating", async () => {
    const service = await app();
    const started = await deploy(service.id);
    await runJobs();
    const response = await h.app.request(`/api/v1/deployments/${started.id}/events`, {
      headers: { cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ") },
    });
    const text = await response.text();
    expect(text).toContain("event: open");
    expect(text).toContain("Initializing deployment");
    expect(text).toContain("event: end");
    const ids = [...text.matchAll(/^id: (.+)$/gm)].map((match) => match[1] as string);
    const resumed = await h.app.request(`/api/v1/deployments/${started.id}/events`, {
      headers: {
        cookie: [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "last-event-id": ids[0] as string,
      },
    });
    const rest = await resumed.text();
    expect(rest).not.toContain("Initializing deployment");
    expect(rest).toContain("event: end");
  });
});

describe("deploy webhooks (spec 6.6, G4)", () => {
  async function webhook(serviceId: string): Promise<string> {
    const created = await owner.post(`/services/${serviceId}/webhook`, {});
    expect(created.status).toBe(200);
    return new URL(created.body.url).pathname.replace("/api/v1", "");
  }

  test("deploys, is shown again to people who can deploy, and a replaced URL answers 401", async () => {
    const service = await app();
    const path = await webhook(service.id);
    expect((await owner.get(`/services/${service.id}/webhook`)).body.url).toContain(path);
    const call = await h.browser().post(path, {});
    expect(call.status).toBe(202);
    await owner.post(`/services/${service.id}/webhook`, {});
    const old = await h.browser().post(path, {});
    expect(old.status).toBe(401);
    expect(JSON.stringify(old.body)).not.toContain("nzw1");
  });

  test("a burst of calls queues one deploy", async () => {
    const service = await app();
    const path = await webhook(service.id);
    const calls = await Promise.all(Array.from({ length: 20 }, () => h.browser().post(path, {})));
    expect(calls.every((call) => call.status === 202)).toBe(true);
    const rows = await h.test.db
      .selectFrom("deployment")
      .select("status")
      .where("service_id", "=", service.id)
      .execute();
    expect(rows).toEqual([{ status: "queued" }]);
  });

  test("ignored when Autodeploy is off, and pushes elsewhere don't deploy", async () => {
    const service = await app();
    await owner.put(`/services/${service.id}/source`, {
      type: "git",
      url: "https://git.example.test/acme/web.git",
      branch: "main",
      watchPaths: ["src/**"],
    });
    const path = await webhook(service.id);
    const docs = await h.browser().post(path, {
      ref: "refs/heads/main",
      after: "abcdef1234567",
      commits: [{ added: [], modified: ["docs/readme.md"], removed: [] }],
    });
    expect(docs.body.deployed).toBe(false);
    const other = await h.browser().post(path, { ref: "refs/heads/feature" });
    expect(other.body.deployed).toBe(false);
    const src = await h.browser().post(path, {
      ref: "refs/heads/main",
      after: "abcdef1234567",
      commits: [{ added: ["src/index.ts"], modified: [], removed: [] }],
      head_commit: { message: "Fix the cart\n\nlonger text" },
    });
    expect(src.status).toBe(202);
    const row = await h.test.db
      .selectFrom("deployment")
      .select(["requested_commit", "title", "trigger"])
      .where("id", "=", src.body.deploymentId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({
      requested_commit: "abcdef1234567",
      title: "Fix the cart",
      trigger: "webhook",
    });
    await owner.patch(`/services/${service.id}/deploy-settings`, { autodeploy: false });
    const off = await h.browser().post(path, {});
    expect(off.body.deployed).toBe(false);
    expect(off.body.message).toContain("Autodeploy is off");
  });
});

describe("runtime actions (spec 6.2, 8.2)", () => {
  test("stop, start and reload act on the deployed container", async () => {
    const service = await app();
    const started = await deploy(service.id);
    await runJobs();
    expect((await owner.post(`/services/${service.id}/stop`, {})).body.status).toBe("stopped");
    expect((await deployment(started.id)).status).toBe("not_running");
    expect(runner.serviceContainers(service.id)[0]?.state).toBe("exited");
    expect((await owner.post(`/services/${service.id}/start`, {})).body.status).toBe("running");
    expect((await deployment(started.id)).status).toBe("active");
    // Reload starts the running image again with the saved settings, as a deploy (30b R2-02).
    const reloaded = await owner.post(`/services/${service.id}/reload`, {});
    expect(reloaded.body.message).toContain("Reloading with the saved settings");
    await runJobs();
    expect((await deployment(reloaded.body.deploymentId)).status).toBe("active");
    const runtime = (await owner.get(`/services/${service.id}/runtime`)).body;
    expect(runtime.containers).toHaveLength(1);
    expect(runtime.containers[0].current).toBe(true);
  });

  test("ports must be unique on the server and keep clear of Nearzero's own", async () => {
    const a = await app();
    const reserved = await owner.put(`/services/${a.id}/ports`, {
      ports: [{ containerPort: 80, publishedPort: 443 }],
    });
    expect(reserved.status).toBe(409);
    const ok = await owner.put(`/services/${a.id}/ports`, {
      ports: [{ containerPort: 53, publishedPort: 5353, protocol: "udp" }],
    });
    expect(ok.status).toBe(200);
    const { environments } = await makeProject(owner, "Other");
    const b = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "dns",
      settings: { image: "coredns:1" },
    });
    const clash = await owner.put(`/services/${b.service.id}/ports`, {
      ports: [{ containerPort: 53, publishedPort: 5353, protocol: "udp" }],
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toContain("already published");
  });

  test("file mounts are stored sealed, never shown, and reach the container", async () => {
    const service = await app();
    const saved = await owner.put(`/services/${service.id}/mounts`, {
      mounts: [
        { type: "volume", name: "data", containerPath: "/data" },
        {
          type: "file",
          containerPath: "/etc/app/config.json",
          content: '{"secret":"s3cr3t-value"}',
        },
      ],
    });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain("s3cr3t-value");
    const view = await owner.get(`/services/${service.id}`);
    expect(JSON.stringify(view.body)).not.toContain("s3cr3t-value");
    await deploy(service.id);
    await runJobs();
    const container = runner.serviceContainers(service.id)[0];
    expect(container?.files).toEqual([{ path: "/etc/app/config.json" }]);
    expect(runner.volumes.has(`${service.appName}-data`)).toBe(true);
    const create = runner.commandsOf("container.create").at(-1);
    expect(JSON.stringify(create?.params.files)).not.toContain("s3cr3t-value");
  });
});

describe("databases (spec 8.1, 8.2)", () => {
  test("a Postgres deploys with its volume and public port, and its URLs are percent-encoded", async () => {
    const { environments } = await makeProject(owner, "Data");
    const created = await makeService(owner, environments.development as string, {
      kind: "postgres",
      name: "db",
      settings: { password: "p@ss:word#1" },
    });
    const id = created.service.id as string;
    const started = await deploy(id);
    await runJobs();
    expect((await deployment(started.id)).status).toBe("active");
    const container = runner.serviceContainers(id)[0];
    expect(container?.env.POSTGRES_PASSWORD).toBe("p@ss:word#1");
    expect(container?.ports[0]?.hostPort).toBe(created.service.publicPort);
    expect(runner.volumes.has(`${created.service.appName}-data`)).toBe(true);
    const masked = (await owner.get(`/services/${id}/connection`)).body.connection;
    expect(masked.internal.url).toBe(
      `postgresql://postgres:••••••••@${created.service.appName}:5432/postgres`,
    );
    const shown = (await owner.post(`/services/${id}/connection/reveal`, {})).body.connection;
    expect(shown.internal.url).toBe(
      `postgresql://postgres:p%40ss%3Aword%231@${created.service.appName}:5432/postgres`,
    );
    const made = await owner.post(`/services/${id}/public`, { public: false });
    expect(made.body.deployment.status).toBe("queued");
    expect(made.body.connection.public).toMatchObject({ enabled: false, url: null });
    const again = await owner.post(`/services/${id}/public`, { public: true });
    expect(again.body.connection.public.enabled).toBe(true);
    expect(again.body.connection.public.port).toBe(again.body.publicPort);
    await owner.post(`/services/${id}/public`, { public: false });
    await runJobs();
    expect(runner.serviceContainers(id)[0]?.ports).toEqual([]);
  });
});

describe("permissions (spec 6.11, 22.3, G11)", () => {
  test("a member without the service can't deploy it, see it, or open its terminal", async () => {
    const service = await app();
    const member = await addMember(h, owner, "mia@example.com", { scope: { serviceIds: [] } });
    expect((await member.post(`/services/${service.id}/deployments`, {})).status).toBe(404);
    expect((await member.get(`/services/${service.id}/logs`)).status).toBe(404);
    const terminal = await member.request("GET", `/services/${service.id}/terminal`, undefined, {
      upgrade: "websocket",
    });
    expect(terminal.status).toBe(404);
    const started = await deploy(service.id);
    expect((await member.get(`/deployments/${started.id}`)).status).toBe(404);
    expect((await member.get("/deployments")).body.deployments).toEqual([]);
  });

  test("C3-06: a terminal that can't open says why, also to a plain GET the console sends", async () => {
    const service = await app();
    const never = await owner.get(`/services/${service.id}/terminal?container=gone`);
    expect(never.status).toBe(409);
    expect(never.body.error.message).toBe(
      "This service has no container on its server. Deploy it first.",
    );
    await deploy(service.id);
    await runJobs();
    const stale = await owner.get(`/services/${service.id}/terminal?container=replaced-abc`);
    expect(stale.status).toBe(404);
    expect(stale.body.error.message).toBe("That container isn't one of this service's.");
    // A container that is there: only then the WebSocket is asked for.
    const plain = await owner.get(`/services/${service.id}/terminal`);
    expect(plain.status).toBe(400);
    expect(plain.body.error.message).toBe(TERMINAL_NEEDS_WEBSOCKET);
  });

  test("another workspace's deployments and services are not found, even for an owner", async () => {
    const other = await h.test.db
      .insertInto("workspace")
      .values({ name: "Elsewhere", slug: "elsewhere" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const row = await h.test.db
      .insertInto("deployment")
      .values({
        workspace_id: other.id,
        service_kind: "application",
        service_name: "theirs",
        app_name: "theirs-abc123",
        project_name: "Theirs",
        environment_name: "development",
        server_name: "Nearzero host",
        trigger: "manual",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    expect((await owner.get(`/deployments/${row.id}`)).status).toBe(404);
    expect((await owner.get(`/deployments/${row.id}/events`)).status).toBe(404);
    expect((await owner.post(`/deployments/${row.id}/cancel`, {})).status).toBe(404);
    expect((await owner.get("/deployments")).body.total).toBe(0);
  });

  test("a member with the service may deploy it but not change its source", async () => {
    const service = await app();
    const member = await addMember(h, owner, "max@example.com", {
      scope: { serviceIds: [service.id] },
    });
    expect((await member.post(`/services/${service.id}/deployments`, {})).status).toBe(202);
    const source = await member.put(`/services/${service.id}/source`, {
      type: "image",
      image: "x:1",
    });
    expect(source.status).toBe(403);
    expect((await member.get("/deployments")).body.total).toBe(1);
  });
});

describe("teardown through the runner (spec 23.1)", () => {
  test("removes containers, images, volumes, folders and routes; reports a server it can't reach", async () => {
    h.services.hostnameProviders.register("test", async (request) => ({
      routes: [{ host: "gone.example.test", path: "/", port: request.port, https: true }],
      notes: [],
    }));
    const service = await app({ servicePort: 3000 });
    await owner.put(`/services/${service.id}/source`, {
      type: "git",
      url: "https://git.example.test/acme/web.git",
    });
    await owner.put(`/services/${service.id}/mounts`, {
      mounts: [{ type: "volume", name: "data", containerPath: "/data" }],
    });
    const started = await deploy(service.id);
    await runJobs();
    expect(runner.routes.size).toBe(1);
    const row = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", service.id)
      .executeTakeFirstOrThrow();
    const target = {
      serviceId: row.id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      environmentId: row.environment_id,
      kind: row.kind,
      name: row.name,
      appName: row.app_name,
      serverId: row.server_id,
      status: row.status,
      settings: row.settings,
    } as const;
    const teardown = runnerTeardown(h.services);
    runner.disconnect();
    const offline = await teardown.remove(target, {
      stopFirst: true,
      removeVolumes: true,
      signal: new AbortController().signal,
    });
    expect(offline.removed).toBe(false);
    expect((offline as { reason: string }).reason).toContain("isn't connected");
    await runner.reconnect();
    const done = await teardown.remove(target, {
      stopFirst: true,
      removeVolumes: true,
      signal: new AbortController().signal,
    });
    expect(done).toEqual({ removed: true });
    expect(runner.serviceContainers(service.id)).toEqual([]);
    expect([...runner.images.keys()].filter((tag) => tag.includes(service.appName))).toEqual([]);
    expect(runner.volumes.size).toBe(0);
    expect(runner.folders.has(service.appName)).toBe(false);
    expect(runner.routes.size).toBe(0);
    expect((await deployment(started.id)).status).toBe("removed");
  });
});

describe("uploads (spec 6.3)", () => {
  test("are stored in pieces and given only to the runner of a server building with them", async () => {
    const service = await app();
    const bytes = new Uint8Array(3 * 1024 * 1024 + 5);
    bytes[0] = 0x50;
    bytes[1] = 0x4b;
    const workspace = await h.test.db
      .selectFrom("workspace")
      .select("id")
      .executeTakeFirstOrThrow();
    const person = await h.test.db.selectFrom("person").select("id").executeTakeFirstOrThrow();
    const stored = await storeUpload(h.test.db, {
      serviceId: service.id,
      workspaceId: workspace.id,
      personId: person.id,
      fileName: "site.zip",
      body: new Blob([bytes]).stream(),
    });
    expect(stored.sizeBytes).toBe(bytes.length);
    expect(await uploadForRunner(h.test.db, stored.id, "host")).toBeNull();
    await h.test.db
      .insertInto("deployment")
      .values({
        workspace_id: workspace.id,
        service_id: service.id,
        service_kind: "application",
        service_name: "web",
        app_name: service.appName,
        project_name: "Shop",
        environment_name: "development",
        server_name: "Nearzero host",
        status: "building",
        trigger: "manual",
        source: JSON.stringify({ type: "upload", uploadId: stored.id }),
      })
      .execute();
    expect(
      await uploadForRunner(h.test.db, stored.id, "00000000-0000-4000-8000-000000000000"),
    ).toBeNull();
    const found = await uploadForRunner(h.test.db, stored.id, "host");
    const back = new Uint8Array(await new Response(found?.body).arrayBuffer());
    expect(back.length).toBe(bytes.length);
    const notZip = await owner.request(
      "POST",
      `/services/${service.id}/source/upload`,
      new Uint8Array([1, 2, 3]),
    );
    expect(notZip.status).toBe(400);
  });
});

describe("retention (spec 11.3)", () => {
  test("keeps the newest 50 per service and removed rows for 30 days", async () => {
    const service = await app();
    const workspace = await h.test.db
      .selectFrom("workspace")
      .select("id")
      .executeTakeFirstOrThrow();
    const base = {
      workspace_id: workspace.id,
      service_kind: "application" as const,
      service_name: "web",
      app_name: service.appName,
      project_name: "Shop",
      environment_name: "development",
      server_name: "Nearzero host",
      trigger: "manual" as const,
    };
    await h.test.db
      .insertInto("deployment")
      .values(
        Array.from({ length: DEPLOYMENTS_KEPT_PER_SERVICE + 5 }, (_, index) => ({
          ...base,
          service_id: service.id,
          status: "previous" as const,
          created_at: new Date(Date.now() - (index + 1) * 60_000),
        })),
      )
      .execute();
    await h.test.db
      .insertInto("deployment")
      .values([
        {
          ...base,
          service_id: null,
          status: "removed",
          removed_at: new Date(Date.now() - 31 * 86_400_000),
        },
        { ...base, service_id: null, status: "removed", removed_at: new Date() },
      ])
      .execute();
    await pruneDeployments(h.test.db);
    const left = await h.test.db
      .selectFrom("deployment")
      .select(["service_id", "status"])
      .execute();
    expect(left.filter((row) => row.service_id === service.id)).toHaveLength(
      DEPLOYMENTS_KEPT_PER_SERVICE,
    );
    expect(left.filter((row) => row.status === "removed")).toHaveLength(1);
  });
});
