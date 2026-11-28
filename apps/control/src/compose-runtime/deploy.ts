import {
  COMPOSE_MIN_VERSION,
  type ComposeDeployed,
  type ComposePrepared,
  cleanContainerOutput,
  NEARZERO_LABELS,
  PRIVATE_NETWORK,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { HostnameRoute } from "../deploys/hostnames.ts";
import type { DeployLog } from "../deploys/log.ts";
import {
  DeployFailure,
  type PipelineContext,
  routeKey,
  routePrefix,
  writeLateNotes,
} from "../deploys/pipeline.ts";
import type { DeployOutcome } from "../deploys/queue.ts";
import { providerCloneAccess } from "../git-providers/sources.ts";
import { movedNotFinalized } from "../migration/moves.ts";
import { removeRoute, upsertRoute } from "../routing/routes.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { readAppSettings } from "../service-runtime/app-settings.ts";
import { Cancelled, ServerOps } from "../service-runtime/server-ops.ts";
import type { ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { openPrivateKey } from "../ssh-keys/keys.ts";
import { variablesForDeploy } from "../variables/deploy.ts";
import { hostDecision, recordApproval } from "./host-policy.ts";
import { parseComposeFile, servicesOf } from "./model.ts";
import { missingMessage, planStack, type StackPlan, saveInventory, webService } from "./plan.ts";
import { builtImage, innerAlias, type RouteForLabels } from "./render.ts";
import {
  type ComposeSource,
  composeSourceOf,
  describeComposeSource,
  sourceFingerprint,
} from "./source.ts";

/**
 * A Compose deploy, start to end (spec 07, 06 6.5, 23.1). The same deployment records, queue,
 * live log and cancel rules as apps:
 *
 * 1. the file: the saved YAML, or the repository fetched at the commit (through the Git provider's
 *    short-lived credentials) and copied into the stack's folder, where its Compose file is read;
 * 2. checks before anything on the server changes: YAML and shape, variables the file needs,
 *    ports Nearzero uses, and privileged options (refused on the Nearzero host for anyone but
 *    instance administrators, warned about elsewhere);
 * 3. the hostnames (the domains area gives the web service its automatic one), Nearzero's
 *    additions and the env file;
 * 4. `docker compose` on the server: validate, pull, build, then up; every container joins
 *    nearzero-edge as <app name>-<service>;
 * 5. a wait until every container runs and stays up (one-off containers may finish with 0),
 *    then the router's routes switch to the inner services.
 *
 * A failure before `up` leaves the running stack exactly as it was. A failure after it starts the
 * previous deployment's files again (their images are kept), or stops the new containers when
 * there was no earlier version.
 */

export const NO_COMPOSE_FILE =
  "This Compose service has no Compose file yet. Paste one under Source, or connect a repository, then deploy.";

const UNCHANGED = "Nothing was changed on the server; the running stack keeps serving.";

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

async function setFields(
  ctx: PipelineContext,
  fields: Partial<{
    title: string;
    commit_hash: string;
    builder: string;
    image: string;
    source: string;
  }>,
): Promise<void> {
  await ctx.services.db
    .updateTable("deployment")
    .set({ ...fields, updated_at: sql<Date>`now()` })
    .where("id", "=", ctx.deployment.id)
    .execute();
}

/** The service's variables for Compose (shared ones without Docker and Compose controls, then its own). */
export async function stackVariables(
  services: ControlServices,
  serviceId: string,
): Promise<
  | { ok: true; variables: { name: string; value: string }[] }
  | { ok: false; message: string; lines: string[] }
> {
  const result = await variablesForDeploy(services.db, services.secrets, serviceId, "runtime");
  if (result.ok) return { ok: true, variables: result.variables };
  const names = result.errors.map((error) => error.reference ?? error.name).filter(Boolean);
  return {
    ok: false,
    lines: result.errors.map((error) => error.message),
    message: names.length
      ? `A variable couldn't be resolved: ${names.join(", ")}. Fix it under Variables, then deploy again.`
      : (result.errors[0]?.message ?? "The variables couldn't be read."),
  };
}

/** Fetches a repository source onto the server (the app pipeline's source.git, same rules). */
async function fetchRepository(
  ctx: PipelineContext,
  service: ServiceRow,
  source: Exclude<ComposeSource, { type: "raw" }>,
): Promise<void> {
  const { services, deployment, log, ops } = ctx;
  let url = source.type === "git" ? source.url : "";
  let httpAuth: { username: string; password: string } | undefined;
  let sshPrivateKey: string | undefined;
  if (source.type === "provider") {
    const access = await providerCloneAccess(services, service.workspace_id, {
      type: "provider",
      providerId: source.providerId,
      provider: source.provider,
      repository: source.repository,
      repositoryId: null,
      branch: source.branch,
      buildPath: "",
      composePath: source.composePath,
      trigger: "push",
      watchPaths: [],
      submodules: source.submodules,
    }).catch((error: Error) => {
      throw new DeployFailure(error.message);
    });
    url = access.url;
    httpAuth = { username: access.username, password: access.password };
  } else if (source.sshKeyId) {
    sshPrivateKey = await openPrivateKey(services, service.workspace_id, source.sshKeyId).catch(
      () => {
        throw new DeployFailure(
          "The SSH key this source uses is gone. Pick another key for the repository, then deploy.",
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
    (text) => log.output(text),
    20 * 60_000,
  )) as { commit: string; subject: string };
  await setFields(ctx, {
    commit_hash: fetched.commit,
    title: fetched.subject.slice(0, 300) || deployment.title,
  });
}

interface Previous {
  deploymentId: string;
  composeFile: string;
  additionsFile: string;
  projectDirectory: string;
}

async function previousVersion(ctx: PipelineContext, serviceId: string): Promise<Previous | null> {
  const row = await ctx.services.db
    .selectFrom("compose_stack as c")
    .innerJoin("deployment as d", "d.id", "c.deployment_id")
    .select(["c.deployment_id", "c.compose_file", "c.additions_file", "c.project_directory"])
    .where("c.service_id", "=", serviceId)
    .where("d.status", "in", ["active", "not_running"])
    .executeTakeFirst();
  if (!row?.deployment_id || row.compose_file === null || row.additions_file === null) return null;
  return {
    deploymentId: row.deployment_id,
    composeFile: row.compose_file,
    additionsFile: row.additions_file,
    projectDirectory: row.project_directory,
  };
}

/** The containers of one deployment of the stack, newest first. */
async function deploymentContainers(ops: ServerOps, serviceId: string, deploymentId: string) {
  const list = await ops.serviceContainers(serviceId);
  return list.filter((item) => item.labels[NEARZERO_LABELS.deployment] === deploymentId);
}

interface Recovery {
  previous: Previous | null;
  envFile: string;
  secrets: string[];
  extraEnvFiles: string[];
  /** The inner services that join the private network (hostnames route to them). */
  routed: string[];
  /** Every inner service name of the previous file and the new one. */
  innerServices: string[];
}

/** The inner service names of a Compose file (none when it can't be read). */
function innerServicesOf(file: string): string[] {
  const parsed = parseComposeFile(file);
  return parsed.ok ? servicesOf(parsed.model).map(([name]) => name) : [];
}

/** The inner services the router sends this stack's traffic to now (its saved routes). */
async function routedNow(ctx: PipelineContext, service: ServiceRow): Promise<string[]> {
  const rows = await ctx.services.db
    .selectFrom("router_route")
    .select("spec")
    .where("target", "=", ctx.ops.target)
    .where("key", "like", `${routePrefix(service.id)}%`)
    .execute();
  const prefix = `${service.app_name}-`;
  const names = new Set<string>();
  for (const row of rows) {
    const spec = (typeof row.spec === "string" ? JSON.parse(row.spec) : row.spec) as {
      upstream?: { host?: unknown };
    } | null;
    const host = spec?.upstream?.host;
    if (typeof host === "string" && host.startsWith(prefix)) names.add(host.slice(prefix.length));
  }
  return [...names];
}

/**
 * The network settings of a run (30b R2-11): only inner services hostnames route to join the
 * private network every app and stack on the server shares; the rest stay on the stack's own.
 * Compose service names may have capitals; Nearzero's aliases are lowercase.
 */
function networkFor(service: ServiceRow, inventory: readonly string[], routed: readonly string[]) {
  const wanted = new Set(routed.map((name) => name.toLowerCase()));
  return {
    name: PRIVATE_NETWORK,
    aliasPrefix: service.app_name,
    services: inventory.filter((name) => wanted.has(name.toLowerCase())),
  };
}

/** After `up` started and something failed: the previous version again, or the new one stopped. */
async function recover(
  ctx: PipelineContext,
  service: ServiceRow,
  recovery: Recovery,
): Promise<void> {
  // A cancelled deploy's signal is spent; recovering runs on its own.
  const ops = new ServerOps(ctx.services, ctx.ops.target, new AbortController().signal);
  const { log } = ctx;
  const previous = recovery.previous;
  if (previous) {
    log.line("Starting the previous version again.");
    try {
      const answer = (await ops.stream(
        "compose.deploy",
        {
          project: service.app_name,
          directory: previous.projectDirectory,
          files: [
            { name: "compose.yml", content: previous.composeFile },
            { name: "nearzero.yml", content: previous.additionsFile },
          ],
          envFile: recovery.envFile,
          writeDotEnv: previous.projectDirectory === "",
          extraEnvFiles: recovery.extraEnvFiles,
          secrets: recovery.secrets,
          pull: false,
          build: false,
          removeOrphans: !(await movedNotFinalized(ctx.services.db, service.id)),
          network: networkFor(service, recovery.innerServices, recovery.routed),
        },
        (text) => log.output(text),
        30 * 60_000,
      )) as ComposeDeployed;
      if (answer.ok) {
        log.line("The previous version is running again.");
        return;
      }
      log.line(
        `The previous version couldn't be started again: ${answer.message ?? "no reason given"}.`,
      );
    } catch (error) {
      log.line(`The previous version couldn't be started again: ${(error as Error).message}`);
    }
    return;
  }
  const containers = await deploymentContainers(ops, service.id, ctx.deployment.id).catch(() => []);
  for (const container of containers) {
    await ops
      .command("container.stop", { id: container.id, timeoutSeconds: 10 }, 40_000)
      .catch(() => {});
  }
  if (containers.length > 0) {
    log.line(
      "There is no earlier version to go back to, so the new containers were stopped. Their logs stay on the page.",
    );
  }
}

interface StableResult {
  ok: boolean;
  reason?: string;
  containerId?: string;
}

/**
 * Waits until every container of the deployment runs and stays up for the stability window (a
 * health check, when there is one, must pass first). A one-off container that finished with
 * exit code 0 counts as done. A crash, restart, exit with an error, or a failed health check
 * fails.
 */
/** How long a stack may take to settle; tests shorten them. */
export const stackWait = {
  /** Containers that are neither running healthy nor in a health check's start period. */
  settleMs: 300_000,
  /** A health check still starting: Docker marks it unhealthy when it never passes. */
  healthMs: 60 * 60_000,
  /** When the log says a health check is still starting. */
  noteMs: 60_000,
  pollMs: 1000,
};

async function waitStable(
  ops: ServerOps,
  serviceId: string,
  deploymentId: string,
  stabilitySeconds: number,
  log: DeployLog,
): Promise<StableResult> {
  const started = Date.now();
  const since = new Map<string, { at: number; startedAt: string; restarts: number }>();
  let announced = false;
  let healthNoted = false;
  for (;;) {
    ops.checkCancelled();
    /** A health check still in its start period: Docker itself says when it passes or fails. */
    let starting: string | null = null;
    const containers = await deploymentContainers(ops, serviceId, deploymentId);
    if (containers.length === 0) {
      return {
        ok: false,
        reason:
          "No container started. Check the services' profiles and replicas in the Compose file.",
      };
    }
    let waiting = false;
    for (const container of containers) {
      const info = await ops.inspect(container.id);
      const service = container.labels["com.docker.compose.service"] ?? container.name;
      if (!info)
        return {
          ok: false,
          reason: `The container of ${service} disappeared.`,
          containerId: container.id,
        };
      if (info.health === "unhealthy") {
        return {
          ok: false,
          reason: `${service} failed its health check.`,
          containerId: container.id,
        };
      }
      if (info.state === "restarting") {
        return {
          ok: false,
          reason: `${service} exited with code ${info.exitCode} and kept restarting.`,
          containerId: container.id,
        };
      }
      if (!info.running) {
        if (info.state === "created" && Date.now() - started < 60_000) {
          waiting = true;
          continue;
        }
        if (info.state === "exited" && info.exitCode === 0 && info.restartCount === 0) continue;
        return {
          ok: false,
          reason: info.oomKilled
            ? `${service} ran out of memory and was stopped.`
            : `${service} exited with code ${info.exitCode}.`,
          containerId: container.id,
        };
      }
      const seen = since.get(container.id);
      if (!seen) {
        since.set(container.id, {
          at: Date.now(),
          startedAt: info.startedAt,
          restarts: info.restartCount,
        });
        waiting = true;
        continue;
      }
      if (seen.startedAt !== info.startedAt || seen.restarts !== info.restartCount) {
        return {
          ok: false,
          reason: `${service} exited${info.exitCode ? ` with code ${info.exitCode}` : ""} and restarted right after it started.`,
          containerId: container.id,
        };
      }
      if (info.health !== null && info.health !== "healthy") {
        if (info.health === "starting") starting ??= service;
        seen.at = Date.now();
        waiting = true;
        continue;
      }
      if (Date.now() - seen.at < stabilitySeconds * 1000) waiting = true;
    }
    if (!waiting) return { ok: true };
    if (!announced && stabilitySeconds > 0 && since.size > 0) {
      announced = true;
      log.line(
        `The containers are running; checking that they stay up for ${stabilitySeconds} seconds.`,
      );
    }
    // A health check in its start period isn't a failure (31b G2-07): a database importing for
    // ten minutes deploys. Docker marks it unhealthy if it never passes, which fails the deploy;
    // only an hour of "starting" stops the wait. Anything else waits at most 5 minutes.
    if (starting && !healthNoted && Date.now() - started > stackWait.noteMs) {
      healthNoted = true;
      log.line(
        `${starting}'s health check is still starting. Waiting for it to pass: a long start period is fine, and only a failing check stops the deploy.`,
      );
    }
    const limit = starting ? stackWait.healthMs : stackWait.settleMs;
    if (Date.now() - started > limit) {
      return {
        ok: false,
        reason: starting
          ? `${starting}'s health check was still starting after an hour.`
          : "The stack never became healthy within 5 minutes.",
      };
    }
    await Bun.sleep(stackWait.pollMs);
  }
}

async function writeRoutes(
  ctx: PipelineContext,
  service: ServiceRow,
  routes: HostnameRoute[],
  fallbackService: string | null,
  /** Whether a hostname provider failed: then routes it didn't name are kept (spec 6.5). */
  providerFailed = false,
): Promise<string[]> {
  const { services, ops } = ctx;
  const keep = new Set<string>();
  const urls: string[] = [];
  for (const route of routes) {
    const inner = route.composeService ?? fallbackService;
    if (!inner) continue;
    const key = routeKey(service.id, route.host, route.path || "/");
    keep.add(key);
    await upsertRoute(services, ops.target, {
      key,
      hostnames: [route.host],
      path: route.path || "/",
      upstream: { host: innerAlias(service.app_name, inner), port: route.port },
      certificate: route.https ? "letsencrypt" : "none",
    });
    urls.push(
      `${route.https ? "https" : "http"}://${route.host}${route.path === "/" ? "" : route.path}`,
    );
  }
  const stale = await services.db
    .selectFrom("router_route")
    .select("key")
    .where("target", "=", ops.target)
    .where("key", "like", `${routePrefix(service.id)}%`)
    .execute();
  for (const row of stale) {
    // A failed provider's routes stay: they reach the stack's stable aliases (B1-11).
    if (!keep.has(row.key) && !providerFailed) await removeRoute(services, ops.target, row.key);
  }
  return urls;
}

/** Built images of the stack beyond the last three successful deployments are removed. */
async function pruneImages(ctx: PipelineContext, service: ServiceRow): Promise<void> {
  const kept = await ctx.services.db
    .selectFrom("deployment")
    .select("id")
    .where("service_id", "=", service.id)
    .where("status", "in", ["active", "previous", "not_running"])
    .orderBy("finished_at", "desc")
    .limit(2)
    .execute();
  const keepShort = new Set(
    [ctx.deployment.id, ...kept.map((row) => row.id)].map((id) => id.slice(0, 8)),
  );
  const images = (await ctx.ops.command("image.list", {
    labels: [`${NEARZERO_LABELS.service}=${service.id}`],
    reference: [],
  })) as { id: string; tags: string[] }[];
  for (const image of images) {
    const ours = image.tags.filter((tag) => tag.startsWith(`nearzero/${service.app_name}-`));
    if (ours.length === 0 || ours.some((tag) => keepShort.has(tag.split(":").at(-1) ?? "")))
      continue;
    for (const tag of ours) {
      await ctx.ops.command("image.remove", { image: tag, force: false }).catch(() => {});
    }
  }
}

function hostnameRouteLabels(routes: HostnameRoute[], fallback: string | null): RouteForLabels[] {
  return routes.flatMap((route) => {
    const inner = route.composeService ?? fallback;
    if (!inner) return [];
    return [
      {
        composeService: inner,
        url: `${route.https ? "https" : "http"}://${route.host}${route.path === "/" ? "" : route.path}`,
        port: route.port,
      },
    ];
  });
}

export async function deployCompose(
  ctx: PipelineContext,
  service: ServiceRow,
): Promise<DeployOutcome> {
  const { services, deployment, log, ops } = ctx;
  const { db } = services;
  const source = composeSourceOf(service.settings);
  if (!source) throw new DeployFailure(NO_COMPOSE_FILE);
  const onHost = ops.target === HOST_TARGET;
  await setFields(ctx, {
    source: JSON.stringify(describeComposeSource(source)),
    builder: "compose",
  });
  if (service.settings?.format === "stack") {
    log.line(
      "This is a Stack file. It runs with Docker Compose on this one server: the format only changes how the file is read.",
    );
  }

  const resolvedVariables = await stackVariables(services, service.id);
  if (!resolvedVariables.ok) {
    for (const line of resolvedVariables.lines) log.line(line);
    throw new DeployFailure(resolvedVariables.message);
  }
  const variables = resolvedVariables.variables;

  // 1. The file.
  let file: string;
  let extraEnvFiles: string[] = [];
  let checkValues: Record<string, string> = {};
  if (source.type === "raw") log.line("Using the Compose file saved on this service.");
  else await fetchRepository(ctx, service, source);
  ops.checkCancelled();
  const prepared = (await ops.command(
    "compose.prepare",
    {
      project: service.app_name,
      ...(source.type === "raw"
        ? {}
        : {
            repository: {
              appKey: service.app_name,
              composePath: source.composePath,
              envFiles: [".env"],
            },
          }),
    },
    5 * 60_000,
  )) as ComposePrepared;
  for (const link of prepared.skippedLinks) {
    log.line(`Left out ${link}: it is a link to somewhere outside the repository.`);
  }
  for (const path of prepared.skippedFiles ?? []) {
    log.line(
      `Left out ${path} from the repository: a container owns the folder it goes in, so what is there stays as the container keeps it.`,
    );
  }
  if (source.type !== "raw") {
    if (prepared.composeFile === null) {
      throw new DeployFailure(`The repository has no Compose file at ./${source.composePath}.`);
    }
    file = prepared.composeFile;
    log.line(`Using ./${source.composePath} from the repository.`);
    extraEnvFiles = prepared.envFiles;
    checkValues = prepared.envValues ?? {};
    if (extraEnvFiles.length > 0) {
      log.line(
        `Compose also reads ${extraEnvFiles.join(", ")} from the repository; Variables win over it.`,
      );
    }
  } else {
    file = source.composeFile;
  }
  if (!prepared.composeVersion) {
    throw new DeployFailure(
      onHost
        ? "Docker Compose isn't available on the Nearzero host. Run the Nearzero install command again on the host to update its image."
        : "Docker Compose isn't installed on this server. Run setup again on this server's page to install it.",
    );
  }
  if (compareVersions(prepared.composeVersion, COMPOSE_MIN_VERSION) < 0) {
    throw new DeployFailure(
      `Docker Compose ${prepared.composeVersion} on this server is older than ${COMPOSE_MIN_VERSION}, which Nearzero needs. Update Docker on the server, then deploy again.`,
    );
  }
  log.line(`Docker Compose ${prepared.composeVersion} on ${deployment.server_name}.`);

  // 2. Checks before anything changes.
  const first = planStack({
    file,
    source,
    appName: service.app_name,
    serviceId: service.id,
    deploymentId: deployment.id,
    variables,
    checkValues,
    routes: [],
    onHost,
  });
  if (!first.ok) {
    log.line(UNCHANGED);
    throw new DeployFailure(`The Compose file can't be used: ${first.problem}`);
  }
  for (const warning of first.plan.warnings) log.line(`Note: ${warning}`);
  await saveInventory(db, service.id, first.plan.inventory, {
    fingerprint: sourceFingerprint(source),
    ref: deployment.requested_commit,
  }).catch(() => {});
  if (first.plan.missing.length > 0) {
    log.line(UNCHANGED);
    throw new DeployFailure(missingMessage(first.plan.missing));
  }
  if (first.plan.portProblems.length > 0) {
    log.line(UNCHANGED);
    throw new DeployFailure(first.plan.portProblems.join(" "));
  }
  const decision = await hostDecision(db, {
    serviceId: service.id,
    onHost,
    findings: first.plan.findings,
    personId: deployment.requested_by,
  });
  if (!decision.allowed) {
    for (const finding of decision.unapproved)
      log.line(`Refused on the Nearzero host: ${finding.message}`);
    log.line(UNCHANGED);
    throw new DeployFailure(decision.message);
  }
  for (const finding of first.plan.findings) {
    log.line(
      onHost
        ? `Allowed on the Nearzero host${decision.approve ? " for a Nearzero administrator" : " (approved by a Nearzero administrator before)"}: ${finding.message}`
        : `Warning: ${finding.message}`,
    );
  }

  // 3. Hostnames, then the final files.
  const web = webService(first.plan.inventory.services);
  const answer = await services.hostnameProviders.collect({
    serviceId: service.id,
    serverId: ops.target,
    port: web?.port ?? 80,
  });
  for (const note of answer.notes) log.line(note);
  writeLateNotes(log, answer.later);
  const plan = planStack({
    file,
    source,
    appName: service.app_name,
    serviceId: service.id,
    deploymentId: deployment.id,
    variables,
    checkValues,
    routes: hostnameRouteLabels(answer.routes, web?.name ?? null),
    onHost,
  });
  if (!plan.ok) throw new DeployFailure(`The Compose file can't be used: ${plan.problem}`);
  const final: StackPlan = plan.plan;
  const secrets = variables.map((variable) => variable.value).filter((value) => value.length >= 4);
  const deploySettings = readAppSettings(service.settings).deploy;
  const builds = final.inventory.services.some((item) => item.build);
  const previous = await previousVersion(ctx, service.id);
  const innerNames = final.inventory.services.map((item) => item.name);
  const routedInner = [
    ...new Set(
      hostnameRouteLabels(answer.routes, web?.name ?? null).map((route) => route.composeService),
    ),
  ];
  const previousInner = previous ? innerServicesOf(previous.composeFile) : [];
  const recovery: Recovery = {
    previous,
    envFile: final.envFile,
    secrets,
    extraEnvFiles,
    routed: [...new Set([...routedInner, ...(await routedNow(ctx, service))])],
    innerServices: [...new Set([...innerNames, ...previousInner])],
  };

  // 4. Docker Compose on the server.
  ops.checkCancelled();
  log.line(
    `Running the stack with Docker Compose: ${final.inventory.services.map((item) => item.name).join(", ")}.`,
  );
  let deployed: ComposeDeployed;
  try {
    deployed = (await ops.stream(
      "compose.deploy",
      {
        project: service.app_name,
        directory: final.folder.projectDirectory,
        files: [
          { name: "compose.yml", content: file },
          { name: "nearzero.yml", content: final.additions.text },
        ],
        envFile: final.envFile,
        writeDotEnv: source.type === "raw",
        extraEnvFiles,
        secrets,
        bindPaths: final.additions.bindPaths,
        pull: true,
        build: builds,
        noCache: deployment.clean_cache || deploySettings.cleanCache,
        // A moved stack shares its project name with 0.1.x's copy until finalize (spec 29.5).
        removeOrphans: !(await movedNotFinalized(ctx.services.db, service.id)),
        network: networkFor(service, innerNames, routedInner),
      },
      (text) => log.output(text),
      90 * 60_000,
    )) as ComposeDeployed;
  } catch (error) {
    // Cancelled or the server went away mid-way: put the previous version back.
    await recover(ctx, service, recovery);
    throw error;
  }
  if (!deployed.ok) {
    if (deployed.touched) {
      await recover(ctx, service, recovery);
    } else {
      log.line(UNCHANGED);
    }
    throw new DeployFailure(deployed.message ?? "Docker Compose couldn't start the stack.");
  }
  for (const name of deployed.notConnected) {
    log.line(
      `${name} can't join ${PRIVATE_NETWORK} (it sets network_mode), so hostnames can't reach it.`,
    );
  }

  // 5. Stable, then routes.
  let stable: StableResult;
  try {
    stable = await waitStable(ops, service.id, deployment.id, deploySettings.stabilitySeconds, log);
  } catch (error) {
    await recover(ctx, service, recovery);
    throw error;
  }
  if (!stable.ok) {
    log.line(stable.reason ?? "The stack didn't stay up.");
    if (stable.containerId) {
      // Cleaned of the stack's values (its variables and the repository's .env), logins in
      // connection strings and escape codes (31b G2-01).
      const output = cleanContainerOutput(
        await ops.lastOutput(stable.containerId, 100).catch(() => ""),
        [...variables.map((variable) => variable.value), ...Object.values(checkValues ?? {})],
      );
      if (output.trim()) {
        log.line("Its last output:");
        log.line(output);
      } else {
        log.line("It printed nothing before it stopped.");
      }
    }
    await recover(ctx, service, recovery);
    throw new DeployFailure(stable.reason ?? "The stack didn't stay up.");
  }
  let urls: string[];
  try {
    urls = await writeRoutes(
      ctx,
      service,
      answer.routes,
      web?.name ?? null,
      answer.failed.length > 0,
    );
  } catch (error) {
    await recover(ctx, service, recovery);
    if (error instanceof Cancelled) throw error;
    throw new DeployFailure(
      `Traffic couldn't be switched to the new version: ${(error as Error).message}`,
    );
  }

  await db
    .insertInto("compose_stack")
    .values({
      service_id: service.id,
      deployment_id: deployment.id,
      source_fingerprint: sourceFingerprint(source),
      compose_file: file,
      additions_file: final.additions.text,
      project_directory: final.folder.projectDirectory,
      deployed_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.column("service_id").doUpdateSet({
        deployment_id: deployment.id,
        source_fingerprint: sourceFingerprint(source),
        compose_file: file,
        additions_file: final.additions.text,
        project_directory: final.folder.projectDirectory,
        deployed_at: new Date(),
        updated_at: new Date(),
      }),
    )
    .execute();
  if (decision.approve) {
    await recordApproval(db, service.id, final.findings, deployment.requested_by);
  }
  if (builds) {
    const tags = final.inventory.services
      .filter((item) => item.build && item.image === null)
      .map((item) => builtImage(service.app_name, item.name, deployment.id));
    if (tags.length > 0) await setFields(ctx, { image: tags.join(", ").slice(0, 1000) });
  }
  await pruneImages(ctx, service).catch(() => {});

  if (urls.length > 0) {
    log.line(`Deployment complete. It's live at: ${urls.join(", ")}`);
  } else {
    log.line(
      "Deployment complete. This stack has no domain yet, so it isn't reachable from the internet. Add one under Domains to give its web service a public URL with HTTPS.",
    );
  }
  return { status: "active", containerName: null, image: null };
}
