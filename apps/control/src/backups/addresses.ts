import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "@nearzero/shared";

/**
 * Where a destination's endpoint points, for a Test run from the Nearzero host on behalf of a
 * workspace that has no server of its own and doesn't use the host (R3-49, spec 17.1, 22.4). The
 * host may only be pointed at the public internet then: an endpoint on a private, loopback,
 * link-local or otherwise reserved address would let anyone probe the host's own network. The
 * name is resolved here, every address it has is checked with the shared public-address check
 * (the IANA special-purpose registries, as every outbound call is), and the runner's helper
 * reaches the name only at the address checked (pinned in its hosts file), so the answer can't
 * change in between.
 */

export type Resolver = (host: string) => Promise<string[]>;

const systemResolver: Resolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);

let resolver: Resolver = systemResolver;

/** Tests answer names themselves. */
export function setResolver(next: Resolver | null): void {
  resolver = next ?? systemResolver;
}

export type PublicCheck =
  | { ok: true; pinned: { host: string; address: string }[] }
  | { ok: false; host: string };

/**
 * The endpoint's addresses, when every one is public: the name pinned to one of them (IPv4
 * first). An address literal needs no pin.
 */
export async function publicEndpoint(endpoint: string): Promise<PublicCheck> {
  const host = new URL(endpoint).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPublicAddress(host) ? { ok: true, pinned: [] } : { ok: false, host };
  let addresses: string[];
  try {
    addresses = await resolver(host);
  } catch {
    return { ok: false, host };
  }
  if (addresses.length === 0 || !addresses.every(isPublicAddress)) return { ok: false, host };
  const chosen = addresses.find((address) => isIP(address) === 4) ?? (addresses[0] as string);
  return { ok: true, pinned: [{ host, address: chosen }] };
}
