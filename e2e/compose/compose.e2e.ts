import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { ObjectRegistry } from "../../apps/control/src/access/objects.ts";
import { HostnameProviders } from "../../apps/control/src/deploys/hostnames.ts";
import { composeWebService } from "../../apps/control/src/domains/hostnames.ts";
import { createJobCatalog } from "../../apps/control/src/jobs/catalog.ts";
import { JobQueue } from "../../apps/control/src/jobs/queue.ts";
import { JobWorker } from "../../apps/control/src/jobs/worker.ts";
import { silentLogger } from "../../apps/control/src/log.ts";
import { registerProjectObjects } from "../../apps/control/src/projects/objects.ts";
import { createLinkCertificate } from "../../apps/control/src/runners/link-certificate.ts";
import { serveRunnerLink } from "../../apps/control/src/runners/link-paths.ts";
import { socketServer, upgraderFor } from "../../apps/control/src/runners/sockets.ts";
import { registerServerObjects } from "../../apps/control/src/servers/servers.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpOwner,
} from "../../apps/control/test/support/harness.ts";
import { addMember } from "../../apps/control/test/support/projects.ts";
import { DindHost, eventually, PLATFORM } from "../runner/dind.ts";

/**
 * The Compose runtime suite (M7), against a Docker-in-Docker host standing in for a server:
 *
 *   bun run --cwd e2e test:compose          (NZ1_E2E_KEEP=1 keeps the host for a look afterwards)
 *
 * The control plane runs in this process on 127.0.0.1:4170 with its job worker; the runner,
 * compiled for linux, runs inside the host with Docker Compose, and a Git server over HTTP serves
 * a repository with a Compose file from inside the host. It deploys a three-service stack pasted
 * as YAML (refused until its ${POSTGRES_PASSWORD} is set) and a stack from the repository (with
 * a build and a bind mount from the repository); the web services get hostnames and serve
 * through the router; per-container logs stream; a redeploy with a file Docker Compose refuses
 * and one whose container crashes leave the old stack serving; a privileged stack is refused on
 * the Nearzero host for a member; and deleting the project removes every container and volume.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `compose-${Date.now().toString(36)}`);
const HOST = new DindHost("nz1-m7-compose");
const PORT = 4170;
/**
 * The runner link's own TLS port (an install's 3443): the server joins there with the
 * certificate's fingerprint, since a remote runner never uses plain HTTP (spec 31, C4-02).
 */
const LINK_PORT = 4179;
const LINK = createLinkCertificate(["127.0.0.1"]);
const CONTROL_FROM_HOST = `https://host.docker.internal:${LINK_PORT}`;
const KEEP = process.env.NZ1_E2E_KEEP === "1";
const ROUTER_IMAGE = "traefik:v3.7.18";
const REPO = join(WORK, "repo");
const GIT_URL = "http://127.0.0.1:8081/stack.git";

let harness: Harness;
let owner: Browser;
let server: ReturnType<typeof Bun.serve>;
let linkServer: ReturnType<typeof Bun.serve>;
let worker: JobWorker;
let serverId = "";
let projectId = "";
let environmentId = "";
const ids: Record<string, string> = {};
const apps: Record<string, string> = {};

const STACK = `services:
  web:
    image: nginx:1.29-alpine
    command: ["sh", "-c", "echo \\"hello from \${GREETING:-compose}\\" > /usr/share/nginx/html/index.html && exec nginx -g 'daemon off;'"]
    ports: ["8080:80"]
    depends_on: [api]
    labels: ["owner=\${APP_NAME}"]
  api:
    image: busybox:1.37
    command: ["sh", "-c", "echo api ready; while true; do echo tick; sleep 2; done"]
    depends_on: [db]
  db:
    image: postgres:17-alpine
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes:
      - pg:/var/lib/postgresql/data
volumes:
  pg: {}
`;

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

async function git(...args: string[]): Promise<string> {
  return (await $`git -C ${REPO} ${args}`.quiet().text()).trim();
}

async function commit(message: string, files: Record<string, string>): Promise<string> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(REPO, name, ".."), { recursive: true });
    await writeFile(join(REPO, name), content);
  }
  await git("add", "-A");
  await git(
    "-c",
    "user.name=E2E",
    "-c",
    "user.email=e2e@example.com",
    "commit",
    "-q",
    "-m",
    message,
  );
  const bare = join(WORK, "stack.git");
  await rm(bare, { recursive: true, force: true });
  await $`git clone -q --bare ${REPO} ${bare}`.quiet();
  await HOST.must("rm -rf /srv/git/stack.git && mkdir -p /srv/git");
  await HOST.copyIn(bare, "/srv/git/stack.git");
  await HOST.must("chown -R root:root /srv/git/stack.git");
  return git("rev-parse", "HEAD");
}

async function curlHost(hostname: string, path = "/"): Promise<string> {
  return (await HOST.exec(`curl -s -m 10 -H 'Host: ${hostname}' http://127.0.0.1${path}`)).out;
}

async function serves(hostname: string, text: string): Promise<string> {
  return eventually(
    `${hostname} to answer "${text}"`,
    async () => {
      const body = await curlHost(hostname);
      return body.includes(text) ? body : null;
    },
    60_000,
  );
}

async function deployment(id: string) {
  return (await owner.get(`/deployments/${id}`)).body.deployment;
}

async function deployLog(id: string): Promise<string> {
  return (await owner.get(`/deployments/${id}/log?lines=all`)).body.text;
}

async function deployAndWait(name: string, browser = owner) {
  const reply = await browser.post(`/services/${ids[name]}/deployments`, {});
  if (reply.status !== 202) throw new Error(JSON.stringify(reply.body));
  const id = reply.body.deployment.id as string;
  const done = await eventually(
    `deployment ${id} to finish`,
    async () => {
      const view = await deployment(id);
      return ["queued", "building"].includes(view.status) ? null : view;
    },
    900_000,
    2000,
  );
  await log(`deploy-${name}-${id.slice(0, 8)}`, await deployLog(id));
  return done as { id: string; status: string; error: string | null; urls: string[] };
}

async function createStack(name: string, file: string, target = serverId): Promise<string> {
  const reply = await owner.post(`/environments/${environmentId}/services`, {
    kind: "compose",
    name,
    serverId: target,
    settings: { format: "compose", composeFile: file },
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  ids[name] = reply.body.service.id;
  apps[name] = reply.body.service.appName;
  await owner.patch(`/services/${ids[name]}/deploy-settings`, { stabilitySeconds: 5 });
  return ids[name] as string;
}

/** The ids of a stack's containers on the server, sorted. */
async function containerIds(name: string): Promise<string[]> {
  const out = await HOST.must(
    `docker ps -aq --no-trunc --filter label=com.docker.compose.project=${apps[name]}`,
  );
  return out.trim().split("\n").filter(Boolean).sort();
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  const target =
    PLATFORM === "linux/arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-musl-baseline";
  await $`bun build ${join(ROOT, "runner", "src", "main.ts")} --compile --target=${target} --outfile=${join(WORK, "nearzero-runner")}`.quiet();
  await $`bun build ${join(ROOT, "e2e", "deploys", "git-http.ts")} --compile --target=${target} --outfile=${join(WORK, "git-http")}`.quiet();

  await HOST.start();
  await HOST.must("apk add --no-cache -q libstdc++ libgcc curl git git-daemon >/dev/null");
  await HOST.copyIn(join(WORK, "nearzero-runner"), "/usr/local/bin/nearzero-runner");
  await HOST.copyIn(join(WORK, "git-http"), "/usr/local/bin/git-http");
  await HOST.must(`docker pull -q ${ROUTER_IMAGE} >/dev/null`);
  await HOST.must("docker compose version");

  // The repository: a Compose file in deploy/, a page it binds from site/, an image it builds.
  await mkdir(REPO, { recursive: true });
  await $`git -C ${REPO} init -q -b main`.quiet();
  await HOST.must("mkdir -p /srv/git");
  await HOST.background("/usr/local/bin/git-http /srv/git 8081", "/var/log/git-http.log");
  ids.v1 = await commit("v1: the stack", {
    "deploy/compose.yml": `services:
  frontend:
    image: nginx:1.29-alpine
    expose: ["80"]
    volumes:
      - ../site:/usr/share/nginx/html:ro
    depends_on: [worker]
  worker:
    build: ../worker
    environment:
      MODE: \${MODE}
`,
    "deploy/.env": "MODE=from-the-repository\n",
    "site/index.html": "hello from the repository\n",
    "worker/Dockerfile":
      'FROM busybox:1.37\nCMD ["sh", "-c", "echo worker mode $MODE; while true; do sleep 5; done"]\n',
  });

  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({
    instanceEmail: INSTANCE_RESEND,
    extra: {
      objects,
      runnerControlUrl: CONTROL_FROM_HOST,
      runnerControlFingerprint: LINK.fingerprint,
    },
  });
  // Hostnames for the suite: <service name>.test.localhost, plain HTTP through the router, to
  // the inner service the domains area would pick (punch-list 5: repository files too).
  harness.services.hostnameProviders = new HostnameProviders();
  harness.services.hostnameProviders.register("e2e", async (request) => {
    const row = await harness.test.db
      .selectFrom("service")
      .select(["name", "settings"])
      .where("id", "=", request.serviceId)
      .executeTakeFirstOrThrow();
    const web = composeWebService(row.settings ?? {});
    if (!web) return { routes: [], notes: ["No web service found in the file."] };
    return {
      routes: [
        {
          host: `${row.name}.test.localhost`,
          path: "/",
          port: web.port ?? request.port,
          composeService: web.name,
          https: false,
        },
      ],
      notes: [`${row.name}.test.localhost routes to ${web.name}.`],
    };
  });
  const app = harness.app;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 120,
    websocket: socketServer,
    fetch: (request, bun) =>
      app.fetch(request, {
        peerAddress: bun.requestIP(request)?.address,
        upgrade: upgraderFor(bun),
      }),
  });
  linkServer = serveRunnerLink(harness.app, {
    hostname: "127.0.0.1",
    port: LINK_PORT,
    certificate: LINK.certificate,
    key: LINK.key,
    idleTimeoutSeconds: 120,
  });
  worker = new JobWorker({
    db: harness.test.db,
    queue: new JobQueue(harness.test.db, { workerId: "e2e-worker" }),
    definitions: createJobCatalog(harness.services),
    log: silentLogger,
    pollIntervalMs: 250,
  });
  worker.start();
  owner = await setUpOwner(harness);
}, 1_800_000);

afterAll(async () => {
  await HOST.exec("cat /var/log/nearzero-runner.log").then((result) => log("runner", result.out));
  await HOST.exec("cat /var/log/git-http.log").then((result) => log("git-http", result.out));
  await worker?.stop({ graceMs: 1000 }).catch(() => {});
  harness?.services.runners.stop();
  server?.stop(true);
  linkServer?.stop(true);
  await harness?.drop();
  if (KEEP) {
    console.log(`Kept ${HOST.name}; remove it with: docker rm -fv ${HOST.name}`);
    return;
  }
  await HOST.remove();
}, 300_000);

describe("Compose stacks on a server through its runner", () => {
  test("the runner joins the server", async () => {
    const generated = await owner.post("/ssh-keys/generate", { type: "ed25519", name: "dind" });
    const key = await owner.post("/ssh-keys", {
      name: "dind",
      publicKey: generated.body.publicKey,
      privateKey: generated.body.privateKey,
    });
    const created = await owner.post("/servers", {
      name: "DinD server",
      sshKeyId: key.body.key.id,
      address: "127.0.0.1",
      port: 22,
      sshUser: "root",
    });
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
    const join = await owner.post(`/servers/${serverId}/join-command`);
    await HOST.background(
      `/usr/local/bin/nearzero-runner join ${CONTROL_FROM_HOST} ${join.body.token} --fingerprint sha256:${LINK.fingerprint}`,
      "/var/log/nearzero-runner.log",
      {
        NEARZERO_RUNNER_STATE_DIR: "/var/lib/nearzero-runner",
        NEARZERO_ROUTER_DIR: "/etc/nearzero/router",
        NEARZERO_ROUTER_HOST_DIR: "/etc/nearzero/router",
        NEARZERO_ROUTER_IMAGE: ROUTER_IMAGE,
      },
    );
    await eventually(
      "the server to be ready",
      async () => (await owner.get(`/servers/${serverId}`)).body.server?.readiness === "ready",
      180_000,
      1000,
    );
    const project = await owner.post("/projects", { name: "Stacks" });
    projectId = project.body.project.id;
    environmentId = project.body.environmentId;
  }, 300_000);

  test("a pasted three-service stack deploys once its variable is set, and its web service serves", async () => {
    await createStack("shop", STACK);
    const refused = await deployAndWait("shop");
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("POSTGRES_PASSWORD");
    expect(await containerIds("shop")).toEqual([]);

    const saved = await owner.put(`/services/${ids.shop}/variables`, {
      text: "POSTGRES_PASSWORD=e2e-postgres-secret\nGREETING=the pasted stack\n",
    });
    expect(saved.status).toBe(200);
    const done = await deployAndWait("shop");
    expect(done.status).toBe("active");
    expect(done.urls).toEqual(["http://shop.test.localhost"]);
    expect(await serves("shop.test.localhost", "hello from the pasted stack")).toContain(
      "hello from the pasted stack",
    );
    const text = await deployLog(done.id);
    expect(text).toContain("Docker Compose");
    expect(text).not.toContain("e2e-postgres-secret");
    expect((await containerIds("shop")).length).toBe(3);
    // Nearzero's labels on every container; its private network with the inner alias.
    const labels = await HOST.must(
      `docker ps --filter label=com.docker.compose.project=${apps.shop} --format '{{.Label "dev.nearzero.service"}} {{.Label "dev.nearzero.deployment"}}'`,
    );
    expect(new Set(labels.trim().split("\n"))).toEqual(new Set([`${ids.shop} ${done.id}`]));
    const aliases = await HOST.must(
      `docker inspect --format '{{json .NetworkSettings.Networks}}' ${apps.shop}-web-1`,
    );
    expect(aliases).toContain(`${apps.shop}-web`);
    // ${APP_NAME} is the app name with no variable for it (30b R2-12).
    const owner_ = await HOST.must(
      `docker inspect --format '{{index .Config.Labels "owner"}}' ${apps.shop}-web-1`,
    );
    expect(owner_.trim()).toBe(apps.shop as string);
    // Only the routed web service is on the shared network (30b R2-11): no app outside the
    // stack can reach its database or api; they stay on the stack's own network.
    for (const inner of ["db", "api"]) {
      const networks = await HOST.must(
        `docker inspect --format '{{json .NetworkSettings.Networks}}' ${apps.shop}-${inner}-1`,
      );
      expect(networks).not.toContain("nearzero-edge");
      expect(networks).toContain(`${apps.shop}_default`);
    }
    const reach = (name: string) =>
      HOST.exec(`docker run --rm --network nearzero-edge busybox:1.37 ping -c 1 -W 2 ${name}`);
    expect((await reach(`${apps.shop}-web`)).code).toBe(0);
    const db = await reach(`${apps.shop}-db`);
    expect(db.code).not.toBe(0);
    expect(db.out).toContain("bad address");
    // The env file on the server is the service's own, readable only by root.
    const mode = await HOST.must(
      `stat -c '%a' /var/lib/nearzero-runner/work/compose/${apps.shop}/.nearzero/env`,
    );
    expect(mode.trim()).toBe("600");
    const volume = await HOST.must(
      `docker volume inspect --format '{{index .Labels "dev.nearzero.service"}}' ${apps.shop}_pg`,
    );
    expect(volume.trim()).toBe(ids.shop as string);
    const volumes = (await owner.get(`/services/${ids.shop}/compose/volumes`)).body;
    expect(volumes.volumes.map((item: { name: string }) => item.name)).toEqual([`${apps.shop}_pg`]);
  }, 1_200_000);

  test("per-container logs stream, and the containers table lists the stack", async () => {
    const listed = (await owner.get(`/services/${ids.shop}/compose/containers`)).body;
    expect(listed.containers.map((item: { service: string }) => item.service)).toEqual([
      "api",
      "db",
      "web",
    ]);
    const api = listed.containers.find((item: { service: string }) => item.service === "api");
    const db = listed.containers.find((item: { service: string }) => item.service === "db");
    const read = async (id: string) => {
      const reply = await owner.get(`/services/${ids.shop}/logs?container=${id}&follow=0&tail=500`);
      if (!(reply.body instanceof ArrayBuffer)) throw new Error(JSON.stringify(reply.body));
      return new TextDecoder().decode(reply.body);
    };
    const apiLog = await eventually("api's log", async () => {
      const text = await read(api.id);
      return text.includes("api ready") ? text : null;
    });
    expect(apiLog).not.toContain("database system is ready");
    const dbLog = await eventually("db's log", async () => {
      const text = await read(db.id);
      return text.includes("database system is ready") ? text : null;
    });
    expect(dbLog).not.toContain("api ready");
    const restarted = await owner.post(
      `/services/${ids.shop}/compose/containers/${api.id}/restart`,
      {},
    );
    expect(restarted.body.message).toBe(`Restarted ${api.name}`);
  }, 300_000);

  test("a redeploy with a file Docker Compose refuses leaves the old stack running", async () => {
    const before = await containerIds("shop");
    // YAML Nearzero reads, but Docker Compose refuses: a dependency on a service that isn't there.
    await owner.patch(`/services/${ids.shop}`, {
      settings: { composeFile: STACK.replace("depends_on: [api]", "depends_on: [missing]") },
    });
    const broken = await deployAndWait("shop");
    expect(broken.status).toBe("failed");
    expect(broken.error).toContain("Docker Compose refused the file");
    expect(await deployLog(broken.id)).toContain("Nothing was changed on the server");
    expect(await containerIds("shop")).toEqual(before);
    expect(await serves("shop.test.localhost", "hello from the pasted stack")).toBeTruthy();

    // A container that crashes after up: the previous version starts again.
    await owner.patch(`/services/${ids.shop}`, {
      settings: {
        composeFile: STACK.replace(
          "echo api ready; while true; do echo tick; sleep 2; done",
          "echo api is broken; exit 3",
        ),
      },
    });
    const crashed = await deployAndWait("shop");
    expect(crashed.status).toBe("failed");
    const text = await deployLog(crashed.id);
    expect(text).toContain("api is broken");
    expect(text).toContain("The previous version is running again.");
    expect(await serves("shop.test.localhost", "hello from the pasted stack")).toBeTruthy();
    await owner.patch(`/services/${ids.shop}`, { settings: { composeFile: STACK } });
  }, 1_200_000);

  test("a stack from a local Git repository deploys, builds, binds and serves", async () => {
    await createStack("repo", "services: {}\n");
    await harness.test.db
      .updateTable("service")
      .set({
        settings: JSON.stringify({
          format: "compose",
          deploy: { autodeploy: true, cleanCache: false, stabilitySeconds: 5 },
          source: {
            type: "git",
            url: GIT_URL,
            branch: "main",
            composePath: "./deploy/compose.yml",
            sshKeyId: null,
            trigger: "push",
            watchPaths: [],
            submodules: false,
          },
        }),
      })
      .where("id", "=", ids.repo as string)
      .execute();
    const done = await deployAndWait("repo");
    expect(done.status).toBe("active");
    expect(done.urls).toEqual(["http://repo.test.localhost"]);
    expect((await deployment(done.id)).commit).toBe(ids.v1);
    expect(await serves("repo.test.localhost", "hello from the repository")).toBeTruthy();
    const worker = await HOST.must(`docker logs ${apps.repo}-worker-1 2>&1`);
    expect(worker).toContain("worker mode from-the-repository");
    const image = await HOST.must(
      `docker inspect --format '{{.Config.Image}}' ${apps.repo}-worker-1`,
    );
    expect(image.trim()).toBe(`nearzero/${apps.repo}-worker:${done.id.slice(0, 8)}`);
  }, 1_200_000);

  test("a privileged stack is refused on the Nearzero host for a member", async () => {
    const id = await createStack(
      "agent",
      "services:\n  agent:\n    image: alpine\n    volumes: ['/var/run/docker.sock:/var/run/docker.sock']\n",
      "host",
    );
    const member = await addMember(harness, owner, "mia@example.com", {
      scope: { serviceIds: [id] },
    });
    const preview = (await member.get(`/services/${id}/compose/preview`)).body;
    expect(preview.refused).toBe(true);
    expect(preview.warnings.map((item: { kind: string }) => item.kind)).toEqual(["docker-socket"]);
    const refused = await member.post(`/services/${id}/deployments`, {});
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain(
      "On the Nearzero host only Nearzero administrators can deploy them.",
    );
  }, 120_000);

  test("deleting the project removes every container and volume of its stacks", async () => {
    const plan = await owner.get(`/projects/${projectId}/delete-plan`);
    const started = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.body.plan.fingerprint,
      confirm: "Stacks",
    });
    expect(started.status).toBe(202);
    const run = await eventually(
      "the delete to finish",
      async () => {
        const reply = await owner.get(`/delete-runs/${started.body.run.id}`);
        return reply.body.run.state === "running" ? null : reply.body.run;
      },
      300_000,
      1000,
    );
    await log("delete-run", JSON.stringify(run, null, 2));
    expect(run.state).toBe("succeeded");
    for (const name of ["shop", "repo"]) {
      expect(await containerIds(name)).toEqual([]);
      const volumes = await HOST.must(
        `docker volume ls -q --filter label=com.docker.compose.project=${apps[name]}`,
      );
      expect(volumes.trim()).toBe("");
    }
    const left = await HOST.must("docker ps -aq --filter label=dev.nearzero.service");
    expect(left.trim()).toBe("");
    const folders = await HOST.must(
      "ls -A /var/lib/nearzero-runner/work/compose 2>/dev/null || true",
    );
    expect(folders.trim()).toBe("");
    const routes = await HOST.must("ls /etc/nearzero/router | grep '^route-s-' || true");
    expect(routes.trim()).toBe("");
  }, 600_000);
});
