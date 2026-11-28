import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerClient } from "../src/docker/client.ts";
import { silentLog } from "../src/log.ts";
import { mainSettingsText, optionsAsYaml } from "../src/router/main-settings.ts";
import { Router, routerOptions } from "../src/router/router.ts";
import {
  procUdpHolder,
  socketsOnPort,
  UDP_HOLDER_SCRIPT,
  udpHolderHelperConfig,
} from "../src/router/udp-port.ts";

/**
 * HTTP/3 on every router (R3-22): UDP 443 next to TCP 443 with Alt-Svc naming the published
 * port, and a router without HTTP/3 instead of none when something else holds UDP 443. The
 * router's main settings as Router files shows them (R3-23).
 */

const SETTINGS = {
  directory: "",
  hostDirectory: "",
  image: "traefik:v3.7.18",
  acmeEmail: "ops@example.com",
  httpPort: 80,
  httpsPort: 443,
  network: "nearzero-edge",
};

let dir: string;
let proc: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nz-router-h3-"));
  proc = join(dir, "proc");
  await mkdir(join(proc, "net"), { recursive: true });
  await writeFile(join(proc, "net", "udp"), UDP_HEADER);
  await writeFile(join(proc, "net", "udp6"), UDP_HEADER);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const UDP_HEADER =
  "   sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode ref pointer drops\n";

/** A /proc/net/udp line for a socket bound to `port` with `inode`. */
function udpLine(port: number, inode: number, address = "00000000"): string {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return `  12: ${address}:${hex} 00000000:0000 07 00000000:00000000 00:00000000 00000000     0        0 ${inode} 2 0000000000000000 0\n`;
}

/** A process in the fake /proc holding `inode` among its descriptors. */
async function processWith(pid: number, comm: string, inode: number | null): Promise<void> {
  await mkdir(join(proc, String(pid), "fd"), { recursive: true });
  await writeFile(join(proc, String(pid), "comm"), `${comm}\n`);
  await symlink("/dev/null", join(proc, String(pid), "fd", "0"));
  if (inode !== null) await symlink(`socket:[${inode}]`, join(proc, String(pid), "fd", "7"));
}

describe("the router's options (R3-22, R3-23)", () => {
  test("HTTP/3 is on the HTTPS entry point and advertises the published port", () => {
    const on = routerOptions({ ...SETTINGS, httpsPort: 8443 }, { accessLog: false, http3: true });
    expect(on).toContain("--entrypoints.websecure.http3=true");
    expect(on).toContain("--entrypoints.websecure.http3.advertisedport=8443");
    const off = routerOptions(SETTINGS, { accessLog: false, http3: false });
    expect(off.some((option) => option.includes("http3"))).toBe(false);
  });

  test("the main settings read as Traefik's YAML with its own names", () => {
    const yaml = optionsAsYaml(routerOptions(SETTINGS, { accessLog: true, http3: true }));
    expect(yaml).toContain(`global:
  checkNewVersion: false
  sendAnonymousUsage: false`);
    expect(yaml).toContain(`entryPoints:
  web:
    address: ":8080"
  websecure:
    address: ":8443"
    http3:
      advertisedPort: 443`);
    expect(yaml).toContain(`certificatesResolvers:
  letsencrypt:
    acme:
      email: "ops@example.com"
      storage: "/certificates/acme.json"
      httpChallenge:
        entryPoint: "web"`);
    expect(yaml).toContain(`accessLog:
  filePath: "/var/log/nearzero-router/access.log"
  format: "json"
  bufferingSize: 0`);
    expect(yaml).toContain('      names:\n        User-Agent: "keep"');
    const text = mainSettingsText(
      routerOptions(SETTINGS, { accessLog: false, http3: false }),
      SETTINGS,
      {
        enabled: false,
        port: 443,
        blockedBy: "caddy",
      },
    );
    expect(text).toStartWith(
      "# The router's main settings, as Nearzero sets them when it starts the router.\n",
    );
    expect(text).toContain("HTTP/3 is off: UDP port 443 is in use by caddy");
  });
});

describe("who holds UDP 443 (R3-22)", () => {
  test("a socket on the port is found in /proc/net/udp, with the process holding it", async () => {
    expect(socketsOnPort(UDP_HEADER + udpLine(443, 4242) + udpLine(53, 99), 443)).toEqual(["4242"]);
    expect(socketsOnPort(UDP_HEADER + udpLine(4430, 1), 443)).toEqual([]);
    expect(await procUdpHolder(proc, 443)).toBeNull();
    await processWith(10, "sshd", null);
    await processWith(31, "caddy", 4242);
    await writeFile(join(proc, "net", "udp6"), UDP_HEADER + udpLine(443, 4242, "0".repeat(32)));
    expect(await procUdpHolder(proc, 443)).toBe("caddy");
    // A socket no process holds (a kernel one, like WireGuard's) is still taken.
    await writeFile(join(proc, "net", "udp"), UDP_HEADER + udpLine(443, 0));
    await writeFile(join(proc, "net", "udp6"), UDP_HEADER);
    expect(await procUdpHolder(proc, 443)).toBe("another program");
  });

  test("the helper container's script finds the same, and only reads", async () => {
    const run = async () => {
      const child = Bun.spawn(["sh", "-c", UDP_HOLDER_SCRIPT, "sh", "443", proc], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      return out.trim();
    };
    expect(await run()).toBe("");
    await processWith(10, "sshd", null);
    await processWith(77, "nc", 5150);
    await writeFile(join(proc, "net", "udp"), UDP_HEADER + udpLine(443, 5150));
    expect(await run()).toBe("nc");
    await writeFile(join(proc, "net", "udp"), UDP_HEADER + udpLine(443, 6000));
    expect(await run()).toBe("?");
    const config = udpHolderHelperConfig("traefik:v3.7.18", 443) as {
      HostConfig: Record<string, unknown>;
    };
    expect(config.HostConfig).toMatchObject({
      NetworkMode: "host",
      PidMode: "host",
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
    });
    expect(config.HostConfig.Privileged).toBeUndefined();
    expect(config.HostConfig.Binds).toBeUndefined();
  });
});

interface FakeContainer {
  Config: { Image: string; Labels: Record<string, string>; Cmd: string[] };
  State: { Running: boolean };
  HostConfig: { PortBindings: Record<string, unknown> };
}

/**
 * A pretend Docker Engine; `udpTaken` makes starting a container that publishes UDP fail, and
 * `tcpTaken` makes every start fail (80 or 443 is someone else's).
 */
function fakeDocker(options: { udpTaken?: () => boolean; tcpTaken?: () => boolean } = {}) {
  const containers = new Map<string, FakeContainer>();
  const docker = {
    findNetwork: async () => ({ Name: "nearzero-edge" }),
    findVolume: async () => ({ Name: "certificates" }),
    imageExists: async () => true,
    listContainers: async () => [],
    findContainer: async (name: string) => containers.get(name) ?? null,
    inspectContainer: async (name: string) => containers.get(name),
    createContainer: async (
      name: string,
      config: FakeContainer["Config"] & { HostConfig: FakeContainer["HostConfig"] },
    ) => {
      if (containers.has(name)) throw new Error(`Conflict: ${name} exists`);
      containers.set(name, {
        Config: config,
        State: { Running: false },
        HostConfig: config.HostConfig,
      });
    },
    startContainer: async (name: string) => {
      const container = containers.get(name);
      if (!container) return;
      if (options.tcpTaken?.()) {
        throw new Error("Bind for 0.0.0.0:443 failed: port is already allocated");
      }
      if (container.HostConfig.PortBindings["8443/udp"] && options.udpTaken?.()) {
        throw new Error(
          "driver failed programming external connectivity on endpoint nearzero-router: failed to bind host port for 0.0.0.0:443:172.18.0.2:8443/udp: address already in use",
        );
      }
      container.State.Running = true;
    },
    stopContainer: async (name: string) => {
      const container = containers.get(name);
      if (container) container.State.Running = false;
    },
    removeContainer: async (name: string) => {
      containers.delete(name);
    },
    waitContainer: async () => ({ StatusCode: 0 }),
    call: async (_method: string, path: string, query?: { query: { name: string } }) => {
      const from = path.split("/")[2] ?? "";
      const container = containers.get(from);
      if (container && query?.query?.name) {
        containers.delete(from);
        containers.set(query.query.name, container);
      }
    },
  } as unknown as DockerClient;
  return { docker, containers };
}

function routerOn(docker: DockerClient): Router {
  return new Router(
    docker,
    { ...SETTINGS, directory: dir, hostDirectory: dir, procRoot: proc },
    silentLog,
  );
}

describe("the router with and without HTTP/3 (R3-22)", () => {
  test("a free UDP port: the router publishes 443/udp and serves HTTP/3", async () => {
    const { docker, containers } = fakeDocker();
    const router = routerOn(docker);
    await router.ensure();
    const running = containers.get("nearzero-router");
    expect(running?.HostConfig.PortBindings["8443/udp"]).toEqual([{ HostPort: "443" }]);
    expect(running?.Config.Cmd).toContain("--entrypoints.websecure.http3=true");
    expect(router.state().http3).toEqual({ enabled: true, port: 443, blockedBy: null });
    // Main settings are the options the running router was started with.
    expect(await router.mainSettings()).toContain("    http3:\n      advertisedPort: 443");
  }, 20_000);

  test("UDP 443 held by another program: the router starts without HTTP/3 and says who has it", async () => {
    await processWith(31, "caddy", 4242);
    await writeFile(join(proc, "net", "udp"), UDP_HEADER + udpLine(443, 4242));
    const { docker, containers } = fakeDocker({ udpTaken: () => true });
    const router = routerOn(docker);
    await router.ensure();
    const running = containers.get("nearzero-router");
    expect(running?.State.Running).toBe(true);
    expect(running?.HostConfig.PortBindings["8443/udp"]).toBeUndefined();
    expect(running?.HostConfig.PortBindings["8443/tcp"]).toEqual([{ HostPort: "443" }]);
    expect(running?.Config.Cmd.some((option) => option.includes("http3"))).toBe(false);
    expect(router.state().http3).toEqual({ enabled: false, port: 443, blockedBy: "caddy" });
    expect(await router.mainSettings()).toContain("HTTP/3 is off: UDP port 443 is in use by caddy");
    // The next minute's check leaves that router alone.
    const before = running;
    await router.ensure();
    expect(containers.get("nearzero-router")).toBe(before);
  }, 20_000);

  test("UDP 443 taken between the check and the start: the router still starts, without HTTP/3", async () => {
    const { docker, containers } = fakeDocker({ udpTaken: () => true });
    const router = routerOn(docker);
    await router.ensure();
    const running = containers.get("nearzero-router");
    expect(running?.State.Running).toBe(true);
    expect(running?.HostConfig.PortBindings["8443/udp"]).toBeUndefined();
    expect(router.state().http3).toEqual({
      enabled: false,
      port: 443,
      blockedBy: "another program",
    });
  }, 20_000);

  test("a stopped router whose UDP port was taken meanwhile comes back without HTTP/3; TCP taken fails once, without looping", async () => {
    let udp = false;
    let tcp = false;
    const { docker, containers } = fakeDocker({ udpTaken: () => udp, tcpTaken: () => tcp });
    const router = routerOn(docker);
    await router.ensure();
    const first = containers.get("nearzero-router");
    expect(first?.HostConfig.PortBindings["8443/udp"]).toBeDefined();
    // Stopped; something nobody can name (a kernel socket) takes UDP 443.
    if (first) first.State.Running = false;
    udp = true;
    await router.ensure();
    const again = containers.get("nearzero-router");
    expect(again?.State.Running).toBe(true);
    expect(again?.HostConfig.PortBindings["8443/udp"]).toBeUndefined();
    expect(router.state().http3).toEqual({
      enabled: false,
      port: 443,
      blockedBy: "another program",
    });
    // With TCP 443 taken too, the check fails with the ports message and doesn't loop.
    if (again) again.State.Running = false;
    tcp = true;
    await expect(router.ensure()).rejects.toThrow("The router can't listen on ports 80 and 443");
  }, 30_000);
});
