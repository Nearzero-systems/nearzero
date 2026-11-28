import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import {
  CROSS_SITE_REFUSAL,
  isCrossSiteRequest,
  ORIGIN_CHECKED_HEADER,
  parseOriginList,
} from "@nearzero/shared";
import {
  type Browser,
  createHarness,
  type Harness,
  INSTANCE_RESEND,
  setUpNamedOwner,
} from "./support/harness.ts";

/**
 * B1-26: a page on another site (an app on a sibling subdomain, or on another port of the same
 * IP) must not make changes or open terminals with a signed-in person's session (spec 22.4,
 * 24 G11), whether or not the request has a body.
 */

setDefaultTimeout(120_000);

let h: Harness;
let owner: Browser;
let invitationId: string;

beforeAll(async () => {
  h = await createHarness({
    instanceEmail: INSTANCE_RESEND,
    consoleUrl: "https://console.example.com",
    extra: { trustedOrigins: ["https://nearzero.internal.example"] },
  });
});

afterAll(async () => {
  await h.drop();
});

beforeEach(async () => {
  await h.reset();
  owner = await setUpNamedOwner(h);
  const invited = await owner.post("/workspace/invitations", {
    email: "new@example.com",
    role: "member",
    policyIds: [],
  });
  expect(invited.status).toBe(201);
  invitationId = invited.body.invitation?.id ?? invited.body.id;
  // Resending waits 30 seconds after a send; the tests resend at once.
  await h.test.db.updateTable("invitation").set({ last_emailed_at: null }).execute();
});

/** A bodyless POST like `fetch(url, {method: "POST", mode: "no-cors", credentials: "include"})`. */
function bodyless(path: string, headers: Record<string, string>) {
  return owner.request("POST", path, undefined, { "content-type": "text/plain", ...headers });
}

describe("changes from another site are refused (B1-26)", () => {
  test("a same-site or cross-site page can't send a bodyless POST", async () => {
    const path = `/workspace/invitations/${invitationId}/resend`;
    for (const site of ["same-site", "cross-site"]) {
      const refused = await bodyless(path, { "sec-fetch-site": site });
      expect(refused.status).toBe(403);
      expect(refused.body.error.message).toBe(CROSS_SITE_REFUSAL);
    }
    const foreign = await bodyless(path, { origin: "http://app.example.com" });
    expect(foreign.status).toBe(403);
    const opaque = await bodyless(path, { origin: "null" });
    expect(opaque.status).toBe(403);
    // Sign-out, cancels and redeploys are refused the same way.
    expect(
      (await owner.request("POST", "/auth/sign-out", undefined, { "sec-fetch-site": "same-site" }))
        .status,
    ).toBe(403);
    expect((await owner.get("/me")).status).toBe(200);
  });

  test("the console's own pages, typed addresses and scripts still work", async () => {
    const path = `/workspace/invitations/${invitationId}/resend`;
    expect((await bodyless(path, { "sec-fetch-site": "same-origin" })).status).toBe(200);
    await h.test.db.updateTable("invitation").set({ last_emailed_at: null }).execute();
    expect((await bodyless(path, { "sec-fetch-site": "none" })).status).toBe(200);
    await h.test.db.updateTable("invitation").set({ last_emailed_at: null }).execute();
    // Older browsers send only Origin: the configured console address and trusted origins count.
    expect((await bodyless(path, { origin: "https://console.example.com" })).status).toBe(200);
    await h.test.db.updateTable("invitation").set({ last_emailed_at: null }).execute();
    expect((await bodyless(path, { origin: "https://nearzero.internal.example" })).status).toBe(
      200,
    );
    await h.test.db.updateTable("invitation").set({ last_emailed_at: null }).execute();
    // No browser headers at all: not a web page.
    expect((await bodyless(path, {})).status).toBe(200);
    // Reads are never refused.
    expect(
      (await owner.request("GET", "/me", undefined, { "sec-fetch-site": "cross-site" })).status,
    ).toBe(200);
  });

  test("the console's word that it checked the origin counts only from the console", async () => {
    const path = `/workspace/invitations/${invitationId}/resend`;
    // From the console (loopback, a trusted proxy), an origin it already compared passes.
    const checked = await bodyless(path, {
      origin: "http://203.0.113.10:4321",
      [ORIGIN_CHECKED_HEADER]: "1",
    });
    expect(checked.status).toBe(200);
    // Straight to the API from elsewhere, the same claim is ignored.
    const direct = h.browser({ peer: "203.0.113.50" });
    for (const [name, value] of owner.cookies) direct.cookies.set(name, value);
    await h.test.db.updateTable("invitation").set({ last_emailed_at: null }).execute();
    const claimed = await direct.request("POST", path, undefined, {
      origin: "http://203.0.113.10:4321",
      [ORIGIN_CHECKED_HEADER]: "1",
    });
    expect(claimed.status).toBe(403);
    // …but the address the API itself was reached at counts as this site.
    const own = await direct.request("POST", path, undefined, { origin: "http://localhost" });
    expect(own.status).toBe(200);
    // A Fetch Metadata header from another site is refused even with the console's word.
    const marked = await bodyless(path, {
      "sec-fetch-site": "same-site",
      [ORIGIN_CHECKED_HEADER]: "1",
    });
    expect(marked.status).toBe(403);
  });

  test("a terminal WebSocket from another site is refused before anything else", async () => {
    const opened = await owner.request(
      "GET",
      "/services/00000000-0000-4000-8000-000000000000/terminal",
      undefined,
      { upgrade: "websocket", connection: "Upgrade", "sec-fetch-site": "same-site" },
    );
    expect(opened.status).toBe(403);
    expect(opened.body.error.message).toBe(CROSS_SITE_REFUSAL);
    const fromOrigin = await owner.request(
      "GET",
      "/services/00000000-0000-4000-8000-000000000000/terminal",
      undefined,
      { upgrade: "websocket", connection: "Upgrade", origin: "https://app.example.com" },
    );
    expect(fromOrigin.status).toBe(403);
    // The same upgrade from the console's own page goes on to the usual checks.
    const own = await owner.request(
      "GET",
      "/services/00000000-0000-4000-8000-000000000000/terminal",
      undefined,
      { upgrade: "websocket", connection: "Upgrade", "sec-fetch-site": "same-origin" },
    );
    expect(own.status).toBe(404);
  });

  test("webhooks and runners are machine paths, never refused for their headers", async () => {
    const webhook = await owner.request("POST", "/webhooks/deploy/not-a-token", undefined, {
      origin: "https://github.com",
      "sec-fetch-site": "cross-site",
    });
    expect(webhook.status).not.toBe(403);
  });
});

describe("the rule itself (packages/shared request-origin.ts)", () => {
  const own = ["https://console.example.com", "http://203.0.113.10:4321"];
  const base = { method: "POST", upgrade: false, ownOrigins: own };
  test("Fetch Metadata decides first, then Origin", () => {
    expect(isCrossSiteRequest({ ...base, fetchSite: "same-origin", origin: null })).toBe(false);
    expect(isCrossSiteRequest({ ...base, fetchSite: "none", origin: null })).toBe(false);
    expect(isCrossSiteRequest({ ...base, fetchSite: "same-site", origin: null })).toBe(true);
    expect(isCrossSiteRequest({ ...base, fetchSite: "Cross-Site", origin: own[0] })).toBe(true);
    expect(isCrossSiteRequest({ ...base, fetchSite: null, origin: own[1] })).toBe(false);
    expect(
      isCrossSiteRequest({ ...base, fetchSite: null, origin: "HTTPS://Console.Example.com:443" }),
    ).toBe(false);
    expect(
      isCrossSiteRequest({ ...base, fetchSite: null, origin: "http://console.example.com" }),
    ).toBe(true);
    expect(isCrossSiteRequest({ ...base, fetchSite: null, origin: "null" })).toBe(true);
    expect(isCrossSiteRequest({ ...base, fetchSite: null, origin: null })).toBe(false);
  });
  test("reads are free, upgrades are not", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(isCrossSiteRequest({ ...base, method, fetchSite: "cross-site", origin: null })).toBe(
        false,
      );
    }
    expect(
      isCrossSiteRequest({
        ...base,
        method: "GET",
        upgrade: true,
        fetchSite: "same-site",
        origin: null,
      }),
    ).toBe(true);
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(isCrossSiteRequest({ ...base, method, fetchSite: "same-site", origin: null })).toBe(
        true,
      );
    }
  });
  test("trusted origins are read as origins, and junk is skipped", () => {
    expect(
      parseOriginList(" https://a.example.com/path , nonsense, http://10.0.0.5:4321 "),
    ).toEqual(["https://a.example.com", "http://10.0.0.5:4321"]);
    expect(parseOriginList(undefined)).toEqual([]);
  });
});
