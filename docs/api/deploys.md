# Deploys, runtime and databases API (M3c)

The deploy engine for applications and databases: sources (public Git over HTTPS, Git over SSH with a saved deploy key, an uploaded .zip, a container image), builders (automatic, Dockerfile, Railpack, Nixpacks, Heroku and Paketo buildpacks, static), the deploy pipeline and queue, deployment records and their live logs, Start / Stop / Reload, runtime logs, terminals, ports and mounts, the six databases' runtime and connection details, deploy webhooks, and teardown through the runner. Implements spec 05 5.4 (copies take their group's source), 05 5.5 (variables at deploy), 06 (all), 08 8.1–8.2, 11 (all), 22.3–22.4 (G11), 23.1, 23.4, 24 (G4, P7), 25 D1.1, D5.

Conventions (errors, cookies, `Cache-Control: no-store`) are those of [identity.md](identity.md); ids, the `"host"` server id and the permission words are those of [projects.md](projects.md). Request schemas and the pure helpers are in `packages/shared/src/deploys.ts` (zod) and `packages/shared/src/deploy-rules.ts` (browser-safe, also exported from `@nearzero/shared/browser`): statuses and labels, `parseGitUrl`, `normalizeBuildPath`, `branchProblem`, `databaseConnectionUrl`, `maskedConnectionUrl`, `firstFailureLine`, builder lists, port rules.

## Who may do what

| Action | Needs (members: on the service) |
| --- | --- |
| See deployments, their logs and live streams, runtime logs, containers | Access to the service (`service.deployments`); a removed service's rows: owners and admins |
| Deploy, redeploy, cancel, start, stop, reload, terminal, see the webhook URL | Deploy rights (`service.deploy`) |
| Change source, builder, ports, mounts, deploy settings, create or replace the webhook, Make public / private | Configure rights (`service.configure`, "Create services"); replacing the webhook also needs deploy rights |
| Use a saved SSH key for a Git source | "Use the workspace's SSH keys" |
| Connection details (URLs with the password masked) | Access to the service |
| Show the database password (`connection/reveal`) | Variable rights on the service (as "Show password") |

Per-service logs, containers and terminals follow the service's own rights above (a member with deploy rights on their service may open its terminal), never server-level rights; the server endpoints in servers.md stay for server administrators. Something a person can't see answers `not_found` (like something that doesn't exist); something they see but can't change answers `forbidden` naming what they'd need. The terminal is checked before the shell starts (G11).

## Shapes

```ts
type DeploymentStatus = "queued" | "building" | "active" | "previous" | "not_running" | "failed" | "cancelled" | "removed";
// Labels (DEPLOYMENT_STATUS_LABELS): Queued, Building, Active, Previous version, Not running, Failed, Cancelled, Removed.
type DeployTrigger = "push" | "webhook" | "manual" | "agent";

interface DeploymentView {
  id: string; status: DeploymentStatus; statusLabel: string; trigger: DeployTrigger;
  title: string;                       // the commit subject once known, else "Manual deployment", "Webhook deploy", "Make public"…
  commit: string | null; shortCommit: string | null;
  service: { id: string | null; name: string; kind: ServiceKind; kindLabel: string; type: "application" | "compose" | "database" };
  project: { id: string | null; name: string };
  environment: { id: string | null; name: string };
  server: { id: string; name: string };            // id "host" and name "Nearzero host" for the host
  source: { type?: "git" | "image" | "upload"; provider?: string | null; repository?: string | null; branch?: string | null; path?: string | null };
  builder: string | null;              // dockerfile, railpack, nixpacks, heroku, paketo, static, image
  framework: string | null;            // detected (Next.js, Express, Django…), for the canvas's "Framework"
  image: string | null; error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  durationMs: number | null;           // while building: so far ("… so far")
  running: boolean;
  log: { lines: number; bytes: number; truncated: boolean };
  can: { cancel: boolean; redeploy: boolean };
}
```

**Service views** (`GET /services/:id` and `GET /environments/:id/services`, from projects.md) carry each service's deploy result, so the canvas can show only services whose last deploy succeeded:

```ts
interface ServiceDeploySummary {
  last: { id; status: DeploymentStatus; statusLabel; succeeded: boolean; title; commit; shortCommit; finishedAt } | null;
  // the newest finished deployment; cancelled ones don't count; succeeded is false only for "failed"
  inProgress: { id; status: "queued" | "building" } | null;   // building wins over the one waiting behind it
}
// ServiceView & { deploy: ServiceDeploySummary }
```

Rows outlive their service: deleting a service marks its rows `removed` (service id `null`, names kept) and they are pruned after 30 days. Each service keeps its newest 50 deployments with their logs. Deleting a server deletes its rows.

## Deploying (spec 6.2, 6.5, 8.2)

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /services/:serviceId/deployments` | `{ cleanCache?: boolean, redeploy?: boolean }` | 202 `{ deployment, replaced, waiting, kept?, message }`: "Deployment started", "Deployment queued. It starts when the running one ends.", or "A deploy was already waiting; it will use this request instead." Deploy fetches the branch's newest commit; Redeploy (`redeploy: true`, and `POST /deployments/:id/redeploy`) fetches the commit the running version was built from (logged "Redeploy: rebuilding commit abc1234 …"). A Redeploy or Reload never replaces a deploy that is already waiting (`kept: true`, "A deploy is already waiting with newer code; it runs next with the saved settings."). |
| `GET /services/:serviceId/deployments` | | `{ deployments: DeploymentView[] }` newest first (the service's Deployments panel) |
| `GET /deployments?search=&status=&type=&pageSize=&page=&serviceId=` | `status`: a status or `all`; `type`: `all`, `application`, `compose`, `database`; `pageSize` 10, 25, 50 (default) or 100 | `{ deployments, total, page, pageSize }` ("N total"); search covers service, project, environment, server, title and commit |
| `GET /deployments/recent?since=<iso>` | | `{ deployments (newest 8), failedSince }`: the bell; `since` defaults to 24 hours ago |
| `GET /deployments/:id` | | `{ deployment: DeploymentView & { urls: string[], servingNewer: "Now serving a newer deployment" \| null, newerDeploymentId } }`. Missing or not visible: 404 "Deployment not found. This deployment may have been removed or filtered out." |
| `GET /deployments/:id/log?lines=all` | | `{ text, totalLines, shownFrom, complete, truncated, failure, lastEventId }`: the last 500 lines unless `lines=all` ("Load all"); `failure` is `{ line, text, message: "Failure detected on line N: …" }` for failed deployments; `lastEventId` resumes the live stream right after this text; `complete` is true only when the deployment has finished and every line is shown (queued and building: false, follow the stream). Output past 5 MB keeps its first 1 MB and its last 4 MB in whole lines, with one line where the middle was left out ("… 3.2 MB of output (41,233 lines) from the middle of this log were left out here. …") and `truncated: true`; the pipeline's own lines are always kept (G2-02) |
| `GET /deployments/:id/events` | SSE, below | |
| `POST /deployments/:id/cancel` | | `{ cancelled, stopping, message }`: a queued one ends at once ("Deployment cancelled"); a building one stops within seconds ("Cancelling. …the running version keeps serving."); finished: 409 |
| `POST /deployments/:id/redeploy` | | 202 as for a new deploy, `message: "Redeployment queued"`; then follow `deployment.id` ("Waiting for logs" → open it). Not for databases (deploy them from their page) or while building |
| `GET /deployments/stream` | SSE | `deployment` events `{ deployment: DeploymentView }` whenever a visible deployment changes status (the live list and the bell) |

**The queue** (6.5, 6.6, 23.1): exactly one deployment per service builds at a time and at most one waits. A request while one waits replaces the waiting one (it keeps its id and takes the newer trigger, commit and title); a request while one builds queues one more after it. Pushes are never dropped. Unique indexes in the database back this up. A cancel of a waiting deployment takes the same lock on the service as a request, so a push that lands at the same moment is either in the cancelled deployment (where the list shows it) or a deployment of its own, never written onto one already cancelled. Each deployment has one job: enqueueing locks the deployment's row, and a job that finds its deployment building under another job leaves it alone; only the job that started it picks it up again after a restart. When the pipeline ends, how it ended is saved on the deployment (`pipeline_outcome`, migration 0768) before its record is written; recording is tried again on a database error, and a later attempt of the job records the saved outcome instead of deploying again. A job that finds its deployment already finished starts the service's waiting deployment if nothing else did, and a notification that fails never holds up the next deploy.

**The pipeline**: the log starts with `Initializing deployment (Nearzero <version>)`. Then: the source (clone at the commit, unpack the upload, or pull the image), the build on the service's own server, the new container on the private network `nearzero-edge` (alias: the app name) with the resolved variables plus `PORT=<service port>` unless set, a wait until it is running and stays up for the stability window (default 10 s, counted from when it actually runs; a Docker health check must pass first), then the routes switch to it and the old container stops, 3 seconds after its routes were written: the router reloads its files at most once every 2 seconds, and the old version keeps answering until the new route serves. Any failure before the switch leaves the old version serving; a container that exits, restarts or never becomes healthy fails the deploy, and the log ends with its last 100 lines. An app with published ports can't run two containers at once, so its old container stops first and is started again if the new one fails. An unknown `${{…}}` reference fails with its name.

**Hostnames**: before routing, every registered hostname provider is asked (see "For other milestones"); each route is written through the routing module as `s-<service id>-<hash>`, pointing at the new container; routes the providers no longer give are removed; the providers' notes are written to the log. With none: "Deployment complete. This app has no domain yet, so it isn't reachable from the internet. …". With some: "Deployment complete. It's live at: <url>, …".

**Databases**: the image is pulled, the data volume (`<app name>-data`) created, the old container stopped (two can't share the volume), the new one started with generated credentials, the public port published when public, and given up to 120 seconds to answer (pg_isready, mysqladmin / mariadb-admin ping, mongosh ping on the real server, redis-cli ping; libSQL: running). A MongoDB replica set runs with `--replSet rs0 --keyFile` (the key file derived from the password, owned by the image's mongodb user) and the first start initializes the set; the user is created by the image. If the new container doesn't come up, the old one starts again.

**Clean cache**: `cleanCache` on a deploy, or the service's Clean cache switch, builds without cached layers (`--no-cache`, `pack --clear-cache`).

### Live log events (`GET /deployments/:id/events`)

`Content-Type: text/event-stream`, headers at once, a `: keep-alive` comment every 15 s.

| Event | `data` (JSON) | `id` |
| --- | --- | --- |
| `open` | `{ deploymentId, status }` | |
| `log` | `{ text, seq }`: a piece of the log, in order | `<deployment id>:<seq>` |
| `status` | `{ status, statusLabel }` | |
| `end` | `{ status, statusLabel, error }`: the deployment finished; the stream closes | |

Reconnecting with `Last-Event-ID` (or `?lastEventId=`) sends only pieces after that one, so nothing repeats or goes missing. A finished deployment answers its stored log, then `end`.

## Sources and builders (spec 6.3, 6.4)

| Endpoint | Request | Response |
| --- | --- | --- |
| `PUT /services/:serviceId/source` | `{ type: "git", url, branch?: "main", buildPath?: "", sshKeyId?: null, trigger?: "push" \| "tag", watchPaths?: [], submodules?: false }` · `{ type: "image", image, registry?: { address, username, password } }` (blank password keeps the saved one when the user name and the registry are unchanged: the address, else the image's registry host, else Docker Hub; a password is never sent to another registry) · `{ type: "upload", buildPath? }` | `{ service, notes }` |
| `POST /services/:serviceId/source/upload?buildPath=&fileName=&deploy=1` | the .zip as the raw body (`Content-Type: application/zip`), at most 200 MB | 201 `{ service, upload: { id, fileName, sizeBytes, sha256, uploadedAt }, deployment \| null, message }`; with `deploy=1` a deploy starts |
| `PUT /services/:serviceId/build` | `{ builder, commands?: { install, build, start } }` | `{ service }` |
| `PATCH /services/:serviceId/deploy-settings` | `{ autodeploy?, cleanCache?, stabilitySeconds?: 0–600 }` | `{ service }` |

- Git URLs: `https://host/owner/repo(.git)`, `git@host:owner/repo(.git)`, `ssh://git@host[:port]/owner/repo(.git)`. Invalid: "Enter a valid public Git URL (HTTPS or git@host:owner/repo)."; credentials in the URL: "Credentials inside the URL are refused. Use an SSH URL with a deploy key, or connect a Git provider." SSH URLs use the chosen saved key (`fields.sshKeyId`: "Saved SSH key not found."); each service remembers its Git host's key on first use and refuses a changed one. Choosing a Git source turns Autodeploy on.
- Build paths are folders inside the source ("Enter a folder inside the repository, like apps/web, or leave it empty."); `..` is refused.
- Uploads stream to the control plane (the API's usual 3 MB limit doesn't apply to this route); the console's proxy must pass request bodies of up to 200 MB through without buffering them whole.
- Uploads: not a zip → 400 "That file isn't a .zip archive. Upload a .zip file."; over 200 MB → 413 "The archive is larger than 200 MB. …". The runner unpacks it refusing absolute paths, `..`, links outside the folder, encrypted entries and unknown compression; one top folder (as "Download ZIP" makes) becomes the root; `__MACOSX/` is skipped. A newer upload replaces the older one.
- `builder` (`builderSchema`): `{ type: "automatic" }`; `{ type: "dockerfile", dockerfilePath: "Dockerfile", contextPath: "", stage: "" }` (paths relative to the build path); `{ type: "railpack", version: "0.43.0" \| "0.42.0" }` (`RAILPACK_VERSIONS`, newest first); `{ type: "nixpacks", publishDirectory: "" }`; `{ type: "heroku", stack: "24" \| "22" }`; `{ type: "paketo" }`; `{ type: "static", spa: false }`.
- Automatic: a Dockerfile (or `dockerfile`, `Containerfile`) at the build path; else Railpack when a known framework is detected; else Nixpacks. A Railpack plan that can't be made goes on with Nixpacks ("Railpack plan was not usable before compilation. Continuing with Nixpacks."). If a Railpack or Nixpacks build fails and the repository root has a Dockerfile, it is used instead (logged).
- Monorepos: in automatic mode, a build path whose package depends on other packages of the repository (npm, pnpm, Yarn or Bun workspaces, `workspace:` links) builds from the repository root with Nixpacks: one install at the root, its workspace dependencies built first (through Turborepo when the root has `turbo.json`), then started from the build path (logged). The person's own commands replace the generated ones.
- Passing failures (timeouts, dropped connections, 429 and 5xx from a registry or Git host) of a clone, an image pull or a build are tried up to three times, 2 then 5 seconds apart, with a log line; other failures fail at once.
- Links: a fetched repository loses its links that lead outside it (followed through every other link; each is named in the log), uploads with such links are refused, and the runner never writes or reads a build file (a `Procfile`, the Dockerfile, the build path) through a link out of the source. Commands are one line: line breaks and other control characters are refused (400 "Keep the command on one line, without line breaks or other control characters.").
- Commands: Railpack gets them as `RAILPACK_INSTALL_CMD` / `RAILPACK_BUILD_CMD` / `RAILPACK_START_CMD`, Nixpacks as `--install-cmd` / `--build-cmd` / `--start-cmd`; a Dockerfile build or an image uses the start command as the container's command (`/bin/sh -c`); buildpacks write a `Procfile` for the start command and log that install and build commands aren't used; Static runs install and build in `node:24-alpine` and serves `dist`, `build`, `out` or `public` (the first that exists), else the folder.
- Nixpacks' publish directory serves that folder of the built app with the static server. Static listens on the service port and, with `spa: true`, answers `index.html` for unknown paths.
- Builds receive only build-safe variables (letters, digits, `_`), never on a command line and never in the built image unless the name marks the value public (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_`, `GATSBY_`, `VUE_APP_`, `STORYBOOK_`, `NIXPACKS_`, `RAILPACK_`, `BP_`, `PORT`, `NODE_ENV`, `CI`). Every variable is a BuildKit secret file (`RUN --mount=type=secret,id=NAME` reads it from `/run/secrets/NAME` in a Dockerfile); public ones are also build arguments, their values taken from buildx's environment. Railpack, Nixpacks and pack read the values from their environment (`--env NAME`); Nixpacks' Dockerfile mounts the secrets per step as files and exports them for that step instead of declaring them `ARG`/`ENV`, which every Docker Engine from 20.10 reads (Debian 12 ships 20.10.24, Debian 13 26.1.5, Amazon Linux 2023 25.0; the `env=` form needs Dockerfile 1.10, Docker 27.3, C2-04). The Static builder's install and build commands get the variables the same way: public names as `ARG`s, the others as secrets exported for those steps (C2-05). A generated plan that would carry a secret's value stops the build: "… generated a plan containing protected build material (key=NAME) …". Names that steer the tools or the system (`PATH`, `HOME`, `LD_*`, `DOCKER_*`, `BUILDKIT_*`, `GIT_*`, `SSH_*` …) never reach a tool's own environment. Values are cut out of the log.
- Paketo builds use `paketobuildpacks/builder-jammy-full`. Build caches carry Nearzero's labels: the BuildKit container `nearzero-buildkit` and its volume `nearzero-buildkit-state` (Railpack, set up once per server even when two first builds start together), and pack's `nearzero-pack-<app name>-build` / `-launch` volumes, which teardown removes with the service.
- Before a build the tools are checked; a missing one stops it with "<tool> is not installed on the build machine. Run setup again on this server's page to install it." (on the host: "Run the Nearzero install command again on the host to update its image, which carries the builders.").

Application `settings` (public, `serviceView`): `source` (git: url, branch, buildPath, sshKeyId, trigger, watchPaths, submodules; image: image, registry `{ address, username, passwordSet }`; upload: buildPath, upload `{ id, fileName, sizeBytes, sha256, uploadedAt }`), `build` (the builder), `commands`, `servicePort`, `servicePortAuto` (true when nobody typed a port: each deploy uses the first TCP port of the app's port mappings, else the port the image declares — 80, 3000, 8080, 8000, 5000 or 4173 first, else the lowest — else 80 for Static, else 3000, logs "Service port N: <why>." and keeps it in `servicePort`; creating with `servicePort`, or saving one, makes it typed), `ports`, `mounts` (file mounts without content), `deploy` (`autodeploy`, `cleanCache`, `stabilitySeconds`). A copy in another environment gets the source, builder, commands, deploy settings and volume mounts (each a volume of its own, `<copy's app name>-<name>`, also when the original keeps a moved 0.1.x volume by name); never bind mounts, published ports, file contents or the registry password. An uploaded archive is copied for it, so the original's next upload or delete never takes it away; a copy that still shares one gets its own at its next deploy (logged). A copy without a source takes its group's at its first deploy (logged).

## Runtime (spec 6.2, 6.7, 6.8, 8.2)

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /services/:serviceId/start` · `/stop` · `/reload` | | `{ status: "running" \| "stopped", message: "Started" \| "Stopped" \| "Reloaded" }`. An application's Reload answers `{ status: "deploying", deploymentId, message: "Reloading with the saved settings. …" }`: a deployment with trigger `reload` starts the running version's image again with the current variables, mounts, ports and start command, with nothing fetched or built (the commit and image stay the running version's); 409 "There's no built version to reload yet. …" when there is none. Stop marks the active deployment `not_running`; Start marks it `active` again. 409 while deploying ("Wait for the deployment to finish first.") or before the first deploy ("This service hasn't been deployed yet. Deploy it first."). |
| `GET /services/:serviceId/runtime` | | `{ status, containers: { id, name, image, state, status, deploymentId, current, createdAt }[] }`: the container picker |
| `GET /services/:serviceId/logs?tail=100\|500\|1000\|all&since=<iso>&search=&follow=1\|0&container=` | | SSE as the servers' log stream: `open { streamId }`, `output { text, offset }` (id `<stream id>:<end>`), `status { connected, message }`, `gap { from, to, message }`, `end { exitCode, error }`. `search` keeps only lines containing it (case-insensitive). Resume with `Last-Event-ID` within 30 s. |
| `GET /services/:serviceId/terminal?container=&shell=sh\|bash&cols=80&rows=24` | WebSocket | Frames as the servers' terminal: binary in = keystrokes, text in = `{ type: "resize", cols, rows }` or `{ type: "input", data }`; binary out = output, text out = `{ type: "status", connected }` and `{ type: "exit", exitCode, error }`. `bash` falls back to `sh` with a note. Audited (`terminal.opened`). The console's proxy must pass WebSocket upgrades through. |
| `PUT /services/:serviceId/ports` | `{ ports: { containerPort, publishedPort, protocol?: "tcp" \| "udp", mode?: "routed" \| "host" }[] }` | `{ service, notes }` with "Published ports are not needed for web traffic, …" and "Deploy to apply the change." |
| `PUT /services/:serviceId/mounts` | `{ mounts: ({ type: "volume", id?, name, containerPath } \| { type: "bind", id?, hostPath, containerPath, readOnly? } \| { type: "file", id?, containerPath, content? })[], deleteVolumeData?: string[] }` | `{ service, notes }` |

- Published ports are unique per server and protocol, counting other apps' ports and databases' public ports: 409 `Port N/TCP is already published by "X" on this server. Pick another port.`; 22, 80 and 443 (and on the host 53, 3000 and 4321) are refused: "Port N is used by Nearzero on this server. Pick another." Both modes publish through Docker on the server (see Spec questions).
- Mounts: named volumes are `<app name>-<name>`; bind mounts take an absolute host path. On the Nearzero host (spec 24 G3) a bind mount that is new or changed is refused for anyone but instance administrators (403 `The mount at /var/run/docker.sock is /var/run/docker.sock, which holds the Docker socket: control of every container on the server. This application mounts the Docker socket of the Nearzero host itself. On the Nearzero host only Nearzero administrators can deploy bind mounts. Use a volume instead, or deploy the application to another server.`); an instance administrator's deploy approves exactly those mounts in exactly that definition (source, builder, commands, every mount with file contents by digest, the variables after references are filled in, published ports and the service port, `host_approval`; C1-04), and hostnames of such an app are added only by instance administrators, so later deploys by anyone with deploy rights, pushes and webhooks may run the same again, and any change needs an administrator first (deploys answer 403, push and webhook deploys fail with "Refused on the Nearzero host: …"). Elsewhere bind mounts are allowed and `notes` and the deploy log warn about the socket and server folders; file mounts keep their content sealed with the service's secrets (never returned, never in the service view, never sent to the Agent); leave `content` out with the mount's `id` to keep it. Removing a volume mount keeps its data unless its name is in `deleteVolumeData`; then it is deleted after the next successful deploy, unless it is mounted again or another service on the server mounts it, and the log says what happened (C1-10). A volume mount with `of: <app id>` mounts that app's volume `name` (an app in the same environment and on the same server that the person may configure; `GET /services/:serviceId/shareable-volumes` lists them, G2-08); removing it never deletes the other app's data.
- Changes apply on the next deploy.
- **Health after the deploy** (G2-06): once a minute the control plane reads what each runner last reported; an app's live container whose health check reports `unhealthy` for a minute is replaced by a Reload titled "Health check failing: replaced with a fresh container" (its log says why). After three such replacements within an hour, the next failure is reported instead, as a failed deployment "Health check still failing after replacements" (with the "Deploy failed" notification), and the container is left running.

## Databases (spec 8.1, 8.2)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /services/:serviceId/connection` | | `{ connection }` with the password masked |
| `POST /services/:serviceId/connection/reveal` | | the same with the password and full URLs ("Show password") |
| `POST /services/:serviceId/public` | `{ public: boolean }` | `{ publicPort, connection, deployment \| null, message }` (`connection` as `GET …/connection`, with the new public URL data): Make public takes the lowest free port from 20000 to 29999 on the server (409 "No free port between 20000 and 29999 …" when full); Make private drops it. A deployed database is redeployed in the background with the change. |

```ts
interface Connection {
  running: boolean; notice: string | null;   // "Works once the database is deployed and running."
  user: string | null; database: string | null; password: string | null;   // password only from /reveal
  internal: { host: string; port: number; url: string; label: "From apps on this server" };
  public: { enabled: boolean; port: number | null; host: string | null; url: string | null; label: "From anywhere";
            hint: string };   // "If it doesn't connect, allow inbound TCP N …" / "Not reachable from outside this server." / "Port N on this database's server. …"
  server: string;
}
```

URLs (`databaseConnectionUrl`, credentials percent-encoded): `postgresql://user:pass@host:port/db`, `mysql://user:pass@host:port/db` (MySQL and MariaDB), `mongodb://user:pass@host:port/?authSource=admin` (replica set: `&replicaSet=rs0` inside, `&directConnection=true` from outside), `redis://default:pass@host:port`, `http://user:pass@host:port` (libSQL). The internal host is the app name on `nearzero-edge`; the public host is the server's address, and for the Nearzero host the install's public IPv4 (`NEARZERO_PUBLIC_IP`, given to the control plane at start); only when neither is known is `public.host` null with the "use its IP with port N" hint. An image change (`PATCH /services/:id { settings: { image } }`) applies on the next deploy.

## Deploy webhooks (spec 6.6, 24 G4)

| Endpoint | Needs | Response |
| --- | --- | --- |
| `GET /services/:serviceId/webhook` | access; the URL only with deploy rights | `{ visible, url, message, warnings, createdAt, lastCalledAt }`. Without deploy rights: `visible: false`, "You need permission to deploy this service to see its webhook". With none yet: `url: null`, "This service has no webhook URL yet. …". Warnings: "Autodeploy is off, so calls to this URL are ignored. …", "GitHub can't reach <host>: …" (a console address that isn't public), and for upload sources "Apps from an uploaded archive have no deploy webhook: …". Image sources have the webhook too (30b R2-03): their registry calls it. |
| `POST /services/:serviceId/webhook` | configure and deploy rights | creates or replaces it ("Webhook URL replaced. The old URL stopped working."); same shape. Refused (409) for an app whose source is an uploaded archive. |
| `POST /webhooks/deploy/:token` | the token; no session | 202 `{ deployed: true, deploymentId, queued, replaced, message }`, or 200 `{ deployed: false, message }` when nothing deploys: a Git host's ping ("Ping received: the webhook is active."), another event than a push, Autodeploy off, another branch, a tag with On push, no changed file matching the watch paths, a skip keyword, a registry push of another image or tag, an upload source. A wrong or replaced token, or a provider webhook's wrong or missing signature: 401. More than 30 calls a minute: 429. Bodies up to 25 MB, as GitHub sends them (413 past that; the GitHub App's webhook and kept 0.1.x addresses too, G2-04). |
| `GET /webhooks/deploy/:token` | nothing | 405 "Call this webhook with POST." with `Allow: POST`, whatever the token; nothing deploys (G4-17). A kept 0.1.x address answers the same through the console. |

The token is `nzw1.<id>.<secret>`; the access log shows the address as `nzw1.<id>.[redacted]`, and a kept 0.1.x address with every token-like segment replaced (G4-11); the secret's SHA-256 checks calls in constant time and a sealed copy lets the URL be shown again. A burst of calls queues at most one deploy (the waiting one is replaced). The raw body is read as bytes first, so provider signature checks can verify exactly what arrived. Then `apps/control/src/webhooks/calls.ts` reads what the call is (spec 6.6; 30b R2-03, R2-10; 30d R4-12, R4-13):

- **Git host headers first.** `X-GitHub-Event: ping` and Bitbucket's `X-Event-Key: diagnostics:ping` are answered "Ping received: the webhook is active." and deploy nothing. A push (`X-GitHub-Event: push`, `X-Gitea-Event: push`, `X-Gitlab-Event` with a push body, `X-Event-Key: repo:push` in Bitbucket's `push.changes` format, `X-SoftServe-Event: push`) is read for its ref, commit, files and head commit message. Any other event of a Git host (issues, stars, comments…) answers "Not deployed: only pushes deploy, and <host> sent the <event> event."
- **Then the body's shape**, without Git host headers: a push-shaped body (`ref`, `after` or `checkout_sha`, `commits[].added/modified/removed`, `head_commit.message`), Bitbucket's `push.changes`, or a Docker Hub webhook (`push_data.tag`, `repository.repo_name`). Anything else, an empty body included, is a plain call (CI tools), which deploys.
- **Git sources**: a push deploys by the trigger, branch and watch paths, at its commit; a push to the branch whose head commit message contains `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]` (any case) doesn't ("The head commit's message contains [skip ci], so this push doesn't deploy."); new tags with the On tag trigger always deploy. A provider-linked source ignores pushes naming another repository. A plain call deploys the branch's newest commit.
- **Image sources**: a Docker Hub webhook, or GitHub's `package` / `registry_package` event for a container (published or updated), redeploys only when the pushed image is the app's (Docker's reading: `nginx` is `docker.io/library/nginx`, registries compared by host) and its tag is the app's (`latest` when the app names none); otherwise "Not deployed: <registry> pushed <image>, and this app runs <image>." or "…pushed the tag dev, and this app runs the tag latest…", and nothing is queued. A call with no image details redeploys the configured image, pulled again.
- **Upload sources** have nothing to redeploy from: a call answers so and deploys nothing.

`shouldDeployPush`, `skipKeyword` and `readPushBody` in `apps/control/src/webhooks/push-rules.ts` are the push rules the GitHub App's webhook and the GitLab, Bitbucket and Gitea checks (git-providers.md) share.

## The runner's side

New commands (`packages/shared/src/runner-protocol.ts`, `runner/src/commands.ts`; additive, protocol 1): `source.git` (streams; shallow fetch of a branch, commit or tag, SSH key in a 0600 file for the fetch only), `source.archive` (streams; downloads `GET /api/v1/runner/uploads/:id` with the runner's credential — only while a deploy using it builds on that server — checks size and SHA-256, unpacks safely), `app.build` (streams; detection, tool checks, the builders), `container.exec-capture` (a command's exit code and output, secrets cut out), `image.list` (by label or reference), `workdir.remove`; `container.create` takes `files` (written into the container before it starts) and `stopTimeoutSeconds`; `container.inspect` adds `restartCount`, `health`, `finishedAt`, `oomKilled`. Images are tagged `nearzero/<app name>:<deployment>` and labelled `dev.nearzero.service` / `dev.nearzero.deployment`; the newest three successful ones are kept.

Builder tools are pinned with checksums in `runner/tools/pins.ts` (Railpack 0.43.0 and 0.42.0 with their BuildKit frontends by digest, Nixpacks 1.41.0, pack 0.40.10, the static server `nginx:1.30.6-alpine`) and installed by `runner/tools/install.ts` into `/usr/local/lib/nearzero/builders/<tool>/<version>/` (`bin/` on PATH). The production image carries them, with `git` and `openssh-client`; server setup installs the same files.

## Teardown (spec 23.1)

`runnerTeardown(services)` (`apps/control/src/service-runtime/teardown.ts`) is the delete job's teardown: queued deploys are cancelled; then on the service's server it removes the containers (stopping them first), the images (by label and by `nearzero/<app name>`), the volumes when asked (always for Compose, after `compose down --volumes`), the service's work folders, and its routes; it checks no container is left. An unreachable server gives "not removed" with the reason ("Couldn't remove it from its server: … delete it again once the server is reachable."). A never-deployed service is removed without contacting a server. Deployment rows are marked `removed`.

## For other milestones

- **Hostname providers** (`apps/control/src/deploys/hostnames.ts`): `services.hostnameProviders.register(name, provide)` (or `registerHostnameProvider(services, name, provide)`). `provide({ serviceId, serverId, port })` — `serverId` is a server id or `"host"`, `port` the service port — returns `{ routes: { host, path, port, composeService?, https }[], notes: string[] }`. Routes become router routes pointing at the new container (`https` → certificate `letsencrypt`, else `none`); notes are written to the deploy log. A provider that throws adds a note and the deploy goes on.
- **Git providers**: add a source type beside `git` in `appSourceRequestSchema` and `readSource`, describe it in `describeSource`, and fetch through `source.git` with the provider's token-authenticated URL (never stored in settings). Use `shouldDeployPush` for push events after checking the provider's signature against the raw body.
- **Compose** deploys, Start / Stop / Reload and the containers of a stack are the Compose runtime's ([compose.md](compose.md)); the queue, records, log, cancel and teardown here apply to them as they are.
- **Jobs**: `createJobCatalog(services)` replaced the static catalog (`deploys.run`, `deploys.prune` hourly, `deletion.remove-services` with the runner teardown).

## Audit events

`service.deploy-requested`, `deployment.cancelled`, `service.start`, `service.stop`, `service.reload`, `service.source-changed`, `service.source-uploaded`, `service.build-changed`, `service.ports-changed`, `service.mounts-changed`, `service.deploy-settings-changed`, `service.webhook-created`, `service.webhook-replaced`, `service.made-public`, `service.made-private`, `terminal.opened`.

## Code map

`apps/control/src/`: `deploys/` (queue, job, pipeline, records, log and live bus, hostname providers, retention, SSE helpers, routes), `service-runtime/` (app settings, database container rules, server operations, runtime actions, settings changes, teardown, routes), `sources/uploads.ts`, `webhooks/` (tokens, push rules, the public endpoint). `runner/src/`: `sources/` (git, archive, zip), `builds/` (detection, tools, builders), `docker/tar.ts`; `runner/tools/` (pins, installer). Migration 0200. Tests: `apps/control/test/deploys.test.ts` (a fake runner speaking the real protocol), `push-rules.test.ts`, `packages/shared/test/deploys.test.ts`, `runner/test/sources.test.ts`, and the Docker-in-Docker suite `e2e/deploys/deploys.e2e.ts` (`bun run --cwd e2e test:deploys`).
