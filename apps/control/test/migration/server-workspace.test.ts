import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hostDecision } from "../../src/compose-runtime/host-policy.ts";
import { planStack } from "../../src/compose-runtime/plan.ts";
import { createBundle, openBundle } from "../../src/migration/bundle.ts";
import { importBundle } from "../../src/migration/importer.ts";
import { hostMountDecision, savedAppDefinition } from "../../src/service-runtime/host-mounts.ts";
import { richFixture } from "./fixture.ts";
import { createMigrationHarness, type MigrationHarness } from "./support.ts";

/**
 * Where moved services may run (spec 22.4 rule 1, 24 G3, 29.5), in one import of the rich bundle
 * with three changes:
 * - a service of one workspace that names another workspace's server is refused (B1-61): the
 *   database stopped refusing it in migration 0153, so the importer checks it;
 * - an app that ran on the Nearzero host with bind mounts keeps them as an administrator's
 *   approval of that definition (30b R2-07), so the move's own deploy runs it;
 * - a pasted Compose stack on the host with privileged options keeps them the same way.
 */

const PASSPHRASE = "a passphrase of sixteen+ characters";
const STACK_FILE =
  'services:\n  grafana:\n    image: grafana/grafana\n    volumes: ["/var/run/docker.sock:/var/run/docker.sock"]\n';

let h: MigrationHarness;
let messages: { refused: string[]; changed: string[] };

beforeAll(async () => {
  h = await createMigrationHarness();
  const fixture = await richFixture();
  const services = fixture.content.records["services.jsonl"] as {
    ref: string;
    name: string;
    appName: string;
    place: unknown;
    settings: Record<string, unknown>;
  }[];
  const find = (ref: string) => {
    const record = services.find((item) => item.ref === ref);
    if (!record) throw new Error(`The fixture has no ${ref}.`);
    return record;
  };
  // The attack: wsp_side's tool claims wsp_acme's server.
  const tool = find("svc_tool");
  // An app on the host with the Docker socket, in the same workspace as tool.
  services.push({
    ...structuredClone(tool),
    ref: "svc_agent",
    name: "agent",
    appName: "agent-q1q2q3",
    settings: {
      ...tool.settings,
      mounts: [
        {
          type: "Host folder",
          containerPath: "/var/run/docker.sock",
          hostPath: "/var/run/docker.sock",
        },
      ],
    },
  } as never);
  tool.place = { serverRef: "srv_prod" };
  const stack = find("svc_stack");
  stack.settings = { ...stack.settings, composeFile: STACK_FILE };
  const bundle = await openBundle(
    await createBundle(fixture.content, PASSPHRASE, { N: 2 ** 14 }),
    PASSPHRASE,
  );
  const result = await importBundle(h.services, bundle, { dryRun: false, inPlace: true });
  messages = {
    refused: result.report.notImported.map((item: { message: string }) => item.message),
    changed: result.report.changed.map((item: { message: string }) => item.message),
  };
}, 120_000);

afterAll(async () => {
  await h?.drop();
});

async function service(name: string) {
  return h.db
    .selectFrom("service")
    .select(["id", "app_name", "settings", "server_id"])
    .where("name", "=", name)
    .executeTakeFirst();
}

describe("services and the workspace of their server (B1-61)", () => {
  test("a service of one workspace pointing at another workspace's server is refused", async () => {
    expect(messages.refused).toContainEqual(
      expect.stringContaining("its server belongs to another workspace."),
    );
    expect(await service("tool")).toBeUndefined();
    const placed = await h.db
      .selectFrom("service as s")
      .innerJoin("server as v", "v.id", "s.server_id")
      .select(["s.workspace_id", "v.workspace_id as server_workspace"])
      .execute();
    expect(placed.length).toBeGreaterThan(0);
    for (const row of placed) expect(row.workspace_id).toBe(row.server_workspace);
  });
});

describe("an app that ran on the host with bind mounts (30b R2-07, spec 29.5)", () => {
  test("keeps them after the move as an administrator's approval of that definition", async () => {
    expect(messages.changed).toContainEqual(
      expect.stringContaining("its bind mounts on the Nearzero host are kept"),
    );
    const row = await service("agent");
    if (!row) throw new Error("agent wasn't imported.");
    expect(row.server_id).toBeNull();
    // The move's own deploy (no person) may run it; another image needs an administrator.
    const moved = await hostMountDecision(h.db, {
      serviceId: row.id,
      definition: await savedAppDefinition(h.db, h.services.secrets, row.id),
      personId: null,
    });
    expect(moved.allowed).toBe(true);
    const changed = await hostMountDecision(h.db, {
      serviceId: row.id,
      definition: await savedAppDefinition(h.db, h.services.secrets, row.id, {
        ...(row.settings ?? {}),
        source: { type: "image", image: "docker:cli", registry: null },
      }),
      personId: null,
    });
    expect(changed.allowed).toBe(false);
  });
});

describe("a pasted Compose stack that ran on the host with privileged options (spec 24 G3, 29.5)", () => {
  test("keeps them after the move as an administrator's approval of those definitions", async () => {
    expect(messages.changed).toContainEqual(
      expect.stringContaining("its privileged options on the Nearzero host are kept"),
    );
    const row = await service("monitoring");
    if (!row) throw new Error("monitoring wasn't imported.");
    const findings = (text: string) => {
      const planned = planStack({
        file: text,
        source: { type: "raw", composeFile: text },
        appName: row.app_name,
        serviceId: row.id,
        deploymentId: null,
        variables: [],
        routes: [],
        onHost: true,
      });
      if (!planned.ok) throw new Error(planned.problem);
      return planned.plan.findings;
    };
    const decide = (text: string) =>
      hostDecision(h.db, {
        serviceId: row.id,
        onHost: true,
        findings: findings(text),
        personId: null,
      });
    expect((await decide(STACK_FILE)).allowed).toBe(true);
    expect((await decide(STACK_FILE.replace("grafana/grafana", "docker:cli"))).allowed).toBe(false);
  });
});
