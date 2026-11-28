import { AppError, HOST_SERVER_ID, PUBLIC_PORT_RANGE } from "@nearzero/shared";
import { sql } from "kysely";
import { notFound } from "../access/grants.ts";
import { composePublishedPorts } from "../compose-runtime/plan.ts";
import type { Db } from "../db/database.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import { isOurId } from "../projects/objects.ts";
import { readAppSettings } from "../service-runtime/app-settings.ts";
import { appNameSuffix } from "./generate.ts";

/**
 * Where a service runs and what it takes there: the server (the Nearzero host or one of the
 * workspace's servers), a unique internal app name, and for databases a public port that no
 * other service on the same server uses (spec 06 6.1, spec 08 8.1).
 */

/** The stored server id: null is the Nearzero host. */
export type Placement = string | null;

export function serverIdOut(serverId: Placement): string {
  return serverId ?? HOST_SERVER_ID;
}

/**
 * Checks the person may put a service on this server and returns where it goes. The Nearzero
 * host is for instance administrators (spec 22.2, spec 24 G3). Other servers must be in the
 * workspace and in the person's reach; they are resolved through the permission module, so
 * until the servers milestone registers them every server id is "not found".
 */
export async function choosePlacement(actor: WorkspaceActor, serverId: string): Promise<Placement> {
  if (serverId === HOST_SERVER_ID) {
    await actor.access.require("host.use");
    return null;
  }
  // Server ids are uuids like every other id; anything else can't be one of them.
  if (!isOurId(serverId)) throw notFound("server");
  await actor.access.require("server.see", { kind: "server", id: serverId });
  return serverId;
}

const MAX_SUFFIX_TRIES = 8;

export const DUPLICATE_APP_NAME = "Service with this app name already exists";

/** `<base>-<6 random characters>`, not used by any service on the install. */
export async function uniqueAppName(db: Db, base: string): Promise<string> {
  for (let attempt = 0; attempt < MAX_SUFFIX_TRIES; attempt++) {
    const candidate = `${base}-${appNameSuffix()}`;
    const taken = await db
      .selectFrom("service")
      .select("id")
      .where("app_name", "=", candidate)
      .executeTakeFirst();
    if (!taken) return candidate;
  }
  throw new AppError("conflict", DUPLICATE_APP_NAME, { fields: { appName: DUPLICATE_APP_NAME } });
}

export const NO_FREE_PORT_NOTE = `No free port between ${PUBLIC_PORT_RANGE.first} and ${PUBLIC_PORT_RANGE.last} on this server, so it was created private. Free a port, then make it public.`;

/**
 * The lowest free public port on a server, or null when the range is full. Run inside the
 * transaction that inserts the service: a per-server lock keeps two creates from taking the same
 * port, and the database's unique index backs that up.
 */
export async function allocatePublicPort(
  db: Db,
  placement: Placement,
  range: { first: number; last: number } = PUBLIC_PORT_RANGE,
): Promise<number | null> {
  const key = placement ?? HOST_SERVER_ID;
  await sql`select pg_advisory_xact_lock(hashtext('public-port'), hashtext(${key}))`.execute(db);
  let query = db.selectFrom("service").select(["kind", "app_name", "settings", "public_port"]);
  query =
    placement === null
      ? query.where("server_id", "is", null)
      : query.where("server_id", "=", placement);
  // Every port published on the server counts: databases' public ports, and the TCP ports apps
  // and Compose files publish (B1-29), so a new database never clashes with them.
  const taken = new Set<number>();
  for (const row of await query.execute()) {
    if (row.public_port !== null) taken.add(row.public_port);
    if (row.kind === "application") {
      for (const port of readAppSettings(row.settings).ports) {
        if (port.protocol === "tcp") taken.add(port.publishedPort);
      }
    } else if (row.kind === "compose") {
      for (const port of composePublishedPorts(row.settings, row.app_name)) {
        if (port.protocol === "tcp") taken.add(port.port);
      }
    }
  }
  for (let port = range.first; port <= range.last; port++) {
    if (!taken.has(port)) return port;
  }
  return null;
}
