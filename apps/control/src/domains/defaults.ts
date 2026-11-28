import { AppError, checkNamePrefix } from "@nearzero/shared";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import type { ControlServices } from "../services.ts";
import type { HostnameRow } from "./hostnames.ts";

/**
 * Where an environment's apps get automatic hostnames (spec 10.8, Environment defaults): the
 * platform domain, no automatic hostname, or a managed zone, with an optional name prefix. An
 * environment without a saved choice uses the workspace's first zone (the first zone connected
 * becomes every environment's default and takes priority over the platform domain), otherwise
 * the platform domain.
 */

export interface ZoneRef {
  id: string;
  name: string;
}

export type EffectiveDefault =
  | { source: "platform"; zone: null; prefix: string; saved: boolean }
  | { source: "none"; zone: null; prefix: string; saved: boolean }
  | { source: "zone"; zone: ZoneRef; prefix: string; saved: boolean };

export async function workspaceZones(db: Db, workspaceId: string): Promise<ZoneRef[]> {
  return db
    .selectFrom("dns_zone")
    .select(["id", "name"])
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at")
    .orderBy("name")
    .execute();
}

export async function effectiveDefaults(
  services: ControlServices,
  workspaceId: string,
  environmentIds: readonly string[],
): Promise<Map<string, EffectiveDefault>> {
  const out = new Map<string, EffectiveDefault>();
  if (environmentIds.length === 0) return out;
  const [rows, zones] = await Promise.all([
    services.db
      .selectFrom("environment_hostname_default as d")
      .leftJoin("dns_zone as z", "z.id", "d.zone_id")
      .select(["d.environment_id", "d.source", "d.zone_id", "d.prefix", "z.name as zone_name"])
      .where("d.workspace_id", "=", workspaceId)
      .where("d.environment_id", "in", [...environmentIds])
      .execute(),
    workspaceZones(services.db, workspaceId),
  ]);
  const saved = new Map(rows.map((row) => [row.environment_id, row]));
  const first = zones[0] ?? null;
  for (const id of environmentIds) {
    const row = saved.get(id);
    if (row?.source === "zone" && row.zone_id && row.zone_name) {
      out.set(id, {
        source: "zone",
        zone: { id: row.zone_id, name: row.zone_name },
        prefix: row.prefix,
        saved: true,
      });
    } else if (row?.source === "platform" || row?.source === "none") {
      out.set(id, { source: row.source, zone: null, prefix: row.prefix, saved: true });
    } else if (first) {
      out.set(id, { source: "zone", zone: first, prefix: "", saved: false });
    } else {
      out.set(id, { source: "platform", zone: null, prefix: "", saved: false });
    }
  }
  return out;
}

export async function effectiveDefault(
  services: ControlServices,
  workspaceId: string,
  environmentId: string,
): Promise<EffectiveDefault> {
  return (await effectiveDefaults(services, workspaceId, [environmentId])).get(
    environmentId,
  ) as EffectiveDefault;
}

// ---- The Environment defaults tab (spec 10.8)

export const NO_ZONE_LABEL = "No zone (apps get no automatic hostname)";
export const PLATFORM_LABEL = "Platform domain";

function sourceLabel(choice: EffectiveDefault): string {
  if (choice.source === "zone") return choice.zone.name;
  return choice.source === "none" ? NO_ZONE_LABEL : PLATFORM_LABEL;
}

export async function listDefaults(services: ControlServices, actor: WorkspaceActor) {
  await actor.access.require("dns.manage");
  const environments = await services.db
    .selectFrom("environment as e")
    .innerJoin("project as p", "p.id", "e.project_id")
    .select(["e.id", "e.name", "e.project_id", "p.name as project_name"])
    .where("e.workspace_id", "=", actor.workspace.id)
    .orderBy("p.name")
    .orderBy("e.name")
    .execute();
  const choices = await effectiveDefaults(
    services,
    actor.workspace.id,
    environments.map((e) => e.id),
  );
  const zones = await workspaceZones(services.db, actor.workspace.id);
  return {
    defaults: environments.map((env) => {
      const choice = choices.get(env.id) as EffectiveDefault;
      return {
        projectId: env.project_id,
        projectName: env.project_name,
        environmentId: env.id,
        environmentName: env.name,
        source: choice.source === "zone" ? choice.zone.id : choice.source,
        sourceLabel: sourceLabel(choice),
        prefix: choice.prefix,
        saved: choice.saved,
      };
    }),
    options: [
      ...(services.domains.platformDomain ? [{ value: "platform", label: PLATFORM_LABEL }] : []),
      { value: "none", label: NO_ZONE_LABEL },
      ...zones.map((zone) => ({ value: zone.id, label: zone.name })),
    ],
    prefixHint: `With "staging", apps get web.staging.${zones[0]?.name ?? "example.com"}`,
  };
}

export async function updateDefault(
  services: ControlServices,
  actor: WorkspaceActor,
  environmentId: string,
  input: { source: string; prefix: string },
) {
  await actor.access.require("dns.manage");
  const env = /^[0-9a-f-]{36}$/.test(environmentId)
    ? await services.db
        .selectFrom("environment")
        .select(["id", "name"])
        .where("id", "=", environmentId)
        .where("workspace_id", "=", actor.workspace.id)
        .executeTakeFirst()
    : undefined;
  if (!env)
    throw new AppError(
      "not_found",
      "This environment doesn't exist in this workspace, or you don't have access to it.",
    );
  const prefix = checkNamePrefix(input.prefix);
  if (!prefix.ok)
    throw new AppError("invalid_request", prefix.message, { fields: { prefix: prefix.message } });
  let source: "platform" | "none" | "zone";
  let zoneId: string | null = null;
  if (input.source === "platform" || input.source === "none") {
    source = input.source;
    if (source === "platform" && !services.domains.platformDomain) {
      const message = "This Nearzero has no platform domain. Pick a zone, or No zone.";
      throw new AppError("invalid_request", message, { fields: { source: message } });
    }
  } else {
    const zone = (await workspaceZones(services.db, actor.workspace.id)).find(
      (item) => item.id === input.source,
    );
    if (!zone) {
      const message = "Pick the platform domain, No zone, or one of this workspace's zones.";
      throw new AppError("invalid_request", message, { fields: { source: message } });
    }
    source = "zone";
    zoneId = zone.id;
  }
  await services.db
    .insertInto("environment_hostname_default")
    .values({
      environment_id: env.id,
      workspace_id: actor.workspace.id,
      source,
      zone_id: zoneId,
      prefix: prefix.prefix,
      updated_by: actor.personId,
    })
    .onConflict((c) =>
      c.column("environment_id").doUpdateSet({
        source,
        zone_id: zoneId,
        prefix: prefix.prefix,
        updated_by: actor.personId,
        updated_at: new Date(),
      }),
    )
    .execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "environment-default.changed",
    workspaceId: actor.workspace.id,
    target: { kind: "environment", id: env.id },
    details: { source, zoneId, prefix: prefix.prefix },
  });
  const { updated, pending } = await updateAutomaticHostnames(services, actor.workspace.id, env.id);
  const message =
    source === "none"
      ? "Saved. Existing automatic hostnames stay until you remove them."
      : pending > 0
        ? `Saved. ${pending} automatic ${pending === 1 ? "hostname updates" : "hostnames update"} on the next deploy.`
        : updated > 0
          ? `Saved and ${updated} automatic ${updated === 1 ? "hostname" : "hostnames"} updated`
          : "Saved";
  return { ...(await listDefaults(services, actor)), message, updated, pending };
}

/**
 * A workspace's first zone becomes the default of every environment without a saved choice
 * (spec 10.8; spec 30 "Decisions, part 2", R3-13), so the automatic hostnames those environments
 * follow move into it at once, as <service>.<zone>, with their records published. Own hostnames
 * and typed ones are never automatic, so they stay. Returns how many moved now, and how many
 * move at their service's next deploy (their server can't be reached now).
 */
export async function followFirstZone(
  services: ControlServices,
  workspaceId: string,
): Promise<{ moved: number; pending: number }> {
  const environments = await services.db
    .selectFrom("environment as e")
    .select("e.id")
    .where("e.workspace_id", "=", workspaceId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("environment_hostname_default as d")
            .select("d.environment_id")
            .whereRef("d.environment_id", "=", "e.id"),
        ),
      ),
    )
    .execute();
  let moved = 0;
  let pending = 0;
  for (const environment of environments) {
    const result = await updateAutomaticHostnames(services, workspaceId, environment.id);
    moved += result.updated;
    pending += result.pending;
  }
  return { moved, pending };
}

/**
 * Moves an environment's automatic hostnames to its default: each one that no longer matches is
 * replaced now when its server can be reached, or at the service's next deploy.
 */
async function updateAutomaticHostnames(
  services: ControlServices,
  workspaceId: string,
  environmentId: string,
) {
  // Loaded here: hostnames.ts reads the defaults too.
  const { assignAutomatic, automaticBase, HOSTNAME_COLUMNS, loadServices, matchesBase, removeRow } =
    await import("./hostnames.ts");
  const { describeTarget } = await import("./addresses.ts");
  const rows = (await services.db
    .selectFrom("hostname as h")
    .innerJoin("service as s", "s.id", "h.service_id")
    .select(HOSTNAME_COLUMNS.map((column) => `h.${column}` as const))
    .where("s.environment_id", "=", environmentId)
    .where("h.workspace_id", "=", workspaceId)
    .where("h.automatic", "=", true)
    .execute()) as HostnameRow[];
  const servicesById = await loadServices(
    services.db,
    workspaceId,
    rows.map((row) => row.service_id as string),
  );
  let updated = 0;
  let pending = 0;
  for (const row of rows) {
    const service = servicesById.get(row.service_id as string);
    if (!service) continue;
    const target = await describeTarget(services, row.target);
    if (!target) continue;
    const base = await automaticBase(services, service, target, false);
    if (base.kind === "none" || matchesBase(row, base, service)) continue;
    if (!services.runners.isOnline(row.target)) {
      await services.db
        .updateTable("hostname")
        .set({ replace_on_deploy: true })
        .where("id", "=", row.id)
        .execute();
      pending++;
      continue;
    }
    try {
      await assignAutomatic(services, service, base, {
        writeRoute: row.route_key !== null,
        createdBy: null,
        composeService: row.compose_service,
        port: row.port,
        path: row.path,
      });
      await removeRow(services, row);
      await services.db
        .deleteFrom("service_hostname_state")
        .where("service_id", "=", service.id)
        .execute();
      updated++;
    } catch {
      await services.db
        .updateTable("hostname")
        .set({ replace_on_deploy: true })
        .where("id", "=", row.id)
        .execute();
      pending++;
    }
  }
  return { updated, pending };
}
