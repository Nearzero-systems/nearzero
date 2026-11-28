import { AppError, type CommandKind, type CommandParams, NEARZERO_LABELS } from "@nearzero/shared";
import { RunnerCommandError } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";

/**
 * What the deploy engine asks of one server's runner, in the engine's own words: commands that
 * honour a cancel signal, streaming commands whose output goes into a log, and the container
 * questions the pipeline, the runtime actions and teardown share.
 */

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  running: boolean;
  exitCode: number;
  startedAt: string;
  finishedAt: string | null;
  oomKilled: boolean;
  restartCount: number;
  health: string | null;
  labels: Record<string, string>;
}

export interface ContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  labels: Record<string, string>;
  createdAt: number;
}

/**
 * Work started before a control-plane restart that its server no longer has (it finished and
 * was forgotten, or the runner restarted too), so it can't be followed again (B2-20).
 */
export class NotResumable extends Error {
  constructor() {
    super("The server no longer has this work, so it can't be followed again.");
    this.name = "NotResumable";
  }
}

export class Cancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "Cancelled";
  }
}

export class ServerOps {
  readonly target: string;
  readonly #services: ControlServices;
  readonly #signal: AbortSignal;
  readonly #resume: boolean;

  /**
   * `resume`: this job's work was started before a control-plane restart; keyed streams follow
   * that work again and never start it (B2-20).
   */
  constructor(
    services: ControlServices,
    target: string,
    signal: AbortSignal,
    options: { resume?: boolean } = {},
  ) {
    this.#services = services;
    this.target = target;
    this.#signal = signal;
    this.#resume = options.resume ?? false;
  }

  checkCancelled(): void {
    if (this.#signal.aborted) throw new Cancelled();
  }

  async command<K extends CommandKind>(
    kind: K,
    params: CommandParams<K>,
    timeoutMs = 60_000,
  ): Promise<unknown> {
    this.checkCancelled();
    try {
      return await this.#services.runners.command(this.target, kind, params, {
        timeoutMs,
        signal: this.#signal,
      });
    } catch (error) {
      if (this.#signal.aborted) throw new Cancelled();
      throw error;
    }
  }

  /**
   * A streaming command whose output goes to `onOutput` as text. Cancelling stops it on the
   * runner (the build or fetch is killed there). With a `key` it is long work that goes on
   * while the control plane restarts (B2-20): the job follows it again afterwards with a
   * resuming ServerOps, which throws {@link NotResumable} when the server no longer has it.
   */
  async stream<K extends CommandKind>(
    kind: K,
    params: CommandParams<K>,
    onOutput: (text: string) => void,
    timeoutMs = 60 * 60_000,
    options: { key?: string } = {},
  ): Promise<unknown> {
    this.checkCancelled();
    const hub = this.#services.runners;
    let opened: Awaited<ReturnType<typeof hub.openStream>> | null;
    if (options.key && this.#resume) {
      opened = await hub.resumeStream(this.target, kind, options.key, { timeoutMs });
      if (!opened) throw new NotResumable();
    } else {
      opened = await hub.openStream(this.target, kind, params, {
        timeoutMs,
        ...(options.key ? { key: options.key } : {}),
      });
    }
    const { stream, done } = opened;
    const decoder = new TextDecoder();
    const unsubscribe = stream.subscribe((event) => {
      if (event.type === "output") onOutput(decoder.decode(event.bytes, { stream: true }));
      else if (event.type === "gap") {
        onOutput("\n… some output was lost while the server was unreachable …\n");
      }
    });
    const onAbort = () => hub.closeStream(stream.id);
    this.#signal.addEventListener("abort", onAbort, { once: true });
    try {
      return await done;
    } catch (error) {
      if (this.#signal.aborted) throw new Cancelled();
      throw error;
    } finally {
      this.#signal.removeEventListener("abort", onAbort);
      unsubscribe();
      const rest = decoder.decode();
      if (rest) onOutput(rest);
      hub.closeStream(stream.id);
    }
  }

  async inspect(id: string): Promise<ContainerInfo | null> {
    try {
      return (await this.command("container.inspect", { id })) as ContainerInfo;
    } catch (error) {
      if (error instanceof RunnerCommandError && error.runnerCode === "not_found") return null;
      throw error;
    }
  }

  /** The service's containers on this server, newest first. */
  async serviceContainers(serviceId: string): Promise<ContainerSummary[]> {
    const list = (await this.command("container.list", {
      all: true,
      labels: [`${NEARZERO_LABELS.service}=${serviceId}`],
    })) as ContainerSummary[];
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The last lines a container printed (for a failed start), or "" when there are none. */
  async lastOutput(id: string, lines = 100): Promise<string> {
    let text = "";
    try {
      await this.stream(
        "container.logs",
        { id, follow: false, tail: lines, timestamps: false },
        (chunk) => {
          text += chunk;
        },
        30_000,
      );
    } catch (error) {
      if (error instanceof Cancelled) throw error;
    }
    return text;
  }

  async stopAndRemove(id: string, timeoutSeconds = 10): Promise<void> {
    await this.command(
      "container.stop",
      { id, timeoutSeconds },
      (timeoutSeconds + 30) * 1000,
    ).catch((error: unknown) => {
      if (error instanceof Cancelled) throw error;
    });
    await this.command("container.remove", { id, force: true, volumes: true }).catch(
      (error: unknown) => {
        if (error instanceof RunnerCommandError && error.runnerCode === "not_found") return;
        throw error;
      },
    );
  }

  /** Runs a command inside a container and returns its exit code and output. */
  async execCapture(
    id: string,
    command: string[],
    options: { env?: Record<string, string>; timeoutSeconds?: number; secrets?: string[] } = {},
  ): Promise<{ exitCode: number | null; output: string }> {
    return (await this.command(
      "container.exec-capture",
      {
        id,
        command,
        env: options.env ?? {},
        timeoutSeconds: options.timeoutSeconds ?? 15,
        secrets: options.secrets ?? [],
      },
      ((options.timeoutSeconds ?? 15) + 20) * 1000,
    )) as { exitCode: number | null; output: string };
  }
}

/** A refusal the server gave, in its words, or the error's message. */
export function reasonOf(error: unknown): string {
  if (error instanceof AppError || error instanceof Error) return error.message;
  return String(error);
}
