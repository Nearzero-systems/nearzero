import { NEARZERO_LABELS } from "@nearzero/shared";
import { parse } from "yaml";
import type { FakeContainer, FakeRunner } from "./fake-runner.ts";

/**
 * Docker Compose for the control plane's tests (and the console's browser flows): it answers the
 * Compose runtime's runner commands on a FakeRunner the way the real runner would, against the
 * fake's pretend Docker. `compose.deploy` reads the two files it is sent, merges Nearzero's
 * labels over each service, and replaces the project's containers with one running container
 * per service. Tests steer it: a file Compose refuses, a pull that fails, a service that crashes.
 */

export interface FakeCompose {
  /** Repository files `compose.prepare` reads (path → text). */
  repository: Map<string, string>;
  version: string | null;
  /** Makes `config --quiet` refuse the next files with this output. */
  refuse: string | null;
  /** Makes the pull fail with this output. */
  pullFailure: string | null;
  /** Services whose container exits right after it starts, with this output. */
  crashing: Map<string, string>;
  /** Services with a health check that stays "starting" this many ms, then passes or fails. */
  slowHealth: Map<string, { ms: number; after: "healthy" | "unhealthy" }>;
  /** Every compose.deploy, with its parameters (the env file included). */
  deploys: Record<string, unknown>[];
}

type ServiceMap = Record<string, Record<string, unknown>>;

function labelsOf(value: unknown): Record<string, string> {
  if (Array.isArray(value)) {
    return Object.fromEntries(
      value.map((item) => {
        const [key, ...rest] = String(item).split("=");
        return [key, rest.join("=")];
      }),
    );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, String(item)]));
  }
  return {};
}

export function installFakeCompose(runner: FakeRunner): FakeCompose {
  const state: FakeCompose = {
    repository: new Map(),
    version: "2.40.3",
    refuse: null,
    pullFailure: null,
    crashing: new Map(),
    slowHealth: new Map(),
    deploys: [],
  };
  let next = 1;
  runner.extraHandlers.set("compose.prepare", async (params) => {
    const repository = params.repository as { composePath: string } | undefined;
    const project = String(params.project);
    return {
      folder: `/var/lib/nearzero-runner/work/compose/${project}`,
      hostFolder: `/var/lib/nearzero-runner/work/compose/${project}`,
      composeVersion: state.version,
      composeFile: repository ? (state.repository.get(repository.composePath) ?? null) : null,
      envFiles: [],
      envValues: {},
      skippedLinks: [],
    };
  });
  runner.extraHandlers.set("compose.deploy", async (params, write) => {
    state.deploys.push(params);
    const project = String(params.project);
    const fail = (stage: string, message: string, touched = false) => ({
      ok: false,
      stage,
      message,
      touched,
      containers: [],
      notConnected: [],
    });
    write("Checking the Compose file with Docker Compose\n");
    if (state.refuse) {
      write(`${state.refuse}\n`);
      return fail("validate", `Docker Compose refused the file:\n${state.refuse}`);
    }
    const files = params.files as { name: string; content: string }[];
    const [user, additions] = files.map(
      (file) =>
        parse(file.content.replaceAll("!reset", "").replaceAll("!override", "")) as {
          services?: ServiceMap;
        },
    );
    if (params.pull !== false) {
      write("Pulling images\n");
      if (state.pullFailure) {
        write(`${state.pullFailure}\n`);
        return fail("pull", `Pulling the images failed:\n${state.pullFailure}`);
      }
    }
    write("Starting the stack\n");
    for (const container of [...runner.containers.values()]) {
      if (container.labels["com.docker.compose.project"] === project) {
        runner.containers.delete(container.id);
      }
    }
    const containers: { id: string; name: string; service: string; state: string }[] = [];
    for (const [service, definition] of Object.entries(user?.services ?? {})) {
      const extra = additions?.services?.[service] ?? {};
      const id = `${"f".repeat(4)}${String(next++).padStart(8, "0")}${"0".repeat(52)}`;
      const crash = state.crashing.get(service);
      const container: FakeContainer = {
        id,
        name: `${project}-${service}-1`,
        image: String(extra.image ?? definition.image ?? `${project}-${service}`),
        labels: {
          ...labelsOf(definition.labels),
          ...labelsOf(extra.labels),
          "com.docker.compose.project": project,
          "com.docker.compose.service": service,
          [NEARZERO_LABELS.managed]: "true",
        },
        env: {},
        state: crash === undefined ? "running" : "exited",
        exitCode: crash === undefined ? 0 : 1,
        startedAt: new Date().toISOString(),
        restartCount: 0,
        output: crash ?? `${service} is up\n`,
        ports: [],
        files: [],
        createdAt: Math.floor(Date.now() / 1000) + next,
      };
      const slow = state.slowHealth.get(service);
      if (slow) container.health = { startingUntil: Date.now() + slow.ms, after: slow.after };
      runner.containers.set(id, container);
      containers.push({ id, name: container.name, service, state: container.state });
      write(` Container ${container.name}  Started\n`);
    }
    return { ok: true, stage: null, message: null, touched: true, containers, notConnected: [] };
  });
  runner.extraHandlers.set("container.restart", async (params) => {
    const container = runner.containers.get(String(params.id));
    if (!container) throw Object.assign(new Error("No such container"), { code: "not_found" });
    container.state = "running";
    container.restartCount += 1;
    return {};
  });
  runner.extraHandlers.set("container.kill", async (params) => {
    const container = runner.containers.get(String(params.id));
    if (!container) throw Object.assign(new Error("No such container"), { code: "not_found" });
    if (container.state !== "running") {
      throw Object.assign(new Error("Container is not running"), { code: "conflict" });
    }
    container.state = "exited";
    container.exitCode = 137;
    return {};
  });
  return state;
}
