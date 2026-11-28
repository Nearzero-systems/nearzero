import {
  editionLabels,
  HOST_RESERVED_PORTS,
  NEARZERO_LABELS,
  PRIVATE_NETWORK,
  reservedPortMessage,
  SERVER_RESERVED_PORTS,
  SERVICE_FOLDER_VARIABLE,
} from "@nearzero/shared";
import { Document, Scalar, YAMLSeq } from "yaml";
import { type ComposeInventory, isObject, type Model, servicesOf, volumeEntry } from "./model.ts";
import { type FolderContext, placeOf } from "./privileged.ts";

/**
 * The files Nearzero runs for a stack (spec 07 7.2, 7.3, 05 5.5): the person's Compose file as it
 * is, then Nearzero's additions, which Docker Compose merges on top, and the env file with the
 * service's variables. The additions carry Nearzero's labels (which service and deployment a
 * container belongs to, and the router's hostnames for it), drop container_name (so copies in
 * other environments and other stacks can't collide), tag built images per deployment (so a
 * failed deploy can go back to the previous images), and write bind mounts inside the service's
 * folder through ${NEARZERO_SERVICE_FOLDER}, the folder as the Docker Engine sees it. Secrets
 * never appear in them: values reach Compose only through the env file.
 */

export const COMPOSE_LABEL = "dev.nearzero.compose-service";
export const ROUTE_HOSTNAMES_LABEL = "dev.nearzero.route.hostnames";
export const ROUTE_PORT_LABEL = "dev.nearzero.route.port";

/** The address the router sends a hostname to: <app name>-<inner service> on nearzero-edge. */
export function innerAlias(appName: string, service: string): string {
  return `${appName}-${service.toLowerCase()}`;
}

/** The tag of a built inner service's image for one deployment. */
export function builtImage(appName: string, service: string, deploymentId: string): string {
  const name = service.toLowerCase().replace(/[^a-z0-9._-]/g, "-");
  return `nearzero/${appName}-${name}:${deploymentId.slice(0, 8)}`;
}

export interface RouteForLabels {
  composeService: string;
  url: string;
  port: number;
}

export interface AdditionsInput {
  /** The person's file, parsed but not interpolated. */
  model: Model;
  /** The same file interpolated with the service's variables (for where paths point). */
  resolved: Model;
  inventory: ComposeInventory;
  folder: FolderContext;
  serviceId: string;
  /** null for Preview: the labels then say the deployment's id is set at deploy. */
  deploymentId: string | null;
  routes: RouteForLabels[];
}

export interface Additions {
  text: string;
  /** Bind-mount sources inside the service's folder, relative to it (made and checked first). */
  bindPaths: string[];
}

function quoted(value: string): Scalar {
  const node = new Scalar(value);
  node.type = Scalar.QUOTE_DOUBLE;
  return node;
}

function quoteAll(value: unknown): unknown {
  if (typeof value === "string") return quoted(value);
  if (Array.isArray(value)) return value.map(quoteAll);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, quoteAll(item)]));
  }
  return value;
}

/** A bind source rewritten to the folder as the Engine sees it, when it is a plain relative path. */
function folderPath(raw: string, resolved: string, folder: FolderContext): string | null {
  if (raw.includes("$")) return null;
  const place = placeOf(resolved, folder);
  if (!place.inside) return null;
  return place.path === ""
    ? `\${${SERVICE_FOLDER_VARIABLE}}`
    : `\${${SERVICE_FOLDER_VARIABLE}}/${place.path}`;
}

function rewriteVolume(raw: unknown, resolvedEntry: unknown, folder: FolderContext) {
  const entry = volumeEntry(raw);
  const resolved = volumeEntry(resolvedEntry);
  if (entry.type !== "bind" || !entry.source || !resolved.source) return { value: raw, path: null };
  const rewritten = folderPath(entry.source, resolved.source, folder);
  const place = placeOf(resolved.source, folder);
  const path = place.inside ? place.path : null;
  if (!rewritten) return { value: raw, path };
  if (typeof raw === "string") {
    const rest = raw.slice(entry.source.length);
    return { value: `${rewritten}${rest}`, path };
  }
  return { value: { ...(raw as Record<string, unknown>), source: rewritten }, path };
}

export function renderAdditions(input: AdditionsInput): Additions {
  const { model, resolved, folder, serviceId, deploymentId } = input;
  const appName = folder.appName;
  const bindPaths = new Set<string>();
  const services: Record<string, unknown> = {};
  const resolvedServices = new Map(servicesOf(resolved));
  for (const [name, service] of servicesOf(model)) {
    const entry: Record<string, unknown> = {};
    if (service.container_name !== undefined) {
      const reset = new Scalar(null);
      reset.tag = "!reset";
      entry.container_name = reset;
    }
    const built = service.build !== undefined && service.build !== null;
    if (built && service.image === undefined) {
      entry.image = quoted(builtImage(appName, name, deploymentId ?? "00000000"));
    }
    const ownLabels: Record<string, string> = {
      [NEARZERO_LABELS.managed]: "true",
      ...editionLabels(),
      [NEARZERO_LABELS.service]: serviceId,
      [NEARZERO_LABELS.deployment]: deploymentId ?? "<this deployment's id>",
      [COMPOSE_LABEL]: name,
    };
    const routes = input.routes.filter((route) => route.composeService === name);
    if (routes.length > 0) {
      ownLabels[ROUTE_HOSTNAMES_LABEL] = routes.map((route) => route.url).join(",");
      ownLabels[ROUTE_PORT_LABEL] = String(routes[0]?.port ?? "");
    }
    if (built) {
      entry.build = {
        labels: quoteAll({
          [NEARZERO_LABELS.managed]: "true",
          ...editionLabels(),
          [NEARZERO_LABELS.service]: serviceId,
        }),
      };
    }
    entry.labels = quoteAll(ownLabels);

    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    const resolvedVolumes = (resolvedServices.get(name)?.volumes as unknown[] | undefined) ?? [];
    let rewrote = false;
    const next = volumes.map((raw, index) => {
      const result = rewriteVolume(raw, resolvedVolumes[index], folder);
      if (result.path !== null) bindPaths.add(result.path);
      if (result.value !== raw) rewrote = true;
      return result.value;
    });
    if (rewrote) {
      const list = new YAMLSeq();
      list.tag = "!override";
      for (const item of next) list.items.push(quoteAll(item) as never);
      entry.volumes = list;
    }
    services[name] = entry;
  }

  const top: Record<string, unknown> = { services };
  const volumes: Record<string, unknown> = {};
  for (const volume of input.inventory.volumes) {
    if (volume.external) continue;
    volumes[volume.key] = {
      labels: quoteAll({
        [NEARZERO_LABELS.managed]: "true",
        ...editionLabels(),
        [NEARZERO_LABELS.service]: serviceId,
      }),
    };
  }
  if (Object.keys(volumes).length > 0) top.volumes = volumes;
  for (const section of ["configs", "secrets"] as const) {
    const declared = isObject(model[section]) ? model[section] : {};
    const resolvedSection = isObject(resolved[section]) ? resolved[section] : {};
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(declared)) {
      const resolvedValue = resolvedSection[key];
      if (!isObject(value) || typeof value.file !== "string" || !isObject(resolvedValue)) continue;
      const rewritten = folderPath(value.file, String(resolvedValue.file ?? ""), folder);
      if (rewritten) out[key] = { file: quoted(rewritten) };
    }
    if (Object.keys(out).length > 0) top[section] = out;
  }

  const doc = new Document(top);
  doc.commentBefore = [
    " Nearzero's additions. Docker Compose merges this file over yours, which runs as it is.",
    " - Labels say which service and deployment each container belongs to, and which",
    "   hostnames the router sends to it.",
    " - container_name is dropped, so this stack can't collide with its copies or other stacks.",
    ` - Bind mounts inside the service's folder use \${${SERVICE_FOLDER_VARIABLE}}, the folder as Docker sees it.`,
    ...networkWords(
      input.inventory.services.map((item) => item.name),
      input.routes.map((route) => route.composeService),
      appName,
    ),
    " - Variables reach Compose as an env file; their values never appear in this file.",
  ].join("\n");
  const text = doc.toString({ lineWidth: 0, defaultKeyType: "PLAIN", nullStr: "null" });
  return { text, bindPaths: [...bindPaths].sort() };
}

/**
 * Which inner services join the shared private network (30b R2-11, 31b): only those with a
 * hostname, as <app name>-<service>, the address the router sends their hostnames to. The others
 * stay on the stack's own network, out of other apps' reach.
 */
export function networkWords(
  inner: readonly string[],
  routed: readonly string[],
  appName: string,
): string[] {
  const joining = inner.filter((name) => routed.includes(name));
  const staying = inner.filter((name) => !routed.includes(name));
  const list = (names: readonly string[]) =>
    names.length <= 1
      ? (names[0] ?? "")
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  if (joining.length === 0) {
    return [
      ` - Only inner services with a hostname join the shared private network ${PRIVATE_NETWORK}.`,
      "   None has one yet, so every service stays on the stack's own network; one that gets a",
      "   hostname joins it then.",
    ];
  }
  return [
    ` - Only inner services with a hostname join the shared private network ${PRIVATE_NETWORK}`,
    `   (here ${list(joining)}, as ${appName}-<service>), the address the router sends their`,
    "   hostnames to.",
    ...(staying.length > 0
      ? [
          `   ${list(staying)} ${staying.length === 1 ? "stays" : "stay"} on the stack's own network.`,
        ]
      : []),
  ];
}

// ---- The env file (spec 05 5.5)

/**
 * One NAME=value line per variable, in Compose's env file syntax. Values are double-quoted with
 * backslashes, double quotes and dollar signs escaped, so Compose reads every value exactly as
 * it was saved (no interpolation inside it, no escape sequences).
 */
export function renderEnvFile(variables: readonly { name: string; value: string }[]): string {
  const lines = ["# Written by Nearzero from this service's variables. Edit them under Variables."];
  for (const { name, value } of variables) {
    const escaped = value
      .replaceAll("\\", () => "\\\\")
      .replaceAll('"', () => '\\"')
      .replaceAll("$", () => "$$");
    lines.push(`${name}="${escaped}"`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- Published ports

function publishedPorts(entry: unknown): number[] {
  if (typeof entry === "number") return [];
  if (isObject(entry)) {
    const published = entry.published;
    if (published === undefined || published === null || published === "") return [];
    return rangeOf(String(published));
  }
  if (typeof entry !== "string") return [];
  const withoutProtocol = entry.split("/")[0] as string;
  const parts = withoutProtocol.split(":");
  if (parts.length < 2) return [];
  return rangeOf(parts[parts.length - 2] as string);
}

function rangeOf(text: string): number[] {
  const [from, to] = text.split("-").map(Number);
  if (!Number.isInteger(from)) return [];
  const end = Number.isInteger(to) ? (to as number) : (from as number);
  const out: number[] = [];
  for (let port = from as number; port <= end && out.length < 1000; port++) out.push(port);
  return out;
}

/** Ports the file publishes that Nearzero itself needs on the server (spec 6.8). */
export function reservedPortProblems(resolved: Model, onHost: boolean): string[] {
  const reserved = new Set<number>([
    ...SERVER_RESERVED_PORTS,
    ...(onHost ? HOST_RESERVED_PORTS : []),
  ]);
  const problems = new Set<string>();
  for (const [name, service] of servicesOf(resolved)) {
    for (const entry of Array.isArray(service.ports) ? service.ports : []) {
      for (const port of publishedPorts(entry)) {
        if (reserved.has(port)) problems.add(`${name}: ${reservedPortMessage(port)}`);
      }
    }
  }
  return [...problems];
}
