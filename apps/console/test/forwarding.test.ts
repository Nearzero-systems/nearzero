import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { connectionOf, firstByteTimeoutFor, forwardToControl } from "../src/lib/control-api.ts";
import {
  forwardedHeaders,
  isTrustedPeer,
  normalizeAddress,
  parseTrustedProxies,
  refreshRouterAddresses,
  resolveConnection,
  useRouterResolver,
} from "../src/lib/forwarding.ts";

const loopback = parseTrustedProxies(undefined);

describe("who the browser is (console proxy contract)", () => {
  test("trusts loopback by default, or the listed addresses and IPv4 ranges", () => {
    expect(isTrustedPeer("127.0.0.1", loopback)).toBe(true);
    expect(isTrustedPeer("::ffff:127.0.0.1", loopback)).toBe(true);
    expect(isTrustedPeer("::1", loopback)).toBe(true);
    expect(isTrustedPeer("203.0.113.7", loopback)).toBe(false);
    const listed = parseTrustedProxies(" 10.0.0.0/8 , 172.18.0.5 ");
    expect(isTrustedPeer("10.20.30.40", listed)).toBe(true);
    expect(isTrustedPeer("172.18.0.5", listed)).toBe(true);
    expect(isTrustedPeer("172.18.0.6", listed)).toBe(false);
    expect(isTrustedPeer("127.0.0.1", listed)).toBe(false);
    expect(normalizeAddress("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  test("a browser's own forwarded headers are ignored", () => {
    const headers = new Headers({ "x-forwarded-for": "1.2.3.4", "x-forwarded-proto": "https" });
    expect(
      resolveConnection({ peer: "203.0.113.7", scheme: "http", headers, trusted: loopback }),
    ).toEqual({
      clientAddress: "203.0.113.7",
      scheme: "http",
    });
  });

  test("a trusted proxy's last X-Forwarded-For entry and its scheme are used", () => {
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.9, 203.0.113.7",
      "x-forwarded-proto": "https",
    });
    const trusted = parseTrustedProxies("172.18.0.0/16");
    expect(resolveConnection({ peer: "172.18.0.2", scheme: "http", headers, trusted })).toEqual({
      clientAddress: "203.0.113.7",
      scheme: "https",
    });
    const junk = new Headers({
      "x-forwarded-for": "not an address",
      "x-forwarded-proto": "gopher",
    });
    expect(
      resolveConnection({ peer: "172.18.0.2", scheme: "http", headers: junk, trusted }),
    ).toEqual({
      clientAddress: "172.18.0.2",
      scheme: "http",
    });
  });

  test("an unknown peer sends no X-Forwarded-For at all", () => {
    expect(forwardedHeaders({ clientAddress: "", scheme: "http" })).toEqual({
      "x-forwarded-proto": "http",
    });
  });
});

describe("the Nearzero host's router is a trusted proxy (B1-27)", () => {
  const previous = process.env.NEARZERO_ROUTER_HOST;
  afterAll(() => {
    useRouterResolver(null);
    if (previous === undefined) delete process.env.NEARZERO_ROUTER_HOST;
    else process.env.NEARZERO_ROUTER_HOST = previous;
  });

  test("its edge-network address is looked up by name and trusted, and nothing else on the network", async () => {
    delete process.env.NEARZERO_ROUTER_HOST;
    const asked: string[] = [];
    useRouterResolver(async (host) => {
      asked.push(host);
      return ["172.19.0.3"];
    });
    await refreshRouterAddresses();
    expect(asked).toEqual(["nearzero-router"]);
    const trusted = parseTrustedProxies(undefined);
    // Behind the router, the browser's real address and HTTPS reach the control plane.
    const headers = new Headers({
      "x-forwarded-for": "198.51.100.9",
      "x-forwarded-proto": "https",
    });
    expect(resolveConnection({ peer: "172.19.0.3", scheme: "http", headers, trusted })).toEqual({
      clientAddress: "198.51.100.9",
      scheme: "https",
    });
    // An app container on the same network is not believed.
    expect(resolveConnection({ peer: "172.19.0.7", scheme: "http", headers, trusted })).toEqual({
      clientAddress: "172.19.0.7",
      scheme: "http",
    });
    // An operator's own list keeps the router too.
    expect(parseTrustedProxies("10.0.0.0/8")).toEqual(["10.0.0.0/8", "172.19.0.3"]);
  });

  test("a failed lookup trusts no router address, and an empty setting turns it off", async () => {
    useRouterResolver(async () => {
      throw new Error("ENOTFOUND nearzero-router");
    });
    await refreshRouterAddresses();
    expect(parseTrustedProxies(undefined)).toEqual(["127.0.0.0/8", "::1"]);
    process.env.NEARZERO_ROUTER_HOST = "";
    useRouterResolver(async () => ["172.19.0.3"]);
    await refreshRouterAddresses();
    expect(parseTrustedProxies(undefined)).toEqual(["127.0.0.0/8", "::1"]);
  });
});

describe("the /api/v1 proxy", () => {
  let control: ReturnType<typeof Bun.serve>;
  let seen: Headers | null = null;
  const previous = process.env.NEARZERO_CONTROL_URL;

  beforeAll(() => {
    control = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(request) {
        seen = request.headers;
        // Read the whole body, as the control plane does, so the kept-alive connection is clean
        // for the next request (an unread streamed body made the next one fail now and then).
        await request.arrayBuffer();
        const headers = new Headers({ "content-type": "application/json" });
        headers.append("set-cookie", "nz_session=abc; HttpOnly; Path=/; SameSite=Lax");
        headers.append("set-cookie", "nz_challenge=; Max-Age=0; Path=/");
        return new Response('{"ok":true}', { headers });
      },
    });
  });

  // Set before each test: other files' hooks may reset the environment between tests.
  beforeEach(() => {
    process.env.NEARZERO_CONTROL_URL = `http://127.0.0.1:${control.port}`;
  });

  afterAll(() => {
    control.stop(true);
    if (previous === undefined) delete process.env.NEARZERO_CONTROL_URL;
    else process.env.NEARZERO_CONTROL_URL = previous;
  });

  test("replaces the browser's forwarded headers with its own and passes cookies both ways", async () => {
    const request = new Request("http://console.test/api/v1/auth/sign-in", {
      method: "POST",
      headers: {
        cookie: "nz_session=old",
        "content-type": "application/json",
        "x-forwarded-for": "1.2.3.4",
        "x-forwarded-proto": "https",
        "x-forwarded-host": "evil.example",
      },
      body: "{}",
    });
    const response = await forwardToControl(request, connectionOf(request, "203.0.113.7"));
    expect(response.status).toBe(200);
    expect(seen?.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(seen?.get("x-forwarded-proto")).toBe("http");
    expect(seen?.get("x-forwarded-host")).toBeNull();
    expect(seen?.get("cookie")).toBe("nz_session=old");
    expect(response.headers.getSetCookie()).toEqual([
      "nz_session=abc; HttpOnly; Path=/; SameSite=Lax",
      "nz_challenge=; Max-Age=0; Path=/",
    ]);
  });

  test("reports https when the browser reached the console over HTTPS", async () => {
    const request = new Request("https://console.test/api/v1/auth/session");
    seen = null;
    const answer = await forwardToControl(request, connectionOf(request, "198.51.100.20"));
    expect(answer.status).toBe(200);
    // The pretend control plane set it while answering.
    const heard = seen as Headers | null;
    expect(heard?.get("x-forwarded-proto")).toBe("https");
    expect(heard?.get("x-forwarded-for")).toBe("198.51.100.20");
  });
});

describe("long actions wait as long as their routes may (31d G4-13)", () => {
  test("routes that answer only when done past 30 seconds get their own wait; the rest 30", () => {
    expect(firstByteTimeoutFor("POST", "/api/v1/backup-destinations/abc/test")).toBeGreaterThan(
      180_000,
    );
    expect(firstByteTimeoutFor("POST", "/api/v1/backup-destinations/test")).toBeGreaterThan(
      180_000,
    );
    expect(
      firstByteTimeoutFor("GET", "/api/v1/services/s1/backup-files?schedule=x"),
    ).toBeGreaterThan(120_000);
    expect(firstByteTimeoutFor("POST", "/api/v1/servers/s1/validation")).toBeGreaterThan(150_000);
    expect(firstByteTimeoutFor("POST", "/api/v1/servers/s1/security-audit")).toBeGreaterThan(
      80_000,
    );
    expect(firstByteTimeoutFor("GET", "/api/v1/analytics?range=24h")).toBeGreaterThan(60_000);
    expect(firstByteTimeoutFor("POST", "/api/v1/analytics/delete-all")).toBeGreaterThan(60_000);
    // Paths given to the server-side client have no /api/v1 prefix handled the same way.
    expect(firstByteTimeoutFor("POST", "/servers/s1/validation")).toBeGreaterThan(150_000);
    expect(firstByteTimeoutFor("GET", "/api/v1/projects")).toBe(30_000);
    expect(firstByteTimeoutFor("GET", "/api/v1/servers/s1/validation")).toBe(30_000);
  });
});
