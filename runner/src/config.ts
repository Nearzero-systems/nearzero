import { accessSync, constants, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BUILDERS_DIR } from "../tools/pins.ts";
import {
  type ControlLink,
  isHostInternalLink,
  normalizeFingerprint,
  remoteLinkProblem,
} from "./link/link.ts";

/**
 * The runner's settings, from its environment (a systemd unit on servers, the compose file on the
 * Nearzero host). Every problem is reported at once, in words that name the setting.
 */

export interface RunnerConfig {
  /** The control plane's address, like https://nearzero.example.com or http://nearzero-control:3000. */
  controlUrl: string;
  /**
   * SHA-256 of the control plane's own certificate at that address (NEARZERO_CONTROL_FINGERPRINT),
   * for an install without a domain: only that certificate is accepted. Null otherwise.
   */
  controlFingerprint: string | null;
  /**
   * The control plane's own TLS port with its certificate's fingerprint
   * (NEARZERO_CONTROL_FALLBACK_URL, NEARZERO_CONTROL_FALLBACK_FINGERPRINT), tried when the address
   * above stops answering (C4-06). Setup writes it when it gives the domain. Null otherwise.
   */
  controlFallback: ControlLink | null;
  /**
   * True only for the Nearzero host's own runner, on the host's private network
   * (`http://nearzero-control:3000` with a hand-off folder). Every other runner refuses a plain
   * http:// address (spec 31 "Remote runners are always encrypted").
   */
  allowPlain: boolean;
  /** Holds the credential (root-only). */
  stateDirectory: string;
  /** The Nearzero host only: where the control plane leaves a one-time join token at start. */
  handoffDirectory: string | null;
  /** A one-time join token given to this run (the join command). */
  joinToken: string | null;
  dockerSocket: string;
  workDirectory: string;
  /** Where the pinned builder tools live (runner/tools/pins.ts). */
  buildersDir: string;
  containerized: boolean;
  /** When false the runner leaves the router alone (tests). */
  manageRouter: boolean;
  router: {
    directory: string;
    /** As the Docker host sees the folder; found from the runner's own container when unset. */
    hostDirectory: string | null;
    image: string;
    acmeEmail: string;
    httpPort: number;
    httpsPort: number;
  };
  network: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

export const DEFAULT_ROUTER_IMAGE = "traefik:v3.7.18";

export type ConfigResult = { ok: true; config: RunnerConfig } | { ok: false; problems: string[] };

/** A folder that is there and that this process can read (the host's hand-off folder). */
function readableFolder(path: string | null): boolean {
  if (!path) return false;
  try {
    accessSync(path, constants.R_OK | constants.X_OK);
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function text(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === "" ? undefined : value;
}

export function readConfig(
  env: Record<string, string | undefined>,
  overrides: { controlUrl?: string; controlFingerprint?: string; joinToken?: string } = {},
): ConfigResult {
  const problems: string[] = [];
  const controlUrl = overrides.controlUrl ?? text(env, "NEARZERO_CONTROL_URL");
  let normalizedUrl = "";
  if (!controlUrl) {
    problems.push(
      "NEARZERO_CONTROL_URL is not set. Set it to the control plane's address, like https://nearzero.example.com.",
    );
  } else {
    try {
      const url = new URL(controlUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
      normalizedUrl = url.origin;
    } catch {
      problems.push(
        `NEARZERO_CONTROL_URL must be an http:// or https:// address; it is "${controlUrl}".`,
      );
    }
  }
  const fingerprintText = overrides.controlFingerprint ?? text(env, "NEARZERO_CONTROL_FINGERPRINT");
  const controlFingerprint = normalizeFingerprint(fingerprintText);
  if (fingerprintText && !controlFingerprint) {
    problems.push(
      `NEARZERO_CONTROL_FINGERPRINT must be a SHA-256 fingerprint (64 hexadecimal digits, like sha256:3f2a…); it is "${fingerprintText}".`,
    );
  } else if (controlFingerprint && normalizedUrl && !normalizedUrl.startsWith("https:")) {
    problems.push(
      "NEARZERO_CONTROL_FINGERPRINT goes only with an https:// NEARZERO_CONTROL_URL: a fingerprint checks Nearzero's certificate, and http:// has none.",
    );
  }
  const handoffDirectory = text(env, "NEARZERO_RUNNER_HANDOFF_DIR") ?? null;
  // Setup writes "false" on servers, which wins over guessing from /.dockerenv (a server may
  // itself be a container, like the test servers of the setup suite).
  const containerizedSetting = text(env, "NEARZERO_RUNNER_CONTAINERIZED");
  const containerized =
    containerizedSetting === "true" ||
    (containerizedSetting !== "false" && existsSync("/.dockerenv"));
  let allowPlain = false;
  if (normalizedUrl && (!fingerprintText || controlFingerprint)) {
    const link = { url: normalizedUrl, fingerprint: controlFingerprint };
    // Plain HTTP only on the Nearzero host itself (C4-16): its runner runs in a container
    // (NEARZERO_RUNNER_CONTAINERIZED=true), reads the hand-off folder the control plane shares
    // with it, and reaches the control plane's container by name on the host's private network.
    // No remote runner connects without encryption, or to an IP address without the pinned
    // certificate (C4-02, C4-03, C4-04).
    if (
      isHostInternalLink(link) &&
      containerizedSetting === "true" &&
      readableFolder(handoffDirectory)
    ) {
      allowPlain = true;
    } else {
      const problem = remoteLinkProblem(link);
      if (problem) {
        problems.push(
          `NEARZERO_CONTROL_URL: ${problem}${isHostInternalLink(link) ? " (Only the Nearzero host's own runner, in its container with NEARZERO_RUNNER_CONTAINERIZED=true and a readable NEARZERO_RUNNER_HANDOFF_DIR, uses its private address.)" : ""}`,
        );
      }
    }
  }
  // The pinned fallback belongs to the configured control plane; a join to another address
  // doesn't take it (the welcome there gives that one's).
  const envUrl = text(env, "NEARZERO_CONTROL_URL");
  const sameControl = !overrides.controlUrl || overrides.controlUrl === envUrl;
  const fallbackUrl = sameControl ? text(env, "NEARZERO_CONTROL_FALLBACK_URL") : undefined;
  const fallbackFingerprintText = sameControl
    ? text(env, "NEARZERO_CONTROL_FALLBACK_FINGERPRINT")
    : undefined;
  let controlFallback: ControlLink | null = null;
  if (fallbackUrl || fallbackFingerprintText) {
    const fingerprint = normalizeFingerprint(fallbackFingerprintText);
    let origin = "";
    try {
      const url = new URL(fallbackUrl ?? "");
      if (url.protocol === "https:") origin = url.origin;
    } catch {
      // Reported below.
    }
    if (!origin || !fingerprint) {
      problems.push(
        "NEARZERO_CONTROL_FALLBACK_URL and NEARZERO_CONTROL_FALLBACK_FINGERPRINT go together: an https:// address and its certificate's SHA-256 fingerprint (64 hexadecimal digits). Run setup again on the server to write them.",
      );
    } else {
      controlFallback = { url: origin, fingerprint };
    }
  }
  const port = (name: string, fallback: number) => {
    const value = text(env, name);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!/^\d+$/.test(value) || parsed < 1 || parsed > 65535) {
      problems.push(`${name} must be a port from 1 to 65535; it is "${value}".`);
      return fallback;
    }
    return parsed;
  };
  const level = text(env, "NEARZERO_LOG_LEVEL") ?? "info";
  if (!["debug", "info", "warn", "error"].includes(level)) {
    problems.push(`NEARZERO_LOG_LEVEL must be debug, info, warn or error; it is "${level}".`);
  }
  const stateDirectory = text(env, "NEARZERO_RUNNER_STATE_DIR") ?? "/var/lib/nearzero-runner";
  const routerDirectory = text(env, "NEARZERO_ROUTER_DIR") ?? "/etc/nearzero/router";
  const config: RunnerConfig = {
    controlUrl: normalizedUrl,
    controlFingerprint,
    controlFallback,
    allowPlain,
    stateDirectory,
    handoffDirectory,
    joinToken: overrides.joinToken ?? text(env, "NEARZERO_RUNNER_JOIN_TOKEN") ?? null,
    dockerSocket: text(env, "NEARZERO_DOCKER_SOCKET") ?? "/var/run/docker.sock",
    workDirectory: text(env, "NEARZERO_RUNNER_WORK_DIR") ?? join(stateDirectory, "work"),
    buildersDir: text(env, "NEARZERO_BUILDERS_DIR") ?? DEFAULT_BUILDERS_DIR,
    containerized,
    manageRouter: text(env, "NEARZERO_ROUTER_MANAGED") !== "false",
    router: {
      directory: routerDirectory,
      hostDirectory:
        text(env, "NEARZERO_ROUTER_HOST_DIR") ?? (containerized ? null : routerDirectory),
      image: text(env, "NEARZERO_ROUTER_IMAGE") ?? DEFAULT_ROUTER_IMAGE,
      acmeEmail: text(env, "NEARZERO_ACME_EMAIL") ?? "",
      httpPort: port("NEARZERO_HTTP_PORT", 80),
      httpsPort: port("NEARZERO_HTTPS_PORT", 443),
    },
    network: text(env, "NEARZERO_NETWORK") ?? "nearzero-edge",
    logLevel: level as RunnerConfig["logLevel"],
  };
  return problems.length > 0 ? { ok: false, problems } : { ok: true, config };
}
