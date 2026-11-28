/**
 * The one way the runner starts other programs (docker compose, docker buildx, later rclone and
 * the builders). The rules that keep it safe (spec 23.1):
 *
 * - Arguments are an array handed to the program as they are. Nothing goes through a shell, so
 *   no value is ever interpreted as shell syntax.
 * - Standard input is closed (the program reads end-of-file) unless input is given, so a step
 *   can never swallow the steps after it.
 * - Every run has a timeout; the program is stopped (TERM, then KILL) when it runs over.
 * - Secret values are cut out of everything the program prints before anyone sees it, even when
 *   a secret arrives split across two pieces of output.
 * - The program gets a small environment (PATH, HOME, LANG and what the caller passes), never the
 *   runner's own, which holds its credential.
 */

export const REDACTED = "[redacted]";

/** How long a program gets to stop after TERM before it is killed. */
const KILL_AFTER_MS = 5_000;
/** The end of the output kept for the result (and for error messages). */
const TAIL_BYTES = 64 * 1024;

export interface CommandSpec {
  /** The program and its arguments. The program is looked up on PATH when it has no slash. */
  argv: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Given input; without it the program's standard input is closed. */
  stdin?: string | Uint8Array;
  timeoutMs: number;
  secrets?: readonly string[];
  onOutput?: (text: string, stream: "stdout" | "stderr") => void;
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number | null;
  /** True when the program ran over its timeout and was stopped. */
  timedOut: boolean;
  /** True when the caller cancelled it. */
  cancelled: boolean;
  /** The last part of what it printed, secrets removed. */
  output: string;
}

/**
 * Cuts secrets out of text that arrives in pieces. The last (longest secret − 1) characters are
 * held back until more text arrives or the stream ends, so a secret split across pieces is still
 * found whole.
 */
export class Redactor {
  readonly #secrets: string[];
  readonly #holdBack: number;
  #pending = "";

  constructor(secrets: readonly string[]) {
    // Longest first, so a secret that contains another is cut out whole.
    this.#secrets = [...new Set(secrets.filter((secret) => secret.trim() !== ""))].sort(
      (a, b) => b.length - a.length,
    );
    this.#holdBack = this.#secrets.length === 0 ? 0 : (this.#secrets[0]?.length ?? 1) - 1;
  }

  push(text: string): string {
    if (this.#secrets.length === 0) return text;
    const all = this.#pending + text;
    let cut = Math.max(0, all.length - this.#holdBack);
    // A secret that is complete but crosses the cut goes out whole (redacted) now.
    for (const secret of this.#secrets) {
      let from = Math.max(0, cut - secret.length + 1);
      for (;;) {
        const at = all.indexOf(secret, from);
        if (at < 0 || at >= cut) break;
        if (at + secret.length > cut) cut = at + secret.length;
        from = at + 1;
      }
    }
    this.#pending = all.slice(cut);
    return this.#replace(all.slice(0, cut));
  }

  flush(): string {
    const rest = this.#replace(this.#pending);
    this.#pending = "";
    return rest;
  }

  #replace(text: string): string {
    let out = text;
    for (const secret of this.#secrets) out = out.split(secret).join(REDACTED);
    return out;
  }
}

/** Removes secrets from a finished piece of text. */
export function redact(text: string, secrets: readonly string[]): string {
  const redactor = new Redactor(secrets);
  return redactor.push(text) + redactor.flush();
}

function baseEnvironment(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/root",
    LANG: "C.UTF-8",
  };
}

export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  if (spec.argv.length === 0 || !spec.argv[0]) throw new Error("A command needs a program.");
  if (!(spec.timeoutMs > 0)) throw new Error("A command needs a timeout.");
  const secrets = spec.secrets ?? [];
  let tail = "";
  const keep = (text: string) => {
    tail = (tail + text).slice(-TAIL_BYTES);
  };

  const child = Bun.spawn([...spec.argv], {
    ...(spec.cwd ? { cwd: spec.cwd } : {}),
    env: { ...baseEnvironment(), ...spec.env },
    stdin: spec.stdin === undefined ? "ignore" : new Blob([spec.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let cancelled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_AFTER_MS);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, spec.timeoutMs);
  const onAbort = () => {
    cancelled = true;
    stop();
  };
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  if (spec.signal?.aborted) onAbort();

  const pump = async (stream: ReadableStream<Uint8Array>, name: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    const redactor = new Redactor(secrets);
    const emit = (text: string) => {
      if (text === "") return;
      keep(text);
      spec.onOutput?.(text, name);
    };
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      emit(redactor.push(decoder.decode(chunk, { stream: true })));
    }
    emit(redactor.push(decoder.decode()));
    emit(redactor.flush());
  };

  try {
    await Promise.all([pump(child.stdout, "stdout"), pump(child.stderr, "stderr")]);
    const exitCode = await child.exited;
    return {
      exitCode: timedOut || cancelled ? null : exitCode,
      timedOut,
      cancelled,
      output: tail,
    };
  } finally {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
    spec.signal?.removeEventListener("abort", onAbort);
  }
}
