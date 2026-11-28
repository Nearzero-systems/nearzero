import { createHash } from "node:crypto";
import {
  BUILDER_LABELS,
  cleanContainerOutput,
  DATABASE_START_SECONDS,
  type DatabaseKind,
  FILE_MOUNT_MAX_CHARS,
  FILE_MOUNT_TOO_LARGE,
  formatBytes,
  GIT_PROVIDER_LABELS,
  HOST_RESERVED_PORTS,
  isDatabaseKind,
  NEARZERO_LABELS,
  type PortMapping,
  PRIVATE_NETWORK,
  type RouteSpec,
  reservedPortMessage,
  SERVER_RESERVED_PORTS,
  SERVICE_KIND_LABELS,
} from "@nearzero/shared";
import { sql } from "kysely";
import { composePublishedPorts } from "../compose-runtime/plan.ts";
import type { Db } from "../db/database.ts";
import { providerCloneAccess } from "../git-providers/sources.ts";
import { removeRoute, upsertRoute } from "../routing/routes.ts";
import { HOST_TARGET, RunnerCommandError } from "../runners/hub.ts";
import { syncPublishedPorts } from "../servers/firewall.ts";
import {
  type AppSecrets,
  type AppSettings,
  type AppSource,
  mountVolume,
  readAppSettings,
  readSource,
  registryHost,
} from "../service-runtime/app-settings.ts";
import {
  type DatabaseSecrets,
  databaseContainer,
  mongoReplicaSetInit,
  readDatabaseSettings,
  readinessCheck,
} from "../service-runtime/databases.ts";
import {
  type AppDefinition,
  appMountWarnings,
  HOST_WITHDRAWN,
  hostMountDecision,
  recordMountApproval,
  workspaceMayUseHost,
} from "../service-runtime/host-mounts.ts";
import { Cancelled, type ServerOps } from "../service-runtime/server-ops.ts";
import { copiesOf, loadService, secretsContext } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { cloneUpload, uploadOwner } from "../sources/uploads.ts";
import { openPrivateKey } from "../ssh-keys/keys.ts";
import { variablesForDeploy } from "../variables/deploy.ts";
import { isInstanceAdmin } from "../workspaces/workspaces.ts";
import { HEALTH_RELOAD_LINE, HEALTH_RELOAD_TITLE } from "./health-watch.ts";
import type { DeployLog } from "./log.ts";
import type { DeployOutcome } from "./queue.ts";
import type { DeploymentRow } from "./records.ts";
import { chooseServicePort } from "./service-port.ts";

/**
 * One deploy, start to end (spec 6.5, 8.1, 23.1): fetch the source (clone at the commit, unpack
 * the upload, or pull the image), build on the service's own server, start the new container on
 * the private network with its resolved variables, wait until it is running and stays up, then
 * route traffic to it and stop the old one. Any failure before the switch leaves the old version
 * serving; a container that exits or never becomes healthy fails the deploy with its last output.
 *
 * Databases can't share their data volume between two containers, so their old container stops
 * first (and starts again when the new one doesn't come up).
 */

/** A deploy that can't go on, with words for the log and the deployment's error. */
export class DeployFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeployFailure";
  }
}

export interface PipelineContext {
  services: ControlServices;
  deployment: DeploymentRow;
  log: DeployLog;
  ops: ServerOps;
}

/**
 * How long a deploy keeps the old version running after the router was given the new route
 * (spec 6.5, 23.1). Traefik's file provider reloads at most once every 2 seconds, so a route
 * written just after another change can take that long to serve.
 */
export const cutover = { routeSwitchMs: 3_000 };

export const NO_SOURCE =
  "This application has no source yet. Choose a Git repository, an image or an upload on its Overview tab, then deploy.";

type FullService = NonNullable<Awaited<ReturnType<typeof loadService>>> & {
  secrets_sealed: string | null;
};

async function loadFullService(db: Db, deployment: DeploymentRow): Promise<FullService> {
  if (!deployment.service_id) throw new DeployFailure("This service was deleted.");
  const row = await loadService(db, deployment.workspace_id, deployment.service_id);
  if (!row) throw new DeployFailure("This service was deleted.");
  const sealed = await db
    .selectFrom("service")
    .select("secrets_sealed")
    .where("id", "=", row.id)
    .executeTakeFirstOrThrow();
  return { ...row, secrets_sealed: sealed.secrets_sealed };
}

function openSecrets<T>(services: ControlServices, service: FullService): T | null {
  if (!service.secrets_sealed) return null;
  const opened = services.secrets.open(service.secrets_sealed, secretsContext(service.id));
  if (!opened.ok) {
    throw new DeployFailure(
      "This service's saved secrets were sealed with another install secret and can't be read any more. Enter them again, then deploy.",
    );
  }
  return JSON.parse(opened.value) as T;
}

async function setFields(
  db: Db,
  deploymentId: string,
  fields: Partial<{
    title: string;
    commit_hash: string;
    builder: string;
    framework: string | null;
    image: string;
    source: string;
  }>,
): Promise<void> {
  await db
    .updateTable("deployment")
    .set({ ...fields, updated_at: sql<Date>`now()` })
    .where("id", "=", deploymentId)
    .execute();
}

/** Where the deployment's code came from, for the detail page (no secrets, no tokens). */
export function describeSource(source: AppSource): Record<string, unknown> {
  switch (source.type) {
    case "git": {
      const host = /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?([^:/]+)/.exec(source.url)?.[1] ?? null;
      return {
        type: "git",
        provider: host,
        repository: source.url,
        branch: source.branch,
        path: source.buildPath || "/",
      };
    }
    case "provider":
      return {
        type: "git",
        provider: GIT_PROVIDER_LABELS[source.provider],
        repository: source.repository,
        branch: source.branch,
        path: source.buildPath || "/",
      };
    case "image":
      return {
        type: "image",
        provider: "Image",
        repository: source.image,
        branch: null,
        path: null,
      };
    case "upload":
      return {
        type: "upload",
        provider: "Upload",
        repository: source.upload?.fileName ?? null,
        branch: null,
        path: source.buildPath || "/",
        uploadId: source.upload?.id ?? null,
      };
  }
}

/** The route's file name on the server: stable for a service, hostname and path. */
export function routeKey(serviceId: string, host: string, path: string): string {
  const digest = createHash("sha256").update(`${host.toLowerCase()}${path}`).digest("hex");
  return `s-${serviceId}-${digest.slice(0, 8)}`;
}

export function routePrefix(serviceId: string): string {
  return `s-${serviceId}-`;
}

/** Ports another service on the same server already publishes, or Nearzero needs (spec 6.8). */
export async function portConflicts(
  db: Db,
  service: { id: string; server_id: string | null },
  ports: readonly PortMapping[],
): Promise<string[]> {
  const problems: string[] = [];
  const reserved = new Set<number>([
    ...SERVER_RESERVED_PORTS,
    ...(service.server_id === null ? HOST_RESERVED_PORTS : []),
  ]);
  for (const port of ports) {
    if (reserved.has(port.publishedPort)) problems.push(reservedPortMessage(port.publishedPort));
  }
  let query = db
    .selectFrom("service")
    .select(["id", "name", "kind", "settings", "public_port", "app_name"])
    .where("id", "!=", service.id);
  query =
    service.server_id === null
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", service.server_id);
  const others = await query.execute();
  for (const other of others) {
    const taken: { port: number; protocol: string }[] = [];
    if (other.public_port !== null) taken.push({ port: other.public_port, protocol: "tcp" });
    if (other.kind === "application") {
      for (const port of readAppSettings(other.settings).ports) {
        taken.push({ port: port.publishedPort, protocol: port.protocol });
      }
    } else if (other.kind === "compose") {
      // What Compose files publish counts too (B1-29).
      for (const port of composePublishedPorts(other.settings, other.app_name)) {
        taken.push(port);
      }
    }
    for (const port of ports) {
      if (
        taken.some((item) => item.port === port.publishedPort && item.protocol === port.protocol)
      ) {
        problems.push(
          `Port ${port.publishedPort}/${port.protocol.toUpperCase()} is already published by "${other.name}" on this server. Pick another port.`,
        );
      }
    }
  }
  return problems;
}

function registryAuth(source: Extract<AppSource, { type: "image" }>, secrets: AppSecrets | null) {
  const registry = source.registry;
  if (!registry?.username || !secrets?.registryPassword) return undefined;
  const host = registry.address || registryHost(source.image, "");
  return Buffer.from(
    JSON.stringify({
      username: registry.username,
      password: secrets.registryPassword,
      serveraddress: host,
    }),
  ).toString("base64url");
}

/** A copy without a source takes its group's at its first deploy (spec 5.4). */
async function adoptGroupSource(
  ctx: PipelineContext,
  service: FullService,
): Promise<AppSource | null> {
  const copies = await copiesOf(ctx.services.db, service);
  for (const copy of copies) {
    const source = readSource(copy.settings?.source);
    if (!source) continue;
    const adopted: AppSource =
      source.type === "image" && source.registry
        ? { ...source, registry: { ...source.registry, passwordSet: false } }
        : source;
    await ctx.services.db
      .updateTable("service")
      .set({
        settings: JSON.stringify({ ...(service.settings ?? {}), source: adopted }),
        updated_at: new Date(),
      })
      .where("id", "=", service.id)
      .execute();
    ctx.log.line(
      `This copy had no source yet, so it uses the source of ${copy.name} in ${copy.environment_name}.`,
    );
    return adopted;
  }
  return null;
}

/**
 * An upload source whose archive belongs to another service (a copy, or a source a copy took
 * from its group) gets an archive of its own first (B1-30), so the original's next upload or
 * delete never takes away what this one builds from.
 */
async function ownArchive(
  ctx: PipelineContext,
  service: FullService,
  source: Extract<AppSource, { type: "upload" }>,
): Promise<Extract<AppSource, { type: "upload" }>> {
  if (!source.upload) return source;
  const owner = await uploadOwner(ctx.services.db, source.upload.id);
  if (owner === null || owner === service.id) return source;
  const id = await cloneUpload(ctx.services.db, source.upload.id, {
    serviceId: service.id,
    workspaceId: service.workspace_id,
  });
  if (!id) return source;
  const own = { ...source, upload: { ...source.upload, id } };
  await ctx.services.db
    .updateTable("service")
    .set({
      settings: sql`jsonb_set(coalesce(settings, '{}'::jsonb), '{source}', ${JSON.stringify(own)}::jsonb)`,
      updated_at: new Date(),
    })
    .where("id", "=", service.id)
    .execute();
  ctx.log.line(`This service now keeps its own copy of ${source.upload.fileName}.`);
  return own;
}

async function resolveVariables(
  ctx: PipelineContext,
  serviceId: string,
  target: "runtime" | "build",
): Promise<Record<string, string>> {
  const result = await variablesForDeploy(ctx.services.db, ctx.services.secrets, serviceId, target);
  if (!result.ok) {
    for (const error of result.errors) ctx.log.line(error.message);
    const names = result.errors.map((error) => error.reference ?? error.name).filter(Boolean);
    throw new DeployFailure(
      names.length
        ? `A variable couldn't be resolved: ${names.join(", ")}. Fix it on the Variables tab, then deploy again.`
        : (result.errors[0]?.message ?? "The variables couldn't be read."),
    );
  }
  const out: Record<string, string> = {};
  for (const variable of result.variables) out[variable.name] = variable.value;
  return out;
}

interface WaitResult {
  ok: boolean;
  reason?: string;
}

/**
 * Waits until the container runs and keeps running for the stability window (spec 23.1): the
 * window starts when it is actually running, and a health check, when the image has one, must
 * pass first. A restart or exit during the window fails.
 */
async function waitStable(
  ops: ServerOps,
  id: string,
  stabilitySeconds: number,
  log: DeployLog,
  options: { startSeconds: number; ready?: () => Promise<boolean> },
): Promise<WaitResult> {
  const begun = Date.now();
  let since: number | null = null;
  let startedAt = "";
  let restarts = 0;
  let readyAt: number | null = options.ready ? null : 0;
  let announced = false;
  for (;;) {
    ops.checkCancelled();
    const info = await ops.inspect(id);
    if (!info) return { ok: false, reason: "The new container disappeared." };
    if (info.health === "unhealthy") {
      return { ok: false, reason: "The new version failed its health check." };
    }
    if (info.state === "restarting") {
      return {
        ok: false,
        reason: `The new version exited with code ${info.exitCode} and kept restarting.`,
      };
    }
    if (!info.running) {
      if (info.state === "created" && Date.now() - begun < options.startSeconds * 1000) {
        await Bun.sleep(1000);
        continue;
      }
      return {
        ok: false,
        reason: info.oomKilled
          ? "The new version ran out of memory and was stopped."
          : `The new version exited with code ${info.exitCode}.`,
      };
    }
    if (since === null) {
      since = Date.now();
      startedAt = info.startedAt;
      restarts = info.restartCount;
    } else if (info.startedAt !== startedAt || info.restartCount !== restarts) {
      return {
        ok: false,
        reason: `The new version exited${info.exitCode ? ` with code ${info.exitCode}` : ""} and restarted right after it started.`,
      };
    }
    const healthy = info.health === null || info.health === "healthy";
    if (healthy && readyAt === null && options.ready && (await options.ready())) {
      readyAt = Date.now();
    }
    const readySince = readyAt === 0 ? since : readyAt;
    if (healthy && readySince !== null) {
      if (!announced && stabilitySeconds > 0) {
        announced = true;
        log.line(
          `The new version is running; checking that it stays up for ${stabilitySeconds} seconds.`,
        );
      }
      if (Date.now() - readySince >= stabilitySeconds * 1000) return { ok: true };
    }
    const limit = options.ready ? options.startSeconds : Math.max(300, options.startSeconds);
    if (Date.now() - since > limit * 1000 && (readySince === null || !healthy)) {
      return {
        ok: false,
        reason: options.ready
          ? `The new version didn't become ready within ${options.startSeconds} seconds.`
          : "The new version never became healthy.",
      };
    }
    await Bun.sleep(1000);
  }
}

/**
 * The end of a failed start: the reason, then the container's last output, cleaned of the
 * service's variable values, logins in connection strings and escape codes (31b G2-01), since
 * everyone who sees the deployments reads it, variables or not (spec 11.4, 23.4).
 */
async function failStart(
  ctx: PipelineContext,
  id: string,
  reason: string,
  values: Iterable<string>,
): Promise<never> {
  const output = cleanContainerOutput(await ctx.ops.lastOutput(id, 100).catch(() => ""), values);
  ctx.log.line(reason);
  if (output.trim()) {
    ctx.log.line("Its last output:");
    ctx.log.line(output);
  } else {
    ctx.log.line("It printed nothing before it stopped.");
  }
  await ctx.ops.stopAndRemove(id, 5).catch(() => {});
  throw new DeployFailure(reason);
}

async function removeLeftovers(ctx: PipelineContext, serviceId: string): Promise<void> {
  const containers = await ctx.ops.serviceContainers(serviceId);
  for (const container of containers) {
    if (container.labels[NEARZERO_LABELS.deployment] === ctx.deployment.id) {
      await ctx.ops.stopAndRemove(container.id, 5);
    }
  }
}

/**
 * DNS notes go into the log when their lookups answer, after whatever steps came meanwhile (even
 * after the deploy finished); the deploy itself never waits for DNS.
 */
export function writeLateNotes(log: DeployLog, later: Promise<string[]> | undefined): void {
  if (!later) return;
  void later
    .then((lines) => {
      for (const line of lines) log.line(line);
      return log.flush();
    })
    .catch(() => {});
}

async function writeRoutes(
  ctx: PipelineContext,
  service: FullService,
  containerName: string,
  port: number,
): Promise<string[]> {
  const { services, log, ops } = ctx;
  const answer = await services.hostnameProviders.collect({
    serviceId: service.id,
    serverId: ops.target,
    port,
  });
  for (const note of answer.notes) log.line(note);
  writeLateNotes(log, answer.later);
  const keep = new Set<string>();
  const urls: string[] = [];
  for (const route of answer.routes) {
    const key = routeKey(service.id, route.host, route.path || "/");
    keep.add(key);
    await upsertRoute(services, ops.target, {
      key,
      hostnames: [route.host],
      path: route.path || "/",
      upstream: { host: containerName, port: route.port },
      certificate: route.https ? "letsencrypt" : "none",
    });
    urls.push(
      `${route.https ? "https" : "http"}://${route.host}${route.path === "/" ? "" : route.path}`,
    );
  }
  const stale = await services.db
    .selectFrom("router_route")
    .select(["key", "spec"])
    .where("target", "=", ops.target)
    .where("key", "like", `${routePrefix(service.id)}%`)
    .execute();
  for (const row of stale) {
    if (keep.has(row.key)) continue;
    if (answer.failed.length > 0) {
      // A provider that failed can't say which of its routes it still wants, so they all stay,
      // now sending visitors to the new container (spec 6.5, 23.1). The next deploy tidies up.
      const spec = row.spec as RouteSpec;
      await upsertRoute(services, ops.target, {
        ...spec,
        upstream: { ...spec.upstream, host: containerName },
      });
      continue;
    }
    await removeRoute(services, ops.target, row.key);
  }
  return urls;
}

/** Built images of this service beyond the last three successful deployments are removed. */
async function pruneImages(ctx: PipelineContext, service: FullService, current: string) {
  const kept = await ctx.services.db
    .selectFrom("deployment")
    .select("image")
    .where("service_id", "=", service.id)
    .where("status", "in", ["active", "previous", "not_running"])
    .where("image", "is not", null)
    .orderBy("finished_at", "desc")
    .limit(3)
    .execute();
  const keep = new Set([current, ...kept.map((row) => row.image as string)]);
  const images = (await ctx.ops.command("image.list", {
    labels: [],
    reference: [`nearzero/${service.app_name}`],
  })) as { id: string; tags: string[] }[];
  for (const image of images) {
    if (image.tags.some((tag) => keep.has(tag))) continue;
    for (const tag of image.tags) {
      await ctx.ops.command("image.remove", { image: tag, force: false }).catch(() => {});
    }
  }
}

/** The deployment a service's traffic goes to now (or went to before it was stopped). */
async function runningVersion(db: Db, serviceId: string) {
  return db
    .selectFrom("deployment")
    .select(["id", "image", "builder", "framework", "commit_hash", "source", "title"])
    .where("service_id", "=", serviceId)
    .where("status", "in", ["active", "not_running"])
    .orderBy("finished_at", "desc")
    .executeTakeFirst();
}

export const NOTHING_TO_RELOAD =
  "There's no built version to reload yet. Deploy the app first; Reload starts that version again with the saved settings.";

async function deployApplication(
  ctx: PipelineContext,
  service: FullService,
): Promise<DeployOutcome> {
  const { services, deployment, log, ops } = ctx;
  const { db } = services;
  const settings: AppSettings = readAppSettings(service.settings);
  const secrets = openSecrets<AppSecrets>(services, service);
  let source = settings.source;
  if (!source) source = await adoptGroupSource(ctx, service);
  if (!source) throw new DeployFailure(NO_SOURCE);
  if (source.type === "upload") source = await ownArchive(ctx, service, source);
  await setFields(db, deployment.id, { source: JSON.stringify(describeSource(source)) });

  const runtime = await resolveVariables(ctx, service.id, "runtime");
  const reload = deployment.trigger === "reload";
  const buildVariables =
    source.type === "image" || reload ? {} : await resolveVariables(ctx, service.id, "build");
  // A moved app's file can be larger than 1.0 takes (31d G4-16): said plainly, before anything
  // is fetched, built or stopped.
  for (const mount of settings.mounts) {
    const content = mount.type === "file" ? secrets?.files?.[mount.id] : undefined;
    if (content !== undefined && content.length > FILE_MOUNT_MAX_CHARS) {
      throw new DeployFailure(
        `The file mount at ${mount.containerPath} holds ${formatBytes(content.length)}. ${FILE_MOUNT_TOO_LARGE} Put the file in a volume, or make it smaller on the Advanced tab, then deploy.`,
      );
    }
  }
  // On the host, bind mounts need an approval of exactly what this deploy runs (C1-04).
  await hostMountChecks(ctx, service, {
    settings: { ...settings, source },
    files: secrets?.files ?? {},
    runtime,
    // A Reload builds nothing, but the approval covers the build variables too.
    build: source.type === "image" || !reload ? buildVariables : null,
  });
  const out = (text: string) => log.output(text);
  const short = deployment.id.slice(0, 8);
  let image: string;
  let builder = "image";
  /** What the image declares (EXPOSE); null for a Reload, whose image is the running one's. */
  let exposedPorts: string[] | null = null;
  const typedPort = settings.servicePortAuto ? null : settings.servicePort;

  if (reload) {
    // Reload (30b R2-02): the running version's image again, with the current variables,
    // mounts, ports and start command. Nothing is fetched or built.
    const running = await runningVersion(db, service.id);
    if (!running?.image) throw new DeployFailure(NOTHING_TO_RELOAD);
    const present = (await ops.command("image.list", {
      labels: [],
      reference: [running.image],
    })) as { tags: string[] }[];
    if (!present.some((item) => item.tags.includes(running.image as string))) {
      throw new DeployFailure(
        `The running version's image (${running.image}) isn't on the server any more, so it can't be reloaded. Deploy the app instead.`,
      );
    }
    // The health watch's replacement says why (31b G2-06).
    if (deployment.title === HEALTH_RELOAD_TITLE) log.line(HEALTH_RELOAD_LINE);
    log.line(
      `Reloading ${running.image} with the saved variables, mounts, ports and start command. Nothing is fetched or built.`,
    );
    image = running.image;
    builder = running.builder ?? "image";
    await setFields(db, deployment.id, {
      image,
      builder,
      framework: running.framework,
      ...(running.commit_hash ? { commit_hash: running.commit_hash } : {}),
      ...(running.source ? { source: JSON.stringify(running.source) } : {}),
    });
  } else if (source.type === "image") {
    log.line(`Pulling ${source.image}`);
    const auth = registryAuth(source, secrets);
    if (source.registry?.username && !auth) {
      log.line("The registry password isn't saved, so the image is pulled without signing in.");
    }
    // Pulled under Nearzero's own name and labels, so teardown and uninstall find it.
    const pulled = (await ops.stream(
      "image.pull",
      {
        image: source.image,
        ...(auth ? { registryAuth: auth } : {}),
        ownTag: `nearzero/${service.app_name}:${short}`,
        labels: {
          [NEARZERO_LABELS.service]: service.id,
          [NEARZERO_LABELS.deployment]: deployment.id,
        },
      },
      out,
      30 * 60_000,
    )) as { image: string; exposedPorts?: string[] };
    image = pulled.image;
    exposedPorts = pulled.exposedPorts ?? [];
  } else {
    if (source.type === "git" || source.type === "provider") {
      let sshPrivateKey: string | undefined;
      let url = source.type === "git" ? source.url : "";
      let httpAuth: { username: string; password: string } | undefined;
      if (source.type === "provider") {
        // A connected provider (spec 16): short-lived credentials, sent as a header only.
        const access = await providerCloneAccess(services, service.workspace_id, source).catch(
          (error: Error) => {
            throw new DeployFailure(error.message);
          },
        );
        url = access.url;
        httpAuth = { username: access.username, password: access.password };
      } else if (source.sshKeyId) {
        sshPrivateKey = await openPrivateKey(services, service.workspace_id, source.sshKeyId).catch(
          () => {
            throw new DeployFailure(
              "The SSH key this source uses is gone. Pick another key in the Git URL source, then deploy.",
            );
          },
        );
      }
      const fetched = (await ops.stream(
        "source.git",
        {
          appKey: service.app_name,
          url,
          branch: source.branch,
          ...(deployment.requested_commit ? { commit: deployment.requested_commit } : {}),
          ...(deployment.requested_tag ? { tag: deployment.requested_tag } : {}),
          ...(sshPrivateKey ? { sshPrivateKey } : {}),
          ...(httpAuth ? { httpAuth } : {}),
          submodules: source.submodules,
        },
        out,
        20 * 60_000,
      )) as { commit: string; subject: string };
      await setFields(db, deployment.id, {
        commit_hash: fetched.commit,
        title: fetched.subject.slice(0, 300) || deployment.title,
      });
    } else {
      if (!source.upload) {
        throw new DeployFailure("Upload a .zip archive of the app first, then deploy.");
      }
      await ops.stream(
        "source.archive",
        {
          appKey: service.app_name,
          uploadId: source.upload.id,
          sha256: source.upload.sha256,
          sizeBytes: source.upload.sizeBytes,
        },
        out,
        20 * 60_000,
      );
    }
    ops.checkCancelled();
    const noCache = deployment.clean_cache || settings.deploy.cleanCache;
    log.line(
      `Building with ${BUILDER_LABELS[settings.builder.type]}${noCache ? ", without cached layers" : ""}`,
    );
    const tag = `nearzero/${service.app_name}:${short}`;
    const built = (await ops.stream(
      "app.build",
      {
        appKey: service.app_name,
        buildPath: source.buildPath,
        builder: settings.builder,
        commands: settings.commands,
        buildEnv: buildVariables,
        // The port the Static builder's server listens on: 80 unless one was typed (R2-01).
        servicePort: typedPort ?? (settings.builder.type === "static" ? 80 : settings.servicePort),
        tags: [tag],
        labels: {
          [NEARZERO_LABELS.service]: service.id,
          [NEARZERO_LABELS.deployment]: deployment.id,
        },
        noCache,
      },
      out,
      60 * 60_000,
    )) as {
      image: string;
      builder: string;
      framework: string | null;
      notes: string[];
      exposedPorts?: string[];
    };
    for (const note of built.notes) log.line(note);
    image = built.image;
    builder = built.builder;
    exposedPorts = built.exposedPorts ?? [];
    await setFields(db, deployment.id, {
      image,
      builder: built.builder,
      framework: built.framework,
    });
    log.line(`Built ${image}`);
  }
  if (source.type === "image" && !reload) await setFields(db, deployment.id, { image, builder });
  ops.checkCancelled();

  // Where traffic goes in the container (R2-01): a typed port, else what the image declares.
  const chosen = chooseServicePort({
    typed: typedPort,
    mappings: settings.ports,
    exposed: exposedPorts,
    builder: settings.builder.type,
    previous: settings.servicePort,
  });
  const servicePort = chosen.port;
  log.line(`Service port ${servicePort}: ${chosen.why}.`);
  if (typedPort === null && servicePort !== settings.servicePort) {
    // Hostnames route to the service port, read from the settings (merged in, so nothing else
    // saved meanwhile is overwritten).
    await db
      .updateTable("service")
      .set({
        settings: sql`coalesce(settings, '{}'::jsonb) || jsonb_build_object('servicePort', ${servicePort}::int)`,
        updated_at: new Date(),
      })
      .where("id", "=", service.id)
      .execute();
  }

  const conflicts = await portConflicts(db, service, settings.ports);
  if (conflicts.length > 0) throw new DeployFailure(conflicts.join(" "));

  await removeLeftovers(ctx, service.id);
  const old = (await ops.serviceContainers(service.id)).filter(
    (container) => container.labels[NEARZERO_LABELS.deployment] !== deployment.id,
  );
  for (const mount of settings.mounts) {
    if (mount.type !== "volume") continue;
    await ops.command("volume.create", {
      name: mountVolume(service.app_name, mount),
      labels: { [NEARZERO_LABELS.service]: service.id },
    });
  }
  const files = settings.mounts.flatMap((mount) => {
    if (mount.type !== "file") return [];
    const content = secrets?.files?.[mount.id];
    if (content === undefined) {
      log.line(`The file mount at ${mount.containerPath} has no content saved, so it is left out.`);
      return [];
    }

    return [
      {
        path: mount.containerPath,
        content: Buffer.from(content).toString("base64"),
        mode: 0o644,
        uid: 0,
        gid: 0,
      },
    ];
  });
  const env = { PORT: String(servicePort), ...runtime };
  const startOverride =
    settings.commands.start && (source.type === "image" || builder === "dockerfile")
      ? { entrypoint: ["/bin/sh", "-c"], command: [settings.commands.start] }
      : {};
  const stopFirst = settings.ports.length > 0;
  const runningOld = old.filter((container) => container.state === "running");
  if (stopFirst && runningOld.length > 0) {
    log.line("This app publishes ports, so the running version stops before the new one starts.");
    for (const container of runningOld) {
      await ops.command("container.stop", { id: container.id, timeoutSeconds: 10 }, 40_000);
    }
  }
  const restoreOld = async () => {
    if (!stopFirst) return;
    for (const container of runningOld) {
      await ops.command("container.start", { id: container.id }).catch(() => {});
    }
    if (runningOld.length > 0) log.line("The previous version was started again.");
  };

  const containerName = `${service.app_name}-${short}`;
  log.line(`Starting ${containerName}`);
  let containerId: string;
  try {
    const created = (await ops.command("container.create", {
      name: containerName,
      image,
      env,
      labels: {
        [NEARZERO_LABELS.service]: service.id,
        [NEARZERO_LABELS.deployment]: deployment.id,
      },
      network: PRIVATE_NETWORK,
      networkAliases: [service.app_name],
      restartPolicy: "unless-stopped",
      mounts: settings.mounts.flatMap(
        (
          mount,
        ): { type: "volume" | "bind"; source: string; target: string; readOnly: boolean }[] =>
          mount.type === "volume"
            ? [
                {
                  type: "volume",
                  source: mountVolume(service.app_name, mount),
                  target: mount.containerPath,
                  readOnly: false,
                },
              ]
            : mount.type === "bind"
              ? [
                  {
                    type: "bind",
                    source: mount.hostPath,
                    target: mount.containerPath,
                    readOnly: mount.readOnly,
                  },
                ]
              : [],
      ),
      ports: settings.ports.map((port) => ({
        containerPort: port.containerPort,
        hostPort: port.publishedPort,
        protocol: port.protocol,
      })),
      files,
      ...startOverride,
    })) as { id: string };
    containerId = created.id;
    await ops.command("container.start", { id: containerId }, 120_000);
  } catch (error) {
    if (error instanceof Cancelled) {
      await removeLeftovers(ctx, service.id).catch(() => {});
      await restoreOld();
      throw error;
    }
    await removeLeftovers(ctx, service.id).catch(() => {});
    await restoreOld();
    throw new DeployFailure(`The new container couldn't start: ${(error as Error).message}`);
  }

  let waited: WaitResult;
  try {
    waited = await waitStable(ops, containerId, settings.deploy.stabilitySeconds, log, {
      startSeconds: 60,
    });
  } catch (error) {
    await ops.stopAndRemove(containerId, 5).catch(() => {});
    await restoreOld();
    throw error;
  }
  if (!waited.ok) {
    try {
      await failStart(
        ctx,
        containerId,
        waited.reason ?? "The new version didn't stay up.",
        // The service's own values; PORT is Nearzero's, and "listening on 3000" should stay.
        Object.values(runtime),
      );
    } finally {
      await restoreOld();
    }
  }

  let urls: string[];
  try {
    urls = await writeRoutes(ctx, service, containerName, servicePort);
  } catch (error) {
    await ops.stopAndRemove(containerId, 5).catch(() => {});
    await restoreOld();
    if (error instanceof Cancelled) throw error;
    throw new DeployFailure(
      `Traffic couldn't be switched to the new version: ${(error as Error).message}`,
    );
  }
  // The router applies a route file on its own time: at once when idle, up to its reload
  // throttle (2 seconds) after another change. The old version keeps answering until then.
  if (urls.length > 0 && !stopFirst && old.some((container) => container.state === "running")) {
    await Bun.sleep(cutover.routeSwitchMs);
  }
  for (const container of old) await ops.stopAndRemove(container.id, 10);
  if (old.length > 0) log.line("Stopped the previous version.");

  if (settings.pendingVolumeRemovals.length > 0) {
    // Only data nothing uses any more is deleted, and the log says what really happened (C1-10):
    // a volume mounted again, or mounted by another service on this server, is kept.
    const mountedNow = new Set(
      settings.mounts.flatMap((mount) =>
        mount.type === "volume" ? [mountVolume(service.app_name, mount)] : [],
      ),
    );
    const { volumesUsedElsewhere } = await import("../service-runtime/teardown.ts");
    const elsewhere = await volumesUsedElsewhere(services, {
      serviceId: service.id,
      serverId: service.server_id,
    });
    for (const volume of settings.pendingVolumeRemovals) {
      const user = elsewhere.get(volume);
      if (mountedNow.has(volume)) {
        log.line(`The volume ${volume} is mounted again, so its data was kept.`);
        continue;
      }
      if (user) {
        log.line(`The volume ${volume} is also used by ${user}, so its data was kept.`);
        continue;
      }
      try {
        await ops.command("volume.remove", { name: volume, force: true });
        log.line(`Deleted the data of the removed volume ${volume}.`);
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        if (error instanceof RunnerCommandError && error.runnerCode === "not_found") {
          log.line(`The removed volume ${volume} was already gone.`);
        } else if (/in use/i.test((error as Error).message)) {
          log.line(`The volume ${volume} is still in use by a container, so its data was kept.`);
        } else {
          log.line(
            `Couldn't delete the data of the removed volume ${volume}: ${(error as Error).message}. It stays on the server.`,
          );
        }
      }
    }
    await db
      .updateTable("service")
      .set({
        settings: sql`settings - 'pendingVolumeRemovals'`,
        updated_at: new Date(),
      })
      .where("id", "=", service.id)
      .execute();
  }
  await pruneImages(ctx, service, image).catch(() => {});

  if (urls.length > 0) {
    log.line(`Deployment complete. It's live at: ${urls.join(", ")}`);
  } else {
    log.line(
      "Deployment complete. This app has no domain yet, so it isn't reachable from the internet. Add a domain on its Settings tab to give it a public URL with HTTPS.",
    );
  }
  return { status: "active", containerName, image };
}

async function deployDatabase(ctx: PipelineContext, service: FullService): Promise<DeployOutcome> {
  const { services, deployment, log, ops } = ctx;
  const kind = service.kind as DatabaseKind;
  const settings = readDatabaseSettings(kind, service.settings, service.app_name);
  const secrets = openSecrets<DatabaseSecrets>(services, service);
  if (!secrets?.password) {
    throw new DeployFailure("This database has no password saved. Create it again.");
  }
  const variables = await resolveVariables(ctx, service.id, "runtime");
  const spec = databaseContainer(kind, settings, secrets);
  await setFields(db(ctx), deployment.id, {
    image: settings.image,
    builder: "image",
    source: JSON.stringify({
      type: "image",
      provider: SERVICE_KIND_LABELS[kind],
      repository: settings.image,
    }),
  });

  log.line(`Pulling ${settings.image}`);
  const pulled = (await ops.stream(
    "image.pull",
    {
      image: settings.image,
      ownTag: `nearzero/${service.app_name}:${deployment.id.slice(0, 8)}`,
      labels: {
        [NEARZERO_LABELS.service]: service.id,
        [NEARZERO_LABELS.deployment]: deployment.id,
      },
    },
    (text) => log.output(text),
    30 * 60_000,
  )) as { image: string };
  ops.checkCancelled();
  await ops.command("volume.create", {
    name: settings.dataVolume,
    labels: { [NEARZERO_LABELS.service]: service.id },
  });

  await removeLeftovers(ctx, service.id);
  const old = (await ops.serviceContainers(service.id)).filter(
    (container) => container.labels[NEARZERO_LABELS.deployment] !== deployment.id,
  );
  const runningOld = old.filter((container) => container.state === "running");
  if (runningOld.length > 0) {
    log.line("Stopping the running database so the new container can use its data.");
    for (const container of runningOld) {
      await ops.command("container.stop", { id: container.id, timeoutSeconds: 30 }, 60_000);
    }
  }
  const restoreOld = async () => {
    for (const container of runningOld) {
      await ops.command("container.start", { id: container.id }).catch(() => {});
    }
    if (runningOld.length > 0) log.line("The previous version was started again.");
  };

  const containerName = `${service.app_name}-${deployment.id.slice(0, 8)}`;
  log.line(`Starting ${containerName}`);
  let containerId: string;
  try {
    const created = (await ops.command("container.create", {
      name: containerName,
      image: pulled.image,
      env: { ...variables, ...spec.env },
      labels: {
        [NEARZERO_LABELS.service]: service.id,
        [NEARZERO_LABELS.deployment]: deployment.id,
      },
      network: PRIVATE_NETWORK,
      networkAliases: [service.app_name],
      restartPolicy: "unless-stopped",
      mounts: [
        { type: "volume", source: settings.dataVolume, target: spec.mountPath, readOnly: false },
      ],
      ports:
        service.public_port !== null
          ? [{ containerPort: settings.port, hostPort: service.public_port, protocol: "tcp" }]
          : [],
      files: spec.files,
      stopTimeoutSeconds: 30,
      ...(spec.command ? { command: spec.command } : {}),
    })) as { id: string };
    containerId = created.id;
    await ops.command("container.start", { id: containerId }, 120_000);
  } catch (error) {
    await removeLeftovers(ctx, service.id).catch(() => {});
    await restoreOld();
    if (error instanceof Cancelled) throw error;
    throw new DeployFailure(`The database couldn't start: ${(error as Error).message}`);
  }

  const check = readinessCheck(kind, settings, secrets);
  let waited: WaitResult;
  try {
    waited = await waitStable(ops, containerId, 3, log, {
      startSeconds: DATABASE_START_SECONDS,
      ...(check
        ? {
            ready: async () => {
              const result = await ops
                .execCapture(containerId, check.command, {
                  env: check.env,
                  timeoutSeconds: 10,
                  secrets: spec.secrets,
                })
                .catch(() => ({ exitCode: 1, output: "" }));
              return result.exitCode === 0;
            },
          }
        : {}),
    });
  } catch (error) {
    await ops.stopAndRemove(containerId, 5).catch(() => {});
    await restoreOld();
    throw error;
  }
  if (!waited.ok) {
    try {
      await failStart(ctx, containerId, waited.reason ?? "The database didn't stay up.", [
        ...Object.values(variables),
        ...Object.values(spec.env),
        secrets.password,
        ...(secrets.rootPassword ? [secrets.rootPassword] : []),
      ]);
    } finally {
      await restoreOld();
    }
  }
  if (kind === "mongodb" && settings.replicaSet) {
    const init = mongoReplicaSetInit(settings, secrets, service.app_name);
    const result = await ops.execCapture(containerId, init.command, {
      env: init.env,
      timeoutSeconds: 60,
      secrets: spec.secrets,
    });
    if (result.exitCode !== 0) {
      log.line(result.output.trim());
      await ops.stopAndRemove(containerId, 10).catch(() => {});
      await restoreOld();
      throw new DeployFailure(
        "The replica set couldn't be set up. The log shows MongoDB's answer.",
      );
    }
    log.line("The replica set is ready.");
  }
  for (const container of old) await ops.stopAndRemove(container.id, 30);
  const where = ops.target === HOST_TARGET ? "the Nearzero host" : "its server";
  log.line(
    `Deployment complete. Apps on ${where} reach it at ${service.app_name}:${settings.port}${
      service.public_port !== null ? `; from outside on port ${service.public_port}` : ""
    }.`,
  );
  await pruneImages(ctx, service, pulled.image).catch(() => {});
  return { status: "active", containerName, image: pulled.image };
}

function db(ctx: PipelineContext): Db {
  return ctx.services.db;
}

/**
 * Redeploy rebuilds what runs (30b R2-09): with no commit of its own, it fetches the commit the
 * running version was built from, not the branch's newest (Deploy takes that). Apps and Compose
 * stacks from a repository; images and uploads have no commit and fetch as they always do.
 */
async function rebuildRunningCommit(ctx: PipelineContext, service: FullService): Promise<void> {
  const { deployment } = ctx;
  if (deployment.trigger !== "redeploy" || deployment.requested_commit || deployment.requested_tag)
    return;
  if (service.kind !== "application" && service.kind !== "compose") return;
  const running = await runningVersion(ctx.services.db, service.id);
  if (!running?.commit_hash) return;
  await ctx.services.db
    .updateTable("deployment")
    .set({ requested_commit: running.commit_hash, updated_at: sql<Date>`now()` })
    .where("id", "=", deployment.id)
    .execute();
  ctx.deployment = { ...deployment, requested_commit: running.commit_hash };
  ctx.log.line(
    `Redeploy: rebuilding commit ${running.commit_hash.slice(0, 7)}, which the running version was built from. Deploy takes the branch's newest commit.`,
  );
}

/**
 * The Nearzero host (spec 24 G3, 22.2): every deploy there, whoever or whatever started it, needs
 * the workspace to still be allowed on the host (B1-07). An application's bind mounts are checked
 * once its variables are resolved (hostMountChecks). Elsewhere bind mounts are allowed and the
 * log warns about them.
 */
async function hostChecks(ctx: PipelineContext, service: FullService): Promise<void> {
  const { deployment, log } = ctx;
  const onHost = ctx.ops.target === HOST_TARGET;
  if (!onHost) {
    if (service.kind === "application") {
      for (const message of appMountWarnings(readAppSettings(service.settings))) {
        log.line(`Warning: ${message}`);
      }
    }
    return;
  }
  const admin = deployment.requested_by
    ? await isInstanceAdmin(db(ctx), deployment.requested_by)
    : false;
  if (!admin && !(await workspaceMayUseHost(db(ctx), service.workspace_id))) {
    throw new DeployFailure(HOST_WITHDRAWN);
  }
}

/**
 * An application's bind mounts on the host need an instance administrator's approval of exactly
 * the definition this deploy runs (30b R2-07; spec 31's decision on host approvals, C1-04): its
 * source, builder, commands, mounts, resolved variables, published ports and service port, taken
 * from what the deploy itself read. An administrator's deploy approves them.
 */
async function hostMountChecks(
  ctx: PipelineContext,
  service: FullService,
  read: {
    settings: AppSettings;
    files: Readonly<Record<string, string>>;
    runtime: Record<string, string>;
    /** null: not read by this deploy (a Reload), read here only when needed. */
    build: Record<string, string> | null;
  },
): Promise<void> {
  const { deployment, log } = ctx;
  if (ctx.ops.target !== HOST_TARGET) return;
  if (!read.settings.mounts.some((mount) => mount.type === "bind")) return;
  const definition: AppDefinition = {
    settings: read.settings,
    files: read.files,
    runtime: { ok: true, values: read.runtime },
    build: { ok: true, values: read.build ?? (await resolveVariables(ctx, service.id, "build")) },
  };
  const admin = deployment.requested_by
    ? await isInstanceAdmin(db(ctx), deployment.requested_by)
    : false;
  const decision = await hostMountDecision(db(ctx), {
    serviceId: service.id,
    definition,
    personId: deployment.requested_by,
    isAdmin: admin,
  });
  if (!decision.allowed) {
    for (const finding of decision.unapproved) {
      log.line(`Refused on the Nearzero host: ${finding.message}`);
    }
    throw new DeployFailure(decision.message);
  }
  for (const finding of decision.findings) {
    log.line(
      `Allowed on the Nearzero host${decision.approve ? " for a Nearzero administrator" : " (approved by a Nearzero administrator before)"}: ${finding.message}`,
    );
  }
  if (decision.approve) {
    await recordMountApproval(db(ctx), service.id, decision.findings, deployment.requested_by);
  }
}

/** Runs the deploy and says how it ended; throws only Cancelled (and for a stopping process). */
export async function runPipeline(ctx: PipelineContext): Promise<DeployOutcome> {
  const service = await loadFullService(ctx.services.db, ctx.deployment);
  const server = ctx.deployment.server_name;
  ctx.log.line(
    `Deploying ${service.name} (${SERVICE_KIND_LABELS[service.kind]}) in ${ctx.deployment.project_name} / ${ctx.deployment.environment_name} on ${server}, started by ${ctx.deployment.trigger}.`,
  );
  await hostChecks(ctx, service);
  await rebuildRunningCommit(ctx, service);
  let outcome: DeployOutcome;
  if (service.kind === "application") outcome = await deployApplication(ctx, service);
  else if (isDatabaseKind(service.kind)) outcome = await deployDatabase(ctx, service);
  else {
    // Compose stacks (spec 07): their own pipeline, with the same records, queue and log.
    const { deployCompose } = await import("../compose-runtime/deploy.ts");
    outcome = await deployCompose(ctx, service);
  }
  // Published ports in a remote server's host firewall (30b R2-13).
  if (outcome.status === "active") {
    for (const line of await syncPublishedPorts(ctx.ops, service)) ctx.log.line(line);
  }
  return outcome;
}
