import { $, type Subprocess } from "bun";

/**
 * A throwaway Docker-in-Docker "server" for the install suite (spec 26.3): the real install.sh
 * runs inside it as it would on a fresh machine, with an image registry of its own so release
 * images can be pulled without publishing anything. Everything here is named nz1-… and is
 * removed afterwards; the developer's own containers, router and ports are never touched.
 */

/** The host's container name; NZ1_E2E_HOST lets parallel work use a name of its own. */
export const HOST = process.env.NZ1_E2E_HOST ?? "nz1-e2e-host";
/** The host's architecture: arm64 on Apple silicon, amd64 on most CI runners. */
export const PLATFORM =
  process.env.NZ1_E2E_PLATFORM ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");
export const DIND_IMAGE = "docker:28-dind";
export const REGISTRY_IMAGE = "registry:2.8.3";

export interface Result {
  code: number;
  out: string;
}

/** Strips terminal control sequences and carriage returns, so output reads as plain lines. */
export function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
}

/** Runs a shell command inside the host, with optional standard input. */
export async function inHost(
  command: string,
  options: { stdin?: string; env?: Record<string, string>; user?: string } = {},
): Promise<Result> {
  const envFlags = Object.entries(options.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
  const userFlags = options.user ? ["--user", options.user] : [];
  const child = Bun.spawn(
    ["docker", "exec", "-i", ...userFlags, ...envFlags, HOST, "sh", "-c", command],
    {
      stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out: plain(out + err) };
}

/** Like inHost, but fails the test with the output when the command fails. */
export async function mustInHost(command: string, options?: Parameters<typeof inHost>[1]) {
  const result = await inHost(command, options);
  if (result.code !== 0) {
    throw new Error(`"${command}" failed with ${result.code}:\n${result.out}`);
  }
  return result.out;
}

/**
 * A command running in a pseudo-terminal inside the host (through `script`), so install.sh sees
 * a real terminal. Answers are typed only after the expected prompt has appeared.
 */
export class TerminalSession {
  readonly #child: Subprocess<"pipe", "pipe", "pipe">;
  #raw = "";
  #cursor = 0;
  readonly #done: Promise<number>;

  constructor(command: string, env: Record<string, string> = {}) {
    const envFlags = Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    this.#child = Bun.spawn(
      ["docker", "exec", "-i", ...envFlags, HOST, "script", "-qfec", command, "/dev/null"],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    const pump = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) this.#raw += decoder.decode(chunk, { stream: true });
    };
    this.#done = Promise.all([pump(this.#child.stdout), pump(this.#child.stderr)]).then(
      () => this.#child.exited,
    );
  }

  get output(): string {
    return plain(this.#raw);
  }

  /** Waits for text to appear after everything already matched. */
  async expect(text: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.output.indexOf(text, this.#cursor);
      if (index >= 0) {
        this.#cursor = index + text.length;
        return;
      }
      if (this.#child.exitCode !== null) break;
      await Bun.sleep(100);
    }
    throw new Error(`Never saw "${text}". Output so far:\n${this.output}`);
  }

  /** Types a line, as a person pressing Enter at the end. */
  type(line: string): void {
    this.#child.stdin.write(`${line}\r`);
    this.#child.stdin.flush();
  }

  async exit(timeoutMs = 600_000): Promise<number> {
    const timer = setTimeout(() => this.#child.kill(), timeoutMs);
    try {
      return await this.#done;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function removeHost(): Promise<void> {
  await $`docker rm --force --volumes ${HOST}`.quiet().nothrow();
}

/** Starts the host and waits for its Docker Engine. */
export async function startHost(): Promise<void> {
  await removeHost();
  await $`docker run -d --privileged --name ${HOST} --platform ${PLATFORM} --label nz1-e2e=true -e DOCKER_TLS_CERTDIR= ${DIND_IMAGE}`.quiet();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if ((await inHost("docker info >/dev/null 2>&1")).code === 0) return;
    await Bun.sleep(1000);
  }
  throw new Error(`The Docker Engine inside ${HOST} didn't start.`);
}

/** Copies one local image into the host's registry and removes the host's local copy. */
export async function pushToHostRegistry(localImage: string, reference: string): Promise<void> {
  const save = Bun.spawn(["docker", "save", localImage], { stdout: "pipe" });
  const load = Bun.spawn(["docker", "exec", "-i", HOST, "docker", "load", "-q"], {
    stdin: save.stdout,
    stdout: "pipe",
    stderr: "pipe",
  });
  if ((await load.exited) !== 0 || (await save.exited) !== 0) {
    throw new Error(
      `Loading ${localImage} into ${HOST} failed: ${await new Response(load.stderr).text()}`,
    );
  }
  await mustInHost(
    `docker tag ${localImage} ${reference} && docker push -q ${reference} >/dev/null && docker image rm ${localImage} ${reference} >/dev/null`,
  );
}
