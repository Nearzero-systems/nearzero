import { AppError, NEARZERO_LABELS, type PortsWaitResult } from "@nearzero/shared";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { requestDeploy } from "../deploys/queue.ts";
import { pushUploads } from "../domains/certificates.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import { carryOutSetup } from "../server-setup/job.ts";
import { failureOf, initialSteps, loadRun, SETUP_JOB } from "../server-setup/runs.ts";
import type { ControlServices } from "../services.ts";
import { legacyScript, runOnServer } from "./legacy.ts";
import { type MoveDriver, removeLegacyWorkloads, runMove, type StepResult } from "./moves.ts";
import "./tables.ts";

/**
 * The move as a job of the control plane (it holds the runners' connections, so it is where
 * deploys and router changes can happen), and the driver that does the real work: setup over SSH,
 * runner commands and the deploy engine.
 */

export const MOVE_JOB = "migration.move";
export const FINALIZE_JOB = "migration.finalize";

const SECOND = 1000;
const RUNNER_WAIT_MS = 10 * 60 * SECOND;
/** How long the move waits for a setup run another job carries out (B1-62). */
const SETUP_WAIT_MS = 60 * 60 * SECOND;
const DEPLOY_WAIT_MS = 90 * 60 * SECOND;
const POLL_MS = 2 * SECOND;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function reasonOf(error: unknown): string {
  if (error instanceof AppError) return error.message;
  const message = (error as Error)?.message ?? String(error);
  return message.length > 300 ? `${message.slice(0, 297)}...` : message;
}

async function attempt(work: () => Promise<unknown>): Promise<StepResult> {
  try {
    await work();
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: reasonOf(error) };
  }
}

export function runnerMoveDriver(services: ControlServices): MoveDriver {
  const { db } = services;

  const runnerReady = async (target: string, signal: AbortSignal): Promise<StepResult> => {
    const until = Date.now() + RUNNER_WAIT_MS;
    while (!services.runners.isOnline(target)) {
      if (signal.aborted) return { ok: false, reason: "the move was interrupted" };
      if (Date.now() > until)
        return { ok: false, reason: "its runner didn't connect within 10 minutes" };
      await sleep(POLL_MS, signal);
    }
    return { ok: true };
  };

  return {
    runnerReady,

    async setUpServer(serverId, signal) {
      const server = await db
        .selectFrom("server")
        .select(["workspace_id", "ssh_user"])
        .where("id", "=", serverId)
        .executeTakeFirst();
      if (!server) return { ok: false, reason: "the server doesn't exist any more" };
      const running = await db
        .selectFrom("server_setup_run as r")
        .leftJoin("job as j", "j.id", "r.job_id")
        .select(["r.id", "j.state as jobState"])
        .where("r.server_id", "=", serverId)
        .where("r.state", "=", "running")
        .executeTakeFirst();
      // A setup someone started from the console has its own job carrying it out: running the
      // same SSH steps beside it would race it (B1-62), so the move waits for it to finish.
      if (running && (running.jobState === "queued" || running.jobState === "running")) {
        const until = Date.now() + SETUP_WAIT_MS;
        for (;;) {
          const run = await loadRun(db, running.id);
          if (run?.state !== "running") break;
          if (signal.aborted) return { ok: false, reason: "the move was interrupted" };
          if (Date.now() > until)
            return {
              ok: false,
              reason: "its setup started elsewhere didn't finish within an hour",
            };
          await sleep(POLL_MS, signal);
        }
        await db
          .updateTable("migration_server_move")
          .set({ setup_run_id: running.id })
          .where("target", "=", serverId)
          .execute();
        const run = await loadRun(db, running.id);
        if (run?.state !== "succeeded") {
          return { ok: false, reason: failureOf(run?.failure)?.message ?? "setup didn't finish" };
        }
        return runnerReady(serverId, signal);
      }
      const runId =
        running?.id ??
        (
          await db
            .insertInto("server_setup_run")
            .values({
              server_id: serverId,
              workspace_id: server.workspace_id,
              steps: JSON.stringify(initialSteps()),
              ssh_user: server.ssh_user,
            })
            .returning("id")
            .executeTakeFirstOrThrow()
        ).id;
      await db
        .updateTable("migration_server_move")
        .set({ setup_run_id: runId })
        .where("target", "=", serverId)
        .execute();
      try {
        await carryOutSetup(services, runId, {
          signal,
          job: { id: 0, kind: SETUP_JOB, payload: { runId }, attempt: 1, maxAttempts: 1 },
        });
      } catch (error) {
        return { ok: false, reason: reasonOf(error) };
      }
      const run = await loadRun(db, runId);
      if (run?.state !== "succeeded") {
        return { ok: false, reason: failureOf(run?.failure)?.message ?? "setup didn't finish" };
      }
      return runnerReady(serverId, signal);
    },

    placeCertificates: (target, store) =>
      attempt(() =>
        services.runners.command(
          target,
          "certificates.import",
          { store: JSON.stringify(store) },
          { timeoutMs: 3 * 60 * SECOND },
        ),
      ),

    pushUploads: (target) => attempt(() => pushUploads(services, target)),

    legacy: (target, action, workload) =>
      attempt(() =>
        services.runners.command(
          target,
          "legacy.workload",
          {
            action,
            kind: workload.kind,
            name: workload.name,
            // A stack's own files, so its 0.1.x copy comes back from them (spec 29.5).
            ...(workload.kind === "compose-project" && workload.folder
              ? {
                  folder: workload.folder,
                  composeFiles: workload.composeFiles ?? [],
                  ...(workload.envFile ? { envFile: workload.envFile } : {}),
                  dataFolders: workload.dataFolders ?? [],
                  dataVolumes: workload.dataVolumes ?? [],
                }
              : {}),
          },
          { timeoutMs: 15 * 60 * SECOND },
        ),
      ),

    restoreVolume: (target, archive) =>
      attempt(() =>
        services.runners.command(
          target,
          "volume.restore",
          {
            volume: archive.volume,
            archiveId: archive.id,
            sha256: archive.sha256,
            sizeBytes: archive.sizeBytes,
          },
          // Large volumes take a while to download and unpack.
          { timeoutMs: 120 * 60 * SECOND },
        ),
      ),

    async waitPortsFree(target, ports) {
      try {
        const answer = (await services.runners.command(
          target,
          "ports.wait-free",
          { ports, timeoutSeconds: 60 },
          { timeoutMs: 90 * SECOND },
        )) as PortsWaitResult;
        if (answer.free) return { ok: true };
        const held = answer.held
          .map((item) => `port ${item.port}/${item.protocol} is still held by ${item.holder}`)
          .join("; ");
        return { ok: false, reason: `${held}, so it can't be published here` };
      } catch (error) {
        return { ok: false, reason: `its ports couldn't be checked (${reasonOf(error)})` };
      }
    },

    removeServiceContainers: (target, serviceId) =>
      attempt(async () => {
        const containers = (await services.runners.command(target, "container.list", {
          all: true,
          labels: [`${NEARZERO_LABELS.service}=${serviceId}`],
        })) as { id: string }[];
        for (const container of containers) {
          await services.runners.command(
            target,
            "container.remove",
            { id: container.id, force: true, volumes: false },
            { timeoutMs: 60 * SECOND },
          );
        }
      }),

    serverLegacy: (serverId, action, workloads) =>
      runOnServer(services, serverId, legacyScript(action, workloads)),

    async deploy(serviceId, existing, requested, signal) {
      let deploymentId = existing;
      if (!deploymentId) {
        const service = await db
          .selectFrom("service")
          .select("workspace_id")
          .where("id", "=", serviceId)
          .executeTakeFirst();
        if (!service) return { ok: false, reason: "the service doesn't exist any more" };
        try {
          const result = await requestDeploy(db, {
            serviceId,
            workspaceId: service.workspace_id,
            trigger: "manual",
            requestedBy: null,
            title: "Moved to Nearzero 1.0",
          });
          deploymentId = result.deployment.id;
        } catch (error) {
          return { ok: false, reason: reasonOf(error) };
        }
        await requested(deploymentId);
      }
      const until = Date.now() + DEPLOY_WAIT_MS;
      for (;;) {
        const row = await db
          .selectFrom("deployment")
          .select(["status", "error"])
          .where("id", "=", deploymentId)
          .executeTakeFirst();
        if (!row) return { ok: false, reason: "its deployment disappeared" };
        if (row.status === "active") return { ok: true };
        if (row.status === "not_running")
          return { ok: false, reason: row.error ?? "it deployed but isn't running" };
        if (row.status === "failed" || row.status === "cancelled" || row.status === "removed") {
          return { ok: false, reason: row.error ?? `the deploy ended as ${row.status}` };
        }
        if (signal.aborted)
          throw new Error("The move was interrupted; it continues when Nearzero starts again.");
        if (Date.now() > until)
          return { ok: false, reason: "the deploy didn't finish within 90 minutes" };
        await sleep(POLL_MS, signal);
      }
    },
  };
}

/** Starts (or joins) the move job. Returns its id. */
export async function enqueueMove(db: Db): Promise<number> {
  const queue = new JobQueue(db, { workerId: "nearzero-command" });
  const open = await db
    .selectFrom("job")
    .select("id")
    .where("kind", "=", MOVE_JOB)
    .where("state", "in", ["queued", "running"])
    .executeTakeFirst();
  const job = open
    ? { id: open.id }
    : await queue.enqueue({
        kind: MOVE_JOB,
        payload: {},
        maxAttempts: 5,
        idempotencyKey: `migration-move:${Date.now()}`,
      });
  await db.updateTable("migration_state").set({ job_id: job.id, updated_at: new Date() }).execute();
  return job.id;
}

export async function enqueueFinalize(db: Db): Promise<number> {
  const queue = new JobQueue(db, { workerId: "nearzero-command" });
  const job = await queue.enqueue({
    kind: FINALIZE_JOB,
    payload: {},
    maxAttempts: 3,
    idempotencyKey: `migration-finalize:${Date.now()}`,
  });
  return job.id;
}

export function moveJob(
  services: ControlServices,
  driver: MoveDriver = runnerMoveDriver(services),
) {
  return defineJob({
    kind: MOVE_JOB,
    payload: z.object({}).passthrough(),
    maxAttempts: 5,
    retryDelayMs: () => 30 * SECOND,
    async run(_payload, context) {
      await runMove({
        db: services.db,
        secrets: services.secrets,
        log: context.log,
        driver,
        signal: context.signal,
      });
    },
  });
}

/** After finalize: the 0.1.x workloads go (their volumes stay; the 1.0 services use them). */
export function finalizeJob(
  services: ControlServices,
  driver: MoveDriver = runnerMoveDriver(services),
) {
  return defineJob({
    kind: FINALIZE_JOB,
    payload: z.object({}).passthrough(),
    maxAttempts: 3,
    async run(_payload, context) {
      const result = await removeLegacyWorkloads(services.db, driver);
      for (const problem of result.problems)
        context.log.warn("couldn't remove a 0.1.x workload", { problem });
    },
  });
}
