import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import type { MigrationPhase, ServerMoveState, ServiceMoveState } from "./tables.ts";
import "./tables.ts";

/**
 * Where the move stands, for `nearzero migrate status` and the installer's progress lines
 * ("web on prod-1: moved"). Names only; nothing secret.
 */

export interface ServiceMoveView {
  serviceId: string;
  service: string;
  server: string;
  state: ServiceMoveState;
  reason: string | null;
  /**
   * Whether a moved service has a running container by its server's latest report (spec 29.5:
   * status reports what actually runs); null when its server hasn't reported lately.
   */
  running: boolean | null;
}

/** A runner's report this old says nothing about what runs now. */
const REPORT_FRESH_MS = 3 * 60_000;

interface ReportedContainer {
  state?: unknown;
  service?: unknown;
}

/** Per server ("host" or its id): the services with a running container, by the latest report. */
async function runningByServer(db: Db): Promise<Map<string, Set<string>>> {
  const rows = await db
    .selectFrom("runner")
    .select(["server_id", "containers", "containers_at"])
    .where("revoked_at", "is", null)
    .where("containers_at", ">", new Date(Date.now() - REPORT_FRESH_MS))
    .execute();
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const list = (Array.isArray(row.containers) ? row.containers : []) as ReportedContainer[];
    const running = new Set<string>();
    for (const item of list) {
      if (item?.state === "running" && typeof item.service === "string") running.add(item.service);
    }
    const key = row.server_id ?? "host";
    out.set(key, new Set([...(out.get(key) ?? []), ...running]));
  }
  return out;
}

export interface MigrationStatus {
  phase: MigrationPhase | "none";
  sourceVersion: string | null;
  importedAt: string | null;
  finalizedAt: string | null;
  servers: { target: string; server: string; state: ServerMoveState; reason: string | null }[];
  services: ServiceMoveView[];
  counts: Record<ServiceMoveState, number>;
}

export async function migrationStatus(db: Db): Promise<MigrationStatus> {
  const state = await db.selectFrom("migration_state").selectAll().executeTakeFirst();
  const latest = await db
    .selectFrom("migration_import")
    .select(["source_version", "imported_at"])
    .orderBy("imported_at", "desc")
    .executeTakeFirst();
  const servers = await db
    .selectFrom("migration_server_move as m")
    .leftJoin("server as s", (join) => join.on(sql<boolean>`s.id::text = m.target`))
    .select(["m.target", "m.state", "m.reason", "s.name"])
    .orderBy("m.position")
    .execute();
  const services = await db
    .selectFrom("migration_move as m")
    .innerJoin("service as s", "s.id", "m.service_id")
    .leftJoin("server as v", "v.id", "s.server_id")
    .select([
      "m.service_id",
      "m.state",
      "m.reason",
      "s.name",
      "s.server_id",
      "v.name as server_name",
    ])
    .orderBy("m.position")
    .execute();
  const counts: Record<ServiceMoveState, number> = {
    waiting: 0,
    moving: 0,
    moved: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of services) counts[row.state]++;
  const reported = await runningByServer(db);
  return {
    phase: state?.phase ?? "none",
    sourceVersion: latest?.source_version ?? null,
    importedAt: latest?.imported_at.toISOString() ?? null,
    finalizedAt: state?.finalized_at?.toISOString() ?? null,
    servers: servers.map((row) => ({
      target: row.target,
      server: row.target === "host" ? "the Nearzero host" : (row.name ?? row.target),
      state: row.state,
      reason: row.reason,
    })),
    services: services.map((row) => ({
      serviceId: row.service_id,
      service: row.name,
      server: row.server_name ?? "the Nearzero host",
      state: row.state,
      reason: row.reason,
      running:
        row.state === "moved"
          ? (reported.get(row.server_id ?? "host")?.has(row.service_id) ??
            (reported.has(row.server_id ?? "host") ? false : null))
          : null,
    })),
    counts,
  };
}

/** One line per finished service, as the installer prints them. */
export function serviceLine(
  view: Pick<ServiceMoveView, "service" | "server" | "state" | "reason"> & {
    running?: boolean | null;
  },
): string {
  const where = `${view.service} on ${view.server}`;
  if (view.state === "moved" && view.running === false) {
    return `${where}: moved, but nothing of it is running now`;
  }
  if (view.state === "moved") return `${where}: moved`;
  if (view.state === "failed") return `${where}: failed: ${view.reason ?? "unknown reason"}`;
  if (view.state === "skipped")
    return `${where}: not moved: ${view.reason ?? "it wasn't deployed"}`;
  return `${where}: ${view.state === "moving" ? "moving" : "waiting"}`;
}

export function statusText(status: MigrationStatus): string[] {
  if (status.phase === "none") {
    return [
      "Nothing was imported on this server. Move a 0.1.x install with: sudo nearzero import <file>",
    ];
  }
  const lines: string[] = [];
  lines.push(
    `Imported from Nearzero ${status.sourceVersion ?? "0.1.x"}${status.importedAt ? ` on ${status.importedAt.slice(0, 10)}` : ""}.`,
  );
  const { counts } = status;
  const total = counts.waiting + counts.moving + counts.moved + counts.failed;
  if (status.phase === "finalized") {
    lines.push(
      `The move is finalized${status.finalizedAt ? ` (${status.finalizedAt.slice(0, 10)})` : ""}: the 0.1.x data is deleted, so it can't be rolled back.`,
    );
  } else if (counts.waiting + counts.moving > 0) {
    lines.push(
      `Moving services onto the 1.0 runner: ${counts.moved} of ${total} moved${counts.failed ? `, ${counts.failed} failed` : ""}.`,
    );
  } else {
    lines.push(
      `${counts.moved} of ${total} services moved${counts.failed ? `, ${counts.failed} failed` : ""}.`,
    );
  }
  for (const server of status.servers.filter((item) => item.state === "failed")) {
    lines.push(`  ${server.server}: couldn't be prepared: ${server.reason ?? "unknown reason"}`);
  }
  for (const service of status.services) lines.push(`  ${serviceLine(service)}`);
  // What runs, by each server's latest report (spec 29.5), not only what the move recorded.
  const stopped = status.services.filter(
    (item) => item.state === "moved" && item.running === false,
  );
  if (stopped.length > 0) {
    lines.push(
      "",
      `${stopped.length === 1 ? "A moved service isn't" : `${stopped.length} moved services aren't`} running now: ${stopped.map((item) => item.service).join(", ")}. Start or redeploy ${stopped.length === 1 ? "it" : "them"} from the console.`,
    );
  }
  if (status.phase !== "finalized") {
    if (counts.failed > 0) {
      lines.push(
        "",
        "Services that failed keep running on 0.1.x. Fix the cause, then run: sudo nearzero migrate retry",
      );
    }
    if (counts.waiting + counts.moving === 0) {
      lines.push(
        "",
        "To go back to 0.1.x: sudo nearzero migrate rollback",
        "When everything works, delete the 0.1.x data: sudo nearzero migrate finalize",
      );
    }
  }
  return lines;
}

/** Marks the move finalized; false when it already was or nothing was imported. */
export async function markFinalized(db: Db): Promise<boolean> {
  const result = await db
    .updateTable("migration_state")
    .set({ phase: "finalized", finalized_at: new Date(), updated_at: new Date() })
    .where("phase", "<>", "finalized")
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}
