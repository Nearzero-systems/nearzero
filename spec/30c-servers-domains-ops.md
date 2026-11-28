# R3. Servers and operations: parity of 0.1.79 and 1.0

Reviewer: parity reviewer (dirty side). Compared: 0.1.79 (the reference behavior) and 1.0 at 9a01ec7, against `spec/` at the same commit. This file describes behavior only.

Scope:
- Servers: add, setup over SSH, validation, the security audit, the DNS card, labels and hostnames, edit, remove, the terminal.
- The Nearzero host; daily and manual Docker cleanup; disk and Docker space reporting.
- SSH keys.
- Domains: generated and own hostnames, per-server hostnames, paths, ports, HTTPS, redirects.
- Certificates: automatic and uploaded, renewal, failures and back-off.
- Managed DNS zones and records; router files.
- Tasks, Analytics, Monitoring and alerts, notification channels and events.
- Backups: destinations, database and volume backups, restore.
- Git providers.

Not counted as gaps:
- the deliberate changes in `spec/00-index.md`;
- everything in `spec/27-dropped.md`;
- the owner's decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10;
- punch-list items marked Done;
- open punch item 5 (Compose automatic hostnames from repository files), which is not repeated here.

The outcome counts, not the mechanism: 1.0 runs plain containers under a per-server runner.

Every 1.0 claim below was checked in 1.0's code, not only in its spec.

## Summary

| Severity | Count |
| --- | --- |
| P0 | 0 |
| P1 | 13 |
| P2 | 39 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| R3-01 | P1 | A member with "Add and remove servers" can't see or set up servers they weren't granted, including one they just added | 09 9.8, 22 (spec gap) |
| R3-02 | P1 | Setup doesn't wait for the package-manager lock or retry package installs, so fresh cloud servers fail | 09 9.3 (spec gap) |
| R3-03 | P1 | A saved SSH key's public half can't be seen, copied or downloaded again | 09 9.7 (spec gap) |
| R3-04 | P1 | The daily Docker cleanup leaves most build cache in place | 09 9.4, 14.4 |
| R3-05 | P1 | No way in the console to forget a changed host key; editing a server's address to a new machine blocks setup | 09 9.2, 22.5 |
| R3-06 | P2 | Server details show a stored validation and audit, not a live check, and only managers can refresh them | 09 9.4 (spec gap) |
| R3-07 | P2 | The security audit no longer says whether the ban service protects SSH, starts on boot, or whether the firewall denies incoming traffic by default | 09 9.4 |
| R3-08 | P2 | Deleting an SSH key used by several servers names only the first | 09 9.7 |
| R3-09 | P2 | Server cards are alphabetical instead of newest first | 09 9.1 (spec gap) |
| R3-10 | P1 | Servers added by hostname never get HTTPS or own domains | 09 9.2, 10.2, 10.7 (spec gap) |
| R3-11 | P1 | Proxied hostnames and failed DNS lookups are held, so their certificates are never requested and HTTP stops redirecting | 10.7 |
| R3-12 | P1 | An install-time managed zone gets no record for the console's own hostname | 03 3.1, 10.8 (spec gap) |
| R3-13 | P2 | Connecting the first zone doesn't move existing automatic hostnames into it | 10.8 (spec gap) |
| R3-14 | P2 | People can add hostnames under the platform domain by hand | 10.5 |
| R3-15 | P2 | A managed-zone hostname ignores a record already at that name | 10.8 |
| R3-16 | P2 | Proxy detection covers only Cloudflare | 10.4, 10.5 |
| R3-17 | P2 | DNS warnings (extra A records, a stray AAAA, the CNAME alias) are gone | 10.4 |
| R3-18 | P2 | Certificate errors are shown raw, and errors where Let's Encrypt never checked the name count toward the pause | 10.7 |
| R3-19 | P2 | No early warning on hostname rows when an uploaded certificate is about to end | 10.7 |
| R3-20 | P2 | Uploaded certificates on a deleted or offline server can't be removed | 10.7, 09 9.6 |
| R3-21 | P2 | "Give N a hostname" appears only once the server's record already points here | 10.2, 10.3 |
| R3-22 | P2 | HTTP/3 is no longer served, though setup still opens 443/udp | 09 9.3 (spec gap) |
| R3-23 | P2 | Router files doesn't show the router's main settings file | 18.3 |
| R3-24 | P2 | The DNS record TTL range is narrower | 10.8 |
| R3-25 | P2 | Spec conflict: the Agent's hostname inputs still list an HTTPS switch and certificate choice | 20.6 vs 10.5 |
| R3-26 | P1 | Analytics counts the console's own traffic | 13.1, 13.2 (spec gap) |
| R3-27 | P2 | Busiest hosts lost the per-host error count | 13.2 (spec gap) |
| R3-28 | P2 | Server tasks run as root from "/", not as the SSH user from their home | 12.2, 12.3 (spec gap) |
| R3-29 | P2 | Host tasks are shared by all instance administrators instead of belonging to their creator | 12.4 (spec gap) |
| R3-30 | P2 | A run missed while Nearzero was stopped now runs at start | 12.3, 23.2 (spec gap) |
| R3-31 | P2 | Tasks shows in the sidebar for people who can't use it | 12.1, 24 G8 |
| R3-32 | P2 | The Tasks empty state doesn't say a filter is hiding tasks | 12.1 |
| R3-33 | P2 | Monitoring shows stale figures as current, and no failure reason | 14.2 |
| R3-34 | P2 | Storage usage can read lower than the root disk really is | 14.1 |
| R3-35 | P2 | Server alert messages don't say when the threshold was crossed | 14.3, 15.3 |
| R3-36 | P1 | GitLab, Bitbucket and Gitea push webhooks stop deploying after a move from 0.1.x | 16.6, 24 G4, 29 (spec gap) |
| R3-37 | P1 | The custom webhook body has a new shape, so integrations moved from 0.1.x break silently | 15.2 (spec gap) |
| R3-38 | P2 | Notification messages are plainer: no time or service kind, fewer buttons, Discord without decoration is plain text | 15.3 |
| R3-39 | P2 | "[skip ci]" and similar keywords no longer skip a GitHub push deploy | 16.6, 06 6.6 (spec gap) |
| R3-40 | P2 | A GitLab group filter takes only one group | 16.3 |
| R3-41 | P2 | 0.1.x OAuth and GitHub setup return addresses aren't answered after a move | 16, 29.5 (spec gap) |
| R3-42 | P2 | GitHub's Install page isn't aimed at the app's owner | 16.2 |
| R3-43 | P2 | Repository search on GitHub and Gitea looks only at the first 1,000 or 500 repositories | 16.7 |
| R3-44 | P1 | Backups made by 0.1.x can't be found, pruned or restored after the move | 29, 08 8.3 (spec gap) |
| R3-45 | P1 | Restore always loads into the service's default database | 08 8.3 (spec gap) |
| R3-46 | P2 | No Restore button on a schedule row | 08 8.3, 17.3 (spec gap) |
| R3-47 | P2 | Backup notifications say less than before | 15.3 (spec gap) |
| R3-48 | P2 | Two "Stop the service while copying" schedules on one service can overlap | 17.2 (spec gap) |
| R3-49 | P2 | Testing a destination needs a connected server the person can use | 17.1 |
| R3-50 | P2 | Database backups and restores need free disk for the whole uncompressed dump | 23.1 (spec gap) |
| R3-51 | P2 | libSQL: databases in namespaces aren't backed up, and restores over 512 MB are refused | 08 8.3, 27 |
| R3-52 | P2 | Restoring into a volume that doesn't exist yet is refused; the default backup folder changed | 17.3 (spec gap) |

---

## Servers and SSH keys

### R3-01 · P1 · "Add and remove servers" doesn't reach the servers it should

**0.1.x:** a member with "Add and remove servers" gets every server in the workspace. Like owners and admins, they see, set up, edit and delete them all.

**1.0 now:**
- That capability lets a member add a server.
- Seeing, editing, setting up or deleting a server also needs a grant for that server, and adding a server gives its creator none.
- So a member with the capability and without the "All servers" scope adds a server, and its card never appears on their Servers page.
- The setup dialog that opens after Create answers "This server doesn't exist in this workspace, or you don't have access to it."

**Expected:**
- A member whose only server right is "Add and remove servers" adds a server, sees its card, runs setup and deletes it.
- Either the capability covers every server in the workspace, or the person who adds a server gets access to it.

**Spec:** 09 9.8 and the matrix in 22. Spec gap: neither says whether the capability reaches servers the person wasn't granted.

### R3-02 · P1 · Setup doesn't wait for the package lock or retry installs

**0.1.x:**
- On Debian and Ubuntu, setup waits up to 5 minutes for other package jobs to release the lock. Fresh cloud servers run automatic upgrades or first-boot jobs at that point.
- Each install also waits for the lock and is tried 3 times, 10 seconds apart.
- The log says "apt-get … failed (attempt N/3); retrying in 10s...".

**1.0 now:**
- The basic tools and Docker are installed in one attempt, with no wait for the lock.
- A server still running its first-boot upgrades fails at step 2 or step 5 with a non-zero exit, and the person has to run setup again later.

**Expected:**
- Setup on a fresh Ubuntu server, while automatic upgrades hold the package lock, waits with a log line saying why and completes without a manual re-run.
- A transient mirror failure is retried at least twice before the step fails.

**Spec:** 09 9.3, steps 2 and 5. Spec gap: waiting and retrying aren't described.

### R3-03 · P1 · A saved key's public half is lost from the console

**0.1.x:**
- Edit on a saved SSH key shows its public key with "Download public key". Only the private key is hidden.
- People use this to put the same key into another server's authorized keys.

**1.0 now:**
- Edit shows only Name, Description and "Stored private keys cannot be displayed".
- The table shows the key type and fingerprint, and only in a tooltip.
- The API returns the public key, but no screen shows it.
- Once the Add dialog closes, the public half is gone from the console.

**Expected:** Edit on a saved key shows its public key read-only, with Copy and "Download public key" (a file named after the key, ending ".pub"). The private key stays hidden.

**Spec:** 09 9.7. Spec gap: Edit lists only name and description.

### R3-04 · P1 · The daily cleanup leaves most build cache

**0.1.x:**
- The 23:50 cleanup removes all unused images and all unused build cache, not only dangling cache.
- It also removes stopped containers and unused networks. The 1.0 spec deliberately keeps only images and build cache, so that part is not a gap.

**1.0 now:**
- It removes all unused images, but only dangling build cache from Docker's own builder.
- It never prunes the cache of the separate BuildKit builder Nearzero starts for Railpack builds, which keeps its cache in its own volume.
- On a server that builds often, that cache keeps growing, and the notification's "space freed" figure stays small.

**Expected:**
- After many builds on a server, one daily cleanup removes all unused build cache: Docker's own and that of Nearzero's Railpack builder.
- Afterwards no builder reports reclaimable cache, and the notification's space freed includes it.

**Spec:** 09 9.4 and 14.4 ("removes unused images and build cache").

### R3-05 · P1 · A changed host key can't be forgotten in the console

**0.1.x:** trusted host keys are recorded per address and port. Pointing a server at a new address, for example a replacement machine, makes a fresh first connection, and setup goes ahead.

**1.0 now:**
- The host key is recorded per server and kept when the address or port changes.
- The next setup or terminal is refused with "This server's host key changed … forget the old host key on the server's details, then run setup again."
- The details dialog has no Forget control; only the API can forget the key.
- The only way out in the console is to delete the server, and its services first.

**Expected:**
- After setup is refused for a changed host key, the details dialog offers "Forget host key".
- After using it, the next setup records the new key and logs "first connection: recorded".
- Changing a server's address or port clears the recorded key, or asks whether to.

**Spec:** 09 9.2 ("it can be forgotten later") and 22.5.

### R3-06 · P2 · Validation and audit are stored results, and only managers can refresh them

**0.1.x:**
- Opening View checks the server live each time ("Checking server configuration…"), for anyone who can see servers.
- The audit also runs live for people with read access.

**1.0 now:**
- View shows the validation stored at the last setup or the last "Check again".
- It shows the last stored audit, which is empty until someone presses "Run audit".
- Both "Check again" and "Run audit" need the server's manage rights, so a person who can only see the server can refresh neither.

**Expected:**
- Opening a ready server's details shows a validation checked when the dialog opened, or less than a minute before.
- Anyone who can see the server can re-check validation and run the read-only audit.

**Spec:** 09 9.4. Spec gap: how fresh the results are and who may re-run them aren't stated.

### R3-07 · P2 · The security audit reports less

**0.1.x:** the audit reports:
- whether the firewall blocks incoming traffic by default;
- whether SSH key sign-in is on, and PAM use;
- whether fail2ban starts on boot;
- whether its SSH jail is on, and in normal or aggressive mode.

**1.0 now:** the audit reports:
- whether a firewall is active (ufw, firewalld or iptables);
- password and keyboard-interactive sign-in;
- root sign-in;
- whether fail2ban, sshguard or crowdsec is running or only installed.

It doesn't say whether the ban service protects SSH or starts on boot, or whether the firewall denies incoming traffic by default.

**Expected:** with fail2ban running but its SSH jail off, the intrusion-ban item reads "Needs attention" and recommends turning on the SSH jail. A firewall that is active but allows incoming traffic by default is flagged.

**Spec:** 09 9.4.

### R3-08 · P2 · Key delete refusal names only one server

**0.1.x:** "This SSH key is attached to servers: A, B. Remove those servers first."

**1.0 now:** the refusal and the disabled menu item's tooltip name only the first server: "…attached to server: A. Remove that server first."

**Expected:** with two servers on a key, the refusal and the tooltip name both, in the plural.

**Spec:** 09 9.7.

### R3-09 · P2 · Server card order

**0.1.x:** newest first.

**1.0 now:** alphabetical by name.

**Expected:** a server added a moment ago appears first, or the spec states the order.

**Spec:** 09 9.1. Spec gap.

---

## Domains, certificates, managed DNS and router files

### R3-10 · P1 · Servers added by hostname never get HTTPS or own domains

**0.1.x:**
- A server's address can be a hostname. When it resolves to exactly one public IPv4, that address is used for:
  - DNS checks;
  - the server's wildcard record;
  - managed-zone records;
  - certificate holds.
- Otherwise the Domains card says "Nearzero couldn't work out this server's public IPv4 address from its address in Servers."

**1.0 now:** only an address typed as an IPv4 number counts. For a server added by hostname:
- its router holds every hostname as "address unknown" for good, so Let's Encrypt is never asked;
- Add domain for its services always fails with "…Correct it under About Nearzero.", but that screen only corrects the Nearzero host's address;
- managed-zone hostnames there are refused;
- its DNS card and wildcard record show no value.

**Expected:**
- A server added as `srv.example.com` that resolves to one public IPv4:
  - gets valid certificates for its hostnames;
  - accepts own domains pointing at that IPv4;
  - gets managed A records with that value.
- A name that resolves to no public address, or to several, shows a message naming the server's address, not About Nearzero.

**Spec:** spec gap. 09 9.2 allows hostnames, while 10.2 and 10.7 assume a known IPv4.

### R3-11 · P1 · Proxied hostnames and failed lookups are held

**0.1.x:**
- Certificate requests are held only when DNS clearly has no record, or points at another address that isn't a known proxy.
- Proxied names (Cloudflare, Bunny CDN, Fastly, Arvancloud), IPv6-only names and failed lookups still let Let's Encrypt try.
- The note for a proxied name: "Proxied by X. HTTPS works if X forwards plain HTTP for /.well-known/acme-challenge/ to this server."
- A proxied hostname gets its certificate and keeps renewing it. That is the usual setup for Cloudflare's "Full (strict)" mode.

**1.0 now:** anything other than "the A records include this server's IPv4" holds the name, including proxied names, IPv6-only names and lookup failures. So:
- a hostname behind a proxy never gets its first certificate;
- a hostname that was DNS only and then moves behind a proxy gets nothing more from Let's Encrypt, and its plain HTTP stops redirecting to HTTPS;
- one temporary resolver failure on a server drops the HTTPS redirect for every affected hostname until the next check.

**Expected:**
- A hostname behind Cloudflare's proxy that forwards the HTTP challenge gets a valid certificate.
- A hostname with a valid certificate whose DNS becomes proxied, or whose lookup fails once, keeps its certificate, its HTTP→HTTPS redirect and its renewal 30 days before expiry.
- Only "no record" and "points at another address that isn't a proxy" hold requests.

**Spec:** 10.7, which should say which DNS states hold.

### R3-12 · P1 · The install-time zone has no record for the console

**0.1.x:**
- When the installer names a managed DNS zone and the console's hostname is inside it, the zone gets an A record for the console's hostname pointing at the host.
- That record sits alongside the ns1 and ns2 records and their glue.
- The console resolves as soon as the zone is delegated.

**1.0 now:** the install's zone gets only its nameserver records. Nothing creates the console's record, so after delegation the console's address doesn't resolve and never gets a certificate.

**Expected:**
- Installing with zone `example.com` and console `nearzero.example.com` serves `nearzero.example.com A <host IPv4>` from the built-in DNS server once the first workspace exists.
- The record shows "Managed by Nearzero".

**Spec:** spec gap (03 3.1, 10.8).

### R3-13 · P2 · Connecting the first zone doesn't move existing automatic hostnames

**0.1.x:** connecting a workspace's first zone binds it to every environment that has none. Each service's Nearzero-assigned hostname then moves at once to `<service>.<zone>` (or `<service>.<prefix>.<zone>`), with its A record published.

**1.0 now:** the first zone becomes the default only for hostnames assigned later. Existing automatic platform hostnames stay until someone saves Environment defaults for that environment.

**Expected:** one of:
- connecting the first zone moves every environment-default automatic hostname into the zone and says how many moved;
- spec 10.8 says existing hostnames stay, and the Connect result says so.

**Spec:** spec gap (10.8).

### R3-14 · P2 · Names under the platform domain can be added by hand

**0.1.x:** any hostname equal to or under the platform domain is refused for own and managed hostnames with "This hostname is reserved for Nearzero's platform domain assignment". Only Nearzero assigns names there.

**1.0 now:**
- Only these are reserved: the platform domain itself, `<server label>.<platform domain>` and zone nameservers.
- Any workspace can claim a name like `login.apps.example.com` on the domain shared by the whole install. It passes the DNS check through the wildcard.

**Expected:**
- Add domain, Connect and the Agent refuse `anything.<platform domain>` and `anything.<server label>.<platform domain>` typed by a person, with the reserved message.
- Generated hostnames still work.

**Spec:** 10.5 step 1 ("the platform domain's assignment names").

### R3-15 · P2 · Managed-zone hostnames ignore an existing record at the name

**0.1.x:** a hostname Nearzero would create in a managed zone is refused with "DNS address record already exists for <host>" when a person-made A, AAAA or CNAME record already uses that name.

**1.0 now:** Nearzero adds its A record anyway. The zone then has two A records (traffic alternates with the old target), or an A record next to a CNAME, which makes the zone invalid.

**Expected:** adding `web.example.com` in a managed zone that already has a person-made A, AAAA or CNAME record for `web` is refused with a message naming that record, and nothing is saved.

**Spec:** 10.8.

### R3-16 · P2 · Only Cloudflare is recognized as a proxy

**0.1.x:** recognizes Cloudflare, Bunny CDN, Fastly and Arvancloud addresses, labels them "Proxied by <name>", and gives the turn-off-the-proxy advice.

**1.0 now:** recognizes only Cloudflare's ranges. The other three show "Points elsewhere".

**Expected:** a hostname that resolves into Fastly's, Bunny CDN's or Arvancloud's ranges shows "Proxied" with the provider's name in the Hostnames list, Add domain and the service dialog.

**Spec:** 10.4, 10.5 step 3.

### R3-17 · P2 · DNS warnings are gone

**0.1.x:** when a hostname points here, Details still warn:
- "<host> also points to <ips>. Let's Encrypt may check one of those instead. Keep only <ip>."
- "An AAAA (IPv6) record points to … Let's Encrypt tries IPv6 first, so remove it unless it reaches this server."
- A CNAME target shows as "Alias of".

**1.0 now:** "Points here" as soon as any A record matches, with no warning and no alias.

**Expected:** a hostname with an extra A record, or with an AAAA record to another machine, shows "Points here" plus the matching warning in Details and in the DNS step of Add domain.

**Spec:** 10.4 (Details "warnings").

### R3-18 · P2 · Raw certificate errors, and the wrong failures count toward the pause

**0.1.x:**
- The router's certificate errors become plain advice, for example:
  - "Let's Encrypt could not reach port 80 on <ip>. Open TCP port 80…" (an IPv6 variant asks to remove the AAAA record);
  - "A CAA record blocks Let's Encrypt. Add a CAA record: 0 issue "letsencrypt.org"";
  - "The check was redirected to HTTPS… If Cloudflare proxies this hostname, turn off Always Use HTTPS…";
  - "Let's Encrypt found no DNS record…";
  - "Let's Encrypt does not issue certificates for this name."
- Failures where Let's Encrypt never checked the name don't count toward the 3-failures-per-hour pause: the server couldn't reach Let's Encrypt, or the name was refused by policy.

**1.0 now:**
- "Failed" and "Last error" show a shortened copy of the router's own error text.
- Every error other than a rate limit counts, so a server whose outbound HTTPS is blocked goes "Paused" after 3 tries.

**Expected:**
- A check that failed because port 80 is closed shows the open-port-80 advice in plain words.
- Three "couldn't reach Let's Encrypt" errors in an hour don't pause requests.

**Spec:** 10.7.

### R3-19 · P2 · Uploaded certificates give no early warning on hostname rows

**0.1.x:** a hostname covered by an uploaded certificate shows "Expires soon" within 14 days of its end: "…Nearzero can't renew uploaded certificates."

**1.0 now:** the row says "Uploaded" until the day the certificate expires, then "Expired". Only the Uploaded certificates tab shows "Expires in N days".

**Expected:** a hostname whose uploaded certificate ends in 10 days shows a warning state on the Hostnames tab saying it won't renew on its own.

**Spec:** 10.7 (states table).

### R3-20 · P2 · Uploaded certificates of a deleted or offline server are stuck

**0.1.x:** deleting a server deletes its uploaded certificates.

**1.0 now:**
- They stay listed, with the server shown as "Unknown server".
- Delete, and replacing the certificate or key, fail while that server's runner isn't connected, so a certificate of a deleted server can never be removed.

**Expected:**
- Deleting a server removes its uploaded certificates.
- Deleting an uploaded certificate whose server is offline removes the record, and the router drops the certificate when its runner reconnects.

**Spec:** 10.7, 09 9.6.

### R3-21 · P2 · "Give N a hostname" waits for DNS

**0.1.x:**
- A server row whose services have no hostname always offers "Give it a hostname" or "Give N a hostname", record or not.
- The result says "…They load once <record> points at this server."

**1.0 now:** the button appears only when the server's wildcard record already points here. Otherwise only "Check again" is offered, and that assigns nothing.

**Expected:** a server row with 2 services and no wildcard record yet shows "Give 2 a hostname". Pressing it assigns both hostnames and says they load once the record exists.

**Spec:** 10.2 ("assigned and routed … before the record exists") and 10.3.

### R3-22 · P2 · HTTP/3 isn't served

**0.1.x:** every router listens on UDP 443 and advertises HTTP/3.

**1.0 now:** routers listen on TCP 80 and 443 only. Setup still opens 443/udp in the firewall, and the firewall reminder still names it.

**Expected:** one of:
- a site on any server answers HTTP/3 on UDP 443, with an Alt-Svc header in its HTTPS answers;
- spec 9.3 drops 443/udp from setup and from the reminder.

**Spec:** spec gap (09 9.3 step 10).

### R3-23 · P2 · Router files leaves out the router's main settings

**0.1.x:**
- The host's router editor shows the router's whole configuration folder, including its main settings file (entry points, certificate resolvers, global options).
- Everything there can be edited. Edits to the main file apply at the next router restart.

**1.0 now:** Router files lists only the route files. The router's main settings can't be seen anywhere.

**Expected:** one of:
- Router files shows the router's main settings read-only, with the reason;
- spec 18.3 states that only route files are shown.

**Spec:** 18.3.

### R3-24 · P2 · Narrower DNS record TTL range

**0.1.x:** record TTLs from 1 second to about 68 years are accepted. A blank TTL uses the zone's 300.

**1.0 now:** only 60 to 86,400 seconds are accepted ("Use a TTL from 60 to 86400 seconds."). The common week-long TTL for NS and MX records (604,800) is refused.

**Expected:** a TTL of 604,800 saves, or the spec states the range.

**Spec:** 10.8 (no range given).

### R3-25 · P2 · Spec conflict on the Agent's HTTPS choice

**0.1.x:**
- The Agent's add-hostname step accepts HTTPS on or off, and a certificate choice: Let's Encrypt or the router's default certificate.
- So the Agent could add an HTTP-only hostname. The console never offered this.

**1.0 now:**
- HTTPS with Let's Encrypt always, as 10.5 says.
- Spec 20.6 still lists "Port, path, HTTPS (on by default), certificate (Let's Encrypt by default)".

**Expected:** spec 20.6 matches 10.5: the Agent's add-hostname inputs are port, path and the Compose service only.

**Spec:** 20.6 against 10.5.

---

## Tasks, Analytics and Monitoring

### R3-26 · P1 · Analytics counts the console's own traffic

**0.1.x:** requests to the console itself are left out of every Analytics figure: stats, chart, busiest hosts and table. Only traffic to deployed apps is counted.

**1.0 now:**
- When the console is reached through its public hostname, all its requests pass the host's router and are counted.
- That includes page loads and the console's own polling: monitoring every 5 seconds, run history every 3 seconds, and others.
- The console's hostname rises to the top of Busiest hosts, and every figure is inflated.
- The 10,000 requests the daily cleanup keeps fill up with console traffic.
- Spec 13's acceptance test ("100 requests … shows 100") fails whenever the tester opens the page through the console's domain.

**Expected:**
- With the console reached through its public hostname, Analytics left open for 5 minutes adds 0 requests, and the console's hostname never appears in Busiest hosts.
- After 100 requests to an app, the page shows exactly 100.

**Spec:** 13.1 and 13.2. Spec gap: the rule isn't written.

### R3-27 · P2 · Busiest hosts lost the error count

**0.1.x:** each busiest host shows its request count, and its error count ("N err") when it has 4xx or 5xx answers.

**1.0 now:** only the request count per host is shown.

**Expected:** a host with 3 errors among 10 requests shows "10" and "3 err". A host with no errors shows no error count.

**Spec:** 13.2 (spec gap).

### R3-28 · P2 · Server tasks run as root from "/"

**0.1.x:** a server task's script runs as the server's SSH user, from that user's home folder. It has that user's home, `~`, and credential files such as `~/.aws` or `~/.docker`.

**1.0 now:**
- The script runs as root, from "/", with home set to /root and a minimal environment.
- A moved script that writes to `~` or reads the user's settings behaves differently, and the files it makes are owned by root.

**Expected:**
- The spec names the user and working folder for server tasks.
- If 0.1.x behavior is kept: on a server set up as "ubuntu", a task running `id -un; pwd` logs "ubuntu" and "/home/ubuntu".

**Spec:** 12.2 and 12.3 (spec gap).

### R3-29 · P2 · Host tasks no longer belong to their creator

**0.1.x:**
- Each Nearzero-host task belongs to the instance administrator who made it, and others don't see it.
- Anyone else who tries to manage it is refused with "You can only manage your own host-level schedules."
- The task is deleted with its owner's account.

**1.0 now:** every instance administrator sees, edits, runs and deletes every host task, from any workspace. Tasks outlive the person who made them.

**Expected:** the spec states whether host tasks are shared by all instance administrators (1.0 today) or private to their creator (0.1.x), and a test covers the chosen rule.

**Spec:** 12.4 (spec gap).

### R3-30 · P2 · Missed runs now run at start

**0.1.x:** due times that pass while the control plane is stopped are skipped. The task next runs at its next scheduled time.

**1.0 now:** at start, a task whose due time passed during the stop runs once at once, then keeps its schedule. Backup schedules do the same.

**Expected:** the spec states which rule applies. If catch-up runs stay, the run history marks them as catch-up runs with the time they were due.

**Spec:** 12.3, 23.2 (spec gap).

### R3-31 · P2 · Tasks shows for people who can't use it

**0.1.x:** the Tasks item shows only to owners and admins.

**1.0 now:** Tasks shows to everyone. A member with no service, server or host to make tasks for sees an empty page with no Add task button.

**Expected:**
- A member with access to no app or Compose service, and with no server manage rights, doesn't see Tasks in the sidebar.
- Opening its address directly gets the standard no-access answer.

**Spec:** 12.1 ("anyone who can see at least one task place"), 24 G8.

### R3-32 · P2 · The Tasks empty state ignores filters

**0.1.x:** when a search or filter matches nothing but tasks exist, the page says "No tasks found / Try adjusting your search or filters."

**1.0 now:** it always says "Create your first scheduled task to automate workflows.", even when tasks exist and are only filtered out.

**Expected:** with at least one task and a search that matches none, the empty state reads "Try adjusting your search or filters."

**Spec:** 12.1.

### R3-33 · P2 · Monitoring shows stale figures as current

**0.1.x:** figures are read live from the server. An unreachable server or monitoring service shows "Error fetching metrics" with the reason under it, for example "No monitoring data available yet…" with steps.

**1.0 now:**
- The panel shows the last stored sample as if it were current, though it can be up to 2 days old: CPU, RAM, storage and a frozen uptime.
- Nothing says the server stopped reporting.
- A failed fetch shows only "Error fetching metrics", without the reason.

**Expected:**
- With a server's runner disconnected for over a minute, the panel says the server isn't reporting and when the last sample was taken, and shows no current-looking figures.
- A failed fetch shows "Error fetching metrics" with the platform's reason.

**Spec:** 14.2.

### R3-34 · P2 · Storage usage can read too low

**0.1.x:**
- The percentage matches what `df` says: space reserved for root counts as unavailable, so a full disk reads 100%.
- The host's figure comes from the host's own root filesystem.

**1.0 now:**
- The percentage is used space divided by total, so a full ext4 disk with 5% reserved reads about 95%.
- On the host, the runner measures its own container's root. That is the disk holding Docker's data, which is not always the host's root disk.

**Expected:**
- On a host whose root disk `df` reports at 100%, Storage usage shows 100%.
- With Docker's data on a separate disk, the host's Storage usage matches `df /` on the host.

**Spec:** 14.1.

### R3-35 · P2 · Alert messages carry no time

**0.1.x:**
- Every channel's alert carries the date and time.
- The title is "Server CPU Alert" or "Server Memory Alert".
- The fields are Server Name, Type, Current Value, Threshold, Message and Time.

**1.0 now:**
- The facts are Server, Metric, Value and Threshold.
- Only the Discord message has a timestamp, and it is the send time, not the time of the sample.

**Expected:** on every channel kind, a server alert states the date and time of the sample that crossed the threshold.

**Spec:** 14.3, 15.3.

---

## Notifications and Git providers

### R3-36 · P1 · GitLab, Bitbucket and Gitea push webhooks stop deploying after a move

**0.1.x:**
- A GitLab, Bitbucket or Gitea push to a service's deploy-webhook address deploys with no secret or signature. The person added that webhook at the Git host by hand.
- Only the branch and the watch paths are checked.

**1.0 now:**
- The old address is still answered.
- A call that carries GitLab, Bitbucket or Gitea event headers, for a service linked through a connected provider, must carry a per-service secret.
- That secret exists only once someone presses "Register webhook" or follows the manual steps, and the move creates none.
- Every push from the existing webhook gets 401 ("The webhook's signature doesn't match…").
- The only warning is in the service's Source panel: "Pushes don't deploy yet: register the webhook…".

**Expected:** after importing a 0.1.x app that deploys from GitLab, Bitbucket or Gitea through a connected account, one of these holds:
- a push to its branch from the existing webhook deploys with no change at the Git host;
- the import registers a signed webhook for that service, replacing the old one.

If neither can be done, the move report names each service whose pushes need "Register webhook".

**Spec:** 29.4 and 29.5 ("so nobody has to change settings at their Git host") conflict with 24 G4 and 16.6. Spec gap: there is no import rule for provider webhooks.

### R3-37 · P1 · The custom webhook body has a new shape

**0.1.x:** the JSON body is flat. Its top-level fields:
- `title`, `message`, `status` ("success", "error", "alert"), `type` (for example "build", "docker-cleanup", "nearzero-restart"), `timestamp` (ISO time) and `date`;
- fields for each event, such as `projectName`, `applicationName`, `applicationType`, `errorMessage`, `buildLink`, `domains`, `databaseType`, `databaseName`, `volumeName`, `backupSize`, `serverName`, `currentValue` and `threshold`.

The test body has `title`, `message`, `type` "test" and `timestamp`.

**1.0 now:**
- The body has `event`, `title`, `summary`, a list of facts, `link`, `tone`, `data` and `sentAt`. None of the 0.1.x fields except `title` is there.
- Moved channels keep their address, so receivers that read `message`, `status`, `type` or `errorMessage` stop working, with no warning.

**Expected:** a custom webhook, at least one moved from 0.1.x, gets a body that still carries the 0.1.x top-level fields for each event alongside 1.0's own. Test: a "Deploy failed" delivery contains `status` "error", `type` "build", `errorMessage` and `buildLink`.

**Spec:** spec gap. 15.2 only says "POST, JSON body".

### R3-38 · P2 · Notification messages are plainer

**0.1.x:**
- Every message carries the date and time. Deploy messages also give the service kind: application, Compose, or the database type.
- Slack uses a colored attachment (red or green) with fields.
- Discord with Decoration off still sends an embed, only without emoji.
- Telegram has a "Deployment Logs" button. Lark sends a card with a "View Build Details" button. ntfy has a "Build details" action button.
- Mattermost posts as "Nearzero Bot" (or "Nearzero") when no user name is set.
- Email uses a designed template.

**1.0 now:**
- No time and no service kind.
- Slack gets one block of text.
- Discord with Decoration off gets plain text, not an embed.
- Telegram gets an inline link, Lark plain text, and ntfy only a tap-through link.
- Mattermost uses the webhook's default name.
- Email is a minimal table.

**Expected:**
- Each event message says when the event happened and, for deploys, the service kind.
- Discord with Decoration off still sends an embed without emoji.
- Mattermost with no user name posts as "Nearzero".
- Telegram and Lark deploy messages carry a button to the log.

**Spec:** 15.3 for content. Formatting is a spec gap.

### R3-39 · P2 · Skip keywords no longer skip GitHub push deploys

**0.1.x:** a GitHub push whose commit message contains "[skip ci]", "[ci skip]", "[no ci]", "[skip actions]" or "[actions skip]" doesn't deploy. The answer is "Deployment skipped: commit message contains skip keyword".

**1.0 now:** there is no keyword check, so such a push deploys.

**Expected:** a push to the app's branch whose head commit message contains "[skip ci]" doesn't deploy, and the webhook's answer says why.

**Spec:** spec gap (16.6, 06 6.6).

### R3-40 · P2 · GitLab group filter takes one group

**0.1.x:** "Group name" takes a comma-separated list. Projects whose namespace starts with any listed group are shown, subgroups included.

**1.0 now:** one group only. A moved value such as "team-a,team-b" fails with "GitLab has no group called team-a,team-b that this account can see…".

**Expected:** with the group name "team-a, team-b", the repository list shows projects from both groups and their subgroups.

**Spec:** 16.3. The wording should allow several groups.

### R3-41 · P2 · Old OAuth and GitHub setup return addresses after a move

**0.1.x:**
- GitLab and Gitea send people back to the 0.1.x callback addresses on the console.
- A GitHub App's setup return goes to the 0.1.x GitHub setup address.
- A GitLab or Gitea provider's Edit dialog lets the person change the saved Redirect URI ("Must match the callback URL in your GitLab application…").

**1.0 now:**
- The redirect address is always 1.0's own, read-only, and the moved redirect address is ignored.
- Neither 0.1.x callback address is answered, so Authorize or Reconnect on a moved GitLab or Gitea provider fails at the Git host with an invalid redirect address, until the person edits the OAuth application there.
- Reinstalling a moved GitHub App lands on a missing page. The installation still binds later, through the app's webhook.

**Expected:** 1.0 either answers the 0.1.x GitLab, Gitea and GitHub setup return addresses, or uses the moved redirect address. Test: Reconnect on a moved GitLab provider completes without changing the GitLab application.

**Spec:** spec gap. 29.5 keeps only the old webhook addresses.

### R3-42 · P2 · GitHub's Install page isn't aimed at the app's owner

**0.1.x:** Install, and the step right after the app is created, open GitHub's install page for the app's owning account. GitHub's "choose an account" step is skipped, so one Install click is left.

**1.0 now:** the app's general install page opens, and the person picks the account first.

**Expected:** after "Continue on GitHub" creates the app, GitHub shows the install confirmation for the owning account or organization, with no account picker.

**Spec:** 16.2 ("opens the install page on the app's owner").

### R3-43 · P2 · Repository search stops at the first few hundred

**0.1.x:** every repository the installation or account can see is listed and can be found.

**1.0 now:**
- Search looks only within the first 1,000 repositories of a GitHub installation and the first 500 of a Gitea account. Anything beyond can't be found.
- GitLab and Bitbucket search at the Git host and are not affected.

**Expected:** searching for a repository past the 1,000th one a GitHub installation can see finds it, and the same past the 500th on Gitea.

**Spec:** 16.7. The 200 cap applies to results, not to what is searched.

---

## Backups

### R3-44 · P1 · 0.1.x backups are invisible to 1.0

**0.1.x:**
- Backup files are named by start time with milliseconds and a "Z", for example `2026-11-25T03-00-00-123Z.sql.gz`, or `.bson.gz` for MongoDB.
- Volume archives are uncompressed and carry the volume's name, for example `data-2026-11-25T03-00-00-123Z.tar`.
- File contents also differ:
  - Postgres files are in Postgres's own archive dump format, gzipped;
  - MySQL files don't name the database they load into;
  - libSQL files are a gzipped archive of the data folder.

**1.0 now:**
- Only files named exactly like `2026-11-25T03-00-00.sql.gz`, `.archive.gz` or `.tar.gz` are listed, pruned or accepted, so every 0.1.x file is refused, even in the service's own folder.
- After a move, "Find backups" says "No backups in this folder yet." for every backup made before it, and Keep N never deletes those files.
- Renaming the files wouldn't help: 1.0's restore loads plain SQL for Postgres, MySQL and libSQL and expects volume archives to be gzipped, so the old Postgres, MySQL, libSQL and volume files would still fail.

**Expected:**
- After importing a 0.1.x install, Restore lists that service's 0.1.x backups in their folder.
- Restoring a 0.1.x Postgres, MySQL, MariaDB, MongoDB, libSQL or volume backup brings the data back.
- Keep N counts and prunes those files together with new ones.

**Spec:** spec gap. 29 carries schedules over but says nothing about files already in the bucket (see also 08 8.3 and 24 G2).

### R3-45 · P1 · Restore always loads into the service's default database

**0.1.x:**
- The restore dialog has a "Restore into database" field.
- It is filled from the schedule's database when opened from that schedule's row, and from the service's database otherwise. The person can change it.
- The restore loads into that database.

**1.0 now:**
- Restore takes no database name. Every restore loads into the service's configured database (by default "postgres" for Postgres, "app" for MySQL, "mariadb" for MariaDB), whatever database the backup dumped.
- Postgres: a schedule that dumps `analytics` makes a dump that restores into `postgres`. Its drop-if-exists lines remove same-named tables there, and `analytics` is left untouched.
- MongoDB: with a database name set on the service, a restore keeps only that database's collections. A backup of another database, or of all databases, restores nothing or only a part, and still ends "Restored".

**Expected:**
- Restoring a backup from a schedule that dumps a non-default database loads it into that same database by default.
- The person can pick or type the database to restore into, and the confirm step names it.

**Spec:** 08 8.3 Restore (spec gap: it doesn't say which database).

### R3-46 · P2 · No per-schedule Restore

**0.1.x:** each schedule row has a "Restore" button that opens the dialog set to that schedule's destination, folder and database.

**1.0 now:** there is only the header's "Restore…". It always opens on the first destination and the first schedule's folder ("daily" when there is none).

**Expected:** Restore opened from a schedule row opens with that schedule's destination, folder and database (or volume) filled in.

**Spec:** spec gap (08 8.3, 17.3).

### R3-47 · P2 · Backup notifications say less

**0.1.x:**
- "Database backup" messages give Project, Application, Database (its type), Database Name, date, time, the result and the error.
- "Volume backup" messages give Project, Application, Volume Name, Service Type, Backup Size, date, time and the error.

**1.0 now:** messages give Service, Volume (volume backups only), Destination, Result, then Size or Reason. There is no project, environment, database type or database name, though the run records the project and the environment.

**Expected:**
- A database backup message names the project and environment, the service, the database type, the database dumped, the destination and the result.
- A volume backup message names the project, the service, the volume and the size.

**Spec:** 15.3 (spec gap: the table lists only service, destination and result).

### R3-48 · P2 · Stop-while-copying runs on one service can overlap

**0.1.x:** volume backups that stop the service take a lock per service, so two of them on the same app or Compose service run one after the other.

**1.0 now:**
- Overlap is prevented only within one schedule, and up to 4 jobs run at once.
- Two such schedules on the same service at the same time (both on the default 03:00) run together.
- One can start the containers again while the other is still copying, so that copy isn't consistent.

**Expected:** a run that stops a service waits while another stop-while-copying run, or a restore, of the same service is in progress. Each copy is taken with the service stopped.

**Spec:** spec gap. 17.2's overlap rule covers one schedule only.

### R3-49 · P2 · Testing a destination needs a server

**0.1.x:** Test, in the dialog and on the row, always lists the bucket from the Nearzero host. Any workspace can test a destination before it has servers.

**1.0 now:**
- Test runs on the Nearzero host only for people allowed to use it, and otherwise on one of the workspace's connected servers.
- A workspace with neither gets "Nearzero tests a destination from one of your servers, and none is connected…". By default that means every workspace except the first one, until it has a remote server.

**Expected:** Test of a new or saved destination works in a workspace with no servers and no host access. Within about 10 seconds it answers "Connected. Nearzero can list <bucket>." or the failure message.

**Spec:** 17.1.

### R3-50 · P2 · Backups and restores need free disk for the whole dump

**0.1.x:** dumps stream straight to the bucket and restores stream from it, so they need no free disk on the server.

**1.0 now:**
- Dumps and restores go through a temporary volume on the server's disk.
- MySQL, MariaDB and libSQL dumps are written uncompressed, then compressed.
- Postgres, MySQL, MariaDB and libSQL restores unpack the whole file to disk first.
- There is no free-space check: on a full disk the step fails with the tool's own error.
- The temporary volume is removed afterwards.

**Expected:** a backup or restore of a database bigger than the server's free disk either works, or fails at once with a plain message saying how much space it needs.

**Spec:** spec gap. 23.1 rules out reading from standard input, but not this outcome.

### R3-51 · P2 · libSQL namespaces and large restores

**0.1.x:** a libSQL service is backed up as an archive of its data folder, which holds every namespace, and restored by unpacking it, with no size limit.

**1.0 now:**
- libSQL is dumped through its HTTP interface without naming a namespace. A service with namespaces turned on is covered only for its default database at best, or the run fails.
- A dump over 512 MB is refused on restore.

**Expected:**
- A libSQL service with namespaces backs up and restores all of them.
- A libSQL dump over 512 MB restores, or the dialog states the size limit before restoring.

**Spec:** 08 8.3; 27 keeps libSQL namespaces.

### R3-52 · P2 · Volume restore into a missing volume; default folder

**0.1.x:**
- A volume restore creates the volume when it isn't on the server, for example a service set up again on a new server before its first deploy.
- The schedule form's default folder is "nightly".

**1.0 now:**
- The restore is refused with "The volume X doesn't exist on the server yet. Deploy the service first."
- The default folder is "daily".

**Expected:**
- Restoring into a volume the service mounts but that isn't on the server yet creates it and unpacks the archive into it.
- The default folder is "nightly", or the spec records both changes.

**Spec:** spec gap (17.3).

---

## Checked and found at parity

1.0 is equal or better unless a gap above says otherwise.

### Servers and SSH keys

**Add server**
- Fields and limits: no default SSH user, the AWS and passwordless-sudo hint, port 22 by default, and "Saved SSH key not found." for a key outside the workspace.
- Duplicate names (case-insensitive) and duplicate address and port are refused.
- The dialog shows the platform's own message instead of a generic error.
- Edit keeps the same fields, and changing the SSH user brings the "Run setup again" notice.

**Setup flow**
- Setup starts at once after Create.
- "Setup is already running…" for a run under 5 minutes old, and "Previous setup looks stalled. Retrying…" for an older one. A ready server opens its details instead.
- Steps are numbered and titled.
- The port 80 and 443 check names the process holding them.
- rclone is pinned and checksum-verified; a Snap-installed Docker is refused.
- Swap is 2× RAM, from 2 to 8 GB, when the disk allows.
- Firewall: 80/tcp, 443/tcp and 443/udp, with the cloud-firewall reminder.
- A non-root user joins the Docker group.
- SSH hardening is validated and rolled back on failure.
- The router is restored when a new one fails, and runs as the owner of its files.
- Alpine gets bash first.
- Re-running setup keeps workloads and routes, and secrets are cut from the log.
- Supported systems and the unsupported-system message match, for amd64 and arm64.

**Setup failures**
- Wrong user, with "Use <user> and run setup again".
- No passwordless sudo, with the exact fix command.
- Key rejected, and server unreachable, with hints.
- "Setup stopped at step N (<title>): … (exit code X)" and "Server setup did not complete. Missing: …".
- The server is kept, its error shows on the card, and "Run setup again" is offered.

**Host keys:** recorded on the first connection; a changed key is always refused; strict mode refuses unknown keys. 1.0 adds "Trust this host key".

**Validation:** the mandatory checks (the runner is added) and the four verdict sentences.

**Server DNS card**
- Provider detection, including every provider named in the spec, with each provider's steps.
- The record name relative to the zone, "In the domain …" and "DNS only".
- The four badges, "App addresses are ready", and "Check again" with its hint.
- "Server setup completed", with and without the DNS-pending sentence.

**Server labels:** a slug of at most 40 characters, "server-" before a leading digit, -2 and -3 on clashes, unique across the install, unchanged by a rename.

**Delete server**
- Both dialog versions, the tick, and "Delete services and server" disabled until it is ticked.
- Each service's delete right is checked first, and the server is kept if any service can't be removed.
- The API refusal "Server has active services, please delete them first", and the Agent's refusal.

**Daily cleanup**
- Runs at 23:50, on for the host and off for other servers by default. The host's switch is on About Nearzero (punch item 12).
- The host's event goes to the first workspace, and each server's to its own workspace.

**Manual cleanup and space reports:** manual Docker cleanup actions and Docker disk-usage reports exist in 0.1.x only on unmounted or hidden screens (spec 27). The Agent has none, so nothing is missing.

**Nearzero host:** not shown as a server card in either version, and the host is restricted as 24 G3 requires.

**Server terminal:** an SSH shell for people with manage rights (punch item 15).

**Servers page:** tabs and `?tab=ssh-keys`, search over name, address, description and user, the status filter, the three empty states, the card menu and the readiness badges.

**SSH keys**
- Generated on the server, RSA 4096 or ED25519, with "SSH key generated".
- Format rules with "Invalid public key format" and "Invalid private key format". 1.0 also refuses a mismatched pair and a passphrase-protected key.
- Downloads from the Add dialog.
- Edit changes the name and description only.
- Delete is refused while a server uses the key, and the dialog lists the Git apps and Compose services that use it (punch item 16).
- Private keys are never returned.
- Newest first, and the "No SSH keys yet" empty state.

### Domains, certificates, DNS and router files

**Hostname input**
- The messages for a scheme, a path or port, a wildcard, a single label, an invalid name and an IP address.
- Internationalized names are stored as punycode.
- Only a numeric or `0x…` last label is refused (punch item 1).
- Hostnames are unique across the install, with the duplicate message. The console's hostname and zone nameservers are reserved.

**Own domains**
- They must point at the server before they are added. Lookups give up after about 10 seconds.
- In a managed zone, the person chooses between Nearzero creating the record and creating it themselves.

**Adding and moving hostnames**
- Adding, connecting and moving are all or nothing. An offline server shows the reason and nothing is saved; the old route comes back on failure.
- One service per hostname, routing by path prefix, the default port from the service, and the Compose inner service required when there are several.

**HTTPS and holds**
- HTTP redirects to HTTPS once a certificate exists. Held names are served over plain HTTP. Names that can never be public are always held.

**Back-off**
- A pause after 3 failed validations in an hour, until an hour after the first.
- A rate limit holds until its retry-after time, or 1 hour.
- The background check runs 1 minute after start, then every 5 minutes. Check DNS and Retry trigger it.

**Certificate states**
- Retry's refusals and their wording.
- The "Expires soon" rule.
- Queued, Issuing, Paused, Rate limited, Unknown, and "Couldn't read certificates on N servers."

**Uploaded certificates**
- PEM certificate and key, which must match.
- The server is fixed after upload, and a blank key keeps the stored one.
- Wildcard coverage, "Expires in N days" within 30 days, and the delete message.

**Managed zones and records**
- Connect with a required admin email, and default ns1 and ns2 nameservers.
- "This DNS zone is already managed by another workspace".
- Apply and Apply all zones, the health messages and the error banner.
- Record types A, AAAA, CNAME, TXT (255 bytes per string), MX with priority, CAA and NS. A CNAME must stand alone, and managed records are read-only.

**Environment defaults:** platform domain, no zone, or a zone, with a name prefix, and both "Saved…" results. Removing a zone (new) is refused while services use it.

**Per-server hostnames:** assigned and routed at deploy, and the deploy-log DNS note never blocks a deploy (punch item 18).

**Removing hostnames**
- Remove (new), Disconnect and Move. A removed generated hostname doesn't come back at the next deploy.
- Deleting a service removes its hostnames, routes and managed records, and republishes the zone.

**Router files (punch item 23, really done)**
- The warning, and the server picker.
- Edit mode, and Save with "Router config updated".
- YAML and router-schema validation with the line and reason.
- Paths outside the folder are refused, and Nearzero's own files are read-only with the managed message.

**About Nearzero**
- Configure public domain, and the certificate email reaching every router (punch item 2).
- Changing an existing console hostname is refused with the installer's steps.
- Correcting the server IP requires a public IPv4 and moves managed records to it.

### Tasks

**Form**
- Name (up to 100) and description (up to 500).
- Runs on: an app's container, a Compose inner service, a server or the Nearzero host. It is fixed after creation, and databases are refused.
- Shells: bash or sh for containers, bash for servers and the host.
- Schedule: the seven presets or a custom cron. A 6-field cron isn't accepted, and the move reports such tasks.
- Time zone: UTC by default, with the next run shown in the task's zone.

**Script checks:** a syntax check without running; Windows line endings converted; null bytes, more than 64 KB and empty scripts refused; the shebang warning; "Save anyway"; the error names the line.

**List:** the search placeholder, the status filter, page sizes 10, 25, 50 and 100, the sorting and paging, and Last run ("Never" before the first).

**Row actions and toasts:** History, Run, Edit and Delete (`Delete "<name>"?`), with the toasts.

**Run history**
- Updates live every 3 seconds.
- The status labels, including Skipped; start time, age and duration; the last 1,000 log lines.
- Stop ends what the run started. Runs are capped at 6 hours, and overlapping scheduled runs are recorded as Skipped.
- Each task keeps 100 runs (0.1.x kept 10; the spec says 100).

**Deleting a service or server** deletes its tasks.

**Permissions** per place, and the Agent uses the same checks, with the production rule.

### Analytics

**Access and recording**
- For instance administrators only, with the sidebar item hidden for others.
- On by default, and the 0.1.x setting is carried over by the move.

**Settings**
- The cleanup cron (daily at midnight by default), which keeps the newest 10,000 requests and is now validated.
- Turning logging on and off with the router-restart warning, and "Delete all request logs" with its confirm and toast, all audited.

**Filters:** a 32 MB read limit; ranges of 24 hours, 3 days, 7 days, 30 days and custom; host-or-path search; the 2xx to 5xx chips; Clear filters.

**Figures:** Requests, Errors with the 4xx and 5xx split, median and 95th percentile; a zero-filled chart of at most 200 buckets; the top 5 hosts, clickable.

**Table:** 25 rows per page, and a drawer with Copy JSON and Download JSON.

### Monitoring

**Collection**
- CPU, memory (used is total minus available), disk, uptime and system information. Network is dropped, as the spec says.
- Install settings for the sample interval and retention (2 days by default), and authenticated reporting per server.

**Panel**
- Data points 50, 200, 500 or All; refresh every 5, 10, 20 or 30 seconds, and none with All.
- The cards, System information, and the CPU and RAM history charts.
- The host's panel on About Nearzero, and a panel on every server's details (new).

**Container stats:** no container-level stats stream was reachable from the 0.1.x console or Agent, so nothing is missing.

**Alerts (new screen)**
- Thresholds from 1 to 100, blank meaning off.
- An alert after 3 samples in a row, then 30 minutes of quiet unless the value drops.
- "Send a test alert", and delivery to channels subscribed to "Server alert". Host alerts go to the first workspace.

### Notifications

**Channels**
- All 12 kinds, with the fields, priorities and defaults of 15.2: Pushover's retry and expire, Telegram threads, the Discord and Gotify Decoration switch, Mattermost's channel and user name, and custom headers.
- The validation messages use the spec's words. SMTP sign-in is optional.

**Secrets and tests**
- Secrets are never returned, and blank fields keep the saved values.
- Changing where a channel sends asks for its secrets again.
- Test notification uses the form's values (saved secrets on edit), with "Test sent…" or "Test failed: <reason>".

**Delivery**
- SMTP uses TLS on port 465 and STARTTLS elsewhere.
- Telegram, Lark and Pushover refusals hidden inside a successful answer are caught.
- Delivery is better than 0.1.x: one message per event per channel, retries after 15 seconds, 1 minute and 4 minutes, and "Last delivery failed: …" on the channel's row.

**Events**
- The 7 events and their short labels.
- App, Compose and database deploys all send "Deploy succeeded" and "Deploy failed".
- Docker cleanup and server alerts go to the server's workspace.
- "Nearzero restart" goes only to the first workspace, and only after an earlier start.

**Access:** one capability covers seeing and managing channels, scoped to the workspace.

### Git providers

**GitHub**
- The manifest: a private app named "Nearzero-<date>-<random>", with read access to contents, metadata and email, write access to pull requests, push and pull request events, and a webhook.
- The organization slug rule (up to 39 characters) and the "View installed GitHub Apps" link.
- "Continue on GitHub" is disabled without a public HTTPS address, with "Configure a domain first." for admins.
- A late install, or one without its state, binds only after GitHub confirms the app owns it.
- Uninstalling or suspending the app marks the provider "Action required".
- Signatures are checked on the raw body. The old GitHub webhook address and the old deploy-webhook addresses are answered after a move.

**GitLab and Gitea:** the internal URL; OAuth with refresh (tokens refreshed a minute before expiry); "Save and connect"; Test connection; a new access-token option.

**Bitbucket:** the API token with the Atlassian email and workspace. Legacy app passwords keep working and are marked "Deprecated".

**Visibility and sharing**
- Owners and admins see every provider. Members see their own, the shared ones and the ones granted to them.
- The provider's owner, and workspace owners and admins, may edit and delete. Only the provider's owner may share, with the two sharing toasts.

**Delete:** the shared warning, and the "I understand" tick with the count of apps and Compose services. Those services keep their repository and show "No Git source".

**Push matching:** by repository id (renames work), by branch or tag, by watch paths (Bitbucket's changed files are fetched), and duplicate deliveries are ignored.

**After connecting:** the person returns to where they started. The connection state is bound to the person, used once, and expires.

### Backups

**Destinations**
- The 8 providers with the same labels and sample endpoints. 1.0 fills in the endpoint and region instead of only showing them as placeholders, and a blank region saves as "auto".
- The fields, the keys hint, "Saved, leave blank to keep", and blank keys keeping the saved ones on edit and on test. Keys never reach the page.
- Test before saving and on the row (a 10-second listing), with the same wording.
- Delete removes the destination's schedules and leaves the files. 1.0 also cancels waiting runs and says how many schedules went.
- Another workspace's destination can't be used.

**Schedules**
- The 4 presets or a custom cron, 03:00 daily by default, on by default.
- Keep blank keeps all, with a minimum of 1. The folder is required.
- File prefixes are `<app>/<folder>/`, and `<app>_<inner service>/<folder>/` for Compose volumes.
- Rows show the state, the schedule in words, the destination, the folder, the Keep value and the last run.

**Dumps**
- Every engine is covered, with libSQL's exception in R3-51. MongoDB may now dump all databases.
- MySQL and MariaDB system databases are refused.

**Runs**
- Keep N prunes only after a successful upload, and only Nearzero's files in that folder.
- A failed step or an empty dump is "Failed". 1.0 also checks that the uploaded size matches.
- Run now returns at once, with a live row and a run log.
- Runs of one schedule never overlap. A run left behind by a stop is marked Failed after a restart, and schedules survive restarts.
- Both backup events are sent on success and failure, for scheduled and manual runs.

**Restore flow**
- Destination and folder, "Find backups", pick a file, type the service's name, and the same warning.
- A live log ending "Restored" or "Restore failed".
- Postgres and libSQL restores now run in one transaction.

**Volumes**
- Discovered from saved mounts, the service's containers, the volumes a Compose file declares, and labels. Never matched by name prefix.
- Stop-while-copying starts the service again even when the copy fails.
- A volume restore stops only this service's containers that use the volume, empties it, unpacks the archive and starts them again, even on failure.
- A volume another service also uses is refused, and so is a volume the service doesn't mount.

**Permissions**
- Choosing a destination needs "Back up to the workspace's destinations".
- Managing destinations needs "Add and remove backup destinations".
- Restore also needs a destination the person can use, as in 0.1.x.

**Redis** now offers volume backups instead of the old dead end.

## How this was checked

- Read both versions' code for every area above: setup scripts, the runner's command handlers, the routes and the console's screens, and the Agent's tools. Each 1.0 gap was confirmed in 1.0's code, not only in its spec.
- 1.0 unit tests run and passing:
  - the runner's tasks and backup suites;
  - the shared analytics, monitoring, tasks and backup rules;
  - the notification and Git-provider suites.
- The control-plane suites that need a database, and every Docker-in-Docker suite, were not run.
- A check against 1.0's own backup file-name rules confirmed that every 0.1.x backup file name is refused (R3-44).
