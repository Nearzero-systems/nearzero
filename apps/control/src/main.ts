import { hostname } from "node:os";
import { resolve } from "node:path";
import {
  IGNORED_LEGACY_SETTINGS,
  ignoredLegacySettings,
  VERSION,
  withLegacySettingNames,
} from "@nearzero/shared";
import { startAgentBackground } from "./agent/restart.ts";
import {
  agentSettingsFromEnv,
  configureAgent,
  ignoredLegacyAgentSettings,
} from "./agent/settings.ts";
import { createApp } from "./app.ts";
import { recordAudit } from "./audit/audit.ts";
import { loadConfig } from "./config.ts";
import { createDatabase } from "./db/database.ts";
import { MigrationError } from "./db/migrate.ts";
import {
  DatabaseRefusedError,
  DatabaseWaitError,
  migrateWhenReachable,
  surviveDatabaseOutages,
} from "./db/resilience.ts";
import { startDomainsBackground } from "./domains/background.ts";
import { createJobCatalog } from "./jobs/catalog.ts";
import { JobQueue } from "./jobs/queue.ts";
import { controlSchedules, startScheduleKeeper } from "./jobs/schedules.ts";
import { markSchedulesStarted } from "./jobs/started.ts";
import { JobWorker } from "./jobs/worker.ts";
import { createLogger } from "./log.ts";
import { startNotificationDispatcher } from "./notifications/dispatcher.ts";
import { recordStart, recordStop } from "./notifications/emit.ts";
import { prepareHostHandoff } from "./runners/host.ts";
import {
  ensureLinkCertificate,
  nextPinToAnnounce,
  prunePreviousLinkCertificate,
  readLinkCertificate,
} from "./runners/link-certificate.ts";
import { serveRunnerLink } from "./runners/link-paths.ts";
import { socketServer, upgraderFor } from "./runners/sockets.ts";
import { configureServerSetup, serverRunnerPins } from "./server-setup/settings.ts";
import { MAX_REQUEST_BODY_BYTES } from "./service-runtime/routes.ts";
import { createServices } from "./services.ts";

/**
 * Starts the control plane: check settings, update the database, start the job worker, then
 * serve the API. Any problem before serving stops the start with a message that says what to fix.
 */

/** Both src/main.ts and the built dist/main.js sit one level below the migrations folder. */
const MIGRATIONS_DIR = resolve(import.meta.dir, "..", "migrations");

/** Streams (logs, the Agent) send a keep-alive at least every 15 seconds (spec 23.2). */
const IDLE_TIMEOUT_SECONDS = 120;

/** How long a stop waits for open requests before closing them. */
const SHUTDOWN_DRAIN_MS = 10_000;

function refuseToStart(lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

async function main(): Promise<void> {
  const loaded = loadConfig(process.env);
  if (!loaded.ok) {
    refuseToStart([
      "Nearzero did not start because of its settings:",
      ...loaded.problems.map((problem) => `  - ${problem}`),
    ]);
  }
  const config = loaded.config;
  const log = createLogger({
    level: config.logLevel,
    fields: { service: "control", version: VERSION },
  });
  log.info("starting", { mode: config.mode });
  if (config.instanceEmailProblem) {
    // Half-made server email never stops the start (30a R1-04); the Members page shows it too.
    log.warn("this server's email settings can't be used", {
      problem: config.instanceEmailProblem,
    });
  }
  if (config.authSecretIsTemporary) {
    log.warn(
      "NEARZERO_AUTH_SECRET is not set, so a temporary one is in use and sign-ins end when this process stops. Production always needs a generated secret.",
    );
  }

  // PostgreSQL restarting mid-run is an outage to wait out, not a reason to stop (spec 23.2):
  // broken connections are reported and replaced, and a start waits for the database to answer.
  surviveDatabaseOutages(log);
  const db = createDatabase(config.databaseUrl, {
    onConnectionError: (error) =>
      log.warn("lost a database connection; it reopens when needed", { reason: error.message }),
  });
  try {
    const { applied } = await migrateWhenReachable(
      db,
      { directory: MIGRATIONS_DIR, log },
      { waitMs: config.databaseWaitSeconds * 1000, log },
    );
    log.info("database is up to date", { appliedNow: applied.length });
  } catch (error) {
    await db.destroy().catch(() => {});
    const message =
      error instanceof MigrationError ||
      error instanceof DatabaseWaitError ||
      error instanceof DatabaseRefusedError
        ? error.message
        : `Nearzero can't reach its database: ${(error as Error).message}. Check DATABASE_URL and that PostgreSQL is running.`;
    log.error("start refused", { reason: message });
    refuseToStart([`Nearzero did not start: ${message}`]);
  }

  // The runner link's own certificate, made once and kept (spec 31 "Remote runners are always
  // encrypted"): servers without a domain to reach pin its fingerprint.
  let linkCertificate: Awaited<ReturnType<typeof ensureLinkCertificate>> | null = null;
  if (config.runner.link) {
    try {
      linkCertificate = await ensureLinkCertificate(
        config.runner.link.tlsDirectory,
        config.publicIp ? [config.publicIp] : [],
      );
      if (linkCertificate.created) {
        log.info(
          linkCertificate.replaced
            ? "made the runner link's certificate again: a key was there without its certificate (an interrupted first start), which no server can have pinned"
            : "made the runner link's certificate",
          { fingerprint: linkCertificate.fingerprint },
        );
      }
    } catch (error) {
      log.error("the runner link's encrypted port is off", { reason: (error as Error).message });
    }
  }
  const ignoredLegacy = ignoredLegacySettings(process.env);
  if (ignoredLegacy.length > 0) {
    // 0.1.x settings 1.0 has nothing for (31d G4-19): said once, with why.
    log.warn(
      ignoredLegacy
        .map(
          (name) =>
            `${name} is a 0.1.x setting that Nearzero 1.0 ignores: ${IGNORED_LEGACY_SETTINGS[name as keyof typeof IGNORED_LEGACY_SETTINGS]}.`,
        )
        .join(" "),
      { settings: ignoredLegacy },
    );
  }
  if (config.runner.ignoredControlUrl) {
    log.warn(
      config.runner.ignoredControlUrl.startsWith("https:")
        ? "NEARZERO_RUNNER_CONTROL_URL is an IP address, which a server can check only with Nearzero's certificate fingerprint, so it is ignored. Set an https:// host name, or leave it out and servers use Nearzero's own encrypted port with its fingerprint."
        : "NEARZERO_RUNNER_CONTROL_URL is a plain http:// address, which Nearzero never gives servers, so it is ignored. Set an https:// address, or leave it out and Nearzero chooses an encrypted one.",
    );
  }

  const workerId = `${hostname()}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
  const queue = new JobQueue(db, { workerId });

  const services = createServices({
    db,
    log,
    authSecret: config.authSecret,
    consoleUrl: config.consoleUrl,
    trustedProxies: config.trustedProxies,
    trustedOrigins: config.legacySettings?.trustedOrigins ?? [],
    instanceEmail: config.instanceEmail,
    instanceEmailProblem: config.instanceEmailProblem ?? null,
    // Only an https:// address set outright; otherwise runners/link.ts chooses one.
    runnerControlUrl: config.runner.controlUrl,
    runnerLinkPort:
      linkCertificate && config.runner.link
        ? { port: config.runner.link.port, fingerprint: linkCertificate.fingerprint }
        : null,
    publicIp: config.publicIp,
    hostPublicIPv4: config.publicIp && !config.publicIp.includes(":") ? config.publicIp : null,
    domains: config.domains,
    buildsPerServer: config.jobs.buildsPerServer,
  });
  // Setting servers up over SSH (spec 9.3): strict host keys and where the runners are.
  configureServerSetup(services, {
    // The router image and builder pins given at install reach every server (G4-18).
    ...serverRunnerPins(withLegacySettingNames(process.env)),
    strictHostKeyChecking: config.ssh.strictHostKeyChecking,
    ...(config.ssh.runnerBinariesDirectory
      ? { runnerBinariesDirectory: config.ssh.runnerBinariesDirectory }
      : {}),
  });
  // The Agent's install settings, and its sweep: turns left behind by a restart are marked
  // stopped, and questions waiting for a model key are answered once one is saved (spec 19.6).
  configureAgent(services, agentSettingsFromEnv(process.env));
  const ignoredAgent = ignoredLegacyAgentSettings(process.env);
  if (ignoredAgent.length > 0) {
    // 0.1.x Agent settings 1.0 has nothing for (30d R4-09): said once, so nobody relies on them.
    log.warn(
      `${ignoredAgent.join(", ")} ${ignoredAgent.length === 1 ? "is a 0.1.x Agent setting" : "are 0.1.x Agent settings"} that Nearzero 1.0 ignores.`,
      { settings: ignoredAgent },
    );
  }
  const agent = startAgentBackground(services);
  // Hostname checks, certificate reports and managed DNS (spec 10.7, 10.8).
  const domains = await startDomainsBackground(services);
  // Due times that passed while the control plane was stopped are skipped from here on, not
  // run at start (spec 30, R3-30).
  markSchedulesStarted(db);
  // Jobs start once the services they use exist (deploys and deletes talk to runners).
  const worker = new JobWorker({
    db,
    queue,
    definitions: createJobCatalog(services),
    log: log.child({ component: "jobs" }),
    // Long work, deploys and scheduler ticks each have their own lanes (R2-15, R4-03).
    concurrency: config.jobs.concurrency,
    deployConcurrency: config.jobs.deployConcurrency,
    pollIntervalMs: config.jobs.pollIntervalMs,
  });
  worker.start();
  // Every schedule (tasks, backups, the Docker cleanup, the request log's cleanup and the daily
  // and hourly clean-ups) is a job chain the keeper checks now and every few minutes, so none
  // depends on a restart to run again (spec 23.2, B1-13).
  const keeper = startScheduleKeeper(
    db,
    log.child({ component: "schedules" }),
    controlSchedules({
      ...(config.legacySettings?.metricsRetentionDays
        ? { metricsRetentionDays: config.legacySettings.metricsRetentionDays }
        : {}),
    }),
  );
  await keeper.first;
  // Notification channels get the outbox's events; "Nearzero restart" when this start follows
  // an earlier one (spec 15.3).
  const notifications = startNotificationDispatcher(services);
  const startId = await recordStart(db, log);
  // The host's runner enrolls itself with the token left here (compose.yml shares the folder).
  if (config.runner.handoffDirectory) {
    await prepareHostHandoff(db, config.runner.handoffDirectory, log).catch((error: unknown) =>
      log.warn("couldn't leave a join token for the host's runner", { error }),
    );
  }
  const app = createApp({ db, log, services });
  const server = Bun.serve({
    hostname: config.http.hostname,
    port: config.http.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    // App archives are uploaded whole (up to 200 MB, spec 6.3); every other route keeps its own
    // smaller limit in app.ts. Bun's default (128 MB) would refuse them.
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    // Runner links and terminals (spec 25 D5).
    websocket: socketServer,
    // The peer's address lets the API tell the console's proxy from a direct client.
    fetch: (request, bunServer) =>
      app.fetch(request, {
        peerAddress: bunServer.requestIP(request)?.address,
        upgrade: upgraderFor(bunServer),
      }),
  });
  log.info("listening", { address: config.http.hostname, port: server.port });
  // The runner link's TLS port: runner routes only (check, enroll, the WebSocket, downloads).
  const linkServer =
    linkCertificate && config.runner.link
      ? serveRunnerLink(app, {
          hostname: config.runner.link.bindAddress,
          port: config.runner.link.listenPort,
          certificate: linkCertificate.certificate,
          key: linkCertificate.key,
          idleTimeoutSeconds: IDLE_TIMEOUT_SECONDS,
        })
      : null;
  if (linkServer) {
    log.info("runner link listening", {
      address: config.runner.link?.bindAddress,
      port: linkServer.port,
      fingerprint: linkCertificate?.fingerprint,
    });
  }
  // Runners connected elsewhere are moved once their address changes (the console's domain
  // got its certificate): checked every minute.
  // Generated links follow a hostname saved under About Nearzero once its certificate is valid
  // (G4-21), checked now and with the runners every minute.
  await services.refreshConsoleUrl().catch(() => {});
  // The pair `nearzero runner-link rotate` made, which every remote runner is given before the
  // switch (C4-10), and after the switch the pair in place on disk until this process serves it
  // (C4-13): read again every minute. The replaced pair goes once every server has reconnected
  // to the new one, or a week after the switch (C4-14).
  const tlsDirectory = linkCertificate ? config.runner.link?.tlsDirectory : undefined;
  const servingSince = new Date();
  const readNextPin = async () => {
    if (!tlsDirectory || !linkCertificate) return;
    const served = linkCertificate.fingerprint;
    const fingerprint = await nextPinToAnnounce(tlsDirectory, served).catch((error: unknown) => {
      log.warn("the runner link's next certificate can't be used", {
        reason: (error as Error).message,
      });
      return null;
    });
    const onDisk = await readLinkCertificate(tlsDirectory).catch(() => null);
    if (onDisk?.fingerprint === served) {
      const waiting = await services.db
        .selectFrom("runner")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("server_id", "is not", null)
        .where("revoked_at", "is", null)
        .where("credential_hash", "is not", null)
        .where((eb) =>
          eb.or([eb("connected_at", "is", null), eb("connected_at", "<", servingSince)]),
        )
        .executeTakeFirst()
        .catch(() => ({ n: "1" }));
      const removed = await prunePreviousLinkCertificate(tlsDirectory, {
        everyServerMoved: Number(waiting?.n ?? 1) === 0,
      }).catch(() => null);
      if (removed !== null) {
        log.info("removed the runner link's replaced certificate and key", {
          fingerprint: removed,
        });
        await recordAudit(
          services.db,
          log,
          { kind: "system", label: "runner link" },
          {
            action: "runner-link.previous-removed",
            target: { kind: "runner-link", id: removed || "previous" },
          },
        );
      }
    }
    if (fingerprint !== (services.runnerLinkSettings.next ?? null)) {
      services.runnerLinkSettings.next = fingerprint;
      if (fingerprint) {
        log.info("giving servers the runner link's next certificate fingerprint", {
          fingerprint,
        });
      }
    }
  };
  await readNextPin();
  const linkKeeper = setInterval(() => {
    void readNextPin();
    void services.refreshConsoleUrl().catch(() => {});
    void services.runners
      .refreshLinks()
      .then((moved) => {
        if (moved > 0) log.info("moving runners to their encrypted address", { runners: moved });
      })
      .catch((error: unknown) => log.warn("couldn't check where runners connect", { error }));
  }, 60_000);
  linkKeeper.unref?.();

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    // No new job starts from here on, so none is picked up again by this process once the
    // runners below are gone (B2-20).
    const workerStopped = worker.stop();
    // Runners reconnect by themselves once Nearzero is back; tell them it is going away. Long
    // work they run goes on, and its jobs follow it again after the restart (B2-20).
    domains.stop();
    keeper.stop();
    agent.stop();
    clearInterval(linkKeeper);
    services.runners.stop();
    linkServer?.stop(true);
    // Finish requests in flight, but don't let a long stream hold the stop up.
    const drained = await Promise.race([
      server.stop().then(() => true),
      Bun.sleep(SHUTDOWN_DRAIN_MS).then(() => false),
    ]);
    if (!drained) await server.stop(true);
    await workerStopped;
    await notifications.stop();
    await recordStop(db, startId);
    await db.destroy();
    log.info("stopped");
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

await main();
