import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  passwordlessSudoMessage,
  SETUP_STEPS,
  VALIDATION_VERDICTS,
  wrongUserMessage,
} from "@nearzero/shared";
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
import { configureServerSetup } from "../../apps/control/src/server-setup/settings.ts";
import { registerServerObjects } from "../../apps/control/src/servers/servers.ts";
import { generateKeyPair } from "../../apps/control/src/ssh-keys/format.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  setUpOwner,
} from "../../apps/control/test/support/harness.ts";
import { e2eName, eventually, PLATFORM } from "../runner/dind.ts";

/**
 * Setting servers up over SSH (M6, spec 09 9.3–9.6), against test servers that run Docker inside
 * themselves:
 *
 *   until mkdir /tmp/nearzero-next-dind.lock 2>/dev/null; do sleep 10; done
 *   bun run --cwd e2e test:server-setup; rmdir /tmp/nearzero-next-dind.lock
 *
 * The control plane runs in this process on 127.0.0.1:4210 with its job worker. The servers are
 * privileged containers reached over SSH on a published loopback port:
 * (a) Ubuntu 24.04 booting systemd that refuses root with the cloud image's message: adding it as
 *     root fails with the user hint, "Use ubuntu and run setup again" completes setup, the runner
 *     connects, the router runs as ubuntu, an app deploys and answers through a route the runner
 *     wrote, running setup again keeps it serving, and deleting the server with its services
 *     leaves nothing of them or the runner behind; with ufw active, a deploy publishing ports
 *     opens them in ufw and a port no longer published is closed again, never touching the
 *     person's own rule (30b R2-13), and a server task runs as ubuntu in /home/ubuntu (R3-28);
 * (b) Alpine without bash or an init system, as root, whose tasks run as root in /root;
 * (c) a user without passwordless sudo, who gets the exact fix.
 * Servers reach the control plane only over its own TLS port (4211 here, 3443 on an install),
 * pinning the certificate's fingerprint that setup writes beside the address (spec 31 "Remote
 * runners are always encrypted", G3-01); a runner left with only a plain address doesn't connect
 * at all and says to run setup again, and nothing of it reaches the plain port (C4-02).
 * NZ1_E2E_KEEP=1 keeps the servers for a look afterwards.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `server-setup-${Date.now().toString(36)}`);
const PORT = 4210;
const CONTROL_FROM_SERVER = `http://host.docker.internal:${PORT}`;
/** The runner link's TLS port, which servers are given (an install's 3443). */
const LINK_PORT = 4211;
const LINK = createLinkCertificate(["127.0.0.1"]);
const ENCRYPTED_FROM_SERVER = `https://host.docker.internal:${LINK_PORT}`;
/** Runner requests that reached the plain port: none ever should (spec 31, C4-02). */
let plainRunnerRequests = 0;
const KEEP = process.env.NZ1_E2E_KEEP === "1";
const IMAGES = join(import.meta.dir, "images");
const ARCH = PLATFORM === "linux/arm64" ? "arm64" : "x64";

class TestServer {
  port = 0;
  otherPort = 0;
  constructor(
    readonly name: string,
    readonly image: string,
    readonly systemd: boolean,
  ) {}

  async start(): Promise<void> {
    await this.remove();
    // Docker's data folders are volumes, so the Docker inside isn't layered on this container's
    // own overlay filesystem (which can't hold another overlay).
    const flags = this.systemd ? ["--tmpfs", "/run", "--tmpfs", "/run/lock"] : [];
    // Two free loopback ports, chosen here (Docker can hand one port out twice).
    const first = freePort();
    const second = freePort([first]);
    await $`docker run -d --privileged --cgroupns=private --name ${this.name} --label nz1-e2e=true --add-host host.docker.internal:host-gateway -v /var/lib/docker -v /var/lib/containerd -p 127.0.0.1:${first}:22 -p 127.0.0.1:${second}:22 ${flags} ${this.image}`.quiet();
    // Two published ports, so two server records can point at one machine.
    const ports = (await $`docker port ${this.name} 22/tcp`.text())
      .trim()
      .split("\n")
      .map((line) => Number(line.split(":").at(-1)));
    this.port = ports[0] ?? 0;
    this.otherPort = ports[1] ?? this.port;
    await eventually(`${this.name} to accept SSH`, () => sshBanner(this.port), 60_000);
  }

  async remove(): Promise<void> {
    await $`docker rm --force --volumes ${this.name}`.quiet().nothrow();
  }

  async exec(command: string): Promise<{ code: number; out: string }> {
    const child = Bun.spawn(["docker", "exec", this.name, "sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, out: out + err };
  }

  async must(command: string): Promise<string> {
    const result = await this.exec(command);
    if (result.code !== 0)
      throw new Error(`"${command}" failed on ${this.name} (${result.code}):\n${result.out}`);
    return result.out;
  }

  async write(path: string, text: string, owner = "root"): Promise<void> {
    const child = Bun.spawn(
      [
        "docker",
        "exec",
        "-i",
        this.name,
        "sh",
        "-c",
        `cat > ${path} && chmod 600 ${path} && chown ${owner}:${owner} ${path}`,
      ],
      {
        stdin: new TextEncoder().encode(text),
        stdout: "ignore",
        stderr: "pipe",
      },
    );
    if ((await child.exited) !== 0) throw new Error(`writing ${path} on ${this.name} failed`);
  }
}

/** A loopback port nothing listens on right now. */
function freePort(not: number[] = []): number {
  for (;;) {
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    if (!not.includes(port)) return port;
  }
}

/** True once something on the port greets like an SSH server. */
async function sshBanner(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value: boolean) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    setTimeout(() => finish(false), 3_000);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        data(socket, data) {
          finish(new TextDecoder().decode(data).startsWith("SSH-"));
          socket.end();
        },
        error: () => finish(false),
        close: () => finish(false),
      },
    }).catch(() => finish(false));
  });
}

const UBUNTU = new TestServer(e2eName("nz1-m6-ubuntu-a"), e2eName("nz1-m6-ubuntu"), true);
const ALPINE = new TestServer(e2eName("nz1-m6-alpine-b"), e2eName("nz1-m6-alpine"), false);

let harness: Harness;
let owner: Browser;
let server: ReturnType<typeof Bun.serve>;
let linkServer: ReturnType<typeof Bun.serve>;
let worker: JobWorker;
let keyId = "";
const ids: Record<string, string> = {};

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

async function buildRunners(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const sums: string[] = [];
  const targets =
    ARCH === "arm64"
      ? [
          ["bun-linux-arm64", "nearzero-runner-linux-arm64"],
          ["bun-linux-arm64-musl", "nearzero-runner-linux-arm64-musl"],
        ]
      : [
          ["bun-linux-x64-baseline", "nearzero-runner-linux-x64"],
          ["bun-linux-x64-musl-baseline", "nearzero-runner-linux-x64-musl"],
        ];
  for (const [target, file] of targets) {
    const out = join(dir, file as string);
    await $`bun build ${join(ROOT, "runner", "src", "main.ts")} --compile --target=${target} --outfile=${out}`.quiet();
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(out).arrayBuffer())
      .digest("hex");
    sums.push(`${digest}  ${file}`);
  }
  await Bun.write(join(dir, "SHA256SUMS"), `${sums.join("\n")}\n`);
}

async function setup(id: string) {
  return (await owner.get(`/servers/${id}/setup`)).body.setup;
}

/** Starts setup (optionally as another user) and waits for the run to end. */
async function runSetup(id: string, body: Record<string, unknown> = {}, timeoutMs = 1_500_000) {
  const started = await owner.post(`/servers/${id}/setup`, body);
  if (started.status !== 202) throw new Error(JSON.stringify(started.body));
  const runId = started.body.setup.run.id as string;
  const done = await eventually(
    `setup on ${id} to finish`,
    async () => {
      const view = await setup(id);
      return view.run?.id === runId && view.run.state !== "running" ? view : null;
    },
    timeoutMs,
    2_000,
  );
  const text = (await owner.get(`/servers/${id}/setup/log?run=${runId}`)).body.text as string;
  await log(`setup-${id.slice(0, 8)}-${runId.slice(0, 8)}`, text);
  return { view: done, log: text };
}

async function addServer(
  name: string,
  host: TestServer,
  user: string,
  port = host.port,
): Promise<string> {
  const reply = await owner.post("/servers", {
    name,
    sshKeyId: keyId,
    address: "127.0.0.1",
    port,
    sshUser: user,
  });
  if (reply.status !== 201) throw new Error(JSON.stringify(reply.body));
  ids[name] = reply.body.server.id;
  return reply.body.server.id;
}

async function curl(host: TestServer, hostname: string): Promise<string> {
  return (await host.exec(`curl -s -m 10 -H 'Host: ${hostname}' http://127.0.0.1/`)).out;
}

async function deployNginx(serverId: string, name: string): Promise<void> {
  const project = await owner.post("/projects", { name: `${name}-project` });
  if (project.status !== 201) throw new Error(JSON.stringify(project.body));
  const created = await owner.post(`/environments/${project.body.environmentId}/services`, {
    kind: "application",
    name,
    serverId,
    settings: { image: "nginx:alpine", servicePort: 80 },
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  ids[name] = created.body.service.id;
  await owner.patch(`/services/${ids[name]}/deploy-settings`, { stabilitySeconds: 3 });
  const started = await owner.post(`/services/${ids[name]}/deployments`, {});
  if (started.status !== 202) throw new Error(JSON.stringify(started.body));
  const deploymentId = started.body.deployment.id as string;
  const done = await eventually(
    `the ${name} deployment`,
    async () => {
      const view = (await owner.get(`/deployments/${deploymentId}`)).body.deployment;
      return ["queued", "building"].includes(view.status) ? null : view;
    },
    600_000,
    2_000,
  );
  await log(
    `deploy-${name}`,
    (await owner.get(`/deployments/${deploymentId}/log?lines=all`)).body.text,
  );
  expect(done.status).toBe("active");
}

/** Deploys a service again and answers its status and log. */
async function redeploy(serviceId: string, name: string): Promise<{ status: string; log: string }> {
  const started = await owner.post(`/services/${serviceId}/deployments`, {});
  if (started.status !== 202) throw new Error(JSON.stringify(started.body));
  const deploymentId = started.body.deployment.id as string;
  const done = await eventually(
    `the ${name} deployment`,
    async () => {
      const view = (await owner.get(`/deployments/${deploymentId}`)).body.deployment;
      return ["queued", "building"].includes(view.status) ? null : view;
    },
    600_000,
    2_000,
  );
  const text = (await owner.get(`/deployments/${deploymentId}/log?lines=all`)).body.text as string;
  await log(`deploy-${name}-${deploymentId.slice(0, 8)}`, text);
  return { status: done.status, log: text };
}

/** An nginx app on the server publishing these ports, deployed. */
async function appWithPorts(serverId: string, name: string, ports: unknown[]) {
  const project = await owner.post("/projects", { name: `${name}-project` });
  if (project.status !== 201) throw new Error(JSON.stringify(project.body));
  const created = await owner.post(`/environments/${project.body.environmentId}/services`, {
    kind: "application",
    name,
    serverId,
    settings: { image: "nginx:alpine", servicePort: 80 },
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  const id = created.body.service.id as string;
  await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 3 });
  const saved = await owner.put(`/services/${id}/ports`, { ports });
  if (saved.status !== 200) throw new Error(JSON.stringify(saved.body));
  return { id, ...(await redeploy(id, name)) };
}

/** Deletes a service and waits for its removal to finish; answers the removal's items. */
async function deleteService(id: string, name: string) {
  const started = await owner.post(`/services/${id}/delete`, { confirm: name });
  if (started.status !== 202) throw new Error(JSON.stringify(started.body));
  return eventually(
    `${name} to be deleted`,
    async () => {
      const run = (await owner.get(`/delete-runs/${started.body.run.id}`)).body.run;
      return run && run.state !== "running" ? run : null;
    },
    300_000,
    2_000,
  );
}

/** Runs a server task now and answers the finished run with its log. */
async function runTask(serverId: string, name: string, script: string) {
  const created = await owner.post("/tasks", {
    name,
    place: "server",
    serverId,
    shell: "bash",
    cron: "0 0 1 1 *",
    timeZone: "UTC",
    script,
    enabled: false,
  });
  if (created.status !== 201) throw new Error(JSON.stringify(created.body));
  // The syntax check ran on the server, as its user.
  expect(created.body.check.syntax).toBe("checked");
  const started = await owner.post(`/tasks/${created.body.task.id}/run`, {});
  if (started.status !== 202) throw new Error(JSON.stringify(started.body));
  const run = await eventually(
    `the ${name} task to finish`,
    async () => {
      const view = (await owner.get(`/task-runs/${started.body.run.id}`)).body.run;
      // Queued, then running: both are open (C1-09).
      return view && !view.open ? view : null;
    },
    120_000,
    1_000,
  );
  await log(`task-${name}`, `${run.status}\n${run.log ?? ""}`);
  return run as { status: string; log: string; error: string | null };
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  await buildRunners(join(WORK, "runners"));
  const keys = await generateKeyPair("ed25519", "server-setup-e2e");
  // The test servers' images (Dockerfiles beside this file).
  await $`docker build -q -t ${UBUNTU.image} ${join(IMAGES, "ubuntu")}`.quiet();
  await $`docker build -q -t ${ALPINE.image} ${join(IMAGES, "alpine")}`.quiet();

  // One at a time: Docker Desktop can hand two containers the same free port at once.
  await UBUNTU.start();
  await ALPINE.start();
  const cloudRefusal =
    'no-port-forwarding,no-agent-forwarding,no-X11-forwarding,command="echo \'Please login as the user \\"ubuntu\\" rather than the user \\"root\\".\';echo;sleep 1;exit 142" ';
  await UBUNTU.write("/root/.ssh/authorized_keys", `${cloudRefusal}${keys.publicKey}\n`);
  await UBUNTU.write("/home/ubuntu/.ssh/authorized_keys", `${keys.publicKey}\n`, "ubuntu");
  await UBUNTU.write("/home/nosudo/.ssh/authorized_keys", `${keys.publicKey}\n`, "nosudo");
  await ALPINE.write("/root/.ssh/authorized_keys", `${keys.publicKey}\n`);
  // A host firewall like a hardened cloud server's: SSH and the person's own 7000/tcp allowed,
  // everything else coming in refused (30b R2-13).
  await UBUNTU.must(
    "ufw allow 22/tcp >/dev/null && ufw allow 7000/tcp >/dev/null && ufw --force enable",
  );
  // As on a cloud image, unattended-upgrade-shutdown waits idle (C2-06).
  await eventually(
    "unattended-upgrade-shutdown to run",
    async () => (await UBUNTU.exec("ps -e -o comm= | grep -qx unattended-upgr")).code === 0,
    60_000,
  );

  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  // No address set outright: the control plane gives servers its own TLS port with the
  // certificate's fingerprint, as an install without a domain does.
  harness = await createHarness({
    extra: {
      objects,
      runnerLinkPort: { port: LINK_PORT, fingerprint: LINK.fingerprint },
      publicIp: "host.docker.internal",
    },
  });
  configureServerSetup(harness.services, {
    runnerBinariesDirectory: join(WORK, "runners"),
    runnerWaitMs: 8 * 60_000,
    metricsWaitMs: 30_000,
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
      notes: [`${row.name}.test.localhost routes here.`],
    };
  });
  const app = harness.app;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 120,
    websocket: socketServer,
    fetch: (request, bun) => {
      if (new URL(request.url).pathname.startsWith("/api/v1/runner/")) {
        plainRunnerRequests++;
      }
      return app.fetch(request, {
        peerAddress: bun.requestIP(request)?.address,
        upgrade: upgraderFor(bun),
      });
    },
  });
  linkServer = serveRunnerLink(app, {
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
  const key = await owner.post("/ssh-keys", { name: "e2e", ...keys });
  keyId = key.body.key.id;
}, 900_000);

afterAll(async () => {
  for (const host of [UBUNTU, ALPINE]) {
    await host
      .exec(
        "journalctl -u nearzero-runner --no-pager 2>/dev/null || cat /var/log/nearzero-runner.log 2>/dev/null",
      )
      .then((result) => log(`${host.name}-runner`, result.out))
      .catch(() => {});
  }
  await worker?.stop({ graceMs: 1000 }).catch(() => {});
  harness?.services.runners.stop();
  server?.stop(true);
  linkServer?.stop(true);
  await harness?.drop();
  if (KEEP) {
    console.log(
      `Kept ${UBUNTU.name} and ${ALPINE.name}; remove them with: docker rm -fv ${UBUNTU.name} ${ALPINE.name}`,
    );
    return;
  }
  await Promise.all([UBUNTU.remove(), ALPINE.remove()]);
}, 300_000);

describe("(a) a cloud image that refuses root", () => {
  test("adding it as root fails with the user hint", async () => {
    const id = await addServer("cloud-1", UBUNTU, "root");
    const { view } = await runSetup(id);
    expect(view.run.state).toBe("failed");
    expect(view.run.failure.kind).toBe("wrong_user");
    expect(view.run.failure.message).toBe(wrongUserMessage("root", "ubuntu"));
    expect(view.run.failure.suggestedUser).toBe("ubuntu");
    expect(view.server.hostKeyFingerprint).toMatch(/^SHA256:/);
  }, 120_000);

  test("(c) a user without passwordless sudo gets the exact fix", async () => {
    // The same machine under another name: each server needs its own address and port.
    const id = await addServer("no-sudo", UBUNTU, "nosudo", UBUNTU.otherPort);
    const { view } = await runSetup(id);
    expect(view.run.failure.kind).toBe("sudo_missing");
    expect(view.run.failure.message).toBe(passwordlessSudoMessage("nosudo"));
    expect(view.run.failure.fixCommand).toBe(
      "echo 'nosudo ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/nosudo",
    );
    expect((await owner.request("DELETE", `/servers/${id}`)).status).toBe(200);
  }, 120_000);

  test("Use ubuntu and run setup again: setup completes and the runner connects", async () => {
    const id = ids["cloud-1"] as string;
    const { view, log: text } = await runSetup(id, { sshUser: "ubuntu" });
    if (view.run.state !== "succeeded")
      throw new Error(`${view.run.failure?.message}\n\n${text.slice(-4000)}`);
    for (const [index, title] of SETUP_STEPS.entries())
      expect(text).toContain(`[${index + 1}/15] ${title}`);
    expect(text).toContain("Setup Server: ✅");
    // C2-06: Ubuntu's idle unattended-upgrade-shutdown made every package install wait 5 minutes.
    expect(text).not.toContain("Another package job is running");
    expect(text).not.toMatch(/nzj1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{16,}/);
    const record = (await owner.get(`/servers/${id}`)).body.server;
    expect(record.sshUser).toBe("ubuntu");
    expect(record.readiness).toBe("ready");
    expect(record.runner.state).toBe("online");
    const validation = (await owner.get(`/servers/${id}/validation`)).body.validation;
    expect(validation.verdict).toBe(VALIDATION_VERDICTS.ready);
    expect(
      validation.checks.find((item: { id: string }) => item.id === "router").value,
    ).toStartWith("Running as ubuntu");
  }, 1_600_000);

  test("G3-01: the runner reaches Nearzero only over the TLS port, pinned to its certificate", async () => {
    const settings = await UBUNTU.must("cat /etc/nearzero/runner.env");
    expect(settings).toContain(`NEARZERO_CONTROL_URL='${ENCRYPTED_FROM_SERVER}'`);
    expect(settings).toContain(`NEARZERO_CONTROL_FINGERPRINT='sha256:${LINK.fingerprint}'`);
    expect(settings).not.toContain("http://");
    // Nothing of the runner's (enrolling, checking, connecting) went to the plain port.
    expect(plainRunnerRequests).toBe(0);
    const row = await harness.test.db
      .selectFrom("runner")
      .select(["link_url", "link_problem"])
      .where("server_id", "=", ids["cloud-1"] as string)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ link_url: ENCRYPTED_FROM_SERVER, link_problem: null });
  }, 60_000);

  test("C4-02: a runner left with only a plain address doesn't connect at all, and says to run setup again", async () => {
    const id = ids["cloud-1"] as string;
    const hub = harness.services.runners;
    const before = plainRunnerRequests;
    await UBUNTU.must("cp -p /etc/nearzero/runner.env /etc/nearzero/runner.env.keep");
    // As an older setup wrote it: the API's plain port, no fingerprint, nothing saved.
    await UBUNTU.must(
      `sed -i -e "s|^NEARZERO_CONTROL_URL=.*|NEARZERO_CONTROL_URL='${CONTROL_FROM_SERVER}'|" -e '/^NEARZERO_CONTROL_FINGERPRINT=/d' /etc/nearzero/runner.env && rm -f /var/lib/nearzero-runner/control-link.json && systemctl restart nearzero-runner`,
    );
    try {
      await eventually("the runner to go", async () => !hub.isOnline(id), 60_000);
      const said = await eventually(
        "the runner to say why it won't start",
        async () => {
          const log = await UBUNTU.exec("journalctl -u nearzero-runner --no-pager -n 50");
          return log.out.includes("plain http://") ? log.out : null;
        },
        60_000,
        1_000,
      );
      expect(said).toContain("run setup again on the server");
      await Bun.sleep(5_000);
      // Its credential never went to the plain port, and it didn't come back online.
      expect(plainRunnerRequests).toBe(before);
      expect(hub.isOnline(id)).toBe(false);
    } finally {
      // What running setup again writes: the encrypted address and its fingerprint.
      await UBUNTU.must(
        "mv -f /etc/nearzero/runner.env.keep /etc/nearzero/runner.env && systemctl restart nearzero-runner",
      );
    }
    await eventually(
      "the runner to come back on the encrypted link",
      async () => hub.isOnline(id),
      120_000,
    );
    expect(await hub.command(id, "router.files", {})).toHaveProperty("files");
    expect(plainRunnerRequests).toBe(before);
  }, 600_000);

  test("on the server: the router runs as ubuntu, the runner is a service, SSH takes keys only", async () => {
    const uid = (await UBUNTU.must("id -u ubuntu")).trim();
    expect(
      (await UBUNTU.must("docker inspect nearzero-router --format '{{.Config.User}}'")).trim(),
    ).toStartWith(`${uid}:`);
    expect((await UBUNTU.must("stat -c %U /etc/nearzero/router")).trim()).toBe("ubuntu");
    // The router, as ubuntu with every capability dropped, can keep its Let's Encrypt
    // certificates (B2-02): the certificates volume is ubuntu's, not root's.
    expect(
      (await UBUNTU.must("docker exec nearzero-router stat -c '%u %a' /certificates")).trim(),
    ).toBe(`${uid} 700`);
    await UBUNTU.must(
      "docker exec nearzero-router sh -c 'touch /certificates/.check && rm /certificates/.check'",
    );
    expect((await UBUNTU.must("systemctl is-enabled nearzero-runner")).trim()).toBe("enabled");
    expect((await UBUNTU.must("stat -c '%U %a' /var/lib/nearzero-runner/credential")).trim()).toBe(
      "root 600",
    );
    expect(await UBUNTU.must("id -nG ubuntu")).toContain("docker");
    const sshd = await UBUNTU.must(
      "sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin) '",
    );
    expect(sshd).toContain("passwordauthentication no");
    // sshd -T names prohibit-password by its older alias.
    expect(sshd).toMatch(/permitrootlogin (prohibit-password|without-password)/);
    // G3-02: what applies to the setup user, as 0.1.x set it, over the image's own
    // PasswordAuthentication yes in sshd_config.d.
    const applied = await UBUNTU.must("sshd -T -C user=ubuntu,host=localhost,addr=127.0.0.1");
    for (const line of [
      "authenticationmethods publickey",
      "maxauthtries 3",
      "logingracetime 30",
      "passwordauthentication no",
      "kbdinteractiveauthentication no",
      "allowagentforwarding no",
      "x11forwarding no",
      "allowtcpforwarding local",
      "gatewayports no",
      "permittunnel no",
      "permituserenvironment no",
    ])
      expect(applied.split("\n")).toContain(line);
  }, 60_000);

  test("an app deploys there and answers through a route the runner wrote", async () => {
    await deployNginx(ids["cloud-1"] as string, "nginx");
    const files = await UBUNTU.must("ls -l /etc/nearzero/router");
    expect(files).toContain("route-");
    await eventually(
      "nginx to answer through the router",
      async () => (await curl(UBUNTU, "nginx.test.localhost")).includes("Welcome to nginx!"),
      60_000,
    );
  }, 900_000);

  test("running setup again keeps the app serving and the router in place", async () => {
    const id = ids["cloud-1"] as string;
    const routerBefore = (
      await UBUNTU.must("docker inspect nearzero-router --format '{{.Id}}'")
    ).trim();
    const appBefore = (
      await UBUNTU.must("docker ps --filter label=dev.nearzero.service --format '{{.ID}}'")
    ).trim();
    const { view } = await runSetup(id);
    expect(view.run.state).toBe("succeeded");
    expect((await UBUNTU.must("docker inspect nearzero-router --format '{{.Id}}'")).trim()).toBe(
      routerBefore,
    );
    expect(
      (
        await UBUNTU.must("docker ps --filter label=dev.nearzero.service --format '{{.ID}}'")
      ).trim(),
    ).toBe(appBefore);
    expect(await curl(UBUNTU, "nginx.test.localhost")).toContain("Welcome to nginx!");
  }, 1_600_000);

  test("R2-13: with ufw active, a published port is opened and closed again; the person's own rule stays", async () => {
    const id = ids["cloud-1"] as string;
    const app = await appWithPorts(id, "ports", [
      { containerPort: 9000, publishedPort: 9000, protocol: "udp" },
      { containerPort: 7000, publishedPort: 7000, protocol: "tcp" },
    ]);
    expect(app.status).toBe("active");
    expect(app.log).toContain("ufw: allowed 9000/udp");
    expect(app.log).toContain("ufw: 7000/tcp is already allowed");
    expect(app.log).toContain(
      "If this server is behind a cloud firewall or security group, allow 7000/tcp, 9000/udp there too.",
    );
    const opened = await UBUNTU.must("ufw status");
    expect(opened).toMatch(/^9000\/udp\s+ALLOW\s+Anywhere\s+# nearzero\s*$/m);
    expect(opened).toMatch(/^7000\/tcp\s+ALLOW\s+Anywhere\s*$/m);

    // No longer published: Nearzero's rule goes, the person's 7000/tcp stays.
    expect(
      (
        await owner.put(`/services/${app.id}/ports`, {
          ports: [{ containerPort: 7000, publishedPort: 7000, protocol: "tcp" }],
        })
      ).status,
    ).toBe(200);
    const narrowed = await redeploy(app.id, "ports");
    expect(narrowed.status).toBe("active");
    expect(narrowed.log).toContain(
      "ufw: removed the rule Nearzero added for 9000/udp, which nothing on this server publishes any more",
    );
    const closed = await UBUNTU.must("ufw status");
    expect(closed).not.toContain("9000/udp");
    expect(closed).toMatch(/^7000\/tcp\s+ALLOW\s+Anywhere\s*$/m);
    expect(closed).toMatch(/^80\/tcp\s+ALLOW\s+Anywhere\s*$/m);

    // Deleting a service takes the rules Nearzero added for it along, and says so.
    const other = await appWithPorts(id, "ports-two", [
      { containerPort: 9000, publishedPort: 9000, protocol: "udp" },
    ]);
    expect(other.log).toContain("ufw: allowed 9000/udp");
    const removal = await deleteService(other.id, "ports-two");
    expect(removal.state).toBe("succeeded");
    expect(JSON.stringify(removal.items)).toContain(
      "ufw: removed the rule Nearzero added for 9000/udp",
    );
    expect(await UBUNTU.must("ufw status")).not.toContain("9000/udp");
    expect((await deleteService(app.id, "ports")).state).toBe("succeeded");
    expect(await UBUNTU.must("ufw status")).toMatch(/^7000\/tcp\s+ALLOW\s+Anywhere\s*$/m);
  }, 1_200_000);

  test("R3-28: a server task runs as ubuntu, from its home, with its groups", async () => {
    const run = await runTask(
      ids["cloud-1"] as string,
      "whoami",
      'id -un; pwd; echo "$HOME $USER $LOGNAME $SHELL"; id -nG; echo "$PATH"; touch ~/nz-task-file',
    );
    if (run.status !== "succeeded") throw new Error(`${run.error}\n${run.log}`);
    const lines = run.log.split("\n");
    expect(lines[0]).toBe("ubuntu");
    expect(lines[1]).toBe("/home/ubuntu");
    expect(lines[2]).toBe("/home/ubuntu ubuntu ubuntu /bin/bash");
    expect(lines[3]?.split(" ")).toContain("docker");
    expect(lines[4]?.split(":")).toEqual(
      expect.arrayContaining(["/usr/local/bin", "/usr/local/sbin"]),
    );
    expect((await UBUNTU.must("stat -c %U /home/ubuntu/nz-task-file")).trim()).toBe("ubuntu");
  }, 300_000);

  test("the security audit reads the server", async () => {
    const audit = (await owner.post(`/servers/${ids["cloud-1"]}/security-audit`, {})).body.audit;
    expect(audit.error).toBeNull();
    const byId = Object.fromEntries(audit.items.map((item: { id: string }) => [item.id, item]));
    expect(byId.ssh_password.state).toBe("good");
    expect(byId.ssh_root.state).toBe("good");
    expect(byId.intrusion_ban.state).toBe("attention");
  }, 120_000);

  test("deleting it with its services leaves nothing of them or the runner", async () => {
    const id = ids["cloud-1"] as string;
    const refused = await owner.request("DELETE", `/servers/${id}`);
    expect(refused.status).toBe(409);
    const started = await owner.request("DELETE", `/servers/${id}?deleteServices=true`);
    expect(started.status).toBe(202);
    const removal = await eventually(
      "the server's removal",
      async () => {
        const view = (await owner.get(`/servers/${id}/removal`)).body.removal;
        return view && view.state !== "running" ? view : null;
      },
      300_000,
      2_000,
    );
    await log("removal", JSON.stringify(removal, null, 2));
    expect(removal.state).toBe("succeeded");
    expect(removal.items.map((item: { state: string }) => item.state)).toEqual(["removed"]);
    expect((await owner.get(`/servers/${id}`)).status).toBe(404);
    expect(
      (
        await UBUNTU.must("docker ps -a --filter label=dev.nearzero.service --format '{{.ID}}'")
      ).trim(),
    ).toBe("");
    expect((await UBUNTU.exec("systemctl is-enabled nearzero-runner")).out.trim()).not.toBe(
      "enabled",
    );
    expect((await UBUNTU.exec("test -e /var/lib/nearzero-runner/credential")).code).not.toBe(0);
  }, 600_000);
});

describe("(b) Alpine without bash or an init system", () => {
  let alpineId = "";
  test("G3-02: a Match block that turns passwords back on for the setup user fails step 14, keeping the old configuration", async () => {
    await ALPINE.must(
      "printf '%s\\n' 'Match User root' '  PasswordAuthentication yes' >> /etc/ssh/sshd_config",
    );
    const before = await ALPINE.must("sha256sum /etc/ssh/sshd_config");
    alpineId = await addServer("alpine-1", ALPINE, "root");
    const { view, log: text } = await runSetup(alpineId);
    // The first run on this server: bash comes first, and there is no init system.
    expect(text).toContain("Installing bash first");
    expect(text).toContain("no init system");
    expect(view.run.state).toBe("failed");
    expect(view.run.failure?.message).toStartWith("Setup stopped at step 14 (Harden SSH)");
    expect(text).toContain(
      "SSH would still let root sign in without a key: a later part of the SSH configuration (often a Match block) sets PasswordAuthentication for root. The old configuration was kept.",
    );
    expect(await ALPINE.must("sha256sum /etc/ssh/sshd_config")).toBe(before);
    expect(
      (await ALPINE.must("grep -c 'Nearzero: begin' /etc/ssh/sshd_config || true")).trim(),
    ).toBe("0");
    // Without it, the run below goes through.
    await ALPINE.must("sed -i '/^Match User root$/,$d' /etc/ssh/sshd_config");
  }, 1_800_000);

  test("setup installs bash first and completes as root", async () => {
    const fresh = !alpineId;
    const id = alpineId || (await addServer("alpine-1", ALPINE, "root"));
    const { view, log: text } = await runSetup(id);
    if (view.run.state !== "succeeded")
      throw new Error(`${view.run.failure?.message}\n\n${text.slice(-4000)}`);
    // After the G3-02 run above, bash is there already; the server still has no init system.
    if (fresh) expect(text).toContain("Installing bash first");
    expect(text).toContain("no init system");
    const record = (await owner.get(`/servers/${id}`)).body.server;
    expect(record.readiness).toBe("ready");
    expect(
      (await ALPINE.must("docker inspect nearzero-router --format '{{.Config.User}}'")).trim(),
    ).toStartWith("0:");
    await deployNginx(id, "alpine-nginx");
    await eventually(
      "nginx on Alpine",
      async () => (await curl(ALPINE, "alpine-nginx.test.localhost")).includes("Welcome to nginx!"),
      60_000,
    );
    // R3-28: a server set up as root runs its tasks as root, in /root.
    const run = await runTask(id, "alpine-whoami", "id -un; pwd");
    if (run.status !== "succeeded") throw new Error(`${run.error}\n${run.log}`);
    expect(run.log.split("\n").slice(0, 2)).toEqual(["root", "/root"]);
  }, 1_800_000);
});
