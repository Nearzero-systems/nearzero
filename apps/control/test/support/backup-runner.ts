import {
  BACKUP_HELPER_LABEL,
  type ControlMessage,
  encodeChunk,
  NEARZERO_LABELS,
  parseControlMessage,
  RUNNER_PROTOCOL_MIN_SUPPORTED,
  RUNNER_PROTOCOL_VERSION,
  type RunnerMessage,
  type VolumeUserContainer,
} from "@nearzero/shared";
import type { Db } from "../../src/db/database.ts";
import type { RunnerHub } from "../../src/runners/hub.ts";

/**
 * A runner for the backup tests: it speaks the real protocol to the hub and answers the backup
 * commands against a pretend bucket (a map of keys to sizes) and pretend containers and volumes,
 * so schedules, runs, pruning, listings and restores run end to end without a server. Tests
 * steer it: a dump that fails or is empty, a run held until released, a bucket that refuses.
 */

export interface FakeBackupContainer {
  id: string;
  name: string;
  state: "running" | "exited";
  labels: Record<string, string>;
  mounts: { name: string; destination: string }[];
}

export interface BucketFile {
  size: number;
  modifiedAt: string;
  /** What was "dumped", so a restore can be checked. */
  content: string;
}

export class BackupRunner {
  readonly commands: { kind: string; params: Record<string, unknown> }[] = [];
  /** Buckets by name, then keys. */
  readonly buckets = new Map<string, Map<string, BucketFile>>();
  readonly containers = new Map<string, FakeBackupContainer>();
  readonly volumes = new Map<string, Record<string, string>>();
  /** What each database "holds"; a backup copies it, a restore puts it back. */
  readonly data = new Map<string, string>();
  /** What each volume "holds". */
  readonly volumeData = new Map<string, string>();
  testFails = false;
  dumpFails: string | null = null;
  emptyDump = false;
  pruneFails: string | null = null;
  timeZone = "UTC";
  #gate: Promise<void> | null = null;
  #release: (() => void) | null = null;
  #link: ReturnType<RunnerHub["attach"]> | null = null;
  readonly #hub: RunnerHub;
  readonly #runnerId: string;
  readonly #serverId: string | null;
  #clock = 0;

  private constructor(hub: RunnerHub, runnerId: string, serverId: string | null) {
    this.#hub = hub;
    this.#runnerId = runnerId;
    this.#serverId = serverId;
  }

  static async connect(db: Db, hub: RunnerHub, serverId: string | null = null, timeZone = "UTC") {
    const row = await db
      .insertInto("runner")
      .values({
        server_id: serverId,
        credential_hash: "0".repeat(64),
        system: JSON.stringify({ timeZone }),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const runner = new BackupRunner(hub, row.id, serverId);
    runner.timeZone = timeZone;
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
        timeZone: this.timeZone,
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

  /** Puts the runner's row back after a test truncated it (the server's time zone lives there). */
  async ensureRow(db: Db): Promise<void> {
    await db
      .insertInto("runner")
      .values({
        id: this.#runnerId,
        server_id: this.#serverId,
        credential_hash: "0".repeat(64),
        system: JSON.stringify({ timeZone: this.timeZone }),
      })
      .onConflict((conflict) => conflict.column("id").doNothing())
      .execute();
  }

  disconnect(): void {
    const link = this.#link;
    this.#link = null;
    link?.closed(1006);
  }

  reset(): void {
    this.commands.length = 0;
    this.buckets.clear();
    this.containers.clear();
    this.volumes.clear();
    this.data.clear();
    this.volumeData.clear();
    this.testFails = false;
    this.dumpFails = null;
    this.emptyDump = false;
    this.pruneFails = null;
    this.release();
  }

  /** Holds every backup and restore until `release()`. */
  hold(): void {
    this.#gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  release(): void {
    this.#release?.();
    this.#gate = null;
    this.#release = null;
  }

  commandsOf(kind: string) {
    return this.commands.filter((command) => command.kind === kind);
  }

  bucket(name: string): Map<string, BucketFile> {
    let found = this.buckets.get(name);
    if (!found) {
      found = new Map();
      this.buckets.set(name, found);
    }
    return found;
  }

  /** A running database or app container of a service. */
  addContainer(
    serviceId: string,
    mounts: { name: string; destination: string }[] = [],
    extra: Record<string, string> = {},
  ) {
    const id = `c${this.containers.size + 1}${"0".repeat(10)}`;
    this.containers.set(id, {
      id,
      name: `svc-${this.containers.size + 1}`,
      state: "running",
      labels: { [NEARZERO_LABELS.service]: serviceId, ...extra },
      mounts,
    });
    for (const mount of mounts) if (!this.volumes.has(mount.name)) this.volumes.set(mount.name, {});
    return id;
  }

  #send(message: RunnerMessage): void {
    const link = this.#link;
    if (!link) return;
    queueMicrotask(() => link.message(JSON.stringify(message)));
  }

  #receive(frame: string): void {
    const message = parseControlMessage(frame) as ControlMessage | null;
    if (message?.type !== "command") return;
    this.#send({ type: "ack", commandId: message.commandId });
    void this.#run(message);
  }

  async #run(message: Extract<ControlMessage, { type: "command" }>): Promise<void> {
    const params = (message.params ?? {}) as Record<string, unknown>;
    this.commands.push({ kind: message.kind, params });
    let offset = 0;
    const streamId = message.streamId;
    const write = (text: string) => {
      if (!streamId) return;
      const bytes = new TextEncoder().encode(text);
      this.#send({ type: "stream.data", streamId, offset, data: encodeChunk(bytes) });
      offset += bytes.length;
    };
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
    };
    try {
      finish(true, await this.#handle(message.kind, params, write));
    } catch (error) {
      finish(false, null, {
        code: (error as { code?: string }).code ?? "failed",
        message: (error as Error).message,
      });
    }
  }

  /** A backup helper container of this run, mounting the volume; returns its id. */
  #addHelper(runId: string, volume: string): string {
    const id = `helper-${runId.slice(0, 8)}-${this.containers.size}`;
    this.containers.set(id, {
      id,
      name: `nearzero-backup-${runId.slice(0, 8)}`,
      state: "running",
      labels: { [NEARZERO_LABELS.managed]: "true", [BACKUP_HELPER_LABEL]: runId },
      mounts: [{ name: volume, destination: "/data" }],
    });
    return id;
  }

  /** Puts a helper of this run on the volume, as a run the control plane resumes finds it. */
  addHelper(runId: string, volume: string): string {
    return this.#addHelper(runId, volume);
  }

  #users(volume: string): VolumeUserContainer[] {
    return [...this.containers.values()]
      .filter((container) => container.mounts.some((mount) => mount.name === volume))
      .map((container) => ({ ...container }));
  }

  async #handle(kind: string, params: Record<string, unknown>, write: (text: string) => void) {
    const destination = params.destination as
      | { bucket: string; secretAccessKey: string }
      | undefined;
    switch (kind) {
      case "container.list": {
        const labels = (params.labels as string[]) ?? [];
        return [...this.containers.values()]
          .filter((container) =>
            labels.every((filter) => {
              const [key, value] = filter.split("=");
              return container.labels[key as string] === value;
            }),
          )
          .map((container) => ({
            id: container.id,
            name: container.name,
            image: "db",
            state: container.state,
            status: container.state === "running" ? "Up" : "Exited",
            labels: container.labels,
            createdAt: 1,
          }));
      }
      case "backup.test":
        if (this.testFails) throw new Error("The store refused the listing (rclone exit code 1).");
        return { entries: this.bucket(destination?.bucket ?? "").size };
      case "backup.files": {
        const prefix = String(params.prefix);
        return {
          files: [...this.bucket(destination?.bucket ?? "")]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, file]) => ({ key, size: file.size, modifiedAt: file.modifiedAt })),
        };
      }
      case "backup.prune": {
        if (this.pruneFails) throw new Error(this.pruneFails);
        for (const key of params.keys as string[])
          this.bucket(destination?.bucket ?? "").delete(key);
        return { deleted: params.keys };
      }
      case "backup.database":
      case "backup.volume": {
        write("→ Dumping\n");
        // While it archives, a volume backup's helper container mounts the volume, as the
        // runner's does (C1-11).
        const helper =
          kind === "backup.volume"
            ? this.#addHelper(String(params.runId), String(params.volume))
            : null;
        try {
          if (this.#gate) await this.#gate;
        } finally {
          if (helper) this.containers.delete(helper);
        }
        if (this.dumpFails) {
          write(`✗ ${this.dumpFails}\n`);
          throw new Error(this.dumpFails);
        }
        if (this.emptyDump) {
          throw new Error(
            "The backup produced an empty file, so nothing was uploaded. The run failed.",
          );
        }
        const source =
          kind === "backup.volume"
            ? (this.volumeData.get(String(params.volume)) ?? "")
            : (this.data.get(String(params.container)) ?? "");
        const key = String(params.key);
        this.#clock++;
        this.bucket(destination?.bucket ?? "").set(key, {
          size: source.length + 10,
          modifiedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#clock)).toISOString(),
          content: source,
        });
        // A secret printed by a tool must never reach the log.
        write(`✓ Uploaded with key ${destination?.secretAccessKey}\n`);
        return { key, bytes: source.length + 10, stopped: params.stop ?? [] };
      }
      case "restore.database":
      case "restore.volume": {
        write("→ Restoring\n");
        if (this.#gate) await this.#gate;
        const file = this.bucket(destination?.bucket ?? "").get(String(params.key));
        if (!file)
          throw Object.assign(new Error("The backup file isn't in the bucket."), {
            code: "failed",
          });
        if (kind === "restore.volume") {
          const allowed = new Set(params.allowedContainers as string[]);
          const others = this.#users(String(params.volume)).filter((user) => !allowed.has(user.id));
          if (others.length && others.every((user) => user.labels[BACKUP_HELPER_LABEL]))
            throw new Error(
              "Another backup or restore of this volume is still running on the server, so nothing was overwritten. Restore again once it has finished.",
            );
          if (others.length)
            throw new Error(
              "Another service also uses this volume, so Nearzero won't overwrite it.",
            );
          this.volumeData.set(String(params.volume), file.content);
        } else {
          this.data.set(String(params.container), file.content);
        }
        return { bytes: file.size };
      }
      case "backup.volumes": {
        const containers = new Map<string, VolumeUserContainer>();
        for (const labels of params.containerLabels as string[][]) {
          for (const container of this.containers.values()) {
            const match = labels.every((filter) => {
              const [key, value] = filter.split("=");
              return container.labels[key as string] === value;
            });
            if (match) containers.set(container.id, { ...container });
          }
        }
        const volumes: { name: string; labels: Record<string, string> }[] = [];
        for (const labels of params.volumeLabels as string[][]) {
          for (const [name, volumeLabels] of this.volumes) {
            const match = labels.every((filter) => {
              const [key, value] = filter.split("=");
              return volumeLabels[key as string] === value;
            });
            if (match) volumes.push({ name, labels: volumeLabels });
          }
        }
        const users: Record<string, VolumeUserContainer[]> = {};
        const missing: string[] = [];
        for (const name of params.volumes as string[]) {
          if (!this.volumes.has(name)) missing.push(name);
          users[name] = this.#users(name);
        }
        return { containers: [...containers.values()], volumes, users, missing };
      }
      default:
        return {};
    }
  }
}
