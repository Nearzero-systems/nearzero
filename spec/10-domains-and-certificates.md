# 10. Domains, hostnames, managed DNS and certificates

Every app and Compose service can have hostnames. HTTPS certificates are free (Let's Encrypt), issued once DNS points at the right server, and renewed automatically.

## 10.1 Where hostnames come from

| Source | How it works | Who sets it up |
| --- | --- | --- |
| **Platform domain** | The installer's domain (for example `apps.example.com`). Apps on the Nearzero host get `<random label>.apps.example.com` through one wildcard record the person creates at their DNS provider. Nearzero creates no records. | Installer, or install settings |
| **Per-server hostnames** | Apps on another server get `<random label>.<server label>.<platform domain>` through one wildcard record per server (10.2). | Automatic once the platform domain exists |
| **Managed DNS zone** | A zone whose nameservers point at Nearzero's built-in DNS server. Nearzero creates the records itself; an app named `web` can get `web.<zone>` (or `web.<prefix>.<zone>`). The first zone connected becomes every environment's default and takes priority over the platform domain. | Domains → Connect a DNS zone |
| **Your own domain** | Any hostname the person points at the service's server with an A record. | Add domain |

Rules:
- No IP-based wildcard services (no hostnames built from the server's IP). With no domain at all, apps run without a public address and the console says how to get one.
- Generated labels are short random strings (for example `a3f9c2b1`), never the service name, under the platform domain.
- A hostname whose last label is all digits or `0x…` hex is refused (browsers read it as an IP address); digits elsewhere are fine (`123.example.com` is valid). Labels Nearzero derives from names get `server-` (server labels) or `app-` (service names in managed zones) in front when they start with a digit.
- Removing a hostname stops it serving at once; its issued certificate stays in the router's store until it expires and is never used again.
- The certificate contact email set under About Nearzero is the one the router uses for new certificates.

## 10.2 Per-server hostnames

- Each server gets a **label** from its name when it is added (a slug of at most 40 characters, `server-` before a leading digit, `-2`, `-3` on clashes). The label never changes, even when the server is renamed, so hostnames stay stable.
- The person adds one record per server: `*.<label>.<platform domain>  A  <server IPv4>`, as **DNS only** (not proxied: proxy certificates don't cover names that deep).
- Hostnames are assigned and routed **at deploy, before the record exists**. Certificates wait for DNS (10.7), so nothing is requested from Let's Encrypt early.
- Until the record exists, Nearzero names the exact record in four places: the deploy log ("… is assigned, but it won't load until this DNS record exists …"), the Agent's reply (as a table), the server's DNS card ([09](09-servers-and-ssh-keys.md) 9.5) and the Domains page.
- **Give N a hostname**: assigns hostnames to the server's running apps and Compose services that have none (only services the person can reach).

## 10.3 Domains page

Sidebar → Infrastructure → **Domains** (people with domain or certificate rights). Header: "Domains", "Where your apps can be reached, and whether DNS and HTTPS are ready. Certificates are free and renew on their own." Button **Add domain**; **More** menu: "Connect a DNS zone" ("Point a domain's nameservers to Nearzero") and "Upload certificate" ("Only for wildcards or your own CA").

**Automatic hostnames card** (when there is a platform domain): "Every app gets its own hostname with HTTPS, like a3f9c2b1.<domain>. One DNS record per server covers all of its apps."
- Row "Nearzero host": `*.<domain> A <ip>` with Copy name and Copy IP; status from looking up a random name under the wildcard.
- One row per other server the person can reach: the record with Copy buttons; badge Points here / Points elsewhere / Not set up / Couldn't check; subtitle "Apps get a hostname under …" or "N services without a hostname"; button "Check again", or "Give it a hostname" / "Give N a hostname"; when not ready: "Add this record once at your DNS provider, as DNS only (not proxied)…".
- Results: "N services got their hostnames. It can take a minute for HTTPS to be ready." / "<record> doesn't point at this server yet. DNS changes can take a few minutes."
- "About HTTPS" (collapsed): one Let's Encrypt certificate per hostname over HTTP validation on port 80, no wildcard certificates, at most 50 new certificates per week per registered domain.

**No domain at all**: a "No domain yet" card with "Add domain" and "Connect a DNS zone".

**Tabs** (each with a count): **Hostnames** (always); **DNS zones** and **Environment defaults** (once a zone exists); **Uploaded certificates** (once one exists, or via More). Hidden tabs stay reachable by address.

On phones, the More menu opens inside the screen and DNS records read as three lines.

## 10.4 Hostnames tab

- Search ("Search hostnames or services": host, service, project, environment, server, DNS source); "Show": All hostnames / Needs attention / Waiting for DNS / Not connected; "Checked at HH:MM" with **Refresh**; "Couldn't read certificates on N servers." when some servers didn't answer.
- Columns:
  - **Hostname**: link, Copy, Visit; DNS source (Platform domain / Nearzero DNS · zone / Your DNS provider).
  - **Service**: service with project/environment · server, or "Not connected" with "Connect a service".
  - **DNS**: Points here, Check records, Waiting for DNS, No record, Points elsewhere, Proxied, IPv6 only, Lookup failed, Unknown, Shared edge, with a note. A connected hostname (or a generated one) with no record reads "Waiting for DNS"; only an unconnected one reads "No record" (31c G3-12). An added hostname behind a proxy has the note "Proxied by X. HTTPS works if X forwards plain HTTP for /.well-known/acme-challenge/ to this server.", never advice to turn the proxy off (31c R3-11); that advice stays only for adding a proxied name, which must point at the server first (10.6).
- **Show** filters (31c G3-12): "Needs attention" holds rows whose HTTPS state is an error or a warning (Failed, Paused, Rate limited, Expired, Expires soon, Not trusted for a name that could get a public certificate), and connected rows whose DNS points elsewhere. A proxied, IPv6-only or once-unresolved name with a valid certificate isn't there. "Waiting for DNS" holds connected rows whose certificate is waiting for DNS or queued; an unconnected one with no record isn't there.
  - **HTTPS**: see 10.7.
- Row: **Details** (Service, DNS and HTTPS sections with fix-it record tables, warnings, "Last error" and "Retry: <reason>"), and a menu: Check DNS; Retry certificate; Open service; Connect a service / Move to another service (not for generated hostnames); Disconnect service ("…It stops serving traffic until you connect a service again."); Open site; **Remove hostname** (new in 1.0; today no hostname can be removed from the console): confirm, then the route, certificate and any managed DNS record go.
- Below: "N services have no domain", up to 50, each with "Add domain".

## 10.5 Add domain (from the Domains page)

Steps **Hostname → Service → DNS → HTTPS**.
1. **Hostname**: "Start from:" chips with up to 6 known parent domains. Errors: "Enter a hostname, like app.example.com." / "Leave out http:// or https://." / "Enter just the hostname, without a path or port." / "Wildcards can't be added here…" / "Use a full hostname…" / "That isn't a valid hostname." Reserved: the console's own address and the platform domain's assignment names. Duplicate: "<host> is already added. Find it in the Hostnames list."
2. **Service**: "Connect it to a service now" (ticked by default) with Project, Environment, Service (Compose inner services listed), Port (default: the service's port; 1 to 65535), Path (default "/"). Unticked: "Server it points to" (the Nearzero host or a server). Error: 'Pick a service, or untick "Connect it to a service now".'
3. **DNS**: inside a managed zone, a choice "Nearzero creates it in <zone>" / "I'll create it at my DNS provider". Otherwise the record table (A, Name, Value, TTL "Auto or 300", Copy) with a name hint and the proxy warning. Live status every 8 seconds plus "Check again": Waiting for DNS / Points somewhere else / Proxied by X / Only an IPv6 record / Server address unknown (with a link to fix it under About Nearzero) / Couldn't look up DNS. "Add domain" is enabled only once DNS points at the server, or in a managed zone ("DNS doesn't point to this server yet. Nearzero keeps checking.").
4. **HTTPS**: follows issuance every 8 seconds up to 20 times: "HTTPS is ready … Open https://host", or "Still working on it. You can close this…". With no service: "Added <host>. Connect a service to it from the Hostnames list…".

Every domain uses HTTPS with Let's Encrypt (with HTTP redirected to HTTPS) unless an uploaded certificate covers it. There is no per-domain HTTPS switch in 1.0.

**Connect a service** dialog: Project, Environment, Service, Port, Path; toast "Service connected".

## 10.6 Add domain (from a service)

The dialog opened by "No domain yet" cards, Create URL, a service's Domains section and Add New → Domain:
- Service picker, then **Generate a domain** or **Use my own domain**.
- Generate: "It will be live at https://…". If the server's record is missing: "It loads once <server> has this DNS record" with the record and "Check again". With nothing to generate under: "No domain to generate hostnames under yet — Add a DNS zone under Domains, or use your own domain." with "Open Domains".
- Own domain: shows the A record to add; the name must already resolve to the service's server: "<host> points at X, not Y…", "<host> doesn't resolve yet…", "Turn off the DNS proxy…", "Couldn't look up … just now". (Slow DNS lookups time out at 10 seconds rather than hanging.)
- "Port and path": the detected container port, the path, and for Compose a service picker.
- Button "Generate domain" or "Add domain"; toast "Added <host>. HTTPS starts working in a minute."
- Creating a hostname is all or nothing: if its route can't be written (for example the server can't be reached), nothing is saved and the reason is shown (P7 in [24-known-gaps.md](24-known-gaps.md)).
- Deleting a service removes its hostnames, for apps and Compose alike.

## 10.7 Certificates

**HTTPS states** (label → note):

| State | Note |
| --- | --- |
| Valid | "Valid until … Renews automatically." |
| Expires soon | Less than the smaller of 20 days and a quarter of its lifetime left |
| Expired | |
| Uploaded / Custom | Covered by an uploaded certificate |
| Not trusted | The router's default certificate is being served |
| Not in use | "Connect a service to get a certificate." |
| Waiting for DNS | "…asks Let's Encrypt once DNS points here" |
| Queued | "DNS points here now. Nearzero asks Let's Encrypt within 5 minutes, or press Check DNS to ask now." |
| Issuing | "usually under a minute" |
| Rate limited | "Retry after …" |
| Paused | "Failed N times in the last hour… Fix it, then press Retry." |
| Failed | with the error |
| Unknown | "Couldn't read certificates on this server." |

**Hold and back-off** (so Let's Encrypt limits are never hit by Nearzero's own retries):
- A hostname whose DNS doesn't point at its server is held: the router serves a placeholder certificate for it and never asks Let's Encrypt. While held, plain HTTP is served without a redirect (so the site works over HTTP); once a real certificate exists, HTTP redirects to HTTPS. Names that can never get a public certificate (local or reserved names) are always held.
- After 3 failed validations in an hour, requests pause until an hour after the first of them.
- A Let's Encrypt rate limit holds until its retry-after time (or 1 hour).
- A background check runs a minute after start and then every 5 minutes, releasing holds whose DNS is now right. Check DNS, Retry, adding a hostname and "Give N a hostname" also trigger it.
- **Which DNS decides a hold** (31c G3-09): the router looks names up through public resolvers (1.1.1.1 and 8.8.8.8, or the runner's `NEARZERO_DNS_RESOLVERS`), the way Let's Encrypt and the Hostnames list see them, and asks the server's own resolver only when public DNS can't be reached. A cloud's private zone, a company resolver or a stale negative cache on the server never holds a name that public DNS points here.
- **The server's address** (31c R3-10): the control plane gives each server's router its public IPv4 when the runner connects and again at every 5-minute check, so a server added by hostname follows its name to a new IPv4 without a reconnect. A lookup of the server's name that fails just then keeps the address the router had; with none known yet, nothing is held for the unknown address, so HTTPS redirects and renewals go on.
- **Retry** is refused, with the reason, when: no service is connected; an uploaded certificate covers it; the certificate is valid; DNS is still wrong; it is rate-limited; 4 or more failures happened in the last hour ("Let's Encrypt allows 5 failed checks per hour. Try again after …"); or the last attempt was under a minute ago.
- Certificates renew 30 days before expiry.

**Uploaded certificates** tab: Name, Covers, Server, Expires ("Expires in N days" within 30 days; red when expired), Edit and Delete. Upload: name, certificate (PEM), private key (PEM), server (fixed after upload). Edit: "Leave blank to keep the stored private key". Delete: "The router stops using it. Hostnames it covered get Let's Encrypt certificates again."

## 10.8 Managed DNS zones

**Connect a DNS zone**: Domain (required), DNS admin email (required; "Stored in the zone file. Not used for login."), Nameservers (optional; default ns1 and ns2 under the platform domain or the zone). The first zone becomes every environment's default. A zone another workspace manages is refused: "This DNS zone is already managed by another workspace". The person delegates the zone at their registrar and allows TCP and UDP 53 on the Nearzero host.

**DNS zones tab**: Zone (with nameservers), Status (Live / Delegation pending / Not applied yet / Needs attention), Records, Health ("Serving N records" / "Not checked yet" / "Nearzero DNS isn't running yet…" / "Couldn't reach the DNS server."). **Records**, **Apply** (publishes to the built-in DNS server), **Apply all zones** (2 or more zones), **Remove zone** (new in 1.0; refused while services still use hostnames in it, listing them). A banner lists zones in error.

**Records dialog**: name, type (A, AAAA, CNAME, TXT, MX, CAA, NS), value, TTL, priority (MX). Rules: A must be IPv4, AAAA IPv6; TXT at most 255 bytes per string; CAA as flags, tag and value, the value with or without quotes (`0 issue letsencrypt.org` saves as `0 issue "letsencrypt.org"`); the name inside the zone; "CNAME cannot coexist with other records". Records Nearzero manages show "Managed by Nearzero" and can't be deleted here.
- **How values are read** (31c G3-11): a CNAME, MX or NS value of "@" is the zone itself, and a value without a dot ("mail") is a name inside the zone (`mail.<zone>`), never a top-level name; anything else is a full name. A blank MX priority is 10. In `example.com`, "www CNAME @" serves `www.example.com CNAME example.com.` and "MX mail" with the priority blank serves `example.com MX 10 mail.example.com.`

**Ready** (31c G3-10): a zone reads **Live** only when it is applied, the built-in DNS server serves it, public resolvers return exactly its nameservers for it, and the host's public IPv4 answers SOA for it on port 53. Applied and served but not that: **Delegation pending**, with the reasons ("Public NS differs from Nearzero: …", "Public resolvers do not return NS records for this zone yet", "Authoritative SOA check failed: …") and "Published means CoreDNS has the zone file. Ready additionally requires public NS delegation and a direct authoritative SOA response." The same state shows on About Nearzero's checklist (18.2). The registrar instructions add, when the nameservers are inside the zone, glue (host) A records for them pointing at the host's IPv4. The check runs with the zone health check, a minute after start and every 5 minutes.

**Environment defaults tab**: Project, Environment, "App hostnames from", Name prefix, with **Change**: "App hostnames from" (Platform domain / "No zone (apps get no automatic hostname)" / a zone) and Name prefix (optional; 'With "staging", apps get web.staging.example.com'). Saving updates existing automatic hostnames: "Saved and N automatic hostnames updated", or "Saved. N … update on the next deploy."

## 10.9 The console's own address

About Nearzero ([18-settings.md](18-settings.md)) shows the console's public address and, for instance administrators, **Configure public domain**: hostname and certificate email, "Save and request HTTPS", with the record to add and the note that ports 80 and 443 must be open. The installer's rule applies: changing an existing console hostname needs the documented migration steps.

## 10.10 Permissions

| Action | Needs |
| --- | --- |
| See the Domains page | Domain or certificate rights |
| Add, connect, move, disconnect, remove hostnames; Give N a hostname | Domain rights on the service (members have these for their services) |
| Upload, edit, delete certificates | "Manage certificates" |
| Connect, edit, apply, remove zones; environment defaults | "Manage DNS" |

**Acceptance**
- With a platform domain and no server record, a deploy on a remote server assigns a hostname, the log names the missing record, no Let's Encrypt request is made, and within 5 minutes of the record appearing the hostname serves a valid certificate.
- A hostname with wrong DNS never causes more than zero Let's Encrypt requests per check cycle.
- Removing a hostname stops it serving within 10 seconds and removes its managed DNS record.
