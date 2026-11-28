import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
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
 * The backups suite (M5), against a Docker-in-Docker host standing in for a server, with MinIO
 * inside it as the S3-compatible store:
 *
 *   until mkdir /tmp/nearzero-next-dind.lock 2>/dev/null; do sleep 10; done
 *   bun run --cwd e2e test:backups; rmdir /tmp/nearzero-next-dind.lock
 *
 * The control plane runs in this process on 127.0.0.1:4180 with its job worker; the runner,
 * compiled for linux, runs inside the host. The deploy engine starts Postgres, MySQL, MariaDB,
 * MongoDB and libSQL there; for each, a backup runs, its data is deleted, and a restore brings
 * it back. Keep 2 after three runs leaves two files. An nginx app's volume is backed up, a file
 * is deleted inside it, and an in-place restore brings it back with the app running. Every
 * file is also checked in MinIO directly, outside Nearzero. NZ1_E2E_KEEP=1 keeps the host.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `backups-${Date.now().toString(36)}`);
const HOST = new DindHost("nz1-m5-backups");
const PORT = 4180;
/**
 * The runner link's own TLS port (an install's 3443): the server joins there with the
 * certificate's fingerprint, since a remote runner never uses plain HTTP (spec 31, C4-02).
 */
const LINK_PORT = 4189;
const LINK = createLinkCertificate(["127.0.0.1"]);
const CONTROL_FROM_HOST = `https://host.docker.internal:${LINK_PORT}`;
const KEEP = process.env.NZ1_E2E_KEEP === "1";
const ROUTER_IMAGE = "traefik:v3.7.18";
const MINIO_IMAGE = process.env.NZ1_E2E_MINIO_IMAGE ?? "bitnamilegacy/minio:2025.7.23";
const TOOLS_IMAGE = "rclone/rclone:1.71.2";
const MINIO_USER = "nz-e2e-access";
const MINIO_PASSWORD = "nz-e2e-secret-0123456789";
const BUCKET = "nearzero-e2e";

let harness: Harness;
let owner: Browser;
let server: ReturnType<typeof Bun.serve>;
let linkServer: ReturnType<typeof Bun.serve>;
let worker: JobWorker;
let serverId = "";
let environmentId = "";
let destinationId = "";
let minioEndpoint = "";

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

/** rclone inside the host, straight against MinIO: what is really in the bucket. */
async function bucketFiles(prefix: string): Promise<string[]> {
  const out = await HOST.must(
    `docker run --rm -e RCLONE_CONFIG_M_TYPE=s3 -e RCLONE_CONFIG_M_PROVIDER=Minio -e RCLONE_CONFIG_M_ACCESS_KEY_ID=${MINIO_USER} -e RCLONE_CONFIG_M_SECRET_ACCESS_KEY=${MINIO_PASSWORD} -e RCLONE_CONFIG_M_ENDPOINT=${minioEndpoint} ${TOOLS_IMAGE} lsf m:${BUCKET}/${prefix}`,
  );
  return (
    out
      .split("\n")
      .map((line) => line.trim())
      // 1.0's names: the start time, and for a volume its name in front (31c G3-20).
      .filter((line) =>
        /^(?:[A-Za-z0-9][A-Za-z0-9_.-]*-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.[a-z.]+$/.test(line),
      )
  );
}

async function containerOf(serviceId: string): Promise<string> {
  return eventually(
    "the service's container",
    async () => {
      const out = await HOST.exec(
        `docker ps -q --filter label=dev.nearzero.service=${serviceId} --filter status=running`,
      );
      return out.out.trim().split("\n")[0] || null;
    },
    60_000,
  );
}

async function deployAndWait(serviceId: string, name: string) {
  const reply = await owner.post(`/services/${serviceId}/deployments`, {});
  if (reply.status !== 202) throw new Error(JSON.stringify(reply.body));
  const id = reply.body.deployment.id as string;
  const done = await eventually(
    `${name} to deploy`,
    async () => {
      const view = (await owner.get(`/deployments/${id}`)).body.deployment;
      return ["queued", "building"].includes(view.status) ? null : view;
    },
    900_000,
    2000,
  );
  await log(`deploy-${name}`, (await owner.get(`/deployments/${id}/log?lines=all`)).body.text);
  expect(done.status).toBe("active");
}

async function createDatabase(kind: string, name: string, settings: Record<string, unknown> = {}) {
  const reply = await owner.post(`/environments/${environmentId}/services`, {
    kind,
    name,
    serverId,
    ...settings,
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  const service = reply.body.service as { id: string; appName: string; name: string };
  await deployAndWait(service.id, name);
  const secrets = (await owner.post(`/services/${service.id}/connection/reveal`, {})).body
    .connection as { password: string; user: string | null; database: string | null };
  return { ...service, password: secrets.password, user: secrets.user, database: secrets.database };
}

async function waitRun(id: string, name: string) {
  const done = await eventually(
    `run ${name} to finish`,
    async () => {
      const view = (await owner.get(`/backup-runs/${id}`)).body.run;
      return view.open ? null : view;
    },
    600_000,
    1500,
  );
  await log(`run-${name}-${id.slice(0, 8)}`, (await owner.get(`/backup-runs/${id}/log`)).body.text);
  return done as { status: string; error: string | null; file: { key: string } | null };
}

async function scheduleFor(serviceId: string, body: Record<string, unknown> = {}) {
  const reply = await owner.post(`/services/${serviceId}/backup-schedules`, {
    destinationId,
    folder: "daily",
    cron: "0 3 * * *",
    keep: null,
    ...body,
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  return reply.body.schedule as { id: string; prefix: string };
}

async function backupNow(scheduleId: string, name: string) {
  const started = await owner.post(`/backup-schedules/${scheduleId}/run`, {});
  expect(started.status).toBe(202);
  const done = await waitRun(started.body.run.id, name);
  if (done.status !== "succeeded") throw new Error(`${name} backup ${done.status}: ${done.error}`);
  return done;
}

async function restore(
  serviceId: string,
  name: string,
  key: string,
  extra: Record<string, unknown> = {},
) {
  const started = await owner.post(`/services/${serviceId}/restores`, {
    destinationId,
    key,
    confirm: name,
    ...extra,
  });
  if (started.status !== 202) throw new Error(JSON.stringify(started.body));
  const done = await waitRun(started.body.run.id, `${name}-restore`);
  if (done.status !== "succeeded") throw new Error(`${name} restore ${done.status}: ${done.error}`);
  return done;
}

/** Puts a file made inside the host into MinIO under a key, as 0.1.x left its backups there. */
async function putInBucket(path: string, key: string): Promise<void> {
  await HOST.must(
    `docker run --rm -v /tmp/nz-legacy:/up -e RCLONE_CONFIG_M_TYPE=s3 -e RCLONE_CONFIG_M_PROVIDER=Minio -e RCLONE_CONFIG_M_ACCESS_KEY_ID=${MINIO_USER} -e RCLONE_CONFIG_M_SECRET_ACCESS_KEY=${MINIO_PASSWORD} -e RCLONE_CONFIG_M_ENDPOINT=${minioEndpoint} ${TOOLS_IMAGE} copyto /up/${path} m:${BUCKET}/${key}`,
  );
}

async function listed(serviceId: string, folder: string): Promise<string[]> {
  const reply = await owner.get(
    `/services/${serviceId}/backup-files?destinationId=${destinationId}&folder=${folder}`,
  );
  expect(reply.status).toBe(200);
  return reply.body.files.map((file: { name: string }) => file.name);
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  const target =
    PLATFORM === "linux/arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-musl-baseline";
  await $`bun build ${join(ROOT, "runner", "src", "main.ts")} --compile --target=${target} --outfile=${join(WORK, "nearzero-runner")}`.quiet();
  await HOST.start();
  await HOST.must("apk add --no-cache -q libstdc++ libgcc curl >/dev/null");
  await HOST.copyIn(join(WORK, "nearzero-runner"), "/usr/local/bin/nearzero-runner");
  await HOST.must(
    `docker pull -q ${ROUTER_IMAGE} >/dev/null && docker pull -q ${TOOLS_IMAGE} >/dev/null`,
  );
  // MinIO (Bitnami's pinned build; MinIO no longer publishes images on Docker Hub) on the
  // host's own port 9000, inside the DinD host only, reached by the runner's helpers through
  // the default network's gateway.
  await HOST.must(`docker pull -q ${MINIO_IMAGE} >/dev/null`);
  await HOST.must(
    `docker run -d --name nz-minio -p 9000:9000 -e MINIO_ROOT_USER=${MINIO_USER} -e MINIO_ROOT_PASSWORD=${MINIO_PASSWORD} ${MINIO_IMAGE}`,
  );
  const gateway = (
    await HOST.must("docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'")
  ).trim();
  minioEndpoint = `http://${gateway}:9000`;
  await eventually("MinIO to answer", async () => {
    const result = await HOST.exec(`curl -sf ${minioEndpoint}/minio/health/live`);
    return result.code === 0;
  });
  await HOST.must(
    `docker run --rm -e RCLONE_CONFIG_M_TYPE=s3 -e RCLONE_CONFIG_M_PROVIDER=Minio -e RCLONE_CONFIG_M_ACCESS_KEY_ID=${MINIO_USER} -e RCLONE_CONFIG_M_SECRET_ACCESS_KEY=${MINIO_PASSWORD} -e RCLONE_CONFIG_M_ENDPOINT=${minioEndpoint} ${TOOLS_IMAGE} mkdir m:${BUCKET}`,
  );

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
  harness.services.hostnameProviders = new HostnameProviders();
  harness.services.hostnameProviders.register("e2e", async (request) => {
    const row = await harness.test.db
      .selectFrom("service")
      .select("name")
      .where("id", "=", request.serviceId)
      .executeTakeFirstOrThrow();
    return {
      routes: [{ host: `${row.name}.test.localhost`, path: "/", port: request.port, https: false }],
      notes: [],
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

describe("backups to MinIO through the runner", () => {
  test("the runner joins and a destination tests as connected", async () => {
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
        TZ: "Europe/Berlin",
      },
    );
    await eventually(
      "the server to be ready",
      async () => (await owner.get(`/servers/${serverId}`)).body.server?.readiness === "ready",
      180_000,
      1000,
    );
    const project = await owner.post("/projects", { name: "Data" });
    environmentId = project.body.environmentId;

    const added = await owner.post("/backup-destinations", {
      name: "MinIO",
      provider: "minio",
      endpoint: minioEndpoint,
      bucket: BUCKET,
      region: "us-east-1",
      accessKeyId: MINIO_USER,
      secretAccessKey: MINIO_PASSWORD,
    });
    expect(added.status).toBe(201);
    destinationId = added.body.destination.id;
    const tested = await owner.post(`/backup-destinations/${destinationId}/test`, { serverId });
    expect(tested.body).toMatchObject({
      ok: true,
      message: `Connected. Nearzero can list ${BUCKET}.`,
    });

    const wrong = await owner.post("/backup-destinations", {
      name: "Wrong keys",
      provider: "minio",
      endpoint: minioEndpoint,
      bucket: BUCKET,
      region: "us-east-1",
      accessKeyId: MINIO_USER,
      secretAccessKey: "not-the-secret-at-all",
    });
    const started = Date.now();
    const failed = await owner.post(`/backup-destinations/${wrong.body.destination.id}/test`, {
      serverId,
    });
    expect(failed.body.ok).toBe(false);
    expect(failed.body.message).toBe(
      "Could not reach the bucket. Check the endpoint, bucket, region and keys.",
    );
    expect(Date.now() - started).toBeLessThan(20_000);
    // The server's time zone came from the runner.
    const panelZone = await harness.test.db
      .selectFrom("runner")
      .select("system")
      .where("server_id", "=", serverId)
      .executeTakeFirstOrThrow();
    expect((panelZone.system as { timeZone?: string }).timeZone).toBe("Europe/Berlin");
  }, 600_000);

  test("Postgres: back up, drop the table, restore; with Keep 2 three runs leave two files", async () => {
    const db = await createDatabase("postgres", "pg");
    const container = await containerOf(db.id);
    const psql = (query: string) =>
      HOST.must(`docker exec ${container} psql -U ${db.user} -d ${db.database} -tAc "${query}"`);
    await psql(
      "create table items (id int primary key, name text); insert into items values (1, 'one'), (2, 'two'), (3, 'three')",
    );
    const schedule = await scheduleFor(db.id, { keep: 2 });
    const first = await backupNow(schedule.id, "pg");
    expect(first.file?.key.startsWith(`${db.appName}/daily/`)).toBe(true);
    expect(await bucketFiles(schedule.prefix)).toHaveLength(1);
    await psql("drop table items");
    await restore(db.id, "pg", first.file?.key as string);
    expect((await psql("select count(*) from items")).trim()).toBe("3");
    // C2-03: tables, views and foreign keys added since the backup don't stop a restore, which
    // brings back the database the backup holds.
    await psql(
      "create table orders (id int, item int references items(id)); insert into orders values (1, 1); create view first_items as select * from items where id = 1; delete from items where id = 3",
    );
    await restore(db.id, "pg", first.file?.key as string);
    expect((await psql("select count(*) from items")).trim()).toBe("3");
    expect((await psql("select coalesce(to_regclass('public.orders')::text, 'gone')")).trim()).toBe(
      "gone",
    );
    for (const round of [2, 3]) {
      await Bun.sleep(1100);
      await backupNow(schedule.id, `pg-${round}`);
    }
    const files = await bucketFiles(schedule.prefix);
    expect(files).toHaveLength(2);
    const listed = await owner.get(
      `/services/${db.id}/backup-files?destinationId=${destinationId}&folder=daily`,
    );
    expect(listed.body.files.map((file: { name: string }) => file.name).sort()).toEqual(
      files.sort(),
    );
  }, 1_200_000);

  test("MySQL: back up, delete rows, restore", async () => {
    const db = await createDatabase("mysql", "my", { settings: { databaseName: "app" } });
    const container = await containerOf(db.id);
    const mysql = (query: string) =>
      HOST.must(
        `docker exec -e MYSQL_PWD=${db.password} ${container} mysql -u${db.user} ${db.database} -N -e "${query}"`,
      );
    await mysql(
      "create table items (id int primary key, name varchar(20)); insert into items values (1, 'one'), (2, 'two')",
    );
    const schedule = await scheduleFor(db.id);
    const done = await backupNow(schedule.id, "mysql");
    await mysql("delete from items");
    expect((await mysql("select count(*) from items")).trim()).toBe("0");
    await restore(db.id, "my", done.file?.key as string);
    expect((await mysql("select count(*) from items")).trim()).toBe("2");
  }, 1_200_000);

  test("MariaDB: back up, drop the table, restore", async () => {
    const db = await createDatabase("mariadb", "maria");
    const container = await containerOf(db.id);
    const sqlRun = (query: string) =>
      HOST.must(
        `docker exec -e MYSQL_PWD=${db.password} ${container} mariadb -u${db.user} ${db.database} -N -e "${query}"`,
      );
    await sqlRun(
      "create table items (id int primary key); insert into items values (1), (2), (3), (4)",
    );
    const schedule = await scheduleFor(db.id);
    const done = await backupNow(schedule.id, "mariadb");
    await sqlRun("drop table items");
    await restore(db.id, "maria", done.file?.key as string);
    expect((await sqlRun("select count(*) from items")).trim()).toBe("4");
  }, 1_200_000);

  test("MongoDB: back up, drop the collection, restore", async () => {
    const db = await createDatabase("mongodb", "mongo");
    const container = await containerOf(db.id);
    const mongo = (script: string) =>
      HOST.must(
        `docker exec ${container} mongosh --quiet -u ${db.user} -p ${db.password} --authenticationDatabase admin shop --eval "${script}"`,
      );
    await mongo("db.items.insertMany([{n: 1}, {n: 2}, {n: 3}]); print(db.items.countDocuments())");
    const schedule = await scheduleFor(db.id);
    const done = await backupNow(schedule.id, "mongodb");
    expect(done.file?.key.endsWith(".archive.gz")).toBe(true);
    await mongo("db.items.drop()");
    expect((await mongo("print(db.items.countDocuments())")).trim()).toBe("0");
    await restore(db.id, "mongo", done.file?.key as string);
    expect((await mongo("print(db.items.countDocuments())")).trim()).toBe("3");
  }, 1_200_000);

  test("libSQL: back up, drop the table, restore", async () => {
    const db = await createDatabase("libsql", "lite");
    await containerOf(db.id);
    const auth = Buffer.from(`${db.user}:${db.password}`).toString("base64");
    // Statements through libSQL's HTTP API from a helper on the database's network.
    const execute = async (statements: string[]) => {
      const body = JSON.stringify({
        requests: [
          ...statements.map((sql) => ({ type: "execute", stmt: { sql } })),
          { type: "close" },
        ],
      });
      return HOST.must(
        `docker run --rm --network nearzero-edge curlimages/curl:8.11.1 -s -H 'Authorization: Basic ${auth}' -H 'Content-Type: application/json' -d '${body}' http://${db.appName}:8080/v2/pipeline`,
      );
    };
    await eventually(
      "libSQL to answer",
      async () => (await execute(["select 1"])).includes('"ok"'),
      60_000,
    );
    const inserted = await execute([
      "create table items (id integer primary key, amount integer)",
      // No single quotes: the request goes through a shell's single-quoted argument.
      "insert into items values (1, 10), (2, 20), (3, 30), (4, 40), (5, 50)",
    ]);
    expect(inserted).not.toContain('"type":"error"');
    expect(await execute(["select count(*) from items"])).toContain('"value":"5"');
    const schedule = await scheduleFor(db.id);
    const done = await backupNow(schedule.id, "libsql");
    await execute(["drop table items"]);
    expect(await execute(["select count(*) from items"])).toContain('"type":"error"');
    await restore(db.id, "lite", done.file?.key as string);
    const counted = await execute(["select count(*) from items"]);
    expect(counted).toContain('"value":"5"');
  }, 1_200_000);

  test("an nginx volume: back up, delete a file inside it, restore in place, the app still runs", async () => {
    const created = await owner.post(`/environments/${environmentId}/services`, {
      kind: "application",
      name: "site",
      serverId,
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    expect(created.status).toBe(201);
    const id = created.body.service.id as string;
    const appName = created.body.service.appName as string;
    await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 3 });
    const mounted = await owner.put(`/services/${id}/mounts`, {
      mounts: [{ type: "volume", name: "html", containerPath: "/usr/share/nginx/html" }],
    });
    expect(mounted.status).toBe(200);
    await deployAndWait(id, "site");
    const container = await containerOf(id);
    await HOST.must(
      `docker exec ${container} sh -c 'echo backed-up-page > /usr/share/nginx/html/keep.html && chown 101:101 /usr/share/nginx/html/keep.html'`,
    );
    const panel = await owner.get(`/services/${id}/backups`);
    const volume = `${appName}-html`;
    expect(panel.body.volumes.volumes.map((item: { name: string }) => item.name)).toContain(volume);
    const schedule = await scheduleFor(id, { volume, stopService: true });
    const done = await backupNow(schedule.id, "volume");
    expect(done.file?.key.endsWith(".tar.gz")).toBe(true);
    // Named after its volume, so two volumes' schedules can share a folder (G3-20).
    expect(done.file?.key.startsWith(`${schedule.prefix}${volume}-`)).toBe(true);
    expect(await bucketFiles(schedule.prefix)).toHaveLength(1);
    // The app is running again after the copy.
    expect((await HOST.must(`docker inspect -f '{{.State.Running}}' ${container}`)).trim()).toBe(
      "true",
    );

    await HOST.must(`docker exec ${container} rm /usr/share/nginx/html/keep.html`);
    await HOST.must(
      `docker exec ${container} sh -c 'echo stray > /usr/share/nginx/html/stray.html'`,
    );
    await restore(id, "site", done.file?.key as string, { volume });
    const after = await containerOf(id);
    expect((await HOST.must(`docker inspect -f '{{.State.Running}}' ${after}`)).trim()).toBe(
      "true",
    );
    expect(
      (await HOST.must(`docker exec ${after} cat /usr/share/nginx/html/keep.html`)).trim(),
    ).toBe("backed-up-page");
    expect(
      (await HOST.must(`docker exec ${after} stat -c %u /usr/share/nginx/html/keep.html`)).trim(),
    ).toBe("101");
    expect(
      (await HOST.exec(`docker exec ${after} test -e /usr/share/nginx/html/stray.html`)).code,
    ).not.toBe(0);
    const served = await HOST.exec(
      `curl -s -m 10 -H 'Host: site.test.localhost' http://127.0.0.1/keep.html`,
    );
    expect(served.out).toContain("backed-up-page");

    // A volume another container also uses is refused.
    await HOST.must(`docker run -d --name nz-other -v ${volume}:/data alpine:3.22 sleep 600`);
    const shared = await owner.post(`/services/${id}/restores`, {
      destinationId,
      key: done.file?.key,
      confirm: "site",
      volume,
    });
    expect(shared.status).toBe(409);
    expect(shared.body.error.message).toBe(
      "Another service also uses this volume, so Nearzero won't overwrite it.",
    );
    // No helper or scratch volume is left behind.
    const leftovers = await HOST.must(
      "docker ps -aq --filter label=dev.nearzero.backup-run; docker volume ls -q --filter label=dev.nearzero.backup-run",
    );
    expect(leftovers.trim()).toBe("");
  }, 1_200_000);
});

describe("restoring into the database a backup came from, and 0.1.x's backups (R3-45, R2-06, R3-44, R3-51)", () => {
  beforeAll(async () => {
    await HOST.must("mkdir -p /tmp/nz-legacy");
  });

  test("Postgres: a non-default database restores into itself; a 0.1.x archive restores through pg_restore", async () => {
    const db = await createDatabase("postgres", "pg-two");
    const container = await containerOf(db.id);
    const psql = (database: string, query: string) =>
      HOST.must(`docker exec ${container} psql -U ${db.user} -d ${database} -tAc "${query}"`);
    await psql(db.database as string, "create database analytics");
    await psql(
      "analytics",
      "create table events (id int); insert into events values (1), (2), (3)",
    );
    await psql(
      db.database as string,
      "create table keepme (id int); insert into keepme values (1)",
    );
    const schedule = await scheduleFor(db.id, { database: "analytics", folder: "analytics" });
    const done = await backupNow(schedule.id, "pg-analytics");
    await psql("analytics", "drop table events");
    const restored = await restore(db.id, "pg-two", done.file?.key as string);
    expect(restored.status).toBe("succeeded");
    expect((await psql("analytics", "select count(*) from events")).trim()).toBe("3");
    // The service's own database was left alone.
    expect((await psql(db.database as string, "select count(*) from keepme")).trim()).toBe("1");
    expect(
      (
        await psql(
          db.database as string,
          "select count(*) from pg_tables where tablename = 'events'",
        )
      ).trim(),
    ).toBe("0");

    // 0.1.x wrote gzipped pg_dump archives with milliseconds in the name.
    await HOST.must(
      `docker exec ${container} sh -c 'pg_dump -U ${db.user} -d analytics -Fc | gzip' > /tmp/nz-legacy/pg.sql.gz`,
    );
    const legacy = "2026-11-20T03-00-00-123Z.sql.gz";
    await putInBucket("pg.sql.gz", `${db.appName}/legacy/${legacy}`);
    expect(await listed(db.id, "legacy")).toEqual([legacy]);
    await psql("analytics", "drop table events");
    await restore(db.id, "pg-two", `${db.appName}/legacy/${legacy}`, { database: "analytics" });
    expect((await psql("analytics", "select count(*) from events")).trim()).toBe("3");
  }, 1_200_000);

  test("MySQL and MongoDB: 0.1.x's dumps (no database named, .bson.gz) restore", async () => {
    const my = await createDatabase("mysql", "my-legacy", { settings: { databaseName: "app" } });
    const myContainer = await containerOf(my.id);
    const mysql = (query: string) =>
      HOST.must(
        `docker exec -e MYSQL_PWD=${my.password} ${myContainer} mysql -u${my.user} app -N -e "${query}"`,
      );
    await mysql("create table items (id int primary key); insert into items values (1), (2), (3)");
    await HOST.must(
      `docker exec -e MYSQL_PWD=${my.password} ${myContainer} sh -c 'mysqldump -u${my.user} --no-tablespaces --single-transaction app | gzip' > /tmp/nz-legacy/my.sql.gz`,
    );
    const myLegacy = "2026-11-21T03-00-00-456Z.sql.gz";
    await putInBucket("my.sql.gz", `${my.appName}/legacy/${myLegacy}`);
    expect(await listed(my.id, "legacy")).toEqual([myLegacy]);
    await mysql("delete from items");
    await restore(my.id, "my-legacy", `${my.appName}/legacy/${myLegacy}`);
    expect((await mysql("select count(*) from items")).trim()).toBe("3");

    const mongo = await createDatabase("mongodb", "mongo-legacy");
    const mongoContainer = await containerOf(mongo.id);
    const mongosh = (script: string) =>
      HOST.must(
        `docker exec ${mongoContainer} mongosh --quiet -u ${mongo.user} -p ${mongo.password} --authenticationDatabase admin shop --eval "${script}"`,
      );
    await mongosh("db.items.insertMany([{n: 1}, {n: 2}]); print(db.items.countDocuments())");
    await HOST.must(
      `docker exec ${mongoContainer} mongodump -u ${mongo.user} -p ${mongo.password} --authenticationDatabase admin --archive --gzip > /tmp/nz-legacy/mongo.bson.gz`,
    );
    const mongoLegacy = "2026-11-21T03-00-00-789Z.bson.gz";
    await putInBucket("mongo.bson.gz", `${mongo.appName}/${mongoLegacy}`);
    // A folderless 0.1.x schedule wrote straight under the app name.
    expect(await listed(mongo.id, "")).toEqual([mongoLegacy]);
    await mongosh("db.items.drop()");
    await restore(mongo.id, "mongo-legacy", `${mongo.appName}/${mongoLegacy}`);
    expect((await mongosh("print(db.items.countDocuments())")).trim()).toBe("2");
  }, 1_200_000);

  test("libSQL: a data-folder archive (namespaced backups, 0.1.x's) backs up and restores", async () => {
    const db = await createDatabase("libsql", "lite-archive");
    await containerOf(db.id);
    const auth = Buffer.from(`${db.user}:${db.password}`).toString("base64");
    const execute = async (statements: string[]) => {
      const body = JSON.stringify({
        requests: [
          ...statements.map((sql) => ({ type: "execute", stmt: { sql } })),
          { type: "close" },
        ],
      });
      return HOST.must(
        `docker run --rm --network nearzero-edge curlimages/curl:8.11.1 -s -H 'Authorization: Basic ${auth}' -H 'Content-Type: application/json' -d '${body}' http://${db.appName}:8080/v2/pipeline`,
      );
    };
    await eventually(
      "libSQL to answer",
      async () => (await execute(["select 1"])).includes('"ok"'),
      60_000,
    );
    await execute([
      "create table items (id integer primary key)",
      "insert into items values (1), (2), (3)",
    ]);
    // With namespaces on, its whole data folder is archived (R3-51).
    const row = await harness.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", db.id)
      .executeTakeFirstOrThrow();
    await harness.test.db
      .updateTable("service")
      .set({ settings: JSON.stringify({ ...row.settings, namespaces: true }) })
      .where("id", "=", db.id)
      .execute();
    const schedule = await scheduleFor(db.id, { folder: "archive" });
    const done = await backupNow(schedule.id, "libsql-archive");
    expect(done.file?.key.endsWith(".tar.gz")).toBe(true);
    await eventually(
      "libSQL to answer after the copy",
      async () => (await execute(["select 1"])).includes('"ok"'),
      60_000,
    );
    await execute(["drop table items"]);
    await restore(db.id, "lite-archive", done.file?.key as string);
    await eventually(
      "libSQL to answer after the restore",
      async () => (await execute(["select count(*) from items"])).includes('"value":"3"'),
      60_000,
    );
    // 0.1.x named the same kind of archive .sql.gz.
    await HOST.must(
      `docker run --rm -e RCLONE_CONFIG_M_TYPE=s3 -e RCLONE_CONFIG_M_PROVIDER=Minio -e RCLONE_CONFIG_M_ACCESS_KEY_ID=${MINIO_USER} -e RCLONE_CONFIG_M_SECRET_ACCESS_KEY=${MINIO_PASSWORD} -e RCLONE_CONFIG_M_ENDPOINT=${minioEndpoint} ${TOOLS_IMAGE} copyto m:${BUCKET}/${done.file?.key} m:${BUCKET}/${db.appName}/legacy/2026-11-22T03-00-00-001Z.sql.gz`,
    );
    await execute(["drop table items"]);
    await restore(db.id, "lite-archive", `${db.appName}/legacy/2026-11-22T03-00-00-001Z.sql.gz`);
    await eventually(
      "libSQL to answer after the 0.1.x restore",
      async () => (await execute(["select count(*) from items"])).includes('"value":"3"'),
      60_000,
    );
  }, 1_200_000);

  test("a volume: 0.1.x's plain <volume>-<time>.tar restores in place", async () => {
    const created = await owner.post(`/environments/${environmentId}/services`, {
      kind: "application",
      name: "site-legacy",
      serverId,
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    expect(created.status).toBe(201);
    const id = created.body.service.id as string;
    const appName = created.body.service.appName as string;
    await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 3 });
    await owner.put(`/services/${id}/mounts`, {
      mounts: [{ type: "volume", name: "html", containerPath: "/usr/share/nginx/html" }],
    });
    await deployAndWait(id, "site-legacy");
    const container = await containerOf(id);
    const volume = `${appName}-html`;
    await HOST.must(
      `docker exec ${container} sh -c 'echo legacy-page > /usr/share/nginx/html/old.html'`,
    );
    await HOST.must(
      `docker run --rm -v ${volume}:/source alpine:3.22 tar -c -C /source . > /tmp/nz-legacy/vol.tar`,
    );
    const legacy = `html-2026-11-23T03-00-00-001Z.tar`;
    await putInBucket("vol.tar", `${appName}/legacy/${legacy}`);
    expect(await listed(id, "legacy")).toEqual([legacy]);
    await HOST.must(`docker exec ${container} rm /usr/share/nginx/html/old.html`);
    await restore(id, "site-legacy", `${appName}/legacy/${legacy}`, { volume });
    const after = await containerOf(id);
    expect(
      (await HOST.must(`docker exec ${after} cat /usr/share/nginx/html/old.html`)).trim(),
    ).toBe("legacy-page");
  }, 1_200_000);
});
