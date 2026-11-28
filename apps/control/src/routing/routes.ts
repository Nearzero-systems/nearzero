import { AppError, type RouteSpec, type RouteSpecInput, routeSpecSchema } from "@nearzero/shared";
import { sql } from "kysely";
import { check } from "../http/validate.ts";
import type { ControlServices } from "../services.ts";

/**
 * Router routes (spec 10.1, 10.2, 10.7): which hostnames reach which container port on a server.
 * The runner writes them as router files; the control plane keeps the list so a server that was
 * set up again, or a runner that lost its files, gets every route back on its next connection.
 *
 * Writing is all or nothing (spec 24 P7): the route is saved only after the server's runner wrote
 * its file, so a route never exists on paper only. Later milestones (deploys, domains) call these
 * functions; the HTTP endpoints for them are for instance administrators.
 */

export interface RouteView extends RouteSpec {
  target: string;
  writtenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: {
  target: string;
  spec: unknown;
  written_at: Date | null;
  created_at: Date;
  updated_at: Date;
}): RouteView {
  const spec = routeSpecSchema.parse(row.spec);
  return {
    ...spec,
    target: row.target,
    writtenAt: row.written_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listRoutes(services: ControlServices, target: string): Promise<RouteView[]> {
  const rows = await services.db
    .selectFrom("router_route")
    .select(["target", "spec", "written_at", "created_at", "updated_at"])
    .where("target", "=", target)
    .orderBy("key")
    .execute();
  return rows.map(toView);
}

/** Writes a route on the target's router, then saves it. */
export async function upsertRoute(
  services: ControlServices,
  target: string,
  input: RouteSpecInput,
): Promise<RouteView> {
  const spec = check(routeSpecSchema, input);
  const clash = await services.db
    .selectFrom("router_route")
    .select(["target", "key", "hostnames"])
    .where(sql<boolean>`hostnames && ${sql.val(spec.hostnames)}::text[]`)
    // One hostname may have routes for different paths on the same server (the console and its
    // runner gateway, for instance), never the same path twice, and never two servers.
    .where((eb) =>
      eb.or([
        eb("target", "<>", target),
        eb.and([eb("key", "<>", spec.key), sql<boolean>`spec->>'path' = ${spec.path}`]),
      ]),
    )
    .executeTakeFirst();
  if (clash) {
    const host = spec.hostnames.find((name) => clash.hostnames.includes(name)) ?? spec.hostnames[0];
    throw new AppError(
      "conflict",
      `${host} already routes somewhere else on this Nearzero. Remove it there first.`,
      { fields: { hostnames: `${host} is already in use.` } },
    );
  }
  await services.runners.command(target, "router.write", { routes: [spec] }, { timeoutMs: 30_000 });
  const row = await services.db
    .insertInto("router_route")
    .values({
      target,
      key: spec.key,
      hostnames: spec.hostnames,
      spec: JSON.stringify(spec),
      written_at: new Date(),
    })
    .onConflict((conflict) =>
      conflict.columns(["target", "key"]).doUpdateSet({
        hostnames: spec.hostnames,
        spec: JSON.stringify(spec),
        written_at: new Date(),
        updated_at: new Date(),
      }),
    )
    .returning(["target", "spec", "written_at", "created_at", "updated_at"])
    .executeTakeFirstOrThrow();
  return toView(row);
}

/** Removes a route from the target's router, then forgets it. */
export async function removeRoute(
  services: ControlServices,
  target: string,
  key: string,
): Promise<boolean> {
  const existing = await services.db
    .selectFrom("router_route")
    .select("id")
    .where("target", "=", target)
    .where("key", "=", key)
    .executeTakeFirst();
  if (!existing) return false;
  await services.runners.command(target, "router.remove", { keys: [key] }, { timeoutMs: 30_000 });
  await services.db.deleteFrom("router_route").where("id", "=", existing.id).execute();
  return true;
}

/** Gives a freshly connected runner every route it should have (and removes stale ones). */
export async function syncRoutes(services: ControlServices, target: string): Promise<void> {
  const routes = (await listRoutes(services, target)).map(
    ({ key, hostnames, path, upstream, certificate, accessLog }) => ({
      key,
      hostnames,
      path,
      upstream,
      certificate,
      accessLog,
    }),
  );
  await services.runners.command(target, "router.sync", { routes }, { timeoutMs: 120_000 });
}
