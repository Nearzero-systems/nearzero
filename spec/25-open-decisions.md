# 25. Open decisions

Each decision has options, tradeoffs and a recommendation. The owner decides; the build plan assumes the recommendations until told otherwise.

## D1. How the control plane drives servers

Nearzero runs on one server (the control plane) and deploys onto that server and others. 1.0 must choose how the control plane talks to them.

### Option A: everything over SSH, nothing installed but Docker and the router

The control plane keeps an SSH key per server and runs every action (setup, build, deploy, logs, terminal, metrics collection, backups) as remote commands.

| For | Against |
| --- | --- |
| Nothing to install, sign or upgrade on servers beyond Docker and the router | The control plane holds root-equivalent keys for every server; one compromise reaches them all |
| Works with any Linux that has SSH and bash | Long log streams and terminals over SSH are fragile; a dropped connection loses state |
| Easy to reason about: every action is a script | Servers behind NAT or without inbound SSH cannot be used |
| Existing installs already work this way | Metrics and live status need polling; every action pays a connection setup |
| | Shell differences between distributions (busybox, missing GNU flags, login shells) keep producing bugs |

### Option B: a small runner on every server

Setup installs one signed binary (the runner) on each server, including the control-plane host. The runner opens an outbound, authenticated, encrypted connection to the control plane and keeps it open. It executes deploy plans locally, streams logs and terminals, reports container state and metrics, and runs backups and tasks.

| For | Against |
| --- | --- |
| Works behind NAT and without inbound SSH after setup | A binary to build for two architectures, sign, distribute and upgrade |
| No long-lived SSH key needed after setup; each runner has its own revocable credential | Version skew between control plane and runners must be handled |
| Real-time status, logs, terminals and metrics over one channel; reconnects resume streams | More moving parts on every server |
| Deploys, backups and tasks keep running if the control plane restarts | Still needs a bootstrap path (SSH or a pasted join command) |
| One code path for the host and remote servers ("the host is just another server") | |

### Option C: SSH to bootstrap, runner for everything after (hybrid)

Adding a server works as today (SSH address, user, key, setup). Setup installs the runner, which then takes over. SSH stays available as a break-glass path for re-setup and for repairing a runner that stopped reporting.

| For | Against |
| --- | --- |
| Keeps today's "add a server over SSH" experience and lets existing servers migrate in place | Two paths to maintain (SSH for setup and repair, runner for the rest) |
| Gains everything in option B for day-to-day work | |
| A person can also add a server by running a one-line join command on it, with no SSH access from the control plane | |

**Recommendation: C.** It keeps the setup flow people know, lets 0.1.x servers move over by re-running setup, and fixes the classes of bugs that came from running long work over SSH. The control-plane host runs the same runner, so there is one deploy path. Runner and control plane speak a versioned protocol; the control plane refuses work for a runner older than the supported window and offers "Update runner" on the server's page. Until that button exists, the refusal names only "Run setup again" (31c G3-05).

**How the link is encrypted (built, spec 31 "Remote runners are always encrypted", 31c G3-01).** The runner's connection is authenticated by its credential and always encrypted, with the control plane's identity checked, with or without a domain:
- Without a domain, the control plane serves the runner link on its own TLS port (3443, `NEARZERO_RUNNER_LINK_PORT`) with a self-signed certificate it makes at the first start of the install and keeps in its own volume, across restarts, upgrades and reruns. Setup writes the certificate's SHA-256 fingerprint into the runner's settings and the join command carries it (`--fingerprint sha256:…`); the runner accepts only that certificate at that address, and checks it before sending its credential.
- Once the console's hostname (from the install or About Nearzero) has a valid certificate on the host's router, every connected remote runner is told the `https://<hostname>` address in its welcome and moves there without setup; it keeps the address beside its credential. A runner that can't use the domain stays on the TLS port, isn't cut off to retry it, and checks it in the background with a request alone, moving once it answers. Blocking ports 3000 and 4321 then leaves every server connected.
- Every remote runner knows the TLS port with its fingerprint as its fallback, also when setup or the join command gave it the domain: setup writes both, and every welcome carries the pinned address. When the address it uses stops answering, the runner tries the fallback.
- Every request the runner makes, the WebSocket and the plain requests (the credential check, enrolling, downloads), goes over a connection whose certificate it has checked before writing a single byte: at a pinned address only that certificate, whoever signed it; by name only a public authority's certificate for exactly that host name, and never an IP address without a fingerprint.
- No remote runner ever connects to, falls back to or follows a move to a plain `http://` or unpinned address (1.0 is unreleased, so no server depends on one). A runner whose only address is plain refuses to connect, and one that reaches the control plane over plain HTTP anyway is refused and gets no work; its server's page says to run setup again. A move is followed only to `https://<the console's domain>` with a publicly valid certificate whose hostname is checked, or to the pinned TLS port with its fingerprint. The Nearzero host's runner stays on the host's private network (`http://nearzero-control:3000`).
- The link certificate is replaced in two steps (`sudo nearzero runner-link rotate`, then `switch`): the control plane gives every server the new fingerprint over its current link first, and the switch refuses while a server lacks it. The newest pin the control plane or setup gave wins: a runner never accepts a replaced fingerprint again, from its settings or anywhere else, and setup run again replaces what the runner kept. The replaced key is removed once every server has reconnected, or after 7 days. A certificate whose key is missing stops the TLS port rather than being made again.
- Across a runner restart, a command the runner had acknowledged is reported lost, never started again (C2-01); docs/runner-protocol.md has the details.

### Sub-decision D1.1: orchestration on each server

| Option | Notes |
| --- | --- |
| Single-node Swarm per server (current behavior) | Gives rolling updates, restart policies and service abstraction; adds Swarm's quirks (tag re-resolution on every task start, 30s default start windows, opaque failures) |
| Plain Docker Engine plus the runner as supervisor | Simpler failure modes; the runner implements start-first rollout, health waits and restarts |

**Recommendation:** plain Docker Engine with the runner supervising, because multi-node clustering is not offered in the console (see [27-dropped.md](27-dropped.md)) and every deploy reliability bug fixed in 0.1.x came from Swarm behavior. Keep the rollout rule: a new version only replaces the old one after it is healthy.

### Sub-decision D1.2: state stores

Today the control plane uses Postgres and Redis. **Recommendation:** Postgres only, with the job queue in Postgres, to cut one service from every install and one failure mode from upgrades. Keep "external database" support for people who run their own Postgres.

## D2. License for future paid parts

The core stays Apache 2.0. If paid features come later, they need a license that lets people read the source but stops others from selling them as a competing service.

| Option | What it allows | What it forbids | Notes |
| --- | --- | --- | --- |
| Functional Source License (FSL-1.1, Apache 2.0 future license) | Reading, modifying, self-hosting for internal use, non-competing commercial use | Offering the software as a competing product or service | Each release converts to Apache 2.0 two years after it ships, which reads as good faith to an open-source audience |
| Elastic License 2.0 | Use, modify, redistribute | Providing it as a managed service; working around license keys; removing notices | Permanent; well known and simple; no conversion to open source |
| Business Source License 1.1 | Like FSL, with a configurable "additional use grant" and change date | Production use beyond the grant until the change date | More knobs, more room for confusion |

**Recommendation:** FSL-1.1 with Apache 2.0 as the future license, for paid parts only, kept in their own clearly named top-level directory and package so the boundary is obvious from the repository layout. Have a lawyer confirm the choice, the wording of the boundary, and the contribution terms (DCO sign-off for the Apache core; a contributor agreement only if paid parts accept outside contributions).

Rules regardless of the choice:
- The `LICENSE` file at the root stays the plain Apache 2.0 text. A preamble that mixes licenses into that file stops code hosts from detecting the license.
- Paid parts carry their own license file in their own directory.
- Public copy never calls a source-available part "open source".

## D3. How 0.1.x installs move to 1.0

Existing installs hold users, workspaces, projects, running apps and databases with live data. 1.0 is a new codebase with a new data model.

### Option A: in-place import by the 1.0 installer

Running the 1.0 install command on a 0.1.x server detects the old install, reads its database directly, writes the new data model, and adopts the running containers, volumes and certificates without redeploying.

- For: one command, the same experience as every previous upgrade.
- Against: 1.0 must understand the old database layout forever, and that layout was never designed as an interface.

### Option B: export bundle from a final 0.1.x release, import into 1.0

A last 0.1.x release adds `nearzero export`, which writes a documented, versioned bundle (all records plus secrets, encrypted with a passphrase the person chooses). The 1.0 installer offers `nearzero import <bundle>` and, when it finds a 0.1.x install on the same server, runs export and import for the person.

- For: the bundle format is a small, testable contract; 1.0 never reads the old database; the same bundle supports moving to a new server.
- Against: needs one more 0.1.x release; people on older 0.1.x versions must upgrade to that release first.

### Option C: side by side

Install 1.0 next to 0.1.x on other ports, import, check, then switch the router over.

- For: instant fallback.
- Against: two routers cannot both own ports 80 and 443; doubles resource use; confusing.

**Recommendation: B, run in place by the 1.0 installer.** The bundle format and import rules are in [29-migration.md](29-migration.md); because 1.0 drops Swarm, services are redeployed onto the 1.0 runner with their volumes, hostnames and certificates kept (one brief restart each), rather than adopted as they run. Flow:
1. The installer finds a 0.1.x install, checks it is on the final 0.1.x release (or tells the person the one command to get there), and stops if it is not.
2. It runs export, then a dry-run import that prints what will move, what will not, and any conflicts. Nothing changes until the person confirms.
3. It stops the 0.1.x control plane (apps keep running), imports, starts 1.0, adopts running workloads by their names and labels, and re-checks every server.
4. The old control-plane data stays on disk, stopped, with a printed command to roll back until the person runs `nearzero migrate finalize`.

What must carry over, with no redeploy and no new certificates:
- Accounts with password hashes and two-factor secrets, so nobody resets a password.
- Workspaces, members, roles, access policies, pending invitations, workspace email and model-provider keys.
- Projects, environments, services with every setting, the links between a service's copies across environments, shared and per-service variables.
- Servers, their per-server hostname labels, SSH keys (private keys included) and setup state.
- Domains and generated hostnames exactly as they are, certificates and the certificate account, managed DNS zones.
- Database passwords, public ports, volume names, so data and connection URLs stay valid.
- Git providers (including GitHub App credentials and installations), deploy webhook URLs (so existing webhooks keep working), push-deploy settings.
- Backup destinations, schedules and retention; volume backup schedules; tasks with scripts and schedules; notification channels.
- Agent policies, Agent sessions and messages. (Personal API keys are not carried; see 27 and 29a.)
- Optional, on by default: the last 50 deployments per service with logs. Not moved: request analytics history.

Encrypted secrets are decrypted with the old key during export and re-encrypted with the 1.0 key during import; the bundle itself is encrypted with the person's passphrase.

## D5. The 1.0 technology stack (decided for the build, 2026-11-25)

Chosen so the product keeps its look and behavior while every structural layer is new (see [28-clean-room.md](28-clean-room.md) 28.3). The owner can overturn any line; the build follows this table until then.

| Layer | Choice | Why |
| --- | --- | --- |
| Language | TypeScript everywhere | One language for console, control plane, runner, installer helpers and tests |
| Runtime and tooling | Bun (runtime, package manager, test runner, bundler) | Fast installs and tests; compiles the runner to a single binary |
| Console | Astro (server-rendered pages) with React only for highly interactive parts (the Agent chat, editors), Tailwind for styling | Keeps the console's look and its fast, mostly server-rendered pages |
| Control-plane API | A small HTTP framework (Hono) serving JSON under `/api/v1`, with request and response schemas validated at the edge (zod) | Plain, documentable HTTP; the same API serves the console, the Agent and a later public API |
| Live updates | Server-sent events for logs, deploy progress and the Agent; WebSocket only for terminals | Survives proxies; simple to resume |
| Data | PostgreSQL, accessed with a typed SQL query builder (Kysely), schema changes as numbered, hand-written SQL migrations | Explicit SQL, no generated schema mirror |
| Jobs and schedules | A job table in PostgreSQL claimed with row locks, plus a cron parser, inside the control plane | No Redis, no separate scheduler service (decision D1.2) |
| Auth | Own small module: argon2id password hashes, opaque session tokens stored hashed, TOTP per RFC 6238 with backup codes | Few dependencies; exactly the behavior in [04](04-identity-and-access.md) |
| Per-server runner | TypeScript compiled with Bun to one binary per architecture (linux x64 and arm64); connects outbound over an authenticated WebSocket; talks to the Docker Engine API on the local socket; collects metrics itself | Decision D1 option C; no separate monitoring service |
| Containers | Plain Docker Engine and the Docker Compose plugin; no Swarm | Decision D1.1 |
| Router | Traefik v3 with its file provider, written by the runner | The certificate behavior in [10](10-domains-and-certificates.md) is defined in its terms |
| Builders | Railpack, Nixpacks, Cloud Native Buildpacks (`pack`), Dockerfile with BuildKit, a static file server image | The builder list in [06](06-applications.md) 6.4 |
| Backups | rclone for S3-compatible storage, called by the runner | Works with every listed provider |
| Model provider | OpenRouter's OpenAI-compatible HTTP API, called directly | [19](19-agent.md) 19.10 |
| Lint and format | Biome | One tool, fast |
| End-to-end tests | Bun test runner driving real installs in Docker-in-Docker hosts and real VMs, browser checks with Playwright | [26](26-build-plan.md) 26.3 |

Repository layout (new):

```
apps/console     the web console
apps/control     the control-plane API, jobs, Agent
runner           the per-server runner
packages/shared  types and schemas shared by console, control and runner
installer        install.sh, uninstall.sh and the nearzero command
e2e              end-to-end suites
provenance       clean-room records and scan reports
spec             this specification
```

## D4. Smaller decisions the owner should confirm

| Decision | Options | Recommendation |
| --- | --- | --- |
| Public HTTP API in 1.0 | (a) none beyond deploy webhooks; (b) a documented, versioned REST API with personal API keys covering projects, services, deploys and logs | (a) for 1.0, since nobody can use today's API keys or REST layer (see 27-dropped). Keep the console's own API clean and permission-checked so (b) can ship in 1.1 |
| A `nearzero` command for app deploys from a laptop | Build one, or not in 1.0 | Not in 1.0; the server command stays server-only |
| Rollbacks | Build "redeploy this previous version" on the Deployments list, or keep dropped | Keep dropped for 1.0 (a failed build already never replaces the running version). Have builds produce versioned images so "Redeploy this version" is cheap in 1.1 |
| Templates catalog | Build, or keep dropped | Keep dropped for 1.0 |
| Model providers for the Agent | OpenRouter only, or also direct provider keys | OpenRouter only in 1.0, behind a provider interface so direct keys can follow |
| Email delivery for invitations | Resend only, or also SMTP | Add SMTP alongside Resend; many self-hosters already have SMTP |
| Invitation sign-up email check | Trust the invited address, or verify it | Verify: the invitee must open the link sent to that address (closes a known gap, see 24) |
| Compose and containers on the control-plane host by any workspace | Allow, or restrict | Restrict to instance administrators unless they allow a workspace explicitly (closes a known gap, see 24) |
| Agent sessions: shared or private | Shared by the whole workspace (today), or private to their author with an explicit share | Private by default with "Share with workspace"; tool results are always filtered by the viewer's access (closes G6 in 24) |
| Update check | Remove, or implement | Implement: the console shows "Update available" from a signed release feed; no other data leaves the server |
| Usage telemetry | None, opt-in, opt-out | None in 1.0 (the owner declined a tracker) |
