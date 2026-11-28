import type { InstanceEmailConfig, RunnerLinkAddress } from "@nearzero/shared";
import { ObjectRegistry } from "./access/objects.ts";
import type { Db } from "./db/database.ts";
import { HostnameProviders } from "./deploys/hostnames.ts";
import { registerDomainHostnames } from "./domains/hostname-provider.ts";
import { type DomainSettings, domainSettings } from "./domains/settings.ts";
import { nodemailerConnector, type SmtpConnector } from "./email/smtp.ts";
import { registerGitAccountObjects } from "./git-providers/records.ts";
import type { Logger } from "./log.ts";
import { projectsBlockWorkspaceDeletion, registerProjectObjects } from "./projects/objects.ts";
import type { RunnerHub } from "./runners/hub.ts";
import {
  generatedConsoleUrl,
  preferredRunnerLink,
  type RunnerLinkSettings,
} from "./runners/link.ts";
import { createRunnerHub } from "./runners/wiring.ts";
import { type ResolveHost, systemResolve } from "./security/outbound.ts";
import { PasswordHasher, type PasswordHashingOptions } from "./security/passwords.ts";
import { SecretBox } from "./security/secret-box.ts";
import { randomToken } from "./security/tokens.ts";
import { registerServerObjects, serversBlockWorkspaceDeletion } from "./servers/servers.ts";

/**
 * Everything the control plane's areas share for one process: the database, the logger, the
 * install's keys, outbound connections (made injectable so tests never reach the network) and the
 * registries later milestones plug into.
 */

/** The outbound HTTP call used for Resend, Firecrawl and other providers. */
export type HttpFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Something that must be empty before a workspace can be deleted (projects arrive in M3). Returns
 * a refusal message, or null when nothing blocks the delete.
 */
export type WorkspaceDeletionCheck = (db: Db, workspaceId: string) => Promise<string | null>;

export interface ControlServices {
  db: Db;
  log: Logger;
  secrets: SecretBox;
  passwords: PasswordHasher;
  /** The console's public address, or null when the server has none (spec 04 4.5). */
  consoleUrl(): string | null;
  trustedProxies: readonly string[];
  /** Extra addresses people open the console at (NEARZERO_TRUSTED_ORIGINS), as origins. */
  trustedOrigins: readonly string[];
  instanceEmail: InstanceEmailConfig | null;
  /** Why this server's own email settings can't be used (half set up), or null (30a R1-04). */
  instanceEmailProblem: string | null;
  http: HttpFetch;
  smtp: SmtpConnector;
  /** How names people type (a workspace's SMTP server) are looked up before they're checked. */
  resolveHost: ResolveHost;
  objects: ObjectRegistry;
  workspaceDeletionChecks: WorkspaceDeletionCheck[];
  /** The clock for two-factor codes. */
  now(): number;
  /** Every runner's connection (spec 25 D1). */
  runners: RunnerHub;
  /**
   * Where remote runners reach the control plane, and the certificate fingerprint they pin when
   * there is no domain (runners/link.ts); null when there is no encrypted address yet.
   */
  runnerLink(): Promise<RunnerLinkAddress | null>;
  /** How runner addresses are chosen (runners/link.ts). */
  runnerLinkSettings: RunnerLinkSettings;
  /**
   * Reads the console's address again (G4-21): a hostname saved under About Nearzero is used in
   * generated links once its certificate is valid. main.ts calls it at start and every minute.
   */
  refreshConsoleUrl(): Promise<string | null>;
  /**
   * The address Git providers call back and send webhooks to: NEARZERO_GIT_PUBLIC_URL (0.1.x's
   * PUBLIC_GIT_PROVIDER_BASE_URL) when set, else the console's (31d G4-19).
   */
  gitPublicUrl(): string | null;
  /** Where deploys get their hostnames; other areas register providers at startup (spec 6.5). */
  hostnameProviders: HostnameProviders;
  /** The install's domain settings and DNS lookups (spec 10). */
  domains: DomainSettings;
  /** How many deploys one server runs at once (R2-15: one, unless an administrator raises it). */
  buildsPerServer: number;
}

export interface ServiceOptions {
  db: Db;
  log: Logger;
  /** The install's authentication secret; a temporary one is made when missing (tests, dev). */
  authSecret?: string;
  consoleUrl?: string | null;
  trustedProxies?: readonly string[];
  trustedOrigins?: readonly string[];
  instanceEmail?: InstanceEmailConfig | null;
  instanceEmailProblem?: string | null;
  http?: HttpFetch;
  smtp?: SmtpConnector;
  resolveHost?: ResolveHost;
  passwordHashing?: PasswordHashingOptions;
  objects?: ObjectRegistry;
  workspaceDeletionChecks?: WorkspaceDeletionCheck[];
  now?: () => number;
  /**
   * An address remote runners use, set outright: the install's https:// one, or (tests only) a
   * plain one. Left out, the control plane chooses (runners/link.ts).
   */
  runnerControlUrl?: string | null;
  /** The pinned fingerprint of the certificate at `runnerControlUrl` (tests). */
  runnerControlFingerprint?: string | null;
  /** The runner link's own TLS port and the fingerprint of its certificate (main.ts). */
  runnerLinkPort?: { port: number; fingerprint: string } | null;
  /** The host's public address from the install (IPv4 or IPv6). */
  publicIp?: string | null;
  /** NEARZERO_GIT_PUBLIC_URL, when Git providers reach Nearzero elsewhere than the console. */
  gitPublicUrl?: string | null;
  /** The host's public IPv4, against which DNS is checked before certificates (spec 10.7). */
  hostPublicIPv4?: string | null;
  /** Domain settings; tests pass fake DNS lookups here. */
  domains?: Parameters<typeof domainSettings>[0];
  /** NEARZERO_BUILDS_PER_SERVER; 1 when left out. */
  buildsPerServer?: number;
}

export const LOOPBACK_PROXIES = ["127.0.0.1", "::1", "::ffff:127.0.0.1"] as const;

export function createServices(options: ServiceOptions): ControlServices {
  const consoleUrl = options.consoleUrl ?? null;
  let currentConsoleUrl = consoleUrl;
  const runnerLinkSettings: RunnerLinkSettings = {
    outright: options.runnerControlUrl
      ? {
          url: new URL(options.runnerControlUrl).origin,
          fingerprint: options.runnerControlFingerprint ?? null,
        }
      : null,
    pinned: options.runnerLinkPort ?? null,
    publicIp: options.publicIp ?? null,
  };
  let services: ControlServices | null = null;
  const runners = createRunnerHub(options.db, options.log, () => services as ControlServices);
  runners.hostPublicIPv4 = options.hostPublicIPv4 ?? null;
  services = {
    db: options.db,
    log: options.log,
    secrets: new SecretBox(options.authSecret ?? randomToken(32)),
    passwords: new PasswordHasher(options.passwordHashing),
    consoleUrl: () => currentConsoleUrl,
    gitPublicUrl: () => options.gitPublicUrl ?? currentConsoleUrl,
    refreshConsoleUrl: async () => {
      currentConsoleUrl = await generatedConsoleUrl(services as ControlServices, consoleUrl);
      return currentConsoleUrl;
    },
    trustedProxies: options.trustedProxies ?? LOOPBACK_PROXIES,
    trustedOrigins: options.trustedOrigins ?? [],
    instanceEmail: options.instanceEmail ?? null,
    instanceEmailProblem: options.instanceEmailProblem ?? null,
    http: options.http ?? ((input, init) => fetch(input, init)),
    smtp: options.smtp ?? nodemailerConnector,
    resolveHost: options.resolveHost ?? systemResolve,
    objects: options.objects ?? defaultObjects(),
    workspaceDeletionChecks: options.workspaceDeletionChecks ?? [
      projectsBlockWorkspaceDeletion,
      serversBlockWorkspaceDeletion,
    ],
    now: options.now ?? (() => Date.now()),
    runners,
    runnerLink: () => preferredRunnerLink(services as ControlServices, runnerLinkSettings),
    runnerLinkSettings,
    hostnameProviders: new HostnameProviders(),
    domains: domainSettings(options.domains),
    buildsPerServer: options.buildsPerServer ?? 1,
  };
  // Deploys ask the domains area for every service's hostnames (spec 10.2).
  registerDomainHostnames(services);
  return services;
}

/** The object kinds that exist so far: projects, environments, services, servers, Git accounts. */
function defaultObjects(): ObjectRegistry {
  const registry = new ObjectRegistry();
  registerProjectObjects(registry);
  registerServerObjects(registry);
  registerGitAccountObjects(registry);
  return registry;
}
