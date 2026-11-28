import { AppError } from "@nearzero/shared";
import { Hono } from "hono";
import { readFile } from "../git-providers/reads.ts";
import { type WorkspaceActor, workspaceActorFor } from "../http/actor.ts";
import type { AppEnv } from "../http/context.ts";
import { serviceForAction } from "../service-runtime/runtime.ts";
import type { ServiceRow } from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { NO_COMPOSE_FILE, stackVariables } from "./deploy.ts";
import { hostDecision } from "./host-policy.ts";
import { composeInventory, parseComposeFile } from "./model.ts";
import { missingMessage, planStack, savedInventory, saveInventory, webService } from "./plan.ts";
import type { RouteForLabels } from "./render.ts";
import {
  CONTAINER_ACTIONS,
  type ContainerAction,
  containerAction,
  containersView,
} from "./runtime.ts";
import { type ComposeSource, composeSourceOf, sourceFingerprint, sourceLabel } from "./source.ts";
import { stackVolumes } from "./volumes.ts";

/**
 * The Compose page's own endpoints (spec 07 7.2; docs/api/compose.md): the stack's summary,
 * Preview Compose, the containers with their row actions, and the volumes for volume backups.
 * Deploy, Start, Stop, Reload, logs and the terminal are the deploy engine's endpoints, which
 * hand Compose services to this area.
 */

const FORMAT_NOTE =
  "Stack files run with Docker Compose on this one server: the format only changes how the file is read. Swarm placement and update settings don't apply.";

async function composeService(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  action: "service.deployments" | "service.deploy" | "service.see",
): Promise<ServiceRow> {
  const row = await serviceForAction(services, actor, serviceId, action);
  if (row.kind !== "compose")
    throw new AppError("not_found", "This service isn't a Compose stack.");
  return row;
}

/** Reads the source's Compose file without deploying: saved YAML, or through the Git provider. */
async function readStackFile(
  services: ControlServices,
  actor: WorkspaceActor,
  source: ComposeSource,
): Promise<{ file: string | null; ref: string | null; message: string | null }> {
  if (source.type === "raw") return { file: source.composeFile, ref: null, message: null };
  if (source.type === "git" || !source.providerId) {
    return {
      file: null,
      ref: null,
      message:
        source.type === "git"
          ? "This repository is read when the stack deploys, so Preview shows the files of the last deploy."
          : "This repository's Git provider was deleted, so its Compose file can't be read. Pick another provider under Source.",
    };
  }
  try {
    const read = await readFile(services, actor, source.providerId, {
      repository: source.repository,
      ref: source.branch,
      path: source.composePath,
    });
    return { file: read.content, ref: read.ref, message: null };
  } catch (error) {
    return {
      file: null,
      ref: null,
      message: `The Compose file couldn't be read from the repository: ${(error as Error).message}`,
    };
  }
}

/** The hostnames the service has now, for the labels Preview shows (no hostname is given here). */
async function currentRoutes(
  services: ControlServices,
  serviceId: string,
  ports: Map<string, number | null>,
  fallback: string | null,
): Promise<RouteForLabels[]> {
  const rows = await services.db
    .selectFrom("hostname")
    .select(["host", "path", "port", "compose_service"])
    .where("service_id", "=", serviceId)
    .orderBy("created_at")
    .execute();
  return rows.flatMap((row) => {
    const inner = row.compose_service ?? fallback;
    if (!inner) return [];
    return [
      {
        composeService: inner,
        url: `https://${row.host}${row.path && row.path !== "/" ? row.path : ""}`,
        port: row.port ?? ports.get(inner) ?? 80,
      },
    ];
  });
}

export interface PreviewView {
  available: boolean;
  message: string | null;
  source: string;
  files: { name: string; title: string; description: string; content: string }[];
  warnings: { kind: string; label: string; service: string | null; message: string }[];
  refused: boolean;
  refusal: string | null;
  problems: string[];
  variables: { delivered: string[]; uses: string[]; missing: string[]; note: string };
  notes: string[];
}

export async function previewStack(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ServiceRow,
): Promise<PreviewView> {
  const source = composeSourceOf(row.settings);
  const empty: PreviewView = {
    available: false,
    message: NO_COMPOSE_FILE,
    source: sourceLabel(source),
    files: [],
    warnings: [],
    refused: false,
    refusal: null,
    problems: [],
    variables: { delivered: [], uses: [], missing: [], note: "" },
    notes: [],
  };
  if (!source) return empty;
  const read = await readStackFile(services, actor, source);
  const notes: string[] = [];
  let file = read.file;
  let additionsFromDeploy: string | null = null;
  if (file === null) {
    const last = await services.db
      .selectFrom("compose_stack")
      .select(["compose_file", "additions_file"])
      .where("service_id", "=", row.id)
      .executeTakeFirst();
    if (!last?.compose_file) return { ...empty, message: read.message };
    file = last.compose_file;
    additionsFromDeploy = last.additions_file;
    if (read.message) notes.push(read.message);
  }
  const variables = await stackVariables(services, row.id);
  if (!variables.ok) notes.push(variables.message);
  const delivered = variables.ok ? variables.variables : [];
  const onHost = row.server_id === null;
  const parsed = parseComposeFile(file);
  const userFile = {
    name: "compose.yml",
    title: "Your Compose file",
    description:
      source.type === "raw"
        ? "Saved on this service. It runs as it is."
        : `./${source.composePath}${read.ref ? ` on ${read.ref}` : ""}. It runs as it is.`,
    content: file,
  };
  if (!parsed.ok) {
    return {
      ...empty,
      available: true,
      message: null,
      files: [userFile],
      problems: [`The Compose file can't be used: ${parsed.problem}`],
      notes,
    };
  }
  const inventory = composeInventory(parsed.model, row.app_name);
  if (source.type !== "raw" && read.file !== null) {
    await saveInventory(services.db, row.id, inventory, {
      fingerprint: sourceFingerprint(source),
      ref: read.ref,
    }).catch(() => {});
  }
  const web = webService(inventory.services);
  const routes = await currentRoutes(
    services,
    row.id,
    new Map(inventory.services.map((item) => [item.name, item.port])),
    web?.name ?? null,
  );
  const planned = planStack({
    file,
    source,
    appName: row.app_name,
    serviceId: row.id,
    deploymentId: null,
    variables: delivered,
    routes,
    onHost,
  });
  if (!planned.ok) {
    return {
      ...empty,
      available: true,
      message: null,
      files: [userFile],
      problems: [`The Compose file can't be used: ${planned.problem}`],
      notes,
    };
  }
  const plan = planned.plan;
  const decision = await hostDecision(services.db, {
    serviceId: row.id,
    onHost,
    findings: plan.findings,
    personId: actor.personId,
    isAdmin: actor.isInstanceAdmin,
  });
  const problems = [
    ...(plan.missing.length > 0 ? [missingMessage(plan.missing)] : []),
    ...plan.portProblems,
  ];
  if (routes.length === 0) {
    notes.push(
      web
        ? `This stack has no hostname yet. Its next deploy gives ${web.name} one when a domain is set up, or add one under Domains.`
        : "This stack has no hostname yet. Add one under Domains and pick the service it goes to.",
    );
  }
  if (row.settings?.format === "stack") notes.push(FORMAT_NOTE);
  if (additionsFromDeploy)
    notes.push("Nearzero's additions are shown as the last deploy wrote them.");
  for (const warning of plan.warnings) notes.push(warning);
  return {
    available: true,
    message: null,
    source: sourceLabel(source),
    files: [
      userFile,
      {
        name: "nearzero.yml",
        title: "Nearzero's additions",
        description: "Docker Compose merges this file over yours.",
        content: additionsFromDeploy ?? plan.additions.text,
      },
    ],
    warnings: plan.findings.map(({ kind, label, service, message }) => ({
      kind,
      label,
      service,
      message,
    })),
    refused: !decision.allowed,
    refusal: decision.allowed ? null : decision.message,
    problems,
    variables: {
      delivered: delivered.map((variable) => variable.name),
      uses: plan.uses,
      missing: plan.missing,
      note: "Variables reach Compose as an env file on the server. Their values are never shown here.",
    },
    notes,
  };
}

/**
 * Before a deploy is queued (spec 07 7.3, 24 G3): a stack with no file is refused, and on the
 * Nearzero host a pasted file with privileged options is refused for anyone but instance
 * administrators (unless an administrator deployed exactly those options before). A
 * repository's file is checked when the deploy has fetched it.
 */
export async function composeDeployPrecheck(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ServiceRow,
): Promise<void> {
  const source = composeSourceOf(row.settings);
  if (!source) throw new AppError("conflict", NO_COMPOSE_FILE);
  if (row.server_id !== null || source.type !== "raw" || actor.isInstanceAdmin) return;
  const variables = await stackVariables(services, row.id);
  const planned = planStack({
    file: source.composeFile,
    source,
    appName: row.app_name,
    serviceId: row.id,
    deploymentId: null,
    variables: variables.ok ? variables.variables : [],
    routes: [],
    onHost: true,
  });
  if (!planned.ok) return;
  const decision = await hostDecision(services.db, {
    serviceId: row.id,
    onHost: true,
    findings: planned.plan.findings,
    personId: actor.personId,
    isAdmin: false,
  });
  if (!decision.allowed) throw new AppError("forbidden", decision.message);
}

export function composeRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db } = services;

  app.get("/services/:serviceId/compose", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await composeService(services, actor, c.req.param("serviceId"), "service.see");
    const source = composeSourceOf(row.settings);
    const stack = await db
      .selectFrom("compose_stack")
      .select(["deployment_id", "source_fingerprint", "deployed_at"])
      .where("service_id", "=", row.id)
      .executeTakeFirst();
    const fingerprint = source ? sourceFingerprint(source) : null;
    const needsDeploy =
      fingerprint !== null &&
      (stack?.source_fingerprint ?? null) !== fingerprint &&
      row.status !== "deploying";
    let services_: { name: string; port: number | null }[] =
      savedInventory(row.settings)?.services ?? [];
    if (source?.type === "raw") {
      const parsed = parseComposeFile(source.composeFile);
      if (parsed.ok) {
        services_ = composeInventory(parsed.model, row.app_name).services.map(({ name, port }) => ({
          name,
          port,
        }));
      }
    }
    return c.json({
      format: row.settings?.format === "stack" ? "stack" : "compose",
      formatLabel: row.settings?.format === "stack" ? "Stack" : "Compose",
      formatNote: row.settings?.format === "stack" ? FORMAT_NOTE : null,
      source: { type: source?.type ?? null, label: sourceLabel(source) },
      needsDeploy,
      needsDeployMessage: needsDeploy
        ? stack?.deployment_id
          ? "Saved changes reach the stack on its next deploy."
          : "Deploy to start the stack."
        : null,
      deployedAt: stack?.deployed_at?.toISOString() ?? null,
      deploymentId: stack?.deployment_id ?? null,
      services: services_,
      onHost: row.server_id === null,
    });
  });

  app.get("/services/:serviceId/compose/preview", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await composeService(services, actor, c.req.param("serviceId"), "service.see");
    return c.json(await previewStack(services, actor, row));
  });

  app.get("/services/:serviceId/compose/containers", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await composeService(
      services,
      actor,
      c.req.param("serviceId"),
      "service.deployments",
    );
    return c.json(await containersView(services, row));
  });

  app.post("/services/:serviceId/compose/containers/:containerId/:action", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await composeService(services, actor, c.req.param("serviceId"), "service.deploy");
    const action = c.req.param("action") as ContainerAction;
    if (!CONTAINER_ACTIONS.includes(action)) {
      throw new AppError("not_found", "Containers can be restarted, started, stopped or killed.");
    }
    const containerId = c.req.param("containerId");
    if (!/^[0-9a-f]{12,64}$/.test(containerId)) {
      throw new AppError("not_found", "That container isn't one of this stack's.");
    }
    return c.json(await containerAction(services, actor, row, containerId, action));
  });

  app.get("/services/:serviceId/compose/volumes", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const row = await composeService(
      services,
      actor,
      c.req.param("serviceId"),
      "service.deployments",
    );
    return c.json(await stackVolumes(services, row));
  });

  return app;
}
