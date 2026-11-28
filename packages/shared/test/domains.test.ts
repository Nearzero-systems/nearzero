import { describe, expect, test } from "bun:test";
import { isPublicIPv4 } from "../src/addresses.ts";
import {
  type CertificateFacts,
  caaText,
  certificateAdvice,
  certificateCovers,
  checkHostnameInput,
  checkNamePrefix,
  checkRecord,
  checkRecordName,
  DAY_MS,
  expiresSoon,
  failureCountsTowardPause,
  generatedLabel,
  HOSTNAME_MESSAGES,
  HOUR_MS,
  httpsStatus,
  isNumericLikeLabel,
  isRateLimitError,
  nameLabel,
  numericLabelMessage,
  pausedUntil,
  recordTarget,
  relativeRecordName,
  retryAfterIn,
  retryRefusal,
  txtStrings,
  ZONE_MESSAGES,
} from "../src/domains.ts";

describe("hostnames typed into Add domain (spec 10.5)", () => {
  const bad = (raw: string) => {
    const result = checkHostnameInput(raw);
    if (result.ok) throw new Error(`${raw} was accepted`);
    return result.message;
  };

  test("each problem gets the spec's words", () => {
    expect(bad("")).toBe(HOSTNAME_MESSAGES.empty);
    expect(bad("   ")).toBe("Enter a hostname, like app.example.com.");
    expect(bad("https://app.example.com")).toBe("Leave out http:// or https://.");
    expect(bad("http://app.example.com/x")).toBe(HOSTNAME_MESSAGES.scheme);
    expect(bad("app.example.com/login")).toBe("Enter just the hostname, without a path or port.");
    expect(bad("app.example.com:8080")).toBe(HOSTNAME_MESSAGES.pathOrPort);
    expect(bad("*.example.com")).toStartWith("Wildcards can't be added here");
    expect(bad("app")).toStartWith("Use a full hostname");
    expect(bad("bad_name.example.com")).toBe("That isn't a valid hostname.");
    expect(bad("-app.example.com")).toBe(HOSTNAME_MESSAGES.invalid);
    expect(bad(`${"a".repeat(64)}.example.com`)).toBe(HOSTNAME_MESSAGES.invalid);
    expect(bad("203.0.113.10")).toBe(HOSTNAME_MESSAGES.ipAddress);
  });

  test("names are lowercased, trimmed and lose a trailing dot; IDNs become punycode", () => {
    expect(checkHostnameInput("  App.Example.COM. ")).toEqual({
      ok: true,
      hostname: "app.example.com",
    });
    expect(checkHostnameInput("bücher.example.com")).toEqual({
      ok: true,
      hostname: "xn--bcher-kva.example.com",
    });
  });

  test("a last label that looks like a number or hex is refused; digits elsewhere are fine", () => {
    expect(isNumericLikeLabel("123")).toBe(true);
    expect(isNumericLikeLabel("0x1f")).toBe(true);
    expect(isNumericLikeLabel("0x")).toBe(true);
    expect(isNumericLikeLabel("a3f9c2b1")).toBe(false);
    expect(isNumericLikeLabel("12ab")).toBe(false);
    expect(bad("app.123")).toBe(numericLabelMessage("123"));
    expect(bad("app.example.0xbeef")).toBe(numericLabelMessage("0xbeef"));
    expect(bad("app.example.0x")).toBe(numericLabelMessage("0x"));
    expect(checkHostnameInput("123.example.com")).toEqual({
      ok: true,
      hostname: "123.example.com",
    });
    expect(checkHostnameInput("2048.example.com")).toEqual({
      ok: true,
      hostname: "2048.example.com",
    });
    expect(checkHostnameInput("0xbeef.example.com")).toEqual({
      ok: true,
      hostname: "0xbeef.example.com",
    });
    expect(checkHostnameInput("web.42.example.com")).toEqual({
      ok: true,
      hostname: "web.42.example.com",
    });
    expect(checkHostnameInput("app.example.c0m")).toEqual({
      ok: true,
      hostname: "app.example.c0m",
    });
  });
});

describe("labels Nearzero makes (spec 10.1, 10.2)", () => {
  test("generated labels are 8 characters, start with a letter, and never look like a number", () => {
    for (let i = 0; i < 500; i++) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const label = generatedLabel(bytes);
      expect(label).toMatch(/^[a-z][a-z0-9]{7}$/);
      expect(isNumericLikeLabel(label)).toBe(false);
    }
    expect(generatedLabel(new Uint8Array(8))).toBe("aaaaaaaa");
    expect(() => generatedLabel(new Uint8Array(3))).toThrow();
  });

  test("labels from names: a slug, app- before a leading digit", () => {
    expect(nameLabel("Web")).toBe("web");
    expect(nameLabel("My API v2")).toBe("my-api-v2");
    expect(nameLabel("2048 game")).toBe("app-2048-game");
    expect(nameLabel("0xdead")).toBe("app-0xdead");
    expect(nameLabel("!!!")).toBe("app");
    expect(nameLabel("x".repeat(80)).length).toBe(63);
  });

  test("name prefixes", () => {
    expect(checkNamePrefix(" Staging ")).toEqual({ ok: true, prefix: "staging" });
    expect(checkNamePrefix("eu.staging")).toEqual({ ok: true, prefix: "eu.staging" });
    expect(checkNamePrefix("")).toEqual({ ok: true, prefix: "" });
    expect(checkNamePrefix("bad_one").ok).toBe(false);
    // The zone always follows the prefix, so digits in it are never the last label.
    expect(checkNamePrefix("123")).toEqual({ ok: true, prefix: "123" });
    expect(checkNamePrefix("eu.2")).toEqual({ ok: true, prefix: "eu.2" });
  });
});

describe("record names relative to their zone (spec 9.5)", () => {
  test("relative names", () => {
    expect(relativeRecordName("*.prod-1.apps.example.com", "example.com")).toBe("*.prod-1.apps");
    expect(relativeRecordName("example.com.", "example.com")).toBe("@");
    expect(relativeRecordName("app.example.co.uk", "example.co.uk")).toBe("app");
    expect(relativeRecordName("other.net", "example.com")).toBe("other.net");
  });

  test("record names in the Records dialog", () => {
    expect(checkRecordName("@", "example.com")).toEqual({ ok: true, name: "@" });
    expect(checkRecordName("www.example.com", "example.com")).toEqual({ ok: true, name: "www" });
    expect(checkRecordName("www.example.com.", "example.com")).toEqual({ ok: true, name: "www" });
    expect(checkRecordName("_dmarc", "example.com")).toEqual({ ok: true, name: "_dmarc" });
    expect(checkRecordName("*.dev", "example.com")).toEqual({ ok: true, name: "*.dev" });
    expect(checkRecordName("www.other.net.", "example.com")).toEqual({
      ok: false,
      message: "Use a name inside example.com, like www or www.example.com.",
    });
    expect(checkRecordName("bad name", "example.com").ok).toBe(false);
  });
});

describe("managed zone records (spec 10.8)", () => {
  const zone = "example.com";
  const ok = (
    input: Partial<Parameters<typeof checkRecord>[0]>,
    others: Parameters<typeof checkRecord>[2] = [],
  ) =>
    checkRecord(
      { name: "www", type: "A", value: "203.0.113.10", ttl: 300, priority: null, ...input },
      zone,
      others,
    );

  test("A is IPv4 and AAAA IPv6", () => {
    expect(ok({})).toBeNull();
    expect(ok({ value: "2001:db8::1" })?.value).toBe(
      "An A record needs an IPv4 address, like 203.0.113.10.",
    );
    expect(ok({ type: "AAAA", value: "2001:db8::1" })).toBeNull();
    expect(ok({ type: "AAAA", value: "203.0.113.10" })?.value).toStartWith(
      "An AAAA record needs an IPv6",
    );
  });

  test("TXT strings are at most 255 bytes each", () => {
    expect(ok({ type: "TXT", value: "v=spf1 -all" })).toBeNull();
    expect(ok({ type: "TXT", value: "x".repeat(256) })?.value).toStartWith(
      "Each TXT string can be at most 255 bytes",
    );
    expect(ok({ type: "TXT", value: `"${"x".repeat(255)}" "${"y".repeat(200)}"` })).toBeNull();
    expect(ok({ type: "TXT", value: `"${"é".repeat(128)}"` })?.value).toStartWith(
      "Each TXT string",
    );
    expect(txtStrings('"a b" "c\\"d"')).toEqual(["a b", 'c"d']);
  });

  test("CAA with or without quotes, MX with a priority or none (10), the TTL in range", () => {
    expect(ok({ name: "@", type: "CAA", value: '0 issue "letsencrypt.org"' })).toBeNull();
    // G3-11: an unquoted CAA value saves, and is written with quotes.
    expect(ok({ name: "@", type: "CAA", value: "0 issue letsencrypt.org" })).toBeNull();
    expect(caaText("0 issue letsencrypt.org")).toBe('0 issue "letsencrypt.org"');
    expect(caaText('128 iodef "mailto:ops@example.com"')).toBe(
      '128 iodef "mailto:ops@example.com"',
    );
    expect(ok({ name: "@", type: "CAA", value: '300 issue "x"' })?.value).toStartWith(
      "Write a CAA record",
    );
    expect(ok({ name: "@", type: "CAA", value: "0 issue" })?.value).toStartWith(
      "Write a CAA record",
    );
    expect(ok({ name: "@", type: "MX", value: "mail.example.com", priority: 10 })).toBeNull();
    // G3-11: a blank MX priority is 10.
    expect(ok({ name: "@", type: "MX", value: "mail" })).toBeNull();
    expect(ok({ name: "@", type: "MX", value: "mail", priority: 70_000 })?.priority).toStartWith(
      "Enter the MX priority",
    );
    expect(ok({ ttl: 0 })?.ttl).toBe("Use a TTL from 1 to 2147483647 seconds.");
    expect(ok({ ttl: 2_147_483_648 })?.ttl).toBe("Use a TTL from 1 to 2147483647 seconds.");
    // R3-24: the week-long TTL common for NS and MX records saves.
    expect(ok({ ttl: 604_800 })).toBeNull();
    expect(ok({ ttl: 5 })).toBeNull();
  });

  test('G3-11: "@" is the zone, and one word is a name inside it, never a top-level name', () => {
    expect(ok({ type: "CNAME", value: "@" })).toBeNull();
    expect(ok({ type: "CNAME", value: "mail" })).toBeNull();
    expect(ok({ name: "@", type: "NS", value: "ns1" })).toBeNull();
    expect(recordTarget("@", zone)).toBe("example.com.");
    expect(recordTarget("mail", zone)).toBe("mail.example.com.");
    expect(recordTarget("Mail", zone)).toBe("mail.example.com.");
    expect(recordTarget("target.example.net", zone)).toBe("target.example.net.");
    expect(recordTarget("target.example.net.", zone)).toBe("target.example.net.");
    expect(ok({ type: "CNAME", value: "bad name" })?.value).toBe(
      "A CNAME record needs a hostname, like target.example.net.",
    );
  });

  test("CNAME cannot coexist with other records", () => {
    const records = [{ id: "1", name: "www", type: "A" as const }];
    expect(ok({ type: "CNAME", value: "target.example.net" }, records)?.type).toBe(
      ZONE_MESSAGES.cnameAlone,
    );
    expect(ok({ name: "@", type: "CNAME", value: "target.example.net" })?.type).toBe(
      ZONE_MESSAGES.cnameAlone,
    );
    expect(ok({}, [{ id: "2", name: "www", type: "CNAME" }])?.type).toBe(
      "CNAME cannot coexist with other records",
    );
    expect(ok({ name: "blog", type: "CNAME", value: "target.example.net" }, records)).toBeNull();
  });

  test("the name must be inside the zone", () => {
    expect(ok({ name: "www.other.net." })?.name).toStartWith("Use a name inside example.com");
  });
});

// ---- The certificate state machine (spec 10.7)

const NOW = Date.parse("2026-11-25T12:00:00Z");

function facts(over: Partial<CertificateFacts> = {}): CertificateFacts {
  return {
    hostname: "app.example.com",
    connected: true,
    uploaded: null,
    storeReadable: true,
    certificate: null,
    hold: null,
    dnsPointsHere: true,
    failures: [],
    rateLimitedUntil: null,
    lastError: null,
    requestedAt: null,
    retriedAt: null,
    ...over,
  };
}

describe("HTTPS states (spec 10.7)", () => {
  const state = (over: Partial<CertificateFacts>) => httpsStatus(facts(over), NOW);

  test("not in use, uploaded, unknown", () => {
    expect(state({ connected: false })).toMatchObject({
      state: "not_in_use",
      note: "Connect a service to get a certificate.",
    });
    expect(state({ uploaded: { name: "Wildcard", notAfter: NOW + 90 * DAY_MS } })).toMatchObject({
      state: "uploaded",
      label: "Uploaded",
    });
    expect(state({ uploaded: { name: "Old", notAfter: NOW - DAY_MS } }).state).toBe("expired");
    expect(state({ storeReadable: false })).toMatchObject({
      state: "unknown",
      note: "Couldn't read certificates on this server.",
    });
  });

  test("valid, expires soon, expired", () => {
    const valid = state({
      certificate: { notBefore: NOW - 10 * DAY_MS, notAfter: NOW + 80 * DAY_MS, issuer: "R11" },
    });
    expect(valid.state).toBe("valid");
    expect(valid.note).toBe("Valid until 2027-02-13. Renews automatically.");
    expect(
      state({
        certificate: { notBefore: NOW - 80 * DAY_MS, notAfter: NOW + 10 * DAY_MS, issuer: "R11" },
      }).state,
    ).toBe("expires_soon");
    expect(
      state({
        certificate: { notBefore: NOW - 91 * DAY_MS, notAfter: NOW - DAY_MS, issuer: "R11" },
      }).state,
    ).toBe("expired");
    // Less than the smaller of 20 days and a quarter of its lifetime: a 7-day certificate with 1 day left.
    expect(expiresSoon(NOW - 6 * DAY_MS, NOW + DAY_MS, NOW)).toBe(true);
    expect(expiresSoon(NOW - 2 * DAY_MS, NOW + 5 * DAY_MS, NOW)).toBe(false);
    expect(expiresSoon(NOW - 60 * DAY_MS, NOW + 21 * DAY_MS, NOW)).toBe(false);
  });

  test("waiting for DNS, queued, not trusted", () => {
    expect(state({ hold: "no_record", dnsPointsHere: false }).state).toBe("waiting_for_dns");
    expect(state({ hold: "points_elsewhere", dnsPointsHere: null }).note).toContain(
      "asks Let's Encrypt once DNS points here",
    );
    expect(state({ hold: "no_record", dnsPointsHere: true })).toMatchObject({
      state: "queued",
      note: "DNS points here now. Nearzero asks Let's Encrypt within 5 minutes, or press Check DNS to ask now.",
    });
    expect(state({ hold: "not_public" }).state).toBe("not_trusted");
    expect(state({ requestedAt: NOW - 30 * 60_000 })).toMatchObject({
      state: "not_trusted",
      note: "The router's default certificate is being served.",
    });
  });

  test("issuing, failed, paused, rate limited", () => {
    expect(state({ requestedAt: NOW - 20_000 })).toMatchObject({ state: "issuing" });
    expect(state({ requestedAt: NOW - 20_000 }).note).toContain("usually under a minute");
    expect(
      state({
        requestedAt: NOW - 60_000,
        failures: [NOW - 30_000],
        lastError: "connection: refused",
      }),
    ).toMatchObject({ state: "failed", note: "connection: refused" });
    // A newer request than the failure: issuing again.
    expect(
      state({ requestedAt: NOW - 10_000, failures: [NOW - 30_000], lastError: "x" }).state,
    ).toBe("issuing");
    const paused = state({
      failures: [NOW - 50 * 60_000, NOW - 20 * 60_000, NOW - 60_000],
      lastError: "dns: NXDOMAIN",
    });
    expect(paused.state).toBe("paused");
    expect(paused.note).toStartWith("Failed 3 times in the last hour");
    expect(paused.note).toEndWith("Fix it, then press Retry.");
    expect(paused.until).toBe(NOW + 10 * 60_000);
    const limited = state({ rateLimitedUntil: NOW + 3 * HOUR_MS });
    expect(limited).toMatchObject({ state: "rate_limited", until: NOW + 3 * HOUR_MS });
    expect(limited.note).toContain("Retry after 2026-11-25 15:00 UTC");
  });
});

describe("uploaded certificates and errors Let's Encrypt never checked (R3-18, R3-19)", () => {
  const state = (over: Partial<CertificateFacts>) => httpsStatus(facts(over), NOW);

  test("an uploaded certificate warns within 14 days of its end, since nothing renews it", () => {
    const soon = state({ uploaded: { name: "Wild", notAfter: NOW + 10 * DAY_MS } });
    expect(soon).toMatchObject({ state: "expires_soon", label: "Expires soon" });
    expect(soon.note).toBe(
      "The uploaded certificate \"Wild\" ends on 2026-12-05. Nearzero can't renew uploaded certificates: upload a new one before then, or delete it to use Let's Encrypt.",
    );
    expect(state({ uploaded: { name: "Wild", notAfter: NOW + 15 * DAY_MS } }).state).toBe(
      "uploaded",
    );
  });

  test("an error that didn't count toward the pause still shows as Failed", () => {
    expect(
      state({
        requestedAt: NOW - 60_000,
        failures: [],
        lastError: "This server couldn't reach Let's Encrypt.",
        lastErrorAt: NOW - 30_000,
      }),
    ).toMatchObject({ state: "failed", note: "This server couldn't reach Let's Encrypt." });
    // A request after it: issuing again.
    expect(
      state({ requestedAt: NOW - 10_000, lastError: "x", lastErrorAt: NOW - 30_000 }).state,
    ).toBe("issuing");
  });

  test("only checks Let's Encrypt made of the name count toward the pause", () => {
    for (const counted of [
      "acme: error: 400 :: urn:ietf:params:acme:error:connection :: 203.0.113.10: Timeout during connect",
      "urn:ietf:params:acme:error:dns :: DNS problem: NXDOMAIN looking up A for x.example.com",
      "urn:ietf:params:acme:error:unauthorized :: Invalid response from http://x/.well-known/acme-challenge/y: 404",
      "urn:ietf:params:acme:error:caa :: CAA record for x.example.com prevents issuance",
      "urn:ietf:params:acme:error:tls :: remote error: tls: handshake failure",
    ]) {
      expect(failureCountsTowardPause(counted)).toBe(true);
    }
    for (const never of [
      "cannot get ACME client get directory at 'https://acme-v02.api.letsencrypt.org/directory': Get \"https://acme-v02.api.letsencrypt.org/directory\": dial tcp: lookup acme-v02.api.letsencrypt.org: no such host",
      'urn:ietf:params:acme:error:rejectedIdentifier :: Error creating new order :: Cannot issue for "x.local": Domain name does not end with a valid public suffix (TLD)',
      "urn:ietf:params:acme:error:serverInternal :: The service is down for maintenance",
      "urn:ietf:params:acme:error:badNonce :: JWS has an invalid anti-replay nonce",
    ]) {
      expect(failureCountsTowardPause(never)).toBe(false);
    }
  });

  test("the router's errors become plain advice with the fix", () => {
    const host = "app.example.com";
    const ip = "203.0.113.10";
    expect(
      certificateAdvice(
        "connection: 203.0.113.10: Fetching http://app.example.com/.well-known/acme-challenge/x: Connection refused",
        host,
        ip,
      ),
    ).toBe(
      "Let's Encrypt could not reach port 80 on 203.0.113.10. Open TCP port 80 in the server's firewall and any cloud firewall, then press Retry.",
    );
    expect(
      certificateAdvice(
        "connection: 2001:db8::5: Fetching http://app.example.com/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)",
        host,
        ip,
      ),
    ).toBe(
      "Let's Encrypt tried app.example.com over IPv6 (2001:db8::5) and couldn't reach port 80 there. Remove the AAAA record for app.example.com, or make port 80 reachable over IPv6, then press Retry.",
    );
    expect(
      certificateAdvice("caa: CAA record for app.example.com prevents issuance", host, ip),
    ).toBe(
      'A CAA record blocks Let\'s Encrypt for app.example.com. Add a CAA record: 0 issue "letsencrypt.org", then press Retry.',
    );
    expect(
      certificateAdvice(
        "unauthorized: 104.16.0.1: Invalid response from https://app.example.com/.well-known/acme-challenge/x: 404",
        host,
        ip,
      ),
    ).toStartWith(
      "The check was redirected to HTTPS, so Let's Encrypt couldn't read Nearzero's answer over HTTP. If Cloudflare proxies app.example.com, turn off Always Use HTTPS",
    );
    expect(
      certificateAdvice(
        "dns: DNS problem: NXDOMAIN looking up A for app.example.com - check that a DNS record exists for this domain",
        host,
        ip,
      ),
    ).toBe(
      "Let's Encrypt found no DNS record for app.example.com. Add the A record pointing at 203.0.113.10, wait a few minutes, then press Retry.",
    );
    expect(
      certificateAdvice(
        'rejectedIdentifier: Error creating new order :: Cannot issue for "app.example.com": The ACME server refuses to issue a certificate for this domain name, because it is forbidden by policy',
        host,
        ip,
      ),
    ).toBe(
      "Let's Encrypt does not issue certificates for app.example.com. Use another hostname, or upload a certificate that covers it.",
    );
    expect(
      certificateAdvice(
        "cannot get ACME client get directory at 'https://acme-v02.api.letsencrypt.org/directory': Get \"https://acme-v02.api.letsencrypt.org/directory\": dial tcp 172.65.32.248:443: i/o timeout",
        host,
        ip,
      ),
    ).toBe(
      "This server couldn't reach Let's Encrypt (i/o timeout), so app.example.com wasn't checked. Allow outgoing HTTPS (TCP 443) from the server, then press Retry.",
    );
    // Anything else stays as the router said it.
    expect(certificateAdvice("malformed: something odd", host, ip)).toBe(
      "malformed: something odd",
    );
  });
});

describe("the back-off (spec 10.7)", () => {
  test("3 failures in an hour pause until an hour after the first", () => {
    expect(pausedUntil([NOW - 10_000, NOW - 5_000], NOW)).toBeNull();
    expect(pausedUntil([NOW - 40 * 60_000, NOW - 10_000, NOW - 5_000], NOW)).toBe(
      NOW + 20 * 60_000,
    );
    // Older failures don't count.
    expect(pausedUntil([NOW - 2 * HOUR_MS, NOW - 10_000, NOW - 5_000], NOW)).toBeNull();
    // A Retry lifts the pause for failures before it.
    expect(pausedUntil([NOW - 3000, NOW - 2000, NOW - 1000], NOW, NOW - 500)).toBeNull();
    expect(pausedUntil([NOW - 3000, NOW - 2000, NOW - 1000], NOW, NOW - 2500)).toBeNull();
  });

  test("rate limits: retry-after times and their errors", () => {
    const error =
      "acme: error: 429 :: POST :: urn:ietf:params:acme:error:rateLimited :: too many certificates (5) already issued for this exact set of identifiers in the last 168h0m0s, retry after 2026-11-27 21:03:25 UTC: see https://letsencrypt.org/docs/rate-limits/";
    expect(isRateLimitError(error)).toBe(true);
    expect(retryAfterIn(error)).toBe(Date.parse("2026-11-27T21:03:25Z"));
    expect(retryAfterIn("no time here")).toBeNull();
    const at = Date.parse("2026-11-27T21:03:25Z");
    // A space or "T" between date and time, and an optional "UTC" (with or without a space) or "Z".
    expect(retryAfterIn("retry after 2026-11-27 21:03:25 UTC: see …")).toBe(at);
    expect(retryAfterIn("retry after 2026-11-27 21:03:25UTC")).toBe(at);
    expect(retryAfterIn("Retry After 2026-11-27T21:03:25Z")).toBe(at);
    expect(retryAfterIn("RETRY AFTER 2026-11-27T21:03:25")).toBe(at);
    expect(retryAfterIn("retry after 2026-11-27 21:03:25")).toBe(at);
    // Anything else is no retry-after time.
    expect(retryAfterIn("retry after 2026-11-27_21:03:25")).toBeNull();
    expect(retryAfterIn("retry after 2026-02-30 21:03:25 UTC")).toBeNull();
    expect(retryAfterIn("retry after 2026-11-27 25:03:25 UTC")).toBeNull();
    expect(retryAfterIn("retry after 26-11-27 21:03:25 UTC")).toBeNull();
    expect(retryAfterIn("retry after soon")).toBeNull();
    expect(isRateLimitError("urn:ietf:params:acme:error:connection :: refused")).toBe(false);
  });
});

describe("Retry is refused, with the reason (spec 10.7)", () => {
  const refuse = (over: Partial<CertificateFacts>, lastAttemptAt: number | null = null) =>
    retryRefusal(facts(over), NOW, lastAttemptAt);

  test("each rule, in order", () => {
    expect(refuse({ connected: false })).toBe(
      "Connect a service to app.example.com first. Certificates are only requested for hostnames that serve something.",
    );
    expect(refuse({ uploaded: { name: "Wildcard", notAfter: NOW + DAY_MS } })).toContain(
      'The uploaded certificate "Wildcard" covers app.example.com',
    );
    expect(
      refuse({
        certificate: { notBefore: NOW - DAY_MS, notAfter: NOW + 60 * DAY_MS, issuer: "R11" },
      }),
    ).toBe(
      "app.example.com already has a valid certificate (until 2027-01-24), and it renews by itself.",
    );
    expect(refuse({ dnsPointsHere: false })).toBe(
      "DNS for app.example.com doesn't point at this server yet, so Let's Encrypt would refuse it. Fix the record, then press Check DNS.",
    );
    expect(refuse({ dnsPointsHere: null, hold: "no_record" })).toContain(
      "doesn't point at this server yet",
    );
    expect(refuse({ hold: "not_public" })).toContain("can't get a public certificate");
    expect(refuse({ rateLimitedUntil: NOW + HOUR_MS })).toBe(
      "Let's Encrypt limited requests for this domain. Try again after 2026-11-25 13:00 UTC.",
    );
    expect(
      refuse({
        failures: [NOW - 50 * 60_000, NOW - 40 * 60_000, NOW - 30 * 60_000, NOW - 20 * 60_000],
      }),
    ).toBe("Let's Encrypt allows 5 failed checks per hour. Try again after 2026-11-25 12:10 UTC.");
    expect(refuse({}, NOW - 30_000)).toBe(
      "Nearzero asked Let's Encrypt less than a minute ago. Wait a minute, then try again.",
    );
  });

  test("allowed: an expired certificate, 3 failures (a paused hostname), a lookup that failed", () => {
    expect(
      refuse({
        certificate: { notBefore: NOW - 91 * DAY_MS, notAfter: NOW - DAY_MS, issuer: "R11" },
      }),
    ).toBeNull();
    expect(refuse({ failures: [NOW - 3000, NOW - 2000, NOW - 1000] }, NOW - 2 * 60_000)).toBeNull();
    expect(refuse({ dnsPointsHere: null, hold: "lookup_failed" })).toBeNull();
    expect(refuse({})).toBeNull();
  });
});

describe("uploaded certificates and addresses", () => {
  test("which names a certificate covers", () => {
    expect(certificateCovers(["*.example.com"], "app.example.com")).toBe(true);
    expect(certificateCovers(["*.example.com"], "a.b.example.com")).toBe(false);
    expect(certificateCovers(["*.example.com"], "example.com")).toBe(false);
    expect(certificateCovers(["App.Example.com"], "app.example.com")).toBe(true);
  });

  test("publicly routable IPv4 addresses", () => {
    expect(isPublicIPv4("8.8.8.8")).toBe(true);
    for (const ip of [
      "10.0.0.1",
      "172.16.5.4",
      "192.168.1.1",
      "127.0.0.1",
      "100.64.0.1",
      "169.254.1.1",
      "192.0.2.1",
      "198.51.100.1",
      "203.0.113.5",
      "224.0.0.1",
      "0.1.2.3",
      "198.18.0.1",
    ]) {
      expect(isPublicIPv4(ip)).toBe(false);
    }
    expect(isPublicIPv4("not.an.ip")).toBe(false);
  });
});
