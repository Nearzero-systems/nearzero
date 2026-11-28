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
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import { readVariables, writeVariables } from "../src/variables/store.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember, makeProject, makeService } from "./support/projects.ts";

/**
 * Shared variables (spec 05 5.5, 22.3; the C1-20 decision in spec 31, replacing B1-33's): anyone
 * who can see an environment sees the names of its shared variables; anyone who can deploy or
 * edit the variables of a service in it sees their values too, since every service receives
 * them; editing needs access to the whole environment. And two first saves of the
 * same set at once (B1-34) end in one save and a "changed by someone else" conflict.
 */

setDefaultTimeout(60_000);

let h: Harness;
let owner: Browser;

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  h = await createHarness({ instanceEmail: INSTANCE_RESEND, extra: { objects } });
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  await sql`truncate job, deployment, project cascade`.execute(h.test.db);
  owner = await setUpNamedOwner(h);
});

describe("who sees and edits shared variables (C1-20)", () => {
  test("a member given one service sees the values but can't edit; access to the whole environment edits", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const environment = environments.development as string;
    const web = await makeService(owner, environment, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine" },
    });
    await makeService(owner, environment, {
      kind: "application",
      name: "billing",
      settings: { image: "nginx:alpine" },
    });
    const saved = await owner.put(`/environments/${environment}/variables`, {
      text: "STRIPE_KEY=sk_live_shared_secret\n",
    });
    expect(saved.status).toBe(200);

    // The report's case: ticking one service also ticks its environment.
    const one = await addMember(h, owner, "mia@example.com", {
      scope: { serviceIds: [web.service.id] },
    });
    const page = await one.get(`/environments/${environment}/variables`);
    expect(page.status).toBe(200);
    expect(page.body.shared.variables.map((item: { name: string }) => item.name)).toEqual([
      "STRIPE_KEY",
    ]);
    // Masked until asked for.
    expect(JSON.stringify(page.body)).not.toContain("sk_live_shared_secret");
    expect(page.body.can).toEqual({ edit: false, reveal: true });
    expect(page.body.message).toBe(
      "Editing them needs access to the whole environment, since they reach every service in it. Ask an owner or admin.",
    );
    // web receives them on every deploy, so its deployer may read them (C1-20).
    const reveal = await one.post(`/environments/${environment}/variables/reveal`, {});
    expect(reveal.status).toBe(200);
    expect(reveal.body.text).toContain("sk_live_shared_secret");
    const edit = await one.put(`/environments/${environment}/variables`, {
      text: "STRIPE_KEY=sk_live_attacker\n",
    });
    expect(edit.status).toBe(403);
    expect(edit.body.error.message).toContain("your access covers only some of them");
    // The service's own tab lists the shared names without Edit shared.
    const tab = await one.get(`/services/${web.service.id}/variables`);
    expect(tab.body.shared.variables.map((item: { name: string }) => item.name)).toEqual([
      "STRIPE_KEY",
    ]);
    expect(tab.body.can.editShared).toBe(false);

    // Access to the whole environment: values and editing.
    const whole = await addMember(h, owner, "max@example.com", {
      scope: { environmentIds: [environment] },
    });
    const revealed = await whole.post(`/environments/${environment}/variables/reveal`, {});
    expect(revealed.status).toBe(200);
    expect(revealed.body.text).toContain("sk_live_shared_secret");
    expect((await whole.get(`/environments/${environment}/variables`)).body.can.edit).toBe(true);

    // Someone who can't see the environment at all gets "not found".
    const none = await addMember(h, owner, "zoe@example.com", { scope: { serviceIds: [] } });
    expect((await none.get(`/environments/${environment}/variables`)).status).toBe(404);
  });
});

describe("two first saves of one set at once (B1-34)", () => {
  test("one saves, the other is told someone else changed it", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const environment = environments.development as string;
    const row = await h.test.db
      .selectFrom("environment")
      .select(["id", "workspace_id"])
      .where("id", "=", environment)
      .executeTakeFirstOrThrow();
    const ownerRef = { kind: "environment" as const, id: row.id, workspaceId: row.workspace_id };
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, index) =>
        writeVariables(h.test.db, h.services.secrets, ownerRef, `A=${index}\n`, {
          by: null,
          baseVersion: 0,
        }),
      ),
    );
    const ok = results.filter((result) => result.status === "fulfilled");
    const failed = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(ok.length).toBe(1);
    expect(failed.length).toBe(5);
    for (const failure of failed) {
      expect(failure.reason.code).toBe("conflict");
    }
    const stored = await readVariables(h.test.db, h.services.secrets, ownerRef);
    expect(stored.version).toBe(1);
  });
});
