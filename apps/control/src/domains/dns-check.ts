import { inRange, proxyOf } from "@nearzero/shared";
import { type DnsLookup, LookupError } from "./settings.ts";

/**
 * DNS checks (spec 10.4–10.6, 9.5): whether a name points at a server, through public
 * resolvers, with plain statuses. Answers are kept for a short while, so a dialog that checks
 * every 8 seconds doesn't hammer the resolvers.
 */

export const DNS_STATUSES = [
  "points_here",
  "points_elsewhere",
  "proxied",
  "ipv6_only",
  "no_record",
  "lookup_failed",
  "address_unknown",
] as const;
export type DnsStatus = (typeof DNS_STATUSES)[number];

export interface DnsCheck {
  name: string;
  status: DnsStatus;
  /** A records found. */
  addresses: string[];
  /** AAAA records found (only looked up when there is no A record). */
  ipv6: string[];
  /** The address it should point at. */
  expected: string | null;
  /** The proxy in front, when the A records are a known proxy's. */
  proxiedBy: string | null;
  /**
   * When it points here, what could still send Let's Encrypt elsewhere: other A records, or an
   * AAAA record (R3-17). Checks stored before 1.0 had none.
   */
  warnings?: string[];
  /** The name it is an alias of, when it is a CNAME (R3-17). */
  aliasOf?: string | null;
  message: string;
  checkedAt: number;
}

// Known proxies' ranges are shared with the runner's certificate hold (R3-11, R3-16).
export { inRange, proxyOf };

/** Plain words for a check's result (spec 10.5, 10.6). */
export function dnsMessage(check: Omit<DnsCheck, "message" | "checkedAt">): string {
  const { name, expected } = check;
  switch (check.status) {
    case "points_here":
      return `${name} points at this server (${expected}).`;
    case "points_elsewhere":
      return `${name} points at ${check.addresses.join(", ")}, not ${expected}. Change its A record to ${expected}.`;
    case "proxied":
      // Why a proxied name can't be added yet (spec 10.6). A hostname already added shows
      // proxiedNote instead (R3-11).
      return `Turn off the DNS proxy for ${name} (DNS only): it points at ${check.proxiedBy}, so Let's Encrypt can't reach this server and the proxy's certificate doesn't cover the name.`;
    case "ipv6_only":
      return `${name} only has an IPv6 (AAAA) record. Add an A record pointing at ${expected}.`;
    case "no_record":
      return `${name} doesn't resolve yet. Add the A record${expected ? ` pointing at ${expected}` : ""}; DNS changes can take a few minutes.`;
    case "lookup_failed":
      return `Couldn't look up ${name} just now. Try again in a moment.`;
    case "address_unknown":
      return "Nearzero doesn't know this server's public IPv4 address, so it can't check DNS. Correct it under About Nearzero.";
  }
}

/**
 * The note of a hostname that is already added and proxied (R3-11, spec 10.4): Let's Encrypt is
 * asked for it too, which works when the proxy passes the HTTP challenge on, as 0.1.x said.
 */
export function proxiedNote(proxiedBy: string | null): string {
  const proxy = proxiedBy ?? "a proxy";
  return `Proxied by ${proxy}. HTTPS works if ${proxy} forwards plain HTTP for /.well-known/acme-challenge/ to this server.`;
}

function finish(partial: Omit<DnsCheck, "message" | "checkedAt">, now: number): DnsCheck {
  return { warnings: [], aliasOf: null, ...partial, message: dnsMessage(partial), checkedAt: now };
}

/** The warnings of a name that points here (spec 10.4 Details, R3-17). */
export function pointsHereWarnings(
  name: string,
  expected: string,
  addresses: readonly string[],
  ipv6: readonly string[],
): string[] {
  const warnings: string[] = [];
  const others = addresses.filter((address) => address !== expected);
  if (others.length > 0) {
    warnings.push(
      `${name} also points to ${others.join(", ")}. Let's Encrypt may check one of those instead. Keep only ${expected}.`,
    );
  }
  if (ipv6.length > 0) {
    warnings.push(
      `An AAAA (IPv6) record points to ${ipv6.join(", ")}. Let's Encrypt tries IPv6 first, so remove it unless it reaches this server.`,
    );
  }
  return warnings;
}

/** A lookup that answers nothing instead of failing: the extra records are only advice. */
async function quietly(lookup: () => Promise<string[]>): Promise<string[]> {
  try {
    return await lookup();
  } catch {
    return [];
  }
}

/** Looks a name up and compares it with the address it should point at. */
export async function checkName(
  lookup: DnsLookup,
  name: string,
  expected: string | null,
  now = Date.now(),
): Promise<DnsCheck> {
  const base = { name, expected, addresses: [] as string[], ipv6: [] as string[], proxiedBy: null };
  let addresses: string[] = [];
  let missing = false;
  try {
    addresses = await lookup.resolve4(name);
  } catch (error) {
    if (error instanceof LookupError && error.kind !== "failed") missing = true;
    else return finish({ ...base, status: "lookup_failed" }, now);
  }
  if (missing || addresses.length === 0) {
    let ipv6: string[] = [];
    try {
      ipv6 = await lookup.resolve6(name);
    } catch {
      ipv6 = [];
    }
    if (ipv6.length > 0) return finish({ ...base, ipv6, status: "ipv6_only" }, now);
    return finish({ ...base, status: "no_record" }, now);
  }
  const withAddresses = { ...base, addresses };
  if (!expected) return finish({ ...withAddresses, status: "address_unknown" }, now);
  if (addresses.includes(expected)) {
    // Points here: an AAAA record or other A records can still send Let's Encrypt elsewhere,
    // and a CNAME says whose name it really is (R3-17).
    const [ipv6, cname] = await Promise.all([
      quietly(() => lookup.resolve6(name)),
      quietly(() => lookup.resolveCname(name)),
    ]);
    return finish(
      {
        ...withAddresses,
        ipv6,
        status: "points_here",
        warnings: pointsHereWarnings(name, expected, addresses, ipv6),
        aliasOf: cname[0]?.toLowerCase().replace(/\.$/, "") ?? null,
      },
      now,
    );
  }
  const proxiedBy = proxyOf(addresses);
  if (proxiedBy) return finish({ ...withAddresses, proxiedBy, status: "proxied" }, now);
  return finish({ ...withAddresses, status: "points_elsewhere" }, now);
}

/** A random name under a wildcard, checked to see whether the wildcard record exists. */
export function wildcardProbe(parent: string, random: (size: number) => Uint8Array): string {
  const bytes = random(6);
  const label = `nz${Array.from(bytes, (b) => b.toString(36).padStart(2, "0").slice(-2)).join("")}`;
  return `${label}.${parent}`;
}

/**
 * The DNS zone a name lives in and its nameservers: the closest parent with NS records. Falls
 * back to the last two labels with no nameservers when nothing answers.
 */
export async function findZone(
  lookup: DnsLookup,
  name: string,
): Promise<{ zone: string; nameservers: string[] }> {
  const labels = name.replace(/^\*\./, "").split(".");
  for (let start = 0; start <= labels.length - 2; start++) {
    const candidate = labels.slice(start).join(".");
    try {
      const nameservers = await lookup.resolveNs(candidate);
      if (nameservers.length > 0) {
        return { zone: candidate, nameservers: nameservers.map((ns) => ns.toLowerCase()) };
      }
    } catch (error) {
      if (!(error instanceof LookupError) || error.kind === "failed") break;
    }
  }
  return { zone: labels.slice(-2).join("."), nameservers: [] };
}

/** Keeps answers for a while, per process, so repeated checks of one name are cheap. */
export class CachedChecks {
  readonly #lookup: () => DnsLookup;
  readonly #checks = new Map<string, { at: number; value: DnsCheck }>();
  readonly #zones = new Map<
    string,
    { at: number; value: { zone: string; nameservers: string[] } }
  >();
  readonly ttlMs: number;

  constructor(lookup: () => DnsLookup, ttlMs = 20_000) {
    this.#lookup = lookup;
    this.ttlMs = ttlMs;
  }

  /**
   * `unknownAddress` is what to say when the server's public IPv4 isn't known (it names the
   * server's address and the fix, spec 10.6); the generic words are for the host.
   */
  async check(
    name: string,
    expected: string | null,
    fresh = false,
    unknownAddress: string | null = null,
  ): Promise<DnsCheck> {
    const key = `${name}|${expected ?? ""}`;
    const hit = this.#checks.get(key);
    let value: DnsCheck;
    if (!fresh && hit && Date.now() - hit.at < this.ttlMs) value = hit.value;
    else {
      value = await checkName(this.#lookup(), name, expected);
      this.#checks.set(key, { at: Date.now(), value });
      if (this.#checks.size > 5_000) this.#checks.clear();
    }
    return value.status === "address_unknown" && unknownAddress
      ? { ...value, message: unknownAddress }
      : value;
  }

  async zone(name: string): Promise<{ zone: string; nameservers: string[] }> {
    const key = name.replace(/^\*\./, "");
    const hit = this.#zones.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
    const value = await findZone(this.#lookup(), key);
    this.#zones.set(key, { at: Date.now(), value });
    if (this.#zones.size > 5_000) this.#zones.clear();
    return value;
  }

  forget(name: string): void {
    for (const key of this.#checks.keys()) if (key.startsWith(`${name}|`)) this.#checks.delete(key);
  }
}
