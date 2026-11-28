import { hostname } from "node:os";
import { PRODUCT_NAME, VERSION } from "@nearzero/shared";
import { AccessLogRuntime, attachAccessLog } from "./access-log/runtime.ts";
import { startLeftStopped } from "./backups/handlers.ts";
import { type RunnerConfig, readConfig } from "./config.ts";
import {
  checkCredential,
  enroll,
  readCredential,
  readHandoffToken,
  saveCredential,
} from "./credentials.ts";
import { DockerClient } from "./docker/client.ts";
import { attachDomains, DomainsRuntime, domainsSettings } from "./domains/runtime.ts";
import { type ControlLink, linkFetch } from "./link/link.ts";
import { createLog, type Log } from "./log.ts";
import { systemInfo } from "./metrics.ts";
import { Router } from "./router/router.ts";
import { RunnerSession } from "./session.ts";
import { runAs } from "./tasks/run-as.ts";

/**
 * The per-server runner (spec 25, D1 option C): it connects out to the control plane, carries out
 * work against the local Docker Engine, keeps the router and the private network running, writes
 * the router's files and reports state and metrics. docs/runner-protocol.md describes the link.
 */

const NAME = "nearzero-runner";

const USAGE = `${PRODUCT_NAME} runner ${VERSION}

Usage: ${NAME} [command]

Commands:
  run                          Connect to Nearzero and do this server's work (the service)
  join <control-url> [--fingerprint sha256:<hex>]
                               Join this server to Nearzero with a one-time join token, then run.
                               It asks for the token (or reads one line of standard input), so the
                               token never shows in a process list or the shell's history. It can
                               also come from NEARZERO_RUNNER_JOIN_TOKEN, or after the address.
                               The fingerprint, which the join command carries when Nearzero has no
                               domain, is the only certificate the runner accepts at that address.
  enroll [control-url]         Join with the one-time token in NEARZERO_RUNNER_JOIN_TOKEN, save the
                               credential, and exit (server setup uses this before starting the
                               service). The address can come from NEARZERO_CONTROL_URL.
  run-as --uid U --gid G --groups A,B --cwd DIR -- PROGRAM ARGS...
                               Run one program as another user (the runner starts a server's
                               tasks this way, as the user the server was set up with)
  version                      Print the version (the default)
  help                         Show this help

Settings (environment): NEARZERO_CONTROL_URL, NEARZERO_CONTROL_FINGERPRINT,
NEARZERO_CONTROL_FALLBACK_URL, NEARZERO_CONTROL_FALLBACK_FINGERPRINT, NEARZERO_RUNNER_STATE_DIR, NEARZERO_DOCKER_SOCKET,
NEARZERO_ROUTER_DIR, NEARZERO_ROUTER_HOST_DIR, NEARZERO_ROUTER_IMAGE, NEARZERO_ACME_EMAIL,
NEARZERO_HTTP_PORT, NEARZERO_HTTPS_PORT, NEARZERO_LOG_LEVEL, NEARZERO_DNS_DIR, NEARZERO_DNS_HOST_DIR,
NEARZERO_DNS_IMAGE, NEARZERO_DNS_BIND_ADDRESS, NEARZERO_DNS_PORT, NEARZERO_DNS_NETWORK,
NEARZERO_ACME_CA_SERVER, NEARZERO_ACME_CA_CERTIFICATES, NEARZERO_SERVER_USER (the user the server was set
up with, whom its tasks run as).`;

export function run(args: readonly string[]): number | Promise<number> {
  const command = args[0] ?? "version";
  switch (command) {
    case "version":
    case "--version":
    case "-v":
      console.log(`${NAME} ${VERSION}`);
      return 0;
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    case "run":
      return serve({});
    case "join":
      return join(args.slice(1));
    case "enroll":
      return enrollOnly(args[1]);
    case "run-as":
      return runAs(args.slice(1));
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

/** One line of standard input: the join token, asked for when standard input is a terminal. */
export async function readTokenLine(
  input: AsyncIterable<string> = console,
  prompt: (text: string) => void = (text) => process.stderr.write(text),
  interactive = Boolean(process.stdin.isTTY),
): Promise<string | null> {
  if (interactive) prompt("Paste the one-time join token from Nearzero, then press Enter: ");
  for await (const line of input) {
    const token = line.trim();
    if (token) return token;
  }
  return null;
}

/**
 * Joins with a one-time token, read from standard input unless given otherwise (B2-16: a token
 * on the command line shows in \`ps\`, the shell's history and sudo's log for its hour).
 */
export function joinArguments(
  args: readonly string[],
): { controlUrl?: string; token?: string; fingerprint?: string } | { problem: string } {
  const out: { controlUrl?: string; token?: string; fingerprint?: string } = {};
  const positional: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--fingerprint") {
      const value = args[++index];
      if (!value) return { problem: "--fingerprint needs the fingerprint after it." };
      out.fingerprint = value;
    } else if (arg.startsWith("--fingerprint=")) {
      const value = arg.slice("--fingerprint=".length);
      // An empty value would quietly turn a pinned join into a public-authority one (C4-04).
      if (!value.trim()) return { problem: "--fingerprint needs the fingerprint after it." };
      out.fingerprint = value;
    } else if (arg.startsWith("--")) {
      return { problem: `Unknown option ${arg}.` };
    } else {
      positional.push(arg);
    }
  }
  if (positional[0]) out.controlUrl = positional[0];
  if (positional[1]) out.token = positional[1];
  if (out.controlUrl && !/^https:\/\//i.test(out.controlUrl)) {
    // A server joins only over https:// (spec 31 "Remote runners are always encrypted", C4-04).
    return {
      problem: `${out.controlUrl} isn't an https:// address. A server joins Nearzero only over https://: copy the join command from the server's page again.`,
    };
  }
  return out;
}

async function join(args: readonly string[]): Promise<number> {
  const parsed = joinArguments(args);
  if ("problem" in parsed || !parsed.controlUrl) {
    console.error(
      `${"problem" in parsed ? `${parsed.problem}\n` : ""}Usage: ${NAME} join <control-url> [--fingerprint sha256:<hex>]\n\n${USAGE}`,
    );
    return 1;
  }
  const joinToken =
    parsed.token ?? process.env.NEARZERO_RUNNER_JOIN_TOKEN?.trim() ?? (await readTokenLine());
  if (!joinToken) {
    console.error("No join token was given. Run the join command again and paste the token.");
    return 1;
  }
  return serve({
    controlUrl: parsed.controlUrl,
    ...(parsed.fingerprint ? { controlFingerprint: parsed.fingerprint } : {}),
    joinToken,
    mustEnroll: true,
  });
}

function configuredLink(config: RunnerConfig): ControlLink {
  return { url: config.controlUrl, fingerprint: config.controlFingerprint };
}

/** The router folder as the Docker host sees it, found from the runner's own container. */
async function routerHostDirectory(config: RunnerConfig, docker: DockerClient): Promise<string> {
  if (config.router.hostDirectory) return config.router.hostDirectory;
  const self = await docker.findContainer(process.env.HOSTNAME ?? hostname()).catch(() => null);
  const mount = self?.Mounts.find((item) => item.Destination === config.router.directory);
  if (!mount) {
    throw new Error(
      `The runner runs in a container but ${config.router.directory} isn't mounted from the host. Mount the router folder there, or set NEARZERO_ROUTER_HOST_DIR to its path on the host.`,
    );
  }
  return mount.Source;
}

async function obtainCredential(
  config: RunnerConfig,
  docker: DockerClient,
  log: Log,
  tokens: { joinToken: string | null },
  link: ControlLink = configuredLink(config),
): Promise<string | null> {
  const token = tokens.joinToken ?? (await readHandoffToken(config.handoffDirectory));
  if (!token) return null;
  const system = await systemInfo(docker, config.containerized).catch(() => ({}));
  try {
    const enrolled = await enroll(link.url, token, system, linkFetch(link));
    await saveCredential(config.stateDirectory, enrolled.credential);
    log.info("joined Nearzero", { server: enrolled.serverName });
    return enrolled.credential;
  } catch (error) {
    log.error("couldn't join Nearzero", { reason: (error as Error).message });
    return null;
  } finally {
    // A given token is used once, whatever the outcome; later runs use the credential. The
    // host's handoff token is read again each time, since the control plane renews it.
    if (tokens.joinToken === token) tokens.joinToken = null;
  }
}

/**
 * Trades the one-time token for this runner's credential and exits: 0 when the credential is
 * saved, 1 with the reason otherwise. The token is read from the environment only, so it never
 * appears in a process list.
 */
async function enrollOnly(controlUrl: string | undefined): Promise<number> {
  const joinToken = process.env.NEARZERO_RUNNER_JOIN_TOKEN?.trim();
  if (!joinToken) {
    console.error(
      "Set NEARZERO_RUNNER_JOIN_TOKEN to the one-time join token, then run enroll again.",
    );
    return 1;
  }
  const loaded = readConfig(process.env, controlUrl ? { controlUrl, joinToken } : { joinToken });
  if (!loaded.ok) {
    console.error("The runner can't join because of its settings:");
    for (const problem of loaded.problems) console.error(`  - ${problem}`);
    return 1;
  }
  const config = loaded.config;
  const docker = new DockerClient({ socketPath: config.dockerSocket });
  const system = await systemInfo(docker, config.containerized).catch(() => ({}));
  try {
    const enrolled = await enroll(
      config.controlUrl,
      joinToken,
      system,
      linkFetch(configuredLink(config)),
    );
    await saveCredential(config.stateDirectory, enrolled.credential);
    console.log(`Joined Nearzero as "${enrolled.serverName}".`);
    return 0;
  } catch (error) {
    console.error(`This server couldn't join Nearzero: ${(error as Error).message}`);
    return 1;
  }
}

async function serve(options: {
  controlUrl?: string;
  controlFingerprint?: string;
  joinToken?: string;
  mustEnroll?: boolean;
}): Promise<number> {
  const loaded = readConfig(process.env, options);
  if (!loaded.ok) {
    console.error("The runner did not start because of its settings:");
    for (const problem of loaded.problems) console.error(`  - ${problem}`);
    return 1;
  }
  const config = loaded.config;
  const log = createLog(config.logLevel);
  log.info("starting", { version: VERSION, control: config.controlUrl });

  const docker = new DockerClient({ socketPath: config.dockerSocket });
  let hostDirectory: string;
  try {
    await docker.negotiate();
    hostDirectory = config.manageRouter
      ? await routerHostDirectory(config, docker)
      : config.router.directory;
  } catch (error) {
    console.error(`The runner did not start: ${(error as Error).message}`);
    return 1;
  }
  const domainSettings = domainsSettings(process.env, config.stateDirectory);
  const router = new Router(
    docker,
    {
      directory: config.router.directory,
      hostDirectory,
      image: config.router.image,
      acmeEmail: config.router.acmeEmail,
      httpPort: config.router.httpPort,
      httpsPort: config.router.httpsPort,
      network: config.network,
      acmeCaServer: domainSettings.acmeCaServer,
      acmeCaCertificates: domainSettings.acmeCaCertificates,
      containerized: config.containerized,
    },
    log,
  );
  // Certificates' back-off, uploaded certificates and the built-in DNS server (spec 10.7, 10.8).
  const domains = new DomainsRuntime({
    docker,
    router,
    log,
    settings: domainSettings,
    containerized: config.containerized,
  });
  attachDomains(router, domains);
  await domains.start();
  // The router's request log (spec 13.1): its saved setting applies before the router is checked.
  const accessLog = new AccessLogRuntime({
    router,
    docker,
    log,
    stateDirectory: config.stateDirectory,
  });
  await accessLog.load();
  attachAccessLog(router, accessLog);

  const tokens = { joinToken: config.joinToken };
  if (options.mustEnroll) {
    const credential = await obtainCredential(config, docker, log, tokens);
    if (!credential) {
      console.error(
        "This server couldn't join Nearzero with that token. Create a new join command on the server's page and run it again.",
      );
      return 1;
    }
  }

  let session: RunnerSession | null = null;
  session = new RunnerSession({
    controlUrl: config.controlUrl,
    controlFingerprint: config.controlFingerprint,
    controlFallback: config.controlFallback,
    allowPlain: config.allowPlain,
    stateDirectory: config.stateDirectory,
    credential: async () =>
      (await readCredential(config.stateDirectory)) ??
      (await obtainCredential(config, docker, log, tokens, session?.link)),
    onCredentialRefused: (_message, link) => obtainCredential(config, docker, log, tokens, link),
    check: (credential, link) => checkCredential(link.url, credential, linkFetch(link)),
    docker,
    router,
    manageRouter: config.manageRouter,
    log,
    workDirectory: config.workDirectory,
    dockerSocket: config.dockerSocket,
    containerized: config.containerized,
    buildersDir: config.buildersDir,
  });
  const running = session;
  const stop = () => {
    log.info("stopping");
    domains.stop();
    running.stop();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Containers a backup or restore stopped before this runner was last stopped (C2-02).
  const restarted = await startLeftStopped(docker, config.workDirectory, log).catch(() => []);
  if (restarted.length > 0) {
    log.info("started containers a backup had stopped", { containers: restarted.length });
  }
  await running.run();
  // Stopped commands clean up first (a backup starts what it stopped), within the stop grace.
  await running.drain(15_000);
  log.info("stopped");
  return 0;
}

if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}
