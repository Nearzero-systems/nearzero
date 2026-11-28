import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  failureCountsTowardPause,
  HOUR_MS,
  type RouteSpec,
  routeSpecSchema,
} from "@nearzero/shared";
import type { DockerClient } from "../src/docker/client.ts";
import { certificatesIn, firstTarFile, parseAcmeLine, shortReason } from "../src/domains/acme.ts";
import { AttemptTracker } from "../src/domains/attempts.ts";
import { BuiltinDns } from "../src/domains/dns-server.ts";
import { DomainsRuntime, domainsSettings } from "../src/domains/runtime.ts";
import { CERTIFICATES_FILE, UploadedCertificates } from "../src/domains/uploads.ts";
import { silentLog } from "../src/log.ts";
import { routeFileContents } from "../src/router/files.ts";
import { Router } from "../src/router/router.ts";

/**
 * The runner's side of certificates (spec 10.7): reading the router's store and log, the
 * back-off that holds hostnames after failures, uploaded certificates and the custom mode.
 */

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nz-domains-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A self-signed certificate and its key, made with openssl for the test. */
async function selfSigned(names: string[], days = 30): Promise<{ cert: string; key: string }> {
  const work = await mkdtemp(join(tmpdir(), "nz-cert-"));
  const run = Bun.spawn(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      String(days),
      "-subj",
      `/CN=${names[0]}`,
      "-addext",
      `subjectAltName=${names.map((name) => `DNS:${name}`).join(",")}`,
      "-keyout",
      join(work, "key.pem"),
      "-out",
      join(work, "cert.pem"),
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  await run.exited;
  const result = {
    cert: await readFile(join(work, "cert.pem"), "utf8"),
    key: await readFile(join(work, "key.pem"), "utf8"),
  };
  await rm(work, { recursive: true, force: true });
  return result;
}

describe("the router's log: failed Let's Encrypt attempts", () => {
  const line = (fields: Record<string, unknown>) => JSON.stringify(fields);

  test("a failed validation names its hostnames and the reason", () => {
    const event = parseAcmeLine(
      line({
        level: "error",
        providerName: "letsencrypt.acme",
        acmeCA: "https://acme-v02.api.letsencrypt.org/directory",
        routerName: "nz-h-1-https@file",
        rule: "Host(`app.example.com`)",
        error:
          "unable to generate a certificate for the domains [app.example.com]: error: one or more domains had a problem:\n[app.example.com] acme: error: 400 :: urn:ietf:params:acme:error:connection :: 203.0.113.10: Fetching http://app.example.com/.well-known/acme-challenge/x: Connection refused",
        domains: ["app.example.com"],
        time: "2026-11-25T12:00:00Z",
        message: "Unable to obtain ACME certificate for domains",
      }),
    );
    expect(event).toMatchObject({
      hostnames: ["app.example.com"],
      at: Date.parse("2026-11-25T12:00:00Z"),
      rateLimited: false,
      counts: true,
    });
    expect(event?.message).toBe(
      "connection: 203.0.113.10: Fetching http://app.example.com/.well-known/acme-challenge/x: Connection refused",
    );
  });

  test("a rate limit is told apart; the hostname comes from the rule when the list is missing", () => {
    const event = parseAcmeLine(
      line({
        level: "error",
        rule: "Host(`a.example.com`)",
        error:
          "acme: error: 429 :: POST :: urn:ietf:params:acme:error:rateLimited :: too many certificates (5) already issued, retry after 2026-11-27 21:03:25 UTC",
        msg: "Unable to obtain ACME certificate for domains",
      }),
    );
    expect(event).toMatchObject({ hostnames: ["a.example.com"], rateLimited: true });
  });

  test("a line recorded from Traefik v3.7 with Pebble", async () => {
    const recorded = await readFile(
      join(import.meta.dir, "fixtures", "traefik-acme-failure.jsonl"),
      "utf8",
    );
    const event = parseAcmeLine(recorded);
    // Pebble checked the name and failed, so it counts toward the pause (R3-18).
    expect(event).toMatchObject({
      hostnames: ["flaky.nzm4.dev"],
      at: Date.parse("2026-11-25T00:32:16Z"),
      rateLimited: false,
      counts: true,
    });
    expect(event?.message).toEndWith("dial tcp 172.19.0.2:80: connect: connection refused");
    expect(event?.message).toStartWith("connection: Get ");
  });

  test("other lines are not failures", () => {
    expect(parseAcmeLine("not json")).toBeNull();
    expect(
      parseAcmeLine(line({ level: "info", message: "Configuration loaded from file" })),
    ).toBeNull();
    expect(
      parseAcmeLine(line({ level: "error", message: "Error while serving", error: "x" })),
    ).toBeNull();
    expect(shortReason("x".repeat(600)).length).toBe(400);
  });
});

describe("the back-off (spec 10.7)", () => {
  const failure = (at: number, raw = "urn:ietf:params:acme:error:dns :: NXDOMAIN") => ({
    hostnames: ["app.example.com"],
    at,
    rateLimited: raw.includes("rateLimited"),
    counts: failureCountsTowardPause(raw),
    message: shortReason(raw),
    raw,
  });

  test("R3-18: errors where Let's Encrypt never checked the name don't pause it", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const tracker = new AttemptTracker(null, () => now);
    const unreachable =
      "cannot get ACME client get directory at 'https://acme-v02.api.letsencrypt.org/directory': Get \"https://acme-v02.api.letsencrypt.org/directory\": dial tcp: lookup acme-v02.api.letsencrypt.org: no such host";
    for (const minutes of [30, 20, 10]) {
      expect(tracker.failure(failure(now - minutes * 60_000, unreachable))).toEqual([]);
    }
    const policy =
      'urn:ietf:params:acme:error:rejectedIdentifier :: Cannot issue for "app.example.com": forbidden by policy';
    expect(tracker.failure(failure(now - 5 * 60_000, policy))).toEqual([]);
    expect(tracker.backoff("app.example.com")).toBeNull();
    const [record] = tracker.records();
    expect(record).toMatchObject({ failures: [], lastErrorAt: now - 5 * 60_000 });
    expect(record?.lastError).toStartWith("rejectedIdentifier:");
    // The router's own log line for an unreachable Let's Encrypt is read the same way.
    const event = parseAcmeLine(
      JSON.stringify({
        level: "error",
        rule: "Host(`app.example.com`)",
        error: unreachable,
        message: "Unable to obtain ACME certificate for domains",
        time: "2026-11-25T11:59:00Z",
      }),
    );
    expect(event).toMatchObject({ hostnames: ["app.example.com"], counts: false });
  });

  test("three failed validations in an hour hold the hostname, a Retry lifts it", () => {
    let now = Date.parse("2026-11-25T12:00:00Z");
    const tracker = new AttemptTracker(null, () => now);
    expect(tracker.failure(failure(now - 30 * 60_000))).toEqual([]);
    expect(tracker.failure(failure(now - 20 * 60_000))).toEqual([]);
    expect(tracker.failure(failure(now - 10 * 60_000))).toEqual(["app.example.com"]);
    expect(tracker.backoff("app.example.com")).toBe("paused");
    // An hour after the first failure, it may ask again.
    now += 31 * 60_000;
    expect(tracker.backoff("app.example.com")).toBeNull();
    now -= 31 * 60_000;
    tracker.retried("app.example.com");
    expect(tracker.backoff("app.example.com")).toBeNull();
    expect(tracker.records()[0]).toMatchObject({ hostname: "app.example.com", retriedAt: now });
  });

  test("two failures logged in one second count twice; the same entry read again counts once", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const tracker = new AttemptTracker(null, () => now);
    // The router's log has whole seconds; each attempt's error names its own challenge.
    const attempt = (token: string) =>
      failure(now - 1_000, `urn:ietf:params:acme:error:connection :: acme-challenge/${token}`);
    expect(tracker.failure(failure(now - 5_000))).toEqual([]);
    expect(tracker.failure(attempt("first"))).toEqual([]);
    // After a reconnect the router's log is read again from that second.
    expect(tracker.failure(attempt("first"))).toEqual([]);
    expect(tracker.failure(attempt("second"))).toEqual(["app.example.com"]);
    expect(tracker.records()[0]?.failures).toHaveLength(3);
  });

  test("a rate limit holds until its retry-after time, or an hour", () => {
    const now = Date.parse("2026-11-25T12:00:00Z");
    const tracker = new AttemptTracker(null, () => now);
    tracker.failure(
      failure(
        now,
        "urn:ietf:params:acme:error:rateLimited :: slow down, retry after 2026-11-25 15:00:00 UTC",
      ),
    );
    expect(tracker.backoff("app.example.com")).toBe("rate_limited");
    expect(tracker.records()[0]?.rateLimitedUntil).toBe(Date.parse("2026-11-25T15:00:00Z"));
    const other = new AttemptTracker(null, () => now);
    other.failure(failure(now, "urn:ietf:params:acme:error:rateLimited :: too many new orders"));
    expect(other.records()[0]?.rateLimitedUntil).toBe(now + HOUR_MS);
  });

  test("it survives a restart", async () => {
    const file = join(dir, "certificates.json");
    const now = Date.now();
    const first = new AttemptTracker(file, () => now);
    for (const minutes of [3, 2, 1]) first.failure(failure(now - minutes * 60_000));
    await Bun.sleep(700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const second = new AttemptTracker(file, () => now);
    await second.load();
    expect(second.backoff("app.example.com")).toBe("paused");
    expect(second.lastLogAt).toBe(now - 60_000);
  });
});

describe("the router's certificate store", () => {
  test("acme.json certificates are read from Docker's tar archive, names and dates only", async () => {
    const { cert } = await selfSigned(["app.example.com"]);
    const json = JSON.stringify({
      letsencrypt: {
        Account: { Email: "" },
        Certificates: [
          {
            domain: { main: "app.example.com" },
            certificate: Buffer.from(cert).toString("base64"),
            key: "c2VjcmV0",
            Store: "default",
          },
        ],
      },
    });
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode("acme.json"), 0);
    header.set(new TextEncoder().encode(`${json.length.toString(8).padStart(11, "0")}\0`), 124);
    header[156] = "0".charCodeAt(0);
    const body = new Uint8Array(Math.ceil(json.length / 512) * 512);
    body.set(new TextEncoder().encode(json));
    const tar = new Uint8Array([...header, ...body, ...new Uint8Array(1024)]);
    const file = firstTarFile(tar);
    expect(new TextDecoder().decode(file as Uint8Array)).toBe(json);
    const [stored] = certificatesIn(json);
    expect(stored?.names).toEqual(["app.example.com"]);
    expect(stored?.notAfter).toBeGreaterThan(Date.now() + 20 * 24 * HOUR_MS);
    expect(JSON.stringify(stored)).not.toContain("c2VjcmV0");
  });
});

const route = (input: Record<string, unknown> = {}): RouteSpec =>
  routeSpecSchema.parse({
    key: "web",
    hostnames: ["app.example.com"],
    upstream: { host: "web-1", port: 3000 },
    ...input,
  });

function makeRouter(dns: Record<string, string[]>) {
  const router = new Router(
    {} as DockerClient,
    {
      directory: dir,
      hostDirectory: dir,
      image: "traefik:v3.7.18",
      acmeEmail: "",
      httpPort: 80,
      httpsPort: 443,
      network: "nearzero-edge",
    },
    silentLog,
    async (host) => dns[host] ?? [],
  );
  router.setPublicIPv4("203.0.113.10");
  return router;
}

describe("the router asks the certificates area first", () => {
  test("a backed-off hostname is held even though DNS points here; released when the back-off ends", async () => {
    const router = makeRouter({ "app.example.com": ["203.0.113.10"] });
    let backoff = true;
    const requested: string[] = [];
    router.gate = () => (backoff ? { mode: "hold", reason: "backoff" } : null);
    router.onRequested = (host) => requested.push(host);
    await router.write([route()]);
    let file = await readFile(join(dir, "route-web.yml"), "utf8");
    expect(file).not.toContain("certResolver");
    expect(router.gatedHostnames()).toEqual(["app.example.com"]);
    expect(router.state().held).toEqual([]);
    backoff = false;
    expect(await router.checkHolds()).toEqual({ released: ["app.example.com"], held: [] });
    file = await readFile(join(dir, "route-web.yml"), "utf8");
    expect(file).toContain('certResolver: "letsencrypt"');
    expect(requested).toEqual(["app.example.com"]);
  });

  test("Retry holds a hostname for a moment, then lets it ask again", async () => {
    const router = makeRouter({ "app.example.com": ["203.0.113.10"] });
    const requested: string[] = [];
    router.onRequested = (host) => requested.push(host);
    await router.write([route()]);
    const during = router.retry("app.example.com", 50);
    await Bun.sleep(20);
    expect(await readFile(join(dir, "route-web.yml"), "utf8")).not.toContain("certResolver");
    expect(await during).toBe(true);
    expect(await readFile(join(dir, "route-web.yml"), "utf8")).toContain("certResolver");
    expect(requested).toEqual(["app.example.com", "app.example.com"]);
    expect(await router.retry("nothing.example.com")).toBe(false);
  });

  test("an uploaded certificate's hostname is served with it, and HTTP redirects", () => {
    const file = routeFileContents(route(), new Map([["app.example.com", { mode: "custom" }]]));
    expect(file).not.toContain("certResolver");
    expect(file).toContain('"nz-web-custom-https"');
    expect(file).toContain("tls: {}");
    expect(file).toContain('middlewares: ["nearzero-redirect-https"]');
  });
});

describe("uploaded certificates on the router", () => {
  test("files are written for the router, keys owner-only, and stale ones removed", async () => {
    const wildcard = await selfSigned(["uploads.example.com", "*.uploads.example.com"]);
    const uploads = new UploadedCertificates(dir);
    expect(
      await uploads.sync([{ id: "one", certificatePem: wildcard.cert, keyPem: wildcard.key }]),
    ).toBe(true);
    expect(uploads.covers("app.uploads.example.com")).toBe(true);
    expect(uploads.covers("uploads.example.com")).toBe(true);
    expect(uploads.covers("a.b.uploads.example.com")).toBe(false);
    const files = await readdir(join(dir, "certificates"));
    expect(files.filter((name) => name.endsWith(".key"))).toHaveLength(1);
    const key = files.find((name) => name.endsWith(".key")) as string;
    expect((await stat(join(dir, "certificates", key))).mode & 0o777).toBe(0o600);
    const tls = await readFile(join(dir, CERTIFICATES_FILE), "utf8");
    expect(tls).toContain(
      `certFile: "/etc/nearzero/router/certificates/${key.replace(".key", ".crt")}"`,
    );
    const again = new UploadedCertificates(dir);
    await again.load();
    expect(again.covers("app.uploads.example.com")).toBe(true);
    expect(await uploads.sync([])).toBe(true);
    expect(await readdir(join(dir, "certificates"))).toEqual([]);
    expect(await Bun.file(join(dir, CERTIFICATES_FILE)).exists()).toBe(false);
  });
});

describe("the certificate contact email (spec 10.1, 10.9)", () => {
  function runtimeWith(email: string) {
    const router = makeRouter({});
    router.settings.acmeEmail = email;
    const runtime = new DomainsRuntime({
      docker: {} as DockerClient,
      router,
      log: silentLog,
      settings: domainsSettings({}, join(dir, "state")),
      containerized: false,
    });
    return { router, runtime };
  }

  test("the email saved under About Nearzero replaces the install's, and survives a restart", async () => {
    const { router, runtime } = runtimeWith("install@example.com");
    const before = await router.desiredContainer();
    expect((before.config as { Cmd: string[] }).Cmd).toContain(
      "--certificatesresolvers.letsencrypt.acme.email=install@example.com",
    );
    expect(await runtime.setContact("about@example.com")).toEqual({
      email: "about@example.com",
      changed: true,
    });
    const after = await router.desiredContainer();
    expect((after.config as { Cmd: string[] }).Cmd).toContain(
      "--certificatesresolvers.letsencrypt.acme.email=about@example.com",
    );
    // The router is recreated for it: its fingerprint changed.
    expect(after.fingerprint).not.toBe(before.fingerprint);
    const saved = join(dir, "state", "certificate-contact.json");
    expect((await stat(saved)).mode & 0o777).toBe(0o600);
    expect(await runtime.setContact("about@example.com")).toEqual({
      email: "about@example.com",
      changed: false,
    });
    // After a restart the saved email is used before the router is first checked.
    const restarted = runtimeWith("install@example.com");
    await restarted.runtime.loadContact();
    expect(restarted.router.settings.acmeEmail).toBe("about@example.com");
  });

  test("without a saved email the install's stays", async () => {
    const { router, runtime } = runtimeWith("install@example.com");
    await runtime.loadContact();
    expect(router.settings.acmeEmail).toBe("install@example.com");
  });
});

describe("the built-in DNS server's container (B2-13)", () => {
  function fakeDocker(binding: { HostIp: string; HostPort: string }, owner = "runner") {
    const calls: string[] = [];
    let container: Record<string, unknown> | null = {
      Config: { Labels: { "dev.nearzero.dns-owner": owner } },
      State: { Running: false },
      HostConfig: { Binds: [], PortBindings: { "1053/udp": [binding], "1053/tcp": [binding] } },
    };
    const docker = {
      findContainer: async () => container,
      imageExists: async () => true,
      removeContainer: async () => {
        calls.push("remove");
        container = null;
      },
      createContainer: async (_name: string, config: { HostConfig: { PortBindings: unknown } }) => {
        calls.push(`create ${JSON.stringify(config.HostConfig.PortBindings)}`);
      },
      startContainer: async () => {
        calls.push("start");
      },
    };
    return { docker: docker as unknown as DockerClient, calls };
  }

  async function applyWith(docker: DockerClient, bindAddress: string) {
    const dir = await mkdtemp(join(tmpdir(), "nz-dns-"));
    try {
      const dns = new BuiltinDns(docker, silentLog, {
        directory: dir,
        hostDirectory: async () => dir,
        image: "coredns/coredns:1.15.0",
        bindAddress,
        port: 53,
        network: null,
      });
      await dns.apply("example.net:1053 {}\n", [{ name: "example.net", content: "x" }]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("a leftover server on the old address is created again on the new one, not started", async () => {
    const { docker, calls } = fakeDocker({ HostIp: "0.0.0.0", HostPort: "53" });
    await applyWith(docker, "10.0.0.5");
    expect(calls).toEqual([
      "remove",
      `create ${JSON.stringify({ "1053/udp": [{ HostIp: "10.0.0.5", HostPort: "53" }], "1053/tcp": [{ HostIp: "10.0.0.5", HostPort: "53" }] })}`,
      "start",
    ]);
  });

  test("one on the right address is only started; the installer's own is left to it", async () => {
    const same = fakeDocker({ HostIp: "10.0.0.5", HostPort: "53" });
    await applyWith(same.docker, "10.0.0.5");
    expect(same.calls).toEqual(["start"]);
    const installers = fakeDocker({ HostIp: "0.0.0.0", HostPort: "53" }, "");
    await applyWith(installers.docker, "10.0.0.5");
    expect(installers.calls).toEqual(["start"]);
  });
});
