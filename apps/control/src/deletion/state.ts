import { sql } from "kysely";
import type { Db } from "../db/database.ts";

/**
 * Whether a delete run is still being carried out. A run is tracked while its job is queued or
 * running; a run whose job is gone or gave up (the platform restarted too often, or the job was
 * pruned) is no longer tracked, and the person can start the delete again.
 */

export interface RunRow {
  id: string;
  workspace_id: string;
  scope: "project" | "services";
  project_id: string;
  project_name: string;
  state: "running" | "succeeded" | "failed";
  fingerprint: string | null;
  job_id: number | null;
  requested_by: string | null;
  created_at: Date;
  finished_at: Date | null;
}

export const RUN_COLUMNS = [
  "id",
  "workspace_id",
  "scope",
  "project_id",
  "project_name",
  "state",
  "fingerprint",
  "job_id",
  "requested_by",
  "created_at",
  "finished_at",
] as const;

export async function isRunTracked(
  db: Db,
  run: Pick<RunRow, "state" | "job_id">,
): Promise<boolean> {
  if (run.state !== "running") return false;
  if (run.job_id === null) return false;
  const job = await db
    .selectFrom("job")
    .select("state")
    .where("id", "=", run.job_id)
    .executeTakeFirst();
  return job?.state === "queued" || job?.state === "running";
}

export const STOPPED_BEFORE_REMOVED =
  "The delete stopped before this service was removed. Start the delete again to finish.";

/** Ends a run nobody is carrying out any more, so its services can be deleted again. */
export async function closeUntrackedRun(db: Db, runId: string): Promise<void> {
  await db
    .updateTable("delete_run_item")
    .set({ state: "not_removed", reason: STOPPED_BEFORE_REMOVED })
    .where("run_id", "=", runId)
    .where("state", "in", ["waiting", "removing"])
    .execute();
  await db
    .updateTable("service")
    .set({ deleting_run_id: null })
    .where("deleting_run_id", "=", runId)
    .execute();
  await db
    .updateTable("delete_run")
    .set({ state: "failed", finished_at: sql<Date>`now()` })
    .where("id", "=", runId)
    .where("state", "=", "running")
    .execute();
}

/** The running delete of a whole project, if any. */
export async function runningProjectRun(db: Db, projectId: string): Promise<RunRow | undefined> {
  return db
    .selectFrom("delete_run")
    .select(RUN_COLUMNS)
    .where("project_id", "=", projectId)
    .where("scope", "=", "project")
    .where("state", "=", "running")
    .executeTakeFirst();
}
