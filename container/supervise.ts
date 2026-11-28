/**
 * The production image's entry point. One container runs the control plane and the console
 * (spec 03, 3.1: "The Nearzero service (console and API), listening on 4321 and 3000").
 *
 * It starts both processes, passes stop signals on to them, and when either one exits it stops
 * the other and exits with the same code, so Docker's restart policy brings the pair back
 * together instead of leaving a console with no API behind it (or the other way round).
 */

import type { Subprocess } from "bun";

/** Ports inside the container. Host ports are chosen by the compose file. */
export const CONTROL_PORT = "3000";
export const CONSOLE_PORT = "4321";

/**
 * Bun would otherwise try to install missing packages at run time, writing a node_modules folder
 * into its working directory. Everything is bundled, and the app files are read-only.
 */
export const BUN_FLAGS = ["--no-install"] as const;

/** How long a stop waits for both processes before killing them. */
const STOP_GRACE_MS = 15_000;

export interface ProcessSpec {
  name: string;
  command: string[];
  env: Record<string, string>;
}

/** The two processes, with the settings each needs inside the container. */
export function processSpecs(
  appDir: string,
  bun: string,
  env: Record<string, string | undefined>,
): ProcessSpec[] {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) base[key] = value;
  return [
    {
      name: "control",
      command: [bun, ...BUN_FLAGS, `${appDir}/control/main.js`],
      env: {
        ...base,
        // Inside the container the API listens on every interface of the container's own
        // network; the compose file decides which host address publishes it.
        NEARZERO_CONTROL_PORT: CONTROL_PORT,
        NEARZERO_MANAGEMENT_BIND_ADDRESS: "0.0.0.0",
      },
    },
    {
      name: "console",
      command: [bun, ...BUN_FLAGS, `${appDir}/console/server/entry.mjs`],
      env: {
        ...base,
        HOST: "0.0.0.0",
        PORT: CONSOLE_PORT,
        // The console always calls the control plane in the same container (spec 22.4, rule 5).
        NEARZERO_CONTROL_URL: `http://127.0.0.1:${CONTROL_PORT}`,
      },
    },
  ];
}

function main(): void {
  const appDir = process.env.NEARZERO_APP_DIR ?? "/app";
  const specs = processSpecs(appDir, process.execPath, process.env);
  const children: Subprocess[] = specs.map((spec) =>
    Bun.spawn(spec.command, {
      env: spec.env,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
    }),
  );

  let exiting = false;
  const stopAll = (signal: NodeJS.Signals) => {
    for (const child of children) if (child.exitCode === null) child.kill(signal);
  };
  const finish = (code: number) => {
    if (exiting) return;
    exiting = true;
    stopAll("SIGTERM");
    const killTimer = setTimeout(() => stopAll("SIGKILL"), STOP_GRACE_MS);
    void Promise.all(children.map((child) => child.exited)).then(() => {
      clearTimeout(killTimer);
      process.exit(code);
    });
  };

  process.on("SIGTERM", () => finish(0));
  process.on("SIGINT", () => finish(0));
  children.forEach((child, index) => {
    void child.exited.then((code) => {
      if (exiting) return;
      const name = specs[index]?.name ?? "process";
      console.error(
        `nearzero: the ${name} process stopped (exit code ${code ?? "none"}), so the container stops too and Docker restarts it.`,
      );
      finish(code === 0 ? 1 : (code ?? 1));
    });
  });
}

if (import.meta.main) main();
