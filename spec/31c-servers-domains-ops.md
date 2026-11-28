# G3. Servers and operations: parity round 3 (0.1.79 and 1.0)

Reviewer: parity reviewer (dirty side), round 3. Compared: 0.1.79 (the reference behavior) and 1.0 at dac9631, against `spec/` at the same commit. This file describes behavior only.

Scope:
- Servers: add, edit, setup over SSH, validation, the security audit, the DNS card, labels and hostnames, remove, the terminal.
- The Nearzero host; daily Docker cleanup; disk and Docker space reporting.
- SSH keys: generate, import, use.
- Domains: generated and own hostnames, per-server hostnames, path routing, ports, redirects.
- Certificates: automatic and uploaded, renewal, failures and back-off.
- Managed DNS zones and records; router files.
- Tasks, Analytics, Monitoring and alerts.
- Notification channels, test messages, events and message content.
- Backups: destinations, database and volume backups, schedules, retention, restore, Run now.
- Git providers.

Not counted as gaps:
- the deliberate changes in `spec/00-index.md`;
- everything in `spec/27-dropped.md`;
- the owner's decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10;
- the decisions in `spec/30-parity-round-2.md`, including "Decisions, part 2";
- punch-list items marked Done;
- gaps already listed in 30a to 30d.

Skipped because they are still in progress elsewhere: R3-06, R3-07, R3-13, R3-17, R3-18, R3-19, R3-21, R3-22, R3-23, R3-28, R3-29, R3-30, R3-31, R3-33, R3-34, R3-38, R3-43, and 30b R2-13.

The outcome counts, not the mechanism: 1.0 runs plain containers under a per-server runner.

Every 1.0 claim below was checked in 1.0's code, not only in its spec.

## Summary

| Kind | P0 | P1 | P2 |
| --- | --- | --- | --- |
| Still broken (round 2 gaps) | 0 | 1 | 3 |
| New gaps | 0 | 2 | 19 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| R3-03 | P2 | Still broken: a member who can only use SSH keys can't see a saved key's public half | 09 9.7 |
| R3-10 | P2 | Still broken: a server added by hostname loses HTTPS when its name fails to resolve at connect, and never follows a new address | 09 9.2, 10.7 |
| R3-11 | P2 | Still broken: a proxied hostname still gets the turn-off-the-proxy advice and sits under "Needs attention" | 10.4, 10.7 |
| R3-37 | P1 | Still broken: several custom webhook fields still differ from 0.1.x (alert `type`, backup `type` and `databaseName`, missing fields, send time) | 15.2 |
| G3-01 | P1 | Without a domain, remote runners talk to Nearzero unencrypted, and nothing moves them to HTTPS later | 25 D1, 22.5 (spec gap) |
| G3-02 | P2 | SSH hardening sets less, and doesn't check the effective settings | 09 9.3 step 14 (spec gap) |
| G3-03 | P2 | The daily cleanup can delete an image a deploy is about to start | 09 9.4, 14.4 (spec gap) |
| G3-04 | P2 | Builds don't check free disk or repair a missing builder first | 06 6.4, 23.1 (spec gap) |
| G3-05 | P2 | The outdated-runner message points to an "Update runner" button that doesn't exist | 25 D1 |
| G3-06 | P2 | Adding a server also needs "Use the workspace's SSH keys" | 09 9.8 (spec likely wrong) |
| G3-07 | P2 | The server DNS card never collapses when ready, and "Check again" says nothing | 09 9.5 |
| G3-08 | P2 | Server and SSH key wording | 09 9.2, 9.3, 9.6, 9.7, 21.10 |
| G3-09 | P2 | Each router decides certificate holds with its server's own DNS resolver, not public DNS | 10.7 (spec gap) |
| G3-10 | P2 | A managed zone reads "Live" and "Ready" without checking delegation or reachability | 10.8, 18.2 (spec gap) |
| G3-11 | P2 | Zone record values: short targets become top-level names; "@", unquoted CAA and a blank MX priority are refused | 10.8 (spec gap) |
| G3-12 | P2 | "Needs attention" and "Waiting for DNS" pick the wrong rows; an own hostname with no record reads "No record" | 10.4 (spec gap) |
| G3-13 | P2 | A custom Analytics range drops the last minute of its last day | 13.2 (spec gap) |
| G3-14 | P2 | Cron forms 0.1.x ran ("L", "#", "nL", "?") are refused, and the move drops such tasks and backup schedules | 12.2 (spec gap) |
| G3-15 | P2 | No warning that a multi-line container task fails only on its last line | 12.2 (spec gap) |
| G3-16 | P2 | Analytics confirm dialogs ignore whether logging is on | 13.1 |
| G3-17 | P2 | A custom webhook address ending in "/" is called without it | 15.2 (spec gap) |
| G3-18 | P2 | A webhook address that redirects fails with "the connection failed" | 15.2 (spec gap) |
| G3-19 | P2 | Discord messages always post as "Nearzero" | 15.2 (spec gap) |
| G3-20 | P1 | A service's second backup schedule to the same folder is refused, the move drops it, and the kept schedule prunes the other volume's old backups | 17.2, 29 (spec gap) |
| G3-21 | P2 | Moved backup schedules silently run at another hour when the server's time zone isn't UTC | 29, 08 8.3 (spec gap) |

---

## Round 2 gaps: still broken

### R3-03 · P2 · Still broken: a member who can only use SSH keys can't see a key's public half

**Fixed part:** Edit on a saved key now shows its public key read-only, with Copy and "Download public key" (`<name>.pub`).

**What's still wrong:**
- The row menu, and with it Edit, is drawn only for people with "Add and remove SSH keys".
- A member with only "Use the workspace's SSH keys" sees the SSH keys tab, but no screen shows them a key's public half.
- 0.1.x showed Edit, with the public key and its download, to everyone who could see keys.

**Expected:**
- A member with only "Use the workspace's SSH keys" opens a saved key read-only, sees its public key, copies it and downloads `<name>.pub`.
- That member has no Save and no Delete.

**Spec:** 09 9.7.

### R3-10 · P2 · Still broken: a server added by hostname loses HTTPS on one failed lookup

**Fixed part:** a server's public IPv4 is now worked out in this order:
- the "Public IPv4" set under Edit;
- else its address, when that is a public IPv4;
- else what its hostname resolves to, when that is exactly one public IPv4.

Private addresses, names that don't resolve, and names that resolve to several addresses get a message naming the server that points to Servers → Edit. Add domain, managed A records, the DNS card and the router's holds all use that address.

**What's still wrong:**
- The server's router learns its public IPv4 only when its runner connects.
- If the server's own hostname fails to resolve at that moment, the router has no address. Every hostname on that server is then held as "address unknown" until the runner reconnects, which can be days later. Until then:
  - plain HTTP stops redirecting to HTTPS;
  - no certificate is requested or renewed.
- If the server's name later resolves to a new IPv4 and nobody edits the server, the router keeps comparing with the old address. Names pointing at the new one are held as "points elsewhere".
- 0.1.x resolved the server's address at each certificate decision.

**Expected:**
- A server added as `srv.example.com` whose name fails to resolve once while its runner connects keeps its HTTPS redirects and renewals.
- At the next 5-minute check, the router uses the address the name resolves to then, with no reconnect.

**Spec:** 09 9.2, 10.7.

### R3-11 · P2 · Still broken: proxied hostnames still get the wrong advice

**Fixed part:** only "no record" and "points at another address that isn't a known proxy" hold a name. Proxied names, IPv6-only names and failed lookups let Let's Encrypt try. Retry no longer refuses them as "DNS is wrong".

**What's still wrong:**
- A proxied hostname's DNS note still says: "Turn off the DNS proxy for <host> (DNS only): it points at <proxy>, so Let's Encrypt can't reach this server and the proxy's certificate doesn't cover the name."
- It says so even while the certificate is valid and renewing.
- 0.1.x said: "Proxied by X. HTTPS works if X forwards plain HTTP for /.well-known/acme-challenge/ to this server."
- The row is also always listed under "Needs attention" (see G3-12).

**Expected:**
- A hostname behind Cloudflare's proxy with a valid certificate shows "Proxied" with the HTTP-challenge note, not the turn-off-the-proxy advice.
- It isn't under "Needs attention" while HTTPS is valid.

**Spec:** 10.4, 10.7.

### R3-37 · P1 · Still broken: the custom webhook body still differs from 0.1.x

**Fixed part:**
- The body now carries the flat 0.1.x fields beside 1.0's own.
- Deploy messages and the test message match 0.1.x.

**What's still wrong:** these were checked by building the body for each event.

1. **Server alert: `type` and `alertType` are swapped.**
   - 0.1.x: `type` is "CPU" or "Memory", and `alertType` is "server-threshold".
   - 1.0: `type` is "server-threshold", and `alertType` is "CPU" or "Memory".
2. **Database and volume backups: `type` has a new value.**
   - 0.1.x: `type` is "success" or "error", the same as `status`.
   - 1.0: `type` is "database-backup" or "volume-backup".
3. **Database backup: `databaseName` holds the service's name.**
   - 0.1.x: it is the database that was dumped, for example "analytics".
   - 1.0: it is the service's name, for example "pg-main".
4. **Missing or reshaped fields:**
   - Volume backups have no `serviceType` ("application", "compose", "postgres" and so on).
   - Docker cleanup has no `cleanupMessage`. 0.1.x sent "Docker cleanup for Server <name> (<id>)" for servers, and "Docker cleanup for nearzero" for the host.
   - A successful backup has no `errorMessage`. 0.1.x sent "".
   - Deploy succeeded sends `domains` as a list with one address including "https://". 0.1.x sent one comma-separated string of every hostname of the service, without a scheme.
   - `backupSize` is a number or null. 0.1.x sent a string.
   - `applicationType` for MongoDB is "mongodb". 0.1.x sent "mongo".
5. **`timestamp` and `date` are the send time, not the event time.**
   - A retry can be minutes late.
   - A server alert's body doesn't carry the time of the sample.
   - `date` is in UTC words, where 0.1.x used the server's local format.

**Expected:**
- A memory alert body has `type` "Memory" and `alertType` "server-threshold".
- A failed backup of database "analytics" on service "pg-main" has `type` "error", `status` "error" and `databaseName` "analytics".
- A volume backup body has `serviceType`.
- A Docker cleanup body has `cleanupMessage`.
- A deploy succeeded body for a service with hostnames a.example.com and b.example.com has `domains` "a.example.com, b.example.com".
- A server alert body's `timestamp` is the time of the sample that crossed the threshold.

**Spec:** 15.2 and the R3-37 expected line in 30c.

---

## New gaps: servers, SSH keys and the Nearzero host

### G3-01 · P1 · Without a domain, remote runners talk to Nearzero unencrypted

**0.1.x:** everything between the platform and a remote server goes over SSH. It is always encrypted, and the server's identity is checked. No domain is needed for that.

**1.0 now:**
- On an install without a domain, a remote server's runner is set up to reach `http://<public IP>:<API port>`. That port is published on every interface. The runner accepts an `http://` address and connects over an unencrypted WebSocket.
- These cross the internet in plain text, and the runner can't tell it is talking to the real control plane:
  - the join token and the runner's credential;
  - every command, including environment values, Git SSH private keys, database passwords and backup destination keys.
- The runner's control address is written once, at setup. Nothing changes it later. A server set up before the console had a domain keeps using plain HTTP after a domain is configured.
- If the person then blocks ports 3000 and 4321, as spec 22.5 tells them to once HTTPS works, every such runner is cut off.

**Expected:**
- A remote runner never carries credentials or commands over an unencrypted link. Either:
  - setup refuses with a plain message until the console has HTTPS; or
  - the link is encrypted and the control plane's identity is checked some other way.
- Once a domain is configured, existing runners move to the `https://` address without the person running setup again.
- Blocking ports 3000 and 4321 afterwards leaves every server connected.

**Spec:** 25 D1 says the runner's connection is "authenticated, encrypted", and 22.5 says ports 3000 and 4321 are not a public edge. Spec gap: neither says what happens without a domain.

### G3-02 · P2 · SSH hardening does less, and doesn't check the result

**0.1.x:** setup puts a managed block at the top of the SSH settings. Besides key-only sign-in, it sets:
- `AuthenticationMethods publickey`, `MaxAuthTries 3` and `LoginGraceTime 30`;
- agent forwarding off, X11 forwarding off, TCP forwarding local only;
- `GatewayPorts no`, `PermitTunnel no`, `PermitUserEnvironment no` and `ChallengeResponseAuthentication no`.

It then reads the settings that actually apply to the setup user, so that a later Match block can't turn passwords back on. If they aren't key-only, it changes nothing and the step fails.

**1.0 now:**
- Only password sign-in off, keyboard-interactive off, key sign-in on, and root with a key only.
- The applied settings aren't checked. A Match block that turns passwords back on for that user passes as hardened.

**Expected:**
- After setup on a fresh Ubuntu server, the settings that apply to the setup user show:
  - `authenticationmethods publickey`, `maxauthtries 3` and `logingracetime 30`;
  - agent forwarding, X11 forwarding, tunnels, gateway ports and user environment all off.
- A configuration whose Match block turns passwords back on for that user makes step 14 fail, and the old configuration is kept.

**Spec:** 09 9.3 step 14. Spec gap: it lists only key-only sign-in and root with a key.

### G3-03 · P2 · The daily cleanup can delete an image a deploy is about to start

**0.1.x:** each cleanup waits, checking every 10 seconds, until no other Docker command (a build or a pull) is running on that machine.

**1.0 now:**
- At 23:50 the runner removes every unused image at once.
- A deploy pulls or builds its image, then creates the container in a later step.
- A cleanup in between removes the image just pulled or built, and the deploy fails.
- Neither the scheduler nor the runner checks for a deploy in progress.

**Expected:**
- A cleanup due while a deploy or build runs on that server waits until it ends, or keeps the images that deploy uses.
- A deploy started at 23:49:58 succeeds.

**Spec:** 09 9.4, 14.4 (spec gap).

### G3-04 · P2 · Builds don't check the server first

**0.1.x:** before every build, on the host or on a server, the platform checks the build machine:
- It refuses at once with "The build server needs at least 2 GB of free disk space in /tmp."
- It repairs these by itself, logging "Server capability repair started: …":
  - a missing pinned builder (Nixpacks, buildpacks or Railpack);
  - a stopped Docker daemon;
  - a lost Docker group membership.
- So servers pick up new builder versions after an upgrade without running setup again.

**1.0 now:**
- There is no free-disk check. A full disk fails mid-build with the tool's own error.
- A missing builder stops the build with "<tool> is not installed on the build machine. Run setup again on this server's page to install it."

**Expected:**
- A build on a server with under 2 GB free stops before building, with a plain message naming the free space.
- A pinned builder the server lacks is installed, with a log line saying so, and the build goes on.

**Spec:** 06 6.4, 23.1 (spec gap). This overlaps the deploys area.

### G3-05 · P2 · The outdated-runner message names a button that doesn't exist

**0.1.x:** there is no runner. After an upgrade of the control plane, remote servers keep working with nothing to do.

**1.0 now:**
- A runner older than the supported protocol is refused.
- The server's page says: `Update the runner: use "Update runner" on the server's page, or run setup again.`
- No such button exists anywhere in the console, and there is no way to update a runner in place.

**Expected:**
- A refused runner's server page offers "Update runner", which replaces the runner in place and reconnects it without touching workloads.
- Until that exists, the message names only "Run setup again".

**Spec:** 25 D1 ("offers 'Update runner' on the server's page").

### G3-06 · P2 · Adding a server needs "Use the workspace's SSH keys" (spec likely wrong)

**0.1.x:**
- A member whose only server right is "Add and remove servers" can add servers.
- The Add server key list is open to every member. Creating a server checks only that the key belongs to the workspace.

**1.0 now:**
- Create, and Edit when the key changes, also need "Use the workspace's SSH keys".
- A member moved from 0.1.x with "Add and remove servers" alone can't add a server.
- The same member can still set up and delete the servers they were granted.

**Expected:** a member with "Add and remove servers" and no SSH key capability can choose a saved key in Add server and create the server. "Add and remove servers" covers using keys in the server forms.

**Spec:** 09 9.8. The spec's separate key row is likely wrong for the server forms.

### G3-07 · P2 · The server DNS card's states and "Check again"

**0.1.x:**
- **Record in place:** the card collapses to "App addresses are ready / Apps on <server> get their own address under <zone>, with HTTPS set up automatically."
- **Record missing:** the subtitle is "It gives every app on <server> its own address under <zone>, with HTTPS set up automatically."
- "Add it now, while setup runs." shows only in the setup dialog.
- "Check again" ends with one of two toasts:
  - "The record points here. Apps on this server get their own address."
  - "It doesn't point at this server yet. DNS changes can take a few minutes."

**1.0 now:**
- The title is always "Add one DNS record in <provider>".
- The subtitle is always "Add it now, while setup runs.", even in a ready server's details.
- A ready card still shows the table and the steps. Only the badge says "App addresses are ready".
- "Check again" refreshes without saying anything.

**Expected:**
- A server whose record points here shows only "App addresses are ready" and its sentence.
- "Add it now, while setup runs." appears only in the setup dialog.
- "Check again" shows one of the two toasts.

**Spec:** 09 9.5.

### G3-08 · P2 · Server and SSH key wording

| Where | 0.1.x | 1.0 |
| --- | --- | --- |
| Delete dialog, one service | "This server has 1 attached service" | "This server has 1 attached services" |
| Setup failure | toast "Setup failed" | no toast |
| Duplicate name | `A server named "X" already exists. Use another name, or change that server instead.` | `…already exists in this workspace. Pick another name.` |
| Duplicate address | `"X" already uses <address>:<port>. Change that server instead of adding the same machine twice.` | `…Each server needs its own address and port.` |
| Create and update toasts | "Server Created" / "Server Updated" | "Added <name>" / "Server updated" |
| Key download names | `<name>_private_id_ed25519` and `<name>_public_id_ed25519.pub`, or `id_rsa` / `id_ed25519` without a name | `<name>` and `<name>.pub`, or `nearzero-key` |

**Expected:**
- One service reads "1 attached service".
- A failed setup shows an error toast.
- The duplicate name and duplicate address messages use the 0.1.x sentences.

**Spec:** 09 9.2, 9.3, 9.6, 9.7, and 21.10 for keeping 0.1.x wording.

---

## New gaps: domains, certificates and managed DNS

### G3-09 · P2 · The router decides holds from its server's own resolver

**0.1.x:**
- The decision to hold a certificate request looks names up through public resolvers (1.1.1.1 and 8.8.8.8), the way Let's Encrypt sees them.
- It falls back to the system resolver only when public DNS can't be reached.
- Split-horizon or cached local answers never cause a hold.

**1.0 now:**
- The control plane checks DNS through public resolvers, so the Hostnames list and Add domain show "Points here".
- Each server's router decides the hold with that server's own system resolver.
- On some servers the resolver answers differently from public DNS: a cloud private zone for the same domain, a company resolver, or a stale negative cache. There the router keeps the name held as "points elsewhere" or "no record".
- The row then stays at "Queued — DNS points here now. Nearzero asks Let's Encrypt within 5 minutes…" for good.
- Check DNS and Retry can't release it, and HTTP isn't redirected.

**Expected:**
- A server whose local resolver answers a hostname with a private IP, while public DNS points it at the server's public IPv4, gets a Let's Encrypt certificate within 5 minutes.
- The router's hold uses the same public answer the Hostnames list shows.

**Spec:** 10.7 (spec gap: which resolver decides isn't stated).

### G3-10 · P2 · A managed zone counts as ready without being delegated

**0.1.x:** the About Nearzero step for the managed zone reads "Ready" only when all three hold:
- the zone is published;
- public DNS returns the expected nameservers for it;
- the host's public IPv4 answers an SOA query on port 53.

Otherwise it reads "Delegation pending" or "Publishing", with the note "Published means CoreDNS has the zone file. Ready additionally requires public NS delegation and a direct authoritative SOA response."

It lists reasons, such as:
- "Public NS differs from Nearzero: …"
- "Public resolvers do not return NS records for this zone yet"
- "Authoritative SOA check failed: …"

It also shows "Delegate the zone to <ns1> <ns2>" and "Create glue/host A records for each nameserver at <ip>."

**1.0 now:**
- Zone health only asks the built-in DNS server, over Docker's internal network, whether it serves the applied serial.
- A zone shows "Live / Serving N records", and the About checklist counts it as ready, even when:
  - it was never delegated at the registrar; or
  - its port 53 is blocked from the internet.
- Nothing checks public NS records or reaches port 53 from outside.
- The delegation text doesn't mention glue records when the nameservers are inside the zone.

**Expected:**
- A zone that is applied but not delegated shows a not-ready state, such as "Delegation pending", with the nameservers public DNS returns. This applies both on About Nearzero and on the DNS zones tab.
- It becomes ready only once public DNS delegates it and the host answers SOA on its public address.
- With nameservers inside the zone, the instructions say to create glue records at the registrar pointing at the host's IPv4.

**Spec:** 10.8 (Health) and 18.2 (the checklist). Spec gap: "ready" isn't defined.

### G3-11 · P2 · Zone record values are read differently

**0.1.x:** in the Records dialog:
- A CNAME, MX or NS value without a dot (for example "mail") means a name inside the zone (`mail.<zone>`).
- "@" means the zone apex, so "www CNAME @" and "MX 10 mail" work.
- A CAA value can be written with or without quotes, for example `0 issue letsencrypt.org`.
- A blank MX priority means 10.

**1.0 now:**
- A one-word value is accepted but published as a top-level name: "mail" becomes `mail.`, the "mail" top-level domain. Mail or the alias silently goes nowhere.
- "@" is refused with "A CNAME record needs a hostname, like target.example.net."
- An unquoted CAA value is refused with 'Write a CAA record as flags, tag and a quoted value, like 0 issue "letsencrypt.org".'
- A blank MX priority is refused with "Enter the MX priority, a number from 0 to 65535."

**Expected:** in zone `example.com`:
- "www CNAME @" serves `www.example.com CNAME example.com.`
- "MX mail" with the priority left blank serves `example.com MX 10 mail.example.com.`
- `0 issue letsencrypt.org` saves as a CAA record.

At the very least, a one-word value is refused with a message instead of being published as a top-level name.

**Spec:** 10.8 (spec gap: how values are read isn't stated).

### G3-12 · P2 · The Hostnames filters and the "No record" label

**0.1.x:**
- "Needs attention" holds:
  - rows whose HTTPS state is an error or a warning;
  - connected rows whose DNS points elsewhere.
- "Waiting for DNS" holds rows whose certificate is waiting for DNS or queued.
- A connected hostname with no DNS record reads "Waiting for DNS". Only an unconnected one reads "No record".

**1.0 now:**
- Any hostname whose DNS reads Proxied, IPv6 only or Lookup failed is under "Needs attention", even with a valid certificate. That includes a proxied site serving fine, and any row after one failed lookup.
- Unconnected hostnames with no record are listed under "Waiting for DNS".
- A person's own connected hostname with no record reads "No record". Only Nearzero-assigned ones read "Waiting for DNS".

**Expected:**
- A connected own hostname with no A record reads "Waiting for DNS".
- An unconnected one reads "No record" and isn't under "Waiting for DNS".
- A proxied, or once-unresolved, hostname with a valid certificate isn't under "Needs attention".

**Spec:** 10.4 (spec gap: the filter rules aren't written).

---

## New gaps: tasks and Analytics

### G3-13 · P2 · A custom Analytics range drops its last minute

**0.1.x:** picking From and To days covers 00:00:00 of the first day through 23:59:59.999 of the last day.

**1.0 now:**
- Picking days sets the end to 23:59:00 of the last day.
- Requests between 23:59:00 and 23:59:59 that day are left out of the stats, the chart, Busiest hosts and the table.

**Expected:** with From and To on the same day, a request logged at 23:59:30 that day (in the browser's time) is counted and listed.

**Spec:** 13.2 (spec gap: whether the end is inclusive isn't stated).

### G3-14 · P2 · Cron forms 0.1.x ran are refused, and the move drops them

**0.1.x:** the schedule check accepts, and the scheduler runs:
- "L" for the last day of the month (`0 0 L * *`);
- "#" for the nth weekday (`0 9 * * 1#1`, the first Monday);
- "nL" for the last given weekday (`0 9 * * 5L`, the last Friday);
- "?" in a day field.

**1.0 now:**
- The task form refuses them, for example `"1#1" isn't a valid day of week.` and `"L" isn't a valid day of month.`
- The backup schedule form refuses them the same way.
- The move doesn't import a 0.1.x task or backup schedule that uses them: "its schedule (…) isn't one 1.0 can read."

**Expected:** one of:
- `0 0 L * *` saves and next runs on the month's last day, `0 9 * * 1#1` saves and runs on the first Monday, and a moved task or backup schedule using either keeps running on that rhythm; or
- spec 12.2 lists the accepted cron syntax, and the move report names each such task or schedule with the plain reason and a 5-field equivalent where one exists.

**Spec:** 12.2 ("a 5-field cron"), 29 (spec gap).

### G3-15 · P2 · No multi-line warning for container tasks

**0.1.x:** a task in a container whose command has several lines gets this warning: "It runs as one shell command; lines run one after another and the task fails only if the last one does. Join them with && to stop at the first failure."

**1.0 now:**
- Container tasks still run the script as one shell command, so an early line that fails doesn't fail the run.
- The checks give only the null-byte, size, empty-script and shebang notes, plus the syntax verdict.
- Nothing warns about this, so "Save anyway" is never prompted for it.

**Expected:**
- "Check and save" on a container task with a two-line command shows that warning and turns the button into "Save anyway".
- Server and host scripts don't get it.

**Spec:** 12.2 (Checks; spec gap).

### G3-16 · P2 · Analytics confirm dialogs ignore whether logging is on

**0.1.x:**
- "Delete all request logs?" ends with one of two sentences, depending on the state:
  - "Request logging stays on, so new requests show up again right away."
  - "Request logging stays off."
- "Turn off request logging?" adds "Requests already recorded stay until the next cleanup."

**1.0 now:**
- The delete dialog always says "Recording goes on with the next request.", even while logging is off.
- The turn-off dialog has only the router-restart sentence.

**Expected:**
- With logging off, the delete confirm says logging stays off and promises no new requests.
- The turn-off confirm says recorded requests stay until the next cleanup.

**Spec:** 13.1.

---

## New gaps: notifications

### G3-17 · P2 · A custom webhook address ending in "/" loses it

**0.1.x:** the endpoint is called exactly as typed.

**1.0 now:**
- Saving, testing or moving a channel removes every trailing "/" from its URL. For example, "https://hooks.zapier.com/hooks/catch/123/abc/" is stored and called as ".../abc".
- Receivers that answer only on the address with the slash return an error or a redirect, and 1.0 then fails the delivery (see G3-18).
- Channels moved from 0.1.x are changed the same way.

**Expected:**
- A custom webhook saved as "https://example.com/hook/" is shown with its slash and posted to "https://example.com/hook/".
- Gotify and ntfy server addresses may still be trimmed.

**Spec:** 15.2 (spec gap).

### G3-18 · P2 · A redirecting webhook address fails with a misleading reason

**0.1.x:** deliveries follow redirects.

**1.0 now:**
- Every channel refuses redirects. That fits the private-address protection, so the refusal itself isn't the gap.
- The gap is the reason shown in the test result and on the channel's row: "couldn't reach <host> (the connection failed)".

**Expected:**
- Testing a custom webhook whose URL answers 301 or 308 shows "Test failed: <host> answered with a redirect …; use the final address."
- A failed delivery shows the same reason in "Last delivery failed: …".

**Spec:** 15.2 (spec gap).

### G3-19 · P2 · Discord messages always post as "Nearzero"

**0.1.x:** Discord messages post under the name the person gave the webhook in Discord.

**1.0 now:** every Discord message sets the sender name to "Nearzero", replacing the webhook's own name. That includes the test message and messages with Decoration off.

**Expected:** a Discord webhook named "Deploy Bot" in Discord shows "Deploy Bot" as the sender of Nearzero's messages.

**Spec:** 15.2 (spec gap).

---

## New gaps: backups

### G3-20 · P1 · Two schedules of one service in the same folder: refused, dropped by the move, and pruned across volumes

**0.1.x:**
- A service can have several backup schedules on the same destination and folder. For example, an app with volumes `data` and `uploads` backs both up nightly to the folder "nightly".
- Volume files carry the volume's name (`data-<time>.tar`, `uploads-<time>.tar`), and each schedule's Keep N counts only its own volume's files.

**1.0 now:**
- A service may have only one schedule per folder on a destination. A second one is refused with "Another backup schedule of this service already writes to this folder on this destination. Pick another folder."
- The move does the same, but not in plain words. The second 0.1.x schedule isn't imported, and the move report says only that the database refused the record, naming an internal rule.
- The schedule that was imported is marked as owning the 0.1.x files in its folder. For volumes, its Keep N then counts every 0.1.x volume file in that folder, not only its own volume's.
- So after the move, the first nightly run of the `data` schedule (Keep 7) deletes the older 0.1.x backups of `uploads` together with older ones of `data`. The `uploads` schedule no longer exists to make new ones.

**Expected:**
- After importing a 0.1.x app with two volume schedules on the same destination and folder:
  - both schedules exist in 1.0 and keep running;
  - each schedule's Keep N prunes only its own volume's files, old and new.
- In 1.0, two volume schedules of one service may share a folder on a destination, or the form explains the rule and offers a folder.
- If the move can't keep a schedule, the report names it, its service and its folder in plain words. The schedule that was kept never prunes another volume's 0.1.x files.

**Spec:** 17.2 ("prunes older files of that schedule"), 29. Spec gap: neither covers schedules that share a folder.

### G3-21 · P2 · Moved backup schedules shift by the server's time-zone offset

**0.1.x:** backup schedules have no time zone. They run in UTC, the zone the bundle records as "null means the server's (UTC)".

**1.0 now:**
- Backup schedules run in the server's time zone, as spec 08 8.3 says.
- The move reports a change of time only when the 0.1.x schedule named a zone.
- A schedule with no zone keeps its cron unchanged. On a server whose zone isn't UTC, for example Asia/Kolkata, "0 3 * * *" moves from 03:00 UTC to 03:00 local time (21:30 UTC the day before), and nothing says so.

**Expected:** after importing a 0.1.x backup schedule "0 3 * * *" onto a server in Asia/Kolkata, one of these holds:
- the schedule still runs at 03:00 UTC, with its cron translated and the form showing the local time; or
- the move report says that it now runs at 03:00 Asia/Kolkata instead of 03:00 UTC.

**Spec:** 29 and 29a.5.17 (spec gap).

---

## Round 2 gaps verified fixed

Each was checked in 1.0's code, including the edge cases named.

**Servers and SSH keys**
- **R3-01:** a member who adds a server gets a grant to it, through the console and through the Agent's add-server action. They see it, set it up and delete it, also when "Add and remove servers" comes from a policy.
- **R3-02:** every package install, on every distribution path, waits up to 5 minutes for another package job. The log says: "Another package job is running (a fresh server often runs its automatic updates first); waiting up to 5 minutes for it to finish." Installs are tried 3 times, 10 seconds apart ("… failed (attempt N/3); retrying in 10s..."). Downloads and the bash bootstrap are retried too.
- **R3-04:** the daily cleanup removes all unused images and all unused build cache. It also empties the Railpack builder's cache on the host and on servers, and "space freed" includes it.
- **R3-05:**
  - A changed host key offers "Forget host key and run setup again", and details has "Forget host key".
  - Changing the address or port forgets the old key and says so.
  - Setup and the terminal record the new key on the next connection.
- **R3-08:** the refusal and the menu tooltip name every server, in the plural: "This SSH key is attached to servers: A, B. Remove those servers first."
- **R3-09:** servers are listed newest first, by name when added at the same time.

**Domains, certificates and DNS**
- **R3-12:** the install zone, and any zone of the first workspace that covers the console's hostname, gets a managed A record for the console. It is created on connect, on a nameserver save, at the check cycle, and when Configure public domain is saved. A person's own A, AAAA or CNAME record at that name is left alone.
- **R3-14:** every typed name at or under the platform domain is refused with "<host> is reserved for Nearzero itself. Pick another hostname." That covers server-label names and anything below them, in preview, Add and the Agent. Generated names still work.
- **R3-15:** a typed managed-zone hostname is refused before anything is saved when an A, AAAA or CNAME record already uses the name. The message names that record. Automatic names move to "-2". The Records dialog refuses a person's record beside a managed A record.
- **R3-16:** Cloudflare, Fastly, Bunny CDN and Arvancloud are recognized and shown as "Proxied" with the provider's name.
- **R3-20:** deleting a server deletes its hostnames, their managed records (zones republished) and its uploaded certificates. Deleting an upload while its server is offline removes it at once, and the router drops it when the runner reconnects.
- **R3-24:** TTLs from 1 to 2,147,483,647 seconds are accepted in the API and in the console's field. A blank TTL is 300.
- **R3-25:** spec 20.6 and the Agent's add-hostname step take only service, hostname, port, path and Compose service.

**Tasks, Analytics and Monitoring**
- **R3-26:** console routes are left out of the request log, including its HTTP redirect, the runner gateway and the routes About Nearzero writes. Entries for the console's hostname are dropped when counting, so older lines never count. The Agent's polling and Git-host webhooks use that hostname too. The IP address never passes the router.
- **R3-27:** each busiest host shows its count, plus "· N err" when it has 4xx or 5xx answers.
- **R3-32:** with a search or filter set, the empty state reads "Try adjusting your search or filters.", and Add task is offered only on an unfiltered empty list.
- **R3-35:** every channel kind's server alert carries a "Time" fact taken from the sample, as "YYYY-MM-DD HH:MM:SS UTC", and Discord's embed time is the sample's. The custom webhook's `timestamp` field is covered by R3-37.

**Git providers**
- **R3-36:**
  - A 0.1.x webhook added by hand keeps deploying through its old address, matched by branch and watch paths. Pushes naming another repository are ignored.
  - The move report and the Source panel ask for "Register webhook". After that, unsigned calls are refused.
- **R3-39:**
  - A push whose head commit message contains "[skip ci]", "[ci skip]", "[no ci]", "[skip actions]" or "[actions skip]" doesn't deploy, in any letter case, from every Git host (0.1.x checked GitHub only).
  - The answer says why: "The head commit's message contains [skip ci], so this push doesn't deploy."
- **R3-40:** "Group name" takes a comma-separated list, with spaces and blanks dropped. Each group's projects and subgroups are listed once, and a missing group is named on its own. Search runs at GitLab.
- **R3-41:**
  - 0.1.x's GitHub setup return and GitLab and Gitea callback addresses on the console redirect, with their query, to 1.0's pages.
  - A moved GitLab or Gitea connection keeps the redirect address its OAuth application was registered with, for Authorize, the token exchange and refreshes, and keeps it through edits.
- **R3-42:** Install, and the step right after the app is created, open GitHub's install page on the owning account or organization.

**Backups**
- **R3-44:**
  - 0.1.x file names are listed with 1.0's, newest first:
    - times with milliseconds and "Z";
    - `.bson.gz` for MongoDB;
    - `<volume>-<time>.tar` for volumes;
    - files straight under the app name for folderless schedules.
  - Restores read each file's content: Postgres archives, MySQL dumps that name no database, libSQL data-folder archives and plain tar volume archives.
  - A moved schedule's Keep N counts its 0.1.x files. G3-20 covers the case of a shared folder.
- **R3-45:**
  - The confirm step has "Restore into database", filled with the database the backup was dumped from. A database that doesn't exist yet is made.
  - The sentence above the confirm field names the database.
  - MongoDB renames into the chosen database. A backup of every database restores every database.
- **R3-46:** each schedule row has Restore, filled with that schedule's destination, folder and database or volume.
- **R3-47:** backup messages name the project, environment and service, then the database type and database, or the volume. They also give the destination, the result, and the size or reason.
- **R3-48:** runs that stop a service, and restores, are one at a time per service, whichever schedule they come from. The next one starts when the running one ends.
- **R3-49:** a workspace with no server of its own tests a destination from the Nearzero host, for endpoints on the public internet, pinned to the address checked.
- **R3-50:** database dumps stream through gzip straight into the bucket. Restores stream out of it after one full read checks the file. Volume restores say at once how much free disk they need.
- **R3-51:** libSQL with namespaces backs up its whole data folder, with the database stopped, and restores by unpacking it. The 512 MB limit for SQL dumps is stated in the dialog.
- **R3-52:**
  - A restore into a volume the service mounts but the server doesn't have yet creates it, with the service's labels.
  - The schedule form's folder starts as "nightly", and the restore dialog falls back to "nightly".

## Checked and found at parity

1.0 is equal or better unless a gap above says otherwise. Round 2's at-parity list in 30c still holds. This round also checked:

**Servers**
- **Setup flow:**
  - 15 numbered steps with per-step time limits, and the bash bootstrap;
  - the port 80 and 443 check (a moved server's 0.1.x router is stopped by the move first);
  - rclone and its plugins checked by checksum; Snap and rootless Docker refused; swap sizing;
  - firewall rules for ufw, firewalld and iptables, with the cloud-firewall reminder;
  - Docker group membership; SSH rolled back after a failed new sign-in;
  - the stalled-run retry, and two attempts across a restart; secrets cut from the log;
  - each failure kind with its button: use user, trust key, forget key, run again.
- **Details:** a ready server's details offer "Run setup again", which 0.1.x didn't.
- **Delete:** teardown runs in the background with a result per service, and the server is kept if any service stays. The runner and its credential are removed over SSH, best effort. Hostnames, uploaded certificates, routes, metrics and cleanup records go with the server.
- **Daily cleanup:**
  - It runs at 23:50 in each server's own time zone, with a one-hour late window, once per local day, with 3 tries.
  - The details switch shows the last result and the next run.
  - The event says how much space was freed, which 0.1.x never did.
- **SSH keys:**
  - RSA 4096 and ED25519 generated on the server.
  - Mismatched pairs and passphrase-protected keys are refused.
  - Private keys are sealed and never returned.
  - Git over SSH pins each app's host key on first use.

**Domains and certificates**
- **Route shape:** path routing is a prefix match with no stripping, and HTTP to HTTPS is a permanent redirect.
- **Own domains:** an own domain must point at the server before it is added, with the 10-second lookup limit.
- **Moves:** moving a managed-zone hostname to another server moves its record and republishes the zone. A failed route write puts the old route back.
- **Removal:** Remove and Disconnect work while the server is offline, and the router syncs on reconnect.
- **Certificates:**
  - Renewal starts 30 days before expiry.
  - The background check runs 1 minute after start, then every 5 minutes, on both sides.
  - Failure history is kept across restarts.
  - An uploaded pair must match, and the router takes it before anything is saved.
- **Zones:**
  - Nested zones of another workspace are refused.
  - In-zone nameservers get glue A records, and the serial rises with every change.
  - Record names allow `*` and `_`.
  - TXT values may hold several quoted strings.
  - The DNS server answers over TCP and UDP.
- **Add domain dialog:** DNS and HTTPS polling every 8 seconds, with "Still working on it…".

**Tasks**
- **Syntax check:** run by the place's own shell, better than 0.1.x's check on the control plane.
- **Time zones:** IANA zones, including Etc/GMT±N.
- **Cron:**
  - weekday 7, and month and day names;
  - day of month or weekday, either one matching;
  - next runs across daylight-saving changes.
- **Audit:** create, update, delete, run and stop are audited.
- **Stopping runs:** Stop works in containers too (0.1.x stopped only host and server runs). Deleting a task stops its runs.
- **Manual runs:** a manual Run while one is going answers 409.
- **Logs:** a run keeps its last 1,000 lines, up to 256 KB.

**Analytics**
- **Logging:** turned on once at upgrade.
- **Records:** the User-Agent and Referer headers, and the status the client got.
- **Cleanup:** a failed cleanup is recorded and the next one is still booked.

**Monitoring**
- **Memory:** total minus available, as in 0.1.x.
- **System information:** the same, plus the host name and Docker version.
- **Retention:** 2 days, pruned hourly, and deleted with the server.
- **Alerts:**
  - 3 samples in a row, then 30 minutes of quiet unless the value drops;
  - samples older than 5 minutes when they arrive never fire;
  - 0.1.x alerted on every sample above the threshold.
- **Test alert:** says how many channels it reached.
- **Container metrics:** 0.1.x collected them but nothing showed them.

**Notifications**
- **Channel kinds:** all 12, with the same fields, labels, priority ranges and defaults:
  - Gotify 5, ntfy 3 on ntfy.sh, Pushover 0, SMTP 587;
  - Pushover's retry (at least 30) and expire (1 to 10,800) for priority 2;
  - Telegram threads, and the Decoration switch.
- **SMTP:** sign-in is optional (0.1.x required it). Port 465 uses TLS from the start; other ports use STARTTLS.
- **Secrets:**
  - Saved secrets are never returned to the page.
  - Blank fields keep the saved values.
  - Changing where a channel sends asks for its secrets again (0.1.x dropped saved headers silently).
- **Refusals:** refusals hidden in a successful answer are caught for Telegram, Lark, Pushover and Resend.
- **Events:**
  - Deploy succeeded and failed for apps, Compose and databases, first deploys and redeploys. A cancelled deploy sends nothing.
  - Backups send on success and failure, scheduled or manual.
  - Docker cleanup and server alerts go to the server's workspace, and the host's to the first workspace.
  - "Nearzero restart" is offered only in the first workspace.
- **Delivery:** one message per event per channel; retries after 15 seconds, 1 minute and 4 minutes; "Last delivery failed" on the row; records kept 30 days.
- **Message content:** no secrets in reasons.
- **Audit:** creating, editing and deleting a channel are audited.

**Git providers**
- **Branches:** listed with the default branch first, then by name. The branch field is free text with suggestions, so more than 200 branches never blocks a choice. 0.1.x listed all branches; 1.0 suggests up to 200.
- **GitLab:**
  - repository search runs at GitLab;
  - a token that can't be refreshed says "GitLab ended this connection's authorization. Choose Reconnect in Settings → Git providers.";
  - parallel reads near a token's expiry share one refresh.
- **Bitbucket:**
  - The workspace filter limits listing to that workspace. Without one, the account's workspaces are listed, newest-updated repositories first.
  - A token without the account scope still works with a workspace name.
- **GitHub:**
  - Ping is answered, and installation events mark the provider "Action required".
  - A delivery that failed answers 500 and deploys when GitHub sends it again.
  - New tags deploy services set to deploy on tags.

**Backups**
- **Destinations:**
  - The 8 providers keep the same labels and sample endpoints, map to the same storage provider names, and never try to create the bucket.
  - Test lists the bucket with a 10-second limit.
  - Keys are written into a file inside the helper, never on a command line.
- **Runs:**
  - The first failing step stops the run and is named.
  - An empty dump fails the run.
  - A partial upload is removed on failure.
  - Containers stopped for a copy start again even when stopping a later one failed.
  - A run left behind by a stop is marked Failed after a restart.
  - Each service keeps its newest 100 runs.
- **Keep N:** prunes only files its own schedule wrote, so destinations sharing a bucket never prune each other (0.1.x pruned every matching file in the folder). A failed prune is reported.
- **MySQL and MariaDB:** their system databases are refused, as dump targets and as restore targets.
- **Volumes:**
  - Only a service's own volumes are listed.
  - Nearzero's own volumes, another service's volumes, and a Compose file's external or foreign-named volumes are refused, with the reason.

## How this was checked

- Read both versions' code for every area above:
  - setup scripts, the runner's command handlers and router;
  - the control plane's routes, jobs and schedulers;
  - the console's screens, the notification senders and message builders;
  - the backup helpers, the Git host clients, and the move's import rules.
- Every 1.0 claim was confirmed in 1.0's code, not only in its spec.
- 1.0 unit tests run and passing:
  - the shared setup-rules suite;
  - the shared domains, tasks, analytics, monitoring and notification-rules suites;
  - the runner's router suite;
  - the control plane's domain-rules suite.
- Control-plane suites that need a database, and every Docker-in-Docker suite, were not run.
