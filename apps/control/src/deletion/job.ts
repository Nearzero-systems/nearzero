import type { ServiceKind, ServiceStatus } from "@nearzero/shared";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { defineJob } from "../jobs/definition.ts";
import type { Logger } from "../log.ts";
import { pruneScopes } from "../projects/scope.ts";
import { DEPLOYING_REFUSAL } from "./plan.ts";
import { REMOVE_SERVICES_JOB } from "./runs.ts";
import { RUN_COLUMNS, type RunRow } from "./state.ts";
import type { ServiceTeardown, TeardownResult } from "./teardown.ts";

/**
 * The background half of a delete: removes each service from its server through the teardown,
 * deletes its records once it is gone, and for a whole project deletes the project only when
 * every service was removed (otherwise "The project was kept", with the reason per service).
 *
 * Safe to repeat: services already removed are skipped, and one left "removing" by a stopped
 * process is torn down again (teardowns are safe to repeat too).
 */

const payload = z.object({ runId: z.string().regex(/^[0-9a-f-]{36}$/) });

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return `Removing it failed: ${text || "no reason was given"}. Try the delete again.`;
}

async function auditFinished(db: Db, log: Logger, run: RunRow, removed: string[], kept: boolean) {
  const person = run.requested_by
    ? await db
        .selectFrom("person")
        .select("email")
        .where("id", "=", run.requested_by)
        .executeTakeFirst()
    : undefined;
  await recordAudit(
    db,
    log,
    { kind: "person", personId: run.requested_by, label: person?.email ?? null },
    {
      action: run.scope === "project" && !kept ? "project.deleted" : "service.deleted",
      workspaceId: run.workspace_id,
      target:
        run.scope === "project" && !kept
          ? { kind: "project", id: run.project_id }
          : { kind: "delete-run", id: run.id },
      details: { project: run.project_name, runId: run.id, removed, kept },
    },
  );
}

export async function carryOutRun(
  db: Db,
  log: Logger,
  teardown: ServiceTeardown,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const run = await db
    .selectFrom("delete_run")
    .select(RUN_COLUMNS)
    .where("id", "=", runId)
    .executeTakeFirst();
  if (run?.state !== "running") return;

  const items = await db
    .selectFrom("delete_run_item")
    .select(["service_id", "state", "stop_first", "service_name"])
    .where("run_id", "=", run.id)
    .orderBy("position")
    .execute();

  for (const item of items) {
    if (item.state === "removed" || item.state === "not_removed") continue;
    if (signal.aborted)
      throw new Error("The control plane is stopping; the delete resumes when it starts again.");
    await db
      .updateTable("delete_run_item")
      .set({ state: "removing" })
      .where("run_id", "=", run.id)
      .where("service_id", "=", item.service_id)
      .execute();

    const service = await db
      .selectFrom("service")
      .select([
        "id",
        "workspace_id",
        "project_id",
        "environment_id",
        "kind",
        "name",
        "app_name",
        "server_id",
        "status",
        "settings",
        "deleting_run_id",
      ])
      .where("id", "=", item.service_id)
      .executeTakeFirst();

    const finish = async (state: "removed" | "not_removed", reason: string | null) => {
      await db
        .updateTable("delete_run_item")
        .set({ state, reason })
        .where("run_id", "=", run.id)
        .where("service_id", "=", item.service_id)
        .execute();
    };

    if (!service) {
      // Already gone (an earlier attempt removed it after recording nothing).
      await finish("removed", null);
      continue;
    }
    if (service.deleting_run_id !== run.id) {
      await finish("not_removed", "Another delete took this service over. Check that one.");
      continue;
    }
    if (service.status === "deploying") {
      await db
        .updateTable("service")
        .set({ deleting_run_id: null })
        .where("id", "=", service.id)
        .execute();
      await finish("not_removed", `A deployment started. ${DEPLOYING_REFUSAL}`);
      continue;
    }

    let result: TeardownResult;
    try {
      result = await teardown.remove(
        {
          serviceId: service.id,
          workspaceId: service.workspace_id,
          projectId: service.project_id,
          environmentId: service.environment_id,
          kind: service.kind as ServiceKind,
          name: service.name,
          appName: service.app_name,
          serverId: service.server_id,
          status: service.status as ServiceStatus,
          settings: service.settings ?? {},
        },
        { stopFirst: service.status === "running" || item.stop_first, removeVolumes: true, signal },
      );
    } catch (error) {
      if (signal.aborted) throw error;
      log.warn("a service teardown failed", { serviceId: service.id, error });
      result = { removed: false, reason: reasonOf(error) };
    }

    if (!result.removed) {
      await db
        .updateTable("service")
        .set({ deleting_run_id: null })
        .where("id", "=", service.id)
        .execute();
      await finish("not_removed", result.reason);
      continue;
    }
    await db.transaction().execute(async (trx) => {
      // Its variables go with it (they cascade).
      await trx.deleteFrom("service").where("id", "=", service.id).execute();
      await pruneScopes(trx, service.workspace_id, { services: [service.id] });
      // A removed service keeps a note only when something was left for the person to do.
      const notes = result.removed && result.notes?.length ? result.notes.join(" ") : null;
      await trx
        .updateTable("delete_run_item")
        .set({ state: "removed", reason: notes })
        .where("run_id", "=", run.id)
        .where("service_id", "=", service.id)
        .execute();
    });
  }

  const results = await db
    .selectFrom("delete_run_item")
    .select(["service_id", "state"])
    .where("run_id", "=", run.id)
    .execute();
  const removed = results.filter((row) => row.state === "removed").map((row) => row.service_id);
  const everyRemoved = removed.length === results.length;

  let kept = true;
  if (run.scope === "project" && everyRemoved) {
    kept = await db.transaction().execute(async (trx) => {
      const left = await trx
        .selectFrom("service")
        .select("id")
        .where("project_id", "=", run.project_id)
        .executeTakeFirst();
      if (left) return true;
      const environments = await trx
        .selectFrom("environment")
        .select("id")
        .where("project_id", "=", run.project_id)
        .execute();
      // Environments and their shared variables cascade with the project.
      await trx.deleteFrom("project").where("id", "=", run.project_id).execute();
      await pruneScopes(trx, run.workspace_id, {
        projects: [run.project_id],
        environments: environments.map((row) => row.id),
      });
      return false;
    });
  }
  const succeeded = everyRemoved && (run.scope === "services" || !kept);
  await db
    .updateTable("delete_run")
    .set({ state: succeeded ? "succeeded" : "failed", finished_at: sql<Date>`now()` })
    .where("id", "=", run.id)
    .where("state", "=", "running")
    .execute();
  await auditFinished(db, log, run, removed, kept);
}

/** The job kind, with the teardown it uses (the real one arrives with servers and the runner). */
export function removeServicesJob(teardown: ServiceTeardown) {
  return defineJob({
    kind: REMOVE_SERVICES_JOB,
    payload,
    maxAttempts: 10,
    lane: "delete",
    async run({ runId }, { db, log, signal }) {
      await carryOutRun(db, log, teardown, runId, signal);
    },
  });
}
