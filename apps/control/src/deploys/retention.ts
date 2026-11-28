import { DEPLOYMENTS_KEPT_PER_SERVICE, REMOVED_DEPLOYMENTS_KEPT_DAYS } from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import type { Db } from "../db/database.ts";
import { defineJob } from "../jobs/definition.ts";
import { JobQueue } from "../jobs/queue.ts";
import { recoverQueue } from "./queue.ts";

/**
 * Deployment retention (spec 11.3), hourly: each service keeps its newest 50 deployments and
 * their logs; a deleted service's rows ("removed") go after 30 days; a deleted server's rows go
 * with it. The same run starts waiting deployments a stopped control plane left without a job.
 */

export async function pruneDeployments(db: Db): Promise<{ deleted: number; recovered: number }> {
  const beyond = await db
    .deleteFrom("deployment")
    .where("id", "in", (eb) =>
      eb
        .selectFrom(
          eb
            .selectFrom("deployment")
            .select([
              "id",
              "status",
              sql<number>`row_number() over (partition by service_id order by created_at desc)`.as(
                "rank",
              ),
            ])
            .where("service_id", "is not", null)
            .as("ranked"),
        )
        .select("ranked.id")
        .where("ranked.rank", ">", DEPLOYMENTS_KEPT_PER_SERVICE)
        .where("ranked.status", "not in", ["queued", "building", "active", "not_running"]),
    )
    .executeTakeFirst();
  const removed = await db
    .deleteFrom("deployment")
    .where("status", "=", "removed")
    .where(
      "removed_at",
      "<",
      sql<Date>`now() - make_interval(days => ${REMOVED_DEPLOYMENTS_KEPT_DAYS}::integer)`,
    )
    .executeTakeFirst();
  const orphaned = await db
    .deleteFrom("deployment")
    .where("server_id", "is not", null)
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("server")
            .select("server.id")
            .whereRef("server.id", "=", "deployment.server_id"),
        ),
      ),
    )
    .where("service_id", "is", null)
    .executeTakeFirst();
  const recovered = await recoverQueue(db);
  return {
    deleted:
      Number(beyond.numDeletedRows) +
      Number(removed.numDeletedRows) +
      Number(orphaned.numDeletedRows),
    recovered,
  };
}

export const pruneDeploymentsJob = defineJob({
  kind: "deploys.prune",
  payload: z.object({}),
  maxAttempts: 3,
  lane: "schedule",
  async run(_payload, { db, log }) {
    try {
      const result = await pruneDeployments(db);
      log.info("pruned deployments", result);
    } finally {
      // The next hour is booked even when this one failed, so the chain never breaks (B1-13).
      await scheduleDeploymentPruning(db, 60 * 60_000);
    }
  },
});

export async function scheduleDeploymentPruning(db: Db, delayMs = 0): Promise<void> {
  const due = new Date(Date.now() + delayMs);
  await new JobQueue(db, { workerId: "scheduler" }).add(
    pruneDeploymentsJob,
    {},
    { delayMs, idempotencyKey: `prune-deployments:${due.toISOString().slice(0, 13)}` },
  );
}
