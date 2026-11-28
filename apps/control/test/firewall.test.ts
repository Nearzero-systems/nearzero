import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { FirewallSyncAnswer } from "@nearzero/shared";
import { ObjectRegistry } from "../src/access/objects.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { firewallLines, settingsPorts } from "../src/servers/firewall.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { runnerTeardown } from "../src/service-runtime/teardown.ts";
import { FakeRunner } from "./support/fake-runner.ts";
import { type Browser, createHarness, type Harness, setUpNamedOwner } from "./support/harness.ts";
import { makeProject, makeService } from "./support/projects.ts";

/**
 * Published ports in a remote server's host firewall (30b R2-13; spec 30 "Decisions, part 2"):
 * what the deploy log and a deletion's result say, and that every deploy on a remote server (and
 * never on the Nearzero host) asks its runner to sync the firewall.
 */

setDefaultTimeout(60_000);

function answer(partial: Partial<FirewallSyncAnswer>): FirewallSyncAnswer {
  return { state: "changed", firewall: "ufw", ports: [], removed: [], notRemoved: [], ...partial };
}

describe("the log's words (spec 30, decisions part 2)", () => {
  const app = "svc-app";

  test("each port the service publishes, with its firewall, and the cloud firewall reminder", () => {
    expect(
      firewallLines(
        answer({
          ports: [
            { port: 9000, protocol: "udp", services: [app], result: "allowed" },
            { port: 20001, protocol: "tcp", services: [app], result: "already" },
            { port: 7000, protocol: "tcp", services: ["other"], result: "allowed" },
          ],
          removed: [{ port: 8125, protocol: "udp" }],
        }),
        app,
      ),
    ).toEqual([
      "ufw: allowed 9000/udp",
      "ufw: 20001/tcp is already allowed",
      "ufw: removed the rule Nearzero added for 8125/udp, which nothing on this server publishes any more",
      "If this server is behind a cloud firewall or security group, allow 9000/udp, 20001/tcp there too.",
    ]);
  });

  test("no firewall, no rights, a port it couldn't allow, and iptables' reboot note", () => {
    const published = [
      { port: 9000, protocol: "udp" as const, services: [app], result: "skipped" as const },
    ];
    expect(firewallLines(answer({ state: "none", firewall: null, ports: published }), app)).toEqual(
      [
        "No host firewall is active, so no ports were opened.",
        "If this server is behind a cloud firewall or security group, allow 9000/udp there.",
      ],
    );
    expect(
      firewallLines(answer({ state: "no_rights", firewall: null, ports: published }), app),
    ).toEqual([
      "Skipped opening ports in the host firewall: the runner isn't root and can't use passwordless sudo. Allow 9000/udp in the server's firewall, and in any cloud firewall in front of it.",
    ]);
    expect(
      firewallLines(
        answer({
          firewall: "iptables",
          ports: [
            { port: 9000, protocol: "udp", services: [app], result: "allowed" },
            {
              port: 9001,
              protocol: "udp",
              services: [app],
              result: "failed",
              error: "Permission denied",
            },
          ],
        }),
        app,
      ),
    ).toEqual([
      "iptables: allowed 9000/udp",
      "iptables: couldn't allow 9001/udp: Permission denied. Allow it in the server's firewall yourself.",
      "iptables rules last until the server restarts unless you save them with your distribution's tool.",
      "If this server is behind a cloud firewall or security group, allow 9000/udp, 9001/udp there too.",
    ]);
    // A service publishing nothing gets no lines, firewall or not.
    expect(firewallLines(answer({ state: "none", firewall: null }), app)).toEqual([]);
  });

  test("what a service publishes by its settings (for a runner too old to say)", () => {
    expect(
      settingsPorts({
        id: "a",
        kind: "application",
        public_port: null,
        settings: { ports: [{ containerPort: 53, publishedPort: 5353, protocol: "udp" }] },
      }),
    ).toEqual([{ port: 5353, protocol: "udp" }]);
    expect(settingsPorts({ id: "d", kind: "postgres", public_port: 20001, settings: {} })).toEqual([
      { port: 20001, protocol: "tcp" },
    ]);
    expect(settingsPorts({ id: "c", kind: "compose", public_port: null, settings: {} })).toBeNull();
  });
});

let h: Harness;
let owner: Browser;
let worker: JobWorker;
let serverRunner: FakeRunner;
let hostRunner: FakeRunner;
let serverId = "";

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  h = await createHarness({ extra: { objects } });
  owner = await setUpNamedOwner(h);
  const generated = await owner.post("/ssh-keys/generate", { type: "ed25519", name: "k" });
  const key = await owner.post("/ssh-keys", {
    name: "k",
    publicKey: generated.body.publicKey,
    privateKey: generated.body.privateKey,
  });
  const server = await owner.post("/servers", {
    name: "prod-1",
    sshKeyId: key.body.key.id,
    address: "198.51.100.30",
    sshUser: "ubuntu",
  });
  serverId = server.body.server.id;
  hostRunner = await FakeRunner.connect(h.test.db, h.services.runners);
  serverRunner = await FakeRunner.connect(h.test.db, h.services.runners, serverId);
  worker = new JobWorker({
    db: h.test.db,
    queue: new JobQueue(h.test.db, { workerId: "firewall-worker" }),
    definitions: createJobCatalog(h.services),
    log: silentLogger,
  });
});

afterAll(async () => {
  h?.services.runners.stop();
  await h?.drop();
});

async function runJobs(): Promise<void> {
  while (await worker.runOnce()) {}
}

async function deployed(name: string, onServer: string, ports: unknown[]) {
  const { environments } = await makeProject(owner, `${name} project`);
  const created = await makeService(owner, environments.development as string, {
    kind: "application",
    name,
    serverId: onServer,
    settings: { image: "nginx:alpine", servicePort: 80 },
  });
  const id = created.service.id as string;
  await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
  if (ports.length > 0)
    expect((await owner.put(`/services/${id}/ports`, { ports })).status).toBe(200);
  const started = await owner.post(`/services/${id}/deployments`, {});
  expect(started.status).toBe(202);
  await runJobs();
  const deployment = started.body.deployment.id as string;
  const view = (await owner.get(`/deployments/${deployment}`)).body.deployment;
  const log = (await owner.get(`/deployments/${deployment}/log?lines=all`)).body.text as string;
  return { id, status: view.status as string, log };
}

describe("a deploy on a remote server syncs its firewall (30b R2-13)", () => {
  test("the log names the firewall and the port, and reminds about the cloud firewall", async () => {
    const synced: Record<string, unknown>[] = [];
    serverRunner.extraHandlers.set("firewall.sync", async (params) => {
      synced.push(params);
      const service = (
        await h.test.db
          .selectFrom("service")
          .select("id")
          .where("name", "=", "dns")
          .executeTakeFirst()
      )?.id;
      return answer({
        ports: [
          { port: 9000, protocol: "udp", services: service ? [service] : [], result: "allowed" },
        ],
      });
    });
    const app = await deployed("dns", serverId, [
      { containerPort: 9000, publishedPort: 9000, protocol: "udp" },
    ]);
    expect(app.status).toBe("active");
    expect(synced).toHaveLength(1);
    expect(app.log).toContain("ufw: allowed 9000/udp");
    expect(app.log).toContain(
      "If this server is behind a cloud firewall or security group, allow 9000/udp there too.",
    );
  });

  test("an older runner says no ports were opened, and which to allow", async () => {
    serverRunner.extraHandlers.set("firewall.sync", async () => {
      throw Object.assign(new Error("This runner doesn't know the command firewall.sync."), {
        code: "unsupported",
      });
    });
    const app = await deployed("game", serverId, [
      { containerPort: 7777, publishedPort: 7777, protocol: "udp" },
    ]);
    expect(app.status).toBe("active");
    expect(app.log).toContain(
      "This server's runner is too old to open published ports in its firewall, so no ports were opened. Run setup again on the server's page to update the runner, or allow 7777/udp in the server's firewall and in any cloud firewall in front of it.",
    );
  });

  test("a firewall that fails never fails the deploy", async () => {
    serverRunner.extraHandlers.set("firewall.sync", async () => {
      throw new Error("ufw: command timed out");
    });
    const app = await deployed("api", serverId, [
      { containerPort: 8080, publishedPort: 8080, protocol: "tcp" },
    ]);
    expect(app.status).toBe("active");
    expect(app.log).toContain(
      "Published ports weren't opened in the server's firewall: ufw: command timed out. Allow 8080/tcp there yourself, and in any cloud firewall in front of it.",
    );
  });

  test("the Nearzero host's firewall is never changed", async () => {
    let asked = 0;
    hostRunner.extraHandlers.set("firewall.sync", async () => {
      asked++;
      return answer({});
    });
    const app = await deployed("site", "host", [
      { containerPort: 9100, publishedPort: 9100, protocol: "udp" },
    ]);
    expect(app.status).toBe("active");
    expect(asked).toBe(0);
    expect(app.log).not.toContain("firewall");
  });

  test("deleting a service there removes the rules Nearzero added for its ports, and says so", async () => {
    serverRunner.extraHandlers.set("firewall.sync", async () => answer({}));
    const app = await deployed("metrics", serverId, [
      { containerPort: 8125, publishedPort: 8125, protocol: "udp" },
    ]);
    let synced = 0;
    serverRunner.extraHandlers.set("firewall.sync", async () => {
      synced++;
      return answer({ removed: [{ port: 8125, protocol: "udp" }] });
    });
    const row = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", app.id)
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
      { stopFirst: true, removeVolumes: true, signal: new AbortController().signal },
    );
    expect(synced).toBe(1);
    expect(result).toEqual({
      removed: true,
      notes: [
        "ufw: removed the rule Nearzero added for 8125/udp, which nothing on this server publishes any more",
      ],
    });
  });
});
