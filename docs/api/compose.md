# Compose runtime API (M7)

Compose stacks at run time: deploys of a pasted Compose file or one from a repository, Preview Compose, Start / Stop / Reload, the containers with their row actions and per-container logs and terminals, hostnames for inner services, and the volumes volume backups use. Implements spec 07 (all), 05 5.5 (Compose variables: the env file and its exclusions), 06 6.6 (push deploys and webhooks for Compose), 10.1 and 10.6 (inner-service hostnames, punch-list item 5), 17.3 (a stack's volumes), 22.3 and 24 (G3).

Conventions (errors, cookies, `Cache-Control: no-store`) are those of [identity.md](identity.md); deployments, their logs, the queue, cancel, webhooks and teardown are those of [deploys.md](deploys.md), which hands Compose services to this area. Code: `apps/control/src/compose-runtime/` (`model.ts` reading and inventory, `privileged.ts`, `render.ts` the files Nearzero runs, `plan.ts`, `source.ts`, `host-policy.ts`, `deploy.ts` the pipeline, `runtime.ts`, `volumes.ts`, `routes.ts`, `tables.ts`), migration 0450; runner `runner/src/compose/`; protocol `packages/shared/src/runner-compose.ts`.

## The format

A service's format (`settings.format`: `compose` or `stack`) is fixed at creation. **Stack** files run with the same runtime: Docker Compose on the service's one server, without Swarm. The format only changes how the file is read (Preview and the deploy log say so); `deploy.replicas` and resources apply, Swarm placement and update settings don't, and a Stack has no Start (deploy it to bring it back).

## Who may do what

| Action | Needs (members: on the service) |
| --- | --- |
| The stack's summary, Preview Compose | Access to the service (`service.see`) |
| The containers, per-container logs, the volumes | `service.deployments` |
| Deploy, Reload, Start, Stop, container Restart / Start / Stop / Kill, the terminal | Deploy rights (`service.deploy`) |
| Save the pasted file (`PATCH /services/:id { settings: { composeFile } }`), the repository source (git-providers.md), Autodeploy and Clean cache (`PATCH /services/:id/deploy-settings`) | Configure rights |
| Privileged options on the Nearzero host | An instance administrator's deploy (below) |

## The files Nearzero runs (spec 07 7.3)

Nearzero never rewrites the person's file. A deploy writes, in the stack's folder on the server (`<work>/compose/<app name>`, the **service's folder**), the person's file as it is and **Nearzero's additions** (`nearzero.yml`), and runs `docker compose -f compose.yml -f nearzero.yml`. Compose merges the additions on top:

- labels on every inner service: `dev.nearzero.managed`, `dev.nearzero.service` (the service id), `dev.nearzero.deployment` (so every deploy makes new containers and their logs belong to one deployment), `dev.nearzero.compose-service`, and for the services hostnames go to, the router's `dev.nearzero.route.hostnames` and `dev.nearzero.route.port` (the router itself is configured by route files; these say which hostnames reach the container);
- `container_name: !reset null` where the file sets a container name, so copies in other environments and other stacks never collide;
- for services that build without an `image:`, a tag per deployment (`nearzero/<app name>-<service>:<deployment>`) and labels on the build, so a failed deploy can start the previous images again and teardown finds them;
- bind mounts and `configs:`/`secrets:` files inside the service's folder written as `${NEARZERO_SERVICE_FOLDER}/<path>` (with `!override` for that service's volume list), the folder as the Docker Engine sees it: the Nearzero host's runner runs in a container, where the work folder is a volume mounted elsewhere;
- labels on the file's own (non-external) volumes.

After `up`, the containers of the inner services hostnames route to (except those with a `network_mode`) join the private network `nearzero-edge` with the alias `<app name>-<service>`, which routes point at (30b R2-11). The other inner services stay on the stack's own network, so a database or cache inside a stack is reachable from that stack only, never from every app and stack on the server. A hostname connected to another inner service between deploys makes that service join at once. It is joined through the Engine API rather than in the YAML, so a service's plain name never becomes a DNS name on the network every stack shares.

Requires Docker Compose 2.24.4 or newer on the server (`!reset`, `!override`); an older one fails the deploy with that.

**Variables** (spec 05 5.5) reach Compose only as an env file, `.nearzero/env` (mode 0600), passed with `--env-file`: `APP_NAME` and `COMPOSE_PROJECT_NAME` set to the service's app name (30b R2-12; a variable of the service's own with that name wins), the environment's shared variables without Docker and Compose control names (`DOCKER_*`, `COMPOSE_*`, `PATH`, `HOME`), then the service's own (its own win). Each value is double-quoted with `\`, `"` and `$` escaped, so Compose reads it exactly as saved. A pasted file also gets the same file as `.env` in its folder (for `env_file: .env`). A repository's own `.env` next to its Compose file is passed first, so its defaults apply and Variables win. Values are cut out of everything the runner prints. A placeholder with no default (`${NAME}`, `$NAME`, `${NAME:?…}`) whose variable isn't set stops the deploy before anything changes: "The Compose file uses POSTGRES_PASSWORD, which isn't set. Add it under Variables, then deploy."

## Privileged options (spec 07 7.3, 24 G3)

Found in the file after interpolation with the service's real variables (a path made of an unset variable can't be checked and counts as outside; `HOME`, `DOCKER_CONFIG`, `DOCKER_HOST`, `PATH`, `BUILDKIT_PROGRESS` and `NEARZERO_SERVICE_FOLDER` are checked with the runner's own values, which Compose uses over any env file): the host's network (`network_mode: host`, a `host`/`macvlan`/`ipvlan` network, `build.network: host`), the host's namespaces (`pid`, `ipc`, `uts`, `userns_mode`, `cgroup: host`, another container's namespaces, `cgroup_parent`), privileged mode (also builds, hooks and Compose providers), the Docker socket, paths outside the service's folder (bind mounts, `env_file`, `label_file`, `extends`, `include`, build contexts and Dockerfiles, `configs`/`secrets` files, `driver_opts` devices), added capabilities beyond Docker's defaults, devices, `security_opt` that switches a protection off, and Docker objects other stacks share (external volumes and networks, fixed volume names outside the stack, `volumes_from: container:…`, other volume drivers). A repository's relative paths may reach its own root, never past it. A service that borrows another one's mounts or namespaces (`volumes_from: <service>`, `network_mode`/`pid`/`ipc: service:<name>`) reaches what that one reaches. Other Compose files (`include`, `extends` with `file`) are a finding of their own ("Other Compose files"): Docker Compose reads them on the server, so what they add can't be checked beforehand.

- **Elsewhere**: warnings on Preview and in the deploy log (`Warning: …`).
- **On the Nearzero host**: refused for anyone but instance administrators. An administrator's deploy records exactly those options in exactly those definitions (`compose_stack.approved_keys`: each key carries a fingerprint of the service it is in, the services it extends in the same file, and where the file comes from; a top-level volume, network, config or secret carries the services that use it); later deploys by anyone with deploy rights, and push and webhook deploys, may run the same again. A new option, or any change to a service that has one (its image, command, anything), needs an administrator first. Other Compose files are never approved: on the host they run only when an instance administrator deploys, every time. A pasted file is checked before it queues (403 `This Compose file uses options that reach the Nearzero host itself (privileged mode, docker socket). On the Nearzero host only Nearzero administrators can deploy them. Remove them, or deploy the stack to another server.`); a repository's file once it is fetched (the deployment fails with the same words, "Refused on the Nearzero host: …" per option, and nothing changes).

Published ports Nearzero needs (22, 80, 443; on the host 53, 3000, 4321) are refused: `web: Port 80 is used by Nearzero on this server. Pick another.`

On the server, every bind source inside the folder is made as a folder when missing and refused when any part of its path is a symbolic link (a container could plant one); the runner's own writes there never follow links either.

## Deploying (spec 07, 06 6.5, 23.1)

`POST /services/:id/deployments`, Redeploy, pushes and the deploy webhook queue Compose deploys exactly as apps (one running, one waiting; cancel). With no file: 409 `This Compose service has no Compose file yet. Paste one under Source, or connect a repository, then deploy.`

The pipeline (`compose-runtime/deploy.ts`, the log in order):
1. The file: `Using the Compose file saved on this service.`, or the repository fetched at the commit with `source.git` (through the Git provider's short-lived credentials, as apps) and copied into `repo/` of the service's folder (`compose.prepare`: files removed from the repository since the last copy go, data the stack wrote stays, links outside the repository are left out and named), then `Using ./deploy/compose.yml from the repository.` The deployment's title and commit are the commit's.
2. Checks, before anything on the server changes: YAML and shape (`The Compose file can't be used: It isn't valid YAML: line 3, column 12: …`, `The service web needs an image: or a build: to run.`), missing variables, reserved ports, privileged options. A failure here logs `Nothing was changed on the server; the running stack keeps serving.`
3. Hostnames from every registered hostname provider (the domains area gives the web-looking inner service its automatic hostname), then the final files.
4. `compose.deploy` on the server: `docker compose config --quiet` (a file Compose refuses: `Docker Compose refused the file: …`), `pull --ignore-buildable`, `build` (Clean cache: `--no-cache`), then `up --detach --remove-orphans --no-build`, then the network. Failures before `up` change nothing.
5. A wait until every container runs and stays up for the stability window (`deploy-settings` `stabilitySeconds`, default 10; a health check must pass first; a one-off container may finish with exit code 0). A crash, restart, failed health check or exit with an error fails with the container's last 100 lines.
6. Routes `s-<service id>-<hash>` to `<app name>-<inner service>:<port>`; stale ones removed. `Deployment complete. It's live at: …` or `… This stack has no domain yet …`.

A failure after `up` started (or a cancel then) starts the previous deployment's files again with its images (`Starting the previous version again.` / `The previous version is running again.`); with no earlier version the new containers are stopped. The files of the last successful deploy are kept in `compose_stack` (they hold no secrets). Built images beyond the last three successful deployments are removed.

Repository stacks redeploy on push like apps (git-providers.md); their Compose file's inner services and volumes are kept on the service as `settings.composeInventory` (at every deploy and Preview), which the domains area reads for repository files (punch-list item 5) and the backups area for declared volumes.

## Endpoints

| Endpoint | Response |
| --- | --- |
| `GET /services/:id/compose` | `{ format, formatLabel ("Compose" \| "Stack"), formatNote (Stack only), source: { type: "raw" \| "provider" \| "git" \| null, label }, needsDeploy, needsDeployMessage ("Deploy to start the stack." / "Saved changes reach the stack on its next deploy."), deployedAt, deploymentId, services: { name, port }[], onHost }` |
| `GET /services/:id/compose/preview` | `{ available, message, source, files: [{ name: "compose.yml", title: "Your Compose file", description, content }, { name: "nearzero.yml", title: "Nearzero's additions", description: "Docker Compose merges this file over yours.", content }], warnings: { kind, label, service, message }[], refused, refusal, problems: string[], variables: { delivered: names, uses: names, missing: names, note: "Variables reach Compose as an env file on the server. Their values are never shown here." }, notes: string[] }`. A repository's file is read through its Git provider at the branch (with the person's access); a plain Git URL, or a provider that can't be read, shows the last deploy's files. The deployment label reads `<this deployment's id>`; hostname labels are the service's current hostnames (Preview gives none). |
| `GET /services/:id/compose/containers` | `{ containers: { id, shortId, name, service (inner), state, status, image, current (part of the serving deployment), createdAt }[], message (the server couldn't be asked), checkedAt }`: containers with the service's label or the stack's Compose project label, by inner service |
| `POST /services/:id/compose/containers/:containerId/restart` · `/start` · `/stop` · `/kill` | `{ container, message: "Restarted <name>" \| "Started …" \| "Stopped …" \| "Killed …" }`; 404 `That container isn't one of this stack's.`; Kill of a stopped one 409; 409 while deploying |
| `GET /services/:id/compose/volumes` | `{ volumes: { name, key, declared, labelled, external, innerServices }[], checkedServer, message }`: the file's declared volumes (Docker's names: `<app name>_<key>`, a `name:`, or an external name) plus volumes on the server labelled `com.docker.compose.project=<app name>` or `dev.nearzero.service=<id>`. Never by name prefix. `stackVolumes(services, row)` in `volumes.ts` is the same for the backups area. |
| `POST /services/:id/start` · `/stop` | Every container of the serving deployment, in dependency order (Stop in reverse): `{ status, message: "Started" \| "Stopped" }`; the deployment becomes `not_running` and `active` again. A Stack has no Start (409 `A Stack starts again when you deploy it.`). |
| `POST /services/:id/reload` | A redeploy titled "Reload": `{ status: "deploying", message, deploymentId }` |
| `GET /services/:id/logs?container=` · `GET /services/:id/terminal?container=` | deploys.md: any of the stack's containers, by id, id prefix or name; the terminal needs deploy rights. `GET /services/:id/runtime` lists them for the pickers. |

Deleting a Compose service always removes its volumes (teardown: `compose down --volumes`, then labelled volumes), its containers, images, folder and routes, and its hostnames. A folder a container took over through a bind mount (Postgres makes its data folder 999:999 0700, which the Nearzero host's runner, root with every capability dropped, can't read) is emptied by a short-lived container of the runner's own image (`nearzero-cleanup-…`, no network, Docker's default rights) and then removed, so the delete finishes and can be retried. A redeploy from a repository leaves out the repository's files that would go into such a folder and logs them ("Left out pgdata/.gitkeep from the repository: a container owns the folder it goes in, …").

## Runner commands (additive, protocol 1)

| Kind | What it does |
| --- | --- |
| `compose.prepare` | `{ project, repository?: { appKey, composePath, envFiles } }` → `{ folder, hostFolder, composeVersion, composeFile, envFiles, envValues, skippedLinks }`: makes the service's folder, copies a fetched repository into `repo/`, reads its Compose file (≤ 1 MB, inside the repository after links) and env files (their values are for the control plane's checks only) |
| `compose.deploy` (streams) | `{ project, directory, files, envFile (secret), writeDotEnv, extraEnvFiles, secrets, bindPaths, pull, build, noCache, network: { name, aliasPrefix } }` → `{ ok, stage (validate \| pull \| build \| up \| connect), message, touched, containers, notConnected }`; sets `NEARZERO_SERVICE_FOLDER` for Compose |
| `container.restart`, `container.kill` | `{ id, timeoutSeconds }`, `{ id, signal: "KILL" }`; never Nearzero's own containers |

`compose.up` and `compose.down` (M3a) stay; teardown uses `compose.down`.

## Audit events

`service.deploy-requested`, `service.start`, `service.stop`, `compose.container-restart`, `compose.container-start`, `compose.container-stop`, `compose.container-kill`, `terminal.opened`.

## Tests

`apps/control/test/compose-rules.test.ts` (reading, inventory, interpolation, privileged options, the additions, the env file, ports), `apps/control/test/compose.test.ts` (end to end against the fake runner with `test/support/fake-compose.ts`), and the Docker-in-Docker suite `e2e/compose/compose.e2e.ts` (`bun run --cwd e2e test:compose`). Console: `apps/console/sweep/compose.ts`, `apps/console/e2e/compose.e2e.ts`.
