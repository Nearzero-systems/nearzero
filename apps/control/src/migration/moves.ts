import { isDatabaseKind } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";
import type { SecretBox } from "../security/secret-box.ts";
import { readAppSettings } from "../service-runtime/app-settings.ts";
import { acmeContext } from "./import-infra.ts";
import "./tables.ts";

/**
 * Moving the imported services onto the 1.0 runner (spec 29.2 step 5, 29.5 "Workloads" and
 * "Certificates"), server by server in the planned order:
 *
 * 1. A remote server is set up again over SSH with its saved key (the 1.0 runner replaces the
 *    0.1.x setup); the host's runner is already there. A server that can't be set up leaves all
 *    its services as they were, listed with the reason.
 * 2. Its certificate authority state goes into its router's store, and its uploaded certificates
 *    to its router, before any of its routes switch, so no certificate is ordered again.
 * 3. Each service in turn (spec 29.5 "Order for each service"): its 0.1.x workload is stopped
 *    (it can't share its volumes with the new container), the ports it published are waited on
 *    until they are free, the service is redeployed through the deploy engine with its volumes
 *    and its exact ports, and its hostnames route to the new container once it runs. When a step
 *    fails, the 1.0 container is removed, the 0.1.x workload is started again as it was, and the
 *    service is listed with the failure ("failed: <reason>").
 *
 * Every step records where it got to, so the job can run again after a restart and continue.
 * The work itself goes through a {@link MoveDriver}, which tests replace with a fake.
 */

export interface LegacyWorkload {
  kind: "swarm-service" | "swarm-stack" | "container" | "compose-project";
  name: string;
  /**
   * A Compose project's own files (29a.9 `legacy`): its copy comes back from them, never from
   * its stopped containers, which 1.0's deploy of the same project may have replaced (29.5).
   */
  folder?: string;
  composeFiles?: string[];
  envFile?: string;
  /**
   * With an absolute `envFile`: the 0.1.x install's data folders, and its data volumes (whose
   * folders on the server count too), which the env file must be a regular file under (29a.9).
   */
  dataFolders?: string[];
  dataVolumes?: string[];
}

export type StepResult = { ok: true } | { ok: false; reason: string };

/**
 * True while the service was moved from 0.1.x and the move isn't finalized: a moved Compose
 * stack shares its project name with 0.1.x's copy, so 1.0 never passes `--remove-orphans` for
 * it then (spec 29.5).
 */
export async function movedNotFinalized(db: Db, serviceId: string): Promise<boolean> {
  const move = await db
    .selectFrom("migration_move")
    .select("service_id")
    .where("service_id", "=", serviceId)
    .executeTakeFirst();
  if (!move) return false;
  const state = await db.selectFrom("migration_state").select("phase").executeTakeFirst();
  return state?.phase !== "finalized";
}

/** A port a service publishes on its server. */
export interface PublishedPort {
  port: number;
  protocol: "tcp" | "udp";
}

/** The ports a service publishes: a database's public port, an app's published ports. */
export async function publishedPorts(db: Db, serviceId: string): Promise<PublishedPort[]> {
  const row = await db
    .selectFrom("service")
    .select(["kind", "settings", "public_port"])
    .where("id", "=", serviceId)
    .executeTakeFirst();
  if (!row) return [];
  if (isDatabaseKind(row.kind)) {
    return row.public_port === null ? [] : [{ port: row.public_port, protocol: "tcp" }];
  }
  if (row.kind !== "application") return [];
  return readAppSettings(row.settings).ports.map((port) => ({
    port: port.publishedPort,
    protocol: port.protocol === "udp" ? "udp" : "tcp",
  }));
}

/** A volume archive from the export (--volumes) waiting to be restored before a first deploy. */
export interface VolumeArchive {
  id: string;
  volume: string;
  sha256: string;
  sizeBytes: number;
}

export interface MoveDriver {
  /** Sets a remote server up again over SSH and waits until its runner is connected. */
  setUpServer(serverId: string, signal: AbortSignal): Promise<StepResult>;
  /** Waits until the target's runner is connected (the host's, or a server's already set up). */
  runnerReady(target: string, signal: AbortSignal): Promise<StepResult>;
  /** Merges a router store into the target's router and restarts it. */
  placeCertificates(target: string, store: unknown): Promise<StepResult>;
  /** Gives the target's router its uploaded certificates. */
  pushUploads(target: string): Promise<StepResult>;
  legacy(
    target: string,
    action: "stop" | "start" | "remove",
    workload: LegacyWorkload,
  ): Promise<StepResult>;
  /** The same for a remote server's own 0.1.x workloads (its router), over SSH before setup. */
  serverLegacy(
    serverId: string,
    action: "stop" | "start",
    workloads: LegacyWorkload[],
  ): Promise<StepResult>;
  /**
   * Unpacks a volume archive the import kept into its volume on the target (moving to another
   * machine), creating the volume when it isn't there.
   */
  restoreVolume(target: string, archive: VolumeArchive): Promise<StepResult>;
  /**
   * Waits until nothing on the target publishes these ports; the reason names each port still
   * held and what holds it.
   */
  waitPortsFree(target: string, ports: PublishedPort[]): Promise<StepResult>;
  /** Removes the service's 1.0 containers on the target (a step of its move failed). */
  removeServiceContainers(target: string, serviceId: string): Promise<StepResult>;
  /**
   * Redeploys the service through the deploy engine and waits for it to end. `requested` is
   * called with the deployment's id as soon as it exists, so a repeat waits on the same one.
   */
  deploy(
    serviceId: string,
    existingDeploymentId: string | null,
    requested: (deploymentId: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<StepResult>;
}

export interface MoveContext {
  db: Db;
  secrets: SecretBox;
  log: Logger;
  driver: MoveDriver;
  signal: AbortSignal;
  /** Called once per service when it ends (the CLI prints one line each). */
  onService?: (line: MoveLine) => void;
}

export interface MoveLine {
  service: string;
  server: string;
  state: "moved" | "failed" | "skipped";
  reason: string | null;
}

async function touchServer(
  db: Db,
  target: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await db
    .updateTable("migration_server_move")
    .set({ ...changes, updated_at: new Date() })
    .where("target", "=", target)
    .execute();
}

async function touchService(
  db: Db,
  serviceId: string,
  changes: Record<string, unknown>,
): Promise<void> {
  await db
    .updateTable("migration_move")
    .set({ ...changes, updated_at: new Date() })
    .where("service_id", "=", serviceId)
    .execute();
}

async function names(
  db: Db,
  serviceId: string,
  target: string,
): Promise<{ service: string; server: string }> {
  const service = await db
    .selectFrom("service")
    .select("name")
    .where("id", "=", serviceId)
    .executeTakeFirst();
  const server =
    target === "host"
      ? "the Nearzero host"
      : ((await db.selectFrom("server").select("name").where("id", "=", target).executeTakeFirst())
          ?.name ?? "its server");
  return { service: service?.name ?? "a service", server };
}

/** Prepares one server; returns the reason when its services can't move. */
async function prepareServer(context: MoveContext, target: string): Promise<string | null> {
  const { db, driver, signal } = context;
  const row = await db
    .selectFrom("migration_server_move")
    .selectAll()
    .where("target", "=", target)
    .executeTakeFirstOrThrow();
  if (row.state === "ready") return null;
  await touchServer(db, target, {
    state: "setting_up",
    started_at: row.started_at ?? new Date(),
    reason: null,
  });
  const legacy = ((row.legacy ?? []) as LegacyWorkload[]).filter(Boolean);
  if (target !== "host" && legacy.length > 0) {
    // Its 0.1.x router holds ports 80 and 443, which setup needs for the 1.0 router.
    const stopped = await driver.serverLegacy(target, "stop", legacy);
    if (!stopped.ok) {
      const reason = `its 0.1.x router couldn't be stopped (${stopped.reason})`;
      await touchServer(db, target, { state: "failed", reason, finished_at: new Date() });
      return reason;
    }
  }
  const ready =
    target === "host"
      ? await driver.runnerReady(target, signal)
      : await driver.setUpServer(target, signal);
  if (!ready.ok) {
    let reason = ready.reason;
    if (target !== "host" && legacy.length > 0) {
      const started = await driver.serverLegacy(target, "start", legacy);
      reason = started.ok
        ? `${reason}; its 0.1.x router is running again`
        : `${reason}; its 0.1.x router couldn't be started again (${started.reason})`;
    }
    await touchServer(db, target, { state: "failed", reason, finished_at: new Date() });
    return reason;
  }
  const acme = await db
    .selectFrom("migration_acme_state")
    .select(["sealed", "placed_at"])
    .where("target", "=", target)
    .executeTakeFirst();
  if (acme && !acme.placed_at) {
    const opened = context.secrets.open(acme.sealed, acmeContext(target));
    if (!opened.ok) {
      const reason = "its certificates can't be read with this install's key";
      await touchServer(db, target, { state: "failed", reason, finished_at: new Date() });
      return reason;
    }
    const placed = await driver.placeCertificates(target, JSON.parse(opened.value));
    if (!placed.ok) {
      const reason = `its certificates couldn't be placed in its router: ${placed.reason}`;
      await touchServer(db, target, { state: "failed", reason, finished_at: new Date() });
      return reason;
    }
    await db
      .updateTable("migration_acme_state")
      .set({ placed_at: new Date() })
      .where("target", "=", target)
      .execute();
    await touchServer(db, target, { certificates_placed_at: new Date() });
  }
  const uploads = await db
    .selectFrom("uploaded_certificate")
    .select("id")
    .where("target", "=", target)
    .limit(1)
    .execute();
  if (uploads.length > 0) {
    const pushed = await driver.pushUploads(target);
    if (!pushed.ok) {
      const reason = `its uploaded certificates couldn't reach its router: ${pushed.reason}`;
      await touchServer(db, target, { state: "failed", reason, finished_at: new Date() });
      return reason;
    }
  }
  await touchServer(db, target, { state: "ready", reason: null, finished_at: new Date() });
  return null;
}

async function moveService(
  context: MoveContext,
  move: {
    service_id: string;
    target: string;
    legacy: unknown;
    legacy_stopped: boolean;
    deployment_id: string | null;
  },
): Promise<MoveLine> {
  const { db, driver, signal } = context;
  const label = await names(db, move.service_id, move.target);
  const legacy = (move.legacy ?? null) as LegacyWorkload | null;
  await touchService(db, move.service_id, {
    state: "moving",
    started_at: new Date(),
    reason: null,
  });
  let stopped = move.legacy_stopped;
  if (legacy && !stopped) {
    const result = await driver.legacy(move.target, "stop", legacy);
    if (!result.ok) {
      const reason = `its 0.1.x workload couldn't be stopped (${result.reason}), so it keeps running there`;
      await touchService(db, move.service_id, { state: "failed", reason, finished_at: new Date() });
      return { ...label, state: "failed", reason };
    }
    stopped = true;
    await touchService(db, move.service_id, { legacy_stopped: true });
  }
  // Moving to another machine: the service's data goes into its new volumes before it first runs.
  const archives = await db
    .selectFrom("migration_volume_archive")
    .select(["id", "volume", "sha256", "size_bytes"])
    .where("service_id", "=", move.service_id)
    .where("restored_at", "is", null)
    .orderBy("volume")
    .execute();
  for (const archive of archives) {
    const restored = await driver.restoreVolume(move.target, {
      id: archive.id,
      volume: archive.volume,
      sha256: archive.sha256,
      sizeBytes: Number(archive.size_bytes),
    });
    if (!restored.ok) {
      const reason = await givenBack(
        context,
        move,
        legacy,
        stopped,
        `its data couldn't be restored into the volume ${archive.volume} (${restored.reason})`,
      );
      return { ...label, state: "failed", reason };
    }
    await db
      .updateTable("migration_volume_archive")
      .set({ restored_at: new Date() })
      .where("id", "=", archive.id)
      .execute();
  }
  // The ports it published are free once its 0.1.x workload has let go of them; the exact ports
  // are kept, never others (29.5 "Public ports"). A deploy already requested holds them itself.
  const ports = move.deployment_id ? [] : await publishedPorts(db, move.service_id);
  if (ports.length > 0) {
    const free = await driver.waitPortsFree(move.target, ports);
    if (!free.ok) {
      const reason = await givenBack(context, move, legacy, stopped, free.reason, true);
      return { ...label, state: "failed", reason };
    }
  }
  const deployed = await driver.deploy(
    move.service_id,
    move.deployment_id,
    (deploymentId) => touchService(db, move.service_id, { deployment_id: deploymentId }),
    signal,
  );
  if (deployed.ok) {
    await touchService(db, move.service_id, {
      state: "moved",
      reason: null,
      finished_at: new Date(),
    });
    return { ...label, state: "moved", reason: null };
  }
  const reason = await givenBack(context, move, legacy, stopped, deployed.reason, true);
  return { ...label, state: "failed", reason };
}

/**
 * A step of a service's move failed: its 0.1.x workload starts again when it was stopped, and the
 * service is marked failed with the reason. The next attempt (retry) starts a fresh deployment.
 */
async function givenBack(
  context: MoveContext,
  move: { service_id: string; target: string },
  legacy: LegacyWorkload | null,
  stopped: boolean,
  failure: string,
  removeContainers = false,
): Promise<string> {
  const { db, driver } = context;
  let reason = failure;
  // The 1.0 container goes first, so the 0.1.x workload gets its ports and volumes back.
  if (removeContainers) {
    const removed = await driver.removeServiceContainers(move.target, move.service_id);
    if (!removed.ok)
      reason = `${reason}; its 1.0 container couldn't be removed (${removed.reason})`;
  }
  if (legacy && stopped) {
    const restarted = await driver.legacy(move.target, "start", legacy);
    if (restarted.ok) {
      await touchService(db, move.service_id, { legacy_stopped: false });
      reason = `${reason}; its 0.1.x workload is running again`;
    } else {
      reason = `${reason}; its 0.1.x workload couldn't be started again (${restarted.reason})`;
    }
  }
  await touchService(db, move.service_id, {
    state: "failed",
    reason,
    finished_at: new Date(),
    deployment_id: null,
  });
  return reason;
}

/** Runs (or continues) the move. Safe to repeat: finished steps are not done again. */
export async function runMove(context: MoveContext): Promise<{ moved: number; failed: number }> {
  const { db, signal } = context;
  await db
    .updateTable("migration_state")
    .set({ phase: "moving", updated_at: new Date() })
    .where("phase", "in", ["imported", "moved"])
    .execute();
  const targets = await db
    .selectFrom("migration_server_move")
    .select(["target", "state"])
    .orderBy("position")
    .execute();
  let moved = 0;
  let failed = 0;
  for (const { target } of targets) {
    if (signal.aborted)
      throw new Error("The move was interrupted; it continues when Nearzero starts again.");
    const pending = await db
      .selectFrom("migration_move")
      .select(["service_id", "target", "legacy", "legacy_stopped", "deployment_id"])
      .where("target", "=", target)
      .where("state", "in", ["waiting", "moving"])
      .orderBy("position")
      .execute();
    if (pending.length === 0) continue;
    const problem = await prepareServer(context, target);
    if (problem) {
      for (const move of pending) {
        const reason = `its server couldn't be prepared: ${problem}`;
        await touchService(db, move.service_id, {
          state: "failed",
          reason,
          finished_at: new Date(),
        });
        failed++;
        context.onService?.({
          ...(await names(db, move.service_id, target)),
          state: "failed",
          reason,
        });
      }
      continue;
    }
    for (const move of pending) {
      if (signal.aborted)
        throw new Error("The move was interrupted; it continues when Nearzero starts again.");
      const line = await moveService(context, move);
      if (line.state === "moved") moved++;
      else failed++;
      context.onService?.(line);
      context.log.info("migration service move finished", {
        serviceId: move.service_id,
        state: line.state,
      });
    }
  }
  const left = await db
    .selectFrom("migration_move")
    .select("service_id")
    .where("state", "in", ["waiting", "moving"])
    .limit(1)
    .execute();
  if (left.length === 0) {
    await db
      .updateTable("migration_state")
      .set({ phase: "moved", updated_at: new Date() })
      .where("phase", "=", "moving")
      .execute();
  }
  return { moved, failed };
}

/** Puts failed services (all, or the named ones) back in line for another attempt. */
export async function retryFailed(db: Db, serviceIds?: readonly string[]): Promise<number> {
  let query = db
    .updateTable("migration_move")
    .set({
      state: "waiting",
      reason: null,
      deployment_id: null,
      finished_at: null,
      updated_at: new Date(),
    })
    .where("state", "=", "failed");
  if (serviceIds && serviceIds.length > 0) query = query.where("service_id", "in", [...serviceIds]);
  const result = await query.executeTakeFirst();
  // A server that failed is tried again too.
  await db
    .updateTable("migration_server_move")
    .set({ state: "waiting", reason: null, updated_at: new Date() })
    .where("state", "=", "failed")
    .execute();
  await db
    .updateTable("migration_state")
    .set({ phase: "moving", updated_at: new Date() })
    .where("phase", "=", "moved")
    .execute();
  return Number(result.numUpdatedRows);
}

/** Removes the 0.1.x workloads (finalize): moved ones, and failed ones the person gave up on. */
export async function removeLegacyWorkloads(
  db: Db,
  driver: MoveDriver,
): Promise<{ removed: number; problems: string[] }> {
  const rows = await db
    .selectFrom("migration_move")
    .select(["service_id", "target", "legacy"])
    .where("legacy", "is not", null)
    .where("legacy_removed_at", "is", null)
    .execute();
  let removed = 0;
  const problems: string[] = [];
  for (const row of rows) {
    const result = await driver.legacy(row.target, "remove", row.legacy as LegacyWorkload);
    if (result.ok) {
      removed++;
      await touchService(db, row.service_id, { legacy_removed_at: sql<Date>`now()` });
    } else {
      const label = await names(db, row.service_id, row.target);
      problems.push(`${label.service} on ${label.server}: ${result.reason}`);
    }
  }
  return { removed, problems };
}
