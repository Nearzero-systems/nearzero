import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ControlServices } from "../services.ts";
import { type SshConnector, ssh2Connector } from "./ssh.ts";

/**
 * Settings of server setup for one control-plane process: strict host key checking (an install
 * setting), where the compiled runners are, and the SSH client. main.ts sets them from the
 * configuration at start; tests set their own (a fake SSH client, shorter waits).
 */

export interface SetupSettings {
  /** NEARZERO_SSH_STRICT_HOST_KEY_CHECKING (spec 03 3.1, 9.2). */
  strictHostKeyChecking: boolean;
  /** Folder with nearzero-runner-linux-* and SHA256SUMS. */
  runnerBinariesDirectory: string;
  connector: SshConnector;
  /** The router image servers run; null leaves the runner's own pin. */
  routerImage: string | null;
  acmeEmail: string | null;
  /** More settings for servers' runners (tests: a private ACME server). */
  runnerEnvironment: Record<string, string>;
  /** How long step 9 waits for the runner to connect and its router to run. */
  runnerWaitMs: number;
  /** How long step 15 waits for the runner's first metrics. */
  metricsWaitMs: number;
}

const settings = new WeakMap<ControlServices, SetupSettings>();

/** The runners next to the app in the image, or runner/dist in a checkout. */
export function defaultRunnerBinariesDirectory(env = process.env): string {
  const appDir = env.NEARZERO_APP_DIR?.trim();
  if (appDir) {
    const inImage = join(appDir, "runner-binaries");
    if (existsSync(inImage)) return inImage;
  }
  return resolve(import.meta.dir, "..", "..", "..", "..", "runner", "dist");
}

export function configureServerSetup(
  services: ControlServices,
  overrides: Partial<SetupSettings>,
): SetupSettings {
  const next = { ...setupSettings(services), ...overrides };
  settings.set(services, next);
  return next;
}

export function setupSettings(services: ControlServices): SetupSettings {
  const known = settings.get(services);
  if (known) return known;
  const fallback: SetupSettings = {
    strictHostKeyChecking: false,
    runnerBinariesDirectory: defaultRunnerBinariesDirectory(),
    connector: ssh2Connector,
    routerImage: null,
    acmeEmail: services.domains.acmeEmail ?? null,
    runnerEnvironment: {},
    runnerWaitMs: 5 * 60_000,
    metricsWaitMs: 20_000,
  };
  settings.set(services, fallback);
  return fallback;
}

/** The builder image pins a runner reads (runner/src/builds/overrides.ts), each by digest. */
export const BUILDER_PIN_SETTINGS = [
  "NEARZERO_HEROKU_BUILDER_IMAGE",
  "NEARZERO_PAKETO_BUILDER_IMAGE",
  "NEARZERO_RAILPACK_FRONTEND_IMAGE",
  "NEARZERO_STATIC_NGINX_IMAGE",
] as const;

const PINNED_IMAGE = /^[a-z0-9][a-z0-9._/:-]*@sha256:[0-9a-f]{64}$/;
const IMAGE = /^[a-z0-9][a-z0-9._/:@-]{0,254}$/;

/**
 * The router image and builder pins given at install, for every server setup sets up (31d
 * G4-18): the control plane's settings (compose.yml gives it every line of .env, 0.1.x's
 * TRAEFIK_IMAGE included) go into each server's runner settings, as they go to the host's runner.
 * Servers set up before pick them up when setup runs again.
 */
export function serverRunnerPins(
  env: Record<string, string | undefined>,
): Pick<SetupSettings, "routerImage" | "runnerEnvironment"> {
  const routerImage = env.NEARZERO_ROUTER_IMAGE?.trim() ?? "";
  const runnerEnvironment: Record<string, string> = {};
  for (const name of BUILDER_PIN_SETTINGS) {
    const value = env[name]?.trim() ?? "";
    if (PINNED_IMAGE.test(value)) runnerEnvironment[name] = value;
  }
  return { routerImage: IMAGE.test(routerImage) ? routerImage : null, runnerEnvironment };
}
