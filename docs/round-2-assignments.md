# Round 2: who fixes what

Sources:
- **Parity gaps:** [spec 30](../spec/30-parity-round-2.md), files 30a to 30d. Each gap's "Expected 1.0" line is spec.
- **Bug reports:** the round 2 clean bug reports B1 (control plane and API), B2 (runner and installer) and B3 (console and Agent), kept outside this repository. These are clean-room reports on 1.0's own code.

Every item has exactly one owner. Fix the critical (P0) items first, then P1, then P2. An item marked "needs a check" is confirmed or ruled out by its owner, with the result noted.

## W1: identity, access, the Agent and the console

Owns the control plane's identity, sessions, workspaces, members, policies and email code, the Agent (backend and React island), request-level security (origin checks, rate limits, error handling), and console pages not listed under W2 or W3.

- 30a: R1-01 to R1-10
- 30c: R3-25 (the Agent's hostname inputs; see 20.6)
- 30d: R4-01, R4-04, R4-05, R4-06, R4-07, R4-08, R4-09, R4-16
- B1: 21, 22, 23, 24, 25, 26, 27, 28, 36, 50, 51, 55, 56, 57, 58, 63, 65
- B3: 01, 02, 06, 07, 08, 09, 10, 11, 12, 15, 16, 17, 18, 19, 20, 24, 27, 28
- B3-13 and B3-14 (spec 21.9b brand kit): built on the `brand` branch, which lands on main first. Check them after merging main.

Migrations: numbers 0700 to 0739.

## W2: apps, Compose, databases, deploys, builds, variables, deploy webhooks and backups

Owns the deploy pipeline, the Compose runtime and its checks, the service runtime, variables, deploy and push webhook handling, backups and restore (control plane and runner), the runner's builds, and the console's service pages (application, Compose, database, new application).

- 30b: R2-01 to R2-16, except R2-13 and R2-15 (W3)
- 30c: R3-36, R3-39, R3-44 to R3-52
- 30d: R4-12, R4-13
- B1: 01, 02, 03, 05, 06, 07, 08, 09, 19, 29, 30, 31, 32, 33, 34, 37, 38, 39, 40, 42, 52, 61
- B2: 01, 06, 14, 15, 17, 18, 19, 21, 22
- B3: 04, 05, 21, 22, 25, 26, 29

Migrations: numbers 0740 to 0779.

## W3: servers, SSH keys, domains, DNS, certificates, the router, tasks, analytics, monitoring, notifications, Git providers, background jobs, the installer and the `nearzero` command

Owns server setup, servers and SSH keys, hostnames, DNS zones, certificates and the router (control plane and runner), tasks, analytics, monitoring, notification channels, Git provider connections and callbacks, the job queue and schedulers, the installer, uninstaller and `nearzero` command, and the console pages for those areas.

- 30b: R2-13, R2-15
- 30c: R3-01 to R3-35, R3-37, R3-38, R3-40 to R3-43, except R3-25 (W1)
- 30d: R4-02, R4-03, R4-10, R4-11, R4-14, R4-15
- B1: 04, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 35, 41, 43, 44, 45, 46, 47, 48, 49, 53, 54, 59, 60, 62, 64
- B2: 02, 03, 04, 05, 07, 08, 09, 10, 11, 12, 13, 16, 20, 23 to 38
- B3: 03, 23

Migrations: numbers 0780 to 0819.

## Decisions for items that asked for one

- **B1-33, shared variables:**
  - Anyone who can see an environment can see the names of its shared variables.
  - Seeing values and editing need the same capability as editing a service's variables, held for the whole environment.
- **B1-56, Agent and production:** while production changes are off, services the Agent creates are not copied into production.
- **B1-63 and 30a R1-02, email changes:**
  - A changed email address must be confirmed by a link sent to the new address before it counts.
  - Until then the old address stays in use.
  - Accounts moved from 0.1.x count as confirmed.
- **Job lanes** (30b R2-15, 30d R4-03, B1-12, B1-13, B2-20):
  - Deploys get their own worker lane.
  - Schedules run on their own timers and never wait behind jobs.
  - A control plane restart resumes or cleanly reports in-flight work instead of cancelling it on every server.

## W4: what W3 left (2026-11-28)

W3's branch is on main. These items were left open, some waiting on a decision that [spec 30](../spec/30-parity-round-2.md) "Decisions, part 2" now gives.

- 30b: R2-13
- 30c: R3-06, R3-07, R3-13, R3-17, R3-18, R3-19, R3-21, R3-22, R3-23, R3-28, R3-29, R3-30, R3-31, R3-33, R3-34, R3-38, R3-43
- B1-15, the remaining hole: a workspace with a connected runner could still set its server's public IPv4 to another workspace's server's address.
- 30a R1-07: the two-factor toast.

Migrations: numbers 0820 to 0859.
