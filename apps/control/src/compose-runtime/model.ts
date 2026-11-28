import { isMap, parseDocument } from "yaml";

/**
 * A Compose file as Nearzero reads it (spec 07): parsed with merge keys resolved, checked for
 * the shape Docker Compose needs, and summed up as an inventory of its services (ports, images,
 * builds, dependencies) and volumes. Pure: nothing here reads a database or a server.
 *
 * The person's file is never rewritten. Nearzero runs it as it is, with a second file of its own
 * additions merged on top (render.ts), so anchors, comments, tags and quoting stay exactly theirs.
 */

export type Model = Record<string, unknown>;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The largest Compose file Nearzero takes (pasted, or read from a repository). */
export const COMPOSE_FILE_MAX_BYTES = 1024 * 1024;

/** Compose's own rule for service names. */
const SERVICE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export type ParseResult =
  | { ok: true; model: Model; warnings: string[] }
  | { ok: false; problem: string };

/** The first line of a YAML error, with where it is. */
function yamlProblem(error: {
  message: string;
  linePos?: [{ line: number; col: number }, ...unknown[]];
}) {
  const first = error.message.split("\n")[0]?.replace(/ at line \d+, column \d+:?$/, "") ?? "";
  const at = error.linePos?.[0];
  return at ? `line ${at.line}, column ${at.col}: ${first}` : first;
}

/**
 * Reads a Compose file. A problem is one sentence that names the line when YAML is broken, or
 * the service when the shape is wrong.
 */
export function parseComposeFile(text: string): ParseResult {
  if (text.trim() === "") return { ok: false, problem: "The Compose file is empty." };
  if (Buffer.byteLength(text, "utf8") > COMPOSE_FILE_MAX_BYTES) {
    return {
      ok: false,
      problem: `The Compose file is larger than ${COMPOSE_FILE_MAX_BYTES / 1024} KB.`,
    };
  }
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text, { merge: true, uniqueKeys: true, prettyErrors: true });
  } catch (error) {
    return { ok: false, problem: `It isn't valid YAML: ${(error as Error).message}` };
  }
  const first = doc.errors[0];
  if (first) return { ok: false, problem: `It isn't valid YAML: ${yamlProblem(first as never)}` };
  if (!isMap(doc.contents)) {
    return {
      ok: false,
      problem: "A Compose file is a map with a services: section at the top.",
    };
  }
  let model: unknown;
  try {
    model = doc.toJS({ maxAliasCount: 1000 });
  } catch (error) {
    return { ok: false, problem: `It isn't valid YAML: ${(error as Error).message}` };
  }
  if (!isObject(model)) {
    return { ok: false, problem: "A Compose file is a map with a services: section at the top." };
  }
  const shape = shapeProblem(model);
  if (shape) return { ok: false, problem: shape };
  // Compose's own tags (!reset, !override) are fine; other warnings are worth showing.
  const warnings = doc.warnings
    .map((warning) => yamlProblem(warning as never))
    .filter((message) => !/Unresolved tag: !(reset|override)\b/.test(message));
  return { ok: true, model, warnings };
}

function shapeProblem(model: Model): string | null {
  const services = model.services;
  if (services === undefined) return "The Compose file has no services: section.";
  if (!isObject(services)) return "services: must be a map of service names to their settings.";
  const names = Object.keys(services);
  if (names.length === 0) return "The Compose file has no services.";
  for (const name of names) {
    if (!SERVICE_NAME.test(name)) {
      return `"${name}" can't be a service name: use letters, digits, ., _ and -, starting with a letter or digit.`;
    }
    const service = services[name];
    if (!isObject(service)) return `The service ${name} must be a map of settings.`;
    if (
      service.image === undefined &&
      service.build === undefined &&
      service.extends === undefined
    ) {
      return `The service ${name} needs an image: or a build: to run.`;
    }
  }
  for (const section of ["volumes", "networks", "configs", "secrets"] as const) {
    const value = model[section];
    if (value !== undefined && value !== null && !isObject(value)) {
      return `${section}: must be a map of names to their settings.`;
    }
  }
  return null;
}

/** The services of a parsed file, by name. */
export function servicesOf(model: Model): [string, Record<string, unknown>][] {
  const services = isObject(model.services) ? model.services : {};
  return Object.entries(services).filter((entry): entry is [string, Record<string, unknown>] =>
    isObject(entry[1]),
  );
}

// ---- Inventory

export interface PublishedPort {
  port: number;
  protocol: "tcp" | "udp";
}

export interface InventoryService {
  name: string;
  /** The container port it listens on, when the file says (expose:, then ports:). */
  port: number | null;
  /** The server ports it publishes (ports: with a host port), for keeping them unique. */
  published: PublishedPort[];
  image: string | null;
  build: boolean;
  dependsOn: string[];
  /** network_mode, when set (such a service can't join Nearzero's network). */
  networkMode: string | null;
}

export interface InventoryVolume {
  /** The key in the file's volumes: section. */
  key: string;
  /** The name Docker gives it: <project>_<key>, its name:, or the key when external. */
  name: string;
  external: boolean;
  /** The services that mount it. */
  innerServices: string[];
}

export interface ComposeInventory {
  services: InventoryService[];
  volumes: InventoryVolume[];
}

function containerPort(entry: unknown): number | null {
  if (typeof entry === "number")
    return Number.isInteger(entry) && entry > 0 && entry < 65536 ? entry : null;
  if (isObject(entry) && "target" in entry) {
    const port = Number(entry.target);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  }
  if (typeof entry !== "string") return null;
  const withoutProtocol = entry.split("/")[0] as string;
  const last = withoutProtocol.split(":").at(-1) as string;
  const port = Number(last.split("-")[0]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** A port range like 8080-8085 (at most 1000 ports), or one port. */
function portRange(value: string): number[] {
  const [first, last] = value.split("-").map((part) => Number(part));
  if (!Number.isInteger(first) || (first as number) < 1 || (first as number) > 65535) return [];
  const end = last === undefined ? first : last;
  if (!Number.isInteger(end) || (end as number) < (first as number)) return [];
  const out: number[] = [];
  for (
    let port = first as number;
    port <= Math.min(end as number, 65535, (first as number) + 999);
    port++
  ) {
    out.push(port);
  }
  return out;
}

/**
 * The server ports one ports: entry publishes: none for a container port alone (Docker picks
 * a random one), and nothing it can't read (a variable, say).
 */
export function publishedPorts(entry: unknown): PublishedPort[] {
  if (isObject(entry)) {
    const protocol = entry.protocol === "udp" ? "udp" : "tcp";
    const published = entry.published;
    const text = typeof published === "number" ? String(published) : published;
    return typeof text === "string" ? portRange(text).map((port) => ({ port, protocol })) : [];
  }
  if (typeof entry !== "string" && typeof entry !== "number") return [];
  const [mapping = "", rawProtocol = "tcp"] = String(entry).split("/");
  const protocol = rawProtocol === "udp" ? "udp" : "tcp";
  // [host ip:]host port:container port; an IPv6 address is in brackets.
  const parts = mapping.replace(/^\[[^\]]*\]:/, "ip:").split(":");
  if (parts.length < 2) return [];
  return portRange(parts[parts.length - 2] as string).map((port) => ({ port, protocol }));
}

function dependsOn(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (isObject(value)) return Object.keys(value);
  return [];
}

/** A service's volume entry, as { source, target, type } (short or long syntax). */
export interface VolumeEntry {
  type: "bind" | "volume" | "tmpfs" | "other";
  source: string | null;
  target: string | null;
  readOnly: boolean;
  raw: unknown;
}

export function volumeEntry(entry: unknown): VolumeEntry {
  if (typeof entry === "string") {
    const parts = entry.split(":");
    // Windows drive letters aren't Compose on Linux; a source and a target, then options.
    if (parts.length === 1) {
      return {
        type: "volume",
        source: null,
        target: parts[0] ?? null,
        readOnly: false,
        raw: entry,
      };
    }
    const [source = "", target = "", options = ""] = parts;
    const bind = /^[./~$]/.test(source) || source.includes("/");
    return {
      type: bind ? "bind" : "volume",
      source,
      target,
      readOnly: options.split(",").includes("ro"),
      raw: entry,
    };
  }
  if (isObject(entry)) {
    const type = typeof entry.type === "string" ? entry.type : "volume";
    return {
      type: type === "bind" || type === "volume" || type === "tmpfs" ? type : "other",
      source: typeof entry.source === "string" ? entry.source : null,
      target: typeof entry.target === "string" ? entry.target : null,
      readOnly: entry.read_only === true,
      raw: entry,
    };
  }
  return { type: "other", source: null, target: null, readOnly: false, raw: entry };
}

export function composeInventory(model: Model, project: string): ComposeInventory {
  const services: InventoryService[] = [];
  const users = new Map<string, Set<string>>();
  for (const [name, service] of servicesOf(model)) {
    const exposed = Array.isArray(service.expose) ? service.expose : [];
    const ports = Array.isArray(service.ports) ? service.ports : [];
    services.push({
      name,
      port: [...exposed, ...ports].map(containerPort).find((value) => value !== null) ?? null,
      published: ports.flatMap(publishedPorts),
      image: typeof service.image === "string" ? service.image : null,
      build: service.build !== undefined && service.build !== null,
      dependsOn: dependsOn(service.depends_on),
      networkMode: typeof service.network_mode === "string" ? service.network_mode : null,
    });
    for (const raw of Array.isArray(service.volumes) ? service.volumes : []) {
      const entry = volumeEntry(raw);
      if (entry.type !== "volume" || !entry.source) continue;
      const set = users.get(entry.source) ?? new Set<string>();
      set.add(name);
      users.set(entry.source, set);
    }
  }
  const volumes: InventoryVolume[] = [];
  const declared = isObject(model.volumes) ? model.volumes : {};
  for (const [key, value] of Object.entries(declared)) {
    const options = isObject(value) ? value : {};
    const named = typeof options.name === "string" && options.name !== "" ? options.name : null;
    const external = options.external === true || isObject(options.external);
    const externalName =
      isObject(options.external) && typeof options.external.name === "string"
        ? options.external.name
        : null;
    volumes.push({
      key,
      name: named ?? externalName ?? (external ? key : `${project}_${key}`),
      external,
      innerServices: [...(users.get(key) ?? [])].sort(),
    });
  }
  return { services, volumes };
}

/** Services in an order that starts what they depend on first. */
export function startOrder(services: readonly InventoryService[]): string[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const done = new Set<string>();
  const order: string[] = [];
  const visit = (name: string, trail: Set<string>) => {
    if (done.has(name) || trail.has(name)) return;
    trail.add(name);
    for (const dependency of byName.get(name)?.dependsOn ?? []) visit(dependency, trail);
    trail.delete(name);
    done.add(name);
    if (byName.has(name)) order.push(name);
  };
  for (const service of services) visit(service.name, new Set());
  return order;
}

// ---- Variables in the file (Compose's interpolation)

export interface Placeholder {
  name: string;
  /** ${NAME:-x}, ${NAME-x}, ${NAME:+x} and ${NAME+x} work without the variable. */
  optional: boolean;
}

const NAME = /^[_a-zA-Z][_a-zA-Z0-9]*/;

/**
 * How much one interpolation of a whole file may read and write, in characters (C1-03). A file
 * is at most 1 MB and its variables at most 1 MB in all, so an honest file stays far below
 * this; a file that repeats a large variable thousands of times (or aliases a large string)
 * would otherwise grow without limit inside the control plane.
 */
export const COMPOSE_INTERPOLATION_MAX_CHARS = 8 * 1024 * 1024;

/** Thrown when filling in a file's variables would pass the limit above. */
export class InterpolationTooLarge extends Error {
  constructor(readonly variable: string | null) {
    super(
      variable
        ? `It grows past ${COMPOSE_INTERPOLATION_MAX_CHARS / 1024 / 1024} MB once its variables are filled in, mostly from ${variable}. Use ${variable} fewer times, or make it shorter.`
        : `It grows past ${COMPOSE_INTERPOLATION_MAX_CHARS / 1024 / 1024} MB once its variables are filled in. Repeat large values fewer times.`,
    );
    this.name = "InterpolationTooLarge";
  }
}

/** What an interpolation has used so far, shared by every value of one file. */
export interface InterpolationBudget {
  left: number;
  /** Characters each variable added, to name the one to blame. */
  byName: Map<string, number>;
  /** Placeholders already reported in `seen`, so repeats don't grow it. */
  seenKeys: Set<string>;
}

export function interpolationBudget(
  limit: number = COMPOSE_INTERPOLATION_MAX_CHARS,
): InterpolationBudget {
  return { left: limit, byName: new Map(), seenKeys: new Set() };
}

function spend(budget: InterpolationBudget, characters: number, name?: string): void {
  budget.left -= characters;
  if (name) budget.byName.set(name, (budget.byName.get(name) ?? 0) + characters);
  if (budget.left >= 0) return;
  let worst: string | null = null;
  let most = 0;
  for (const [variable, added] of budget.byName) {
    if (added > most) {
      most = added;
      worst = variable;
    }
  }
  throw new InterpolationTooLarge(worst);
}

/**
 * Compose's interpolation of one value: $$ is a dollar sign; ${NAME}, ${NAME:-default},
 * ${NAME-default}, ${NAME:?error}, ${NAME?error}, ${NAME:+other}, ${NAME+other} and $NAME.
 * `lookup` answers a variable's value (undefined when unset). `seen` collects every placeholder
 * once. Reading and writing count against `budget`, which throws InterpolationTooLarge.
 */
export function interpolate(
  value: string,
  lookup: (name: string) => string | undefined,
  seen?: Placeholder[],
  budget: InterpolationBudget = interpolationBudget(),
): string {
  spend(budget, value.length);
  let out = "";
  let index = 0;
  const note = (placeholder: Placeholder) => {
    if (!seen) return;
    const key = `${placeholder.optional ? "?" : ""}${placeholder.name}`;
    if (budget.seenKeys.has(key)) return;
    budget.seenKeys.add(key);
    seen.push(placeholder);
  };
  const put = (name: string, text: string) => {
    if (text === "") return;
    spend(budget, text.length, name);
    out += text;
  };
  while (index < value.length) {
    const char = value[index];
    if (char !== "$") {
      // Copy the run of plain text up to the next dollar sign at once.
      const stop = value.indexOf("$", index);
      const end = stop === -1 ? value.length : stop;
      out += value.slice(index, end);
      index = end;
      continue;
    }
    const next = value[index + 1];
    if (next === "$") {
      out += "$";
      index += 2;
      continue;
    }
    if (next === "{") {
      // Find the matching brace (defaults may hold their own ${...}).
      let depth = 1;
      let end = index + 2;
      while (end < value.length && depth > 0) {
        if (value[end] === "{") depth++;
        else if (value[end] === "}") depth--;
        if (depth > 0) end++;
      }
      if (depth > 0) {
        out += value.slice(index);
        break;
      }
      const inner = value.slice(index + 2, end);
      const name = NAME.exec(inner)?.[0] ?? "";
      const rest = inner.slice(name.length);
      const current = name ? lookup(name) : undefined;
      const operator = /^(:-|-|:\?|\?|:\+|\+)/.exec(rest)?.[0] ?? "";
      const argument = rest.slice(operator.length);
      note({ name, optional: ["-", ":-", "+", ":+"].includes(operator) });
      const empty = current === undefined || current === "";
      const nested = () => interpolate(argument, lookup, seen, budget);
      switch (operator) {
        case ":-":
          put(name, empty ? nested() : (current as string));
          break;
        case "-":
          put(name, current === undefined ? nested() : current);
          break;
        case ":+":
          put(name, empty ? "" : nested());
          break;
        case "+":
          put(name, current === undefined ? "" : nested());
          break;
        default:
          put(name, current ?? "");
      }
      index = end + 1;
      continue;
    }
    const name = NAME.exec(value.slice(index + 1))?.[0];
    if (name) {
      note({ name, optional: false });
      put(name, lookup(name) ?? "");
      index += 1 + name.length;
      continue;
    }
    out += "$";
    index++;
  }
  return out;
}

/**
 * Every string value of a model, with interpolation applied (keys stay as they are). The whole
 * model shares one budget, so a file can't multiply its variables past the limit (C1-03).
 */
export function interpolateModel(
  model: unknown,
  lookup: (name: string) => string | undefined,
  seen?: Placeholder[],
  budget: InterpolationBudget = interpolationBudget(),
): unknown {
  if (typeof model === "string") return interpolate(model, lookup, seen, budget);
  if (Array.isArray(model)) {
    return model.map((item) => interpolateModel(item, lookup, seen, budget));
  }
  if (isObject(model)) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(model)) {
      // Extension fields (x-…) are Compose's scratch space; they reach services through anchors.
      out[key] = key.startsWith("x-") ? value : interpolateModel(value, lookup, seen, budget);
    }
    return out;
  }
  return model;
}

/**
 * The variables a file needs that aren't set: placeholders with no default. Compose would put an
 * empty value there, which almost never works (a database without its password), so a deploy
 * stops first and names them.
 */
export function missingVariables(model: Model, names: ReadonlySet<string>): string[] {
  const seen: Placeholder[] = [];
  interpolateModel(model, (name) => (names.has(name) ? "set" : undefined), seen);
  const missing = new Set<string>();
  for (const placeholder of seen) {
    if (placeholder.name && !placeholder.optional && !names.has(placeholder.name)) {
      missing.add(placeholder.name);
    }
  }
  return [...missing].sort();
}

/** The names a file refers to as ${NAME} or $NAME (for "Variables used by the file"). */
export function placeholderNames(model: Model): string[] {
  const seen: Placeholder[] = [];
  interpolateModel(model, () => undefined, seen);
  return [...new Set(seen.map((item) => item.name).filter(Boolean))].sort();
}
