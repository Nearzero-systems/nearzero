# 23. Non-functional requirements

## 23.1 Reliability of deploys

| Requirement | Detail |
| --- | --- |
| A failed build changes nothing for visitors | The build finishes before anything running is touched. If it fails, the current version keeps serving. |
| New versions replace old ones only when healthy | A new container must start and stay up through a stability window before the old one stops. The window starts when the container is actually running, not when it was requested, so slow pulls never cut it short. Databases get up to 120 seconds to start; apps get a configurable window with a sensible default. |
| A crash is shown, not hidden | When the new version exits or fails its health check, the deploy log ends with the container's last output and the deploy is marked failed. A failure is never reported as success. |
| Pushes are never lost | A push that arrives while a deploy is waiting replaces the waiting one; a push that arrives during a running deploy queues one more deploy after it. |
| Long work outlives requests | Builds, deploys, server setup, backups, restores, task runs and "run now" actions run in the background. The request that started them returns at once with something to follow (a deployment or run with a live log). No action runs twice because a proxy or client retried after a timeout. |
| Scripts are safe to feed on standard input | Any script the platform sends to a server must not have steps that read standard input, or later steps get swallowed and the script "succeeds" having done nothing (this silently broke every database backup once). Each step's success is checked. |
| Tools are checked before use | A build that needs a tool the build machine lacks stops at once with "X is not installed on the build machine", instead of failing obscurely halfway. |
| Teardown is complete | Deleting a service or project removes its containers, images, folders, volumes (when asked), routes and hostnames from whichever server it ran on. A delete that cannot reach the server fails visibly and can be retried; it never leaves running orphans while reporting success. A workspace that still has projects cannot be deleted. |
| Version in every log | Every deployment log starts with "Initializing deployment (Nearzero <version>)", and the health endpoint reports the version, so a support question always starts from the right version. |

## 23.2 Reliability of the control plane

- Each server's runner checks the router when it starts and every minute after, and recreates it if needed, so hostnames work even before any management hostname exists and a stopped router comes back on its own.
- Startup refuses to run in production without a generated authentication secret; there is no built-in default secret.
- Background schedules (backups, tasks, cleanup, certificate checks) run in exactly one place. Enabling an optional worker must never double-schedule jobs.
- Every kind of long work has job lanes of its own: deploys, backups and restores, task runs, server setups, deletes, and the daily cleanups. No kind can use up the lanes another kind needs, so while 4 task runs of 30 minutes are running a database backup due that minute starts within a minute, and while 4 server setups are running a task due that minute does too (31d R4-03; raising one shared count isn't the fix). Scheduler ticks have lanes of their own as well. `NEARZERO_JOB_CONCURRENCY` is the lane count of each long-work kind (4), `NEARZERO_DEPLOY_CONCURRENCY` that of deploys (4).
- Database queries that load a service never load columns they do not need; any relation loaded with a service names its fields (an unbounded load once exceeded the database's argument limit and broke task and backup editing everywhere).
- The console proxy's timeout covers the time to first byte only, so the Agent's streams and long log streams are never cut; streaming responses send a keep-alive at least every 15 seconds.
- Retrying a request on another address happens only when the connection never opened.

## 23.3 Upgrades

- Upgrading is "run the install command again". It keeps settings, data, accounts and passwords, and only asks questions that have no saved answer yet.
- Upgrades never stop running apps or databases. Only the control plane restarts.
- Database changes are forward-only, versioned, and run automatically at start. A failed migration stops the start with a clear message and leaves the previous data untouched.
- A release is published only when every image it needs exists for both architectures and the installer's checksum matches.
- Each release's installer is also kept at a versioned address, so a person can pin and verify a version.
- Settings that changed meaning between versions are migrated once and marked done, so an administrator's later choice is never overwritten (for example, request logging was turned on by default once, and anyone who later turned it off keeps it off).
- 0.1.x installs move to 1.0 by the migration in decision D3 ([25-open-decisions.md](25-open-decisions.md)).

## 23.4 Secrets

1. **Secrets never reach the model.** Values entered in the Agent's secure forms (environment variables, SSH private keys, task scripts, provider keys) go straight from the browser to the platform. The model is told only names, ids and outcomes. Stored conversation messages never contain the values. A test inserts known secrets through every form and searches every stored message and every model request for them.
2. **Secrets are encrypted at rest** with a per-install key: model-provider keys, research keys, email keys, Git provider tokens and app private keys, SSH private keys, backup destination keys, database passwords, notification tokens and webhook secrets.
3. **Secrets are never sent back to the browser** after they are saved. Pages show them masked (with who saved them and when). Editing a record with a blank secret field keeps the saved value. Database passwords are the one exception: "Show password" reveals them to people who can manage that database.
4. **Secrets never appear in URLs**, query strings, logs, error messages or notification bodies. Webhook URLs are the exception by design: they carry a token, are treated as secrets, are shown only to people with deploy rights on the service, and can be replaced, which stops the old URL at once.
5. **Secrets the installer generates** (database password, authentication secret) are random per install, written with owner-only file permissions, and never printed except the admin password when the installer generated it in unattended mode.
6. Public API responses for services strip every private field (tokens, keys, refresh tokens) through one shared filter, tested against every service type.

## 23.5 Performance

| Measure | Target |
| --- | --- |
| In-app page change on a warm cache | Content visible in under 300ms on the control-plane host's own network |
| Any dashboard page cold | Under 2 seconds on a 2 vCPU, 4 GB server with 20 projects |
| Agent first token | Under 3 seconds after the model starts answering; the "Thinking" line shows within 200ms of sending |
| Log streaming delay | Under 1 second from a container writing a line to the console showing it |
| Analytics page | Reads at most the last 32 MB of the request log; loads in under 2 seconds |
| Control-plane footprint | Runs, with no apps, in under 1.5 GB of memory |

**Long actions** (31d G4-13, the decision in 31): the console waits for the first byte of an answer 30 seconds, except for actions whose control-plane route answers only once its work is done and may take longer. For those it waits a little longer than the route's own limit: a backup destination's Test connection (up to 180 seconds), the restore file list (120), a server's Check again (the SSH sign-in, then up to 120), the security audit (the SSH sign-in, then 60), Analytics reads of a large request log (up to 60 per piece) and Delete all request logs (60). The 30-second message ("The Nearzero API didn't answer within 30 seconds…") stays only for routes that end within 30 seconds.

## 23.6 Compatibility

- Control-plane and app servers: current Ubuntu LTS and Debian, Fedora, RHEL-family, Amazon Linux, and Alpine-based images; amd64 and arm64.
- Servers set up as root or as a non-root user with passwordless sudo.
- Browsers: current Chrome, Safari, Firefox and Edge, on desktop and phone; plain HTTP on an IP address (see [21-design-system.md](21-design-system.md) 21.9).

## 23.7 Accessibility

- Every control is reachable and operable by keyboard; focus is always visible.
- Dialogs trap focus and return it on close; Escape closes them.
- Icons that act as buttons have labels.
- Text contrast meets 4.5:1 for body text in all three themes (2.6:1 is the automated floor that blocks a release; 4.5:1 is the goal).
- Reduced motion turns off every animation.

## 23.8 Observability of the product itself

- The control plane writes structured logs with request ids; `sudo nearzero logs` shows them.
- Every background job writes a log a person can open from where they started it.
- Errors shown to people are their own words, never "Internal server error" when the cause is known. Unknown errors show a short reference that matches a line in the server log.

## 23.9 Privacy

- No usage telemetry. The only outbound calls are ones the person configured: model provider, research provider, Git hosts, email provider, backup storage, notification channels, certificate authority, public DNS lookups for checks, and (if decision D4 is accepted) a release feed for the update check.
- The Agent uses only the workspace's own keys. Keys set in the server environment are not used for the Agent.
