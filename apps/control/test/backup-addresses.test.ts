import { afterEach, describe, expect, test } from "bun:test";
import { publicEndpoint, setResolver } from "../src/backups/addresses.ts";

/**
 * A destination tested from the Nearzero host for a workspace without a server (R3-49, spec 17.1,
 * 22.4): the endpoint's name is resolved once, every address it gives must pass the shared
 * public-address check, and the name is pinned to the address that was checked.
 */

afterEach(() => setResolver(null));

function answers(table: Record<string, string[]>): void {
  setResolver(async (host) => {
    const found = table[host];
    if (!found) throw new Error(`ENOTFOUND ${host}`);
    return found;
  });
}

describe("a destination's endpoint from the Nearzero host (R3-49)", () => {
  test("a public name is pinned to the address that was checked, IPv4 first", async () => {
    answers({
      "s3.example.com": ["2606:4700::6810:84e5", "93.184.216.34"],
      "v6.example.com": ["2606:4700::6810:84e5"],
    });
    expect(await publicEndpoint("https://s3.example.com")).toEqual({
      ok: true,
      pinned: [{ host: "s3.example.com", address: "93.184.216.34" }],
    });
    expect(await publicEndpoint("https://v6.example.com:9000/bucket")).toEqual({
      ok: true,
      pinned: [{ host: "v6.example.com", address: "2606:4700::6810:84e5" }],
    });
  });

  test("one internal address among public ones refuses the name", async () => {
    answers({ "mixed.example.com": ["93.184.216.34", "10.0.0.5"] });
    expect(await publicEndpoint("https://mixed.example.com")).toEqual({
      ok: false,
      host: "mixed.example.com",
    });
  });

  test("a name that doesn't resolve, or resolves to nothing, is refused", async () => {
    answers({ "empty.example.com": [] });
    expect(await publicEndpoint("https://missing.example.com")).toEqual({
      ok: false,
      host: "missing.example.com",
    });
    expect(await publicEndpoint("https://empty.example.com")).toEqual({
      ok: false,
      host: "empty.example.com",
    });
  });

  test("names resolving into any special-purpose range are refused", async () => {
    const internal = [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "192.0.0.9",
      "192.0.2.1",
      "192.31.196.1",
      "192.52.193.1",
      "192.88.99.1",
      "192.168.1.1",
      "192.175.48.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
      "::1",
      "::",
      "::ffff:8.8.8.8",
      "64:ff9b::a9fe:a9fe",
      "64:ff9b:1::808:808",
      "100::1",
      "2001:2::1",
      "2001:db8::1",
      "2002:c0a8:101::1",
      "2620:4f:8000::1",
      "3fff::1",
      "5f00::1",
      "fd00::1",
      "fe80::1",
      "ff02::1",
    ];
    for (const address of internal) {
      answers({ "s3.example.com": [address] });
      expect([address, await publicEndpoint("https://s3.example.com")]).toEqual([
        address,
        { ok: false, host: "s3.example.com" },
      ]);
    }
  });

  test("an address literal is checked as it is, with nothing to pin", async () => {
    answers({});
    expect(await publicEndpoint("https://93.184.216.34:9000")).toEqual({ ok: true, pinned: [] });
    expect(await publicEndpoint("https://[2606:4700:4700::1111]")).toEqual({
      ok: true,
      pinned: [],
    });
    for (const endpoint of [
      "http://169.254.169.254",
      "http://192.175.48.10",
      "http://[::1]:9000",
      "http://[::ffff:127.0.0.1]",
      "http://[64:ff9b::127.0.0.1]",
      "http://[2001:db8::1]",
      // WHATWG URL reads other spellings of an IPv4 address as the address itself.
      "http://0x7f.1/",
      "http://2130706433/",
    ]) {
      const result = await publicEndpoint(endpoint);
      expect([endpoint, result.ok]).toEqual([endpoint, false]);
    }
  });
});
