import { createHash } from "node:crypto";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import {
  type ComposeInventory,
  composeInventory,
  InterpolationTooLarge,
  type InventoryService,
  interpolateModel,
  type Model,
  missingVariables,
  type PublishedPort,
  parseComposeFile,
  placeholderNames,
} from "./model.ts";
import {
  type Finding,
  type FolderContext,
  findPrivileged,
  RUNNER_PROCESS_VARIABLES,
  runnerProcessValue,
} from "./privileged.ts";
import {
  type Additions,
  type RouteForLabels,
  renderAdditions,
  renderEnvFile,
  reservedPortProblems,
} from "./render.ts";
import { type ComposeSource, composeSourceOf, folderOf, sourceOrigin } from "./source.ts";

/**
 * Everything Nearzero works out from a Compose file before running it (spec 07): the checks
 * (YAML and shape, variables the file needs, ports Nearzero uses, privileged options), the
 * inventory, Nearzero's additions and the env file. Preview shows it; a deploy runs it.
 */

export interface StackPlan {
  model: Model;
  resolved: Model;
  inventory: ComposeInventory;
  folder: FolderContext;
  findings: Finding[];
  /** Placeholders with no default whose variable isn't set. */
  missing: string[];
  /** Variables the file refers to. */
  uses: string[];
  /** Published ports Nearzero needs itself. */
  portProblems: string[];
  warnings: string[];
  additions: Additions;
  envFile: string;
}

export type PlanResult = { ok: true; plan: StackPlan } | { ok: false; problem: string };

type PlanInput = {
  file: string;
  source: ComposeSource;
  appName: string;
  serviceId: string;
  deploymentId: string | null;
  variables: readonly { name: string; value: string }[];
  /**
   * Values Compose also reads (a repository's .env), for the checks only: they never go into
   * Nearzero's env file. The service's variables win over them.
   */
  checkValues?: Readonly<Record<string, string>>;
  routes: RouteForLabels[];
  onHost: boolean;
};

export function planStack(input: PlanInput): PlanResult {
  try {
    return planStackOnce(input);
  } catch (error) {
    // A file that multiplies its variables past the limit is refused, naming the variable (C1-03).
    if (error instanceof InterpolationTooLarge) return { ok: false, problem: error.message };
    throw error;
  }
}

function planStackOnce(input: PlanInput): PlanResult {
  const parsed = parseComposeFile(input.file);
  if (!parsed.ok) return { ok: false, problem: parsed.problem };
  // APP_NAME and COMPOSE_PROJECT_NAME are the service's app name unless its variables say
  // otherwise (30b R2-12): a file can use ${APP_NAME} without anyone adding a variable.
  const given = new Set(input.variables.map((variable) => variable.name));
  const delivered = [
    ...STACK_NAME_VARIABLES.filter((name) => !given.has(name)).map((name) => ({
      name,
      value: input.appName,
    })),
    ...input.variables,
  ];
  const values = new Map([
    ...Object.entries(input.checkValues ?? {}),
    ...delivered.map((variable) => [variable.name, variable.value] as [string, string]),
  ]);
  const envFile = renderEnvFile(delivered);
  const folder: FolderContext = {
    ...folderOf(input.source),
    appName: input.appName,
    origin: sourceOrigin(input.source),
    envFileDigest: createHash("sha256").update(envFile).digest("hex"),
  };
  // Compose takes a few names from the runner's own environment, over every env file (B1-32).
  const lookup = (name: string) => runnerProcessValue(name, folder) ?? values.get(name);
  const model = parsed.model;
  const resolved = interpolateModel(model, lookup) as Model;
  const inventory = composeInventory(model, input.appName);
  const additions = renderAdditions({
    model,
    resolved,
    inventory,
    folder,
    serviceId: input.serviceId,
    deploymentId: input.deploymentId,
    routes: input.routes,
  });
  return {
    ok: true,
    plan: {
      model,
      resolved,
      inventory,
      folder,
      findings: findPrivileged(model, folder, lookup),
      missing: missingVariables(model, new Set([...values.keys(), ...RUNNER_PROCESS_VARIABLES])),
      uses: placeholderNames(model),
      portProblems: reservedPortProblems(resolved, input.onHost),
      warnings: parsed.warnings,
      additions,
      envFile,
    },
  };
}

/** Names every stack gets with its app name, unless its variables set them (30b R2-12). */
export const STACK_NAME_VARIABLES = ["APP_NAME", "COMPOSE_PROJECT_NAME"] as const;

export function missingMessage(names: readonly string[]): string {
  const list = names.join(", ");
  return names.length === 1
    ? `The Compose file uses ${list}, which isn't set. Add it under Variables, then deploy.`
    : `The Compose file uses ${list}, which aren't set. Add them under Variables, then deploy.`;
}

const WEB_NAMES = [
  "web",
  "app",
  "frontend",
  "front",
  "site",
  "www",
  "server",
  "nginx",
  "caddy",
  "proxy",
];

/** The inner service that looks like the web one: a web-looking name with a port, else the first with a port. */
export function webService(services: readonly InventoryService[]): InventoryService | null {
  const withPorts = services.filter((item) => item.port !== null);
  return (
    withPorts.find((item) => WEB_NAMES.includes(item.name.toLowerCase())) ?? withPorts[0] ?? null
  );
}

/**
 * Keeps the file's inventory on the service (settings.composeInventory), so the domains area can
 * offer a repository file's inner services and give the web one its automatic hostname
 * (punch-list item 5), and the backups area can list its declared volumes. Merged into the
 * settings in one statement, so it never overwrites anything else saved meanwhile.
 */
export async function saveInventory(
  db: Db,
  serviceId: string,
  inventory: ComposeInventory,
  meta: { fingerprint: string; ref: string | null },
): Promise<void> {
  const value = {
    services: inventory.services.map(({ name, port, dependsOn, published, build }) => ({
      name,
      port,
      dependsOn,
      published,
      build,
    })),
    volumes: inventory.volumes,
    fingerprint: meta.fingerprint,
    ref: meta.ref,
    readAt: new Date().toISOString(),
  };
  await db
    .updateTable("service")
    .set({
      settings: sql`coalesce(settings, '{}'::jsonb) || jsonb_build_object('composeInventory', ${JSON.stringify(value)}::jsonb)`,
    })
    .where("id", "=", serviceId)
    .execute();
}

/**
 * The server ports a Compose service publishes: read from its pasted file, else from the
 * inventory its last deploy or Preview saved (a repository's file). B1-29.
 */
export function composePublishedPorts(
  settings: Record<string, unknown> | null,
  appName: string,
): PublishedPort[] {
  const source = composeSourceOf(settings);
  if (source?.type === "raw") {
    const parsed = parseComposeFile(source.composeFile);
    if (parsed.ok) {
      return composeInventory(parsed.model, appName).services.flatMap((item) => item.published);
    }
  }
  return (savedInventory(settings)?.services ?? []).flatMap((item) => item.published);
}

/**
 * Whether a stack builds anything (G2-05): a pasted file is read now; a repository's stack by
 * the inventory its last read saved, and counts as building when that doesn't say.
 */
export function composeBuilds(settings: Record<string, unknown> | null): boolean {
  const source = composeSourceOf(settings);
  if (source?.type === "raw") {
    const parsed = parseComposeFile(source.composeFile);
    return !parsed.ok || composeInventory(parsed.model, "x").services.some((item) => item.build);
  }
  const value = settings?.composeInventory as { services?: { build?: unknown }[] } | undefined;
  const services = Array.isArray(value?.services) ? value.services : null;
  if (!services || services.some((item) => typeof item?.build !== "boolean")) return true;
  return services.some((item) => item.build === true);
}

/** The inventory saved on the service, if any. */
export function savedInventory(settings: Record<string, unknown> | null): {
  services: {
    name: string;
    port: number | null;
    dependsOn: string[];
    published: PublishedPort[];
  }[];
  volumes: ComposeInventory["volumes"];
  fingerprint: string | null;
} | null {
  const value = settings?.composeInventory as Record<string, unknown> | undefined;
  if (!value || !Array.isArray(value.services)) return null;
  return {
    services: (
      value.services as {
        name?: unknown;
        port?: unknown;
        dependsOn?: unknown;
        published?: unknown;
      }[]
    )
      .filter((item) => typeof item.name === "string")
      .map((item) => ({
        name: item.name as string,
        port: typeof item.port === "number" ? item.port : null,
        dependsOn: Array.isArray(item.dependsOn)
          ? item.dependsOn.filter((name): name is string => typeof name === "string")
          : [],
        published: Array.isArray(item.published)
          ? (item.published as PublishedPort[]).filter(
              (entry) =>
                Number.isInteger(entry?.port) &&
                (entry.protocol === "tcp" || entry.protocol === "udp"),
            )
          : [],
      })),
    volumes: Array.isArray(value.volumes) ? (value.volumes as ComposeInventory["volumes"]) : [],
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : null,
  };
}
