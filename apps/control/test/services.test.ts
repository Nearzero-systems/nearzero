import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { SERVICE_KINDS } from "@nearzero/shared";
import { sql } from "kysely";
import { setUpNamedOwner } from "./support/harness.ts";
import {
  addMember,
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

const SUFFIXED = /^[a-z][a-z0-9-]*-[a-z0-9]{6}$/;

describe("creating services and their copies (spec 05 5.4)", () => {
  test("a Postgres in development adds idle copies in staging and production with their own passwords and ports", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Shop", ["staging", "production"]);
    const created = await makeService(owner, environments.development as string, {
      kind: "postgres",
      name: "db",
    });
    expect(created.message).toBe(
      "Also added to staging and production, not deployed yet. Each environment has its own variables and URL.",
    );
    expect(
      created.alsoAddedTo.map((copy: { environmentName: string }) => copy.environmentName),
    ).toEqual(["staging", "production"]);
    const ids = [
      created.service.id,
      ...created.alsoAddedTo.map((copy: { serviceId: string }) => copy.serviceId),
    ];
    const details = await Promise.all(
      ids.map(async (id) => (await owner.get(`/services/${id}`)).body.service),
    );
    for (const service of details) {
      expect(service).toMatchObject({
        kind: "postgres",
        name: "db",
        status: "idle",
        serverId: "host",
      });
      expect(service.appName).toMatch(SUFFIXED);
      expect(service.appName).toStartWith("shop-db-");
      expect(service.settings).toMatchObject({
        image: "postgres:18",
        databaseName: "postgres",
        user: "postgres",
        port: 5432,
        dataVolume: `${service.appName}-data`,
      });
      expect(service.copyGroupId).toBe(created.service.copyGroupId);
    }
    expect(new Set(details.map((service) => service.appName)).size).toBe(3);
    const ports = details.map((service) => service.publicPort);
    expect(new Set(ports).size).toBe(3);
    for (const port of ports) expect(port).toBeGreaterThanOrEqual(20000);
    const passwords = await Promise.all(
      ids.map(
        async (id) =>
          (await owner.post(`/services/${id}/credentials/reveal`)).body.credentials.password,
      ),
    );
    expect(new Set(passwords).size).toBe(3);
    for (const password of passwords) expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
    // Each lists the others as copies.
    expect(
      details[0].copies.map((copy: { environmentName: string }) => copy.environmentName),
    ).toEqual(["staging", "production"]);
  });

  test("defaults per database, typed passwords and root passwords", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Data");
    const env = environments.development as string;
    const expectations: Record<string, Record<string, unknown>> = {
      mysql: { image: "mysql:8", databaseName: "app", user: "mysql" },
      mariadb: { image: "mariadb:11", databaseName: "mariadb", user: "mariadb" },
      mongodb: { image: "mongo:8", user: "mongo", replicaSet: false },
      redis: { image: "redis:8" },
      libsql: { user: "libsql", nodeRole: "primary", namespaces: false },
    };
    for (const [kind, settings] of Object.entries(expectations)) {
      const created = await makeService(owner, env, { kind, name: kind });
      expect(created.service.settings).toMatchObject(settings);
      const credentials = (await owner.post(`/services/${created.service.id}/credentials/reveal`))
        .body.credentials;
      expect(credentials.password).toMatch(/^[A-Za-z0-9]{24}$/);
      if (kind === "mysql" || kind === "mariadb") {
        expect(credentials.rootPassword).toMatch(/^[A-Za-z0-9]{24}$/);
      } else {
        expect(credentials.rootPassword).toBeNull();
      }
    }
    const typed = await makeService(owner, env, {
      kind: "postgres",
      name: "typed",
      settings: { password: "Typed_pass-123", databaseName: "app", user: "web" },
    });
    expect(typed.service.settings).toMatchObject({ databaseName: "app", user: "web" });
    expect(
      (await owner.post(`/services/${typed.service.id}/credentials/reveal`)).body.credentials,
    ).toEqual({
      user: "web",
      password: "Typed_pass-123",
      rootPassword: null,
      databaseName: "app",
    });
    const bad = await owner.post(`/environments/${env}/services`, {
      kind: "postgres",
      name: "bad",
      serverId: "host",
      settings: { password: "has space in it" },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields["settings.password"]).toContain("Leave out $ ! '");
    const app = await makeService(owner, env, { kind: "application", name: "web" });
    expect((await owner.post(`/services/${app.service.id}/credentials/reveal`)).status).toBe(409);
  });

  test("secrets never appear in any service answer, for every kind", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Kinds", ["staging"]);
    const env = environments.development as string;
    const secrets: string[] = [];
    for (const kind of SERVICE_KINDS) {
      const created = await makeService(owner, env, { kind, name: `k-${kind}` });
      const raw = await p.h.test.db
        .selectFrom("service")
        .select(["secrets_sealed"])
        .where("id", "=", created.service.id)
        .executeTakeFirstOrThrow();
      if (raw.secrets_sealed) {
        const credentials = (await owner.post(`/services/${created.service.id}/credentials/reveal`))
          .body.credentials;
        secrets.push(
          credentials.password,
          ...(credentials.rootPassword ? [credentials.rootPassword] : []),
        );
        expect(raw.secrets_sealed).not.toContain(credentials.password);
      }
      const bodies = [
        JSON.stringify(created),
        JSON.stringify((await owner.get(`/services/${created.service.id}`)).body),
        JSON.stringify((await owner.get(`/environments/${env}/services`)).body),
        JSON.stringify((await owner.get(`/services/${created.service.id}/delete-plan`)).body),
      ];
      for (const body of bodies) {
        expect(body).not.toContain("secrets_sealed");
        for (const secret of secrets) expect(body).not.toContain(secret);
      }
    }
    expect(secrets.length).toBe(8); // six passwords and two root passwords
  });

  test("app names follow the rules, get a suffix, and are refused before anything is created", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web", ["staging"]);
    const env = environments.development as string;
    const bad = await owner.post(`/environments/${env}/services`, {
      kind: "application",
      name: "api",
      serverId: "host",
      appName: "Bad_Name",
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.appName).toBe(
      "Use lowercase letters, numbers and single dashes, starting with a letter and ending with a letter or number.",
    );
    expect((await owner.get(`/environments/${env}/services`)).body.services).toEqual([]);
    const good = await makeService(owner, env, {
      kind: "application",
      name: "api",
      appName: "my-api",
    });
    expect(good.service.appName).toMatch(/^my-api-[a-z0-9]{6}$/);
    const copy = (await owner.get(`/services/${good.alsoAddedTo[0].serviceId}`)).body.service;
    expect(copy.appName).toMatch(/^my-api-[a-z0-9]{6}$/);
    expect(copy.appName).not.toBe(good.service.appName);
  });

  test("a name used in the environment is refused; one used in another environment skips that copy", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web", ["staging"]);
    await makeService(owner, environments.development as string, { kind: "redis", name: "cache" });
    const again = await owner.post(`/environments/${environments.development}/services`, {
      kind: "redis",
      name: "Cache",
      serverId: "host",
    });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(
      'This environment already has a service called "Cache". Pick another name.',
    );
    // Only staging's copy goes, so staging alone has a "cache" afterwards.
    const stagingCache = (await owner.get(`/environments/${environments.staging}/services`)).body
      .services[0];
    await owner.post(`/services/${stagingCache.id}/delete`, { confirm: "cache" });
    await p.runJobs();
    const devOnly = await makeService(owner, environments.staging as string, {
      kind: "postgres",
      name: "cache-db",
    });
    expect(devOnly.alsoAddedTo).toHaveLength(1);
    // development still has "cache"; adding "cache" to staging can't copy it there.
    const clash = await makeService(owner, environments.staging as string, {
      kind: "redis",
      name: "cache",
    });
    expect(clash.alsoAddedTo).toEqual([]);
    expect(clash.notAddedTo).toEqual([
      {
        environmentId: environments.development,
        environmentName: "development",
        reason: 'It already has a service called "cache".',
      },
    ]);
    expect(clash.message).toBeNull();
  });

  test("the Nearzero host is for instance administrators; other servers must be the workspace's", async () => {
    const owner = await setUpNamedOwner(p.h);
    const workspaceId = await workspaceIdOf(owner);
    const { projectId, environments } = await makeProject(owner, "Web");
    const env = environments.development as string;
    const unknown = await owner.post(`/environments/${env}/services`, {
      kind: "redis",
      name: "cache",
      serverId: "srv-unknown",
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe(
      "This server doesn't exist in this workspace, or you don't have access to it.",
    );
    const serverId = p.servers.add(workspaceId, "22222222-2222-4222-8222-222222222222");
    const onServer = await makeService(owner, env, { kind: "redis", name: "cache", serverId });
    expect(onServer.service).toMatchObject({ serverId, onHost: false });

    const member = await addMember(p.h, owner, "mia@example.com", {
      capabilities: ["services.create"],
      scope: { projectIds: [projectId], serverIds: [serverId] },
    });
    const onHost = await member.post(`/environments/${env}/services`, {
      kind: "redis",
      name: "cache-2",
      serverId: "host",
    });
    expect(onHost.status).toBe(403);
    expect(onHost.body.error.message).toBe(
      "Only Nearzero administrators can use the Nearzero host.",
    );
    expect(
      (await makeService(member, env, { kind: "redis", name: "cache-2", serverId })).service
        .serverId,
    ).toBe(serverId);
  });

  test("public ports are unique per server; with none free the database is created private with a note", async () => {
    const owner = await setUpNamedOwner(p.h);
    const workspaceId = await workspaceIdOf(owner);
    const { environments } = await makeProject(owner, "Ports");
    const env = environments.development as string;
    const first = await makeService(owner, env, { kind: "redis", name: "a" });
    const second = await makeService(owner, env, { kind: "redis", name: "b" });
    expect(first.service.publicPort).toBe(20000);
    expect(second.service.publicPort).toBe(20001);
    const serverId = p.servers.add(workspaceId, "11111111-1111-4111-8111-111111111111");
    const elsewhere = await makeService(owner, env, { kind: "redis", name: "c", serverId });
    expect(elsewhere.service.publicPort).toBe(20000);

    // Fill the rest of the host's range.
    const template = await p.h.test.db
      .selectFrom("service")
      .select(["workspace_id", "project_id", "environment_id"])
      .where("id", "=", first.service.id)
      .executeTakeFirstOrThrow();
    await sql`
      insert into service (workspace_id, project_id, environment_id, kind, name, app_name_base, app_name, public_port)
      select ${template.workspace_id}::uuid, ${template.project_id}::uuid, ${template.environment_id}::uuid,
             'redis', 'filler-' || port, 'filler', 'filler-' || port, port
      from generate_series(20002, 29999) as port
    `.execute(p.h.test.db);
    const full = await makeService(owner, env, { kind: "redis", name: "d" });
    expect(full.service.publicPort).toBeNull();
    expect(full.service.publicPortNote).toBe(
      "No free port between 20000 and 29999 on this server, so it was created private. Free a port, then make it public.",
    );
    expect(full.notes).toEqual([full.service.publicPortNote]);
    const app = await makeService(owner, env, { kind: "application", name: "web" });
    expect(app.service.publicPort).toBeNull();
    expect(app.service.publicPortNote).toBeNull();
  });

  test("secret-looking names with a public prefix block creating an app", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web");
    const refused = await owner.post(`/environments/${environments.development}/services`, {
      kind: "application",
      name: "web",
      serverId: "host",
      variables: [{ name: "NEXT_PUBLIC_API_KEY", value: "x" }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toStartWith(
      "Rename NEXT_PUBLIC_API_KEY before creating the app.",
    );
    const twice = await owner.post(`/environments/${environments.development}/services`, {
      kind: "application",
      name: "web",
      serverId: "host",
      variables: [
        { name: "A", value: "1" },
        { name: "A", value: "2" },
      ],
    });
    expect(twice.status).toBe(400);
    expect(twice.body.error.message).toBe("A is set twice, in rows 1 and 2. Keep one.");
  });

  test("settings: images change on the next deploy, fixed choices stay fixed", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { environments } = await makeProject(owner, "Web");
    const env = environments.development as string;
    const db = await makeService(owner, env, {
      kind: "mongodb",
      name: "docs",
      settings: { replicaSet: true },
    });
    const changed = await owner.patch(`/services/${db.service.id}`, {
      description: "Documents",
      settings: { image: "mongo:7" },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.service).toMatchObject({
      description: "Documents",
      settings: { image: "mongo:7", replicaSet: true },
    });
    expect(changed.body.notes[0]).toContain("manual upgrade");
    const app = await makeService(owner, env, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine" },
    });
    // M3c added the builder's commands, ports, mounts and deploy settings beside these.
    expect(app.service.settings).toMatchObject({
      source: { type: "image", image: "nginx:alpine", registry: null },
      build: { type: "automatic" },
      servicePort: 3000,
      ports: [],
      mounts: [],
    });
    const spaced = await owner.patch(`/services/${app.service.id}`, { settings: { image: "a b" } });
    expect(spaced.status).toBe(400);
    const compose = await makeService(owner, env, {
      kind: "compose",
      name: "stack",
      settings: { format: "stack", composeFile: "services: {}\n" },
    });
    expect(compose.service.settings).toEqual({
      format: "stack",
      source: { type: "raw", composeFile: "services: {}\n" },
    });
    const replica = await owner.post(`/environments/${env}/services`, {
      kind: "libsql",
      name: "edge",
      serverId: "host",
      settings: { nodeRole: "replica" },
    });
    expect(replica.body.error.fields["settings.primaryUrl"]).toContain("primary's URL");
  });
});

describe("copies made before linking", () => {
  test("services without a link match their copies by name and kind, and get linked", async () => {
    const owner = await setUpNamedOwner(p.h);
    const { projectId, environments } = await makeProject(owner, "Old", ["staging"]);
    const created = await makeService(owner, environments.development as string, {
      kind: "redis",
      name: "cache",
    });
    await p.h.test.db.updateTable("service").set({ copy_group_id: null }).execute();
    const detail = (await owner.get(`/services/${created.service.id}`)).body.service;
    expect(detail.copyGroupId).toBeNull();
    expect(detail.copies.map((copy: { environmentName: string }) => copy.environmentName)).toEqual([
      "staging",
    ]);
    // A new environment links them, and gets one copy, not two.
    const qa = await owner.post(`/projects/${projectId}/environments`, { name: "qa" });
    expect(qa.body.copiedServices).toBe(1);
    const linked = (await owner.get(`/services/${created.service.id}`)).body.service;
    expect(linked.copyGroupId).not.toBeNull();
    expect(linked.copies).toHaveLength(2);
  });
});
