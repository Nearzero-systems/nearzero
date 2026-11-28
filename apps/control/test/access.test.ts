import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { loadGrants, WorkspaceAccess } from "../src/access/grants.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
} from "./support/harness.ts";

// Throwaway databases can take seconds to create and migrate on a busy machine.
setDefaultTimeout(120_000);

let h: Harness;

beforeAll(async () => {
  h = await createHarness({ instanceEmail: INSTANCE_RESEND });
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
});

async function workspaceIdOf(browser: Browser): Promise<string> {
  return (await browser.get("/workspace")).body.workspace.id;
}

/** Projects, environments, services, servers and Git accounts that later milestones will own. */
function seedObjects(workspaceId: string, otherWorkspaceId: string) {
  const add = h.fakes.add.bind(h.fakes);
  add({ workspaceId, kind: "project", id: "proj-web" });
  add({ workspaceId, kind: "environment", id: "env-web-dev", projectId: "proj-web" });
  add({ workspaceId, kind: "environment", id: "env-web-prod", projectId: "proj-web" });
  add({
    workspaceId,
    kind: "service",
    id: "svc-web-dev-api",
    environmentId: "env-web-dev",
    projectId: "proj-web",
  });
  add({
    workspaceId,
    kind: "service",
    id: "svc-web-prod-api",
    environmentId: "env-web-prod",
    projectId: "proj-web",
  });
  add({ workspaceId, kind: "project", id: "proj-shop" });
  add({ workspaceId, kind: "server", id: "srv-1" });
  add({ workspaceId, kind: "server", id: "srv-2" });
  add({ workspaceId, kind: "git_account", id: "git-private", ownerPersonId: "someone" });
  add({ workspaceId: otherWorkspaceId, kind: "project", id: "proj-foreign" });
  add({ workspaceId: otherWorkspaceId, kind: "server", id: "srv-foreign" });
}

async function accessFor(email: string, workspaceId: string): Promise<WorkspaceAccess> {
  const grants = await loadGrants(h.test.db, {
    personId: await personIdOf(h, email),
    workspaceId,
    role: "member",
    isInstanceAdmin: false,
  });
  return new WorkspaceAccess(h.test.db, h.services.objects, grants);
}

describe("access policies (spec 04 4.7)", () => {
  test("create, list with holders, edit and delete", async () => {
    const owner = await setUpNamedOwner(h);
    const workspaceId = await workspaceIdOf(owner);
    seedObjects(workspaceId, "00000000-0000-0000-0000-000000000000");
    const created = await owner.post("/workspace/policies", {
      name: "Developers",
      description: "Work on the web project",
      capabilities: ["services.create", "projects.create"],
      scope: { projectIds: ["proj-web"], serverIds: ["srv-1"] },
    });
    expect(created.status).toBe(201);
    expect(created.body.policy).toMatchObject({
      name: "Developers",
      description: "Work on the web project",
      // Kept in catalog order.
      capabilities: ["projects.create", "services.create"],
      scope: {
        allProjects: false,
        projectIds: ["proj-web"],
        serverIds: ["srv-1"],
        allServers: false,
      },
      holders: [],
    });

    await addMemberThroughInvitation(h, owner, "mia@example.com", {
      policyIds: [created.body.policy.id],
    });
    const listed = await owner.get("/workspace/policies");
    expect(listed.body.count).toBe(1);
    expect(listed.body.policies[0].holders).toEqual([
      { id: await personIdOf(h, "mia@example.com"), name: "Mia Member", email: "mia@example.com" },
    ]);

    const edited = await owner.put(`/workspace/policies/${created.body.policy.id}`, {
      name: "Web developers",
      capabilities: [],
      scope: { allProjects: true, allServers: true, allGitAccounts: true },
    });
    expect(edited.body.policy).toMatchObject({
      name: "Web developers",
      description: "",
      capabilities: [],
      scope: { allProjects: true, allServers: true, allGitAccounts: true, projectIds: [] },
    });

    const deleted = await owner.delete(`/workspace/policies/${created.body.policy.id}`);
    expect(deleted.body).toEqual({ deleted: true, holdersAffected: 1 });
    expect((await owner.get("/workspace/policies")).body.policies).toEqual([]);
  });

  test("names are required, unique (ignoring case) and up to 60 characters; descriptions up to 240", async () => {
    const owner = await setUpNamedOwner(h);
    expect((await owner.post("/workspace/policies", { name: "" })).body.error.message).toBe(
      "Enter a name for the policy.",
    );
    expect((await owner.post("/workspace/policies", { name: "x".repeat(61) })).status).toBe(400);
    expect(
      (await owner.post("/workspace/policies", { name: "Ops", description: "d".repeat(241) }))
        .status,
    ).toBe(400);
    expect((await owner.post("/workspace/policies", { name: "Ops" })).status).toBe(201);
    const clash = await owner.post("/workspace/policies", { name: "ops" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.message).toBe('There is already a policy called "ops".');
    const unknownCapability = await owner.post("/workspace/policies", {
      name: "Bad",
      capabilities: ["servers.manage", "launch.rockets"],
    });
    expect(unknownCapability.status).toBe(400);
  });

  test("at most 100 policies per workspace", async () => {
    const owner = await setUpNamedOwner(h);
    const workspaceId = await workspaceIdOf(owner);
    await h.test.db
      .insertInto("access_policy")
      .values(Array.from({ length: 100 }, (_, i) => ({ workspace_id: workspaceId, name: `P${i}` })))
      .execute();
    const reply = await owner.post("/workspace/policies", { name: "One more" });
    expect(reply.status).toBe(409);
    expect(reply.body.error.message).toStartWith("A workspace can have up to 100 access policies.");
  });

  test("something deleted since the page loaded, or in another workspace, is refused", async () => {
    const owner = await setUpNamedOwner(h);
    const workspaceId = await workspaceIdOf(owner);
    seedObjects(workspaceId, "11111111-1111-1111-1111-111111111111");
    const gone = await owner.post("/workspace/policies", {
      name: "P",
      scope: { projectIds: ["proj-deleted"] },
    });
    expect(gone.status).toBe(409);
    expect(gone.body.error.message).toBe(
      "A project in the list isn't in this workspace any more. Reload the page and try again.",
    );
    const foreign = await owner.post("/workspace/policies", {
      name: "P",
      scope: { serverIds: ["srv-foreign"] },
    });
    expect(foreign.body.error.message).toStartWith("A server in the list isn't in this workspace");
  });

  test("ticking a child ticks its parents", async () => {
    const owner = await setUpNamedOwner(h);
    seedObjects(await workspaceIdOf(owner), "11111111-1111-1111-1111-111111111111");
    const reply = await owner.post("/workspace/policies", {
      name: "Dev API only",
      scope: { serviceIds: ["svc-web-dev-api"] },
    });
    expect(reply.body.policy.scope).toMatchObject({
      projectIds: ["proj-web"],
      environmentIds: ["env-web-dev"],
      serviceIds: ["svc-web-dev-api"],
    });
  });
});

describe("member access (spec 04 4.7)", () => {
  test("only for members, never for yourself", async () => {
    const owner = await setUpNamedOwner(h);
    const ada = await addMemberThroughInvitation(h, owner, "ada@example.com", { role: "admin" });
    const ownerId = await personIdOf(h, "owner@example.com");
    const adaId = await personIdOf(h, "ada@example.com");

    const self = await ada.put(`/workspace/members/${adaId}/access`, {});
    expect(self.status).toBe(403);
    expect(self.body.error.message).toBe(
      "You can't change your own access. Ask another owner or admin.",
    );
    const forAdmin = await owner.put(`/workspace/members/${adaId}/access`, {});
    expect(forAdmin.status).toBe(409);
    expect(forAdmin.body.error.message).toStartWith("Owners and admins already reach everything.");
    const forOwner = await ada.put(`/workspace/members/${ownerId}/access`, {});
    expect(forOwner.status).toBe(409);
  });

  test("effective access is the union of direct grants and policies, with where each comes from", async () => {
    const owner = await setUpNamedOwner(h);
    const workspaceId = await workspaceIdOf(owner);
    seedObjects(workspaceId, "11111111-1111-1111-1111-111111111111");
    const devs = await owner.post("/workspace/policies", {
      name: "Developers",
      capabilities: ["services.create"],
      scope: { projectIds: ["proj-web"] },
    });
    const ops = await owner.post("/workspace/policies", {
      name: "Ops",
      capabilities: ["services.create", "servers.manage"],
      scope: { allServers: true },
    });
    await addMemberThroughInvitation(h, owner, "mia@example.com");
    const miaId = await personIdOf(h, "mia@example.com");

    const saved = await owner.put(`/workspace/members/${miaId}/access`, {
      policyIds: [devs.body.policy.id, ops.body.policy.id],
      capabilities: ["projects.create"],
      scope: { projectIds: ["proj-shop"] },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.policies.map((p: { name: string }) => p.name)).toEqual(["Developers", "Ops"]);
    expect(saved.body.direct).toMatchObject({
      capabilities: ["projects.create"],
      scope: { projectIds: ["proj-shop"] },
    });
    expect(saved.body.effective.capabilities).toEqual([
      { key: "projects.create", from: ["direct"] },
      { key: "services.create", from: ["Developers", "Ops"] },
      { key: "servers.manage", from: ["Ops"] },
    ]);
    expect(saved.body.effective.allServers).toBe(true);

    const access = await accessFor("mia@example.com", workspaceId);
    const target = (kind: "project" | "server", id: string) => ({ kind, id });
    expect(access.can("project.see", target("project", "proj-web"))).toBe(true);
    expect(access.can("project.see", target("project", "proj-shop"))).toBe(true);
    expect(access.can("server.manage", target("server", "srv-2"))).toBe(true);
    expect(access.can("project.delete", target("project", "proj-web"))).toBe(false);
  });

  test("a policy granting one project and one server reaches only those, and removing it removes them at once", async () => {
    const owner = await setUpNamedOwner(h);
    const workspaceId = await workspaceIdOf(owner);
    seedObjects(workspaceId, "11111111-1111-1111-1111-111111111111");
    const narrow = await owner.post("/workspace/policies", {
      name: "Web only",
      scope: { projectIds: ["proj-web"], serverIds: ["srv-1"] },
    });
    await addMemberThroughInvitation(h, owner, "mia@example.com", {
      policyIds: [narrow.body.policy.id],
    });
    const miaId = await personIdOf(h, "mia@example.com");
    // Something given directly survives the policy's removal.
    await owner.put(`/workspace/members/${miaId}/access`, {
      policyIds: [narrow.body.policy.id],
      scope: { serverIds: ["srv-2"] },
    });

    let access = await accessFor("mia@example.com", workspaceId);
    expect(
      access.visible(h.fakes.objects.filter((o) => o.workspaceId === workspaceId)).map((o) => o.id),
    ).toEqual([
      "proj-web",
      "env-web-dev",
      "env-web-prod",
      "svc-web-dev-api",
      "svc-web-prod-api",
      "srv-1",
      "srv-2",
    ]);
    await expect(
      access.require("project.see", { kind: "project", id: "proj-shop" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      access.require("server.see", { kind: "server", id: "srv-1" }),
    ).resolves.toMatchObject({
      id: "srv-1",
    });
    // Another workspace's object is not found, as if it didn't exist.
    await expect(
      access.require("project.see", { kind: "project", id: "proj-foreign" }),
    ).rejects.toMatchObject({ code: "not_found" });

    await owner.delete(`/workspace/policies/${narrow.body.policy.id}`);
    access = await accessFor("mia@example.com", workspaceId);
    expect(
      access.visible(h.fakes.objects.filter((o) => o.workspaceId === workspaceId)).map((o) => o.id),
    ).toEqual(["srv-2"]);
  });

  test("an owner is refused an object in another workspace too", async () => {
    const owner = await setUpNamedOwner(h);
    const workspaceId = await workspaceIdOf(owner);
    seedObjects(workspaceId, "11111111-1111-1111-1111-111111111111");
    const grants = await loadGrants(h.test.db, {
      personId: await personIdOf(h, "owner@example.com"),
      workspaceId,
      role: "owner",
      isInstanceAdmin: true,
    });
    const access = new WorkspaceAccess(h.test.db, h.services.objects, grants);
    await expect(
      access.require("project.delete", { kind: "project", id: "proj-foreign" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      access.require("project.delete", { kind: "project", id: "proj-web" }),
    ).resolves.toBeDefined();
  });

  test("promoting a member to admin drops member-only grants", async () => {
    const owner = await setUpNamedOwner(h);
    const policy = await owner.post("/workspace/policies", { name: "P" });
    await addMemberThroughInvitation(h, owner, "mia@example.com", {
      policyIds: [policy.body.policy.id],
    });
    const miaId = await personIdOf(h, "mia@example.com");
    await owner.patch(`/workspace/members/${miaId}`, { role: "admin" });
    expect((await owner.get("/workspace/policies")).body.policies[0].holders).toEqual([]);
  });
});
