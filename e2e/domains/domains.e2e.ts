import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { ObjectRegistry } from "../../apps/control/src/access/objects.ts";
import { routeKey } from "../../apps/control/src/deploys/pipeline.ts";
import { runCheckCycle } from "../../apps/control/src/domains/background.ts";
import { publicDnsLookup } from "../../apps/control/src/domains/settings.ts";
import { checkZoneHealth } from "../../apps/control/src/domains/zones.ts";
import { registerProjectObjects } from "../../apps/control/src/projects/objects.ts";
import { upsertRoute } from "../../apps/control/src/routing/routes.ts";
import { createLinkCertificate } from "../../apps/control/src/runners/link-certificate.ts";
import { serveRunnerLink } from "../../apps/control/src/runners/link-paths.ts";
import { socketServer, upgraderFor } from "../../apps/control/src/runners/sockets.ts";
import { registerServerObjects } from "../../apps/control/src/servers/servers.ts";
import {
  type Browser,
  createHarness,
  type Harness,
  setUpNamedOwner,
} from "../../apps/control/test/support/harness.ts";
import { makeProject, makeService } from "../../apps/control/test/support/projects.ts";
import { DIND_IMAGE, DindHost, eventually, PLATFORM } from "../runner/dind.ts";

/**
 * Domains and certificates (M4) against a Docker-in-Docker host:
 *
 *   bun run --cwd e2e test:domains        (NZ1_E2E_KEEP=1 keeps the host for a look afterwards)
 *
 * Inside the host: Nearzero's runner (joined as the Nearzero host) with its router, Pebble as the
 * ACME server, and a small CoreDNS the test controls, which gives one answer to everyone (the
 * public view) and may give Pebble another, so a validation can be made to fail. The control
 * plane runs in this process on 127.0.0.1:4170 and asks the same DNS server through a published
 * port. Then:
 *   - a hostname whose DNS is wrong is held, and Pebble receives no order;
 *   - once the record exists, the next check issues a certificate and HTTPS serves it;
 *   - three failed validations pause requests, and Retry is refused after a fourth;
 *   - a managed zone serves its records from the built-in DNS server;
 *   - removing a hostname stops it serving within 10 seconds;
 *   - the router serves HTTP/3 on UDP 443 (a QUIC Version Negotiation answer) and its HTTPS
 *     answers say so in Alt-Svc; with UDP 443 taken by another program it starts without HTTP/3
 *     and the host's details name that program (R3-22), as do Router files' read-only main
 *     settings (R3-23).
 * The deploy engine's part (writing the routes a deploy's providers return) is played by the test.
 */

const ROOT = resolve(import.meta.dir, "..", "..");
const WORK = join(ROOT, "e2e", ".work", `domains-${Date.now().toString(36)}`);
const HOST = new DindHost("nz1-m4-domains");
const PORT = 4170;
const DNS_ON_MAC = 55453;
/**
 * The runner link's own TLS port (an install's 3443): the server joins there with the
 * certificate's fingerprint, since a remote runner never uses plain HTTP (spec 31, C4-02).
 */
const LINK_PORT = 4178;
const LINK = createLinkCertificate(["127.0.0.1"]);
const CONTROL_FROM_HOST = `https://host.docker.internal:${LINK_PORT}`;
const KEEP = process.env.NZ1_E2E_KEEP === "1";
const ROUTER_IMAGE = "traefik:v3.7.18";
const DNS_IMAGE = "coredns/coredns:1.15.0";
const PEBBLE_IMAGE = "ghcr.io/letsencrypt/pebble:2.8.0";
const ZONE = "nzm4.dev";
const PLATFORM_DOMAIN = `apps.${ZONE}`;

let harness: Harness;
let owner: Browser;
let server: ReturnType<typeof Bun.serve>;
let linkServer: ReturnType<typeof Bun.serve>;
let hostIp = "";
let testDnsIp = "";
let upstreamNs = "";
let serial = Math.floor(Date.now() / 1000);
let touches = 0;

async function log(name: string, text: string): Promise<void> {
  await writeFile(join(WORK, `${name}.log`), text);
}

/** The test's DNS: what everyone sees, and what Pebble sees (the same unless given). */
async function setRecords(everyone: string[], pebble: string[] = everyone): Promise<void> {
  serial++;
  const head = (lines: string[]) =>
    [
      `$ORIGIN ${ZONE}.`,
      "$TTL 1",
      `@ IN SOA ns.${ZONE}. admin.${ZONE}. ( ${serial} 60 60 60 1 )`,
      `@ IN NS ns.${ZONE}.`,
      `ns IN A ${testDnsIp}`,
      ...lines,
      "",
    ].join("\n");
  const encode = (text: string) => Buffer.from(text).toString("base64");
  await HOST.must(
    `echo ${encode(head(everyone))} | base64 -d > /srv/testdns/public.db.tmp && mv /srv/testdns/public.db.tmp /srv/testdns/public.db && ` +
      `echo ${encode(head(pebble))} | base64 -d > /srv/testdns/pebble.db.tmp && mv /srv/testdns/pebble.db.tmp /srv/testdns/pebble.db`,
  );
  // CoreDNS checks the files every second.
  await Bun.sleep(2500);
}

/**
 * What public DNS says about the managed zone's nameservers (G3-10): the registrar's NS records
 * for zone.<ZONE>, as the internet's resolvers would return them.
 */
async function setZoneDelegation(nameservers: string[]): Promise<void> {
  serial++;
  const text = [
    `$ORIGIN zone.${ZONE}.`,
    "$TTL 1",
    `@ IN SOA ns.${ZONE}. admin.${ZONE}. ( ${serial} 60 60 60 1 )`,
    ...nameservers.map((name) => `@ IN NS ${name}.`),
    "",
  ].join("\n");
  await HOST.must(
    `echo ${Buffer.from(text).toString("base64")} | base64 -d > /srv/testdns/zone-public.db.tmp && mv /srv/testdns/zone-public.db.tmp /srv/testdns/zone-public.db`,
  );
  await Bun.sleep(2500);
}

/** Pebble's log lines that mention a name. */
async function pebbleLines(name: string): Promise<string[]> {
  const out = await HOST.must("docker logs nz-pebble 2>&1");
  return out.split("\n").filter((line) => line.includes(name));
}

/** Traefik's failed attempts for a name, from its JSON log. */
async function routerFailures(name: string): Promise<number> {
  const out = await HOST.must("docker logs nearzero-router 2>&1");
  return out
    .split("\n")
    .filter((line) => line.includes("Unable to obtain ACME certificate") && line.includes(name))
    .length;
}

/** Any change to the router's configuration (the router looks at every name again). */
async function touchRouter(): Promise<void> {
  touches++;
  await upsertRoute(harness.services, "host", {
    key: `e2e-touch-${touches}`,
    hostnames: [`touch-${touches}.localhost`],
    upstream: { host: "nz-testdns", port: 53 },
  });
  await Bun.sleep(3000);
}

async function https(name: string, path = "/"): Promise<string> {
  const result = await HOST.exec(
    `curl -s --max-time 5 --cacert /srv/pebble/root.pem --resolve ${name}:443:127.0.0.1 https://${name}${path}`,
  );
  return result.code === 0 ? result.out : "";
}

async function httpStatus(name: string): Promise<string> {
  return (
    await HOST.exec(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 -H 'Host: ${name}' http://127.0.0.1/`,
    )
  ).out.trim();
}

/** What the deploy pipeline does: start the app, ask the providers, write their routes. */
async function fakeDeploy(service: { id: string; appName: string }) {
  const hub = harness.services.runners;
  const name = `${service.appName}-e2e`;
  await hub
    .command("host", "container.create", {
      name,
      image: "nginx:alpine",
      network: "nearzero-edge",
      networkAliases: [service.appName],
      labels: { "dev.nearzero.service": service.id },
    })
    .catch(() => {});
  await hub.command("host", "container.start", { id: name }).catch(() => {});
  const answer = await harness.services.hostnameProviders.collect({
    serviceId: service.id,
    serverId: "host",
    port: 80,
  });
  for (const route of answer.routes) {
    await upsertRoute(harness.services, "host", {
      key: routeKey(service.id, route.host, route.path),
      hostnames: [route.host],
      path: route.path,
      upstream: { host: name, port: route.port },
      certificate: route.https ? "letsencrypt" : "none",
    });
  }
  // Notes that need a DNS lookup arrive on their own (punch list 18); a deploy writes them to
  // its log when they do. This suite reads them together with the rest.
  const later = (await answer.later) ?? [];
  return { ...answer, notes: [...answer.notes, ...later] };
}

let projects = 0;
async function app(name: string) {
  const project = await makeProject(owner, `Shop ${++projects}`);
  const created = await makeService(owner, project.environments.development as string, {
    kind: "application",
    name,
    serverId: "host",
    servicePort: 80,
  });
  return created.service as { id: string; appName: string; environmentId: string };
}

async function hostnameView(id: string) {
  await owner.post(`/domains/hostnames/${id}/check-dns`);
  return (await owner.get(`/domains/hostnames/${id}`)).body.hostname;
}

beforeAll(async () => {
  await mkdir(WORK, { recursive: true });
  const target =
    PLATFORM === "linux/arm64" ? "bun-linux-arm64-musl" : "bun-linux-x64-musl-baseline";
  const binary = join(WORK, "nearzero-runner");
  await $`bun build ${join(ROOT, "runner", "src", "main.ts")} --compile --target=${target} --outfile=${binary}`.quiet();

  // The host publishes the test DNS server's port, and nothing else, on the Mac's loopback.
  await HOST.remove();
  await $`docker run -d --privileged --name ${HOST.name} --platform ${PLATFORM} --label nz1-e2e=true -p 127.0.0.1:${DNS_ON_MAC}:5353/udp -p 127.0.0.1:${DNS_ON_MAC}:5353/tcp -e DOCKER_TLS_CERTDIR= ${DIND_IMAGE}`.quiet();
  await eventually(
    "Docker inside the host",
    async () => (await HOST.exec("docker info >/dev/null 2>&1")).code === 0,
    90_000,
    1000,
  );
  await HOST.must(
    "apk add --no-cache -q libstdc++ libgcc curl openssl bind-tools socat >/dev/null",
  );
  await HOST.copyIn(binary, "/usr/local/bin/nearzero-runner");
  for (const image of [ROUTER_IMAGE, DNS_IMAGE, PEBBLE_IMAGE, "nginx:alpine"]) {
    await HOST.must(`docker pull -q ${image} >/dev/null`);
  }
  hostIp = (await HOST.must("ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1")).trim();
  upstreamNs = (await HOST.must("awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf")).trim();
  await HOST.must(
    "docker network create --label dev.nearzero.managed=true nearzero-edge >/dev/null",
  );

  // The test's DNS server: the public view on 53, Pebble's view on 5354.
  await HOST.must("mkdir -p /srv/testdns /srv/pebble /etc/nearzero/router /etc/nearzero/dns");
  const corefile = `${ZONE}:53 {
    file /zones/public.db {
        reload 1s
    }
}
zone.${ZONE}:53 {
    file /zones/zone-public.db {
        reload 1s
    }
}
.:53 {
    forward . ${upstreamNs}
}
${ZONE}:5354 {
    file /zones/pebble.db {
        reload 1s
    }
}
`;
  await HOST.must(
    `echo ${Buffer.from(corefile).toString("base64")} | base64 -d > /srv/testdns/Corefile`,
  );
  testDnsIp = "0.0.0.0";
  await setRecords([]);
  // Before the move to Nearzero, the managed zone's registrar still points elsewhere.
  await setZoneDelegation(["ns1.previous-dns.example"]);
  await HOST.must(
    `docker run -d --name nz-testdns --network nearzero-edge -p 5353:53/udp -p 5353:53/tcp -v /srv/testdns:/zones:ro ${DNS_IMAGE} -conf /zones/Corefile >/dev/null`,
  );
  testDnsIp = (
    await HOST.must(
      "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' nz-testdns",
    )
  ).trim();
  await setRecords([]);
  // The server (and everything Docker starts on it) resolves names through the test's DNS.
  await HOST.must(`printf 'nameserver ${testDnsIp}\\n' > /etc/resolv.conf`);

  // Pebble validates over HTTP on port 80 and asks Pebble's view of DNS.
  await HOST.must(
    "docker create --name pebble-files " +
      PEBBLE_IMAGE +
      " >/dev/null && docker cp pebble-files:/test/certs/pebble.minica.pem /srv/pebble/minica.pem && docker rm pebble-files >/dev/null",
  );
  const pebbleConfig = {
    pebble: {
      listenAddress: "0.0.0.0:14000",
      managementListenAddress: "0.0.0.0:15000",
      certificate: "test/certs/localhost/cert.pem",
      privateKey: "test/certs/localhost/key.pem",
      httpPort: 80,
      tlsPort: 443,
      ocspResponderURL: "",
      externalAccountBindingRequired: false,
    },
  };
  await HOST.must(
    `echo ${Buffer.from(JSON.stringify(pebbleConfig)).toString("base64")} | base64 -d > /srv/pebble/pebble.json`,
  );
  await HOST.must(
    `docker run -d --name nz-pebble --network nearzero-edge --network-alias pebble -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 -e PEBBLE_AUTHZREUSE=0 -v /srv/pebble:/config:ro ${PEBBLE_IMAGE} -config /config/pebble.json -dnsserver ${testDnsIp}:5354 >/dev/null`,
  );
  const pebbleIp = (
    await HOST.must(
      "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' nz-pebble",
    )
  ).trim();
  await eventually(
    "Pebble's root certificate",
    async () => {
      const result = await HOST.exec(
        `curl -sk --max-time 3 https://${pebbleIp}:15000/roots/0 -o /srv/pebble/root.pem && grep -q BEGIN /srv/pebble/root.pem`,
      );
      return result.code === 0;
    },
    60_000,
    1000,
  );

  const objects = new ObjectRegistry();
  registerProjectObjects(objects);
  registerServerObjects(objects);
  harness = await createHarness({
    extra: {
      objects,
      runnerControlUrl: CONTROL_FROM_HOST,
      runnerControlFingerprint: LINK.fingerprint,
      hostPublicIPv4: hostIp,
      domains: {
        platformDomain: PLATFORM_DOMAIN,
        acmeEmail: `ops@${ZONE}`,
        // Public DNS is the test's DNS. The host's public address is only reachable from the
        // test network, so the authoritative SOA check (G3-10) asks it from there.
        dns: {
          ...publicDnsLookup([`127.0.0.1:${DNS_ON_MAC}`]),
          async soaSerialAt(server: string, zone: string) {
            const [address = "", port = "53"] = server.split(":");
            const answer = (
              await HOST.exec(`dig +short +time=2 +tries=1 -p ${port} @${address} ${zone} SOA`)
            ).out.trim();
            const serialText = answer.split(/\s+/)[2];
            if (!serialText || !/^\d+$/.test(serialText)) throw new Error("no answer");
            return Number(serialText);
          },
        },
      },
    },
  });
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: PORT,
    idleTimeout: 120,
    websocket: socketServer,
    fetch: (request, bun) =>
      harness.app.fetch(request, {
        peerAddress: bun.requestIP(request)?.address,
        upgrade: upgraderFor(bun),
      }),
  });
  linkServer = serveRunnerLink(harness.app, {
    hostname: "127.0.0.1",
    port: LINK_PORT,
    certificate: LINK.certificate,
    key: LINK.key,
    idleTimeoutSeconds: 120,
  });
  owner = await setUpNamedOwner(harness);

  const joining = await owner.post("/servers/host/join-command");
  expect(joining.status).toBe(200);
  await HOST.background(
    `/usr/local/bin/nearzero-runner join ${CONTROL_FROM_HOST} ${joining.body.token} --fingerprint sha256:${LINK.fingerprint}`,
    "/var/log/nearzero-runner.log",
    {
      NEARZERO_RUNNER_STATE_DIR: "/var/lib/nearzero-runner",
      NEARZERO_ROUTER_DIR: "/etc/nearzero/router",
      NEARZERO_ROUTER_HOST_DIR: "/etc/nearzero/router",
      NEARZERO_ROUTER_IMAGE: ROUTER_IMAGE,
      NEARZERO_ACME_EMAIL: `ops@${ZONE}`,
      NEARZERO_ACME_CA_SERVER: "https://pebble:14000/dir",
      NEARZERO_ACME_CA_CERTIFICATES: "/srv/pebble/minica.pem",
      NEARZERO_DNS_DIR: "/etc/nearzero/dns",
      NEARZERO_DNS_HOST_DIR: "/etc/nearzero/dns",
      NEARZERO_DNS_IMAGE: DNS_IMAGE,
      // The router's hold asks public DNS (G3-09); here the test's DNS is the public view.
      NEARZERO_DNS_RESOLVERS: testDnsIp,
    },
  );
  await eventually(
    "the host's runner and router",
    async () => {
      if (!harness.services.runners.isOnline("host")) return false;
      return (
        (await HOST.exec("docker inspect -f '{{.State.Running}}' nearzero-router")).out.trim() ===
        "true"
      );
    },
    180_000,
    1000,
  );
}, 1_200_000);

afterAll(async () => {
  if (HOST.name) {
    await HOST.exec("cat /var/log/nearzero-runner.log").then((r) => log("runner", r.out));
    await HOST.exec("docker logs nearzero-router 2>&1").then((r) => log("router", r.out));
    await HOST.exec("docker logs nz-pebble 2>&1").then((r) => log("pebble", r.out));
    await HOST.exec("docker logs nearzero1-dns 2>&1").then((r) => log("dns", r.out));
    await HOST.exec("ls -la /etc/nearzero/router; cat /etc/nearzero/router/*.yml").then((r) =>
      log("router-files", r.out),
    );
  }
  harness?.services.runners.stop();
  server?.stop(true);
  linkServer?.stop(true);
  await harness?.drop();
  if (KEEP) {
    console.log(`Kept ${HOST.name}; remove it with: docker rm -fv ${HOST.name}`);
    return;
  }
  await HOST.remove();
}, 120_000);

let issuedId = "";
let issuedHost = "";

describe("certificates wait for DNS (spec 10.2, 10.7)", () => {
  test("a hostname whose DNS is wrong is held, serves plain HTTP, and Pebble receives no order", async () => {
    const service = await app("web");
    const answer = await fakeDeploy(service);
    const route = answer.routes[0] as { host: string };
    issuedHost = route.host;
    expect(issuedHost).toMatch(/^[a-z][a-z0-9]{7}\.apps\.nzm4\.dev$/);
    expect(answer.notes[0]).toBe(
      `${issuedHost} is assigned, but it won't load until this DNS record exists: *.${PLATFORM_DOMAIN} A ${hostIp} (DNS only, not proxied). HTTPS starts on its own once it does.`,
    );
    const row = await harness.test.db
      .selectFrom("hostname")
      .select("id")
      .where("host", "=", issuedHost)
      .executeTakeFirstOrThrow();
    issuedId = row.id;
    // Checks run, and keep holding it.
    await harness.services.runners.command("host", "router.check-holds", {});
    await runCheckCycle(harness.services);
    await touchRouter();
    const file = await HOST.must(
      `grep -l '${issuedHost}' /etc/nearzero/router/route-*.yml | xargs cat`,
    );
    expect(file).not.toContain("certResolver");
    expect(
      await eventually(
        "plain HTTP while held",
        async () => (await httpStatus(issuedHost)) === "200",
        20_000,
      ),
    ).toBe(true);
    expect(await pebbleLines(issuedHost)).toEqual([]);
    expect(await routerFailures(issuedHost)).toBe(0);
    const view = await hostnameView(issuedId);
    expect(view.https.state).toBe("waiting_for_dns");
    expect(view.dns.label).toBe("Waiting for DNS");
  }, 180_000);

  test("once the record exists, the next check issues a certificate and HTTPS serves it", async () => {
    await setRecords([`*.apps IN A ${hostIp}`]);
    const started = Date.now();
    await runCheckCycle(harness.services);
    const page = await eventually(
      "HTTPS with Pebble's certificate",
      async () => {
        const text = await https(issuedHost);
        return text.includes("Welcome to nginx!") ? text : null;
      },
      120_000,
      2000,
    );
    expect(page).toContain("Welcome to nginx!");
    await log("issued-after", `${Date.now() - started} ms`);
    // HTTP now redirects to HTTPS.
    expect(await httpStatus(issuedHost)).toBe("301");
    const view = await eventually(
      "the Valid state",
      async () => {
        const current = await hostnameView(issuedId);
        return current.https.state === "valid" ? current : null;
      },
      60_000,
      2000,
    );
    expect(view.https.note).toEndWith("Renews automatically.");
    expect((await pebbleLines(issuedHost)).length).toBeGreaterThan(0);
  }, 300_000);
});

/**
 * A QUIC packet with a version no server speaks (0x1a2a3a4a, reserved for this), padded to 1200
 * bytes, sent to UDP 443 on the host: a QUIC server answers with Version Negotiation (RFC 9000
 * 6, 17.2.1). Returns the answer's bytes as hex, or "" without one.
 */
async function quicVersionNegotiation(): Promise<string> {
  const packet =
    "printf '\\300\\032\\052\\072\\112\\010\\001\\002\\003\\004\\005\\006\\007\\010\\010\\021\\022\\023\\024\\025\\026\\027\\030' > /tmp/quic.bin && dd if=/dev/zero bs=1177 count=1 2>/dev/null >> /tmp/quic.bin";
  await HOST.must(packet);
  expect((await HOST.must("wc -c < /tmp/quic.bin")).trim()).toBe("1200");
  const out = await HOST.exec("socat -t 3 - UDP:127.0.0.1:443 < /tmp/quic.bin | od -An -tx1 -v");
  return out.out.trim().split(/\s+/).join(" ");
}

describe("HTTP/3 (R3-22, R3-23)", () => {
  test("the router answers QUIC on UDP 443 and its HTTPS answers advertise HTTP/3", async () => {
    const bindings = await HOST.must(
      "docker inspect -f '{{json .HostConfig.PortBindings}}' nearzero-router",
    );
    expect(bindings).toContain('"8443/udp":[{"HostIp":"","HostPort":"443"}]');
    const headers = await HOST.must(
      `curl -s -D - -o /dev/null --max-time 5 --cacert /srv/pebble/root.pem --resolve ${issuedHost}:443:127.0.0.1 https://${issuedHost}/`,
    );
    await log("http3-headers", headers);
    expect(headers).toMatch(/^alt-svc: h3=":443"; ma=\d+\r?$/im);
    const answer = await eventually(
      "a QUIC answer on UDP 443",
      quicVersionNegotiation,
      30_000,
      2000,
    );
    await log("http3-quic", answer);
    // Long header, version 0 (Version Negotiation), our connection IDs swapped, then the versions
    // the router speaks, QUIC version 1 among them.
    expect(Number.parseInt(answer.slice(0, 2), 16) & 0x80).toBe(0x80);
    const rest = answer.slice(3);
    expect(rest).toStartWith("00 00 00 00 08 11 12 13 14 15 16 17 18 08 01 02 03 04 05 06 07 08");
    const versions = rest.slice(
      "00 00 00 00 08 11 12 13 14 15 16 17 18 08 01 02 03 04 05 06 07 08 ".length,
    );
    expect(versions.match(/.{11}( |$)/g)?.map((item) => item.trim())).toContain("00 00 00 01");
    // The host's details say it's on, and the main settings show it.
    const host = (await owner.get("/host")).body.host;
    expect(host.runner.http3).toEqual({ enabled: true, message: null });
    const files = (await owner.get("/servers/host/router-files")).body;
    expect(files.mainSettings.title).toBe("Main settings");
    expect(files.mainSettings.contents).toContain(
      '  websecure:\n    address: ":8443"\n    http3:\n      advertisedPort: 443',
    );
    expect(files.mainSettings.editable).toBe(false);
    const refused = await owner.put("/servers/host/router-files/main-settings", {
      contents: "entryPoints: {}\n",
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toBe(
      "Nearzero sets these when it starts the router, so they can't be edited here.",
    );
  }, 120_000);
});

describe("the back-off (spec 10.7)", () => {
  test("three failed validations pause requests; Retry gets one more, then is refused", async () => {
    const flaky = `flaky.${ZONE}`;
    // Everyone sees the server; Pebble is sent to an address where nothing listens on port 80.
    await setRecords(
      [`*.apps IN A ${hostIp}`, `flaky IN A ${hostIp}`],
      [`*.apps IN A ${hostIp}`, `flaky IN A ${testDnsIp}`],
    );
    const service = await app("flaky");
    await fakeDeploy(service);
    const added = await owner.post("/domains/hostnames", {
      hostname: flaky,
      connect: { serviceId: service.id },
    });
    expect(added.status).toBe(201);
    const id = added.body.hostname.id as string;
    await eventually(
      "the first failure",
      async () => (await routerFailures(flaky)) >= 1,
      90_000,
      2000,
    );
    for (let i = 0; i < 6 && (await routerFailures(flaky)) < 3; i++) {
      await touchRouter();
      await Bun.sleep(4000);
    }
    expect(await routerFailures(flaky)).toBe(3);
    const paused = await eventually(
      "the Paused state",
      async () => {
        const view = await hostnameView(id);
        return view.https.state === "paused" ? view : null;
      },
      60_000,
      2000,
    );
    expect(paused.https.note).toStartWith("Failed 3 times in the last hour");
    // More changes to the router don't ask again.
    const pebbleBefore = (await pebbleLines(flaky)).length;
    await touchRouter();
    await touchRouter();
    await Bun.sleep(5000);
    expect(await routerFailures(flaky)).toBe(3);
    expect((await pebbleLines(flaky)).length).toBe(pebbleBefore);
    const file = await HOST.must(`grep -l '${flaky}' /etc/nearzero/router/route-*.yml | xargs cat`);
    expect(file).not.toContain("certResolver");

    // Retry is allowed at 3 failures: one more attempt, which fails, and then it is refused.
    const retry = await owner.post(`/domains/hostnames/${id}/retry`);
    expect(retry.status).toBe(200);
    await eventually(
      "the fourth failure",
      async () => (await routerFailures(flaky)) >= 4,
      90_000,
      2000,
    );
    await hostnameView(id);
    const refused = await owner.post(`/domains/hostnames/${id}/retry`);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toStartWith(
      "Retry: Let's Encrypt allows 5 failed checks per hour. Try again after",
    );
    await owner.delete(`/domains/hostnames/${id}`);
  }, 600_000);
});

describe("removing a hostname (spec 10.4)", () => {
  test("it stops serving within 10 seconds", async () => {
    expect(await https(issuedHost)).toContain("Welcome to nginx!");
    const started = Date.now();
    const removed = await owner.delete(`/domains/hostnames/${issuedId}`);
    expect(removed.body.message).toBe(`Removed ${issuedHost}.`);
    await eventually(
      "the hostname to stop serving",
      async () => (await httpStatus(issuedHost)) === "404",
      10_000,
      250,
    );
    const took = Date.now() - started;
    await log("removed-after", `${took} ms`);
    expect(took).toBeLessThan(10_000);
    // Over HTTPS too: nothing routes there any more.
    expect(await https(issuedHost)).not.toContain("Welcome to nginx!");
    expect(
      (await HOST.exec(`grep -l '${issuedHost}' /etc/nearzero/router/route-*.yml`)).code,
    ).not.toBe(0);
  }, 60_000);
});

describe("managed DNS zones (spec 10.8)", () => {
  const dig = async (name: string) =>
    (await HOST.exec(`dig +short +time=2 +tries=1 @127.0.0.1 ${name} A`)).out.trim();

  // The workspace's first zone: connecting it moves the automatic hostnames that follow their
  // environment's default into it (R3-13), so this runs after the tests that use the platform
  // hostname issued above.
  test("a managed zone serves its records, and a hostname's record goes with it", async () => {
    const zoneName = `zone.${ZONE}`;
    const connected = await owner.post("/domains/zones", {
      domain: zoneName,
      adminEmail: `dns@${ZONE}`,
    });
    expect(connected.status).toBe(201);
    expect(connected.body.message).toStartWith("DNS zone connected.");
    const zoneId = connected.body.zone.id as string;
    await eventually(
      "the built-in DNS server",
      async () =>
        (await HOST.exec("docker inspect -f '{{.State.Running}}' nearzero1-dns")).out.trim() ===
        "true",
      60_000,
      1000,
    );
    const record = await owner.post(`/domains/zones/${zoneId}/records`, {
      name: "www",
      type: "A",
      value: "192.0.2.44",
      ttl: 60,
    });
    expect(record.status).toBe(201);
    await owner.post(`/domains/zones/${zoneId}/apply`);
    expect(
      await eventually(
        "www in the zone",
        async () => (await dig(`www.${zoneName}`)) === "192.0.2.44",
        30_000,
        1000,
      ),
    ).toBe(true);
    // Published, but nobody delegated it yet: not ready (G3-10).
    await checkZoneHealth(harness.services);
    const pending = await owner.get("/domains/zones");
    expect(pending.body.zones[0]).toMatchObject({
      name: zoneName,
      status: "delegation_pending",
      statusLabel: "Delegation pending",
    });
    expect(pending.body.zones[0].health).toContain(
      "Public NS differs from Nearzero: ns1.previous-dns.example",
    );
    // The registrar delegates it to Nearzero's nameservers, and the host answers SOA on its
    // public address: ready.
    await setZoneDelegation(connected.body.zone.nameservers as string[]);
    await checkZoneHealth(harness.services);
    const zones = await owner.get("/domains/zones");
    expect(zones.body.zones[0]).toMatchObject({
      name: zoneName,
      status: "live",
      statusLabel: "Live",
    });
    expect(zones.body.zones[0].health).toMatch(/^Serving \d+ records$/);

    const service = await app("store");
    const added = await owner.post("/domains/hostnames", {
      hostname: `store.${zoneName}`,
      connect: { serviceId: service.id },
    });
    expect(added.status).toBe(201);
    expect(
      await eventually(
        "the hostname's record",
        async () => (await dig(`store.${zoneName}`)) === hostIp,
        30_000,
        1000,
      ),
    ).toBe(true);
    await owner.delete(`/domains/hostnames/${added.body.hostname.id}`);
    expect(
      await eventually(
        "the record gone",
        async () => (await dig(`store.${zoneName}`)) === "",
        15_000,
        1000,
      ),
    ).toBe(true);
  }, 240_000);
});

describe("HTTP/3 when UDP 443 is taken (R3-22)", () => {
  test("the router starts without HTTP/3, and the host's details name the program holding the port", async () => {
    // Another program takes UDP 443 the moment the router is gone (one command, so the runner's
    // minute check can't bring the router back in between).
    await HOST.background(
      "docker rm -f nearzero-router >/dev/null; exec socat -u UDP4-RECV:443 OPEN:/dev/null",
      "/tmp/udp-holder.log",
    );
    await eventually(
      "socat on UDP 443",
      async () => (await HOST.exec("pgrep -x socat && grep -i ':01BB ' /proc/net/udp")).code === 0,
      15_000,
      500,
    );
    const state = (await harness.services.runners.command("host", "router.ensure", {})) as {
      running: boolean;
      http3?: { enabled: boolean; port: number; blockedBy: string | null };
    };
    expect(state.running).toBe(true);
    expect(state.http3).toEqual({ enabled: false, port: 443, blockedBy: "socat" });
    expect(
      await HOST.must("docker inspect -f '{{json .HostConfig.PortBindings}}' nearzero-router"),
    ).not.toContain("8443/udp");
    // It serves HTTPS all the same.
    expect(
      (
        await HOST.exec("curl -sk -o /dev/null -w '%{http_code}' --max-time 5 https://127.0.0.1/")
      ).out.trim(),
    ).toBe("404");
    const host = await eventually(
      "the host's details to say HTTP/3 is off",
      async () => {
        const view = (await owner.get("/host")).body.host;
        return view.runner.http3?.enabled === false ? view : null;
      },
      60_000,
      1000,
    );
    expect(host.runner.http3.message).toBe("HTTP/3 is off: UDP port 443 is in use by socat");
    const files = (await owner.get("/servers/host/router-files")).body;
    expect(files.mainSettings.contents).toContain("HTTP/3 is off: UDP port 443 is in use by socat");
    expect(files.mainSettings.contents).not.toContain("http3:");
    await HOST.exec("pkill socat");
  }, 180_000);
});
