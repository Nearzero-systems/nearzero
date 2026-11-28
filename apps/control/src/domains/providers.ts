/**
 * Which DNS provider serves a domain, from its nameservers, and how to add a record there
 * (spec 9.5). Providers with their own steps: Cloudflare, Route 53, GoDaddy, Namecheap,
 * DigitalOcean, Google Cloud DNS, Vercel, Porkbun and Azure. Other recognized providers get
 * general steps that name them.
 */

export interface DnsProvider {
  id: string;
  name: string;
  /** Nameserver hostnames end with one of these, or match the pattern. */
  match: RegExp;
  /** Steps of its own, or null for the general steps. */
  steps: ((record: RecordToAdd) => string[]) | null;
}

export interface RecordToAdd {
  /** Relative to the zone, like *.prod-1.apps. */
  name: string;
  /** The full name, like *.prod-1.apps.example.com. */
  fullName: string;
  zone: string;
  type: "A";
  value: string;
}

const PROVIDERS: DnsProvider[] = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    match: /\.ns\.cloudflare\.com$/,
    steps: (r) => [
      `In Cloudflare, open ${r.zone} and go to DNS → Records.`,
      `Add record: Type A, Name ${r.name}, IPv4 address ${r.value}.`,
      "Turn Proxy status off (grey cloud, DNS only): Cloudflare's certificates don't cover names this deep, and Let's Encrypt must reach this server.",
      "Save.",
    ],
  },
  {
    id: "route53",
    name: "Amazon Route 53",
    match: /^ns-\d+\.awsdns-\d+\.(com|net|org|co\.uk)$/,
    steps: (r) => [
      `In the Route 53 console, open Hosted zones → ${r.zone}.`,
      `Create record: Record name ${r.name}, Record type A, Value ${r.value}, TTL 300.`,
      "Leave Alias off, then Create records.",
    ],
  },
  {
    id: "godaddy",
    name: "GoDaddy",
    match: /\.domaincontrol\.com$/,
    steps: (r) => [
      `In GoDaddy, open My Products → ${r.zone} → DNS.`,
      `Add New Record: Type A, Name ${r.name}, Value ${r.value}, TTL 600 seconds or less.`,
      "Save.",
    ],
  },
  {
    id: "namecheap",
    name: "Namecheap",
    match: /\.registrar-servers\.com$/,
    steps: (r) => [
      `In Namecheap, open Domain List → ${r.zone} → Manage → Advanced DNS.`,
      `Add New Record: A Record, Host ${r.name}, Value ${r.value}, TTL Automatic.`,
      "Save it with the check mark.",
    ],
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    match: /^ns\d\.digitalocean\.com$/,
    steps: (r) => [
      `In DigitalOcean, open Networking → Domains → ${r.zone}.`,
      `Create a new A record: Hostname ${r.name}, Will direct to ${r.value}, TTL 300.`,
      "Create Record.",
    ],
  },
  {
    id: "google",
    name: "Google Cloud DNS",
    match: /^ns-cloud-[a-z]\d\.googledomains\.com$/,
    steps: (r) => [
      `In Google Cloud, open Network services → Cloud DNS → the zone for ${r.zone}.`,
      `Add standard: DNS name ${r.fullName}, Resource record type A, IPv4 address ${r.value}, TTL 300.`,
      "Create.",
    ],
  },
  {
    id: "vercel",
    name: "Vercel",
    match: /\.vercel-dns\.com$/,
    steps: (r) => [
      `In Vercel, open Domains → ${r.zone}.`,
      `Add a DNS record: Name ${r.name}, Type A, Value ${r.value}, TTL 300.`,
      "Add.",
    ],
  },
  {
    id: "porkbun",
    name: "Porkbun",
    match: /\.ns\.porkbun\.com$|\.porkbun\.com$/,
    steps: (r) => [
      `In Porkbun, open Domain Management → ${r.zone} → DNS.`,
      `Add a record: Type A, Host ${r.name}, Answer ${r.value}, TTL 600 or less.`,
      "Add.",
    ],
  },
  {
    id: "azure",
    name: "Azure DNS",
    match: /\.azure-dns\.(com|net|org|info)$/,
    steps: (r) => [
      `In the Azure portal, open DNS zones → ${r.zone}.`,
      `Add a record set: Name ${r.name}, Type A, IP address ${r.value}, TTL 300 seconds.`,
      "OK.",
    ],
  },
  {
    id: "hetzner",
    name: "Hetzner",
    match: /\.ns\.hetzner\.(com|de)$|\.hetzner\.(com|de)$/,
    steps: null,
  },
  { id: "ovh", name: "OVHcloud", match: /\.ovh\.(net|ca)$|\.anycast\.me$/, steps: null },
  { id: "gandi", name: "Gandi", match: /\.gandi\.net$/, steps: null },
  { id: "linode", name: "Linode (Akamai)", match: /\.linode\.com$/, steps: null },
  { id: "vultr", name: "Vultr", match: /\.vultr\.com$/, steps: null },
  { id: "ionos", name: "IONOS", match: /\.ui-dns\.(com|de|org|biz)$/, steps: null },
  { id: "namesilo", name: "NameSilo", match: /\.dnsowl\.com$/, steps: null },
  { id: "dnsimple", name: "DNSimple", match: /\.dnsimple(-edge)?\.(com|net|org)$/, steps: null },
  { id: "ns1", name: "NS1", match: /\.nsone\.net$/, steps: null },
  {
    id: "hostinger",
    name: "Hostinger",
    match: /\.dns-parking\.com$|\.hostinger\.com$/,
    steps: null,
  },
];

/** The provider whose nameservers these are, or null. */
export function detectProvider(nameservers: readonly string[]): DnsProvider | null {
  const names = nameservers.map((ns) => ns.toLowerCase().replace(/\.$/, ""));
  if (names.length === 0) return null;
  for (const provider of PROVIDERS) {
    if (names.some((ns) => provider.match.test(ns))) return provider;
  }
  return null;
}

/** Steps for adding the record at a provider (or anywhere, when it isn't known). */
export function providerSteps(provider: DnsProvider | null, record: RecordToAdd): string[] {
  if (provider?.steps) return provider.steps(record);
  const where = provider ? `In ${provider.name}` : "At your DNS provider";
  return [
    `${where}, open the DNS records of ${record.zone}.`,
    `Add a record: Type A, Name ${record.name}, Value ${record.value}, TTL 300 or Auto.`,
    "If the provider can proxy traffic, keep it off for this record (DNS only).",
    "Save.",
  ];
}

/** "Add one DNS record in <provider>" or "at your DNS provider" (spec 9.5). */
export function recordTitle(provider: DnsProvider | null): string {
  return provider
    ? `Add one DNS record in ${provider.name}`
    : "Add one DNS record at your DNS provider";
}
