import { sql } from "kysely";
import { z } from "zod";
import { defineJob } from "./definition.ts";

/**
 * Deletes finished jobs (succeeded or failed) older than the given number of days, so the job
 * table stays small. Safe to repeat.
 */
export const pruneFinishedJobs = defineJob({
  kind: "maintenance.prune-finished-jobs",
  payload: z.object({
    olderThanDays: z.number().int().min(1).max(365),
  }),
  maxAttempts: 3,
  lane: "schedule",
  async run({ olderThanDays }, { db, log }) {
    const result = await db
      .deleteFrom("job")
      .where("state", "in", ["succeeded", "failed"])
      .where(
        "finished_at",
        "<",
        sql<Date>`now() - make_interval(days => ${olderThanDays}::integer)`,
      )
      .executeTakeFirst();
    log.info("pruned finished jobs", { deleted: Number(result.numDeletedRows), olderThanDays });
  },
});
