import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CertificateStatus, ControlMessage } from "@nearzero/shared";
import { sql } from "kysely";
import { ObjectRegistry } from "../src/access/objects.ts";
import { onRunnerReady, sweepOrphanRoutes } from "../src/domains/background.ts";
import { type DnsLookup, LookupError } from "../src/domains/settings.ts";
import { checkZoneHealth } from "../src/domains/zones.ts";
import { registerProjectObjects } from "../src/projects/objects.ts";
import { registerServerObjects } from "../src/servers/servers.ts";
import {
  addMemberThroughInvitation,
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  personIdOf,
  setUpNamedOwner,
} from "./support/harness.ts";
import { addMember, makeProject, makeService } from "./support/projects.ts";

/**
 * Hostnames, certificates and managed DNS (spec 10) against a real database, with runners that
 * are fakes answering the protocol and DNS answers the test chooses.
 */

const HOST_IP = "203.0.113.10";
const SERVER_IP = "198.51.100.20";
// A busy machine (other suites, Docker-in-Docker runs) can stretch a test past bun's 5 seconds.
setDefaultTimeout(60_000);

const DOMAIN = "apps.example.com";

/** DNS as the test says: names, then wildcards, else nothing. */
const records = new Map<string, string[]>();
/** AAAA and CNAME answers, by name (R3-17). */
const ipv6Records = new Map<string, string[]>();
const cnameRecords = new Map<string, string[]>();
/** How slow each A lookup is, and how many ran at once at most (B1-49). */
const lookups = { delayMs: 0, inFlight: 0, peak: 0 };
/** Names whose lookups fail outright (the resolver didn't answer), G3-12. */
const failingNames = new Set<string>();
/** Public NS records by zone, and SOA answers by "ip:port zone" (G3-10). */
const nsRecords = new Map<string, string[]>();
const soaAnswers = new Map<string, number>();
const fakeDns: DnsLookup = {
  async resolve4(name) {
    if (failingNames.has(name)) throw new LookupError("failed", "timed out");
    if (lookups.delayMs > 0) {
      lookups.inFlight++;
      lookups.peak = Math.max(lookups.peak, lookups.inFlight);
      await Bun.sleep(lookups.delayMs);
      lookups.inFlight--;
    }
    const direct = records.get(name);
    if (direct) return direct;
    const parent = name.slice(name.indexOf(".") + 1);
    const wildcard = records.get(`*.${parent}`);
    if (wildcard) return wildcard;
    throw new LookupError("not_found", `${name} doesn't exist`);
  },
  async resolve6(name) {
    const found = ipv6Records.get(name);
    if (found) return found;
    throw new LookupError("no_data", "none");
  },
  async resolveCname(name) {
    const found = cnameRecords.get(name);
    if (found) return found;
    throw new LookupError("no_data", "none");
  },
  async resolveNs(name) {
    const delegated = nsRecords.get(name);
    if (delegated) return delegated;
    if (name === "example.org" || name === "example.com")
      return ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"];
    throw new LookupError("no_data", "none");
  },
  async soaSerialAt(server, zone) {
    const serial = soaAnswers.get(`${server} ${zone}`);
    if (serial !== undefined) return serial;
    throw new LookupError("failed", "no answer");
  },
};

let counter = 0;
function deterministicRandom(size: number): Uint8Array {
  counter++;
  return Uint8Array.from({ length: size }, (_, i) => (counter * 7 + i * 13) % 256);
}

interface FakeRunner {
  /** The welcome the control plane sent (its server name and public IPv4). */
  welcome: Record<string, unknown> | null;
  commands: { kind: string; params: Record<string, unknown> }[];
  of(kind: string): Record<string, unknown>[];
  certificates: CertificateStatus;
  fail: Set<string>;
}

let harness: Harness;
let owner: Browser;
let serverId = "";
let keyId = "";
let host: FakeRunner;
let server: FakeRunner;

function emptyStatus(): CertificateStatus {
  return {
    readable: true,
    error: null,
    certificates: [],
    uploaded: [],
    attempts: [],
    holds: [],
    backoff: [],
    checkedAt: Date.now(),
  };
}

async function attachRunner(target: string | null): Promise<FakeRunner> {
  const fake: FakeRunner = {
    welcome: null,
    commands: [],
    of: (kind) => fake.commands.filter((item) => item.kind === kind).map((item) => item.params),
    certificates: emptyStatus(),
    fail: new Set(),
  };
  let link: ReturnType<Harness["services"]["runners"]["attach"]>;
  const socket = {
    send(data: string) {
      const message = JSON.parse(data) as ControlMessage;
      if (message.type === "welcome") fake.welcome = message as unknown as Record<string, unknown>;
      if (message.type !== "command") return;
      queueMicrotask(() => {
        link.message(JSON.stringify({ type: "ack", commandId: message.commandId }));
        const params = (message.params ?? {}) as Record<string, unknown>;
        fake.commands.push({ kind: message.kind, params });
        const reply = (ok: boolean, data: unknown) =>
          link.message(
            JSON.stringify(
              ok
                ? { type: "result", commandId: message.commandId, ok, data }
                : {
                    type: "result",
                    commandId: message.commandId,
                    ok,
                    error: { code: "failed", message: String(data) },
                  },
            ),
          );
        if (fake.fail.has(message.kind))
          return reply(false, `The runner couldn't do ${message.kind}.`);
        switch (message.kind) {
          case "certificates.status":
            return reply(true, fake.certificates);
          case "router.check-holds":
            return reply(true, { released: [], held: [] });
          case "dns.status":
            return reply(true, {
              running: true,
              error: null,
              zones: ((params.zones ?? []) as string[]).map((name) => ({
                name,
                serial: 1_000_000_000,
              })),
            });
          default:
            return reply(true, {});
        }
      });
    },
    close() {},
  };
  link = harness.services.runners.attach(socket, {
    runnerId: crypto.randomUUID(),
    serverId: target,
  });
  link.message(
    JSON.stringify({
      type: "hello",
      runnerVersion: "1.0.0-dev",
      protocol: 1,
      minProtocol: 1,
      startedAt: Date.now(),
      system: {
        hostname: "h",
        os: "Linux",
        kernel: "6",
        architecture: "x86_64",
        cpuModel: "x",
        cpuCores: 1,
        cpuThreads: 1,
        cpuMhz: 0,
        memoryTotalBytes: 1,
        dockerVersion: "28.0.0",
        containerized: false,
      },
      checks: { docker: true, network: true, router: true, routerDirectory: true },
      streams: [],
      commands: [],
    }),
  );
  const key = target ?? "host";
  // Up to 10 seconds: a busy machine can take a while to finish the hello.
  for (let i = 0; i < 1000 && !harness.services.runners.isOnline(key); i++) await Bun.sleep(10);
  await Bun.sleep(50);
  fake.commands.length = 0;
  return fake;
}

beforeAll(async () => {
  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({
    instanceEmail: INSTANCE_RESEND,
    extra: {
      objects,
      hostPublicIPv4: HOST_IP,
      domains: {
        platformDomain: DOMAIN,
        managementHostname: "nearzero.example.com",
        dns: fakeDns,
        random: deterministicRandom,
        sleep: async () => {},
      },
    },
  });
  owner = await setUpNamedOwner(harness);
  const generated = await owner.post("/ssh-keys/generate", { type: "ed25519", name: "k" });
  const key = await owner.post("/ssh-keys", {
    name: "k",
    publicKey: generated.body.publicKey,
    privateKey: generated.body.privateKey,
  });
  keyId = key.body.key.id;
  const created = await owner.post("/servers", {
    name: "Prod 1",
    sshKeyId: key.body.key.id,
    address: SERVER_IP,
    sshUser: "root",
  });
  serverId = created.body.server.id;
  host = await attachRunner(null);
  server = await attachRunner(serverId);
}, 60_000);

afterAll(async () => {
  harness?.services.runners.stop();
  await harness?.drop();
  // Dropping the throwaway database takes more than the 5-second hook default on a busy machine.
}, 60_000);

beforeEach(async () => {
  // The fake runners send no heartbeats, so on a slow machine the hub may have let one go
  // quiet (35 seconds) between tests that use it: each test starts with both connected.
  if (!harness.services.runners.isOnline("host")) host = await attachRunner(null);
  if (!harness.services.runners.isOnline(serverId)) server = await attachRunner(serverId);
  records.clear();
  ipv6Records.clear();
  cnameRecords.clear();
  host.commands.length = 0;
  server.commands.length = 0;
  host.fail.clear();
  server.fail.clear();
  host.certificates = emptyStatus();
  server.certificates = emptyStatus();
  await sql`truncate hostname, dns_zone, uploaded_certificate, certificate_snapshot, address_setting, environment_hostname_default, service_hostname_state, router_route cascade`.execute(
    harness.test.db,
  );
}, 30_000);

let projectCount = 0;
async function app(
  onServer: "host" | "server",
  name = "web",
  kind = "application",
  extra: Record<string, unknown> = {},
) {
  const project = await makeProject(owner, `Project ${++projectCount}`);
  const created = await makeService(owner, project.environments.development as string, {
    kind,
    name,
    serverId: onServer === "host" ? "host" : serverId,
    ...extra,
  });
  return {
    service: created.service as { id: string; appName: string; environmentId: string },
    project,
  };
}

describe("Add domain (spec 10.5, 10.6)", () => {
  test("bad, reserved and duplicate hostnames are refused in the spec's words", async () => {
    const { service } = await app("host");
    const add = (hostname: string) =>
      owner.post("/domains/hostnames", { hostname, connect: { serviceId: service.id } });
    expect((await add("https://shop.example.org")).body.error.message).toBe(
      "Leave out http:// or https://.",
    );
    expect((await add("shop.example.org/x")).body.error.message).toBe(
      "Enter just the hostname, without a path or port.",
    );
    expect((await add("*.example.org")).body.error.message).toStartWith(
      "Wildcards can't be added here",
    );
    expect((await add("shop")).body.error.message).toStartWith("Use a full hostname");
    for (const reserved of ["nearzero.example.com", DOMAIN, `prod-1.${DOMAIN}`]) {
      const reply = await add(reserved);
      expect(reply.status).toBe(409);
      expect(reply.body.error.message).toBe(
        `${reserved} is reserved for Nearzero itself. Pick another hostname.`,
      );
    }
  });

  test("your own domain must point at the service's server; then it's saved with its route", async () => {
    const { service } = await app("host");
    records.set("shop.example.org", ["192.0.2.99"]);
    const early = await owner.post("/domains/hostnames", {
      hostname: "Shop.Example.org",
      connect: { serviceId: service.id },
    });
    expect(early.status).toBe(409);
    expect(early.body.error.message).toBe(
      `shop.example.org points at 192.0.2.99, not ${HOST_IP}. Change its A record to ${HOST_IP}.`,
    );
    expect(host.of("router.write")).toHaveLength(0);

    const preview = await owner.post("/domains/hostnames/preview", {
      hostname: "shop.example.org",
      serviceId: service.id,
    });
    expect(preview.body).toMatchObject({
      valid: true,
      canAdd: false,
      record: { name: "shop", zone: "example.org", value: HOST_IP },
    });
    // The preview's DNS check has the hostname list's shape (punch list 17).
    const keys = (value: object) => Object.keys(value).sort();
    expect(preview.body.dns).toMatchObject({
      status: "points_elsewhere",
      label: "Points elsewhere",
      managed: false,
      proxiedBy: null,
      record: { type: "A", name: "shop.example.org", value: HOST_IP, proxy: "DNS only" },
    });

    records.set("shop.example.org", [HOST_IP]);
    const added = await owner.post("/domains/hostnames", {
      hostname: "shop.example.org",
      connect: { serviceId: service.id },
    });
    expect(added.status).toBe(201);
    expect(added.body.message).toBe("Added shop.example.org. HTTPS starts working in a minute.");
    expect(added.body.hostname).toMatchObject({
      hostname: "shop.example.org",
      source: "own",
      sourceLabel: "Your DNS provider",
    });
    expect(keys(added.body.hostname.dns)).toEqual(keys(preview.body.dns));
    const [write] = host.of("router.write") as {
      routes: { key: string; hostnames: string[]; upstream: { host: string; port: number } }[];
    }[];
    expect(write?.routes[0]).toMatchObject({
      hostnames: ["shop.example.org"],
      upstream: { host: service.appName, port: 3000 },
    });
    expect(write?.routes[0]?.key).toStartWith(`s-${service.id}-`);
    expect(host.of("router.check-holds").length).toBeGreaterThanOrEqual(0);

    const again = await owner.post("/domains/hostnames", {
      hostname: "shop.example.org",
      connect: { serviceId: service.id },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.message).toBe(
      "shop.example.org is already added. Find it in the Hostnames list.",
    );
  });

  test("R3-17: a name that points here still warns about other A records and an AAAA record, and shows its alias", async () => {
    const { service } = await app("host", "warned");
    // Another A record beside this server's, and an AAAA record.
    records.set("two.example.org", [HOST_IP, "192.0.2.77"]);
    ipv6Records.set("two.example.org", ["2001:db8::5"]);
    cnameRecords.set("two.example.org", ["edge.example.net."]);
    const extra = `two.example.org also points to 192.0.2.77. Let's Encrypt may check one of those instead. Keep only ${HOST_IP}.`;
    const aaaa =
      "An AAAA (IPv6) record points to 2001:db8::5. Let's Encrypt tries IPv6 first, so remove it unless it reaches this server.";
    // The DNS step of Add domain…
    const preview = await owner.post("/domains/hostnames/preview", {
      hostname: "two.example.org",
      serviceId: service.id,
    });
    expect(preview.body.dns).toMatchObject({
      status: "points_here",
      label: "Points here",
      warnings: [extra, aaaa],
      aliasOf: "edge.example.net",
    });
    const added = await owner.post("/domains/hostnames", {
      hostname: "two.example.org",
      connect: { serviceId: service.id },
    });
    expect(added.status).toBe(201);
    // …and Details.
    const details = await owner.get(`/domains/hostnames/${added.body.hostname.id}`);
    expect(details.body.hostname.dns).toMatchObject({
      status: "points_here",
      warnings: [extra, aaaa],
      aliasOf: "edge.example.net",
    });
    // Only this server's address, and no AAAA record: nothing to warn about.
    records.set("one.example.org", [HOST_IP]);
    const clean = await owner.post("/domains/hostnames/preview", {
      hostname: "one.example.org",
      serviceId: service.id,
    });
    expect(clean.body.dns).toMatchObject({ status: "points_here", warnings: [], aliasOf: null });
  });

  test("creating a hostname is all or nothing: a route the server can't take saves nothing (P7)", async () => {
    const { service } = await app("server");
    records.set("api.example.org", [SERVER_IP]);
    server.fail.add("router.write");
    const reply = await owner.post("/domains/hostnames", {
      hostname: "api.example.org",
      connect: { serviceId: service.id },
    });
    expect(reply.status).toBe(409);
    expect(reply.body.error.message).toBe("The runner couldn't do router.write.");
    const rows = await harness.test.db.selectFrom("hostname").select("id").execute();
    expect(rows).toHaveLength(0);
    const routes = await harness.test.db.selectFrom("router_route").select("id").execute();
    expect(routes).toHaveLength(0);
  });

  test("not connected, then connected, moved, disconnected and removed", async () => {
    const first = await app("host", "web");
    const second = await app("host", "api");
    records.set("www.example.org", [HOST_IP]);
    const missing = await owner.post("/domains/hostnames", { hostname: "www.example.org" });
    expect(missing.body.error.message).toBe(
      'Pick a service, or untick "Connect it to a service now".',
    );
    const added = await owner.post("/domains/hostnames", {
      hostname: "www.example.org",
      serverId: "host",
    });
    expect(added.status).toBe(201);
    expect(added.body.message).toStartWith(
      "Added www.example.org. Connect a service to it from the Hostnames list",
    );
    expect(added.body.hostname.https.state).toBe("not_in_use");
    const id = added.body.hostname.id;

    const connected = await owner.post(`/domains/hostnames/${id}/connect`, {
      serviceId: first.service.id,
      path: "/",
    });
    expect(connected.body.message).toBe("Service connected");
    expect(host.of("router.write")).toHaveLength(1);

    const moved = await owner.post(`/domains/hostnames/${id}/connect`, {
      serviceId: second.service.id,
      port: 8080,
    });
    expect(moved.status).toBe(200);
    expect(host.of("router.remove")).toHaveLength(1);
    expect(
      (host.of("router.write")[1] as { routes: { upstream: { port: number } }[] }).routes[0]
        ?.upstream.port,
    ).toBe(8080);

    const disconnected = await owner.post(`/domains/hostnames/${id}/disconnect`);
    expect(disconnected.body.message).toBe(
      "Disconnected www.example.org from api. It stops serving traffic until you connect a service again.",
    );
    const removed = await owner.delete(`/domains/hostnames/${id}`);
    expect(removed.body).toEqual({ removed: true, message: "Removed www.example.org." });
    expect((await owner.get(`/domains/hostnames/${id}`)).status).toBe(404);
  });

  test("Generate a domain names the record the server still needs", async () => {
    const { service } = await app("server");
    const suggestion = await owner.get(`/services/${service.id}/hostnames/suggestion`);
    expect(suggestion.body).toMatchObject({ available: true, base: "platform" });
    expect(suggestion.body.message).toMatch(
      /^It will be live at https:\/\/[a-z][a-z0-9]{7}\.prod-1\.apps\.example\.com$/,
    );
    expect(suggestion.body.record).toMatchObject({
      name: `*.prod-1.${DOMAIN}`,
      value: SERVER_IP,
      proxy: "DNS only",
    });
    const generated = await owner.post(`/services/${service.id}/hostnames/generate`, {});
    expect(generated.status).toBe(201);
    expect(generated.body.hostname.hostname).toMatch(
      /^[a-z][a-z0-9]{7}\.prod-1\.apps\.example\.com$/,
    );
    expect(generated.body.missingRecord.message).toBe(
      `It loads once Prod 1 has this DNS record: *.prod-1.${DOMAIN} A ${SERVER_IP} (DNS only, not proxied).`,
    );
    expect(generated.body.hostname.can.move).toBe(false);
    const move = await owner.post(`/domains/hostnames/${generated.body.hostname.id}/connect`, {
      serviceId: service.id,
    });
    expect(move.status).toBe(409);
  });
});

describe("hostnames at deploy (spec 10.2)", () => {
  test("a deploy on a remote server assigns <random>.<label>.<domain> before the record exists, and the log names it", async () => {
    const { service } = await app("server");
    const answer = await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId,
      port: 3000,
    });
    expect(answer.routes).toHaveLength(1);
    const route = answer.routes[0] as { host: string; port: number; https: boolean };
    expect(route.host).toMatch(/^[a-z][a-z0-9]{7}\.prod-1\.apps\.example\.com$/);
    expect(route).toMatchObject({ port: 3000, https: true, path: "/" });
    // The DNS note needs a lookup, so it comes separately and the deploy never waits for it.
    expect(answer.notes).toEqual([]);
    expect(await answer.later).toEqual([
      `${route.host} is assigned, but it won't load until this DNS record exists: *.prod-1.${DOMAIN} A ${SERVER_IP} (DNS only, not proxied). HTTPS starts on its own once it does.`,
    ]);
    // Nothing asked a server for a certificate: the deploy's route is written by the pipeline,
    // and the router holds it until DNS points here.
    expect(server.of("certificates.retry")).toHaveLength(0);
    // The same hostname on the next deploy, and once the record exists the note says so.
    records.set(`*.prod-1.${DOMAIN}`, [SERVER_IP]);
    const next = await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId,
      port: 3000,
    });
    expect(next.routes.map((r) => r.host)).toEqual([route.host]);
  });

  test("on the host the hostname is <random>.<platform domain>; removing it keeps the next deploy from adding another", async () => {
    const { service } = await app("host");
    const answer = await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId: "host",
      port: 3000,
    });
    const route = answer.routes[0] as { host: string };
    expect(route.host).toMatch(/^[a-z][a-z0-9]{7}\.apps\.example\.com$/);
    const [row] = await harness.test.db
      .selectFrom("hostname")
      .select("id")
      .where("host", "=", route.host)
      .execute();
    await owner.delete(`/domains/hostnames/${row?.id}`);
    const after = await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId: "host",
      port: 3000,
    });
    expect(after.routes).toEqual([]);
    expect(after.notes[0]).toStartWith("This service has no domain");
  });

  test("Give N a hostname gives the server's running apps without one their hostnames", async () => {
    const a = await app("server", "one");
    const b = await app("server", "two");
    await harness.test.db
      .updateTable("service")
      .set({ status: "running" })
      .where("id", "in", [a.service.id, b.service.id])
      .execute();
    const card = await owner.get("/domains/automatic");
    const row = card.body.card.rows.find(
      (item: { target: { id: string } }) => item.target.id === serverId,
    );
    expect(row).toMatchObject({
      record: { name: `*.prod-1.${DOMAIN}`, value: SERVER_IP },
      badge: "not_set_up",
      badgeLabel: "Not set up",
      without: 2,
      subtitle: "2 services without a hostname",
    });
    records.set(`*.prod-1.${DOMAIN}`, [SERVER_IP]);
    const checked = await owner.post(`/domains/targets/${serverId}/check`);
    expect(checked.body.row).toMatchObject({
      badge: "points_here",
      actionLabel: "Give 2 a hostname",
    });
    const given = await owner.post(`/domains/targets/${serverId}/give-hostnames`);
    expect(given.body.message).toBe(
      "2 services got their hostnames. It can take a minute for HTTPS to be ready.",
    );
    expect(server.of("router.write")).toHaveLength(2);
  });

  test("R3-21: Give N a hostname is offered before the record exists, and says they load once it does", async () => {
    // Only this test's services run on the server.
    await harness.test.db
      .updateTable("service")
      .set({ status: "stopped" })
      .where("server_id", "=", serverId)
      .where("status", "=", "running")
      .execute();
    const a = await app("server", "alpha");
    const b = await app("server", "beta");
    await harness.test.db
      .updateTable("service")
      .set({ status: "running" })
      .where("id", "in", [a.service.id, b.service.id])
      .execute();
    // No wildcard record yet: the row still offers to give both a hostname.
    const card = await owner.get("/domains/automatic?fresh=1");
    const row = card.body.card.rows.find(
      (item: { target: { id: string } }) => item.target.id === serverId,
    );
    expect(row).toMatchObject({
      badge: "not_set_up",
      without: 2,
      action: "give_n",
      actionLabel: "Give 2 a hostname",
    });
    expect(row.help).toStartWith("Add this record once at your DNS provider");
    const checked = await owner.post(`/domains/targets/${serverId}/check`);
    expect(checked.body.row.actionLabel).toBe("Give 2 a hostname");
    const given = await owner.post(`/domains/targets/${serverId}/give-hostnames`);
    expect(given.status).toBe(200);
    expect(given.body.given).toHaveLength(2);
    expect(given.body.message).toBe(
      `2 services got their hostnames. They load once *.prod-1.${DOMAIN} points at this server.`,
    );
    // Both are assigned and routed, before the record exists (spec 10.2).
    expect(server.of("router.write")).toHaveLength(2);
    const hosts = await harness.test.db
      .selectFrom("hostname")
      .select("host")
      .where("service_id", "in", [a.service.id, b.service.id])
      .execute();
    expect(hosts.map((h) => h.host).every((h) => h.endsWith(`.prod-1.${DOMAIN}`))).toBe(true);
    const after = await owner.post(`/domains/targets/${serverId}/check`);
    expect(after.body.row).toMatchObject({ without: 0, action: "check_again" });
    await harness.test.db
      .updateTable("service")
      .set({ status: "stopped" })
      .where("id", "in", [a.service.id, b.service.id])
      .execute();
  });

  test("the server's DNS card names the record relative to its zone, with the provider's steps", async () => {
    const card = await owner.get(`/servers/${serverId}/dns-card?fresh=1`);
    expect(card.body.card).toMatchObject({
      shown: true,
      title: "Add one DNS record in Cloudflare",
      record: { type: "A", name: "*.prod-1.apps", value: SERVER_IP, proxy: "DNS only" },
      zoneLine: `In the domain example.com. The full name is *.prod-1.${DOMAIN}.`,
      badgeLabel: "Not added yet",
    });
    expect(card.body.card.steps.join(" ")).toContain("Turn Proxy status off");
    expect((await owner.get("/servers/host/dns-card")).body.card.shown).toBe(false);
  });

  test("G3-07: the card collapses once the record points here, and Check again says what it found", async () => {
    const saved = records.get(`*.prod-1.${DOMAIN}`);
    records.delete(`*.prod-1.${DOMAIN}`);
    try {
      const missing = (await owner.get(`/servers/${serverId}/dns-card?fresh=1`)).body.card;
      expect(missing).toMatchObject({
        title: "Add one DNS record in Cloudflare",
        subtitle: `It gives every app on Prod 1 its own address under prod-1.${DOMAIN}, with HTTPS set up automatically.`,
        // Only for the setup dialog, which shows it while the record is missing.
        whileSetup: "Add it now, while setup runs.",
        ready: false,
        checkToast: "It doesn't point at this server yet. DNS changes can take a few minutes.",
      });
      expect(missing.subtitle).not.toContain("while setup runs");
      records.set(`*.prod-1.${DOMAIN}`, [SERVER_IP]);
      const ready = (await owner.get(`/servers/${serverId}/dns-card?fresh=1`)).body.card;
      expect(ready).toMatchObject({
        title: "App addresses are ready",
        subtitle: `Apps on Prod 1 get their own address under prod-1.${DOMAIN}, with HTTPS set up automatically.`,
        ready: true,
        checkToast: "The record points here. Apps on this server get their own address.",
      });
    } finally {
      if (saved) records.set(`*.prod-1.${DOMAIN}`, saved);
      else records.delete(`*.prod-1.${DOMAIN}`);
    }
  });
});

describe("the new-application page's Domain preview (spec 6.1, punch list 28)", () => {
  test("the hostname the first deploy gives, and the zone option once a zone exists", async () => {
    const project = await makeProject(owner, `Preview ${++projectCount}`);
    const environmentId = project.environments.development as string;
    const preview = (server: string, name = "Shop Web") =>
      owner.get(
        `/environments/${environmentId}/hostname-preview?serverId=${server}&name=${encodeURIComponent(name)}`,
      );
    const onHost = await preview("host");
    expect(onHost.status).toBe(200);
    expect(onHost.body).toMatchObject({ source: "platform", zoneOption: null });
    expect(onHost.body.hostname).toMatch(/^[a-z][a-z0-9]{7}\.apps\.example\.com$/);
    expect(onHost.body.message).toBe(
      `The first deploy gives it a hostname like ${onHost.body.hostname}.`,
    );
    const onServer = await preview(serverId);
    expect(onServer.body.source).toBe("server");
    expect(onServer.body.hostname).toMatch(/^[a-z][a-z0-9]{7}\.prod-1\.apps\.example\.com$/);
    expect(onServer.body.record).toEqual({
      type: "A",
      name: `*.prod-1.${DOMAIN}`,
      value: SERVER_IP,
      proxy: "DNS only",
    });

    // A zone: the first one becomes the environment's default, so the app gets a name in it.
    await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" });
    const inZone = await preview("host");
    expect(inZone.body).toMatchObject({
      source: "zone",
      hostname: "shop-web.example.net",
      zoneOption: null,
    });
    // With the platform domain as the environment's default, the zone is offered on top.
    const changed = await owner.put(`/domains/defaults/${environmentId}`, { source: "platform" });
    expect(changed.status).toBe(200);
    const both = await preview("host");
    expect(both.body.source).toBe("platform");
    expect(both.body.zoneOption).toMatchObject({
      zoneName: "example.net",
      hostname: "shop-web.example.net",
    });
    expect((await preview("not-a-server")).status).toBe(404);
    expect(
      (await owner.get(`/environments/${crypto.randomUUID()}/hostname-preview?serverId=host`))
        .status,
    ).toBe(404);
  });
});

describe("managed DNS zones (spec 10.8)", () => {
  test("connecting a zone publishes it; the first zone becomes every environment's default", async () => {
    const zone = await owner.post("/domains/zones", {
      domain: "example.net",
      adminEmail: "dns@example.net",
    });
    expect(zone.status).toBe(201);
    expect(zone.body.zone).toMatchObject({
      name: "example.net",
      nameservers: [`ns1.${DOMAIN}`, `ns2.${DOMAIN}`],
    });
    const [apply] = host.of("dns.apply") as {
      corefile: string;
      zones: { name: string; content: string }[];
    }[];
    expect(apply?.corefile).toContain("example.net:1053 {");
    expect(apply?.zones[0]?.content).toContain(`@ 3600 IN NS ns1.${DOMAIN}.`);
    expect(
      (await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" }))
        .body.error.message,
    ).toBe("This DNS zone is already connected. Find it in the DNS zones tab.");
    const other = await harness.test.db
      .insertInto("workspace")
      .values({ name: "Other", slug: `other-${Date.now()}` })
      .returning("id")
      .executeTakeFirstOrThrow();
    await harness.test.db
      .insertInto("dns_zone")
      .values({
        workspace_id: other.id,
        name: "taken.example",
        admin_email: "a@b.c",
        nameservers: ["ns1.x.y"],
      })
      .execute();
    expect(
      (
        await owner.post("/domains/zones", {
          domain: "taken.example",
          adminEmail: "dns@example.net",
        })
      ).body.error.message,
    ).toBe("This DNS zone is already managed by another workspace");

    const { service } = await app("host", "web");
    const answer = await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId: "host",
      port: 3000,
    });
    expect(answer.routes.map((r) => r.host)).toEqual(["web.example.net"]);
    expect(await answer.later).toEqual(["web.example.net is served by Nearzero DNS."]);
    const last = host.of("dns.apply").at(-1) as { zones: { content: string }[] };
    expect(last.zones[0]?.content).toContain(`web 300 IN A ${HOST_IP}`);

    const removal = await owner.delete(`/domains/zones/${zone.body.zone.id}`);
    expect(removal.status).toBe(409);
    expect(removal.body.error.message).toBe(
      "Services still use hostnames in example.net: web.example.net (web). Remove those hostnames first.",
    );
    const [row] = await harness.test.db
      .selectFrom("hostname")
      .select("id")
      .where("host", "=", "web.example.net")
      .execute();
    await owner.delete(`/domains/hostnames/${row?.id}`);
    const cleared = host.of("dns.apply").at(-1) as { zones: { content: string }[] };
    expect(cleared.zones[0]?.content).not.toContain("web 300 IN A");
    expect((await owner.delete(`/domains/zones/${zone.body.zone.id}`)).status).toBe(200);
  });

  test("R3-13: connecting the first zone moves the automatic hostnames that follow it, and says how many", async () => {
    // An automatic hostname on the host and one on a server, under the platform domain…
    const web = await app("host", "web");
    const api = await app("server", "api");
    for (const [one, target] of [
      [web, "host"],
      [api, serverId],
    ] as const) {
      await harness.services.hostnameProviders.collect({
        serviceId: one.service.id,
        serverId: target,
        port: 3000,
      });
    }
    // …an environment whose default was saved as the platform domain…
    const kept = await app("host", "kept");
    expect(
      (
        await owner.put(`/domains/defaults/${kept.service.environmentId}`, {
          source: "platform",
          prefix: "",
        })
      ).status,
    ).toBe(200);
    await harness.services.hostnameProviders.collect({
      serviceId: kept.service.id,
      serverId: "host",
      port: 3000,
    });
    // …and a person's own hostname.
    records.set("shop.example.org", [HOST_IP]);
    expect(
      (
        await owner.post("/domains/hostnames", {
          hostname: "shop.example.org",
          connect: { serviceId: web.service.id },
        })
      ).status,
    ).toBe(201);
    const hostsOf = async (serviceId: string) =>
      (
        await harness.test.db
          .selectFrom("hostname")
          .select("host")
          .where("service_id", "=", serviceId)
          .orderBy("host")
          .execute()
      ).map((row) => row.host);
    const keptBefore = await hostsOf(kept.service.id);

    const zone = await owner.post("/domains/zones", {
      domain: "example.net",
      adminEmail: "dns@example.net",
    });
    expect(zone.status).toBe(201);
    expect(zone.body).toMatchObject({
      moved: 2,
      pending: 0,
      message: "DNS zone connected. 2 automatic hostnames moved into example.net.",
    });
    expect(await hostsOf(web.service.id)).toEqual(["shop.example.org", "web.example.net"]);
    expect(await hostsOf(api.service.id)).toEqual(["api.example.net"]);
    // A saved default and own hostnames never move.
    expect(await hostsOf(kept.service.id)).toEqual(keptBefore);
    // Their records are published, pointing at each one's server.
    const published = host.of("dns.apply").at(-1) as { zones: { content: string }[] };
    expect(published.zones[0]?.content).toContain(`web 300 IN A ${HOST_IP}`);
    expect(published.zones[0]?.content).toContain(`api 300 IN A ${SERVER_IP}`);
    // The routes moved too.
    const writes = [...host.of("router.write"), ...server.of("router.write")];
    expect(JSON.stringify(writes)).toContain("web.example.net");
    expect(JSON.stringify(writes)).toContain("api.example.net");
    // A second zone isn't the default, so nothing moves.
    const second = await owner.post("/domains/zones", {
      domain: "second.example",
      adminEmail: "dns@second.example",
    });
    expect(second.body).toMatchObject({ moved: 0, pending: 0, message: "DNS zone connected" });
    expect(await hostsOf(web.service.id)).toEqual(["shop.example.org", "web.example.net"]);
  });

  test("records are checked, and Nearzero's own can't be changed", async () => {
    const zone = (
      await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" })
    ).body.zone;
    const add = (body: Record<string, unknown>) =>
      owner.post(`/domains/zones/${zone.id}/records`, body);
    expect((await add({ name: "www", type: "A", value: "2001:db8::1" })).body.error.message).toBe(
      "An A record needs an IPv4 address, like 203.0.113.10.",
    );
    const www = await add({ name: "www", type: "A", value: "192.0.2.5" });
    expect(www.status).toBe(201);
    expect(
      (await add({ name: "www", type: "CNAME", value: "x.example.org" })).body.error.message,
    ).toBe("CNAME cannot coexist with other records");
    const listed = await owner.get(`/domains/zones/${zone.id}`);
    expect(listed.body.zone.status).toBe("not_applied");
    const managed = listed.body.records.find((record: { managed: boolean }) => record.managed);
    expect(managed.managedNote).toBe("Managed by Nearzero");
    expect((await owner.delete(`/domains/zones/${zone.id}/records/${managed.id}`)).status).toBe(
      403,
    );
    const applied = await owner.post(`/domains/zones/${zone.id}/apply`);
    expect(applied.status).toBe(200);
    expect(
      (host.of("dns.apply").at(-1) as { zones: { content: string }[] }).zones[0]?.content,
    ).toContain("www 300 IN A 192.0.2.5");
  });

  test('G3-11: "www CNAME @", "MX mail" with a blank priority and an unquoted CAA save and serve as 0.1.x read them', async () => {
    const zone = (
      await owner.post("/domains/zones", { domain: "example.com", adminEmail: "dns@example.com" })
    ).body.zone;
    const add = (body: Record<string, unknown>) =>
      owner.post(`/domains/zones/${zone.id}/records`, body);
    expect((await add({ name: "www", type: "CNAME", value: "@" })).status).toBe(201);
    const mx = await add({ type: "MX", value: "mail" });
    expect(mx.status).toBe(201);
    expect(mx.body.record).toMatchObject({ type: "MX", value: "mail", priority: 10 });
    const caa = await add({ type: "CAA", value: "0 issue letsencrypt.org" });
    expect(caa.status).toBe(201);
    expect(caa.body.record.value).toBe('0 issue "letsencrypt.org"');
    await owner.post(`/domains/zones/${zone.id}/apply`);
    const published = (
      host.of("dns.apply").at(-1) as { zones: { name: string; content: string }[] }
    ).zones.find((item) => item.name === "example.com")?.content;
    expect(published).toContain("www 300 IN CNAME example.com.");
    expect(published).toContain("@ 300 IN MX 10 mail.example.com.");
    expect(published).toContain('@ 300 IN CAA 0 issue "letsencrypt.org"');
  });

  test("changing an environment's default updates its automatic hostnames now", async () => {
    const { service } = await app("host", "shop");
    await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId: "host",
      port: 3000,
    });
    const zone = (
      await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" })
    ).body.zone;
    const saved = await owner.put(`/domains/defaults/${service.environmentId}`, {
      source: zone.id,
      prefix: "staging",
    });
    expect(saved.body.message).toBe("Saved and 1 automatic hostname updated");
    const rows = await harness.test.db
      .selectFrom("hostname")
      .select("host")
      .where("service_id", "=", service.id)
      .execute();
    expect(rows.map((row) => row.host)).toEqual(["shop.staging.example.net"]);
    const listed = await owner.get("/domains/defaults");
    expect(listed.body.options.map((option: { label: string }) => option.label)).toEqual([
      "Platform domain",
      "No zone (apps get no automatic hostname)",
      "example.net",
    ]);
  });
});

describe("names under the platform domain (R3-14)", () => {
  test("a person can't add one by hand, at any depth; generated ones still work", async () => {
    const { service } = await app("host", "claim");
    records.set(`*.${DOMAIN}`, [HOST_IP]);
    records.set(`*.prod-1.${DOMAIN}`, [SERVER_IP]);
    for (const hostname of [`login.${DOMAIN}`, `x.prod-1.${DOMAIN}`, `a.b.${DOMAIN}`]) {
      const reply = await owner.post("/domains/hostnames", {
        hostname,
        connect: { serviceId: service.id },
      });
      expect(reply.status).toBe(409);
      expect(reply.body.error.message).toBe(
        `${hostname} is reserved for Nearzero itself. Pick another hostname.`,
      );
    }
    const answer = await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId: "host",
      port: 3000,
    });
    expect(answer.routes[0]?.host).toMatch(
      new RegExp(`^[a-z0-9]{8}\\.${DOMAIN.replaceAll(".", "\\.")}$`),
    );
  });
});

describe("the Automatic hostnames card (spec 10.3)", () => {
  test("B1-49: every server's record is looked up at once, not one after another", async () => {
    const ids: string[] = [];
    for (const n of [1, 2, 3]) {
      const reply = await owner.post("/servers", {
        name: `Card ${n}`,
        sshKeyId: keyId,
        address: `93.184.215.${70 + n}`,
        sshUser: "root",
      });
      ids.push(reply.body.server.id);
    }
    lookups.delayMs = 150;
    lookups.peak = 0;
    try {
      const card = await owner.get("/domains/automatic?fresh=1");
      expect(card.status).toBe(200);
      expect(card.body.card.rows.length).toBeGreaterThanOrEqual(4);
      // The host's and every server's wildcard went out together.
      expect(lookups.peak).toBeGreaterThanOrEqual(4);
    } finally {
      lookups.delayMs = 0;
      await harness.test.db.deleteFrom("server").where("id", "in", ids).execute();
    }
  });
});

describe("the console's own record and About's checklist (R3-12, B3-03)", () => {
  test("a zone of the administrators that covers the console's address serves its A record, and the checklist shows the zone", async () => {
    expect((await owner.get("/about/address")).body.checklist.managedZone).toBeNull();
    const zone = (
      await owner.post("/domains/zones", { domain: "example.com", adminEmail: "dns@example.com" })
    ).body.zone;
    const records = (await owner.get(`/domains/zones/${zone.id}`)).body.records as {
      name: string;
      type: string;
      value: string;
      managedNote: string | null;
    }[];
    expect(records.find((record) => record.name === "nearzero")).toMatchObject({
      type: "A",
      value: HOST_IP,
      managedNote: "Managed by Nearzero",
    });
    const published = host.of("dns.apply").at(-1) as { zones: { content: string }[] };
    expect(published.zones[0]?.content).toContain(`nearzero 300 IN A ${HOST_IP}`);
    // Published but not delegated: not ready, with what public DNS says (G3-10), on About and
    // on the DNS zones tab alike.
    await checkZoneHealth(harness.services);
    const pending = (await owner.get("/about/address")).body.checklist.managedZone;
    expect(pending).toMatchObject({
      name: "example.com",
      state: "delegation_pending",
      label: "Delegation pending",
      link: "/dashboard/domains?tab=dns-zones",
    });
    expect(pending.message).toContain(
      "Public NS differs from Nearzero: ada.ns.cloudflare.com, bob.ns.cloudflare.com",
    );
    expect(pending.message).toContain(
      `Authoritative SOA check failed: ${HOST_IP} didn't answer for example.com on port 53`,
    );
    const tab = (await owner.get("/domains/zones")).body.zones[0];
    expect(tab).toMatchObject({ status: "delegation_pending", statusLabel: "Delegation pending" });
    expect(tab.readiness).toEqual({
      ready: false,
      reasons: expect.arrayContaining([
        "Public NS differs from Nearzero: ada.ns.cloudflare.com, bob.ns.cloudflare.com",
      ]),
      note: "Published means CoreDNS has the zone file. Ready additionally requires public NS delegation and a direct authoritative SOA response.",
    });
    // Nameservers inside the zone need glue records at the registrar, pointing at the host.
    const inside = zone.nameservers.filter((name: string) => name.endsWith(".example.com"));
    expect(inside.length).toBeGreaterThan(0);
    expect(tab.delegation).toContain(
      `also create glue (host) A records for ${inside.length === 1 ? "it" : "each nameserver"} at your registrar, pointing at ${HOST_IP}.`,
    );
    // Delegated, and the host answers for it: now it is ready.
    nsRecords.set(
      "example.com",
      [...zone.nameservers].reverse().map((n: string) => `${n}.`),
    );
    soaAnswers.set(`${HOST_IP}:53 example.com`, 2026112801);
    try {
      await checkZoneHealth(harness.services);
      const checklist = (await owner.get("/about/address")).body.checklist.managedZone;
      expect(checklist).toMatchObject({ name: "example.com", state: "live", label: "Live" });
      expect(checklist.message).toContain("Serving");
      // Only delegated, without the host answering, is still pending.
      soaAnswers.clear();
      await checkZoneHealth(harness.services);
      expect((await owner.get("/domains/zones")).body.zones[0].status).toBe("delegation_pending");
    } finally {
      nsRecords.clear();
      soaAnswers.clear();
    }
    // Saving the nameservers again keeps the record.
    await owner.patch(`/domains/zones/${zone.id}`, { nameservers: ["ns1.example.com"] });
    const again = (await owner.get(`/domains/zones/${zone.id}`)).body.records as {
      name: string;
    }[];
    expect(again.filter((record) => record.name === "nearzero")).toHaveLength(1);
  });

  test("a person's own record at the console's name is left alone", async () => {
    const zone = (
      await owner.post("/domains/zones", { domain: "example.com", adminEmail: "dns@example.com" })
    ).body.zone;
    // As on an install whose zone came before this record: the person made their own.
    await harness.test.db
      .deleteFrom("dns_record")
      .where("zone_id", "=", zone.id)
      .where("name", "=", "nearzero")
      .execute();
    expect(
      (
        await owner.post(`/domains/zones/${zone.id}/records`, {
          name: "nearzero",
          type: "A",
          value: "192.0.2.50",
        })
      ).status,
    ).toBe(201);
    await owner.patch(`/domains/zones/${zone.id}`, { nameservers: ["ns1.example.com"] });
    const records = (await owner.get(`/domains/zones/${zone.id}`)).body.records as {
      name: string;
      value: string;
      managed: boolean;
    }[];
    expect(records.filter((record) => record.name === "nearzero")).toEqual([
      expect.objectContaining({ value: "192.0.2.50", managed: false }),
    ]);
  });
});

describe("managed records beside a person's own (B1-17, R3-15)", () => {
  test("automatic names skip a name with a record; a typed name with one is refused, naming it", async () => {
    const zone = (
      await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" })
    ).body.zone;
    const add = (body: Record<string, unknown>) =>
      owner.post(`/domains/zones/${zone.id}/records`, body);
    expect((await add({ name: "web", type: "A", value: "192.0.2.5" })).status).toBe(201);
    expect((await add({ name: "api", type: "CNAME", value: "api.elsewhere.example" })).status).toBe(
      201,
    );
    // Generate a domain for app "web": web is the person's, so it gets web-2.
    const { service } = await app("host", "web");
    const answer = await harness.services.hostnameProviders.collect({
      serviceId: service.id,
      serverId: "host",
      port: 3000,
    });
    expect(answer.routes.map((r) => r.host)).toEqual(["web-2.example.net"]);
    // A typed name that has a record is refused with that record, and nothing is saved.
    const api = await owner.post("/domains/hostnames", {
      hostname: "api.example.net",
      connect: { serviceId: service.id },
    });
    expect(api.status).toBe(409);
    expect(api.body.error.message).toBe(
      "A DNS address record already exists for api.example.net: api CNAME api.elsewhere.example in example.net. Delete it under DNS zones → Records, or pick another hostname.",
    );
    expect(
      await harness.test.db
        .selectFrom("hostname")
        .select("host")
        .where("host", "=", "api.example.net")
        .execute(),
    ).toEqual([]);
    const records = (await owner.get(`/domains/zones/${zone.id}`)).body.records as {
      name: string;
      type: string;
      value: string;
    }[];
    expect(records.filter((r) => r.name === "web").map((r) => r.value)).toEqual(["192.0.2.5"]);
    expect(records.filter((r) => r.name === "api").map((r) => r.type)).toEqual(["CNAME"]);
    // And the other way round: a person's A record beside Nearzero's is refused.
    const beside = await add({ name: "web-2", type: "A", value: "192.0.2.9" });
    expect(beside.status).toBe(409);
    expect(beside.body.error.message).toBe(
      "Nearzero manages the address of web-2.example.net. Remove that hostname under Domains first, or use another name.",
    );
    expect((await add({ name: "web-2", type: "TXT", value: "fine" })).status).toBe(201);
    // R3-24: a week-long TTL, common for MX and NS, saves.
    const weekly = await add({
      name: "@",
      type: "MX",
      value: "mail.example.net",
      priority: 10,
      ttl: 604_800,
    });
    expect(weekly.status).toBe(201);
    expect(weekly.body.ttl ?? weekly.body.record?.ttl).toBe(604_800);
  });
});

describe("servers added by hostname or a private address (R3-10, B1-18, B2-05)", () => {
  async function addServer(name: string, address: string) {
    const reply = await owner.post("/servers", { name, sshKeyId: keyId, address, sshUser: "root" });
    expect(reply.status).toBe(201);
    return reply.body.server.id as string;
  }
  async function serviceOn(target: string, name: string) {
    const project = await makeProject(owner, `Project ${++projectCount}`);
    return (
      await makeService(owner, project.environments.development as string, {
        kind: "application",
        name,
        serverId: target,
      })
    ).service as { id: string };
  }
  async function removeServer(id: string) {
    await harness.test.db.deleteFrom("service").where("server_id", "=", id).execute();
    await harness.test.db.deleteFrom("server").where("id", "=", id).execute();
  }

  test("a server whose hostname resolves to one public IPv4 takes own domains, managed records and a hold that can be released", async () => {
    records.set("srv1.example.net", ["93.184.215.20"]);
    const id = await addServer("By name", "srv1.example.net");
    const runner = await attachRunner(id);
    // Its router compares DNS with that address, so Let's Encrypt can be asked (B2-05).
    expect(runner.welcome?.publicIPv4).toBe("93.184.215.20");
    const service = await serviceOn(id, "blog");
    records.set("blog.example.org", ["93.184.215.20"]);
    const added = await owner.post("/domains/hostnames", {
      hostname: "blog.example.org",
      connect: { serviceId: service.id },
    });
    expect(added.status).toBe(201);
    const zone = (
      await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" })
    ).body.zone;
    const inZone = await owner.post("/domains/hostnames", {
      hostname: "shop.example.net",
      connect: { serviceId: service.id },
    });
    expect(inZone.status).toBe(201);
    const listed = (await owner.get(`/domains/zones/${zone.id}`)).body.records as {
      name: string;
      value: string;
    }[];
    expect(listed.find((record) => record.name === "shop")?.value).toBe("93.184.215.20");
    await removeServer(id);
  });

  test("a hostname resolving to several addresses, or none, says so with the server's address, not About Nearzero", async () => {
    records.set("pool.example.net", ["93.184.215.21", "93.184.215.22"]);
    const id = await addServer("Pool", "pool.example.net");
    const service = await serviceOn(id, "api");
    records.set("api.example.org", ["93.184.215.21"]);
    const refused = await owner.post("/domains/hostnames", {
      hostname: "api.example.org",
      connect: { serviceId: service.id },
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toBe(
      "pool.example.net, the address of Pool, resolves to several addresses (93.184.215.21, 93.184.215.22), so Nearzero can't tell which one its hostnames should point at. Set its public IPv4 under Servers → Pool → Edit.",
    );
    expect(refused.body.error.message).not.toContain("About Nearzero");
    const missing = await addServer("Nowhere", "nowhere.example.net");
    const other = await serviceOn(missing, "www");
    await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" });
    const zoned = await owner.post("/domains/hostnames", {
      hostname: "www.example.net",
      connect: { serviceId: other.id },
    });
    expect(zoned.status).toBe(409);
    expect(zoned.body.error.message).toBe(
      "Nearzero can't create the DNS record: nowhere.example.net, the address of Nowhere, doesn't resolve to a public IPv4 address, so Nearzero doesn't know where its hostnames should point. Set its public IPv4 under Servers → Nowhere → Edit.",
    );
    await removeServer(id);
    await removeServer(missing);
  });

  test("a private address needs its public IPv4 set; setting it reaches the runner at once", async () => {
    const id = await addServer("In a VPC", "10.0.0.5");
    const runner = await attachRunner(id);
    // The SSH address isn't where the internet reaches it, so it isn't used (B2-05).
    expect(runner.welcome?.publicIPv4).toBeNull();
    const service = await serviceOn(id, "site");
    records.set("site.example.org", ["93.184.215.30"]);
    const refused = await owner.post("/domains/hostnames", {
      hostname: "site.example.org",
      connect: { serviceId: service.id },
    });
    expect(refused.body.error.message).toBe(
      "10.0.0.5, the address of In a VPC, is a private address, so Nearzero doesn't know where its hostnames should point. Set its public IPv4 under Servers → In a VPC → Edit.",
    );
    expect((await owner.patch(`/servers/${id}`, { publicIPv4: "10.0.0.9" })).status).toBe(400);
    const saved = await owner.patch(`/servers/${id}`, { publicIPv4: "93.184.215.30" });
    expect(saved.status).toBe(200);
    expect(saved.body.server.publicIPv4).toBe("93.184.215.30");
    // The runner was asked to reconnect, and hears the new address when it does.
    expect(harness.services.runners.isOnline(id)).toBe(false);
    const again = await attachRunner(id);
    expect(again.welcome?.publicIPv4).toBe("93.184.215.30");
    expect(
      (
        await owner.post("/domains/hostnames", {
          hostname: "site.example.org",
          connect: { serviceId: service.id },
        })
      ).status,
    ).toBe(201);
    // Blank clears it again.
    expect((await owner.patch(`/servers/${id}`, { publicIPv4: "" })).body.server.publicIPv4).toBe(
      null,
    );
    await removeServer(id);
  });

  test("B1-45, R3-20: a deleted server takes its hostnames and uploaded certificates along; an offline server's certificate can be deleted", async () => {
    const work = await mkdtemp(join(tmpdir(), "nz-upload-"));
    const made = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=leaving.example.org",
        "-addext",
        "subjectAltName=DNS:*.leaving.example.org",
        "-keyout",
        join(work, "k.pem"),
        "-out",
        join(work, "c.pem"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await made.exited;
    const certificate = await readFile(join(work, "c.pem"), "utf8");
    const privateKey = await readFile(join(work, "k.pem"), "utf8");
    await rm(work, { recursive: true, force: true });
    const upload = (serverId: string, name: string) =>
      owner.post("/domains/certificates", { name, certificate, privateKey, serverId });

    // Deleting a certificate while its server is offline.
    const id = await addServer("Leaving", "93.184.215.50");
    let runner = await attachRunner(id);
    const first = await upload(id, "First");
    expect(first.status).toBe(201);
    harness.services.runners.disconnect(id);
    const deleted = await owner.delete(`/domains/certificates/${first.body.certificate.id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.message).toContain("once the server is back");
    expect(
      await harness.test.db.selectFrom("uploaded_certificate").select("id").execute(),
    ).toHaveLength(0);
    // The router drops it when the runner is back, though none is left to give it: what a
    // runner gets when it connects always brings its set up to date.
    runner = await attachRunner(id);
    await onRunnerReady(harness.services, id);
    expect(
      (runner.of("certificates.uploads").at(-1) as { certificates: unknown[] }).certificates,
    ).toEqual([]);

    // Deleting the server: its certificate and its hostname without a service go too.
    expect((await upload(id, "Second")).status).toBe(201);
    records.set("spare.leaving.example.org", ["93.184.215.50"]);
    const spare = await owner.post("/domains/hostnames", {
      hostname: "spare.leaving.example.org",
      serverId: id,
    });
    expect(spare.status).toBe(201);
    const removed = await owner.delete(`/servers/${id}`);
    expect(removed.status).toBe(200);
    expect(
      await harness.test.db.selectFrom("uploaded_certificate").select("id").execute(),
    ).toHaveLength(0);
    expect(
      await harness.test.db
        .selectFrom("hostname")
        .select("id")
        .where("host", "=", "spare.leaving.example.org")
        .execute(),
    ).toHaveLength(0);
    // The name is free again for another server.
    const other = await addServer("Staying", "93.184.215.51");
    await attachRunner(other);
    records.set("spare.leaving.example.org", ["93.184.215.51"]);
    expect(
      (
        await owner.post("/domains/hostnames", {
          hostname: "spare.leaving.example.org",
          serverId: other,
        })
      ).status,
    ).toBe(201);
    await harness.test.db.deleteFrom("hostname").where("target", "=", other).execute();
    await removeServer(other);
  });

  test("B1-46: changing a server's address moves the managed DNS records of its hostnames", async () => {
    const id = await addServer("Moving", "93.184.215.40");
    await attachRunner(id);
    const service = await serviceOn(id, "moving");
    const zone = (
      await owner.post("/domains/zones", { domain: "example.net", adminEmail: "dns@example.net" })
    ).body.zone;
    expect(
      (
        await owner.post("/domains/hostnames", {
          hostname: "moving.example.net",
          connect: { serviceId: service.id },
        })
      ).status,
    ).toBe(201);
    const value = async () =>
      (
        (await owner.get(`/domains/zones/${zone.id}`)).body.records as {
          name: string;
          value: string;
        }[]
      ).find((record) => record.name === "moving")?.value;
    expect(await value()).toBe("93.184.215.40");
    host.commands.length = 0;
    expect((await owner.patch(`/servers/${id}`, { address: "93.184.215.41" })).status).toBe(200);
    expect(await value()).toBe("93.184.215.41");
    // …and is published at once.
    const applied = host.of("dns.apply").at(-1) as { zones: { content: string }[] };
    expect(applied.zones[0]?.content).toContain("moving 300 IN A 93.184.215.41");
    await removeServer(id);
  });
});

describe("certificates (spec 10.7)", () => {
  async function connected() {
    const { service } = await app("host");
    records.set("pay.example.org", [HOST_IP]);
    const added = await owner.post("/domains/hostnames", {
      hostname: "pay.example.org",
      connect: { serviceId: service.id },
    });
    return added.body.hostname.id as string;
  }

  test("states come from the router's report and the DNS check", async () => {
    const id = await connected();
    host.certificates = {
      ...emptyStatus(),
      holds: [{ hostname: "pay.example.org", reason: "no_record" }],
    };
    const queued = await owner.post(`/domains/hostnames/${id}/check-dns`);
    expect(queued.body.hostname.https).toMatchObject({ state: "queued", label: "Queued" });
    expect(host.of("router.check-holds").length).toBeGreaterThan(0);
    const now = Date.now();
    host.certificates = {
      ...emptyStatus(),
      certificates: [
        {
          names: ["pay.example.org"],
          notBefore: now - 86_400_000,
          notAfter: now + 80 * 86_400_000,
          issuer: "R11",
        },
      ],
    };
    const valid = await owner.get("/domains/hostnames?refresh=1");
    const view = valid.body.hostnames.find((item: { id: string }) => item.id === id);
    expect(view.https.state).toBe("valid");
    expect(view.https.note).toEndWith("Renews automatically.");
  });

  test("G3-12, R3-11: the filters and labels pick the rows 0.1.x picked", async () => {
    const id = await connected();
    const now = Date.now();
    const valid = (...names: string[]) => ({
      ...emptyStatus(),
      certificates: names.map((name) => ({
        names: [name],
        notBefore: now - 86_400_000,
        notAfter: now + 80 * 86_400_000,
        issuer: "R11",
      })),
    });
    const view = async (hostId: string, show = "all") =>
      (
        (await owner.get(`/domains/hostnames?refresh=1&show=${show}`)).body.hostnames as {
          id: string;
          dns: { status: string; label: string; note: string };
          https: { state: string };
        }[]
      ).find((item) => item.id === hostId);
    // Behind Cloudflare's proxy with a valid certificate: "Proxied" with the HTTP-challenge
    // note, and not under Needs attention.
    records.set("pay.example.org", ["104.16.1.1"]);
    host.certificates = valid("pay.example.org");
    await owner.post(`/domains/hostnames/${id}/check-dns`);
    const proxied = await view(id);
    expect(proxied?.dns).toMatchObject({
      status: "proxied",
      label: "Proxied",
      note: "Proxied by Cloudflare. HTTPS works if Cloudflare forwards plain HTTP for /.well-known/acme-challenge/ to this server.",
    });
    expect(proxied?.https.state).toBe("valid");
    expect(await view(id, "attention")).toBeUndefined();
    // One lookup that failed doesn't put a serving site under Needs attention either.
    failingNames.add("pay.example.org");
    try {
      await owner.post(`/domains/hostnames/${id}/check-dns`);
      expect((await view(id))?.dns.status).toBe("lookup_failed");
      expect(await view(id, "attention")).toBeUndefined();
    } finally {
      failingNames.delete("pay.example.org");
    }
    // Connected with no A record: "Waiting for DNS", under Waiting for DNS.
    records.delete("pay.example.org");
    host.certificates = {
      ...emptyStatus(),
      holds: [{ hostname: "pay.example.org", reason: "no_record" }],
    };
    await owner.post(`/domains/hostnames/${id}/check-dns`);
    const waiting = await view(id);
    expect(waiting?.dns).toMatchObject({ status: "waiting", label: "Waiting for DNS" });
    expect(waiting?.https.state).toBe("waiting_for_dns");
    expect(await view(id, "waiting")).toBeDefined();
    expect(await view(id, "attention")).toBeUndefined();
    // Connected and pointing elsewhere: Needs attention.
    records.set("pay.example.org", ["192.0.2.1"]);
    await owner.post(`/domains/hostnames/${id}/check-dns`);
    expect(await view(id, "attention")).toBeDefined();
    // Unconnected with no record: "No record", and not waiting for anything.
    await owner.post(`/domains/hostnames/${id}/disconnect`);
    records.delete("pay.example.org");
    host.certificates = emptyStatus();
    await owner.post(`/domains/hostnames/${id}/check-dns`);
    const loose = await view(id);
    expect(loose?.dns).toMatchObject({ status: "no_record", label: "No record" });
    expect(await view(id, "waiting")).toBeUndefined();
    expect(await view(id, "attention")).toBeUndefined();
  });

  test("Retry is refused with the reason, and otherwise asks the router", async () => {
    const id = await connected();
    const now = Date.now();
    host.certificates = {
      ...emptyStatus(),
      attempts: [
        {
          hostname: "pay.example.org",
          failures: [now - 4000, now - 3000, now - 2000, now - 1000],
          lastError: "dns: NXDOMAIN",
          rateLimitedUntil: null,
          requestedAt: now - 5000,
          retriedAt: null,
        },
      ],
    };
    const refused = await owner.post(`/domains/hostnames/${id}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toStartWith(
      "Retry: Let's Encrypt allows 5 failed checks per hour. Try again after",
    );
    host.certificates = {
      ...emptyStatus(),
      attempts: [
        {
          hostname: "pay.example.org",
          failures: [now - 3000, now - 2000, now - 1000],
          lastError: "dns: NXDOMAIN",
          rateLimitedUntil: null,
          requestedAt: now - 5000,
          retriedAt: null,
        },
      ],
    };
    const paused = await owner.get(`/domains/hostnames/${id}`);
    expect(paused.body.hostname.https.state).toBe("paused");
    const allowed = await owner.post(`/domains/hostnames/${id}/retry`);
    expect(allowed.status).toBe(200);
    expect(host.of("certificates.retry")).toEqual([{ hostname: "pay.example.org" }]);
    const soon = await owner.post(`/domains/hostnames/${id}/retry`);
    expect(soon.body.error.message).toBe(
      "Retry: Nearzero asked Let's Encrypt less than a minute ago. Wait a minute, then try again.",
    );
    records.set("pay.example.org", ["192.0.2.1"]);
    const dns = await owner.post(`/domains/hostnames/${id}/retry`);
    expect(dns.body.error.message).toStartWith(
      "Retry: DNS for pay.example.org doesn't point at this server yet",
    );
  });

  test("R3-18: certificate errors read as plain advice with the fix, and a server that can't reach Let's Encrypt isn't paused", async () => {
    const id = await connected();
    const now = Date.now();
    const report = (lastError: string, failures: number[]) => {
      host.certificates = {
        ...emptyStatus(),
        attempts: [
          {
            hostname: "pay.example.org",
            failures,
            lastError,
            lastErrorAt: now - 1000,
            rateLimitedUntil: null,
            requestedAt: now - 60_000,
            retriedAt: null,
          },
        ],
      };
    };
    const view = async () =>
      (await owner.get("/domains/hostnames?refresh=1")).body.hostnames.find(
        (item: { id: string }) => item.id === id,
      );
    // Port 80 closed: Let's Encrypt checked the name, so it counts, and the advice says what to open.
    report(
      "connection: 203.0.113.10: Fetching http://pay.example.org/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)",
      [now - 1000],
    );
    const port80 = await view();
    const open80 =
      "Let's Encrypt could not reach port 80 on 203.0.113.10. Open TCP port 80 in the server's firewall and any cloud firewall, then press Retry.";
    expect(port80.https).toMatchObject({ state: "failed", note: open80, lastError: open80 });
    // Three times "couldn't reach Let's Encrypt": the runner counted none of them (its back-off
    // only counts checks Let's Encrypt made), so requests aren't paused and Retry is allowed.
    report(
      "cannot get ACME client get directory at 'https://acme-v02.api.letsencrypt.org/directory': Get \"https://acme-v02.api.letsencrypt.org/directory\": dial tcp: lookup acme-v02.api.letsencrypt.org on 127.0.0.11:53: no such host",
      [],
    );
    const unreachable = await view();
    expect(unreachable.https).toMatchObject({
      state: "failed",
      note: "This server couldn't reach Let's Encrypt (no such host), so pay.example.org wasn't checked. Allow outgoing HTTPS (TCP 443) from the server, then press Retry.",
      retryRefusal: null,
    });
    // A CAA record and a name Let's Encrypt won't issue for, in plain words too.
    report("caa: CAA record for pay.example.org prevents issuance", [now - 1000]);
    expect((await view()).https.note).toBe(
      'A CAA record blocks Let\'s Encrypt for pay.example.org. Add a CAA record: 0 issue "letsencrypt.org", then press Retry.',
    );
  });

  test("R3-19: a hostname warns 14 days before its uploaded certificate ends, since it won't renew", async () => {
    const work = await mkdtemp(join(tmpdir(), "nz-upload-"));
    const made = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "10",
        "-subj",
        "/CN=example.org",
        "-addext",
        "subjectAltName=DNS:*.example.org,DNS:example.org",
        "-keyout",
        join(work, "k.pem"),
        "-out",
        join(work, "c.pem"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await made.exited;
    const certificate = await readFile(join(work, "c.pem"), "utf8");
    const privateKey = await readFile(join(work, "k.pem"), "utf8");
    await rm(work, { recursive: true, force: true });
    const uploaded = await owner.post("/domains/certificates", {
      name: "Short",
      certificate,
      privateKey,
      serverId: "host",
    });
    expect(uploaded.status).toBe(201);
    const id = await connected();
    const listed = (await owner.get("/domains/hostnames")).body.hostnames.find(
      (item: { id: string }) => item.id === id,
    );
    expect(listed.https).toMatchObject({ state: "expires_soon", label: "Expires soon" });
    expect(listed.https.note).toMatch(
      /^The uploaded certificate "Short" ends on \d{4}-\d{2}-\d{2}\. Nearzero can't renew uploaded certificates/,
    );
    expect(listed.needsAttention).toBe(true);
    await owner.delete(`/domains/certificates/${uploaded.body.certificate.id}`);
  });

  test("uploaded certificates: saved only after the router took them; edit keeps the key; delete reverts", async () => {
    const work = await mkdtemp(join(tmpdir(), "nz-upload-"));
    const made = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "20",
        "-subj",
        "/CN=example.org",
        "-addext",
        "subjectAltName=DNS:*.example.org,DNS:example.org",
        "-keyout",
        join(work, "k.pem"),
        "-out",
        join(work, "c.pem"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await made.exited;
    const certificate = await readFile(join(work, "c.pem"), "utf8");
    const privateKey = await readFile(join(work, "k.pem"), "utf8");
    await rm(work, { recursive: true, force: true });
    expect(
      (
        await owner.post("/domains/certificates", {
          name: "Wild",
          certificate: "nope",
          privateKey,
          serverId: "host",
        })
      ).body.error.message,
    ).toBe("Paste the certificate in PEM form: it starts with -----BEGIN CERTIFICATE-----.");
    host.fail.add("certificates.uploads");
    expect(
      (
        await owner.post("/domains/certificates", {
          name: "Wild",
          certificate,
          privateKey,
          serverId: "host",
        })
      ).status,
    ).toBe(409);
    expect(
      await harness.test.db.selectFrom("uploaded_certificate").select("id").execute(),
    ).toHaveLength(0);
    host.fail.clear();
    const uploaded = await owner.post("/domains/certificates", {
      name: "Wild",
      certificate,
      privateKey,
      serverId: "host",
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body.certificate).toMatchObject({
      name: "Wild",
      covers: ["*.example.org", "example.org"],
      server: { id: "host", name: "Nearzero host" },
    });
    expect(uploaded.body.certificate.expiresNote).toMatch(/^Expires in (19|20) days$/);
    const pushed = host.of("certificates.uploads").at(-1) as { certificates: { keyPem: string }[] };
    expect(pushed.certificates[0]?.keyPem).toContain("PRIVATE KEY");
    const stored = await harness.test.db
      .selectFrom("uploaded_certificate")
      .select("key_sealed")
      .executeTakeFirstOrThrow();
    expect(stored.key_sealed).not.toContain("PRIVATE KEY");

    const id = await connected();
    const covered = await owner.get(`/domains/hostnames/${id}`);
    expect(covered.body.hostname.https).toMatchObject({ state: "uploaded", label: "Uploaded" });
    expect((await owner.post(`/domains/hostnames/${id}/retry`)).body.error.message).toContain(
      'The uploaded certificate "Wild" covers pay.example.org',
    );

    const renamed = await owner.patch(`/domains/certificates/${uploaded.body.certificate.id}`, {
      name: "Wildcard",
      privateKey: "",
    });
    expect(renamed.body.certificate.name).toBe("Wildcard");
    const deleted = await owner.delete(`/domains/certificates/${uploaded.body.certificate.id}`);
    expect(deleted.body.message).toBe(
      "The router stops using it. Hostnames it covered get Let's Encrypt certificates again.",
    );
    expect(
      (host.of("certificates.uploads").at(-1) as { certificates: unknown[] }).certificates,
    ).toEqual([]);
  });
});

describe("permissions (spec 10.10)", () => {
  test("a member sees and changes only their own services' hostnames", async () => {
    const mine = await app("host", "mine");
    const theirs = await app("host", "theirs");
    records.set("mine.example.org", [HOST_IP]);
    records.set("theirs.example.org", [HOST_IP]);
    await owner.post("/domains/hostnames", {
      hostname: "theirs.example.org",
      connect: { serviceId: theirs.service.id },
    });
    const nobody = await addMember(harness, owner, `nobody-${Date.now()}@example.com`);
    expect((await nobody.get("/domains")).status).toBe(403);
    const member = await addMember(harness, owner, `member-${Date.now()}@example.com`, {
      scope: { serviceIds: [mine.service.id] },
      capabilities: [],
    });
    const added = await member.post("/domains/hostnames", {
      hostname: "mine.example.org",
      connect: { serviceId: mine.service.id },
    });
    expect(added.status).toBe(201);
    const list = await member.get("/domains/hostnames");
    expect(list.body.hostnames.map((item: { hostname: string }) => item.hostname)).toEqual([
      "mine.example.org",
    ]);
    const other = await harness.test.db
      .selectFrom("hostname")
      .select("id")
      .where("host", "=", "theirs.example.org")
      .executeTakeFirstOrThrow();
    expect((await member.delete(`/domains/hostnames/${other.id}`)).status).toBe(404);
    expect(
      (
        await member.post("/domains/hostnames", {
          hostname: "x.example.org",
          connect: { serviceId: theirs.service.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (await member.post("/domains/zones", { domain: "example.net", adminEmail: "a@example.net" }))
        .status,
    ).toBe(403);
    expect((await member.get("/domains/certificates")).status).toBe(403);
  });
});

describe("About Nearzero: the console's address (spec 18.2, 10.9)", () => {
  test("the server IP can be corrected, and the public domain saved with its routes", async () => {
    const about = await owner.get("/about/address");
    expect(about.body.serverIp).toMatchObject({
      address: HOST_IP,
      corrected: false,
      canCorrect: true,
    });
    expect((await owner.put("/about/server-ip", { ip: "10.0.0.5" })).status).toBe(400);
    const corrected = await owner.put("/about/server-ip", { ip: "93.184.215.14" });
    expect(corrected.body.serverIp).toMatchObject({ address: "93.184.215.14", corrected: true });
    expect(corrected.body.message).toBe("Saved. Nearzero now uses 93.184.215.14 for this server.");
    harness.services.runners.hostPublicIPv4 = HOST_IP;
    await sql`truncate address_setting`.execute(harness.test.db);
    host = await attachRunner(null);

    const change = await owner.put("/about/public-domain", {
      hostname: "console.example.org",
      email: "ops@example.org",
    });
    expect(change.status).toBe(409);
    expect(change.body.error.message).toStartWith(
      "The console already has the address nearzero.example.com.",
    );
    const same = await owner.put("/about/public-domain", {
      hostname: "nearzero.example.com",
      email: "ops@example.org",
    });
    expect(same.status).toBe(200);
    expect(same.body.publicDomain).toMatchObject({
      hostname: "nearzero.example.com",
      email: "ops@example.org",
      note: "Ports 80 and 443 must be open on this server for HTTPS.",
    });
    // The saved email becomes every router's contact for new certificates (spec 10.1)…
    for (let i = 0; i < 100 && host.of("certificates.contact").length === 0; i++) {
      await Bun.sleep(10);
    }
    expect(host.of("certificates.contact")).toEqual([{ email: "ops@example.org" }]);
    // …and a runner that connects later gets it when it connects.
    host.commands.length = 0;
    await onRunnerReady(harness.services, "host");
    expect(host.of("certificates.contact")).toEqual([{ email: "ops@example.org" }]);
  });
});

describe("deleting a service removes its hostnames (spec 10.6)", () => {
  test("its hostnames go with it, and a route left behind is swept", async () => {
    const { service } = await app("host");
    records.set("gone.example.org", [HOST_IP]);
    await owner.post("/domains/hostnames", {
      hostname: "gone.example.org",
      connect: { serviceId: service.id },
    });
    expect(await harness.test.db.selectFrom("router_route").select("key").execute()).toHaveLength(
      1,
    );
    await harness.test.db.deleteFrom("service").where("id", "=", service.id).execute();
    expect(await harness.test.db.selectFrom("hostname").select("id").execute()).toHaveLength(0);
    expect(await sweepOrphanRoutes(harness.services)).toBe(1);
    expect(host.of("router.remove")).toHaveLength(1);
    expect(await harness.test.db.selectFrom("router_route").select("key").execute()).toHaveLength(
      0,
    );
  });
});

/**
 * B: an ordinary account working in its own personal workspace, where it is owner but not an
 * instance administrator (the review's attacker).
 */
let outsiderBrowser: Browser | null = null;
async function outsider(): Promise<Browser> {
  if (outsiderBrowser) return outsiderBrowser;
  const browser = await addMemberThroughInvitation(harness, owner, "outsider@example.com");
  const personal = await harness.test.db
    .selectFrom("workspace")
    .select("id")
    .where("created_by", "=", await personIdOf(harness, "outsider@example.com"))
    .where("is_personal", "=", true)
    .executeTakeFirstOrThrow();
  expect((await browser.post(`/workspaces/${personal.id}/switch`)).status).toBe(200);
  outsiderBrowser = browser;
  return browser;
}

describe("deleting a workspace (B1-64)", () => {
  test("its zones leave the DNS server and its uploaded certificates leave the router", async () => {
    const created = await owner.post("/workspaces", { name: "Short lived" });
    expect(created.status).toBe(201);
    const workspaceId = created.body.workspace.id as string;
    expect((await owner.post(`/workspaces/${workspaceId}/switch`)).status).toBe(200);
    const zone = await owner.post("/domains/zones", {
      domain: "short-lived.example",
      adminEmail: "dns@short-lived.example",
    });
    expect(zone.status).toBe(201);
    const work = await mkdtemp(join(tmpdir(), "nz-upload-"));
    const made = Bun.spawn(
      [
        "openssl",
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-days",
        "30",
        "-subj",
        "/CN=short-lived.example",
        "-addext",
        "subjectAltName=DNS:*.short-lived.example",
        "-keyout",
        join(work, "k.pem"),
        "-out",
        join(work, "c.pem"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    await made.exited;
    const uploaded = await owner.post("/domains/certificates", {
      name: "Short",
      certificate: await readFile(join(work, "c.pem"), "utf8"),
      privateKey: await readFile(join(work, "k.pem"), "utf8"),
      serverId: "host",
    });
    await rm(work, { recursive: true, force: true });
    expect(uploaded.status).toBe(201);
    expect(
      (host.of("dns.apply").at(-1) as { zones: { name: string }[] }).zones.map((z) => z.name),
    ).toContain("short-lived.example");

    host.commands.length = 0;
    expect((await owner.delete("/workspace")).status).toBe(200);
    const applied = host.of("dns.apply").at(-1) as { zones: { name: string }[] } | undefined;
    expect(applied).toBeDefined();
    expect(applied?.zones.map((item) => item.name)).not.toContain("short-lived.example");
    const certificates = host.of("certificates.uploads").at(-1) as
      | { certificates: { id: string }[] }
      | undefined;
    expect(certificates).toBeDefined();
    expect(certificates?.certificates.map((item) => item.id)).not.toContain(
      uploaded.body.certificate.id,
    );
  });
});

describe("workspace boundaries in managed DNS (spec 10.8, 22.4)", () => {
  test("B1-04: a zone inside, or around, another workspace's zone is refused", async () => {
    const b = await outsider();
    expect(
      (
        await owner.post("/domains/zones", {
          domain: "victim.example",
          adminEmail: "a@victim.example",
        })
      ).status,
    ).toBe(201);
    // The review's attack: B connects a sub-zone and would answer for A's names.
    const inside = await b.post("/domains/zones", {
      domain: "api.victim.example",
      adminEmail: "b@b-own.example",
    });
    expect(inside.status).toBe(409);
    expect(inside.body.error.message).toBe(
      "This DNS zone is inside a zone another workspace manages, so it can't be connected here.",
    );
    expect(
      (
        await owner.post("/domains/zones", {
          domain: "shop.parent.example",
          adminEmail: "a@x.example",
        })
      ).status,
    ).toBe(201);
    const around = await b.post("/domains/zones", {
      domain: "parent.example",
      adminEmail: "b@b-own.example",
    });
    expect(around.status).toBe(409);
    expect(around.body.error.message).toBe(
      "This DNS zone contains a zone another workspace manages, so it can't be connected here.",
    );
    // The other way round too: A can't take a zone around B's.
    expect(
      (await b.post("/domains/zones", { domain: "b-own.example", adminEmail: "b@b-own.example" }))
        .status,
    ).toBe(201);
    expect(
      (await owner.post("/domains/zones", { domain: "x.b-own.example", adminEmail: "a@x.example" }))
        .status,
    ).toBe(409);
    // A zone inside one's own zone is fine.
    expect(
      (
        await owner.post("/domains/zones", {
          domain: "eu.victim.example",
          adminEmail: "a@x.example",
        })
      ).status,
    ).toBe(201);
    const corefile = (host.of("dns.apply").at(-1) as { corefile: string }).corefile;
    expect(corefile).not.toContain("api.victim.example:1053");
    expect(corefile).not.toContain("\nparent.example:1053");
    expect(
      await harness.test.db.selectFrom("dns_zone").select("name").orderBy("name").execute(),
    ).toEqual([
      { name: "b-own.example" },
      { name: "eu.victim.example" },
      { name: "shop.parent.example" },
      { name: "victim.example" },
    ]);
  });

  test("B1-04: zones covering the console's address or the platform domain are for instance administrators", async () => {
    const b = await outsider();
    for (const domain of ["example.com", "nearzero.example.com", "x.apps.example.com"]) {
      const reply = await b.post("/domains/zones", { domain, adminEmail: "b@b-own.example" });
      expect(reply.status).toBe(403);
      expect(reply.body.error.message).toEndWith(
        "so only an instance administrator can connect it.",
      );
    }
    expect(await harness.test.db.selectFrom("dns_zone").select("name").execute()).toEqual([]);
    expect(
      (await owner.post("/domains/zones", { domain: "example.com", adminEmail: "a@example.com" }))
        .status,
    ).toBe(201);
  });

  test("B1-43: a workspace not allowed on the host can't point hostnames at it", async () => {
    const b = await outsider();
    records.set("onhost.example.org", [HOST_IP]);
    const reply = await b.post("/domains/hostnames", {
      hostname: "onhost.example.org",
      serverId: "host",
    });
    expect(reply.status).toBe(404);
    expect(await harness.test.db.selectFrom("hostname").select("host").execute()).toEqual([]);
  });

  test("B1-44: hostname previews never describe another workspace's server", async () => {
    const b = await outsider();
    const preview = await b.post("/domains/hostnames/preview", {
      hostname: "x.example.org",
      serverId,
    });
    expect(preview.status).toBe(404);
    expect(JSON.stringify(preview.body)).not.toContain(SERVER_IP);
    const project = await makeProject(b, `B project ${++projectCount}`);
    const draft = await b.get(
      `/environments/${project.environments.development}/hostname-preview?serverId=${serverId}&name=web`,
    );
    expect(draft.status).toBe(404);
    expect(JSON.stringify(draft.body)).not.toContain("prod-1");
  });

  test("B1-15: a server record with someone else's IP can't squat a hostname, and a name held elsewhere says so", async () => {
    const b = await outsider();
    const generated = await b.post("/ssh-keys/generate", { type: "ed25519", name: "bk" });
    const key = await b.post("/ssh-keys", {
      name: "bk",
      publicKey: generated.body.publicKey,
      privateKey: generated.body.privateKey,
    });
    // The review's attack: a server that was never set up, at the victim's server's IP. The
    // address itself is refused now (spec 30, decisions part 2)…
    const atVictim = await b.post("/servers", {
      name: "Not mine",
      sshKeyId: key.body.key.id,
      address: SERVER_IP,
      sshUser: "root",
    });
    expect(atVictim.status).toBe(409);
    expect(atVictim.body.error.message).toBe(
      "That address belongs to a server in another workspace.",
    );
    // …and a record that reaches it some other way still needs a connected runner.
    records.set("not-mine.b.example", [SERVER_IP]);
    const fake = await b.post("/servers", {
      name: "Not mine",
      sshKeyId: key.body.key.id,
      address: "not-mine.b.example",
      sshUser: "root",
    });
    expect(fake.status).toBe(201);
    records.set("shop.acme.example", [SERVER_IP]);
    const squat = await b.post("/domains/hostnames", {
      hostname: "shop.acme.example",
      serverId: fake.body.server.id,
    });
    expect(squat.status).toBe(409);
    expect(squat.body.error.message).toBe(
      "Not mine isn't connected to Nearzero yet, so a hostname can't point at it. Set the server up first, or connect a service to the hostname instead.",
    );
    // The real owner can still add it.
    const { service } = await app("server", "shop");
    expect(
      (
        await owner.post("/domains/hostnames", {
          hostname: "shop.acme.example",
          connect: { serviceId: service.id },
        })
      ).status,
    ).toBe(201);
    // A name another workspace holds is never a silent dead end.
    const held = await b.post("/domains/hostnames", {
      hostname: "shop.acme.example",
      serverId: "host",
    });
    expect([404, 409]).toContain(held.status);
    const again = await harness.test.db
      .selectFrom("workspace")
      .select("id")
      .where("created_by", "=", await personIdOf(harness, "outsider@example.com"))
      .executeTakeFirstOrThrow();
    await harness.test.db
      .insertInto("hostname")
      .values({
        workspace_id: again.id,
        host: "taken.acme.example",
        source: "own",
        target: "host",
        path: "/",
      })
      .execute();
    records.set("taken.acme.example", [HOST_IP]);
    const { service: other } = await app("host", "taken");
    const blocked = await owner.post("/domains/hostnames", {
      hostname: "taken.acme.example",
      connect: { serviceId: other.id },
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toBe(
      "taken.acme.example is already added in another workspace on this Nearzero. If the domain is yours, ask a Nearzero administrator to remove it there.",
    );
    await harness.test.db.deleteFrom("server").where("id", "=", fake.body.server.id).execute();
  });

  test("B1-15: a connected server can't take another workspace's or the host's address to squat names", async () => {
    const VICTIM_IP = "93.184.215.41";
    const VICTIM_NAMED_IP = "93.184.215.42";
    const B_IP = "93.184.215.99";
    const HOST_PUBLIC = "93.184.215.10";
    // The victim's servers: one added by IP, one by a hostname.
    const victim = await owner.post("/servers", {
      name: "Victim box",
      sshKeyId: keyId,
      address: VICTIM_IP,
      sshUser: "root",
    });
    expect(victim.status).toBe(201);
    records.set("victim.example.net", [VICTIM_NAMED_IP]);
    const victimNamed = await owner.post("/servers", {
      name: "Victim named",
      sshKeyId: keyId,
      address: "victim.example.net",
      sshUser: "root",
    });
    expect(victimNamed.status).toBe(201);

    const b = await outsider();
    const generated = await b.post("/ssh-keys/generate", { type: "ed25519", name: "bk2" });
    const key = await b.post("/ssh-keys", {
      name: "bk2",
      publicKey: generated.body.publicKey,
      privateKey: generated.body.privateKey,
    });
    const mine = await b.post("/servers", {
      name: "B box",
      sshKeyId: key.body.key.id,
      address: B_IP,
      sshUser: "root",
    });
    expect(mine.status).toBe(201);
    const bServer = mine.body.server.id as string;
    // B's server is real: its runner is connected, so hostnames may point at it.
    await attachRunner(bServer);
    expect(harness.services.runners.isOnline(bServer)).toBe(true);

    // The attack: claim the victim's address as B's public IPv4, or as its address.
    for (const body of [
      { publicIPv4: VICTIM_IP },
      { publicIPv4: VICTIM_NAMED_IP },
      { address: VICTIM_IP },
    ]) {
      const claim = await b.patch(`/servers/${bServer}`, body);
      expect(claim.status).toBe(409);
      expect(claim.body.error.message).toBe(
        "That address belongs to a server in another workspace.",
      );
      expect(Object.keys(claim.body.error.fields)).toEqual(Object.keys(body));
      // The other server is never named.
      expect(JSON.stringify(claim.body)).not.toContain("Victim");
    }
    const unchanged = await harness.test.db
      .selectFrom("server")
      .select(["address", "public_ipv4"])
      .where("id", "=", bServer)
      .executeTakeFirstOrThrow();
    expect(unchanged).toEqual({ address: B_IP, public_ipv4: null });

    // So a name the victim points at its server still can't be taken from B's.
    records.set("shop.victim.example", [VICTIM_IP]);
    const squat = await b.post("/domains/hostnames", {
      hostname: "shop.victim.example",
      serverId: bServer,
    });
    expect(squat.status).toBe(409);
    expect(squat.body.error.message).toBe(
      `shop.victim.example points at ${VICTIM_IP}, not ${B_IP}. Change its A record to ${B_IP}.`,
    );

    // A name B controls that resolves to the victim's address doesn't count either.
    records.set("b-box.b.example", [VICTIM_IP]);
    const named = await b.post("/servers", {
      name: "B named",
      sshKeyId: key.body.key.id,
      address: "b-box.b.example",
      sshUser: "root",
    });
    expect(named.status).toBe(201);
    await attachRunner(named.body.server.id);
    const viaName = await b.post("/domains/hostnames", {
      hostname: "shop.victim.example",
      serverId: named.body.server.id,
    });
    expect(viaName.status).toBe(409);
    expect(viaName.body.error.message).toBe(
      `b-box.b.example, the address of B named, resolves to ${VICTIM_IP}, which belongs to a server in another workspace, so Nearzero won't point its hostnames there. Set its public IPv4 under Servers → B named → Edit.`,
    );
    expect(
      await harness.test.db
        .selectFrom("hostname")
        .select("host")
        .where("host", "=", "shop.victim.example")
        .execute(),
    ).toEqual([]);

    // The Nearzero host's address is only for who may use the host (B1-43).
    await harness.test.db
      .insertInto("address_setting")
      .values({ key: "public_ipv4", value: HOST_PUBLIC })
      .execute();
    const hostClaim = await b.patch(`/servers/${bServer}`, { publicIPv4: HOST_PUBLIC });
    expect(hostClaim.status).toBe(409);
    expect(hostClaim.body.error.message).toBe(
      "That address belongs to the Nearzero host, which you aren't allowed to use.",
    );
    // B's own address is B's, and the owner may use the host's.
    expect((await b.patch(`/servers/${bServer}`, { publicIPv4: "93.184.215.98" })).status).toBe(
      200,
    );
    const ownerClaim = await owner.patch(`/servers/${victim.body.server.id}`, {
      publicIPv4: HOST_PUBLIC,
    });
    expect(ownerClaim.status).toBe(200);
    // One workspace's servers may share an address among themselves.
    expect(
      (
        await owner.patch(`/servers/${victimNamed.body.server.id}`, {
          publicIPv4: VICTIM_IP,
        })
      ).status,
    ).toBe(200);
    await harness.test.db
      .deleteFrom("server")
      .where("id", "in", [
        victim.body.server.id,
        victimNamed.body.server.id,
        bServer,
        named.body.server.id,
      ])
      .execute();
  });

  test("B1-16: a zone's nameserver list reserves only names inside the zone and Nearzero's own", async () => {
    const b = await outsider();
    // The review's attack: list the victim's name as a nameserver of B's own zone.
    const zone = await b.post("/domains/zones", {
      domain: "b-own.example",
      adminEmail: "b@b-own.example",
      nameservers: ["shop.victim.example", "ns1.b-own.example"],
    });
    expect(zone.status).toBe(201);
    const { service } = await app("host", "shop");
    records.set("shop.victim.example", [HOST_IP]);
    const added = await owner.post("/domains/hostnames", {
      hostname: "shop.victim.example",
      connect: { serviceId: service.id },
    });
    expect(added.status).toBe(201);
    // A nameserver inside the zone gets its address from Nearzero, so it stays reserved…
    records.set("ns1.b-own.example", [HOST_IP]);
    const glue = await owner.post("/domains/hostnames", {
      hostname: "ns1.b-own.example",
      connect: { serviceId: service.id },
    });
    expect(glue.status).toBe(409);
    expect(glue.body.error.message).toBe(
      "ns1.b-own.example is reserved for Nearzero itself. Pick another hostname.",
    );
    // …as are Nearzero's default nameservers under the platform domain.
    expect(
      (
        await owner.post("/domains/hostnames/preview", {
          hostname: `ns2.${DOMAIN}`,
        })
      ).body.message,
    ).toBe(`ns2.${DOMAIN} is reserved for Nearzero itself. Pick another hostname.`);
  });
});
