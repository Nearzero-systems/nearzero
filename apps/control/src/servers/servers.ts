import {
  AppError,
  type createServerRequestSchema,
  duplicateServerAddressMessage,
  duplicateServerNameMessage,
  isIPv4,
  labelCandidates,
  SERVER_MESSAGES,
  type ServerReadiness,
  serverLabelBase,
  type updateServerRequestSchema,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { z } from "zod";
import type { AccessTarget, ObjectRegistry } from "../access/objects.ts";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import type { ServerSetupState } from "../db/schema.ts";
import {
  describeTarget,
  forgetServerName,
  isPrivateIPv4,
  publicAddressUser,
} from "../domains/addresses.ts";
import { publishZones } from "../domains/zones.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { isOurId, ourIds } from "../projects/objects.ts";
import { type RunnerView, runnerViews } from "../runners/records.ts";
import type { ControlServices } from "../services.ts";

/**
 * Servers as records (spec 09 9.1, 9.2, 9.4, 9.6): what a person adds, edits and deletes, and
 * how ready each one is. Setting a server up over SSH arrives in a later milestone; a server can
 * already join with the one-line join command, which installs nothing over SSH.
 */

export interface ServerView {
  id: string;
  name: string;
  description: string;
  address: string;
  port: number;
  sshUser: string;
  sshKey: { id: string; name: string } | null;
  /** Its hostnames live under <label>.<platform domain> (spec 10.2). Never changes. */
  label: string;
  hostKeyFingerprint: string | null;
  /** The public IPv4 a person set for it, or null to use its address (spec 10.2, 10.7). */
  publicIPv4: string | null;
  setup: {
    state: ServerSetupState;
    error: string | null;
    startedAt: string | null;
    finishedAt: string | null;
  };
  readiness: ServerReadiness;
  dockerCleanup: boolean;
  runner: RunnerView;
  services: number;
  createdAt: string;
  updatedAt: string;
}

export function serverTarget(id: string): AccessTarget {
  return { kind: "server", id };
}

export function registerServerObjects(registry: ObjectRegistry): void {
  if (registry.has("server")) return;
  registry.register("server", {
    async resolve(db: Db, workspaceId, ids) {
      const wanted = ourIds(ids);
      if (wanted.length === 0) return [];
      const rows = await db
        .selectFrom("server")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("id", "in", wanted)
        .execute();
      return rows.map((row) => serverTarget(row.id));
    },
  });
}

/** A workspace with servers can't be deleted: their runners would be left with no owner. */
export async function serversBlockWorkspaceDeletion(
  db: Db,
  workspaceId: string,
): Promise<string | null> {
  const row = await db
    .selectFrom("server")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  const count = Number(row.count);
  if (count === 0) return null;
  return `Delete this workspace's ${count} ${count === 1 ? "server" : "servers"} first, then try again.`;
}

/** A setup run older than this counts as stalled (spec 9.3). */
const SETUP_STALLED_MS = 5 * 60_000;

export function readinessOf(setup: ServerSetupState, runner: RunnerView): ServerReadiness {
  switch (setup) {
    case "not_started":
      return "setup_needed";
    case "running":
      return "setup_running";
    case "failed":
      return "setup_failed";
    case "ready":
      return runner.state === "online" ? "ready" : "inactive";
  }
}

export function setupStalled(view: ServerView, now = Date.now()): boolean {
  return (
    view.setup.state === "running" &&
    view.setup.startedAt !== null &&
    now - Date.parse(view.setup.startedAt) > SETUP_STALLED_MS
  );
}

async function loadViews(
  services: ControlServices,
  workspaceId: string,
  ids?: string[],
): Promise<ServerView[]> {
  let query = services.db
    .selectFrom("server as s")
    .leftJoin("ssh_key as k", (join) =>
      join.onRef("k.id", "=", "s.ssh_key_id").onRef("k.workspace_id", "=", "s.workspace_id"),
    )
    .select([
      "s.id",
      "s.name",
      "s.description",
      "s.address",
      "s.port",
      "s.ssh_user",
      "s.ssh_key_id",
      "k.name as ssh_key_name",
      "s.label",
      "s.host_key_fingerprint",
      "s.public_ipv4",
      "s.setup_state",
      "s.setup_error",
      "s.setup_started_at",
      "s.setup_finished_at",
      "s.docker_cleanup",
      "s.created_at",
      "s.updated_at",
    ])
    .where("s.workspace_id", "=", workspaceId)
    // Newest first, so a server added a moment ago leads the page (spec 9.1, R3-09).
    .orderBy("s.created_at", "desc")
    .orderBy("s.name");
  if (ids) query = query.where("s.id", "in", ids);
  const rows = await query.execute();
  if (rows.length === 0) return [];
  const serverIds = rows.map((row) => row.id);
  const [runners, counts] = await Promise.all([
    runnerViews(services, serverIds),
    services.db
      .selectFrom("service")
      .select(["server_id", (eb) => eb.fn.countAll<number>().as("count")])
      .where("workspace_id", "=", workspaceId)
      .where("server_id", "in", serverIds)
      .groupBy("server_id")
      .execute(),
  ]);
  return rows.map((row) => {
    const runner = runners.get(row.id) as RunnerView;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      address: row.address,
      port: row.port,
      sshUser: row.ssh_user,
      sshKey: row.ssh_key_name ? { id: row.ssh_key_id, name: row.ssh_key_name } : null,
      label: row.label,
      hostKeyFingerprint: row.host_key_fingerprint,
      publicIPv4: row.public_ipv4,
      setup: {
        state: row.setup_state,
        error: row.setup_error,
        startedAt: row.setup_started_at?.toISOString() ?? null,
        finishedAt: row.setup_finished_at?.toISOString() ?? null,
      },
      readiness: readinessOf(row.setup_state, runner),
      dockerCleanup: row.docker_cleanup,
      runner,
      services: Number(counts.find((count) => count.server_id === row.id)?.count ?? 0),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  });
}

export interface ServerFilter {
  /** Matches name, address, description and SSH user (spec 9.1). */
  search?: string;
  readiness?: ServerReadiness;
}

export async function listServers(
  services: ControlServices,
  actor: WorkspaceActor,
  filter: ServerFilter = {},
): Promise<ServerView[]> {
  const all = await loadViews(services, actor.workspace.id);
  const visible = new Set(
    actor.access.visible(all.map((view) => serverTarget(view.id))).map((t) => t.id),
  );
  const needle = filter.search?.trim().toLowerCase() ?? "";
  return all.filter(
    (view) =>
      visible.has(view.id) &&
      (filter.readiness === undefined || view.readiness === filter.readiness) &&
      (needle === "" ||
        [view.name, view.address, view.description, view.sshUser].some((text) =>
          text.toLowerCase().includes(needle),
        )),
  );
}

export async function getServer(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<ServerView> {
  await actor.access.require("server.see", { kind: "server", id });
  return loadView(services, actor.workspace.id, id);
}

export async function loadView(services: ControlServices, workspaceId: string, id: string) {
  const [view] = await loadViews(services, workspaceId, [id]);
  if (!view) {
    throw new AppError(
      "not_found",
      "This server doesn't exist in this workspace, or you don't have access to it.",
    );
  }
  return view;
}

/**
 * The key must be one of the workspace's. Choosing it in the server forms is part of adding and
 * managing servers, which the callers already checked: "Add and remove servers" covers it
 * without "Use the workspace's SSH keys" (G3-06, spec 9.8).
 */
async function checkKey(services: ControlServices, actor: WorkspaceActor, keyId: string) {
  const found =
    isOurId(keyId) &&
    (await services.db
      .selectFrom("ssh_key")
      .select("id")
      .where("id", "=", keyId)
      .where("workspace_id", "=", actor.workspace.id)
      .executeTakeFirst());
  if (!found) {
    throw new AppError("invalid_request", SERVER_MESSAGES.keyNotFound, {
      fields: { sshKeyId: SERVER_MESSAGES.keyNotFound },
    });
  }
}

async function checkUnique(
  db: Db,
  workspaceId: string,
  input: { name: string; address: string; port: number },
  exceptId?: string,
): Promise<void> {
  let byName = db
    .selectFrom("server")
    .select(["id", "name"])
    .where("workspace_id", "=", workspaceId)
    .where(sql<string>`lower(name)`, "=", input.name.toLowerCase());
  if (exceptId) byName = byName.where("id", "<>", exceptId);
  const sameName = await byName.executeTakeFirst();
  if (sameName) {
    const message = duplicateServerNameMessage(input.name);
    throw new AppError("conflict", message, { fields: { name: message } });
  }
  let byAddress = db
    .selectFrom("server")
    .select(["id", "name"])
    .where("workspace_id", "=", workspaceId)
    .where(sql<string>`lower(address)`, "=", input.address.toLowerCase())
    .where("port", "=", input.port);
  if (exceptId) byAddress = byAddress.where("id", "<>", exceptId);
  const sameAddress = await byAddress.executeTakeFirst();
  if (sameAddress) {
    const message = duplicateServerAddressMessage(sameAddress.name, input.address, input.port);
    throw new AppError("conflict", message, { fields: { address: message } });
  }
}

/** The first free label for a name; run inside the transaction that saves it. */
export async function chooseLabel(db: Db, serverName: string): Promise<string> {
  await sql`select pg_advisory_xact_lock(hashtext('server-label'))`.execute(db);
  const base = serverLabelBase(serverName);
  const taken = new Set(
    (
      await db
        .selectFrom("server")
        .select("label")
        .where((eb) =>
          eb.or([eb("label", "=", base), eb("label", "like", `${base.slice(0, 30)}%`)]),
        )
        .execute()
    ).map((row) => row.label),
  );
  for (const candidate of labelCandidates(base)) {
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("unreachable");
}

function uniqueViolation(error: unknown, input: { name: string; address: string; port: number }) {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (code !== "23505") return null;
  if (constraint === "server_name_idx") {
    const message = duplicateServerNameMessage(input.name);
    return new AppError("conflict", message, { fields: { name: message } });
  }
  if (constraint === "server_address_idx") {
    const message = duplicateServerAddressMessage("Another server", input.address, input.port);
    return new AppError("conflict", message, { fields: { address: message } });
  }
  return null;
}

/**
 * The address hostnames would point at when a server is reached at `address` with no public
 * IPv4 set: the address itself when it is an IPv4 address the internet reaches (spec 10.2).
 */
function effectiveAddress(address: string, publicIPv4: string | null): string | null {
  if (publicIPv4) return publicIPv4;
  return isIPv4(address) && !isPrivateIPv4(address) ? address : null;
}

/**
 * A server's public address can't be another workspace's (B1-15; spec 30, decisions part 2):
 * a hostname counts as pointing at a server when it resolves to the server's address, so a
 * workspace claiming another's address could take names that are really the other's. The
 * other server is never named. The host's address is for people who may use the host (B1-43).
 * Runs inside the transaction that saves the address, under one lock, so two workspaces can't
 * claim one address at once.
 */
async function claimPublicAddress(
  services: ControlServices,
  trx: Db,
  actor: WorkspaceActor,
  ipv4: string,
  field: "address" | "publicIPv4",
): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext('server-public-address'))`.execute(trx);
  const user = await publicAddressUser(services, trx, actor.workspace.id, ipv4);
  const message =
    user === "workspace"
      ? SERVER_MESSAGES.addressOfAnotherWorkspace
      : user === "host" && !actor.access.can("host.use")
        ? SERVER_MESSAGES.addressOfHost
        : null;
  if (message) throw new AppError("conflict", message, { fields: { [field]: message } });
}

export async function createServer(
  services: ControlServices,
  actor: WorkspaceActor,
  input: z.output<typeof createServerRequestSchema>,
): Promise<ServerView> {
  await actor.access.require("servers.add");
  await checkKey(services, actor, input.sshKeyId);
  await checkUnique(services.db, actor.workspace.id, input);
  const claimed = effectiveAddress(input.address, null);
  let id: string;
  try {
    id = await services.db.transaction().execute(async (trx) => {
      if (claimed) await claimPublicAddress(services, trx, actor, claimed, "address");
      const label = await chooseLabel(trx, input.name);
      const row = await trx
        .insertInto("server")
        .values({
          workspace_id: actor.workspace.id,
          name: input.name,
          description: input.description,
          address: input.address,
          port: input.port,
          ssh_user: input.sshUser,
          ssh_key_id: input.sshKeyId,
          label,
          created_by: actor.personId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      // A member who adds a server reaches it: they see its card, set it up and delete it
      // (R3-01). Owners and admins reach every server already.
      if (actor.role === "member") {
        await trx
          .insertInto("member_access")
          .values({ workspace_id: actor.workspace.id, person_id: actor.personId })
          .onConflict((conflict) => conflict.columns(["workspace_id", "person_id"]).doNothing())
          .execute();
        await trx
          .insertInto("access_scope_item")
          .values({
            workspace_id: actor.workspace.id,
            person_id: actor.personId,
            object_kind: "server",
            object_id: row.id,
          })
          .execute();
      }
      await recordAudit(trx, services.log, auditActor(actor), {
        action: "server.added",
        workspaceId: actor.workspace.id,
        target: { kind: "server", id: row.id },
        details: { name: input.name, address: `${input.address}:${input.port}`, label },
      });
      return row.id;
    });
  } catch (error) {
    throw uniqueViolation(error, input) ?? error;
  }
  return loadView(services, actor.workspace.id, id);
}

export async function updateServer(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  input: z.output<typeof updateServerRequestSchema>,
): Promise<{ server: ServerView; notices: string[] }> {
  await actor.access.require("server.manage", { kind: "server", id });
  const current = await loadView(services, actor.workspace.id, id);
  const next = {
    name: input.name ?? current.name,
    address: input.address ?? current.address,
    port: input.port ?? current.port,
  };
  if (input.sshKeyId !== undefined && input.sshKeyId !== current.sshKey?.id) {
    await checkKey(services, actor, input.sshKeyId);
  }
  await checkUnique(services.db, actor.workspace.id, next, id);
  // Another address or port is another machine as far as SSH knows: the host key recorded for
  // the old one is forgotten, and the next setup records the new one (spec 9.2, R3-05).
  const forgetKey =
    current.hostKeyFingerprint !== null &&
    ((input.address !== undefined && input.address !== current.address) ||
      (input.port !== undefined && input.port !== current.port));
  const changes = {
    ...(forgetKey ? { host_key_fingerprint: null } : {}),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.address === undefined ? {} : { address: input.address }),
    ...(input.port === undefined ? {} : { port: input.port }),
    ...(input.sshUser === undefined ? {} : { ssh_user: input.sshUser }),
    ...(input.sshKeyId === undefined ? {} : { ssh_key_id: input.sshKeyId }),
    ...(input.dockerCleanup === undefined ? {} : { docker_cleanup: input.dockerCleanup }),
    ...(input.publicIPv4 === undefined ? {} : { public_ipv4: input.publicIPv4 }),
  };
  const notices: string[] = [];
  if (input.sshUser !== undefined && input.sshUser !== current.sshUser) {
    notices.push(SERVER_MESSAGES.sshUserChanged);
  }
  if (forgetKey) notices.push(SERVER_MESSAGES.hostKeyForgotten);
  // A newly claimed public address is checked against other workspaces' (B1-15).
  const before = effectiveAddress(current.address, current.publicIPv4);
  const after = effectiveAddress(
    next.address,
    input.publicIPv4 === undefined ? current.publicIPv4 : input.publicIPv4,
  );
  const claimed = after !== null && after !== before ? after : null;
  if (Object.keys(changes).length > 0) {
    try {
      await services.db.transaction().execute(async (trx) => {
        if (claimed) {
          const field = input.publicIPv4 ? "publicIPv4" : "address";
          await claimPublicAddress(services, trx, actor, claimed, field);
        }
        await trx
          .updateTable("server")
          .set({ ...changes, updated_at: new Date() })
          .where("id", "=", id)
          .where("workspace_id", "=", actor.workspace.id)
          .execute();
        await recordAudit(trx, services.log, auditActor(actor), {
          action: "server.updated",
          workspaceId: actor.workspace.id,
          target: { kind: "server", id },
          details: changes,
        });
      });
    } catch (error) {
      throw uniqueViolation(error, next) ?? error;
    }
  }
  const addressChanged =
    (input.address !== undefined && input.address !== current.address) ||
    (input.publicIPv4 !== undefined && input.publicIPv4 !== current.publicIPv4);
  if (addressChanged) await afterAddressChange(services, id, current.address);
  return { server: await loadView(services, actor.workspace.id, id), notices };
}

/**
 * A server's address or public IPv4 changed: the managed DNS records of its hostnames follow the
 * new address (spec 10.8, Nearzero manages those records), and its runner hears it for its
 * certificate hold when it reconnects, which it does at once.
 */
async function afterAddressChange(
  services: ControlServices,
  id: string,
  previousAddress: string,
): Promise<void> {
  forgetServerName(services, previousAddress);
  const target = await describeTarget(services, id);
  if (target?.ipv4) {
    const changed = await services.db
      .updateTable("dns_record")
      .set({ value: target.ipv4, updated_at: new Date() })
      .where("managed", "=", true)
      .where("type", "=", "A")
      .where("value", "<>", target.ipv4)
      .where("hostname_id", "in", (eb) =>
        eb.selectFrom("hostname").select("id").where("target", "=", id),
      )
      .returning("zone_id")
      .execute();
    const zones = [...new Set(changed.map((row) => row.zone_id))];
    if (zones.length > 0) {
      await publishZones(services, zones).catch((error: unknown) =>
        services.log.warn("couldn't publish DNS after a server's address changed", { error }),
      );
    }
  }
  services.runners.disconnect(id);
}

/**
 * Deletes a server and revokes its runner. A server with services is refused (spec 9.6); deleting
 * them together arrives with remote-server teardown.
 */
/**
 * What a deleted server leaves under Domains goes with it (spec 23.1 "Teardown is complete",
 * 09 9.6; B1-45, R3-20): its hostnames, with their managed DNS records, and its uploaded
 * certificates with their sealed keys. Returns the zones whose records changed, to publish once
 * the deletion is committed.
 */
export async function forgetServerDomains(db: Db, serverId: string): Promise<string[]> {
  const removed = await db
    .deleteFrom("hostname")
    .where("target", "=", serverId)
    .returning("zone_id")
    .execute();
  await db.deleteFrom("uploaded_certificate").where("target", "=", serverId).execute();
  return [...new Set(removed.map((row) => row.zone_id).filter((zone) => zone !== null))];
}

export async function deleteServer(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  onDeleted: (serverId: string) => Promise<void>,
): Promise<void> {
  await actor.access.require("server.manage", { kind: "server", id });
  const current = await loadView(services, actor.workspace.id, id);
  if (current.services > 0) throw new AppError("conflict", SERVER_MESSAGES.hasServices);
  let zones: string[] = [];
  try {
    await services.db.transaction().execute(async (trx) => {
      zones = await forgetServerDomains(trx, id);
      await trx.deleteFrom("router_route").where("target", "=", id).execute();
      await trx.deleteFrom("server_metric").where("target", "=", id).execute();
      await trx
        .deleteFrom("server")
        .where("id", "=", id)
        .where("workspace_id", "=", actor.workspace.id)
        .execute();
      await recordAudit(trx, services.log, auditActor(actor), {
        action: "server.deleted",
        workspaceId: actor.workspace.id,
        target: { kind: "server", id },
        details: { name: current.name, address: `${current.address}:${current.port}` },
      });
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23503") {
      throw new AppError("conflict", SERVER_MESSAGES.hasServices);
    }
    throw error;
  }
  if (zones.length > 0) await publishZones(services, zones).catch(() => {});
  await onDeleted(id);
}

/**
 * Marks a server that joined with the join command ready once its runner connected with every
 * mandatory check passing. A server set up over SSH is marked by its setup run instead, which
 * also validates what the runner can't see (spec 9.4), so a running or failed setup is left as
 * it is.
 */
export async function markReadyFromRunner(db: Db, serverId: string): Promise<void> {
  await db
    .updateTable("server")
    .set({
      setup_state: "ready",
      setup_error: null,
      setup_finished_at: new Date(),
      updated_at: new Date(),
    })
    .where("id", "=", serverId)
    .where("setup_state", "=", "not_started")
    .execute();
}
