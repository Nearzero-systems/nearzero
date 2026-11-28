import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { DEFAULT_DNS_RESOLVERS } from "@nearzero/shared";

/**
 * The install's domain settings (spec 03 3.1) and the outbound DNS lookups the domains area
 * makes (spec 23.9: "public DNS lookups for checks"). Both are injectable, so tests never reach
 * the network and can give any answers.
 */

// The domain tables join the Database type wherever the control plane is compiled (tables.ts).
export type { DnsZoneTable, HostnameTable } from "./tables.ts";

/** Slow lookups give up rather than hang (spec 10.6). */
export const LOOKUP_TIMEOUT_MS = 10_000;

/** Why a lookup returned nothing. */
export type LookupFailure = "not_found" | "no_data" | "failed";

export class LookupError extends Error {
  readonly kind: LookupFailure;
  constructor(kind: LookupFailure, message: string) {
    super(message);
    this.name = "LookupError";
    this.kind = kind;
  }
}

/** DNS questions the domain checks ask. Each throws a {@link LookupError} when it gets nothing. */
export interface DnsLookup {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveCname(name: string): Promise<string[]>;
  resolveNs(name: string): Promise<string[]>;
  /** The SOA serial a server answers for a zone, asked at one address ("ip:port"). */
  soaSerialAt(server: string, zone: string): Promise<number>;
}

export interface DomainSettings {
  platformDomain: string | null;
  managementHostname: string | null;
  /** A zone named at install, connected for the first workspace at start. */
  managedZone: string | null;
  managedZoneEmail: string | null;
  acmeEmail: string | null;
  sharedEdge: boolean;
  dns: DnsLookup;
  /** Random bytes for generated labels. */
  random(size: number): Uint8Array;
  /** Waits between steps that need the router to notice a change. Tests make it instant. */
  sleep(ms: number): Promise<void>;
}

function classify(error: unknown, name: string): LookupError {
  const code = (error as { code?: string }).code ?? "";
  if (code === "ENOTFOUND" || code === "NXDOMAIN") {
    return new LookupError("not_found", `${name} doesn't exist in DNS.`);
  }
  if (code === "ENODATA" || code === "NODATA") {
    return new LookupError("no_data", `${name} has no records of that kind.`);
  }
  return new LookupError("failed", `Couldn't look up ${name} (${code || "no answer"}).`);
}

function withTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new LookupError("failed", `Looking up ${name} took longer than 10 seconds.`)),
      LOOKUP_TIMEOUT_MS,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof LookupError ? error : classify(error, name));
      },
    );
  });
}

/** Lookups through public resolvers (NEARZERO_DNS_RESOLVERS, Cloudflare's and Google's by default). */
export function publicDnsLookup(servers: readonly string[] = DEFAULT_DNS_RESOLVERS): DnsLookup {
  const resolver = new Resolver({ timeout: 4_000, tries: 2 });
  resolver.setServers([...servers]);
  return {
    resolve4: (name) => withTimeout(resolver.resolve4(name), name),
    resolve6: (name) => withTimeout(resolver.resolve6(name), name),
    resolveCname: (name) => withTimeout(resolver.resolveCname(name), name),
    resolveNs: (name) => withTimeout(resolver.resolveNs(name), name),
    async soaSerialAt(server, zone) {
      const direct = new Resolver({ timeout: 3_000, tries: 1 });
      direct.setServers([server]);
      const soa = await withTimeout(direct.resolveSoa(zone), zone);
      return soa.serial;
    },
  };
}

export function domainSettings(
  options: Partial<DomainSettings> & { resolvers?: readonly string[] } = {},
): DomainSettings {
  return {
    platformDomain: options.platformDomain ?? null,
    managementHostname: options.managementHostname ?? null,
    managedZone: options.managedZone ?? null,
    managedZoneEmail: options.managedZoneEmail ?? null,
    acmeEmail: options.acmeEmail ?? null,
    sharedEdge: options.sharedEdge ?? false,
    dns: options.dns ?? publicDnsLookup(options.resolvers),
    random: options.random ?? ((size) => new Uint8Array(randomBytes(size))),
    sleep: options.sleep ?? ((ms) => Bun.sleep(ms)),
  };
}
