import { describe, expect, test } from "bun:test";
import { isZoneMailbox, retryRefusal, zoneSchema } from "@nearzero/shared";
import { factsFor } from "../src/domains/certificates.ts";
import { checkName, findZone, inRange, proxiedNote, proxyOf } from "../src/domains/dns-check.ts";
import { detectProvider, providerSteps, recordTitle } from "../src/domains/providers.ts";
import { type DnsLookup, LookupError } from "../src/domains/settings.ts";
import { renderCorefile, renderZone, soaMailbox } from "../src/domains/zones.ts";
import fixtures from "./fixtures/nameservers.json";

/**
 * The domains area's pure rules: provider detection from recorded nameservers (spec 9.5), DNS
 * check statuses (spec 10.5, 10.6) and the zone files the built-in DNS server reads (spec 10.8).
 */

describe("DNS provider detection from nameservers (spec 9.5)", () => {
  const expected: Record<string, string> = {
    cloudflare: "Cloudflare",
    route53: "Amazon Route 53",
    godaddy: "GoDaddy",
    namecheap: "Namecheap",
    digitalocean: "DigitalOcean",
    google: "Google Cloud DNS",
    vercel: "Vercel",
    porkbun: "Porkbun",
    azure: "Azure DNS",
    hetzner: "Hetzner",
    ovh: "OVHcloud",
    gandi: "Gandi",
    linode: "Linode (Akamai)",
    vultr: "Vultr",
    ionos: "IONOS",
    namesilo: "NameSilo",
    dnsimple: "DNSimple",
    ns1: "NS1",
    hostinger: "Hostinger",
  };

  for (const [id, name] of Object.entries(expected)) {
    test(`${name} is recognized`, () => {
      const provider = detectProvider(
        (fixtures as unknown as Record<string, string[]>)[id] as string[],
      );
      expect(provider?.id).toBe(id);
      expect(provider?.name).toBe(name);
    });
  }

  test("an unknown provider, or none, gets the general title", () => {
    expect(detectProvider(fixtures.unknown)).toBeNull();
    expect(detectProvider([])).toBeNull();
    expect(recordTitle(null)).toBe("Add one DNS record at your DNS provider");
    expect(recordTitle(detectProvider(fixtures.cloudflare))).toBe(
      "Add one DNS record in Cloudflare",
    );
  });

  const record = {
    name: "*.prod-1.apps",
    fullName: "*.prod-1.apps.example.com",
    zone: "example.com",
    type: "A" as const,
    value: "203.0.113.10",
  };

  test("Cloudflare's steps turn the proxy off", () => {
    const steps = providerSteps(detectProvider(fixtures.cloudflare), record);
    expect(steps.join(" ")).toContain("Turn Proxy status off (grey cloud, DNS only)");
    expect(steps.join(" ")).toContain("Name *.prod-1.apps, IPv4 address 203.0.113.10");
  });

  test("providers with their own steps name the record relative to the zone", () => {
    for (const id of [
      "route53",
      "godaddy",
      "namecheap",
      "digitalocean",
      "vercel",
      "porkbun",
      "azure",
    ]) {
      const steps = providerSteps(
        detectProvider((fixtures as unknown as Record<string, string[]>)[id] as string[]),
        record,
      ).join(" ");
      expect(steps).toContain("*.prod-1.apps");
      expect(steps).toContain("203.0.113.10");
    }
    // Google Cloud DNS takes the full name.
    expect(providerSteps(detectProvider(fixtures.google), record).join(" ")).toContain(
      "*.prod-1.apps.example.com",
    );
  });

  test("other recognized providers get general steps naming them", () => {
    const steps = providerSteps(detectProvider(fixtures.hetzner), record);
    expect(steps[0]).toBe("In Hetzner, open the DNS records of example.com.");
    expect(providerSteps(null, record)[0]).toBe(
      "At your DNS provider, open the DNS records of example.com.",
    );
  });
});

/** Answers from a table; names not in it don't exist. */
function lookup(
  table: Record<string, { a?: string[]; aaaa?: string[]; ns?: string[]; fail?: boolean }>,
): DnsLookup {
  const answer = (name: string, kind: "a" | "aaaa" | "ns") => {
    const entry = table[name];
    if (!entry) return Promise.reject(new LookupError("not_found", `${name} doesn't exist`));
    if (entry.fail) return Promise.reject(new LookupError("failed", "SERVFAIL"));
    const values = entry[kind];
    if (!values) return Promise.reject(new LookupError("no_data", "no data"));
    return Promise.resolve(values);
  };
  return {
    resolve4: (name) => answer(name, "a"),
    resolve6: (name) => answer(name, "aaaa"),
    resolveNs: (name) => answer(name, "ns"),
    resolveCname: () => Promise.reject(new LookupError("no_data", "no data")),
    soaSerialAt: () => Promise.reject(new LookupError("failed", "no")),
  };
}

describe("DNS check statuses (spec 10.5, 10.6)", () => {
  const dns = lookup({
    "here.example.com": { a: ["203.0.113.10"] },
    "elsewhere.example.com": { a: ["198.51.100.7"] },
    "proxied.example.com": { a: ["104.21.3.4", "172.67.1.2"] },
    "six.example.com": { aaaa: ["2001:db8::1"] },
    "broken.example.com": { fail: true },
  });
  const status = async (name: string, expected: string | null = "203.0.113.10") =>
    checkName(dns, name, expected, 0);

  test("points here, elsewhere, proxied, IPv6 only, no record, lookup failed, address unknown", async () => {
    expect((await status("here.example.com")).status).toBe("points_here");
    const elsewhere = await status("elsewhere.example.com");
    expect(elsewhere.status).toBe("points_elsewhere");
    expect(elsewhere.message).toBe(
      "elsewhere.example.com points at 198.51.100.7, not 203.0.113.10. Change its A record to 203.0.113.10.",
    );
    const proxied = await status("proxied.example.com");
    expect(proxied).toMatchObject({ status: "proxied", proxiedBy: "Cloudflare" });
    // Why it can't be added yet; once added, the list shows the HTTP-challenge note (R3-11).
    expect(proxied.message).toStartWith("Turn off the DNS proxy for proxied.example.com");
    expect(proxiedNote(proxied.proxiedBy)).toBe(
      "Proxied by Cloudflare. HTTPS works if Cloudflare forwards plain HTTP for /.well-known/acme-challenge/ to this server.",
    );
    expect((await status("six.example.com")).status).toBe("ipv6_only");
    const none = await status("missing.example.com");
    expect(none.status).toBe("no_record");
    expect(none.message).toStartWith("missing.example.com doesn't resolve yet");
    expect((await status("broken.example.com")).message).toBe(
      "Couldn't look up broken.example.com just now. Try again in a moment.",
    );
    expect((await status("here.example.com", null)).status).toBe("address_unknown");
  });

  test("Cloudflare's ranges", () => {
    expect(inRange("104.16.0.1", "104.16.0.0/13")).toBe(true);
    expect(inRange("104.24.0.1", "104.16.0.0/13")).toBe(false);
    expect(proxyOf(["172.67.1.2"])).toBe("Cloudflare");
    expect(proxyOf(["8.8.8.8"])).toBeNull();
  });

  test("R3-16: Fastly, Bunny CDN and Arvancloud are recognized too", async () => {
    expect(proxyOf(["151.101.1.57", "151.101.65.57"])).toBe("Fastly");
    expect(proxyOf(["89.187.188.227"])).toBe("Bunny CDN");
    expect(proxyOf(["185.143.233.4"])).toBe("Arvancloud");
    // Every address must be the proxy's.
    expect(proxyOf(["151.101.1.57", "203.0.113.9"])).toBeNull();
    const fastly = await checkName(
      lookup({ "cdn.example.com": { a: ["151.101.1.57"] } }),
      "cdn.example.com",
      "203.0.113.10",
      0,
    );
    expect(fastly).toMatchObject({ status: "proxied", proxiedBy: "Fastly" });
    // A proxied name isn't "DNS is wrong": Retry may ask Let's Encrypt (R3-11).
    const facts = factsFor(
      { host: "cdn.example.com", connected: true, target: "host" },
      undefined,
      [],
      fastly,
    );
    expect(facts.dnsPointsHere).toBeNull();
    expect(retryRefusal(facts, Date.now(), null)).toBeNull();
  });

  test("the zone of a name is its closest parent with nameservers", async () => {
    const zones = lookup({
      "example.com": { ns: ["ada.ns.cloudflare.com"] },
      "prod-1.apps.example.com": {},
      "apps.example.com": {},
    });
    expect(await findZone(zones, "*.prod-1.apps.example.com")).toEqual({
      zone: "example.com",
      nameservers: ["ada.ns.cloudflare.com"],
    });
    expect(await findZone(lookup({}), "app.example.org")).toEqual({
      zone: "example.org",
      nameservers: [],
    });
  });
});

describe("zone files for the built-in DNS server (spec 10.8)", () => {
  test("the SOA mailbox escapes dots in the local part", () => {
    expect(soaMailbox("host.master@example.com", "example.com")).toBe("host\\.master.example.com.");
  });

  test("B1-14: an admin email that would break the zone file is refused, and never rendered", () => {
    // The review's payload: ";" comments out the SOA fields and ")" unbalances them. CoreDNS
    // stops serving every zone when one file doesn't parse (checked with coredns 1.15.0).
    for (const bad of [
      "dns@broken.example);",
      "a;b@example.com",
      "a(b@example.com",
      'a"b@example.com',
      "a\\b@example.com",
      "$x@example.com",
      "a b@example.com",
      "a..b@example.com",
      "a@example.com.",
      "a@exa)mple.com",
      "@example.com",
    ]) {
      expect(isZoneMailbox(bad)).toBe(false);
      expect(zoneSchema.safeParse({ domain: "example.com", adminEmail: bad }).success).toBe(false);
    }
    for (const good of [
      "hostmaster@example.com",
      "dns.ops+zone@mail.example.co.uk",
      "a_b-c@x.io",
    ]) {
      expect(zoneSchema.safeParse({ domain: "example.com", adminEmail: good }).success).toBe(true);
    }
    // A row saved before this check (or imported) becomes hostmaster of its zone.
    expect(soaMailbox("dns@broken.example);", "broken.example")).toBe("hostmaster.broken.example.");
    const text = renderZone(
      {
        name: "broken.example",
        admin_email: "dns@broken.example);",
        nameservers: ["ns1.apps.example.com"],
        serial: 3,
      },
      [],
    );
    expect(text).toContain(
      "@ IN SOA ns1.apps.example.com. hostmaster.broken.example. ( 3 3600 600 604800 300 )",
    );
  });

  test("records render in the standard form", () => {
    const text = renderZone(
      {
        name: "example.com",
        admin_email: "hostmaster@example.com",
        nameservers: ["ns1.example.com", "ns2.example.com"],
        serial: 7,
      },
      [
        { name: "@", type: "NS", value: "ns1.example.com", ttl: 3600, priority: null },
        { name: "web", type: "A", value: "203.0.113.10", ttl: 300, priority: null },
        { name: "@", type: "MX", value: "mail.example.com", ttl: 300, priority: 10 },
        { name: "@", type: "TXT", value: 'v=spf1 "quoted" -all', ttl: 300, priority: null },
        { name: "@", type: "CAA", value: '0 issue "letsencrypt.org"', ttl: 300, priority: null },
      ],
    );
    expect(text).toContain("$ORIGIN example.com.");
    expect(text).toContain(
      "@ IN SOA ns1.example.com. hostmaster.example.com. ( 7 3600 600 604800 300 )",
    );
    expect(text).toContain("@ 3600 IN NS ns1.example.com.");
    expect(text).toContain("web 300 IN A 203.0.113.10");
    expect(text).toContain("@ 300 IN MX 10 mail.example.com.");
    expect(text).toContain('@ 300 IN TXT "v=spf1 \\"quoted\\" -all"');
    expect(text).toContain('@ 300 IN CAA 0 issue "letsencrypt.org"');
  });

  test('G3-11: "www CNAME @", "MX mail" with no priority and an unquoted CAA serve what 0.1.x served', () => {
    const text = renderZone(
      {
        name: "example.com",
        admin_email: "hostmaster@example.com",
        nameservers: ["ns1.example.com", "ns2.example.com"],
        serial: 8,
      },
      [
        { name: "www", type: "CNAME", value: "@", ttl: 300, priority: null },
        { name: "@", type: "MX", value: "mail", ttl: 300, priority: null },
        { name: "blog", type: "CNAME", value: "www", ttl: 300, priority: null },
        { name: "@", type: "CAA", value: "0 issue letsencrypt.org", ttl: 300, priority: null },
      ],
    );
    expect(text).toContain("www 300 IN CNAME example.com.");
    expect(text).toContain("@ 300 IN MX 10 mail.example.com.");
    // Never a top-level name like "www.".
    expect(text).toContain("blog 300 IN CNAME www.example.com.");
    expect(text).not.toMatch(/IN CNAME www\.$/m);
    expect(text).toContain('@ 300 IN CAA 0 issue "letsencrypt.org"');
  });

  test("one server block per zone, reloaded within seconds", () => {
    const corefile = renderCorefile(["a.example.com", "b.example.org"]);
    expect(corefile).toContain("a.example.com:1053 {");
    expect(corefile).toContain("file /etc/nearzero/dns/zones/b.example.org.zone {");
    expect(corefile).toContain("reload 2s");
  });
});
