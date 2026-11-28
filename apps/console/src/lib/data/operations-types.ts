import type { ServiceKind } from "./types.ts";

/**
 * Shapes of the operations area: deployments and their logs (docs/api/deploys.md), runtime,
 * hostnames, DNS zones and certificates (docs/api/domains.md), servers, SSH keys and the host
 * (docs/api/servers.md), and About Nearzero's address. They mirror the API's answers; dates stay
 * ISO strings because most of them travel on to the browser.
 */

// ---------- Deployments (spec 11)

export type DeploymentStatus =
  | "queued"
  | "building"
  | "active"
  | "previous"
  | "not_running"
  | "failed"
  | "cancelled"
  | "removed";

export type DeployTrigger = "push" | "tag" | "webhook" | "manual" | "agent" | "redeploy" | "reload";

export interface DeploymentView {
  id: string;
  status: DeploymentStatus;
  statusLabel: string;
  trigger: DeployTrigger;
  title: string;
  commit: string | null;
  shortCommit: string | null;
  service: {
    id: string | null;
    name: string;
    kind: ServiceKind;
    kindLabel: string;
    type: "application" | "compose" | "database";
  };
  project: { id: string | null; name: string };
  environment: { id: string | null; name: string };
  server: { id: string; name: string };
  source: {
    type?: "git" | "image" | "upload";
    provider?: string | null;
    repository?: string | null;
    branch?: string | null;
    path?: string | null;
  };
  builder: string | null;
  framework: string | null;
  image: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  running: boolean;
  log: { lines: number; bytes: number; truncated: boolean };
  can: { cancel: boolean; redeploy: boolean };
}

export interface DeploymentDetail extends DeploymentView {
  urls: string[];
  servingNewer: string | null;
  newerDeploymentId: string | null;
}

export interface DeploymentLog {
  text: string;
  totalLines: number;
  shownFrom: number;
  complete: boolean;
  truncated: boolean;
  failure: { line: number; text: string; message: string } | null;
  lastEventId: string | null;
}

export interface DeploymentPage {
  deployments: DeploymentView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeploymentQuery {
  search?: string;
  status?: string;
  type?: string;
  page?: number;
  pageSize?: number;
}

/** What GET /services/:id(/…) says about a service's deploys (deploys.md, Shapes). */
export interface ServiceDeploySummary {
  last: {
    id: string;
    status: DeploymentStatus;
    statusLabel: string;
    succeeded: boolean;
    title: string;
    commit: string | null;
    shortCommit: string | null;
    finishedAt: string | null;
  } | null;
  inProgress: { id: string; status: "queued" | "building" } | null;
}

export interface RecentDeployments {
  deployments: DeploymentView[];
  failedSince: number;
}

export interface ServiceContainer {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  deploymentId: string | null;
  current: boolean;
  createdAt: string | number | null;
}

export interface ServiceRuntime {
  status: string;
  containers: ServiceContainer[];
}

export interface WebhookView {
  visible: boolean;
  url: string | null;
  message: string | null;
  warnings: string[];
  createdAt: string | null;
  lastCalledAt: string | null;
}

export interface DatabaseConnection {
  running: boolean;
  notice: string | null;
  user: string | null;
  database: string | null;
  password: string | null;
  internal: { host: string; port: number; url: string; label: string };
  public: {
    enabled: boolean;
    port: number | null;
    host: string | null;
    url: string | null;
    label: string;
    hint: string;
  };
  server: string;
}

// ---------- Hostnames (spec 10)

export type HttpsState =
  | "valid"
  | "expires_soon"
  | "expired"
  | "uploaded"
  | "not_trusted"
  | "not_in_use"
  | "waiting_for_dns"
  | "queued"
  | "issuing"
  | "rate_limited"
  | "paused"
  | "failed"
  | "unknown";

export type DnsStatus =
  | "points_here"
  | "points_elsewhere"
  | "proxied"
  | "ipv6_only"
  | "no_record"
  | "lookup_failed"
  | "waiting"
  | "check_records"
  | "unknown";

export interface DnsRecordHint {
  type: "A";
  name: string;
  value: string | null;
  ttl: string;
  proxy: string;
}

export interface HostnameEntry {
  id: string;
  hostname: string;
  url: string;
  source: "platform" | "server" | "zone" | "own";
  sourceLabel: string;
  zone: { id: string; name: string } | null;
  automatic: boolean;
  service: {
    id: string;
    name: string;
    kind: ServiceKind;
    projectId: string;
    projectName: string;
    environmentId: string;
    environmentName: string;
    composeService: string | null;
    port: number | null;
    path: string;
  } | null;
  target: { id: string; name: string; host: boolean; address: string | null };
  dns: {
    status: DnsStatus;
    label: string;
    note: string;
    addresses: string[];
    /** The proxy in front ("Cloudflare"), when the A records are a known proxy's. */
    proxiedBy: string | null;
    /** Points here, but other A records or an AAAA record could send Let's Encrypt elsewhere. */
    warnings?: string[];
    /** The name it is an alias of (a CNAME). */
    aliasOf?: string | null;
    checkedAt: string | null;
    managed: boolean;
    record: DnsRecordHint | null;
  };
  https: {
    state: HttpsState;
    label: string;
    note: string;
    until: number | null;
    lastError: string | null;
    retryRefusal: string | null;
    certificate: { notAfter: string | number; issuer: string } | null;
  };
  needsAttention: boolean;
  waiting: boolean;
  can: { manage: boolean; move: boolean; retry: boolean };
  createdAt: string;
}

export interface ServiceHostnames {
  hostnames: HostnameEntry[];
  composeServices: { name: string; port: number | null }[];
  servicePort: number | null;
  canAdd: boolean;
}

export interface HostnameSuggestion {
  available: boolean;
  hostname?: string;
  base?: "platform" | "zone";
  message: string;
  record?: {
    type: string;
    name: string;
    value: string | null;
    proxy: string;
    status: string;
    message: string;
  };
  composeServices?: { name: string; port: number | null }[];
  servicePort?: number | null;
  openDomains?: boolean;
}

export interface DomainsTab {
  id: "hostnames" | "dns-zones" | "environment-defaults" | "uploaded-certificates";
  label: string;
  count: number;
  shown: boolean;
}

export interface DomainsOverview {
  title: string;
  description: string;
  platformDomain: string | null;
  noDomain: boolean;
  noDomainCard: unknown;
  startFrom: string[];
  tabs: DomainsTab[];
  more: { id: string; label: string; hint: string }[];
  can: { connectZone: boolean; uploadCertificate: boolean };
}

export interface WithoutDomainService {
  id: string;
  name: string;
  kind: ServiceKind;
  projectName: string;
  environmentName: string;
  serverId: string;
  canAdd: boolean;
}

export interface HostnameList {
  hostnames: HostnameEntry[];
  checkedAt: string | null;
  unreadableServers: number;
  unreadableMessage: string | null;
  withoutDomain: { count: number; message: string | null; services: WithoutDomainService[] };
}

export interface AutomaticRow {
  target: { id: string; name: string; host?: boolean };
  record: { type: string; name: string; value: string | null };
  badge: "points_here" | "points_elsewhere" | "not_set_up" | "couldnt_check";
  badgeLabel: string;
  without: number;
  subtitle: string;
  action: "check_again" | "give_one" | "give_n";
  actionLabel: string;
  help: string | null;
  message: string | null;
  checkedAt: string | null;
}

export interface AutomaticCard {
  domain: string;
  description: string;
  rows: AutomaticRow[];
  aboutHttps: string | string[];
}

export interface DnsZone {
  id: string;
  name: string;
  adminEmail: string;
  nameservers: string[];
  status: "live" | "delegation_pending" | "not_applied" | "needs_attention";
  statusLabel: string;
  records: number;
  health: string;
  error: string | null;
  appliedAt: string | null;
  /** What to do at the registrar, with glue records for in-zone nameservers (G3-10). */
  delegation: string;
  /** Published but not ready: why, and what ready needs (G3-10). */
  readiness?: { ready: boolean; reasons: string[]; note: string };
}

export interface ZoneList {
  zones: DnsZone[];
  banner: string | null;
  canApplyAll: boolean;
}

export interface ZoneRecord {
  id: string;
  name: string;
  type: string;
  value: string;
  ttl: number;
  priority: number | null;
  managed: boolean;
  managedNote: string | null;
  hostnameId: string | null;
}

export interface EnvironmentDefault {
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  source: string;
  sourceLabel: string;
  prefix: string;
  saved: boolean;
}

export interface EnvironmentDefaults {
  defaults: EnvironmentDefault[];
  options: { value: string; label: string }[];
  prefixHint: string;
}

export interface UploadedCertificate {
  id: string;
  name: string;
  covers: string[];
  server: { id: string; name: string };
  issuer: string;
  expiresAt: string;
  expired: boolean;
  expiresNote: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- Servers and SSH keys (spec 9)

export type Readiness = "ready" | "setup_needed" | "setup_running" | "setup_failed" | "inactive";

export interface RunnerView {
  state: "online" | "offline" | "never_connected" | "update_needed";
  version: string | null;
  protocol?: number | null;
  connectedAt?: string | null;
  lastSeenAt?: string | null;
  message: string | null;
  updateNeeded: boolean;
  /** HTTP/3 on the router (R3-22); null when the runner isn't connected or doesn't say. */
  http3?: { enabled: boolean; message: string | null } | null;
}

export interface ServerRecord {
  id: string;
  name: string;
  description: string;
  address: string;
  port: number;
  sshUser: string;
  sshKey: { id: string; name: string } | null;
  label: string;
  hostKeyFingerprint: string | null;
  /** The public IPv4 a person set, or null to use its address. */
  publicIPv4: string | null;
  setup: {
    state: "not_started" | "running" | "ready" | "failed";
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  readiness: Readiness;
  dockerCleanup: boolean;
  runner: RunnerView;
  services: number;
  createdAt: string;
  updatedAt: string;
}

export interface SshKeyRecord {
  id: string;
  name: string;
  description: string;
  type: "rsa" | "ed25519";
  publicKey: string;
  fingerprint: string;
  createdAt: string;
  updatedAt: string;
  usedBy: { id: string; name: string }[];
  /** Servers using it that the person can't see (C1-13); older control planes don't send it. */
  hiddenServers?: number;
  /** Apps and Compose services that clone over SSH with it (spec 9.7), among those visible. */
  gitUsers: {
    id: string;
    name: string;
    kind: "application" | "compose";
    project: string;
    environment: string;
  }[];
  hiddenGitUsers: number;
}

export interface HostView {
  id: "host";
  name: string;
  available: boolean;
  canManage: boolean;
  runner: RunnerView;
}

export interface AllowedWorkspace {
  workspaceId: string;
  name: string;
  slug: string;
  /** Its owner's name and email (or email), so same-named workspaces can be told apart. */
  owner: string | null;
  first: boolean;
  allowed: boolean;
  allowedAt: string | null;
}

/** A server's (or the host's) daily Docker cleanup (spec 9.4; docs/api/server-setup.md). */
export interface DockerCleanup {
  enabled: boolean;
  defaultEnabled: boolean;
  description: string;
  timeZone: string | null;
  nextRunAt: string | null;
  last: {
    at: string;
    freedBytes: number | null;
    freedText: string | null;
    error: string | null;
  } | null;
}

// ---------- About Nearzero (spec 18.2, 10.9)

export interface AboutAddress {
  consoleUrl: string | null;
  serverIp: {
    address: string | null;
    corrected: boolean;
    detected: string | null;
    canCorrect: boolean;
  };
  platformDomain: string | null;
  checklist: {
    consoleAddress: {
      state: "ready" | "dns" | "https_pending" | "needs_setup";
      label: string;
      message: string;
      link: string | null;
    };
    managedZone: {
      name: string;
      state: "live" | "delegation_pending" | "not_applied" | "needs_attention";
      label: string;
      message: string;
      link: string;
    } | null;
  };
  publicDomain: {
    hostname: string | null;
    email: string | null;
    canConfigure: boolean;
    record: { type: string; name: string; value: string | null } | null;
    note: string;
    changeNote: string | null;
  };
}

/** Settings → Router files (spec 18.3): a router folder's files and what may be edited. */
export interface RouterFileList {
  canEdit: boolean;
  files: { name: string; contents: string; managed: boolean; editable: boolean }[];
  /** The router's main settings, read-only (R3-23); null from an older runner. */
  mainSettings?: {
    name: string;
    title: string;
    contents: string;
    note: string;
    managed: boolean;
    editable: false;
  } | null;
}

// ---------- The data module's operations half

export interface OperationsData {
  deployments(query: DeploymentQuery): Promise<DeploymentPage>;
  deployment(id: string): Promise<DeploymentDetail | null>;
  deploymentLog(id: string): Promise<DeploymentLog | null>;
  serviceDeployments(serviceId: string): Promise<DeploymentView[]>;
  /** The bell: the newest 8 and whether any failed recently; null when the API refused. */
  recent(): Promise<RecentDeployments | null>;
  serviceHostnames(serviceId: string): Promise<ServiceHostnames | null>;
  hostnameSuggestion(serviceId: string): Promise<HostnameSuggestion | null>;
  connection(serviceId: string): Promise<DatabaseConnection | null>;
  webhook(serviceId: string): Promise<WebhookView | null>;
  /** Volumes of other apps in the environment and server this app may mount (31b G2-08). */
  shareableVolumes(serviceId: string): Promise<ShareableVolume[]>;
  domains(): Promise<DomainsOverview | { refused: string }>;
  hostnames(query: { q?: string; show?: string }): Promise<HostnameList>;
  automaticCard(): Promise<AutomaticCard | null>;
  zones(): Promise<ZoneList>;
  environmentDefaults(): Promise<EnvironmentDefaults>;
  certificates(): Promise<UploadedCertificate[]>;
  servers(query: { q?: string; status?: string }): Promise<ServerRecord[]>;
  sshKeys(): Promise<SshKeyRecord[] | null>;
  host(): Promise<HostView | null>;
  allowedWorkspaces(): Promise<AllowedWorkspace[] | null>;
  dockerCleanup(serverId: string): Promise<DockerCleanup | null>;
  /** Throws the API's refusal (an offline runner, no access) for the page to show. */
  routerFiles(targetId: string): Promise<RouterFileList>;
  about(): Promise<AboutAddress>;
  health(): Promise<{ version: string } | null>;
}

/** A volume of another app this one may mount too (31b G2-08). */
export interface ShareableVolume {
  serviceId: string;
  serviceName: string;
  name: string;
  containerPath: string;
}
