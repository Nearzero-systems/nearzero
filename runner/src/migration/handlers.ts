import { createHash, X509Certificate } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type LegacyWorkloadResult,
  type MigrationCommandKind,
  NEARZERO_LABELS,
  type ParsedCommandParams,
  type PortsWaitResult,
  ROUTER_CONTAINER,
} from "@nearzero/shared";
import type { CommandContext } from "../commands.ts";
import { type DockerClient, DockerError } from "../docker/client.ts";
import { createTar } from "../docker/tar.ts";
import { ACME_STORE_PATH, firstTarFile } from "../domains/acme.ts";

/**
 * The runner's part of moving a 0.1.x install to 1.0 (spec 29.5): the server's certificate
 * authority state goes into its router's store before any route switches, so certificates
 * continue without new orders; and the 0.1.x workload a service replaces is stopped, started
 * again when the redeploy fails, and removed once the move is finalized. On another machine, a
 * volume archive from the export is restored into the service's new volume before its first
 * deploy. commands.ts adds these handlers to its table.
 */

type Handler<K extends MigrationCommandKind> = (
  params: ParsedCommandParams<K>,
  context: CommandContext,
) => Promise<unknown>;

const RESOLVER = "letsencrypt";
/** Where the earlier replica count of a stopped Swarm service is kept, on the service itself. */
const REPLICAS_LABEL = "dev.nearzero.migration.replicas";
/**
 * And its published ports, which Swarm keeps holding at zero replicas, as
 * "published:target:protocol:mode" words: the installer's and the server scripts' shell
 * functions read and write the same label.
 */
const PORTS_LABEL = "dev.nearzero.migration.ports";

interface StoredCertificate {
  domain?: { main?: string; sans?: string[] };
  certificate?: string;
  key?: string;
  Store?: string;
}

interface Resolver {
  Account?: Record<string, unknown> | null;
  Certificates?: StoredCertificate[] | null;
}

type Store = Record<string, Resolver>;

function notAfter(certificate: StoredCertificate): number {
  try {
    const pem = Buffer.from(certificate.certificate ?? "", "base64").toString("utf8");
    const block = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
    return block ? Date.parse(new X509Certificate(block).validTo) : 0;
  } catch {
    return 0;
  }
}

/**
 * The router's store with the imported resolver merged in: the router's own account stays when it
 * has one, and for each name the certificate that lasts longer stays.
 */
export function mergeRouterStores(
  existing: Store,
  incoming: Store,
): { store: Store; certificates: number } {
  const mine = existing[RESOLVER] ?? {};
  const theirs = incoming[RESOLVER] ?? {};
  const byName = new Map<string, StoredCertificate>();
  for (const certificate of [...(mine.Certificates ?? []), ...(theirs.Certificates ?? [])]) {
    const name = certificate.domain?.main?.toLowerCase();
    if (!name || !certificate.certificate || !certificate.key) continue;
    const held = byName.get(name);
    if (!held || notAfter(certificate) > notAfter(held)) byName.set(name, certificate);
  }
  const certificates = [...byName.values()];
  return {
    store: {
      ...existing,
      [RESOLVER]: {
        Account: mine.Account ?? theirs.Account ?? null,
        Certificates: certificates,
      },
    },
    certificates: certificates.length,
  };
}

async function readStore(docker: DockerClient): Promise<Store> {
  try {
    const response = await docker.request("GET", `/containers/${ROUTER_CONTAINER}/archive`, {
      query: { path: ACME_STORE_PATH },
    });
    const file = firstTarFile(new Uint8Array(await response.arrayBuffer()));
    if (!file || file.length === 0) return {};
    const parsed = JSON.parse(new TextDecoder().decode(file)) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Store) : {};
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

const importCertificates: Handler<"certificates.import"> = async (params, context) => {
  let incoming: Store;
  try {
    incoming = JSON.parse(params.store) as Store;
  } catch {
    throw new Error("The certificate store to import isn't JSON.");
  }
  // The router, its folder and its certificates volume exist before anything is written.
  await context.router.ensure();
  const merged = mergeRouterStores(await readStore(context.docker), incoming);
  const owner = await stat(context.router.settings.directory);
  // Traefik reads acme.json only when it is private to the user it runs as.
  const tar = createTar([
    {
      path: "acme.json",
      type: "file",
      content: new TextEncoder().encode(JSON.stringify(merged.store, null, 2)),
      mode: 0o600,
      uid: owner.uid,
      gid: owner.gid,
    },
  ]);
  await context.docker.putArchive(ROUTER_CONTAINER, "/certificates", tar);
  // The router reads its store when it starts.
  await context.docker.call("POST", `/containers/${ROUTER_CONTAINER}/restart`, {
    query: { t: 10 },
  });
  return { certificates: merged.certificates };
};

// ---- 0.1.x workloads

interface SwarmPort {
  Protocol?: string;
  TargetPort?: number;
  PublishedPort?: number;
  PublishMode?: string;
}

interface SwarmService {
  ID: string;
  Version: { Index: number };
  Spec: {
    Name?: string;
    Labels?: Record<string, string>;
    Mode?: { Replicated?: { Replicas?: number }; Global?: unknown };
    EndpointSpec?: { Mode?: string; Ports?: SwarmPort[] };
    [key: string]: unknown;
  };
  Endpoint?: { Ports?: SwarmPort[] };
}

async function swarmService(docker: DockerClient, name: string): Promise<SwarmService | null> {
  try {
    return await docker.json<SwarmService>("GET", `/services/${encodeURIComponent(name)}`);
  } catch (error) {
    // 404: no such service; 503: this server isn't a Swarm manager (nothing of 0.1.x left).
    if (error instanceof DockerError && (error.status === 404 || error.status === 503)) return null;
    throw error;
  }
}

async function scaleSwarmService(
  docker: DockerClient,
  service: SwarmService,
  replicas: number,
  labels: Record<string, string>,
  ports: SwarmPort[] | undefined = service.Spec.EndpointSpec?.Ports,
) {
  if (!service.Spec.Mode?.Replicated) {
    throw new Error(
      "This 0.1.x service runs on every node (global mode), so it can't be scaled down.",
    );
  }
  await docker.call("POST", `/services/${encodeURIComponent(service.ID)}/update`, {
    query: { version: service.Version.Index },
    body: {
      ...service.Spec,
      Labels: labels,
      Mode: { Replicated: { Replicas: replicas } },
      EndpointSpec: { ...(service.Spec.EndpointSpec ?? {}), Ports: ports ?? [] },
    },
  });
}

export function portsLabel(ports: SwarmPort[]): string {
  return ports
    .map(
      (port) =>
        `${port.PublishedPort ?? 0}:${port.TargetPort ?? 0}:${port.Protocol ?? "tcp"}:${port.PublishMode ?? "ingress"}`,
    )
    .join(" ");
}

function keptPorts(labels: Record<string, string>): SwarmPort[] | null {
  const text = labels[PORTS_LABEL];
  if (text === undefined) return null;
  return text
    .split(/\s+/)
    .map((word) => /^(\d{1,5}):(\d{1,5}):(tcp|udp|sctp):(ingress|host)$/.exec(word))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({
      PublishedPort: Number(match[1]),
      TargetPort: Number(match[2]),
      Protocol: match[3],
      PublishMode: match[4],
    }));
}

/** Containers of a 0.1.x workload; Nearzero 1.0's own containers are never among them. */
async function workloadContainers(
  docker: DockerClient,
  kind: "container" | "compose-project",
  name: string,
) {
  if (kind === "container") {
    const found = await docker.findContainer(name);
    if (!found) return [];
    return [
      { id: found.Id, labels: found.Config.Labels ?? {}, running: found.State?.Running === true },
    ];
  }
  const listed = await docker.listContainers({
    all: true,
    labels: [`com.docker.compose.project=${name}`],
  });
  return listed.map((item) => ({
    id: item.Id,
    labels: item.Labels ?? {},
    running: item.State === "running",
  }));
}

/** `docker compose` arguments that start a 0.1.x project from its own files in its folder. */
export function stackUpArgs(params: {
  name: string;
  folder: string;
  composeFiles: string[];
  envFile?: string | undefined;
}): string[] {
  const args = ["compose", "--project-directory", params.folder, "-p", params.name];
  for (const file of params.composeFiles) args.push("-f", `${params.folder}/${file}`);
  if (params.envFile) {
    args.push(
      "--env-file",
      params.envFile.startsWith("/") ? params.envFile : `${params.folder}/${params.envFile}`,
    );
  }
  args.push("up", "-d");
  return args;
}

type CommandRunner = (spec: {
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal: AbortSignal;
}) => Promise<{ exitCode: number | null; output?: string }>;

/**
 * Removes 1.0's labelled containers in the project (with their anonymous volumes), then runs
 * 0.1.x's own Compose files from its folder; without named files, Compose's own lookup there. A
 * runner in a container (the Nearzero host's) runs Compose in a short-lived container of its own
 * image with the folder at the same path, since the folder is on the host.
 */
export async function startStackFromFiles(
  params: ParsedCommandParams<"legacy.workload">,
  context: CommandContext,
  run: CommandRunner = defaultRunner,
): Promise<void> {
  const { docker } = context;
  const folder = params.folder as string;
  const ours = await docker.listContainers({
    all: true,
    labels: [`com.docker.compose.project=${params.name}`, `${NEARZERO_LABELS.edition}=1`],
  });
  for (const container of ours) await docker.removeContainer(container.Id, { force: true });
  const compose = stackUpArgs({
    name: params.name,
    folder,
    composeFiles: params.composeFiles,
    envFile: params.envFile,
  });
  const env = { DOCKER_HOST: `unix://${context.dockerSocket}` };
  // An env file kept outside the stack's folder: under the install's data folders only (29a.9).
  const outside = params.envFile?.startsWith("/") ? params.envFile : null;
  if (outside) await allowedEnvFile(outside, params, context);
  let argv = ["docker", ...compose];
  if (context.containerized) {
    const self = await docker
      .json<{ Config?: { Image?: string } }>(
        "GET",
        `/containers/${encodeURIComponent(process.env.HOSTNAME ?? "")}/json`,
      )
      .catch(() => null);
    const image = self?.Config?.Image;
    if (!image)
      throw new Error("The runner couldn't tell its own image to run Docker Compose with.");
    argv = [
      "docker",
      "run",
      "--rm",
      // The runner's image runs as an unprivileged user, who can't open the Docker socket
      // (root:docker 0660) from this helper (B2-03).
      "--user",
      "0:0",
      "--label",
      `${NEARZERO_LABELS.managed}=true`,
      "--label",
      `${NEARZERO_LABELS.edition}=1`,
      "-v",
      `${context.dockerSocket}:/var/run/docker.sock`,
      "-v",
      `${folder}:${folder}:ro`,
      // Its folder must exist already: a bind mount never makes one on the server.
      ...(outside
        ? ["--mount", `type=bind,source=${dirname(outside)},target=${dirname(outside)},readonly`]
        : []),
      "-w",
      folder,
      "--entrypoint",
      "sh",
      image,
      "-c",
      // Inside, where the server's file is visible: a regular file reached by no link.
      'if [ -n "$1" ]; then [ -f "$1" ] && [ "$(readlink -f "$1")" = "$1" ] || { echo "The env file $1 isn\'t a regular file." >&2; exit 3; }; fi; shift; exec docker "$@"',
      "sh",
      outside ?? "",
      ...compose,
    ];
  }
  const result = await run({
    argv,
    cwd: context.containerized ? undefined : folder,
    env,
    timeoutMs: 15 * 60_000,
    signal: context.signal,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `Docker Compose couldn't start the 0.1.x copy of ${params.name} from ${folder} (exit code ${result.exitCode ?? "none"}).`,
    );
  }
}

/**
 * An absolute env file is used only under the 0.1.x install's data folders (the ones the bundle
 * names and its data volumes' folders on this server), and, where the runner can see the
 * server's files, only as a regular file reached by no link. 1.0 never writes to it.
 */
async function allowedEnvFile(
  file: string,
  params: ParsedCommandParams<"legacy.workload">,
  context: CommandContext,
): Promise<void> {
  // The 0.1.x data folders on every server (29a.9), then the ones the move names for this one.
  const roots = ["/opt/nearzero", "/etc/nearzero", ...params.dataFolders];
  for (const volume of params.dataVolumes) {
    const found = await context.docker
      .json<{ Mountpoint?: string }>("GET", `/volumes/${encodeURIComponent(volume)}`)
      .catch(() => null);
    if (found?.Mountpoint) roots.push(found.Mountpoint);
  }
  const inside = roots.some(
    (root) => root !== "/" && file.startsWith(`${root.replace(/\/+$/, "")}/`),
  );
  if (!inside) {
    throw new Error(
      `The env file ${file} isn't under the 0.1.x install's data folders, so ${params.name} isn't started with it.`,
    );
  }
  if (context.containerized) return;
  const { lstat, realpath } = await import("node:fs/promises");
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile() || (await realpath(file).catch(() => "")) !== file) {
    throw new Error(
      `The env file ${file} isn't a regular file, so ${params.name} isn't started with it.`,
    );
  }
}

async function defaultRunner(spec: Parameters<CommandRunner>[0]) {
  const { runCommand } = await import("../exec/command.ts");
  return runCommand({ ...spec, onOutput: () => {} });
}

/** What carries 1.0's label (or, from before it, a reserved 1.0 component's). */
function isOneZero(labels: Record<string, string> | undefined): boolean {
  return (
    labels?.[NEARZERO_LABELS.edition] === "1" || labels?.[NEARZERO_LABELS.component] !== undefined
  );
}

/** One Swarm service: scaled to zero keeping its replica count, back, removed or described. */
async function swarmAction(
  docker: DockerClient,
  service: SwarmService,
  action: "stop" | "start" | "remove" | "status",
): Promise<boolean> {
  const labels = { ...(service.Spec.Labels ?? {}) };
  const replicas = service.Spec.Mode?.Replicated?.Replicas ?? 1;
  switch (action) {
    case "status":
      return replicas > 0;
    case "stop": {
      // Its published ports go too: Swarm holds them even at zero replicas (spec 29.5).
      const ports = service.Spec.EndpointSpec?.Ports ?? [];
      if (replicas > 0 || ports.length > 0) {
        if (replicas > 0) labels[REPLICAS_LABEL] = String(replicas);
        if (ports.length > 0) labels[PORTS_LABEL] = portsLabel(ports);
        await scaleSwarmService(docker, service, 0, labels, []);
      }
      return false;
    }
    case "start": {
      const earlier = Number(labels[REPLICAS_LABEL] ?? "1");
      const ports = keptPorts(labels) ?? service.Spec.EndpointSpec?.Ports ?? [];
      delete labels[REPLICAS_LABEL];
      delete labels[PORTS_LABEL];
      await scaleSwarmService(
        docker,
        service,
        Number.isInteger(earlier) && earlier > 0 ? earlier : 1,
        labels,
        ports,
      );
      return true;
    }
    case "remove":
      await docker.call("DELETE", `/services/${encodeURIComponent(service.ID)}`);
      return false;
  }
}

const legacyWorkload: Handler<"legacy.workload"> = async (
  params,
  context,
): Promise<LegacyWorkloadResult> => {
  const { docker } = context;
  if (params.kind === "swarm-stack") {
    let services: SwarmService[];
    try {
      services = await docker.json<SwarmService[]>("GET", "/services", {
        query: {
          filters: JSON.stringify({ label: [`com.docker.stack.namespace=${params.name}`] }),
        },
      });
    } catch (error) {
      // 503: this server isn't a Swarm manager, so nothing of 0.1.x is left here.
      if (error instanceof DockerError && error.status === 503)
        return { found: false, running: false };
      throw error;
    }
    if (services.length === 0) return { found: false, running: false };
    let running = false;
    for (const service of services.filter((item) => !isOneZero(item.Spec.Labels))) {
      running = (await swarmAction(docker, service, params.action)) || running;
    }
    return { found: true, running };
  }
  if (params.kind === "swarm-service") {
    const service = await swarmService(docker, params.name);
    if (!service || isOneZero(service.Spec.Labels)) return { found: false, running: false };
    return { found: true, running: await swarmAction(docker, service, params.action) };
  }
  // 1.0's own containers are never touched (spec 29.5 "Finalize"): a moved stack keeps its
  // Compose project name, so its 1.0 containers share the project label with 0.1.x's.
  // A Compose project with its own files comes back from them (spec 29.5): 0.1.x's stopped
  // containers may have been replaced by 1.0's deploy of the same project.
  if (params.kind === "compose-project" && params.action === "start" && params.folder) {
    await startStackFromFiles(params, context);
    return { found: true, running: true };
  }
  const containers = (await workloadContainers(docker, params.kind, params.name)).filter(
    (item) => !isOneZero(item.labels),
  );
  if (containers.length === 0) return { found: false, running: false };
  for (const container of containers) {
    const id = encodeURIComponent(container.id);
    try {
      if (params.action === "stop" && container.running) {
        await docker.call("POST", `/containers/${id}/stop`, { query: { t: 30 } });
      } else if (params.action === "start" && !container.running) {
        await docker.call("POST", `/containers/${id}/start`);
      } else if (params.action === "remove") {
        // Volumes stay: they hold the data the 1.0 service now uses.
        // Its anonymous volumes go with it; named ones (the 1.0 service's data) never do.
        await docker.removeContainer(container.id, { force: true });
      }
    } catch (error) {
      // 304: already in the asked state.
      if (!(error instanceof DockerError && error.status === 304)) throw error;
    }
  }
  return {
    found: true,
    running:
      params.action === "status"
        ? containers.some((item) => item.running)
        : params.action === "start",
  };
};

// ---- Volume archives (moving to another machine)

/** Where the restore container mounts the volume; it is created, filled and removed, never started. */
const RESTORE_PATH = "/restore";

/**
 * Downloads the archive into the runner's work folder (private to it) while checking its size and
 * SHA-256, so a large volume never sits in memory; the file is removed afterwards either way.
 */
async function downloadArchive(
  params: ParsedCommandParams<"volume.restore">,
  context: CommandContext,
  file: string,
): Promise<void> {
  const response = await context.controlFetch(
    `/api/v1/runner/migration-archives/${params.archiveId}`,
    { signal: context.signal },
  );
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(
      response.status === 404
        ? "The volume archive isn't on Nearzero any more."
        : `Downloading the volume archive from Nearzero failed (${response.status}).`,
    );
  }
  const hash = createHash("sha256");
  const out = createWriteStream(file, { mode: 0o600 });
  let received = 0;
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length;
      if (received > params.sizeBytes) {
        throw new Error("The downloaded volume archive is larger than the one exported.");
      }
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((resolve) => out.once("drain", resolve));
    }
  } finally {
    await new Promise<void>((resolve, reject) =>
      out.end((error?: Error | null) => (error ? reject(error) : resolve())),
    );
  }
  if (received !== params.sizeBytes || hash.digest("hex") !== params.sha256) {
    throw new Error("The downloaded volume archive doesn't match the export's checksum.");
  }
}

const restoreVolume: Handler<"volume.restore"> = async (params, context) => {
  const { docker } = context;
  const folder = join(context.workDirectory, "migration");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const file = join(folder, `${params.archiveId}.tar`);
  let holder: string | null = null;
  try {
    await downloadArchive(params, context, file);
    if (!(await docker.findVolume(params.volume))) {
      await docker.createVolume(params.volume, { [NEARZERO_LABELS.managed]: "true" });
    }
    // Any image will do for a container that never runs; the router's is already on the server.
    const image = context.router.settings.image;
    if (!(await docker.imageExists(image))) await docker.pullImage(image);
    holder = await docker.createContainer(
      `nearzero-restore-${params.archiveId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`,
      {
        Image: image,
        Entrypoint: ["true"],
        Cmd: [],
        Labels: { [NEARZERO_LABELS.managed]: "true" },
        AttachStdin: false,
        OpenStdin: false,
        Tty: false,
        HostConfig: {
          AutoRemove: false,
          NetworkMode: "none",
          Mounts: [{ Type: "volume", Source: params.volume, Target: RESTORE_PATH }],
        },
      },
    );
    // copyUIDGID off: the archive's own owners stay (a database's files keep its user).
    await docker.call("PUT", `/containers/${encodeURIComponent(holder)}/archive`, {
      query: { path: RESTORE_PATH, noOverwriteDirNonDir: true },
      rawBody: { bytes: Bun.file(file), contentType: "application/x-tar" },
      signal: context.signal,
    });
    return { volume: params.volume, bytes: params.sizeBytes };
  } finally {
    if (holder) await docker.removeContainer(holder, { force: true }).catch(() => {});
    await rm(file, { force: true });
  }
};

// ---- Ports a moved service needs (spec 29.5 "Public ports")

interface ListedContainer {
  Names?: string[];
  Ports?: { PublicPort?: number; Type?: string }[];
}

/** What publishes each of these ports now: running containers and Swarm services. */
export async function portHolders(
  docker: DockerClient,
  wanted: { port: number; protocol: "tcp" | "udp" }[],
): Promise<PortsWaitResult["held"]> {
  const held: PortsWaitResult["held"] = [];
  const add = (port: number, protocol: string, holder: string) => {
    for (const item of wanted) {
      if (item.port === port && item.protocol === (protocol || "tcp").toLowerCase()) {
        if (
          !held.some((h) => h.port === port && h.protocol === item.protocol && h.holder === holder)
        ) {
          held.push({ port, protocol: item.protocol, holder });
        }
      }
    }
  };
  const containers = await docker.json<ListedContainer[]>("GET", "/containers/json");
  for (const container of containers) {
    const name = (container.Names?.[0] ?? "a container").replace(/^\//, "");
    for (const port of container.Ports ?? []) {
      if (port.PublicPort) add(port.PublicPort, port.Type ?? "tcp", `the container ${name}`);
    }
  }
  let services: SwarmService[] = [];
  try {
    services = await docker.json<SwarmService[]>("GET", "/services");
  } catch (error) {
    // 503: not a Swarm manager, so no service holds anything.
    if (!(error instanceof DockerError && error.status === 503)) throw error;
  }
  for (const service of services) {
    const name = service.Spec.Name ?? service.ID;
    for (const port of [
      ...(service.Endpoint?.Ports ?? []),
      ...(service.Spec.EndpointSpec?.Ports ?? []),
    ]) {
      if (port.PublishedPort)
        add(port.PublishedPort, port.Protocol ?? "tcp", `the Swarm service ${name}`);
    }
  }
  return held;
}

const waitPortsFree: Handler<"ports.wait-free"> = async (
  params,
  context,
): Promise<PortsWaitResult> => {
  const until = Date.now() + params.timeoutSeconds * 1000;
  for (;;) {
    const held = await portHolders(context.docker, params.ports);
    if (held.length === 0) return { free: true, held: [] };
    if (Date.now() >= until || context.signal.aborted) return { free: false, held };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

export const migrationHandlers: { [K in MigrationCommandKind]: Handler<K> } = {
  "certificates.import": importCertificates,
  "legacy.workload": legacyWorkload,
  "ports.wait-free": waitPortsFree,
  "volume.restore": restoreVolume,
};
