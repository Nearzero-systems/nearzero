import { z } from "zod";

/**
 * The control plane's configuration, read from environment variables at start.
 *
 * Every problem is reported in plain words that name the variable and the fix, and all problems
 * are reported together. Messages never repeat a value that may hold a secret.
 */

export const RUN_MODES = ["production", "development", "test"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const CONTROL_DEFAULTS = {
  mode: "production",
  port: 3000,
  bindAddress: "0.0.0.0",
  logLevel: "info",
  jobConcurrency: 4,
  /** Deploys have their own lanes (R2-15): pushes never wait behind tasks or backups. */
  deployConcurrency: 4,
  /** How many apps one server builds at once, unless an administrator raises it (R2-15). */
  buildsPerServer: 1,
  jobPollIntervalMs: 1000,
  databaseWaitSeconds: 120,
} as const;

/** A generated secret is at least this long (32 random bytes as hex is 64). */
export const AUTH_SECRET_MIN_LENGTH = 32;

/** Fewer distinct characters than this means the secret was typed by hand, not generated. */
const AUTH_SECRET_MIN_DISTINCT = 10;

const GENERATE_SECRET_HINT = "openssl rand -hex 32";

/** How this server sends email when a workspace has no email settings of its own. */
export type InstanceEmailConfig =
  | { provider: "resend"; from: string; apiKey: string }
  | {
      provider: "smtp";
      from: string;
      host: string;
      port: number;
      security: "tls" | "starttls";
      username: string;
      password: string;
    };

export interface ControlConfig {
  mode: RunMode;
  databaseUrl: string;
  /** The authentication secret, or null when none is set (never allowed in production). */
  authSecret: string | null;
  http: { hostname: string; port: number };
  logLevel: LogLevel;
  jobs: {
    concurrency: number;
    deployConcurrency: number;
    buildsPerServer: number;
    pollIntervalMs: number;
  };
  /**
   * How long a start waits for PostgreSQL to answer before it gives up (spec 23.2: the control
   * plane survives the database restarting; a start doesn't fail just because it is still coming up).
   */
  databaseWaitSeconds: number;
  /**
   * The console's public address, used in invitation links and sign-in instructions, or null
   * when this server has none yet.
   */
  consoleUrl: string | null;
  /**
   * Peers whose X-Forwarded-For and X-Forwarded-Proto headers are believed (the console's proxy).
   * Loopback addresses by default.
   */
  trustedProxies: string[];
  instanceEmail: InstanceEmailConfig | null;
  /**
   * Why this server's email settings can't be used (half set up), or null. Logged at start and
   * shown on the Members page; the control plane runs without server email meanwhile.
   */
  instanceEmailProblem?: string | null;
  /** The server's public IP address from the install, or null. */
  publicIp: string | null;
  /**
   * The address Git providers call back and send events to, when it isn't the console's
   * (NEARZERO_GIT_PUBLIC_URL, 0.1.x's PUBLIC_GIT_PROVIDER_BASE_URL); null to use the console's.
   */
  gitPublicUrl?: string | null;
  runner: {
    /**
     * A folder shared with the Nearzero host's runner, where a one-time join token is left at
     * every start so the host's runner enrolls by itself. Null outside the installed host.
     */
    handoffDirectory: string | null;
    /**
     * An https:// address remote runners connect to, set outright (NEARZERO_RUNNER_CONTROL_URL);
     * null to let the control plane choose (spec 31 "Remote runners are always encrypted"): the
     * console's hostname once its certificate is valid, else the runner link below.
     */
    controlUrl: string | null;
    /**
     * A NEARZERO_RUNNER_CONTROL_URL that is ignored and named in the start log: plain http://
     * (servers never get a plain address), or https:// to an IP address, which runners can't
     * check without a fingerprint (C4-03). Null when there is none.
     */
    ignoredControlUrl?: string | null;
    /**
     * The runner link's own TLS port, for installs without a domain: served with a certificate
     * the control plane makes once and keeps in `tlsDirectory`. Null when not set up (tests).
     */
    link?: {
      tlsDirectory: string;
      /** The port servers connect to (published by compose.yml). */
      port: number;
      /** The port the control plane listens on in its container. */
      listenPort: number;
      bindAddress: string;
    } | null;
  };
  /** Domains, certificates and managed DNS (spec 03 3.1, spec 10). */
  domains: DomainsConfig;
  /**
   * Settings 0.1.x had that 1.0 keeps reading (spec 03 3.5). Optional so a hand-made config
   * needn't list them.
   */
  legacySettings?: {
    /** NEARZERO_REGISTRATION_MODE: both behave alike in 1.0 (invitations only, spec 04 4.2). */
    registrationMode: "bootstrap" | "invite-only";
    /** NEARZERO_TRUSTED_ORIGINS: extra addresses people sign in from. */
    trustedOrigins: string[];
    /** NEARZERO_METRICS_RETENTION_DAYS: days of server metrics kept, or null for the default. */
    metricsRetentionDays: number | null;
    /** NEARZERO_METRICS_REFRESH_SECONDS: the host runner's sample interval, or null. */
    metricsRefreshSeconds: number | null;
  };
  /** Setting servers up over SSH (spec 09 9.2, 9.3, 22.5). */
  ssh: {
    /** NEARZERO_SSH_STRICT_HOST_KEY_CHECKING: refuse servers whose host key wasn't trusted first. */
    strictHostKeyChecking: boolean;
    /**
     * NEARZERO_RUNNER_BINARIES_DIR: the compiled runners setup installs on servers, with their
     * SHA256SUMS. Null: next to the app (production image) or runner/dist (development).
     */
    runnerBinariesDirectory: string | null;
  };
}

export interface DomainsConfig {
  /** The domain whose wildcard gives apps generated hostnames (NEARZERO_PLATFORM_DOMAIN). */
  platformDomain: string | null;
  /** The console's own hostname (NEARZERO_MANAGEMENT_HOSTNAME). */
  managementHostname: string | null;
  /** A zone set at install (NEARZERO_MANAGED_DNS_ZONE), connected for the first workspace. */
  managedZone: string | null;
  managedZoneEmail: string | null;
  /** The contact for Let's Encrypt (NEARZERO_ACME_EMAIL). */
  acmeEmail: string | null;
  /** NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE. */
  sharedEdge: boolean;
  /**
   * Public resolvers DNS checks ask (NEARZERO_DNS_RESOLVERS, "ip" or "ip:port", comma
   * separated). Defaults to Cloudflare's and Google's.
   */
  resolvers: string[];
}

export const DEFAULT_DNS_RESOLVERS = ["1.1.1.1", "8.8.8.8"] as const;

/**
 * The runner link's TLS port (spec 31 "Remote runners are always encrypted"): servers reach the
 * control plane here when it has no domain, checking its certificate by fingerprint.
 */
export const RUNNER_LINK_DEFAULT_PORT = 3443;

/**
 * 0.1.x setting names 1.0 reads as a 1.0 setting (spec 03 3.5), old name to new. The 1.0 name wins
 * when both are set. installer/install.sh keeps the same table (NZ_SETTING_ALIASES).
 */
export const LEGACY_SETTING_ALIASES: Readonly<Record<string, string>> = {
  NEARZERO_NONINTERACTIVE: "NEARZERO_UNATTENDED",
  NEARZERO_STARTUP_TIMEOUT_SECONDS: "NEARZERO_STARTUP_TIMEOUT",
  NEARZERO_PLATFORM_PORT: "NEARZERO_API_PORT",
  CONSOLE_URL: "NEARZERO_CONSOLE_URL",
  PUBLIC_BACKEND_URL: "NEARZERO_CONSOLE_URL",
  // 0.1.x's auth address names the console too, after its console names (31d G4-19).
  BETTER_AUTH_URL: "NEARZERO_CONSOLE_URL",
  // The address Git providers call back and send events to (OAuth callbacks, webhooks).
  PUBLIC_GIT_PROVIDER_BASE_URL: "NEARZERO_GIT_PUBLIC_URL",
  // The router: 1.0's runner runs it from these (the installer gives them to it).
  TRAEFIK_IMAGE: "NEARZERO_ROUTER_IMAGE",
  TRAEFIK_PORT: "NEARZERO_HTTP_PORT",
  TRAEFIK_SSL_PORT: "NEARZERO_HTTPS_PORT",
  DRY_RUN: "NEARZERO_DRY_RUN",
  INSTALL_DIR: "NEARZERO_INSTALL_DIR",
  // This server's own email (30a R1-04): 0.1.x read the key and the sender by these names. When
  // both old sender names are set, NEARZERO_AUTH_FROM_EMAIL wins, as it did in 0.1.x.
  RESEND_API_KEY: "NEARZERO_RESEND_API_KEY",
  NEARZERO_AUTH_FROM_EMAIL: "NEARZERO_EMAIL_FROM",
  RESEND_FROM_EMAIL: "NEARZERO_EMAIL_FROM",
};

/**
 * 0.1.x settings accepted and ignored (spec 03 3.5, 31d G4-19), with why: 1.0 has nothing they
 * set. Each is named once, by the installer and in the control plane's start log.
 */
export const IGNORED_LEGACY_SETTINGS = {
  NEARZERO_METRICS_PORT: "Nearzero 1.0's runner collects metrics itself",
  NEARZERO_METRICS_CRON: "Nearzero 1.0's runner collects metrics itself",
  NEARZERO_MONITORING_IMAGE: "1.0 has no separate monitoring service",
  NEARZERO_ALLOW_MONITORING_DOCKER_METADATA: "1.0 has no separate monitoring service",
  NEARZERO_SCHEDULE_IMAGE: "the control plane runs schedules itself",
  JOBS_URL: "the control plane runs jobs itself",
  API_KEY: "the control plane runs jobs itself",
  TRAEFIK_SOCKET_PROXY_IMAGE: "the router reads files, not the Docker socket",
  TRAEFIK_HTTP3_PORT: "HTTP/3 uses the HTTPS port (UDP)",
  POSTGRES_USER: "the bundled database's user is fixed; an external one is given by DATABASE_URL",
  POSTGRES_DB: "the bundled database's name is fixed; an external one is given by DATABASE_URL",
} as const;

/** The ignored 0.1.x settings an environment sets, in the table's order. */
export function ignoredLegacySettings(env: Record<string, string | undefined>): string[] {
  return Object.keys(IGNORED_LEGACY_SETTINGS).filter((name) => env[name]?.trim());
}

/**
 * The environment with each 0.1.x name read as its 1.0 setting where that isn't set, and
 * EXTERNAL_SERVICES=true as external data mode (spec 03 3.5).
 */
export function withLegacySettingNames(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out = { ...env };
  for (const [old, current] of Object.entries(LEGACY_SETTING_ALIASES)) {
    if (!out[current]?.trim() && out[old]?.trim()) out[current] = out[old];
  }
  if (
    !out.NEARZERO_DATA_MODE?.trim() &&
    /^(true|1|yes|on)$/i.test(out.EXTERNAL_SERVICES?.trim() ?? "")
  ) {
    out.NEARZERO_DATA_MODE = "external";
  }
  return out;
}

export type ControlConfigResult =
  | { ok: true; config: ControlConfig }
  | { ok: false; problems: string[] };

type Ctx = z.RefinementCtx;

function problem(ctx: Ctx, message: string): never {
  ctx.addIssue({ code: "custom", message });
  return z.NEVER;
}

/** A variable that may be missing; blank counts as missing. */
const optionalText = z
  .string()
  .optional()
  .transform((value) => {
    const trimmed = value?.trim();
    return trimmed === "" ? undefined : trimmed;
  });

function integerVariable(name: string, fallback: number, min: number, max: number) {
  return optionalText.transform((value, ctx) => {
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || parsed < min || parsed > max) {
      return problem(
        ctx,
        `${name} must be a whole number from ${min} to ${max}; it is "${value}".`,
      );
    }
    return parsed;
  });
}

function oneOf<const T extends readonly string[]>(name: string, allowed: T, fallback: T[number]) {
  return optionalText.transform((value, ctx): T[number] => {
    if (value === undefined) return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T[number];
    const list = allowed.map((item) => `"${item}"`).join(", ");
    return problem(ctx, `${name} must be one of ${list}; it is "${value}".`);
  });
}

const databaseUrl = optionalText.transform((value, ctx) => {
  const example = "postgres://user:password@127.0.0.1:5432/nearzero";
  if (value === undefined) {
    return problem(
      ctx,
      `DATABASE_URL is not set. Set it to the control plane's PostgreSQL address, like ${example}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return problem(
      ctx,
      `DATABASE_URL is not a valid address. Use the form ${example}, with special characters in the password percent-encoded.`,
    );
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    return problem(ctx, "DATABASE_URL must start with postgres:// or postgresql://.");
  }
  if (url.hostname === "" || url.pathname === "" || url.pathname === "/") {
    return problem(ctx, `DATABASE_URL must name a host and a database, like ${example}.`);
  }
  return value;
});

const authSecret = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  if (value.length < AUTH_SECRET_MIN_LENGTH) {
    return problem(
      ctx,
      `NEARZERO_AUTH_SECRET is too short (${value.length} characters). Use at least ${AUTH_SECRET_MIN_LENGTH} random characters, for example the output of: ${GENERATE_SECRET_HINT}`,
    );
  }
  if (new Set(value).size < AUTH_SECRET_MIN_DISTINCT) {
    return problem(
      ctx,
      `NEARZERO_AUTH_SECRET doesn't look randomly generated. Replace it with the output of: ${GENERATE_SECRET_HINT}`,
    );
  }
  return value;
});

const bindAddress = optionalText.transform((value, ctx) => {
  if (value === undefined) return CONTROL_DEFAULTS.bindAddress;
  if (/\s/.test(value)) {
    return problem(
      ctx,
      `NEARZERO_MANAGEMENT_BIND_ADDRESS must be one address, like 0.0.0.0 or 127.0.0.1; it is "${value}".`,
    );
  }
  return value;
});

const runMode = oneOf("NEARZERO_ENV", RUN_MODES, CONTROL_DEFAULTS.mode);

const consoleUrl = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return problem(
      ctx,
      "NEARZERO_CONSOLE_URL is not a valid address. Use the console's address, like https://nearzero.example.com.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return problem(ctx, "NEARZERO_CONSOLE_URL must start with https:// or http://.");
  }
  return url.origin;
});

const hostnameVariable = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
    return problem(
      ctx,
      `NEARZERO_MANAGEMENT_HOSTNAME must be a host name with a dot, like nearzero.example.com; it is "${value}".`,
    );
  }
  return value.toLowerCase();
});

const publicIp = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value) && !/^[0-9a-f:]+$/i.test(value)) {
    return problem(ctx, `NEARZERO_PUBLIC_IP must be an IP address; it is "${value}".`);
  }
  return value;
});

const addressList = optionalText.transform((value, ctx) => {
  if (value === undefined) return ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  for (const item of items) {
    if (!/^[0-9a-f.:]+(\/\d{1,3})?$/i.test(item)) {
      return problem(
        ctx,
        `NEARZERO_TRUSTED_PROXIES must list IP addresses or ranges separated by commas, like 127.0.0.1,10.0.0.0/8; "${item}" is not one.`,
      );
    }
  }
  return items;
});

const smtpUrl = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  const example = "smtp://user:password@smtp.example.com:587";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return problem(
      ctx,
      `NEARZERO_SMTP_URL is not a valid address. Use the form ${example}, with special characters percent-encoded.`,
    );
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") {
    return problem(ctx, `NEARZERO_SMTP_URL must start with smtp:// or smtps://, like ${example}.`);
  }
  if (url.hostname === "") {
    return problem(ctx, `NEARZERO_SMTP_URL must name the mail server, like ${example}.`);
  }
  const tls = url.protocol === "smtps:";
  return {
    host: url.hostname,
    port: url.port === "" ? (tls ? 465 : 587) : Number(url.port),
    security: tls ? ("tls" as const) : ("starttls" as const),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
});

const handoffDirectory = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  if (!value.startsWith("/") || /\s/.test(value)) {
    return problem(
      ctx,
      `NEARZERO_RUNNER_HANDOFF_DIR must be an absolute folder path without spaces; it is "${value}".`,
    );
  }
  return value;
});

const absoluteFolder = (name: string) =>
  optionalText.transform((value, ctx) => {
    if (value === undefined) return null;
    if (!value.startsWith("/") || /\s/.test(value)) {
      return problem(
        ctx,
        `${name} must be an absolute folder path without spaces; it is "${value}".`,
      );
    }
    return value;
  });

const gitPublicUrl = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return problem(
      ctx,
      "NEARZERO_GIT_PUBLIC_URL (0.1.x's PUBLIC_GIT_PROVIDER_BASE_URL) is not a valid address. Use the public HTTPS address Git providers reach Nearzero at, like https://nearzero.example.com.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return problem(ctx, "NEARZERO_GIT_PUBLIC_URL must start with https:// or http://.");
  }
  return url.origin;
});

const runnerControlUrl = optionalText.transform((value, ctx) => {
  if (value === undefined) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return problem(
      ctx,
      "NEARZERO_RUNNER_CONTROL_URL is not a valid address. Use the address servers reach Nearzero at, like https://nearzero.example.com.",
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return problem(ctx, "NEARZERO_RUNNER_CONTROL_URL must start with https:// or http://.");
  }
  return url.origin;
});

/** A domain name; a leading "*." is dropped, as the installer does. */
function domainVariable(name: string) {
  return optionalText.transform((value, ctx) => {
    if (value === undefined) return null;
    const domain = value.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      return problem(
        ctx,
        `${name} must be a domain name, like apps.example.com; it is "${value}".`,
      );
    }
    return domain;
  });
}

const resolverList = optionalText.transform((value, ctx) => {
  if (value === undefined) return [...DEFAULT_DNS_RESOLVERS];
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  for (const item of items) {
    if (!/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d{1,5})?$|^[0-9a-f:]+$/i.test(item)) {
      return problem(
        ctx,
        `NEARZERO_DNS_RESOLVERS must list resolver addresses separated by commas, like 1.1.1.1,8.8.8.8; "${item}" is not one.`,
      );
    }
  }
  return items.length > 0 ? items : [...DEFAULT_DNS_RESOLVERS];
});

/** true or false (also 1/0, yes/no); blank is false. */
function booleanVariable(name: string) {
  return optionalText.transform((value, ctx) => {
    if (value === undefined) return false;
    const lower = value.toLowerCase();
    if (["true", "1", "yes"].includes(lower)) return true;
    if (["false", "0", "no"].includes(lower)) return false;
    return problem(ctx, `${name} must be true or false; it is "${value}".`);
  });
}

/** Checks each variable on its own. Rules that span variables are in {@link parseControlConfig}. */
export const controlEnvSchema = z.object({
  NEARZERO_ENV: runMode,
  DATABASE_URL: databaseUrl,
  NEARZERO_AUTH_SECRET: authSecret,
  NEARZERO_CONTROL_PORT: integerVariable("NEARZERO_CONTROL_PORT", CONTROL_DEFAULTS.port, 1, 65535),
  NEARZERO_MANAGEMENT_BIND_ADDRESS: bindAddress,
  NEARZERO_LOG_LEVEL: oneOf("NEARZERO_LOG_LEVEL", LOG_LEVELS, CONTROL_DEFAULTS.logLevel),
  NEARZERO_JOB_CONCURRENCY: integerVariable(
    "NEARZERO_JOB_CONCURRENCY",
    CONTROL_DEFAULTS.jobConcurrency,
    1,
    64,
  ),
  NEARZERO_DEPLOY_CONCURRENCY: integerVariable(
    "NEARZERO_DEPLOY_CONCURRENCY",
    CONTROL_DEFAULTS.deployConcurrency,
    1,
    64,
  ),
  NEARZERO_BUILDS_PER_SERVER: integerVariable(
    "NEARZERO_BUILDS_PER_SERVER",
    CONTROL_DEFAULTS.buildsPerServer,
    1,
    16,
  ),
  NEARZERO_JOB_POLL_INTERVAL_MS: integerVariable(
    "NEARZERO_JOB_POLL_INTERVAL_MS",
    CONTROL_DEFAULTS.jobPollIntervalMs,
    50,
    60_000,
  ),
  NEARZERO_DATABASE_WAIT_SECONDS: integerVariable(
    "NEARZERO_DATABASE_WAIT_SECONDS",
    CONTROL_DEFAULTS.databaseWaitSeconds,
    0,
    3600,
  ),
  NEARZERO_CONSOLE_URL: consoleUrl,
  NEARZERO_MANAGEMENT_HOSTNAME: hostnameVariable,
  NEARZERO_PUBLIC_IP: publicIp,
  NEARZERO_CONSOLE_PORT: integerVariable("NEARZERO_CONSOLE_PORT", 4321, 1, 65535),
  /** The API's port on the host (compose.yml publishes it), which runners reach without a domain. */
  NEARZERO_API_PORT: integerVariable("NEARZERO_API_PORT", 3000, 1, 65535),
  NEARZERO_TRUSTED_PROXIES: addressList,
  NEARZERO_EMAIL_FROM: optionalText,
  NEARZERO_RESEND_API_KEY: optionalText,
  NEARZERO_SMTP_URL: smtpUrl,
  NEARZERO_RUNNER_HANDOFF_DIR: handoffDirectory,
  NEARZERO_RUNNER_CONTROL_URL: runnerControlUrl,
  NEARZERO_GIT_PUBLIC_URL: gitPublicUrl,
  /** Where the runner link's certificate and key are kept (compose.yml: a volume). */
  NEARZERO_RUNNER_TLS_DIR: absoluteFolder("NEARZERO_RUNNER_TLS_DIR"),
  /** The runner link's port on the host, which servers reach without a domain. */
  NEARZERO_RUNNER_LINK_PORT: integerVariable(
    "NEARZERO_RUNNER_LINK_PORT",
    RUNNER_LINK_DEFAULT_PORT,
    1,
    65535,
  ),
  NEARZERO_RUNNER_LINK_LISTEN_PORT: integerVariable(
    "NEARZERO_RUNNER_LINK_LISTEN_PORT",
    RUNNER_LINK_DEFAULT_PORT,
    1,
    65535,
  ),
  NEARZERO_RUNNER_LINK_BIND_ADDRESS: optionalText.transform((value, ctx) => {
    if (value === undefined) return "0.0.0.0";
    if (/\s/.test(value)) {
      return problem(
        ctx,
        `NEARZERO_RUNNER_LINK_BIND_ADDRESS must be one address, like 0.0.0.0; it is "${value}".`,
      );
    }
    return value;
  }),
  NEARZERO_PLATFORM_DOMAIN: domainVariable("NEARZERO_PLATFORM_DOMAIN"),
  NEARZERO_MANAGED_DNS_ZONE: domainVariable("NEARZERO_MANAGED_DNS_ZONE"),
  NEARZERO_MANAGED_DNS_SOA_EMAIL: optionalText,
  NEARZERO_ACME_EMAIL: optionalText,
  NEARZERO_ADMIN_EMAIL: optionalText,
  NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE: optionalText.transform((value) => value === "true"),
  NEARZERO_DNS_RESOLVERS: resolverList,
  NEARZERO_SSH_STRICT_HOST_KEY_CHECKING: booleanVariable("NEARZERO_SSH_STRICT_HOST_KEY_CHECKING"),
  NEARZERO_REGISTRATION_MODE: optionalText.transform((value, ctx) => {
    const mode = value?.toLowerCase();
    if (mode === undefined || mode === "bootstrap" || mode === "open") return "bootstrap" as const;
    // 0.1.x wrote the value with an underscore (30a R1-03); both mean the same.
    if (mode === "invite-only" || mode === "invite_only") return "invite-only" as const;
    return problem(
      ctx,
      `NEARZERO_REGISTRATION_MODE must be bootstrap or invite-only; it is "${value}".`,
    );
  }),
  NEARZERO_TRUSTED_ORIGINS: optionalText.transform((value, ctx) => {
    if (value === undefined) return [];
    const origins: string[] = [];
    for (const item of value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)) {
      let url: URL | null = null;
      try {
        url = new URL(item);
      } catch {
        url = null;
      }
      if (
        !url ||
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.origin === "null"
      ) {
        return problem(
          ctx,
          `NEARZERO_TRUSTED_ORIGINS must list addresses separated by commas, like https://nearzero.example.com; "${item}" is not one.`,
        );
      }
      origins.push(url.origin);
    }
    return origins;
  }),
  NEARZERO_METRICS_RETENTION_DAYS: optionalText.transform((value, ctx) => {
    if (value === undefined) return null;
    if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 365) {
      return problem(
        ctx,
        `NEARZERO_METRICS_RETENTION_DAYS must be a whole number from 1 to 365; it is "${value}".`,
      );
    }
    return Number(value);
  }),
  NEARZERO_METRICS_REFRESH_SECONDS: optionalText.transform((value, ctx) => {
    if (value === undefined) return null;
    if (!/^\d{1,4}$/.test(value) || Number(value) < 1 || Number(value) > 3600) {
      return problem(
        ctx,
        `NEARZERO_METRICS_REFRESH_SECONDS must be a whole number from 1 to 3600; it is "${value}".`,
      );
    }
    return Number(value);
  }),
  NEARZERO_RUNNER_BINARIES_DIR: optionalText.transform((value, ctx) => {
    if (value === undefined) return null;
    if (!value.startsWith("/") || /\s/.test(value)) {
      return problem(
        ctx,
        `NEARZERO_RUNNER_BINARIES_DIR must be an absolute folder path without spaces; it is "${value}".`,
      );
    }
    return value;
  }),
});

type ParsedEnv = z.output<typeof controlEnvSchema>;

/** The console's address: set outright, else from the management hostname, else the public IP. */
function deriveConsoleUrl(parsed: ParsedEnv): string | null {
  if (parsed.NEARZERO_CONSOLE_URL) return parsed.NEARZERO_CONSOLE_URL;
  if (parsed.NEARZERO_MANAGEMENT_HOSTNAME) return `https://${parsed.NEARZERO_MANAGEMENT_HOSTNAME}`;
  if (parsed.NEARZERO_PUBLIC_IP) {
    const host = parsed.NEARZERO_PUBLIC_IP.includes(":")
      ? `[${parsed.NEARZERO_PUBLIC_IP}]`
      : parsed.NEARZERO_PUBLIC_IP;
    return `http://${host}:${parsed.NEARZERO_CONSOLE_PORT}`;
  }
  return null;
}

/**
 * An address set outright for runners on other servers (spec 25 D1), when it is encrypted.
 * Remote runners never get a plain http:// address (spec 31 "Remote runners are always
 * encrypted", 31c G3-01, C2-07, C2-09): without one set here the control plane chooses at run
 * time (apps/control/src/runners/link.ts), the console's hostname once its certificate is valid,
 * else its own TLS port on the public IP with the certificate's fingerprint. The console's port
 * (4321) and the API's (3000) are never given: they are plain HTTP, and the console doesn't carry
 * the runner's WebSocket (B2-04).
 */
function deriveRunnerUrl(parsed: ParsedEnv): string | null {
  const url = parsed.NEARZERO_RUNNER_CONTROL_URL;
  if (!url?.startsWith("https:")) return null;
  // An IP address can't be checked against a public certificate (runners check none for IP
  // literals, C4-03), and this setting has no fingerprint: the control plane's own TLS port
  // covers that case.
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  return /^[0-9.]+$/.test(host) || host.includes(":") ? null : url;
}

/**
 * This server's own email settings. A half-made setup (a key without a sender, a sender without
 * a key, or both Resend and SMTP) leaves the server without email and says why, but never stops
 * the control plane from starting (30a R1-04): 0.1.x kept running too.
 */
function instanceEmail(parsed: ParsedEnv, problems: string[]): InstanceEmailConfig | null {
  const from = parsed.NEARZERO_EMAIL_FROM;
  const resend = parsed.NEARZERO_RESEND_API_KEY;
  const smtp = parsed.NEARZERO_SMTP_URL;
  if (!from && !resend && !smtp) return null;
  if (resend && smtp) {
    problems.push(
      "NEARZERO_RESEND_API_KEY and NEARZERO_SMTP_URL are both set. Keep the one this server should send email with.",
    );
    return null;
  }
  if (!from) {
    problems.push(
      "NEARZERO_EMAIL_FROM is not set, so this server's email settings can't be used. Set it to the sender, like Nearzero <team@example.com>.",
    );
    return null;
  }
  if (resend) return { provider: "resend", from, apiKey: resend };
  if (smtp) return { provider: "smtp", from, ...smtp };
  problems.push(
    "NEARZERO_EMAIL_FROM is set but neither NEARZERO_RESEND_API_KEY nor NEARZERO_SMTP_URL is, so this server can't send email. Set one of them, or remove NEARZERO_EMAIL_FROM.",
  );
  return null;
}

export const MISSING_PRODUCTION_SECRET =
  "NEARZERO_AUTH_SECRET is not set, and Nearzero never starts in production without a generated secret. " +
  `Run the install command again to create one, or generate one with "${GENERATE_SECRET_HINT}" and add it to /opt/nearzero/.env.`;

/** Reads and checks the control plane's configuration from an environment. */
export function parseControlConfig(given: Record<string, string | undefined>): ControlConfigResult {
  const env = withLegacySettingNames(given);
  const result = controlEnvSchema.safeParse(env);
  const problems = result.success ? [] : result.error.issues.map((issue) => issue.message);

  // Checked even when other variables have problems, so every problem is reported at once.
  // There is no built-in default secret (spec 23.2).
  const mode = runMode.safeParse(env.NEARZERO_ENV);
  const secret = optionalText.safeParse(env.NEARZERO_AUTH_SECRET);
  if (mode.success && mode.data === "production" && secret.success && secret.data === undefined) {
    problems.push(MISSING_PRODUCTION_SECRET);
  }

  if (!result.success) return { ok: false, problems };
  const parsed = result.data;
  const emailProblems: string[] = [];
  const email = instanceEmail(parsed, emailProblems);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      mode: parsed.NEARZERO_ENV,
      databaseUrl: parsed.DATABASE_URL,
      authSecret: parsed.NEARZERO_AUTH_SECRET,
      http: {
        hostname: parsed.NEARZERO_MANAGEMENT_BIND_ADDRESS,
        port: parsed.NEARZERO_CONTROL_PORT,
      },
      logLevel: parsed.NEARZERO_LOG_LEVEL,
      jobs: {
        concurrency: parsed.NEARZERO_JOB_CONCURRENCY,
        deployConcurrency: parsed.NEARZERO_DEPLOY_CONCURRENCY,
        buildsPerServer: parsed.NEARZERO_BUILDS_PER_SERVER,
        pollIntervalMs: parsed.NEARZERO_JOB_POLL_INTERVAL_MS,
      },
      databaseWaitSeconds: parsed.NEARZERO_DATABASE_WAIT_SECONDS,
      consoleUrl: deriveConsoleUrl(parsed),
      trustedProxies: parsed.NEARZERO_TRUSTED_PROXIES,
      instanceEmail: email,
      instanceEmailProblem: emailProblems[0] ?? null,
      publicIp: parsed.NEARZERO_PUBLIC_IP,
      gitPublicUrl: parsed.NEARZERO_GIT_PUBLIC_URL,
      runner: {
        handoffDirectory: parsed.NEARZERO_RUNNER_HANDOFF_DIR,
        controlUrl: deriveRunnerUrl(parsed),
        ignoredControlUrl:
          parsed.NEARZERO_RUNNER_CONTROL_URL && !deriveRunnerUrl(parsed)
            ? parsed.NEARZERO_RUNNER_CONTROL_URL
            : null,
        link: parsed.NEARZERO_RUNNER_TLS_DIR
          ? {
              tlsDirectory: parsed.NEARZERO_RUNNER_TLS_DIR,
              port: parsed.NEARZERO_RUNNER_LINK_PORT,
              listenPort: parsed.NEARZERO_RUNNER_LINK_LISTEN_PORT,
              bindAddress: parsed.NEARZERO_RUNNER_LINK_BIND_ADDRESS,
            }
          : null,
      },
      domains: {
        platformDomain: parsed.NEARZERO_PLATFORM_DOMAIN,
        managementHostname: parsed.NEARZERO_MANAGEMENT_HOSTNAME,
        managedZone: parsed.NEARZERO_MANAGED_DNS_ZONE,
        managedZoneEmail:
          parsed.NEARZERO_MANAGED_DNS_SOA_EMAIL ??
          parsed.NEARZERO_ADMIN_EMAIL ??
          parsed.NEARZERO_ACME_EMAIL ??
          null,
        acmeEmail: parsed.NEARZERO_ACME_EMAIL ?? null,
        sharedEdge: parsed.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE,
        resolvers: parsed.NEARZERO_DNS_RESOLVERS,
      },
      legacySettings: {
        registrationMode: parsed.NEARZERO_REGISTRATION_MODE,
        trustedOrigins: parsed.NEARZERO_TRUSTED_ORIGINS,
        metricsRetentionDays: parsed.NEARZERO_METRICS_RETENTION_DAYS,
        metricsRefreshSeconds: parsed.NEARZERO_METRICS_REFRESH_SECONDS,
      },
      ssh: {
        strictHostKeyChecking: parsed.NEARZERO_SSH_STRICT_HOST_KEY_CHECKING,
        runnerBinariesDirectory: parsed.NEARZERO_RUNNER_BINARIES_DIR,
      },
    },
  };
}
