import { isIPv4, isPublicIPv4, serverWildcardName } from "@nearzero/shared";
import { HOST_TARGET } from "../runners/hub.ts";
import type { ControlServices } from "../services.ts";
import { LookupError } from "./settings.ts";

/**
 * Where hostnames point (spec 10.1, 10.2, 18.2): the Nearzero host's public IPv4 (detected at
 * install, or corrected by an instance administrator), each server's address and label, the
 * platform domain and the console's own hostname. Also the naming rules routes for hostnames
 * follow, which the deploy pipeline uses too.
 */

export interface TargetInfo {
  /** A server id, or "host". */
  id: string;
  name: string;
  host: boolean;
  /** The server's label (spec 10.2); null for the host. */
  label: string | null;
  /** Its public IPv4, or null when unknown. */
  ipv4: string | null;
  /** When ipv4 is unknown: why, and where to fix it, in plain words. */
  unknownAddress: string | null;
  /** Unknown only because the server's name didn't resolve just now (R3-10). */
  lookupFailed?: boolean;
  workspaceId: string | null;
}

export const HOST_ADDRESS_UNKNOWN =
  "Nearzero doesn't know the Nearzero host's public IPv4 address. Correct it under About Nearzero.";

/** What a server's address resolved to through public DNS: its A records, or null on failure. */
type Resolved = string[] | null;

const RESOLVED_FOR_MS = 5 * 60_000;
const FAILED_FOR_MS = 60_000;
const resolvedNames = new WeakMap<ControlServices, Map<string, { at: number; value: Resolved }>>();

/** A server address that is a hostname, looked up through public DNS and kept for a while. */
async function resolveServerName(services: ControlServices, name: string): Promise<Resolved> {
  let cache = resolvedNames.get(services);
  if (!cache) {
    cache = new Map();
    resolvedNames.set(services, cache);
  }
  const hit = cache.get(name);
  if (hit && Date.now() - hit.at < (hit.value === null ? FAILED_FOR_MS : RESOLVED_FOR_MS)) {
    return hit.value;
  }
  let value: Resolved;
  try {
    value = await services.domains.dns.resolve4(name);
  } catch (error) {
    value = error instanceof LookupError && error.kind !== "failed" ? [] : null;
  }
  cache.set(name, { at: Date.now(), value });
  if (cache.size > 2_000) cache.clear();
  return value;
}

/** Forgets what a server address resolved to (its record was just edited). */
export function forgetServerName(services: ControlServices, name: string): void {
  resolvedNames.get(services)?.delete(name);
}

/** Addresses only a private network reaches: RFC 1918, shared (CGNAT), loopback, link-local. */
export function isPrivateIPv4(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254)
  );
}

/**
 * A server's public IPv4 (spec 09 9.2, 10.2, 10.7): the one a person set, else its address when
 * that is an IPv4 address the internet reaches, else what its hostname resolves to when that is
 * exactly one public IPv4. Otherwise null, with the reason naming the server's address.
 */
export function serverIPv4(
  server: { name: string; address: string; public_ipv4: string | null },
  resolved: Resolved | undefined,
): { ipv4: string | null; unknownAddress: string | null; lookupFailed?: boolean } {
  if (server.public_ipv4) return { ipv4: server.public_ipv4, unknownAddress: null };
  const fix = `Set its public IPv4 under Servers → ${server.name} → Edit.`;
  if (isIPv4(server.address)) {
    if (!isPrivateIPv4(server.address)) return { ipv4: server.address, unknownAddress: null };
    // Reached over a private network (a VPC): the internet reaches it elsewhere.
    return {
      ipv4: null,
      unknownAddress: `${server.address}, the address of ${server.name}, is a private address, so Nearzero doesn't know where its hostnames should point. ${fix}`,
    };
  }
  if (resolved === undefined || resolved === null) {
    return {
      ipv4: null,
      lookupFailed: true,
      unknownAddress: `Nearzero couldn't look up ${server.address}, the address of ${server.name}, just now, so it doesn't know its public IPv4 address. Try again in a moment, or ${fix.charAt(0).toLowerCase()}${fix.slice(1)}`,
    };
  }
  const public4 = [...new Set(resolved.filter((ip) => isPublicIPv4(ip)))];
  if (public4.length === 1 && resolved.length === 1) {
    return { ipv4: public4[0] as string, unknownAddress: null };
  }
  if (resolved.length === 0 || public4.length === 0) {
    return {
      ipv4: null,
      unknownAddress: `${server.address}, the address of ${server.name}, doesn't resolve to a public IPv4 address, so Nearzero doesn't know where its hostnames should point. ${fix}`,
    };
  }
  return {
    ipv4: null,
    unknownAddress: `${server.address}, the address of ${server.name}, resolves to several addresses (${resolved.join(", ")}), so Nearzero can't tell which one its hostnames should point at. ${fix}`,
  };
}

async function setting(
  services: ControlServices,
  key: "public_ipv4" | "console_hostname" | "console_acme_email",
) {
  const row = await services.db
    .selectFrom("address_setting")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  return row?.value ?? null;
}

/** The host's public IPv4: an administrator's correction, else the install's. */
export async function hostAddress(services: ControlServices): Promise<string | null> {
  return (await setting(services, "public_ipv4")) ?? services.runners.hostPublicIPv4;
}

/** The console's hostname: set under About Nearzero, else the install's. */
export async function consoleHostname(services: ControlServices): Promise<string | null> {
  return (await setting(services, "console_hostname")) ?? services.domains.managementHostname;
}

/** The certificate contact: set under About Nearzero, else the install's (spec 10.1, 10.9). */
export async function consoleAcmeEmail(services: ControlServices): Promise<string | null> {
  return (await savedAcmeEmail(services)) ?? services.domains.acmeEmail;
}

/** The certificate contact set under About Nearzero, or null when none was saved. */
export function savedAcmeEmail(services: ControlServices): Promise<string | null> {
  return setting(services, "console_acme_email");
}

export async function describeTargets(
  services: ControlServices,
  ids: readonly string[],
): Promise<Map<string, TargetInfo>> {
  const out = new Map<string, TargetInfo>();
  const unique = [...new Set(ids)];
  if (unique.includes(HOST_TARGET)) {
    const ipv4 = await hostAddress(services);
    out.set(HOST_TARGET, {
      id: HOST_TARGET,
      name: "Nearzero host",
      host: true,
      label: null,
      ipv4,
      unknownAddress: ipv4 ? null : HOST_ADDRESS_UNKNOWN,
      workspaceId: null,
    });
  }
  const serverIds = unique.filter((id) => id !== HOST_TARGET && /^[0-9a-f-]{36}$/.test(id));
  if (serverIds.length > 0) {
    const rows = await services.db
      .selectFrom("server")
      .select(["id", "name", "label", "address", "public_ipv4", "workspace_id"])
      .where("id", "in", serverIds)
      .execute();
    // Hostnames are looked up together, so N servers cost one lookup's time, not N.
    const names = [
      ...new Set(
        rows.filter((row) => !row.public_ipv4 && !isIPv4(row.address)).map((row) => row.address),
      ),
    ];
    const resolved = new Map(
      await Promise.all(
        names.map(async (name) => [name, await resolveServerName(services, name)] as const),
      ),
    );
    const found = rows.map((row) => ({ row, ...serverIPv4(row, resolved.get(row.address)) }));
    // What a name resolves to holds an address only while no one else has a better claim on it
    // (B1-15, see addressHolders).
    const viaName = found.filter(
      (item) => item.ipv4 && !item.row.public_ipv4 && !isIPv4(item.row.address),
    );
    if (viaName.length > 0) {
      const holders = await addressHolders(
        services,
        services.db,
        viaName.map((item) => item.ipv4 as string),
      );
      for (const item of viaName) {
        const ip = item.ipv4 as string;
        const holder = holders.get(ip) as AddressHolder;
        const workspace = item.row.workspace_id;
        const otherSet = holder.set.some((id) => id !== workspace);
        const ownSet = holder.set.includes(workspace);
        const earlierName = !ownSet && holder.named !== undefined && holder.named !== workspace;
        const owner =
          otherSet || earlierName
            ? "a server in another workspace"
            : holder.host
              ? "the Nearzero host"
              : null;
        if (!owner) continue;
        item.ipv4 = null;
        item.unknownAddress = `${item.row.address}, the address of ${item.row.name}, resolves to ${ip}, which belongs to ${owner}, so Nearzero won't point its hostnames there. Set its public IPv4 under Servers → ${item.row.name} → Edit.`;
      }
    }
    for (const { row, ipv4, unknownAddress, lookupFailed } of found) {
      out.set(row.id, {
        id: row.id,
        name: row.name,
        host: false,
        label: row.label,
        ipv4,
        unknownAddress,
        ...(lookupFailed && !ipv4 ? { lookupFailed: true } : {}),
        workspaceId: row.workspace_id,
      });
    }
  }
  return out;
}

// ---- Who holds a public address (B1-15)
//
// A hostname counts as pointing at a server when it resolves to the server's address, so an
// address proves control of names only while one workspace holds it (spec 30, decisions part
// 2, "A server's public address can't be another workspace's"):
// - an address that is set (a server's public IPv4, or an address that is an IPv4 address) is
//   checked against other workspaces when it is saved, so the first workspace to save it holds
//   it, and the host's address is for people who may use the host;
// - what a server's hostname address resolves to can change at any time, so it holds the
//   address only while no other workspace has it set, it isn't the host's, and no server of
//   another workspace added earlier by hostname resolves to it.

interface AddressHolder {
  /** Workspaces with a server that has this address set. */
  set: string[];
  /** It is the Nearzero host's address. */
  host: boolean;
  /** The workspace of the earliest server added by hostname that resolves to it, if any. */
  named?: string;
}

async function addressHolders(
  services: ControlServices,
  db: ControlServices["db"],
  ips: readonly string[],
): Promise<Map<string, AddressHolder>> {
  const wanted = [...new Set(ips)];
  const out = new Map<string, AddressHolder>();
  if (wanted.length === 0) return out;
  const host = await hostAddress(services);
  const set = await db
    .selectFrom("server")
    .select(["workspace_id", "public_ipv4", "address"])
    .where((eb) => eb.or([eb("public_ipv4", "in", wanted), eb("address", "in", wanted)]))
    .execute();
  for (const ip of wanted) {
    out.set(ip, {
      set: set
        .filter((row) => row.public_ipv4 === ip || row.address === ip)
        .map((row) => row.workspace_id),
      host: ip === host,
    });
  }
  const named = (
    await db
      .selectFrom("server")
      .select(["workspace_id", "name", "address"])
      .where("public_ipv4", "is", null)
      .orderBy("created_at")
      .orderBy("id")
      .execute()
  ).filter((row) => !isIPv4(row.address) && !row.address.includes(":"));
  const names = [...new Set(named.map((row) => row.address))];
  const resolved = new Map<string, Resolved>();
  // Cached, and looked up 20 at a time, so this stays cheap.
  for (let i = 0; i < names.length; i += 20) {
    const chunk = names.slice(i, i + 20);
    const answers = await Promise.all(chunk.map((name) => resolveServerName(services, name)));
    for (const [index, name] of chunk.entries()) resolved.set(name, answers[index] ?? null);
  }
  for (const row of named) {
    const { ipv4 } = serverIPv4({ ...row, public_ipv4: null }, resolved.get(row.address));
    const holder = ipv4 ? out.get(ipv4) : undefined;
    if (holder && holder.named === undefined) holder.named = row.workspace_id;
  }
  return out;
}

/**
 * Who would stop a workspace from setting a public IPv4 on one of its servers (B1-15): "workspace"
 * when a server of another workspace holds it, "host" when it is the Nearzero host's address
 * (for the caller to allow to people who may use the host), else null. `db` may be the
 * transaction that saves the address.
 */
export async function publicAddressUser(
  services: ControlServices,
  db: ControlServices["db"],
  workspaceId: string,
  ipv4: string,
): Promise<"workspace" | "host" | null> {
  const holder = (await addressHolders(services, db, [ipv4])).get(ipv4) as AddressHolder;
  if (holder.set.some((workspace) => workspace !== workspaceId)) return "workspace";
  if (holder.host) return "host";
  if (holder.set.includes(workspaceId)) return null;
  if (holder.named !== undefined && holder.named !== workspaceId) return "workspace";
  return null;
}

export async function describeTarget(
  services: ControlServices,
  id: string,
): Promise<TargetInfo | null> {
  return (await describeTargets(services, [id])).get(id) ?? null;
}

/**
 * The parent automatic hostnames on a target live under: the platform domain on the host,
 * <label>.<platform domain> on other servers (spec 10.1, 10.2). Null without a platform domain.
 */
export function automaticParent(services: ControlServices, target: TargetInfo): string | null {
  const domain = services.domains.platformDomain;
  if (!domain) return null;
  if (target.host || !target.label) return domain;
  return `${target.label}.${domain}`;
}

/** The one wildcard record a target needs for its automatic hostnames. */
export function wildcardRecord(services: ControlServices, target: TargetInfo) {
  const parent = automaticParent(services, target);
  if (!parent) return null;
  return {
    type: "A" as const,
    name: target.host
      ? `*.${parent}`
      : serverWildcardName(target.label as string, services.domains.platformDomain as string),
    value: target.ipv4,
    parent,
  };
}

// ---- Routes for hostnames (shared with the deploy pipeline)

/**
 * The router route key for a service's hostname and path: the deploy pipeline's own key
 * (deploys/pipeline.ts routeKey), so a route written here when a hostname is added and the one a
 * deploy writes are the same route, and a deploy keeps exactly the routes its providers name.
 */
export { routeKey as hostnameRouteKey, routePrefix } from "../deploys/pipeline.ts";

/**
 * The address a hostname's route sends traffic to on the server's private network when no
 * deploy has said yet: the running container of the service's active deployment, else its app
 * name (every app container carries it as a network alias), or <app name>-<service> for a
 * Compose service.
 */
export function upstreamHostFor(
  appName: string,
  composeService?: string | null,
  container?: string | null,
): string {
  if (composeService) return `${appName}-${composeService.toLowerCase()}`;
  return container ?? appName;
}
