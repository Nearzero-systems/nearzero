import { isIP } from "node:net";
import type { Context } from "hono";
import type { AppEnv } from "./context.ts";

/**
 * The real client behind the console's proxy (spec 04 4.1, spec 24 G10). The console connects
 * from a trusted address (loopback by default) and says who its client is in X-Forwarded-For and
 * X-Forwarded-Proto. From any other peer those headers are ignored, so nobody can claim another
 * address by sending them straight to the API.
 */

function ipv4ToNumber(address: string): number | null {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255))
    return null;
  return (
    (((parts[0] ?? 0) << 24) >>> 0) +
    ((parts[1] ?? 0) << 16) +
    ((parts[2] ?? 0) << 8) +
    (parts[3] ?? 0)
  );
}

function stripMappedIpv4(address: string): string {
  return address.toLowerCase().startsWith("::ffff:") && isIP(address.slice(7)) === 4
    ? address.slice(7)
    : address;
}

/** Whether an address is one of the trusted entries (exact addresses or IPv4 ranges). */
export function isTrustedPeer(address: string, trusted: readonly string[]): boolean {
  const peer = stripMappedIpv4(address);
  for (const entry of trusted) {
    const [base, bits] = entry.split("/");
    if (!base) continue;
    if (bits === undefined) {
      if (stripMappedIpv4(base).toLowerCase() === peer.toLowerCase()) return true;
      continue;
    }
    const prefix = Number(bits);
    const left = ipv4ToNumber(peer);
    const right = ipv4ToNumber(base);
    if (left === null || right === null || !(prefix >= 0 && prefix <= 32)) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    if ((left & mask) === (right & mask)) return true;
  }
  return false;
}

export interface ClientInfo {
  /** The client's address, or "unknown" when none can be told. */
  address: string;
  /** True when the browser reached the console over HTTPS. */
  secure: boolean;
}

export function clientInfo(c: Context<AppEnv>, trusted: readonly string[]): ClientInfo {
  const peer = c.env?.peerAddress;
  const url = new URL(c.req.url);
  const direct: ClientInfo = {
    address: peer ? stripMappedIpv4(peer) : "unknown",
    secure: url.protocol === "https:",
  };
  if (!peer || !isTrustedPeer(peer, trusted)) return direct;

  // The console sets these itself and drops whatever its own client sent, so the last entry is
  // the one it added.
  const forwardedFor = c.req.header("x-forwarded-for");
  const last = forwardedFor?.split(",").pop()?.trim();
  const address = last && isIP(last) ? stripMappedIpv4(last) : direct.address;
  const proto = c.req.header("x-forwarded-proto")?.split(",").pop()?.trim().toLowerCase();
  return { address, secure: proto === undefined ? direct.secure : proto === "https" };
}
