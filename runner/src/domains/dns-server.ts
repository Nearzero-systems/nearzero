import { Resolver } from "node:dns/promises";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { type DnsStatus, NEARZERO_LABELS } from "@nearzero/shared";
import {
  type ContainerDetails,
  type DockerClient,
  DockerError,
  selinuxLabels,
} from "../docker/client.ts";
import type { Log } from "../log.ts";
import { writeFileAtomically } from "../router/files.ts";

/**
 * The built-in DNS server on the Nearzero host (spec 10.8, 03 3.1): CoreDNS serving zone files,
 * running only while a managed zone exists. The control plane renders the files; the runner
 * writes them into the DNS folder and keeps the server's container running (creating it when the
 * install didn't), or stops it when the last zone is gone. CoreDNS reloads changed files within
 * seconds, so applying never restarts it.
 */

// 1.0's own name, never 0.1.x's (spec 29.5 "No shared names with 0.1.x"); the installer's
// compose file gives its DNS server the same one.
export const DNS_CONTAINER = "nearzero1-dns";
/** Inside the container: unprivileged; the host's port 53 is published onto it. */
const LISTEN_PORT = 1053;
const CONTAINER_DIRECTORY = "/etc/nearzero/dns";
const OWNER_LABEL = "dev.nearzero.dns-owner";

export interface DnsServerSettings {
  /** Where the runner writes the Corefile and zones/. */
  directory: string;
  /** The same folder as Docker sees it; found lazily when the runner runs in a container. */
  hostDirectory: () => Promise<string>;
  image: string;
  bindAddress: string;
  port: number;
  /** A network to join (on the host, the control plane's), or null. */
  network: string | null;
}

export class BuiltinDns {
  readonly #docker: DockerClient;
  readonly #log: Log;
  readonly settings: DnsServerSettings;
  #lastError: string | null = null;

  constructor(docker: DockerClient, log: Log, settings: DnsServerSettings) {
    this.#docker = docker;
    this.#log = log;
    this.settings = settings;
  }

  async #writeFiles(
    corefile: string,
    zones: readonly { name: string; content: string }[],
  ): Promise<void> {
    const zonesFolder = join(this.settings.directory, "zones");
    await mkdir(zonesFolder, { recursive: true, mode: 0o755 });
    const keep = new Set<string>();
    for (const zone of zones) {
      const file = `${zone.name}.zone`;
      keep.add(file);
      const path = join(zonesFolder, file);
      if ((await readFile(path, "utf8").catch(() => null)) !== zone.content) {
        await writeFileAtomically(path, zone.content, 0o644);
      }
    }
    for (const name of await readdir(zonesFolder).catch(() => [] as string[])) {
      if (name.endsWith(".zone") && !keep.has(name))
        await rm(join(zonesFolder, name), { force: true });
    }
    const corefilePath = join(this.settings.directory, "Corefile");
    if ((await readFile(corefilePath, "utf8").catch(() => null)) !== corefile) {
      await writeFileAtomically(corefilePath, corefile, 0o644);
    }
  }

  /** Writes the zones and keeps the server running (or stops it with no zones). */
  async apply(
    corefile: string,
    zones: readonly { name: string; content: string }[],
  ): Promise<{ running: boolean }> {
    if (zones.length > 0) await this.#writeFiles(corefile, zones);
    const current = await this.#docker.findContainer(DNS_CONTAINER);
    if (zones.length === 0) {
      if (current?.State.Running) {
        this.#log.info("no managed DNS zones are left; stopping the built-in DNS server");
        await this.#docker.stopContainer(DNS_CONTAINER, 10);
      }
      if (current && current.Config.Labels?.[OWNER_LABEL] === "runner") {
        await this.#docker.removeContainer(DNS_CONTAINER, { force: true }).catch(() => {});
      }
      await this.#writeFiles(corefile, []);
      return { running: false };
    }
    try {
      if (current && this.#ownedWithOldBinding(current)) {
        // Its address or port changed (NEARZERO_DNS_BIND_ADDRESS set to get past a resolver on
        // port 53): starting the old one would fail the same way again (B2-13).
        this.#log.info("the DNS server's address changed; creating it again", {
          bindAddress: this.settings.bindAddress,
          port: this.settings.port,
        });
        await this.#docker.removeContainer(DNS_CONTAINER, { force: true });
        await this.#create();
      } else if (current) {
        if (!current.State.Running) await this.#docker.startContainer(DNS_CONTAINER);
      } else {
        await this.#create();
      }
      this.#lastError = null;
    } catch (error) {
      const message = (error as Error).message;
      this.#lastError = /address already in use|port is already allocated/i.test(message)
        ? `Nearzero DNS can't listen on port ${this.settings.port}: another program already uses it. Stop that program, or set NEARZERO_DNS_BIND_ADDRESS to an address of this server that is free on port ${this.settings.port}, then run the install command again.`
        : `Nearzero DNS didn't start: ${message}`;
      throw new Error(this.#lastError, { cause: error });
    }
    return { running: true };
  }

  /** A DNS server this runner created, published on another address or port than the settings'. */
  #ownedWithOldBinding(current: ContainerDetails): boolean {
    if (current.Config.Labels?.[OWNER_LABEL] !== "runner") return false;
    const published = current.HostConfig?.PortBindings?.[`${LISTEN_PORT}/udp`]?.[0];
    if (!published) return false;
    return (
      (published.HostIp || "0.0.0.0") !== this.settings.bindAddress ||
      published.HostPort !== String(this.settings.port)
    );
  }

  async #create(): Promise<void> {
    const s = this.settings;
    if (!(await this.#docker.imageExists(s.image))) {
      this.#log.info("downloading the DNS server image", { image: s.image });
      await this.#docker.pullImage(s.image);
    }
    const binding = [{ HostIp: s.bindAddress, HostPort: String(s.port) }];
    await this.#docker.createContainer(DNS_CONTAINER, {
      Image: s.image,
      Cmd: ["-conf", `${CONTAINER_DIRECTORY}/Corefile`],
      ExposedPorts: { [`${LISTEN_PORT}/udp`]: {}, [`${LISTEN_PORT}/tcp`]: {} },
      Labels: {
        [NEARZERO_LABELS.managed]: "true",
        [NEARZERO_LABELS.component]: "dns",
        [OWNER_LABEL]: "runner",
      },
      HostConfig: {
        // Relabelled under SELinux so the confined server may read its zones (C2-08).
        Binds: [
          `${await s.hostDirectory()}:${CONTAINER_DIRECTORY}:ro${(await selinuxLabels(this.#docker)) ? ",z" : ""}`,
        ],
        PortBindings: { [`${LISTEN_PORT}/udp`]: binding, [`${LISTEN_PORT}/tcp`]: binding },
        RestartPolicy: { Name: "unless-stopped" },
        CapDrop: ["ALL"],
        CapAdd: ["NET_BIND_SERVICE"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "5" } },
      },
      ...(s.network
        ? { NetworkingConfig: { EndpointsConfig: { [s.network]: { Aliases: [DNS_CONTAINER] } } } }
        : {}),
    });
    await this.#docker.startContainer(DNS_CONTAINER);
    this.#log.info("started the built-in DNS server", { image: s.image });
  }

  /** Whether it runs, and the SOA serial it answers for each zone. */
  async status(zones: readonly string[]): Promise<DnsStatus> {
    const current = await this.#docker.findContainer(DNS_CONTAINER).catch((error: unknown) => {
      if (error instanceof DockerError) return null;
      throw error;
    });
    if (!current?.State.Running) {
      return {
        running: false,
        error: this.#lastError,
        zones: zones.map((name) => ({ name, serial: null })),
      };
    }
    const networks = Object.values(current.NetworkSettings.Networks ?? {}) as {
      IPAddress?: string;
    }[];
    const address = networks.map((network) => network.IPAddress).find((ip) => ip) ?? null;
    const answers: { name: string; serial: number | null }[] = [];
    for (const name of zones) {
      let serial: number | null = null;
      if (address) {
        const resolver = new Resolver({ timeout: 2_000, tries: 1 });
        resolver.setServers([`${address}:${LISTEN_PORT}`]);
        serial = await resolver
          .resolveSoa(name)
          .then((soa) => soa.serial)
          .catch(() => null);
      }
      answers.push({ name, serial });
    }
    return { running: true, error: this.#lastError, zones: answers };
  }
}
