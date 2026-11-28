import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { loadDestination } from "../../src/backups/destinations.ts";
import { openProviderSecrets } from "../../src/git-providers/records.ts";
import { createBundle, type OpenedBundle, openBundle } from "../../src/migration/bundle.ts";
import { importBundle } from "../../src/migration/importer.ts";
import { openSecrets as openChannelSecrets } from "../../src/notifications/channels.ts";
import { totpCode } from "../../src/security/totp.ts";
import { secretsContext } from "../../src/services/records.ts";
import { readWorkspaceKey } from "../../src/settings/keys.ts";
import { openPrivateKey } from "../../src/ssh-keys/keys.ts";
import { readVariables } from "../../src/variables/store.ts";
import { currentWebhookToken } from "../../src/webhooks/tokens.ts";
import { BACKUP_CODE, PASSWORDS, richFixture, TOTP_BASE32, WEBHOOK_TOKEN } from "./fixture.ts";
import { createMigrationHarness, type MigrationHarness } from "./support.ts";

/**
 * Importing a rich bundle (spec 29a) into a fresh 1.0 database (spec 29.5): every record kind, the
 * dry run's report, refs turned into ids, labels turned into 1.0's choices, secrets sealed with
 * this install's key, old password hashes at sign-in, and a second import that changes nothing.
 */

const PASSPHRASE = "a passphrase of sixteen+ characters";

let h: MigrationHarness;
let bundle: OpenedBundle;
let serverId: string;

async function id(table: string, column: string, value: string): Promise<string> {
  const result = await sql<{
    id: string;
  }>`select id from ${sql.table(table)} where ${sql.ref(column)} = ${value}`.execute(h.db);
  const row = result.rows[0];
  if (!row) throw new Error(`no ${table} with ${column} = ${value}`);
  return row.id;
}

async function count(table: string): Promise<number> {
  const result = await sql<{ n: string }>`select count(*) as n from ${sql.table(table)}`.execute(
    h.db,
  );
  return Number(result.rows[0]?.n ?? 0);
}

const TABLES = [
  "person",
  "workspace",
  "workspace_old_slug",
  "membership",
  "access_policy",
  "access_scope_item",
  "policy_attachment",
  "invitation",
  "ssh_key",
  "server",
  "git_provider",
  "dns_zone",
  "dns_record",
  "project",
  "environment",
  "service",
  "variable_set",
  "hostname",
  "uploaded_certificate",
  "backup_destination",
  "backup_schedule",
  "task",
  "notification_channel",
  "agent_session",
  "agent_turn",
  "deployment",
  "deployment_log",
  "deploy_webhook",
  "migration_move",
  "migration_server_move",
  "migration_acme_state",
  "two_factor",
  "two_factor_backup_code",
];

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) out[table] = await count(table);
  return out;
}

const messages = (list: { message: string }[]) => list.map((item) => item.message);

beforeAll(async () => {
  h = await createMigrationHarness();
  const fixture = await richFixture();
  // A host task whose 0.1.x owner isn't moved (banned) goes to the person who ran the move (R3-29).
  fixture.content.records["tasks.jsonl"]?.push({
    ref: "tsk_host_orphan",
    workspaceRef: "wsp_acme",
    place: { host: true },
    name: "Rotate keys",
    description: null,
    cron: "0 3 * * *",
    timeZone: null,
    shell: "bash",
    script: "true",
    enabled: false,
    ownerRef: "per_mallory",
    createdAt: null,
  });
  bundle = await openBundle(
    await createBundle(fixture.content, PASSPHRASE, { N: 2 ** 14 }),
    PASSPHRASE,
  );
}, 120_000);

afterAll(async () => {
  await h?.drop();
});

describe("dry run", () => {
  test("reports counts, refusals, changes and dropped settings, and changes nothing", async () => {
    const result = await importBundle(h.services, bundle, { dryRun: true, inPlace: true });
    const report = result.report;
    expect(result.importId).toBeNull();
    expect(report.dryRun).toBe(true);
    expect(report.counts.people).toEqual({
      inBundle: 5,
      imported: 4,
      alreadyImported: 0,
      notImported: 1,
    });
    expect(report.counts.servers).toEqual({
      inBundle: 2,
      imported: 1,
      alreadyImported: 0,
      notImported: 1,
    });
    expect(report.counts.services.imported).toBe(12);
    expect(report.counts.channels).toEqual({
      inBundle: 3,
      imported: 2,
      alreadyImported: 0,
      notImported: 1,
    });
    expect(report.counts.invitations).toEqual({
      inBundle: 2,
      imported: 1,
      alreadyImported: 0,
      notImported: 1,
    });
    expect(report.counts.backupSchedules).toEqual({
      inBundle: 3,
      imported: 2,
      alreadyImported: 0,
      notImported: 1,
    });
    expect(messages(report.notImported)).toEqual(
      expect.arrayContaining([
        "mallory@example.com: the account was banned on 0.1.x, so it was left out.",
        "Server orphan: it has no SSH key, and 1.0 reaches servers with one. Add it again under Servers.",
        "Notification channel Fax: Fax isn't a channel type 1.0 sends to.",
        "Invitation for old@example.com: it has expired.",
        "Backup schedule grafana of monitoring: Compose database backups aren't in Nearzero 1.0; back up the stack's volumes instead.",
      ]),
    );
    expect(messages(report.changed)).toEqual(
      expect.arrayContaining([
        "Service api uses a builder 1.0 doesn't offer (Buildpacks classic); it will build automatically.",
        "dave@example.com's password can't be checked by 1.0. Set a new one with: sudo nearzero reset-password dave@example.com",
        "carol@example.com's two-factor secret couldn't be carried over, so two-factor sign-in is off for them until they set it up again in Profile.",
        "Environment Staging Env in Shop is called staging-env in 1.0 (environment names are lowercase words joined by dashes).",
        'dave@example.com in Acme: the role "Billing" isn\'t in 1.0, so they are a member with their capabilities.',
        // The server hasn't reported its time zone yet, so the move can't say which it is (G3-21).
        "Backup schedule pg of pg: 0.1.x ran \"0 3 * * *\" in Europe/Berlin. 1.0 runs backups in their server's time zone, which this server hasn't reported yet: if it isn't Europe/Berlin, check the schedule's time once the server connects.",
        "Backup schedule uploads of web: 0.1.x ran \"30 4 L * *\" in UTC. 1.0 runs backups in their server's time zone, which this server hasn't reported yet: if it isn't UTC, check the schedule's time once the server connects.",
        "Task Disk report: tasks on a server run with bash in 1.0.",
        "Hostname docs.example.net: 1.0 serves every hostname over HTTPS once its DNS points here.",
      ]),
    );
    // Its kept webhook URL deploys only on POST now (G4-17).
    expect(
      messages(report.changed).some((message) =>
        message.includes(
          '0.1.x also deployed when its webhook URL was called with GET. 1.0 deploys only on POST and answers a GET with "Call this webhook with POST."',
        ),
      ),
    ).toBe(true);
    expect(messages(report.dropped)).toEqual(
      expect.arrayContaining([
        'Workspace Acme: the Agent policy "Teleport servers" isn\'t in 1.0, so it was left out.',
        "Service web: Replica counts aren't in Nearzero 1.0, so it runs one container.",
        "Service worker: building on the Nearzero host for another server isn't in 1.0 (spec 27), so it builds on its own server.",
        "Service worker: Build arguments aren't in Nearzero 1.0; its variables are available while it builds instead.",
        "Service worker: Custom commands aren't in Nearzero 1.0, so it starts with its Start command or its image's own.",
        'Service monitoring: "randomizeNames" isn\'t in 1.0; its containers are named <app name>-<service> on the private network.',
        "Service edge: 1.0 publishes libSQL's HTTP port only, so its gRPC and admin ports are private.",
        'Access policy Deployers: the capability "Manage container registries" isn\'t in 1.0, so it was left out.',
        'Notification channel Deploys: the event "Nearzero backup" isn\'t in 1.0, so it was left out.',
        "Hostname api.apps.example.com: rewriting the path to the app isn't in 1.0, so requests reach it with the path they came with.",
        "bob@example.com also signed in with GitHub. 1.0 signs in with email and password (spec 27), so they use their password.",
        "web: Its health check isn't carried (29a.7).",
      ]),
    );
    expect(messages(report.install)).toEqual(
      expect.arrayContaining([
        "the Nearzero host: 1 certificate and the certificate authority account are kept, so nothing is ordered again.",
        "prod-1: 1 certificate and the certificate authority account are kept, so nothing is ordered again (1 unreadable entries were left out).",
        "The 0.1.x console was at nearzero.example.com; this one is at this server's IP address. To keep the old address, run the install command again with NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com.",
      ]),
    );
    expect(report.collisions).toEqual([]);
    // The move plan: the host first, then prod-1; oldest deployed first on each.
    expect(report.moves.map((move) => `${move.service}@${move.server}`)).toEqual([
      "mysql@the Nearzero host",
      "maria@the Nearzero host",
      "mongo@the Nearzero host",
      "cache@the Nearzero host",
      "edge@the Nearzero host",
      "monitoring@the Nearzero host",
      "api@the Nearzero host",
      "worker@the Nearzero host",
      "tool@the Nearzero host",
      "pg@prod-1",
      "web@prod-1",
    ]);
    // Nothing was written.
    expect(await count("person")).toBe(0);
    expect(await count("migration_import")).toBe(0);
    expect(await count("migration_record")).toBe(0);
  });
});

describe("import", () => {
  let first: Awaited<ReturnType<typeof importBundle>>;

  beforeAll(async () => {
    first = await importBundle(h.services, bundle, { dryRun: false, inPlace: true });
    serverId = await id("server", "name", "prod-1");
  }, 120_000);

  test("the real import's report matches the dry run's", () => {
    expect(first.importId).not.toBeNull();
    expect(first.moves).toBe(11);
    expect(first.report.counts.services.imported).toBe(12);
    expect(first.report.counts.deployments.imported).toBe(12);
  });

  test("people, two-factor and the first workspace", async () => {
    const alice = await h.db
      .selectFrom("person")
      .selectAll()
      .where("email", "=", "alice@example.com")
      .executeTakeFirstOrThrow();
    expect(alice.first_name).toBe("Alice");
    expect(alice.password_hash?.startsWith("nzlegacy1:")).toBe(true);
    expect(alice.onboarding_step).toBeNull();
    expect(alice.avatar_color).toBe("teal");
    const dave = await h.db
      .selectFrom("person")
      .selectAll()
      .where("email", "=", "dave@example.com")
      .executeTakeFirstOrThrow();
    expect(dave.password_hash).toBeNull();
    expect(dave.onboarding_step).toBe("name");
    // 0.1.x's "not verified" flag said nothing: moved accounts count as confirmed, so their
    // invitations keep reaching the bell and the after-sign-in redirect (30a R1-02).
    expect(dave.email_verified_at).not.toBeNull();
    const twoFactor = await h.db
      .selectFrom("two_factor")
      .selectAll()
      .where("person_id", "=", alice.id)
      .executeTakeFirstOrThrow();
    expect(twoFactor.secret_sealed).not.toContain(TOTP_BASE32);
    expect(twoFactor.enabled_at).not.toBeNull();
    expect(
      await h.db
        .selectFrom("two_factor_backup_code")
        .select("id")
        .where("person_id", "=", alice.id)
        .execute(),
    ).toHaveLength(2);
    expect(await h.db.selectFrom("two_factor").select("person_id").execute()).toHaveLength(1);
    const acme = await h.db
      .selectFrom("workspace")
      .selectAll()
      .where("slug", "=", "acme")
      .executeTakeFirstOrThrow();
    expect(acme.created_by).toBe(alice.id);
    const state = await h.db.selectFrom("install_state").selectAll().executeTakeFirstOrThrow();
    expect(state.first_workspace_id).toBe(acme.id);
    expect(
      (await h.db.selectFrom("workspace_old_slug").selectAll().execute()).map((row) => row.slug),
    ).toEqual(["acme-old"]);
    expect(
      await h.db.selectFrom("host_allowed_workspace").select("workspace_id").execute(),
    ).toHaveLength(2);
    const policies = (
      await h.db
        .selectFrom("workspace_settings")
        .select("agent_policies")
        .where("workspace_id", "=", acme.id)
        .executeTakeFirstOrThrow()
    ).agent_policies as Record<string, boolean>;
    expect(Object.keys(policies)).toHaveLength(16);
    expect(policies["services.import-git"]).toBe(true);
    expect(policies.production).toBe(false);
  });

  test("members, policies, scopes and invitations point at the imported objects", async () => {
    const acme = await id("workspace", "slug", "acme");
    const bob = await id("person", "email", "bob@example.com");
    const policy = await h.db
      .selectFrom("access_policy")
      .selectAll()
      .where("workspace_id", "=", acme)
      .executeTakeFirstOrThrow();
    expect(policy.name).toBe("Deployers");
    expect(policy.capabilities).toEqual(["services.create"]);
    const policyScope = await h.db
      .selectFrom("access_scope_item")
      .select(["object_kind", "object_id"])
      .where("policy_id", "=", policy.id)
      .orderBy("object_kind")
      .execute();
    expect(policyScope).toEqual([
      { object_kind: "project", object_id: await id("project", "name", "Shop") },
      { object_kind: "server", object_id: serverId },
    ]);
    const access = await h.db
      .selectFrom("member_access")
      .selectAll()
      .where("person_id", "=", bob)
      .executeTakeFirstOrThrow();
    expect(access.capabilities).toEqual(["ssh-keys.use"]);
    const direct = await h.db
      .selectFrom("access_scope_item")
      .select(["object_kind", "object_id", "parent_id"])
      .where("person_id", "=", bob)
      .orderBy("object_kind")
      .execute();
    const api = await id("service", "app_name", "api-x1y2z3");
    const apiEnvironment = (
      await h.db
        .selectFrom("service")
        .select("environment_id")
        .where("id", "=", api)
        .executeTakeFirstOrThrow()
    ).environment_id;
    expect(direct).toEqual([
      {
        object_kind: "git_account",
        object_id: await id("git_provider", "name", "Acme GitHub"),
        parent_id: null,
      },
      { object_kind: "service", object_id: api, parent_id: apiEnvironment },
    ]);
    expect(
      await h.db
        .selectFrom("policy_attachment")
        .select("person_id")
        .where("policy_id", "=", policy.id)
        .execute(),
    ).toEqual([{ person_id: bob }]);
    const roles = await h.db
      .selectFrom("membership as m")
      .innerJoin("person as p", "p.id", "m.person_id")
      .select(["p.email", "m.role"])
      .where("m.workspace_id", "=", acme)
      .orderBy("p.email")
      .execute();
    expect(roles).toEqual([
      { email: "alice@example.com", role: "owner" },
      { email: "bob@example.com", role: "member" },
      { email: "dave@example.com", role: "member" },
    ]);
    // Alice's default workspace is Acme; she is an admin in Side Projects too.
    const alice = await h.db
      .selectFrom("person")
      .select(["id", "last_workspace_id"])
      .where("email", "=", "alice@example.com")
      .executeTakeFirstOrThrow();
    expect(alice.last_workspace_id).toBe(acme);
    const invitation = await h.db.selectFrom("invitation").selectAll().executeTakeFirstOrThrow();
    expect(invitation.email).toBe("erin@example.com");
    expect(invitation.invited_by).toBe(alice.id);
    expect(await h.db.selectFrom("invitation_policy").select("policy_id").execute()).toEqual([
      { policy_id: policy.id },
    ]);
  });

  test("names and addresses are kept exactly: app names, labels, volumes, ports, hostnames", async () => {
    const server = await h.db
      .selectFrom("server")
      .selectAll()
      .where("id", "=", serverId)
      .executeTakeFirstOrThrow();
    expect(server.label).toBe("prod1");
    expect(server.setup_state).toBe("not_started");
    expect(server.docker_cleanup).toBe(true);
    const alerts = await h.db
      .selectFrom("server_alert_setting")
      .select(["target", "cpu_threshold", "memory_threshold"])
      .execute();
    expect(alerts.sort((a, b) => (a.target === "host" ? -1 : b.target === "host" ? 1 : 0))).toEqual(
      [
        { target: "host", cpu_threshold: 95, memory_threshold: 90 },
        { target: serverId, cpu_threshold: 90, memory_threshold: 85 },
      ],
    );
    const services = await h.db
      .selectFrom("service")
      .select(["name", "app_name", "server_id", "public_port", "settings", "kind"])
      .execute();
    const byName = new Map(services.map((row) => [`${row.name}:${row.app_name}`, row]));
    expect([...byName.keys()].sort()).toEqual(
      [
        "api:api-x1y2z3",
        "cache:cache-e1f2g3",
        "edge:edge-f1g2h3",
        "maria:maria-c1d2e3",
        "mongo:mongo-d1e2f3",
        "monitoring:monitoring-m1n2o3",
        "mysql:mysql-b1c2d3",
        "pg:pg-a1b2c3",
        "tool:tool-h1h2h3",
        "web:web-k3m9x2",
        "web:web-p7q8r9",
        "worker:worker-u1u2u3",
      ].sort(),
    );
    const kinds = Object.fromEntries(services.map((row) => [row.name, row.kind]));
    expect(kinds).toMatchObject({
      pg: "postgres",
      mysql: "mysql",
      maria: "mariadb",
      mongo: "mongodb",
      cache: "redis",
      edge: "libsql",
      monitoring: "compose",
    });
    const pg = byName.get("pg:pg-a1b2c3");
    expect(pg?.server_id).toBe(serverId);
    expect(pg?.public_port).toBe(25432);
    expect(pg?.settings).toMatchObject({
      image: "postgres:16",
      dataVolume: "pg-a1b2c3-data",
      databaseName: "shop",
      user: "app",
    });
    expect(byName.get("mysql:mysql-b1c2d3")?.public_port).toBe(23306);
    // 29.5 "Public ports": the exact port, even outside the range new ones come from.
    expect(byName.get("mongo:mongo-d1e2f3")?.public_port).toBe(31017);
    expect(byName.get("mongo:mongo-d1e2f3")?.settings).toMatchObject({
      replicaSet: true,
      dataVolume: "mongo-d1e2f3-data",
    });
    expect(byName.get("edge:edge-f1g2h3")?.public_port).toBe(24080);
    expect(byName.get("edge:edge-f1g2h3")?.settings).toMatchObject({
      nodeRole: "primary",
      namespaces: true,
    });
    const web = byName.get("web:web-k3m9x2");
    const github = await id("git_provider", "name", "Acme GitHub");
    expect(web?.settings).toMatchObject({
      source: {
        type: "provider",
        providerId: github,
        provider: "github",
        repository: "acme/shop",
        branch: "main",
        trigger: "push",
        watchPaths: ["src/**"],
      },
      build: { type: "nixpacks" },
      commands: { build: "npm run build" },
      servicePort: 8080,
      ports: [{ containerPort: 9000, publishedPort: 9000, protocol: "tcp", mode: "routed" }],
      mounts: [
        { type: "volume", name: "uploads", containerPath: "/app/uploads" },
        { type: "file", containerPath: "/app/config.json" },
      ],
      deploy: { autodeploy: true },
    });
    expect(byName.get("api:api-x1y2z3")?.settings).toMatchObject({
      source: {
        type: "image",
        image: "ghcr.io/acme/api:1.2.0",
        registry: { address: "ghcr.io", username: "acme", passwordSet: true },
      },
      build: { type: "automatic" },
      servicePort: 3000,
    });
    const worker = byName.get("worker:worker-u1u2u3")?.settings as {
      source: { sshKeyId: string };
      build: unknown;
    };
    expect(worker.source.sshKeyId).toBe(await id("ssh_key", "name", "Deploy key"));
    expect(worker.build).toEqual({
      type: "dockerfile",
      dockerfilePath: "Dockerfile.worker",
      contextPath: "",
      stage: "",
    });
    expect(byName.get("monitoring:monitoring-m1n2o3")?.settings).toMatchObject({
      format: "compose",
      source: { type: "raw", composeFile: "services:\n  grafana:\n    image: grafana/grafana\n" },
    });
    // Linked copies share a copy group.
    const groups = await h.db
      .selectFrom("service")
      .select("copy_group_id")
      .where("name", "=", "web")
      .execute();
    expect(groups[0]?.copy_group_id).not.toBeNull();
    expect(groups[0]?.copy_group_id).toBe(groups[1]?.copy_group_id ?? "");

    const hosts = await h.db
      .selectFrom("hostname")
      .select(["host", "source", "automatic", "target", "compose_service", "port", "path"])
      .orderBy("host")
      .execute();
    expect(hosts).toEqual([
      {
        host: "a1b2c3.prod1.apps.example.com",
        source: "server",
        automatic: true,
        target: serverId,
        compose_service: null,
        port: 8080,
        path: "/",
      },
      {
        host: "api.apps.example.com",
        source: "platform",
        automatic: true,
        target: "host",
        compose_service: null,
        port: 3000,
        path: "/v1",
      },
      {
        host: "docs.example.net",
        source: "zone",
        automatic: false,
        target: "host",
        compose_service: "grafana",
        port: 3000,
        path: "/",
      },
      {
        host: "shop.example.org",
        source: "own",
        automatic: false,
        target: serverId,
        compose_service: null,
        port: 8080,
        path: "/",
      },
      {
        host: "spare.example.net",
        source: "zone",
        automatic: false,
        target: "host",
        compose_service: null,
        port: null,
        path: "/",
      },
    ]);
    const zone = await id("dns_zone", "name", "example.net");
    const records = await h.db
      .selectFrom("dns_record")
      .select(["name", "type", "value", "ttl", "managed"])
      .where("zone_id", "=", zone)
      .orderBy("name")
      .orderBy("type")
      .orderBy("value")
      .execute();
    expect(records).toEqual([
      { name: "@", type: "MX", value: "mail.example.net.", ttl: 3600, managed: false },
      { name: "@", type: "NS", value: "ns1.example.net", ttl: 3600, managed: true },
      { name: "@", type: "NS", value: "ns2.example.net", ttl: 3600, managed: true },
      { name: "docs", type: "A", value: "203.0.113.10", ttl: 300, managed: true },
      { name: "ns1", type: "A", value: "203.0.113.10", ttl: 3600, managed: true },
      { name: "ns2", type: "A", value: "203.0.113.10", ttl: 3600, managed: true },
      { name: "spare", type: "A", value: "203.0.113.10", ttl: 300, managed: true },
      { name: "www", type: "CNAME", value: "example.net.", ttl: 600, managed: false },
    ]);
  });

  test("secrets are sealed with this install's key and open through each area", async () => {
    const acme = await id("workspace", "slug", "acme");
    expect(await readWorkspaceKey(h.services, acme, "model")).toEqual({
      status: "ok",
      value: "sk-or-v1-abcdefghijklmnop",
    });
    const keyId = await id("ssh_key", "name", "Deploy key");
    expect(await openPrivateKey(h.services, acme, keyId)).toContain("PRIVATE KEY");
    const provider = await h.db.selectFrom("git_provider").selectAll().executeTakeFirstOrThrow();
    expect(provider.status).toBe("ready");
    expect(String(provider.installation_id)).toBe("987654");
    expect(String(provider.github_app_id)).toBe("123456");
    expect(openProviderSecrets<{ webhookSecret: string }>(h.services, provider).webhookSecret).toBe(
      "gh-webhook-secret",
    );
    const destination = await id("backup_destination", "name", "S3 backups");
    expect((await loadDestination(h.services, acme, destination)).runner).toMatchObject({
      provider: "aws",
      secretAccessKey: "s3-secret-key",
    });
    const slack = await h.db
      .selectFrom("notification_channel")
      .select(["id", "secrets_sealed", "settings", "events"])
      .where("type", "=", "slack")
      .executeTakeFirstOrThrow();
    expect(openChannelSecrets(h.services, slack)).toEqual({
      ok: true,
      secrets: { webhookUrl: "https://hooks.slack.com/services/T000/B000/XXXX" },
    });
    expect(slack.settings).toEqual({ channel: "#deploys" });
    expect(slack.events.sort()).toEqual(["deploy.failed", "deploy.succeeded"]);
    const hook = await h.db
      .selectFrom("notification_channel")
      .select(["id", "secrets_sealed", "settings", "events"])
      .where("type", "=", "webhook")
      .executeTakeFirstOrThrow();
    expect(openChannelSecrets(h.services, hook)).toEqual({
      ok: true,
      secrets: { headers: [{ name: "Authorization", value: "Bearer hook-token" }] },
    });
    expect(hook.events).toEqual(["server.alert"]);
    // Called exactly as 0.1.x called it, its trailing "/" included (G3-17).
    expect(hook.settings).toEqual({ url: "https://hooks.example.com/nearzero/" });
    const pg = await h.db
      .selectFrom("service")
      .select(["id", "secrets_sealed"])
      .where("app_name", "=", "pg-a1b2c3")
      .executeTakeFirstOrThrow();
    expect(
      JSON.parse(
        (
          h.services.secrets.open(pg.secrets_sealed as string, secretsContext(pg.id)) as {
            value: string;
          }
        ).value,
      ),
    ).toEqual({ password: "pg-pass-1" });
    const mysql = await h.db
      .selectFrom("service")
      .select(["id", "secrets_sealed"])
      .where("app_name", "=", "mysql-b1c2d3")
      .executeTakeFirstOrThrow();
    expect(
      JSON.parse(
        (
          h.services.secrets.open(mysql.secrets_sealed as string, secretsContext(mysql.id)) as {
            value: string;
          }
        ).value,
      ),
    ).toEqual({ password: "my-pass", rootPassword: "my-root" });
    const web = await id("service", "app_name", "web-k3m9x2");
    expect((await currentWebhookToken(h.services, web))?.token).toBe(WEBHOOK_TOKEN);
    const shop = await id("project", "name", "Shop");
    const production = (
      await h.db
        .selectFrom("environment")
        .select("id")
        .where("name", "=", "production")
        .where("project_id", "=", shop)
        .executeTakeFirstOrThrow()
    ).id;
    const shared = await readVariables(h.db, h.services.secrets, {
      kind: "environment",
      id: production,
      workspaceId: acme,
    });
    expect(shared.text).toBe(
      "# shared\nLOG_LEVEL=warn\nREGION=eu\n# From the project\nSHARED_FROM_PROJECT=1\n",
    );
    const own = await readVariables(h.db, h.services.secrets, {
      kind: "service",
      id: web,
      workspaceId: acme,
    });
    expect(own.text).toBe("# own\nDATABASE_URL=postgres://app:pw@pg-a1b2c3:5432/shop\n");

    // Another install's key opens none of it: the values were sealed for this one.
    const other = h.servicesWithSecret("another-install-secret-0123456789");
    expect(await readWorkspaceKey(other, acme, "model")).toEqual({ status: "unreadable" });
    expect(other.secrets.open(pg.secrets_sealed as string, secretsContext(pg.id))).toEqual({
      ok: false,
      reason: "key_changed",
    });

    // No plain secret from the bundle is anywhere in the database.
    const plain = [
      "pg-pass-1",
      "my-root",
      "ghcr-token",
      "s3-secret-key",
      "gh-webhook-secret",
      "gh-client-secret",
      "sk-or-v1-abcdefghijklmnop",
      "re_123456789abc",
      "hooks.slack.com/services/T000",
      "hook-token",
      WEBHOOK_TOKEN,
      TOTP_BASE32,
      "PRIVATE KEY",
      "MIIEowIBAAKCAQEA",
      "pw@pg-a1b2c3",
      '{"secret":true}',
    ];
    for (const table of TABLES.concat(["workspace_secret", "workspace_email", "address_setting"])) {
      const rows = await sql<{
        row: string;
      }>`select row_to_json(t)::text as row from ${sql.table(table)} t`.execute(h.db);
      for (const row of rows.rows)
        for (const value of plain)
          expect(row.row.includes(value) ? `${table}: ${value}` : "").toBe("");
    }
  });

  test("schedules, tasks, uploads, sessions, deployments and install settings", async () => {
    const schedules = await h.db
      .selectFrom("backup_schedule")
      .select([
        "folder",
        "kind",
        "volume_name",
        "keep",
        "enabled",
        "next_run_at",
        "stop_service",
        "legacy_files",
      ])
      .orderBy("folder")
      .execute();
    expect(
      schedules.map((row) => [
        row.folder,
        row.kind,
        row.volume_name,
        row.keep,
        row.enabled,
        row.stop_service,
        row.legacy_files,
      ]),
    ).toEqual([
      // 0.1.x's files in these folders are these schedules' own (R2-06, R3-44).
      ["pg", "database", null, 14, true, false, true],
      ["uploads", "volume", "uploads", null, true, true, true],
    ]);
    for (const row of schedules) expect(row.next_run_at).not.toBeNull();
    // A schedule using 0.1.x's "L" keeps its rhythm: the month's last day (G3-14).
    const lastDay = await h.db
      .selectFrom("backup_schedule")
      .select(["cron", "next_run_at"])
      .where("folder", "=", "uploads")
      .executeTakeFirstOrThrow();
    expect(lastDay.cron).toBe("30 4 L * *");
    const lastDayRun = new Date(lastDay.next_run_at as Date);
    const monthEnd = new Date(
      Date.UTC(lastDayRun.getUTCFullYear(), lastDayRun.getUTCMonth() + 1, 0),
    ).getUTCDate();
    expect(Math.abs(lastDayRun.getUTCDate() - monthEnd)).toBeLessThanOrEqual(1);
    const tasks = await h.db
      .selectFrom("task")
      .select([
        "name",
        "place",
        "workspace_id",
        "shell",
        "script",
        "enabled",
        "next_run_at",
        "time_zone",
        "inner_service",
        "owner_id",
      ])
      .orderBy("name")
      .execute();
    expect(
      tasks.map((row) => [
        row.name,
        row.place,
        row.shell,
        row.enabled,
        row.time_zone,
        row.inner_service,
        row.next_run_at !== null,
      ]),
    ).toEqual([
      ["Disk report", "server", "bash", true, "Europe/Paris", null, true],
      ["Prune logs", "host", "bash", true, "UTC", null, true],
      ["Reload", "container", "sh", false, "UTC", "grafana", false],
      ["Rotate keys", "host", "bash", false, "UTC", null, false],
    ]);
    // A task using 0.1.x's "#" keeps its rhythm: the first Monday, 09:00 in Paris (G3-14).
    const firstMonday = await h.db
      .selectFrom("task")
      .select(["cron", "next_run_at"])
      .where("name", "=", "Disk report")
      .executeTakeFirstOrThrow();
    expect(firstMonday.cron).toBe("0 9 * * 1#1");
    const paris = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Paris",
      weekday: "short",
      day: "numeric",
      hour: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(firstMonday.next_run_at as Date));
    const part = (type: string) => paris.find((item) => item.type === type)?.value;
    expect(part("weekday")).toBe("Mon");
    expect(Number(part("day"))).toBeLessThanOrEqual(7);
    expect(part("hour")).toBe("09");
    // A host task keeps its 0.1.x owner; one whose owner wasn't moved goes to the person who
    // ran the move, the install's owner (spec 30, R3-29). Other tasks have none.
    const owners = Object.fromEntries(tasks.map((row) => [row.name, row.owner_id]));
    expect(owners).toEqual({
      "Disk report": null,
      "Prune logs": await id("person", "email", "bob@example.com"),
      Reload: null,
      "Rotate keys": await id("person", "email", "alice@example.com"),
    });
    expect(tasks.find((row) => row.name === "Prune logs")?.workspace_id).toBeNull();
    expect(tasks.find((row) => row.name === "Prune logs")?.script).toBe(
      "find /var/log -name '*.gz' -mtime +7 -delete\n",
    );

    const upload = await h.db
      .selectFrom("uploaded_certificate")
      .select(["name", "target", "names"])
      .executeTakeFirstOrThrow();
    expect(upload).toEqual({
      name: "Shop certificate",
      target: serverId,
      names: ["shop.example.org"],
    });

    const sessions = await h.db
      .selectFrom("agent_session")
      .select(["id", "title", "shared", "author_id"])
      .orderBy("title")
      .execute();
    const alice = await id("person", "email", "alice@example.com");
    expect(sessions.map((row) => [row.title, row.shared, row.author_id === alice])).toEqual([
      ["Deploy the shop", false, true],
      ["Old chat", true, true],
    ]);
    const turns = await h.db
      .selectFrom("agent_turn as t")
      .innerJoin("agent_message as m", "m.id", "t.message_id")
      .select(["m.text", "t.answer_text", "t.state"])
      .where("t.session_id", "=", sessions[0]?.id as string)
      .orderBy("t.created_at")
      .orderBy("m.text")
      .execute();
    expect(turns).toEqual([
      {
        text: "Deploy web please\n\n(1 attachment not carried over)",
        answer_text: "Deployed web.\n\nSteps:\n- Started a deploy of web\n- Checked web (failed)",
        state: "finished",
      },
      { text: "Thanks", answer_text: "You're welcome.", state: "finished" },
    ]);

    const deployments = await h.db
      .selectFrom("deployment")
      .select([
        "id",
        "title",
        "status",
        "trigger",
        "commit_hash",
        "log_lines",
        "container_name",
        "log_truncated",
      ])
      .where("title", "like", "Fix%")
      .orderBy("title")
      .execute();
    expect(
      deployments.map((row) => [
        row.title,
        row.status,
        row.trigger,
        row.commit_hash,
        row.log_lines,
        row.container_name,
        row.log_truncated,
      ]),
    ).toEqual([
      ["Fix the cart", "failed", "push", "a1b2c3d", 3, null, false],
      ["Fix the cart again", "previous", "manual", "d4e5f6a", 3, null, true],
    ]);
    const log = await h.db
      .selectFrom("deployment_log")
      .select("text")
      .where("deployment_id", "=", deployments[0]?.id as string)
      .orderBy("seq")
      .execute();
    expect(log.map((row) => row.text)).toEqual(["Cloning", "Building", "error: oops"]);

    expect(
      (await h.db.selectFrom("analytics_setting").select("enabled").executeTakeFirstOrThrow())
        .enabled,
    ).toBe(false);
    expect(await h.db.selectFrom("address_setting").select(["key", "value"]).execute()).toEqual([
      { key: "console_acme_email", value: "certs@example.com" },
    ]);
    expect(await h.db.selectFrom("docker_cleanup").select(["target", "enabled"]).execute()).toEqual(
      [{ target: "host", enabled: true }],
    );
    const acme = await h.db
      .selectFrom("migration_acme_state")
      .select(["target", "certificate_count"])
      .execute();
    expect(acme.map((row) => row.target).sort()).toEqual(["host", serverId].sort());
  });

  test("the move plan keeps each 0.1.x workload; never-deployed copies are left alone", async () => {
    const moves = await h.db
      .selectFrom("migration_move as m")
      .innerJoin("service as s", "s.id", "m.service_id")
      .select(["s.app_name", "m.state", "m.target", "m.legacy", "m.position"])
      .orderBy("m.position")
      .execute();
    expect(moves.map((row) => [row.app_name, row.state])).toEqual([
      ["mysql-b1c2d3", "waiting"],
      ["maria-c1d2e3", "waiting"],
      ["mongo-d1e2f3", "waiting"],
      ["cache-e1f2g3", "waiting"],
      ["edge-f1g2h3", "waiting"],
      ["monitoring-m1n2o3", "waiting"],
      ["api-x1y2z3", "waiting"],
      ["worker-u1u2u3", "waiting"],
      ["tool-h1h2h3", "waiting"],
      ["pg-a1b2c3", "waiting"],
      ["web-k3m9x2", "waiting"],
      ["web-p7q8r9", "skipped"],
    ]);
    expect(moves.find((row) => row.app_name === "web-k3m9x2")?.legacy).toEqual({
      kind: "swarm-service",
      name: "web-k3m9x2",
    });
    expect(moves.find((row) => row.app_name === "monitoring-m1n2o3")?.legacy).toEqual({
      kind: "compose-project",
      name: "monitoring-m1n2o3",
    });
    const servers = await h.db
      .selectFrom("migration_server_move")
      .select(["target", "position", "legacy"])
      .orderBy("position")
      .execute();
    expect(servers).toEqual([
      { target: "host", position: 1, legacy: null },
      {
        target: serverId,
        position: 2,
        legacy: [{ kind: "swarm-service", name: "nearzero-router" }],
      },
    ]);
    expect(
      (await h.db.selectFrom("migration_state").select("phase").executeTakeFirstOrThrow()).phase,
    ).toBe("imported");
  });

  test("importing the same bundle again changes nothing", async () => {
    const before = await counts();
    const again = await importBundle(h.services, bundle, { dryRun: false, inPlace: true });
    expect(again.importId).toBeNull();
    expect(again.moves).toBe(0);
    for (const [kind, value] of Object.entries(again.report.counts)) {
      expect([kind, value.imported]).toEqual([kind, 0]);
      expect([kind, value.alreadyImported + value.notImported]).toEqual([kind, value.inBundle]);
    }
    expect(await counts()).toEqual(before);
    expect(await count("migration_import")).toBe(1);
    const dry = await importBundle(h.services, bundle, { dryRun: true, inPlace: true });
    expect(dry.report.counts.services).toEqual({
      inBundle: 12,
      imported: 0,
      alreadyImported: 12,
      notImported: 0,
    });
  });
});

describe("after the import", () => {
  test("people sign in with their old passwords, which are then re-hashed with argon2id", async () => {
    const bob = h.browser();
    expect(
      (await bob.post("/auth/sign-in", { email: "bob@example.com", password: "wrong-password" }))
        .status,
    ).toBe(401);
    const signedIn = await bob.post("/auth/sign-in", {
      email: "bob@example.com",
      password: PASSWORDS.bob,
    });
    expect(signedIn.body.status).toBe("signed_in");
    const row = await h.db
      .selectFrom("person")
      .select("password_hash")
      .where("email", "=", "bob@example.com")
      .executeTakeFirstOrThrow();
    expect(row.password_hash?.startsWith("$argon2id$")).toBe(true);
    expect(
      (
        await h
          .browser()
          .post("/auth/sign-in", { email: "bob@example.com", password: PASSWORDS.bob })
      ).body.status,
    ).toBe("signed_in");

    // Carol's hash is scrypt as 29a.5.1 declares it (NFKC, the salt's hex text as bytes).
    const carol = await h
      .browser()
      .post("/auth/sign-in", { email: "carol@example.com", password: PASSWORDS.carol });
    expect(carol.body.status).toBe("signed_in");
    expect(
      (await h.browser().post("/auth/sign-in", { email: "dave@example.com", password: "password" }))
        .status,
    ).toBe(401);
  });

  test("two-factor works unchanged: the authenticator, then a backup code as it was shown", async () => {
    const alice = h.browser();
    const first = await alice.post("/auth/sign-in", {
      email: "alice@example.com",
      password: PASSWORDS.alice,
    });
    expect(first.body.status).toBe("two_factor_required");
    const step = Math.floor(Date.now() / 30_000);
    const done = await alice.post("/auth/two-factor", { code: totpCode(TOTP_BASE32, step) });
    expect(done.body.status).toBe("signed_in");
    const again = h.browser();
    await again.post("/auth/sign-in", { email: "alice@example.com", password: PASSWORDS.alice });
    // Typed in lower case; it was shown in capitals.
    expect(
      (await again.post("/auth/two-factor", { code: BACKUP_CODE.toLowerCase() })).body.status,
    ).toBe("signed_in");
    const reused = h.browser();
    await reused.post("/auth/sign-in", { email: "alice@example.com", password: PASSWORDS.alice });
    expect((await reused.post("/auth/two-factor", { code: BACKUP_CODE })).status).toBe(401);
  });

  test("the old deploy webhook's secret still reaches its service; others are refused", async () => {
    const browser = h.browser();
    const ok = await browser.post(`/webhooks/deploy/${WEBHOOK_TOKEN}`, {});
    expect([200, 202]).toContain(ok.status);
    const web = await id("service", "app_name", "web-k3m9x2");
    const row = await h.db
      .selectFrom("deploy_webhook")
      .select("last_called_at")
      .where("service_id", "=", web)
      .executeTakeFirstOrThrow();
    expect(row.last_called_at).not.toBeNull();
    expect(
      (await browser.post("/webhooks/deploy/old-webhook-secret-0123456789abcdeX", {})).status,
    ).toBe(401);
  });
});
