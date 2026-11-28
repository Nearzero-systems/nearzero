# Architecture

How Nearzero 1.0 is put together. Everything here is derived from [`spec/`](spec/00-index.md), mainly the stack decision D5 and the server decision D1 in [`spec/25-open-decisions.md`](spec/25-open-decisions.md). Sections marked **(M0)** exist in the code today; the rest is the design later milestones fill in.

## The pieces

```
 browser ──HTTP──▶ console (Astro, :4321) ──fixed internal address──▶ control plane (Hono on Bun, :3000)
                                                                        │   ├─ JSON API under /api/v1
                                                                        │   ├─ job worker + schedules
                                                                        │   ├─ the Agent
                                                                        │   └─ runner gateway (WebSocket)
                                                                        ▼
                                                                   PostgreSQL (data, jobs, events)
                                                                        ▲
 every server, the control-plane host included:                        │ outbound, authenticated
   runner (one binary) ──talks to──▶ local Docker Engine + Traefik ────┘ WebSocket
```

| Folder | What lives there |
| --- | --- |
| `apps/control` | The control plane: HTTP API, data access, migrations, jobs, and later auth, the Agent and the runner gateway |
| `apps/console` | The web console: server-rendered Astro pages, Tailwind, React only for highly interactive parts |
| `runner` | The per-server runner, compiled to one binary per architecture |
| `packages/shared` | The product version, the API error shape, request and response schemas, configuration schemas |
| `installer` | `install.sh`, `uninstall.sh` and the `nearzero` server command (from M1) |
| `e2e` | End-to-end suites; their work folders (`e2e/.work`) hold throwaway secrets and never reach an image |

## Control plane

**(M0)** `apps/control/src` is split by concern:

| Module | Role |
| --- | --- |
| `main.ts` | Start order: read settings → update the database → start the job worker → serve HTTP. Any problem before serving stops the start with a message that says what to fix. Stops cleanly on SIGTERM. |
| `config.ts` | Reads settings from the environment through the shared schema. Production refuses to start without a generated authentication secret; outside production a missing one is replaced by a random secret that lasts until the process stops. There is never a built-in default. |
| `app.ts`, `http/` | The Hono app. Every request gets a request id, a logger carrying it, and one access-log line. Errors are turned into the standard error body in one place. |
| `db/` | Kysely over node-postgres, the table types, and the migration runner. |
| `jobs/` | The job queue, the worker, the catalog of job kinds and the sample `maintenance.prune-finished-jobs` job. |
| `log.ts` | Structured JSON logs with secret-looking fields redacted. |

Later milestones add modules beside these, one per area of the spec: identity and sessions, workspaces and access, projects and services, deployments, servers and the runner gateway, domains, backups, tasks, notifications, analytics and the Agent. Each area owns its routes, its queries and its job kinds. Route handlers stay thin: they validate input with zod, call the area's functions, and return JSON. The Agent calls the same functions (see Permissions).

### Database and migrations **(M0)**

PostgreSQL is the only state store (D1.2). Queries go through Kysely, so SQL stays explicit and typed; the table types in `db/schema.ts` are written by hand next to the migrations.

Schema changes are numbered, hand-written SQL files in `apps/control/migrations` (`0001_job_queue.sql`, …). At every start the runner:

1. reads the folder and refuses misnamed files or two files with one number;
2. creates its own record table, `applied_migration`, if missing;
3. refuses to start if the database has a migration this version doesn't know (it was upgraded by a newer version) or if an applied file's checksum changed (migrations are forward-only);
4. applies each pending file in number order, each in its own transaction together with its record row, so a failing file changes nothing and the start stops with the file's name and the database's message.

Several control-plane processes can start at once: each migration's transaction takes a PostgreSQL advisory lock and re-checks whether the file was applied meanwhile.

### When PostgreSQL restarts

The control plane outlives its database restarting or crashing (spec 23.2): every pooled connection has an error listener, so a connection the server drops is reported and replaced instead of stopping the process, and a promise or exception that is only a lost connection is logged, not fatal (`db/resilience.ts`). Meanwhile `/api/v1/health` answers 503 `degraded`, requests that need the database fail with the standard error, and the job worker backs off and resumes; jobs that were running get their leases back through recovery. A start waits for the database to answer (growing pauses, up to `NEARZERO_DATABASE_WAIT_SECONDS`) before it updates it, and stops at once on a real migration problem. `e2e/control/db-restart.e2e.ts` restarts and kills PostgreSQL under load to check this.

### Jobs **(M0)**

Anything long (builds, deploys, server setup, backups, restores, task runs, pruning) is a job, so the request that starts it returns at once with something to follow (spec 23.1).

- **Table.** One `job` row per piece of work: kind, JSON payload, state (`queued`, `running`, `succeeded`, `failed`), attempts and attempt limit, when it may run, lease owner and expiry, last error, timestamps.
- **Lanes.** Each job kind runs on one lane group: scheduler ticks and housekeeping on their own two lanes, deploys on their own (`NEARZERO_DEPLOY_CONCURRENCY`, 4), and each kind of long work (backups and restores, task runs, server setups, deletes, Docker cleanups, and the rest such as a 0.1.x move) on lanes of its own, `NEARZERO_JOB_CONCURRENCY` (4) each, so no kind of long work can hold up another, a tick or a push (spec 23.2, R4-03). The idle lanes of a group take turns asking the database, so more lanes don't mean more polling. A server runs one build at a time unless `NEARZERO_BUILDS_PER_SERVER` says more; only deploys that build count (apps from Git or an upload, Compose stacks with a build step), so Reload, database deploys, image-only deploys and Make public or Make private start at once (31b G2-05). A build waiting for its server stays queued, says so in its log, and frees its lane meanwhile. A keeper books every schedule's next job at start and every 5 minutes (`jobs/schedules.ts`), so daily and hourly clean-ups never depend on a restart.
- **Claiming.** A worker claims the oldest due job of the kinds it knows with an `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`. Locked rows are skipped, so any number of workers in any number of processes never take the same job. Unknown kinds (written by a newer version) wait instead of failing.
- **Leases.** A claimed job holds a lease, renewed while it runs. If its process dies, the lease runs out and recovery puts the job back (or marks it failed when its attempts are used up). Jobs therefore run at least once, and handlers are written to be safe to repeat. A worker that lost its lease can't record a result.
- **Retries.** A failed attempt goes back to the queue after a backoff (5 s, doubling, at most 10 minutes) until the kind's attempt limit. A `PermanentJobError`, or a payload that no longer fits the kind's schema, fails at once.
- **Idempotency.** Enqueueing with a key that is already used returns the existing job, so a client or proxy retry never starts the same work twice.
- **Time.** All times come from the database clock, so processes never disagree about what is due.

Schedules (backups, tasks, cleanup, certificate checks) will use a cron parser inside the control plane that enqueues jobs with idempotency keys made from the schedule and its due time. Because the key is unique, a schedule fires once even when several processes evaluate it, which keeps "background schedules run in exactly one place" (spec 23.2) without a separate scheduler service.

Each job that a person starts gets a log they can open where they started it (spec 23.8): log lines are rows tied to the job's subject (a deployment, a task run, a backup run), streamed as described below.

## Live updates

Logs, deploy progress, setup progress and the Agent's answers reach the browser as server-sent events; only terminals use WebSockets (D5).

1. Whatever produces events (a job, a runner message, the Agent) appends them to a table with a per-stream sequence number, then sends a PostgreSQL `NOTIFY` naming the stream.
2. Each control-plane process holds one `LISTEN` connection and wakes the SSE responses subscribed to that stream.
3. A client opens `GET /api/v1/…/events`, which first checks access (spec 22.4, rule 2), then replays stored events after the client's `Last-Event-ID`, then follows live ones. A dropped connection resumes exactly where it stopped, and nothing depends on which process served it.
4. Headers go out at once and a keep-alive comment goes out at least every 15 seconds. The control plane's idle timeout (120 s) and the console proxy, whose timeout covers only the wait for response headers, never cut a quiet stream (spec 23.2).

## Console

**(M0)** Astro renders pages on the server with the standalone Node adapter, run by Bun. Tailwind provides styling; the design system (three themes, tokens, fonts) arrives in M2.

- Pages fetch data on the server from the control plane at one fixed internal address (`NEARZERO_CONTROL_URL`, default `http://127.0.0.1:3000`), never from an address derived from the request or forwarded headers (spec 22.4, rule 5).
- Browser code calls `/api/v1/…` on the console, which streams the request to the control plane and the answer back. It drops forwarded and per-connection headers, passes the request id, and answers with the standard error body when the control plane is unreachable or slow to start answering.
- Terminals are the one WebSocket the browser opens. The console accepts upgrades under `/api/v1/` and bridges them frame by frame to the same path on the control plane (`apps/console/src/lib/socket-bridge.ts`, using the Bun runtime's own `ws`). The dev server attaches it from an integration hook; the production build adds one call where the Node adapter's standalone server creates its HTTP server (`astro.config.ts`), and the build stops if that spot moves.
- React is used only where a page is highly interactive (the Agent chat, editors).
- The console works over plain HTTP on an IP address: no browser crypto or UUID APIs, copy buttons with a fallback, POST-only credential forms (spec 21.9).

## Runner

**(M0)** `bun run build` compiles `runner/` for linux x64 and arm64 (glibc and musl) and writes `SHA256SUMS`.

**(M3a)** The runner connects, joins with a one-time token, carries out commands against the Docker Engine API (images, containers, logs, exec with a TTY, networks, volumes, prune; Compose and BuildKit through the Docker CLI), keeps the router and the private network running, writes route files with the certificate hold, and reports container state and metrics every 5 seconds. The protocol, resume rules and router files are in [`docs/runner-protocol.md`](docs/runner-protocol.md); the control plane's side is `apps/control/src/runners/` (hub, gateway, credentials) with servers, SSH keys and routes beside it ([`docs/api/servers.md`](docs/api/servers.md)). On the Nearzero host the runner is the `runner` service in `installer/compose.yml`, from the same image, and owns `nearzero-router`. **(M6)** Remote servers are set up over SSH from `apps/control/src/server-setup/` ([`docs/api/server-setup.md`](docs/api/server-setup.md)): fifteen numbered steps install Docker, the runner (as a system service, joined with a one-time token) and the builders, then the runner takes over.

Design (D1 option C):

- **Bootstrap.** Adding a server works over SSH as people expect: setup installs Docker, the router and the runner binary, and gives the runner its own credential (random, stored hashed by the control plane, readable only by root on the server, revocable). A one-line join command is the alternative for servers the control plane can't reach over SSH. SSH stays available for repair and re-setup.
- **Connection.** The runner dials out to the control plane over an authenticated WebSocket and keeps the connection open, reconnecting with backoff. Servers behind NAT work, and no long-lived SSH session is needed.
- **Protocol.** The first message carries the runner's version and protocol version. The control plane refuses work for runners older than its supported window, and the server's page says to run setup again, which updates the runner (an in-place "Update runner" is still to come, 31c G3-05).
- **Work.** The control plane sends work orders (a deploy plan, a backup, a task run, a terminal) with ids; the runner acknowledges, carries them out locally against the Docker Engine API on its socket, writes the router's file-provider configuration, and streams progress, log lines, container state and metrics back with sequence numbers. Work keeps running if the control plane restarts; on reconnect the runner resumes each stream from the last sequence the control plane stored.
- **One path.** The control-plane host runs the same runner, so the host is just another server.

The control-plane side is a runner gateway module: it authenticates connections, tracks which runner serves which server, and lets jobs send a work order and wait on its events while their lease is renewed. In M3a one control-plane process holds the runner connections and follows streams in memory; spreading them over several processes would route them through PostgreSQL's NOTIFY as in Live updates above.

## Shared package

**(M0)** `packages/shared` holds what the console, the control plane and the runner must agree on: the product version (`1.0.0-dev`, reported by `/api/v1/health` and every log), the API error shape and codes, request-id rules, response schemas, and the control plane's configuration schema. Later it gains the request and response schemas of every endpoint and the runner protocol's message schemas, so both ends validate the same shapes.

## Errors

**(M0)** Every error response has one shape:

```json
{ "error": { "code": "conflict", "message": "A project named web already exists. Pick another name.", "fields": { "name": "…" }, "reference": "req_k3m9x2p7q4wz" } }
```

- `code` is a stable machine code (`invalid_request`, `unauthenticated`, `forbidden`, `not_found`, `conflict`, `rate_limited`, `internal`, …) with a fixed HTTP status. Clients accept codes they don't know yet.
- `message` is written for people and names the cause and the next step (spec 01, principle 4). Handlers throw `AppError` with such a message.
- Anything else becomes `internal` with a message that carries the request id as a reference; the full error is logged with the same id, never sent to the browser (spec 23.8).
- Messages never contain secrets; logs redact fields whose names look like secrets.

## Permissions

Designed from [`spec/22-security-and-permissions.md`](spec/22-security-and-permissions.md); built in M1 and M9.

- An authentication middleware resolves the session to a person, their active workspace and their membership (owner, admin or member), capabilities and access policies. Instance administrators are owners and admins of the first workspace.
- Every query for a workspace object is scoped to the active workspace in the query itself, so another workspace's object is simply not found (rule 1).
- A member's reach is the union of direct grants and policies. Something a person can't see answers `not_found`, exactly like something that doesn't exist (rule 3); something they can see but not change answers `forbidden` with what they would need.
- The Agent acts through the same area functions with the asking person's identity, plus the workspace's Agent policies; it has no private path (spec 01, principle 1).
- Every endpoint is tested allowed, refused without the capability, and refused across workspaces.

## Configuration and secrets

**(M0)** The control plane reads `NEARZERO_ENV` (production by default), `DATABASE_URL`, `NEARZERO_AUTH_SECRET`, `NEARZERO_CONTROL_PORT`, `NEARZERO_MANAGEMENT_BIND_ADDRESS`, `NEARZERO_LOG_LEVEL`, `NEARZERO_JOB_CONCURRENCY`, `NEARZERO_DEPLOY_CONCURRENCY`, `NEARZERO_BUILDS_PER_SERVER`, `NEARZERO_JOB_POLL_INTERVAL_MS` and `NEARZERO_DATABASE_WAIT_SECONDS` (how long a start waits for PostgreSQL, 120 by default), and reports every problem at once without repeating secret values. Secrets stored later (keys, tokens, passwords) are encrypted at rest with a per-install key and never returned to the browser (spec 23.4).

## Testing

- Unit tests (`bun test`) cover rules that are easy to get wrong; database tests run against real PostgreSQL in throwaway databases.
- `bun run test:e2e` builds what it tests and drives it from outside. From M1 the harness also creates throwaway Docker-in-Docker hosts and real VMs (spec 26.3).
- CI runs lint, typecheck, unit tests, the end-to-end smoke run and the build on every pull request, and checks commit sign-offs.
