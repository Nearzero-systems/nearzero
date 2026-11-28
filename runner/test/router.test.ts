import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RouteSpec, routeSpecSchema } from "@nearzero/shared";
import type { DockerClient } from "../src/docker/client.ts";
import { silentLog } from "../src/log.ts";
import {
  MIDDLEWARES_FILE,
  REDIRECT_MIDDLEWARE,
  RouteFiles,
  routeFileContents,
  routeRule,
} from "../src/router/files.ts";
import { holdReason, neverPublic, publicLookup, publicResolvers } from "../src/router/holds.ts";
import {
  CERTIFICATES_OWNER_CONTAINER,
  certificatesOwnerConfig,
  Router,
} from "../src/router/router.ts";
import { FakeDns } from "./support/fake-dns.ts";

/** Route files for the router (spec 10.1, 10.7) and the certificate hold. */

const route = (input: Record<string, unknown> = {}): RouteSpec =>
  routeSpecSchema.parse({
    key: "web",
    hostnames: ["app.example.com"],
    upstream: { host: "web-abc123", port: 3000 },
    ...input,
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nz-router-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("route rules and files", () => {
  test("hostnames and a path become a Traefik rule", () => {
    expect(routeRule(["a.example.com"], "/")).toBe("Host(`a.example.com`)");
    expect(routeRule(["a.example.com", "b.example.com"], "/api")).toBe(
      "(Host(`a.example.com`) || Host(`b.example.com`)) && PathPrefix(`/api`)",
    );
  });

  test("the schema refuses anything that could break out of a rule", () => {
    for (const hostname of ["a`) || Host(`b", "a b.com", "-a.com", "a..com", "é.com"]) {
      expect(routeSpecSchema.safeParse({ ...route(), hostnames: [hostname] }).success).toBe(false);
    }
    for (const path of ["no-slash", "/a b", "/`x`"]) {
      expect(routeSpecSchema.safeParse({ ...route(), path }).success).toBe(false);
    }
    expect(routeSpecSchema.safeParse({ ...route(), key: "Bad Key" }).success).toBe(false);
    expect(route({ hostnames: ["APP.Example.com"] }).hostnames).toEqual(["app.example.com"]);
  });

  test("an issued hostname gets Let's Encrypt and an HTTPS redirect", () => {
    const file = routeFileContents(
      route(),
      new Map([["app.example.com", { mode: "letsencrypt" }]]),
    );
    expect(file).toContain('certResolver: "letsencrypt"');
    expect(file).toContain(`middlewares: ["${REDIRECT_MIDDLEWARE}"]`);
    expect(file).toContain('- url: "http://web-abc123:3000"');
    expect(file).not.toContain("tls: {}");
  });

  test("R3-26: a route kept out of the request log says so on every router (Traefik v3 observability)", () => {
    const quiet = routeFileContents(
      route({ accessLog: false, hostnames: ["nearzero.example.com"] }),
      new Map([["nearzero.example.com", { mode: "letsencrypt" }]]),
    );
    // Both the HTTPS router and the HTTP redirect router stay out of the log.
    expect(quiet.match(/observability:\n {8}accessLogs: false/g)).toHaveLength(2);
    const loud = routeFileContents(
      route(),
      new Map([["app.example.com", { mode: "letsencrypt" }]]),
    );
    expect(loud).not.toContain("observability");
    expect(route().accessLog).toBe(true);
  });

  test("a held hostname gets the placeholder certificate and plain HTTP, never Let's Encrypt", () => {
    const file = routeFileContents(
      route(),
      new Map([["app.example.com", { mode: "hold", reason: "points_elsewhere" }]]),
    );
    expect(file).toContain("tls: {}");
    expect(file).not.toContain("certResolver");
    expect(file).not.toContain(REDIRECT_MIDDLEWARE);
  });

  test("files are written atomically, only when they change, and sync leaves others alone", async () => {
    const files = new RouteFiles(dir);
    await files.prepare();
    await writeFile(join(dir, "console.yml"), "# the installer's\n");
    const certificates = new Map([["app.example.com", { mode: "letsencrypt" as const }]]);
    expect(await files.write(route(), certificates)).toBe(true);
    expect(await files.write(route(), certificates)).toBe(false);
    expect(
      await files.write(route({ key: "api", hostnames: ["api.example.com"] }), new Map()),
    ).toBe(true);
    expect((await files.keys()).sort()).toEqual(["api", "web"]);
    expect(await files.remove("api")).toBe(true);
    const names = (await readdir(dir)).sort();
    expect(names).toEqual(["console.yml", MIDDLEWARES_FILE, "route-web.yml"]);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    expect(await readFile(join(dir, "console.yml"), "utf8")).toBe("# the installer's\n");
  });

  test("a person's own file is saved in the folder; the runner's files and other paths are refused (spec 18.3)", async () => {
    const files = new RouteFiles(dir);
    await files.prepare();
    expect(await files.writeOwn("my-rules.yml", "http: {}\n")).toEqual({
      name: "my-rules.yml",
      contents: "http: {}\n",
    });
    expect(await readFile(join(dir, "my-rules.yml"), "utf8")).toBe("http: {}\n");
    await expect(files.writeOwn("route-web.yml", "x: 1\n")).rejects.toThrow("Managed by Nearzero");
    await expect(files.writeOwn(MIDDLEWARES_FILE, "x: 1\n")).rejects.toThrow("Managed by Nearzero");
    await expect(files.writeOwn("../outside.yml", "x: 1\n")).rejects.toThrow(
      "Paths outside it are refused",
    );
    expect((await files.list()).map((file) => file.name)).toContain("my-rules.yml");
  });
});

describe("the certificate hold (spec 10.7)", () => {
  test("names no public authority issues for are always held", () => {
    for (const name of [
      "test.localhost",
      "localhost",
      "box.local",
      "a.test",
      "10.0.0.1",
      "intranet",
    ]) {
      expect(neverPublic(name)).toBe(true);
    }
    expect(neverPublic("app.example.com")).toBe(false);
  });

  test("DNS decides: here releases, elsewhere, missing or failing holds", async () => {
    const lookup = (answers: Record<string, string[] | Error>) => async (host: string) => {
      const answer = answers[host];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    };
    const notFound = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    const answers = lookup({
      "here.example.com": ["198.51.100.7", "198.51.100.8"],
      "there.example.com": ["192.0.2.1"],
      "gone.example.com": notFound,
      "slow.example.com": timeout,
    });
    const none = async () => [] as string[];
    expect(await holdReason("here.example.com", "198.51.100.7", answers, none)).toBeNull();
    expect(await holdReason("there.example.com", "198.51.100.7", answers, none)).toBe(
      "points_elsewhere",
    );
    expect(await holdReason("gone.example.com", "198.51.100.7", answers, none)).toBe("no_record");
    expect(await holdReason("here.example.com", null, answers, none)).toBe("address_unknown");
  });

  test("R3-11: proxied names, IPv6-only names and failed lookups let Let's Encrypt try", async () => {
    const notFound = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    const timeout = Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    const v4: Record<string, string[] | Error> = {
      "cf.example.com": ["104.16.1.1", "172.67.2.2"],
      "fastly.example.com": ["151.101.1.57"],
      "bunny.example.com": ["89.187.188.227"],
      "arvan.example.com": ["185.143.232.10"],
      "mixed.example.com": ["104.16.1.1", "192.0.2.1"],
      "v6.example.com": notFound,
      "slow.example.com": timeout,
    };
    const lookup = async (host: string) => {
      const answer = v4[host];
      if (answer instanceof Error) throw answer;
      return answer ?? [];
    };
    const lookup6 = async (host: string) => (host === "v6.example.com" ? ["2001:db8::7"] : []);
    for (const name of [
      "cf.example.com",
      "fastly.example.com",
      "bunny.example.com",
      "arvan.example.com",
      "v6.example.com",
      // One failed lookup never holds a name (it would drop a working certificate's redirect).
      "slow.example.com",
    ]) {
      expect(await holdReason(name, "198.51.100.7", lookup, lookup6)).toBeNull();
    }
    // Only "no record" and "another address that isn't a proxy" hold.
    expect(await holdReason("mixed.example.com", "198.51.100.7", lookup, lookup6)).toBe(
      "points_elsewhere",
    );
    expect(await holdReason("gone.example.com", "198.51.100.7", async () => [], lookup6)).toBe(
      "no_record",
    );
  });

  test("G3-09: the hold asks public DNS, as Let's Encrypt does, not the server's own resolver", async () => {
    const publicDns = new FakeDns();
    const server = await publicDns.start();
    try {
      // Public DNS points the name at the server; the server's resolver (a cloud's private
      // zone) answers a private address.
      publicDns.records.set("shop.example.com", ["198.51.100.7"]);
      const local = async () => ["10.0.0.5"];
      const lookup = publicLookup(4, [server], local);
      expect(
        await holdReason("shop.example.com", "198.51.100.7", lookup, async () => []),
      ).toBeNull();
      expect(publicDns.questions).toContain("shop.example.com");
      // A stale negative answer locally never holds it either; public DNS's "no record" does.
      const missing = publicLookup(4, [server], async () => {
        throw Object.assign(new Error("gone"), { code: "ENOTFOUND" });
      });
      expect(
        await holdReason("shop.example.com", "198.51.100.7", missing, async () => []),
      ).toBeNull();
      expect(await holdReason("none.example.com", "198.51.100.7", missing, async () => [])).toBe(
        "no_record",
      );
      // Only when public DNS can't be reached does the server's own resolver answer.
      const unreachable = publicLookup(4, ["127.0.0.1:9"], local);
      expect(await unreachable("shop.example.com")).toEqual(["10.0.0.5"]);
    } finally {
      publicDns.stop();
    }
    expect(publicResolvers(undefined)).toEqual(["1.1.1.1", "8.8.8.8"]);
    expect(publicResolvers("10.9.0.2:5353, 9.9.9.9 , nope")).toEqual(["10.9.0.2:5353", "9.9.9.9"]);
  });

  test("R3-10: a failed lookup of the server's name at connect holds nothing, and the next check's address is used", async () => {
    const dns: Record<string, string[]> = {
      "app.example.com": ["198.51.100.7"],
      "moved.example.com": ["198.51.100.9"],
    };
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
      async () => [],
    );
    // The welcome had no address: the server's name didn't resolve just then.
    router.setPublicIPv4(null);
    expect(router.setPublicIPv4(null, { lookupFailed: true })).toBe(true);
    await router.write([route({ hostnames: ["app.example.com", "moved.example.com"] })]);
    // HTTPS (and its redirect) stays: nothing is held for an address nobody knows yet.
    expect(router.state().held).toEqual([]);
    expect(await readFile(join(dir, "route-web.yml"), "utf8")).toContain("certResolver");
    // The 5-minute check knows the address: names pointing elsewhere are held, with no reconnect.
    expect(router.setPublicIPv4("198.51.100.7")).toBe(true);
    await router.checkHolds({ addressChanged: true });
    expect(router.state().held).toEqual([
      { hostname: "moved.example.com", reason: "points_elsewhere" },
    ]);
    // Another failed lookup keeps the address it has.
    expect(router.setPublicIPv4(null, { lookupFailed: true })).toBe(false);
    expect(router.publicIPv4).toBe("198.51.100.7");
    // The name now resolves to a new address: the next check follows it.
    expect(router.setPublicIPv4("198.51.100.9")).toBe(true);
    const after = await router.checkHolds({ addressChanged: true });
    expect(after.released).toEqual(["moved.example.com"]);
    expect(router.state().held).toEqual([
      { hostname: "app.example.com", reason: "points_elsewhere" },
    ]);
  });

  test("a held hostname is released once DNS points here, and its file is rewritten", async () => {
    const dns: Record<string, string[]> = { "app.example.com": ["192.0.2.1"] };
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
    router.setPublicIPv4("198.51.100.7");
    await router.write([route()]);
    expect(router.state().held).toEqual([
      { hostname: "app.example.com", reason: "points_elsewhere" },
    ]);
    expect(await readFile(join(dir, "route-web.yml"), "utf8")).not.toContain("certResolver");
    dns["app.example.com"] = ["198.51.100.7"];
    expect(await router.checkHolds()).toEqual({ released: ["app.example.com"], held: [] });
    expect(await readFile(join(dir, "route-web.yml"), "utf8")).toContain("certResolver");
    // Sync with nothing removes it.
    expect(await router.sync([])).toEqual({ written: [], removed: ["web"] });
    expect(router.state().routes).toBe(0);
  });
});

describe("the router under SELinux (C2-08)", () => {
  /** A Docker Engine that records the router it is asked to create. */
  function engine(selinux: boolean | null) {
    const created: { HostConfig: { Binds: string[] } }[] = [];
    const docker = {
      ...(selinux === null ? {} : { selinuxEnabled: async () => selinux }),
      findNetwork: async () => ({ Name: "nearzero-edge" }),
      findVolume: async () => ({ Name: "certificates" }),
      imageExists: async () => true,
      findContainer: async () => null,
      createContainer: async (_name: string, config: { HostConfig: { Binds: string[] } }) => {
        created.push(config);
      },
      startContainer: async () => {},
      waitContainer: async () => ({ StatusCode: 0 }),
      removeContainer: async () => {},
      call: async () => {},
    } as unknown as DockerClient;
    return { docker, created };
  }

  test("its folders are relabelled where the daemon labels containers, and only there", async () => {
    const binds: Record<string, string[]> = {};
    for (const [name, selinux] of [
      ["on", true],
      ["off", false],
      ["unknown", null],
    ] as const) {
      const { docker, created } = engine(selinux);
      const router = new Router(
        docker,
        {
          directory: dir,
          hostDirectory: "/etc/nearzero/router",
          image: "traefik:v3.7.18",
          acmeEmail: "",
          httpPort: 80,
          httpsPort: 443,
          network: "nearzero-edge",
        },
        silentLog,
      );
      router.accessLogEnabled = true;
      await router.ensure().catch(() => {});
      binds[name] = created.at(-1)?.HostConfig.Binds ?? [];
    }
    expect(binds.on).toEqual([
      "/etc/nearzero/router:/etc/nearzero/router:ro,z",
      "/etc/nearzero/router/access-log:/var/log/nearzero-router:z",
    ]);
    // Without SELinux nothing changes: the same binds, so the same settings fingerprint.
    expect(binds.off).toEqual([
      "/etc/nearzero/router:/etc/nearzero/router:ro",
      "/etc/nearzero/router/access-log:/var/log/nearzero-router",
    ]);
    expect(binds.unknown).toEqual(binds.off);
  });

  test("the runner asks the daemon once, from its security options", async () => {
    const { DockerClient } = await import("../src/docker/client.ts");
    let asked = 0;
    const client = new DockerClient({ socketPath: "/nowhere.sock" });
    (client as unknown as { info: () => Promise<unknown> }).info = async () => {
      asked++;
      return { SecurityOptions: ["name=seccomp,profile=builtin", "name=selinux"] };
    };
    expect(await client.selinuxEnabled()).toBe(true);
    expect(await client.selinuxEnabled()).toBe(true);
    expect(asked).toBe(1);
    const plain = new DockerClient({ socketPath: "/nowhere.sock" });
    (plain as unknown as { info: () => Promise<unknown> }).info = async () => ({
      SecurityOptions: ["name=seccomp,profile=builtin", "name=cgroupns"],
    });
    expect(await plain.selinuxEnabled()).toBe(false);
  });
});

describe("the router container", () => {
  test("a setting changed while the first check creates the router is applied by one more check", async () => {
    // A pretend Docker Engine that answers slowly, like a real one creating a container.
    const containers = new Map<
      string,
      {
        Config: { Image: string; Labels: Record<string, string>; Cmd: string[] };
        State: { Running: boolean };
      }
    >();
    let created = 0;
    const docker = {
      findNetwork: async () => ({ Name: "nearzero-edge" }),
      findVolume: async () => ({ Name: "certificates" }),
      imageExists: async () => true,
      findContainer: async (name: string) => containers.get(name) ?? null,
      inspectContainer: async (name: string) => containers.get(name),
      createContainer: async (
        name: string,
        config: { Image: string; Labels: Record<string, string>; Cmd: string[] },
      ) => {
        await Bun.sleep(50);
        created++;
        containers.set(name, { Config: config, State: { Running: false } });
      },
      startContainer: async (name: string) => {
        const container = containers.get(name);
        if (container) container.State.Running = true;
      },
      stopContainer: async (name: string) => {
        const container = containers.get(name);
        if (container) container.State.Running = false;
      },
      removeContainer: async (name: string) => {
        containers.delete(name);
      },
      waitContainer: async () => ({ StatusCode: 0 }),
      call: async (_method: string, path: string, options: { query: { name: string } }) => {
        const from = path.split("/")[2] ?? "";
        const container = containers.get(from);
        if (container) {
          containers.delete(from);
          containers.set(options.query.name, container);
        }
      },
    } as unknown as DockerClient;
    const router = new Router(
      docker,
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
    );
    const first = router.ensure();
    // The request log is turned on just after the runner connects, while that check runs.
    await Bun.sleep(10);
    router.accessLogEnabled = true;
    await Promise.all([first, router.ensure()]);
    const wanted = await router.desiredContainer();
    const running = containers.get("nearzero-router");
    expect(running?.Config.Labels).toEqual(wanted.config.Labels as Record<string, string>);
    expect(running?.Config.Cmd).toContain("--accesslog=true");
    // Nothing changed since: the next check leaves the router alone (and its volume's owner).
    const before = created;
    await router.ensure();
    expect(created).toBe(before);
    // Each start waits 1.5 s to see that the router stays up.
  }, 20_000);

  test("B2-02: the certificates volume is given to the router's user before the router starts, once per start", async () => {
    const events: string[] = [];
    const created = new Map<string, Record<string, unknown>>();
    let running = false;
    let routerLabels: Record<string, string> = {};
    let ownerExit = 10;
    const docker = {
      findNetwork: async () => ({ Name: "nearzero-edge" }),
      findVolume: async () => ({ Name: "nearzero-router-certificates" }),
      imageExists: async () => true,
      findContainer: async (name: string) =>
        name === "nearzero-router" && created.has(name)
          ? {
              Config: { Image: "traefik:v3.7.18", Labels: routerLabels },
              State: { Running: running },
            }
          : null,
      inspectContainer: async () => ({
        Config: { Image: "traefik:v3.7.18" },
        State: { Running: true },
      }),
      createContainer: async (name: string, config: Record<string, unknown>) => {
        events.push(`create ${name}`);
        created.set(name, config);
        if (name === "nearzero-router") routerLabels = config.Labels as Record<string, string>;
      },
      startContainer: async (name: string) => {
        events.push(`start ${name}`);
        if (name === "nearzero-router") running = true;
      },
      waitContainer: async (name: string) => {
        events.push(`wait ${name}`);
        return { StatusCode: ownerExit };
      },
      removeContainer: async (name: string) => {
        if (name === CERTIFICATES_OWNER_CONTAINER && created.has(name)) {
          events.push(`remove ${name}`);
          created.delete(name);
        }
      },
      call: async (method: string, path: string) => {
        events.push(`${method} ${path}`);
      },
    } as unknown as DockerClient;
    const router = new Router(
      docker,
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
    );
    const info = await stat(dir);
    const user = `${info.uid}:${info.gid}`;
    await router.ensure();
    // The volume is given away first, by a root container with only chown's rights…
    expect(events.slice(0, 4)).toEqual([
      `create ${CERTIFICATES_OWNER_CONTAINER}`,
      `start ${CERTIFICATES_OWNER_CONTAINER}`,
      `wait ${CERTIFICATES_OWNER_CONTAINER}`,
      `remove ${CERTIFICATES_OWNER_CONTAINER}`,
    ]);
    expect(events.slice(4)).toEqual(["create nearzero-router", "start nearzero-router"]);
    expect(created.get("nearzero-router")?.User).toBe(user);
    const helper = certificatesOwnerConfig("traefik:v3.7.18", user);
    expect(helper.User).toBe("0:0");
    expect((helper.Entrypoint as string[]).at(-1)).toBe(user);
    expect(helper.HostConfig).toMatchObject({
      NetworkMode: "none",
      CapDrop: ["ALL"],
      Mounts: [{ Type: "volume", Source: "nearzero-router-certificates", Target: "/certificates" }],
    });
    // …and not again while this runner runs.
    events.length = 0;
    await router.ensure();
    expect(events).toEqual([]);

    // A runner started on an existing router whose store was root's restarts the router.
    const restarted = new Router(docker, router.settings, silentLog);
    events.length = 0;
    await restarted.ensure();
    expect(events).toEqual([
      `create ${CERTIFICATES_OWNER_CONTAINER}`,
      `start ${CERTIFICATES_OWNER_CONTAINER}`,
      `wait ${CERTIFICATES_OWNER_CONTAINER}`,
      `remove ${CERTIFICATES_OWNER_CONTAINER}`,
      "POST /containers/nearzero-router/restart",
    ]);
    // One whose store was already right is left running.
    ownerExit = 0;
    const third = new Router(docker, router.settings, silentLog);
    events.length = 0;
    await third.ensure();
    expect(events).not.toContain("POST /containers/nearzero-router/restart");
  }, 20_000);
});
