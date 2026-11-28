import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { HostnameProviders } from "../src/deploys/hostnames.ts";
import { requestDeploy } from "../src/deploys/queue.ts";
import { createJobCatalog } from "../src/jobs/catalog.ts";
import { JobQueue } from "../src/jobs/queue.ts";
import { JobWorker } from "../src/jobs/worker.ts";
import { silentLogger } from "../src/log.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { copyAppSettings } from "../src/service-runtime/app-settings.ts";
import { checkMountsOnSave } from "../src/service-runtime/host-mounts.ts";
import { runnerTeardown } from "../src/service-runtime/teardown.ts";
import { storeUpload } from "../src/sources/uploads.ts";
import { FakeRunner } from "./support/fake-runner.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { makeProject, makeService } from "./support/projects.ts";

/**
 * The Nearzero host and copies (spec 24 G3, 22.2, 05 5.4): application bind mounts on the host
 * are for instance administrators (30b R2-07, B1-02), a workspace whose host allowance was
 * withdrawn stops deploying there and gets no new copies there (B1-07), and a copy never shares
 * the original's volume (B1-05) or uploaded archive (B1-30).
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
  runner.commands.length = 0;
  h.services.hostnameProviders = new HostnameProviders();
  owner = await setUpNamedOwner(h);
});

async function runJobs(): Promise<void> {
  while (await worker.runOnce()) {}
}

async function deploymentOf(id: string) {
  return (await owner.get(`/deployments/${id}`)).body.deployment as {
    id: string;
    status: string;
    error: string | null;
  };
}

async function logOf(id: string): Promise<string> {
  return (await owner.get(`/deployments/${id}/log?lines=all`)).body.text as string;
}

/**
 * The report's setting: "Team Two" is allowed on the host, and Ann is its admin but not an
 * instance administrator. The owner (an instance administrator) stays in Team Two too.
 */
async function teamTwo() {
  const team = await owner.post("/workspaces", { name: "Team Two" });
  const teamId = team.body.workspace.id as string;
  await owner.post(`/workspaces/${teamId}/switch`);
  const ann = await addMemberThroughInvitation(h, owner, "ann@example.com", { role: "admin" });
  await ann.post(`/workspaces/${teamId}/switch`);
  expect((await owner.put(`/host/allowed-workspaces/${teamId}`, { allowed: true })).status).toBe(
    200,
  );
  const { environments, projectId } = await makeProject(ann, "Shop");
  const created = await makeService(ann, environments.development as string, {
    kind: "application",
    name: "web",
    settings: { image: "nginx:alpine", servicePort: 80 },
  });
  const id = created.service.id as string;
  await ann.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
  return { teamId, ann, id, projectId, appName: created.service.appName as string };
}

async function deployBy(browser: Browser, serviceId: string) {
  const reply = await browser.post(`/services/${serviceId}/deployments`, {});
  return reply;
}

/** A deploy with no person, as a push or a webhook makes it. */
async function pushDeploy(serviceId: string, workspaceId: string) {
  const result = await requestDeploy(h.test.db, {
    serviceId,
    workspaceId,
    trigger: "webhook",
    requestedBy: null,
    cleanCache: false,
  });
  await runJobs();
  return deploymentOf(result.deployment.id);
}

const SOCKET = {
  type: "bind" as const,
  hostPath: "/var/run/docker.sock",
  containerPath: "/var/run/docker.sock",
  readOnly: false,
};
const ROOT = { type: "bind" as const, hostPath: "/", containerPath: "/host", readOnly: false };
const ETC = { type: "bind" as const, hostPath: "/etc", containerPath: "/host-etc", readOnly: true };

describe("application bind mounts on the Nearzero host (30b R2-07, B1-02, spec 24 G3)", () => {
  test("refused for anyone but instance administrators, whose deploy approves that definition", async () => {
    const team = await teamTwo();
    // The report's attack: the Docker socket, then / at /host.
    const socket = await team.ann.put(`/services/${team.id}/mounts`, { mounts: [SOCKET] });
    expect(socket.status).toBe(403);
    expect(socket.body.error.message).toContain("Docker socket");
    expect(socket.body.error.message).toContain(
      "On the Nearzero host only Nearzero administrators can deploy bind mounts.",
    );
    const root = await team.ann.put(`/services/${team.id}/mounts`, { mounts: [ROOT] });
    expect(root.status).toBe(403);
    // / holds the socket too.
    expect(root.body.error.message).toContain(
      "The mount at /host is /, which holds the Docker socket",
    );
    const etc = await team.ann.put(`/services/${team.id}/mounts`, { mounts: [ETC] });
    expect(etc.status).toBe(403);
    expect(etc.body.error.message).toContain("is the server's folder /etc");
    // Volumes are fine.
    expect(
      (
        await team.ann.put(`/services/${team.id}/mounts`, {
          mounts: [{ type: "volume", name: "data", containerPath: "/data" }],
        })
      ).status,
    ).toBe(200);

    // An instance administrator may save and deploy them.
    expect(
      (await owner.put(`/services/${team.id}/mounts`, { mounts: [SOCKET, ROOT, ETC] })).status,
    ).toBe(200);
    const refused = await deployBy(team.ann, team.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain("the Docker socket and server folders");
    const byAdmin = await deployBy(owner, team.id);
    expect(byAdmin.status).toBe(202);
    await runJobs();
    const first = await deploymentOf(byAdmin.body.deployment.id);
    expect(first.status).toBe("active");
    expect(await logOf(first.id)).toContain(
      "Allowed on the Nearzero host for a Nearzero administrator",
    );
    const created = runner.commands.filter((command) => command.kind === "container.create").at(-1);
    expect(created?.params.mounts).toContainEqual({
      type: "bind",
      source: "/var/run/docker.sock",
      target: "/var/run/docker.sock",
      readOnly: false,
    });

    // The same definition again: Ann's deploy and a push run it.
    const again = await deployBy(team.ann, team.id);
    expect(again.status).toBe(202);
    await runJobs();
    expect((await deploymentOf(again.body.deployment.id)).status).toBe("active");
    // Saving the mounts again unchanged is fine for her.
    expect(
      (await team.ann.put(`/services/${team.id}/mounts`, { mounts: [SOCKET, ROOT, ETC] })).status,
    ).toBe(200);

    // Another image with the same mounts is another definition (B1-06's rule for apps).
    expect(
      (await team.ann.patch(`/services/${team.id}`, { settings: { image: "docker:cli" } })).status,
    ).toBe(200);
    expect((await deployBy(team.ann, team.id)).status).toBe(403);
    const pushed = await pushDeploy(team.id, team.teamId);
    expect(pushed.status).toBe("failed");
    expect(await logOf(pushed.id)).toContain(
      "Refused on the Nearzero host: The mount at /var/run/docker.sock is /var/run/docker.sock",
    );
  });

  test("the approval covers the whole definition: variables, ports, the service port, files and hostnames (C1-04)", async () => {
    const team = await teamTwo();
    // The report's setting: a Docker socket proxy, approved read-only by an administrator.
    expect(
      (
        await team.ann.patch(`/services/${team.id}`, {
          settings: { image: "tecnativa/docker-socket-proxy:0.3", servicePort: 2375 },
        })
      ).status,
    ).toBe(200);
    const readOnlySocket = { ...SOCKET, readOnly: true };
    expect(
      (await owner.put(`/services/${team.id}/mounts`, { mounts: [readOnlySocket] })).status,
    ).toBe(200);
    expect(
      (await owner.put(`/services/${team.id}/variables`, { text: "CONTAINERS=1\n" })).status,
    ).toBe(200);
    const byAdmin = await deployBy(owner, team.id);
    expect(byAdmin.status).toBe(202);
    await runJobs();
    expect((await deploymentOf(byAdmin.body.deployment.id)).status).toBe("active");
    // The same definition: Ann's deploy runs it.
    const same = await deployBy(team.ann, team.id);
    expect(same.status).toBe(202);
    await runJobs();
    expect((await deploymentOf(same.body.deployment.id)).status).toBe("active");

    // The attack: Ann widens what the proxy allows. Saving is fine; deploying needs approval.
    expect(
      (
        await team.ann.put(`/services/${team.id}/variables`, {
          text: "CONTAINERS=1\nPOST=1\nEXEC=1\nALLOW_START=1\n",
        })
      ).status,
    ).toBe(200);
    const widened = await deployBy(team.ann, team.id);
    expect(widened.status).toBe(403);
    expect(widened.body.error.message).toContain("only Nearzero administrators can deploy");
    runner.commands.length = 0;
    const pushed = await pushDeploy(team.id, team.teamId);
    expect(pushed.status).toBe("failed");
    expect(await logOf(pushed.id)).toContain("Refused on the Nearzero host:");
    expect(runner.commands.some((command) => command.kind === "container.create")).toBe(false);
    // A Reload runs the new variables too, so it is refused as well.
    expect((await team.ann.post(`/services/${team.id}/reload`, {})).status).toBe(403);

    // Back to the approved values: allowed again.
    await team.ann.put(`/services/${team.id}/variables`, { text: "CONTAINERS=1\n" });
    const back = await deployBy(team.ann, team.id);
    expect(back.status).toBe(202);
    await runJobs();
    expect((await deploymentOf(back.body.deployment.id)).status).toBe("active");

    // A shared variable the app receives changes its resolved values.
    const environmentId = (
      await h.test.db
        .selectFrom("service")
        .select("environment_id")
        .where("id", "=", team.id)
        .executeTakeFirstOrThrow()
    ).environment_id;
    expect(
      (await owner.put(`/environments/${environmentId}/variables`, { text: "POST=1\n" })).status,
    ).toBe(200);
    expect((await deployBy(team.ann, team.id)).status).toBe(403);
    await owner.put(`/environments/${environmentId}/variables`, { text: "" });
    expect((await deployBy(team.ann, team.id)).status).toBe(202);
    await runJobs();

    // Publishing the proxy's port on the host, or moving the service port, is a change too.
    expect(
      (
        await team.ann.put(`/services/${team.id}/ports`, {
          ports: [{ containerPort: 2375, publishedPort: 2375, protocol: "tcp", mode: "host" }],
        })
      ).status,
    ).toBe(200);
    const published = await deployBy(team.ann, team.id);
    expect(published.status).toBe(403);
    await team.ann.put(`/services/${team.id}/ports`, { ports: [] });
    expect((await deployBy(team.ann, team.id)).status).toBe(202);
    await runJobs();
    await team.ann.patch(`/services/${team.id}`, { settings: { servicePort: 2376 } });
    expect((await deployBy(team.ann, team.id)).status).toBe(403);
    await team.ann.patch(`/services/${team.id}`, { settings: { servicePort: 2375 } });
    expect((await deployBy(team.ann, team.id)).status).toBe(202);
    await runJobs();

    // Hostnames route to it without a deploy, so only administrators add or generate them.
    const hostname = await team.ann.post("/domains/hostnames", {
      hostname: "docker.example.org",
      connect: { serviceId: team.id, port: 2375 },
    });
    expect(hostname.status).toBe(403);
    expect(hostname.body.error.message).toContain(
      "only Nearzero administrators can change the hostnames",
    );
    const generated = await team.ann.post(`/services/${team.id}/hostnames/generate`, {});
    expect(generated.status).toBe(403);
    expect(
      await h.test.db
        .selectFrom("hostname")
        .select("id")
        .where("service_id", "=", team.id)
        .execute(),
    ).toEqual([]);
  }, 180_000);

  test("elsewhere they are allowed, with Compose's warning", () => {
    const binds = [
      { ...SOCKET, id: "a" },
      { ...ETC, id: "b" },
    ] as const;
    expect(
      checkMountsOnSave({ onHost: false, isAdmin: false, before: [], after: [...binds] }),
    ).toEqual([
      "Warning: The mount at /var/run/docker.sock is /var/run/docker.sock, which holds the Docker socket: control of every container on the server.",
      "Warning: The mount at /host-etc is the server's folder /etc, outside the service's own volumes.",
    ]);
    expect(() =>
      checkMountsOnSave({ onHost: true, isAdmin: false, before: [], after: [...binds] }),
    ).toThrow("Docker socket");
    expect(
      checkMountsOnSave({ onHost: true, isAdmin: true, before: [], after: [...binds] }),
    ).toEqual([]);
  });
});

describe("withdrawing a workspace's host allowance (B1-07, spec 24 G3, 22.2)", () => {
  test("stops its deploys there, by people and pushes, and its new environments get no host copies", async () => {
    const team = await teamTwo();
    const first = await deployBy(team.ann, team.id);
    expect(first.status).toBe(202);
    await runJobs();
    expect((await deploymentOf(first.body.deployment.id)).status).toBe("active");

    expect(
      (await owner.put(`/host/allowed-workspaces/${team.teamId}`, { allowed: false })).status,
    ).toBe(200);
    // Creating a host service was already refused; deploying one is now too.
    const refused = await deployBy(team.ann, team.id);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain(
      "This workspace isn't allowed on the Nearzero host any more",
    );
    expect((await team.ann.post(`/services/${team.id}/reload`, {})).status).toBe(403);
    // A push or webhook deploy fails with the same reason, and the running version stays.
    const pushed = await pushDeploy(team.id, team.teamId);
    expect(pushed.status).toBe("failed");
    expect(pushed.error).toContain("This workspace isn't allowed on the Nearzero host any more");
    expect((await deploymentOf(first.body.deployment.id)).status).toBe("active");
    // A new environment doesn't copy the host service onto the host.
    const staging = await team.ann.post(`/projects/${team.projectId}/environments`, {
      name: "staging",
    });
    expect(staging.status).toBe(201);
    expect(staging.body.copiedServices).toBe(0);
    expect(staging.body.notCopied).toEqual([
      {
        name: "web",
        reason:
          "web runs on the Nearzero host, which this workspace can't use, so it wasn't copied. Create it in this environment on another server.",
      },
    ]);
    // An instance administrator can still deploy it.
    const byAdmin = await deployBy(owner, team.id);
    expect(byAdmin.status).toBe(202);
    await runJobs();
    expect((await deploymentOf(byAdmin.body.deployment.id)).status).toBe("active");
  });
});

describe("copies get their own data (B1-05, B1-30, spec 05 5.4)", () => {
  test("a copy of a moved app gets its own volume and no bind mounts", async () => {
    expect(
      copyAppSettings({
        source: { type: "image", image: "nginx:alpine", registry: null },
        mounts: [
          {
            type: "volume",
            id: "m1",
            name: "data",
            containerPath: "/data",
            volume: "legacy_shop_data",
          },
          { type: "bind", id: "m2", hostPath: "/srv/shop", containerPath: "/srv", readOnly: false },
          { type: "file", id: "m3", containerPath: "/etc/app.conf" },
        ],
      }).mounts,
    ).toEqual([{ type: "volume", id: "m1", name: "data", containerPath: "/data" }]);

    // End to end: the report's imported app, then a staging copy deployed and deleted.
    const { environments, projectId } = await makeProject(owner, "Shop");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const id = created.service.id as string;
    const row = await h.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await h.test.db
      .updateTable("service")
      .set({
        settings: JSON.stringify({
          ...(row.settings ?? {}),
          mounts: [
            {
              type: "volume",
              id: "m1",
              name: "data",
              containerPath: "/data",
              volume: "legacy_shop_data",
            },
          ],
        }),
      })
      .where("id", "=", id)
      .execute();
    const staging = await owner.post(`/projects/${projectId}/environments`, { name: "staging" });
    expect(staging.body.copiedServices).toBe(1);
    const copy = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("environment_id", "=", staging.body.environment.id)
      .executeTakeFirstOrThrow();
    await owner.patch(`/services/${copy.id}/deploy-settings`, { stabilitySeconds: 0 });
    const deployed = await deployBy(owner, copy.id);
    await runJobs();
    expect((await deploymentOf(deployed.body.deployment.id)).status).toBe("active");
    const mounts = runner.commands.find((command) => command.kind === "container.create")?.params
      .mounts as { source: string }[];
    expect(mounts.map((mount) => mount.source)).toEqual([`${copy.app_name}-data`]);
    expect(runner.volumes.has("legacy_shop_data")).toBe(false);
  });

  test("a removed volume's data goes only when nothing uses it, and the log says what happened (C1-10)", async () => {
    const { environments } = await makeProject(owner, "Shop", ["staging"]);
    const made = async (environment: string, name: string) => {
      const created = await makeService(owner, environments[environment] as string, {
        kind: "application",
        name,
        settings: { image: "nginx:alpine", servicePort: 80 },
      });
      const id = created.service.id as string;
      await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
      return { id, appName: created.service.appName as string };
    };
    const web = await made("development", "web");
    const DATA = { type: "volume", name: "data", containerPath: "/data" };
    await owner.put(`/services/${web.id}/mounts`, { mounts: [DATA] });
    await deployBy(owner, web.id);
    await runJobs();
    const volume = `${web.appName}-data`;
    expect(runner.volumes.has(volume)).toBe(true);
    // The report's first case: removed with "delete its data", then added back before a deploy.
    await owner.put(`/services/${web.id}/mounts`, { mounts: [], deleteVolumeData: ["data"] });
    const again = await owner.put(`/services/${web.id}/mounts`, { mounts: [DATA] });
    expect(again.status).toBe(200);
    expect(again.body.service.settings.pendingVolumeRemovals ?? []).toEqual([]);
    const redeployed = await deployBy(owner, web.id);
    await runJobs();
    expect(await logOf(redeployed.body.deployment.id)).not.toContain("Deleted the data");
    expect(runner.volumes.has(volume)).toBe(true);

    // The second: a 0.1.x volume two services still share; one removes it with its data.
    const other = await made("staging", "worker");
    for (const id of [web.id, other.id]) {
      const row = await h.test.db
        .selectFrom("service")
        .select("settings")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      await h.test.db
        .updateTable("service")
        .set({
          settings: JSON.stringify({
            ...(row.settings ?? {}),
            mounts: [
              { type: "volume", id: "m1", name: "shared", containerPath: "/s", volume: "legacy_v" },
            ],
          }),
        })
        .where("id", "=", id)
        .execute();
      await deployBy(owner, id);
      await runJobs();
    }
    await owner.put(`/services/${web.id}/mounts`, { mounts: [], deleteVolumeData: ["shared"] });
    const removed = await deployBy(owner, web.id);
    await runJobs();
    expect((await deploymentOf(removed.body.deployment.id)).status).toBe("active");
    const text = await logOf(removed.body.deployment.id);
    expect(text).toContain("The volume legacy_v is also used by worker, so its data was kept.");
    expect(text).not.toContain("Deleted the data of the removed volume legacy_v");
    expect(runner.volumes.has("legacy_v")).toBe(true);

    // The third: something outside Nearzero's records still mounts it; Docker refuses, and the
    // log says so instead of claiming it was deleted.
    await owner.put(`/services/${web.id}/mounts`, { mounts: [DATA] });
    await deployBy(owner, web.id);
    await runJobs();
    const running = runner.serviceContainers(web.id)[0];
    if (!running) throw new Error("web isn't running.");
    runner.containers.set("outsider000000", {
      ...running,
      id: "outsider000000",
      name: "outsider",
      labels: {},
      mounts: [{ type: "volume", source: volume }],
    });
    await owner.put(`/services/${web.id}/mounts`, { mounts: [], deleteVolumeData: ["data"] });
    const refused = await deployBy(owner, web.id);
    await runJobs();
    const refusedText = await logOf(refused.body.deployment.id);
    expect(refusedText).toContain(
      `The volume ${volume} is still in use by a container, so its data was kept.`,
    );
    expect(refusedText).not.toContain(`Deleted the data of the removed volume ${volume}`);
    runner.containers.delete("outsider000000");
  });

  test("two apps share a named volume; nothing else can reach it (G2-08)", async () => {
    const { environments } = await makeProject(owner, "Shop", ["staging"]);
    const made = async (environment: string, name: string) => {
      const created = await makeService(owner, environments[environment] as string, {
        kind: "application",
        name,
        settings: { image: "nginx:alpine", servicePort: 80 },
      });
      const id = created.service.id as string;
      await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
      return { id, appName: created.service.appName as string };
    };
    const web = await made("development", "web");
    const worker = await made("development", "worker");
    const elsewhere = await made("staging", "other");
    await owner.put(`/services/${web.id}/mounts`, {
      mounts: [{ type: "volume", name: "uploads", containerPath: "/srv/uploads" }],
    });
    // The worker is offered web's volume, and mounts it.
    const offered = await owner.get(`/services/${worker.id}/shareable-volumes`);
    expect(offered.status).toBe(200);
    expect(offered.body.volumes).toEqual([
      { serviceId: web.id, serviceName: "web", name: "uploads", containerPath: "/srv/uploads" },
    ]);
    const shared = await owner.put(`/services/${worker.id}/mounts`, {
      mounts: [{ type: "volume", name: "uploads", of: web.id, containerPath: "/uploads" }],
    });
    expect(shared.status).toBe(200);
    for (const id of [web.id, worker.id]) {
      await deployBy(owner, id);
      await runJobs();
    }
    const sources = (serviceId: string) => {
      const create = runner.commands
        .filter(
          (command) =>
            command.kind === "container.create" &&
            (command.params.labels as Record<string, string>)["dev.nearzero.service"] === serviceId,
        )
        .at(-1);
      return ((create?.params.mounts ?? []) as { source: string }[]).map((mount) => mount.source);
    };
    expect(sources(worker.id)).toEqual([`${web.appName}-uploads`]);
    expect(sources(web.id)).toEqual([`${web.appName}-uploads`]);

    // Not offered and refused: an app in another environment, a made-up id, a member who
    // can't configure web.
    expect((await owner.get(`/services/${elsewhere.id}/shareable-volumes`)).body.volumes).toEqual(
      [],
    );
    const across = await owner.put(`/services/${elsewhere.id}/mounts`, {
      mounts: [{ type: "volume", name: "uploads", of: web.id, containerPath: "/uploads" }],
    });
    expect(across.status).toBe(400);
    expect(across.body.error.message).toBe(
      "Pick a volume of another app in this environment on the same server, one you can configure.",
    );
    const madeUp = await owner.put(`/services/${elsewhere.id}/mounts`, {
      mounts: [
        {
          type: "volume",
          name: "uploads",
          of: "00000000-0000-4000-8000-000000000000",
          containerPath: "/uploads",
        },
      ],
    });
    expect(madeUp.status).toBe(400);
    const member = await addMemberThroughInvitation(h, owner, "mia@example.com", {
      role: "member",
    });
    const memberId = (
      await h.test.db
        .selectFrom("person")
        .select("id")
        .where("email", "=", "mia@example.com")
        .executeTakeFirstOrThrow()
    ).id;
    await owner.put(`/workspace/members/${memberId}/access`, {
      policyIds: [],
      capabilities: ["services.create"],
      scope: {
        allProjects: false,
        projectIds: [],
        environmentIds: [],
        serviceIds: [worker.id],
        allServers: false,
        serverIds: [],
        allGitAccounts: false,
        gitAccountIds: [],
      },
    });
    expect((await member.get(`/services/${worker.id}/shareable-volumes`)).body.volumes).toEqual([]);
    // Her save keeps the mount someone else set up, but she can't point it at another volume.
    expect(
      (
        await member.put(`/services/${worker.id}/mounts`, {
          mounts: [
            {
              type: "volume",
              id: shared.body.service.settings.mounts[0].id,
              name: "uploads",
              of: web.id,
              containerPath: "/uploads",
            },
          ],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await member.put(`/services/${worker.id}/mounts`, {
          mounts: [{ type: "volume", name: "uploads", of: web.id, containerPath: "/other" }],
        })
      ).status,
    ).toBe(400);

    // Removing the shared mount never deletes web's data, and deleting web keeps it for worker.
    const removed = await owner.put(`/services/${worker.id}/mounts`, {
      mounts: [],
      deleteVolumeData: ["uploads"],
    });
    expect(removed.body.service.settings.pendingVolumeRemovals ?? []).toEqual([]);
    await owner.put(`/services/${worker.id}/mounts`, {
      mounts: [{ type: "volume", name: "uploads", of: web.id, containerPath: "/uploads" }],
    });
    const row = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", web.id)
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
      { stopFirst: true, removeVolumes: true, signal: new AbortController().signal },
    );
    expect(done.removed && done.notes).toContain(
      `The volume ${web.appName}-uploads is also used by worker, so its data was kept.`,
    );
    expect(runner.volumes.has(`${web.appName}-uploads`)).toBe(true);
  });

  test("deleting a service never removes a volume another service still mounts", async () => {
    const { environments } = await makeProject(owner, "Shop", ["staging"]);
    const ids: string[] = [];
    for (const environment of ["development", "staging"]) {
      const created = await makeService(owner, environments[environment] as string, {
        kind: "application",
        name: `web-${environment}`,
        settings: { image: "nginx:alpine", servicePort: 80 },
      });
      ids.push(created.service.id as string);
    }
    // A copy made before copies had volumes of their own: both name the 0.1.x volume.
    for (const id of ids) {
      const row = await h.test.db
        .selectFrom("service")
        .select("settings")
        .where("id", "=", id)
        .executeTakeFirstOrThrow();
      await h.test.db
        .updateTable("service")
        .set({
          settings: JSON.stringify({
            ...(row.settings ?? {}),
            mounts: [
              { type: "volume", id: "m1", name: "data", containerPath: "/d", volume: "legacy_v" },
            ],
          }),
        })
        .where("id", "=", id)
        .execute();
      await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
      await deployBy(owner, id);
      await runJobs();
    }
    expect(runner.volumes.has("legacy_v")).toBe(true);
    const row = await h.test.db
      .selectFrom("service")
      .selectAll()
      .where("id", "=", ids[1] as string)
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
      { stopFirst: true, removeVolumes: true, signal: new AbortController().signal },
    );
    expect(done).toEqual({
      removed: true,
      notes: ["The volume legacy_v is also used by web-development, so its data was kept."],
    });
    expect(runner.volumes.has("legacy_v")).toBe(true);
  });

  test("a copy keeps its own uploaded archive, so the original's next upload doesn't break it", async () => {
    const { environments, projectId } = await makeProject(owner, "Shop");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "site",
      settings: {},
    });
    const id = created.service.id as string;
    const zip = () => {
      const bytes = new Uint8Array(64);
      bytes[0] = 0x50;
      bytes[1] = 0x4b;
      return new Blob([bytes]).stream();
    };
    const ids = await h.test.db
      .selectFrom("service")
      .select(["workspace_id"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const person = await h.test.db.selectFrom("person").select("id").executeTakeFirstOrThrow();
    const stored = await storeUpload(h.test.db, {
      serviceId: id,
      workspaceId: ids.workspace_id,
      personId: person.id,
      fileName: "site.zip",
      body: zip(),
    });
    const row = await h.test.db
      .selectFrom("service")
      .select("settings")
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    await h.test.db
      .updateTable("service")
      .set({
        settings: JSON.stringify({
          ...(row.settings ?? {}),
          source: { type: "upload", buildPath: "", upload: stored },
        }),
      })
      .where("id", "=", id)
      .execute();
    const staging = await owner.post(`/projects/${projectId}/environments`, { name: "staging" });
    const copy = await h.test.db
      .selectFrom("service")
      .select(["id", "settings"])
      .where("environment_id", "=", staging.body.environment.id)
      .executeTakeFirstOrThrow();
    const copyUpload = (copy.settings as { source: { upload: { id: string } } }).source.upload.id;
    expect(copyUpload).not.toBe(stored.id);
    // The original uploads a new archive: its old one goes, the copy's stays.
    await storeUpload(h.test.db, {
      serviceId: id,
      workspaceId: ids.workspace_id,
      personId: person.id,
      fileName: "site-2.zip",
      body: zip(),
    });
    const left = await h.test.db
      .selectFrom("source_upload")
      .select(["id", "service_id", "complete"])
      .execute();
    expect(left.find((item) => item.id === stored.id)).toBeUndefined();
    expect(left.find((item) => item.id === copyUpload)).toMatchObject({
      service_id: copy.id,
      complete: true,
    });
    const parts = await h.test.db
      .selectFrom("source_upload_part")
      .select("seq")
      .where("upload_id", "=", copyUpload)
      .execute();
    expect(parts.length).toBe(1);
  });

  test("an archive a build is downloading stays when a new one is uploaded", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "site",
      settings: {},
    });
    const id = created.service.id as string;
    const row = await h.test.db
      .selectFrom("service")
      .select(["workspace_id", "app_name"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    const person = await h.test.db.selectFrom("person").select("id").executeTakeFirstOrThrow();
    const zip = () => new Blob([new Uint8Array([0x50, 0x4b, 3, 4])]).stream();
    const old = await storeUpload(h.test.db, {
      serviceId: id,
      workspaceId: row.workspace_id,
      personId: person.id,
      fileName: "a.zip",
      body: zip(),
    });
    await h.test.db
      .insertInto("deployment")
      .values({
        workspace_id: row.workspace_id,
        service_id: id,
        service_kind: "application",
        service_name: "site",
        app_name: row.app_name,
        project_name: "Shop",
        environment_name: "development",
        server_name: "Nearzero host",
        status: "building",
        trigger: "manual",
        source: JSON.stringify({ type: "upload", uploadId: old.id }),
      })
      .execute();
    await storeUpload(h.test.db, {
      serviceId: id,
      workspaceId: row.workspace_id,
      personId: person.id,
      fileName: "b.zip",
      body: zip(),
    });
    const left = await h.test.db
      .selectFrom("source_upload")
      .select("id")
      .where("service_id", "=", id)
      .execute();
    expect(left.map((item) => item.id)).toContain(old.id);
  });
});

describe("registry logins (B1-09, spec 23.4.3)", () => {
  test("a saved password never follows the image to another registry", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: {},
    });
    const id = created.service.id as string;
    await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
    const saved = await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "registry.acme.com/shop/web:1",
      registry: { address: "", username: "deploy", password: "acme-registry-password" },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.service.settings.source.registry.passwordSet).toBe(true);
    // The same registry with a new tag keeps it.
    const tag = await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "registry.acme.com/shop/web:2",
      registry: { address: "", username: "deploy", password: "" },
    });
    expect(tag.body.service.settings.source.registry.passwordSet).toBe(true);
    // The report's attack: another registry, the same username and a blank password.
    const moved = await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "attacker.example.net/x:1",
      registry: { address: "", username: "deploy", password: "" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.service.settings.source.registry.passwordSet).toBe(false);
    runner.commands.length = 0;
    const started = await owner.post(`/services/${id}/deployments`, {});
    await runJobs();
    const pulls = runner.commands.filter((command) => command.kind === "image.pull");
    expect(pulls.length).toBe(1);
    expect(pulls.every((command) => command.params.registryAuth === undefined)).toBe(true);
    expect(JSON.stringify(runner.commands)).not.toContain(
      Buffer.from("acme-registry-password").toString("base64url").slice(0, 12),
    );
    expect(await logOf(started.body.deployment.id)).not.toContain("acme-registry-password");
    // Changing only the registry address is another registry too.
    await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "shop/web:1",
      registry: { address: "registry.acme.com", username: "deploy", password: "pw-two" },
    });
    const address = await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "shop/web:1",
      registry: { address: "ghcr.io", username: "deploy", password: "" },
    });
    expect(address.body.service.settings.source.registry.passwordSet).toBe(false);
  });

  test("typing the old registry as the address doesn't carry the password to the image's new registry (C1-02)", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const created = await makeService(owner, environments.development as string, {
      kind: "application",
      name: "web",
      settings: {},
    });
    const id = created.service.id as string;
    await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
    const saved = await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "registry.acme.com/shop/web:1",
      registry: { address: "", username: "deploy", password: "acme-secret-pw" },
    });
    expect(saved.body.service.settings.source.registry.passwordSet).toBe(true);
    // The report's attack: the image moves to another registry, the address names the old one.
    const moved = await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "attacker.example.net/x:1",
      registry: { address: "registry.acme.com", username: "deploy", password: "" },
    });
    expect(moved.status).toBe(200);
    expect(moved.body.service.settings.source.registry.passwordSet).toBe(false);
    runner.commands.length = 0;
    await owner.post(`/services/${id}/deployments`, {});
    await runJobs();
    const pull = runner.commands.find((command) => command.kind === "image.pull");
    expect(pull?.params.image).toBe("attacker.example.net/x:1");
    expect(pull?.params.registryAuth).toBeUndefined();
    // Typing the address the image already names, then a new tag, still keeps it.
    await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "registry.acme.com/shop/web:1",
      registry: { address: "registry.acme.com", username: "deploy", password: "pw-again" },
    });
    const tag = await owner.put(`/services/${id}/source`, {
      type: "image",
      image: "registry.acme.com/shop/web:2",
      registry: { address: "registry.acme.com", username: "deploy", password: "" },
    });
    expect(tag.body.service.settings.source.registry.passwordSet).toBe(true);
  });
});

describe("resuming a log stream (B1-31, spec 22.4 rule 2)", () => {
  test("reuses a stream only for the same service and container", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const ids: string[] = [];
    for (const name of ["a", "b"]) {
      const created = await makeService(owner, environments.development as string, {
        kind: "application",
        name,
        settings: { image: "nginx:alpine", servicePort: 80 },
      });
      const id = created.service.id as string;
      await owner.patch(`/services/${id}/deploy-settings`, { stabilitySeconds: 0 });
      await owner.post(`/services/${id}/deployments`, {});
      await runJobs();
      ids.push(id);
    }
    const [a, b] = ids as [string, string];
    for (const container of runner.containers.values()) {
      if (container.labels["dev.nearzero.service"] === b) container.output = "b's private line\n";
      if (container.labels["dev.nearzero.service"] === a) container.output = "a's own line\n";
    }
    const cookie = [...owner.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const read = async (serviceId: string, resume?: string) => {
      const response = await h.app.request(`/api/v1/services/${serviceId}/logs?follow=0&tail=100`, {
        headers: { cookie, ...(resume ? { "last-event-id": resume } : {}) },
      });
      return response.text();
    };
    const ofB = await read(b);
    expect(ofB).toContain("b's private line");
    const streamId = /^id: ([0-9a-f-]{36}):\d+$/m.exec(ofB)?.[1];
    expect(streamId).toBeTruthy();
    // The report's attack: someone who can read a resumes with b's stream id.
    const throughA = await read(a, `${streamId}:0`);
    expect(throughA).not.toContain("b's private line");
    expect(throughA).toContain("a's own line");
    // b's own resume still works from where it was.
    const again = await read(b, `${streamId}:0`);
    expect(again).toContain("b's private line");
  });
});
