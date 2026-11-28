import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { type Browser, personIdOf, setUpNamedOwner } from "./support/harness.ts";
import {
  addMember,
  createProjectsHarness,
  giveAccess,
  makeProject,
  makeService,
  type ProjectsHarness,
  workspaceIdOf,
} from "./support/projects.ts";

/**
 * The rows of the permission matrix (spec 22.3) that concern projects, environments, services
 * and variables, over HTTP: owners and admins allowed, members by scope ("own services") and by
 * capability, and every object refused across workspaces, owners included (spec 22.4).
 */

setDefaultTimeout(120_000);

let p: ProjectsHarness;

beforeAll(async () => {
  p = await createProjectsHarness();
});

afterAll(async () => {
  await p.drop();
});

beforeEach(async () => {
  await p.reset();
});

interface World {
  owner: Browser;
  projectId: string;
  development: string;
  staging: string;
  api: string;
  apiStaging: string;
  db: string;
  serverId: string;
}

async function world(): Promise<World> {
  const owner = await setUpNamedOwner(p.h);
  const workspaceId = await workspaceIdOf(owner);
  const serverId = p.servers.add(workspaceId, "44444444-4444-4444-8444-444444444444");
  const { projectId, environments } = await makeProject(owner, "Web", ["staging"]);
  const development = environments.development as string;
  const api = await makeService(owner, development, { kind: "application", name: "api" });
  const db = await makeService(owner, development, { kind: "postgres", name: "db" });
  await makeProject(owner, "Other");
  return {
    owner,
    projectId,
    development,
    staging: environments.staging as string,
    api: api.service.id,
    apiStaging: api.alsoAddedTo[0].serviceId,
    db: db.service.id,
    serverId,
  };
}

/** The reads every visible object answers. */
function reads(w: World) {
  return {
    project: `/projects/${w.projectId}`,
    environments: `/projects/${w.projectId}/environments`,
    environment: `/environments/${w.development}`,
    services: `/environments/${w.development}/services`,
    service: `/services/${w.api}`,
    sharedVariables: `/environments/${w.development}/variables`,
    serviceVariables: `/services/${w.api}/variables`,
  };
}

async function statuses(browser: Browser, paths: Record<string, string>) {
  const out: Record<string, number> = {};
  for (const [name, path] of Object.entries(paths)) out[name] = (await browser.get(path)).status;
  return out;
}

const all = (status: number) => ({
  project: status,
  environments: status,
  environment: status,
  services: status,
  service: status,
  sharedVariables: status,
  serviceVariables: status,
});

describe("owners and admins reach everything in their workspace", () => {
  test("an admin of a workspace that isn't the first can't use the Nearzero host", async () => {
    const w = await world();
    const team = await w.owner.post("/workspaces", { name: "Team Two" });
    await w.owner.post(`/workspaces/${team.body.workspace.id}/switch`);
    const { environments } = await makeProject(w.owner, "Theirs");
    const admin = await addMember(p.h, w.owner, "ada@example.com", { role: "admin" });
    const switched = await admin.post(`/workspaces/${team.body.workspace.id}/switch`);
    expect(switched.status).toBe(200);
    const host = await admin.post(`/environments/${environments.development}/services`, {
      kind: "redis",
      name: "cache",
      serverId: "host",
    });
    expect(host.status).toBe(403);
    expect(host.body.error.message).toBe("Only Nearzero administrators can use the Nearzero host.");
  });

  test("an admin sees, creates, changes and deletes", async () => {
    const w = await world();
    const admin = await addMember(p.h, w.owner, "ada@example.com", { role: "admin" });
    expect(await statuses(admin, reads(w))).toEqual(all(200));
    expect((await admin.get("/projects")).body.projects).toHaveLength(2);
    expect((await admin.post("/projects", { name: "Admin's" })).status).toBe(201);
    expect((await admin.patch(`/projects/${w.projectId}`, { name: "Web 2" })).status).toBe(200);
    expect((await admin.post(`/projects/${w.projectId}/environments`, { name: "qa" })).status).toBe(
      201,
    );
    expect((await admin.patch(`/services/${w.api}`, { description: "x" })).status).toBe(200);
    expect((await admin.put(`/services/${w.api}/variables`, { text: "A=1\n" })).status).toBe(200);
    expect(
      (await admin.put(`/environments/${w.development}/variables`, { text: "B=1\n" })).status,
    ).toBe(200);
    // Admins of the first workspace are instance administrators, so the host is theirs too.
    expect(
      (await makeService(admin, w.development, { kind: "redis", name: "cache" })).service.onHost,
    ).toBe(true);
    expect(
      (
        await makeService(admin, w.development, {
          kind: "redis",
          name: "queue",
          serverId: w.serverId,
        })
      ).service.name,
    ).toBe("queue");
    expect((await admin.post(`/services/${w.db}/delete`, { confirm: "db" })).status).toBe(202);
    await p.runJobs();
    const plan = (await admin.get(`/projects/${w.projectId}/delete-plan`)).body.plan;
    expect(plan.canDelete).toBe(true);
  });
});

describe("a member with nothing granted", () => {
  test("sees nothing: every object answers as if it didn't exist", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com");
    const list = await member.get("/projects");
    expect(list.body).toMatchObject({ projects: [], total: 0, can: { create: false } });
    expect(await statuses(member, reads(w))).toEqual(all(404));
    const hidden = await member.get(`/services/${w.api}`);
    expect(hidden.body.error.message).toBe(
      "This service doesn't exist in this workspace, or you don't have access to it.",
    );
    expect((await member.post(`/services/${w.api}/variables/reveal`)).status).toBe(404);
    expect((await member.post(`/services/${w.db}/credentials/reveal`)).status).toBe(404);
    expect((await member.get(`/projects/${w.projectId}/delete-plan`)).status).toBe(404);
  });

  test("can't create projects without the capability, and is told which one", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com");
    const refused = await member.post("/projects", { name: "Mine" });
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toContain('"Create projects"');
  });
});

describe('a member scoped to a project ("own services")', () => {
  test("sees it, edits service and shared variables, but needs capabilities for the rest", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com", {
      scope: { projectIds: [w.projectId] },
    });
    expect(await statuses(member, reads(w))).toEqual(all(200));
    const list = (await member.get("/projects")).body;
    expect(list.projects.map((project: { name: string }) => project.name)).toEqual(["Web"]);
    expect(list.projects[0].can).toEqual({
      update: false,
      delete: false,
      createEnvironment: false,
    });
    expect(list.projects[0].serviceCount).toBe(4);

    expect((await member.put(`/services/${w.api}/variables`, { text: "A=1\n" })).status).toBe(200);
    expect((await member.post(`/services/${w.api}/variables/reveal`)).body.text).toBe("A=1\n");
    expect(
      (await member.put(`/environments/${w.development}/variables`, { text: "B=1\n" })).status,
    ).toBe(200);
    expect((await member.post(`/services/${w.db}/credentials/reveal`)).status).toBe(200);

    const refusals: [Promise<{ status: number; body: { error: { message: string } } }>, string][] =
      [
        [member.patch(`/projects/${w.projectId}`, { name: "Mine" }), "Create projects"],
        [
          member.post(`/projects/${w.projectId}/environments`, { name: "qa" }),
          "Create environments",
        ],
        [member.patch(`/environments/${w.staging}`, { name: "qa" }), "Create environments"],
        [member.delete(`/environments/${w.staging}`), "Delete environments"],
        [
          member.post(`/environments/${w.development}/services`, {
            kind: "redis",
            name: "cache",
            serverId: w.serverId,
          }),
          "Create services",
        ],
        [member.patch(`/services/${w.api}`, { description: "x" }), "Create services"],
        [member.post(`/services/${w.api}/delete`, { confirm: "api" }), "Delete services"],
        [member.get(`/projects/${w.projectId}/delete-plan`), "Delete projects"],
      ];
    for (const [request, capability] of refusals) {
      const reply = await request;
      expect(reply.status).toBe(403);
      expect(reply.body.error.message).toContain(`"${capability}"`);
    }
    // The other project stays out of sight.
    const other = (await w.owner.get("/projects?search=Other")).body.projects[0].id;
    expect((await member.get(`/projects/${other}`)).status).toBe(404);
  });

  test("scoped to one environment, the others and their services are hidden", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com", {
      scope: { environmentIds: [w.development] },
    });
    const project = (await member.get(`/projects/${w.projectId}`)).body.project;
    expect(project.environments.map((environment: { name: string }) => environment.name)).toEqual([
      "development",
    ]);
    expect(project.serviceCount).toBe(2);
    expect((await member.get(`/environments/${w.staging}`)).status).toBe(404);
    expect((await member.get(`/services/${w.apiStaging}`)).status).toBe(404);
    expect((await member.get(`/environments/${w.staging}/variables`)).status).toBe(404);
    // The copy in staging isn't listed among the copies it can open.
    expect((await member.get(`/services/${w.api}`)).body.service.copies).toEqual([]);
  });

  test("scoped to one service, only that service is visible", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com", {
      scope: { serviceIds: [w.api] },
    });
    const services = (await member.get(`/environments/${w.development}/services`)).body.services;
    expect(services.map((service: { name: string }) => service.name)).toEqual(["api"]);
    expect((await member.get(`/services/${w.db}`)).status).toBe(404);
    expect((await member.get(`/services/${w.api}/variables`)).status).toBe(200);
  });
});

describe("a member with capabilities", () => {
  test("creates and deletes projects, environments and services within their scope", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com", {
      capabilities: [
        "projects.create",
        "projects.delete",
        "environments.create",
        "environments.delete",
        "services.create",
        "services.delete",
      ],
      scope: { projectIds: [w.projectId], serverIds: [w.serverId] },
    });
    expect((await member.patch(`/projects/${w.projectId}`, { description: "ours" })).status).toBe(
      200,
    );
    const qa = await member.post(`/projects/${w.projectId}/environments`, { name: "qa" });
    expect(qa.status).toBe(201);
    expect(
      (await member.patch(`/environments/${qa.body.environment.id}`, { name: "qa-2" })).status,
    ).toBe(200);
    const cache = await makeService(member, w.development, {
      kind: "redis",
      name: "cache",
      serverId: w.serverId,
    });
    expect(cache.alsoAddedTo).toHaveLength(2);
    expect((await member.patch(`/services/${cache.service.id}`, { description: "x" })).status).toBe(
      200,
    );
    expect(
      (await member.post(`/services/${cache.service.id}/delete`, { confirm: "cache" })).status,
    ).toBe(202);
    // While that delete is pending, the project's plan waits for it.
    expect((await member.get(`/projects/${w.projectId}/delete-plan`)).body.plan.canDelete).toBe(
      false,
    );
    await p.runJobs();
    const plan = (await member.get(`/projects/${w.projectId}/delete-plan`)).body.plan;
    expect(plan.canDelete).toBe(true);
  });

  test("a project they create is theirs to see, even with no scope", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com", {
      capabilities: ["projects.create"],
    });
    const created = await member.post("/projects", { name: "Mine" });
    expect(created.status).toBe(201);
    expect(created.body.project.environments).toHaveLength(1);
    const list = (await member.get("/projects")).body.projects;
    expect(list.map((project: { name: string }) => project.name)).toEqual(["Mine"]);
    expect((await member.get(`/environments/${created.body.environmentId}`)).status).toBe(200);
    expect((await w.owner.get(`/projects/${created.body.project.id}`)).status).toBe(200);
  });

  test("a project delete with services they can't access shows why, and nothing is deleted", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com", {
      capabilities: ["projects.delete"],
      scope: { environmentIds: [w.development] },
    });
    const plan = (await member.get(`/projects/${w.projectId}/delete-plan`)).body.plan;
    expect(plan.counts).toMatchObject({ services: 4, noAccess: 2 });
    expect(plan.canDelete).toBe(false);
    expect(plan.blockers[0]).toBe(
      "You can't delete 2 services in this list, so nothing will be deleted. Ask an owner or admin.",
    );
    const hidden = plan.services.filter((item: { access: boolean }) => !item.access);
    expect(
      hidden.every(
        (item: { id: unknown; name: unknown; environment: unknown }) =>
          item.id === null && item.name === null && item.environment === null,
      ),
    ).toBe(true);
    const refused = await member.post(`/projects/${w.projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "Web",
    });
    expect(refused.status).toBe(403);
    expect(await p.runJobs()).toBe(0);
    expect((await w.owner.get(`/projects/${w.projectId}`)).body.project.serviceCount).toBe(4);
  });
});

describe("the workspace boundary (spec 22.4, rule 1)", () => {
  test("another workspace's objects are not found, for its owner too", async () => {
    const w = await world();
    const other = await w.owner.post("/workspaces", { name: "Elsewhere" });
    await w.owner.post(`/workspaces/${other.body.workspace.id}/switch`);
    expect(await statuses(w.owner, reads(w))).toEqual(all(404));
    const writes = [
      w.owner.patch(`/projects/${w.projectId}`, { name: "x" }),
      w.owner.post(`/projects/${w.projectId}/environments`, { name: "qa" }),
      w.owner.patch(`/environments/${w.development}`, { name: "x" }),
      w.owner.delete(`/environments/${w.staging}`),
      w.owner.post(`/environments/${w.development}/services`, {
        kind: "redis",
        name: "x",
        serverId: "host",
      }),
      w.owner.patch(`/services/${w.api}`, { description: "x" }),
      w.owner.put(`/services/${w.api}/variables`, { text: "A=1\n" }),
      w.owner.put(`/environments/${w.development}/variables`, { text: "A=1\n" }),
      w.owner.post(`/services/${w.api}/variables/reveal`),
      w.owner.post(`/services/${w.db}/credentials/reveal`),
      w.owner.post(`/services/${w.api}/delete`, { confirm: "api" }),
      w.owner.get(`/projects/${w.projectId}/delete-plan`),
      w.owner.post(`/environments/${w.development}/services/delete-plan`, { serviceIds: [w.api] }),
    ];
    for (const reply of await Promise.all(writes)) expect(reply.status).toBe(404);
    expect((await w.owner.get("/projects")).body.projects).toEqual([]);
    // A server of the first workspace can't be used from here either.
    const { environments } = await makeProject(w.owner, "Here");
    const foreignServer = await w.owner.post(`/environments/${environments.development}/services`, {
      kind: "redis",
      name: "x",
      serverId: w.serverId,
    });
    expect(foreignServer.status).toBe(404);
  });

  test("a delete run is followed only inside its workspace", async () => {
    const w = await world();
    const run = (await w.owner.post(`/services/${w.db}/delete`, { confirm: "db" })).body.run;
    expect((await w.owner.get(`/delete-runs/${run.id}`)).status).toBe(200);
    const member = await addMember(p.h, w.owner, "mia@example.com");
    expect((await member.get(`/delete-runs/${run.id}`)).status).toBe(404);
    const other = await w.owner.post("/workspaces", { name: "Elsewhere" });
    await w.owner.post(`/workspaces/${other.body.workspace.id}/switch`);
    expect((await w.owner.get(`/delete-runs/${run.id}`)).status).toBe(404);
  });
});

describe("scopes follow deletes", () => {
  test("when a member's only ticked service goes, its environment doesn't start covering everything", async () => {
    const w = await world();
    const member = await addMember(p.h, w.owner, "mia@example.com", {
      scope: { serviceIds: [w.api] },
    });
    expect((await member.get(`/services/${w.db}`)).status).toBe(404);
    await w.owner.post(`/services/${w.api}/delete`, { confirm: "api" });
    await p.runJobs();
    expect((await member.get(`/services/${w.db}`)).status).toBe(404);
    expect((await member.get(`/environments/${w.development}`)).status).toBe(404);
    const items = await p.h.test.db
      .selectFrom("access_scope_item")
      .select(["object_kind"])
      .where("person_id", "=", await personIdOf(p.h, "mia@example.com"))
      .execute();
    expect(items).toEqual([]);
  });

  test("a policy keeps the rest of its scope when one ticked service goes", async () => {
    const w = await world();
    await addMember(p.h, w.owner, "mia@example.com");
    await giveAccess(p.h, w.owner, "mia@example.com", { scope: { serviceIds: [w.api, w.db] } });
    await w.owner.post(`/services/${w.api}/delete`, { confirm: "api" });
    await p.runJobs();
    const items = await p.h.test.db
      .selectFrom("access_scope_item")
      .select(["object_kind", "object_id"])
      .where("person_id", "=", await personIdOf(p.h, "mia@example.com"))
      .orderBy("object_kind")
      .execute();
    expect(items.map((item) => item.object_kind)).toEqual(["environment", "project", "service"]);
    expect(items.find((item) => item.object_kind === "service")?.object_id).toBe(w.db);
  });
});
