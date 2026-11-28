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
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";
import { makeProject, makeService } from "./support/projects.ts";

/**
 * Published ports are unique per server (spec 06 6.8, 08 8.1; B1-29): a database's automatic
 * public port skips the ports apps and Compose files publish, and an app can't publish a port a
 * Compose file on the same server already does.
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

describe("published ports are unique per server (B1-29)", () => {
  test("a new database's public port skips what apps and Compose files publish", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const environment = environments.development as string;
    // The report's case: an app publishes 20000.
    const app = await makeService(owner, environment, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const ports = await owner.put(`/services/${app.service.id}/ports`, {
      ports: [{ publishedPort: 20000, containerPort: 80 }],
    });
    expect(ports.status).toBe(200);
    // A pasted Compose file publishes 20001 and a UDP 20002 (UDP doesn't block a TCP port).
    const stack = await makeService(owner, environment, {
      kind: "compose",
      name: "stack",
      settings: {
        format: "compose",
        composeFile:
          'services:\n  web:\n    image: nginx\n    ports: ["20001:80", "20002:53/udp"]\n',
      },
    });
    expect(stack.service.id).toBeTruthy();
    // Databases get their public port when they are created (spec 08 8.1).
    const db = await makeService(owner, environment, { kind: "postgres", name: "db" });
    const row = await h.test.db
      .selectFrom("service")
      .select("public_port")
      .where("id", "=", db.service.id)
      .executeTakeFirstOrThrow();
    expect(row.public_port).toBe(20002);
  });

  test("an app can't publish a port a Compose file on the server publishes", async () => {
    const { environments } = await makeProject(owner, "Shop");
    const environment = environments.development as string;
    await makeService(owner, environment, {
      kind: "compose",
      name: "stack",
      settings: {
        format: "compose",
        composeFile: 'services:\n  web:\n    image: nginx\n    ports: ["9000:80"]\n',
      },
    });
    const app = await makeService(owner, environment, {
      kind: "application",
      name: "web",
      settings: { image: "nginx:alpine", servicePort: 80 },
    });
    const refused = await owner.put(`/services/${app.service.id}/ports`, {
      ports: [{ publishedPort: 9000, containerPort: 80 }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      'Port 9000/TCP is already published by "stack" on this server. Pick another port.',
    );
  });
});
