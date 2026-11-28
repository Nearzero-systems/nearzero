import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { ObjectRegistry } from "../../apps/control/src/access/objects.ts";
import { HostnameProviders } from "../../apps/control/src/deploys/hostnames.ts";
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
  setUpOwner,
} from "../../apps/control/test/support/harness.ts";
import { DindHost, eventually, PLATFORM } from "../runner/dind.ts";

/**
 * The deploy engine suite (M3c), against a Docker-in-Docker host standing in for a server:
 *
 *   bun run --cwd e2e test:deploys          (NZ1_E2E_KEEP=1 keeps the host for a look afterwards)
 *
 * The control plane runs in this process on 127.0.0.1:4160 with its job worker; the runner,
 * compiled for linux, runs inside the host with the pinned builder tools, and a Git server over
 * HTTP serves a tiny Node app from a repository inside the host. The runner deploys: the app
 * with its Dockerfile, the same app with Railpack, a static site from an uploaded .zip,
 * nginx:alpine as an image, and a Postgres reached by its internal URL from the app and by its
 * public port from outside the app network. Then a failing build and a crashing container leave
 * the old version serving, two webhook calls during a running build make exactly two deploys,
 * a cancel stops a build, and deleting the project leaves nothing behind on the host.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `deploys-${Date.now().toString(36)}`);
const HOST = new DindHost("nz1-m3c-deploys");
const PORT = 4160;
/**
 * The runner link's own TLS port (an install's 3443): the server joins there with the
 * certificate's fingerprint, since a remote runner never uses plain HTTP (spec 31, C4-02).
 */
const LINK_PORT = 4169;
const LINK = createLinkCertificate(["127.0.0.1"]);
const CONTROL_FROM_HOST = `https://host.docker.internal:${LINK_PORT}`;
const KEEP = process.env.NZ1_E2E_KEEP === "1";
const ROUTER_IMAGE = "traefik:v3.7.18";
const REPO = join(WORK, "repo");
const GIT_URL = "http://127.0.0.1:8081/web.git";
/** A build variable's value that must never be on a command line or in an image (R2-05). */
const BUILD_SECRET = `nz-build-secret-${crypto.randomUUID().slice(0, 12)}`;
const PUBLIC_VALUE = `nz-public-${crypto.randomUUID().slice(0, 8)}`;

let harness: Harness;
let owner: Browser;
let server: ReturnType<typeof Bun.serve>;
let linkServer: ReturnType<typeof Bun.serve>;
let worker: JobWorker;
let serverId = "";
let projectId = "";
let environmentId = "";
const ids: Record<string, string> = {};

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

async function git(...args: string[]): Promise<string> {
  return (await $`git -C ${REPO} ${args}`.quiet().text()).trim();
}

const SERVER_JS = (version: string, extra = "") => `const http = require("node:http");
const net = require("node:net");
${extra}
http
  .createServer((req, res) => {
    if (req.url === "/db") {
      const url = new URL(process.env.DATABASE_URL);
      const socket = net.connect(Number(url.port), url.hostname, () => {
        socket.end();
        res.end("db reachable\\n");
      });
      socket.on("error", (error) => {
        res.statusCode = 500;
        res.end("db unreachable: " + error.message + "\\n");
      });
      return;
    }
    res.end("hello from ${version}\\n");
  })
  .listen(Number(process.env.PORT || 3000), () => console.log("listening on " + (process.env.PORT || 3000)));
`;

const DOCKERFILE = (extra = "") => `FROM node:24-alpine
WORKDIR /app
COPY . .
${extra}
EXPOSE 3000
CMD ["node", "server.js"]
`;

/** Writes the app's files, commits them, and publishes the repository to the Git server. */
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
  const bare = join(WORK, "web.git");
  await rm(bare, { recursive: true, force: true });
  await $`git clone -q --bare ${REPO} ${bare}`.quiet();
  await HOST.must("rm -rf /srv/git/web.git && mkdir -p /srv/git");
  await HOST.copyIn(bare, "/srv/git/web.git");
  // docker cp keeps this machine's owner; the Git server runs as root and refuses other owners.
  await HOST.must("chown -R root:root /srv/git/web.git");
  return git("rev-parse", "HEAD");
}

async function curlHost(hostname: string, path = "/"): Promise<string> {
  return (await HOST.exec(`curl -s -m 10 -H 'Host: ${hostname}' http://127.0.0.1${path}`)).out;
}

/** Waits until the router answers `hostname` with `text` (it loads new route files in a moment). */
async function serves(hostname: string, text: string, path = "/"): Promise<string> {
  return eventually(
    `${hostname}${path} to answer "${text}"`,
    async () => {
      const body = await curlHost(hostname, path);
      return body.includes(text) ? body : null;
    },
    30_000,
  );
}

async function deployment(id: string) {
  return (await owner.get(`/deployments/${id}`)).body.deployment;
}

async function waitDeployment(id: string, timeoutMs = 900_000) {
  return eventually(
    `deployment ${id} to finish`,
    async () => {
      const view = await deployment(id);
      return ["queued", "building"].includes(view.status) ? null : view;
    },
    timeoutMs,
    2000,
  );
}

async function deployLog(id: string): Promise<string> {
  return (await owner.get(`/deployments/${id}/log?lines=all`)).body.text;
}

async function startDeploy(service: string): Promise<string> {
  const reply = await owner.post(`/services/${ids[service]}/deployments`, {});
  if (reply.status !== 202) throw new Error(JSON.stringify(reply.body));
  return reply.body.deployment.id;
}

async function deployAndWait(
  service: string,
  timeoutMs?: number,
): Promise<{ id: string; status: string; error: string | null }> {
  const id = await startDeploy(service);
  const done = await waitDeployment(id, timeoutMs);
  await log(`deploy-${service}-${id.slice(0, 8)}`, await deployLog(id));
  return done;
}

/**
 * Watches every process command line on the server while `run` goes, and answers the ones that
 * contained `secret` (spec 23.4, 30b R2-05: build variables never reach a command line).
 */
async function commandLinesWith<T>(
  secret: string,
  run: () => Promise<T>,
): Promise<{ result: T; seen: string[] }> {
  const seen: string[] = [];
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      const list = await HOST.exec("ps -eo args");
      for (const line of list.out.split("\n")) if (line.includes(secret)) seen.push(line);
      await Bun.sleep(300);
    }
  })();
  try {
    return { result: await run(), seen };
  } finally {
    watching = false;
    await watcher;
  }
}

/** The image's configuration and history as text, to look for values in. */
async function imageText(image: string): Promise<string> {
  const config = await HOST.must(`docker image inspect --format '{{json .Config}}' ${image}`);
  const history = await HOST.must(`docker history --no-trunc --format '{{.CreatedBy}}' ${image}`);
  return `${config}\n${history}`;
}

async function createApp(name: string, settings: Record<string, unknown>): Promise<string> {
  const reply = await owner.post(`/environments/${environmentId}/services`, {
    kind: "application",
    name,
    serverId,
    settings,
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  ids[name] = reply.body.service.id;
  await owner.patch(`/services/${ids[name]}/deploy-settings`, { stabilitySeconds: 3 });
  return ids[name] as string;
}

/** The Git server here speaks plain HTTP, which the API refuses for people; set it directly. */
async function useLocalRepository(serviceId: string, buildPath = ""): Promise<void> {
  const row = await harness.test.db
    .selectFrom("service")
    .select("settings")
    .where("id", "=", serviceId)
    .executeTakeFirstOrThrow();
  await harness.test.db
    .updateTable("service")
    .set({
      settings: JSON.stringify({
        ...row.settings,
        source: {
          type: "git",
          url: GIT_URL,
          branch: "main",
          buildPath,
          sshKeyId: null,
          trigger: "push",
          watchPaths: [],
          submodules: false,
        },
      }),
    })
    .where("id", "=", serviceId)
    .execute();
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  const target =
    PLATFORM === "linux/arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-musl-baseline";
  const arch = PLATFORM === "linux/arm64" ? "arm64" : "amd64";
  // The harness builds what it tests: the runner, the Git server, and the pinned builder tools.
  await $`bun build ${join(ROOT, "runner", "src", "main.ts")} --compile --target=${target} --outfile=${join(WORK, "nearzero-runner")}`.quiet();
  await $`bun build ${join(import.meta.dir, "git-http.ts")} --compile --target=${target} --outfile=${join(WORK, "git-http")}`.quiet();
  await $`bun ${join(ROOT, "runner", "tools", "install.ts")} --arch ${arch} --dest ${join(WORK, "builders")}`.quiet();

  await HOST.start();
  await HOST.must(
    "apk add --no-cache -q libstdc++ libgcc curl git git-daemon openssh-client >/dev/null",
  );
  await HOST.copyIn(join(WORK, "nearzero-runner"), "/usr/local/bin/nearzero-runner");
  await HOST.copyIn(join(WORK, "git-http"), "/usr/local/bin/git-http");
  await HOST.must("mkdir -p /usr/local/lib/nearzero");
  await HOST.copyIn(join(WORK, "builders"), "/usr/local/lib/nearzero/builders");
  await HOST.must(`docker pull -q ${ROUTER_IMAGE} >/dev/null`);

  // The app's repository, published to the Git server inside the host.
  await mkdir(REPO, { recursive: true });
  await $`git -C ${REPO} init -q -b main`.quiet();
  await HOST.must("mkdir -p /srv/git");
  await HOST.background("/usr/local/bin/git-http /srv/git 8081", "/var/log/git-http.log");
  ids.v1 = await commit("v1: the first page", {
    "server.js": SERVER_JS("v1"),
    Dockerfile: DOCKERFILE(),
    "package.json": `${JSON.stringify({ name: "tiny", version: "1.0.0", private: true, scripts: { start: "node server.js" } }, null, 2)}\n`,
    "package-lock.json": `${JSON.stringify({ name: "tiny", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "tiny", version: "1.0.0" } } }, null, 2)}\n`,
  });

  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({
    extra: {
      objects,
      runnerControlUrl: CONTROL_FROM_HOST,
      runnerControlFingerprint: LINK.fingerprint,
    },
  });
  // Hostnames for the suite: <service name>.test.localhost, plain HTTP through the router.
  harness.services.hostnameProviders = new HostnameProviders();
  harness.services.hostnameProviders.register("e2e", async (request) => {
    const row = await harness.test.db
      .selectFrom("service")
      .select("name")
      .where("id", "=", request.serviceId)
      .executeTakeFirstOrThrow();
    return {
      routes: [{ host: `${row.name}.test.localhost`, path: "/", port: request.port, https: false }],
      notes: [`${row.name}.test.localhost routes here.`],
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

describe("deploying to a server through its runner", () => {
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
    const project = await owner.post("/projects", { name: "Demo" });
    projectId = project.body.project.id;
    environmentId = project.body.environmentId;
  }, 300_000);

  test("a Node app from the Git repository goes live with its Dockerfile", async () => {
    await createApp("web", { servicePort: 3000 });
    await useLocalRepository(ids.web as string);
    const done = await deployAndWait("web");
    expect(done.status).toBe("active");
    const view = await deployment(done.id);
    expect(view.commit).toBe(ids.v1);
    expect(view.title).toBe("v1: the first page");
    expect(view.builder).toBe("dockerfile");
    const text = await deployLog(done.id);
    expect(text.split("\n")[0]).toBe("Initializing deployment (Nearzero 1.0.0-dev)");
    expect(text).toContain("Automatic build: using the Dockerfile");
    expect(text).toContain("It's live at: http://web.test.localhost");
    const page = await eventually("the app to answer", async () => {
      const body = await curlHost("web.test.localhost");
      return body.includes("hello from v1") ? body : null;
    });
    expect(page).toContain("hello from v1");
  }, 1_200_000);

  test("the same app builds with Railpack", async () => {
    const id = await createApp("web-railpack", { servicePort: 3000 });
    await useLocalRepository(id);
    await owner.put(`/services/${id}/build`, { builder: { type: "railpack" } });
    // A first Railpack build downloads its builder images: give a slow network time.
    const done = await deployAndWait("web-railpack", 1_700_000);
    expect(done.status).toBe("active");
    expect((await deployment(done.id)).builder).toBe("railpack");
    const page = await eventually("the Railpack app to answer", async () => {
      const body = await curlHost("web-railpack.test.localhost");
      return body.includes("hello from v1") ? body : null;
    });
    expect(page).toContain("hello from v1");
  }, 1_800_000);

  test("a static site from an uploaded .zip serves index.html for unknown paths", async () => {
    const id = await createApp("site", { servicePort: 8080 });
    await owner.put(`/services/${id}/build`, { builder: { type: "static", spa: true } });
    const folder = join(WORK, "site");
    await mkdir(join(folder, "assets"), { recursive: true });
    await writeFile(join(folder, "index.html"), "<h1>static site home</h1>\n");
    await writeFile(join(folder, "assets", "app.js"), "console.log('hi');\n");
    await $`cd ${folder} && zip -qr ../site.zip .`.quiet();
    const zip = new Uint8Array(await Bun.file(join(WORK, "site.zip")).arrayBuffer());
    const uploaded = await owner.request("POST", `/services/${id}/source/upload?deploy=1`, zip, {
      "content-type": "application/zip",
    });
    expect(uploaded.status).toBe(201);
    const done = await waitDeployment(uploaded.body.deployment.id);
    await log("deploy-site", await deployLog(done.id));
    expect(done.status).toBe("active");
    await serves("site.test.localhost", "static site home", "/some/deep/link");
    await serves("site.test.localhost", "console.log", "/assets/app.js");
  }, 1_200_000);

  test("an image (nginx:alpine) deploys as it is", async () => {
    await createApp("nginx", { image: "nginx:alpine", servicePort: 80 });
    const done = await deployAndWait("nginx");
    expect(done.status).toBe("active");
    await serves("nginx.test.localhost", "Welcome to nginx!");
  }, 600_000);

  test("nginx:alpine created without a port is live on the port its image declares (R2-01)", async () => {
    await createApp("nginx-auto", { image: "nginx:alpine" });
    const done = await deployAndWait("nginx-auto");
    expect(done.status).toBe("active");
    expect(await deployLog(done.id)).toContain("Service port 80: the image declares 80/tcp.");
    await serves("nginx-auto.test.localhost", "Welcome to nginx!");
  }, 600_000);

  test("a Postgres is reached by its internal URL from the app and by its public port from outside", async () => {
    const created = await owner.post(`/environments/${environmentId}/services`, {
      kind: "postgres",
      name: "db",
      serverId,
    });
    expect(created.status).toBe(201);
    ids.db = created.body.service.id;
    const publicPort = created.body.service.publicPort as number;
    const done = await deployAndWait("db");
    expect(done.status).toBe("active");
    const connection = (await owner.post(`/services/${ids.db}/connection/reveal`, {})).body
      .connection;
    expect(connection.internal.url).toStartWith("postgresql://postgres:");
    await owner.put(`/services/${ids.web}/variables`, {
      text: `DATABASE_URL=${connection.internal.url}\nAPI_TOKEN=${BUILD_SECRET}\n`,
    });
    // The build never had the values on a command line, and the image doesn't carry them
    // (30b R2-05); the app still gets them when it runs.
    const watched = await commandLinesWith(BUILD_SECRET, () => deployAndWait("web"));
    expect(watched.result.status).toBe("active");
    expect(watched.seen).toEqual([]);
    const webImage = (await deployment(watched.result.id)).image as string;
    expect(await imageText(webImage)).not.toContain(BUILD_SECRET);
    expect(
      await eventually("the app to reach the database", async () => {
        const body = await curlHost("web.test.localhost", "/db");
        return body.includes("db reachable") ? body : null;
      }),
    ).toContain("db reachable");
    // psql runs from the database's own image: the runner dropped the postgres:18 tag it pulled
    // (only the labelled copy is kept), and --pull never keeps pull messages out of the output.
    const psqlImage = (
      await HOST.must(
        `docker ps --filter label=dev.nearzero.service=${ids.db} --format '{{.Image}}' | head -n 1`,
      )
    ).trim();
    expect(psqlImage).toStartWith("nearzero/");
    const inside = await HOST.must(
      `docker run --rm --pull never --network nearzero-edge ${psqlImage} psql '${connection.internal.url}' -tAc 'select 40 + 2'`,
    );
    expect(inside.trim()).toBe("42");
    // From a container on Docker's default network (not the app network), through the server's
    // own address on that network and the public port.
    const gateway = (
      await HOST.must("docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'")
    ).trim();
    const outsideUrl = connection.internal.url.replace(
      `@${connection.internal.host}:5432/`,
      `@${gateway}:${publicPort}/`,
    );
    const outside = await HOST.must(
      `docker run --rm --pull never ${psqlImage} psql '${outsideUrl}' -tAc 'select 43'`,
    );
    expect(outside.trim()).toBe("43");
  }, 900_000);

  test("Nixpacks: a secret never reaches a command line or the image; a public name does reach the build (R2-05)", async () => {
    const id = await createApp("web-nixpacks", { servicePort: 3000 });
    await useLocalRepository(id);
    await owner.put(`/services/${id}/build`, { builder: { type: "nixpacks" } });
    await owner.put(`/services/${id}/variables`, {
      text: `API_TOKEN=${BUILD_SECRET}\nNEXT_PUBLIC_SITE=${PUBLIC_VALUE}\n`,
    });
    // A first Nixpacks build downloads Nix packages: give a slow network time.
    const watched = await commandLinesWith(BUILD_SECRET, () =>
      deployAndWait("web-nixpacks", 1_700_000),
    );
    expect(watched.result.status).toBe("active");
    expect(watched.seen).toEqual([]);
    const view = await deployment(watched.result.id);
    expect(view.builder).toBe("nixpacks");
    const text = await imageText(view.image as string);
    expect(text).not.toContain(BUILD_SECRET);
    expect(text).toContain(PUBLIC_VALUE);
    await serves("web-nixpacks.test.localhost", "hello from v1");
    const container = (
      await HOST.must(
        `docker ps --filter label=dev.nearzero.service=${id} --format '{{.ID}}' | head -n 1`,
      )
    ).trim();
    expect((await HOST.must(`docker exec ${container} printenv API_TOKEN`)).trim()).toBe(
      BUILD_SECRET,
    );
  }, 1_800_000);

  test("a failing build leaves the old version serving", async () => {
    await commit("v2: a broken build", {
      Dockerfile: DOCKERFILE("RUN echo 'about to fail' && false"),
    });
    const done = await deployAndWait("web");
    expect(done.status).toBe("failed");
    await serves("web.test.localhost", "hello from v1");
    expect(await deployLog(done.id)).toContain("The Docker build failed");
  }, 900_000);

  test("a container that crashes right after start fails with its output", async () => {
    await commit("v3: crashes at start", {
      Dockerfile: DOCKERFILE(),
      "server.js": SERVER_JS("v3", 'console.log("boom: SECRET_KEY is missing"); process.exit(3);'),
    });
    const done = await deployAndWait("web");
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/exited with code 3|restarted/);
    expect(await deployLog(done.id)).toContain("boom: SECRET_KEY is missing");
    await serves("web.test.localhost", "hello from v1");
  }, 900_000);

  test("two webhook calls during a running build produce exactly two deploys", async () => {
    await commit("v4: a slow build", {
      Dockerfile: DOCKERFILE("RUN sleep 25 && echo v4"),
      "server.js": SERVER_JS("v4"),
    });
    const hook = await owner.post(`/services/${ids.web}/webhook`, {});
    const path = new URL(hook.body.url).pathname;
    const before = (await owner.get(`/services/${ids.web}/deployments`)).body.deployments.length;
    const manual = await startDeploy("web");
    // The source is fetched before the next commit is published.
    await eventually(
      "the source to be fetched",
      async () => (await deployLog(manual)).includes("Checked out"),
      300_000,
    );
    const v5 = await commit("v5: the newest page", {
      Dockerfile: DOCKERFILE("RUN sleep 25 && echo v5"),
      "server.js": SERVER_JS("v5"),
    });
    const call = () =>
      fetch(`http://127.0.0.1:${PORT}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ref: "refs/heads/main", after: v5 }),
      }).then(async (response) => ({
        status: response.status,
        body: (await response.json()) as { deploymentId: string; replaced: boolean },
      }));
    const first = await call();
    await Bun.sleep(3000);
    const second = await call();
    expect(first.status).toBe(202);
    expect(second.body.replaced).toBe(true);
    expect(second.body.deploymentId).toBe(first.body.deploymentId);
    await waitDeployment(manual);
    const last = await waitDeployment(first.body.deploymentId);
    await log("deploy-web-webhook", await deployLog(last.id));
    const after = (await owner.get(`/services/${ids.web}/deployments`)).body.deployments;
    expect(after.length - before).toBe(2);
    expect(last.status).toBe("active");
    expect((await deployment(last.id)).commit).toBe(v5);
    ids.v5 = v5;
    await serves("web.test.localhost", "hello from v5");
  }, 1_200_000);

  test("cancel stops a building deployment within 10 seconds and the running version keeps serving", async () => {
    await commit("v6: a very slow build", {
      Dockerfile: DOCKERFILE("RUN sleep 120 && echo v6"),
      "server.js": SERVER_JS("v6"),
    });
    const id = await startDeploy("web");
    await eventually(
      "the build to start",
      async () => {
        const text = await deployLog(id);
        return text.includes("sleep 120") ? text : null;
      },
      300_000,
    );
    const asked = Date.now();
    const cancelled = await owner.post(`/deployments/${id}/cancel`, {});
    expect(cancelled.status).toBe(200);
    const done = await waitDeployment(id, 30_000);
    expect(done.status).toBe("cancelled");
    expect(Date.now() - asked).toBeLessThan(10_000);
    await serves("web.test.localhost", "hello from v5");
    // No build process is left behind on the server.
    expect((await HOST.exec("ps aux | grep -c '[b]uildx build'")).out.trim()).toBe("0");
  }, 600_000);

  test("runtime logs stream the app's output, and Reload restarts it", async () => {
    const response = await harness.app.request(
      `/api/v1/services/${ids.web}/logs?tail=100&follow=0`,
      {
        headers: {
          cookie: [...owner.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        },
      },
    );
    const text = await response.text();
    expect(text).toContain("event: output");
    expect(text).toContain("listening on 3000");
    // Reload applies saved settings without fetching or building (30b R2-02).
    const before = (await owner.get(`/services/${ids.web}/deployments`)).body.deployments.find(
      (item: { status: string }) => item.status === "active",
    );
    const variables = (await owner.post(`/services/${ids.web}/variables/reveal`, {})).body
      .text as string;
    await owner.put(`/services/${ids.web}/variables`, {
      text: `${variables.replace(/\n?$/, "\n")}GREETING=reloaded at ${Date.now()}\n`,
    });
    const asked = Date.now();
    const reloaded = await owner.post(`/services/${ids.web}/reload`, {});
    expect(reloaded.status).toBe(200);
    expect(reloaded.body.message).toContain("Reloading with the saved settings");
    const done = await waitDeployment(reloaded.body.deploymentId, 120_000);
    expect(Date.now() - asked).toBeLessThan(60_000);
    await log("deploy-web-reload", await deployLog(done.id));
    expect(done.status).toBe("active");
    const view = await deployment(done.id);
    expect(view.trigger).toBe("reload");
    expect(view.commit).toBe(before.commit);
    expect(view.image).toBe(before.image);
    const reloadLog = await deployLog(done.id);
    expect(reloadLog).not.toContain("Fetching");
    expect(reloadLog).not.toContain("Building with");
    const container = (
      await HOST.must(
        `docker ps --filter label=dev.nearzero.deployment=${done.id} --format '{{.ID}}' | head -n 1`,
      )
    ).trim();
    expect((await HOST.must(`docker exec ${container} printenv GREETING`)).trim()).toStartWith(
      "reloaded at",
    );
    await serves("web.test.localhost", "hello from v5");
  }, 300_000);

  test("Redeploy rebuilds the running commit, not the branch's newer one (R2-09)", async () => {
    // The branch's newest commit is v6 (its build was cancelled); v5 runs.
    const reply = await owner.post(`/services/${ids.web}/deployments`, { redeploy: true });
    expect(reply.status).toBe(202);
    const done = await waitDeployment(reply.body.deployment.id);
    await log("deploy-web-redeploy", await deployLog(done.id));
    expect(done.status).toBe("active");
    const view = await deployment(done.id);
    expect(view.trigger).toBe("redeploy");
    expect(view.commit).toBe(ids.v5);
    expect(await deployLog(done.id)).toContain("Redeploy: rebuilding commit");
    await serves("web.test.localhost", "hello from v5");
  }, 900_000);

  test("everything the runner made carries Nearzero's labels, so uninstall finds it (spec 3.3)", async () => {
    const label = '{{index .Config.Labels "dev.nearzero.managed"}}';
    // Every service container runs an image labelled as Nearzero's.
    const containers = (await HOST.must("docker ps -aq --filter label=dev.nearzero.service"))
      .trim()
      .split("\n");
    expect(containers.length).toBeGreaterThanOrEqual(4);
    for (const id of containers) {
      const image = (await HOST.must(`docker inspect --format '{{.Config.Image}}' ${id}`)).trim();
      expect(image).toStartWith("nearzero/");
      expect((await HOST.must(`docker image inspect --format '${label}' ${image}`)).trim()).toBe(
        "true",
      );
    }
    // A pulled image that wasn't on the server before is kept only under Nearzero's name.
    expect((await HOST.exec("docker image inspect nginx:alpine")).code).not.toBe(0);
    // The BuildKit builder Railpack used, its cache volume, and the private network.
    const builder = await HOST.must(
      "docker ps -a --filter label=dev.nearzero.component=builder --format '{{.Names}} {{.Label \"dev.nearzero.managed\"}}'",
    );
    expect(builder.trim()).toBe("nearzero-buildkit true");
    const builderImage = (
      await HOST.must("docker inspect --format '{{.Config.Image}}' nearzero-buildkit")
    ).trim();
    expect(
      (await HOST.must(`docker image inspect --format '${label}' ${builderImage}`)).trim(),
    ).toBe("true");
    const volume = await HOST.must(
      "docker volume inspect --format '{{index .Labels \"dev.nearzero.managed\"}}' nearzero-buildkit-state",
    );
    expect(volume.trim()).toBe("true");
    const network = await HOST.must(
      "docker network inspect --format '{{index .Labels \"dev.nearzero.managed\"}}' nearzero-edge",
    );
    expect(network.trim()).toBe("true");
    // Every volume on the server is Nearzero's.
    const unlabelled = await HOST.must(
      `for v in $(docker volume ls -q); do [ "$(docker volume inspect --format '{{index .Labels "dev.nearzero.managed"}}' "$v")" = true ] || echo "$v"; done`,
    );
    expect(unlabelled.trim()).toBe("");
  }, 120_000);

  test("deleting the project leaves nothing of it on the server", async () => {
    const plan = await owner.get(`/projects/${projectId}/delete-plan`);
    expect(plan.status).toBe(200);
    const started = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.body.plan.fingerprint,
      confirm: "Demo",
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
    const containers = await HOST.must("docker ps -aq --filter label=dev.nearzero.service");
    expect(containers.trim()).toBe("");
    const volumes = await HOST.must("docker volume ls -q --filter label=dev.nearzero.service");
    expect(volumes.trim()).toBe("");
    // Only the shared BuildKit builder's image is left under Nearzero's name.
    const images = await HOST.must(
      "docker images --format '{{.Repository}}' | grep '^nearzero/' | grep -v '^nearzero/buildkit$' || true",
    );
    expect(images.trim()).toBe("");
    const folders = await HOST.must("ls -A /var/lib/nearzero-runner/work/apps 2>/dev/null || true");
    expect(folders.trim()).toBe("");
    const routes = await HOST.must("ls /etc/nearzero/router | grep '^route-s-' || true");
    expect(routes.trim()).toBe("");
    const rows = await harness.test.db.selectFrom("deployment").select("status").execute();
    expect(new Set(rows.map((row) => row.status))).toEqual(new Set(["removed"]));
  }, 600_000);
});
