# Domains, hostnames, certificates and managed DNS API (M4)

Endpoints for the Domains page, a service's Add domain dialog and Domains section, the server DNS card and About Nearzero's address. Implements spec 10 (all), 09 9.5, 06 6.7, 07 7.2, 18.2, 03 3.1 (platform domain, managed zone, install settings), 22.3, 23.9 and 24 (G7, P7).

Conventions (errors, JSON bodies, the session cookie, `Cache-Control: no-store`) are those of [`identity.md`](identity.md). Request schemas and the rules behind them (hostname checks, record checks, the HTTPS state machine, Retry refusals) are in `packages/shared/src/domains.ts`; the runner commands in `packages/shared/src/runner-domains.ts`.

Wherever a server id is taken, `host` means the Nearzero host.

## Install settings

The control plane reads `NEARZERO_PLATFORM_DOMAIN` (a leading `*.` is dropped), `NEARZERO_MANAGEMENT_HOSTNAME`, `NEARZERO_MANAGED_DNS_ZONE`, `NEARZERO_MANAGED_DNS_SOA_EMAIL` (else `NEARZERO_ADMIN_EMAIL`, else `NEARZERO_ACME_EMAIL`), `NEARZERO_ACME_EMAIL`, `NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE`, `NEARZERO_PUBLIC_IP`, and `NEARZERO_DNS_RESOLVERS` (comma-separated `ip` or `ip:port`, default `1.1.1.1,8.8.8.8`: the public resolvers DNS checks ask, spec 23.9). A zone named at install is connected for the first workspace at start (nameservers `ns1`/`ns2` under the zone, as the installer prints).

## Shapes

```ts
type HttpsState = "valid" | "expires_soon" | "expired" | "uploaded" | "not_trusted" | "not_in_use"
  | "waiting_for_dns" | "queued" | "issuing" | "rate_limited" | "paused" | "failed" | "unknown";
// Labels: Valid, Expires soon, Expired, Uploaded, Not trusted, Not in use, Waiting for DNS, Queued,
// Issuing, Rate limited, Paused, Failed, Unknown (HTTPS_STATE_LABELS).

interface Hostname {
  id: string;
  hostname: string;                    // lowercase, punycode for IDNs
  url: string;                         // https://<hostname><path>
  source: "platform" | "server" | "zone" | "own";
  sourceLabel: string;                 // "Platform domain" | "Nearzero DNS · <zone>" | "Your DNS provider"
  zone: { id; name } | null;
  automatic: boolean;                  // given by Nearzero: can't be moved to another service
  service: { id; name; kind; projectId; projectName; environmentId; environmentName;
             composeService: string | null; port: number | null; path: string } | null;   // null: "Not connected"
  target: { id; name; host: boolean; address: string | null };   // the server its DNS should point at
  dns: {
    status: "points_here" | "points_elsewhere" | "proxied" | "ipv6_only" | "no_record" | "lookup_failed"
          | "waiting" | "check_records" | "unknown";
    label: string;                     // Points here, Points elsewhere, Proxied, IPv6 only, No record, Lookup failed,
                                       // Waiting for DNS (automatic, no record yet), Check records (managed zone), Unknown
    note: string;                      // the check's plain words
    addresses: string[]; proxiedBy: string | null; checkedAt: string | null; managed: boolean;
    warnings: string[];                // Points here, but other A records or an AAAA record could send
                                       // Let's Encrypt elsewhere (R3-17)
    aliasOf: string | null;            // the CNAME's target, shown as "Alias of"
    record: { type: "A"; name: string; value: string | null; ttl: "Auto or 300"; proxy: "DNS only" } | null;
  };
  https: { state; label; note; until: number | null;
           lastError: string | null;     // the router's error as plain advice with the fix (R3-18)
           retryRefusal: string | null;   // why Retry would be refused now ("Retry: <reason>")
           certificate: { notAfter; issuer } | null };
  needsAttention: boolean;             // Show → Needs attention: an HTTPS error or warning, or connected and pointing elsewhere (G3-12)
  waiting: boolean;                    // Show → Waiting for DNS: connected, certificate waiting for DNS or queued (G3-12)
  can: { manage: boolean; move: boolean; retry: boolean };
  createdAt: string;
}
```

## The Domains page (spec 10.3, 10.4)

Needs domain or certificate rights: owners and admins, people with "Manage certificates" or "Manage DNS zones", and members with rights on a service (their own services). Others get 403: `You can't see Domains: …`.

| Endpoint | Response |
| --- | --- |
| `GET /domains` | `{ title, description, platformDomain, noDomain, noDomainCard, startFrom: string[] (≤ 6 parent domains for "Start from:"), tabs: { id, label, count, shown }[] (hostnames always; dns-zones and environment-defaults once a zone exists; uploaded-certificates once one exists: hidden tabs stay reachable), more: [{ id: "connect-zone", label: "Connect a DNS zone", hint }, { id: "upload-certificate", … }], can: { connectZone, uploadCertificate } }` |
| `GET /domains/hostnames?q=&show=all\|attention\|waiting\|unconnected&refresh=1` | `{ hostnames: Hostname[], checkedAt, unreadableServers, unreadableMessage ("Couldn't read certificates on N servers."), withoutDomain: { count, message ("N services have no domain"), services: (≤ 50) { id, name, kind, projectName, environmentName, serverId, canAdd }[] } }`. `q` searches hostname, service, project, environment, Compose service, server and DNS source. `refresh=1` (the Refresh button) looks every hostname up again and reads the servers' certificates first. |
| `GET /domains/hostnames/:id` | `{ hostname }` (Details: Service, DNS and HTTPS sections) |
| `GET /domains/automatic?fresh=1` | `{ card }` or `{ card: null }` without a platform domain. `card: { domain, description, rows, aboutHttps }`; each row `{ target, record: { type, name, value }, badge: points_here\|points_elsewhere\|not_set_up\|couldnt_check, badgeLabel, without, subtitle, action: check_again\|give_one\|give_n, actionLabel ("Check again" / "Give it a hostname" / "Give N a hostname"), help ("Add this record once at your DNS provider, as DNS only (not proxied)…" when not ready), message, checkedAt }`. The Nearzero host's row only for people who may use the host; one row per server the person can see. The status comes from looking up a random name under the wildcard. |
| `POST /domains/targets/:id/check` | `{ row, message }`: "Check again" for one row (a fresh lookup): `<record> doesn't point at this server yet. DNS changes can take a few minutes.` |
| `POST /domains/targets/:id/give-hostnames` | `{ given: string[], problems: string[], message }`: "N services got their hostnames. It can take a minute for HTTPS to be ready.", or, while the server's record doesn't point here yet, "N services got their hostnames. They load once <record> points at this server." The server's running apps and Compose services without a hostname, that the person may add hostnames to. Offered whether or not the record exists (R3-21). |

## Hostnames: add, connect, move, disconnect, remove (spec 10.4–10.6)

Needs domain rights on the service (`service.hostnames`: members have them for their services). A hostname that isn't connected can be managed by owners and admins and by people who can reach the server it points at (the host: people who may use it).

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /domains/hostnames/preview` | `{ hostname, serviceId?, serverId? }` | The Add domain dialog's checks, every 8 seconds: `{ valid, hostname, message, source, zone, managedChoice ({ managed: "Nearzero creates it in <zone>", external: "I'll create it at my DNS provider" } inside a managed zone), target, record: { type: "A", name (relative to the DNS zone), fullName, zone, value, ttl: "Auto or 300", proxy: "DNS only" }, hint, proxyWarning, dns (the check, in the same shape as a Hostname's `dns`; `managed` stays false because the managed choice is still open), canAdd, addressHelp ("Server address unknown…" with the About Nearzero link) }`. `canAdd` is true once DNS points at the server, or inside a managed zone (then `message` is "DNS doesn't point to this server yet. Nearzero keeps checking."). |
| `GET /environments/:id/hostname-preview?serverId=&name=` | | The new-application page's Domain preview (spec 6.1), before the app exists; needs Create services in the environment and use of the server. `{ hostname (an example random label under the platform domain or `<server label>.<platform domain>`, or the name in the environment's default zone; null when none), source: "platform" \| "server" \| "zone" \| "none", message ("The first deploy gives it a hostname like …" or why none), record ({ type: "A", name, value, proxy } the server's wildcard record, platform only), zoneOption ({ zoneId, zoneName, hostname } when a workspace zone exists that the automatic hostname doesn't come from: "Also assign a hostname from the workspace's DNS zone") }`. No DNS lookups. |
| `POST /domains/hostnames` | `{ hostname, connect?: { serviceId, port?, path?: "/", composeService? }, serverId?, dns?: "managed" \| "external" }` | 201 `{ hostname, message }`: "Added <host>. HTTPS starts working in a minute." or, without a service, "Added <host>. Connect a service to it from the Hostnames list…" |
| `POST /domains/hostnames/:id/connect` | `{ serviceId, port?, path?, composeService? }` | `{ hostname, message: "Service connected" }`. Connects, or moves to another service. Automatic hostnames can't be moved (409). |
| `POST /domains/hostnames/:id/disconnect` | | `{ hostname, message: "Disconnected <host> from <service>. It stops serving traffic until you connect a service again." }` |
| `DELETE /domains/hostnames/:id` | | `{ removed: true, message: "Removed <host>." }`: the route, the certificate and any managed DNS record go. Removing an automatic hostname keeps deploys from giving the service another until someone asks (Generate a domain, Give N a hostname). |
| `POST /domains/hostnames/:id/check-dns` | | `{ hostname, message }`: looks the name up now and has the router release the hold if DNS is right. |
| `POST /domains/hostnames/:id/retry` | | `{ hostname, message }`, or 409 `Retry: <reason>` (below). |

**Validation** (spec 10.5, in `checkHostnameInput`): "Enter a hostname, like app.example.com." / "Leave out http:// or https://." / "Enter just the hostname, without a path or port." / "Wildcards can't be added here…" / "Use a full hostname…" / "That isn't a valid hostname." / "Use a hostname, like app.example.com, not an IP address." A label that looks like a number or hex (all digits, or `0x…`): `"<label>" looks like a number, which browsers read as an address…`. Reserved (409): the console's own hostname, the platform domain itself, `<server label>.<platform domain>`, and every managed zone's nameservers: `<host> is reserved for Nearzero itself. Pick another hostname.` Duplicate (409, across the install, as routes are): `<host> is already added. Find it in the Hostnames list.` No service and no server: `Pick a service, or untick "Connect it to a service now".` Databases take no hostnames; Compose needs one of the file's services and a port when the file doesn't say it.

**DNS first.** A hostname from your own DNS provider (or typed under the platform domain) is added only when it points at the service's server (409 with the check's words: `<host> points at X, not Y…`, `<host> doesn't resolve yet…`, `Turn off the DNS proxy for <host>…`, `<host> only has an IPv6 (AAAA) record…`, `Couldn't look up <host> just now…`). Lookups give up after 10 seconds. Inside a managed zone, Nearzero creates an A record for it (choose `dns: "external"` to create it elsewhere; then the DNS rule applies).

**All or nothing (P7).** Connecting writes the hostname's route on the service's server first; if the server's runner isn't connected or refuses the route, nothing is saved and the reason is shown (503 or 409). Moving puts the old route back if the new one can't be written. Disconnecting or removing on a server whose runner is away drops the saved route, and the router loses the file when the runner reconnects (it then gets exactly the saved routes).

## A service's hostnames (spec 10.6, 06 6.7, 07 7.2)

| Endpoint | Response |
| --- | --- |
| `GET /services/:id/hostnames` | `{ hostnames: Hostname[], composeServices: { name, port }[], servicePort, canAdd }` |
| `GET /services/:id/hostnames/suggestion` | Generate a domain's preview: `{ available: true, hostname, base: "platform" \| "zone", message: "It will be live at https://…", record (when the server's record is missing: { type, name, value, proxy, status, message: "It loads once <server> has this DNS record." }), composeServices, servicePort }` or `{ available: false, message: "No domain to generate hostnames under yet — Add a DNS zone under Domains, or use your own domain.", openDomains: true }` |
| `POST /services/:id/hostnames/generate` | `{ port?, path?, composeService? }` → 201 `{ hostname, message: "Added <host>. HTTPS starts working in a minute.", missingRecord: { record, status, message: "It loads once <server> has this DNS record: …" } \| null }` |

"Use my own domain" is `POST /domains/hostnames` with `connect`.

## Hostnames at deploy (spec 10.2)

The domains area registers the `domains` hostname provider on `services.hostnameProviders` (`apps/control/src/deploys/hostnames.ts`). For each deploy of an app or Compose service it:

1. gives a service with no hostname an automatic one, unless a person removed its automatic hostname: under the environment's default (below) — `<random label>.<platform domain>` on the host, `<random label>.<server label>.<platform domain>` on other servers (labels are 8 random characters starting with a letter, never the service name), or `<name>[.<prefix>].<zone>` in a managed zone (with its A record). It is assigned and routed before its DNS record exists;
2. replaces automatic hostnames whose environment default changed while their server couldn't be reached;
3. answers every connected hostname as `{ host, path, port, composeService?, https: true }` (there is no per-domain HTTPS switch in 1.0), and log lines: `<host> is assigned, but it won't load until this DNS record exists: *.<label>.<platform domain> A <ip> (DNS only, not proxied). HTTPS starts on its own once it does.`, the DNS check's words for your own domains, or "This service has no domain…" with how to get one.

Routes for hostnames use the deploy pipeline's key (`routeKey(serviceId, host, path)`), so a route written when a hostname is added (to the service's active container, else its app name, or `<app name>-<compose service>`) is the same route the next deploy rewrites. A service's hostnames go when it is deleted (the rows cascade, its teardown removes its routes, and a background sweep removes any route of a service that no longer exists); managed records go with them.

## The server's DNS card (spec 9.5)

`GET /servers/:id/dns-card?fresh=1` (server access) → `{ card }`. For the host, or without a platform domain, `{ shown: false }`. Otherwise `{ shown: true, title ("Add one DNS record in <provider>" / "… at your DNS provider"), subtitle: "Add it now, while setup runs.", record: { type: "A", name (relative to the zone, like *.prod-1.apps), value, proxy: "DNS only" }, zoneLine: "In the domain <zone>. The full name is …", provider: { id, name } | null, steps: string[], badge: points_here | points_elsewhere | not_added | couldnt_check, badgeLabel (Points here / Points elsewhere / Not added yet / Couldn't check), ready, readyText ("App addresses are ready"), checkHint: "DNS changes usually show up within a few minutes.", message }`.

The provider comes from the zone's nameservers: Cloudflare (steps turn the proxy off), Route 53, GoDaddy, Namecheap, DigitalOcean, Google Cloud DNS, Vercel, Porkbun and Azure get their own steps; Hetzner, OVHcloud, Gandi, Linode, Vultr, IONOS, NameSilo, DNSimple, NS1 and Hostinger get general steps naming them.

## Certificates (spec 10.7)

The router on each server keeps one Let's Encrypt certificate per hostname (HTTP validation on port 80) and renews it 30 days before it expires. The runner holds a hostname on the router's placeholder certificate — plain HTTP served, no redirect, Let's Encrypt never asked — while its DNS doesn't point at the server (checked a minute after the runner starts, every 5 minutes, and on Check DNS, Retry, adding a hostname and Give N a hostname), after 3 failed validations in an hour (until an hour after the first), and during a rate limit (until its retry-after time, or an hour). Failed attempts are read from the router's JSON log as they happen, so the pause starts at once. The control plane also checks every hostname a minute after start and every 5 minutes, and tells routers to release holds whose DNS is now right.

States and notes are the spec's (`httpsStatus`). **Retry** is refused, with `Retry: <reason>` (409), when no service is connected; an uploaded certificate covers it; the certificate is valid; DNS is still wrong; it is rate-limited; 4 or more failures happened in the last hour ("Let's Encrypt allows 5 failed checks per hour. Try again after …"); or the last attempt was under a minute ago.

### Uploaded certificates

Needs "Manage certificates" (certificates for the host: instance administrators).

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /domains/certificates` | | `{ certificates: { id, name, covers: string[], server: { id, name }, issuer, expiresAt, expired, expiresNote ("Expires in N days" within 30 days, "Expired"), createdAt, updatedAt }[] }` |
| `POST /domains/certificates` | `{ name, certificate (PEM, chain allowed), privateKey (PEM), serverId }` | 201 `{ certificate }` |
| `PATCH /domains/certificates/:id` | `{ name?, certificate?, privateKey? }` (blank: keep the stored private key) | `{ certificate }` |
| `DELETE /domains/certificates/:id` | | `{ deleted: true, message: "The router stops using it. Hostnames it covered get Let's Encrypt certificates again." }` |

The server is fixed after upload. The key must be unencrypted PEM and belong to the certificate; it is sealed with the install key and sent only to that server's router. Saving waits for the router to take it (P7). The router serves an uploaded certificate for every name it covers (exact names and one-label wildcards) and redirects HTTP to HTTPS for them.

## Managed DNS zones (spec 10.8)

Needs "Manage DNS zones". Zones are published to the built-in DNS server on the host (CoreDNS with file zones, TCP and UDP 53), which the host's runner starts when the first zone is applied and stops when the last is removed.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /domains/zones` | | `{ zones: Zone[], banner (zones in error), canApplyAll (2 or more) }` |
| `POST /domains/zones` | `{ domain, adminEmail, nameservers? }` | 201 `{ zone, moved, pending, message }`; the workspace's first zone becomes the default of every environment without a saved choice, and their automatic hostnames move into it at once (`moved`), or at the next deploy when their server can't be reached (`pending`); `message` says how many (R3-13); default nameservers `ns1`/`ns2` under the platform domain, or the zone. Refused: "This DNS zone is already managed by another workspace" (409); a zone inside, or containing, a zone another workspace manages (409); a zone that covers, or sits inside, the console's address or the platform domain unless the caller is an instance administrator (403). The first zone becomes every environment's default. |
| `GET /domains/zones/:id` | | `{ zone, records: { id, name, type, value, ttl, priority, managed, managedNote ("Managed by Nearzero"), hostnameId }[] }` |
| `PATCH /domains/zones/:id` | `{ adminEmail?, nameservers? }` | `{ zone }` |
| `POST /domains/zones/:id/apply`, `POST /domains/zones/apply-all` | | `{ zones, message }` |
| `DELETE /domains/zones/:id` | | `{ removed: true }`; refused while services use hostnames in it: `Services still use hostnames in <zone>: <host> (<service>), …` |
| `POST /domains/zones/:id/records` | `{ name, type, value, ttl?: 300, priority? }` | 201 `{ record }` |
| `PATCH`/`DELETE /domains/zones/:id/records/:recordId` | | `{ record }` / `{ deleted: true }`; records Nearzero manages answer 403. |

`Zone`: `{ id, name, adminEmail, nameservers, status: live | delegation_pending | not_applied | needs_attention, statusLabel (Live / Delegation pending / Not applied yet / Needs attention), records, health ("Serving N records" / "Published. <reasons>." / "Not checked yet" / "Nearzero DNS isn't running yet…" / "Couldn't reach the DNS server."), error, appliedAt, delegation (the registrar instructions, with glue A records for in-zone nameservers), readiness: { ready, reasons, note } }`. **Live** needs the zone applied and served, public NS records equal to its nameservers (`resolveNs` through the public resolvers) and an SOA answer from the host's public IPv4 on port 53; the health check (a minute after start, then every 5 minutes, and after Apply) records both (G3-10).

Record rules: A is IPv4, AAAA IPv6; TXT at most 255 bytes per string; CAA as `flags tag value`, with or without quotes (saved quoted); MX with a priority (blank is 10); CNAME, MX and NS values that are "@" (the zone), one word (a name inside the zone) or a full name (G3-11); the name inside the zone ("@" is the apex); "CNAME cannot coexist with other records"; TTL 1 to 2147483647 seconds (a blank TTL is 300). Record changes wait for Apply ("Not applied yet"); records Nearzero manages (the zone's nameservers and hostnames' records) are published at once, together with the zone's other pending changes.

## Environment defaults (spec 10.8)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /domains/defaults` | | `{ defaults: { projectId, projectName, environmentId, environmentName, source ("platform" \| "none" \| zone id), sourceLabel, prefix, saved }[], options: { value, label }[] ("Platform domain", "No zone (apps get no automatic hostname)", zones), prefixHint }` |
| `PUT /domains/defaults/:environmentId` | `{ source, prefix? }` | the same, plus `message`: "Saved and N automatic hostnames updated", or "Saved. N automatic hostnames update on the next deploy." (servers that couldn't be reached), or "Saved. Existing automatic hostnames stay until you remove them." (No zone) |

Without a saved choice, an environment uses the workspace's first zone, else the platform domain.

## About Nearzero: the console's address (spec 18.2, 10.9)

| Endpoint | Needs | Request | Response |
| --- | --- | --- | --- |
| `GET /about/address` | anyone | | `{ consoleUrl, serverIp: { address, corrected, detected, canCorrect }, platformDomain, checklist: { consoleAddress: { state: ready \| dns \| https_pending \| needs_setup, label (Ready / DNS / HTTPS pending / Needs setup), message, link }, managedZone }, publicDomain: { hostname, email, canConfigure, record, note: "Ports 80 and 443 must be open on this server for HTTPS.", changeNote } }` |
| `PUT /about/server-ip` | instance administrator | `{ ip }` | the same with `message`; a publicly routable IPv4 only. Managed records that pointed at the old address follow it; the host's runner reconnects to learn it. |
| `PUT /about/public-domain` | instance administrator | `{ hostname, email }` | "Save and request HTTPS": the same with `message` naming the record to add. Writes the console's routes on the host (the console, and `/api/v1/runner/` straight to the API); HTTPS follows once DNS points here. Changing an existing console hostname is refused with the migration steps. |

## Runner commands

`certificates.status` (the router's certificates — names and dates only — attempts, holds and back-off), `certificates.retry { hostname }` (holds it for 3 seconds, then releases it, so the router asks again), `certificates.contact { email }` (the contact email for new certificates: the one saved under About Nearzero, sent to every connected runner when it is saved and to each runner when it connects; the runner keeps it in `<state dir>/certificate-contact.json`, uses it over `NEARZERO_ACME_EMAIL` from its next start, and recreates the router when it changed), `certificates.uploads { certificates }` (exactly this set, written into the router folder; keys 0600), `dns.apply { corefile, zones }` (writes the DNS folder and keeps `nearzero1-dns` running, creating it when the install didn't; with no zones it stops it), `dns.status { zones }` (whether it runs, and the SOA serial each zone answers). See [`docs/runner-protocol.md`](../runner-protocol.md). Runner settings: `NEARZERO_DNS_DIR`, `NEARZERO_DNS_HOST_DIR`, `NEARZERO_DNS_IMAGE`, `NEARZERO_DNS_BIND_ADDRESS`, `NEARZERO_DNS_PORT`, `NEARZERO_DNS_NETWORK`, and for a private ACME server (tests) `NEARZERO_ACME_CA_SERVER` and `NEARZERO_ACME_CA_CERTIFICATES`.

## Audit events

`hostname.added`, `hostname.connected`, `hostname.moved`, `hostname.disconnected`, `hostname.removed`, `certificate.uploaded`, `certificate.updated`, `certificate.deleted`, `dns-zone.connected`, `dns-zone.updated`, `dns-zone.applied`, `dns-zone.removed`, `dns-record.added`, `dns-record.updated`, `dns-record.deleted`, `environment-default.changed`, `console.server-ip-corrected`, `console.public-domain-configured`.

## Code map

`apps/control/src/domains/`: `settings.ts` (install settings, DNS lookups), `tables.ts` (table types), `addresses.ts` (host IP, targets, route keys), `dns-check.ts`, `providers.ts`, `hostnames.ts`, `hostname-provider.ts` (deploys), `cards.ts`, `certificates.ts`, `uploads.ts`, `zones.ts`, `defaults.ts`, `about.ts`, `background.ts`, `routes.ts`. Runner: `runner/src/domains/` (ACME store and log, back-off, uploads, the DNS server, command handlers). Migration 0250.
