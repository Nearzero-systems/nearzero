import { afterEach, describe, expect, test } from "bun:test";
import {
  consoleHttpsAddress,
  httpsTarget,
  isServerIpAddress,
  mayMoveToHttps,
  useConsoleAddressSource,
} from "../src/lib/plain-http.ts";

/** 30a R1-01: plain-HTTP visits to the IP address move to the HTTPS address (spec 04 4.1). */

const visit = (url: string, extra: Partial<Parameters<typeof mayMoveToHttps>[0]> = {}) => {
  const parsed = new URL(url);
  return mayMoveToHttps({
    method: "GET",
    url: parsed,
    host: parsed.host,
    scheme: parsed.protocol === "https:" ? "https" : "http",
    ...extra,
  });
};

describe("which visits move to HTTPS (R1-01)", () => {
  afterEach(() => useConsoleAddressSource(null));

  test("a page on the server's IP over plain HTTP moves, with its path and query", () => {
    expect(visit("http://203.0.113.10:4321/sign-in?next=/x")).toBe(true);
    expect(visit("http://203.0.113.10:4321/sign-in", { method: "HEAD" })).toBe(true);
    expect(visit("http://[2001:db8::10]:4321/")).toBe(true);
    expect(
      httpsTarget(
        new URL("http://203.0.113.10:4321/sign-in?next=/x"),
        "https://console.example.com",
      ),
    ).toBe("https://console.example.com/sign-in?next=/x");
  });

  test("API paths, POSTs, loopback, names and requests already secure stay", () => {
    expect(visit("http://203.0.113.10:4321/api/v1/projects")).toBe(false);
    expect(visit("http://203.0.113.10:4321/sign-in", { method: "POST" })).toBe(false);
    expect(visit("http://127.0.0.1:4321/sign-in")).toBe(false);
    expect(visit("http://[::1]:4321/sign-in")).toBe(false);
    expect(visit("http://localhost:4321/sign-in")).toBe(false);
    expect(visit("http://nearzero.lan:4321/sign-in")).toBe(false);
    // A trusted proxy said the browser came over HTTPS.
    expect(visit("http://203.0.113.10:4321/sign-in", { scheme: "https" })).toBe(false);
    expect(isServerIpAddress("999.1.1.1")).toBe(false);
  });

  test("no HTTPS address means no redirect", () => {
    expect(httpsTarget(new URL("http://203.0.113.10:4321/"), null)).toBeNull();
    expect(
      httpsTarget(new URL("http://203.0.113.10:4321/"), "http://plain.example.com"),
    ).toBeNull();
  });

  test("the address is asked of the control plane at most every 30 seconds, and kept when it can't answer", async () => {
    let calls = 0;
    let answer: string | null | Error = "https://console.example.com";
    useConsoleAddressSource(async () => {
      calls++;
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const start = Date.now();
    expect(await consoleHttpsAddress(start)).toBe("https://console.example.com");
    expect(await consoleHttpsAddress(start + 10_000)).toBe("https://console.example.com");
    expect(calls).toBe(1);
    answer = new Error("unreachable");
    expect(await consoleHttpsAddress(start + 60_000)).toBe("https://console.example.com");
    answer = null;
    expect(await consoleHttpsAddress(Date.now() + 60_000)).toBeNull();
    expect(calls).toBe(3);
  });
});
