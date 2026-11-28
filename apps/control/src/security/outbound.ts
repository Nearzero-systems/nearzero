import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "@nearzero/shared";

/**
 * Outbound calls to addresses people type (spec 23.9: outbound calls go only to providers people
 * configured): a notification channel's webhook or SMTP server, a public repository's URL. The
 * control plane runs next to its database and other private services, so such a call is never
 * allowed to reach this machine, a private network or a cloud's metadata address, unless an
 * instance administrator chose it. Names are resolved first and every address they give is
 * checked (by the shared isPublicAddress, the IANA special-purpose registries); a name that
 * resolves to one public and one private address is refused.
 */

/** Looks a name up the way the connection will (the system resolver, /etc/hosts included). */
export type ResolveHost = (host: string) => Promise<string[]>;

export const systemResolve: ResolveHost = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

export class OutboundRefused extends Error {
  readonly kind: "internal" | "lookup";
  constructor(kind: "internal" | "lookup", message: string) {
    super(message);
    this.name = "OutboundRefused";
    this.kind = kind;
  }
}

/**
 * The addresses a host reaches, after checking them: throws {@link OutboundRefused} when the
 * name doesn't resolve, or when any address isn't public and `allowInternal` is false.
 */
export async function checkOutboundHost(
  rawHost: string,
  resolve: ResolveHost,
  allowInternal: boolean,
): Promise<string[]> {
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = await resolve(host);
    } catch {
      throw new OutboundRefused("lookup", `couldn't look up ${host}`);
    }
    if (addresses.length === 0) throw new OutboundRefused("lookup", `couldn't look up ${host}`);
  }
  if (!allowInternal && addresses.some((address) => !isPublicAddress(address))) {
    throw new OutboundRefused(
      "internal",
      `${host} is a private or internal address, and only an instance administrator can send there`,
    );
  }
  return addresses;
}
