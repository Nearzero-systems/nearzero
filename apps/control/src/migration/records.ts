import { z } from "zod";

/**
 * The record kinds of an export bundle, field by field as spec 29a.5 fixes them (format 1). Every
 * record has a `ref`; references between records are refs. Fields the importer doesn't know are
 * ignored and missing ones take 1.0's defaults (29.3), so the schemas are lenient: a record is
 * refused only when 1.0 can't use it, and the importer says why in its report. Labels (29a.6) are
 * read by migration/labels.ts.
 *
 * The optional in-place fields of 29a.9 (`legacy` on services and servers, `servicePort`,
 * `controlPlane`, `controlPlaneVolumes`, `legacyWebhookPaths`) are read by legacy-fields.ts;
 * without `legacy` a service's workload is derived from its internal app name. The old console
 * address of 29a.9.1 (`legacyConsolePath`) is read by console-paths.ts.
 */

const ref = z.string().min(1).max(200);
const maybeRef = ref.nullish();
const maybeText = (max: number) => z.string().max(max).nullish();
const time = z.string().max(64).nullish();
const yesNo = z.boolean().nullish();
const object = z.record(z.string(), z.unknown());
/** 29a.9.1: where 0.1.x showed the object (a path without host). */
const legacyConsolePath = z.string().max(2000).nullish().catch(null);
const refs = z
  .array(ref)
  .nullish()
  .transform((value) => value ?? []);

/** Where something runs: a server or the Nearzero host (29a.5.1). */
export const placeSchema = z.object({ serverRef: maybeRef, host: yesNo }).nullish();
export type BundlePlace = z.infer<typeof placeSchema>;

export const scopeSchema = z
  .object({
    allProjects: yesNo,
    projectRefs: refs,
    environmentRefs: refs,
    serviceRefs: refs,
    allServers: yesNo,
    serverRefs: refs,
    allGitProviders: yesNo,
    gitProviderRefs: refs,
  })
  .nullish();
export type BundleScope = z.infer<typeof scopeSchema>;

export const passwordSchema = z.object({
  algorithm: z.string().max(40),
  encoded: z.string().max(1024),
  params: object.nullish(),
});

export const twoFactorSchema = z.object({
  enabled: yesNo,
  unreadable: yesNo,
  secret: maybeText(256),
  secretBase32: maybeText(512),
  totp: object.nullish(),
  backupCodes: z
    .object({
      algorithm: maybeText(20),
      encoding: maybeText(20),
      hashes: z.array(z.string().max(256)).nullish(),
    })
    .nullish(),
});

/** How a 0.1.x workload is found on its server (an optional field beyond 29a). */
export const legacyWorkloadSchema = z.object({
  kind: z.enum(["swarm-service", "swarm-stack", "container", "compose-project"]),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/),
  /** For `compose-project` (29a.9): its folder, Compose files and env file, read by legacyOf. */
  folder: z.unknown().optional(),
  composeFiles: z.unknown().optional(),
  envFile: z.unknown().optional(),
});
export type LegacyWorkload = z.infer<typeof legacyWorkloadSchema>;

export const personSchema = z.object({
  ref,
  email: z.string().min(1).max(320),
  emailVerified: yesNo,
  firstName: maybeText(200),
  lastName: maybeText(200),
  password: passwordSchema.nullish(),
  twoFactor: twoFactorSchema.nullish(),
  avatar: maybeText(4096),
  otherSignIns: z.array(z.string().max(60)).nullish(),
  banned: yesNo,
  createdAt: time,
});

export const workspaceSchema = z.object({
  ref,
  name: z.string().min(1).max(200),
  slug: maybeText(100),
  oldSlugs: z.array(z.string().max(100)).nullish(),
  logo: maybeText(4096),
  ownerRef: maybeRef,
  personal: yesNo,
  firstWorkspace: yesNo,
  hostsAllowed: yesNo,
  agentPolicies: z.record(z.string(), z.unknown()).nullish(),
  modelKey: maybeText(1024),
  researchKey: maybeText(1024),
  invitationEmail: z.object({ resendKey: maybeText(1024), sender: maybeText(320) }).nullish(),
  createdAt: time,
});

export const membershipSchema = z.object({
  ref,
  personRef: ref,
  workspaceRef: ref,
  role: z.string().max(40),
  capabilities: z.array(z.string().max(120)).nullish(),
  scope: scopeSchema,
  policyRefs: refs,
  defaultWorkspace: yesNo,
  createdAt: time,
});

export const policySchema = z.object({
  ref,
  workspaceRef: ref,
  name: z.string().min(1).max(200),
  description: maybeText(4000),
  capabilities: z.array(z.string().max(120)).nullish(),
  scope: scopeSchema,
});

export const invitationSchema = z.object({
  ref,
  workspaceRef: ref,
  email: z.string().min(1).max(320),
  role: z.string().max(40),
  policyRefs: refs,
  invitedByRef: maybeRef,
  expiresAt: time,
});

export const serverSchema = z.object({
  ref,
  workspaceRef: ref,
  name: z.string().min(1).max(200),
  description: maybeText(4000),
  address: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).nullish(),
  sshUser: maybeText(64),
  sshKeyRef: maybeRef,
  hostKeyFingerprint: maybeText(200),
  hostnameLabel: maybeText(63),
  dailyCleanup: yesNo,
  alertThresholds: z
    .object({ cpuPercent: z.number().nullish(), memoryPercent: z.number().nullish() })
    .nullish(),
  createdAt: time,
  /** 29a.9: the 0.1.x router on it, stopped before setup (read by legacy-fields.ts). */
  legacy: z.unknown().nullish(),
  legacyConsolePath,
});

export const sshKeySchema = z.object({
  ref,
  workspaceRef: ref,
  name: z.string().min(1).max(200),
  description: maybeText(4000),
  publicKey: z.string().min(1).max(8192),
  privateKey: z.string().min(1).max(65536),
  createdAt: time,
  lastUsedAt: time,
});

export const gitProviderSchema = z.object({
  ref,
  workspaceRef: ref,
  ownerRef: maybeRef,
  shared: yesNo,
  kind: z.string().max(40),
  name: z.string().min(1).max(200),
  connection: maybeText(40),
  urls: z
    .object({ web: maybeText(500), internal: maybeText(500), redirect: maybeText(500) })
    .nullish(),
  app: z
    .object({
      appId: z.union([z.number(), z.string()]).nullish(),
      appName: maybeText(200),
      clientId: maybeText(200),
      clientSecret: maybeText(1024),
      privateKey: maybeText(16384),
      webhookSecret: maybeText(1024),
    })
    .nullish(),
  oauth: z
    .object({
      clientId: maybeText(500),
      clientSecret: maybeText(1024),
      scopes: z.unknown().nullish(),
    })
    .nullish(),
  installationIds: z.array(z.union([z.string(), z.number()])).nullish(),
  tokens: z
    .object({
      accessToken: maybeText(4096),
      refreshToken: maybeText(4096),
      expiresAt: time,
      appPassword: maybeText(1024),
      apiToken: maybeText(4096),
    })
    .nullish(),
  account: z
    .object({
      group: maybeText(200),
      username: maybeText(200),
      email: maybeText(320),
      workspace: maybeText(200),
    })
    .nullish(),
  createdAt: time,
});

export const projectSchema = z.object({
  ref,
  workspaceRef: ref,
  name: z.string().min(1).max(200),
  description: maybeText(4000),
  createdAt: time,
  legacyConsolePath,
});

export const environmentSchema = z.object({
  ref,
  projectRef: ref,
  name: z.string().min(1).max(100),
  description: maybeText(4000),
  default: yesNo,
  sharedVariables: maybeText(1_000_000),
  hostnameDefaults: z
    .object({ source: maybeText(40), zoneRef: maybeRef, prefix: maybeText(100) })
    .nullish(),
  createdAt: time,
  legacyConsolePath,
});

export const serviceSchema = z.object({
  ref,
  environmentRef: ref,
  copyGroupRef: maybeRef,
  kind: z.string().max(40),
  name: z.string().min(1).max(200),
  appName: maybeText(100),
  description: maybeText(4000),
  place: placeSchema,
  variables: maybeText(1_000_000),
  settings: object.nullish(),
  volumes: z.array(z.string().max(255)).nullish(),
  createdAt: time,
  /** 29a.9: what runs the service today; otherwise derived from appName. */
  legacy: legacyWorkloadSchema.nullish().catch(null),
  /** 29a.9 (applications): the container port the app listens on. */
  servicePort: z.number().int().min(1).max(65535).nullish().catch(null),
  legacyConsolePath,
});

export const hostnameSchema = z.object({
  ref,
  serviceRef: maybeRef,
  innerService: maybeText(63),
  place: placeSchema,
  host: z.string().min(1).max(253),
  port: z.number().int().nullish(),
  path: maybeText(1024),
  internalPath: maybeText(1024),
  stripPath: yesNo,
  https: yesNo,
  certificate: maybeText(40),
  source: maybeText(40),
  zoneRef: maybeRef,
  serverRef: maybeRef,
  generated: yesNo,
  createdAt: time,
});

export const zoneSchema = z.object({
  ref,
  workspaceRef: ref,
  domain: z.string().min(1).max(253),
  adminEmail: z.string().min(1).max(254),
  nameservers: z.array(z.string().max(253)).nullish(),
  ttl: z.number().int().nullish(),
  records: z
    .array(
      z.object({
        name: z.string().min(1).max(253),
        type: z.string().max(10),
        value: z.string().min(1).max(4000),
        ttl: z.number().int().nullish(),
        priority: z.number().int().nullish(),
      }),
    )
    .nullish(),
  createdAt: time,
});

export const certificateSchema = z.object({
  ref,
  workspaceRef: ref,
  name: z.string().min(1).max(200),
  place: placeSchema,
  certificatePem: z.string().min(1).max(65_536),
  privateKeyPem: z.string().min(1).max(65_536),
  autoRenew: yesNo,
});

export const destinationSchema = z.object({
  ref,
  workspaceRef: ref,
  name: z.string().min(1).max(200),
  provider: maybeText(100),
  endpoint: z.string().min(1).max(500),
  bucket: z.string().min(1).max(255),
  region: maybeText(64),
  accessKey: z.string().min(1).max(1024),
  secretKey: z.string().min(1).max(1024),
  extraFlags: z.array(z.string().max(500)).nullish(),
  createdAt: time,
});

export const backupScheduleSchema = z.object({
  ref,
  serviceRef: ref,
  destinationRef: ref,
  kind: z.string().max(40),
  name: maybeText(200),
  database: maybeText(64),
  composeDatabase: object.nullish(),
  volume: maybeText(255),
  innerService: maybeText(63),
  /** Empty: 0.1.x wrote straight under the app name. */
  folder: z.string().max(200),
  cron: z.string().min(1).max(200),
  timeZone: maybeText(64),
  keep: z.number().int().nullish(),
  enabled: yesNo,
  stopWhileCopying: yesNo,
  createdAt: time,
});

export const taskSchema = z.object({
  ref,
  workspaceRef: maybeRef,
  place: z
    .object({ serviceRef: maybeRef, innerService: maybeText(63), serverRef: maybeRef, host: yesNo })
    .nullish(),
  name: z.string().min(1).max(200),
  description: maybeText(2000),
  cron: z.string().min(1).max(200),
  timeZone: maybeText(64),
  shell: maybeText(10),
  script: z.string().min(1).max(65_536),
  enabled: yesNo,
  /** Who a host task belongs to in 0.1.x (spec 30, R3-29), when the export says. */
  ownerRef: maybeRef,
  createdAt: time,
});

export const channelSchema = z.object({
  ref,
  workspaceRef: ref,
  kind: z.string().max(40),
  name: z.string().min(1).max(200),
  fields: z.record(z.string(), z.unknown()).nullish(),
  secrets: z.record(z.string(), z.unknown()).nullish(),
  events: z.array(z.string().max(80)).nullish(),
  createdAt: time,
});

export const agentSessionSchema = z.object({
  ref,
  workspaceRef: ref,
  authorRef: maybeRef,
  shared: yesNo,
  parentRef: maybeRef,
  title: maybeText(500),
  position: z.number().nullish(),
  messages: z
    .array(
      z.object({
        role: z.string().max(20),
        text: z.string().max(1_000_000).nullish(),
        steps: z.array(z.object({ action: maybeText(2000), outcome: maybeText(20) })).nullish(),
        attachments: z.number().int().nullish(),
        createdAt: time,
      }),
    )
    .nullish(),
  createdAt: time,
  updatedAt: time,
});

export const deploymentSchema = z.object({
  ref,
  serviceRef: ref,
  status: z.string().max(40),
  title: maybeText(1000),
  commit: maybeText(100),
  trigger: maybeText(40),
  error: maybeText(10_000),
  createdAt: time,
  startedAt: time,
  finishedAt: time,
  log: z
    .string()
    .max(2 * 1024 * 1024)
    .nullish(),
  logTruncated: yesNo,
  logMissing: yesNo,
  legacyConsolePath,
});

export const installSchema = z.object({
  sourceVersion: maybeText(64),
  platformDomain: maybeText(253),
  platformDomainSharedEdge: yesNo,
  consoleHostname: maybeText(253),
  consoleHttps: yesNo,
  letsEncryptEmail: maybeText(254),
  managedZone: z
    .object({ domain: maybeText(253), zoneRef: maybeRef, adminEmail: maybeText(254) })
    .nullish(),
  managedDnsEnabled: yesNo,
  publicIp: maybeText(64),
  dataMode: maybeText(40),
  registrationMode: maybeText(40),
  adminEmail: maybeText(320),
  ownerClaimedAt: time,
  monitoring: z
    .object({
      refreshSeconds: z.number().nullish(),
      retentionDays: z.number().nullish(),
      cron: maybeText(200),
      thresholds: z
        .object({ cpuPercent: z.number().nullish(), memoryPercent: z.number().nullish() })
        .nullish(),
    })
    .nullish(),
  analytics: z.object({ requestLogging: yesNo }).nullish(),
  hostDailyCleanup: yesNo,
  logCleanupCron: maybeText(200),
  /** 29a.9: what runs the 0.1.x control plane on the host, `[{ kind, name }]` (legacy-fields.ts). */
  controlPlane: z.unknown().nullish(),
  /** 29a.9: its Compose project, folder and ports, for the dry-run report and rollback. */
  controlPlaneDetails: z.unknown().nullish(),
  /** 29a.9: the volumes holding its data. */
  controlPlaneVolumes: z.array(z.string()).nullish().catch(null),
  /** 29a.9: the 0.1.x webhook paths, "{token}" where the token goes. */
  legacyWebhookPaths: z.unknown().nullish(),
});

/** The record files (29a.5) in import order, with their schema and label for the report. */
export const RECORD_FILES = {
  people: { file: "people.jsonl", schema: personSchema, label: "people" },
  workspaces: { file: "workspaces.jsonl", schema: workspaceSchema, label: "workspaces" },
  sshKeys: { file: "ssh-keys.jsonl", schema: sshKeySchema, label: "SSH keys" },
  servers: { file: "servers.jsonl", schema: serverSchema, label: "servers" },
  gitProviders: { file: "git-providers.jsonl", schema: gitProviderSchema, label: "Git providers" },
  zones: { file: "zones.jsonl", schema: zoneSchema, label: "DNS zones" },
  projects: { file: "projects.jsonl", schema: projectSchema, label: "projects" },
  environments: { file: "environments.jsonl", schema: environmentSchema, label: "environments" },
  services: { file: "services.jsonl", schema: serviceSchema, label: "services" },
  hostnames: { file: "hostnames.jsonl", schema: hostnameSchema, label: "hostnames" },
  certificates: { file: "certificates.jsonl", schema: certificateSchema, label: "certificates" },
  policies: { file: "policies.jsonl", schema: policySchema, label: "access policies" },
  memberships: { file: "memberships.jsonl", schema: membershipSchema, label: "members" },
  invitations: { file: "invitations.jsonl", schema: invitationSchema, label: "invitations" },
  destinations: {
    file: "destinations.jsonl",
    schema: destinationSchema,
    label: "backup destinations",
  },
  backupSchedules: {
    file: "backup-schedules.jsonl",
    schema: backupScheduleSchema,
    label: "backup schedules",
  },
  tasks: { file: "tasks.jsonl", schema: taskSchema, label: "tasks" },
  channels: { file: "channels.jsonl", schema: channelSchema, label: "notification channels" },
  agentSessions: {
    file: "agent-sessions.jsonl",
    schema: agentSessionSchema,
    label: "Agent sessions",
  },
  deployments: { file: "deployments.jsonl", schema: deploymentSchema, label: "deployments" },
} as const;

export type RecordKind = keyof typeof RECORD_FILES;
export type BundleRecord<K extends RecordKind> = z.infer<(typeof RECORD_FILES)[K]["schema"]>;
