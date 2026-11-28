import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupCommandSchemas, NEARZERO_LABELS } from "@nearzero/shared";
import { backupHandlers, guardVolume } from "../src/backups/handlers.ts";
import type { CommandContext } from "../src/commands.ts";
import type { DockerClient } from "../src/docker/client.ts";

/**
 * The backup handlers' own rules, against a pretend Docker Engine (spec 17.3, 22.4 rule 4; B1-03,
 * B2-17): Nearzero's own volumes are never archived or overwritten, and the containers stopped
 * for a copy start again even when stopping a later one failed.
 */

interface FakeContainer {
  id: string;
  name: string;
  running: boolean;
  labels: Record<string, string>;
  volumes: string[];
  failStop?: boolean;
}

class FakeDocker {
  readonly calls: string[] = [];
  readonly volumes = new Map<string, Record<string, string>>();
  readonly containers = new Map<string, FakeContainer>();

  add(container: FakeContainer): void {
    this.containers.set(container.id, container);
    for (const volume of container.volumes)
      if (!this.volumes.has(volume)) this.volumes.set(volume, {});
  }

  async findVolume(name: string) {
    const labels = this.volumes.get(name);
    return labels ? { Name: name, Labels: labels } : null;
  }

  async createVolume(name: string, labels: Record<string, string>) {
    this.calls.push(`create-volume ${name}`);
    this.volumes.set(name, labels);
  }

  async removeVolume(name: string) {
    this.volumes.delete(name);
  }

  async json(_method: string, path: string, options: { query?: { filters?: string } } = {}) {
    if (path !== "/containers/json") throw new Error(`unexpected ${path}`);
    const filters = JSON.parse(options.query?.filters ?? "{}") as { volume?: string[] };
    return [...this.containers.values()]
      .filter((item) => !filters.volume || item.volumes.some((v) => filters.volume?.includes(v)))
      .map((item) => ({
        Id: item.id,
        Names: [`/${item.name}`],
        State: item.running ? "running" : "exited",
        Labels: item.labels,
        Mounts: item.volumes.map((volume) => ({ Type: "volume", Name: volume, Destination: "/d" })),
      }));
  }

  async findContainer(id: string) {
    const item = this.containers.get(id);
    if (!item) return null;
    return {
      Id: item.id,
      Name: `/${item.name}`,
      State: { Running: item.running },
      Config: { Labels: item.labels },
    };
  }

  async stopContainer(id: string) {
    const item = this.containers.get(id);
    this.calls.push(`stop ${item?.name}`);
    if (item?.failStop) throw new Error("Docker answered 500");
    if (item) item.running = false;
  }

  async startContainer(id: string) {
    const item = this.containers.get(id);
    this.calls.push(`start ${item?.name}`);
    if (item) item.running = true;
  }
}

const WORK = mkdtempSync(join(tmpdir(), "nz-backup-handlers-"));

function context(docker: FakeDocker): CommandContext {
  return {
    docker: docker as unknown as DockerClient,
    signal: new AbortController().signal,
    stream: { text: () => {} },
    workDirectory: WORK,
  } as unknown as CommandContext;
}

const DESTINATION = {
  provider: "minio",
  endpoint: "http://minio.internal:9000",
  bucket: "b",
  region: "us-east-1",
  accessKeyId: "AKID",
  secretAccessKey: "SECRET",
};
const RUN = "11111111-2222-4333-8444-555555555555";

describe("Nearzero's own volumes (B1-03)", () => {
  test("its reserved names, and anything its own containers use, are refused", async () => {
    const docker = new FakeDocker();
    docker.add({
      id: "pg",
      name: "nearzero-postgres",
      running: true,
      labels: { [NEARZERO_LABELS.component]: "database" },
      volumes: ["nearzero-postgres-data", "renamed-control-data"],
    });
    docker.volumes.set("victim-data", {});
    const fake = docker as unknown as DockerClient;
    await expect(guardVolume(fake, "nearzero-postgres-data")).rejects.toThrow("Nearzero's own");
    await expect(guardVolume(fake, "nearzero-runner-state")).rejects.toThrow("Nearzero's own");
    await expect(
      guardVolume(fake, "nearzero-backup-11111111-2222-4333-8444-555555555555"),
    ).rejects.toThrow("Nearzero's own");
    // Used by the control plane's database container under another name.
    await expect(guardVolume(fake, "renamed-control-data")).rejects.toThrow("Nearzero's own");
    expect(await guardVolume(fake, "victim-data")).toBe(true);
    expect(await guardVolume(fake, "not-there")).toBe(false);

    // The commands refuse before anything is stopped, read or written.
    const backup = backupCommandSchemas["backup.volume"].parse({
      runId: RUN,
      volume: "renamed-control-data",
      stop: ["pg"],
      destination: DESTINATION,
      key: "s/daily/2026-01-01T00-00-00.tar.gz",
    });
    await expect(backupHandlers["backup.volume"](backup, context(docker))).rejects.toThrow(
      "Nearzero's own",
    );
    const restore = backupCommandSchemas["restore.volume"].parse({
      runId: RUN,
      volume: "nearzero-postgres-data",
      allowedContainers: ["pg"],
      destination: DESTINATION,
      key: "s/daily/2026-01-01T00-00-00.tar.gz",
    });
    await expect(backupHandlers["restore.volume"](restore, context(docker))).rejects.toThrow(
      "Nearzero's own",
    );
    expect(docker.calls).toEqual([]);
  });
});

describe("stop while copying (spec 17.3, B2-17)", () => {
  test("when stopping a later container fails, the ones already stopped start again", async () => {
    const docker = new FakeDocker();
    docker.add({ id: "a", name: "web-a", running: true, labels: {}, volumes: ["web-data"] });
    docker.add({
      id: "b",
      name: "web-b",
      running: true,
      labels: {},
      volumes: ["web-data"],
      failStop: true,
    });
    const params = backupCommandSchemas["backup.volume"].parse({
      runId: RUN,
      volume: "web-data",
      stop: ["a", "b"],
      destination: DESTINATION,
      key: "web/daily/2026-01-01T00-00-00.tar.gz",
    });
    await expect(backupHandlers["backup.volume"](params, context(docker))).rejects.toThrow(
      "Docker answered 500",
    );
    expect(docker.calls.filter((call) => !call.startsWith("create-volume"))).toEqual([
      "stop web-a",
      "stop web-b",
      "start web-a",
    ]);
    expect(docker.containers.get("a")?.running).toBe(true);
  });
});
