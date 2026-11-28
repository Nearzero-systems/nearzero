import {
  type ControlMessage,
  encodeChunk,
  NEARZERO_LABELS,
  parseControlMessage,
  type RouterState,
  RUNNER_PROTOCOL_MIN_SUPPORTED,
  RUNNER_PROTOCOL_VERSION,
  type RunnerMessage,
} from "@nearzero/shared";
import type { Db } from "../../src/db/database.ts";
import type { RunnerHub } from "../../src/runners/hub.ts";

/**
 * A runner for control-plane tests: it speaks the real protocol to the hub (hello, acks,
 * results, streams) over an in-memory link, and carries out commands against a small pretend
 * Docker, so the deploy pipeline, runtime actions and teardown run end to end without a server.
 * Tests steer it: a build that waits or fails, a container that crashes with output, a server
 * that goes away.
 */

export interface FakeContainer {
  id: string;
  name: string;
  image: string;
  labels: Record<string, string>;
  env: Record<string, string>;
  state: "created" | "running" | "exited";
  exitCode: number;
  startedAt: string;
  restartCount: number;
  output: string;
  ports: { containerPort: number; hostPort: number; protocol: string }[];
  files: { path: string }[];
  /** What `docker ps` shows as its status, like "Up 2 hours (unhealthy)" (sendState). */
  statusText?: string;
  /** A health check's status by time: "starting" until this, then "healthy" (or as set). */
  health?: { startingUntil: number; after: "healthy" | "unhealthy" };
  /** Volumes and folders it mounts (Docker refuses to remove a volume a container mounts). */
  mounts?: { type: string; source: string }[];
  createdAt: number;
}

export class FakeRunner {
  readonly commands: { kind: string; params: Record<string, unknown> }[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly images = new Map<string, Record<string, string>>();
  readonly volumes = new Map<string, Record<string, string>>();
  readonly folders = new Set<string>();
  readonly routes = new Map<string, unknown>();
  /** Images whose containers exit right after they start, with this output. */
  readonly crashing = new Map<string, string>();
  /** Nearzero's labelled copies of pulled images, and what they were pulled as. */
  readonly origins = new Map<string, string>();
  /**
   * Handlers other areas' tests add for their own commands (the Compose runtime's fake Compose,
   * test/support/fake-compose.ts). Checked before the built-in ones.
   */
  readonly extraHandlers = new Map<
    string,
    (params: Record<string, unknown>, write: (text: string) => void) => Promise<unknown>
  >();
  /** The ports images declare (EXPOSE), by the image pulled; and what built images declare. */
  readonly exposedPorts = new Map<string, string[]>();
  builtExposedPorts: string[] = [];
  /** The commit source.git checks out when it isn't asked for one: the branch's newest. */
  headCommit = "0123456789abcdef0123456789abcdef01234567";
  /** Set to make the next builds fail with this message. */
  buildFailure: string | null = null;
  /** While set, builds wait until it resolves (or the build is cancelled). */
  buildGate: Promise<void> | null = null;
  #releaseGate: (() => void) | null = null;
  builds = 0;
  readonly #hub: RunnerHub;
  readonly #runnerId: string;
  readonly #serverId: string | null;
  #link: ReturnType<RunnerHub["attach"]> | null = null;
  #next = 1;
  readonly #cancels = new Map<string, () => void>();
  readonly #streamOf = new Map<string, string>();

  private constructor(hub: RunnerHub, runnerId: string, serverId: string | null) {
    this.#hub = hub;
    this.#runnerId = runnerId;
    this.#serverId = serverId;
  }

  static async connect(
    db: Db,
    hub: RunnerHub,
    serverId: string | null = null,
  ): Promise<FakeRunner> {
    const row = await db
      .insertInto("runner")
      .values({ server_id: serverId, credential_hash: "0".repeat(64) })
      .returning("id")
      .executeTakeFirstOrThrow();
    const runner = new FakeRunner(hub, row.id, serverId);
    await runner.reconnect();
    return runner;
  }

  async reconnect(): Promise<void> {
    this.#link = this.#hub.attach(
      {
        send: (data) => queueMicrotask(() => this.#receive(data)),
        close: () => {
          this.#link = null;
        },
      },
      { runnerId: this.#runnerId, serverId: this.#serverId },
    );
    this.#send({
      type: "hello",
      runnerVersion: "1.0.0-test",
      protocol: RUNNER_PROTOCOL_VERSION,
      minProtocol: RUNNER_PROTOCOL_MIN_SUPPORTED,
      startedAt: Date.now(),
      system: {
        hostname: "fake",
        os: "Linux",
        kernel: "6",
        architecture: "arm64",
        cpuModel: "fake",
        cpuCores: 1,
        cpuThreads: 1,
        cpuMhz: 1,
        memoryTotalBytes: 1,
        dockerVersion: "28",
        containerized: false,
      },
      checks: { docker: true, network: true, router: true, routerDirectory: true },
      streams: [],
      commands: [],
    });
    const target = this.#serverId ?? "host";
    const deadline = Date.now() + 5_000;
    while (!this.#hub.isOnline(target)) {
      if (Date.now() > deadline) throw new Error("the fake runner wasn't welcomed");
      await Bun.sleep(5);
    }
  }

  /**
   * Sends a heartbeat every 10 s, as the real runner does, so a slow test never leaves the link
   * silent past the hub's timeout. Returns the function that stops them.
   */
  keepAlive(): () => void {
    let seq = 0;
    const timer = setInterval(() => {
      this.#send({ type: "heartbeat", seq: seq++, at: Date.now() });
    }, 10_000);
    return () => clearInterval(timer);
  }

  /** The server goes away: the hub sees the link close. */
  disconnect(): void {
    const link = this.#link;
    this.#link = null;
    link?.closed(1006);
  }

  /** Reports the containers as the runner's state does every few seconds (G2-06). */
  async sendState(): Promise<void> {
    this.#send({
      type: "state",
      at: Date.now(),
      containers: [...this.containers.values()].map((container) => ({
        id: container.id,
        name: container.name,
        image: container.image,
        state: container.state,
        status:
          container.statusText ?? (container.state === "running" ? "Up 1 hour" : "Exited (0)"),
        labels: container.labels,
        createdAt: container.createdAt,
      })),
      router: {
        running: true,
        image: "traefik:v3.7.18",
        routes: 0,
        held: [],
        lastError: null,
        checkedAt: Date.now(),
      },
      checks: { docker: true, network: true, router: true, routerDirectory: true },
    });
    await Bun.sleep(50);
  }

  /** Reports the router's state as a runner does (R3-22's HTTP/3 among it). */
  async sendRouterState(router: Partial<RouterState> = {}): Promise<void> {
    this.#send({
      type: "state",
      at: Date.now(),
      containers: [],
      router: {
        running: true,
        image: "traefik:v3.7.18",
        routes: 0,
        held: [],
        lastError: null,
        checkedAt: Date.now(),
        ...router,
      },
      checks: { docker: true, network: true, router: true, routerDirectory: true },
    });
    await Bun.sleep(50);
  }

  holdBuilds(): void {
    this.buildGate = new Promise((resolve) => {
      this.#releaseGate = resolve;
    });
  }

  releaseBuilds(): void {
    this.#releaseGate?.();
    this.buildGate = null;
  }

  commandsOf(kind: string) {
    return this.commands.filter((command) => command.kind === kind);
  }

  serviceContainers(serviceId: string): FakeContainer[] {
    return [...this.containers.values()].filter(
      (container) => container.labels[NEARZERO_LABELS.service] === serviceId,
    );
  }

  #send(message: RunnerMessage): void {
    const link = this.#link;
    if (!link) return;
    queueMicrotask(() => link.message(JSON.stringify(message)));
  }

  #receive(frame: string): void {
    const message = parseControlMessage(frame) as ControlMessage | null;
    if (!message) return;
    if (message.type === "command") {
      this.#send({ type: "ack", commandId: message.commandId });
      void this.#run(message);
    } else if (message.type === "cancel") {
      this.#cancels.get(message.commandId)?.();
    } else if (message.type === "stream.close") {
      for (const [commandId, streamId] of this.#streamOf) {
        if (streamId === message.streamId) this.#cancels.get(commandId)?.();
      }
    }
  }

  async #run(message: Extract<ControlMessage, { type: "command" }>): Promise<void> {
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.commands.push({ kind: message.kind, params });
    let offset = 0;
    const streamId = message.streamId;
    if (streamId) this.#streamOf.set(message.commandId, streamId);
    const write = (text: string) => {
      if (!streamId) return;
      const bytes = new TextEncoder().encode(text);
      this.#send({ type: "stream.data", streamId, offset, data: encodeChunk(bytes) });
      offset += bytes.length;
    };
    let cancelled = false;
    const cancel = new Promise<void>((resolve) => {
      this.#cancels.set(message.commandId, () => {
        cancelled = true;
        resolve();
      });
    });
    const finish = (ok: boolean, data: unknown, error?: { code: string; message: string }) => {
      if (streamId) {
        this.#send({
          type: "stream.end",
          streamId,
          offset,
          ...(error ? { error: error as never } : {}),
        });
      }
      this.#send({
        type: "result",
        commandId: message.commandId,
        ok,
        ...(ok ? { data } : { error: error as never }),
      });
      this.#cancels.delete(message.commandId);
      this.#streamOf.delete(message.commandId);
    };
    try {
      const data = await this.#handle(message.kind, params, write, cancel, () => cancelled);
      if (cancelled)
        finish(false, null, { code: "cancelled", message: "The command was cancelled." });
      else finish(true, data);
    } catch (error) {
      const code = (error as { code?: string }).code ?? "failed";
      finish(false, null, { code, message: (error as Error).message });
    }
  }

  #container(id: string): FakeContainer {
    const found =
      this.containers.get(id) ?? [...this.containers.values()].find((item) => item.name === id);
    if (!found) throw Object.assign(new Error(`No such container: ${id}`), { code: "not_found" });
    return found;
  }

  async #handle(
    kind: string,
    params: Record<string, unknown>,
    write: (text: string) => void,
    cancel: Promise<void>,
    isCancelled: () => boolean,
  ): Promise<unknown> {
    const extra = this.extraHandlers.get(kind);
    if (extra) return extra(params, write);
    switch (kind) {
      case "router.sync":
      case "router.ensure":
      case "router.check-holds":
      case "network.ensure":
        return {};
      case "router.write":
        for (const route of params.routes as { key: string }[]) this.routes.set(route.key, route);
        return {};
      case "router.remove":
        for (const key of params.keys as string[]) this.routes.delete(key);
        return {};
      case "image.pull": {
        // Like the real runner: the control plane's log already says "Pulling <image>".
        write(`Downloading ${params.image}: 100%\nPulled ${params.image}\n`);
        const own = params.ownTag ? String(params.ownTag) : null;
        if (own) {
          this.images.set(own, (params.labels as Record<string, string>) ?? {});
          this.origins.set(own, String(params.image));
        } else this.images.set(String(params.image), {});
        return {
          image: own ?? params.image,
          exposedPorts: this.exposedPorts.get(String(params.image)) ?? [],
        };
      }
      case "source.git":
        write(`Fetching ${params.commit ?? params.branch} from ${params.url}\n`);
        this.folders.add(String(params.appKey));
        return {
          commit: params.commit ? String(params.commit) : this.headCommit,
          subject: "Add the home page",
          branch: params.branch,
        };
      case "source.archive":
        write("Unpacking the archive\n");
        this.folders.add(String(params.appKey));
        return { files: 2, bytes: 10, strippedFolder: null };
      case "app.build": {
        this.builds++;
        write("#1 building\n");
        if (this.buildGate) await Promise.race([this.buildGate, cancel]);
        if (isCancelled()) return null;
        if (this.buildFailure) {
          write(`ERROR: ${this.buildFailure}\n`);
          throw new Error(`The Docker build failed (exit code 1).`);
        }
        const tag = (params.tags as string[])[0] as string;
        this.images.set(tag, params.labels as Record<string, string>);
        write(`#9 naming to ${tag} done\n`);
        return {
          image: tag,
          builder: "dockerfile",
          framework: "Express",
          language: "Node.js",
          notes: [],
          exposedPorts: this.builtExposedPorts,
        };
      }
      case "volume.create":
        this.volumes.set(String(params.name), (params.labels as Record<string, string>) ?? {});
        return {};
      case "volume.list": {
        const wanted = (params.labels as string[]) ?? [];
        return [...this.volumes]
          .filter(([, labels]) =>
            wanted.every((filter) => {
              const [key, value] = filter.split("=");
              return labels[key as string] === value;
            }),
          )
          .map(([name, labels]) => ({ Name: name, Labels: labels }));
      }
      case "volume.remove": {
        const name = String(params.name);
        // As Docker does, force or not: a volume a container mounts stays.
        const user = [...this.containers.values()].find((container) =>
          container.mounts?.some((mount) => mount.type === "volume" && mount.source === name),
        );
        if (user) {
          throw Object.assign(new Error(`remove ${name}: volume is in use - [${user.id}]`), {
            code: "conflict",
          });
        }
        this.volumes.delete(name);
        return {};
      }
      case "image.list": {
        const labels = (params.labels as string[]) ?? [];
        const references = (params.reference as string[]) ?? [];
        return [...this.images]
          .filter(([tag, imageLabels]) => {
            if (labels.length) {
              return labels.every((filter) => {
                const [key, value] = filter.split("=");
                return imageLabels[key as string] === value;
              });
            }
            return references.some(
              (reference) => tag === reference || tag.startsWith(`${reference}:`),
            );
          })
          .map(([tag, imageLabels]) => ({ id: tag, tags: [tag], labels: imageLabels, size: 1 }));
      }
      case "image.remove":
        this.images.delete(String(params.image));
        return {};
      case "workdir.remove":
        this.folders.delete(String(params.appKey));
        return {};
      case "container.list": {
        const filters = (params.labels as string[]) ?? [];
        return [...this.containers.values()]
          .filter((container) =>
            filters.every((filter) => {
              const [key, value] = filter.split("=");
              return container.labels[key as string] === value;
            }),
          )
          .map((container) => ({
            id: container.id,
            name: container.name,
            image: container.image,
            state: container.state,
            status: container.state,
            labels: container.labels,
            createdAt: container.createdAt,
          }));
      }
      case "container.create": {
        const name = String(params.name);
        if ([...this.containers.values()].some((container) => container.name === name)) {
          throw Object.assign(new Error(`The name ${name} is in use.`), { code: "conflict" });
        }
        const id = `c${this.#next++}${"0".repeat(10)}`;
        this.containers.set(id, {
          id,
          name,
          image: String(params.image),
          labels: {
            ...(params.labels as Record<string, string>),
            [NEARZERO_LABELS.managed]: "true",
          },
          env: (params.env as Record<string, string>) ?? {},
          state: "created",
          exitCode: 0,
          startedAt: "0001-01-01T00:00:00Z",
          restartCount: 0,
          output: "",
          ports: (params.ports as FakeContainer["ports"]) ?? [],
          files: ((params.files as { path: string }[]) ?? []).map((file) => ({ path: file.path })),
          mounts: ((params.mounts as { type: string; source: string }[]) ?? []).map((mount) => ({
            type: mount.type,
            source: mount.source,
          })),
          createdAt: Math.floor(Date.now() / 1000) + this.#next,
        });
        return { id };
      }
      case "container.start": {
        const container = this.#container(String(params.id));
        const crash =
          this.crashing.get(container.image) ??
          this.crashing.get(this.origins.get(container.image) ?? "");
        container.startedAt = new Date().toISOString();
        if (crash !== undefined) {
          container.state = "exited";
          container.exitCode = 1;
          container.output = crash;
        } else {
          container.state = "running";
          container.output = "listening on 3000\n";
        }
        return {};
      }
      case "container.stop": {
        const container = this.#container(String(params.id));
        container.state = "exited";
        return {};
      }
      case "container.remove":
        this.containers.delete(this.#container(String(params.id)).id);
        return {};
      case "container.inspect": {
        const container = this.#container(String(params.id));
        return {
          id: container.id,
          name: container.name,
          image: container.image,
          state: container.state,
          running: container.state === "running",
          exitCode: container.exitCode,
          startedAt: container.startedAt,
          finishedAt: null,
          oomKilled: false,
          restartCount: container.restartCount,
          health: container.health
            ? Date.now() < container.health.startingUntil
              ? "starting"
              : container.health.after
            : null,
          labels: container.labels,
          tty: false,
          networks: ["nearzero-edge"],
        };
      }
      case "container.logs": {
        const container = this.#container(String(params.id));
        // As Docker does with timestamps: each line starts with the time it was recorded.
        write(
          params.timestamps === true
            ? container.output.replace(/^(?=.)/gm, "2026-11-28T10:15:30.123456789Z ")
            : container.output,
        );
        return {};
      }
      case "container.exec-capture":
        return { exitCode: 0, output: "1\n" };
      default:
        return {};
    }
  }
}
