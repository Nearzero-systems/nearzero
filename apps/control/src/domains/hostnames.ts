import {
  AppError,
  type ConnectServiceInput,
  type CreateHostnameInput,
  checkHostnameInput,
  dnsSourceLabel,
  duplicateHostnameMessage,
  GENERATED_LABEL_LENGTH,
  generatedLabel,
  type HostnameSource,
  HTTPS_STATE_LABELS,
  isWithin,
  nameLabel,
  type RouteSpecInput,
  reservedHostnameMessage,
  type ServiceKind,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { AccessTarget } from "../access/objects.ts";
import { recordAudit } from "../audit/audit.ts";
import { joinRoutedInnerService } from "../compose-runtime/runtime.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { serviceTarget } from "../projects/objects.ts";
import { removeRoute, upsertRoute } from "../routing/routes.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import { HOST_ROUTE_REFUSAL, hostRouteRefusal } from "../service-runtime/host-mounts.ts";
import type { ControlServices } from "../services.ts";
import {
  automaticParent,
  consoleHostname,
  describeTarget,
  describeTargets,
  hostnameRouteKey,
  type TargetInfo,
  upstreamHostFor,
  wildcardRecord,
} from "./addresses.ts";
import {
  factsFor,
  type HttpsView,
  httpsView,
  loadSnapshots,
  refreshSnapshot,
  uploadsFor,
} from "./certificates.ts";
import { effectiveDefault } from "./defaults.ts";
import { CachedChecks, type DnsCheck, proxiedNote } from "./dns-check.ts";
import { publishZones, zoneForHost } from "./zones.ts";

/**
 * Hostnames (spec 10.1–10.6): every hostname is a row, connected to at most one service (with a
 * port, a path and, for Compose, one of its services) or pointing at a server without serving
 * anything. Connecting writes the hostname's route on the service's server, all or nothing
 * (spec 24 P7): if the route can't be written, nothing is saved and the reason is shown.
 */

// ---- Rows and services

export interface HostnameRow {
  id: string;
  workspace_id: string;
  host: string;
  source: HostnameSource;
  zone_id: string | null;
  automatic: boolean;
  service_id: string | null;
  compose_service: string | null;
  port: number | null;
  path: string;
  target: string;
  route_key: string | null;
  dns: unknown;
  dns_checked_at: Date | null;
  last_attempt_at: Date | null;
  replace_on_deploy: boolean;
  created_at: Date;
}

export const HOSTNAME_COLUMNS = [
  "id",
  "workspace_id",
  "host",
  "source",
  "zone_id",
  "automatic",
  "service_id",
  "compose_service",
  "port",
  "path",
  "target",
  "route_key",
  "dns",
  "dns_checked_at",
  "last_attempt_at",
  "replace_on_deploy",
  "created_at",
] as const;

export interface ServiceInfo {
  id: string;
  workspace_id: string;
  project_id: string;
  environment_id: string;
  kind: ServiceKind;
  name: string;
  app_name: string;
  server_id: string | null;
  status: string;
  settings: Record<string, unknown>;
  project_name: string;
  environment_name: string;
}

export async function loadServices(
  db: Db,
  workspaceId: string | null,
  ids: readonly string[],
): Promise<Map<string, ServiceInfo>> {
  const wanted = [...new Set(ids)].filter((id) => /^[0-9a-f-]{36}$/.test(id));
  if (wanted.length === 0) return new Map();
  let query = db
    .selectFrom("service as s")
    .innerJoin("project as p", "p.id", "s.project_id")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([
      "s.id",
      "s.workspace_id",
      "s.project_id",
      "s.environment_id",
      "s.kind",
      "s.name",
      "s.app_name",
      "s.server_id",
      "s.status",
      "s.settings",
      "p.name as project_name",
      "e.name as environment_name",
    ])
    .where("s.id", "in", wanted);
  if (workspaceId) query = query.where("s.workspace_id", "=", workspaceId);
  const rows = await query.execute();
  return new Map(
    rows.map((row) => [
      row.id,
      { ...row, settings: (row.settings ?? {}) as Record<string, unknown> } as ServiceInfo,
    ]),
  );
}

export function targetOfService(service: ServiceInfo): string {
  return service.server_id ?? HOST_TARGET;
}

const NOT_FOUND = "This hostname doesn't exist in this workspace, or you don't have access to it.";

async function rowOrThrow(
  services: ControlServices,
  workspaceId: string,
  id: string,
): Promise<HostnameRow> {
  const row = /^[0-9a-f-]{36}$/.test(id)
    ? await services.db
        .selectFrom("hostname")
        .select(HOSTNAME_COLUMNS)
        .where("id", "=", id)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst()
    : undefined;
  if (!row) throw new AppError("not_found", NOT_FOUND);
  return row as HostnameRow;
}

// ---- Compose services (spec 07 7.2: domains per inner service)

export interface ComposeServiceInfo {
  name: string;
  port: number | null;
}

function containerPort(entry: unknown): number | null {
  if (typeof entry === "number") return entry;
  if (typeof entry === "object" && entry && "target" in entry)
    return Number((entry as { target: unknown }).target) || null;
  if (typeof entry !== "string") return null;
  const withoutProtocol = entry.split("/")[0] as string;
  const last = withoutProtocol.split(":").at(-1) as string;
  const port = Number(last.split("-")[0]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * The services of a Compose file, with the port each listens on when it says: parsed from pasted
 * YAML, or for a repository file the inventory the Compose runtime keeps on the service
 * (settings.composeInventory, read at every deploy and Preview; punch-list item 5).
 */
export function composeServicesOf(settings: Record<string, unknown>): ComposeServiceInfo[] {
  const source = settings.source as { type?: string; composeFile?: string } | null | undefined;
  if (source?.type !== "raw" || typeof source.composeFile !== "string") {
    const inventory = settings.composeInventory as { services?: unknown } | null | undefined;
    if (!inventory || !Array.isArray(inventory.services)) return [];
    return (inventory.services as { name?: unknown; port?: unknown }[])
      .filter((item) => typeof item?.name === "string")
      .map((item) => ({
        name: item.name as string,
        port: typeof item.port === "number" ? item.port : null,
      }));
  }
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(source.composeFile);
  } catch {
    return [];
  }
  const list = (parsed as { services?: Record<string, Record<string, unknown>> })?.services;
  if (!list || typeof list !== "object") return [];
  return Object.entries(list).map(([name, definition]) => {
    const exposed = Array.isArray(definition?.expose) ? definition.expose : [];
    const ports = Array.isArray(definition?.ports) ? definition.ports : [];
    const port = [...exposed, ...ports].map(containerPort).find((value) => value !== null) ?? null;
    return { name, port };
  });
}

const WEB_NAMES = [
  "web",
  "app",
  "frontend",
  "front",
  "site",
  "www",
  "server",
  "nginx",
  "caddy",
  "proxy",
];

/** The Compose service an automatic hostname goes to: a web-looking one with a port. */
export function composeWebService(settings: Record<string, unknown>): ComposeServiceInfo | null {
  const withPorts = composeServicesOf(settings).filter((item) => item.port !== null);
  return (
    withPorts.find((item) => WEB_NAMES.includes(item.name.toLowerCase())) ?? withPorts[0] ?? null
  );
}

/** The port a hostname routes to on its service. */
function defaultPort(service: ServiceInfo, composeService: string | null): number | null {
  if (service.kind === "application") {
    const port = Number(service.settings.servicePort);
    return Number.isInteger(port) && port > 0 ? port : 3000;
  }
  if (service.kind === "compose") {
    return (
      composeServicesOf(service.settings).find((item) => item.name === composeService)?.port ?? null
    );
  }
  return null;
}

// ---- Routes

/** The container of the service's active deployment, which a route outside a deploy goes to. */
async function activeContainer(db: Db, serviceId: string): Promise<string | null> {
  const row = await db
    .selectFrom("deployment")
    .select("container_name")
    .where("service_id", "=", serviceId)
    .where("status", "in", ["active", "not_running"])
    .orderBy("created_at", "desc")
    .executeTakeFirst()
    .catch(() => undefined);
  return row?.container_name ?? null;
}

/**
 * The route for a hostname written outside a deploy (Add domain, Connect, Generate). Its key is
 * the deploy pipeline's, so the next deploy replaces it with one pointing at the new container.
 */
export async function routeSpecFor(
  db: Db,
  hostname: { host: string; path: string; port: number | null; compose_service: string | null },
  service: ServiceInfo,
): Promise<RouteSpecInput> {
  const port = hostname.port ?? defaultPort(service, hostname.compose_service) ?? 80;
  const container = hostname.compose_service ? null : await activeContainer(db, service.id);
  return {
    key: hostnameRouteKey(service.id, hostname.host, hostname.path),
    hostnames: [hostname.host],
    path: hostname.path,
    upstream: {
      host: upstreamHostFor(service.app_name, hostname.compose_service, container),
      port,
    },
    certificate: "letsencrypt",
  };
}

/**
 * Removes a route. With the server's runner away, the saved route is dropped and the router
 * loses the file when the runner reconnects (it gets exactly the saved routes then).
 */
export async function dropRoute(
  services: ControlServices,
  target: string,
  key: string,
): Promise<void> {
  if (services.runners.isOnline(target)) {
    await removeRoute(services, target, key);
    return;
  }
  await services.db
    .deleteFrom("router_route")
    .where("target", "=", target)
    .where("key", "=", key)
    .execute();
}

/** Asks the server's router to look at DNS again now, and reads its certificates after. */
export function kickTarget(services: ControlServices, target: string): void {
  if (!services.runners.isOnline(target)) return;
  void services.runners
    .command(target, "router.check-holds", {}, { timeoutMs: 60_000 })
    .catch(() => {})
    .then(() => refreshSnapshot(services, target))
    .catch(() => {});
}

// ---- DNS checks, once per process

const checksByServices = new WeakMap<ControlServices, CachedChecks>();

export function dnsChecks(services: ControlServices): CachedChecks {
  let checks = checksByServices.get(services);
  if (!checks) {
    checks = new CachedChecks(() => services.domains.dns);
    checksByServices.set(services, checks);
  }
  return checks;
}

async function storeCheck(db: Db, id: string, check: DnsCheck): Promise<void> {
  await db
    .updateTable("hostname")
    .set({ dns: JSON.stringify(check), dns_checked_at: new Date(check.checkedAt) })
    .where("id", "=", id)
    .execute();
}

export async function checkRowDns(
  services: ControlServices,
  row: HostnameRow,
  fresh = false,
): Promise<DnsCheck> {
  const target = await describeTarget(services, row.target);
  const check = await dnsChecks(services).check(
    row.host,
    target?.ipv4 ?? null,
    fresh,
    target?.unknownAddress ?? null,
  );
  await storeCheck(services.db, row.id, check);
  return check;
}

// ---- Access

function serviceAccessTarget(service: ServiceInfo): AccessTarget {
  return serviceTarget({
    id: service.id,
    project_id: service.project_id,
    environment_id: service.environment_id,
  });
}

/**
 * Whether the person may manage an unconnected hostname: on the host, only who may use the
 * host, owners and admins included (spec 24 G3, B1-43); on a server, owners and admins, or who
 * can reach it. The server's workspace is checked where it is looked up (B1-44).
 */
function canManageTarget(actor: WorkspaceActor, target: string): boolean {
  if (target === HOST_TARGET) return actor.access.can("host.use");
  if (actor.role === "owner" || actor.role === "admin") return true;
  return actor.access.can("server.see", { kind: "server", id: target });
}

/** A target the person may point hostnames at: the host, or a server of this workspace. */
function ownTarget(actor: WorkspaceActor, info: TargetInfo | null): info is TargetInfo {
  return info !== null && (info.host || info.workspaceId === actor.workspace.id);
}

const SERVER_NOT_FOUND =
  "This server doesn't exist in this workspace, or you don't have access to it.";

async function requireServiceRights(actor: WorkspaceActor, service: ServiceInfo): Promise<void> {
  const target = serviceAccessTarget(service);
  if (!actor.access.can("service.see", target)) {
    throw new AppError(
      "not_found",
      "This service doesn't exist in this workspace, or you don't have access to it.",
    );
  }
  const decision = actor.access.decide("service.hostnames", target);
  if (!decision.allowed) throw new AppError("forbidden", decision.message);
}

async function requireRowRights(
  services: ControlServices,
  actor: WorkspaceActor,
  row: HostnameRow,
): Promise<ServiceInfo | null> {
  if (row.service_id) {
    const service = (await loadServices(services.db, actor.workspace.id, [row.service_id])).get(
      row.service_id,
    );
    if (!service || !actor.access.can("service.see", serviceAccessTarget(service))) {
      throw new AppError("not_found", NOT_FOUND);
    }
    await requireServiceRights(actor, service);
    return service;
  }
  if (!canManageTarget(actor, row.target)) throw new AppError("not_found", NOT_FOUND);
  return null;
}

function canSeeRow(
  actor: WorkspaceActor,
  row: HostnameRow,
  service: ServiceInfo | undefined,
): boolean {
  if (row.service_id)
    return service !== undefined && actor.access.can("service.see", serviceAccessTarget(service));
  return canManageTarget(actor, row.target);
}

/** The service a hostname gets connected to, checked: reachable, routable, and its port. */
async function serviceForConnect(
  services: ControlServices,
  actor: WorkspaceActor,
  input: ConnectServiceInput,
): Promise<{
  service: ServiceInfo;
  composeService: string | null;
  port: number | null;
  path: string;
}> {
  const service = (await loadServices(services.db, actor.workspace.id, [input.serviceId])).get(
    input.serviceId,
  );
  if (!service) {
    throw new AppError(
      "not_found",
      "This service doesn't exist in this workspace, or you don't have access to it.",
      {
        fields: { serviceId: 'Pick a service, or untick "Connect it to a service now".' },
      },
    );
  }
  await requireServiceRights(actor, service);
  if (service.kind !== "application" && service.kind !== "compose") {
    throw new AppError(
      "invalid_request",
      "Databases don't take hostnames. Connect the hostname to an app or a Compose service.",
      {
        fields: { serviceId: "Pick an app or a Compose service." },
      },
    );
  }
  let composeService: string | null = null;
  if (service.kind === "compose") {
    const known = composeServicesOf(service.settings);
    composeService = input.composeService ?? composeWebService(service.settings)?.name ?? null;
    if (!composeService) {
      throw new AppError("invalid_request", "Pick the Compose service the hostname goes to.", {
        fields: { composeService: "Pick one of the Compose file's services." },
      });
    }
    if (known.length > 0 && !known.some((item) => item.name === composeService)) {
      throw new AppError(
        "invalid_request",
        `The Compose file has no service named ${composeService}.`,
        {
          fields: { composeService: "Pick one of the Compose file's services." },
        },
      );
    }
  }
  const port = input.port ?? defaultPort(service, composeService);
  if (port === null) {
    throw new AppError(
      "invalid_request",
      "Enter the port that Compose service listens on (1 to 65535).",
      {
        fields: { port: "Enter a port from 1 to 65535." },
      },
    );
  }
  await refuseHostRoute(services, actor, service, composeService);
  return { service, composeService, port: input.port ?? null, path: input.path };
}

/**
 * A host service whose definition an administrator approved (bind mounts, privileged Compose
 * options) takes hostnames only from administrators: routes are part of that approval and
 * change without a deploy (C1-04).
 */
async function refuseHostRoute(
  services: ControlServices,
  actor: WorkspaceActor,
  service: ServiceInfo,
  composeService: string | null,
): Promise<void> {
  const refusal = await hostRouteRefusal(
    services.db,
    actor,
    { id: service.id, kind: service.kind, serverId: service.server_id, settings: service.settings },
    composeService,
  );
  if (refusal) throw new AppError("forbidden", refusal);
}

// ---- Names that can't be added

export async function reservedReason(
  services: ControlServices,
  host: string,
): Promise<string | null> {
  const consoleHost = await consoleHostname(services);
  if (consoleHost && host === consoleHost) return reservedHostnameMessage(host);
  // The platform domain is the whole install's: only Nearzero assigns names under it (spec 10.5
  // "the platform domain's assignment names", R3-14). Generated hostnames don't come here.
  const domain = services.domains.platformDomain;
  if (domain && isWithin(host, domain)) return reservedHostnameMessage(host);
  // A zone's nameservers reserve only names that are Nearzero's own: the default ns1 and ns2
  // under the platform domain (reserved above), and nameservers inside the zone itself
  // (Nearzero gives those their address records). Any other name a zone lists stays free.
  const zones = await services.db
    .selectFrom("dns_zone")
    .select("name")
    .where(sql<boolean>`${host} = ANY(nameservers)`)
    .execute();
  if (zones.some((zone) => isWithin(host, zone.name))) return reservedHostnameMessage(host);
  return null;
}

/** Why a managed record can't be made for a target whose public IPv4 isn't known. */
function cantCreateRecord(target: TargetInfo | null): string {
  return `Nearzero can't create the DNS record: ${
    target?.unknownAddress ??
    "it doesn't know this server's public IPv4 address. Correct it under About Nearzero."
  }`;
}

/** The name of `host` inside a zone ("@" for the apex). */
function nameInZone(host: string, zone: string): string {
  return host === zone ? "@" : host.slice(0, -(zone.length + 1));
}

/**
 * An address record (A, AAAA or CNAME) already at `host` in a managed zone, if any. Nearzero
 * never adds its A record beside one: two A records split traffic, and an A record next to a
 * CNAME makes the zone invalid (spec 10.8).
 */
async function addressRecordAt(
  db: Db,
  zone: { id: string; name: string },
  host: string,
): Promise<{ name: string; type: string; value: string } | null> {
  return (
    (await db
      .selectFrom("dns_record")
      .select(["name", "type", "value"])
      .where("zone_id", "=", zone.id)
      .where("name", "=", nameInZone(host, zone.name))
      .where("type", "in", ["A", "AAAA", "CNAME"])
      .orderBy("created_at")
      .executeTakeFirst()) ?? null
  );
}

function addressRecordMessage(
  host: string,
  zone: string,
  record: { name: string; type: string; value: string },
): string {
  return `A DNS address record already exists for ${host}: ${record.name} ${record.type} ${record.value} in ${zone}. Delete it under DNS zones → Records, or pick another hostname.`;
}

/**
 * Refuses a hostname that is already added. One added in another workspace says so, instead of
 * pointing at a Hostnames list where it isn't (B1-15).
 */
async function ensureFree(db: Db, host: string, workspaceId?: string): Promise<void> {
  const taken = await db
    .selectFrom("hostname")
    .select(["id", "workspace_id"])
    .where("host", "=", host)
    .executeTakeFirst();
  if (taken) {
    const message =
      workspaceId !== undefined && taken.workspace_id !== workspaceId
        ? `${host} is already added in another workspace on this Nearzero. If the domain is yours, ask a Nearzero administrator to remove it there.`
        : duplicateHostnameMessage(host);
    throw new AppError("conflict", message, { fields: { hostname: message } });
  }
}

/** Where a typed hostname's DNS comes from. */
async function classify(
  services: ControlServices,
  workspaceId: string,
  host: string,
  dns: "managed" | "external" | undefined,
): Promise<{ source: HostnameSource; zone: { id: string; name: string } | null }> {
  const zone = await zoneForHost(services.db, workspaceId, host);
  if (zone && dns !== "external") return { source: "zone", zone: { id: zone.id, name: zone.name } };
  const domain = services.domains.platformDomain;
  if (domain && isWithin(host, domain)) {
    const depth = host.slice(0, -(domain.length + 1)).split(".").length;
    return { source: depth === 1 ? "platform" : "server", zone: null };
  }
  return { source: "own", zone: null };
}

// ---- Saving a new hostname, all or nothing

interface NewHostname {
  workspaceId: string;
  host: string;
  source: HostnameSource;
  zoneId: string | null;
  automatic: boolean;
  service: ServiceInfo | null;
  composeService: string | null;
  port: number | null;
  path: string;
  target: string;
  /** For a hostname in a managed zone: the A record Nearzero creates. */
  recordIp: string | null;
  zoneName: string | null;
  createdBy: string | null;
  writeRoute: boolean;
}

async function saveHostname(services: ControlServices, plan: NewHostname): Promise<HostnameRow> {
  const routeKey = plan.service ? hostnameRouteKey(plan.service.id, plan.host, plan.path) : null;
  let wrote = false;
  try {
    const row = await services.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`hostname:${plan.host}`}))`.execute(trx);
      await ensureFree(trx, plan.host, plan.workspaceId);
      if (plan.recordIp && plan.zoneId && plan.zoneName) {
        const existing = await addressRecordAt(
          trx,
          { id: plan.zoneId, name: plan.zoneName },
          plan.host,
        );
        if (existing) {
          const message = addressRecordMessage(plan.host, plan.zoneName, existing);
          throw new AppError("conflict", message, { fields: { hostname: message } });
        }
      }
      if (plan.service && plan.writeRoute) {
        const spec = await routeSpecFor(
          services.db,
          {
            host: plan.host,
            path: plan.path,
            port: plan.port,
            compose_service: plan.composeService,
          },
          plan.service,
        );
        if (plan.composeService) {
          // Only routed inner services are on the private network (30b R2-11).
          await joinRoutedInnerService(services, plan.target, plan.service, plan.composeService);
        }
        await upsertRoute(services, plan.target, spec);
        wrote = true;
      }
      const inserted = await trx
        .insertInto("hostname")
        .values({
          workspace_id: plan.workspaceId,
          host: plan.host,
          source: plan.source,
          zone_id: plan.zoneId,
          automatic: plan.automatic,
          service_id: plan.service?.id ?? null,
          compose_service: plan.composeService,
          port: plan.port,
          path: plan.path,
          target: plan.target,
          route_key: routeKey,
          created_by: plan.createdBy,
        })
        .returning(HOSTNAME_COLUMNS)
        .executeTakeFirstOrThrow();
      if (plan.recordIp && plan.zoneId && plan.zoneName) {
        const name = nameInZone(plan.host, plan.zoneName);
        await trx
          .insertInto("dns_record")
          .values({
            zone_id: plan.zoneId,
            name,
            type: "A",
            value: plan.recordIp,
            ttl: 300,
            managed: true,
            hostname_id: inserted.id,
          })
          .execute();
      }
      return inserted as HostnameRow;
    });
    if (plan.zoneId && plan.recordIp) {
      await publishZones(services, [plan.zoneId]).catch((error: unknown) =>
        services.log.warn("couldn't publish a hostname's DNS record yet", { error }),
      );
    }
    return row;
  } catch (error) {
    if (wrote && routeKey) await dropRoute(services, plan.target, routeKey).catch(() => {});
    if ((error as { code?: string }).code === "23505") {
      const message = duplicateHostnameMessage(plan.host);
      throw new AppError("conflict", message, { fields: { hostname: message } });
    }
    throw error;
  }
}

async function audit(
  services: ControlServices,
  actor: WorkspaceActor,
  action: string,
  row: { id: string; host: string },
  details: Record<string, unknown> = {},
) {
  await recordAudit(services.db, services.log, auditActor(actor), {
    action,
    workspaceId: actor.workspace.id,
    target: { kind: "hostname", id: row.id },
    details: { hostname: row.host, ...details },
  });
}

// ---- Views

export interface HostnameView {
  id: string;
  hostname: string;
  url: string;
  source: HostnameSource;
  sourceLabel: string;
  zone: { id: string; name: string } | null;
  automatic: boolean;
  service: {
    id: string;
    name: string;
    kind: ServiceKind;
    projectId: string;
    projectName: string;
    environmentId: string;
    environmentName: string;
    composeService: string | null;
    port: number | null;
    path: string;
  } | null;
  target: { id: string; name: string; host: boolean; address: string | null };
  dns: DnsView;
  https: HttpsView;
  needsAttention: boolean;
  waiting: boolean;
  can: { manage: boolean; move: boolean; retry: boolean };
  createdAt: string;
}

/**
 * A hostname's DNS as people see it (spec 10.4 DNS column, 10.6 the Add domain dialog's check):
 * one shape for the hostname list and the Add domain preview.
 */
export interface DnsView {
  status: string;
  label: string;
  /** The check's plain words. */
  note: string;
  addresses: string[];
  /** The proxy in front, when the A records are a known proxy's ("Cloudflare"). */
  proxiedBy: string | null;
  /** What could still send Let's Encrypt elsewhere though it points here (R3-17). */
  warnings: string[];
  /** The name it is an alias of (a CNAME), shown as "Alias of" (R3-17). */
  aliasOf: string | null;
  checkedAt: string | null;
  /** Nearzero keeps the record in its own DNS zone. */
  managed: boolean;
  /** The record to add, while DNS doesn't point here (the full name; null when managed). */
  record: DnsRecordView | null;
}

export interface DnsRecordView {
  type: "A";
  name: string;
  value: string | null;
  ttl: string;
  proxy: "DNS only";
}

const DNS_LABELS: Record<string, string> = {
  points_here: "Points here",
  points_elsewhere: "Points elsewhere",
  proxied: "Proxied",
  ipv6_only: "IPv6 only",
  no_record: "No record",
  lookup_failed: "Lookup failed",
  address_unknown: "Unknown",
  waiting: "Waiting for DNS",
  check_records: "Check records",
  unknown: "Unknown",
};

function dnsColumn(
  row: HostnameRow,
  zoneName: string | null,
  target: TargetInfo | undefined,
  services: ControlServices,
) {
  const check = (row.dns ?? null) as DnsCheck | null;
  const managed = row.source === "zone";
  const recordFor = () => {
    if (managed) return null;
    const automaticParentName = target ? automaticParent(services, target) : null;
    if (
      (row.source === "platform" || row.source === "server") &&
      target &&
      automaticParentName &&
      isWithin(row.host, automaticParentName)
    ) {
      const wildcard = wildcardRecord(services, target);
      return wildcard
        ? {
            type: "A" as const,
            name: wildcard.name,
            value: wildcard.value,
            ttl: "Auto or 300",
            proxy: "DNS only" as const,
          }
        : null;
    }
    return {
      type: "A" as const,
      name: row.host,
      value: target?.ipv4 ?? null,
      ttl: "Auto or 300",
      proxy: "DNS only" as const,
    };
  };
  const view = dnsView(check, {
    managed,
    // A connected hostname with no record waits for it; an unconnected one has "No record" (G3-12).
    waitsForRecord: row.automatic || row.service_id !== null,
    zoneName,
    record: recordFor,
  });
  // An added hostname behind a proxy gets the HTTP-challenge note, not the advice to turn the
  // proxy off that refuses adding one (R3-11).
  return view.status === "proxied" ? { ...view, note: proxiedNote(view.proxiedBy) } : view;
}

/** The one DNS shape of the list and the preview, from a check (null: not checked yet). */
export function dnsView(
  check: DnsCheck | null,
  options: {
    managed: boolean;
    /** Connected (or automatic): no record yet reads "Waiting for DNS", not "No record". */
    waitsForRecord: boolean;
    zoneName: string | null;
    record: () => DnsRecordView | null;
  },
): DnsView {
  const { managed, zoneName } = options;
  if (!check) {
    return {
      status: "unknown",
      label: DNS_LABELS.unknown as string,
      note: "Not checked yet.",
      addresses: [],
      proxiedBy: null,
      warnings: [],
      aliasOf: null,
      checkedAt: null,
      managed,
      record: managed ? null : options.record(),
    };
  }
  let status: string = check.status;
  let note = check.message;
  if (managed && check.status !== "points_here") {
    status = "check_records";
    note = `Nearzero DNS has the record in ${zoneName}. If it doesn't resolve yet, check that ${zoneName} is delegated to Nearzero's nameservers at your registrar.`;
  } else if (check.status === "no_record" && options.waitsForRecord) {
    status = "waiting";
  }
  return {
    status,
    label: DNS_LABELS[status] ?? "Unknown",
    note,
    addresses: check.addresses,
    proxiedBy: check.proxiedBy,
    warnings: check.status === "points_here" ? (check.warnings ?? []) : [],
    aliasOf: check.aliasOf ?? null,
    checkedAt: new Date(check.checkedAt).toISOString(),
    managed,
    record: status === "points_here" || managed ? null : options.record(),
  };
}

/**
 * The Hostnames filters (spec 10.4, G3-12), as 0.1.x read them. "Needs attention": an HTTPS
 * state that is an error or a warning, or a connected hostname whose DNS points elsewhere. A
 * proxied name, an IPv6-only one or one lookup that failed is never there on its own, so a site
 * serving fine behind a proxy isn't flagged. "Waiting for DNS": a certificate waiting for DNS,
 * or queued now that it points here.
 */
const ATTENTION = new Set([
  "failed",
  "paused",
  "rate_limited",
  "expired",
  "expires_soon",
  "not_trusted",
]);
const WAITING = new Set(["waiting_for_dns", "queued"]);

export async function buildViews(
  services: ControlServices,
  actor: WorkspaceActor | null,
  rows: readonly HostnameRow[],
): Promise<HostnameView[]> {
  const workspaceId = actor?.workspace.id ?? null;
  const [servicesById, targets, snapshots, uploads, zones] = await Promise.all([
    loadServices(
      services.db,
      workspaceId,
      rows.flatMap((row) => (row.service_id ? [row.service_id] : [])),
    ),
    describeTargets(
      services,
      rows.map((row) => row.target),
    ),
    loadSnapshots(
      services,
      rows.map((row) => row.target),
    ),
    uploadsFor(
      services,
      rows.map((row) => row.target),
    ),
    rows.some((row) => row.zone_id)
      ? services.db
          .selectFrom("dns_zone")
          .select(["id", "name"])
          .where(
            "id",
            "in",
            rows.flatMap((row) => (row.zone_id ? [row.zone_id] : [])),
          )
          .execute()
      : Promise.resolve([] as { id: string; name: string }[]),
  ]);
  const zoneNames = new Map(zones.map((zone) => [zone.id, zone.name]));
  const views: HostnameView[] = [];
  for (const row of rows) {
    const service = row.service_id ? servicesById.get(row.service_id) : undefined;
    if (actor && !canSeeRow(actor, row, service)) continue;
    const target = targets.get(row.target);
    const zoneName = row.zone_id ? (zoneNames.get(row.zone_id) ?? null) : null;
    const facts = factsFor(
      { host: row.host, connected: row.service_id !== null, target: row.target },
      snapshots.get(row.target),
      uploads,
      (row.dns ?? null) as DnsCheck | null,
    );
    const https = httpsView(facts, row.last_attempt_at?.getTime() ?? null);
    const dns = dnsColumn(row, zoneName, target, services);
    const manage = actor
      ? service
        ? actor.access.can("service.hostnames", serviceAccessTarget(service))
        : canManageTarget(actor, row.target)
      : true;
    views.push({
      id: row.id,
      hostname: row.host,
      url: `https://${row.host}${row.path === "/" ? "" : row.path}`,
      source: row.source,
      sourceLabel: dnsSourceLabel(row.source, zoneName),
      zone: row.zone_id && zoneName ? { id: row.zone_id, name: zoneName } : null,
      automatic: row.automatic,
      service: service
        ? {
            id: service.id,
            name: service.name,
            kind: service.kind,
            projectId: service.project_id,
            projectName: service.project_name,
            environmentId: service.environment_id,
            environmentName: service.environment_name,
            composeService: row.compose_service,
            port: row.port ?? defaultPort(service, row.compose_service),
            path: row.path,
          }
        : null,
      target: {
        id: row.target,
        name: target?.name ?? "Unknown server",
        host: row.target === HOST_TARGET,
        address: target?.ipv4 ?? null,
      },
      dns,
      https,
      needsAttention:
        // A name no public authority issues for gets the default certificate by design.
        (ATTENTION.has(https.state) && facts.hold !== "not_public") ||
        (row.service_id !== null && dns.status === "points_elsewhere"),
      waiting: row.service_id !== null && WAITING.has(https.state),
      can: { manage, move: manage && !row.automatic, retry: manage && https.retryRefusal === null },
      createdAt: row.created_at.toISOString(),
    });
  }
  return views;
}

export const SHOW_FILTERS = ["all", "attention", "waiting", "unconnected"] as const;
export type ShowFilter = (typeof SHOW_FILTERS)[number];

export async function listHostnames(
  services: ControlServices,
  actor: WorkspaceActor,
  options: { search?: string; show?: ShowFilter; refresh?: boolean } = {},
) {
  let rows = (await services.db
    .selectFrom("hostname")
    .select(HOSTNAME_COLUMNS)
    .where("workspace_id", "=", actor.workspace.id)
    .orderBy("host")
    .execute()) as HostnameRow[];
  if (options.refresh) {
    const targets = [...new Set(rows.filter((row) => row.service_id).map((row) => row.target))];
    await Promise.all(
      targets.map((target) =>
        services.runners.isOnline(target) ? refreshSnapshot(services, target) : null,
      ),
    );
    await eachLimited(rows, 8, (row) =>
      checkRowDns(services, row)
        .then(() => {})
        .catch(() => {}),
    );
    rows = (await services.db
      .selectFrom("hostname")
      .select(HOSTNAME_COLUMNS)
      .where("workspace_id", "=", actor.workspace.id)
      .orderBy("host")
      .execute()) as HostnameRow[];
  }
  let views = await buildViews(services, actor, rows);
  const needle = options.search?.trim().toLowerCase() ?? "";
  if (needle) {
    views = views.filter((view) =>
      [
        view.hostname,
        view.service?.name,
        view.service?.projectName,
        view.service?.environmentName,
        view.service?.composeService,
        view.target.name,
        view.sourceLabel,
      ].some((text) => text?.toLowerCase().includes(needle)),
    );
  }
  const show = options.show ?? "all";
  if (show === "attention") views = views.filter((view) => view.needsAttention);
  if (show === "waiting") views = views.filter((view) => view.waiting);
  if (show === "unconnected") views = views.filter((view) => view.service === null);
  const targets = [...new Set(rows.filter((row) => row.service_id).map((row) => row.target))];
  const snapshots = await loadSnapshots(services, targets);
  const unreadable = targets.filter((target) => {
    const snapshot = snapshots.get(target);
    return !snapshot?.status || snapshot.error !== null;
  }).length;
  const times = rows.flatMap((row) => (row.dns_checked_at ? [row.dns_checked_at.getTime()] : []));
  return {
    hostnames: views,
    checkedAt: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
    unreadableServers: unreadable,
    unreadableMessage:
      unreadable > 0
        ? `Couldn't read certificates on ${unreadable} ${unreadable === 1 ? "server" : "servers"}.`
        : null,
  };
}

async function eachLimited<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(runners);
}

export async function getHostname(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<HostnameView> {
  const row = await rowOrThrow(services, actor.workspace.id, id);
  const [view] = await buildViews(services, actor, [row]);
  if (!view) throw new AppError("not_found", NOT_FOUND);
  return view;
}

/** Services the person can reach that have no hostname yet (spec 10.4: up to 50). */
export async function servicesWithoutDomain(services: ControlServices, actor: WorkspaceActor) {
  const rows = await services.db
    .selectFrom("service as s")
    .innerJoin("project as p", "p.id", "s.project_id")
    .innerJoin("environment as e", "e.id", "s.environment_id")
    .select([
      "s.id",
      "s.name",
      "s.kind",
      "s.project_id",
      "s.environment_id",
      "s.server_id",
      "p.name as project_name",
      "e.name as environment_name",
    ])
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.kind", "in", ["application", "compose"])
    .where("s.deleting_run_id", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("hostname as h").select("h.id").whereRef("h.service_id", "=", "s.id"),
        ),
      ),
    )
    .orderBy("p.name")
    .orderBy("s.name")
    .execute();
  const visible = rows.filter((row) => actor.access.can("service.see", serviceTarget(row)));
  return {
    count: visible.length,
    message:
      visible.length === 0
        ? null
        : `${visible.length} ${visible.length === 1 ? "service has" : "services have"} no domain`,
    services: visible.slice(0, 50).map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      projectId: row.project_id,
      projectName: row.project_name,
      environmentId: row.environment_id,
      environmentName: row.environment_name,
      serverId: row.server_id ?? HOST_TARGET,
      canAdd: actor.access.can("service.hostnames", serviceTarget(row)),
    })),
  };
}

// ---- Previews and checks for the Add domain dialogs (spec 10.5, 10.6)

export async function previewHostname(
  services: ControlServices,
  actor: WorkspaceActor,
  input: { hostname: string; serviceId?: string | undefined; serverId?: string | undefined },
) {
  const checked = checkHostnameInput(input.hostname);
  if (!checked.ok) return { valid: false, message: checked.message, canAdd: false };
  const host = checked.hostname;
  const reserved = await reservedReason(services, host);
  if (reserved) return { valid: false, hostname: host, message: reserved, canAdd: false };
  const taken = await services.db
    .selectFrom("hostname")
    .select("id")
    .where("host", "=", host)
    .executeTakeFirst();
  if (taken)
    return { valid: false, hostname: host, message: duplicateHostnameMessage(host), canAdd: false };
  let target = input.serverId ?? HOST_TARGET;
  if (input.serviceId) {
    const service = (await loadServices(services.db, actor.workspace.id, [input.serviceId])).get(
      input.serviceId,
    );
    if (!service || !actor.access.can("service.see", serviceAccessTarget(service))) {
      throw new AppError(
        "not_found",
        "This service doesn't exist in this workspace, or you don't have access to it.",
      );
    }
    target = targetOfService(service);
  } else if (!canManageTarget(actor, target)) {
    throw new AppError("not_found", SERVER_NOT_FOUND);
  }
  const info = await describeTarget(services, target);
  // Another workspace's server is not found: its name, address and label stay private (B1-44).
  if (!ownTarget(actor, info)) throw new AppError("not_found", SERVER_NOT_FOUND);
  const { source, zone } = await classify(services, actor.workspace.id, host, undefined);
  const check = await dnsChecks(services).check(
    host,
    info?.ipv4 ?? null,
    false,
    info?.unknownAddress ?? null,
  );
  const found = await dnsChecks(services).zone(host);
  const record = {
    type: "A" as const,
    name: host === found.zone ? "@" : host.slice(0, -(found.zone.length + 1)),
    fullName: host,
    zone: found.zone,
    value: info?.ipv4 ?? null,
    ttl: "Auto or 300",
    proxy: "DNS only" as const,
  };
  const inZone = source === "zone";
  return {
    valid: true,
    hostname: host,
    source,
    zone,
    managedChoice: inZone
      ? {
          managed: `Nearzero creates it in ${zone?.name}`,
          external: "I'll create it at my DNS provider",
        }
      : null,
    target: { id: target, name: info?.name ?? "Unknown server", address: info?.ipv4 ?? null },
    record,
    hint: `In your DNS provider's records for ${found.zone}, the name is ${record.name}.`,
    proxyWarning:
      "Keep the record DNS only (not proxied): Let's Encrypt has to reach this server directly.",
    // The same shape as the hostname list's DNS column. Not "managed" yet: inside a zone the
    // person still picks who creates the record (managedChoice).
    dns: dnsView(check, {
      managed: false,
      waitsForRecord: false,
      zoneName: zone?.name ?? null,
      record: () => ({
        type: "A",
        name: host,
        value: record.value,
        ttl: record.ttl,
        proxy: record.proxy,
      }),
    }),
    canAdd: inZone || check.status === "points_here",
    message:
      inZone && check.status !== "points_here"
        ? "DNS doesn't point to this server yet. Nearzero keeps checking."
        : check.message,
    addressHelp: info?.ipv4
      ? null
      : (info?.unknownAddress ?? "Server address unknown. Correct it under About Nearzero."),
  };
}

// ---- Changes

export async function createHostname(
  services: ControlServices,
  actor: WorkspaceActor,
  input: CreateHostnameInput,
): Promise<{ hostname: HostnameView; message: string }> {
  const checked = checkHostnameInput(input.hostname);
  if (!checked.ok)
    throw new AppError("invalid_request", checked.message, {
      fields: { hostname: checked.message },
    });
  const host = checked.hostname;
  const reserved = await reservedReason(services, host);
  if (reserved) throw new AppError("conflict", reserved, { fields: { hostname: reserved } });
  await ensureFree(services.db, host, actor.workspace.id);

  let connect: Awaited<ReturnType<typeof serviceForConnect>> | null = null;
  let target: string;
  if (input.connect) {
    connect = await serviceForConnect(services, actor, input.connect);
    target = targetOfService(connect.service);
  } else {
    if (!input.serverId) {
      throw new AppError(
        "invalid_request",
        'Pick a service, or untick "Connect it to a service now".',
        {
          fields: { serviceId: 'Pick a service, or untick "Connect it to a service now".' },
        },
      );
    }
    target = input.serverId;
    const known = await describeTarget(services, target);
    if (!ownTarget(actor, known) || !canManageTarget(actor, target)) {
      throw new AppError("not_found", SERVER_NOT_FOUND, {
        fields: { serverId: "Pick the Nearzero host or one of your servers." },
      });
    }
    // A typed address proves nothing about who controls a name: a server record anyone can add
    // with someone else's IP. A hostname pointing at a server needs its runner connected
    // (B1-15).
    if (!known.host && !services.runners.isOnline(target)) {
      const message = `${known.name} isn't connected to Nearzero yet, so a hostname can't point at it. Set the server up first, or connect a service to the hostname instead.`;
      throw new AppError("conflict", message, { fields: { serverId: message } });
    }
  }
  const info = await describeTarget(services, target);
  const { source, zone } = await classify(services, actor.workspace.id, host, input.dns);
  if (source === "zone") {
    // Whoever may add the hostname may have Nearzero create its record in the zone.
    if (!info?.ipv4) {
      throw new AppError("conflict", cantCreateRecord(info));
    }
  } else {
    // The name must already point at the server (spec 10.5 step 3, 10.6).
    const check = await dnsChecks(services).check(
      host,
      info?.ipv4 ?? null,
      true,
      info?.unknownAddress ?? null,
    );
    if (check.status !== "points_here") {
      throw new AppError("conflict", check.message, { fields: { hostname: check.message } });
    }
  }
  const row = await saveHostname(services, {
    workspaceId: actor.workspace.id,
    host,
    source,
    zoneId: zone?.id ?? null,
    automatic: false,
    service: connect?.service ?? null,
    composeService: connect?.composeService ?? null,
    port: connect?.port ?? null,
    path: connect?.path ?? "/",
    target,
    recordIp: source === "zone" ? (info?.ipv4 ?? null) : null,
    zoneName: zone?.name ?? null,
    createdBy: actor.personId,
    writeRoute: true,
  });
  await checkRowDns(services, row).catch(() => {});
  if (connect) kickTarget(services, target);
  await audit(services, actor, "hostname.added", row, {
    serviceId: connect?.service.id ?? null,
    target,
  });
  return {
    hostname: await getHostname(services, actor, row.id),
    message: connect
      ? `Added ${host}. HTTPS starts working in a minute.`
      : `Added ${host}. Connect a service to it from the Hostnames list to serve something there.`,
  };
}

export async function connectHostname(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  input: ConnectServiceInput,
): Promise<{ hostname: HostnameView; message: string }> {
  const row = await rowOrThrow(services, actor.workspace.id, id);
  const current = await requireRowRights(services, actor, row);
  if (row.automatic && current) {
    throw new AppError(
      "conflict",
      `Nearzero gave ${row.host} to ${current.name} automatically, so it can't be moved. Add your own domain to the other service instead.`,
    );
  }
  const next = await serviceForConnect(services, actor, input);
  const target = targetOfService(next.service);
  const nextKey = hostnameRouteKey(next.service.id, row.host, next.path);
  const spec = await routeSpecFor(
    services.db,
    { host: row.host, path: next.path, port: next.port, compose_service: next.composeService },
    next.service,
  );
  const oldKey = row.route_key;
  const moving = oldKey !== null && (row.target !== target || oldKey !== nextKey);
  if (moving) await dropRoute(services, row.target, oldKey);
  if (next.composeService) {
    // Only routed inner services are on the private network (30b R2-11).
    await joinRoutedInnerService(services, target, next.service, next.composeService);
  }
  try {
    await upsertRoute(services, target, spec);
  } catch (error) {
    // Put the old route back so nothing changed (spec 24 P7).
    if (moving && current) {
      await upsertRoute(services, row.target, await routeSpecFor(services.db, row, current)).catch(
        () => {},
      );
    }
    throw error;
  }
  const info = await describeTarget(services, target);
  await services.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("hostname")
      .set({
        service_id: next.service.id,
        compose_service: next.composeService,
        port: next.port,
        path: next.path,
        target,
        route_key: nextKey,
        updated_at: new Date(),
      })
      .where("id", "=", row.id)
      .execute();
    if (row.source === "zone" && info?.ipv4 && row.target !== target) {
      await trx
        .updateTable("dns_record")
        .set({ value: info.ipv4, updated_at: new Date() })
        .where("hostname_id", "=", row.id)
        .execute();
    }
  });
  if (row.source === "zone" && row.zone_id && row.target !== target) {
    await publishZones(services, [row.zone_id]).catch(() => {});
  }
  kickTarget(services, target);
  await audit(services, actor, current ? "hostname.moved" : "hostname.connected", row, {
    serviceId: next.service.id,
  });
  return { hostname: await getHostname(services, actor, row.id), message: "Service connected" };
}

export async function disconnectHostname(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
) {
  const row = await rowOrThrow(services, actor.workspace.id, id);
  const current = await requireRowRights(services, actor, row);
  if (!current)
    return {
      hostname: await getHostname(services, actor, id),
      message: `${row.host} isn't connected to a service.`,
    };
  if (row.route_key) await dropRoute(services, row.target, row.route_key);
  await services.db
    .updateTable("hostname")
    .set({
      service_id: null,
      compose_service: null,
      port: null,
      path: "/",
      route_key: null,
      updated_at: new Date(),
    })
    .where("id", "=", row.id)
    .execute();
  await audit(services, actor, "hostname.disconnected", row, { serviceId: current.id });
  return {
    hostname: await getHostname(services, actor, id),
    message: `Disconnected ${row.host} from ${current.name}. It stops serving traffic until you connect a service again.`,
  };
}

/** Removes a hostname with its route, certificate and managed DNS record (spec 10.4). */
export async function removeHostname(services: ControlServices, actor: WorkspaceActor, id: string) {
  const row = await rowOrThrow(services, actor.workspace.id, id);
  await requireRowRights(services, actor, row);
  await removeRow(services, row);
  await audit(services, actor, "hostname.removed", row);
  return { removed: true, message: `Removed ${row.host}.` };
}

export async function removeRow(services: ControlServices, row: HostnameRow): Promise<void> {
  if (row.route_key) await dropRoute(services, row.target, row.route_key);
  await services.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("hostname").where("id", "=", row.id).execute();
    if (row.automatic && row.service_id) {
      await trx
        .insertInto("service_hostname_state")
        .values({ service_id: row.service_id, automatic_declined: true })
        .onConflict((c) =>
          c.column("service_id").doUpdateSet({ automatic_declined: true, updated_at: new Date() }),
        )
        .execute();
    }
  });
  if (row.zone_id) await publishZones(services, [row.zone_id]).catch(() => {});
}

// ---- Automatic hostnames (spec 10.1, 10.2, 10.6 Generate, 10.8 defaults)

export type AutomaticBase =
  | { kind: "platform"; parent: string }
  | { kind: "zone"; zone: { id: string; name: string }; prefix: string }
  | { kind: "none"; message: string };

export const NOTHING_TO_GENERATE =
  "No domain to generate hostnames under yet — Add a DNS zone under Domains, or use your own domain.";

/**
 * Where a service's automatic hostname goes. `explicit` (Generate a domain, Give N a hostname)
 * falls back to the platform domain when the environment's default is "No zone".
 */
export async function automaticBase(
  services: ControlServices,
  service: ServiceInfo,
  target: TargetInfo,
  explicit: boolean,
): Promise<AutomaticBase> {
  const choice = await effectiveDefault(services, service.workspace_id, service.environment_id);
  if (choice.source === "zone") return { kind: "zone", zone: choice.zone, prefix: choice.prefix };
  if (choice.source === "none" && !explicit) {
    return {
      kind: "none",
      message: "This environment's apps get no automatic hostname (Environment defaults).",
    };
  }
  const parent = automaticParent(services, target);
  if (!parent) return { kind: "none", message: NOTHING_TO_GENERATE };
  return { kind: "platform", parent };
}

/** Whether a hostname is what the base would give this service (so it needs no replacing). */
export function matchesBase(row: HostnameRow, base: AutomaticBase, service: ServiceInfo): boolean {
  if (base.kind === "platform") {
    if (!row.host.endsWith(`.${base.parent}`)) return false;
    return !row.host.slice(0, -(base.parent.length + 1)).includes(".");
  }
  if (base.kind === "zone") {
    if (row.zone_id !== base.zone.id) return false;
    const stem = [nameLabel(service.name), base.prefix].filter((part) => part !== "").join(".");
    const rest = row.host.slice(0, -(base.zone.name.length + 1));
    return (
      rest === stem ||
      new RegExp(
        `^${stem.split(".")[0]}-\\d+${base.prefix ? `\\.${base.prefix.replaceAll(".", "\\.")}` : ""}$`,
      ).test(rest)
    );
  }
  return false;
}

/**
 * The first candidate no hostname uses; in a managed zone, also one with no address record
 * already at that name (a person's own, or a nameserver's), so automatic names skip them.
 */
async function freeName(
  db: Db,
  candidates: Iterable<string>,
  zone?: { id: string; name: string },
): Promise<string | null> {
  let tries = 0;
  for (const candidate of candidates) {
    if (++tries > 50) break;
    const taken = await db
      .selectFrom("hostname")
      .select("id")
      .where("host", "=", candidate)
      .executeTakeFirst();
    if (taken) continue;
    if (zone && (await addressRecordAt(db, zone, candidate))) continue;
    return candidate;
  }
  return null;
}

function* generatedNames(services: ControlServices, parent: string): Generator<string> {
  for (;;) yield `${generatedLabel(services.domains.random(GENERATED_LABEL_LENGTH))}.${parent}`;
}

function* zoneNames(service: ServiceInfo, zone: string, prefix: string): Generator<string> {
  const tail = [prefix, zone].filter((part) => part !== "").join(".");
  const label = nameLabel(service.name, 55);
  yield `${label}.${tail}`;
  for (let n = 2; ; n++) yield `${label}-${n}.${tail}`;
}

export interface Assigned {
  row: HostnameRow;
  target: TargetInfo;
}

/** Gives a service an automatic hostname under `base`. */
export async function assignAutomatic(
  services: ControlServices,
  service: ServiceInfo,
  base: Exclude<AutomaticBase, { kind: "none" }>,
  options: {
    writeRoute: boolean;
    createdBy: string | null;
    port?: number | null;
    path?: string;
    composeService?: string | null;
  },
): Promise<Assigned> {
  const target = (await describeTarget(services, targetOfService(service))) as TargetInfo;
  let composeService = options.composeService ?? null;
  if (service.kind === "compose" && !composeService) {
    composeService = composeWebService(service.settings)?.name ?? null;
    if (!composeService) {
      throw new AppError("invalid_request", "Pick the Compose service the hostname goes to.", {
        fields: { composeService: "Pick one of the Compose file's services." },
      });
    }
  }
  const host =
    base.kind === "platform"
      ? await freeName(services.db, generatedNames(services, base.parent))
      : await freeName(services.db, zoneNames(service, base.zone.name, base.prefix), base.zone);
  if (!host) throw new AppError("conflict", "Couldn't find a free hostname. Try again.");
  if (base.kind === "zone" && !target.ipv4) {
    throw new AppError("conflict", cantCreateRecord(target));
  }
  const row = await saveHostname(services, {
    workspaceId: service.workspace_id,
    host,
    source: base.kind === "zone" ? "zone" : target.host ? "platform" : "server",
    zoneId: base.kind === "zone" ? base.zone.id : null,
    automatic: true,
    service,
    composeService,
    port: options.port ?? null,
    path: options.path ?? "/",
    target: target.id,
    recordIp: base.kind === "zone" ? target.ipv4 : null,
    zoneName: base.kind === "zone" ? base.zone.name : null,
    createdBy: options.createdBy,
    writeRoute: options.writeRoute,
  });
  await services.db
    .insertInto("service_hostname_state")
    .values({ service_id: service.id, automatic_declined: false })
    .onConflict((c) =>
      c.column("service_id").doUpdateSet({ automatic_declined: false, updated_at: new Date() }),
    )
    .execute();
  return { row, target };
}

/** "It loads once <server> has this DNS record" when the target's wildcard isn't there yet. */
export async function missingRecordNote(
  services: ControlServices,
  row: HostnameRow,
  target: TargetInfo,
) {
  if (row.source === "zone" || row.source === "own") return null;
  const record = wildcardRecord(services, target);
  if (!record) return null;
  const check = await dnsChecks(services).check(
    row.host,
    target.ipv4,
    false,
    target.unknownAddress,
  );
  if (check.status === "points_here") return null;
  return {
    record: {
      type: record.type,
      name: record.name,
      value: record.value,
      proxy: "DNS only" as const,
    },
    status: check.status,
    message: `It loads once ${target.name} has this DNS record: ${record.name} A ${record.value ?? "<server IPv4>"} (DNS only, not proxied).`,
  };
}

export async function serviceHostnames(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
) {
  const service = (await loadServices(services.db, actor.workspace.id, [serviceId])).get(serviceId);
  if (!service || !actor.access.can("service.see", serviceAccessTarget(service))) {
    throw new AppError(
      "not_found",
      "This service doesn't exist in this workspace, or you don't have access to it.",
    );
  }
  const rows = (await services.db
    .selectFrom("hostname")
    .select(HOSTNAME_COLUMNS)
    .where("service_id", "=", serviceId)
    .orderBy("created_at")
    .execute()) as HostnameRow[];
  return {
    hostnames: await buildViews(services, actor, rows),
    composeServices: service.kind === "compose" ? composeServicesOf(service.settings) : [],
    servicePort: defaultPort(service, null),
    canAdd: actor.access.can("service.hostnames", serviceAccessTarget(service)),
  };
}

/** What "Generate a domain" would give a service (spec 10.6), before anything is saved. */
export async function generateSuggestion(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
) {
  const service = (await loadServices(services.db, actor.workspace.id, [serviceId])).get(serviceId);
  if (!service)
    throw new AppError(
      "not_found",
      "This service doesn't exist in this workspace, or you don't have access to it.",
    );
  await requireServiceRights(actor, service);
  const target = (await describeTarget(services, targetOfService(service))) as TargetInfo;
  const base = await automaticBase(services, service, target, true);
  if (base.kind === "none") return { available: false, message: base.message, openDomains: true };
  const example =
    base.kind === "platform"
      ? `${generatedLabel(services.domains.random(GENERATED_LABEL_LENGTH))}.${base.parent}`
      : ((await freeName(
          services.db,
          zoneNames(service, base.zone.name, base.prefix),
          base.zone,
        )) ?? base.zone.name);
  let record = null;
  if (base.kind === "platform") {
    const wildcard = wildcardRecord(services, target);
    const check = await dnsChecks(services).check(
      `nzcheck${Date.now().toString(36)}.${base.parent}`,
      target.ipv4,
    );
    if (wildcard && check.status !== "points_here") {
      record = {
        type: "A" as const,
        name: wildcard.name,
        value: wildcard.value,
        proxy: "DNS only" as const,
        status: check.status,
        message: `It loads once ${target.name} has this DNS record.`,
      };
    }
  }
  return {
    available: true,
    hostname: example,
    base: base.kind,
    message: `It will be live at https://${example}`,
    record,
    composeServices: service.kind === "compose" ? composeServicesOf(service.settings) : [],
    servicePort: defaultPort(service, null),
  };
}

/**
 * The new-application page's Domain preview (spec 6.1), before the app exists: the hostname its
 * first deploy will get (a random label under the platform domain or the server's label, or a
 * name in the environment's default zone), and, when the workspace has a DNS zone the automatic
 * hostname doesn't come from, the name "Also assign a hostname from the workspace's DNS zone"
 * would add. No DNS is looked up, so the page never waits on resolvers.
 */
export async function newAppHostnamePreview(
  services: ControlServices,
  actor: WorkspaceActor,
  input: { environmentId: string; serverId: string; name: string },
) {
  const environment = /^[0-9a-f-]{36}$/.test(input.environmentId)
    ? await services.db
        .selectFrom("environment as e")
        .innerJoin("project as p", "p.id", "e.project_id")
        .select(["e.id", "e.project_id", "e.name", "p.name as project_name"])
        .where("e.id", "=", input.environmentId)
        .where("e.workspace_id", "=", actor.workspace.id)
        .executeTakeFirst()
    : undefined;
  if (
    !environment ||
    !actor.access.can("service.create", {
      kind: "environment",
      id: environment.id,
      projectId: environment.project_id,
    })
  ) {
    throw new AppError(
      "not_found",
      "This environment doesn't exist in this workspace, or you don't have access to it.",
    );
  }
  const targetId = input.serverId || HOST_TARGET;
  const found = canManageTarget(actor, targetId) ? await describeTarget(services, targetId) : null;
  // Another workspace's server is not found (B1-44).
  if (!ownTarget(actor, found)) throw new AppError("not_found", SERVER_NOT_FOUND);
  const target = found;
  const draft: ServiceInfo = {
    id: "new",
    workspace_id: actor.workspace.id,
    project_id: environment.project_id,
    environment_id: environment.id,
    kind: "application",
    name: input.name.trim() || "app",
    app_name: "",
    server_id: targetId === HOST_TARGET ? null : targetId,
    status: "idle",
    settings: {},
    project_name: environment.project_name,
    environment_name: environment.name,
  };
  const base = await automaticBase(services, draft, target, false);
  let hostname: string | null = null;
  let source: "platform" | "server" | "zone" | "none" = "none";
  let message: string;
  if (base.kind === "platform") {
    hostname = `${generatedLabel(services.domains.random(GENERATED_LABEL_LENGTH))}.${base.parent}`;
    source = target.host ? "platform" : "server";
    message = `The first deploy gives it a hostname like ${hostname}.`;
  } else if (base.kind === "zone") {
    hostname =
      (await freeName(services.db, zoneNames(draft, base.zone.name, base.prefix), base.zone)) ??
      base.zone.name;
    source = "zone";
    message = `The first deploy gives it ${hostname}.`;
  } else {
    message = base.message;
  }
  const zones = await services.db
    .selectFrom("dns_zone")
    .select(["id", "name"])
    .where("workspace_id", "=", actor.workspace.id)
    .orderBy("created_at")
    .orderBy("name")
    .execute();
  const other = zones.find((zone) => !(base.kind === "zone" && base.zone.id === zone.id));
  const zoneHostname = other
    ? await freeName(services.db, zoneNames(draft, other.name, ""), other)
    : null;
  return {
    hostname,
    source,
    message,
    // The one wildcard record its server needs (shown with the preview; not looked up here).
    record: (() => {
      const wildcard = base.kind === "platform" ? wildcardRecord(services, target) : null;
      return wildcard
        ? { type: "A" as const, name: wildcard.name, value: wildcard.value, proxy: "DNS only" }
        : null;
    })(),
    zoneOption:
      other && zoneHostname
        ? { zoneId: other.id, zoneName: other.name, hostname: zoneHostname }
        : null,
  };
}

export async function generateForService(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: { port?: number | undefined; path: string; composeService?: string | undefined },
) {
  const service = (await loadServices(services.db, actor.workspace.id, [serviceId])).get(serviceId);
  if (!service)
    throw new AppError(
      "not_found",
      "This service doesn't exist in this workspace, or you don't have access to it.",
    );
  await requireServiceRights(actor, service);
  if (service.kind !== "application" && service.kind !== "compose") {
    throw new AppError(
      "invalid_request",
      "Databases don't take hostnames. Connect the hostname to an app or a Compose service.",
    );
  }
  await refuseHostRoute(
    services,
    actor,
    service,
    service.kind === "compose"
      ? (input.composeService ?? composeWebService(service.settings)?.name ?? null)
      : null,
  );
  const target = (await describeTarget(services, targetOfService(service))) as TargetInfo;
  const base = await automaticBase(services, service, target, true);
  if (base.kind === "none") throw new AppError("conflict", base.message);
  const { row } = await assignAutomatic(services, service, base, {
    writeRoute: true,
    createdBy: actor.personId,
    port: input.port ?? null,
    path: input.path,
    composeService: input.composeService ?? null,
  });
  await checkRowDns(services, row).catch(() => {});
  kickTarget(services, target.id);
  await audit(services, actor, "hostname.added", row, { serviceId, automatic: true });
  return {
    hostname: await getHostname(services, actor, row.id),
    message: `Added ${row.host}. HTTPS starts working in a minute.`,
    missingRecord: await missingRecordNote(services, row, target),
  };
}

/** "Give N a hostname" (spec 10.2): the server's running apps and Compose services without one. */
export async function giveHostnames(
  services: ControlServices,
  actor: WorkspaceActor,
  targetId: string,
) {
  const candidates = await withoutHostnameOn(services, actor, targetId);
  const target = await describeTarget(services, targetId);
  if (!target)
    throw new AppError(
      "not_found",
      "This server doesn't exist in this workspace, or you don't have access to it.",
    );
  const given: string[] = [];
  const givenRows: HostnameRow[] = [];
  const problems: string[] = [];
  for (const service of candidates) {
    try {
      const composeService =
        service.kind === "compose" ? (composeWebService(service.settings)?.name ?? null) : null;
      if (
        await hostRouteRefusal(
          services.db,
          actor,
          {
            id: service.id,
            kind: service.kind,
            serverId: service.server_id,
            settings: service.settings,
          },
          composeService,
        )
      ) {
        problems.push(`${service.name}: ${HOST_ROUTE_REFUSAL}`);
        continue;
      }
      const base = await automaticBase(services, service, target, true);
      if (base.kind === "none") {
        problems.push(`${service.name}: ${base.message}`);
        continue;
      }
      const { row } = await assignAutomatic(services, service, base, {
        writeRoute: true,
        createdBy: actor.personId,
      });
      await checkRowDns(services, row).catch(() => {});
      await audit(services, actor, "hostname.added", row, {
        serviceId: service.id,
        automatic: true,
      });
      given.push(row.host);
      givenRows.push(row);
    } catch (error) {
      problems.push(`${service.name}: ${(error as Error).message}`);
    }
  }
  kickTarget(services, targetId);
  const got = `${given.length} ${given.length === 1 ? "service got its hostname" : "services got their hostnames"}.`;
  // Given before the server's record exists, they load once it does (spec 10.2, R3-21).
  const waiting = given.length > 0 ? await waitingRecord(services, target, givenRows) : null;
  return {
    given,
    problems,
    message:
      given.length === 0
        ? (problems[0] ?? "Every running service here already has a hostname.")
        : waiting
          ? `${got} They load once ${waiting} points at this server.`
          : `${got} It can take a minute for HTTPS to be ready.`,
  };
}

/**
 * The server's wildcard record, when hostnames just given under it are waiting for it (it
 * doesn't point here yet), else null. Hostnames in a managed zone get their record from
 * Nearzero, so they never wait for it.
 */
async function waitingRecord(
  services: ControlServices,
  target: TargetInfo,
  rows: readonly HostnameRow[],
): Promise<string | null> {
  const under = rows.find((row) => row.source === "platform" || row.source === "server");
  const record = wildcardRecord(services, target);
  if (!under || !record) return null;
  // The name was just looked up for its row, so this answer comes from the cache.
  const check = await dnsChecks(services)
    .check(under.host, target.ipv4, false, target.unknownAddress)
    .catch(() => null);
  return check?.status === "points_here" ? null : record.name;
}

/** Running apps and Compose services on a target with no hostname, that the person can reach. */
export async function withoutHostnameOn(
  services: ControlServices,
  actor: WorkspaceActor,
  targetId: string,
): Promise<ServiceInfo[]> {
  let query = services.db
    .selectFrom("service as s")
    .select("s.id")
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.kind", "in", ["application", "compose"])
    .where("s.status", "=", "running")
    .where("s.deleting_run_id", "is", null)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("hostname as h").select("h.id").whereRef("h.service_id", "=", "s.id"),
        ),
      ),
    );
  query =
    targetId === HOST_TARGET
      ? query.where("s.server_id", "is", null)
      : query.where("s.server_id", "=", targetId);
  const ids = (await query.execute()).map((row) => row.id);
  const loaded = await loadServices(services.db, actor.workspace.id, ids);
  return [...loaded.values()].filter((service) =>
    actor.access.can("service.hostnames", serviceAccessTarget(service)),
  );
}

// ---- Check DNS and Retry (spec 10.7)

/**
 * Check DNS: looks the name up again now, and has the server's router check its holds, so a
 * hostname whose DNS is right now is asked for at once.
 */
export async function checkHostnameDns(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
) {
  const row = await rowOrThrow(services, actor.workspace.id, id);
  await requireRowRights(services, actor, row);
  const check = await checkRowDns(services, row, true);
  if (row.service_id && services.runners.isOnline(row.target)) {
    const result = (await services.runners
      .command(row.target, "router.check-holds", {}, { timeoutMs: 60_000 })
      .catch(() => null)) as { released?: string[] } | null;
    if (result?.released?.includes(row.host)) {
      await services.db
        .updateTable("hostname")
        .set({ last_attempt_at: new Date() })
        .where("id", "=", row.id)
        .execute();
    }
    await refreshSnapshot(services, row.target);
  }
  return { hostname: await getHostname(services, actor, id), message: check.message };
}

/** Retry: asks Let's Encrypt again for one hostname, unless a rule of spec 10.7 refuses it. */
export async function retryCertificate(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
) {
  const row = await rowOrThrow(services, actor.workspace.id, id);
  await requireRowRights(services, actor, row);
  const check = await checkRowDns(services, row, true);
  const snapshot = row.service_id ? await refreshSnapshot(services, row.target) : undefined;
  const uploads = await uploadsFor(services, [row.target]);
  const facts = factsFor(
    { host: row.host, connected: row.service_id !== null, target: row.target },
    snapshot,
    uploads,
    check,
  );
  if (row.service_id && !snapshot?.status) {
    throw new AppError(
      "unavailable",
      `Couldn't read certificates on this server: ${snapshot?.error ?? "no answer"}`,
    );
  }
  const view = httpsView(facts, row.last_attempt_at?.getTime() ?? null);
  if (view.retryRefusal) throw new AppError("conflict", `Retry: ${view.retryRefusal}`);
  await services.runners.command(
    row.target,
    "certificates.retry",
    { hostname: row.host },
    { timeoutMs: 60_000 },
  );
  await services.db
    .updateTable("hostname")
    .set({ last_attempt_at: new Date() })
    .where("id", "=", row.id)
    .execute();
  await refreshSnapshot(services, row.target);
  return {
    hostname: await getHostname(services, actor, id),
    message: `Asking Let's Encrypt for ${row.host}; usually under a minute.`,
  };
}

export { HTTPS_STATE_LABELS };
