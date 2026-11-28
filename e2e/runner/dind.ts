import { $ } from "bun";

/**
 * A throwaway Docker-in-Docker "server" for the runner suite (spec 26.3). Everything runs inside
 * it: the runner, its router on ports 80 and 443, and the containers it starts. Nothing is
 * published on the developer's machine, and the developer's own Docker, router and ports are
 * never touched. Named nz1-… and removed afterwards.
 */

export const DIND_IMAGE = "docker:28-dind";
export const PLATFORM =
  process.env.NZ1_E2E_PLATFORM ?? (process.arch === "arm64" ? "linux/arm64" : "linux/amd64");

/**
 * A container or image name for this run: "nz1-m3a-runner", or with NZ1_E2E_PREFIX=nz1-verify
 * "nz1-verify-m3a-runner", so two people (or a person and a harness) never share one.
 */
export function e2eName(name: string): string {
  const prefix = process.env.NZ1_E2E_PREFIX;
  return prefix ? name.replace(/^nz1-/, `${prefix}-`) : name;
}

export interface Result {
  code: number;
  out: string;
}

export class DindHost {
  readonly name: string;

  constructor(name: string) {
    this.name = e2eName(name);
  }

  async start(): Promise<void> {
    await this.remove();
    await $`docker run -d --privileged --name ${this.name} --platform ${PLATFORM} --shm-size 8g --label nz1-e2e=true -e DOCKER_TLS_CERTDIR= ${DIND_IMAGE}`.quiet();
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if ((await this.exec("docker info >/dev/null 2>&1")).code === 0) return;
      await Bun.sleep(1000);
    }
    throw new Error(`The Docker Engine inside ${this.name} didn't start.`);
  }

  async remove(): Promise<void> {
    await $`docker rm --force --volumes ${this.name}`.quiet().nothrow();
  }

  async exec(command: string, env: Record<string, string> = {}): Promise<Result> {
    const envFlags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    const child = Bun.spawn(["docker", "exec", ...envFlags, this.name, "sh", "-c", command], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code: await child.exited, out: out + err };
  }

  async must(command: string, env: Record<string, string> = {}): Promise<string> {
    const result = await this.exec(command, env);
    if (result.code !== 0)
      throw new Error(`"${command}" failed with ${result.code}:\n${result.out}`);
    return result.out;
  }

  /** Starts a long-running command inside the host, detached, with its output in a file. */
  async background(command: string, logFile: string, env: Record<string, string> = {}) {
    const envFlags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
    await $`docker exec -d ${envFlags} ${this.name} sh -c ${`${command} >${logFile} 2>&1`}`.quiet();
  }

  async copyIn(source: string, destination: string): Promise<void> {
    await $`docker cp ${source} ${this.name}:${destination}`.quiet();
  }
}

/** Waits until `check` returns a value, or fails with what it last saw. */
export async function eventually<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await Bun.sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${String(lastError)}` : ""}`);
}
