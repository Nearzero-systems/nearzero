import {
  AppError,
  caaText,
  checkRecord,
  checkZoneName,
  type DnsRecordType,
  dnsStatusSchema,
  isWithin,
  isZoneMailbox,
  type recordSchema,
  recordTarget,
  txtStrings,
  ZONE_MESSAGES,
  type zoneSchema,
  type zoneUpdateSchema,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { firstWorkspaceId } from "../workspaces/workspaces.ts";
import { consoleHostname, hostAddress } from "./addresses.ts";
import { followFirstZone, workspaceZones } from "./defaults.ts";
import { LookupError } from "./settings.ts";

/**
 * Managed DNS zones (spec 10.8): zones whose nameservers point at Nearzero's built-in DNS server
 * on the host. Records live in the database; Apply renders zone files and hands them to the
 * host's runner, which keeps the DNS server (CoreDNS with file zones) running only while a zone
 * exists (spec 03 3.1).
 */

export interface ZoneRow {
  id: string;
  workspace_id: string;
  name: string;
  admin_email: string;
  nameservers: string[];
  serial: string;
  applied_serial: string | null;
  applied_content: string | null;
  applied_at: Date | null;
  apply_error: string | null;
  health: unknown;
  health_checked_at: Date | null;
  created_at: Date;
}

export interface RecordRow {
  id: string;
  zone_id: string;
  name: string;
  type: DnsRecordType;
  value: string;
  ttl: number;
  priority: number | null;
  managed: boolean;
  hostname_id: string | null;
}

const ZONE_COLUMNS = [
  "id",
  "workspace_id",
  "name",
  "admin_email",
  "nameservers",
  "serial",
  "applied_serial",
  "applied_content",
  "applied_at",
  "apply_error",
  "health",
  "health_checked_at",
  "created_at",
] as const;

const RECORD_COLUMNS = [
  "id",
  "zone_id",
  "name",
  "type",
  "value",
  "ttl",
  "priority",
  "managed",
  "hostname_id",
] as const;

/** What the built-in DNS server answered at the last check, and what the internet sees. */
interface Health {
  running: boolean;
  reachable: boolean;
  servedSerial: number | null;
  message: string | null;
  /**
   * Public delegation (G3-10): the NS records public resolvers return for the zone, and why
   * they don't make it Nearzero's, when they don't. Absent in checks made before.
   */
  delegation?: { publicNameservers: string[]; ok: boolean; reason: string | null };
  /** Whether the host's public IPv4 answers SOA for the zone on port 53 (G3-10). */
  authoritative?: { address: string | null; ok: boolean; reason: string | null };
}

/**
 * A zone's state (spec 10.8, G3-10). "Live" means ready: applied, served by the built-in DNS
 * server, delegated to Nearzero's nameservers in public DNS, and answered for by the host's
 * public address. Published but not that: "Delegation pending".
 */
export type ZoneStatus = "live" | "delegation_pending" | "not_applied" | "needs_attention";
export const ZONE_STATUS_LABELS: Record<ZoneStatus, string> = {
  live: "Live",
  delegation_pending: "Delegation pending",
  not_applied: "Not applied yet",
  needs_attention: "Needs attention",
};

/** What ready needs beyond publishing (G3-10), as 0.1.x said it. */
export const ZONE_READY_NOTE =
  "Published means CoreDNS has the zone file. Ready additionally requires public NS delegation and a direct authoritative SOA response.";

/** A nameserver name as DNS answers compare: lowercase, without the final dot. */
function nameserverKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.$/, "");
}

export interface ZoneView {
  id: string;
  name: string;
  adminEmail: string;
  nameservers: string[];
  status: ZoneStatus;
  statusLabel: string;
  records: number;
  health: string;
  error: string | null;
  appliedAt: string | null;
  createdAt: string;
  /** What to do at the registrar (spec 10.8), with glue records for in-zone nameservers. */
  delegation: string;
  /** Published but not ready: why, and what ready needs (G3-10). */
  readiness: { ready: boolean; reasons: string[]; note: string };
}

// ---- Reading

async function zoneRows(db: Db, workspaceId: string, id?: string): Promise<ZoneRow[]> {
  let query = db
    .selectFrom("dns_zone")
    .select(ZONE_COLUMNS)
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at")
    .orderBy("name");
  if (id) query = query.where("id", "=", id);
  return (await query.execute()) as ZoneRow[];
}

async function zoneOrThrow(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<ZoneRow> {
  const [row] = /^[0-9a-f-]{36}$/.test(id)
    ? await zoneRows(services.db, actor.workspace.id, id)
    : [];
  if (!row) {
    throw new AppError(
      "not_found",
      "This DNS zone doesn't exist in this workspace, or you don't have access to it.",
    );
  }
  return row;
}

export async function recordsOf(db: Db, zoneIds: readonly string[]): Promise<RecordRow[]> {
  if (zoneIds.length === 0) return [];
  return (await db
    .selectFrom("dns_record")
    .select(RECORD_COLUMNS)
    .where("zone_id", "in", [...zoneIds])
    .orderBy("name")
    .orderBy("type")
    .orderBy("created_at")
    .execute()) as RecordRow[];
}

function healthOf(row: ZoneRow, records: number): { text: string; ok: boolean | null } {
  const health = row.health as Health | null;
  if (!health || !row.health_checked_at) return { text: "Not checked yet", ok: null };
  if (!health.running) {
    return {
      text: "Nearzero DNS isn't running yet. Apply the zone to start it; the host needs TCP and UDP port 53 free.",
      ok: false,
    };
  }
  if (!health.reachable) return { text: "Couldn't reach the DNS server.", ok: false };
  if (
    health.servedSerial !== null &&
    row.applied_serial !== null &&
    health.servedSerial >= Number(row.applied_serial)
  ) {
    return { text: `Serving ${records} ${records === 1 ? "record" : "records"}`, ok: true };
  }
  return { text: "The DNS server still serves an older version of this zone.", ok: false };
}

/** Why a published zone isn't ready yet (G3-10): empty when it is. */
function readinessReasons(row: ZoneRow): string[] {
  const health = row.health as Health | null;
  if (!health?.delegation || !health.authoritative) {
    return ["Public delegation and the host's answer haven't been checked yet"];
  }
  const reasons: string[] = [];
  if (!health.delegation.ok && health.delegation.reason) reasons.push(health.delegation.reason);
  if (!health.authoritative.ok && health.authoritative.reason)
    reasons.push(health.authoritative.reason);
  return reasons;
}

/**
 * What to do at the registrar (spec 10.8): delegate the zone, open port 53, and, when the
 * nameservers are inside the zone, create their glue records pointing at the host (G3-10).
 */
function delegationText(row: ZoneRow): string {
  const health = row.health as Health | null;
  const base = `At your registrar, set the nameservers of ${row.name} to ${row.nameservers.join(" and ")}, and allow TCP and UDP port 53 on the Nearzero host.`;
  const inside = row.nameservers.filter((name) => isWithin(nameserverKey(name), row.name));
  if (inside.length === 0) return base;
  const address = health?.authoritative?.address ?? null;
  return `${base} Because ${inside.join(" and ")} ${inside.length === 1 ? "is" : "are"} inside ${row.name}, also create glue (host) A records for ${inside.length === 1 ? "it" : "each nameserver"} at your registrar, pointing at ${address ?? "the Nearzero host's public IPv4"}.`;
}

export function zoneView(row: ZoneRow, records: number): ZoneView {
  const health = healthOf(row, records);
  const applied = row.applied_serial !== null && Number(row.applied_serial) >= Number(row.serial);
  const reasons = applied && health.ok === true ? readinessReasons(row) : [];
  const status: ZoneStatus =
    row.apply_error || health.ok === false
      ? "needs_attention"
      : !applied
        ? "not_applied"
        : health.ok === true && reasons.length === 0
          ? "live"
          : "delegation_pending";
  return {
    id: row.id,
    name: row.name,
    adminEmail: row.admin_email,
    nameservers: row.nameservers,
    status,
    statusLabel: ZONE_STATUS_LABELS[status],
    records,
    // Published, but the internet doesn't reach it yet: say what is missing (G3-10).
    health:
      status === "delegation_pending" && health.ok
        ? `Published. ${reasons.join(". ")}.`
        : health.text,
    error: row.apply_error,
    appliedAt: row.applied_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    delegation: delegationText(row),
    readiness: { ready: status === "live", reasons, note: ZONE_READY_NOTE },
  };
}

/**
 * Asks public DNS for the zone's NS records and the host's public address for its SOA, so a
 * zone reads ready only when the internet reaches it (G3-10).
 */
async function publicReadiness(
  services: ControlServices,
  zone: { name: string; nameservers: string[] },
  hostIPv4: string | null,
): Promise<Pick<Health, "delegation" | "authoritative">> {
  const expected = [...new Set(zone.nameservers.map(nameserverKey))].sort();
  let delegation: NonNullable<Health["delegation"]>;
  try {
    const found = [...new Set((await services.domains.dns.resolveNs(zone.name)).map(nameserverKey))]
      .filter(Boolean)
      .sort();
    const same = found.length === expected.length && found.every((name, i) => name === expected[i]);
    delegation = {
      publicNameservers: found,
      ok: same,
      reason: same ? null : `Public NS differs from Nearzero: ${found.join(", ")}`,
    };
  } catch (error) {
    const missing = error instanceof LookupError && error.kind !== "failed";
    delegation = {
      publicNameservers: [],
      ok: false,
      reason: missing
        ? "Public resolvers do not return NS records for this zone yet"
        : `Couldn't look up the zone's NS records just now: ${(error as Error).message}`,
    };
  }
  let authoritative: NonNullable<Health["authoritative"]>;
  if (!hostIPv4) {
    authoritative = {
      address: null,
      ok: false,
      reason:
        "Authoritative SOA check failed: Nearzero doesn't know the host's public IPv4 address. Correct it under About Nearzero",
    };
  } else {
    try {
      await services.domains.dns.soaSerialAt(`${hostIPv4}:53`, zone.name);
      authoritative = { address: hostIPv4, ok: true, reason: null };
    } catch (error) {
      authoritative = {
        address: hostIPv4,
        ok: false,
        reason: `Authoritative SOA check failed: ${hostIPv4} didn't answer for ${zone.name} on port 53 (${((error as Error).message || "no answer").replace(/[.\s]+$/, "")})`,
      };
    }
  }
  return { delegation, authoritative };
}

/**
 * The managed-zone step of About Nearzero's setup checklist (spec 18.2, B3-03): the zones, the
 * worst state among them, and what to look at. Null when the workspace has no zone.
 */
export async function zoneChecklist(
  services: ControlServices,
  workspaceId: string,
): Promise<{
  name: string;
  state: ZoneStatus;
  label: string;
  message: string;
  link: string;
} | null> {
  const rows = await zoneRows(services.db, workspaceId);
  if (rows.length === 0) return null;
  const records = await recordsOf(
    services.db,
    rows.map((row) => row.id),
  );
  const views = rows.map((row) =>
    zoneView(row, records.filter((record) => record.zone_id === row.id).length),
  );
  const worst =
    views.find((view) => view.status === "needs_attention") ??
    views.find((view) => view.status === "not_applied") ??
    views.find((view) => view.status === "delegation_pending") ??
    (views[0] as ZoneView);
  return {
    name: views.map((view) => view.name).join(", "),
    state: worst.status,
    label: worst.statusLabel,
    message:
      worst.status === "live"
        ? views.length === 1
          ? worst.health
          : `${views.length} zones are live.`
        : `${worst.name}: ${worst.error ?? worst.health}`,
    link: "/dashboard/domains?tab=dns-zones",
  };
}

export async function listZones(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<ZoneView[]> {
  await actor.access.require("dns.manage");
  const rows = await zoneRows(services.db, actor.workspace.id);
  const records = await recordsOf(
    services.db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => zoneView(row, records.filter((r) => r.zone_id === row.id).length));
}

export async function getZone(services: ControlServices, actor: WorkspaceActor, id: string) {
  await actor.access.require("dns.manage");
  const row = await zoneOrThrow(services, actor, id);
  const records = await recordsOf(services.db, [row.id]);
  return { zone: zoneView(row, records.length), records: records.map(recordView) };
}

export function recordView(row: RecordRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    value: row.value,
    ttl: row.ttl,
    priority: row.priority,
    managed: row.managed,
    managedNote: row.managed ? ZONE_MESSAGES.managed : null,
    hostnameId: row.hostname_id,
  };
}

// ---- Rendering zone files and the DNS server's configuration

function fqdn(value: string): string {
  const name = value.trim().toLowerCase();
  return name.endsWith(".") ? name : `${name}.`;
}

/**
 * The SOA mailbox form of an email: dots in the local part escaped, then the domain. An address
 * that isn't a plain mailbox (an old row, an imported record) becomes hostmaster of the zone, so
 * one zone's admin email can never break the zone file (CoreDNS stops serving every zone when
 * one file doesn't parse).
 */
export function soaMailbox(email: string, zone: string): string {
  const value = email.trim().toLowerCase();
  if (!isZoneMailbox(value)) return `hostmaster.${fqdn(zone)}`;
  const at = value.lastIndexOf("@");
  return `${value.slice(0, at).replaceAll(".", "\\.")}.${fqdn(value.slice(at + 1))}`;
}

function recordValue(record: Pick<RecordRow, "type" | "value" | "priority">, zone: string): string {
  switch (record.type) {
    case "CNAME":
    case "NS":
      // "@" is the apex and one word a name inside the zone, never a top-level name (G3-11).
      return recordTarget(record.value, zone);
    case "MX":
      return `${record.priority ?? 10} ${recordTarget(record.value, zone)}`;
    case "TXT":
      return txtStrings(record.value)
        .map((text) => `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
        .join(" ");
    case "CAA":
      return caaText(record.value);
    default:
      return record.value.trim();
  }
}

/** One zone file in the standard (RFC 1035) form CoreDNS's file plugin reads. */
export function renderZone(
  zone: { name: string; admin_email: string; nameservers: string[]; serial: number },
  records: readonly Pick<RecordRow, "name" | "type" | "value" | "ttl" | "priority">[],
): string {
  const lines = [
    "; Written by Nearzero. Changes here are replaced the next time the zone is applied.",
    `$ORIGIN ${fqdn(zone.name)}`,
    "$TTL 300",
    `@ IN SOA ${fqdn(zone.nameservers[0] ?? `ns1.${zone.name}`)} ${soaMailbox(zone.admin_email, zone.name)} ( ${zone.serial} 3600 600 604800 300 )`,
  ];
  for (const record of records) {
    lines.push(`${record.name} ${record.ttl} IN ${record.type} ${recordValue(record, zone.name)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The DNS server's configuration: one server block per zone, each reloaded within seconds. */
export function renderCorefile(zones: readonly string[]): string {
  const blocks = zones.map(
    (name) => `${name}:1053 {
    file /etc/nearzero/dns/zones/${name}.zone {
        reload 2s
    }
    reload 3s 1s
    errors
}`,
  );
  return `# Written by Nearzero. Changes here are replaced the next time zones are applied.\n${blocks.join("\n\n")}\n`;
}

// ---- Publishing (Apply)

/**
 * Publishes zones to the built-in DNS server on the host. `fresh` zones are rendered from their
 * records now; every other zone is published as it was last applied. With no zones left the
 * runner stops the DNS server.
 */
export async function publishZones(
  services: ControlServices,
  fresh: "all" | readonly string[],
): Promise<void> {
  const rows = (await services.db
    .selectFrom("dns_zone")
    .select(ZONE_COLUMNS)
    .orderBy("name")
    .execute()) as ZoneRow[];
  const renew = rows.filter(
    (row) => fresh === "all" || fresh.includes(row.id) || row.applied_content === null,
  );
  const records = await recordsOf(
    services.db,
    renew.map((row) => row.id),
  );
  const rendered = new Map<string, { content: string; serial: string }>();
  for (const row of renew) {
    rendered.set(row.id, {
      serial: row.serial,
      content: renderZone(
        { ...row, serial: Number(row.serial) },
        records.filter((record) => record.zone_id === row.id),
      ),
    });
  }
  const zones = rows.map((row) => ({
    name: row.name,
    content: rendered.get(row.id)?.content ?? (row.applied_content as string),
  }));
  try {
    await services.runners.command(
      HOST_TARGET,
      "dns.apply",
      { corefile: renderCorefile(zones.map((zone) => zone.name)), zones },
      { timeoutMs: 120_000 },
    );
  } catch (error) {
    const message = `Couldn't publish to Nearzero DNS: ${(error as Error).message}`;
    if (renew.length > 0) {
      await services.db
        .updateTable("dns_zone")
        .set({ apply_error: message, updated_at: new Date() })
        .where(
          "id",
          "in",
          renew.map((row) => row.id),
        )
        .execute();
    }
    throw new AppError("unavailable", message);
  }
  for (const row of renew) {
    const done = rendered.get(row.id) as { content: string; serial: string };
    await services.db
      .updateTable("dns_zone")
      .set({
        applied_serial: done.serial,
        applied_content: done.content,
        applied_at: new Date(),
        apply_error: null,
        // A managed change made while publishing is published next time.
        auto_apply: sql<boolean>`serial <> ${done.serial}::bigint AND auto_apply`,
      })
      .where("id", "=", row.id)
      .execute();
  }
}

/**
 * Asks the DNS server what it serves, and keeps the answer for the zones tab. With `settle`, it
 * asks a few times over some seconds while the server still answers an older serial (it reloads
 * changed files within seconds of an Apply).
 */
export async function checkZoneHealth(
  services: ControlServices,
  zoneIds?: readonly string[],
  settle = false,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const behind = await checkZoneHealthOnce(services, zoneIds);
    if (!settle || !behind || attempt >= 7) return;
    await services.domains.sleep(1_000);
  }
}

/** One look; true when a running server still serves an older version of a zone. */
async function checkZoneHealthOnce(
  services: ControlServices,
  zoneIds?: readonly string[],
): Promise<boolean> {
  let query = services.db
    .selectFrom("dns_zone")
    .select(["id", "name", "applied_serial", "nameservers"]);
  if (zoneIds) {
    if (zoneIds.length === 0) return false;
    query = query.where("id", "in", [...zoneIds]);
  }
  const zones = await query.execute();
  if (zones.length === 0) return false;
  let health: Map<string, Health>;
  try {
    const data = dnsStatusSchema.parse(
      await services.runners.command(
        HOST_TARGET,
        "dns.status",
        { zones: zones.map((z) => z.name) },
        { timeoutMs: 20_000 },
      ),
    );
    health = new Map(
      zones.map((zone) => {
        const served = data.zones.find((item) => item.name === zone.name)?.serial ?? null;
        return [
          zone.id,
          {
            running: data.running,
            reachable: data.running && served !== null,
            servedSerial: served,
            message: data.error,
          },
        ];
      }),
    );
  } catch (error) {
    health = new Map(
      zones.map((zone) => [
        zone.id,
        { running: true, reachable: false, servedSerial: null, message: (error as Error).message },
      ]),
    );
  }
  let behind = false;
  const hostIPv4 = await hostAddress(services).catch(() => null);
  for (const zone of zones) {
    const found = health.get(zone.id) as Health;
    if (
      found.running &&
      zone.applied_serial !== null &&
      (found.servedSerial ?? 0) < Number(zone.applied_serial)
    ) {
      behind = true;
    }
    // Served: is it reachable from the internet too (G3-10)?
    if (found.reachable) Object.assign(found, await publicReadiness(services, zone, hostIPv4));
    await services.db
      .updateTable("dns_zone")
      .set({ health: JSON.stringify(found), health_checked_at: new Date() })
      .where("id", "=", zone.id)
      .execute();
  }
  return behind;
}

/** Publishes zones whose managed records changed (hostnames added or removed). */
export async function publishPendingZones(services: ControlServices): Promise<void> {
  const pending = await services.db
    .selectFrom("dns_zone")
    .select("id")
    .where("auto_apply", "=", true)
    .execute();
  if (pending.length === 0 || !services.runners.isOnline(HOST_TARGET)) return;
  const ids = pending.map((row) => row.id);
  await publishZones(services, ids).catch((error: unknown) =>
    services.log.warn("couldn't publish managed DNS changes", { error }),
  );
  await checkZoneHealth(services, ids, true).catch(() => {});
}

// ---- Managed records: the zone's nameservers

async function nameserverRecords(
  services: ControlServices,
  db: Db,
  zone: { id: string; name: string; nameservers: string[] },
): Promise<void> {
  await db
    .deleteFrom("dns_record")
    .where("zone_id", "=", zone.id)
    .where("managed", "=", true)
    .where("hostname_id", "is", null)
    .execute();
  const rows: {
    zone_id: string;
    name: string;
    type: DnsRecordType;
    value: string;
    ttl: number;
    managed: boolean;
  }[] = [];
  for (const ns of zone.nameservers)
    rows.push({ zone_id: zone.id, name: "@", type: "NS", value: ns, ttl: 3600, managed: true });
  const inside = zone.nameservers.filter((ns) => ns.endsWith(`.${zone.name}`));
  if (inside.length > 0) {
    const ip = await hostAddress(services);
    if (!ip) {
      throw new AppError(
        "conflict",
        "Nearzero doesn't know the host's public IPv4 address, so its nameservers can't get one. Correct it under About Nearzero, then try again.",
      );
    }
    for (const ns of inside) {
      rows.push({
        zone_id: zone.id,
        name: ns.slice(0, -(zone.name.length + 1)),
        type: "A",
        value: ip,
        ttl: 3600,
        managed: true,
      });
    }
  }
  if (rows.length > 0) await db.insertInto("dns_record").values(rows).execute();
}

/**
 * The console's own address record in a zone that covers it (R3-12): when the install's zone,
 * or another zone of the instance administrators' workspace, contains the console's hostname,
 * Nearzero creates `<console> A <host IPv4>` there, managed like the nameservers' records, so
 * the console resolves as soon as the zone is delegated. A person's own address record at that
 * name is left alone. True when it added one.
 */
export async function consoleRecord(
  services: ControlServices,
  db: Db,
  zone: { id: string; name: string; workspaceId: string },
): Promise<boolean> {
  const host = await consoleHostname(services);
  if (!host || !isWithin(host, zone.name)) return false;
  if (zone.workspaceId !== (await firstWorkspaceId(db))) return false;
  const ip = await hostAddress(services);
  if (!ip) return false;
  const name = host === zone.name ? "@" : host.slice(0, -(zone.name.length + 1));
  const existing = await db
    .selectFrom("dns_record")
    .select("id")
    .where("zone_id", "=", zone.id)
    .where("name", "=", name)
    .where("type", "in", ["A", "AAAA", "CNAME"])
    .executeTakeFirst();
  if (existing) return false;
  await db
    .insertInto("dns_record")
    .values({ zone_id: zone.id, name, type: "A", value: ip, ttl: 300, managed: true })
    .execute();
  return true;
}

function defaultNameservers(services: ControlServices, zone: string): string[] {
  const parent = services.domains.platformDomain ?? zone;
  return [`ns1.${parent}`, `ns2.${parent}`];
}

function checkNameservers(raw: readonly string[] | undefined): string[] | null {
  if (!raw) return null;
  const list = raw
    .map((ns) => ns.trim().toLowerCase().replace(/\.$/, ""))
    .filter((ns) => ns !== "");
  if (list.length === 0) return null;
  for (const ns of list) {
    const checked = checkZoneName(ns);
    if (!checked.ok) {
      throw new AppError("invalid_request", `"${ns}" isn't a valid nameserver hostname.`, {
        fields: { nameservers: `"${ns}" isn't a valid nameserver hostname.` },
      });
    }
  }
  return [...new Set(list)];
}

// ---- Changes

/** What Connect a DNS zone says, with how many automatic hostnames moved into a first zone. */
export function connectedMessage(
  zone: string,
  first: boolean,
  moved: number,
  pending: number,
): string {
  if (!first) return "DNS zone connected";
  const hostnames = (n: number) => `${n} automatic ${n === 1 ? "hostname" : "hostnames"}`;
  if (moved === 0 && pending === 0) {
    return `DNS zone connected. It's now the default for automatic hostnames; none needed moving.`;
  }
  const now = moved > 0 ? ` ${hostnames(moved)} moved into ${zone}.` : "";
  const later =
    pending > 0
      ? ` ${moved > 0 ? `${pending} more` : hostnames(pending)} ${pending === 1 ? "moves" : "move"} into ${zone} at the next deploy, once ${pending === 1 ? "its server answers" : "their servers answer"}.`
      : "";
  return `DNS zone connected.${now}${later}`;
}

export async function connectZone(
  services: ControlServices,
  actor: WorkspaceActor,
  input: z.output<typeof zoneSchema>,
): Promise<{ zone: ZoneView; moved: number; pending: number; message: string }> {
  await actor.access.require("dns.manage");
  const checked = checkZoneName(input.domain);
  if (!checked.ok)
    throw new AppError("invalid_request", checked.message, { fields: { domain: checked.message } });
  const name = checked.hostname;
  const covered = nearzeroNamesIn(services, name);
  if (covered && !actor.isInstanceAdmin) {
    const message = `This DNS zone covers Nearzero's own address ${covered}, so only an instance administrator can connect it.`;
    throw new AppError("forbidden", message, { fields: { domain: message } });
  }
  const nameservers = checkNameservers(input.nameservers) ?? defaultNameservers(services, name);
  const id = await createZoneRow(services, {
    workspaceId: actor.workspace.id,
    name,
    adminEmail: input.adminEmail,
    nameservers,
    createdBy: actor.personId,
  });
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "dns-zone.connected",
    workspaceId: actor.workspace.id,
    target: { kind: "dns_zone", id },
    details: { name, nameservers },
  });
  await publishZones(services, [id]).catch(() => {});
  await checkZoneHealth(services, [id], true).catch(() => {});
  // The first zone becomes every environment's default, and the automatic hostnames that
  // follow it move into it now (R3-13).
  const first = (await workspaceZones(services.db, actor.workspace.id))[0]?.id === id;
  const { moved, pending } = first
    ? await followFirstZone(services, actor.workspace.id)
    : { moved: 0, pending: 0 };
  const [row] = await zoneRows(services.db, actor.workspace.id, id);
  const records = await recordsOf(services.db, [id]);
  return {
    zone: zoneView(row as ZoneRow, records.length),
    moved,
    pending,
    message: connectedMessage(name, first, moved, pending),
  };
}

/** Serializes zone connects (an arbitrary constant, unique to this lock). */
const ZONE_CONNECT_LOCK = 7_310_853_201;

/**
 * Why a zone named `name` can't be connected for `workspaceId`, if it can't: the built-in DNS
 * server answers every workspace's zones and picks the most specific one for each question, so
 * a zone inside, or around, another workspace's zone would answer for that workspace's names
 * (spec 10.8, 22.4 rule 1). Zones of the same workspace may nest.
 */
export function overlapOf(
  zones: readonly { name: string; workspace_id: string }[],
  name: string,
  workspaceId: string,
): string | null {
  const same = zones.find((zone) => zone.name === name);
  if (same) {
    return same.workspace_id === workspaceId
      ? ZONE_MESSAGES.takenHere
      : ZONE_MESSAGES.takenElsewhere;
  }
  const other = zones.find(
    (zone) =>
      zone.workspace_id !== workspaceId && (isWithin(name, zone.name) || isWithin(zone.name, name)),
  );
  if (!other) return null;
  return isWithin(name, other.name)
    ? "This DNS zone is inside a zone another workspace manages, so it can't be connected here."
    : "This DNS zone contains a zone another workspace manages, so it can't be connected here.";
}

/**
 * The install's own name (the console's address or the platform domain) a zone would answer
 * for, or sit inside, if any. Only instance administrators connect such zones.
 */
export function nearzeroNamesIn(services: ControlServices, name: string): string | null {
  for (const own of [services.domains.managementHostname, services.domains.platformDomain]) {
    if (own && (isWithin(own, name) || isWithin(name, own))) return own;
  }
  return null;
}

async function createZoneRow(
  services: ControlServices,
  input: {
    workspaceId: string;
    name: string;
    adminEmail: string;
    nameservers: string[];
    createdBy: string | null;
  },
): Promise<string> {
  try {
    return await services.db.transaction().execute(async (trx) => {
      // One connect at a time, so two overlapping zones can't both pass the check below.
      await sql`select pg_advisory_xact_lock(${ZONE_CONNECT_LOCK})`.execute(trx);
      const clash = overlapOf(
        await trx.selectFrom("dns_zone").select(["name", "workspace_id"]).execute(),
        input.name,
        input.workspaceId,
      );
      if (clash) throw new AppError("conflict", clash, { fields: { domain: clash } });
      const row = await trx
        .insertInto("dns_zone")
        .values({
          workspace_id: input.workspaceId,
          name: input.name,
          admin_email: input.adminEmail,
          nameservers: input.nameservers,
          created_by: input.createdBy,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await nameserverRecords(services, trx, {
        id: row.id,
        name: input.name,
        nameservers: input.nameservers,
      });
      await consoleRecord(services, trx, {
        id: row.id,
        name: input.name,
        workspaceId: input.workspaceId,
      });
      return row.id;
    });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new AppError("conflict", ZONE_MESSAGES.takenElsewhere, {
        fields: { domain: ZONE_MESSAGES.takenElsewhere },
      });
    }
    throw error;
  }
}

/** The zone named at install (NEARZERO_MANAGED_DNS_ZONE) belongs to the first workspace. */
export async function ensureInstallZone(services: ControlServices): Promise<void> {
  const name = services.domains.managedZone;
  if (!name) return;
  const exists = await services.db
    .selectFrom("dns_zone")
    .select("id")
    .where("name", "=", name)
    .executeTakeFirst();
  if (exists) {
    // An install whose zone came before this record gets it now, once.
    const row = await services.db
      .selectFrom("dns_zone")
      .select(["id", "workspace_id"])
      .where("id", "=", exists.id)
      .executeTakeFirstOrThrow();
    const added = await consoleRecord(services, services.db, {
      id: row.id,
      name,
      workspaceId: row.workspace_id,
    });
    if (added) await publishZones(services, [row.id]).catch(() => {});
    return;
  }
  const install = await services.db
    .selectFrom("install_state")
    .select("first_workspace_id")
    .executeTakeFirst();
  if (!install) return;
  if (!(await hostAddress(services))) return;
  await createZoneRow(services, {
    workspaceId: install.first_workspace_id,
    name,
    adminEmail: services.domains.managedZoneEmail ?? `hostmaster@${name}`,
    nameservers: [`ns1.${name}`, `ns2.${name}`],
    createdBy: null,
  });
  services.log.info("connected the install's managed DNS zone", { zone: name });
}

export async function updateZone(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  input: z.output<typeof zoneUpdateSchema>,
): Promise<ZoneView> {
  await actor.access.require("dns.manage");
  const row = await zoneOrThrow(services, actor, id);
  const nameservers = checkNameservers(input.nameservers) ?? row.nameservers;
  await services.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("dns_zone")
      .set({
        ...(input.adminEmail ? { admin_email: input.adminEmail } : {}),
        nameservers,
        serial: sql<string>`serial + 1`,
        updated_at: new Date(),
      })
      .where("id", "=", id)
      .execute();
    await nameserverRecords(services, trx, { id, name: row.name, nameservers });
    await consoleRecord(services, trx, { id, name: row.name, workspaceId: row.workspace_id });
  });
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "dns-zone.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "dns_zone", id },
    details: { name: row.name, nameservers },
  });
  return (await getZone(services, actor, id)).zone;
}

export async function applyZone(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string | "all",
) {
  await actor.access.require("dns.manage");
  const ids =
    id === "all"
      ? (await zoneRows(services.db, actor.workspace.id)).map((row) => row.id)
      : [(await zoneOrThrow(services, actor, id)).id];
  await publishZones(services, ids);
  await checkZoneHealth(services, ids, true);
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "dns-zone.applied",
    workspaceId: actor.workspace.id,
    details: { zones: ids.length },
  });
  return listZones(services, actor);
}

export async function removeZone(services: ControlServices, actor: WorkspaceActor, id: string) {
  await actor.access.require("dns.manage");
  const row = await zoneOrThrow(services, actor, id);
  const used = await services.db
    .selectFrom("hostname as h")
    .innerJoin("service as s", "s.id", "h.service_id")
    .select(["h.host", "s.name"])
    .where("h.zone_id", "=", id)
    .orderBy("h.host")
    .execute();
  if (used.length > 0) {
    const list = used
      .slice(0, 10)
      .map((item) => `${item.host} (${item.name})`)
      .join(", ");
    throw new AppError(
      "conflict",
      `Services still use hostnames in ${row.name}: ${list}${used.length > 10 ? `, and ${used.length - 10} more` : ""}. Remove those hostnames first.`,
    );
  }
  await services.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("hostname").where("zone_id", "=", id).execute();
    await trx.deleteFrom("dns_zone").where("id", "=", id).execute();
  });
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "dns-zone.removed",
    workspaceId: actor.workspace.id,
    target: { kind: "dns_zone", id },
    details: { name: row.name },
  });
  await publishZones(services, []).catch((error: unknown) =>
    services.log.warn("couldn't publish DNS after removing a zone", { error }),
  );
  return { removed: true, message: `Removed ${row.name}.` };
}

// ---- Records

async function recordChecks(
  services: ControlServices,
  zone: ZoneRow,
  input: z.output<typeof recordSchema>,
  exceptId?: string,
) {
  const others = (await recordsOf(services.db, [zone.id])).filter(
    (record) => record.id !== exceptId,
  );
  const problems = checkRecord(input, zone.name, others);
  if (problems) {
    const first = Object.values(problems)[0] as string;
    throw new AppError("invalid_request", first, { fields: problems });
  }
  const name = input.name.trim().toLowerCase();
  const relative =
    name === "" || name === "@" || name === zone.name || name === `${zone.name}.`
      ? "@"
      : name.replace(/\.$/, "").endsWith(`.${zone.name}`)
        ? name.replace(/\.$/, "").slice(0, -(zone.name.length + 1))
        : name;
  // Nearzero's own address record at a name (a hostname's, or a nameserver's) is the only one
  // there: another A, an AAAA or a CNAME beside it would split or break its traffic.
  if (
    (input.type === "A" || input.type === "AAAA" || input.type === "CNAME") &&
    others.some((record) => record.managed && record.type === "A" && record.name === relative)
  ) {
    const full = relative === "@" ? zone.name : `${relative}.${zone.name}`;
    const message = `Nearzero manages the address of ${full}. Remove that hostname under Domains first, or use another name.`;
    throw new AppError("conflict", message, { fields: { name: message } });
  }
  // A CAA value is kept in its standard form, its value quoted (G3-11).
  return {
    relative,
    value: input.type === "CAA" ? caaText(input.value) : input.value.trim(),
  };
}

export async function addRecord(
  services: ControlServices,
  actor: WorkspaceActor,
  zoneId: string,
  input: z.output<typeof recordSchema>,
) {
  await actor.access.require("dns.manage");
  const zone = await zoneOrThrow(services, actor, zoneId);
  const { relative, value } = await recordChecks(services, zone, input);
  const row = await services.db
    .insertInto("dns_record")
    .values({
      zone_id: zone.id,
      name: relative,
      type: input.type,
      value,
      ttl: input.ttl,
      // A blank MX priority is 10 (G3-11).
      priority: input.type === "MX" ? (input.priority ?? 10) : null,
    })
    .returning(RECORD_COLUMNS)
    .executeTakeFirstOrThrow();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "dns-record.added",
    workspaceId: actor.workspace.id,
    target: { kind: "dns_zone", id: zone.id },
    details: { name: relative, type: input.type },
  });
  return recordView(row as RecordRow);
}

async function editableRecord(
  services: ControlServices,
  zone: ZoneRow,
  recordId: string,
): Promise<RecordRow> {
  const record = /^[0-9a-f-]{36}$/.test(recordId)
    ? ((await services.db
        .selectFrom("dns_record")
        .select(RECORD_COLUMNS)
        .where("id", "=", recordId)
        .where("zone_id", "=", zone.id)
        .executeTakeFirst()) as RecordRow | undefined)
    : undefined;
  if (!record) throw new AppError("not_found", "That record isn't in this zone any more.");
  if (record.managed) {
    throw new AppError(
      "forbidden",
      "Managed by Nearzero: this record follows the zone's nameservers and hostnames, so it can't be changed here.",
    );
  }
  return record;
}

export async function updateRecord(
  services: ControlServices,
  actor: WorkspaceActor,
  zoneId: string,
  recordId: string,
  input: z.output<typeof recordSchema>,
) {
  await actor.access.require("dns.manage");
  const zone = await zoneOrThrow(services, actor, zoneId);
  await editableRecord(services, zone, recordId);
  const { relative, value } = await recordChecks(services, zone, input, recordId);
  const row = await services.db
    .updateTable("dns_record")
    .set({
      name: relative,
      type: input.type,
      value,
      ttl: input.ttl,
      priority: input.type === "MX" ? (input.priority ?? 10) : null,
      updated_at: new Date(),
    })
    .where("id", "=", recordId)
    .returning(RECORD_COLUMNS)
    .executeTakeFirstOrThrow();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "dns-record.updated",
    workspaceId: actor.workspace.id,
    target: { kind: "dns_zone", id: zone.id },
    details: { name: relative, type: input.type },
  });
  return recordView(row as RecordRow);
}

export async function deleteRecord(
  services: ControlServices,
  actor: WorkspaceActor,
  zoneId: string,
  recordId: string,
) {
  await actor.access.require("dns.manage");
  const zone = await zoneOrThrow(services, actor, zoneId);
  const record = await editableRecord(services, zone, recordId);
  await services.db.deleteFrom("dns_record").where("id", "=", recordId).execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "dns-record.deleted",
    workspaceId: actor.workspace.id,
    target: { kind: "dns_zone", id: zone.id },
    details: { name: record.name, type: record.type },
  });
  return { deleted: true };
}

/** The zone of this workspace a hostname falls in, if any (the longest match). */
export async function zoneForHost(db: Db, workspaceId: string | null, host: string) {
  let query = db.selectFrom("dns_zone").select(["id", "name", "workspace_id"]);
  if (workspaceId) query = query.where("workspace_id", "=", workspaceId);
  const zones = await query.execute();
  return (
    zones
      .filter((zone) => host === zone.name || host.endsWith(`.${zone.name}`))
      .sort((a, b) => b.name.length - a.name.length)[0] ?? null
  );
}
