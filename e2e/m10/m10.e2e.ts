import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { storagePercent } from "@nearzero/shared";
import { $ } from "bun";
import { ObjectRegistry } from "../../apps/control/src/access/objects.ts";
import { HostnameProviders } from "../../apps/control/src/deploys/hostnames.ts";
import { createJobCatalog } from "../../apps/control/src/jobs/catalog.ts";
import { JobQueue } from "../../apps/control/src/jobs/queue.ts";
import { JobWorker } from "../../apps/control/src/jobs/worker.ts";
import { silentLogger } from "../../apps/control/src/log.ts";
import {
  type Dispatcher,
  startNotificationDispatcher,
} from "../../apps/control/src/notifications/dispatcher.ts";
import { setNotificationTransport } from "../../apps/control/src/notifications/transport.ts";
import { registerProjectObjects } from "../../apps/control/src/projects/objects.ts";
import { createJoinToken } from "../../apps/control/src/runners/credentials.ts";
import { createLinkCertificate } from "../../apps/control/src/runners/link-certificate.ts";
import { serveRunnerLink } from "../../apps/control/src/runners/link-paths.ts";
import { socketServer, upgraderFor } from "../../apps/control/src/runners/sockets.ts";
import { registerServerObjects } from "../../apps/control/src/servers/servers.ts";
import { startTaskScheduler } from "../../apps/control/src/tasks/scheduler.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  setUpOwner,
} from "../../apps/control/test/support/harness.ts";
import { DindHost, eventually, PLATFORM } from "../runner/dind.ts";

/**
 * The M10 suite against a Docker-in-Docker host (spec 12, 13, 14, 15):
 *
 *   until mkdir /tmp/nearzero-next-dind.lock 2>/dev/null; do sleep 10; done
 *   bun run --cwd e2e test:m10; rmdir /tmp/nearzero-next-dind.lock
 *
 * The control plane runs in this process on 127.0.0.1:4232 with its job worker, the task
 * scheduler and the notification dispatcher. Inside the host, compiled for linux, run two
 * runners: the Nearzero host's (it owns the router) and a server's (it leaves the router alone).
 * - Tasks run in an nginx app's container and on the server, on demand and on an every-minute
 *   schedule in Asia/Kolkata; a syntax error is refused by the server's own bash; Stop kills a
 *   run and what it started.
 * - The host router logs requests (on by default); after 100 requests to the app, Analytics
 *   shows 100, the right status mix, and the app's host first in Busiest hosts.
 * - Metrics arrive every 5 seconds, and a 30-second CPU load above the threshold sends exactly
 *   one alert to a webhook channel on a local fake server.
 * - Storage usage matches `df -P /` on the host: used, available and its Use% (30c R3-34).
 * - A server whose runner stops is shown as not reporting a minute later, with when its last
 *   sample was taken and no current figures (30c R3-33).
 * NZ1_E2E_KEEP=1 keeps the host.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `m10-${Date.now().toString(36)}`);
const HOST = new DindHost("nz1-m10-dind");
const PORT = 4232;
/**
 * The runner link's own TLS port (an install's 3443): the server joins there with the
 * certificate's fingerprint, since a remote runner never uses plain HTTP (spec 31, C4-02).
 */
const LINK_PORT = 4239;
const LINK = createLinkCertificate(["127.0.0.1"]);
const CONTROL_FROM_HOST = `https://host.docker.internal:${LINK_PORT}`;
const KEEP = process.env.NZ1_E2E_KEEP === "1";
const ROUTER_IMAGE = "traefik:v3.7.18";
const APP_IMAGE = "nginx:1.27-alpine";
const APP_HOST = "web.m10.localhost";

let harness: Harness;
let owner: Browser;
let server: ReturnType<typeof Bun.serve>;
let linkServer: ReturnType<typeof Bun.serve>;
let worker: JobWorker;
let dispatcher: Dispatcher;
let hook: ReturnType<typeof Bun.serve>;
const alerts: Record<string, unknown>[] = [];
let serverId = "";
let appId = "";

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

async function waitRun(id: string, name: string, timeoutMs = 120_000) {
  const done = await eventually(
    `run ${name} to finish`,
    async () => {
      const view = (await owner.get(`/task-runs/${id}`)).body.run;
      return view?.open ? null : view;
    },
    timeoutMs,
    1000,
  );
  await log(`run-${name}`, `${done.status} ${done.error ?? ""}\n${done.log ?? ""}`);
  return done as { status: string; log: string; error: string | null; exitCode: number | null };
}

async function createTask(body: Record<string, unknown>) {
  const reply = await owner.post("/tasks", { cron: "0 0 * * *", timeZone: "", ...body });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  return reply.body.task as { id: string; name: string };
}

async function runNow(taskId: string) {
  const reply = await owner.post(`/tasks/${taskId}/run`, {});
  if (reply.status !== 202) throw new Error(JSON.stringify(reply.body));
  return reply.body.run as { id: string };
}

function runnerEnv(stateDir: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    NEARZERO_RUNNER_STATE_DIR: stateDir,
    NEARZERO_RUNNER_CONTAINERIZED: "false",
    NEARZERO_ROUTER_DIR: "/etc/nearzero/router",
    NEARZERO_ROUTER_HOST_DIR: "/etc/nearzero/router",
    NEARZERO_ROUTER_IMAGE: ROUTER_IMAGE,
    ...extra,
  };
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  const target =
    PLATFORM === "linux/arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-musl-baseline";
  await $`bun build ${join(ROOT, "runner", "src", "main.ts")} --compile --target=${target} --outfile=${join(WORK, "nearzero-runner")}`.quiet();
  // A busy machine can take longer than the helper's 90 seconds to start the inner engine.
  await HOST.start().catch(async () => {
    await eventually(
      "the inner Docker Engine",
      async () => (await HOST.exec("docker info >/dev/null 2>&1")).code === 0,
      240_000,
      2000,
    );
  });
  await HOST.must("apk add --no-cache -q libstdc++ libgcc curl bash procps >/dev/null");
  await HOST.copyIn(join(WORK, "nearzero-runner"), "/usr/local/bin/nearzero-runner");
  await HOST.must(
    `docker pull -q ${ROUTER_IMAGE} >/dev/null && docker pull -q ${APP_IMAGE} >/dev/null`,
  );

  hook = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request) => {
      alerts.push((await request.json().catch(() => ({}))) as Record<string, unknown>);
      return Response.json({ ok: true });
    },
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
  harness.services.hostnameProviders = new HostnameProviders();
  harness.services.hostnameProviders.register("e2e", async (request) => ({
    routes: [{ host: APP_HOST, path: "/", port: request.port, https: false }],
    notes: [],
  }));
  // Notifications go out for real, to the local fake webhook; retries come quickly.
  setNotificationTransport(harness.services, {
    http: (input, init) => fetch(input, init),
    retryDelaysMs: [500, 500, 500],
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
  await startTaskScheduler(harness.test.db);
  dispatcher = startNotificationDispatcher(harness.services, 1_000);
  owner = await setUpOwner(harness);
  await owner.post("/onboarding/workspace", { name: "Maya Lopez", workspaceName: "Acme" });
  await owner.post("/onboarding/skip-invitations");

  // The Nearzero host's runner: a host join token, as the control plane leaves one at start.
  const hostToken = await createJoinToken(harness.test.db, null, { ttlMs: 60 * 60_000 });
  await HOST.background(
    `/usr/local/bin/nearzero-runner join ${CONTROL_FROM_HOST} ${hostToken.token} --fingerprint sha256:${LINK.fingerprint}`,
    "/var/log/nearzero-runner-host.log",
    runnerEnv("/var/lib/nz-host", { TZ: "UTC" }),
  );
  // A server's runner on the same machine, which leaves the router to the host's.
  const generated = await owner.post("/ssh-keys/generate", { type: "ed25519", name: "dind" });
  const key = await owner.post("/ssh-keys", {
    name: "dind",
    publicKey: generated.body.publicKey,
    privateKey: generated.body.privateKey,
  });
  const created = await owner.post("/servers", {
    name: "worker-1",
    sshKeyId: key.body.key.id,
    address: "127.0.0.2",
    port: 22,
    sshUser: "root",
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  serverId = created.body.server.id;
  const joined = await owner.post(`/servers/${serverId}/join-command`);
  await HOST.background(
    `/usr/local/bin/nearzero-runner join ${CONTROL_FROM_HOST} ${joined.body.token} --fingerprint sha256:${LINK.fingerprint}`,
    "/var/log/nearzero-runner-server.log",
    // Its own router folder, so its (empty) route sync never touches the host's files.
    runnerEnv("/var/lib/nz-server", {
      NEARZERO_ROUTER_MANAGED: "false",
      NEARZERO_ROUTER_DIR: "/etc/nearzero/router-server",
      NEARZERO_ROUTER_HOST_DIR: "/etc/nearzero/router-server",
      NEARZERO_RUNNER_WORK_DIR: "/var/lib/nz-server/work",
    }),
  );
  await eventually(
    "both runners to connect",
    async () =>
      harness.services.runners.isOnline("host") && harness.services.runners.isOnline(serverId),
    120_000,
    500,
  );
}, 1_800_000);

afterAll(async () => {
  for (const name of ["host", "server"]) {
    await HOST.exec(`cat /var/log/nearzero-runner-${name}.log`).then((result) =>
      log(`runner-${name}`, result.out),
    );
  }
  await dispatcher?.stop().catch(() => {});
  await worker?.stop({ graceMs: 1000 }).catch(() => {});
  harness?.services.runners.stop();
  server?.stop(true);
  linkServer?.stop(true);
  hook?.stop(true);
  await harness?.drop();
  if (KEEP) {
    console.log(`Kept ${HOST.name}; remove it with: docker rm -fv ${HOST.name}`);
    return;
  }
  await HOST.remove();
}, 300_000);

describe("M10 on a real server", () => {
  test("the host's router logs requests by default; an app is deployed behind it", async () => {
    await eventually(
      "the router to run with its request log",
      async () =>
        (
          await HOST.exec("docker inspect nearzero-router --format '{{json .Config.Cmd}}'")
        ).out.includes("--accesslog=true"),
      180_000,
      1000,
    );
    const project = await owner.post("/projects", { name: "Shop" });
    const reply = await owner.post(`/environments/${project.body.environmentId}/services`, {
      kind: "application",
      name: "web",
      serverId: "host",
      settings: { image: APP_IMAGE, servicePort: 80 },
    });
    if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
    appId = reply.body.service.id;
    await owner.patch(`/services/${appId}/deploy-settings`, { stabilitySeconds: 3 });
    const deploy = await owner.post(`/services/${appId}/deployments`, {});
    expect(deploy.status).toBe(202);
    const done = await eventually(
      "the app to deploy",
      async () => {
        const view = (await owner.get(`/deployments/${deploy.body.deployment.id}`)).body.deployment;
        return ["queued", "building"].includes(view.status) ? null : view;
      },
      600_000,
      2000,
    );
    await log(
      "deploy-web",
      (await owner.get(`/deployments/${deploy.body.deployment.id}/log?lines=all`)).body.text,
    );
    expect(done.status).toBe("active");
    await eventually(
      "the app to answer through the router",
      async () => {
        const body = (await HOST.exec(`curl -s -m 5 -H 'Host: ${APP_HOST}' http://127.0.0.1/`)).out;
        return body.includes("nginx");
      },
      60_000,
      1000,
    );
  }, 900_000);

  test("after 100 requests, Analytics shows 100, the status mix and the app's host (spec 13 acceptance)", async () => {
    // Requests before this point (the checks above) are cleared first.
    expect((await owner.post("/analytics/delete-all", {})).body.message).toBe(
      "Deleted every recorded request",
    );
    await HOST.must(
      `for i in $(seq 1 80); do curl -s -o /dev/null -H 'Host: ${APP_HOST}' http://127.0.0.1/; done; for i in $(seq 1 20); do curl -s -o /dev/null -H 'Host: ${APP_HOST}' http://127.0.0.1/missing-$i; done`,
    );
    const page = await eventually(
      "100 requests in Analytics",
      async () => {
        const reply = await owner.get(`/analytics?q=${APP_HOST}`);
        return reply.body.stats?.requests >= 100 ? reply.body : null;
      },
      30_000,
      1000,
    );
    await log(
      "analytics",
      JSON.stringify(
        { stats: page.stats, hosts: page.hosts, sample: page.table.entries[0] },
        null,
        2,
      ),
    );
    expect(page.recording).toMatchObject({ enabled: true, message: "Recording requests" });
    expect(page.stats).toMatchObject({
      requests: 100,
      errors: 20,
      clientErrors: 20,
      serverErrors: 0,
    });
    expect(page.stats.medianMs).not.toBeNull();
    expect(page.stats.p95Ms).toBeGreaterThanOrEqual(page.stats.medianMs);
    // Each busiest host shows its own errors too (R3-27).
    expect(page.hosts[0]).toEqual({ host: APP_HOST, requests: 100, errors: 20 });
    expect(page.table.total).toBe(100);
    expect(page.table.rangeText).toBe("1–25 of 100");
    expect(
      page.chart.buckets.reduce(
        (sum: number, bucket: { requests: number }) => sum + bucket.requests,
        0,
      ),
    ).toBe(100);
    const audited = await harness.test.db
      .selectFrom("audit_event")
      .select("action")
      .where("action", "=", "analytics.request-logs-deleted")
      .execute();
    expect(audited).toHaveLength(1);
  }, 120_000);

  test("tasks run in the app's container and on the server, on demand and on schedule", async () => {
    const inContainer = await createTask({
      name: "Container check",
      place: "container",
      serviceId: appId,
      shell: "sh",
      script: "echo in-container; nginx -v 2>&1; cat /etc/os-release | head -1",
    });
    const containerRun = await waitRun((await runNow(inContainer.id)).id, "container");
    expect(containerRun.status).toBe("succeeded");
    expect(containerRun.log).toContain("in-container");
    expect(containerRun.log).toContain("nginx version");

    const broken = await owner.post("/tasks", {
      name: "Broken",
      place: "server",
      serverId,
      cron: "0 0 * * *",
      script: "echo one\necho two\nfi\necho four\n",
    });
    expect(broken.status).toBe(400);
    expect(broken.body.error.fields.script).toContain("line 3");

    const onServer = await createTask({
      name: "Server check",
      place: "server",
      serverId,
      script:
        '#!/bin/bash\nset -e\necho "on $(uname -s) as $(id -un)"\nread -t 1 line || echo stdin-closed\n',
    });
    const serverRun = await waitRun((await runNow(onServer.id)).id, "server");
    expect(serverRun.status).toBe("succeeded");
    expect(serverRun.log).toContain("on Linux as root");
    expect(serverRun.log).toContain("stdin-closed");

    const failing = await createTask({
      name: "Exit 3",
      place: "server",
      serverId,
      script: "echo before; exit 3",
    });
    const failed = await waitRun((await runNow(failing.id)).id, "exit-3");
    expect(failed).toMatchObject({ status: "failed", exitCode: 3 });

    // Every minute in Asia/Kolkata: a scheduled run comes within the next minute or so.
    const scheduled = await createTask({
      name: "Every minute",
      place: "container",
      serviceId: appId,
      shell: "sh",
      cron: "* * * * *",
      timeZone: "Asia/Kolkata",
      script: "date -u +%H:%M:%S",
    });
    const view = (await owner.get(`/tasks/${scheduled.id}`)).body.task;
    expect(view.nextRunText).toContain("(Asia/Kolkata)");
    const due = new Date(view.nextRunAt).getTime();
    expect(due - Date.now()).toBeLessThanOrEqual(61_000);
    const run = await eventually(
      "the scheduled run",
      async () => {
        const runs = (await owner.get(`/tasks/${scheduled.id}/runs`)).body.runs as {
          trigger: string;
          status: string;
          startedAt: string;
          id: string;
        }[];
        return (
          runs.find((item) => item.trigger === "schedule" && item.status === "succeeded") ?? null
        );
      },
      150_000,
      2000,
    );
    // It ran on time: within a few seconds of its due minute.
    expect(Math.abs(new Date(run.startedAt).getTime() - due)).toBeLessThan(15_000);
    await owner.patch(`/tasks/${scheduled.id}`, { enabled: false });
  }, 600_000);

  test("Stop kills a run and what it started", async () => {
    const task = await createTask({
      name: "Long",
      place: "server",
      serverId,
      script: "sleep 290 & sleep 291; echo never",
    });
    const run = await runNow(task.id);
    await eventually(
      "the sleeps to start",
      async () =>
        (await HOST.exec("pgrep -f 'sleep 29[01]'")).out.trim().split("\n").filter(Boolean)
          .length >= 2,
      30_000,
      500,
    );
    const stopped = await owner.post(`/task-runs/${run.id}/stop`, {});
    expect(stopped.body.message).toBe("Run stopped");
    const done = await waitRun(run.id, "stopped", 30_000);
    expect(done.status).toBe("stopped");
    await eventually(
      "the sleeps to be gone",
      async () => (await HOST.exec("pgrep -f 'sleep 29[01]'")).out.trim() === "",
      20_000,
      500,
    );
  }, 120_000);

  test("metrics arrive, and a 30-second CPU load above the threshold sends exactly one alert (spec 14 acceptance)", async () => {
    const samples = await eventually(
      "the host's samples",
      async () => {
        const reply = await owner.get("/servers/host/metrics?points=50");
        return reply.body.samples?.length >= 3 ? reply.body.samples : null;
      },
      30_000,
      1000,
    );
    const latest = samples.at(-1);
    expect(latest.memoryTotalBytes).toBeGreaterThan(0);
    expect(latest.diskTotalBytes).toBeGreaterThan(0);
    // The machine Docker runs on is shared with other work, so the threshold sits above its
    // quiet load (at least 50%).
    await Bun.sleep(15_000);
    const quiet = (await owner.get("/servers/host/metrics?points=50")).body.samples as {
      cpuPercent: number;
    }[];
    const baseline = Math.max(...quiet.slice(-4).map((sample) => sample.cpuPercent));
    const threshold = Math.min(90, Math.max(50, Math.ceil(baseline + 20)));
    await log(
      "cpu-baseline",
      `baseline ${baseline}, threshold ${threshold}\n${JSON.stringify(quiet.map((sample) => sample.cpuPercent))}`,
    );
    const channel = await owner.post("/notification-channels", {
      name: "Alerts",
      type: "webhook",
      fields: { url: `http://127.0.0.1:${hook.port}/alerts` },
      events: ["server.alert"],
    });
    expect(channel.status).toBe(201);
    const set = await owner.put("/servers/host/alerts", {
      cpuThreshold: threshold,
      memoryThreshold: null,
    });
    expect(set.body.alerts).toMatchObject({ cpuThreshold: threshold, channels: 1 });
    alerts.length = 0;
    await HOST.background(
      "for i in $(seq 1 $(nproc)); do timeout 30 sh -c 'while :; do :; done' & done; wait",
      "/tmp/stress.log",
    );
    await Bun.sleep(45_000);
    const during = (await owner.get("/servers/host/metrics?points=50")).body.samples as {
      cpuPercent: number;
    }[];
    await log("cpu-stress", JSON.stringify(during.map((sample) => sample.cpuPercent)));
    await eventually("the alert", async () => alerts.length >= 1, 20_000, 500);
    await Bun.sleep(10_000);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ event: "server.alert", data: { metric: "cpu", threshold } });
    expect(String(alerts[0]?.summary)).toContain("CPU on Nearzero host is at");
    // A receiver written for 0.1.x reads its own fields (31c R3-37, 31d R4-14).
    expect(alerts[0]).toMatchObject({
      title: "Server CPU Alert",
      type: "CPU",
      alertType: "server-threshold",
      status: "alert",
      timestamp: (alerts[0] as { data: { at: string } }).data.at,
    });
  }, 300_000);

  test("Storage usage is the host's root filesystem as df counts it (30c R3-34)", async () => {
    const df = async () => {
      // Filesystem 1024-blocks Used Available Capacity Mounted-on
      const line = (await HOST.must("df -P / | tail -n 1")).trim().split(/\s+/);
      return {
        total: Number(line[1]) * 1024,
        used: Number(line[2]) * 1024,
        available: Number(line[3]) * 1024,
        percent: Number(String(line[4]).replace("%", "")),
      };
    };
    const latest = await eventually(
      "a sample with df's available figure",
      async () => {
        const reply = await owner.get("/servers/host/metrics?points=50");
        const sample = reply.body.latest;
        return typeof sample?.diskAvailableBytes === "number" ? sample : null;
      },
      30_000,
      1000,
    );
    const now = await df();
    await log("storage", JSON.stringify({ latest, df: now }, null, 2));
    // The same filesystem: its size is the same to the megabyte.
    expect(Math.abs(latest.diskTotalBytes - now.total)).toBeLessThan(1024 ** 2);
    // Docker on this machine writes all the time, so used and available move a little between
    // the sample and df.
    const slack = Math.max(2 * 1024 ** 3, now.total * 0.02);
    expect(Math.abs(latest.diskUsedBytes - now.used)).toBeLessThan(slack);
    expect(Math.abs(latest.diskAvailableBytes - now.available)).toBeLessThan(slack);
    expect(Math.abs(storagePercent(latest) - now.percent)).toBeLessThanOrEqual(2);
    // On df's own figures, the same Use%: GNU df (most servers) rounds up, as Nearzero does;
    // this host's BusyBox df rounds to the nearest, so it may read one less.
    const same = storagePercent({
      ...latest,
      diskAvailableBytes: now.available,
      diskUsedBytes: now.used,
    });
    expect(same).toBe(Math.ceil((now.used * 100) / (now.used + now.available)));
    expect([now.percent, now.percent + 1]).toContain(same);
  }, 120_000);

  test("a server whose runner stopped isn't shown as current a minute later (30c R3-33)", async () => {
    const before = (await owner.get(`/servers/${serverId}/metrics?points=50`)).body;
    expect(before.reporting.current).toBe(true);
    expect(before.latest).not.toBeNull();
    // Stop the server's runner (the one whose state folder is /var/lib/nz-server).
    await HOST.must(
      `for d in /proc/[0-9]*; do if tr '\\000' '\\n' < "$d/environ" 2>/dev/null | grep -qx 'NEARZERO_RUNNER_STATE_DIR=/var/lib/nz-server'; then kill "\${d#/proc/}"; fi; done; true`,
    );
    await eventually(
      "the server's runner to go",
      async () => !harness.services.runners.isOnline(serverId),
      30_000,
      500,
    );
    const stale = await eventually(
      "the server to stop reporting",
      async () => {
        const body = (await owner.get(`/servers/${serverId}/metrics?points=50`)).body;
        return body.reporting.current ? null : body;
      },
      120_000,
      2_000,
    );
    await log("not-reporting", JSON.stringify(stale.reporting, null, 2));
    expect(stale.latest).toBeNull();
    expect(stale.samples.length).toBeGreaterThan(0);
    expect(stale.reporting.message).toStartWith(
      "worker-1 isn't reporting. The last sample was taken ",
    );
    expect(stale.reporting.lastSampleAt).toBe(new Date(stale.samples.at(-1).at).toISOString());
  }, 240_000);
});
