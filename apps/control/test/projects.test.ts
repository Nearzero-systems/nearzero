import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { setUpNamedOwner } from "./support/harness.ts";
import {
  createProjectsHarness,
  makeProject,
  makeService,
  type ProjectsHarness,
} from "./support/projects.ts";

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

describe("projects (spec 05 5.1)", () => {
  test("a new project starts with exactly one environment, development, its default", async () => {
    const owner = await setUpNamedOwner(p.h);
    const created = await owner.post("/projects", { name: "Web", description: "The site" });
    expect(created.status).toBe(201);
    expect(created.body.message).toBe("Project created");
    const project = created.body.project;
    expect(project).toMatchObject({ name: "Web", description: "The site", serviceCount: 0 });
    expect(project.environments).toEqual([
      { id: created.body.environmentId, name: "development", isDefault: true, isProduction: false },
    ]);
    expect(project.openEnvironmentId).toBe(created.body.environmentId);
    expect(project.can).toEqual({ update: true, delete: true, createEnvironment: true });
  });

  test("an empty name is refused in the dialog's words; names need not be unique", async () => {
    const owner = await setUpNamedOwner(p.h);
    const empty = await owner.post("/projects", { name: "  " });
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toBe("Project name is required");
    expect(empty.body.error.fields.name).toBe("Project name is required");
    expect((await owner.post("/projects", { name: "Same" })).status).toBe(201);
    expect((await owner.post("/projects", { name: "Same" })).status).toBe(201);
  });

  test("update changes the name and description", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId } = await makeProject(owner, "Old");
    const updated = await owner.patch(`/projects/${projectId}`, {
      name: "New",
      description: "Now with words",
    });
    expect(updated.status).toBe(200);
    expect(updated.body.message).toBe("Project updated");
    expect(updated.body.project).toMatchObject({ name: "New", description: "Now with words" });
  });

  test("the list searches name and description and sorts six ways on the server", async () => {
    const owner = await setUpNamedOwner(p.h);
    const alpha = await makeProject(owner, "alpha", [], "Billing tools");
    const beta = await makeProject(owner, "Beta", ["staging"], "The website");
    const gamma = await makeProject(owner, "gamma", [], "Internal");
    await makeService(owner, beta.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    await makeService(owner, gamma.environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    // Two environments: one service and its copy count as two.
    const names = async (query: string) =>
      ((await owner.get(`/projects${query}`)).body.projects as { name: string }[]).map(
        (project) => project.name,
      );
    expect(await names("")).toEqual(["gamma", "Beta", "alpha"]);
    expect(await names("?sort=oldest")).toEqual(["alpha", "Beta", "gamma"]);
    expect(await names("?sort=name-asc")).toEqual(["alpha", "Beta", "gamma"]);
    expect(await names("?sort=name-desc")).toEqual(["gamma", "Beta", "alpha"]);
    expect(await names("?sort=most-services")).toEqual(["Beta", "gamma", "alpha"]);
    expect(await names("?sort=least-services")).toEqual(["alpha", "gamma", "Beta"]);

    const search = await owner.get("/projects?search=WEB");
    expect(search.body.projects.map((project: { id: string }) => project.id)).toEqual([
      beta.projectId,
    ]);
    expect(search.body).toMatchObject({ total: 3, matching: 1, search: "WEB" });
    expect((await owner.get("/projects?search=billing")).body.projects[0].id).toBe(alpha.projectId);
    const counts = (await owner.get("/projects?sort=name-asc")).body.projects.map(
      (project: { serviceCount: number }) => project.serviceCount,
    );
    expect(counts).toEqual([0, 2, 1]);
    const bad = await owner.get("/projects?sort=random");
    expect(bad.status).toBe(400);
  });

  test("opening a project goes to development, else the default, else the first", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, environments } = await makeProject(owner, "Web", ["staging"]);
    await owner.patch(`/environments/${environments.development}`, { name: "main" });
    const project = (await owner.get(`/projects/${projectId}`)).body.project;
    expect(project.openEnvironmentId).toBe(environments.development);
    expect(project.environments.map((environment: { name: string }) => environment.name)).toEqual([
      "main",
      "staging",
    ]);
  });
});

describe("environments (spec 05 5.3)", () => {
  test('"QA Team" becomes "qa-team", "prod" is refused, a second "staging" is refused', async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId } = await makeProject(owner, "Web", ["staging"]);
    const qa = await owner.post(`/projects/${projectId}/environments`, { name: "QA Team" });
    expect(qa.status).toBe(201);
    expect(qa.body.environment.name).toBe("qa-team");
    expect(qa.body.message).toBe("Created qa-team");

    const prod = await owner.post(`/projects/${projectId}/environments`, { name: "prod" });
    expect(prod.status).toBe(400);
    expect(prod.body.error.fields.name).toStartWith('Name it "production" instead');
    expect((await owner.post(`/projects/${projectId}/environments`, { name: "PRD" })).status).toBe(
      400,
    );

    const again = await owner.post(`/projects/${projectId}/environments`, { name: "Staging" });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(
      'This project already has an environment called "staging".',
    );

    const long = await owner.post(`/projects/${projectId}/environments`, {
      name: "a".repeat(33),
    });
    expect(long.body.error.message).toBe("Use at most 32 characters.");
    const symbols = await owner.post(`/projects/${projectId}/environments`, { name: "qa.2" });
    expect(symbols.body.error.message).toBe(
      "Use letters, numbers and dashes, like staging or qa-2.",
    );
    const wordy = await owner.post(`/projects/${projectId}/environments`, {
      name: "docs",
      description: "x".repeat(1001),
    });
    expect(wordy.body.error.message).toBe("Use at most 1,000 characters.");
  });

  test("production is exactly the environment named production", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, environments } = await makeProject(owner, "Web", ["production", "staging"]);
    const list = (await owner.get(`/projects/${projectId}/environments`)).body.environments;
    expect(
      list.map((environment: { name: string; isProduction: boolean }) => [
        environment.name,
        environment.isProduction,
      ]),
    ).toEqual([
      ["development", false],
      ["production", true],
      ["staging", false],
    ]);
    const renamed = await owner.patch(`/environments/${environments.staging}`, {
      name: "Production",
    });
    expect(renamed.status).toBe(409);
  });

  test("rename uses the same rules; the default can be renamed but not deleted", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web", ["staging"]);
    const renamed = await owner.patch(`/environments/${environments.development}`, {
      name: "Dev Box",
      description: "Mine",
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.environment).toMatchObject({
      name: "dev-box",
      description: "Mine",
      isDefault: true,
    });
    expect(
      (await owner.patch(`/environments/${environments.staging}`, { name: "prod" })).status,
    ).toBe(400);
    const deleteDefault = await owner.delete(`/environments/${environments.development}`);
    expect(deleteDefault.status).toBe(409);
    expect(deleteDefault.body.error.message).toContain("default environment");
  });

  test("delete is allowed only when the environment is empty", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web", ["staging"]);
    await makeService(owner, environments.development as string, { kind: "redis", name: "cache" });
    const busy = await owner.delete(`/environments/${environments.staging}`);
    expect(busy.status).toBe(409);
    expect(busy.body.error.message).toBe("Delete or move its 1 service first.");

    const empty = await owner.post(
      `/projects/${(await owner.get(`/environments/${environments.staging}`)).body.environment.projectId}/environments`,
      {
        name: "scratch",
      },
    );
    // A new environment gets every service copied in, so it isn't empty either.
    expect(empty.body.copiedServices).toBe(1);
    const services = (await owner.get(`/environments/${empty.body.environment.id}/services`)).body
      .services;
    const run = await owner.post(`/services/${services[0].id}/delete`, { confirm: "cache" });
    expect(run.status).toBe(202);
    await p.runJobs();
    expect((await owner.delete(`/environments/${empty.body.environment.id}`)).body).toEqual({
      deleted: true,
    });
    expect((await owner.get(`/environments/${empty.body.environment.id}`)).status).toBe(404);
  });

  test("creating an environment copies every service in, idle, with variable names and no values", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, environments } = await makeProject(owner, "Shop");
    const development = environments.development as string;
    await makeService(owner, development, {
      kind: "application",
      name: "api",
      variables: [
        { name: "API_KEY", value: "s3cret" },
        { name: "MODE", value: "dev" },
      ],
    });
    await makeService(owner, development, { kind: "postgres", name: "db" });
    await makeService(owner, development, { kind: "redis", name: "cache" });
    await owner.put(`/environments/${development}/variables`, {
      text: "# shared\nREGION=eu\nTOKEN=abc\n",
    });

    const staging = await owner.post(`/projects/${projectId}/environments`, {
      name: "staging",
      variables: { from: development },
    });
    expect(staging.status).toBe(201);
    expect(staging.body.copiedServices).toBe(3);
    const stagingId = staging.body.environment.id;
    const services = (await owner.get(`/environments/${stagingId}/services`)).body.services;
    expect(
      services.map((service: { name: string; status: string }) => [service.name, service.status]),
    ).toEqual([
      ["api", "idle"],
      ["cache", "idle"],
      ["db", "idle"],
    ]);
    const api = services.find((service: { name: string }) => service.name === "api");
    const own = await owner.post(`/services/${api.id}/variables/reveal`);
    expect(own.body.text).toBe("API_KEY=\nMODE=\n");
    const shared = await owner.post(`/environments/${stagingId}/variables/reveal`);
    expect(shared.body.text).toBe("# shared\nREGION=\nTOKEN=\n");

    // With "Also copy the values", secrets included.
    const qa = await owner.post(`/projects/${projectId}/environments`, {
      name: "qa",
      variables: { from: development, values: true },
    });
    const qaApi = (
      await owner.get(`/environments/${qa.body.environment.id}/services`)
    ).body.services.find((service: { name: string }) => service.name === "api");
    expect((await owner.post(`/services/${qaApi.id}/variables/reveal`)).body.text).toBe(
      "API_KEY=s3cret\nMODE=dev\n",
    );
    expect(
      (await owner.post(`/environments/${qa.body.environment.id}/variables/reveal`)).body.text,
    ).toBe("# shared\nREGION=eu\nTOKEN=abc\n");

    // "Start empty": no shared variables, but the services' copies still get the names.
    const empty = await owner.post(`/projects/${projectId}/environments`, { name: "demo" });
    const emptyShared = await owner.get(`/environments/${empty.body.environment.id}/variables`);
    expect(emptyShared.body.shared.count).toBe(0);
    const demoApi = (
      await owner.get(`/environments/${empty.body.environment.id}/services`)
    ).body.services.find((service: { name: string }) => service.name === "api");
    expect((await owner.post(`/services/${demoApi.id}/variables/reveal`)).body.text).toBe(
      "API_KEY=\nMODE=\n",
    );
  });
});

describe("workspace deletion (spec 23.1)", () => {
  test("a workspace that still has projects can't be deleted", async () => {
    const owner = await setUpNamedOwner(p.h);
    const team = await owner.post("/workspaces", { name: "Team Two" });
    await owner.post(`/workspaces/${team.body.workspace.id}/switch`);
    const { projectId } = await makeProject(owner, "Web");
    await makeProject(owner, "Docs");
    const refused = await owner.delete("/workspace");
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      "Delete this workspace's 2 projects first, then try again.",
    );

    for (const project of (await owner.get("/projects")).body.projects) {
      const plan = (await owner.get(`/projects/${project.id}/delete-plan`)).body.plan;
      const started = await owner.post(`/projects/${project.id}/delete`, {
        fingerprint: plan.fingerprint,
        confirm: project.name,
      });
      expect(started.status).toBe(202);
    }
    await p.runJobs();
    expect((await owner.get(`/projects/${projectId}`)).status).toBe(404);
    expect((await owner.delete("/workspace")).status).toBe(200);
  });
});
