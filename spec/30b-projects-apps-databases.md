# R2. Projects and everything that runs: parity of 0.1.79 and 1.0

Reviewer: parity reviewer (dirty side). Compared: 0.1.79 (the reference behavior) and 1.0 at 9a01ec7, against `spec/` at the same commit. This file describes behavior only.

Scope: projects, environments, service copies, variables; applications (sources, builders, commands, ports, mounts, deploy actions, push deploys and webhooks, logs, terminal); Compose; the six databases with backups and restore; deployments (list, detail, cancel, queueing, retention, bell).

Not counted as gaps: the deliberate changes in `spec/00-index.md`, everything in `spec/27-dropped.md`, the owner's decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10, and punch-list items marked Done. Open punch-list items (5, 22) are not repeated. The bell's refresh is in R1-06 and not repeated here.

## Summary

| Severity | Count |
| --- | --- |
| P0 | 0 |
| P1 | 7 |
| P2 | 9 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| R2-01 | P1 | Apps from an image or a Dockerfile are routed to port 3000 instead of the port their image declares | 06 6.1, 6.5, 6.9 (spec gap) |
| R2-02 | P1 | Reload only restarts the old container; saved variables, mounts and ports need a full rebuild | 06 6.2, 6.8, 05 5.5 (spec gap) |
| R2-03 | P1 | Image-source apps have no deploy webhook, so a pushed image can't redeploy them; registry calls aren't checked | 06 6.6 (spec wrong) |
| R2-04 | P1 | Monorepo apps that depend on other workspace packages no longer build | 06 6.1, 6.4 (spec gap) |
| R2-05 | P1 | Build variables appear on build command lines and end up inside built images | 23.4, 05 5.5 (spec gap) |
| R2-06 | P1 | Database backups written by 0.1.x can't be found or restored after the move | 08 8.3, 29 (spec gap) |
| R2-07 | P1 | App bind mounts on the Nearzero host aren't refused for people who aren't instance administrators | 24 G3, 06 6.8 |
| R2-08 | P2 | Builds give up at the first transient failure, and automatic mode no longer falls back from Railpack to Nixpacks | 06 6.4, 23.1 (spec gap) |
| R2-09 | P2 | Redeploy fetches the newest commit instead of rebuilding what runs | 06 6.2, 11.2 (spec gap) |
| R2-10 | P2 | The generic deploy webhook deploys on GitHub's ping and on Bitbucket pushes to any branch | 06 6.6 |
| R2-11 | P2 | Every container of a Compose stack joins the server's shared network | 07 7.3 (spec gap) |
| R2-12 | P2 | Compose files no longer get `APP_NAME` and `COMPOSE_PROJECT_NAME` | 07 7.1, 05 5.5 (spec gap) |
| R2-13 | P2 | Published app ports and database public ports aren't opened in a remote server's firewall | 06 6.8, 08 8.2 (spec gap) |
| R2-14 | P2 | Paketo builds use the smaller builder, so fewer languages build | 06 6.4 |
| R2-15 | P2 | Deploys share four job lanes with backups, tasks, deletes and setup | 23.1, 23.2, 08 8.3 (spec gap) |
| R2-16 | P2 | `${{project.NAME}}` references from 0.1.x fail every deploy after the move; shared values now fail on references | 05 5.5, 29 (spec gap) |

---

## Gaps

### R2-01 · P1 · Image and Dockerfile apps are routed to 3000, not to the port their image declares

**0.1.x**
1. After the image is built or pulled, every app deploy works out the port traffic goes to and logs "Detecting application runtime port..." then "Application runtime port detected: N".
2. The order: the first TCP container port of the app's own port mappings; else the TCP ports the image declares (exposed ports), preferring 80, 3000, 8080, 8000, 5000 and 4173 in that order, else the lowest; else 80 for the Static builder; else 3000.
3. The generated hostname routes to that port. So `nginx:alpine` created without Git, or a Dockerfile app whose image exposes 8080, answers at its hostname with no input.

**1.0 now**
- The service port is 3000 unless the person typed another on Configure. "Create without Git" has no port field.
- The image's declared ports are never read. The container gets `PORT=3000` and the route points at 3000.
- `nginx:alpine` deployed this way answers its hostname with a bad-gateway error until someone changes Service port in Settings and deploys again. The same happens to a Dockerfile app that listens on 8080 and ignores `PORT`.

**Expected 1.0**
- When the person didn't set a port, an app created without Git from `nginx:alpine` is live at its generated hostname after its first deploy.
- When the person didn't set a port, a Dockerfile app whose image exposes only 8080 is routed to 8080.
- The deploy log says which port was used and why. A port the person typed always wins.

**Spec**: 06 6.1, 6.5, 6.9 (spec gap: the spec fixes the default at 3000 and says nothing about declared ports).

### R2-02 · P1 · Reload restarts the old container instead of applying the saved settings

**0.1.x**
- Reload ("Reload Application" / "Are you sure you want to reload this application?") re-creates the running app from its last built image with the current shared and own variables, mounts, ports and start command. It doesn't fetch or build anything. Toast: "Application reloaded successfully".
- So a variable change reaches a Git app in seconds, without a rebuild.

**1.0 now**
- Reload stops and starts the same container. It keeps the environment, mounts and ports the container was created with.
- Saved variables, mounts and ports reach the app only through Deploy or Redeploy. For Git sources both fetch and rebuild, which takes minutes.

**Expected 1.0**: after a variable is changed on a running Git app, Reload makes the container see the new value within a minute. The log has no fetch or build step, and the deployment's commit and image are unchanged.

**Spec**: 06 6.2 ("restart without rebuilding"), 6.8 ("Changes apply on the next deploy"), 05 5.5 (spec gap).

### R2-03 · P1 · Image-source apps have no deploy webhook

**0.1.x**
1. Settings → Deployment settings shows Autodeploy and Deploy webhook (Show URL, Copy, Replace URL) for image-source apps too. A call pulls the configured image again and redeploys.
2. Calls from Docker Hub-style registry webhooks and GitHub Packages container events are checked. When the call names an image, it must match the app's image name, and its tag when both name one. Otherwise the answer names the mismatch, for example "Application Image Name (x) doesn't match request event payload Image Name (y).", and nothing deploys.
3. A call that names no image deploys the configured image.

**1.0 now**
- Autodeploy and the webhook rows show only for Git sources. An image app's owner can't see or create its URL, so pushing a new image to the registry can't redeploy it. (The API still accepts a token if one exists.)
- Registry payloads aren't read: any call to a valid token deploys.

**Expected 1.0**
- An image-source app's Settings shows Autodeploy and Deploy webhook.
- A Docker Hub webhook call for the app's repository and tag redeploys it with the newly pushed image.
- A call that names another image or tag answers that it doesn't match and queues nothing.
- Upload sources keep no webhook.

**Spec**: 06 6.6 says "Not shown for image and upload sources". I think that's wrong for image sources: this is how image apps get continuous deploys.

### R2-04 · P1 · Monorepo apps that depend on other workspace packages no longer build

**0.1.x**
- In automatic mode, the picked app folder might depend on other packages of the same repository (npm, pnpm, Yarn or Bun workspaces, `workspace:` links). Then the build runs from the repository root with Nixpacks and runs the picked app's install, build and start from its own folder.
- With a Turborepo build pipeline at the root, it builds through Turbo, so the dependency packages build first. The log says it detected workspace dependencies in that folder and how it builds them.

**1.0 now**
- Only the build-path folder is the build's context. Sibling packages aren't there, so the install fails on the workspace links.
- The only fallback is a Dockerfile at the repository root.

**Expected 1.0**: a pnpm or Turborepo monorepo whose `apps/web` depends on `packages/ui` (`workspace:*`) deploys and serves `apps/web`. It is created with build path `apps/web`, in automatic mode, with no Dockerfile and no custom commands.

**Spec**: 06 6.1 (monorepo build path picker), 6.4 (spec gap: nothing about workspace dependencies).

### R2-05 · P1 · Build variables appear on command lines and end up in built images

**0.1.x**
- Railpack and Nixpacks builds receive variables only as build secrets. Values never appear on a command line or in the generated build plan.
- If a generated plan would carry a variable's value, the build stops with "…generated a plan containing protected build material (key=NAME)". Public framework names (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`, `REACT_APP_`, `NUXT_PUBLIC_`, `EXPO_PUBLIC_`, `PORT`, `NODE_ENV` and similar) are exempt from the check.
- Dockerfile builds get the service's variables only as secret files a Dockerfile can mount, never as build arguments.

**1.0 now**
- Every build variable is passed as `NAME=value` on the build programs' command lines: build arguments for Dockerfile builds, plan variables plus build arguments for Nixpacks, env flags for buildpacks and for Railpack's planning step. During a build, any user on the server can read the values in the process list.
- Nixpacks turns them into environment entries of the built image.
- A Dockerfile that declares an `ARG` for one keeps its value in the image history.
- The last three successful images are kept on the server.

**Expected 1.0**
- After a Nixpacks build and a Dockerfile build of an app with `DATABASE_URL` set, neither built image's configuration or history contains the value.
- No process command line on the build server contained it during the build.
- The app still receives it at runtime, and public-prefix names still reach the build.

**Spec**: 23.4 (secrets), 05 5.5 "How values reach a service" (spec gap: the spec doesn't say how build values are delivered).

### R2-06 · P1 · 0.1.x database backups can't be found or restored after the move

**0.1.x writes**
- Files are named `<app name>/<folder>/<time>.sql.gz`. The time has milliseconds and a trailing `Z`, like `2026-11-25T03-00-00-123Z.sql.gz`.
- MongoDB files end in `.bson.gz`. A schedule with an empty folder writes straight under `<app name>/`.
- Postgres files are gzipped pg_dump custom-format archives, restored with pg_restore (clean, if exists, no owner).
- MySQL files dump one database without a `USE` line and are restored into the named database.
- libSQL files are gzipped tar archives of the database folder, restored by unpacking.

**1.0 now**
- The restore list shows only names of 1.0's exact shape: whole seconds, no `Z`, `.archive.gz` for MongoDB, one folder below the app name. None of a moved install's files appear, and the restore endpoint refuses them as the wrong kind of file.
- Even if one were listed:
  - a Postgres custom-format file fails in the plain-SQL loader;
  - a MySQL file stops with "No database selected";
  - a libSQL tar is sent to the server as SQL.
- These files are also never pruned. That is safe, but they can't be used.

**Expected 1.0**: after a 0.1.x install is moved, each of a Postgres, MySQL, MariaDB, MongoDB and libSQL database's pre-move backups appears in its Restore list (same destination and folder, including an empty folder) and restores successfully. Whether "Keep N" counts these files is a decision to record.

**Spec**: 08 8.3, 29 (spec gap: the migration keeps destinations and schedules but says nothing about the files they already wrote).

### R2-07 · P1 · App bind mounts on the Nearzero host aren't restricted

This is a known security gap the spec requires 1.0 to close, not a regression.

**0.1.x**: anyone who could configure an app could bind-mount any host path, the Docker socket included, on the control-plane host (G3).

**1.0 now**
- The Advanced tab and its API accept any absolute host path (`/`, `/var/run/docker.sock`, `/etc`) for an app on the Nearzero host.
- This works for anyone with configure rights in a workspace allowed to use the host. Only Compose files get the host check.

**Expected 1.0**
- When a person who isn't an instance administrator saves or deploys an app on the Nearzero host with a bind mount of the Docker socket, `/`, or a path outside the service's own folder, it is refused with the reason.
- An instance administrator can do it.
- On other servers it is allowed, with the same warning Compose shows.

**Spec**: 24 G3, 06 6.8.

### R2-08 · P2 · Builds stop at the first transient failure; no Railpack-to-Nixpacks fallback

**0.1.x**
1. Fetching the source (clone or image pull) and building are retried up to 3 times when a failure looks transient: network timeouts, unexpected EOF, "too many requests", HTTP 429, 500, 502, 503 or 504 from a registry, or a dropped SSH connection. Real compile errors fail at once.
2. In automatic mode, when Railpack can't produce a usable plan, the log says "Railpack plan was not usable before compilation. Continuing with Nixpacks." and Nixpacks builds the app.
3. A Nixpacks build that fails on a Node.js `engines` requirement retries with a Node major that satisfies it.

**1.0 now**
- One attempt each for clone, pull and build.
- A failed Railpack plan fails the deploy. Only a repository-root Dockerfile is tried, and only when the build path is a subfolder.
- No retry with another Node version.

**Expected 1.0**
- A deploy whose image pull answers 503 once and then succeeds finishes without a manual retry, and the log notes the retry.
- An automatic build whose Railpack plan fails continues with Nixpacks and says so.

**Spec**: 06 6.4, 23.1 (spec gap).

### R2-09 · P2 · Redeploy fetches the newest commit

**0.1.x**
- Redeploy rebuilds the source already checked out for the last deploy. That covers the header button (confirm "Rebuild application") and Redeploy on the Deployments page, for apps and Compose.
- It uses the same commit with the current settings and variables, and is titled "Rebuild deployment".
- Deploy fetches the branch's newest commit.

**1.0 now**: Redeploy fetches the branch's newest commit, so it does the same as Deploy. Nothing rebuilds what is running without also taking new commits.

**Expected 1.0**: with autodeploy off and a new commit pushed, Redeploy builds the commit the active deployment ran, and Deploy builds the new one.

**Spec**: 06 6.2, 11.2 (spec gap: neither says which commit Redeploy builds).

### R2-10 · P2 · The generic deploy webhook deploys on GitHub's ping and on Bitbucket pushes to any branch

**0.1.x**
- The deploy webhook answers GitHub's ping with 200 "Ping received, webhook is active" and deploys nothing.
- For a Git URL source it deploys only for a recognizable push to the app's branch: GitHub, Gitea and GitLab push refs, or Bitbucket's pushed branch name. Otherwise it answers "Branch Not Match".

**1.0 now**
- A body without a `ref` deploys the branch's newest commit. That includes the ping GitHub sends when the webhook is added, and other GitHub event types.
- A Bitbucket push to a Git URL app is not read, so pushes to any branch deploy.
- The same applies to the deploy webhook of GitHub-linked apps.

**Expected 1.0**
- Adding the deploy webhook at GitHub queues no deploy and answers that the webhook is active.
- A Bitbucket push to another branch of a Git URL app's repository answers that the branch doesn't match and queues nothing.
- A POST with no body still deploys, under 1.0's generic rule.

**Spec**: 06 6.6.

### R2-11 · P2 · Every container of a Compose stack joins the shared network

**0.1.x**
- Only inner services that have a domain join the shared network that the router, apps and databases use.
- The other inner services stay on the stack's own network, reachable only from the same stack.

**1.0 now**
- After `up`, every container of every stack joins the server's shared private network as `<app name>-<service>`.
- A database or cache inside a stack, often run without a password because it was private, becomes reachable from every app, database and stack on that server. That includes other projects and, on the Nearzero host, other workspaces allowed to use it.

**Expected 1.0**: in a stack with `web` (with a domain) and `redis` (no domain), no app outside the stack on the same server can connect to that `redis`, and `web`'s hostname still works.

**Spec**: 07 7.3 (spec gap: "Nearzero adds its own network" doesn't say which services join it).

### R2-12 · P2 · Compose files no longer get `APP_NAME` and `COMPOSE_PROJECT_NAME`

**0.1.x**: Compose runs with `APP_NAME` and `COMPOSE_PROJECT_NAME` set to the service's app name, so a file can use `${APP_NAME}` in names, labels or paths without defining it.

**1.0 now**: neither is set. A file that uses `${APP_NAME}` is refused before the deploy as needing a variable.

**Expected 1.0**: a pasted file with a label `owner=${APP_NAME}` deploys with the app name filled in, and nobody adds a variable.

**Spec**: 07 7.1, 05 5.5 (spec gap).

### R2-13 · P2 · Published ports aren't opened in a remote server's firewall

**0.1.x**
- Deploying on a remote server an app with published ports, or a database with a public port, opens those ports in the server's active host firewall: ufw, firewalld or iptables, using passwordless sudo when not root.
- The deploy log gets the outcome, for example "UFW allowed Docker published ports: …", and a reminder that the cloud firewall must allow them too.
- Without sudo it logs that it skipped and which ports to allow.

**1.0 now**: nothing is opened or logged. Only the connection card's hint remains.

**Expected 1.0**
- On a remote server with ufw active, a database made public, or an app that publishes 9000/udp, gets that port allowed in ufw, and a deploy log line says so.
- With no supported firewall active, the log says none was found.

**Spec**: 06 6.8, 08 8.2 (spec gap).

### R2-14 · P2 · Paketo builds use the smaller builder

**0.1.x**: Paketo buildpacks builds use Paketo's full Jammy builder, which has more languages (PHP among them) and more system libraries.

**1.0 now**: they use the base Jammy builder.

**Expected 1.0**: a PHP app (a `composer.json` and no Dockerfile) set to Paketo buildpacks builds and serves.

**Spec**: 06 6.4.

### R2-15 · P2 · Deploys share four job lanes with everything else

**0.1.x**: deploys run one at a time across the install, in their own queue. Backups and scheduled tasks run on their own schedules and never wait for deploys.

**1.0 now**
- Four lanes are shared by every background job: deploys, database and volume backups, task runs, deletes, server setup and cleanups.
- Four long builds (each allowed an hour) hold every lane, so a backup due at 03:00, a task run or a delete waits behind them.
- Up to four builds can also run at once on one small server.

**Expected 1.0**
- While four deploys are building, a backup or task that falls due still starts within a minute.
- Builds for two apps on the same server don't run at the same time unless an administrator raises the limit.

**Spec**: 23.1, 23.2, 08 8.3 (spec gap).

### R2-16 · P2 · Variable references from 0.1.x fail after the move

**0.1.x**
- References are worked out only inside a service's own values.
- Shared values are passed exactly as written: a `${{…}}` inside a shared value stays literal and never fails a deploy.
- `${{project.NAME}}` resolves from the project's variables.

**1.0 now**
- Shared values are resolved too. An unknown reference inside a shared value fails every deploy in that environment.
- `${{project.NAME}}` is looked up as a service variable literally called `project.NAME` and fails the deploy. It comes from a moved install, whose project-level values now sit in each environment's shared variables.

**Expected 1.0**
- After a 0.1.x install is moved, a service value `${{project.API_URL}}` resolves to the shared `API_URL` its project-level value became. Either the import rewrites it to `${{environment.API_URL}}` or 1.0 accepts the old form.
- A shared value carried over with a literal `${{…}}` doesn't stop deploys.

**Spec**: 05 5.5, 29 (spec gap).

---

## Checked and at parity

I checked these against both versions' behavior and found them matching, or better in 1.0 in line with the spec:

**Projects**
- Create: one "development" environment that is the default; name and description limits; "Project created".
- Update.
- List search and the six sort orders.
- Which environment opening a project goes to.
- Delete: the plan with each service's access, typing the name, the background delete with a state per service, the project kept when a service fails, refused when the plan changed. In 1.0 a delete also survives a restart.

**Environments and service copies**
- Environments: name normalization; "prod" and "prd" refused; duplicates refused; 32 characters. "Copy names from" with "Also copy the values" (only values the person may read). The default environment can't be deleted. Delete only when the environment has no services.
- Copies: each gets its own app name, volume, password and public port, and never the original's domains. Services from before linking are matched by name. A duplicate name is skipped and reported. A copy with no source takes its group's at first deploy. Copies aren't deployed on create.

**Variables**
- Own beats shared.
- `${{environment.NAME}}` and `${{NAME}}` in a service's values; an unknown reference fails the deploy with its name.
- Only names of letters, digits and `_` reach builds.
- Compose never inherits `DOCKER_*`, `COMPOSE_*`, `PATH` or `HOME`, and gets its variables as an env file.
- Values are masked with a reveal; 256 KB limit.

**Apps: deploys**
- A failed build or start leaves the old version serving, and the crashed container's last output ends the log.
- Apps that publish ports stop the old version first and start it again on failure.
- `PORT` is set.
- Automatic mode uses a Dockerfile when present.
- Clean cache works for every builder.
- Build timeout: one hour.
- Each app's images beyond its last three successful deploys are pruned.

**Apps: uploads and Git**
- Uploads: a single top folder in the zip is stripped, `__MACOSX` is ignored, paths that escape are refused.
- Git: shallow clones, submodules, SSH keys with host-key checks.

**Apps: push deploys**
- The GitHub App deploys apps and Compose on push and on tag, with watch paths, branch matching and the Autodeploy switch.
- GitLab, Bitbucket and Gitea calls are checked against their secret or signature.
- One deploy runs per service and one waits; a newer request replaces the waiting one.

**Apps: logs and terminal**
- Runtime logs: line counts, since, search, follow, Copy, Download, container picker.
- Terminal with sh or bash.

**Deletes**: containers, images, folders, volumes, routes and provider webhooks are removed. Deployment rows are kept as "Removed" for 30 days. Backup files in the bucket are kept.

**Deployments**
- 50 kept per service; 0.1.x kept 10.
- Cancel for queued and building deployments.
- A deploy whose server's runner isn't connected fails with a plain reason.
- A deploy left building by a restart runs again.
- The bell: latest 8, failed-since badge, "9+".
- "Deploy succeeded" and "Deploy failed" notifications.

**Databases**
- What each type runs with: user, password, database name, root password; Redis's password kept out of its command line; MongoDB replica set with a key file and first-start setup; libSQL roles, primary URL and namespaces.
- Data volume per type, including Postgres 18's folder.
- Up to 120 seconds to start, with a readiness check.
- Stop-first redeploy, with the old container started again on failure.
- Public ports from 20000 to 29999, allocated automatically and per copy; Make public and private redeploy the database.
- Dumps and restores of 1.0's own backup files for all five types; system schemas refused.

**Compose**
- Validate, pull, build, then up, so a refused file, a failed pull or a failed build leaves the running stack alone.
- The project name is the app name, so declared volumes belong to their stack; `container_name` is dropped, so copies can't collide.
- Stack files run with Compose with a note.
- Privileged options are checked on the host.
- Delete removes the stack's volumes.

Not run: no Docker-in-Docker suites and no servers. The console's wording and layout were taken as the spec describes them unless a gap above says otherwise.
