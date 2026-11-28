import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { BUILD_CACHE_COMPONENT, NEARZERO_LABELS } from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { HostnameProviders } from "../src/deploys/hostnames.ts";
import { chooseServicePort } from "../src/deploys/service-port.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { runnerTeardown } from "../src/service-runtime/teardown.ts";
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
 * What a deploy runs and where its traffic goes (30b R2-01, R2-02, R2-09, B2-22), end to end
 * against the fake runner: the service port comes from the image when nobody typed one, Reload
 * starts the running version's image again with the saved settings without fetching or
 * building, Redeploy rebuilds the running commit while Deploy takes the newest, and a deleted
 * service's build caches go with it.
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
  await sql`truncate job, deployment, router_route, project cascade`.execute(h.test.db);
  runner.containers.clear();
  runner.images.clear();
  runner.volumes.clear();
  runner.routes.clear();
  runner.commands.length = 0;
  runner.exposedPorts.clear();
  runner.builtExposedPorts = [];
  runner.headCommit = "0123456789abcdef0123456789abcdef01234567";
  runner.buildFailure = null;
  h.services.hostnameProviders = new HostnameProviders();
  h.services.hostnameProviders.register("test", async (request) => ({
    routes: [{ host: "web.example.test", path: "/", port: request.port, https: false }],
    notes: [],
  }));
  owner = await setUpNamedOwner(h);
  if (!h.services.runners.isOnline("host")) await runner.reconnect();
});

async function runJobs(): Promise<void> {
  while (await worker.runOnce()) {}
}

async function app(settings: Record<string, unknown>) {
  const { environments } = await makeProject(owner, "Shop");
  const created = await makeService(owner, environments.development as string, {
    kind: "application",
    name: "web",
    settings,
  });
  const id = created.service.id as string;
  await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
  return { id, appName: created.service.appName as string };
}

async function gitApp(settings: Record<string, unknown> = {}) {
  const service = await app(settings);
  const saved = await owner.put(`/services/${service.id}/source`, {
    type: "git",
    url: "https://git.example.test/acme/web.git",
    branch: "main",
  });
  expect(saved.status).toBe(200);
  return service;
}

async function deployAndRun(serviceId: string, body: Record<string, unknown> = {}) {
  const reply = await owner.post(`/services/${serviceId}/deployments`, body);
  expect(reply.status).toBe(202);
  await runJobs();
  return (await owner.get(`/deployments/${reply.body.deployment.id}`)).body.deployment;
}

async function logOf(id: string): Promise<string> {
  return (await owner.get(`/deployments/${id}/log?lines=all`)).body.text as string;
}

function routedPort(): number | undefined {
  const route = [...runner.routes.values()][0] as { upstream: { port: number } } | undefined;
  return route?.upstream.port;
}

async function settingsOf(serviceId: string) {
  return (
    await h.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow()
  ).settings as Record<string, unknown>;
}

describe("the service port comes from the image unless one was typed (R2-01)", () => {
  test("Create without Git from nginx:alpine, no port: live on 80 at its hostname", async () => {
    runner.exposedPorts.set("nginx:alpine", ["80/tcp"]);
    const service = await app({ image: "nginx:alpine" });
    expect((await settingsOf(service.id)).servicePortAuto).toBe(true);
    const done = await deployAndRun(service.id);
    expect(done.status).toBe("active");
    expect(routedPort()).toBe(80);
    expect(runner.serviceContainers(service.id)[0]?.env.PORT).toBe("80");
    expect(await logOf(done.id)).toContain("Service port 80: the image declares 80/tcp.");
    // Hostnames added later route there too: the settings keep what the deploy found.
    expect(await settingsOf(service.id)).toMatchObject({ servicePort: 80, servicePortAuto: true });
    const view = (await owner.get(`/services/${service.id}`)).body.service;
    expect(view.settings).toMatchObject({ servicePort: 80, servicePortAuto: true });
  });

  test("a Dockerfile app whose image exposes only 8080 is routed to 8080", async () => {
    runner.builtExposedPorts = ["8080/tcp"];
    const service = await gitApp();
    const done = await deployAndRun(service.id);
    expect(done.status).toBe("active");
    expect(routedPort()).toBe(8080);
    expect(await logOf(done.id)).toContain("Service port 8080: the image declares 8080/tcp.");
  });

  test("a port the person typed always wins", async () => {
    runner.exposedPorts.set("nginx:alpine", ["80/tcp"]);
    const service = await app({ image: "nginx:alpine", servicePort: 3000 });
    const first = await deployAndRun(service.id);
    expect(routedPort()).toBe(3000);
    expect(await logOf(first.id)).toContain("Service port 3000: the service port set in Settings.");
  });

  test("a port typed later in Settings wins from then on", async () => {
    runner.exposedPorts.set("nginx:alpine", ["80/tcp"]);
    const auto = await app({ image: "nginx:alpine" });
    const typed = await owner.patch(`/services/${auto.id}`, { settings: { servicePort: 8081 } });
    expect(typed.status).toBe(200);
    expect((await settingsOf(auto.id)).servicePortAuto).toBeUndefined();
    await deployAndRun(auto.id);
    expect(routedPort()).toBe(8081);
  });

  test("which declared port, and the fallbacks", () => {
    const base = { typed: null, mappings: [], builder: "dockerfile", previous: 3000 };
    expect(chooseServicePort({ ...base, exposed: ["443/tcp", "8080/tcp", "9000/udp"] })).toEqual({
      port: 8080,
      why: "the image declares 443/tcp, 8080/tcp, and 8080 is the usual web port among them",
    });
    expect(chooseServicePort({ ...base, exposed: ["9001/tcp", "9000/tcp"] }).port).toBe(9000);
    expect(chooseServicePort({ ...base, exposed: ["53/udp"] }).port).toBe(3000);
    expect(chooseServicePort({ ...base, exposed: [], builder: "static" }).port).toBe(80);
    expect(
      chooseServicePort({
        ...base,
        exposed: ["80/tcp"],
        mappings: [{ containerPort: 9090, publishedPort: 19090, protocol: "tcp", mode: "routed" }],
      }).port,
    ).toBe(9090);
    expect(chooseServicePort({ ...base, exposed: null, previous: 8080 }).port).toBe(8080);
  });
});

describe("Reload applies the saved settings without fetching or building (R2-02)", () => {
  test("a changed variable reaches the app; the commit and image stay", async () => {
    const service = await gitApp({ servicePort: 3000 });
    const first = await deployAndRun(service.id);
    expect(first.status).toBe("active");
    const saved = await owner.put(`/services/${service.id}/variables`, {
      text: "GREETING=hello again\n",
    });
    expect(saved.status).toBe(200);
    runner.commands.length = 0;
    const reloaded = await owner.post(`/services/${service.id}/reload`, {});
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.message).toContain("Reloading with the saved settings");
    await runJobs();
    const after = (await owner.get(`/deployments/${reloaded.body.deploymentId}`)).body.deployment;
    expect(after).toMatchObject({ status: "active", trigger: "reload" });
    expect(after.commit).toBe(first.commit);
    expect(after.image).toBe(first.image);
    expect(runner.commandsOf("source.git")).toEqual([]);
    expect(runner.commandsOf("app.build")).toEqual([]);
    const containers = runner.serviceContainers(service.id);
    expect(containers).toHaveLength(1);
    expect(containers[0]?.env.GREETING).toBe("hello again");
    expect(containers[0]?.image).toBe(first.image);
    const text = await logOf(after.id);
    expect(text).toContain("Nothing is fetched or built.");
    expect(text).not.toContain("Fetching");
    expect((await owner.get(`/deployments/${first.id}`)).body.deployment.status).toBe("previous");
  });

  test("a service that never deployed has nothing to reload", async () => {
    const service = await app({ image: "nginx:alpine" });
    const reply = await owner.post(`/services/${service.id}/reload`, {});
    expect(reply.status).toBe(409);
  });
});

describe("Redeploy rebuilds the running commit; Deploy takes the newest (R2-09)", () => {
  test("with a new commit pushed, Redeploy builds what runs and Deploy builds the new one", async () => {
    const service = await gitApp({ servicePort: 3000 });
    const first = await deployAndRun(service.id);
    expect(first.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    runner.headCommit = "fedcba9876543210fedcba9876543210fedcba98";
    const redeployed = await deployAndRun(service.id, { redeploy: true });
    expect(redeployed).toMatchObject({ status: "active", trigger: "redeploy" });
    expect(redeployed.commit).toBe(first.commit);
    expect(runner.commandsOf("source.git").at(-1)?.params.commit).toBe(first.commit);
    expect(await logOf(redeployed.id)).toContain(
      "Redeploy: rebuilding commit 0123456, which the running version was built from.",
    );
    const deployed = await deployAndRun(service.id);
    expect(deployed.commit).toBe("fedcba9876543210fedcba9876543210fedcba98");
    // The Deployments page's Redeploy does the same.
    const again = await owner.post(`/deployments/${first.id}/redeploy`, {});
    expect(again.status).toBe(202);
    await runJobs();
    const view = (await owner.get(`/deployments/${again.body.deployment.id}`)).body.deployment;
    expect(view.commit).toBe("fedcba9876543210fedcba9876543210fedcba98");
  });

  test("a deploy already waiting is never turned into a rebuild of the old commit", async () => {
    const service = await gitApp({ servicePort: 3000 });
    await deployAndRun(service.id);
    runner.holdBuilds();
    const building = await owner.post(`/services/${service.id}/deployments`, {});
    const worked = worker.runOnce();
    await Bun.sleep(200);
    const waiting = await owner.post(`/services/${service.id}/deployments`, {});
    expect(waiting.body.waiting).toBe(true);
    const redeploy = await owner.post(`/services/${service.id}/deployments`, { redeploy: true });
    expect(redeploy.status).toBe(202);
    expect(redeploy.body.deployment.id).toBe(waiting.body.deployment.id);
    expect(redeploy.body.message).toBe(
      "A deploy is already waiting with newer code; it runs next with the saved settings.",
    );
    expect(redeploy.body.deployment.trigger).toBe("manual");
    runner.releaseBuilds();
    await worked;
    await runJobs();
    expect(
      (await owner.get(`/deployments/${building.body.deployment.id}`)).body.deployment.status,
    ).toBe("previous");
  });
});

describe("a deleted service's build caches go with it (B2-22)", () => {
  test("even when its data volumes are kept", async () => {
    const service = await app({ image: "nginx:alpine", servicePort: 80 });
    await deployAndRun(service.id);
    runner.volumes.set(`nearzero-pack-${service.appName}-build`, {
      [NEARZERO_LABELS.service]: service.id,
      [NEARZERO_LABELS.component]: BUILD_CACHE_COMPONENT,
    });
    runner.volumes.set(`${service.appName}-data`, { [NEARZERO_LABELS.service]: service.id });
    const row = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", service.id)
      .executeTakeFirstOrThrow();
    const done = await runnerTeardown(h.services).remove(
      {
        serviceId: row.id,
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        environmentId: row.environment_id,
        kind: row.kind,
        name: row.name,
        appName: row.app_name,
        serverId: row.server_id,
        status: row.status,
        settings: row.settings ?? {},
      },
      { stopFirst: true, removeVolumes: false, signal: new AbortController().signal },
    );
    expect(done).toEqual({ removed: true });
    expect([...runner.volumes.keys()]).toEqual([`${service.appName}-data`]);
  });
});
