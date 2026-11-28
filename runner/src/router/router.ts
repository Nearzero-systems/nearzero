import { createHash } from "node:crypto";
import { chown, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCESS_LOG_FOLDER,
  type HoldReason,
  NEARZERO_LABELS,
  ROUTER_CERTIFICATES_VOLUME,
  ROUTER_CONTAINER,
  type RouterHttp3,
  type RouterState,
  type RouteSpec,
} from "@nearzero/shared";
import {
  type ContainerDetails,
  type DockerClient,
  DockerError,
  selinuxLabels,
} from "../docker/client.ts";
import type { Log } from "../log.ts";
import { type EffectiveCertificate, RouteFiles } from "./files.ts";
import { holdReason, publicResolve4, publicResolve6, type Resolve4 } from "./holds.ts";
import { mainSettingsText } from "./main-settings.ts";
import { UNKNOWN_HOLDER, udpPortHolder } from "./udp-port.ts";

/**
 * The router on this server and what it serves (spec 09 9.3 step 9, spec 10, spec 23.2): the
 * runner keeps Nearzero's private network and the router container running, recreates the router
 * only when its configuration changed, and writes the route files.
 *
 * The router listens on unprivileged ports inside its container (8080, 8443) with the host's web
 * ports published onto them, so it runs with every Linux capability dropped, a read-only root
 * filesystem, and as the owner of its configuration folder (spec 22.5).
 *
 * It serves HTTP/3 on the server's UDP HTTPS port next to TCP, and its HTTPS answers advertise it
 * (Alt-Svc). When something else already holds that UDP port, the router starts without HTTP/3
 * instead of failing, and its state says who holds it (R3-22, spec 30 decisions part 2).
 */

export interface RouterSettings {
  /** Where the runner writes route files. */
  directory: string;
  /** The same folder as the Docker host sees it (differs when the runner runs in a container). */
  hostDirectory: string;
  image: string;
  acmeEmail: string;
  httpPort: number;
  httpsPort: number;
  network: string;
  /** A private ACME server's directory (tests use Pebble); Let's Encrypt when unset. */
  acmeCaServer?: string | null;
  /** That server's CA certificate, as a file path the Docker host sees. */
  acmeCaCertificates?: string | null;
  /**
   * The runner runs in a container (the Nearzero host): who holds the UDP port is read through a
   * helper container that sees the host's network and processes (R3-22).
   */
  containerized?: boolean;
  /** Where the server's /proc is (tests give their own). */
  procRoot?: string;
}

/** What the certificates area says about a hostname before its DNS is checked (spec 10.7). */
export type CertificateGate = { mode: "custom" } | { mode: "hold"; reason: "backoff" } | null;

const CONTAINER_DIRECTORY = "/etc/nearzero/router";
/** The one-off container that gives the certificates volume to the router's user. */
export const CERTIFICATES_OWNER_CONTAINER = `${ROUTER_CONTAINER}-certificates-owner`;
/** Its exit code when it had to change an owner (so a running router reopens its store). */
const OWNER_CHANGED = 10;
/** How long after a failed attempt the next check tries again. */
const OWNER_RETRY_MS = 10 * 60_000;

/**
 * Gives the certificates volume, and what is in it, to `user` (uid:gid). A fresh volume is
 * root's, and the router runs as the router folder's owner with every capability dropped, so it
 * couldn't create acme.json there (spec 9.3: "the router runs as that user, and HTTPS works").
 */
const OWN_CERTIFICATES_SCRIPT = `want="$1"; changed=0
for path in /certificates /certificates/* /certificates/.[!.]*; do
  [ -e "$path" ] || continue
  [ "$(stat -c %u:%g "$path")" = "$want" ] || changed=1
done
[ "$changed" = 0 ] || chown -R "$want" /certificates
chmod 700 /certificates
[ ! -f /certificates/acme.json ] || chmod 600 /certificates/acme.json
[ "$changed" = 0 ] || exit ${OWNER_CHANGED}`;

/** The one-off container's settings: root with only the rights chown needs, and no network. */
export function certificatesOwnerConfig(image: string, user: string): Record<string, unknown> {
  return {
    Image: image,
    User: "0:0",
    Entrypoint: ["/bin/sh", "-c", OWN_CERTIFICATES_SCRIPT, "sh", user],
    Cmd: [],
    Labels: { [NEARZERO_LABELS.managed]: "true" },
    AttachStdin: false,
    OpenStdin: false,
    Tty: false,
    NetworkDisabled: true,
    HostConfig: {
      AutoRemove: false,
      NetworkMode: "none",
      Mounts: [{ Type: "volume", Source: ROUTER_CERTIFICATES_VOLUME, Target: "/certificates" }],
      CapDrop: ["ALL"],
      CapAdd: ["CHOWN", "FOWNER", "DAC_OVERRIDE"],
      SecurityOpt: ["no-new-privileges:true"],
    },
  };
}
/** Where the router writes its request log inside its container (spec 13.1). */
export const ACCESS_LOG_MOUNT = "/var/log/nearzero-router";

/** How long a decision about HTTP/3 stands while the router runs without it (R3-22). */
const HTTP3_RECHECK_MS = 5 * 60_000;

/** The router's static options (its main settings, R3-23): entry points, resolvers, globals. */
export function routerOptions(
  settings: RouterSettings,
  options: { accessLog: boolean; http3: boolean },
): string[] {
  return [
    "--global.checknewversion=false",
    "--global.sendanonymoususage=false",
    "--log.level=INFO",
    // JSON, so the runner can read failed certificate attempts from the log (spec 10.7).
    "--log.format=json",
    "--entrypoints.web.address=:8080",
    "--entrypoints.websecure.address=:8443",
    // HTTP/3 on the same port over UDP; Alt-Svc names the port the server publishes (R3-22).
    ...(options.http3
      ? [
          "--entrypoints.websecure.http3=true",
          `--entrypoints.websecure.http3.advertisedport=${settings.httpsPort}`,
        ]
      : []),
    `--providers.file.directory=${CONTAINER_DIRECTORY}`,
    "--providers.file.watch=true",
    `--certificatesresolvers.letsencrypt.acme.email=${settings.acmeEmail}`,
    "--certificatesresolvers.letsencrypt.acme.storage=/certificates/acme.json",
    "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web",
    ...(settings.acmeCaServer
      ? [`--certificatesresolvers.letsencrypt.acme.caserver=${settings.acmeCaServer}`]
      : []),
    ...(options.accessLog
      ? [
          "--accesslog=true",
          `--accesslog.filepath=${ACCESS_LOG_MOUNT}/access.log`,
          "--accesslog.format=json",
          "--accesslog.bufferingsize=0",
          "--accesslog.fields.headers.defaultmode=drop",
          "--accesslog.fields.headers.names.User-Agent=keep",
          "--accesslog.fields.headers.names.Referer=keep",
        ]
      : []),
  ];
}

/** Docker refused to publish a port the router asks for: something else has it. */
export class PortsInUseError extends Error {}

function portsInUse(error: unknown): boolean {
  return /address already in use|port is already allocated/i.test((error as Error)?.message ?? "");
}

/** Whether a router container publishes the UDP HTTPS port (serves HTTP/3). */
function publishesUdp(container: ContainerDetails | null): boolean {
  return Boolean(container?.HostConfig?.PortBindings?.["8443/udp"]?.length);
}

export class Router {
  readonly settings: RouterSettings;
  readonly files: RouteFiles;
  readonly #docker: DockerClient;
  readonly #log: Log;
  readonly #lookup: Resolve4;
  readonly #routes = new Map<string, RouteSpec>();
  readonly #holds = new Map<string, HoldReason | "requested">();
  #publicIPv4: string | null = null;
  /** The server's name didn't resolve when the control plane last looked, and no address is known. */
  #addressLookupFailed = false;
  #lastError: string | null = null;
  #running = false;
  #image: string | null = null;
  #checkedAt = 0;
  #ensuring: Promise<void> | null = null;
  /** The user the certificates volume was given to by this process, once it was. */
  #certificatesOwner: string | null = null;
  /** When giving it away last failed: tried again after a while, not at every check. */
  #certificatesOwnerFailedAt = 0;
  /** One more check, after the running one, for callers that changed a setting meanwhile. */
  #ensuringAgain: Promise<void> | null = null;
  /** Hostnames held by the back-off (failed validations, rate limits). */
  readonly #gated = new Set<string>();
  /** Hostnames currently allowed to ask Let's Encrypt. */
  readonly #issuing = new Set<string>();
  /** Hostnames held for a moment so the router notices a Retry. */
  readonly #forcedHold = new Set<string>();
  /** Whether the router serves HTTP/3, and who holds the UDP port when not (R3-22). */
  #http3: RouterHttp3 | null = null;
  #http3CheckedAt = 0;
  /** Asked for each hostname of a Let's Encrypt route before its DNS check. */
  gate: ((hostname: string) => CertificateGate) | null = null;
  /** Called when a hostname is released to ask Let's Encrypt. */
  onRequested: ((hostname: string) => void) | null = null;
  /**
   * Whether the router writes its request log (spec 13.1): one JSON line per request, without
   * buffering, into `access-log/` of the router folder. Set by access-log/runtime.ts; changing it
   * changes the router's fingerprint, so the next ensure recreates it.
   */
  accessLogEnabled = false;

  readonly #lookup6: Resolve4;

  constructor(
    docker: DockerClient,
    settings: RouterSettings,
    log: Log,
    lookup = publicResolve4,
    lookup6 = publicResolve6,
  ) {
    this.#docker = docker;
    this.settings = settings;
    this.files = new RouteFiles(settings.directory);
    this.#log = log;
    this.#lookup = lookup;
    this.#lookup6 = lookup6;
  }

  /**
   * The server's public IPv4, from the control plane: at connect, and at its check every 5
   * minutes, so a server added by hostname follows its name to a new address without a
   * reconnect (R3-10). A lookup of the server's name that failed just now never takes the
   * address away: the last one known stays, and with none known nothing is held for it.
   */
  setPublicIPv4(address: string | null, options: { lookupFailed?: boolean } = {}): boolean {
    const before = `${this.#publicIPv4}|${this.#addressLookupFailed}`;
    if (address === null && options.lookupFailed) {
      this.#addressLookupFailed = this.#publicIPv4 === null;
    } else {
      this.#publicIPv4 = address;
      this.#addressLookupFailed = false;
    }
    return before !== `${this.#publicIPv4}|${this.#addressLookupFailed}`;
  }

  /** The address the hold compares with (tests, and the router's state). */
  get publicIPv4(): string | null {
    return this.#publicIPv4;
  }

  state(): RouterState {
    return {
      running: this.#running,
      image: this.#image,
      routes: this.#routes.size,
      held: [...this.#holds].map(([hostname, reason]) => ({
        hostname,
        reason: reason === "requested" ? "not_public" : reason,
      })),
      lastError: this.#lastError,
      checkedAt: this.#checkedAt,
      ...(this.#http3 ? { http3: { ...this.#http3 } } : {}),
    };
  }

  /** HTTP/3 as the router serves it now, or null before the first check (R3-22). */
  http3(): RouterHttp3 | null {
    return this.#http3 ? { ...this.#http3 } : null;
  }

  /**
   * The router's main settings as text (R3-23): the options the running router was started
   * with, or those it would be started with when there is none yet.
   */
  async mainSettings(): Promise<string> {
    const current = await this.#docker.findContainer(ROUTER_CONTAINER).catch(() => null);
    const options =
      current?.Config.Labels?.[NEARZERO_LABELS.component] === "router" && current.Config.Cmd
        ? current.Config.Cmd
        : routerOptions(this.settings, {
            accessLog: this.accessLogEnabled,
            http3: this.#http3?.enabled ?? true,
          });
    const http3 = current ? { ...(this.#http3 ?? this.#http3Of(current)) } : this.#http3;
    return mainSettingsText(options, this.settings, http3);
  }

  #http3Of(current: ContainerDetails): RouterHttp3 {
    return { enabled: publishesUdp(current), port: this.settings.httpsPort, blockedBy: null };
  }

  // ---- Network and container

  /**
   * Makes sure the private network, the certificates volume and the router are in place. A call
   * while a check runs waits for one more check after it: the running one may have read the
   * settings before the caller changed them (the request log is turned on just after the runner
   * connects, while its first check is creating the router).
   */
  ensure(): Promise<void> {
    if (this.#ensuring) {
      this.#ensuringAgain ??= this.#ensuring
        .catch(() => {})
        .then(() => {
          this.#ensuringAgain = null;
          return this.ensure();
        });
      return this.#ensuringAgain;
    }
    this.#ensuring = this.#ensure().finally(() => {
      this.#ensuring = null;
    });
    return this.#ensuring;
  }

  async #ensure(): Promise<void> {
    try {
      await this.files.prepare();
      if (this.accessLogEnabled) await this.#prepareAccessLog();
      await this.ensureNetwork(this.settings.network);
      if (!(await this.#docker.findVolume(ROUTER_CERTIFICATES_VOLUME))) {
        await this.#docker.createVolume(ROUTER_CERTIFICATES_VOLUME, {
          [NEARZERO_LABELS.managed]: "true",
        });
      }
      await this.#ensureContainer();
      this.#lastError = null;
    } catch (error) {
      this.#lastError = (error as Error).message;
      this.#log.warn("router check failed", { reason: this.#lastError });
      throw error;
    } finally {
      this.#checkedAt = Date.now();
    }
  }

  /** The request log's folder, owned like the router folder so the router can write in it. */
  async #prepareAccessLog(): Promise<void> {
    const folder = join(this.settings.directory, ACCESS_LOG_FOLDER);
    await mkdir(folder, { recursive: true, mode: 0o750 });
    const owner = await stat(this.settings.directory);
    await chown(folder, owner.uid, owner.gid).catch(() => {});
  }

  /** Uses the network when it exists; never replaces one of the same name (spec 9.3 step 6). */
  async ensureNetwork(name: string, labels: Record<string, string> = {}): Promise<void> {
    const existing = await this.#docker.findNetwork(name);
    if (existing) return;
    try {
      await this.#docker.createNetwork(name, { [NEARZERO_LABELS.managed]: "true", ...labels });
    } catch (error) {
      // Created meanwhile by someone else: fine.
      if (!(error instanceof DockerError && error.status === 409)) throw error;
    }
  }

  async #owner(): Promise<string> {
    const info = await stat(this.settings.directory);
    return `${info.uid}:${info.gid}`;
  }

  /** The router container's settings, and a fingerprint that changes when any of them does. */
  async desiredContainer(): Promise<{ config: Record<string, unknown>; fingerprint: string }> {
    const s = this.settings;
    // On unless something else holds the UDP port (decided before each check, R3-22).
    const http3 = this.#http3?.enabled ?? true;
    const command = routerOptions(s, { accessLog: this.accessLogEnabled, http3 });
    const user = await this.#owner();
    const caFile = "/etc/nearzero/acme-ca.pem";
    // Under SELinux the router's own folders are relabelled so it may read them; nothing changes
    // (the settings' fingerprint included) where the daemon doesn't label containers (C2-08).
    const label = (await selinuxLabels(this.#docker)) ? ",z" : "";
    const base = {
      Image: s.image,
      Cmd: command,
      User: user,
      ...(s.acmeCaCertificates ? { Env: [`LEGO_CA_CERTIFICATES=${caFile}`] } : {}),
      ExposedPorts: { "8080/tcp": {}, "8443/tcp": {}, ...(http3 ? { "8443/udp": {} } : {}) },
      HostConfig: {
        Binds: [
          `${s.hostDirectory}:${CONTAINER_DIRECTORY}:ro${label}`,
          ...(s.acmeCaCertificates ? [`${s.acmeCaCertificates}:${caFile}:ro`] : []),
          ...(this.accessLogEnabled
            ? [`${s.hostDirectory}/${ACCESS_LOG_FOLDER}:${ACCESS_LOG_MOUNT}${label ? ":z" : ""}`]
            : []),
        ],
        Mounts: [{ Type: "volume", Source: ROUTER_CERTIFICATES_VOLUME, Target: "/certificates" }],
        PortBindings: {
          "8080/tcp": [{ HostPort: String(s.httpPort) }],
          "8443/tcp": [{ HostPort: String(s.httpsPort) }],
          ...(http3 ? { "8443/udp": [{ HostPort: String(s.httpsPort) }] } : {}),
        },
        RestartPolicy: { Name: "unless-stopped" },
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        ReadonlyRootfs: true,
        LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "5" } },
      },
      NetworkingConfig: { EndpointsConfig: { [s.network]: {} } },
    };
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(base))
      .digest("hex")
      .slice(0, 16);
    return {
      fingerprint,
      config: {
        ...base,
        Labels: {
          [NEARZERO_LABELS.managed]: "true",
          [NEARZERO_LABELS.component]: "router",
          [NEARZERO_LABELS.routerConfig]: fingerprint,
        },
      },
    };
  }

  /**
   * Decides whether the next router serves HTTP/3 (R3-22): yes while the running router already
   * publishes the UDP port; otherwise only when nothing else holds that port. A decision stands
   * for a while when the router runs without HTTP/3, so a busy port isn't looked at every minute.
   */
  async #decideHttp3(current: ContainerDetails | null): Promise<void> {
    const port = this.settings.httpsPort;
    if (current?.State.Running && publishesUdp(current)) {
      this.#http3 = { enabled: true, port, blockedBy: null };
      return;
    }
    if (
      this.#http3 &&
      current?.State.Running &&
      Date.now() - this.#http3CheckedAt < HTTP3_RECHECK_MS
    ) {
      return;
    }
    const holder = await udpPortHolder(this.#docker, {
      port,
      containerized: this.settings.containerized ?? false,
      image: this.settings.image,
      ...(this.settings.procRoot ? { procRoot: this.settings.procRoot } : {}),
    }).catch((error: unknown) => {
      this.#log.warn("couldn't check who holds the router's UDP port", {
        reason: (error as Error).message,
      });
      return null;
    });
    this.#http3CheckedAt = Date.now();
    if (holder) this.#http3Off(holder);
    else this.#http3 = { enabled: true, port, blockedBy: null };
  }

  #http3Off(holder: string): void {
    const port = this.settings.httpsPort;
    if (this.#http3?.blockedBy !== holder) {
      this.#log.warn("the router starts without HTTP/3: its UDP port is in use", {
        port,
        holder,
      });
    }
    this.#http3 = { enabled: false, port, blockedBy: holder };
    this.#http3CheckedAt = Date.now();
  }

  /** `decided`: HTTP/3 was just turned off for this check (no second look, no loop). */
  async #ensureContainer(decided = false): Promise<void> {
    const current = await this.#docker.findContainer(ROUTER_CONTAINER);
    if (!decided) await this.#decideHttp3(current);
    const { config, fingerprint } = await this.desiredContainer();
    const user = config.User as string;
    const unchanged =
      current !== null && current.Config.Labels?.[NEARZERO_LABELS.routerConfig] === fingerprint;
    if (!unchanged || this.#certificatesOwner !== user) {
      if (!(await this.#docker.imageExists(this.settings.image))) {
        this.#log.info("downloading the router image", { image: this.settings.image });
        await this.#docker.pullImage(this.settings.image);
      }
    }
    // Once per runner start (which repairs routers made before this step existed), and whenever
    // the router's user changes (setup run again as another SSH user).
    const ownerChanged =
      this.#certificatesOwner === user ||
      Date.now() - this.#certificatesOwnerFailedAt < OWNER_RETRY_MS
        ? false
        : await this.#ownCertificates(user);
    if (current && unchanged) {
      if (!current.State.Running) {
        this.#log.info("starting the router");
        try {
          await this.#docker.startContainer(ROUTER_CONTAINER);
        } catch (error) {
          // HTTP/3's UDP port may have been taken while the router was stopped: replace it
          // without HTTP/3, once; if that fails too, it wasn't the UDP port.
          if (decided || !portsInUse(error) || !publishesUdp(current)) throw error;
          const before = this.#http3;
          this.#http3Off((await this.#udpHolder().catch(() => null)) ?? UNKNOWN_HOLDER);
          try {
            return await this.#ensureContainer(true);
          } catch (second) {
            this.#http3 = before;
            throw second;
          }
        }
      } else if (ownerChanged) {
        // Traefik opens its certificate store at start; it couldn't before.
        this.#log.info("restarting the router so it can use its certificate store");
        await this.#docker.call("POST", `/containers/${ROUTER_CONTAINER}/restart`, {
          query: { t: 10 },
        });
      }
      this.#running = true;
      this.#image = current.Config.Image;
      return;
    }
    if (!current) {
      await this.#createAndStart(config);
      this.#log.info("router started", { image: this.settings.image });
      return;
    }
    // Replace it, keeping the old one until the new one runs (spec 9.3 step 9).
    this.#log.info("router configuration changed; replacing the router");
    const previous = `${ROUTER_CONTAINER}-previous`;
    await this.#docker.removeContainer(previous, { force: true }).catch(() => {});
    await this.#docker.call("POST", `/containers/${ROUTER_CONTAINER}/rename`, {
      query: { name: previous },
    });
    if (current.State.Running) await this.#docker.stopContainer(previous, 10);
    try {
      await this.#createAndStart(config);
      await this.#docker.removeContainer(previous, { force: true });
    } catch (error) {
      this.#log.warn("the new router didn't start; restoring the previous one", {
        reason: (error as Error).message,
      });
      await this.#docker.removeContainer(ROUTER_CONTAINER, { force: true }).catch(() => {});
      await this.#docker.call("POST", `/containers/${previous}/rename`, {
        query: { name: ROUTER_CONTAINER },
      });
      if (current.State.Running) await this.#docker.startContainer(ROUTER_CONTAINER);
      throw error;
    }
  }

  /**
   * Runs the one-off container that gives the certificates volume to the router's user. True
   * when it changed an owner. A failure is logged and tried again at the next check: the router
   * still serves HTTP and uploaded certificates meanwhile.
   */
  async #ownCertificates(user: string): Promise<boolean> {
    const name = CERTIFICATES_OWNER_CONTAINER;
    try {
      await this.#docker.removeContainer(name, { force: true }).catch(() => {});
      await this.#docker.createContainer(name, certificatesOwnerConfig(this.settings.image, user));
      try {
        await this.#docker.startContainer(name);
        const { StatusCode } = await this.#docker.waitContainer(name, "not-running");
        if (StatusCode !== 0 && StatusCode !== OWNER_CHANGED) {
          throw new Error(`it exited with code ${StatusCode}`);
        }
        this.#certificatesOwner = user;
        if (StatusCode === OWNER_CHANGED) {
          this.#log.info("gave the certificate store to the router's user", { user });
        }
        return StatusCode === OWNER_CHANGED;
      } finally {
        await this.#docker.removeContainer(name, { force: true }).catch(() => {});
      }
    } catch (error) {
      this.#certificatesOwnerFailedAt = Date.now();
      this.#log.warn("couldn't give the certificate store to the router's user", {
        user,
        reason: (error as Error).message,
      });
      return false;
    }
  }

  /** Who holds the router's UDP port now, or null when it is free. */
  #udpHolder(): Promise<string | null> {
    return udpPortHolder(this.#docker, {
      port: this.settings.httpsPort,
      containerized: this.settings.containerized ?? false,
      image: this.settings.image,
      ...(this.settings.procRoot ? { procRoot: this.settings.procRoot } : {}),
    });
  }

  /**
   * Creates and starts the router. When Docker can't publish its ports and it asked for HTTP/3,
   * the UDP port may be what is taken (taken since the check): it starts without HTTP/3 instead,
   * and fails only when that fails too (R3-22).
   */
  async #createAndStart(config: Record<string, unknown>): Promise<void> {
    await this.#docker.createContainer(ROUTER_CONTAINER, config);
    try {
      await this.#start(ROUTER_CONTAINER);
    } catch (error) {
      if (!(error instanceof PortsInUseError) || !(this.#http3?.enabled ?? true)) throw error;
      await this.#docker.removeContainer(ROUTER_CONTAINER, { force: true }).catch(() => {});
      const before = this.#http3;
      this.#http3Off((await this.#udpHolder().catch(() => null)) ?? UNKNOWN_HOLDER);
      const fallback = await this.desiredContainer();
      await this.#docker.createContainer(ROUTER_CONTAINER, fallback.config);
      try {
        await this.#start(ROUTER_CONTAINER);
      } catch (second) {
        // Not the UDP port after all: TCP 80 or 443 is taken.
        this.#http3 = before;
        throw second;
      }
    }
  }

  async #start(name: string): Promise<void> {
    try {
      await this.#docker.startContainer(name);
    } catch (error) {
      if (portsInUse(error)) {
        throw new PortsInUseError(
          `The router can't listen on ports ${this.settings.httpPort} and ${this.settings.httpsPort}: another program already uses them. Stop that program (or free the ports), then run setup again.`,
          { cause: error },
        );
      }
      throw error;
    }
    // A router that exits right away (bad flags, unreadable folder) counts as not started.
    await Bun.sleep(1500);
    const after = await this.#docker.inspectContainer(name);
    if (!after.State.Running) {
      throw new Error(
        `The router stopped right after starting (exit code ${after.State.ExitCode}). Its log: docker logs ${name}`,
      );
    }
    this.#running = true;
    this.#image = after.Config.Image;
  }

  /** Whether the router container is up right now. */
  async isRunning(): Promise<boolean> {
    const current = await this.#docker.findContainer(ROUTER_CONTAINER).catch(() => null);
    this.#running = current?.State.Running ?? false;
    return this.#running;
  }

  // ---- Routes

  async #certificatesFor(route: RouteSpec): Promise<Map<string, EffectiveCertificate>> {
    const out = new Map<string, EffectiveCertificate>();
    for (const hostname of route.hostnames) {
      if (route.certificate === "none") {
        out.set(hostname, { mode: "none" });
        this.#holds.delete(hostname);
      } else if (route.certificate === "hold") {
        out.set(hostname, { mode: "hold", reason: "requested" });
        this.#holds.set(hostname, "requested");
      } else {
        const gate = this.#forcedHold.has(hostname)
          ? ({ mode: "hold", reason: "backoff" } as const)
          : (this.gate?.(hostname) ?? null);
        if (gate) {
          out.set(hostname, gate);
          this.#holds.delete(hostname);
          this.#issuing.delete(hostname);
          if (gate.mode === "hold") this.#gated.add(hostname);
          else this.#gated.delete(hostname);
          continue;
        }
        this.#gated.delete(hostname);
        const reason = await holdReason(
          hostname,
          this.#publicIPv4,
          this.#lookup,
          this.#lookup6,
          this.#addressLookupFailed,
        );
        if (reason) {
          out.set(hostname, { mode: "hold", reason });
          this.#holds.set(hostname, reason);
          this.#issuing.delete(hostname);
        } else {
          out.set(hostname, { mode: "letsencrypt" });
          this.#holds.delete(hostname);
          if (!this.#issuing.has(hostname)) {
            this.#issuing.add(hostname);
            this.onRequested?.(hostname);
          }
        }
      }
    }
    return out;
  }

  /** Every hostname with a route on this server. */
  hostnames(): string[] {
    return [...new Set([...this.#routes.values()].flatMap((route) => route.hostnames))];
  }

  /** Hostnames held by the back-off right now. */
  gatedHostnames(): string[] {
    return [...this.#gated];
  }

  /** Writes again the routes of these hostnames (after a back-off or an upload changed). */
  async refresh(hostnames: readonly string[]): Promise<void> {
    const wanted = new Set(hostnames);
    for (const route of this.#routes.values()) {
      if (route.hostnames.some((hostname) => wanted.has(hostname))) {
        await this.files.write(route, await this.#certificatesFor(route));
      }
    }
  }

  /**
   * Makes the router ask Let's Encrypt for a hostname again: it is held for a moment, then
   * released, which the router sees as a new configuration. Returns false without a route.
   */
  async retry(hostname: string, pauseMs = 3_000): Promise<boolean> {
    if (!this.hostnames().includes(hostname)) return false;
    this.#forcedHold.add(hostname);
    try {
      await this.refresh([hostname]);
      await Bun.sleep(pauseMs);
    } finally {
      this.#forcedHold.delete(hostname);
    }
    this.#issuing.delete(hostname);
    await this.refresh([hostname]);
    return true;
  }

  async write(routes: readonly RouteSpec[]): Promise<{ written: string[] }> {
    await this.files.prepare();
    const written: string[] = [];
    for (const route of routes) {
      const previous = this.#routes.get(route.key);
      for (const hostname of previous?.hostnames ?? []) {
        if (!route.hostnames.includes(hostname)) this.#holds.delete(hostname);
      }
      this.#routes.set(route.key, route);
      if (await this.files.write(route, await this.#certificatesFor(route)))
        written.push(route.key);
    }
    return { written };
  }

  async remove(keys: readonly string[]): Promise<{ removed: string[] }> {
    const removed: string[] = [];
    for (const key of keys) {
      for (const hostname of this.#routes.get(key)?.hostnames ?? []) {
        this.#holds.delete(hostname);
        this.#gated.delete(hostname);
        this.#issuing.delete(hostname);
      }
      this.#routes.delete(key);
      if (await this.files.remove(key)) removed.push(key);
    }
    return { removed };
  }

  /** Leaves exactly these routes in the folder. */
  async sync(routes: readonly RouteSpec[]): Promise<{ written: string[]; removed: string[] }> {
    const wanted = new Set(routes.map((route) => route.key));
    const stale = [...new Set([...(await this.files.keys()), ...this.#routes.keys()])].filter(
      (key) => !wanted.has(key),
    );
    const { removed } = stale.length > 0 ? await this.remove(stale) : { removed: [] };
    const { written } = routes.length > 0 ? await this.write(routes) : { written: [] };
    return { written, removed };
  }

  /** Looks again at held hostnames and rewrites routes whose hold changed. */
  async checkHolds(
    options: { addressChanged?: boolean } = {},
  ): Promise<{ released: string[]; held: string[] }> {
    const before = new Set([...this.#holds.keys(), ...this.#gated]);
    // A new address can hold names that pointed at the old one, so every route is checked then.
    const affected = [...this.#routes.values()].filter(
      (route) =>
        route.certificate === "letsencrypt" &&
        (options.addressChanged || route.hostnames.some((hostname) => before.has(hostname))),
    );
    for (const route of affected) {
      await this.files.write(route, await this.#certificatesFor(route));
    }
    const released = [...before].filter(
      (hostname) => !this.#holds.has(hostname) && !this.#gated.has(hostname),
    );
    return { released, held: [...this.#holds.keys(), ...this.#gated] };
  }
}
