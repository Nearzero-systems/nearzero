import { cleanupJob as analyticsCleanupJob } from "../analytics/area.ts";
import { runBackupJob } from "../backups/job.ts";
import { backupTickJob } from "../backups/scheduler.ts";
import { removeServicesJob } from "../deletion/job.ts";
import { healthWatchJob } from "../deploys/health-watch.ts";
import { runDeployJob } from "../deploys/job.ts";
import { pruneDeploymentsJob } from "../deploys/retention.ts";
import { pruneIdentityRecords } from "../identity/maintenance.ts";
import { finalizeJob, moveJob } from "../migration/move-job.ts";
import { pruneServerMetrics } from "../runners/metrics.ts";
import { cleanupRunJob, cleanupTickJob } from "../server-setup/cleanup.ts";
import { runSetupJob } from "../server-setup/job.ts";
import { removeServerJob, uninstallRunnerJob } from "../server-setup/removal.ts";
import { runnerTeardown } from "../service-runtime/teardown.ts";
import type { ControlServices } from "../services.ts";
import { runTaskJob } from "../tasks/runs.ts";
import { taskTickJob } from "../tasks/scheduler.ts";
import type { AnyJobDefinition } from "./definition.ts";
import { pruneFinishedJobs } from "./prune-finished-jobs.ts";

/**
 * Every job kind this version of the control plane can run. Deploys and deletes reach servers
 * through their runners, so the catalog is made from the process's services. Deleting services
 * tears them down from their servers through the runner (service-runtime/teardown.ts).
 */
export function createJobCatalog(services: ControlServices): AnyJobDefinition[] {
  return [
    pruneFinishedJobs,
    pruneIdentityRecords,
    removeServicesJob(runnerTeardown(services)),
    pruneServerMetrics,
    runDeployJob(services),
    pruneDeploymentsJob,
    // Apps whose health check fails after their deploy get a fresh container (31b G2-06).
    healthWatchJob(services),
    // Backups: the one scheduler (backups.tick) and every run (spec 17.2, 24 P5).
    backupTickJob(services),
    runBackupJob(services),
    // Servers over SSH: setup, the daily Docker cleanup, deleting with services (spec 9.3–9.6).
    runSetupJob(services),
    cleanupTickJob,
    cleanupRunJob(services),
    removeServerJob(services, runnerTeardown(services)),
    uninstallRunnerJob(services),
    // Tasks: the one scheduler and every run; the request log's cleanup (spec 12, 13.1).
    taskTickJob(services),
    runTaskJob(services),
    analyticsCleanupJob(services),
    // Moving a 0.1.x install to 1.0: services onto the runner, then the old workloads (spec 29).
    moveJob(services),
    finalizeJob(services),
  ];
}
