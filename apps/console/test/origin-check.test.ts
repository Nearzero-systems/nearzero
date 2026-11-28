import { afterEach, describe, expect, test } from "bun:test";
import { CROSS_SITE_REFUSAL, ORIGIN_CHECKED_HEADER } from "@nearzero/shared";
import { forwardToControl } from "../src/lib/control-api.ts";
import { ownOrigins, refusedAsCrossSite } from "../src/lib/origin-check.ts";
import { refusedUpgrade, upstreamHeaders } from "../src/lib/socket-bridge.ts";
import { ALL } from "../src/pages/api/v1/[...path].ts";

/**
 * B1-26: the console's proxy and its terminal bridge refuse what a page on another site sends
 * with a signed-in person's cookies (spec 22.4, 24 G11).
 */

const saved = {
  trusted: process.env.NEARZERO_TRUSTED_ORIGINS,
  consoleUrl: process.env.NEARZERO_CONSOLE_URL,
  control: process.env.NEARZERO_CONTROL_URL,
};

function post(headers: Record<string, string>, url = "http://203.0.113.10:4321/api/v1/x") {
  return new Request(url, { method: "POST", headers: { host: new URL(url).host, ...headers } });
}

describe("the console's origin check (B1-26)", () => {
  afterEach(() => {
    for (const [name, value] of [
      ["NEARZERO_TRUSTED_ORIGINS", saved.trusted],
      ["NEARZERO_CONSOLE_URL", saved.consoleUrl],
      ["NEARZERO_CONTROL_URL", saved.control],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test("the address the browser used counts as this console, plus the configured ones", () => {
    process.env.NEARZERO_TRUSTED_ORIGINS = "https://extra.example.com";
    process.env.NEARZERO_CONSOLE_URL = "https://console.example.com/";
    expect(ownOrigins(post({}), "198.51.100.7")).toEqual([
      "http://203.0.113.10:4321",
      "https://extra.example.com",
      "https://console.example.com",
    ]);
  });

  test("refuses another site's changes, keeps the console's own", () => {
    process.env.NEARZERO_TRUSTED_ORIGINS = "";
    const peer = "198.51.100.7";
    expect(refusedAsCrossSite(post({ "sec-fetch-site": "same-site" }), peer)).toBe(true);
    expect(refusedAsCrossSite(post({ origin: "http://203.0.113.10:8080" }), peer)).toBe(true);
    expect(refusedAsCrossSite(post({ "sec-fetch-site": "same-origin" }), peer)).toBe(false);
    expect(refusedAsCrossSite(post({ origin: "http://203.0.113.10:4321" }), peer)).toBe(false);
    expect(refusedAsCrossSite(post({}), peer)).toBe(false);
  });

  test("the proxy answers 403 with the reason and never calls the control plane", async () => {
    process.env.NEARZERO_CONTROL_URL = "http://127.0.0.1:9";
    const response = await ALL({
      request: post({ "sec-fetch-site": "cross-site", "content-type": "text/plain" }),
      clientAddress: "198.51.100.7",
    } as Parameters<typeof ALL>[0]);
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
      CROSS_SITE_REFUSAL,
    );
  });

  test("the proxy tells the control plane it checked, and drops a browser's own claim", async () => {
    let seen: Headers | null = null;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        seen = request.headers;
        return Response.json({ ok: true });
      },
    });
    try {
      process.env.NEARZERO_CONTROL_URL = `http://127.0.0.1:${server.port}`;
      const forged = post({ [ORIGIN_CHECKED_HEADER]: "1" });
      await forwardToControl(forged, { clientAddress: "198.51.100.7", scheme: "http" });
      expect((seen as Headers | null)?.get(ORIGIN_CHECKED_HEADER) ?? null).toBeNull();
      await forwardToControl(
        post({}),
        { clientAddress: "198.51.100.7", scheme: "http" },
        { originChecked: true },
      );
      expect((seen as Headers | null)?.get(ORIGIN_CHECKED_HEADER)).toBe("1");
    } finally {
      server.stop(true);
    }
  });

  test("a terminal WebSocket from another site is refused before it is bridged", () => {
    const upgrade = (headers: Record<string, string>) =>
      refusedUpgrade({
        url: "/api/v1/services/s1/terminal",
        headers: { host: "203.0.113.10:4321", upgrade: "websocket", ...headers },
        peer: "198.51.100.7",
        encrypted: false,
      });
    expect(upgrade({ origin: "http://203.0.113.10:8080" })).toBe(true);
    expect(upgrade({ "sec-fetch-site": "same-site", origin: "http://203.0.113.10:8080" })).toBe(
      true,
    );
    expect(upgrade({ origin: "http://203.0.113.10:4321" })).toBe(false);
    expect(upgrade({ "sec-fetch-site": "same-origin", origin: "http://203.0.113.10:4321" })).toBe(
      false,
    );
    // What the control plane gets for a bridged terminal says the origin was checked.
    const headers = upstreamHeaders({
      headers: {
        cookie: "a=b",
        origin: "http://203.0.113.10:4321",
        "sec-fetch-site": "same-origin",
      },
      peer: "198.51.100.7",
      encrypted: false,
    });
    expect(headers[ORIGIN_CHECKED_HEADER]).toBe("1");
    expect(headers["sec-fetch-site"]).toBe("same-origin");
  });
});
