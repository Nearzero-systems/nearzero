/**
 * Whether an address is on the public internet: the one check behind every place an address
 * people type or a name resolves to must be public (spec 03 3.1 NEARZERO_PUBLIC_IP, 09 a server's
 * public IPv4, 17.1 a destination tested from the Nearzero host, 23.9 outbound calls). It refuses
 * every block in IANA's IPv4 and IPv6 Special-Purpose Address Registries that isn't globally
 * reachable, the anycast service blocks next to them (AS112, AMT), multicast, and on IPv6
 * everything outside global unicast 2000::/3. An IPv6 address that carries an IPv4 one (NAT64
 * 64:ff9b::/96, 6to4 2002::/16) counts only when that IPv4 address does.
 *
 * Pure code with no imports, so the browser and the control plane read addresses the same way.
 */

/** A dotted IPv4 address as a number, or null when it isn't one (no leading zeros). */
function ipv4Value(text: string): number | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const byte = Number(part);
    if (byte > 255) return null;
    value = value * 256 + byte;
  }
  return value;
}

/**
 * IPv4 blocks that are never public (IANA IPv4 Special-Purpose Address Registry, 2025-10-09,
 * every entry whose "Globally Reachable" isn't True, plus the anycast service blocks and
 * multicast). 192.0.0.0/24 is refused whole: its two anycast addresses (192.0.0.9 and
 * 192.0.0.10) are never a server, a destination or a webhook.
 */
export const IPV4_NOT_PUBLIC: readonly string[] = [
  "0.0.0.0/8", // "This network", with 0.0.0.0/32 (RFC 791, 1122)
  "10.0.0.0/8", // Private-Use (RFC 1918)
  "100.64.0.0/10", // Shared Address Space (RFC 6598)
  "127.0.0.0/8", // Loopback (RFC 1122)
  "169.254.0.0/16", // Link Local (RFC 3927)
  "172.16.0.0/12", // Private-Use (RFC 1918)
  "192.0.0.0/24", // IETF Protocol Assignments: 192.0.0.0/29, .8, .170, .171 (RFC 6890)
  "192.0.2.0/24", // Documentation, TEST-NET-1 (RFC 5737)
  "192.31.196.0/24", // AS112-v4 (RFC 7535)
  "192.52.193.0/24", // AMT (RFC 7450)
  "192.88.99.0/24", // Deprecated 6to4 relay anycast, with the 6a44 relay 192.88.99.2 (RFC 7526)
  "192.168.0.0/16", // Private-Use (RFC 1918)
  "192.175.48.0/24", // Direct Delegation AS112 Service (RFC 7534)
  "198.18.0.0/15", // Benchmarking (RFC 2544)
  "198.51.100.0/24", // Documentation, TEST-NET-2 (RFC 5737)
  "203.0.113.0/24", // Documentation, TEST-NET-3 (RFC 5737)
  "224.0.0.0/4", // Multicast (RFC 5771)
  "240.0.0.0/4", // Reserved (RFC 1112)
  "255.255.255.255/32", // Limited Broadcast (RFC 919, 8190)
];

const IPV4_BLOCKS = IPV4_NOT_PUBLIC.map((block) => {
  const [base = "", bits = "32"] = block.split("/");
  const size = 2 ** (32 - Number(bits));
  return { start: ipv4Value(base) as number, size };
});

function publicIPv4Value(value: number): boolean {
  return !IPV4_BLOCKS.some(({ start, size }) => value >= start && value < start + size);
}

/** Whether an IPv4 address is publicly routable (not private, shared, loopback, reserved…). */
export function isPublicIPv4(address: string): boolean {
  const value = ipv4Value(address);
  return value !== null && publicIPv4Value(value);
}

/**
 * The eight 16-bit groups of an IPv6 address in any of its spellings (`::` anywhere, leading
 * zeros, a dotted IPv4 tail, brackets, a zone), or null when it isn't one. URLs write an embedded
 * IPv4 in hex (`[64:ff9b::127.0.0.1]` becomes `[64:ff9b::7f00:1]`), so an address is always read
 * by its groups, never by its text.
 */
export function ipv6Groups(raw: string): number[] | null {
  let text = raw.replace(/^\[|\]$/g, "").toLowerCase();
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return null;
  const dotted = /^(.*:)([^:]*\.[^:]*)$/.exec(text);
  if (dotted) {
    const value = ipv4Value(dotted[2] as string);
    if (value === null) return null;
    text = `${dotted[1]}${(value >>> 16).toString(16)}:${(value & 0xffff).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const read = (part: string): number[] | null => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };
  const head = read(halves[0] as string);
  const tail = halves.length === 2 ? read(halves[1] as string) : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  // "::" stands for at least one group of zeros.
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array<number>(missing).fill(0), ...tail];
}

/** Whether the groups start with `prefix` (groups, read left to right) for `bits` bits. */
function inBlock(groups: number[], prefix: number[], bits: number): boolean {
  for (let index = 0; index * 16 < bits; index++) {
    const left = bits - index * 16;
    const mask = left >= 16 ? 0xffff : (0xffff << (16 - left)) & 0xffff;
    if (((groups[index] ?? 0) & mask) !== ((prefix[index] ?? 0) & mask)) return false;
  }
  return true;
}

/**
 * IPv6 blocks inside global unicast 2000::/3 that are never public (IANA IPv6 Special-Purpose
 * Address Registry, 2025-10-09). The blocks outside 2000::/3 (::/128, ::1/128, ::ffff:0:0/96,
 * 64:ff9b:1::/48, 100::/64, 100:0:0:1::/64, SRv6 SIDs 5f00::/16, fc00::/7, fe80::/10,
 * multicast…) are refused with everything else outside it; 6to4 and the NAT64 well-known prefix
 * go by the IPv4 they carry.
 */
const IPV6_NOT_PUBLIC: { prefix: number[]; bits: number }[] = [
  // IETF Protocol Assignments, refused whole as 192.0.0.0/24 is: Teredo 2001::/32, benchmarking
  // 2001:2::/48, the deprecated ORCHID 2001:10::/28, and the anycast and identifier blocks
  // (2001:1::1–3, AMT 2001:3::/32, AS112-v6 2001:4:112::/48, ORCHIDv2, DETs) beside them.
  { prefix: [0x2001, 0x0000], bits: 23 },
  { prefix: [0x2001, 0x0db8], bits: 32 }, // Documentation (RFC 3849)
  { prefix: [0x2620, 0x004f, 0x8000], bits: 48 }, // Direct Delegation AS112 Service (RFC 7534)
  { prefix: [0x3fff, 0x0000], bits: 20 }, // Documentation (RFC 9637)
];

function embeddedIPv4(high: number, low: number): number {
  return high * 0x10000 + low;
}

/**
 * Whether the internet can reach this address: an IPv4 or IPv6 address, in brackets or not. A
 * name, or anything that isn't an address, is never public.
 */
export function isPublicAddress(raw: string): boolean {
  const address = raw.replace(/^\[|\]$/g, "");
  const v4 = ipv4Value(address);
  if (v4 !== null) return publicIPv4Value(v4);
  const groups = ipv6Groups(address);
  if (!groups) return false;
  const [a = 0, b = 0, c = 0, , , , high = 0, low = 0] = groups;
  // NAT64's well-known prefix 64:ff9b::/96 (RFC 6052): the IPv4 address in its last 32 bits
  // decides. (Its local-use 64:ff9b:1::/48, RFC 8215, is outside 2000::/3 and refused below.)
  if (inBlock(groups, [0x64, 0xff9b, 0, 0, 0, 0], 96))
    return publicIPv4Value(embeddedIPv4(high, low));
  // 6to4 (RFC 3056): the IPv4 address in groups 2 and 3.
  if (a === 0x2002) return publicIPv4Value(embeddedIPv4(b, c));
  if (IPV6_NOT_PUBLIC.some(({ prefix, bits }) => inBlock(groups, prefix, bits))) return false;
  // Global unicast is 2000::/3; everything else (::/8 with loopback, unspecified, mapped and
  // compatible addresses, 100::/64, 5f00::/16, fc00::/7, fe80::/10, fec0::/10, ff00::/8…) isn't
  // public.
  return (a & 0xe000) === 0x2000;
}
