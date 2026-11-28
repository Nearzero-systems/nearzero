import {
  DATABASE_DEFAULTS,
  type DatabaseKind,
  isDatabaseKind,
  PROJECT_SORT_LABELS,
  SERVICE_KIND_LABELS,
  PROJECT_SORTS as SORT_KEYS,
} from "@nearzero/shared/browser";
import type {
  EnvironmentBrief,
  ProjectView,
  ServerTarget,
  ServiceKind,
  ServiceStatus,
  ServiceView,
} from "./data/index.ts";
import type { IconName } from "./icons.ts";

/** Sorting, wording and small rules for projects and services (spec 5.1, 5.2, 6, 7, 8). */

export type PillStatus = "ok" | "run" | "warn" | "fail" | "idle";

export const PROJECT_SORTS = SORT_KEYS.map((value) => ({
  value,
  label: PROJECT_SORT_LABELS[value],
}));
export type ProjectSort = (typeof SORT_KEYS)[number];
export const DEFAULT_PROJECT_SORT: ProjectSort = "newest";
export const PROJECT_SORT_COOKIE = "nz_projects_sort";

export function parseProjectSort(value: unknown): ProjectSort {
  return (SORT_KEYS as readonly unknown[]).includes(value)
    ? (value as ProjectSort)
    : DEFAULT_PROJECT_SORT;
}

type Sortable = Pick<ProjectView, "name" | "createdAt" | "serviceCount">;

/** The same orders the API uses, for the cards the browser re-sorts in place. */
export function sortProjects<T extends Sortable>(projects: readonly T[], sort: ProjectSort): T[] {
  const byName = (a: T, b: T) => a.name.localeCompare(b.name);
  const sorters: Record<ProjectSort, (a: T, b: T) => number> = {
    "name-asc": byName,
    "name-desc": (a, b) => byName(b, a),
    newest: (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    oldest: (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    "most-services": (a, b) => b.serviceCount - a.serviceCount || byName(a, b),
    "least-services": (a, b) => a.serviceCount - b.serviceCount || byName(a, b),
  };
  return [...projects].sort(sorters[sort]);
}

export function matchesSearch(
  project: Pick<ProjectView, "name" | "description">,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return `${project.name}\n${project.description}`.toLowerCase().includes(needle);
}

/** "N total" or "N of M total" (spec 5.1). */
export function countLabel(shown: number, total: number): string {
  return shown === total ? `${total} total` : `${shown} of ${total} total`;
}

/** Where a project card leads: the API's choice (development, else default, else first). */
export function openingEnvironment(
  project: Pick<ProjectView, "environments" | "openEnvironmentId">,
): EnvironmentBrief | null {
  if (project.openEnvironmentId) {
    const chosen = project.environments.find((env) => env.id === project.openEnvironmentId);
    if (chosen) return chosen;
  }
  return (
    project.environments.find((env) => env.name === "development") ??
    project.environments.find((env) => env.isDefault) ??
    project.environments[0] ??
    null
  );
}

export function servicesLabel(count: number): string {
  return `${count} service${count === 1 ? "" : "s"}`;
}

// ---------- Services

export const SERVICE_STATUS: Record<ServiceStatus, { pill: PillStatus; label: string }> = {
  running: { pill: "ok", label: "Running" },
  deploying: { pill: "run", label: "Deploying" },
  failed: { pill: "fail", label: "Error" },
  stopped: { pill: "idle", label: "Not running" },
  idle: { pill: "idle", label: "Not running" },
};

export { isDatabaseKind };

export function isDatabase(service: Pick<ServiceView, "kind">): boolean {
  return isDatabaseKind(service.kind);
}

/** Applications and Compose services can have hostnames (spec 10). */
export function isRoutable(service: Pick<ServiceView, "kind">): boolean {
  return service.kind === "application" || service.kind === "compose";
}

export function serviceTypeLabel(kind: ServiceKind): string {
  return SERVICE_KIND_LABELS[kind];
}

/**
 * The type names every page uses (spec 21.10): Application, Compose, Postgres, Mysql, Mariadb,
 * Mongo, Redis, LibSQL. One table for all of them (B3-21).
 */
export function serviceKindName(kind: ServiceKind): string {
  return SERVICE_KIND_LABELS[kind];
}

/** Lists and the canvas show applications, then Compose services, then databases, each oldest first. */
export function inServiceOrder<T extends Pick<ServiceView, "kind" | "createdAt">>(
  services: readonly T[],
): T[] {
  const rank = (service: T) =>
    service.kind === "application" ? 0 : service.kind === "compose" ? 1 : 2;
  return [...services].sort(
    (a, b) => rank(a) - rank(b) || a.createdAt.getTime() - b.createdAt.getTime(),
  );
}

export function serviceIcon(kind: ServiceKind): IconName {
  if (kind === "application") return "app";
  if (kind === "compose") return "compose";
  return "database";
}

/**
 * Whether a service belongs on the Overview canvas: its last deploy succeeded (spec 5.2). The
 * API reports the newest finished deployment (cancelled ones don't count); without that summary
 * a service counts once it has run.
 */
export function onCanvas(
  service: Pick<ServiceView, "status"> & { deploy?: ServiceView["deploy"] },
): boolean {
  if (service.deploy) return service.deploy.last?.succeeded === true;
  return service.status === "running" || service.status === "stopped";
}

export interface ImageSource {
  type: "image";
  image: string;
}

export function applicationSource(service: Pick<ServiceView, "settings">): ImageSource | null {
  const source = service.settings.source as { type?: unknown; image?: unknown } | null | undefined;
  if (source && source.type === "image" && typeof source.image === "string") {
    return { type: "image", image: source.image };
  }
  return null;
}

export function servicePort(service: Pick<ServiceView, "settings">): number {
  const port = service.settings.servicePort;
  return typeof port === "number" ? port : 3000;
}

const BUILD_LABELS: Record<string, string> = {
  dockerfile: "Dockerfile",
  railpack: "Railpack",
  nixpacks: "Nixpacks",
  heroku: "Heroku buildpacks",
  paketo: "Paketo buildpacks",
  static: "Static",
};

/**
 * The canvas card's detail row (spec 5.2, 21.10): apps show "Framework" (the detected framework,
 * else the build type, "Docker" for an image, else "Unknown"); other services show "Runtime"
 * with their container's app name.
 */
export function canvasDetail(
  service: Pick<ServiceView, "kind" | "settings"> & { appName?: string },
): {
  label: "Framework" | "Runtime";
  value: string;
} {
  if (service.kind === "application") {
    const framework = service.settings.framework;
    if (typeof framework === "string" && framework) return { label: "Framework", value: framework };
    const build = (service.settings.build as { type?: unknown } | undefined)?.type;
    const buildLabel = typeof build === "string" ? BUILD_LABELS[build] : undefined;
    if (buildLabel) return { label: "Framework", value: buildLabel };
    if (applicationSource(service)) return { label: "Framework", value: "Docker" };
    return { label: "Framework", value: "Unknown" };
  }
  if (service.appName) return { label: "Runtime", value: service.appName };
  if (service.kind === "compose") {
    return { label: "Runtime", value: composeFormat(service) === "stack" ? "Stack" : "Compose" };
  }
  const image = service.settings.image;
  return {
    label: "Runtime",
    value: typeof image === "string" && image ? image : SERVICE_KIND_LABELS[service.kind],
  };
}

export function composeFormat(service: Pick<ServiceView, "settings">): "compose" | "stack" {
  return service.settings.format === "stack" ? "stack" : "compose";
}

export function composeFile(service: Pick<ServiceView, "settings">): string {
  const source = service.settings.source as { type?: unknown; composeFile?: unknown } | null;
  return source && source.type === "raw" && typeof source.composeFile === "string"
    ? source.composeFile
    : "";
}

export interface DatabaseSettings {
  image: string;
  databaseName: string | null;
  user: string | null;
  port: number;
  dataVolume: string;
  replicaSet: boolean;
  nodeRole: "primary" | "replica" | null;
  primaryUrl: string | null;
  namespaces: boolean;
}

export function databaseSettings(
  service: Pick<ServiceView, "kind" | "settings">,
): DatabaseSettings {
  const defaults = isDatabaseKind(service.kind)
    ? DATABASE_DEFAULTS[service.kind as DatabaseKind]
    : null;
  const value = service.settings;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
  return {
    image: text("image") ?? defaults?.image ?? "",
    databaseName: text("databaseName"),
    user: text("user"),
    port: typeof value.port === "number" ? value.port : (defaults?.port ?? 0),
    dataVolume: text("dataVolume") ?? "",
    replicaSet: value.replicaSet === true,
    nodeRole:
      value.nodeRole === "replica" ? "replica" : value.nodeRole === "primary" ? "primary" : null,
    primaryUrl: text("primaryUrl"),
    namespaces: value.namespaces === true,
  };
}

// ---------- Where a new service can go

export interface ServerChoice {
  id: string;
  label: string;
}

/**
 * The server picker of the create dialogs (spec 08 8.1, 06 6.1): the Nearzero host as
 * "Nearzero (local)" when the person may use it, then the ready servers they can use.
 */
export function serverChoices(targets: readonly ServerTarget[]): ServerChoice[] {
  const host = targets.filter((target) => target.host);
  const ready = targets.filter((target) => !target.host && target.readiness === "ready");
  return [
    ...host.map((target) => ({ id: target.id, label: "Nearzero (local)" })),
    ...ready.map((target) => ({ id: target.id, label: target.name })),
  ];
}

export const NO_SERVER_MESSAGE =
  "There's no server you can deploy to yet. Add a server under Servers, or ask an owner or admin for access to one.";
