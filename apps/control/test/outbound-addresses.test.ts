import { describe, expect, test } from "bun:test";
import { ipv6Groups, isPublicAddress } from "@nearzero/shared";
import { checkOutboundHost, OutboundRefused } from "../src/security/outbound.ts";

/**
 * C1-08 (spec 23.9): addresses are read by their groups, so an internal IPv4 address can't pass
 * as public by being written inside an IPv6 one the way URLs write it (NAT64 in hex), and the
 * IANA special-purpose IPv6 ranges are never public.
 */

describe("addresses people type are read by their groups (C1-08)", () => {
  test("NAT64 in the form URLs give it is checked by the IPv4 address it carries", () => {
    const host = new URL("http://[64:ff9b::127.0.0.1]/").hostname;
    expect(host).toBe("[64:ff9b::7f00:1]");
    expect(isPublicAddress(host)).toBe(false);
    for (const internal of [
      "64:ff9b::7f00:1",
      "64:ff9b:0:0:0:0:7f00:1",
      "0064:ff9b:0000::a9fe:a9fe",
      "64:ff9b::169.254.169.254",
      "64:ff9b::a00:5",
      "64:ff9b:1::a00:5",
    ]) {
      expect(isPublicAddress(internal)).toBe(false);
    }
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
    expect(isPublicAddress("[64:ff9b::8.8.8.8]")).toBe(true);
  });

  test("mapped, compatible and 6to4 addresses never pass for an internal IPv4 address", () => {
    for (const internal of [
      new URL("http://[::ffff:127.0.0.1]/").hostname,
      "::ffff:7f00:1",
      "::ffff:0:7f00:1",
      "::127.0.0.1",
      "::",
      "::1",
      "2002:7f00:1::",
      "2002:a9fe:a9fe::1",
    ]) {
      expect(isPublicAddress(internal)).toBe(false);
    }
    expect(isPublicAddress("2002:808:808::1")).toBe(true);
  });

  test("the special-purpose IPv6 ranges are refused; global unicast passes", () => {
    for (const reserved of [
      "fe80::1%eth0",
      "fd00::1",
      "fec0::1",
      "ff02::1",
      "100::1",
      "2001::1",
      "2001:db8::1",
      "3fff::1",
      "5f00::1",
      "4000::1",
    ]) {
      expect(isPublicAddress(reserved)).toBe(false);
    }
    for (const global of ["2606:4700:4700::1111", "2a00:1450:4001::200e", "3fff:1000::1"]) {
      expect(isPublicAddress(global)).toBe(true);
    }
    expect(ipv6Groups("1::2:3")).toEqual([1, 0, 0, 0, 0, 0, 2, 3]);
    expect(ipv6Groups("not-an-address")).toBeNull();
  });

  test("a name that resolves to NAT64 for an internal address is refused", async () => {
    const resolve = async () => ["64:ff9b::a9fe:a9fe"];
    await expect(checkOutboundHost("hooks.example.com", resolve, false)).rejects.toBeInstanceOf(
      OutboundRefused,
    );
    expect(await checkOutboundHost("hooks.example.com", resolve, true)).toEqual([
      "64:ff9b::a9fe:a9fe",
    ]);
  });
});
