import type { LegacyWorkload } from "./moves.ts";

/**
 * The optional in-place fields of spec 29a.9, read leniently: 29a.9 names what they hold, not
 * their exact shape, so each reader accepts the plain forms an exporter is likely to write and
 * ignores anything else.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;
const KINDS = new Set(["swarm-service", "swarm-stack", "container", "compose-project"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.filter((item): item is string => typeof item === "string" && NAME.test(item));
}

/**
 * Workloads to stop and start again, from any of:
 * - `[{ kind, name }]` (or one such object);
 * - `{ containers, services | swarmServices, composeProject | composeProjects, stack | stacks }`;
 * - `{ container | service | name }` for one router (servers[].legacy);
 * - a name alone, taken as a container.
 */
export function legacyWorkloads(value: unknown): LegacyWorkload[] {
  const out: LegacyWorkload[] = [];
  const add = (kind: LegacyWorkload["kind"], name: string) => {
    if (NAME.test(name) && !out.some((item) => item.kind === kind && item.name === name)) {
      out.push({ kind, name });
    }
  };
  const visit = (item: unknown) => {
    if (typeof item === "string") return add("container", item);
    if (!isObject(item)) return;
    if (typeof item.kind === "string") {
      // A kind 1.0 can't stop and start is left alone rather than guessed at.
      if (typeof item.name === "string" && KINDS.has(item.kind)) {
        add(item.kind as LegacyWorkload["kind"], item.name);
      }
      return;
    }
    for (const name of names(item.containers ?? item.container)) add("container", name);
    for (const name of names(item.services ?? item.swarmServices ?? item.service))
      add("swarm-service", name);
    for (const name of names(item.composeProject ?? item.composeProjects ?? item.project))
      add("compose-project", name);
    for (const name of names(item.stack ?? item.stacks ?? item.swarmStack))
      add("swarm-stack", name);
    if (typeof item.name === "string" && out.length === 0) add("container", item.name);
  };
  if (Array.isArray(value)) value.forEach(visit);
  else visit(value);
  return out;
}

export interface WebhookPattern {
  pattern: string;
  kind: "deploy" | "github";
}

/** A path 1.0 can answer: absolute, no query, not one of 1.0's own API addresses. */
function usablePath(path: string): boolean {
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/{}-]{1,499}$/.test(path) && !path.startsWith("/api/v1/");
}

/**
 * The 0.1.x webhook paths (install.json `legacyWebhookPaths`, 29a.9), with "{token}" where a
 * deploy webhook's token goes. Accepted: a list of paths; `{ deploy, github }` (each a path or a
 * list; a key naming GitHub marks the GitHub App's path); or `[{ kind, path }]`. A path without
 * "{token}" is the GitHub App's only when it is marked so.
 */
export function legacyWebhookPatterns(value: unknown): WebhookPattern[] {
  const out: WebhookPattern[] = [];
  const add = (path: unknown, github: boolean) => {
    if (typeof path !== "string" || !usablePath(path)) return;
    const kind = github ? "github" : path.includes("{token}") ? "deploy" : null;
    if (kind && !out.some((item) => item.pattern === path)) out.push({ pattern: path, kind });
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") add(item, /github/i.test(item) && !item.includes("{token}"));
      else if (isObject(item))
        add(item.path ?? item.pattern, /github/i.test(String(item.kind ?? "")));
    }
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      for (const path of Array.isArray(item) ? item : [item]) add(path, /github/i.test(key));
    }
  }
  return out;
}

/** The token a path carries under a pattern, "" for a pattern without one, or null for no match. */
export function matchWebhookPath(pattern: string, path: string): string | null {
  const parts = pattern.split("{token}");
  if (parts.length > 2) return null;
  const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const source =
    parts.length === 2
      ? `^${escaped(parts[0] as string)}([A-Za-z0-9._~-]{1,256})${escaped(parts[1] as string)}/?$`
      : `^${escaped(pattern.replace(/\/+$/, ""))}/?$`;
  const match = new RegExp(source).exec(path);
  if (!match) return null;
  return parts.length === 2 ? decodeURIComponent(match[1] as string) : "";
}

/** The kinds the 0.1.x control plane runs as (29a.9 `controlPlane`). */
const CONTROL_PLANE_KINDS = new Set(["container", "swarm-service", "compose-project"]);

/**
 * What runs the 0.1.x control plane on the host (install.json `controlPlane`): a list of
 * `{ kind, name }`, kind `container`, `swarm-service` or `compose-project`. The move stops
 * exactly these; any other entry is left out.
 */
export function controlPlaneWorkloads(value: unknown): LegacyWorkload[] {
  if (!Array.isArray(value)) return [];
  return legacyWorkloads(value.filter(isObject)).filter((item) =>
    CONTROL_PLANE_KINDS.has(item.kind),
  );
}

export interface ControlPlaneDetails {
  composeProject: string | null;
  folder: string | null;
  ports: number[];
  /** Its Compose files in the folder, in the order Compose reads them (29a.9). */
  composeFiles: string[];
  /** The file its variables come from, in the folder. */
  envFile: string | null;
}

/** An absolute folder of plain characters, without a trailing slash, or null. */
export function plainFolder(value: unknown): string | null {
  return typeof value === "string" &&
    /^\/[A-Za-z0-9._/-]{0,499}$/.test(value) &&
    !value.split("/").includes("..")
    ? value.replace(/\/+$/, "") || "/"
    : null;
}

/**
 * A Compose project's own files from a service's `legacy` (29a.9): its folder, Compose files in
 * order and env file, the same as `controlPlaneDetails`. Nothing without a usable folder.
 */
export function stackFiles(
  value: unknown,
): { folder: string; composeFiles: string[]; envFile?: string } | null {
  if (!isObject(value)) return null;
  const folder = plainFolder(value.folder);
  if (!folder) return null;
  const composeFiles = [
    ...new Set(
      (Array.isArray(value.composeFiles) ? value.composeFiles : [])
        .map(folderFile)
        .filter((name): name is string => name !== null),
    ),
  ];
  const envFile = envFileValue(value.envFile);
  return { folder, composeFiles, ...(envFile ? { envFile } : {}) };
}

/**
 * An env file (29a.9): a name inside the folder, or an absolute path where 0.1.x keeps it
 * elsewhere (a stack's env file). Plain characters only and no `..`; that an absolute one is a
 * regular file under the 0.1.x install's data folders is checked on the server before it is
 * used, and 1.0 never writes to it.
 */
export function envFileValue(value: unknown): string | null {
  const name = folderFile(value);
  if (name) return name;
  if (typeof value !== "string") return null;
  const path = value.replace(/\/{2,}/g, "/");
  return /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)+$/.test(path) &&
    !path.split("/").includes("..") &&
    path.length <= 500
    ? path
    : null;
}

/** A file named inside the folder: plain characters, no way out of it. */
function folderFile(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/^\.\//, "");
  return /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(name) &&
    !name.split("/").includes("..") &&
    name.length <= 255
    ? name
    : null;
}

/**
 * The Compose project, folder and ports the 0.1.x control plane uses (install.json
 * `controlPlaneDetails`), for the dry-run report and rollback, with its Compose files and env
 * file (names in the folder). Read leniently; a folder must be an absolute path of plain
 * characters, and a file a name inside it.
 */
export function controlPlaneDetails(value: unknown): ControlPlaneDetails | null {
  if (!isObject(value)) return null;
  const project = value.composeProject ?? value.project ?? value.compose;
  const folder = value.folder ?? value.directory ?? value.path;
  const ports = (Array.isArray(value.ports) ? value.ports : [])
    .map((port) => (typeof port === "string" ? Number.parseInt(port, 10) : port))
    .filter((port): port is number => Number.isInteger(port) && port >= 1 && port <= 65535);
  const details: ControlPlaneDetails = {
    composeProject: typeof project === "string" && NAME.test(project) ? project : null,
    folder:
      typeof folder === "string" &&
      /^\/[A-Za-z0-9._/-]{0,499}$/.test(folder) &&
      !folder.includes("..")
        ? folder.replace(/\/+$/, "") || "/"
        : null,
    ports: [...new Set(ports)],
    composeFiles: [
      ...new Set(
        (Array.isArray(value.composeFiles) ? value.composeFiles : [])
          .map(folderFile)
          .filter((name): name is string => name !== null),
      ),
    ],
    envFile: envFileValue(value.envFile),
  };
  return details.composeProject || details.folder || details.ports.length > 0 ? details : null;
}

/** The dry-run report's line about the 0.1.x control plane, or null with nothing to say. */
export function controlPlaneLine(
  workloads: LegacyWorkload[],
  details: ControlPlaneDetails | null,
): string | null {
  if (workloads.length === 0 && !details) return null;
  const parts: string[] = [];
  if (details?.composeProject) parts.push(`Compose project ${details.composeProject}`);
  if (details?.folder) parts.push(`in ${details.folder}`);
  if (details && details.ports.length > 0) {
    parts.push(`holding port${details.ports.length === 1 ? "" : "s"} ${details.ports.join(", ")}`);
  }
  const where = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  const what =
    workloads.length > 0
      ? `: ${workloads.map((item) => `${item.kind} ${item.name}`).join(", ")} ${workloads.length === 1 ? "stops when the move starts, and rollback starts it again" : "stop when the move starts, and rollback starts them again"}.`
      : ". The export doesn't say what runs it, so the installer stops nothing; while its ports are held, the move doesn't start.";
  return `The 0.1.x control plane${where}${what}`;
}
