import { createHash } from "node:crypto";
import {
  builderSchema,
  checkEnvText,
  DATABASE_DEFAULTS,
  DEFAULT_DEPLOY_SETTINGS,
  FILE_MOUNT_MAX_CHARS,
  formatBytes,
  HEROKU_STACKS,
  isDatabaseKind,
  parseCron,
  portMappingSchema,
  RAILPACK_VERSIONS,
  type ServiceKind,
  slugify,
  textBytes,
  usableTimeZone,
  volumeNameProblem,
} from "@nearzero/shared";
import { sql } from "kysely";
import { nextRunFor, reportedTimeZone, serverTimeZone } from "../backups/schedules.ts";
import { recordApproval } from "../compose-runtime/host-policy.ts";
import { planStack } from "../compose-runtime/plan.ts";
import { composeSourceOf } from "../compose-runtime/source.ts";
import { hostAddress } from "../domains/addresses.ts";
import { sha256Hex } from "../security/tokens.ts";
import {
  appMountFindings,
  recordMountApproval,
  savedAppDefinition,
} from "../service-runtime/host-mounts.ts";
import { generatePassword } from "../services/generate.ts";
import { uniqueAppName } from "../services/placement.ts";
import { secretsContext } from "../services/records.ts";
import { variablesForDeploy } from "../variables/deploy.ts";
import { writeVariables } from "../variables/store.ts";
import { IMPORTED_TOKEN } from "../webhooks/tokens.ts";
import { bundleJson } from "./bundle.ts";
import { DROPPED_SERVICE_SETTINGS } from "./dropped.ts";
import { cleanHost, placeTarget } from "./import-infra.ts";
import { type ImportRun, NotImported, validDate } from "./importer.ts";
import {
  builderNamed,
  deploymentStatusNamed,
  deploymentTriggerNamed,
  hostnameDefaultNamed,
  hostnameSourceNamed,
  mountTypeNamed,
  serviceKindNamed,
  sourceTypeNamed,
} from "./labels.ts";
import { controlPlaneDetails, stackFiles } from "./legacy-fields.ts";
import type { LegacyWorkload } from "./moves.ts";
import { type BundleRecord, installSchema } from "./records.ts";

/**
 * Projects, environments, services, hostnames, backup schedules, tasks, Agent sessions and
 * deployments (spec 29a.5.10–29a.5.21), then the plan that moves every service onto the 1.0
 * runner. Internal app names, data volumes, database passwords, public ports, generated hostnames
 * and webhook tokens are kept exactly when they are free, so apps, DNS and Git hosts keep reaching
 * them (spec 29.5, "Names and addresses").
 */

const APP_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ENVIRONMENT_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const INNER_SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/;
const MAX_VARIABLES = 262_144;

type Settings = Record<string, unknown>;

function isObject(value: unknown): value is Settings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function webhookContext(serviceId: string): string {
  return `service:${serviceId}:deploy-webhook`;
}

/** A stable uuid for a copy group, so services of one group imported in two runs still match. */
function copyGroupId(run: ImportRun, group: string): string {
  const hex = createHash("sha256")
    .update(`${run.bundle.sourceInstall}\u0000${group}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Saves variables text as it is (comments included), or says why it couldn't. */
async function saveVariables(
  run: ImportRun,
  owner: { kind: "environment" | "service"; id: string; workspaceId: string },
  value: string,
  label: string,
  kind: "environments" | "services",
): Promise<void> {
  if (value.trim() === "") return;
  if (textBytes(value) > MAX_VARIABLES) {
    run.changed(
      kind,
      label,
      `${label}: its variables are larger than 256 KB, so they were left out. Add them again before deploying.`,
    );
    return;
  }
  const problems = checkEnvText(value);
  if (problems.length > 0) {
    run.changed(
      kind,
      label,
      `${label}: line ${problems[0]?.line} of its variables can't be read by 1.0 (${problems[0]?.message}). Fix it before the next deploy.`,
    );
  }
  await writeVariables(run.db, run.services.secrets, owner, value, { by: null });
}

// ---- Projects and environments

async function importProject(run: ImportRun, record: BundleRecord<"projects">): Promise<string> {
  const workspaceId = run.id("workspaces", record.workspaceRef);
  if (!workspaceId)
    throw new NotImported(`Project ${record.name}`, "its workspace wasn't imported.");
  const created = await run.db
    .insertInto("project")
    .values({
      workspace_id: workspaceId,
      name: record.name.trim().slice(0, 100),
      description: (record.description ?? "").slice(0, 1000),
      ...(validDate(record.createdAt) ? { created_at: validDate(record.createdAt) as Date } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return created.id;
}

async function importEnvironment(
  run: ImportRun,
  record: BundleRecord<"environments">,
): Promise<string> {
  const projectId = run.id("projects", record.projectRef);
  const label = `Environment ${record.name}`;
  if (!projectId) throw new NotImported(label, "its project wasn't imported.");
  const project = await run.db
    .selectFrom("project")
    .select(["workspace_id", "name"])
    .where("id", "=", projectId)
    .executeTakeFirstOrThrow();
  let name = record.name.trim().toLowerCase();
  if (!ENVIRONMENT_NAME.test(name) || name.length > 32) {
    name = slugify(record.name, 32) || "environment";
    run.changed(
      "environments",
      record.name,
      `${label} in ${project.name} is called ${name} in 1.0 (environment names are lowercase words joined by dashes).`,
    );
  }
  const taken = async (candidate: string) =>
    (await run.db
      .selectFrom("environment")
      .select("id")
      .where("project_id", "=", projectId)
      .where("name", "=", candidate)
      .executeTakeFirst()) !== undefined;
  if (await taken(name)) {
    let n = 2;
    while (await taken(`${name.slice(0, 29)}-${n}`)) n++;
    const next = `${name.slice(0, 29)}-${n}`;
    run.collision(
      "environments",
      record.name,
      `${label} in ${project.name}: the name is taken, so it is ${next}.`,
    );
    name = next;
  }
  const hasDefault =
    (await run.db
      .selectFrom("environment")
      .select("id")
      .where("project_id", "=", projectId)
      .where("is_default", "=", true)
      .executeTakeFirst()) !== undefined;
  const created = await run.db
    .insertInto("environment")
    .values({
      workspace_id: project.workspace_id,
      project_id: projectId,
      name,
      description: (record.description ?? "").slice(0, 1000),
      is_default: record.default === true && !hasDefault,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  // 0.1.x project-level variables already follow the environment's own in this text (29a.5.11).
  await saveVariables(
    run,
    { kind: "environment", id: created.id, workspaceId: project.workspace_id },
    record.sharedVariables ?? "",
    `${label} in ${project.name}`,
    "environments",
  );
  const defaults = record.hostnameDefaults;
  if (defaults?.source) {
    const source = hostnameDefaultNamed(defaults.source);
    const zoneId = run.id("zones", defaults.zoneRef);
    if (!source || (source === "zone" && !zoneId)) {
      run.changed(
        "environments",
        record.name,
        `${label} in ${project.name}: its hostname default couldn't be carried over, so new services get the install's default.`,
      );
    } else {
      await run.db
        .insertInto("environment_hostname_default")
        .values({
          environment_id: created.id,
          workspace_id: project.workspace_id,
          source,
          zone_id: source === "zone" ? (zoneId as string) : null,
          prefix: (defaults.prefix ?? "").slice(0, 100),
        })
        .execute();
    }
  }
  return created.id;
}

// ---- Services

interface KindResult {
  settings: Settings;
  secrets: Record<string, unknown> | null;
  /** False when the redeploy can't happen (an uploaded archive isn't in the bundle). */
  deployable: boolean;
  why?: string;
}

type Note = (message: string) => void;

/** A source (29a.5.12) in 1.0's terms, with refs turned into ids. */
async function mapSource(
  run: ImportRun,
  raw: unknown,
  label: string,
  note: Note,
  secrets: Record<string, unknown>,
  extra: { trigger: unknown; watchPaths: unknown; submodules: unknown; composePath?: unknown },
): Promise<{ source: Settings | null; deployable: boolean; why?: string }> {
  if (!isObject(raw))
    return { source: null, deployable: false, why: "It has no source to deploy from." };
  const type = sourceTypeNamed(text(raw.type));
  const watchPaths = Array.isArray(extra.watchPaths)
    ? extra.watchPaths.filter((item): item is string => typeof item === "string")
    : [];
  const trigger = text(extra.trigger).toLowerCase() === "tag" ? "tag" : "push";
  const submodules = extra.submodules === true;
  switch (type) {
    case "image": {
      const image = text(raw.image);
      if (!image) return { source: null, deployable: false, why: "Its image is missing." };
      const password = text(raw.password);
      if (password) secrets.registryPassword = password;
      const registry =
        text(raw.registryUrl) || text(raw.username)
          ? {
              address: text(raw.registryUrl),
              username: text(raw.username),
              passwordSet: password !== "",
            }
          : null;
      return { source: { type: "image", image, registry }, deployable: true };
    }
    case "git": {
      const url = text(raw.url);
      if (!url) return { source: null, deployable: false, why: "Its Git URL is missing." };
      const keyRef = text(raw.sshKeyRef);
      const sshKeyId = keyRef ? (run.id("sshKeys", keyRef) ?? null) : null;
      if (keyRef && !sshKeyId)
        note(`${label}: its deploy key wasn't imported, so it fetches without one.`);
      return {
        source: {
          type: "git",
          url,
          branch: text(raw.branch, "main") || "main",
          buildPath: text(raw.path),
          sshKeyId,
          trigger,
          watchPaths,
          submodules,
        },
        deployable: true,
      };
    }
    case "github":
    case "gitlab":
    case "gitea":
    case "bitbucket": {
      const providerId = run.id("gitProviders", text(raw.gitProviderRef));
      if (!providerId) {
        return {
          source: null,
          deployable: false,
          why: "Its Git provider wasn't imported, so it has no source until one is picked.",
        };
      }
      const owner = text(raw.owner) || text(raw.namespace);
      const name = text(raw.repositorySlug) || text(raw.repository);
      const repository = name.includes("/") || !owner ? name : `${owner}/${name}`;
      return {
        source: {
          type: "provider",
          providerId,
          provider: type,
          repository,
          repositoryId:
            raw.projectId !== undefined && raw.projectId !== null ? String(raw.projectId) : null,
          branch: text(raw.branch, "main") || "main",
          buildPath: text(raw.path),
          composePath: typeof extra.composePath === "string" ? extra.composePath : null,
          trigger,
          watchPaths,
          submodules,
        },
        deployable: true,
      };
    }
    case "upload":
      return {
        source: { type: "upload", buildPath: text(raw.path), upload: null },
        deployable: false,
        why: "It was deployed from an uploaded archive, which isn't in the export. Upload it again, then deploy.",
      };
    case "raw":
      return { source: null, deployable: true };
    default:
      return {
        source: null,
        deployable: false,
        why: `Its source type "${text(raw.type)}" isn't one 1.0 knows, so it has none until one is picked.`,
      };
  }
}

function deploySettings(raw: Settings): Settings {
  return {
    autodeploy:
      typeof raw.autodeploy === "boolean" ? raw.autodeploy : DEFAULT_DEPLOY_SETTINGS.autodeploy,
    cleanCache:
      isObject(raw.builder) && typeof raw.builder.cleanCache === "boolean"
        ? raw.builder.cleanCache
        : DEFAULT_DEPLOY_SETTINGS.cleanCache,
    stabilitySeconds: DEFAULT_DEPLOY_SETTINGS.stabilitySeconds,
  };
}

/** Settings every kind may carry that 1.0 dropped (spec 27): replicas and resource limits. */
function droppedCommon(raw: Settings, drop: Note, label: string): void {
  if (typeof raw.replicas === "number" && raw.replicas > 1)
    drop(`${label}: ${DROPPED_SERVICE_SETTINGS.replicas}`);
  if (
    isObject(raw.resources) &&
    Object.values(raw.resources).some(
      (value) => value !== null && value !== undefined && value !== 0,
    )
  ) {
    drop(`${label}: ${DROPPED_SERVICE_SETTINGS.resourceLimits}`);
  }
}

function mapBuilder(raw: unknown, label: string, note: Note, drop: Note): Settings {
  if (!isObject(raw)) return { type: "automatic" };
  if (text(raw.runsOn) === "Nearzero host") {
    drop(
      `${label}: building on the Nearzero host for another server isn't in 1.0 (spec 27), so it builds on its own server.`,
    );
  }
  for (const [field, setting] of [
    ["buildArgs", "buildArgs"],
    ["buildSecrets", "buildSecrets"],
  ] as const) {
    if (text(raw[field]).trim() !== "") drop(`${label}: ${DROPPED_SERVICE_SETTINGS[setting]}`);
  }
  if (text(raw.selection) === "Automatic") return { type: "automatic" };
  const type = builderNamed(text(raw.type));
  if (!type) {
    note(
      `${label} uses a builder 1.0 doesn't offer (${text(raw.type, "unknown")}); it will build automatically.`,
    );
    return { type: "automatic" };
  }
  let candidate: Settings;
  switch (type) {
    case "dockerfile":
      candidate = {
        type,
        dockerfilePath: text(raw.dockerfile, "Dockerfile") || "Dockerfile",
        contextPath: text(raw.contextPath),
        stage: text(raw.buildStage),
      };
      break;
    case "railpack": {
      const version = text(raw.railpackVersion);
      if (version && !(RAILPACK_VERSIONS as readonly string[]).includes(version)) {
        note(
          `${label}: Railpack ${version} isn't offered in 1.0, so it builds with Railpack ${RAILPACK_VERSIONS[0]}.`,
        );
      }
      candidate = {
        type,
        ...((RAILPACK_VERSIONS as readonly string[]).includes(version) ? { version } : {}),
      };
      break;
    }
    case "heroku": {
      const stack = text(raw.herokuVersion).replace(/^heroku-/, "");
      candidate = {
        type,
        ...((HEROKU_STACKS as readonly string[]).includes(stack) ? { stack } : {}),
      };
      break;
    }
    case "nixpacks":
      candidate = { type, publishDirectory: text(raw.publishDirectory) };
      break;
    case "static":
      candidate = { type, spa: raw.staticSpa === true };
      break;
    default:
      candidate = { type };
  }
  const parsed = builderSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  note(
    `${label}: its ${text(raw.type)} settings can't be used in 1.0, so it builds automatically.`,
  );
  return { type: "automatic" };
}

/** Mounts (29a.5.12): volumes 1.0 names <app name>-<name>, host folders and files. */
const DOCKER_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** A mount name (1.0's rules) for a volume kept under its own name, unique among the mounts. */
function mountNameFor(volume: string, mounts: Settings[]): string {
  const base =
    volume
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 56) || "data";
  const taken = new Set(mounts.map((mount) => mount.name));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
  return name;
}

function mapMounts(
  raw: unknown,
  appName: string,
  label: string,
  note: Note,
  files: Record<string, string>,
  volumes: Map<string, string>,
): Settings[] {
  const mounts: Settings[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item)) continue;
    const type = mountTypeNamed(text(item.type));
    // 29a.9: every mount names its path inside the container in containerPath.
    const containerPath = text(item.containerPath) || text(item.path) || text(item.filePath);
    if (!type || !containerPath.startsWith("/")) {
      note(
        `${label}: a mount (${text(item.type, "unknown")} at ${containerPath || "no path"}) can't be used in 1.0 and was left out.`,
      );
      continue;
    }
    // Mount ids are what the console sends back when the mounts are edited.
    const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    if (type === "volume") {
      // 29.5 "Volumes": the mount uses the volume the bundle names, under that exact name.
      const full = text(item.volume);
      if (!DOCKER_VOLUME.test(full)) {
        note(
          `${label}: the volume mount at ${containerPath} names no usable volume (${full || "none"}), so it was left out.`,
        );
        continue;
      }
      const short = full.startsWith(`${appName}-`) ? full.slice(appName.length + 1) : "";
      const derived = short !== "" && !volumeNameProblem(short);
      const name = derived ? short : mountNameFor(full, mounts);
      volumes.set(full, full);
      mounts.push({
        type: "volume",
        id,
        name,
        containerPath,
        ...(derived ? {} : { volume: full }),
      });
    } else if (type === "bind") {
      mounts.push({
        type: "bind",
        id,
        hostPath: text(item.hostPath),
        containerPath,
        readOnly: item.readOnly === true,
      });
    } else {
      mounts.push({ type: "file", id, containerPath });
      files[id] = text(item.content);
      // 0.1.x had no practical limit; 1.0's is 1 MB (spec 6.8, 31d G4-16). Said before any deploy.
      if (files[id].length > FILE_MOUNT_MAX_CHARS) {
        note(
          `${label}: the file mount at ${containerPath} holds ${formatBytes(files[id].length)}, more than the 1 MB a file mount can hold in 1.0, so it won't deploy as it is. Put the file in a volume, or make it smaller on the Advanced tab, before deploying.`,
        );
      }
    }
  }
  return mounts;
}

async function applicationSettings(
  run: ImportRun,
  record: BundleRecord<"services">,
  appName: string,
  label: string,
): Promise<KindResult> {
  const raw = record.settings ?? {};
  const secrets: Record<string, unknown> = {};
  const note: Note = (message) => run.changed("services", record.name, message);
  const drop: Note = (message) => run.dropped("services", record.name, message);
  const builder = isObject(raw.builder) ? raw.builder : {};
  const mapped = await mapSource(run, raw.source, label, note, secrets, {
    trigger: raw.trigger,
    watchPaths: raw.watchPaths,
    submodules: builder.submodules,
  });
  const commands = isObject(raw.commands) ? raw.commands : {};
  if (text(commands.command).trim() !== "") drop(`${label}: ${DROPPED_SERVICE_SETTINGS.command}`);
  if (Array.isArray(commands.args) && commands.args.length > 0)
    drop(`${label}: ${DROPPED_SERVICE_SETTINGS.args}`);
  droppedCommon(raw, drop, label);
  const ports: unknown[] = [];
  let droppedPorts = 0;
  for (const item of Array.isArray(raw.ports) ? raw.ports : []) {
    const port = isObject(item) ? item : {};
    const parsed = portMappingSchema.safeParse({
      containerPort: port.target,
      publishedPort: port.published,
      protocol: text(port.protocol, "TCP").toLowerCase(),
    });
    if (parsed.success) ports.push(parsed.data);
    else droppedPorts++;
  }
  if (droppedPorts > 0)
    note(`${label}: ${droppedPorts} published ports can't be used in 1.0 and were left out.`);
  const files: Record<string, string> = {};
  const volumes = new Map<string, string>();
  run.volumeNames.set(record.ref, volumes);
  const mounts = mapMounts(raw.mounts, appName, label, note, files, volumes);
  // Every name in `volumes` is attached under that name; one no mount places has no path to go.
  for (const volume of record.volumes ?? []) {
    if (!volumes.has(volume)) {
      note(
        `${label}: the volume ${volume} isn't mounted at any path in the export, so it isn't attached. It stays on the server as it is.`,
      );
    }
  }
  if (Object.keys(files).length > 0) secrets.files = files;
  // The port the app listens on: its routed hostname's port when there is one, else 3000.
  return {
    settings: {
      source: mapped.source,
      build: mapBuilder(raw.builder, label, note, drop),
      commands: {
        install: text(commands.install),
        build: text(commands.build),
        start: text(commands.start),
      },
      // 29a.9 servicePort; else the port its first hostname routes to; else 3000.
      servicePort:
        record.servicePort ??
        (typeof raw.servicePort === "number" ? raw.servicePort : null) ??
        run.servicePorts.get(record.ref) ??
        3000,
      ports,
      mounts,
      deploy: deploySettings(raw),
    },
    secrets: Object.keys(secrets).length > 0 ? secrets : null,
    deployable: mapped.deployable,
    ...(mapped.why ? { why: mapped.why } : {}),
  };
}

async function composeSettings(
  run: ImportRun,
  record: BundleRecord<"services">,
  label: string,
): Promise<KindResult> {
  const raw = record.settings ?? {};
  const secrets: Record<string, unknown> = {};
  const note: Note = (message) => run.changed("services", record.name, message);
  const drop: Note = (message) => run.dropped("services", record.name, message);
  const pasted =
    !isObject(raw.source) || sourceTypeNamed(text((raw.source as Settings).type)) === "raw";
  const mapped = pasted
    ? text(raw.composeFile)
      ? { source: { type: "raw", composeFile: text(raw.composeFile) }, deployable: true }
      : { source: null, deployable: false, why: "Its Compose file isn't in the export." }
    : await mapSource(run, raw.source, label, note, secrets, {
        trigger: raw.trigger,
        watchPaths: raw.watchPaths,
        submodules: raw.submodules,
        composePath: raw.composePath,
      });
  if (text(raw.command).trim() !== "") drop(`${label}: ${DROPPED_SERVICE_SETTINGS.command}`);
  for (const option of ["randomizeNames", "isolatedNetwork", "isolatedVolumes"] as const) {
    if (raw[option] === true) {
      drop(
        `${label}: "${option}" isn't in 1.0; its containers are named <app name>-<service> on the private network.`,
      );
    }
  }
  droppedCommon(raw, drop, label);
  return {
    settings: {
      format: text(raw.format).toLowerCase() === "stack" ? "stack" : "compose",
      source: mapped.source,
      deploy: deploySettings(raw),
    },
    secrets: null,
    deployable: mapped.deployable,
    ...("why" in mapped && mapped.why ? { why: mapped.why } : {}),
  };
}

function databaseSettings(
  run: ImportRun,
  record: BundleRecord<"services">,
  kind: Exclude<ServiceKind, "application" | "compose">,
  appName: string,
  label: string,
): KindResult & { publicPort: number | null } {
  const defaults = DATABASE_DEFAULTS[kind];
  const raw = record.settings ?? {};
  const credentials = isObject(raw.credentials) ? raw.credentials : {};
  const drop: Note = (message) => run.dropped("services", record.name, message);
  if (text(raw.command).trim() !== "" || (Array.isArray(raw.args) && raw.args.length > 0)) {
    drop(`${label}: ${DROPPED_SERVICE_SETTINGS.databaseCommand}`);
  }
  droppedCommon(raw, drop, label);
  const settings: Settings = {
    image: text(raw.image) || defaults.image,
    port: defaults.port,
    // The existing volume is reused exactly, so the data is there after the redeploy.
    dataVolume: (record.volumes ?? [])[0] || `${appName}-data`,
  };
  const old = (record.volumes ?? [])[0];
  if (old) run.volumeNames.set(record.ref, new Map([[old, settings.dataVolume as string]]));
  if (defaults.databaseName !== null)
    settings.databaseName = text(credentials.database) || defaults.databaseName;
  if (defaults.user !== null) settings.user = text(credentials.user) || defaults.user;
  if (kind === "mongodb") settings.replicaSet = raw.replicaSet === true;
  let publicPort = typeof raw.publicPort === "number" ? raw.publicPort : null;
  if (kind === "libsql") {
    const libsql = isObject(raw.libsql) ? raw.libsql : {};
    settings.nodeRole = text(libsql.node).toLowerCase() === "replica" ? "replica" : "primary";
    settings.primaryUrl = settings.nodeRole === "replica" ? text(libsql.primaryUrl) : null;
    settings.namespaces = libsql.namespaces === true;
    const ports = isObject(raw.publicPorts) ? raw.publicPorts : {};
    if (publicPort === null && typeof ports.http === "number") publicPort = ports.http;
    if (typeof ports.grpc === "number" || typeof ports.admin === "number") {
      drop(
        `${label}: 1.0 publishes libSQL's HTTP port only, so its gRPC and admin ports are private.`,
      );
    }
  }
  const secrets: Record<string, string> = {};
  const password = text(credentials.password);
  if (password) secrets.password = password;
  else {
    secrets.password = generatePassword();
    if (kind !== "redis" && kind !== "libsql") {
      run.changed(
        "services",
        record.name,
        `${label} had no password in the export, so it got a new one. Apps that connect to it need the new connection URL.`,
      );
    }
  }
  if (defaults.hasRootPassword)
    secrets.rootPassword = text(credentials.rootPassword) || generatePassword();
  return { settings, secrets, deployable: true, publicPort };
}

function appNameBase(appName: string): string {
  const base = appName
    .replace(/-[a-z0-9]{6}$/, "")
    .slice(0, 50)
    .replace(/-+$/, "");
  return APP_NAME.test(base) ? base : "app";
}

/** The 0.1.x workload a service replaces: named in the bundle, or by its internal app name. */
/**
 * The 0.1.x data folders on every server (29a.9): its install folder, and the folder where it
 * keeps app, Compose and secret files on remote servers.
 */
export const LEGACY_DATA_FOLDERS = ["/opt/nearzero", "/etc/nearzero"] as const;

/**
 * Where an absolute env file may be (29a.9: under the 0.1.x install's data folders): on every
 * server the folders above; on the Nearzero host also its control plane's folder and the folders
 * of its data volumes (`controlPlaneVolumes`, which the server resolves).
 */
function dataPlaces(
  run: ImportRun,
  onHost: boolean,
): { dataFolders: string[]; dataVolumes: string[] } {
  if (!onHost) return { dataFolders: [...LEGACY_DATA_FOLDERS], dataVolumes: [] };
  const install = installSchema.safeParse(bundleJson(run.bundle, "install.json") ?? {});
  const details = controlPlaneDetails(install.success ? install.data.controlPlaneDetails : null);
  const dataFolders = [
    ...new Set([...LEGACY_DATA_FOLDERS, ...(details?.folder ? [details.folder] : [])]),
  ];
  const dataVolumes = ((install.success ? install.data.controlPlaneVolumes : null) ?? []).filter(
    (name) => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name),
  );
  return { dataFolders, dataVolumes };
}

function legacyOf(
  run: ImportRun,
  record: BundleRecord<"services">,
  kind: ServiceKind,
  appName: string,
  onHost: boolean,
): LegacyWorkload | null {
  if (record.legacy) {
    const { kind: legacyKind, name } = record.legacy;
    // A Compose project's own files come along, so its copy can come back from them (29.5).
    const files = legacyKind === "compose-project" ? stackFiles(record.legacy) : null;
    // An env file kept outside the stack's folder must be under the install's data folders.
    const places = files?.envFile?.startsWith("/") ? dataPlaces(run, onHost) : null;
    return { kind: legacyKind, name, ...(files ?? {}), ...(places ?? {}) };
  }
  if (!APP_NAME.test(appName)) return null;
  if (kind === "compose") {
    const stack = text(record.settings?.format).toLowerCase() === "stack";
    return { kind: stack ? "swarm-stack" : "compose-project", name: appName };
  }
  return { kind: "swarm-service", name: appName };
}

async function importService(run: ImportRun, record: BundleRecord<"services">): Promise<string> {
  const label = `Service ${record.name}`;
  const environmentId = run.id("environments", record.environmentRef);
  if (!environmentId) throw new NotImported(label, "its environment wasn't imported.");
  const kind = serviceKindNamed(record.kind);
  if (!kind) throw new NotImported(label, `${record.kind} isn't a kind of service 1.0 runs.`);
  const environment = await run.db
    .selectFrom("environment as e")
    .innerJoin("project as p", "p.id", "e.project_id")
    .select(["e.workspace_id", "e.project_id", "e.name", "p.name as project_name"])
    .where("e.id", "=", environmentId)
    .executeTakeFirstOrThrow();
  const target = placeTarget(run, record.place);
  if (!target) throw new NotImported(label, "its server wasn't imported.");
  const serverId = target === "host" ? null : target;
  if (serverId !== null) {
    // The database no longer refuses it (migration 0153): a service only runs on its own
    // workspace's servers (spec 22.4 rule 1; B1-61).
    const server = await run.db
      .selectFrom("server")
      .select("workspace_id")
      .where("id", "=", serverId)
      .executeTakeFirst();
    if (server?.workspace_id !== environment.workspace_id) {
      throw new NotImported(label, "its server belongs to another workspace.");
    }
  }
  const where = `${environment.project_name} / ${environment.name}`;

  let name = record.name.trim().slice(0, 100);
  const nameTaken = async (candidate: string) =>
    (await run.db
      .selectFrom("service")
      .select("id")
      .where("environment_id", "=", environmentId)
      .where(sql<string>`lower(name)`, "=", candidate.toLowerCase())
      .executeTakeFirst()) !== undefined;
  if (await nameTaken(name)) {
    let n = 2;
    while (await nameTaken(`${name.slice(0, 95)} ${n}`)) n++;
    const next = `${name.slice(0, 95)} ${n}`;
    run.collision(
      "services",
      record.name,
      `${label} in ${where}: the name is taken, so it is ${next}.`,
    );
    name = next;
  }

  // The internal app name is how other apps reach it on the private network: kept when free.
  let appName = (record.appName ?? "").trim();
  const legacyName = appName;
  const appNameFree =
    APP_NAME.test(appName) &&
    appName.length <= 57 &&
    (await run.db
      .selectFrom("service")
      .select("id")
      .where("app_name", "=", appName)
      .executeTakeFirst()) === undefined;
  if (!appNameFree) {
    const next = await uniqueAppName(
      run.db,
      appNameBase(slugify(record.appName || record.name, 50).replace(/^[^a-z]+/, "") || "app"),
    );
    if (record.appName) {
      run.changed(
        "services",
        record.name,
        `${label} in ${where}: its internal name ${record.appName} can't be used here, so it is ${next}. Apps that reach it by the old name need the new one.`,
      );
    }
    appName = next;
  }

  let publicPortWanted: number | null = null;
  let made: KindResult;
  if (kind === "application") made = await applicationSettings(run, record, appName, label);
  else if (kind === "compose") made = await composeSettings(run, record, label);
  else {
    const database = databaseSettings(run, record, kind, appName, label);
    publicPortWanted = database.publicPort;
    made = database;
  }

  let publicPort: number | null = null;
  if (isDatabaseKind(kind) && publicPortWanted) {
    const port = publicPortWanted;
    let query = run.db.selectFrom("service").select("id").where("public_port", "=", port);
    query =
      serverId === null
        ? query.where("server_id", "is", null)
        : query.where("server_id", "=", serverId);
    // 29.5 "Public ports": the exact port, even outside the range 1.0 picks new ones from; the
    // import never picks another. One taken by another 1.0 service here leaves it private.
    if (port >= 1 && port <= 65535 && !(await query.executeTakeFirst())) publicPort = port;
    else {
      run.collision(
        "services",
        record.name,
        `${label} in ${where}: its public port ${port} is already another service's on its server, so it is private now. Free the port, then make it public again with port ${port}.`,
      );
    }
  }

  const id = crypto.randomUUID();
  await run.db
    .insertInto("service")
    .values({
      id,
      workspace_id: environment.workspace_id,
      project_id: environment.project_id,
      environment_id: environmentId,
      copy_group_id: record.copyGroupRef ? copyGroupId(run, record.copyGroupRef) : null,
      kind,
      name,
      app_name_base: appNameBase(appName),
      app_name: appName,
      description: (record.description ?? "").slice(0, 1000),
      server_id: serverId,
      settings: JSON.stringify(made.settings),
      secrets_sealed: made.secrets
        ? run.services.secrets.seal(JSON.stringify(made.secrets), secretsContext(id))
        : null,
      public_port: publicPort,
    })
    .execute();

  if (serverId === null && !run.hostWorkspaces.has(environment.workspace_id)) {
    run.hostWorkspaces.add(environment.workspace_id);
    const inserted = await run.db
      .insertInto("host_allowed_workspace")
      .values({ workspace_id: environment.workspace_id })
      .onConflict((conflict) => conflict.doNothing())
      .returning("workspace_id")
      .execute();
    if (inserted.length > 0) {
      const workspace = await run.db
        .selectFrom("workspace")
        .select("name")
        .where("id", "=", environment.workspace_id)
        .executeTakeFirstOrThrow();
      run.report.install.push({
        kind: "install",
        name: workspace.name,
        message: `${workspace.name} ran services on the Nearzero host, so it may deploy there.`,
      });
    }
  }

  await saveVariables(
    run,
    { kind: "service", id, workspaceId: environment.workspace_id },
    record.variables ?? "",
    `${label} in ${where}`,
    "services",
  );

  // An app that ran on the host with bind mounts keeps running them after the move (29.5): the
  // bundle is what an administrator's 0.1.x install ran, so those mounts in that whole definition
  // (variables included, C1-04) count as approved by an administrator (spec 24 G3; 30b R2-07).
  // Any later change needs one again. Inside the import's own transaction, after the variables.
  if (serverId === null && kind === "application") {
    const findings = appMountFindings(await savedAppDefinition(run.db, run.services.secrets, id));
    if (findings.length > 0) {
      await recordMountApproval(run.db, id, findings, null);
      run.changed(
        "services",
        record.name,
        `${label} in ${where}: its bind mounts on the Nearzero host are kept as an administrator's approval. Any change to them, or to its source, commands, variables or ports, needs a Nearzero administrator's deploy.`,
      );
    }
  }

  // A pasted Compose stack that ran on the host with privileged options keeps running them after
  // the move, as an administrator's approval of exactly those definitions (spec 24 G3, 29.5).
  // Other Compose files (include, extends with a file) are never approved: they wait for an
  // administrator's deploy.
  if (serverId === null && kind === "compose") {
    const source = composeSourceOf(made.settings);
    if (source?.type === "raw") {
      // Inside the import's own transaction, which holds the new service and its variables.
      const variables = await variablesForDeploy(run.db, run.services.secrets, id, "runtime");
      const planned = planStack({
        file: source.composeFile,
        source,
        appName,
        serviceId: id,
        deploymentId: null,
        variables: variables.ok ? variables.variables : [],
        routes: [],
        onHost: true,
      });
      if (planned.ok && planned.plan.findings.length > 0) {
        await recordApproval(run.db, id, planned.plan.findings, null);
        const unchecked = planned.plan.findings.some((finding) => !finding.approvable);
        run.changed(
          "services",
          record.name,
          unchecked
            ? `${label} in ${where}: its file pulls in other Compose files, so on the Nearzero host only a Nearzero administrator's deploy runs it. Deploy it once as one after the move.`
            : `${label} in ${where}: its privileged options on the Nearzero host are kept as an administrator's approval. Any change to those services needs a Nearzero administrator's deploy.`,
        );
      }
    }
  }

  // The deploy webhook's secret part, kept so its URL keeps working; stored hashed (29a.5.12).
  const token = text(record.settings?.webhookToken);
  if (token) {
    if (IMPORTED_TOKEN.test(token)) {
      await run.db
        .insertInto("deploy_webhook")
        .values({
          service_id: id,
          workspace_id: environment.workspace_id,
          secret_hash: sha256Hex(token),
          token_sealed: run.services.secrets.seal(token, webhookContext(id)),
        })
        .execute();
      // 30c R3-36: a GitLab, Bitbucket or Gitea webhook added by hand in 0.1.x has no secret.
      // Its pushes keep deploying through the kept URL, checked by its token like any generic
      // webhook (24 G4), and the report names the service so someone registers a signed one.
      const source = made.settings.source as { type?: unknown; provider?: unknown } | undefined;
      const hosts: Record<string, string> = {
        gitlab: "GitLab",
        bitbucket: "Bitbucket",
        gitea: "Gitea",
      };
      const host =
        source?.type === "provider" && typeof source.provider === "string"
          ? hosts[source.provider]
          : undefined;
      if (host) {
        run.changed(
          "services",
          record.name,
          `${label} in ${where}: pushes from its ${host} webhook keep deploying through the same URL, checked by its token alone. Press Register webhook on its Source panel so ${host} signs each push, then delete the old webhook on ${host}.`,
        );
      }
      // 0.1.x deployed on any method; 1.0 only on POST (31d G4-17).
      run.changed(
        "services",
        record.name,
        `${label} in ${where}: 0.1.x also deployed when its webhook URL was called with GET. 1.0 deploys only on POST and answers a GET with "Call this webhook with POST.", so change any script or cron job that calls it without -X POST.`,
      );
    } else {
      run.changed(
        "services",
        record.name,
        `${label} in ${where}: its webhook URL can't be kept. Copy the new one from its Settings tab into the Git host.`,
      );
    }
  }

  const targetName =
    serverId === null
      ? "the Nearzero host"
      : ((
          await run.db
            .selectFrom("server")
            .select("name")
            .where("id", "=", serverId)
            .executeTakeFirst()
        )?.name ?? "its server");
  // Oldest deployed first; when the bundle carries deployments, one never deployed stays so.
  const deployedAt = run.lastDeployed.get(record.ref) ?? null;
  const deployments =
    run.bundle.manifest.options?.deployments !== false && run.bundle.files.has("deployments.jsonl");
  const everDeployed = deployedAt !== null || !deployments;
  const legacy = legacyOf(run, record, kind, legacyName, serverId === null);
  // A stack without its folder comes back as before, by starting its stopped containers, which
  // 1.0's deploy of the same project may have replaced (spec 29.5, 29a.9).
  if (legacy?.kind === "compose-project" && !legacy.folder) {
    run.changed(
      "services",
      record.name,
      `${label}: its 0.1.x Compose project ${legacy.name} can't be restored from its files (the export doesn't name its folder), so a failed move or a rollback starts its stopped containers again.`,
    );
  }
  run.moves.push({
    serviceId: id,
    name,
    target,
    targetName,
    // Without deployments in the bundle, creation order stands in for deploy order.
    lastDeployedAt:
      deployedAt ?? (deployments ? null : (validDate(record.createdAt)?.getTime() ?? null)),
    legacy,
    deployable: made.deployable && everDeployed,
    ...(made.why ? { why: made.why } : {}),
  });
  return id;
}

// ---- Hostnames

async function importHostname(run: ImportRun, record: BundleRecord<"hostnames">): Promise<string> {
  const host = cleanHost(record.host);
  const label = `Hostname ${record.host}`;
  if (!host) throw new NotImported(label, "it isn't a hostname 1.0 accepts.");
  const existing = await run.db
    .selectFrom("hostname")
    .select("id")
    .where("host", "=", host)
    .executeTakeFirst();
  if (existing) throw new NotImported(label, "this server already routes it.");
  let workspaceId: string;
  let serviceId: string | null = null;
  let target: string;
  const zoneId = run.id("zones", record.zoneRef) ?? null;
  if (record.serviceRef) {
    serviceId = run.id("services", record.serviceRef) ?? null;
    if (!serviceId) throw new NotImported(label, "its service wasn't imported.");
    const service = await run.db
      .selectFrom("service")
      .select(["workspace_id", "server_id"])
      .where("id", "=", serviceId)
      .executeTakeFirstOrThrow();
    workspaceId = service.workspace_id;
    target = service.server_id ?? "host";
  } else {
    const resolved = record.place
      ? placeTarget(run, record.place)
      : record.serverRef
        ? run.id("servers", record.serverRef)
        : "host";
    if (!resolved) throw new NotImported(label, "its server wasn't imported.");
    target = resolved;
    const server =
      target === "host"
        ? undefined
        : await run.db
            .selectFrom("server")
            .select("workspace_id")
            .where("id", "=", target)
            .executeTakeFirst();
    const zone = zoneId
      ? await run.db
          .selectFrom("dns_zone")
          .select("workspace_id")
          .where("id", "=", zoneId)
          .executeTakeFirst()
      : undefined;
    const owner = server?.workspace_id ?? zone?.workspace_id;
    if (!owner)
      throw new NotImported(
        label,
        "it isn't connected to a service and its workspace can't be told.",
      );
    workspaceId = owner;
  }
  const source = hostnameSourceNamed(record.source) ?? "own";
  if (record.source && !hostnameSourceNamed(record.source)) {
    run.changed(
      "hostnames",
      host,
      `${label}: its source "${record.source}" isn't one 1.0 knows, so it is your own domain.`,
    );
  }
  if (source === "zone" && !zoneId) throw new NotImported(label, "its DNS zone wasn't imported.");
  const innerService =
    record.innerService && INNER_SERVICE.test(record.innerService) ? record.innerService : null;
  const port = record.port && record.port >= 1 && record.port <= 65535 ? record.port : null;
  const given = record.path || "/";
  const path = (given.startsWith("/") ? given : `/${given}`).slice(0, 1024);
  if ((record.internalPath && record.internalPath !== given) || record.stripPath) {
    run.dropped(
      "hostnames",
      host,
      `${label}: rewriting the path to the app isn't in 1.0, so requests reach it with the path they came with.`,
    );
  }
  if (record.https === false || record.certificate === "None") {
    run.changed(
      "hostnames",
      host,
      `${label}: 1.0 serves every hostname over HTTPS once its DNS points here.`,
    );
  }
  const created = await run.db
    .insertInto("hostname")
    .values({
      workspace_id: workspaceId,
      host,
      source,
      zone_id: source === "zone" ? zoneId : null,
      automatic: record.generated === true,
      service_id: serviceId,
      compose_service: serviceId ? innerService : null,
      port,
      path,
      target,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  // Records Nearzero writes for hostnames aren't in the bundle; 1.0 writes them again (29a.5.14).
  if (source === "zone" && zoneId) {
    const zone = await run.db
      .selectFrom("dns_zone")
      .select("name")
      .where("id", "=", zoneId)
      .executeTakeFirstOrThrow();
    const ip =
      target === "host"
        ? await hostAddress(run.services)
        : ((
            await run.db
              .selectFrom("server")
              .select("address")
              .where("id", "=", target)
              .executeTakeFirst()
          )?.address ?? null);
    if (
      ip &&
      /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) &&
      (host === zone.name || host.endsWith(`.${zone.name}`))
    ) {
      await run.db
        .insertInto("dns_record")
        .values({
          zone_id: zoneId,
          name: host === zone.name ? "@" : host.slice(0, -(zone.name.length + 1)),
          type: "A",
          value: ip,
          ttl: 300,
          managed: true,
          hostname_id: created.id,
        })
        .execute();
    }
  }
  return created.id;
}

// ---- Backup schedules and tasks

async function importBackupSchedule(
  run: ImportRun,
  record: BundleRecord<"backupSchedules">,
): Promise<string> {
  const label = `Backup schedule ${record.folder}`;
  const serviceId = run.id("services", record.serviceRef);
  const destinationId = run.id("destinations", record.destinationRef);
  if (!serviceId) throw new NotImported(label, "its service wasn't imported.");
  if (!destinationId) throw new NotImported(label, "its backup destination wasn't imported.");
  const service = await run.db
    .selectFrom("service")
    .select(["workspace_id", "server_id", "name"])
    .where("id", "=", serviceId)
    .executeTakeFirstOrThrow();
  const destination = await run.db
    .selectFrom("backup_destination")
    .select("workspace_id")
    .where("id", "=", destinationId)
    .executeTakeFirstOrThrow();
  const named = `Backup schedule ${record.folder} of ${service.name}`;
  if (record.composeDatabase)
    throw new NotImported(
      named,
      DROPPED_SERVICE_SETTINGS.composeBackups ?? "Compose database backups aren't in 1.0.",
    );
  if (destination.workspace_id !== service.workspace_id)
    throw new NotImported(named, "its destination belongs to another workspace.");
  if (!parseCron(record.cron).ok)
    throw new NotImported(named, `its schedule (${record.cron}) isn't one 1.0 can read.`);
  const kind =
    record.kind.trim().toLowerCase() === "volume"
      ? "volume"
      : record.kind.trim().toLowerCase() === "database"
        ? "database"
        : null;
  if (!kind) throw new NotImported(named, `its kind "${record.kind}" isn't Database or Volume.`);
  if (kind === "volume" && !record.volume) throw new NotImported(named, "it names no volume.");
  const zone = await serverTimeZone(run.db, service.server_id);
  // 0.1.x ran a schedule without a zone in UTC (29a.5.17); 1.0 runs it in the server's (G3-21).
  const was = record.timeZone ? usableTimeZone(record.timeZone) : "UTC";
  const known = await reportedTimeZone(run.db, service.server_id);
  if (known === null) {
    run.changed(
      "backupSchedules",
      named,
      `${named}: 0.1.x ran "${record.cron}" in ${was}. 1.0 runs backups in their server's time zone, which this server hasn't reported yet: if it isn't ${was}, check the schedule's time once the server connects.`,
    );
  } else if (was !== zone) {
    run.changed(
      "backupSchedules",
      named,
      `${named}: 1.0 runs backups in their server's time zone (${zone}), so "${record.cron}" now runs in ${zone} instead of ${was}.`,
    );
  }
  const folder = record.folder.trim().replace(/^\/+|\/+$/g, "");
  const volumeName = kind === "volume" ? (record.volume as string) : null;
  const innerService =
    record.innerService && INNER_SERVICE.test(record.innerService) ? record.innerService : null;
  // Volumes' schedules may share a folder, one per volume; a database has one per folder (G3-20).
  const taken = await run.db
    .selectFrom("backup_schedule")
    .select("id")
    .where("service_id", "=", serviceId)
    .where("destination_id", "=", destinationId)
    .where(sql<boolean>`coalesce(inner_service, '') = ${innerService ?? ""}`)
    .where("folder", "=", folder)
    .where(sql<boolean>`coalesce(volume_name, '') = ${volumeName ?? ""}`)
    .executeTakeFirst();
  if (taken) {
    throw new NotImported(
      named,
      kind === "volume"
        ? `another schedule of ${service.name} already backs up the volume ${volumeName} to the folder "${folder || "(none)"}" on that destination, and 1.0 keeps one per volume and folder. Its files stay there and are listed under the kept schedule.`
        : `another schedule of ${service.name} already writes its database backups to the folder "${folder || "(none)"}" on that destination, and 1.0 keeps one database schedule per folder. Its files stay there and are listed under the kept schedule; add it again with another folder after the move.`,
    );
  }
  const enabled = record.enabled !== false;
  const created = await run.db
    .insertInto("backup_schedule")
    .values({
      workspace_id: service.workspace_id,
      service_id: serviceId,
      destination_id: destinationId,
      kind,
      database_name: kind === "database" ? (record.database ?? null) : null,
      volume_name: volumeName,
      inner_service: innerService,
      stop_service: record.stopWhileCopying === true,
      // 0.1.x's files stay where they are: in this folder (none: straight under the app name),
      // and they count as this schedule's for listing, restoring and Keep N (R2-06, R3-44), a
      // volume's only when they are of its volume (C1-12).
      folder,
      legacy_files: true,
      cron: record.cron,
      keep: record.keep && record.keep >= 1 && record.keep <= 1000 ? record.keep : null,
      enabled,
      next_run_at: enabled ? nextRunFor(record.cron, zone) : null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return created.id;
}

async function importTask(run: ImportRun, record: BundleRecord<"tasks">): Promise<string> {
  const label = `Task ${record.name}`;
  const place = record.place ?? {};
  let where: "container" | "server" | "host" = "host";
  let workspaceId: string | null = null;
  let serviceId: string | null = null;
  let serverId: string | null = null;
  if (place.serviceRef) {
    serviceId = run.id("services", place.serviceRef) ?? null;
    if (!serviceId) throw new NotImported(label, "its service wasn't imported.");
    workspaceId = (
      await run.db
        .selectFrom("service")
        .select("workspace_id")
        .where("id", "=", serviceId)
        .executeTakeFirstOrThrow()
    ).workspace_id;
    where = "container";
  } else if (place.serverRef) {
    serverId = run.id("servers", place.serverRef) ?? null;
    if (!serverId) throw new NotImported(label, "its server wasn't imported.");
    workspaceId = (
      await run.db
        .selectFrom("server")
        .select("workspace_id")
        .where("id", "=", serverId)
        .executeTakeFirstOrThrow()
    ).workspace_id;
    where = "server";
  }
  // Host tasks belong to no workspace in 1.0, but to the instance administrator who made them:
  // their 0.1.x owner when that person moved, else the person who ran the move, the install's
  // owner, once the move has settled who that is (spec 12.4, spec 30 "Host tasks belong to their
  // creator").
  const movedOwner = where === "host" ? run.id("people", record.ownerRef) : undefined;
  const ownerId = where === "host" ? (movedOwner ?? (await provisionalOwner(run, record))) : null;
  if (where === "host" && !ownerId)
    throw new NotImported(label, "nobody on this install can own a Nearzero host task yet.");
  if (!parseCron(record.cron).ok)
    throw new NotImported(label, `its schedule (${record.cron}) isn't one 1.0 can read.`);
  const script = record.script.replace(/\r\n?/g, "\n");
  if (textBytes(script) > 65_536) throw new NotImported(label, "its script is larger than 64 KB.");
  let shell: "bash" | "sh" = record.shell === "sh" ? "sh" : "bash";
  if (where !== "container" && shell !== "bash") {
    shell = "bash";
    run.changed("tasks", record.name, `${label}: tasks on a server run with bash in 1.0.`);
  }
  const zone = usableTimeZone(record.timeZone ?? "UTC");
  const enabled = record.enabled !== false;
  const created = await run.db
    .insertInto("task")
    .values({
      workspace_id: workspaceId,
      name: record.name.trim().slice(0, 100),
      description: (record.description ?? "").slice(0, 500),
      place: where,
      service_id: serviceId,
      inner_service:
        where === "container" && place.innerService && INNER_SERVICE.test(place.innerService)
          ? place.innerService
          : null,
      server_id: serverId,
      shell,
      cron: record.cron,
      time_zone: zone,
      script,
      enabled,
      next_run_at: enabled ? nextRunFor(record.cron, zone) : null,
      owner_id: ownerId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (where === "host" && !movedOwner) run.unownedHostTasks.push(created.id);
  return created.id;
}

/**
 * Who holds a moved host task whose 0.1.x owner wasn't moved until the move settles the
 * install's owner (settleHostTaskOwners): the owner of the bundle's first workspace, else this
 * install's owner, else the owner of the task's own workspace.
 */
async function provisionalOwner(
  run: ImportRun,
  record: BundleRecord<"tasks">,
): Promise<string | null> {
  const firstWorkspaceOwner = async (workspaceId: string | null | undefined) =>
    workspaceId
      ? ((
          await run.db
            .selectFrom("workspace")
            .select("created_by")
            .where("id", "=", workspaceId)
            .executeTakeFirst()
        )?.created_by ?? null)
      : null;
  return (
    (await firstWorkspaceOwner(run.firstWorkspaceId)) ??
    (await installOwner(run)) ??
    (await firstWorkspaceOwner(run.id("workspaces", record.workspaceRef)))
  );
}

/** The owner of the install's first workspace: who administers Nearzero. */
async function installOwner(run: ImportRun): Promise<string | null> {
  const row = await run.db
    .selectFrom("install_state as s")
    .innerJoin("membership as m", (join) =>
      join.onRef("m.workspace_id", "=", "s.first_workspace_id").on("m.role", "=", "owner"),
    )
    .select("m.person_id")
    .executeTakeFirst();
  return row?.person_id ?? null;
}

/**
 * Once memberships and the install's first workspace are settled: moved host tasks whose 0.1.x
 * owner wasn't moved go to the person who ran the move, the install's owner (spec 30 R3-29).
 */
export async function settleHostTaskOwners(run: ImportRun): Promise<void> {
  if (run.unownedHostTasks.length === 0) return;
  const owner = await installOwner(run);
  if (!owner) return;
  await run.db
    .updateTable("task")
    .set({ owner_id: owner })
    .where("id", "in", run.unownedHostTasks)
    .where("place", "=", "host")
    .execute();
}

// ---- Agent sessions and deployments

async function importAgentSession(
  run: ImportRun,
  record: BundleRecord<"agentSessions">,
): Promise<string> {
  const label = `Agent session ${record.title ?? record.ref}`;
  const workspaceId = run.id("workspaces", record.workspaceRef);
  if (!workspaceId) throw new NotImported(label, "its workspace wasn't imported.");
  let authorId = run.id("people", record.authorRef) ?? null;
  let shared = record.shared === true;
  if (!authorId) {
    // Unknown author: the workspace's owner keeps it, shared with the workspace (spec 29.4).
    const owner = await run.db
      .selectFrom("membership")
      .select("person_id")
      .where("workspace_id", "=", workspaceId)
      .where("role", "=", "owner")
      .executeTakeFirst();
    if (!owner) throw new NotImported(label, "it has no author and its workspace has no owner.");
    authorId = owner.person_id;
    shared = true;
  }
  const at = (value: string | null | undefined, fallback: Date) => validDate(value) ?? fallback;
  const createdAt = at(record.createdAt, new Date());
  const title = record.title?.trim().slice(0, 80) || null;
  const session = await run.db
    .insertInto("agent_session")
    .values({
      workspace_id: workspaceId,
      author_id: authorId,
      title,
      title_source: title ? "generated" : null,
      shared,
      created_at: createdAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  // Each person's message opens a turn; the Agent's answers until the next one are its text, with
  // its steps in words (tool inputs and outputs aren't carried, 29a.5.20).
  type Turn = { text: string; at: Date; answers: string[]; steps: string[]; last: Date };
  const turns: Turn[] = [];
  for (const message of record.messages ?? []) {
    const when = at(message.createdAt, createdAt);
    const person = message.role.trim().toLowerCase() === "person";
    if (person || turns.length === 0) {
      turns.push({
        text: person ? (message.text ?? "") : "",
        at: when,
        answers: [],
        steps: [],
        last: when,
      });
      if (person) {
        if ((message.attachments ?? 0) > 0) {
          const turn = turns.at(-1) as Turn;
          turn.text = `${turn.text}${turn.text ? "\n\n" : ""}(${message.attachments} attachment${message.attachments === 1 ? "" : "s"} not carried over)`;
        }
        continue;
      }
    }
    const turn = turns.at(-1) as Turn;
    if ((message.text ?? "").trim() !== "") turn.answers.push(message.text as string);
    for (const step of message.steps ?? []) {
      if (step.action)
        turn.steps.push(
          step.outcome && step.outcome !== "Done"
            ? `${step.action} (${step.outcome.toLowerCase()})`
            : step.action,
        );
    }
    turn.last = when;
  }
  for (const turn of turns) {
    const answer = [
      ...turn.answers,
      ...(turn.steps.length > 0
        ? [`Steps:\n${turn.steps.map((step) => `- ${step}`).join("\n")}`]
        : []),
    ].join("\n\n");
    const message = await run.db
      .insertInto("agent_message")
      .values({ session_id: session.id, author_id: authorId, text: turn.text, created_at: turn.at })
      .returning("id")
      .executeTakeFirstOrThrow();
    const created = await run.db
      .insertInto("agent_turn")
      .values({
        session_id: session.id,
        workspace_id: workspaceId,
        person_id: authorId,
        message_id: message.id,
        state: "finished",
        answer_text: answer,
        created_at: turn.at,
        finished_at: turn.last,
        closed_at: turn.last,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    // What the model sees of the conversation next time (text only, no tool payloads).
    await run.db
      .insertInto("agent_model_item")
      .values([
        {
          session_id: session.id,
          turn_id: created.id,
          item: JSON.stringify({ role: "user", text: turn.text, fileIds: [] }),
        },
        {
          session_id: session.id,
          turn_id: created.id,
          item: JSON.stringify({ role: "assistant", text: answer, toolCalls: [] }),
        },
      ])
      .execute();
  }
  const last = turns.at(-1)?.last ?? null;
  if (last)
    await run.db
      .updateTable("agent_session")
      .set({ last_message_at: last })
      .where("id", "=", session.id)
      .execute();
  return session.id;
}

async function importDeployment(
  run: ImportRun,
  record: BundleRecord<"deployments">,
): Promise<string> {
  const serviceId = run.id("services", record.serviceRef);
  const label = `Deployment ${record.title || record.ref}`;
  if (!serviceId) throw new NotImported(label, "its service wasn't imported.");
  const service = await run.db
    .selectFrom("service as s")
    .innerJoin("project as p", "p.id", "s.project_id")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .leftJoin("server as v", "v.id", "s.server_id")
    .select([
      "s.workspace_id",
      "s.project_id",
      "s.environment_id",
      "s.kind",
      "s.name",
      "s.app_name",
      "s.server_id",
      "p.name as project_name",
      "e.name as environment_name",
      "v.name as server_name",
    ])
    .where("s.id", "=", serviceId)
    .executeTakeFirstOrThrow();
  // History only: the move makes the deployment that runs on 1.0, so none of these is active.
  const status = deploymentStatusNamed(record.status) ?? "cancelled";
  const log = record.logMissing ? "" : (record.log ?? "");
  const lines = log === "" ? [] : log.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");
  const created = await run.db
    .insertInto("deployment")
    .values({
      workspace_id: service.workspace_id,
      service_id: serviceId,
      project_id: service.project_id,
      environment_id: service.environment_id,
      service_kind: service.kind,
      service_name: service.name,
      app_name: service.app_name,
      project_name: service.project_name,
      environment_name: service.environment_name,
      server_id: service.server_id,
      server_name: service.server_name ?? "Nearzero host",
      status,
      trigger: deploymentTriggerNamed(record.trigger) ?? "manual",
      title: (record.title ?? "").slice(0, 500),
      commit_hash: record.commit ?? null,
      error:
        status === "cancelled" && !record.error
          ? "Stopped by the move to Nearzero 1.0."
          : (record.error ?? null),
      log_bytes: textBytes(log),
      log_lines: lines.length,
      log_truncated: record.logTruncated === true,
      ...(validDate(record.createdAt) ? { created_at: validDate(record.createdAt) as Date } : {}),
      started_at: validDate(record.startedAt),
      finished_at: validDate(record.finishedAt) ?? validDate(record.createdAt),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (let at = 0; at < lines.length; at += 500) {
    await run.db
      .insertInto("deployment_log")
      .values(
        lines
          .slice(at, at + 500)
          .map((line, index) => ({ deployment_id: created.id, seq: at + index + 1, text: line })),
      )
      .execute();
  }
  return created.id;
}

/** Agent sessions, after members: a session without a known author goes to the workspace's owner. */
export async function importAgentSessions(run: ImportRun): Promise<void> {
  await run.each("agentSessions", (record) => importAgentSession(run, record));
}

export async function importProjects(run: ImportRun): Promise<void> {
  await run.each("projects", (record) => importProject(run, record));
  await run.each("environments", (record) => importEnvironment(run, record));
  await run.each("services", (record) => importService(run, record));
  await run.each("hostnames", (record) => importHostname(run, record));
  await run.each("backupSchedules", (record) => importBackupSchedule(run, record));
  await run.each("tasks", (record) => importTask(run, record));
  if (run.options.deployments !== false) {
    await run.each("deployments", (record) => importDeployment(run, record));
  }
}

// ---- The move plan

/**
 * One row per service imported now, in the order the move redeploys them: the Nearzero host
 * first, then each server, and on each, the service deployed longest ago first (spec 29.2 step 5).
 * Services that can't be redeployed are listed with why and left as they are.
 */
export async function planMoves(run: ImportRun): Promise<number> {
  if (run.moves.length === 0) return 0;
  const targets = new Map<string, { name: string; earliest: number }>();
  for (const move of run.moves) {
    const entry = targets.get(move.target) ?? {
      name: move.targetName,
      earliest: Number.POSITIVE_INFINITY,
    };
    entry.earliest = Math.min(entry.earliest, move.lastDeployedAt ?? Number.POSITIVE_INFINITY);
    targets.set(move.target, entry);
  }
  const order = [...targets].sort(([a, left], [b, right]) => {
    if (a === "host") return -1;
    if (b === "host") return 1;
    return left.earliest - right.earliest || left.name.localeCompare(right.name);
  });
  let serverPosition =
    (
      await run.db
        .selectFrom("migration_server_move")
        .select(sql<number>`coalesce(max(position), 0)`.as("n"))
        .executeTakeFirst()
    )?.n ?? 0;
  let position =
    (
      await run.db
        .selectFrom("migration_move")
        .select(sql<number>`coalesce(max(position), 0)`.as("n"))
        .executeTakeFirst()
    )?.n ?? 0;
  let waiting = 0;
  for (const [target, info] of order) {
    serverPosition++;
    await run.db
      .insertInto("migration_server_move")
      .values({
        target,
        import_id: run.importId,
        position: serverPosition,
        legacy:
          run.options.inPlace && run.serverLegacy.has(target)
            ? JSON.stringify(run.serverLegacy.get(target))
            : null,
      })
      .onConflict((conflict) => conflict.column("target").doNothing())
      .execute();
    const services = run.moves
      .filter((move) => move.target === target)
      .sort(
        (a, b) =>
          (a.lastDeployedAt ?? Number.POSITIVE_INFINITY) -
          (b.lastDeployedAt ?? Number.POSITIVE_INFINITY),
      );
    for (const move of services) {
      position++;
      const why = move.why;
      const skipped = !move.deployable;
      const reason = skipped
        ? (why ?? "It wasn't deployed on 0.1.x, so it stays undeployed until you deploy it.")
        : null;
      await run.db
        .insertInto("migration_move")
        .values({
          service_id: move.serviceId,
          import_id: run.importId,
          target,
          position,
          legacy: run.options.inPlace && move.legacy ? JSON.stringify(move.legacy) : null,
          state: skipped ? "skipped" : "waiting",
          reason,
        })
        .execute();
      if (skipped) {
        if (why)
          run.changed(
            "services",
            move.name,
            `${move.name} on ${info.name} won't be redeployed: ${why}`,
          );
      } else {
        waiting++;
        run.report.moves.push({ service: move.name, server: info.name });
      }
    }
  }
  await run.db
    .insertInto("migration_state")
    .values({ phase: "imported" })
    .onConflict((conflict) =>
      conflict.column("singleton").doUpdateSet({ phase: "imported", updated_at: new Date() }),
    )
    .execute();
  return waiting;
}
