import { editionLabels } from "@nearzero/shared";
import { demuxDockerStream } from "./demux.ts";
import { type HijackedStream, hijack } from "./hijack.ts";

/**
 * A small client for the Docker Engine API on the local socket (spec 25 D5: the runner talks to
 * the Engine API itself). Only what the runner uses is here. Every call goes through
 * {@link DockerClient.request}, which speaks to the socket with Bun's fetch.
 */

/**
 * 1.0's mark on every container, volume and network the runner creates (spec 29.5): the move
 * attempt comes from the runner's environment while a move from 0.1.x runs.
 */
function oneLabels(): Record<string, string> {
  return editionLabels(process.env.NEARZERO_MIGRATION_ATTEMPT);
}

/** Newest Engine API version the runner asks for; older engines are spoken to in their own. */
const MAX_API_VERSION = "1.47";
/** Docker 20.10. Older engines lack what the runner needs (BuildKit by default, start-first). */
const MIN_API_VERSION = "1.41";

export class DockerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "DockerError";
    this.status = status;
  }
}

/** The engine isn't reachable at all (not installed, not running, no permission). */
export class DockerUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DockerUnavailableError";
  }
}

function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor === bMajor ? aMinor - bMinor : aMajor - bMajor;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** A body sent as it is (an archive), instead of JSON. */
  rawBody?: { bytes: Uint8Array | Blob; contentType: string };
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export interface ContainerSummary {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
  Labels: Record<string, string> | null;
  Created: number;
}

export interface ContainerDetails {
  Id: string;
  Name: string;
  Config: {
    Image: string;
    Tty: boolean;
    Labels: Record<string, string> | null;
    User: string;
    Env: string[] | null;
    Cmd: string[] | null;
  };
  State: {
    Status: string;
    Running: boolean;
    ExitCode: number;
    StartedAt: string;
    FinishedAt?: string;
    OOMKilled?: boolean;
    Health?: { Status?: string } | null;
  };
  RestartCount?: number;
  HostConfig: {
    Binds: string[] | null;
    PortBindings?: Record<string, { HostIp?: string; HostPort?: string }[] | null> | null;
  };
  Mounts: { Type: string; Source: string; Destination: string; Name?: string }[];
  NetworkSettings: { Networks: Record<string, { IPAddress: string; Aliases: string[] | null }> };
  Image: string;
}

export interface PullProgress {
  /** Overall progress from 0 to 100, from the layers' bytes. */
  percent: number;
  /** A line worth showing, when a layer changed state. */
  line?: string;
}

/** One event of the Engine's pull stream. */
export interface PullEvent {
  status?: string;
  id?: string;
  progressDetail?: { current?: number; total?: number };
}

/** Layer states after which its download is finished. */
const LAYER_DOWNLOADED =
  /^(Verifying Checksum|Download complete|Extracting|Pull complete|Already exists)$/;

/**
 * Overall progress of a pull from the Engine's per-layer events (spec 6.5), as a percentage that
 * never goes down. Only download bytes count: extraction reports sizes of its own, which would
 * pull the figure back. A layer whose size isn't known yet counts as the average of the known
 * ones, and the figure stays below 100 until every layer is downloaded, so it neither jumps
 * ahead early nor backwards when a late layer's size arrives.
 */
export class PullMeter {
  readonly #layers = new Map<string, { current: number; total: number; status: string }>();
  #shown = 0;

  update(item: PullEvent): PullProgress {
    let line: string | undefined;
    const status = item.status ?? "";
    if (item.id && status && !status.startsWith("Pulling from")) {
      const layer = this.#layers.get(item.id) ?? { current: 0, total: 0, status: "" };
      if (status === "Downloading" && item.progressDetail?.total) {
        layer.total = item.progressDetail.total;
        layer.current = Math.min(item.progressDetail.current ?? 0, layer.total);
      } else if (LAYER_DOWNLOADED.test(status)) {
        layer.current = layer.total;
      }
      if (layer.status !== status && !/^(Downloading|Extracting|Waiting)$/.test(status)) {
        line = `${item.id}: ${status}`;
      }
      layer.status = status;
      this.#layers.set(item.id, layer);
    } else if (status) {
      line = status;
    }
    this.#shown = Math.max(this.#shown, this.#estimate());
    return line === undefined ? { percent: this.#shown } : { percent: this.#shown, line };
  }

  #estimate(): number {
    let known = 0;
    let current = 0;
    let sized = 0;
    let unsized = 0;
    let finished = true;
    for (const layer of this.#layers.values()) {
      const downloaded = LAYER_DOWNLOADED.test(layer.status);
      if (!downloaded) finished = false;
      if (layer.total > 0) {
        sized++;
        known += layer.total;
        current += layer.current;
      } else if (!downloaded) {
        unsized++;
      }
    }
    if (this.#layers.size === 0) return 0;
    if (finished) return 100;
    const expected = known + (sized > 0 ? (known / sized) * unsized : 0);
    if (expected === 0) return 0;
    return Math.min(99, Math.floor((current / expected) * 100));
  }
}

/** Splits an image reference so a pull never fetches every tag of a repository. */
export function imageWithTag(reference: string): string {
  if (reference.includes("@")) return reference;
  const lastSlash = reference.lastIndexOf("/");
  const lastColon = reference.lastIndexOf(":");
  return lastColon > lastSlash ? reference : `${reference}:latest`;
}

export class DockerClient {
  readonly socketPath: string;
  #apiVersion: string | null = null;

  constructor(options: { socketPath: string }) {
    this.socketPath = options.socketPath;
  }

  get apiVersion(): string | null {
    return this.#apiVersion;
  }

  /** Finds the API version to speak: the engine's own, up to the newest this runner knows. */
  async negotiate(): Promise<string> {
    let response: Response;
    try {
      response = await fetch("http://docker/_ping", { unix: this.socketPath });
    } catch (error) {
      throw new DockerUnavailableError(
        `Docker isn't reachable on ${this.socketPath}. Check that Docker is installed and running, and that the runner may use its socket.`,
        { cause: error },
      );
    }
    const engine = response.headers.get("api-version") ?? MAX_API_VERSION;
    await response.body?.cancel();
    if (compareVersions(engine, MIN_API_VERSION) < 0) {
      throw new DockerUnavailableError(
        `Docker on this server is too old (Engine API ${engine}). Nearzero needs Docker 20.10 or newer; upgrade Docker, then run setup again.`,
      );
    }
    this.#apiVersion = compareVersions(engine, MAX_API_VERSION) < 0 ? engine : MAX_API_VERSION;
    return this.#apiVersion;
  }

  async #prefix(): Promise<string> {
    return `/v${this.#apiVersion ?? (await this.negotiate())}`;
  }

  async request(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    const url = new URL(`http://docker${await this.#prefix()}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { ...options.headers };
    let body: string | Uint8Array | Blob | undefined;
    if (options.rawBody) {
      headers["content-type"] = options.rawBody.contentType;
      body = options.rawBody.bytes;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        unix: this.socketPath,
        ...(body === undefined ? {} : { body }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      if ((error as Error).name === "AbortError") throw error;
      throw new DockerUnavailableError(
        `Docker isn't reachable on ${this.socketPath}. Check that Docker is running.`,
        { cause: error },
      );
    }
    if (response.status >= 400) {
      let message = `Docker answered ${response.status}`;
      try {
        const text = await response.text();
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) message = parsed.message;
      } catch {
        // Keep the status as the message.
      }
      throw new DockerError(response.status, message);
    }
    return response;
  }

  async json<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.request(method, path, options);
    if (response.status === 204 || response.status === 304) {
      await response.body?.cancel();
      return undefined as T;
    }
    const text = await response.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /** For calls whose answer doesn't matter (start, stop, remove…). */
  async call(method: string, path: string, options: RequestOptions = {}): Promise<void> {
    const response = await this.request(method, path, options);
    await response.body?.cancel();
  }

  // ---- System

  info(): Promise<{
    ServerVersion: string;
    OperatingSystem: string;
    KernelVersion: string;
    Architecture: string;
    NCPU: number;
    MemTotal: number;
    Name: string;
    SecurityOptions?: string[];
  }> {
    return this.json("GET", "/info");
  }

  #selinux: Promise<boolean> | null = null;

  /**
   * Whether the Docker daemon labels containers for SELinux (Fedora's moby-engine runs with
   * --selinux-enabled): then a folder of this server's bound into a container is relabelled
   * (`,z`) so the confined container may read it (C2-08). Asked once; false when unknown.
   */
  selinuxEnabled(): Promise<boolean> {
    this.#selinux ??= this.info()
      .then((info) =>
        (info.SecurityOptions ?? []).some((item) => /(^|,)name=selinux(,|$)/.test(item)),
      )
      .catch(() => {
        this.#selinux = null;
        return false;
      });
    return this.#selinux;
  }

  // ---- Images

  async imageExists(reference: string): Promise<boolean> {
    try {
      await this.json("GET", `/images/${encodeURIComponent(reference)}/json`);
      return true;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return false;
      throw error;
    }
  }

  /** The ports an image declares (EXPOSE), like "8080/tcp"; none when it declares none. */
  async imageExposedPorts(reference: string): Promise<string[]> {
    const details = (await this.json("GET", `/images/${encodeURIComponent(reference)}/json`)) as {
      Config?: { ExposedPorts?: Record<string, unknown> | null } | null;
    };
    return Object.keys(details.Config?.ExposedPorts ?? {});
  }

  /** Pulls an image, reporting overall progress; fails with the registry's own message. */
  async pullImage(
    reference: string,
    options: {
      platform?: string;
      registryAuth?: string;
      signal?: AbortSignal;
      onProgress?: (progress: PullProgress) => void;
    } = {},
  ): Promise<void> {
    const response = await this.request("POST", "/images/create", {
      query: { fromImage: imageWithTag(reference), platform: options.platform },
      headers: options.registryAuth ? { "x-registry-auth": options.registryAuth } : {},
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const meter = new PullMeter();
    for await (const event of jsonLines(response)) {
      const item = event as PullEvent & { error?: string; errorDetail?: { message?: string } };
      if (item.error || item.errorDetail) {
        throw new DockerError(500, item.errorDetail?.message ?? item.error ?? "The pull failed.");
      }
      options.onProgress?.(meter.update(item));
    }
  }

  listImages(
    filters: { labels?: string[]; reference?: string[] } = {},
  ): Promise<
    { Id: string; RepoTags: string[] | null; Labels: Record<string, string> | null; Size: number }[]
  > {
    const wanted: Record<string, string[]> = {};
    if (filters.labels?.length) wanted.label = filters.labels;
    if (filters.reference?.length) wanted.reference = filters.reference;
    return this.json("GET", "/images/json", {
      query: { filters: Object.keys(wanted).length ? JSON.stringify(wanted) : undefined },
    });
  }

  async removeImage(reference: string, force = false): Promise<void> {
    await this.call("DELETE", `/images/${encodeURIComponent(reference)}`, { query: { force } });
  }

  // ---- Containers

  async createContainer(name: string, config: Record<string, unknown>): Promise<string> {
    const labels = (config.Labels as Record<string, string> | undefined) ?? {};
    const created = await this.json<{ Id: string }>("POST", "/containers/create", {
      query: { name },
      body: { ...config, Labels: { ...labels, ...oneLabels() } },
    });
    return created.Id;
  }

  async startContainer(id: string): Promise<void> {
    await this.call("POST", `/containers/${encodeURIComponent(id)}/start`);
  }

  async stopContainer(id: string, timeoutSeconds = 10): Promise<void> {
    await this.call("POST", `/containers/${encodeURIComponent(id)}/stop`, {
      query: { t: timeoutSeconds },
    });
  }

  /**
   * Removes a container with its anonymous volumes, always: a named volume is never removed this
   * way (spec 29.5: 1.0 removes a container's anonymous volumes wherever it removes one).
   */
  async removeContainer(id: string, options: { force?: boolean } = {}) {
    await this.call("DELETE", `/containers/${encodeURIComponent(id)}`, {
      query: { force: options.force ?? false, v: true },
    });
  }

  /** The anonymous volumes a container mounts (Docker marks them, or names them by 64 hex digits). */
  async anonymousVolumesOf(id: string): Promise<string[]> {
    const details = await this.json<{ Mounts?: { Type?: string; Name?: string }[] }>(
      "GET",
      `/containers/${encodeURIComponent(id)}/json`,
    ).catch(() => ({ Mounts: [] }));
    const names: string[] = [];
    for (const mount of details.Mounts ?? []) {
      if (mount.Type !== "volume" || !mount.Name) continue;
      const volume = await this.json<{ Labels?: Record<string, string> | null }>(
        "GET",
        `/volumes/${encodeURIComponent(mount.Name)}`,
      ).catch(() => null);
      const marked = volume?.Labels && "com.docker.volume.anonymous" in volume.Labels;
      if (marked || /^[0-9a-f]{64}$/.test(mount.Name)) names.push(mount.Name);
    }
    return names;
  }

  /** Unpacks a tar archive into a container's filesystem at `path` (which must exist). */
  async putArchive(id: string, path: string, tar: Uint8Array): Promise<void> {
    await this.call("PUT", `/containers/${encodeURIComponent(id)}/archive`, {
      query: { path, copyUIDGID: true, noOverwriteDirNonDir: true },
      rawBody: { bytes: tar, contentType: "application/x-tar" },
    });
  }

  /** Whether a path exists in a container's filesystem. */
  async containerPathExists(id: string, path: string): Promise<boolean> {
    try {
      await this.call("HEAD", `/containers/${encodeURIComponent(id)}/archive`, { query: { path } });
      return true;
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return false;
      throw error;
    }
  }

  inspectContainer(id: string): Promise<ContainerDetails> {
    return this.json("GET", `/containers/${encodeURIComponent(id)}/json`);
  }

  async findContainer(id: string): Promise<ContainerDetails | null> {
    try {
      return await this.inspectContainer(id);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null;
      throw error;
    }
  }

  waitContainer(
    id: string,
    condition: string,
    signal?: AbortSignal,
  ): Promise<{ StatusCode: number }> {
    return this.json("POST", `/containers/${encodeURIComponent(id)}/wait`, {
      query: { condition },
      ...(signal ? { signal } : {}),
    });
  }

  listContainers(options: { all?: boolean; labels?: string[] } = {}): Promise<ContainerSummary[]> {
    const filters = options.labels?.length ? JSON.stringify({ label: options.labels }) : undefined;
    return this.json("GET", "/containers/json", { query: { all: options.all ?? true, filters } });
  }

  /**
   * The container's output as one byte stream: stdout and stderr merged in order for containers
   * without a TTY (Docker multiplexes them), raw for containers with one.
   */
  async logs(
    id: string,
    options: {
      follow: boolean;
      tail: number | "all";
      since?: number;
      timestamps: boolean;
      signal?: AbortSignal;
    },
  ): Promise<AsyncIterable<Uint8Array>> {
    const details = await this.inspectContainer(id);
    const response = await this.request("GET", `/containers/${encodeURIComponent(id)}/logs`, {
      query: {
        follow: options.follow,
        stdout: true,
        stderr: true,
        tail: options.tail,
        since: options.since,
        timestamps: options.timestamps,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.body) return emptyStream();
    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    return details.Config.Tty ? body : demuxDockerStream(body);
  }

  // ---- Exec

  async createExec(
    id: string,
    options: {
      command: string[];
      tty: boolean;
      env: Record<string, string>;
      user?: string;
      workingDir?: string;
    },
  ): Promise<string> {
    const created = await this.json<{ Id: string }>(
      "POST",
      `/containers/${encodeURIComponent(id)}/exec`,
      {
        body: {
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: options.tty,
          Cmd: options.command,
          Env: Object.entries(options.env).map(([key, value]) => `${key}=${value}`),
          ...(options.user ? { User: options.user } : {}),
          ...(options.workingDir ? { WorkingDir: options.workingDir } : {}),
        },
      },
    );
    return created.Id;
  }

  /** Starts an exec and hands back its two-way connection (Docker's hijacked stream). */
  async startExec(execId: string, tty: boolean): Promise<HijackedStream> {
    return hijack(this.socketPath, `${await this.#prefix()}/exec/${execId}/start`, {
      Detach: false,
      Tty: tty,
    });
  }

  async resizeExec(execId: string, cols: number, rows: number): Promise<void> {
    await this.call("POST", `/exec/${execId}/resize`, { query: { h: rows, w: cols } });
  }

  inspectExec(execId: string): Promise<{ Running: boolean; ExitCode: number | null }> {
    return this.json("GET", `/exec/${execId}/json`);
  }

  // ---- Networks and volumes

  async findNetwork(name: string): Promise<{ Id: string; Name: string; Driver: string } | null> {
    try {
      return await this.json("GET", `/networks/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null;
      throw error;
    }
  }

  async createNetwork(name: string, labels: Record<string, string>): Promise<string> {
    const created = await this.json<{ Id: string }>("POST", "/networks/create", {
      body: {
        Name: name,
        Driver: "bridge",
        CheckDuplicate: true,
        Labels: { ...labels, ...oneLabels() },
      },
    });
    return created.Id;
  }

  async connectNetwork(network: string, container: string, aliases: string[]): Promise<void> {
    await this.call("POST", `/networks/${encodeURIComponent(network)}/connect`, {
      body: { Container: container, EndpointConfig: aliases.length ? { Aliases: aliases } : {} },
    });
  }

  async removeNetwork(name: string): Promise<void> {
    await this.call("DELETE", `/networks/${encodeURIComponent(name)}`);
  }

  async findVolume(name: string): Promise<{ Name: string } | null> {
    try {
      return await this.json("GET", `/volumes/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof DockerError && error.status === 404) return null;
      throw error;
    }
  }

  async createVolume(name: string, labels: Record<string, string>): Promise<void> {
    await this.call("POST", "/volumes/create", {
      body: { Name: name, Labels: { ...labels, ...oneLabels() } },
    });
  }

  async removeVolume(name: string, force = false): Promise<void> {
    await this.call("DELETE", `/volumes/${encodeURIComponent(name)}`, { query: { force } });
  }

  async listVolumes(labels: string[]): Promise<{ Name: string; Labels: Record<string, string> }[]> {
    const filters = labels.length ? JSON.stringify({ label: labels }) : undefined;
    const answer = await this.json<{ Volumes: { Name: string; Labels: Record<string, string> }[] }>(
      "GET",
      "/volumes",
      { query: { filters } },
    );
    return answer.Volumes ?? [];
  }

  // ---- Cleanup

  async pruneImages(unused: boolean): Promise<{ SpaceReclaimed: number }> {
    const filters = JSON.stringify({ dangling: [unused ? "false" : "true"] });
    return this.json("POST", "/images/prune", { query: { filters } });
  }

  /** Removes every unused build cache record (not only dangling ones, spec 9.4, R3-04). */
  async pruneBuildCache(): Promise<{ SpaceReclaimed: number }> {
    return this.json("POST", "/build/prune", { query: { all: true } });
  }

  // ---- Events

  /** Container events as they happen, until the signal aborts. */
  async *events(
    signal: AbortSignal,
  ): AsyncGenerator<{ Type: string; Action: string; id?: string }> {
    const response = await this.request("GET", "/events", {
      query: { filters: JSON.stringify({ type: ["container"] }) },
      signal,
    });
    for await (const event of jsonLines(response)) {
      yield event as { Type: string; Action: string; id?: string };
    }
  }
}

async function* emptyStream(): AsyncGenerator<Uint8Array> {}

/** Docker's streaming answers are JSON objects separated by newlines. */
export async function* jsonLines(response: Response): AsyncGenerator<unknown> {
  if (!response.body) return;
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      if (line !== "") yield JSON.parse(line);
      newline = pending.indexOf("\n");
    }
  }
  const rest = pending.trim();
  if (rest !== "") yield JSON.parse(rest);
}

/**
 * Whether a Docker client's daemon labels containers for SELinux (C2-08); false when it can't
 * tell (a stand-in without the question, an unreachable daemon).
 */
export async function selinuxLabels(docker: object): Promise<boolean> {
  const ask = (docker as { selinuxEnabled?: () => Promise<boolean> }).selinuxEnabled;
  return typeof ask === "function" ? ask.call(docker).catch(() => false) : false;
}
