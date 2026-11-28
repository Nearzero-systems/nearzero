import { deployLogFirstLine, VERSION } from "@nearzero/shared";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { DeferJob, defineJob } from "../jobs/definition.ts";
import type { Logger } from "../log.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { Cancelled, ServerOps } from "../service-runtime/server-ops.ts";
import type { ControlServices } from "../services.ts";
import { DeployLog } from "./log.ts";
import { DeployFailure, runPipeline } from "./pipeline.ts";
import {
  type DeployOutcome,
  finishDeployment,
  RUN_DEPLOY_JOB,
  registerRunning,
  savedOutcome,
  saveOutcome,
  startBuilding,
  startNextWaiting,
} from "./queue.ts";

/**
 * The job that carries out one deployment (spec 23.1, "Long work outlives requests"). It runs
 * at least once: if the control plane stops mid-deploy, the next attempt starts the deploy again
 * from the beginning (leftovers of the first attempt are removed), and the log says so.
 *
 * Once the pipeline has ended, how it ended is saved first. Writing the deployment's record can
 * then fail (the database dropping a connection) without the deploy ever running twice: the
 * recording is tried again, and a later attempt of the job only records the saved outcome.
 */

const payload = z.object({ deploymentId: z.string().regex(/^[0-9a-f-]{36}$/) });

/** How often a running deploy looks for a cancel made by another process. */
const CANCEL_POLL_MS = 2_000;
/** How soon a deploy waiting for its server's other deploy looks again. */
const SERVER_BUSY_RETRY_MS = 3_000;
/** Deployments whose log already says they wait for their server. */
const waitingNoted = new Set<string>();

/** Pauses between tries at recording a finished deploy. */
export const RECORD_RETRY_MS = [500, 2_000, 5_000];

export function runDeployJob(services: ControlServices) {
  return defineJob({
    kind: RUN_DEPLOY_JOB,
    payload,
    maxAttempts: 3,
    lane: "deploy",
    retryDelayMs: () => 2_000,
    async run({ deploymentId }, { db, log, signal, job }) {
      const started = await startBuilding(db, deploymentId, {
        jobId: job.id,
        perServer: services.buildsPerServer,
      });
      if (!started.start) {
        if (started.serverBusy) {
          // The server is building another app: stay queued, and say why once (R2-15). Only
          // builds wait, so the words are about the build (G2-05).
          if (!waitingNoted.has(deploymentId)) {
            waitingNoted.add(deploymentId);
            if (waitingNoted.size > 10_000) waitingNoted.clear();
            const waitLog = await DeployLog.open(db, deploymentId);
            waitLog.line(
              started.serverBusy.cleanup
                ? `Queued: the daily Docker cleanup is running on ${started.serverBusy.serverName}. This deploy starts when it ends, so the cleanup can't remove its image.`
                : services.buildsPerServer === 1
                  ? `Queued: this deploy builds, and ${started.serverBusy.serverName} builds one app at a time. It starts when the build running there ends.`
                  : `Queued: this deploy builds, and ${started.serverBusy.serverName} builds ${services.buildsPerServer} apps at a time. It starts when one of the builds running there ends.`,
            );
            await waitLog.flush();
          }
          throw new DeferJob(SERVER_BUSY_RETRY_MS, "the server is busy with another deploy");
        }
        // Already finished, or another job's (B1-38, B1-39): only the waiting deploy may start.
        await startNextWaiting(db, deploymentId);
        return;
      }
      waitingNoted.delete(deploymentId);
      if (started.resumed) {
        const saved = await savedOutcome(db, deploymentId);
        if (saved) {
          // The deploy itself ended before; only its record is written again.
          await record(db, log, deploymentId, saved);
          return;
        }
      }
      const deployment = started.row;
      const controller = new AbortController();
      const unregister = registerRunning(deploymentId, controller);
      const stopping = () => controller.abort();
      signal.addEventListener("abort", stopping, { once: true });
      const poll = setInterval(() => {
        void db
          .selectFrom("deployment")
          .select("cancel_requested_at")
          .where("id", "=", deploymentId)
          .executeTakeFirst()
          .then((row) => {
            if (row?.cancel_requested_at) controller.abort();
          })
          .catch(() => {});
      }, CANCEL_POLL_MS);
      let deployLog: DeployLog;
      try {
        deployLog = await DeployLog.open(db, deploymentId);
      } catch (error) {
        clearInterval(poll);
        signal.removeEventListener("abort", stopping);
        unregister();
        throw error;
      }
      if (started.resumed) {
        deployLog.line("");
        deployLog.line(
          `Nearzero stopped during this deploy (attempt ${job.attempt - 1}), so it starts again.`,
        );
      }
      deployLog.line(deployLogFirstLine(VERSION));
      let outcome: DeployOutcome;
      try {
        if (deployment.cancel_requested_at) throw new Cancelled();
        const ops = new ServerOps(services, deployment.server_id ?? HOST_TARGET, controller.signal);
        outcome = await runPipeline({ services, deployment, log: deployLog, ops });
      } catch (error) {
        if (
          (signal.aborted || services.runners.stopping) &&
          !(await cancelRequested(services, deploymentId))
        ) {
          // The control plane is stopping (its runners went first, B2-20): the next attempt
          // deploys again instead of this one being marked failed.
          deployLog.line("Nearzero is stopping; this deploy continues when it starts again.");
          await deployLog.flush().catch(() => {});
          clearInterval(poll);
          unregister();
          throw new Error("The control plane stopped during this deploy.");
        }
        if (error instanceof Cancelled || controller.signal.aborted) {
          deployLog.line("Cancelled. The running version keeps serving.");
          outcome = { status: "cancelled" };
        } else if (error instanceof DeployFailure) {
          deployLog.line(`Deployment failed: ${error.message}`);
          outcome = { status: "failed", error: error.message };
        } else {
          const message = (error as Error)?.message || String(error);
          log.warn("a deploy failed unexpectedly", { deploymentId, error });
          deployLog.line(`Deployment failed: ${message}`);
          outcome = { status: "failed", error: message };
        }
      } finally {
        clearInterval(poll);
        signal.removeEventListener("abort", stopping);
      }
      unregister();
      // Saved before anything else: from here on, a retry never runs the pipeline again.
      await retrying(() => saveOutcome(db, deploymentId, outcome));
      await deployLog.flush().catch((error) => {
        log.warn("a deploy's last log lines couldn't be saved", { deploymentId, error });
      });
      await record(db, log, deploymentId, outcome);
    },
  });
}

async function retrying(step: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await step();
      return;
    } catch (error) {
      const pause = RECORD_RETRY_MS[attempt];
      if (pause === undefined) throw error;
      await Bun.sleep(pause);
    }
  }
}

/** Records the outcome, trying a few times; the job's next attempt tries again after that. */
async function record(
  db: Db,
  log: Logger,
  deploymentId: string,
  outcome: DeployOutcome,
): Promise<void> {
  try {
    await retrying(() => finishDeployment(db, deploymentId, outcome));
  } catch (error) {
    log.warn("a finished deploy couldn't be recorded yet", { deploymentId, error });
    throw error;
  }
}

async function cancelRequested(services: ControlServices, deploymentId: string): Promise<boolean> {
  const row = await services.db
    .selectFrom("deployment")
    .select("cancel_requested_at")
    .where("id", "=", deploymentId)
    .executeTakeFirst();
  return Boolean(row?.cancel_requested_at);
}
