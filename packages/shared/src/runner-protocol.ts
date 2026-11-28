import { z } from "zod";
import { builderSchema } from "./deploys.ts";
import { ROUTER_FILE_MAX_BYTES, ROUTER_FILE_NAME } from "./router-file-rules.ts";
import { accessLogCommandSchemas } from "./runner-access-log.ts";
import { BACKUP_STREAMING_COMMANDS, backupCommandSchemas } from "./runner-backups.ts";
import { COMPOSE_STREAMING_COMMANDS, composeCommandSchemas } from "./runner-compose.ts";
import { domainCommandSchemas } from "./runner-domains.ts";
import { firewallCommandSchemas } from "./runner-firewall.ts";
import { migrationCommandSchemas } from "./runner-migration.ts";
import { TASK_STREAMING_COMMANDS, taskCommandSchemas } from "./runner-tasks.ts";

/**
 * The protocol between the control plane and the runner on every server (spec 25 D1 option C,
 * D5). The runner opens one outbound WebSocket to the control plane, authenticated with its own
 * credential, and keeps it open. Every frame is one JSON message with a `type`.
 *
 * Both ends validate every message with the schemas below, so a malformed or unknown message is
 * refused in one place. Fields a side doesn't know are ignored, which lets either side add
 * optional fields without a new protocol version. A new protocol version is needed only when a
 * message changes meaning or a field becomes required; docs/runner-protocol.md describes the rules.
 */

/** The protocol this build speaks. */
export const RUNNER_PROTOCOL_VERSION = 1;

/**
 * The oldest runner protocol this control plane still accepts. Runners below it are refused with
 * a message that says to run setup again, which updates it (G3-05: there is no in-place
 * "Update runner" yet, so nothing names one).
 */
export const RUNNER_PROTOCOL_MIN_SUPPORTED = 1;

/** Where the runner connects (WebSocket) and enrolls (HTTP POST), under the API prefix. */
export const RUNNER_CONNECT_PATH = "/api/v1/runner/connect";
export const RUNNER_ENROLL_PATH = "/api/v1/runner/enroll";

/** A runner's credential: `nzr1.<runner id>.<secret>`. A join token: `nzj1.<token id>.<secret>`. */
export const RUNNER_CREDENTIAL_PREFIX = "nzr1";
export const JOIN_TOKEN_PREFIX = "nzj1";

/** How often the runner says it is alive, and how long silence means the link is gone. */
export const HEARTBEAT_INTERVAL_MS = 10_000;
export const HEARTBEAT_TIMEOUT_MS = 35_000;

/** Metrics are sampled this often (spec 14.1). */
export const METRICS_INTERVAL_MS = 5_000;

/** Largest piece of stream output in one message, before base64. */
export const STREAM_CHUNK_MAX_BYTES = 64 * 1024;

/** WebSocket close codes the two ends use, in the private range. */
export const RUNNER_CLOSE = {
  /** A newer connection for the same runner took over. */
  replaced: 4000,
  /** The runner speaks a protocol outside the supported window. */
  versionRefused: 4001,
  /** The credential was revoked or rotated. */
  revoked: 4002,
  /** A message didn't follow the protocol. */
  protocolError: 4003,
  /** No heartbeat within the timeout. */
  silent: 4004,
  /** The control plane is stopping; reconnect soon. */
  goingAway: 4005,
  /** Closed on request (tests, a forced reconnect, a move to another address). */
  reconnect: 4006,
  /**
   * A remote runner that can reach the control plane only unencrypted: no work goes to it until
   * it reaches the encrypted address (spec 31 "Remote runners are always encrypted").
   */
  unencrypted: 4007,
} as const;

/** The protocol both ends agree on, or why they can't agree. */
export type ProtocolAgreement =
  | { ok: true; protocol: number }
  | { ok: false; reason: "runner_outdated" | "control_outdated"; message: string };

/**
 * Picks the protocol for a connection: the newest both ends speak. A runner older than the
 * control plane's window is told to update; a runner that needs a newer control plane is told to
 * update Nearzero.
 */
export function agreeProtocol(
  runner: { protocol: number; minProtocol: number; version: string },
  control: { protocol: number; minSupported: number } = {
    protocol: RUNNER_PROTOCOL_VERSION,
    minSupported: RUNNER_PROTOCOL_MIN_SUPPORTED,
  },
): ProtocolAgreement {
  const agreed = Math.min(runner.protocol, control.protocol);
  if (agreed < control.minSupported) {
    return {
      ok: false,
      reason: "runner_outdated",
      message: `This server's runner (version ${runner.version}, protocol ${runner.protocol}) is older than this Nearzero supports (protocol ${control.minSupported} or newer). Run setup again on the server's page to update it.`,
    };
  }
  if (agreed < runner.minProtocol) {
    return {
      ok: false,
      reason: "control_outdated",
      message: `This server's runner (version ${runner.version}) needs a newer Nearzero (protocol ${runner.minProtocol} or newer; this one speaks ${control.protocol}). Update Nearzero by running the install command again.`,
    };
  }
  return { ok: true, protocol: agreed };
}

// ---- Shared shapes

const id = z.string().min(1).max(128);
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/);
const offset = z.number().int().min(0);

/** What a runner knows about its machine (spec 14.1, system information). */
export const systemInfoSchema = z.object({
  hostname: z.string().max(255),
  os: z.string().max(255),
  kernel: z.string().max(255),
  architecture: z.string().max(64),
  cpuModel: z.string().max(255),
  cpuCores: z.number().int().min(0),
  cpuThreads: z.number().int().min(0),
  cpuMhz: z.number().min(0),
  memoryTotalBytes: z.number().min(0),
  dockerVersion: z.string().max(64).nullable(),
  /** True when the runner runs inside a container (the Nearzero host's runner). */
  containerized: z.boolean(),
  /**
   * The server's time zone (an IANA name, or a fixed offset like UTC+05:30), which backup
   * schedules use (spec 08 8.3). Optional: older runners don't send it, and UTC is assumed.
   */
  timeZone: z.string().max(64).optional(),
});
export type SystemInfo = z.infer<typeof systemInfoSchema>;

/** One metrics sample (spec 14.1). Network is not collected in 1.0. */
export const metricsSampleSchema = z.object({
  at: z.number().int().min(0),
  cpuPercent: z.number().min(0).max(100),
  memoryUsedBytes: z.number().min(0),
  memoryTotalBytes: z.number().min(0),
  diskUsedBytes: z.number().min(0),
  diskTotalBytes: z.number().min(0),
  uptimeSeconds: z.number().min(0),
  // ---- Storage as df counts it (30c R3-34). Optional and additive: older runners don't send
  // it, and their samples show used / total as before.
  /**
   * What is still free for anyone but root on the server's root filesystem (statfs f_bavail, df's
   * "Available"). Space reserved for root counts as not available, so a full disk reads 100%.
   */
  diskAvailableBytes: z.number().min(0).optional(),
});
export type MetricsSample = z.infer<typeof metricsSampleSchema>;

export const containerStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  /** Docker's state word: created, running, paused, restarting, removing, exited, dead. */
  state: z.string(),
  status: z.string(),
  /** Only Nearzero's own labels (dev.nearzero.*), which map containers to services. */
  labels: z.record(z.string(), z.string()),
  createdAt: z.number().int(),
});
export type ContainerState = z.infer<typeof containerStateSchema>;

/** Why the router serves its placeholder certificate for a hostname (spec 10.7). */
export const HOLD_REASONS = [
  /** The hostname can never get a public certificate (localhost, .local, an IP, one label). */
  "not_public",
  /** The server's public IPv4 address isn't known, so DNS can't be checked. */
  "address_unknown",
  /** No A record. */
  "no_record",
  /** A records exist but none is this server. */
  "points_elsewhere",
  /** The lookup failed; checked again later. */
  "lookup_failed",
] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

// ---- HTTP/3 (R3-22), added in 1.0 round 2: older runners leave the field out

/**
 * Whether the router serves HTTP/3 on the server's UDP HTTPS port (spec 30, decisions part 2):
 * on, or off because something else already holds that port (`blockedBy` names it).
 */
export const routerHttp3Schema = z.object({
  enabled: z.boolean(),
  /** The UDP port it is (or would be) served on: the server's HTTPS port, 443. */
  port: z.number().int().min(1).max(65535),
  blockedBy: z.string().max(200).nullable(),
});
export type RouterHttp3 = z.infer<typeof routerHttp3Schema>;

/** The server details line when HTTP/3 is off (R3-22). */
export function http3OffMessage(port: number, program: string): string {
  return `HTTP/3 is off: UDP port ${port} is in use by ${program}`;
}

export const routerStateSchema = z.object({
  running: z.boolean(),
  image: z.string().nullable(),
  /** Route files the runner manages. */
  routes: z.number().int().min(0),
  held: z.array(z.object({ hostname: z.string(), reason: z.enum(HOLD_REASONS) })),
  lastError: z.string().nullable(),
  checkedAt: z.number().int(),
  /** R3-22: absent from older runners, and until the router was first checked. */
  http3: routerHttp3Schema.optional(),
});
export type RouterState = z.infer<typeof routerStateSchema>;

/** The checks the runner reports, which decide whether a server is ready (spec 9.4). */
export const runnerChecksSchema = z.object({
  docker: z.boolean(),
  network: z.boolean(),
  router: z.boolean(),
  routerDirectory: z.boolean(),
});
export type RunnerChecks = z.infer<typeof runnerChecksSchema>;

// ---- Routes the runner writes for the router (spec 10.1, 10.2, 10.7)

const ROUTE_KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HOSTNAME_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const PATH = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/;

/** A hostname a route may carry: lowercase letters, digits and dashes in dot-separated labels. */
export function isRouteHostname(value: string): boolean {
  if (value.length === 0 || value.length > 253) return false;
  const labels = value.split(".");
  return labels.every((label) => HOSTNAME_LABEL.test(label));
}

/**
 * How a route gets HTTPS. "letsencrypt" asks Let's Encrypt once DNS points at the server and
 * holds the hostname on the router's placeholder certificate until then; "hold" always serves the
 * placeholder; "none" serves plain HTTP only.
 */
export const ROUTE_CERTIFICATES = ["letsencrypt", "hold", "none"] as const;
export type RouteCertificate = (typeof ROUTE_CERTIFICATES)[number];

export const routeSpecSchema = z.object({
  /** The route's name on the server; its file is `<key>.yml`. */
  key: z.string().regex(ROUTE_KEY, "Use lowercase letters, numbers and dashes for a route key."),
  hostnames: z
    .array(
      z
        .string()
        .transform((value) => value.trim().toLowerCase())
        .refine(isRouteHostname, "That isn't a valid hostname."),
    )
    .min(1)
    .max(50),
  path: z.string().regex(PATH, "A path starts with / and has no spaces.").max(1024).default("/"),
  upstream: z.object({
    /** A container name or network alias on the private network. */
    host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
    port: z.number().int().min(1).max(65535),
    scheme: z.enum(["http", "https"]).default("http"),
  }),
  certificate: z.enum(ROUTE_CERTIFICATES).default("letsencrypt"),
  /**
   * Whether the router's request log records this route's requests (spec 13.1). The console's
   * own routes don't, so Analytics counts only traffic to apps (R3-26). Older runners ignore it.
   */
  accessLog: z.boolean().default(true),
});
export type RouteSpec = z.output<typeof routeSpecSchema>;
export type RouteSpecInput = z.input<typeof routeSpecSchema>;

// ---- Commands the control plane sends

const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/), z.string());
/** A service's folder in the runner's work folder: its internal app name. */
const appKey = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);
const labels = z.record(z.string().min(1).max(255), z.string().max(4096));
const imageRef = z.string().min(1).max(512);

export const commandParamsSchemas = {
  "system.info": z.object({}),
  "image.pull": z.object({
    image: imageRef,
    platform: z.string().max(64).optional(),
    /** Base64 JSON for the registry, as Docker expects it. A secret; never logged. */
    registryAuth: z.string().max(16_384).optional(),
    /**
     * Makes the pulled image Nearzero's own: a copy tagged with this name and carrying `labels`
     * (and the managed label), so teardown and uninstall find it. The pulled tag is dropped again
     * when it wasn't on the server before. The result's `image` is this tag.
     */
    ownTag: imageRef.optional(),
    labels: labels.default({}),
  }),
  "image.build": z.object({
    contextDirectory: z.string().min(1).max(4096),
    dockerfile: z.string().max(4096).optional(),
    tags: z.array(imageRef).min(1).max(10),
    buildArgs: env.default({}),
    labels: labels.default({}),
    /** Values hidden from the build log wherever they appear. */
    secrets: z.array(z.string()).max(100).default([]),
  }),
  "image.remove": z.object({ image: imageRef, force: z.boolean().default(false) }),
  "container.create": z.object({
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
    image: imageRef,
    env: env.default({}),
    labels: labels.default({}),
    command: z.array(z.string()).optional(),
    entrypoint: z.array(z.string()).optional(),
    workingDir: z.string().max(4096).optional(),
    user: z.string().max(128).optional(),
    network: z.string().max(128).optional(),
    networkAliases: z.array(z.string().max(128)).max(16).default([]),
    restartPolicy: z
      .enum(["no", "always", "unless-stopped", "on-failure"])
      .default("unless-stopped"),
    mounts: z
      .array(
        z.object({
          type: z.enum(["volume", "bind"]),
          source: z.string().min(1).max(4096),
          target: z.string().min(1).max(4096),
          readOnly: z.boolean().default(false),
        }),
      )
      .max(64)
      .default([]),
    ports: z
      .array(
        z.object({
          containerPort: z.number().int().min(1).max(65535),
          hostPort: z.number().int().min(1).max(65535),
          protocol: z.enum(["tcp", "udp"]).default("tcp"),
          hostIp: z.string().max(64).optional(),
        }),
      )
      .max(64)
      .default([]),
    tty: z.boolean().default(false),
    /**
     * Files put into the container before it starts (file mounts, key files). Their content is a
     * secret: never logged, never returned.
     */
    files: z
      .array(
        z.object({
          path: z.string().regex(/^\/[^\0]{1,999}$/),
          /** Base64. */
          content: z.string().max(2 * 1024 * 1024),
          mode: z.number().int().min(0).max(0o7777).default(0o644),
          uid: z.number().int().min(0).default(0),
          gid: z.number().int().min(0).default(0),
        }),
      )
      .max(64)
      .default([]),
    /** Seconds Docker gives the process to stop before killing it. */
    stopTimeoutSeconds: z.number().int().min(0).max(600).optional(),
  }),
  "container.start": z.object({ id }),
  "container.stop": z.object({ id, timeoutSeconds: z.number().int().min(0).max(600).default(10) }),
  "container.remove": z.object({
    id,
    force: z.boolean().default(false),
    volumes: z.boolean().default(false),
  }),
  "container.inspect": z.object({ id }),
  "container.wait": z.object({
    id,
    condition: z.enum(["not-running", "next-exit", "removed"]).default("not-running"),
  }),
  "container.list": z.object({
    all: z.boolean().default(true),
    /** label=value or label filters, as Docker takes them. */
    labels: z.array(z.string().max(512)).max(16).default([]),
  }),
  /** Streams the container's output. */
  "container.logs": z.object({
    id,
    follow: z.boolean().default(true),
    tail: z.union([z.number().int().min(0).max(100_000), z.literal("all")]).default(200),
    /** Seconds since the epoch, fractions allowed. */
    since: z.number().min(0).optional(),
    timestamps: z.boolean().default(false),
  }),
  /** Starts a process in the container and streams its output; input arrives as stream.input. */
  "container.exec": z.object({
    id,
    command: z.array(z.string()).min(1).max(256),
    tty: z.boolean().default(true),
    cols: z.number().int().min(1).max(1000).default(80),
    rows: z.number().int().min(1).max(1000).default(24),
    env: env.default({}),
    user: z.string().max(128).optional(),
    workingDir: z.string().max(4096).optional(),
  }),
  "network.ensure": z.object({ name: z.string().min(1).max(128), labels: labels.default({}) }),
  "network.connect": z.object({
    network: z.string().min(1).max(128),
    container: id,
    aliases: z.array(z.string().max(128)).max(16).default([]),
  }),
  "network.remove": z.object({ name: z.string().min(1).max(128) }),
  "volume.create": z.object({ name: z.string().min(1).max(255), labels: labels.default({}) }),
  "volume.remove": z.object({
    name: z.string().min(1).max(255),
    force: z.boolean().default(false),
  }),
  "volume.list": z.object({ labels: z.array(z.string().max(512)).max(16).default([]) }),
  /** Removes unused images and build cache (the nightly cleanup, spec 9.4). */
  "system.prune": z.object({
    images: z.enum(["dangling", "unused"]).default("unused"),
    buildCache: z.boolean().default(true),
  }),
  /** A Compose stack: files are written to the runner's work folder, then `docker compose up`. */
  "compose.up": z.object({
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    files: z
      .array(z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/), content: z.string() }))
      .min(1)
      .max(32),
    env: env.default({}),
    secrets: z.array(z.string()).max(100).default([]),
    /** False while a moved stack isn't finalized (spec 29.5). */
    removeOrphans: z.boolean().default(true),
  }),
  "compose.down": z.object({
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    volumes: z.boolean().default(false),
    /** False while a moved stack isn't finalized (spec 29.5). */
    removeOrphans: z.boolean().default(true),
  }),
  /**
   * Runs a command in a running container and waits for it (readiness checks, replica set
   * setup). Output is captured, cut to its last 64 KB, with the given secrets removed.
   */
  "container.exec-capture": z.object({
    id,
    command: z.array(z.string()).min(1).max(256),
    env: env.default({}),
    user: z.string().max(128).optional(),
    timeoutSeconds: z.number().int().min(1).max(600).default(30),
    secrets: z.array(z.string()).max(100).default([]),
  }),
  "image.list": z.object({
    labels: z.array(z.string().max(512)).max(16).default([]),
    /** Image references, like nearzero/my-app-x1y2z3 (every tag of it). */
    reference: z.array(z.string().max(512)).max(16).default([]),
  }),
  /**
   * Fetches a Git repository into the service's source folder, at the branch's newest commit, a
   * given commit, or a tag. Over SSH the given private key is used and then deleted.
   */
  "source.git": z.object({
    appKey,
    url: z.string().min(1).max(1000),
    branch: z.string().min(1).max(255),
    commit: z
      .string()
      .regex(/^[0-9a-f]{7,64}$/)
      .optional(),
    tag: z.string().min(1).max(255).optional(),
    /** A secret; written to a 0600 file for the fetch only. */
    sshPrivateKey: z.string().max(16_384).optional(),
    /**
     * Secret, short-lived credentials from a connected Git provider (spec 16): sent to the
     * repository's own host as an HTTP Authorization header for this fetch only, never put in
     * the URL, and cut out of anything printed.
     */
    httpAuth: z
      .object({ username: z.string().min(1).max(255), password: z.string().min(1).max(8192) })
      .optional(),
    submodules: z.boolean().default(false),
  }),
  /**
   * Downloads an uploaded .zip from the control plane (with the runner's credential), checks its
   * checksum, and unpacks it safely into the service's source folder.
   */
  "source.archive": z.object({
    appKey,
    uploadId: z.string().regex(/^[0-9a-f-]{36}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    sizeBytes: z.number().int().min(1),
  }),
  /** Builds the service's source folder into an image with the chosen builder (spec 6.4). */
  "app.build": z.object({
    appKey,
    buildPath: z.string().max(500).default(""),
    builder: builderSchema,
    commands: z
      .object({
        install: z.string().max(2000).default(""),
        build: z.string().max(2000).default(""),
        start: z.string().max(2000).default(""),
      })
      .default({ install: "", build: "", start: "" }),
    /** Build-safe variables (letters, digits and _). Values are secrets. */
    buildEnv: env.default({}),
    /** The port the app listens on (the static server listens there too). */
    servicePort: z.number().int().min(1).max(65535).default(3000),
    tags: z.array(imageRef).min(1).max(10),
    labels: labels.default({}),
    noCache: z.boolean().default(false),
  }),
  /** Removes a service's folders from the runner's work folder (teardown). */
  "workdir.remove": z.object({ appKey }),
  /** Writes or replaces route files. */
  "router.write": z.object({ routes: z.array(routeSpecSchema).min(1).max(500) }),
  "router.remove": z.object({ keys: z.array(z.string().regex(ROUTE_KEY)).min(1).max(500) }),
  /** Makes the router folder hold exactly these routes (stale Nearzero files are removed). */
  "router.sync": z.object({ routes: z.array(routeSpecSchema).max(10_000) }),
  /** Reads the router folder: file names and contents (Router files, spec 9.1). */
  "router.files": z.object({}),
  /**
   * Writes one YAML file a person edited in Settings → Router files (spec 18.3), directly in the
   * router's folder; the runner's own files are refused. The control plane validated it first.
   */
  "router.file-write": z.object({
    name: z.string().regex(ROUTER_FILE_NAME),
    contents: z.string().max(ROUTER_FILE_MAX_BYTES),
  }),
  /**
   * Checks DNS for held hostnames now and releases those that point here (spec 10.7). The
   * control plane's 5-minute check gives the server's public IPv4 as it is now, or null with
   * `lookupFailed` when the server's own name didn't resolve just now (R3-10); without it the
   * router keeps the address it has.
   */
  "router.check-holds": z.object({
    publicIPv4: z.string().max(64).nullable().optional(),
    lookupFailed: z.boolean().optional(),
  }),
  /** Checks the router and the private network, recreating them when needed (spec 23.2). */
  "router.ensure": z.object({}),
  // Certificates and the built-in DNS server (spec 10.7, 10.8).
  ...domainCommandSchemas,
  // Backups and restores (spec 08 8.3, 17).
  ...backupCommandSchemas,
  // Compose stacks (spec 07).
  ...composeCommandSchemas,
  // Tasks and the router's request log (spec 12, 13).
  ...taskCommandSchemas,
  ...accessLogCommandSchemas,
  // Moving a 0.1.x install to 1.0 (spec 29.5).
  ...migrationCommandSchemas,
  // Published ports in a remote server's host firewall (30b R2-13; runner-firewall.ts).
  ...firewallCommandSchemas,
} as const;

export type CommandKind = keyof typeof commandParamsSchemas;
export const COMMAND_KINDS = Object.keys(commandParamsSchemas) as CommandKind[];
export type CommandParams<K extends CommandKind> = z.input<(typeof commandParamsSchemas)[K]>;
export type ParsedCommandParams<K extends CommandKind> = z.output<(typeof commandParamsSchemas)[K]>;

/** Commands whose output arrives as a stream (with a stream id given by the control plane). */
export const STREAMING_COMMANDS: ReadonlySet<CommandKind> = new Set<CommandKind>([
  "image.pull",
  "image.build",
  "container.logs",
  "container.exec",
  "compose.up",
  "compose.down",
  "source.git",
  "source.archive",
  "app.build",
  ...BACKUP_STREAMING_COMMANDS,
  ...COMPOSE_STREAMING_COMMANDS,
  ...TASK_STREAMING_COMMANDS,
]);

export function isCommandKind(value: string): value is CommandKind {
  return Object.hasOwn(commandParamsSchemas, value);
}

/** Machine codes for a command that failed on the runner. The message is for people. */
export const RUNNER_ERROR_CODES = [
  "invalid",
  "not_found",
  "conflict",
  "docker_unavailable",
  "timeout",
  "cancelled",
  "unsupported",
  "failed",
] as const;
export type RunnerErrorCode = (typeof RUNNER_ERROR_CODES)[number];

const runnerError = z.object({
  code: z.enum(RUNNER_ERROR_CODES),
  message: z.string().max(8_000),
});
export type RunnerError = z.infer<typeof runnerError>;

// ---- Where the runner reaches the control plane

/** An origin the runner connects to: scheme, host and port, nothing else. */
export const linkOrigin = z
  .string()
  .max(300)
  .regex(/^https?:\/\/[^/\s?#@]+$/);
/** SHA-256 of a certificate's DER bytes, 64 lowercase hex characters. */
export const linkFingerprint = z.string().regex(/^[0-9a-f]{64}$/);
/** An https:// origin: the only kind a remote runner is ever moved to (C4-04). */
export const encryptedLinkOrigin = z
  .string()
  .max(300)
  .regex(/^https:\/\/[^/\s?#@]+$/);
/**
 * Whether an origin's host is an IP address, in any spelling a URL parser reads as one: dotted,
 * a single number (`https://2130706433`), hexadecimal or octal parts, a trailing dot, or IPv6.
 * The WHATWG parser normalizes all of them to dotted IPv4 or bracketed IPv6, as the runner does.
 */
export function isIpOrigin(origin: string): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}
/**
 * An address a remote runner may be moved to: pinned (with the control plane's certificate
 * fingerprint), or a host name checked against public authorities. Never plain, and never an IP
 * address without a pin (spec 31 "Remote runners are always encrypted", C4-03, C4-04).
 */
export const runnerMoveTarget = z
  .object({ url: encryptedLinkOrigin, fingerprint: linkFingerprint.nullable() })
  .refine((link) => link.fingerprint !== null || !isIpOrigin(link.url), {
    message: "An IP address needs the certificate's fingerprint.",
  });
export type RunnerLinkAddress = { url: string; fingerprint: string | null };

// ---- Messages from the runner

export const helloSchema = z.object({
  type: z.literal("hello"),
  runnerVersion: z.string().max(64),
  protocol: z.number().int().min(1),
  minProtocol: z.number().int().min(1),
  startedAt: z.number().int(),
  system: systemInfoSchema,
  checks: runnerChecksSchema,
  /** Streams still open on the runner, with the output it still holds for each. */
  streams: z
    .array(z.object({ streamId: id, firstOffset: offset, endOffset: offset, ended: z.boolean() }))
    .max(10_000),
  /** Commands the runner is still running, or finished with a result not yet received. */
  commands: z.array(z.object({ commandId: id, finished: z.boolean() })).max(10_000),
  /**
   * The address this runner reaches the control plane at, from runners the control plane can
   * move (welcome.link); older runners leave it out. `declined` lists addresses it was moved to
   * recently and couldn't use, with why, so it isn't sent there again at once.
   */
  link: z
    .object({
      url: linkOrigin,
      declined: z
        .array(z.object({ url: linkOrigin, reason: z.string().max(500) }))
        .max(5)
        .optional(),
      /** The next fingerprint the runner already holds (the pair being replaced, C4-10). */
      next: linkFingerprint.optional(),
    })
    .optional(),
});

export const runnerMessageSchema = z.discriminatedUnion("type", [
  helloSchema,
  z.object({
    type: z.literal("heartbeat"),
    seq: z.number().int().min(0),
    at: z.number().int(),
    /** The next link fingerprint the runner holds, once a welcome gave it one (C4-10). */
    next: linkFingerprint.optional(),
  }),
  z.object({ type: z.literal("ack"), commandId: id }),
  /** ok with data, or not ok with an error. */
  z.object({
    type: z.literal("result"),
    commandId: id,
    ok: z.boolean(),
    data: z.unknown().optional(),
    error: runnerError.optional(),
  }),
  z.object({
    type: z.literal("stream.data"),
    streamId: id,
    /** Byte offset of this chunk's first byte in the whole stream. */
    offset,
    data: base64,
  }),
  z.object({
    type: z.literal("stream.end"),
    streamId: id,
    /** The stream's total length in bytes. */
    offset,
    exitCode: z.number().int().nullable().optional(),
    error: runnerError.optional(),
  }),
  z.object({
    type: z.literal("state"),
    at: z.number().int(),
    containers: z.array(containerStateSchema).max(10_000),
    router: routerStateSchema,
    checks: runnerChecksSchema,
  }),
  z.object({ type: z.literal("metrics"), samples: z.array(metricsSampleSchema).min(1).max(2_000) }),
]);
export type RunnerMessage = z.infer<typeof runnerMessageSchema>;
export type HelloMessage = z.infer<typeof helloSchema>;

// ---- Messages from the control plane

export const welcomeSchema = z.object({
  type: z.literal("welcome"),
  protocol: z.number().int().min(1),
  controlVersion: z.string().max(64),
  /** The server this runner serves: a server id, or "host" for the Nearzero host. */
  serverId: id,
  serverName: z.string().max(255),
  /** The server's public IPv4 address, against which DNS is checked before certificates. */
  publicIPv4: z.string().max(64).nullable(),
  heartbeatIntervalMs: z.number().int().min(1000),
  /** Where to resume each open stream the control plane still follows. */
  resume: z.array(z.object({ streamId: id, offset })).max(10_000),
  /** Open streams nobody follows any more: stop them. */
  close: z.array(id).max(10_000),
  /** Commands whose results the control plane already has. */
  received: z.array(id).max(10_000),
  /**
   * Where this runner should reach the control plane from now on, when that isn't where it is
   * (spec 31 "Remote runners are always encrypted"): an https:// address, with the SHA-256
   * fingerprint of the control plane's own certificate when there is no domain. The runner tries
   * it, keeps it once it is welcomed there, and goes back to its old address when it can't. Sent
   * only to runners whose hello says where they are; the Nearzero host's runner is never moved.
   */
  link: runnerMoveTarget.optional(),
  /**
   * The control plane's own TLS port and its certificate's fingerprint, which the runner keeps as
   * its fallback when the address it uses stops answering (C4-06). Remote runners only.
   */
  fallback: z.object({ url: encryptedLinkOrigin, fingerprint: linkFingerprint }).optional(),
  /**
   * The fingerprint of the certificate that will replace the current one (C4-10): the runner
   * accepts it as well from now on, so the switch cuts nobody off.
   */
  nextFingerprint: linkFingerprint.optional(),
});
export type WelcomeMessage = z.infer<typeof welcomeSchema>;

export const controlMessageSchema = z.discriminatedUnion("type", [
  welcomeSchema,
  z.object({
    type: z.literal("refused"),
    /** "unencrypted" goes only to runners that sent hello.link, which know it. */
    reason: z.enum(["runner_outdated", "control_outdated", "revoked", "unencrypted"]),
    message: z.string().max(2_000),
  }),
  z.object({
    type: z.literal("command"),
    commandId: id,
    kind: z.string().max(64),
    params: z.unknown(),
    /** For streaming commands: the id output is sent under. */
    streamId: id.optional(),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(24 * 3_600_000)
      .optional(),
    /**
     * Follow this command only if it is running or has its result waiting; never start it
     * (work followed again after a control-plane restart, B2-20). Otherwise the result is
     * `not_found`.
     */
    resumeOnly: z.boolean().optional(),
  }),
  z.object({ type: z.literal("cancel"), commandId: id }),
  z.object({ type: z.literal("result.received"), commandId: id }),
  z.object({ type: z.literal("stream.ack"), streamId: id, offset }),
  z.object({ type: z.literal("stream.input"), streamId: id, data: base64 }),
  z.object({
    type: z.literal("stream.resize"),
    streamId: id,
    cols: z.number().int().min(1).max(1000),
    rows: z.number().int().min(1).max(1000),
  }),
  z.object({ type: z.literal("stream.close"), streamId: id }),
  z.object({ type: z.literal("heartbeat.ack"), seq: z.number().int().min(0) }),
]);
export type ControlMessage = z.infer<typeof controlMessageSchema>;

/** Parses one frame; null when it isn't a valid message (the caller closes the connection). */
export function parseRunnerMessage(frame: string): RunnerMessage | null {
  return parseFrame(frame, runnerMessageSchema);
}

export function parseControlMessage(frame: string): ControlMessage | null {
  return parseFrame(frame, controlMessageSchema);
}

function parseFrame<T>(frame: string, schema: z.ZodType<T>): T | null {
  let value: unknown;
  try {
    value = JSON.parse(frame);
  } catch {
    return null;
  }
  const result = schema.safeParse(value);
  return result.success ? result.data : null;
}

// ---- Enrollment (HTTP, before the WebSocket)

export const enrollRequestSchema = z.object({
  joinToken: z.string().min(10).max(512),
  runnerVersion: z.string().max(64),
  protocol: z.number().int().min(1),
  minProtocol: z.number().int().min(1),
  system: systemInfoSchema.partial().optional(),
});
export type EnrollRequest = z.infer<typeof enrollRequestSchema>;

export const enrollResponseSchema = z.object({
  serverId: z.string(),
  serverName: z.string(),
  /** Shown once; the runner keeps it in a root-only file. */
  credential: z.string(),
});
export type EnrollResponse = z.infer<typeof enrollResponseSchema>;

// ---- Helpers both ends use

/** Base64 for stream data. */
export function encodeChunk(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function decodeChunk(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

/** Docker labels Nearzero puts on what it creates. */
export const NEARZERO_LABELS = {
  managed: "dev.nearzero.managed",
  /** Nearzero's own containers (control, database, router, runner, DNS): reserved. */
  component: "dev.nearzero.component",
  /** Containers that belong to a service carry its id (spec 22.4, rule 4). */
  service: "dev.nearzero.service",
  /** Containers and images of one deployment carry its id. */
  deployment: "dev.nearzero.deployment",
  /** The router's configuration fingerprint, so an unchanged router is never recreated. */
  routerConfig: "dev.nearzero.router-config",
  /**
   * "1" on everything Nearzero 1.0 creates on a host (spec 29.5 "No shared names with 0.1.x"):
   * rollback and uninstall remove only what carries it, and the installer's collision check
   * tells 1.0's own names from anything else's.
   */
  edition: "dev.nearzero.edition",
  /** The move from 0.1.x that created it, while there is one (spec 29.5). */
  attempt: "dev.nearzero.migration-attempt",
} as const;

/** The labels naming 1.0 (and the move attempt, when given) on what it creates. */
export function editionLabels(attempt?: string | null): Record<string, string> {
  return {
    [NEARZERO_LABELS.edition]: "1",
    ...(attempt && /^[A-Za-z0-9_.-]{1,64}$/.test(attempt)
      ? { [NEARZERO_LABELS.attempt]: attempt }
      : {}),
  };
}

/** The private network apps and the router share on every server. */
export const PRIVATE_NETWORK = "nearzero-edge";
export const ROUTER_CONTAINER = "nearzero-router";
export const ROUTER_CERTIFICATES_VOLUME = "nearzero-router-certificates";
