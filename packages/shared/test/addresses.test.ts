import { describe, expect, test } from "bun:test";
import { ipv6Groups, isPublicAddress, isPublicIPv4 } from "../src/addresses.ts";

/**
 * The one public-address check (spec 03 3.1, 17.1, 22.4, 23.9) against every block of IANA's
 * IPv4 and IPv6 Special-Purpose Address Registries (2025-10-09) that isn't globally reachable,
 * the anycast service blocks beside them, multicast, and the edges of each block.
 */

/** [block, its first address, its last address, public neighbours just outside it]. */
const IPV4_BLOCKS: [string, string, string, string[]][] = [
  ["0.0.0.0/8 this network", "0.0.0.0", "0.255.255.255", ["1.0.0.0"]],
  ["10.0.0.0/8 private-use", "10.0.0.0", "10.255.255.255", ["9.255.255.255", "11.0.0.0"]],
  ["100.64.0.0/10 shared", "100.64.0.0", "100.127.255.255", ["100.63.255.255", "100.128.0.0"]],
  ["127.0.0.0/8 loopback", "127.0.0.0", "127.255.255.255", ["126.255.255.255", "128.0.0.0"]],
  [
    "169.254.0.0/16 link local",
    "169.254.0.0",
    "169.254.255.255",
    ["169.253.255.255", "169.255.0.0"],
  ],
  ["172.16.0.0/12 private-use", "172.16.0.0", "172.31.255.255", ["172.15.255.255", "172.32.0.0"]],
  [
    "192.0.0.0/24 IETF protocol assignments",
    "192.0.0.0",
    "192.0.0.255",
    ["191.255.255.255", "192.0.1.0"],
  ],
  ["192.0.2.0/24 TEST-NET-1", "192.0.2.0", "192.0.2.255", ["192.0.1.255", "192.0.3.0"]],
  [
    "192.31.196.0/24 AS112-v4",
    "192.31.196.0",
    "192.31.196.255",
    ["192.31.195.255", "192.31.197.0"],
  ],
  ["192.52.193.0/24 AMT", "192.52.193.0", "192.52.193.255", ["192.52.192.255", "192.52.194.0"]],
  [
    "192.88.99.0/24 deprecated 6to4 relay anycast",
    "192.88.99.0",
    "192.88.99.255",
    ["192.88.98.255", "192.88.100.0"],
  ],
  [
    "192.168.0.0/16 private-use",
    "192.168.0.0",
    "192.168.255.255",
    ["192.167.255.255", "192.169.0.0"],
  ],
  [
    "192.175.48.0/24 direct delegation AS112",
    "192.175.48.0",
    "192.175.48.255",
    ["192.175.47.255", "192.175.49.0"],
  ],
  ["198.18.0.0/15 benchmarking", "198.18.0.0", "198.19.255.255", ["198.17.255.255", "198.20.0.0"]],
  [
    "198.51.100.0/24 TEST-NET-2",
    "198.51.100.0",
    "198.51.100.255",
    ["198.51.99.255", "198.51.101.0"],
  ],
  ["203.0.113.0/24 TEST-NET-3", "203.0.113.0", "203.0.113.255", ["203.0.112.255", "203.0.114.0"]],
  ["224.0.0.0/4 multicast", "224.0.0.0", "239.255.255.255", ["223.255.255.255"]],
  ["240.0.0.0/4 reserved", "240.0.0.0", "255.255.255.254", []],
  ["255.255.255.255/32 limited broadcast", "255.255.255.255", "255.255.255.255", []],
];

describe("IPv4: every special-purpose block that isn't globally reachable is refused", () => {
  for (const [block, first, last, neighbours] of IPV4_BLOCKS) {
    test(block, () => {
      expect(isPublicIPv4(first)).toBe(false);
      expect(isPublicIPv4(last)).toBe(false);
      expect(isPublicAddress(first)).toBe(false);
      expect(isPublicAddress(last)).toBe(false);
      for (const neighbour of neighbours) {
        expect(isPublicIPv4(neighbour)).toBe(true);
        expect(isPublicAddress(neighbour)).toBe(true);
      }
    });
  }

  test("the registry's smaller entries inside 192.0.0.0/24 and 192.88.99.0/24", () => {
    // 192.0.0.0/29 service continuity, .8 dummy, .9 and .10 anycast, .170 and .171 NAT64
    // discovery; 192.88.99.2 the 6a44 relay.
    for (const ip of [
      "192.0.0.1",
      "192.0.0.7",
      "192.0.0.8",
      "192.0.0.9",
      "192.0.0.10",
      "192.0.0.170",
      "192.0.0.171",
      "192.88.99.2",
      "0.0.0.0",
    ]) {
      expect(isPublicIPv4(ip)).toBe(false);
    }
  });

  test("public addresses pass, and anything that isn't a dotted IPv4 address doesn't", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "34.120.9.9", "223.255.255.254"]) {
      expect(isPublicIPv4(ip)).toBe(true);
    }
    for (const text of ["1.2.3", "1.2.3.4.5", "300.1.1.1", "01.2.3.4", "8.8.8.8 ", "", "::1"]) {
      expect(isPublicIPv4(text)).toBe(false);
    }
  });
});

/** [block, addresses in it (its edges where it has them)]. */
const IPV6_BLOCKS: [string, string[]][] = [
  ["::1/128 loopback", ["::1", "0:0:0:0:0:0:0:1", "[::1]"]],
  ["::/128 unspecified", ["::", "0::0"]],
  [
    "::ffff:0:0/96 IPv4-mapped, whatever IPv4 it maps",
    ["::ffff:0:0", "::ffff:ffff:ffff", "::ffff:127.0.0.1", "::ffff:8.8.8.8", "::ffff:808:808"],
  ],
  ["IPv4-compatible ::/96 (deprecated)", ["::8.8.8.8", "::127.0.0.1"]],
  [
    "64:ff9b:1::/48 local-use NAT64",
    ["64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff", "64:ff9b:1::808:808"],
  ],
  ["100::/64 discard-only", ["100::", "100::ffff:ffff:ffff:ffff"]],
  ["100:0:0:1::/64 dummy prefix", ["100:0:0:1::", "100:0:0:1:ffff:ffff:ffff:ffff"]],
  ["2001::/23 IETF protocol assignments", ["2001::", "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["2001::/32 Teredo", ["2001:0:4136:e378:8000:63bf:3fff:fdd2"]],
  ["2001:1::1–3 anycast", ["2001:1::1", "2001:1::2", "2001:1::3"]],
  ["2001:2::/48 benchmarking", ["2001:2::", "2001:2:0:ffff:ffff:ffff:ffff:ffff"]],
  ["2001:3::/32 AMT", ["2001:3::1"]],
  ["2001:4:112::/48 AS112-v6", ["2001:4:112::1"]],
  ["2001:10::/28 deprecated ORCHID", ["2001:10::1"]],
  ["2001:20::/28 ORCHIDv2 and 2001:30::/28 DETs", ["2001:20::1", "2001:30::1"]],
  ["2001:db8::/32 documentation", ["2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"]],
  [
    "2620:4f:8000::/48 direct delegation AS112",
    ["2620:4f:8000::", "2620:4f:8000:ffff:ffff:ffff:ffff:ffff"],
  ],
  ["3fff::/20 documentation", ["3fff::", "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["5f00::/16 SRv6 SIDs", ["5f00::", "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff"]],
  ["fc00::/7 unique-local", ["fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fd12:3456::1"]],
  ["fe80::/10 link-local", ["fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::1%eth0"]],
  ["fec0::/10 site-local (deprecated)", ["fec0::1"]],
  ["ff00::/8 multicast", ["ff02::1", "ff0e::1"]],
  ["outside global unicast 2000::/3", ["4000::1", "1fff:ffff::1", "8000::1", "e000::1"]],
];

describe("IPv6: every special-purpose block that isn't globally reachable is refused", () => {
  for (const [block, addresses] of IPV6_BLOCKS) {
    test(block, () => {
      for (const address of addresses)
        expect([address, isPublicAddress(address)]).toEqual([address, false]);
    });
  }

  test("global unicast just outside the blocks passes", () => {
    for (const address of [
      "2001:200::1",
      "2001:4860:4860::8888",
      "2001:db7:ffff:ffff:ffff:ffff:ffff:ffff",
      "2001:db9::",
      "2606:4700:4700::1111",
      "2620:4f:7fff:ffff:ffff:ffff:ffff:ffff",
      "2620:4f:8001::",
      "2a00:1450:4001::200e",
      "3ffe:ffff::1",
      "3fff:1000::",
      "[2606:4700:4700::1111]",
      "2606:4700:4700::1111%eth0",
    ]) {
      expect([address, isPublicAddress(address)]).toEqual([address, true]);
    }
  });

  test("NAT64 (64:ff9b::/96) and 6to4 (2002::/16) go by the IPv4 address they carry", () => {
    for (const internal of [
      "64:ff9b::7f00:1",
      "64:ff9b::127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b::c01f:c401", // 192.31.196.1, AS112
      "64:ff9b::ffff:ffff",
      "2002:a00:1::",
      "2002:c0a8:101::1",
      "2002:c034:c101::1", // 192.52.193.1, AMT
      "2002:c0af:3001::1", // 192.175.48.1, AS112
      "2002:c058:6301::1", // 192.88.99.1
      "2002:ffff:ffff::1",
    ]) {
      expect([internal, isPublicAddress(internal)]).toEqual([internal, false]);
    }
    for (const outside of ["64:ff9b::808:808", "64:ff9b::8.8.8.8", "2002:808:808::1"]) {
      expect([outside, isPublicAddress(outside)]).toEqual([outside, true]);
    }
    // Only the /96 is the well-known prefix; the rest of 64:ff9b::/32 isn't global unicast.
    expect(isPublicAddress("64:ff9b:0:0:1::808:808")).toBe(false);
  });

  test("an address is read by its groups, in any spelling", () => {
    expect(ipv6Groups("1::2:3")).toEqual([1, 0, 0, 0, 0, 0, 2, 3]);
    expect(ipv6Groups("[0064:FF9B:0000::A9FE:A9FE]")).toEqual([
      0x64, 0xff9b, 0, 0, 0, 0, 0xa9fe, 0xa9fe,
    ]);
    expect(ipv6Groups("::ffff:192.0.2.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201]);
    expect(ipv6Groups("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(ipv6Groups("1:2:3:4:5:6:7::")).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    expect(ipv6Groups("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    // An IPv4 address has no IPv6 groups (it is read as IPv4).
    expect(ipv6Groups("1.2.3.4")).toBeNull();
    for (const wrong of [
      "not-an-address",
      "1::2::3",
      "12345::",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7:8::",
      "1:2:3:4:5:6:7",
      ":1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:",
      "::ffff:1.2.3",
      "::ffff:256.1.1.1",
      "1:2:3:4:5:6:7:1.2.3.4",
      "g::1",
      "",
    ]) {
      expect([wrong, ipv6Groups(wrong)]).toEqual([wrong, null]);
      expect(isPublicAddress(wrong)).toBe(false);
    }
  });

  test("a name is never an address", () => {
    for (const name of ["example.com", "localhost", "8.8.8.8.nip.io", "[example.com]"]) {
      expect(isPublicAddress(name)).toBe(false);
    }
  });
});
