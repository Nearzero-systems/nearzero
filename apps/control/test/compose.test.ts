import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { NEARZERO_LABELS } from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { HostnameProviders } from "../src/deploys/hostnames.ts";
import { composeServicesOf, composeWebService } from "../src/domains/hostnames.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { runnerTeardown } from "../src/service-runtime/teardown.ts";
import { type FakeCompose, installFakeCompose } from "./support/fake-compose.ts";
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
 * The Compose runtime end to end against a fake runner that speaks the real protocol, with a
 * pretend Docker Compose (spec 07, 05 5.5, 10.6, 17.3, 24 G3): a pasted stack deploys once its
 * variable is set, its web service gets the hostname, a broken or refused file and a crash after
 * `up` leave the previous stack serving, privileged options are refused on the host for anyone
 * but instance administrators, Preview, the containers and their actions, Start, Stop and
 * Reload, the volumes for backups, a repository's inner services for hostnames, and delete.
 */

setDefaultTimeout(180_000);

let h: Harness;
let runner: FakeRunner;
let compose: FakeCompose;
let stopBeats: () => void = () => {};
let worker: JobWorker;
let owner: Browser;

const STACK = `services:
  web:
    image: nginx:alpine
    ports: ["8080:80"]
    depends_on: [api]
  api:
    image: node:24-alpine
    expose: ["3000"]
    depends_on: [db]
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes: ["pg:/var/lib/postgresql/data"]
volumes:
  pg: {}
`;

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects } });
  runner = await FakeRunner.connect(h.test.db, h.services.runners);
  compose = installFakeCompose(runner);
  stopBeats = runner.keepAlive();
  worker = new JobWorker({
    db: h.test.db,
    queue: new JobQueue(h.test.db, { workerId: "test-worker" }),
    definitions: createJobCatalog(h.services),
    log: silentLogger,
  });
});

afterAll(async () => {
  stopBeats();
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
  compose.refuse = null;
  compose.pullFailure = null;
  compose.crashing.clear();
  compose.slowHealth.clear();
  compose.deploys.length = 0;
  compose.repository.clear();
  // Hostnames as the domains area gives them: the web-looking inner service, by the file.
  h.services.hostnameProviders = new HostnameProviders();
  h.services.hostnameProviders.register("test", async (request) => {
    const row = await h.test.db
      .selectFrom("service")
      .select(["name", "settings"])
      .where("id", "=", request.serviceId)
      .executeTakeFirstOrThrow();
    const web = composeWebService(row.settings ?? {});
    if (!web) return { routes: [], notes: ["no web service"] };
    return {
      routes: [
        {
          host: `${row.name}.example.test`,
          path: "/",
          port: web.port ?? request.port,
          composeService: web.name,
          https: false,
        },
      ],
      notes: [`${row.name}.example.test routes to ${web.name}.`],
    };
  });
  owner = await setUpNamedOwner(h);
  // A slow machine can leave the pretend link silent past the heartbeat window between tests.
  if (!h.services.runners.isOnline("host")) await runner.reconnect();
});

async function runJobs(): Promise<number> {
  let ran = 0;
  while (await worker.runOnce()) ran++;
  return ran;
}

async function stack(file = STACK, name = "shop") {
  const { environments } = await makeProject(owner, "Shop");
  const created = await makeService(owner, environments.development as string, {
    kind: "compose",
    name,
    settings: { format: "compose", composeFile: file },
  });
  const id = created.service.id as string;
  const settings = await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
  if (settings.status !== 200) throw new Error(JSON.stringify(settings.body));
  return { id, appName: created.service.appName as string };
}

async function deploy(serviceId: string, browser = owner) {
  const reply = await browser.post(`/services/${serviceId}/deployments`, {});
  if (reply.status !== 202) throw new Error(JSON.stringify(reply.body));
  await runJobs();
  return (await owner.get(`/deployments/${reply.body.deployment.id}`)).body.deployment as {
    id: string;
    status: string;
    error: string | null;
    urls: string[];
  };
}

async function logOf(id: string): Promise<string> {
  return (await owner.get(`/deployments/${id}/log?lines=all`)).body.text as string;
}

async function setPassword(serviceId: string, value = "pg-secret-value-1") {
  const saved = await owner.put(`/services/${serviceId}/variables`, {
    text: `POSTGRES_PASSWORD=${value}\n`,
  });
  expect(saved.status).toBe(200);
}

describe("deploying a pasted stack (spec 07 7.2, 7.3; acceptance)", () => {
  test("waits for its variable, then runs three services and routes the web one", async () => {
    const service = await stack();
    const first = await deploy(service.id);
    expect(first.status).toBe("failed");
    expect(first.error).toBe(
      "The Compose file uses POSTGRES_PASSWORD, which isn't set. Add it under Variables, then deploy.",
    );
    expect(await logOf(first.id)).toContain("Nothing was changed on the server");
    expect(compose.deploys).toEqual([]);

    await setPassword(service.id);
    const done = await deploy(service.id);
    expect(done.status).toBe("active");
    expect(done.urls).toEqual(["http://shop.example.test"]);
    const text = await logOf(done.id);
    expect(text.split("\n")[0]).toContain("Initializing deployment");
    expect(text).toContain("Using the Compose file saved on this service.");
    expect(text).toContain("Running the stack with Docker Compose: web, api, db.");
    expect(text).toContain("It's live at: http://shop.example.test");
    expect(text).not.toContain("pg-secret-value-1");

    // Values reach Compose only through the env file; the additions never carry them.
    const sent = compose.deploys[0] as {
      envFile: string;
      files: { name: string; content: string }[];
    };
    expect(sent.envFile).toContain('POSTGRES_PASSWORD="pg-secret-value-1"');
    expect(sent.files.map((file) => file.name)).toEqual(["compose.yml", "nearzero.yml"]);
    expect(sent.files[0]?.content).toBe(STACK);
    expect(sent.files[1]?.content).not.toContain("pg-secret-value-1");

    const containers = runner.serviceContainers(service.id);
    expect(containers.map((item) => item.labels["com.docker.compose.service"]).sort()).toEqual([
      "api",
      "db",
      "web",
    ]);
    expect(new Set(containers.map((item) => item.labels[NEARZERO_LABELS.deployment]))).toEqual(
      new Set([done.id]),
    );
    const route = [...runner.routes.values()][0] as { upstream: Record<string, unknown> };
    expect(route.upstream).toEqual({ host: `${service.appName}-web`, port: 80, scheme: "http" });
    const view = (await owner.get(`/services/${service.id}`)).body.service;
    expect(view.status).toBe("running");
    expect((await owner.get(`/deployments/${done.id}`)).body.deployment.source).toMatchObject({
      provider: "Compose file",
    });
  });

  test("only inner services hostnames route to join the private network (R2-11)", async () => {
    const service = await stack();
    await setPassword(service.id);
    const done = await deploy(service.id);
    expect(done.status).toBe("active");
    // web has the hostname; api and db stay on the stack's own network.
    const sent = compose.deploys.at(-1) as { network: Record<string, unknown> };
    expect(sent.network).toEqual({
      name: "nearzero-edge",
      aliasPrefix: service.appName,
      services: ["web"],
    });
    // A hostname connected to api later makes api join now, under its alias.
    const joined: Record<string, unknown>[] = [];
    runner.extraHandlers.set("network.connect", async (params) => {
      joined.push(params);
      return {};
    });
    try {
      const { joinRoutedInnerService } = await import("../src/compose-runtime/runtime.ts");
      await joinRoutedInnerService(
        h.services,
        "host",
        { id: service.id, app_name: service.appName },
        "api",
      );
    } finally {
      runner.extraHandlers.delete("network.connect");
    }
    const api = runner
      .serviceContainers(service.id)
      .find((item) => item.labels["com.docker.compose.service"] === "api");
    expect(joined).toEqual([
      { network: "nearzero-edge", container: api?.id, aliases: [`${service.appName}-api`] },
    ]);
  });

  test("a saved file needs a deploy until it runs", async () => {
    const service = await stack();
    await setPassword(service.id);
    const before = (await owner.get(`/services/${service.id}/compose`)).body;
    expect(before.needsDeploy).toBe(true);
    expect(before.needsDeployMessage).toBe("Deploy to start the stack.");
    expect(before.services.map((item: { name: string }) => item.name)).toEqual([
      "web",
      "api",
      "db",
    ]);
    await deploy(service.id);
    expect((await owner.get(`/services/${service.id}/compose`)).body.needsDeploy).toBe(false);
    const saved = await owner.patch(`/services/${service.id}`, {
      settings: { composeFile: `${STACK}  # changed\n` },
    });
    expect(saved.body.notes).toEqual(["Compose file saved. Deploy to use it."]);
    const after = (await owner.get(`/services/${service.id}/compose`)).body;
    expect(after.needsDeploy).toBe(true);
    expect(after.needsDeployMessage).toBe("Saved changes reach the stack on its next deploy.");
  });
});

describe("a failed redeploy keeps the previous stack (spec 07, 23.1)", () => {
  async function running() {
    const service = await stack();
    await setPassword(service.id);
    const first = await deploy(service.id);
    expect(first.status).toBe("active");
    const ids = runner
      .serviceContainers(service.id)
      .map((item) => item.id)
      .sort();
    return { service, first, ids };
  }

  test("broken YAML fails before anything on the server changes", async () => {
    const { service, first, ids } = await running();
    await owner.patch(`/services/${service.id}`, {
      settings: { composeFile: "services:\n  web:\n    image: [nginx\n" },
    });
    const broken = await deploy(service.id);
    expect(broken.status).toBe("failed");
    expect(broken.error).toMatch(/^The Compose file can't be used: It isn't valid YAML: line \d+/);
    expect(
      runner
        .serviceContainers(service.id)
        .map((item) => item.id)
        .sort(),
    ).toEqual(ids);
    expect((await owner.get(`/deployments/${first.id}`)).body.deployment.status).toBe("active");
    expect((await owner.get(`/services/${service.id}`)).body.service.status).toBe("running");
  });

  test("a file Docker Compose refuses, or an image that won't pull, changes nothing", async () => {
    const { service, ids } = await running();
    compose.refuse = "services.web.ports must be a list";
    const refused = await deploy(service.id);
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("Docker Compose refused the file");
    expect(await logOf(refused.id)).toContain("Nothing was changed on the server");
    compose.refuse = null;
    compose.pullFailure = "manifest for nginx:nope not found";
    const pulled = await deploy(service.id);
    expect(pulled.error).toContain("Pulling the images failed");
    expect(
      runner
        .serviceContainers(service.id)
        .map((item) => item.id)
        .sort(),
    ).toEqual(ids);
  });

  test("a crashed inner service's last output is cleaned before it reaches the log (G2-01)", async () => {
    const { service } = await running();
    compose.crashing.set(
      "api",
      "\u001b[31mError\u001b[0m: password pg-secret-value-1 refused by postgres://api:s3cret@db/app\n",
    );
    const crashed = await deploy(service.id);
    expect(crashed.status).toBe("failed");
    const text = await logOf(crashed.id);
    expect(text).toContain(
      "Error: password [redacted] refused by postgres://[credentials-redacted]@db/app",
    );
    expect(text).not.toContain("pg-secret-value-1");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("\u001b");
  });

  test("a health check in its start period isn't a failure; one that fails is (G2-07)", async () => {
    const { stackWait } = await import("../src/compose-runtime/deploy.ts");
    const saved = { ...stackWait };
    // Scaled down: the usual 5 minutes is 1 second here.
    Object.assign(stackWait, { settleMs: 1_000, healthMs: 20_000, noteMs: 500, pollMs: 100 });
    try {
      // The report's stack: db imports for longer than the usual wait before its check passes.
      const service = await stack();
      await setPassword(service.id);
      compose.slowHealth.set("db", { ms: 3_000, after: "healthy" });
      const first = await deploy(service.id);
      expect(first.status).toBe("active");
      const text = await logOf(first.id);
      expect(text).toContain("db's health check is still starting.");
      expect(text).not.toContain("never became healthy");
      // A check that fails after its start period fails the deploy, and the old version stays.
      compose.slowHealth.set("db", { ms: 1_500, after: "unhealthy" });
      const failed = await deploy(service.id);
      expect(failed.status).toBe("failed");
      expect(failed.error).toBe("db failed its health check.");
      expect((await owner.get(`/deployments/${first.id}`)).body.deployment.status).toBe("active");
    } finally {
      Object.assign(stackWait, saved);
      compose.slowHealth.clear();
    }
  });

  test("a crash after up starts the previous version again", async () => {
    const { service, first } = await running();
    compose.crashing.set("api", "Error: cannot find module /app/server.js\n");
    const crashed = await deploy(service.id);
    expect(crashed.status).toBe("failed");
    expect(crashed.error).toBe("api exited with code 1.");
    const text = await logOf(crashed.id);
    expect(text).toContain("cannot find module");
    expect(text).toContain("Starting the previous version again.");
    expect(text).toContain("The previous version is running again.");
    const rollback = compose.deploys.at(-1) as {
      pull: boolean;
      build: boolean;
      files: { content: string }[];
    };
    expect(rollback.pull).toBe(false);
    expect(rollback.build).toBe(false);
    expect(rollback.files[1]?.content).toContain(first.id);
    // The containers are the previous deployment's again.
    compose.crashing.clear();
    const containers = runner.serviceContainers(service.id);
    expect(new Set(containers.map((item) => item.labels[NEARZERO_LABELS.deployment]))).toEqual(
      new Set([first.id]),
    );
    expect((await owner.get(`/deployments/${first.id}`)).body.deployment.status).toBe("active");
  });
});

describe("privileged options on the Nearzero host (spec 07 7.3, 24 G3)", () => {
  const PRIVILEGED = `services:
  agent:
    image: alpine
    privileged: true
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]
`;

  test("only instance administrators deploy them; their deploy approves exactly those", async () => {
    const service = await stack(PRIVILEGED, "agent");
    const member = await addMember(h, owner, "mia@example.com", {
      scope: { serviceIds: [service.id] },
    });
    const preview = (await member.get(`/services/${service.id}/compose/preview`)).body;
    expect(preview.refused).toBe(true);
    expect(preview.refusal).toContain(
      "On the Nearzero host only Nearzero administrators can deploy them.",
    );
    expect(preview.warnings.map((item: { kind: string }) => item.kind)).toEqual([
      "privileged",
      "docker-socket",
    ]);
    const refused = await member.post(`/services/${service.id}/deployments`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("privileged mode, docker socket");

    // The owner of the first workspace is an instance administrator.
    expect((await owner.get(`/services/${service.id}/compose/preview`)).body.refused).toBe(false);
    const deployed = await deploy(service.id);
    expect(deployed.status).toBe("active");
    expect(await logOf(deployed.id)).toContain(
      "Allowed on the Nearzero host for a Nearzero administrator",
    );

    // The same options again: allowed for the member now.
    const again = await deploy(service.id, member);
    expect(again.status).toBe("active");
    // One more privileged option: refused until an administrator deploys it.
    await owner.patch(`/services/${service.id}`, {
      settings: { composeFile: `${PRIVILEGED}    network_mode: host\n` },
    });
    const more = await member.post(`/services/${service.id}/deployments`, {});
    expect(more.status).toBe(403);
    expect(more.body.error.message).toContain("host network");
  });

  test("an approval is for the definition: a new image or command needs an administrator again (B1-06)", async () => {
    const service = await stack(PRIVILEGED, "agent");
    // A member with configure rights on the service.
    const member = await addMember(h, owner, "mia@example.com", {
      scope: { serviceIds: [service.id] },
      capabilities: ["services.create"],
    });
    expect((await deploy(service.id)).status).toBe("active");
    expect((await deploy(service.id, member)).status).toBe("active");
    // The report's attack: same options, another image and a command that uses the socket.
    const changed = await member.patch(`/services/${service.id}`, {
      settings: {
        composeFile: PRIVILEGED.replace(
          "image: alpine",
          'image: docker:cli\n    command: ["docker", "run", "--privileged", "-v", "/:/host", "alpine"]',
        ),
      },
    });
    expect(changed.status).toBe(200);
    const refused = await member.post(`/services/${service.id}/deployments`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("docker socket");
    // A push or webhook deploy (no person) is refused at the deploy too.
    const { requestDeploy } = await import("../src/deploys/queue.ts");
    const pushed = await requestDeploy(h.test.db, {
      serviceId: service.id,
      workspaceId: (
        await h.test.db
          .selectFrom("service")
          .select("workspace_id")
          .where("id", "=", service.id)
          .executeTakeFirstOrThrow()
      ).workspace_id,
      trigger: "webhook",
      requestedBy: null,
      cleanCache: false,
    });
    await runJobs();
    const after = (await owner.get(`/deployments/${pushed.deployment.id}`)).body.deployment;
    expect(after.status).toBe("failed");
    expect(await logOf(after.id)).toContain("Refused on the Nearzero host");
  });

  test("hostnames to an approved service, and the values it reads from env files, need an administrator (C1-04)", async () => {
    const file = `services:
  proxy:
    image: tecnativa/docker-socket-proxy:0.3
    env_file: [.env]
    volumes: ["/var/run/docker.sock:/var/run/docker.sock:ro"]
  web:
    image: nginx:alpine
`;
    const service = await stack(file, "sockets");
    await owner.put(`/services/${service.id}/variables`, { text: "CONTAINERS=1\n" });
    const member = await addMember(h, owner, "mia@example.com", {
      scope: { serviceIds: [service.id] },
    });
    expect((await deploy(service.id)).status).toBe("active");
    expect((await deploy(service.id, member)).status).toBe("active");
    // The proxy reads every variable through the env file, so a new value is a new definition.
    expect(
      (
        await member.put(`/services/${service.id}/variables`, {
          text: "CONTAINERS=1\nPOST=1\nEXEC=1\n",
        })
      ).status,
    ).toBe(200);
    const widened = await member.post(`/services/${service.id}/deployments`, {});
    expect(widened.status).toBe(403);
    expect(widened.body.error.message).toContain("docker socket");
    await member.put(`/services/${service.id}/variables`, { text: "CONTAINERS=1\n" });
    expect((await deploy(service.id, member)).status).toBe("active");
    // A hostname straight to the approved proxy is for administrators; web's is fine.
    const toProxy = await member.post("/domains/hostnames", {
      hostname: "docker.example.org",
      connect: { serviceId: service.id, composeService: "proxy", port: 2375 },
    });
    expect(toProxy.status).toBe(403);
    expect(toProxy.body.error.message).toContain(
      "only Nearzero administrators can change the hostnames",
    );
    const toWeb = await member.post("/domains/hostnames", {
      hostname: "web.example.org",
      connect: { serviceId: service.id, composeService: "web", port: 80 },
    });
    expect(toWeb.status).not.toBe(403);
  });

  test("files that pull in other Compose files run on the host only by an administrator's own deploy (B1-01)", async () => {
    // The report's attack: the main file is harmless and includes the privileged one.
    const file = "include: [./more.yml]\nservices:\n  web:\n    image: nginx\n";
    const service = await stack(file, "inc");
    const member = await addMember(h, owner, "mia@example.com", {
      scope: { serviceIds: [service.id] },
    });
    const preview = (await member.get(`/services/${service.id}/compose/preview`)).body;
    expect(preview.refused).toBe(true);
    expect(preview.warnings.map((item: { kind: string }) => item.kind)).toEqual(["other-files"]);
    const refused = await member.post(`/services/${service.id}/deployments`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("include, or extends with file");
    // The administrator's deploy runs it, and approves nothing for anyone else.
    expect((await deploy(service.id)).status).toBe("active");
    const again = await member.post(`/services/${service.id}/deployments`, {});
    expect(again.status).toBe(403);
    // extends with a file is the same.
    const extended = await stack(
      "services:\n  web:\n    extends: { file: ./data/base.yml, service: web }\n",
      "ext",
    );
    const member2 = await addMember(h, owner, "max@example.com", {
      scope: { serviceIds: [extended.id] },
    });
    expect((await member2.post(`/services/${extended.id}/deployments`, {})).status).toBe(403);
  });
});

describe("Preview Compose (spec 07 7.2)", () => {
  test("a file that multiplies a variable is refused by Preview and deploy, naming it (C1-03)", async () => {
    // The report's file: 500 references to a 200 KB variable, about 100 M characters.
    const reference = "$" + "{A}";
    const file = `services:\n  web:\n    image: nginx\n    command: "${reference.repeat(500)}"\n`;
    const service = await stack(file);
    expect(
      (
        await owner.put(`/services/${service.id}/variables`, {
          text: `A=${"x".repeat(200 * 1024)}\n`,
        })
      ).status,
    ).toBe(200);
    const started = performance.now();
    const preview = (await owner.get(`/services/${service.id}/compose/preview`)).body;
    expect(performance.now() - started).toBeLessThan(5_000);
    const refusal =
      "The Compose file can't be used: It grows past 8 MB once its variables are filled in, mostly from A. Use A fewer times, or make it shorter.";
    expect(preview.problems).toEqual([refusal]);
    const done = await deploy(service.id);
    expect(done.status).toBe("failed");
    expect(done.error).toBe(refusal);
    expect(compose.deploys).toEqual([]);
  });

  test("shows both files, the variables by name, and what is missing", async () => {
    const service = await stack();
    const missing = (await owner.get(`/services/${service.id}/compose/preview`)).body;
    expect(missing.problems).toEqual([
      "The Compose file uses POSTGRES_PASSWORD, which isn't set. Add it under Variables, then deploy.",
    ]);
    await setPassword(service.id);
    const preview = (await owner.get(`/services/${service.id}/compose/preview`)).body;
    expect(preview.available).toBe(true);
    expect(preview.problems).toEqual([]);
    expect(preview.warnings).toEqual([]);
    expect(preview.files.map((file: { title: string }) => file.title)).toEqual([
      "Your Compose file",
      "Nearzero's additions",
    ]);
    expect(preview.files[0].content).toBe(STACK);
    expect(preview.files[1].content).toContain("dev.nearzero.service");
    expect(preview.files[1].content).toContain("<this deployment's id>");
    expect(JSON.stringify(preview)).not.toContain("pg-secret-value-1");
    expect(preview.variables).toMatchObject({
      delivered: ["POSTGRES_PASSWORD"],
      uses: ["POSTGRES_PASSWORD"],
    });
    expect(preview.notes[0]).toContain("Its next deploy gives web one");
  });
});

describe("containers, Start, Stop and Reload (spec 07 7.2)", () => {
  test("the containers table and its row actions", async () => {
    const service = await stack();
    expect((await owner.get(`/services/${service.id}/compose/containers`)).body.containers).toEqual(
      [],
    );
    await setPassword(service.id);
    await deploy(service.id);
    const listed = (await owner.get(`/services/${service.id}/compose/containers`)).body;
    expect(listed.containers.map((item: { service: string }) => item.service)).toEqual([
      "api",
      "db",
      "web",
    ]);
    const api = listed.containers[0] as {
      id: string;
      name: string;
      shortId: string;
      current: boolean;
    };
    expect(api.shortId).toHaveLength(12);
    expect(api.current).toBe(true);
    const restarted = await owner.post(
      `/services/${service.id}/compose/containers/${api.id}/restart`,
      {},
    );
    expect(restarted.body.message).toBe(`Restarted ${api.name}`);
    const killed = await owner.post(
      `/services/${service.id}/compose/containers/${api.shortId}/kill`,
      {},
    );
    expect(killed.body.message).toBe(`Killed ${api.name}`);
    expect(killed.body.container.state).toBe("exited");
    const again = await owner.post(`/services/${service.id}/compose/containers/${api.id}/kill`, {});
    expect(again.status).toBe(409);
    const started = await owner.post(
      `/services/${service.id}/compose/containers/${api.id}/start`,
      {},
    );
    expect(started.body.message).toBe(`Started ${api.name}`);
    const foreign = await owner.post(
      `/services/${service.id}/compose/containers/${"a".repeat(64)}/stop`,
      {},
    );
    expect(foreign.status).toBe(404);
  });

  test("Stop and Start act on the whole stack; Reload redeploys", async () => {
    const service = await stack();
    await setPassword(service.id);
    const first = await deploy(service.id);
    const stopped = await owner.post(`/services/${service.id}/stop`, {});
    expect(stopped.body).toEqual({ status: "stopped", message: "Stopped" });
    expect(runner.serviceContainers(service.id).every((item) => item.state === "exited")).toBe(
      true,
    );
    expect((await owner.get(`/deployments/${first.id}`)).body.deployment.status).toBe(
      "not_running",
    );
    // Stopped in reverse dependency order (web first), started in order (db first).
    const stops = runner.commandsOf("container.stop").map((command) => command.params.id);
    const names = (id: unknown) =>
      runner.containers.get(String(id))?.labels["com.docker.compose.service"];
    expect(stops.map(names)).toEqual(["web", "api", "db"]);
    runner.commands.length = 0;
    const started = await owner.post(`/services/${service.id}/start`, {});
    expect(started.body).toEqual({ status: "running", message: "Started" });
    expect(runner.commandsOf("container.start").map((command) => names(command.params.id))).toEqual(
      ["db", "api", "web"],
    );
    const reload = await owner.post(`/services/${service.id}/reload`, {});
    expect(reload.body.status).toBe("deploying");
    await runJobs();
    const reloaded = (await owner.get(`/deployments/${reload.body.deploymentId}`)).body.deployment;
    expect(reloaded.status).toBe("active");
    expect(reloaded.title).toBe("Reload");
  });
});

describe("volumes, repositories and delete (spec 17.3, 10.6, punch-list 5, 23.1)", () => {
  test("the volumes for backups are the file's own and those labelled for the stack", async () => {
    const service = await stack();
    await setPassword(service.id);
    await deploy(service.id);
    runner.volumes.set(`${service.appName}_pg`, { "com.docker.compose.project": service.appName });
    runner.volumes.set(`${service.appName}_cache`, {
      "com.docker.compose.project": service.appName,
    });
    runner.volumes.set("unrelated_shop_data", {});
    const answer = (await owner.get(`/services/${service.id}/compose/volumes`)).body;
    expect(answer.checkedServer).toBe(true);
    expect(answer.volumes).toEqual([
      {
        name: `${service.appName}_cache`,
        key: null,
        declared: false,
        labelled: true,
        external: false,
        innerServices: [],
      },
      {
        name: `${service.appName}_pg`,
        key: "pg",
        declared: true,
        labelled: true,
        external: false,
        innerServices: ["db"],
      },
    ]);
  });

  test("a repository's file deploys and its web service is found for hostnames", async () => {
    const service = await stack();
    await h.test.db
      .updateTable("service")
      .set({
        settings: JSON.stringify({
          format: "compose",
          source: {
            type: "git",
            url: "https://git.example.test/acme/shop.git",
            branch: "main",
            composePath: "./deploy/compose.yml",
          },
        }),
      })
      .where("id", "=", service.id)
      .execute();
    compose.repository.set(
      "deploy/compose.yml",
      "services:\n  worker:\n    image: busybox\n  frontend:\n    build: ../web\n    expose: ['4321']\n",
    );
    const done = await deploy(service.id);
    expect(done.status).toBe("active");
    expect(done.urls).toEqual(["http://shop.example.test"]);
    const text = await logOf(done.id);
    expect(text).toContain("Using ./deploy/compose.yml from the repository.");
    const sent = compose.deploys[0] as {
      directory: string;
      build: boolean;
      files: { content: string }[];
    };
    expect(sent.directory).toBe("repo/deploy");
    expect(sent.build).toBe(true);
    expect(sent.files[1]?.content).toContain(
      `nearzero/${service.appName}-frontend:${done.id.slice(0, 8)}`,
    );
    const row = await h.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", service.id)
      .executeTakeFirstOrThrow();
    expect(composeServicesOf(row.settings ?? {})).toEqual([
      { name: "worker", port: null },
      { name: "frontend", port: 4321 },
    ]);
    const route = [...runner.routes.values()][0] as { upstream: { host: string; port: number } };
    expect(route.upstream.host).toBe(`${service.appName}-frontend`);
    expect(route.upstream.port).toBe(4321);
    expect((await owner.get(`/services/${service.id}/hostnames`)).body.composeServices).toEqual([
      { name: "worker", port: null },
      { name: "frontend", port: 4321 },
    ]);
  });

  test("the Git tab saves a plain Git URL with the Compose file path, and it deploys", async () => {
    const service = await stack(STACK, "git-url");
    const outside = await owner.put(`/services/${service.id}/source`, {
      type: "git",
      url: "https://git.example.test/acme/shop.git",
      composePath: "../outside.yml",
    });
    expect(outside.status).toBe(400);
    const image = await owner.put(`/services/${service.id}/source`, {
      type: "image",
      image: "nginx:alpine",
    });
    expect(image.status).toBe(409);
    const saved = await owner.put(`/services/${service.id}/source`, {
      type: "git",
      url: "https://git.example.test/acme/shop.git",
      branch: "main",
      composePath: "./deploy/compose.yml",
    });
    expect(saved.status).toBe(200);
    const row = await h.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", service.id)
      .executeTakeFirstOrThrow();
    expect(row.settings?.source).toMatchObject({
      type: "git",
      url: "https://git.example.test/acme/shop.git",
      branch: "main",
      composePath: "./deploy/compose.yml",
    });
    expect(row.settings?.format).toBe("compose");
    compose.repository.set("deploy/compose.yml", "services:\n  worker:\n    image: busybox\n");
    const done = await deploy(service.id);
    expect(done.status).toBe("active");
    expect(await logOf(done.id)).toContain("Using ./deploy/compose.yml from the repository.");
  });

  test("delete takes the stack down with its volumes", async () => {
    const service = await stack();
    await setPassword(service.id);
    await deploy(service.id);
    runner.volumes.set(`${service.appName}_pg`, { [NEARZERO_LABELS.service]: service.id });
    const row = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", service.id)
      .executeTakeFirstOrThrow();
    const result = await runnerTeardown(h.services).remove(
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
        settings: row.settings,
      },
      { stopFirst: true, removeVolumes: false, signal: new AbortController().signal },
    );
    expect(result).toEqual({ removed: true });
    expect(runner.commandsOf("compose.down")[0]?.params).toMatchObject({
      project: service.appName,
      volumes: true,
    });
    expect(runner.serviceContainers(service.id)).toEqual([]);
    expect(runner.volumes.has(`${service.appName}_pg`)).toBe(false);
    expect(runner.routes.size).toBe(0);
  });

  test("a stack with no file is refused before it queues", async () => {
    const service = await stack("");
    const reply = await owner.post(`/services/${service.id}/deployments`, {});
    expect(reply.status).toBe(409);
    expect(reply.body.error.message).toBe(
      "This Compose service has no Compose file yet. Paste one under Source, or connect a repository, then deploy.",
    );
  });
});
