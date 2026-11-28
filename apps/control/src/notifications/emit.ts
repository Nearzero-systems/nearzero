import { VERSION } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import type { Logger } from "../log.ts";
import { firstWorkspaceId } from "../workspaces/workspaces.ts";
import { recordEvent } from "./outbox.ts";

/**
 * Events other areas finish with (spec 15.3): "Deploy succeeded" and "Deploy failed" when a
 * deployment ends, and "Nearzero restart" when the control plane starts after a stop or a
 * crash. Backups and the Docker cleanup write theirs themselves (backups/events.ts,
 * server-setup/cleanup.ts); server alerts come from monitoring/alerts.ts.
 */

function addressOf(host: string, path: string): string {
  const plain = /\.(localhost|local|test)$/.test(host) || /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  return `${plain ? "http" : "https"}://${host}${path === "/" ? "" : path}`;
}

/**
 * Writes the deploy's event once it ended as Active or Failed. Safe to call again: the event's
 * key is the deployment and its outcome.
 */
export async function emitDeployEvent(db: Db, log: Logger, deploymentId: string): Promise<void> {
  const row = await db
    .selectFrom("deployment")
    .select([
      "id",
      "workspace_id",
      "service_id",
      "service_name",
      "service_kind",
      "project_name",
      "environment_name",
      "status",
      "commit_hash",
      "error",
      "finished_at",
    ])
    .where("id", "=", deploymentId)
    .executeTakeFirst();
  if (!row || (row.status !== "active" && row.status !== "failed")) return;
  const succeeded = row.status === "active";
  let address: string | null = null;
  // Every hostname of the service, own ones first, each once: a custom webhook's `domains`
  // lists them all the way 0.1.x did (R3-37).
  let hostnames: string[] = [];
  if (succeeded && row.service_id) {
    const hosts = await db
      .selectFrom("hostname")
      .select(["host", "path"])
      .where("service_id", "=", row.service_id)
      .orderBy("automatic")
      .orderBy("created_at")
      .orderBy("host")
      .execute();
    const first = hosts[0];
    if (first) address = addressOf(first.host, first.path);
    hostnames = [...new Set(hosts.map((host) => host.host))];
  }
  await recordEvent(db, log, {
    workspaceId: row.workspace_id,
    event: succeeded ? "deploy.succeeded" : "deploy.failed",
    dedupeKey: `deploy:${row.id}:${row.status}`,
    payload: {
      deploymentId: row.id,
      service: { id: row.service_id, name: row.service_name, kind: row.service_kind },
      project: row.project_name,
      environment: row.environment_name,
      commit: row.commit_hash,
      address,
      hostnames,
      // The engine's own failure line ("Deployment failed: …"); never a variable's value.
      error: succeeded ? null : (row.error ?? "The deploy failed."),
      finishedAt: new Date(row.finished_at ?? Date.now()).toISOString(),
    },
  });
}

/**
 * Records this start and, when an earlier start exists, writes "Nearzero restart" for the first
 * workspace (the instance administrators', spec 15.3, 22.2). Returns the start's id, which the
 * clean stop marks.
 */
export async function recordStart(db: Db, log: Logger): Promise<number | null> {
  try {
    const previous = await db
      .selectFrom("control_plane_start")
      .select(["id", "stopped_at"])
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    const current = await db
      .insertInto("control_plane_start")
      .values({ version: VERSION })
      .returning(["id", "started_at"])
      .executeTakeFirstOrThrow();
    // Old starts beyond the last 50 aren't needed.
    await db
      .deleteFrom("control_plane_start")
      .where("id", "<", sql<number>`${current.id} - 50`)
      .execute();
    const first = await firstWorkspaceId(db);
    if (previous && first) {
      await recordEvent(db, log, {
        workspaceId: first,
        event: "nearzero.restart",
        dedupeKey: `nearzero-restart:${current.id}`,
        payload: {
          version: VERSION,
          startedAt: new Date(current.started_at).toISOString(),
          after: previous.stopped_at ? "stop" : "crash",
        },
      });
    }
    return current.id;
  } catch (error) {
    log.warn("couldn't record this start", { error });
    return null;
  }
}

/** A clean stop: the next start says "after a stop", not "after a crash". */
export async function recordStop(db: Db, startId: number | null): Promise<void> {
  if (startId === null) return;
  await db
    .updateTable("control_plane_start")
    .set({ stopped_at: sql<Date>`now()` })
    .where("id", "=", startId)
    .execute()
    .catch(() => {});
}
