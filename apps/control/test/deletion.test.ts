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
import { carryOutRun } from "../src/deletion/job.ts";
import { DEPLOYED_TEARDOWN_UNAVAILABLE, recordsOnlyTeardown } from "../src/deletion/teardown.ts";
import { silentLogger } from "../src/log.ts";
import { type Browser, setUpNamedOwner } from "./support/harness.ts";
import {
  createProjectsHarness,
  makeProject,
  makeService,
  type ProjectsHarness,
  workspaceIdOf,
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

async function setStatus(serviceId: string, status: "deploying" | "running" | "stopped") {
  await p.h.test.db.updateTable("service").set({ status }).where("id", "=", serviceId).execute();
}

/** A project with services on two servers: the host and one remote server. */
async function twoServerProject(owner: Browser) {
  const workspaceId = await workspaceIdOf(owner);
  const serverId = p.servers.add(workspaceId, "33333333-3333-4333-8333-333333333333");
  const fixture = await makeProject(owner, "Shop", ["production"]);
  const development = fixture.environments.development as string;
  const db = await makeService(owner, development, { kind: "postgres", name: "db" });
  const web = await makeService(owner, development, { kind: "application", name: "web", serverId });
  await owner.put(`/services/${web.service.id}/variables`, { text: "SECRET=1\n" });
  return { ...fixture, serverId, db, web };
}

describe("deleting a project (spec 05 5.1)", () => {
  test("the plan lists every service in every environment with its server, marked production", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, serverId } = await twoServerProject(owner);
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    expect(
      plan.services.map(
        (item: {
          name: string;
          environment: { name: string };
          serverId: string;
          production: boolean;
        }) => [item.name, item.environment.name, item.serverId, item.production],
      ),
    ).toEqual([
      ["db", "development", "host", false],
      ["web", "development", serverId, false],
      ["db", "production", "host", true],
      ["web", "production", serverId, true],
    ]);
    expect(plan.summary).toBe(
      "Delete Shop and remove its 4 services from their servers? Their containers, volumes, files, logs, images, domains and DNS records are wiped from the servers. This cannot be undone.",
    );
    expect(plan.warnings).toEqual(["2 services run in production."]);
    expect(plan.confirmLabel).toBe("Delete project and 4 services");
    expect(plan.canDelete).toBe(true);
    expect(plan.confirmText).toBe("Shop");
  });

  test("an empty project says it has no services", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId } = await makeProject(owner, "Empty");
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    expect(plan.summary).toBe("Delete Empty? It has no services.");
    expect(plan.confirmLabel).toBe("Delete project");
  });

  test("a project with services on two servers deletes completely, in the background", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, serverId } = await twoServerProject(owner);
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    const started = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "Shop",
    });
    expect(started.status).toBe(202);
    expect(started.body.run).toMatchObject({
      scope: "project",
      state: "running",
      tracked: true,
      message: "You can close this; the delete keeps going.",
    });
    expect(started.body.run.items.map((item: { state: string }) => item.state)).toEqual([
      "waiting",
      "waiting",
      "waiting",
      "waiting",
    ]);
    // Reopening the dialog shows it is already being deleted; a second delete is refused.
    const reopened = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    expect(reopened.inProgress.message).toBe("Shop is already being deleted.");
    const again = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: reopened.fingerprint,
      confirm: "Shop",
    });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe("Shop is already being deleted.");
    // Nothing can be added while it goes.
    const environmentId = (await owner.get(`/projects/${projectId}`)).body.project.environments[0]
      .id;
    const add = await owner.post(`/environments/${environmentId}/services`, {
      kind: "redis",
      name: "late",
      serverId: "host",
    });
    expect(add.status).toBe(409);

    expect(await p.runJobs()).toBe(1);
    const servers = p.teardown.calls.map((call) => call.target.serverId);
    expect(servers.filter((id) => id === null)).toHaveLength(2);
    expect(servers.filter((id) => id === serverId)).toHaveLength(2);
    for (const call of p.teardown.calls) expect(call.options.removeVolumes).toBe(true);

    const run = (await owner.get(`/delete-runs/${started.body.run.id}`)).body.run;
    expect(run).toMatchObject({ state: "succeeded", message: "Shop was deleted." });
    expect(run.project.kept).toBe(false);
    expect(run.counts).toEqual({ waiting: 0, removing: 0, removed: 4, notRemoved: 0 });
    expect((await owner.get(`/projects/${projectId}`)).status).toBe(404);
    for (const table of ["service", "environment", "project", "variable_set"] as const) {
      const rows = await p.h.test.db.selectFrom(table).select("id").execute();
      expect(rows).toEqual([]);
    }
    const audit = await p.h.test.db
      .selectFrom("audit_event")
      .select("action")
      .where("action", "in", ["project.delete-started", "project.deleted"])
      .orderBy("id")
      .execute();
    expect(audit.map((row) => row.action)).toEqual(["project.delete-started", "project.deleted"]);
  });

  test("the typed name must match, and a project that changed after the plan is refused", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, environments } = await twoServerProject(owner);
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    const typo = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "shop",
    });
    expect(typo.status).toBe(400);
    expect(typo.body.error.message).toBe("Type the project name, Shop, to confirm.");
    await makeService(owner, environments.development as string, { kind: "redis", name: "cache" });
    const stale = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "Shop",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toContain("changed after the plan was shown");
    expect(p.teardown.calls).toEqual([]);
  });

  test("if any service fails, the project is kept with the reason, and the delete can be retried", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId } = await twoServerProject(owner);
    p.teardown.throws.add("web");
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    const started = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "Shop",
    });
    await p.runJobs();
    const run = (await owner.get(`/projects/${projectId}/delete-run`)).body.run;
    expect(run.id).toBe(started.body.run.id);
    expect(run.state).toBe("failed");
    expect(run.project.kept).toBe(true);
    expect(run.message).toStartWith("The project was kept.");
    const failed = run.items.filter((item: { state: string }) => item.state === "not_removed");
    expect(failed.map((item: { name: string }) => item.name)).toEqual(["web", "web"]);
    expect(failed[0].reason).toContain("ECONNREFUSED");
    // The databases went; the apps are still there, no longer marked as being deleted.
    const left = (await owner.get(`/projects/${projectId}`)).body.project;
    expect(left.serviceCount).toBe(2);

    p.teardown.throws.clear();
    const retryPlan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    expect(retryPlan.services).toHaveLength(2);
    expect(retryPlan.canDelete).toBe(true);
    const retry = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: retryPlan.fingerprint,
      confirm: "Shop",
    });
    expect(retry.status).toBe(202);
    await p.runJobs();
    expect((await owner.get(`/delete-runs/${retry.body.run.id}`)).body.run.state).toBe("succeeded");
    expect((await owner.get(`/projects/${projectId}`)).status).toBe(404);
  });

  test("deploying services refuse the delete; running ones are stopped as part of it", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, db, web } = await twoServerProject(owner);
    await setStatus(db.service.id, "deploying");
    await setStatus(web.service.id, "running");
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    expect(plan.canDelete).toBe(false);
    expect(plan.blockers).toEqual([
      "db is deploying. Wait for the deployment to finish before deleting this service.",
    ]);
    expect(plan.warnings).toContain("1 service is running and will be stopped first.");
    const refused = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "Shop",
    });
    expect(refused.status).toBe(403);

    await setStatus(db.service.id, "stopped");
    const next = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: next.fingerprint,
      confirm: "Shop",
    });
    await p.runJobs();
    const webCall = p.teardown.calls.find((call) => call.target.serviceId === web.service.id);
    expect(webCall?.options.stopFirst).toBe(true);
    const dbCall = p.teardown.calls.find((call) => call.target.serviceId === db.service.id);
    expect(dbCall?.options.stopFirst).toBe(false);
  });

  test("a delete the platform stopped tracking can be started again", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId } = await twoServerProject(owner);
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    const started = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "Shop",
    });
    // The job gave up (the platform kept restarting).
    await sql`update job set state = 'failed', finished_at = now()`.execute(p.h.test.db);
    const run = (await owner.get(`/delete-runs/${started.body.run.id}`)).body.run;
    expect(run.tracked).toBe(false);
    expect(run.message).toContain("no longer tracked");
    const again = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    expect(again.inProgress).toBeNull();
    const restarted = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: again.fingerprint,
      confirm: "Shop",
    });
    expect(restarted.status).toBe(202);
    expect((await owner.get(`/delete-runs/${started.body.run.id}`)).body.run.state).toBe("failed");
    await p.runJobs();
    expect((await owner.get(`/projects/${projectId}`)).status).toBe(404);
  });

  test("the records-only teardown never reports a deployed service as removed", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, web } = await twoServerProject(owner);
    await setStatus(web.service.id, "stopped");
    const plan = (await owner.get(`/projects/${projectId}/delete-plan`)).body.plan;
    const started = await owner.post(`/projects/${projectId}/delete`, {
      fingerprint: plan.fingerprint,
      confirm: "Shop",
    });
    await carryOutRun(
      p.h.test.db,
      silentLogger,
      recordsOnlyTeardown,
      started.body.run.id,
      new AbortController().signal,
    );
    const run = (await owner.get(`/delete-runs/${started.body.run.id}`)).body.run;
    expect(run.state).toBe("failed");
    const stuck = run.items.find(
      (item: { serviceId: string }) => item.serviceId === web.service.id,
    );
    expect(stuck.reason).toBe(DEPLOYED_TEARDOWN_UNAVAILABLE);
    expect((await owner.get(`/services/${web.service.id}`)).status).toBe(200);
  });
});

describe("deleting services (spec 05 5.2)", () => {
  test("one service, with the copies the person ticks", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web", ["staging", "production"]);
    const created = await makeService(owner, environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    const plan = (await owner.get(`/services/${created.service.id}/delete-plan`)).body.plan;
    expect(plan.copies.map((copy: { label: string }) => copy.label)).toEqual([
      "staging (cache)",
      "production (cache)",
    ]);
    expect(plan.copiesHint).toBe("Only this environment's copy is deleted unless you tick others.");
    const staging = plan.copies[0].id;

    const wrong = await owner.post(`/services/${created.service.id}/delete`, { confirm: "Cache" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.message).toBe("Type the service name, cache, to confirm.");
    const started = await owner.post(`/services/${created.service.id}/delete`, {
      confirm: "cache",
      alsoDeleteCopyIds: [staging],
    });
    expect(started.status).toBe(202);
    await p.runJobs();
    const run = (await owner.get(`/delete-runs/${started.body.run.id}`)).body.run;
    expect(run).toMatchObject({ state: "succeeded", message: "2 services removed" });
    const production = (await owner.get(`/environments/${environments.production}/services`)).body
      .services;
    expect(production.map((service: { name: string }) => service.name)).toEqual(["cache"]);
    expect((await owner.get(`/services/${staging}`)).status).toBe(404);
  });

  test("a removal that fails says the service was removed, but not everywhere", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web", ["staging"]);
    const created = await makeService(owner, environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    // The copy was deployed once, so the records-only teardown can't remove it.
    const copy = created.alsoAddedTo[0].serviceId;
    await setStatus(copy, "stopped");
    const started = await owner.post(`/services/${created.service.id}/delete`, {
      confirm: "cache",
      alsoDeleteCopyIds: [copy],
    });
    const run = started.body.run;
    await carryOutRun(
      p.h.test.db,
      silentLogger,
      recordsOnlyTeardown,
      run.id,
      new AbortController().signal,
    );
    const finished = (await owner.get(`/delete-runs/${run.id}`)).body.run;
    expect(finished.message).toBe("Service removed, but not everywhere");
    expect(finished.items.map((item: { state: string }) => item.state)).toEqual([
      "removed",
      "not_removed",
    ]);
  });

  test("what a removal left for the person to do is kept on the removed service's row", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Hooks");
    const created = await makeService(owner, environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    const started = await owner.post(`/services/${created.service.id}/delete`, {
      confirm: "cache",
    });
    const note =
      "The webhook Nearzero added to team/web on Gitea couldn't be removed (Gitea didn't answer). Delete it in the repository's webhook settings on Gitea.";
    await carryOutRun(
      p.h.test.db,
      silentLogger,
      { remove: async () => ({ removed: true, notes: [note] }) },
      started.body.run.id,
      new AbortController().signal,
    );
    const run = (await owner.get(`/delete-runs/${started.body.run.id}`)).body.run;
    expect(run.state).toBe("succeeded");
    expect(run.items).toMatchObject([{ state: "removed", reason: note }]);
    expect((await owner.get(`/services/${created.service.id}`)).status).toBe(404);
  });

  test("deleting is refused while a service is deploying, for single and bulk deletes", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web");
    const development = environments.development as string;
    const a = await makeService(owner, development, { kind: "redis", name: "a" });
    const b = await makeService(owner, development, { kind: "redis", name: "b" });
    await setStatus(a.service.id, "deploying");
    const single = await owner.post(`/services/${a.service.id}/delete`, { confirm: "a" });
    expect(single.status).toBe(409);
    expect(single.body.error.message).toBe(
      "Wait for the deployment to finish before deleting this service.",
    );
    const plan = (
      await owner.post(`/environments/${development}/services/delete-plan`, {
        serviceIds: [a.service.id, b.service.id],
      })
    ).body.plan;
    expect(plan.canDelete).toBe(false);
    const bulk = await owner.post(`/environments/${development}/services/delete`, {
      serviceIds: [a.service.id, b.service.id],
      fingerprint: plan.fingerprint,
      confirm: "Web",
    });
    expect(bulk.status).toBe(409);
    expect(bulk.body.error.message).toBe(
      "a is deploying. Wait for the deployment to finish before deleting this service.",
    );
  });

  test("bulk delete: the plan, the project name to confirm, and the result", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web", ["staging"]);
    const development = environments.development as string;
    const a = await makeService(owner, development, { kind: "redis", name: "a" });
    const b = await makeService(owner, development, { kind: "postgres", name: "b" });
    await setStatus(b.service.id, "running");
    const planned = await owner.post(`/environments/${development}/services/delete-plan`, {
      serviceIds: [a.service.id, b.service.id],
    });
    const plan = planned.body.plan;
    expect(plan).toMatchObject({
      scope: "services",
      confirmLabel: "Delete 2 services",
      confirmText: "Web",
    });
    expect(plan.summary).toStartWith("Remove 2 services of Web from their servers?");
    const elsewhere = await owner.post(
      `/environments/${environments.staging}/services/delete-plan`,
      {
        serviceIds: [a.service.id],
      },
    );
    expect(elsewhere.status).toBe(404);
    const started = await owner.post(`/environments/${development}/services/delete`, {
      serviceIds: [a.service.id, b.service.id],
      fingerprint: plan.fingerprint,
      confirm: "Web",
    });
    expect(started.status).toBe(202);
    await p.runJobs();
    expect((await owner.get(`/environments/${development}/services`)).body.services).toEqual([]);
    expect(
      (await owner.get(`/environments/${environments.staging}/services`)).body.services,
    ).toHaveLength(2);
    const stopped = p.teardown.calls.find((call) => call.target.serviceId === b.service.id);
    expect(stopped?.options.stopFirst).toBe(true);
  });
});
