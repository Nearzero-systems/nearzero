import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { ObjectRegistry } from "../../apps/control/src/access/objects.ts";
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
import { DindHost, eventually, PLATFORM } from "./dind.ts";

/**
 * The runner suite (M3a), against a Docker-in-Docker host:
 *
 *   bun run --cwd e2e test:runner          (NZ1_E2E_KEEP=1 keeps the host for a look afterwards)
 *
 * The control plane runs in this process on 127.0.0.1:4140 against a throwaway database. The
 * runner, compiled for linux, runs inside the DinD host as it would on a server: it joins with a
 * one-time token, starts the router there, pulls nginx:alpine, starts it on the private network,
 * and serves it through a route for test.localhost. Then logs stream, a terminal runs a command,
 * and a forced disconnect shows the log stream resuming without a gap.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `runner-${Date.now().toString(36)}`);
const HOST = new DindHost("nz1-m3a-runner");
const PORT = 4140;
/**
 * The runner link's own TLS port (an install's 3443): the server joins there with the certificate's
 * fingerprint, which the join command carries (spec 31 "Remote runners are always encrypted").
 */
const LINK_PORT = 4141;
const LINK = createLinkCertificate(["127.0.0.1"]);
const CONTROL_FROM_HOST = `https://host.docker.internal:${LINK_PORT}`;
const KEEP = process.env.NZ1_E2E_KEEP === "1";
const ROUTER_IMAGE = "traefik:v3.7.18";

let harness: Harness;
let owner: Browser;
let server: ReturnType<typeof Bun.serve>;
let linkServer: ReturnType<typeof Bun.serve>;
let serverId = "";
/** While true, runners can't connect (the window a forced disconnect lasts). */
let runnersBlocked = false;

function cookieHeader(browser: Browser): string {
  return [...browser.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

function api(path: string): string {
  return `http://127.0.0.1:${PORT}/api/v1${path}`;
}

interface SseEvent {
  event: string;
  id: string | null;
  data: string;
}

/** Reads server-sent events from a response into a list, until the response ends. */
function readEvents(response: Response, into: SseEvent[]): Promise<void> {
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split >= 0) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        const event: SseEvent = { event: "message", id: null, data: "" };
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event: ")) event.event = line.slice(7);
          else if (line.startsWith("id: ")) event.id = line.slice(4);
          else if (line.startsWith("data: ")) data.push(line.slice(6));
        }
        event.data = data.join("\n");
        if (block.trim() !== "" && !block.startsWith(":")) into.push(event);
        split = buffer.indexOf("\n\n");
      }
    }
  })().catch(() => {});
}

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  // The harness builds what it tests: the runner for the host's architecture (musl, as the DinD
  // image is Alpine-based).
  const target =
    PLATFORM === "linux/arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-musl-baseline";
  const binary = join(WORK, "nearzero-runner");
  await $`bun build ${join(ROOT, "runner", "src", "main.ts")} --compile --target=${target} --outfile=${binary}`.quiet();

  await HOST.start();
  await HOST.must("apk add --no-cache -q libstdc++ libgcc curl openssl >/dev/null");
  await HOST.copyIn(binary, "/usr/local/bin/nearzero-runner");
  // Pulled here so the router starts quickly; nginx is pulled by the runner itself.
  await HOST.must(`docker pull -q ${ROUTER_IMAGE} >/dev/null`);

  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({
    extra: {
      objects,
      runnerLinkPort: { port: LINK_PORT, fingerprint: LINK.fingerprint },
      publicIp: "host.docker.internal",
    },
  });
  const app = harness.app;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 120,
    websocket: socketServer,
    fetch(request, bun) {
      const path = new URL(request.url).pathname;
      if (runnersBlocked && path.startsWith("/api/v1/runner/")) {
        return new Response("paused by the test", { status: 503 });
      }
      return app.fetch(request, {
        peerAddress: bun.requestIP(request)?.address,
        upgrade: upgraderFor(bun),
      });
    },
  });
  linkServer = serveRunnerLink(
    {
      fetch: (request, env) =>
        runnersBlocked && new URL(request.url).pathname.startsWith("/api/v1/runner/")
          ? new Response("paused by the test", { status: 503 })
          : app.fetch(request, env),
    },
    {
      hostname: "127.0.0.1",
      port: LINK_PORT,
      certificate: LINK.certificate,
      key: LINK.key,
      idleTimeoutSeconds: 120,
    },
  );
  owner = await setUpOwner(harness);
}, 900_000);

afterAll(async () => {
  await HOST.exec("cat /var/log/nearzero-runner.log").then((result) => log("runner", result.out));
  harness?.services.runners.stop();
  server?.stop(true);
  linkServer?.stop(true);
  await harness?.drop();
  if (KEEP) {
    console.log(`Kept ${HOST.name}; remove it with: docker rm -fv ${HOST.name}`);
    return;
  }
  await HOST.remove();
}, 120_000);

describe("a runner on a server", () => {
  test("joins with a one-time token and connects", async () => {
    const generated = await owner.post("/ssh-keys/generate", { type: "ed25519", name: "dind" });
    expect(generated.status).toBe(200);
    const key = await owner.post("/ssh-keys", {
      name: "dind",
      publicKey: generated.body.publicKey,
      privateKey: generated.body.privateKey,
    });
    expect(key.status).toBe(201);
    const created = await owner.post("/servers", {
      name: "DinD server",
      sshKeyId: key.body.key.id,
      address: "127.0.0.1",
      port: 22,
      sshUser: "root",
    });
    expect(created.status).toBe(201);
    serverId = created.body.server.id;
    expect(created.body.server).toMatchObject({ label: "dind-server", readiness: "setup_needed" });

    const join = await owner.post(`/servers/${serverId}/join-command`);
    expect(join.status).toBe(200);
    // Encrypted, with the fingerprint of Nearzero's own certificate (G3-01).
    expect(join.body.command).toBe(
      `sudo nearzero-runner join ${CONTROL_FROM_HOST} --fingerprint sha256:${LINK.fingerprint}`,
    );
    // The token goes in on standard input, as a person pastes it (B2-16).
    await HOST.background(
      `printf '%s\n' ${join.body.token} | /usr/local/bin/nearzero-runner join ${CONTROL_FROM_HOST} --fingerprint sha256:${LINK.fingerprint}`,
      "/var/log/nearzero-runner.log",
      {
        NEARZERO_RUNNER_STATE_DIR: "/var/lib/nearzero-runner",
        NEARZERO_ROUTER_DIR: "/etc/nearzero/router",
        NEARZERO_ROUTER_HOST_DIR: "/etc/nearzero/router",
        NEARZERO_ROUTER_IMAGE: ROUTER_IMAGE,
      },
    );
    const view = await eventually(
      "the server to be ready",
      async () => {
        const reply = await owner.get(`/servers/${serverId}`);
        return reply.body.server?.readiness === "ready" ? reply.body.server : null;
      },
      180_000,
      1000,
    );
    expect(view.runner).toMatchObject({ state: "online", updateNeeded: false });
    expect(view.runner.system.dockerVersion).toMatch(/^\d+\./);
    // The token worked once; the credential is in a root-only file.
    expect((await HOST.must("stat -c %a /var/lib/nearzero-runner/credential")).trim()).toBe("600");
    const again = await fetch(api("/runner/enroll"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        joinToken: join.body.token,
        runnerVersion: "1.0.0-dev",
        protocol: 1,
        minProtocol: 1,
      }),
    });
    expect(again.status).toBe(401);
  }, 300_000);

  test("G3-01: with another certificate's fingerprint the runner sends nothing, its token included", async () => {
    const join = await owner.post(`/servers/${serverId}/join-command`);
    const wrong = createLinkCertificate().fingerprint;
    const tried = await HOST.exec("/usr/local/bin/nearzero-runner enroll", {
      NEARZERO_RUNNER_JOIN_TOKEN: join.body.token,
      NEARZERO_CONTROL_URL: CONTROL_FROM_HOST,
      NEARZERO_CONTROL_FINGERPRINT: `sha256:${wrong}`,
      NEARZERO_RUNNER_STATE_DIR: "/tmp/nz1-wrong-pin",
    });
    expect(tried.code).toBe(1);
    expect(tried.out).toContain("isn't Nearzero's");
    // The token never left the server: it is still unused, and nothing was saved there.
    const unused = await harness.test.db
      .selectFrom("runner_join_token")
      .select("used_at")
      .where("server_id", "=", serverId)
      .where("used_at", "is", null)
      .execute();
    expect(unused.length).toBeGreaterThan(0);
    expect((await HOST.exec("test -e /tmp/nz1-wrong-pin/credential")).code).not.toBe(0);
    // The server is still connected over its own pinned link.
    expect(harness.services.runners.isOnline(serverId)).toBe(true);
  }, 120_000);

  test("keeps the router running with every capability dropped", async () => {
    const inspect = JSON.parse(await HOST.must("docker inspect nearzero-router"))[0];
    expect(inspect.State.Running).toBe(true);
    expect(inspect.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(inspect.HostConfig.ReadonlyRootfs).toBe(true);
    expect(inspect.Config.Labels["dev.nearzero.component"]).toBe("router");
    expect(Object.keys(inspect.NetworkSettings.Networks)).toContain("nearzero-edge");
  });

  test("pulls nginx:alpine with progress and starts it on the private network", async () => {
    const hub = harness.services.runners;
    const pull = await hub.openStream(serverId, "image.pull", { image: "nginx:alpine" });
    let text = "";
    pull.stream.subscribe((event) => {
      if (event.type === "output") text += new TextDecoder().decode(event.bytes);
    });
    await pull.done;
    expect(text).toContain("Pulled nginx:alpine");
    const created = (await hub.command(serverId, "container.create", {
      name: "nz1-web",
      image: "nginx:alpine",
      network: "nearzero-edge",
      labels: { "dev.nearzero.service": "nz1-test-service" },
    })) as { id: string };
    expect(created.id).toMatch(/^[0-9a-f]{64}$/);
    await hub.command(serverId, "container.start", { id: "nz1-web" });
    const inspect = JSON.parse(await HOST.must("docker inspect nz1-web"))[0];
    expect(inspect.State.Running).toBe(true);
    expect(inspect.Config.Labels["dev.nearzero.managed"]).toBe("true");
  }, 300_000);

  test("a route for test.localhost serves the nginx page through the router", async () => {
    const put = await owner.put(`/servers/${serverId}/routes/test`, {
      hostnames: ["test.localhost"],
      upstream: { host: "nz1-web", port: 80 },
    });
    expect(put.status).toBe(200);
    expect(put.body.route).toMatchObject({ key: "test", certificate: "letsencrypt" });
    const page = await eventually(
      "the router to serve test.localhost",
      async () => {
        const result = await HOST.exec("curl -s -H 'Host: test.localhost' http://127.0.0.1/");
        return result.out.includes("Welcome to nginx!") ? result.out : null;
      },
      30_000,
    );
    expect(page).toContain("Welcome to nginx!");
    // test.localhost can't get a public certificate, so it is held on the router's placeholder,
    // and Let's Encrypt is never asked.
    const tls = await HOST.exec(
      "curl -skv --resolve test.localhost:443:127.0.0.1 https://test.localhost/ 2>&1",
    );
    expect(tls.out).toContain("Welcome to nginx!");
    expect(tls.out).toContain("TRAEFIK DEFAULT CERT");
    const file = await HOST.must("cat /etc/nearzero/router/route-test.yml");
    expect(file).not.toContain("certResolver");
    const routes = await owner.get(`/servers/${serverId}/routes`);
    await eventually(
      "the hold to be reported",
      async () => {
        const again = await owner.get(`/servers/${serverId}/routes`);
        return again.body.held.some(
          (hold: { hostname: string }) => hold.hostname === "test.localhost",
        );
      },
      20_000,
    );
    expect(routes.body.routes).toHaveLength(1);
    const files = await owner.get(`/servers/${serverId}/router-files`);
    expect(files.body.files.map((item: { name: string }) => item.name)).toContain("route-test.yml");
  }, 120_000);

  test("container logs stream over server-sent events, and resume without a gap after a disconnect", async () => {
    const events: SseEvent[] = [];
    const controller = new AbortController();
    const response = await fetch(api(`/servers/${serverId}/containers/nz1-web/logs?tail=0`), {
      headers: { cookie: cookieHeader(owner), accept: "text/event-stream" },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reading = readEvents(response, events);
    const text = () =>
      events
        .filter((event) => event.event === "output")
        .map((event) => JSON.parse(event.data).text as string)
        .join("");
    await eventually(
      "the stream to open",
      async () => events.some((e) => e.event === "open"),
      10_000,
    );
    await HOST.must("curl -s -o /dev/null -H 'Host: test.localhost' http://127.0.0.1/before-1");
    await eventually(
      "the first request in the log",
      async () => text().includes("GET /before-1"),
      15_000,
    );

    // The runner loses the control plane for a few seconds; nginx keeps logging meanwhile.
    runnersBlocked = true;
    expect(harness.services.runners.disconnect(serverId)).toBe(true);
    await HOST.must(
      "for i in $(seq 1 25); do curl -s -o /dev/null -H 'Host: test.localhost' http://127.0.0.1/during-$i; done",
    );
    await Bun.sleep(3000);
    expect(harness.services.runners.isOnline(serverId)).toBe(false);
    runnersBlocked = false;
    await eventually(
      "the runner to reconnect",
      async () => harness.services.runners.isOnline(serverId),
      60_000,
    );
    await HOST.must("curl -s -o /dev/null -H 'Host: test.localhost' http://127.0.0.1/after-1");
    await eventually(
      "the request after the reconnect",
      async () => text().includes("GET /after-1"),
      30_000,
    );
    controller.abort();
    await reading;

    const logText = text();
    for (let i = 1; i <= 25; i++) {
      // The access log line (nginx's error log names the request too).
      expect(logText.split(`"GET /during-${i} HTTP/1.1" 404`).length - 1).toBe(1);
    }
    expect(logText.indexOf("GET /before-1")).toBeLessThan(logText.indexOf("GET /during-1 "));
    expect(logText.indexOf("GET /during-25 ")).toBeLessThan(logText.indexOf("GET /after-1"));
    expect(events.filter((event) => event.event === "gap")).toEqual([]);
    // Offsets follow on exactly: every chunk starts where the previous one ended.
    let expected: number | null = null;
    for (const event of events.filter((item) => item.event === "output")) {
      const offset = JSON.parse(event.data).offset as number;
      const end = Number(event.id?.split(":")[1]);
      if (expected !== null) expect(offset).toBe(expected);
      expected = end;
    }
    const statuses = events
      .filter((event) => event.event === "status")
      .map((e) => JSON.parse(e.data).connected);
    expect(statuses).toEqual([false, true]);
    await log("logs-stream", JSON.stringify(events, null, 2));
  }, 180_000);

  test("a terminal runs a command in the container", async () => {
    const output: string[] = [];
    const socket = new WebSocket(
      `ws://127.0.0.1:${PORT}/api/v1/servers/${serverId}/containers/nz1-web/terminal?cols=100&rows=30`,
      { headers: { cookie: cookieHeader(owner) } } as unknown as string[],
    );
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      output.push(
        typeof event.data === "string"
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer),
      );
    });
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen());
      socket.addEventListener("error", () => reject(new Error("the terminal didn't open")));
    });
    socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    socket.send(new TextEncoder().encode("echo o''k-$((40+2))\r"));
    try {
      await eventually(
        "the command's output",
        async () => output.join("").includes("ok-42"),
        20_000,
      );
    } finally {
      await log("terminal", output.join(""));
    }
    socket.send(new TextEncoder().encode("exit\r"));
    await eventually(
      "the shell to exit",
      async () => output.join("").includes('"type":"exit"'),
      20_000,
    );
    socket.close();
  }, 60_000);

  test("reports metrics every 5 seconds", async () => {
    const metrics = await eventually(
      "metrics",
      async () => {
        const reply = await owner.get(`/servers/${serverId}/metrics?points=50`);
        return reply.body.samples?.length >= 2 ? reply.body : null;
      },
      30_000,
      1000,
    );
    expect(metrics.latest.memoryTotalBytes).toBeGreaterThan(0);
    expect(metrics.latest.diskTotalBytes).toBeGreaterThan(0);
    expect(metrics.latest.uptimeSeconds).toBeGreaterThan(0);
    expect(metrics.system.cpuThreads).toBeGreaterThan(0);
  }, 60_000);

  test("removing the route stops serving the hostname", async () => {
    const removed = await owner.delete(`/servers/${serverId}/routes/test`);
    expect(removed.status).toBe(200);
    await eventually(
      "the router to stop serving test.localhost",
      async () => {
        const result = await HOST.exec(
          "curl -s -o /dev/null -w '%{http_code}' -H 'Host: test.localhost' http://127.0.0.1/",
        );
        return result.out.trim() === "404";
      },
      10_000,
    );
    expect((await HOST.exec("ls /etc/nearzero/router/route-test.yml")).code).not.toBe(0);
  }, 30_000);
});
