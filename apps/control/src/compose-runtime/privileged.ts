import { createHash } from "node:crypto";
import { posix } from "node:path";
import { PRIVATE_NETWORK } from "@nearzero/shared";
import { interpolateModel, isObject, type Model, servicesOf, volumeEntry } from "./model.ts";

/**
 * Options in a Compose file that reach past its own containers into the server (spec 07 7.3,
 * 24 G3): the host's network or namespaces, privileged mode, the Docker socket, files and folders
 * of the server outside the service's own folder, added capabilities, devices, switched-off
 * security protections, and Docker objects that other stacks share. On the Nearzero host they
 * are refused for anyone but instance administrators (host-policy.ts); elsewhere Preview and the
 * deploy log warn about them.
 *
 * Detection reads the file after interpolation with the service's real variables, so a path
 * like ${DATA_DIR}:/data is checked where it actually points. A variable that isn't set makes a
 * path impossible to check, which counts as outside the folder.
 *
 * What an administrator approves is the whole definition, not the option alone (B1-06): every
 * finding's key carries a fingerprint of the service it is in (its resolved settings, the
 * services it extends in the same file, and where the file comes from), so a changed image,
 * command or anything else needs an administrator again. A service that borrows another one's
 * mounts, network or processes (volumes_from, network_mode/pid/ipc: service:x) inherits what
 * that one reaches. Other Compose files (include, extends with file) can't be checked here, since
 * Compose reads them on the server; they are findings that are never approved (B1-01): on the
 * host only an administrator's own deploy runs them, every time.
 */

export const FINDING_KINDS = [
  "host-network",
  "host-namespace",
  "privileged",
  "docker-socket",
  "host-path",
  "capabilities",
  "devices",
  "security-options",
  "shared-resource",
  "other-files",
] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export const FINDING_LABELS: Record<FindingKind, string> = {
  "host-network": "Host network",
  "host-namespace": "Host namespaces",
  privileged: "Privileged mode",
  "docker-socket": "Docker socket",
  "host-path": "Server paths outside the service's folder",
  capabilities: "Added capabilities",
  devices: "Devices",
  "security-options": "Security protections off",
  "shared-resource": "Shared Docker objects",
  "other-files": "Other Compose files",
};

export interface Finding {
  kind: FindingKind;
  label: string;
  /** The inner service it is in, or null for a top-level section. */
  service: string | null;
  message: string;
  /**
   * Stable text for this exact option in this exact definition, compared when an administrator
   * approved a stack.
   */
  key: string;
  /**
   * False for what can't be checked here (other Compose files): an administrator's deploy runs
   * it, but never approves it for anyone else's.
   */
  approvable: boolean;
}

export interface FolderContext {
  /** The project directory inside the stack's folder: "" (pasted file) or "repo/<folder>". */
  projectDirectory: string;
  /** How far relative paths may reach: "" (the whole service folder) or "repo" (the repository). */
  root: string;
  /** The service's app name: the stack's own volumes and networks start with it. */
  appName: string;
  /**
   * Where the file comes from ("raw", or the repository, branch and file path), part of every
   * approval key: the same file from another repository builds other code.
   */
  origin?: string;
  /**
   * A digest of the env file Nearzero writes (every variable of the service). A service that
   * reads env files gets those values, so they are part of its approval (C1-04).
   */
  envFileDigest?: string;
}

/**
 * Variables Compose takes from the runner's own environment, which wins over every env file
 * (runner/src/compose/handlers.ts). The checks must see what Compose sees (B1-32), never the
 * service's variable of the same name: HOME and DOCKER_CONFIG are the runner's own folders,
 * PATH and DOCKER_HOST point into the server, and NEARZERO_SERVICE_FOLDER is the stack's folder.
 */
export const RUNNER_PROCESS_VARIABLES = [
  "HOME",
  "DOCKER_CONFIG",
  "DOCKER_HOST",
  "PATH",
  "BUILDKIT_PROGRESS",
  "NEARZERO_SERVICE_FOLDER",
] as const;

/**
 * The value the checks use for a variable Compose takes from the runner's environment, or
 * undefined for any other name. Absolute stand-ins for the runner's own paths, so a mount made of
 * them counts as outside the folder; the stack's folder as a path relative to the project
 * directory.
 */
export function runnerProcessValue(name: string, context: FolderContext): string | undefined {
  switch (name) {
    case "HOME":
      return "/(the runner's HOME folder)";
    case "DOCKER_CONFIG":
      return "/(the runner's HOME folder)/.docker";
    case "DOCKER_HOST":
      return "unix:///var/run/docker.sock";
    case "PATH":
      return "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    case "BUILDKIT_PROGRESS":
      return "plain";
    case "NEARZERO_SERVICE_FOLDER": {
      const depth =
        context.projectDirectory === "" ? 0 : context.projectDirectory.split("/").length;
      return depth === 0 ? "." : Array.from({ length: depth }, () => "..").join("/");
    }
    default:
      return undefined;
  }
}

/** Marks a variable that isn't set inside an interpolated value. */
const UNSET = "\u0000";

/** Docker's default capabilities: adding one of them changes nothing. */
const DEFAULT_CAPABILITIES = new Set([
  "CHOWN",
  "DAC_OVERRIDE",
  "FSETID",
  "FOWNER",
  "MKNOD",
  "NET_RAW",
  "SETGID",
  "SETUID",
  "SETFCAP",
  "SETPCAP",
  "NET_BIND_SERVICE",
  "SYS_CHROOT",
  "KILL",
  "AUDIT_WRITE",
]);

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "string") return /^(true|yes|on|y|1)$/i.test(value.trim());
  return value === 1;
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function strings(value: unknown): string[] {
  return list(value).filter((item): item is string => typeof item === "string");
}

export type PathPlace =
  | { inside: true; path: string }
  | { inside: false; reason: "absolute" | "home" | "escapes" | "unset"; shown: string };

/**
 * Where a path in the file points: inside the service's folder (as a path relative to the
 * stack's folder), or outside it.
 */
export function placeOf(path: string, context: FolderContext): PathPlace {
  const shown = path.replaceAll(UNSET, "");
  if (path.includes(UNSET)) return { inside: false, reason: "unset", shown };
  if (path.startsWith("~")) return { inside: false, reason: "home", shown };
  if (path.startsWith("/")) return { inside: false, reason: "absolute", shown };
  const joined = posix.normalize(posix.join(context.projectDirectory || ".", path));
  const clean = joined === "." ? "" : joined.replace(/\/$/, "");
  const inRoot =
    context.root === ""
      ? clean !== ".." && !clean.startsWith("../")
      : clean === context.root || clean.startsWith(`${context.root}/`);
  return inRoot ? { inside: true, path: clean } : { inside: false, reason: "escapes", shown };
}

export function isSocketPath(path: string): boolean {
  const clean = posix.normalize(path).replace(/\/$/, "") || "/";
  return (
    clean.endsWith("docker.sock") ||
    ["/", "/var", "/var/run", "/run", "/run/docker", "/var/lib/docker"].includes(clean)
  );
}

function outsideWords(place: Extract<PathPlace, { inside: false }>): string {
  if (place.reason === "unset") {
    return `${place.shown || "a path"} (it uses a variable that isn't set, so where it points can't be checked)`;
  }
  return `${place.shown}, outside the service's folder`;
}

/** Whether a build context or extra context is a remote address rather than a path. */
function remote(value: string): boolean {
  return /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|github\.com\/|docker-image:\/\/|oci-layout:\/\/|service:|target:)/.test(
    value,
  );
}

/** JSON with object keys sorted, so the same definition always gives the same text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

/** Inner services another one borrows from: extends (same file), volumes_from, service: modes. */
function sameFileBases(service: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof service.extends === "string") out.push(service.extends);
  if (isObject(service.extends) && typeof service.extends.service === "string") {
    if (service.extends.file === undefined) out.push(service.extends.service);
  }
  return out;
}

/** The services whose mounts, network or processes this one borrows, with what it borrows. */
function borrowed(service: Record<string, unknown>): { from: string; what: FindingKind[] }[] {
  const out: { from: string; what: FindingKind[] }[] = [];
  for (const source of strings(service.volumes_from)) {
    if (source.startsWith("container:")) continue;
    const name = source.split(":")[0] as string;
    if (name) out.push({ from: name, what: ["docker-socket", "host-path"] });
  }
  for (const key of ["network_mode", "pid", "ipc"] as const) {
    const value = typeof service[key] === "string" ? (service[key] as string) : "";
    if (!value.startsWith("service:")) continue;
    out.push({
      from: value.slice("service:".length),
      what: key === "network_mode" ? ["host-network", "host-namespace"] : ["host-namespace"],
    });
  }
  return out;
}

/** Whether a service uses a top-level volume, network, config or secret by its key. */
function usesSectionEntry(service: Record<string, unknown>, section: string, key: string): boolean {
  if (section === "volumes") {
    return list(service.volumes).some((raw) => {
      const entry = volumeEntry(raw);
      return entry.type === "volume" && entry.source === key;
    });
  }
  if (section === "networks") {
    const networks = service.networks;
    return Array.isArray(networks) ? networks.includes(key) : isObject(networks) && key in networks;
  }
  return list(service[section]).some(
    (item) => item === key || (isObject(item) && item.source === key),
  );
}

export function findPrivileged(
  model: Model,
  context: FolderContext,
  lookup: (name: string) => string | undefined,
): Finding[] {
  const resolved = interpolateModel(
    model,
    (name) => runnerProcessValue(name, context) ?? lookup(name) ?? UNSET,
  ) as Model;
  const findings: Finding[] = [];
  const seen = new Set<string>();
  const inner = new Map(servicesOf(resolved));
  const origin = context.origin ?? "";
  // A service's fingerprint: its own resolved settings and those of the services it extends in
  // this file (an image or command can come from them), and where the file comes from.
  const fingerprints = new Map<string, string>();
  const fingerprintOf = (name: string): string => {
    const known = fingerprints.get(name);
    if (known) return known;
    const chain: unknown[] = [];
    const visited = new Set<string>();
    let next: string[] = [name];
    while (next.length > 0) {
      const current = next.shift() as string;
      if (visited.has(current)) continue;
      visited.add(current);
      const definition = inner.get(current);
      chain.push([current, definition ?? null]);
      if (definition) next = [...next, ...sameFileBases(definition)];
    }
    // A service that reads env files (Nearzero's own among them) gets the variables' values.
    const readsEnvFiles = chain.some(
      (entry) =>
        isObject((entry as [string, unknown])[1]) && "env_file" in (entry as [string, Model])[1],
    );
    const value = digest(
      canonical(readsEnvFiles ? [origin, chain, context.envFileDigest ?? ""] : [origin, chain]),
    );
    fingerprints.set(name, value);
    return value;
  };
  // A top-level volume, network, config or secret: its own settings and every service that uses
  // it, so a new service mounting an approved server folder needs an administrator too.
  const sectionFingerprint = (section: string, key: string): string => {
    const entries = isObject(resolved[section]) ? (resolved[section] as Model) : {};
    const users = [...inner.entries()]
      .filter(([, service]) => usesSectionEntry(service, section, key))
      .map(([name]) => [name, fingerprintOf(name)]);
    return digest(canonical([origin, section, key, entries[key] ?? null, users]));
  };
  const add = (
    kind: FindingKind,
    service: string | null,
    detail: string,
    message: string,
    options: { approvable?: boolean; fingerprint?: string } = {},
  ) => {
    const base = `${service ?? "*"}|${kind}|${detail}`;
    if (seen.has(base)) return;
    seen.add(base);
    const fingerprint =
      options.fingerprint ?? (service ? fingerprintOf(service) : digest(canonical([origin])));
    findings.push({
      kind,
      label: FINDING_LABELS[kind],
      service,
      message,
      key: `${base}@${fingerprint}`,
      approvable: options.approvable ?? true,
    });
  };
  const checkPath = (
    service: string | null,
    path: string,
    what: (where: string) => string,
    detail: string,
    fingerprint?: string,
  ) => {
    const place = placeOf(path, context);
    if (place.inside) return;
    add(
      "host-path",
      service,
      `${detail}:${place.shown}`,
      what(outsideWords(place)),
      fingerprint ? { fingerprint } : {},
    );
  };

  for (const [name, service] of servicesOf(resolved)) {
    const mode = (key: string) =>
      typeof service[key] === "string" ? (service[key] as string) : "";
    const network = mode("network_mode");
    if (network === "host") {
      add(
        "host-network",
        name,
        "network_mode",
        `${name} uses the server's own network (network_mode: host).`,
      );
    } else if (network.startsWith("container:")) {
      add(
        "host-namespace",
        name,
        `network_mode:${network}`,
        `${name} joins the network of another container (network_mode: ${network}).`,
      );
    }
    for (const key of ["pid", "ipc"] as const) {
      const value = mode(key);
      if (value === "host") {
        add(
          "host-namespace",
          name,
          key,
          `${name} shares the server's ${key === "pid" ? "processes" : "shared memory"} (${key}: host).`,
        );
      } else if (value.startsWith("container:")) {
        add(
          "host-namespace",
          name,
          `${key}:${value}`,
          `${name} shares another container's ${key === "pid" ? "processes" : "shared memory"} (${key}: ${value}).`,
        );
      }
    }
    for (const key of ["uts", "userns_mode", "cgroup"] as const) {
      if (mode(key) === "host") {
        add(
          "host-namespace",
          name,
          key,
          `${name} uses the server's own ${key === "uts" ? "host name" : key === "cgroup" ? "control groups" : "user IDs"} (${key}: host).`,
        );
      }
    }
    if (truthy(service.privileged)) {
      add(
        "privileged",
        name,
        "privileged",
        `${name} runs in privileged mode, with full access to the server.`,
      );
    }
    const added = strings(service.cap_add).map((cap) => cap.toUpperCase().replace(/^CAP_/, ""));
    const extra = added.filter((cap) => !DEFAULT_CAPABILITIES.has(cap));
    if (extra.length > 0) {
      add(
        "capabilities",
        name,
        `cap_add:${[...extra].sort().join(",")}`,
        `${name} adds Linux capabilities: ${extra.join(", ")}.`,
      );
    }
    const devices = list(service.devices)
      .map((item) =>
        typeof item === "string" ? item : isObject(item) ? String(item.source ?? "") : "",
      )
      .filter(Boolean);
    if (devices.length > 0) {
      add(
        "devices",
        name,
        `devices:${devices.join(",")}`,
        `${name} uses the server's devices: ${devices.join(", ")}.`,
      );
    }
    if (strings(service.device_cgroup_rules).length > 0) {
      add(
        "devices",
        name,
        "device_cgroup_rules",
        `${name} changes which of the server's devices it may use (device_cgroup_rules).`,
      );
    }
    for (const option of strings(service.security_opt)) {
      if (/unconfined|disable/i.test(option)) {
        add(
          "security-options",
          name,
          `security_opt:${option}`,
          `${name} turns off a security protection (security_opt: ${option}).`,
        );
      }
    }
    for (const source of strings(service.volumes_from)) {
      if (source.startsWith("container:")) {
        add(
          "shared-resource",
          name,
          `volumes_from:${source}`,
          `${name} mounts the volumes of a container outside this stack (${source}).`,
        );
      }
    }
    if (typeof service.cgroup_parent === "string" && service.cgroup_parent !== "") {
      add(
        "host-namespace",
        name,
        "cgroup_parent",
        `${name} places itself in the server's control group ${service.cgroup_parent}.`,
      );
    }
    if (service.provider !== undefined) {
      add(
        "privileged",
        name,
        "provider",
        `${name} is run by a Compose provider, a program on the server.`,
      );
    }
    for (const hook of [...list(service.post_start), ...list(service.pre_stop)]) {
      if (isObject(hook) && truthy(hook.privileged)) {
        add("privileged", name, "hook", `${name} runs a lifecycle hook in privileged mode.`);
      }
    }

    for (const raw of list(service.volumes)) {
      const entry = volumeEntry(raw);
      // A source made of a variable that isn't set could be a path: it can't be checked.
      if (entry.source?.includes(UNSET)) entry.type = "bind";
      if (entry.type !== "bind" || !entry.source) continue;
      const place = placeOf(entry.source, context);
      if (!place.inside && isSocketPath(place.shown)) {
        add(
          "docker-socket",
          name,
          `socket:${place.shown}`,
          `${name} mounts ${place.shown}, which holds the Docker socket: control of every container on the server.`,
        );
        continue;
      }
      checkPath(
        name,
        entry.source,
        (where) => `${name} mounts ${where}.`,
        `bind:${entry.target ?? ""}`,
      );
    }
    for (const file of list(service.env_file)) {
      const path =
        typeof file === "string"
          ? file
          : isObject(file) && typeof file.path === "string"
            ? file.path
            : null;
      if (path)
        checkPath(name, path, (where) => `${name} reads the env file ${where}.`, "env_file");
    }
    for (const path of strings(service.label_file)) {
      checkPath(name, path, (where) => `${name} reads the label file ${where}.`, "label_file");
    }
    if (isObject(service.extends) && service.extends.file !== undefined) {
      const file = String(service.extends.file);
      add(
        "other-files",
        name,
        `extends-file:${file}`,
        `${name} extends a service from another file, ${file}. Docker Compose reads that file on the server, so the options it adds can't be checked here.`,
        { approvable: false },
      );
      checkPath(name, file, (where) => `${name} extends a file at ${where}.`, "extends");
    }

    const build = service.build;
    if (typeof build === "string" || isObject(build)) {
      const settings = isObject(build) ? build : { context: build };
      const buildContext = typeof settings.context === "string" ? settings.context : ".";
      if (!remote(buildContext)) {
        checkPath(name, buildContext, (where) => `${name} builds from ${where}.`, "build");
        if (typeof settings.dockerfile === "string" && !settings.dockerfile.startsWith("/")) {
          checkPath(
            name,
            posix.join(buildContext, settings.dockerfile),
            (where) => `${name} builds with the Dockerfile ${where}.`,
            "dockerfile",
          );
        } else if (typeof settings.dockerfile === "string") {
          checkPath(
            name,
            settings.dockerfile,
            (where) => `${name} builds with the Dockerfile ${where}.`,
            "dockerfile",
          );
        }
      }
      const contexts = isObject(settings.additional_contexts)
        ? Object.values(settings.additional_contexts)
        : strings(settings.additional_contexts).map((item) => item.split("=").slice(1).join("="));
      for (const value of contexts) {
        if (typeof value === "string" && !remote(value)) {
          checkPath(
            name,
            value,
            (where) => `${name} builds with files from ${where}.`,
            `context:${value}`,
          );
        }
      }
      if (settings.network === "host") {
        add(
          "host-network",
          name,
          "build.network",
          `${name} builds on the server's own network (build network: host).`,
        );
      }
      if (truthy(settings.privileged)) {
        add("privileged", name, "build.privileged", `${name} builds in privileged mode.`);
      }
      for (const entitlement of strings(settings.entitlements)) {
        if (/network\.host|security\.insecure/.test(entitlement)) {
          add(
            "privileged",
            name,
            `entitlement:${entitlement}`,
            `${name} builds with the ${entitlement} entitlement.`,
          );
        }
      }
      for (const ssh of strings(settings.ssh)) {
        const path = ssh.split("=").slice(1).join("=");
        if (path)
          checkPath(
            name,
            path,
            (where) => `${name} builds with the SSH key ${where}.`,
            `ssh:${ssh}`,
          );
      }
    }
  }

  // A service that borrows another one's mounts, network or processes reaches what it reaches.
  const direct = [...findings];
  for (const [name, service] of servicesOf(resolved)) {
    for (const { from, what } of borrowed(service)) {
      for (const finding of direct) {
        if (finding.service !== from || !what.includes(finding.kind)) continue;
        add(
          finding.kind,
          name,
          `from:${from}:${finding.key.split("@")[0]}`,
          `${name} shares ${from}'s ${finding.kind === "host-network" || finding.kind === "host-namespace" ? "namespaces" : "mounts"}: ${finding.message}`,
        );
      }
    }
  }

  // Top-level sections.
  for (const [key, value] of Object.entries(isObject(resolved.volumes) ? resolved.volumes : {})) {
    const options = isObject(value) ? value : {};
    const fingerprint = sectionFingerprint("volumes", key);
    const external = options.external === true || isObject(options.external);
    const named = typeof options.name === "string" ? options.name : null;
    if (external) {
      add(
        "shared-resource",
        null,
        `volume-external:${named ?? key}`,
        `The volume ${named ?? key} already exists outside this stack (external: true).`,
        { fingerprint },
      );
    } else if (named && !named.startsWith(context.appName)) {
      add(
        "shared-resource",
        null,
        `volume-name:${named}`,
        `The volume ${key} is named ${named}, a name other stacks can use too.`,
        { fingerprint },
      );
    }
    if (typeof options.driver === "string" && options.driver !== "local") {
      add(
        "shared-resource",
        null,
        `volume-driver:${options.driver}`,
        `The volume ${key} uses the volume driver ${options.driver}.`,
        { fingerprint },
      );
    }
    const driverOptions = isObject(options.driver_opts) ? options.driver_opts : {};
    const device = typeof driverOptions.device === "string" ? driverOptions.device : null;
    if (device || /\bbind\b/.test(String(driverOptions.o ?? ""))) {
      add(
        "host-path",
        null,
        `volume-device:${key}`,
        `The volume ${key} is the server's folder ${device ?? "(a bind mount)"}, outside the service's folder.`,
        { fingerprint },
      );
    }
  }
  for (const [key, value] of Object.entries(isObject(resolved.networks) ? resolved.networks : {})) {
    const options = isObject(value) ? value : {};
    const fingerprint = sectionFingerprint("networks", key);
    const external = options.external === true || isObject(options.external);
    const named = typeof options.name === "string" ? options.name : null;
    const actual = named ?? key;
    if (typeof options.driver === "string" && /^(host|macvlan|ipvlan)$/.test(options.driver)) {
      add(
        "host-network",
        null,
        `network-driver:${key}`,
        `The network ${key} uses the ${options.driver} driver, which reaches the server's own network.`,
        { fingerprint },
      );
    }
    if ((external || named) && actual !== PRIVATE_NETWORK && !actual.startsWith(context.appName)) {
      add(
        "shared-resource",
        null,
        `network:${actual}`,
        `The network ${key} joins ${actual}, a network outside this stack.`,
        { fingerprint },
      );
    }
  }
  for (const section of ["configs", "secrets"] as const) {
    for (const [key, value] of Object.entries(
      isObject(resolved[section]) ? resolved[section] : {},
    )) {
      if (isObject(value) && typeof value.file === "string") {
        checkPath(
          null,
          value.file,
          (where) => `The ${section === "configs" ? "config" : "secret"} ${key} reads ${where}.`,
          `${section}:${key}`,
          sectionFingerprint(section, key),
        );
      }
    }
  }
  for (const item of list(resolved.include)) {
    const paths = typeof item === "string" ? [item] : isObject(item) ? strings(item.path) : [];
    add(
      "other-files",
      null,
      `include:${canonical(item)}`,
      `The file includes ${paths.join(", ") || "another Compose file"}. Docker Compose reads it on the server, so the services and options it adds can't be checked here.`,
      { approvable: false },
    );
    for (const path of paths) {
      checkPath(null, path, (where) => `The file includes ${where}.`, `include:${path}`);
    }
    if (isObject(item) && typeof item.project_directory === "string") {
      checkPath(
        null,
        item.project_directory,
        (where) => `The file includes a project at ${where}.`,
        "include-directory",
      );
    }
  }
  return findings;
}

/** The approval fingerprint of a set of findings (only what an approval can cover). */
export function findingKeys(findings: readonly Finding[]): string[] {
  return [
    ...new Set(findings.filter((finding) => finding.approvable).map((finding) => finding.key)),
  ].sort();
}
