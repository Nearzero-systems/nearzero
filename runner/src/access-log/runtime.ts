import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ACCESS_LOG_FILE,
  ACCESS_LOG_FOLDER,
  type AccessLogStatus,
  NEARZERO_LABELS,
  ROUTER_CONTAINER,
} from "@nearzero/shared";
import type { DockerClient } from "../docker/client.ts";
import type { Log } from "../log.ts";
import { writeFileAtomically } from "../router/files.ts";
import type { Router } from "../router/router.ts";
import { fileSize } from "./file.ts";

/**
 * The router's request log on this server (spec 13.1): whether it is on, kept in the runner's
 * state folder so the router comes back the same way after a restart, and where the file is.
 * The control plane turns it on for the Nearzero host (on by default); other servers' routers
 * don't log requests in 1.0. Turning it on or off recreates the router in the background.
 */

const SETTINGS_FILE = "access-log.json";

export class AccessLogRuntime {
  readonly #router: Router;
  readonly #docker: DockerClient;
  readonly #log: Log;
  readonly #stateDirectory: string;

  constructor(options: { router: Router; docker: DockerClient; log: Log; stateDirectory: string }) {
    this.#router = options.router;
    this.#docker = options.docker;
    this.#log = options.log;
    this.#stateDirectory = options.stateDirectory;
  }

  get path(): string {
    return join(this.#router.settings.directory, ACCESS_LOG_FOLDER, ACCESS_LOG_FILE);
  }

  /** Reads the saved setting before the router is first checked. */
  async load(): Promise<void> {
    const text = await readFile(join(this.#stateDirectory, SETTINGS_FILE), "utf8").catch(() => "");
    try {
      const saved = JSON.parse(text) as { enabled?: unknown };
      this.#router.accessLogEnabled = saved.enabled === true;
    } catch {
      this.#router.accessLogEnabled = false;
    }
  }

  /** Saves the setting and, when it changed, recreates the router in the background. */
  async configure(enabled: boolean): Promise<{ enabled: boolean; changed: boolean }> {
    const changed = this.#router.accessLogEnabled !== enabled;
    await mkdir(this.#stateDirectory, { recursive: true, mode: 0o700 });
    await writeFileAtomically(
      join(this.#stateDirectory, SETTINGS_FILE),
      `${JSON.stringify({ enabled })}\n`,
      0o600,
    );
    this.#router.accessLogEnabled = enabled;
    if (changed) {
      this.#log.info(enabled ? "turning the request log on" : "turning the request log off");
      void this.#router.ensure().catch((error: unknown) =>
        this.#log.warn("the router didn't restart with the new request log setting", {
          reason: (error as Error).message,
        }),
      );
    }
    return { enabled, changed };
  }

  async status(): Promise<AccessLogStatus> {
    const size = await fileSize(this.path);
    const wanted = await this.#router.desiredContainer().catch(() => null);
    const current = await this.#docker.findContainer(ROUTER_CONTAINER).catch(() => null);
    const applied =
      wanted !== null &&
      current?.State.Running === true &&
      current.Config.Labels?.[NEARZERO_LABELS.routerConfig] === wanted.fingerprint;
    return {
      enabled: this.#router.accessLogEnabled,
      applied,
      exists: size !== null,
      sizeBytes: size ?? 0,
    };
  }
}

const runtimes = new WeakMap<Router, AccessLogRuntime>();

export function attachAccessLog(router: Router, runtime: AccessLogRuntime): void {
  runtimes.set(router, runtime);
}

export function accessLogFor(router: Router): AccessLogRuntime | null {
  return runtimes.get(router) ?? null;
}
