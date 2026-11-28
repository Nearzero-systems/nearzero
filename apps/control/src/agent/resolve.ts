import type { ServiceKind } from "@nearzero/shared";
import { serviceTarget } from "../projects/objects.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import "./tables.ts";
import type { AgentContext } from "./context.ts";

/**
 * Finding what the model names, among what the person can reach (spec 19.11, 20.2, 22.4 rule 3):
 * projects, services and servers by name with typos tolerated (1 for 4 to 7 letters, 2 for 8 or
 * more), environments by name, servers by name or address, services also by internal app name,
 * a deployment log path or a container name, and anything by id. When nothing matches, the model
 * gets the real candidates instead of an error that hides what exists.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_INSIDE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Optimal string alignment distance (Levenshtein plus swapped neighbours). */
export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) (d[i] as number[])[0] = i;
  for (let j = 0; j < cols; j++) (d[0] as number[])[j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i] as number[];
      const above = d[i - 1] as number[];
      let best = Math.min(
        (above[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (above[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, ((d[i - 2] as number[])[j - 2] as number) + 1);
      }
      row[j] = best;
    }
  }
  return (d[a.length] as number[])[b.length] as number;
}

/** How many typos a name of this length tolerates. */
export function typoAllowance(length: number): number {
  if (length >= 8) return 2;
  if (length >= 4) return 1;
  return 0;
}

export const normalizeName = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

export interface Named {
  id: string;
  name: string;
  /** Other names that point at it exactly (app name, address, container names). */
  aliases?: readonly string[];
}

export type Match<T> =
  | { kind: "one"; item: T; exact: boolean }
  | { kind: "many"; items: T[] }
  | { kind: "none" };

/** Exact (ignoring case and separators), then aliases, then typo-tolerant matches. */
export function matchByName<T extends Named>(items: readonly T[], query: string): Match<T> {
  const raw = query.trim();
  if (raw === "") return { kind: "none" };
  if (UUID.test(raw)) {
    const found = items.find((item) => item.id === raw.toLowerCase());
    return found ? { kind: "one", item: found, exact: true } : { kind: "none" };
  }
  const wanted = normalizeName(raw);
  const exact = items.filter((item) => normalizeName(item.name) === wanted);
  if (exact.length === 1) return { kind: "one", item: exact[0] as T, exact: true };
  if (exact.length > 1) return { kind: "many", items: exact };
  const aliased = items.filter((item) =>
    (item.aliases ?? []).some((alias) => normalizeName(alias) === wanted || alias === raw),
  );
  if (aliased.length === 1) return { kind: "one", item: aliased[0] as T, exact: true };
  if (aliased.length > 1) return { kind: "many", items: aliased };
  const close = items
    .map((item) => {
      const name = normalizeName(item.name);
      const allowance = typoAllowance(Math.min(name.length, wanted.length));
      const distance = editDistance(name, wanted);
      return { item, distance, allowance };
    })
    .filter((entry) => entry.allowance > 0 && entry.distance <= entry.allowance)
    .sort((a, b) => a.distance - b.distance);
  if (close.length === 0) return { kind: "none" };
  const best = close[0]?.distance ?? 0;
  const top = close.filter((entry) => entry.distance === best).map((entry) => entry.item);
  return top.length === 1
    ? { kind: "one", item: top[0] as T, exact: false }
    : { kind: "many", items: top };
}

/** Thrown when a reference resolves to nothing or to several things; the model gets the list. */
/** How many names a failed lookup lists in its reason; the model still gets them all. */
const LISTED_CANDIDATES = 10;

/** "a, b and c", or "a, b, … and 12 more" past the first ten. */
export function listNames(names: readonly string[]): string {
  const shown = names.slice(0, LISTED_CANDIDATES);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(", ")} and ${more} more`;
  if (shown.length <= 1) return shown.join("");
  return `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}

/**
 * A name that matched nothing, or more than one thing. The reason is the whole sentence a person
 * reads under the failed row (B3-09, spec 19.4): it lists the candidates itself, so it never ends
 * on a dangling "These exist:", and it speaks to the person. The model gets the full list too.
 */
export class ResolveFailure extends Error {
  constructor(
    reason: string,
    readonly candidates: string[],
  ) {
    super(completeReason(reason, candidates));
    this.name = "ResolveFailure";
  }
}

function completeReason(reason: string, candidates: readonly string[]): string {
  const text = reason.trim();
  const list = listNames(candidates);
  if (text.endsWith(":")) return list ? `${text} ${list}.` : `${text.slice(0, -1).trimEnd()}.`;
  return list ? `${text} Choices: ${list}.` : text;
}

const KIND_WORD = {
  project: "project",
  environment: "environment",
  service: "service",
  server: "server",
};

function pick<T extends Named>(
  kind: keyof typeof KIND_WORD,
  items: readonly T[],
  query: string,
  label: (item: T) => string = (item) => item.name,
): T {
  const match = matchByName(items, query);
  if (match.kind === "one") return match.item;
  if (match.kind === "many") {
    throw new ResolveFailure(
      `More than one ${KIND_WORD[kind]} matches "${query}":`,
      match.items.map(label),
    );
  }
  throw new ResolveFailure(
    items.length === 0
      ? `There is no ${KIND_WORD[kind]} you can open yet.`
      : `No ${KIND_WORD[kind]} you can open matches "${query}". There are:`,
    items.slice(0, 40).map(label),
  );
}

// ---- Projects and environments

export interface ProjectRef extends Named {
  environments: { id: string; name: string; isProduction: boolean }[];
}

export async function visibleProjects(ctx: AgentContext): Promise<ProjectRef[]> {
  const { db } = ctx.services;
  const projects = await db
    .selectFrom("project")
    .select(["id", "name"])
    .where("workspace_id", "=", ctx.actor.workspace.id)
    .orderBy("created_at")
    .execute();
  const seen = ctx.actor.access.visible(
    projects.map((row) => ({ kind: "project" as const, id: row.id })),
  );
  const ids = new Set(seen.map((item) => item.id));
  const environments =
    ids.size === 0
      ? []
      : await db
          .selectFrom("environment")
          .select(["id", "name", "project_id"])
          .where("project_id", "in", [...ids])
          .orderBy("created_at")
          .execute();
  const envVisible = new Set(
    ctx.actor.access
      .visible(
        environments.map((row) => ({
          kind: "environment" as const,
          id: row.id,
          projectId: row.project_id,
        })),
      )
      .map((item) => item.id),
  );
  return projects
    .filter((row) => ids.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      environments: environments
        .filter((env) => env.project_id === row.id && envVisible.has(env.id))
        .map((env) => ({ id: env.id, name: env.name, isProduction: env.name === "production" })),
    }));
}

export async function resolveProject(ctx: AgentContext, query: string): Promise<ProjectRef> {
  return pick("project", await visibleProjects(ctx), query);
}

/** An environment of a project by name; without a name, "development", else the first non-production one. */
export function resolveEnvironment(
  project: ProjectRef,
  query: string | null | undefined,
): ProjectRef["environments"][number] {
  if (query?.trim()) {
    const wanted = query.trim().toLowerCase();
    const alias =
      wanted === "prod" || wanted === "prd"
        ? "production"
        : wanted === "dev"
          ? "development"
          : wanted;
    const found =
      project.environments.find((env) => env.id === wanted || env.name === alias) ??
      (() => {
        const match = matchByName(project.environments, alias);
        return match.kind === "one" ? match.item : undefined;
      })();
    if (found) return found;
    throw new ResolveFailure(
      `The project ${project.name} has no environment called "${query}". Its environments:`,
      project.environments.map((env) => env.name),
    );
  }
  const preferred =
    project.environments.find((env) => env.name === "development") ??
    project.environments.find((env) => !env.isProduction) ??
    project.environments[0];
  if (!preferred) {
    throw new ResolveFailure(`The project ${project.name} has no environment you can open.`, []);
  }
  return preferred;
}

// ---- Services

export interface ServiceRef extends Named {
  kind: ServiceKind;
  appName: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
  isProduction: boolean;
  serverId: string;
  serverName: string;
  status: string;
}

export function serviceLabel(service: ServiceRef): string {
  return `${service.name} (${service.projectName} / ${service.environmentName}, on ${service.serverName})`;
}

export async function visibleServices(ctx: AgentContext): Promise<ServiceRef[]> {
  const { db } = ctx.services;
  const rows = await db
    .selectFrom("service as s")
    .innerJoin("project as p", "p.id", "s.project_id")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .leftJoin("server as v", "v.id", "s.server_id")
    .select([
      "s.id",
      "s.name",
      "s.kind",
      "s.app_name",
      "s.project_id",
      "s.environment_id",
      "s.server_id",
      "s.status",
      "p.name as project_name",
      "e.name as environment_name",
      "v.name as server_name",
    ])
    .where("s.workspace_id", "=", ctx.actor.workspace.id)
    .orderBy("p.created_at")
    .orderBy("e.created_at")
    .orderBy("s.name")
    .execute();
  return rows
    .filter((row) => ctx.actor.access.can("service.see", serviceTarget(row)))
    .map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      appName: row.app_name,
      aliases: [row.app_name],
      projectId: row.project_id,
      projectName: row.project_name,
      environmentId: row.environment_id,
      environmentName: row.environment_name,
      isProduction: row.environment_name === "production",
      serverId: row.server_id ?? HOST_TARGET,
      serverName: row.server_id ? (row.server_name ?? "a server") : "Nearzero host",
      status: row.status,
    }));
}

/**
 * A service by name (typos tolerated), app name, a container name (app name plus a suffix), a
 * deployment log path or deployment id, or its id; optionally narrowed to a project and
 * environment.
 */
export async function resolveService(
  ctx: AgentContext,
  query: string,
  within: { project?: string | null; environment?: string | null } = {},
): Promise<ServiceRef> {
  let all = await visibleServices(ctx);
  if (within.project?.trim()) {
    const project = await resolveProject(ctx, within.project);
    all = all.filter((service) => service.projectId === project.id);
    if (within.environment?.trim()) {
      const environment = resolveEnvironment(project, within.environment);
      all = all.filter((service) => service.environmentId === environment.id);
    }
  } else if (within.environment?.trim()) {
    const wanted = within.environment.trim().toLowerCase();
    const narrowed = all.filter((service) => service.environmentName === wanted);
    if (narrowed.length > 0) all = narrowed;
  }
  const raw = query.trim();
  // A deployment id, or a path or text that carries one (a deployment log path).
  const ids = [...raw.matchAll(UUID_INSIDE)].map((match) => match[0].toLowerCase());
  for (const id of ids) {
    const direct = all.find((service) => service.id === id);
    if (direct) return direct;
    const deployment = await ctx.services.db
      .selectFrom("deployment")
      .select(["service_id"])
      .where("workspace_id", "=", ctx.actor.workspace.id)
      .where("id", "=", id)
      .executeTakeFirst();
    const owner = deployment?.service_id
      ? all.find((service) => service.id === deployment.service_id)
      : undefined;
    if (owner) return owner;
  }
  // A container name or path segment: "<app name>" or "<app name>-<anything>" or ".../<app name>/...".
  const segments = raw
    .toLowerCase()
    .split(/[\s/\\:]+/)
    .filter((part) => part !== "");
  for (const segment of segments) {
    const byApp = all.filter(
      (service) =>
        segment === service.appName ||
        segment.startsWith(`${service.appName}-`) ||
        segment.startsWith(`${service.appName}.`),
    );
    if (byApp.length === 1) return byApp[0] as ServiceRef;
  }
  return pick("service", all, raw, serviceLabel);
}

// ---- Servers

export interface ServerRef extends Named {
  address: string | null;
  isHost: boolean;
}

export async function visibleServers(ctx: AgentContext): Promise<ServerRef[]> {
  const rows = await ctx.services.db
    .selectFrom("server")
    .select(["id", "name", "address"])
    .where("workspace_id", "=", ctx.actor.workspace.id)
    .orderBy("name")
    .execute();
  const seen = new Set(
    ctx.actor.access
      .visible(rows.map((row) => ({ kind: "server" as const, id: row.id })))
      .map((item) => item.id),
  );
  const servers: ServerRef[] = rows
    .filter((row) => seen.has(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      address: row.address,
      aliases: [row.address],
      isHost: false,
    }));
  if (ctx.actor.access.can("host.use")) {
    servers.push({
      id: HOST_TARGET,
      name: "Nearzero host",
      address: null,
      aliases: ["host", "nearzero", "the host", "nearzero-host", "control plane"],
      isHost: true,
    });
  }
  return servers;
}

export async function resolveServer(ctx: AgentContext, query: string): Promise<ServerRef> {
  const all = await visibleServers(ctx);
  const raw = query.trim();
  if (raw.toLowerCase() === HOST_TARGET) {
    const host = all.find((server) => server.isHost);
    if (host) return host;
  }
  return pick("server", all, raw, (server) =>
    server.isHost ? "Nearzero host" : `${server.name} (${server.address})`,
  );
}
