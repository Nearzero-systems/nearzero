import { mkdir, readFile } from "node:fs/promises";
import { hostname as machineName } from "node:os";
import { dirname, join } from "node:path";
import { type CertificateStatus, ROUTER_CONTAINER } from "@nearzero/shared";
import type { DockerClient } from "../docker/client.ts";
import type { Log } from "../log.ts";
import { writeFileAtomically } from "../router/files.ts";
import type { Router } from "../router/router.ts";
import { parseAcmeLine, readStoredCertificates } from "./acme.ts";
import { AttemptTracker } from "./attempts.ts";
import { BuiltinDns } from "./dns-server.ts";
import { UploadedCertificates } from "./uploads.ts";

/**
 * Certificates and the built-in DNS server on this server (spec 10.7, 10.8): the back-off that
 * holds hostnames after failed validations or a rate limit, uploaded certificates, reading the
 * router's certificate store and log, and (on the host) the DNS server. Attached to the router,
 * which asks it about every hostname before it lets the router ask Let's Encrypt.
 */

export const DEFAULT_DNS_IMAGE = "coredns/coredns:1.15.0";

export interface DomainsSettings {
  stateFile: string | null;
  /** Where the certificate contact email from the control plane is kept (spec 10.1). */
  contactFile: string | null;
  dns: {
    directory: string;
    hostDirectory: string | null;
    image: string;
    bindAddress: string;
    port: number;
    network: string | null;
  };
  /** For a private ACME server (tests use Pebble): its directory URL and CA file on the host. */
  acmeCaServer: string | null;
  acmeCaCertificates: string | null;
}

function text(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** The runner's domain settings from its environment. */
export function domainsSettings(
  env: Record<string, string | undefined>,
  stateDirectory: string | null,
): DomainsSettings {
  const port = Number(text(env, "NEARZERO_DNS_PORT") ?? "53");
  return {
    stateFile: stateDirectory ? join(stateDirectory, "certificates.json") : null,
    contactFile: stateDirectory ? join(stateDirectory, "certificate-contact.json") : null,
    dns: {
      directory: text(env, "NEARZERO_DNS_DIR") ?? "/etc/nearzero/dns",
      hostDirectory: text(env, "NEARZERO_DNS_HOST_DIR"),
      image: text(env, "NEARZERO_DNS_IMAGE") ?? DEFAULT_DNS_IMAGE,
      bindAddress: text(env, "NEARZERO_DNS_BIND_ADDRESS") ?? "0.0.0.0",
      port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 53,
      network: text(env, "NEARZERO_DNS_NETWORK"),
    },
    acmeCaServer: text(env, "NEARZERO_ACME_CA_SERVER"),
    acmeCaCertificates: text(env, "NEARZERO_ACME_CA_CERTIFICATES"),
  };
}

export class DomainsRuntime {
  readonly tracker: AttemptTracker;
  readonly uploads: UploadedCertificates;
  readonly dns: BuiltinDns;
  readonly #docker: DockerClient;
  readonly #router: Router;
  readonly #log: Log;
  readonly #contactFile: string | null;
  #following: AbortController | null = null;
  #stopped = false;

  constructor(options: {
    docker: DockerClient;
    router: Router;
    log: Log;
    settings: DomainsSettings;
    containerized: boolean;
  }) {
    this.#docker = options.docker;
    this.#router = options.router;
    this.#log = options.log;
    this.#contactFile = options.settings.contactFile;
    this.tracker = new AttemptTracker(options.settings.stateFile);
    this.uploads = new UploadedCertificates(options.router.settings.directory);
    const dnsSettings = options.settings.dns;
    this.dns = new BuiltinDns(options.docker, options.log, {
      directory: dnsSettings.directory,
      bindAddress: dnsSettings.bindAddress,
      image: dnsSettings.image,
      port: dnsSettings.port,
      network: dnsSettings.network,
      hostDirectory: async () => {
        if (dnsSettings.hostDirectory) return dnsSettings.hostDirectory;
        if (!options.containerized) return dnsSettings.directory;
        const self = await options.docker
          .findContainer(process.env.HOSTNAME ?? machineName())
          .catch(() => null);
        const mount = self?.Mounts.find((item) => item.Destination === dnsSettings.directory);
        if (!mount) {
          throw new Error(
            `The runner runs in a container but ${dnsSettings.directory} isn't mounted from the host. Mount the DNS folder there, or set NEARZERO_DNS_HOST_DIR to its path on the host.`,
          );
        }
        return mount.Source;
      },
    });
    // Asked for every hostname of a Let's Encrypt route before the DNS check (spec 10.7).
    this.#router.gate = (hostname) => {
      if (this.uploads.covers(hostname)) return { mode: "custom" };
      const backoff = this.tracker.backoff(hostname);
      return backoff ? { mode: "hold", reason: "backoff" } : null;
    };
    this.#router.onRequested = (hostname) => this.tracker.requested(hostname);
  }

  async start(): Promise<void> {
    await this.tracker.load();
    await this.uploads.load();
    await this.loadContact();
    void this.#follow();
  }

  /**
   * Uses the contact email the control plane last gave (spec 10.1: the one saved under About
   * Nearzero) instead of the install's, before the router is first checked, so a restart doesn't
   * recreate the router with the old email and then again with the new one.
   */
  async loadContact(): Promise<void> {
    if (!this.#contactFile) return;
    const text = await readFile(this.#contactFile, "utf8").catch(() => "");
    try {
      const saved = JSON.parse(text) as { email?: unknown };
      if (typeof saved.email === "string") this.#router.settings.acmeEmail = saved.email;
    } catch {
      // Nothing saved yet: the install's email stays.
    }
  }

  /**
   * The contact email for new certificates. Saved, then, when it changed, the router is
   * recreated in the background with it (the router reads it only when it starts); certificates
   * it already has are kept.
   */
  async setContact(email: string): Promise<{ email: string; changed: boolean }> {
    const changed = this.#router.settings.acmeEmail !== email;
    if (this.#contactFile) {
      await mkdir(dirname(this.#contactFile), { recursive: true, mode: 0o700 });
      await writeFileAtomically(this.#contactFile, `${JSON.stringify({ email })}\n`, 0o600);
    }
    this.#router.settings.acmeEmail = email;
    if (changed) {
      this.#log.info("the certificate contact email changed; recreating the router");
      void this.#router.ensure().catch((error: unknown) =>
        this.#log.warn("the router didn't restart with the new certificate email", {
          reason: (error as Error).message,
        }),
      );
    }
    return { email, changed };
  }

  stop(): void {
    this.#stopped = true;
    this.#following?.abort();
  }

  /** Follows the router's log for failed Let's Encrypt attempts, across router restarts. */
  async #follow(): Promise<void> {
    while (!this.#stopped) {
      this.#following = new AbortController();
      try {
        const since = Math.max(this.tracker.lastLogAt, Date.now() - 60 * 60_000) / 1000;
        const source = await this.#docker.logs(ROUTER_CONTAINER, {
          follow: true,
          tail: "all",
          since: Math.floor(since),
          timestamps: false,
          signal: this.#following.signal,
        });
        const decoder = new TextDecoder();
        let pending = "";
        for await (const chunk of source) {
          if (this.#stopped) break;
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const line of lines) this.#line(line);
        }
        if (pending) this.#line(pending);
      } catch {
        // The router isn't there yet, or was replaced; look again shortly.
      }
      if (this.#stopped) return;
      await Bun.sleep(2_000);
    }
  }

  #line(line: string): void {
    const failure = parseAcmeLine(line);
    if (!failure) return;
    // The same entry read again after a reconnect is ignored by its time.
    if (failure.at <= this.tracker.lastLogAt && failure.at < Date.now() - 1_000) return;
    this.#log.warn("Let's Encrypt refused a certificate", {
      hostnames: failure.hostnames,
      reason: failure.message,
      rateLimited: failure.rateLimited,
    });
    const held = this.tracker.failure(failure);
    if (held.length > 0) {
      this.#log.info("holding hostnames after failed validations", { hostnames: held });
      void this.#router.refresh(held).catch(() => {});
    }
  }

  /** The certificates.status answer. */
  async status(): Promise<CertificateStatus> {
    let certificates: CertificateStatus["certificates"] = [];
    let readable = true;
    let error: string | null = null;
    try {
      certificates = await readStoredCertificates(this.#docker);
    } catch (problem) {
      readable = false;
      error = `Couldn't read the router's certificates: ${(problem as Error).message}`;
    }
    const state = this.#router.state();
    this.tracker.keepOnly(new Set(this.#router.hostnames()));
    return {
      readable,
      error,
      certificates,
      uploaded: this.uploads.list(),
      attempts: this.tracker.records(),
      holds: state.held.map((item) => ({ hostname: item.hostname, reason: item.reason })),
      backoff: this.#router.gatedHostnames(),
      checkedAt: Date.now(),
    };
  }

  /** A Retry the control plane allowed: lift the pause and make the router ask again. */
  async retry(hostname: string): Promise<{ started: boolean }> {
    this.tracker.retried(hostname);
    const started = await this.#router.retry(hostname);
    return { started };
  }

  async setUploads(certificates: { id: string; certificatePem: string; keyPem: string }[]) {
    const before = new Set(this.uploads.list().flatMap((item) => item.names));
    await this.uploads.sync(certificates);
    const after = this.uploads.list().flatMap((item) => item.names);
    // Hostnames an upload now covers, or no longer covers, get their routes written again.
    const touched = this.#router
      .hostnames()
      .filter((host) =>
        [...before, ...after].some(
          (name) => name === host || (name.startsWith("*.") && host.endsWith(name.slice(1))),
        ),
      );
    if (touched.length > 0) await this.#router.refresh(touched);
    return { uploaded: this.uploads.list().length };
  }
}

const runtimes = new WeakMap<Router, DomainsRuntime>();

export function attachDomains(router: Router, runtime: DomainsRuntime): void {
  runtimes.set(router, runtime);
}

export function domainsFor(router: Router): DomainsRuntime | null {
  return runtimes.get(router) ?? null;
}
