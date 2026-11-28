# G2. Projects and everything that runs: parity round 3 (0.1.79 and 1.0)

Reviewer: parity reviewer (dirty side), round 3. Compared: 0.1.79 at 938d9c4 (the reference behavior) and 1.0 at dac9631 (main, after the round 2 builder's merge), against `spec/` at the same commit. This file describes behavior only.

Scope: projects, environments, service copies, variables; applications (sources, builders, commands, ports, mounts, deploy actions, push deploys and webhooks, build and runtime logs, terminal); Compose; the six databases with backups and restore; deployments (list, detail, cancel, queueing and concurrency, retention, the bell, the canvas).

Not counted as gaps: the deliberate changes in `spec/00-index.md`, everything in `spec/27-dropped.md`, the owner's decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10, the decisions in `spec/30-parity-round-2.md`, punch-list items marked Done, and gaps already listed in 30a to 30d. R2-13 (firewall ports) is being built elsewhere and was not checked. R2-08's retry with another Node version is known to be open and is not repeated.

## Summary

| Severity | New gaps | Still broken |
| --- | --- | --- |
| P0 | 0 | 0 |
| P1 | 1 | 0 |
| P2 | 7 | 1 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| G2-01 | P1 | A crashed container's last output goes into the deploy log unredacted: variable values and credentials in URLs are readable by anyone who can see the deployment | 23.4, 06 6.5, 11.4 (spec gap) |
| G2-02 | P2 | A build log over 5 MB keeps its beginning and drops its end, so the error that failed the build is never stored | 06 6.5, 11.2 (spec gap) |
| G2-03 | P2 | Watch paths no longer understand negation (`!`), braces (`{a,b}`) or character classes (`[…]`), so such paths never match | 06 6.6 (spec gap) |
| G2-04 | P2 | Large push payloads are refused: over 1 MB at the deploy webhook, over 3 MB at the GitHub App's webhook | 06 6.6, 16.2 (spec gap) |
| G2-05 | P2 | The one-deploy-per-server limit also holds Reload, database deploys and Make public / Make private behind another app's build | 23.1, 30 decisions (R2-15), 08 8.2 |
| G2-06 | P2 | An app whose image health check starts failing after the deploy keeps running unhealthy and keeps getting traffic; 0.1.x replaced it | 06 6.5, 23.1 (spec gap) |
| G2-07 | P2 | Compose stacks whose containers need more than 5 minutes to become healthy fail every deploy: a first deploy is stopped, later ones are rolled back | 07 7.2, 7.3 (spec gap) |
| G2-08 | P2 | Two apps can no longer share a named volume on their server | 06 6.8 (spec gap) |
| Still broken: R2-11 | P2 | Preview Compose still tells people that every container joins the shared network | 07 7.2, 7.3 |

---

## Round 2 gaps, re-checked

| Id | Result | What I checked |
| --- | --- | --- |
| R2-01 | Fixed | With no port typed, each deploy reads what the pulled or built image declares, prefers 80, 3000, 8080, 8000, 5000 and 4173 in that order, else the lowest, else 80 for Static, else 3000, and logs "Service port N: <why>". A port typed on Configure or in Settings always wins. "Create without Git" leaves the port to the image. |
| R2-02 | Fixed | Reload of an app starts the running version's image as a new container with the saved variables, mounts, ports and start command, logs that nothing is fetched or built, and keeps the deployment's commit and image. A missing image is refused with a reason. |
| R2-03 | Fixed | Settings shows Autodeploy and the deploy webhook for image sources, with registry instructions. Docker Hub pushes and GitHub package events are read; another image or tag answers "Not deployed: …" and queues nothing. Upload sources have no webhook and a call explains why. |
| R2-04 | Fixed | In automatic mode, a build-path folder that depends on sibling workspace packages builds from the repository root with Nixpacks (through Turborepo when present), and the log says so. |
| R2-05 | Fixed | Build values go to builds as secret files, never on command lines; Nixpacks' plan no longer bakes them in; a generated plan containing a protected value stops the build and names the variable; public framework names still reach builds as arguments. |
| R2-06 | Fixed | 0.1.x file names (milliseconds and `Z`, `.bson.gz`, an empty folder) are listed and restored with the matching loader for each type; the Keep N decision is recorded. |
| R2-07 | Fixed | On the Nearzero host, bind mounts need an instance administrator at save and at deploy; an administrator's deploy approves exactly that definition; elsewhere they are allowed with a warning in the log. |
| R2-08 | Fixed (Node retry still open, as known) | Clone, pull and build retry up to three times on failures that look like network or registry trouble, with a log line; an automatic build whose Railpack plan fails continues with Nixpacks and logs "Railpack plan was not usable before compilation. Continuing with Nixpacks." |
| R2-09 | Fixed | Redeploy of an app or Compose stack from a repository rebuilds the commit the running version was built from and says so in the log; Deploy takes the branch's newest commit. |
| R2-10 | Fixed | GitHub's ping and Bitbucket's test answer "Ping received: the webhook is active." and deploy nothing; other Git host events never deploy; Bitbucket pushes are read and checked against the branch; a POST with no body still deploys. |
| R2-11 | **Still broken (wording only)** | The behavior is fixed: only inner services with a hostname join the shared network, and one that gets a hostname later joins it then. But see below. |
| R2-12 | Fixed | Stacks get `APP_NAME` and `COMPOSE_PROJECT_NAME` set to the app name unless the service's variables set them. |
| R2-13 | Not checked | In progress elsewhere; not on main yet. |
| R2-14 | Fixed | Paketo builds use the full Jammy builder. |
| R2-15 | Fixed, with a side effect | Deploys have their own worker lanes, schedules their own timers, and a server runs one deploy at a time by default. The limit also catches deploys that build nothing: see G2-05. |
| R2-16 | Fixed | `${{project.NAME}}` resolves to the shared `NAME` (a service variable literally named `project.NAME` still wins), and an unknown reference inside a shared value stays as written instead of failing deploys. |

### Still broken: R2-11 · P2 · Preview Compose still describes the old network rule

**0.1.x**: only inner services with a domain join the shared network. (Round 2 asked 1.0 to do the same, and it now does.)

**1.0 now**
- Deploys follow the new rule.
- The second file Preview Compose shows ("Nearzero's additions") still starts with the comment: "After it starts, every container also joins the private network nearzero-edge as <app name>-<service>, the address the router sends its hostnames to."
- So a person checking whether their unprotected cache or database inside a stack is reachable from other apps is told that it is.

**Expected 1.0**: for a stack with `web` (with a hostname) and `redis` (none), Preview Compose says that only inner services with a hostname join the shared private network (here `web`), and that the others stay on the stack's own network.

**Spec**: 07 7.2 (Preview shows what Nearzero adds), 7.3.

---

## New gaps

### G2-01 · P1 · A crashed container's last output goes into the deploy log unredacted

**0.1.x**
- When a new app version exits, restarts or never settles, the deploy log ends with the container's last output, cleaned first:
  - every value of the service's environment variables is replaced by "[redacted]";
  - credentials inside connection strings (`scheme://user:password@`) become "[credentials-redacted]";
  - terminal colour codes and control characters are removed;
  - at most the last 60 lines and 6,000 characters are kept.
- So an app that prints its configuration or a connection error with a full `postgres://user:secret@host/db` doesn't put the secret into the deployment record.

**1.0 now**
- The last 100 lines of the crashed container are written into the deploy log after "Its last output:", exactly as the container printed them. Nothing is redacted and colour codes stay.
- The same happens for a database container that fails to start.
- Deploy logs are readable by everyone who can see the service's deployments, including members who have no right to read its variables (spec 11.4), and are kept with up to 50 deployments.
- Build output, by contrast, is masked.

**Expected 1.0**
- An app whose start command prints the value of its `DATABASE_URL` variable and the text `postgres://app:s3cret@db:5432/app`, then exits 1, gives a Failed deploy.
- Its log ends with the container's last lines, with the variable's value and `s3cret` replaced by a redaction marker, and no terminal escape codes.
- The same holds for a database container's last output and for a Compose service's.

**Spec**: 23.4 (secrets never shown where they don't belong), 06 6.5 (the log ends with the last output), 11.4 (who reads logs). Spec gap: nothing says the crash output is cleaned.

### G2-02 · P2 · A build log over 5 MB drops its end, so the error that failed the build is never stored

**0.1.x**: build and deploy output is appended to the deployment's log file without a size limit, so the last lines (where a compiler or package manager prints why it failed) are always there. "Failure detected on line N" points at them.

**1.0 now**
- Output from the fetch, build and start steps is stored up to 5 MB per deployment. After that the log gets "… This log keeps the first 5 MB of output; the rest of this step's output is not stored." and every later byte of output is dropped, for all later steps too.
- Nearzero's own lines still appear, so a failed build ends with "The <builder> build failed (exit code 1)." but without the tool's error.
- Builds that print a lot (verbose package installs, large compiles, plain build progress) reach this, and the one part people need is gone.

**Expected 1.0**
- A build that prints 8 MB and then fails with a compiler error keeps that error, and the lines before it, in its stored log.
- The log says which part was left out, for example the middle.
- "Failure detected on line N" points at the real error.

**Spec**: 06 6.5, 11.2 (spec gap: no limit is described).

### G2-03 · P2 · Watch paths no longer understand negation, braces or character classes

**0.1.x**
- Watch paths are standard glob patterns. Besides `*`, `**` and `?`, they understand:
  - negation: `!docs/**`, which on its own means "anything outside docs";
  - braces: `{apps/web,packages/ui}/**`;
  - character classes: `src/*.[jt]s`.
- This applies to GitHub App pushes, the deploy webhook and Compose.

**1.0 now**
- Only `*`, `**` and `?` are special. `!`, `{`, `}`, `[` and `]` are taken literally.
- So `!docs/**` matches nothing and the app never deploys on a push. A brace or class pattern never matches either.
- Watch paths carried over from 0.1.x keep these patterns, and the console accepts them without a warning.
- (1.0's new rule that a plain folder name matches everything under it is an improvement and not a gap.)

**Expected 1.0**
- With the watch path `!docs/**` alone, a push changing only `src/index.ts` deploys, and a push changing only `docs/a.md` doesn't.
- With `{apps/web,packages/ui}/**`, a change to `packages/ui/button.tsx` deploys.
- With `src/*.[jt]s`, a change to `src/a.ts` deploys.
- Patterns that combine positive paths and `!` paths match what is under the positive paths, minus the excluded paths.

**Spec**: 06 6.6 (spec gap: the pattern syntax isn't described).

### G2-04 · P2 · Large push payloads are refused

**0.1.x**: the deploy webhook and the GitHub App's webhook read the whole body, whatever its size, so a push always gets its branch and watch-path check.

**1.0 now**
- The deploy webhook refuses bodies over 1 MB: "The webhook body is larger than 1 MB."
- The GitHub App's webhook, and every other webhook route, refuse bodies over 3 MB: "The request is too large. Send less at once."
- GitHub sends push payloads up to 25 MB. A push of many commits, or of one commit touching thousands of files (a dependency update, a vendored folder, a monorepo rename), lists every file and is easily larger.
- Such a push is refused, nothing deploys, and only the Git host's delivery log shows why. This contradicts "Pushes are never dropped".

**Expected 1.0**: a GitHub push event of 5 MB (with 20 commits listing 20,000 changed files) is accepted at both the GitHub App's webhook and an app's deploy webhook. It is checked for branch, watch paths and skip keywords like any push, and deploys.

**Spec**: 06 6.6 ("Pushes are never dropped"), 16.2 (spec gap: no body limit is described).

### G2-05 · P2 · The one-deploy-per-server limit also holds deploys that build nothing

**0.1.x**
- App Reload ("Reload Application"), database Deploy, and database restarts after a public port change run at once. They never wait in the install's deploy queue behind a build.
- Reload re-creates the running service. Databases are deployed directly.

**1.0 now**
- Round 2 made a server run one deploy at a time (R2-15). Every deploy-queue run counts against that limit, including:
  - an app's Reload (now a queued run with its own log);
  - a database's Deploy;
  - the restart that Make public and Make private start.
- While another app on the same server builds (up to an hour), each of these waits. The log says "Queued: waiting for <server>'s other deploy to finish (it builds one app at a time).", even for a database that builds nothing.
- Example: a person changes a variable and clicks Reload, or makes a database public to connect to it, and nothing happens for 20 minutes.

**Expected 1.0**
- While app A on a server builds for 10 minutes, these each start within a minute on the same server:
  - a Reload of app B;
  - a Deploy of a Postgres database;
  - Make public on that database.
- Only runs that build (apps and Compose stacks with a build step) wait for the server's build limit.
- A run that does wait names what it waits for in words that fit it.

**Spec**: 23.1, spec 30's decision on background work ("A server builds at most one app at a time"), 06 6.2 (Reload), 08 8.2 (Make public restarts the database).

### G2-06 · P2 · An app that turns unhealthy after its deploy keeps running and keeps getting traffic

**0.1.x**: apps run as Swarm services. When an image has a health check and the running container starts failing it (after a hang or deadlock, say), Swarm marks the task failed, replaces it with a fresh container, and stops routing to the unhealthy one. A hung app comes back by itself.

**1.0 now**
- Apps run as plain containers that restart only when they exit. The health check is used only while a deploy waits for the new version.
- After that, a container that turns "unhealthy" is left running, its hostname keeps sending traffic to it, and nothing restarts it, logs it or notifies anyone until a person notices and clicks Reload or Deploy.

**Expected 1.0**
- An app deployed from an image with a health check, whose health check starts failing an hour after the deploy, gets a fresh container automatically within a few minutes, and its runtime logs say so.
- A container that keeps failing its health check after being replaced is reported (on the service's page and as a failure notification) instead of being restarted forever without a word.

**Spec**: 06 6.5, 23.1 reliability (spec gap: the spec covers health only during a deploy).

### G2-07 · P2 · Compose stacks that need more than 5 minutes to become healthy fail every deploy

**0.1.x**: a Compose deploy runs `up` and is done when `up` returns. A stack whose search engine or database takes 8 minutes to pass its health check on first start (a large index or import, a long `start_period`) deploys and simply becomes healthy later.

**1.0 now**
- After `up`, the deploy waits for every container to run, pass its health check and stay up, for at most 5 minutes in all. A health check still "starting" after 5 minutes fails the deploy with "The stack never became healthy within 5 minutes."
- On a first deploy the new containers are then stopped ("There is no earlier version to go back to, so the new containers were stopped.").
- On later deploys the previous file is started again, so every change to such a stack is rolled back and can never be deployed.
- The wait can't be lengthened from the console.

**Expected 1.0**
- A stack whose `db` service has a health check with a 10-minute start period deploys successfully, and the deploy isn't failed while the health check is still within its start period.
- Only a container that exits with an error, keeps restarting or reports unhealthy fails the deploy.
- A failed first deploy says why, and the person can see the container logs.

**Spec**: 07 7.2, 7.3 (spec gap: no stability rule for stacks is described).

### G2-08 · P2 · Two apps can no longer share a named volume

**0.1.x**: a volume mount's name is the volume's name on the server. Two apps on the same server that mount a volume with the same name (a web app and its worker sharing `uploads`, for example) see the same files. Mounts were added through the Agent, which allowed this.

**1.0 now**
- Each app's volume name gets its own app name in front, so the same name typed in two apps makes two separate volumes. Nothing lets an app mount another app's volume.
- Volumes carried over from 0.1.x keep their exact names, so moved pairs keep sharing. But a new pair can't be set up, and a moved app's mount can't be re-added with the same effect.
- (Keeping volumes of other workspaces and projects out of reach, especially on the Nearzero host, is right and should stay.)

**Expected 1.0**
- On the Advanced tab, a person can mount an existing volume of another app in the same environment on the same server (for example "Use a volume of <app>"), and both apps see the same files.
- Volumes of services the person can't configure, or of other projects or workspaces, are never offered or accepted.
- Deleting one of the apps keeps the volume while the other still uses it.

**Spec**: 06 6.8 (spec gap: nothing says whether apps can share volumes).

---

## Checked and at parity

These match 0.1.79's behavior, or are better in 1.0 in line with the spec:

**Projects, environments, variables**
- Environment create:
  - name normalization and refusals ("prod", "prd", duplicates, 32 characters);
  - "Copy names from" with "Also copy the values", limited to values the person may read;
  - services copied in idle;
  - services from before linking are matched by name;
  - a name collision is skipped and reported;
  - copies on the Nearzero host are skipped for workspaces that can't use it.
- Environment rename and delete: the default environment can't be deleted, and an environment with services can't be deleted.
- Copies:
  - apps keep their source, builder, commands and port setting;
  - published ports and bind mounts aren't copied;
  - volumes are the copy's own;
  - a saved registry password isn't copied;
  - a Compose copy keeps its file, format and deploy settings.
- Variable resolution:
  - own beats shared;
  - `${{environment.NAME}}`, `${{NAME}}` and 0.1.x's `${{project.NAME}}` all resolve;
  - an unknown reference in a service's own value fails the deploy with its name;
  - a loop is refused;
  - total size is capped;
  - builds get only letter, digit and `_` names;
  - Compose never inherits Docker and Compose control names.

**Applications**
- App names: 50 characters before the suffix, plus a 6-character suffix; 0.1.x allowed 63 in all.
- Header actions, by state, and their confirms; "Create URL" and the "Live at" banner.
- Deploy pipeline:
  - a failure leaves the old version serving;
  - apps with published ports stop first and start the old version again on failure;
  - images beyond the last three successful deploys are pruned;
  - containers restart unless stopped;
  - the first log line names the version;
  - a deploy waits for a health check when the image has one.
- Git clone: depth 1 at the requested commit, with a fallback when a host doesn't serve single commits; submodules; transient retries.
- Builders and their fields: Dockerfile path, context and stage; Railpack version; Nixpacks publish directory; Heroku stack; Paketo; Static with single-page mode.
- The automatic choice, with Railpack falling back to Nixpacks and a language build falling back to a repository Dockerfile.
- Build secrets handling.
- Deploy webhook:
  - Autodeploy off answers that calls are ignored;
  - a replaced URL stops working;
  - a burst queues at most one deploy;
  - Git host signatures are checked on the raw body;
  - skip keywords are honored;
  - On push and On tag;
  - deletes of branches and tags never deploy;
  - for provider-linked sources, a push naming another repository is ignored.
- Terminal: sh and bash, the same choices 0.1.x offered.
- Deployment detail: "Failure detected on line N", "Find in logs", "Load all", Copy.

**Compose**
- Validate, pull, build and `up`, with the previous version started again when a later step fails.
- The project name is the app name; `container_name` is dropped; built images are tagged per deployment; bind mounts are rewritten into the service's folder.
- Variables reach Compose as an env file with values taken literally, and a repository's own `.env` is honored.
- Only routed inner services join the shared network; `APP_NAME` and `COMPOSE_PROJECT_NAME` are set.
- The same Compose file names are looked for in repositories (`docker-compose.yml`, `docker-compose.yaml`, `compose.yml`, `compose.yaml`).
- The Stop and Start rules by format.
- Moved stacks: 0.1.x's API-only options for random names and isolated networks had no screen. Their loss is named at import.

**Databases**
- What each type runs with: user, database name and root password defaults (MySQL "app"); Redis's password kept out of its command line.
- MongoDB replica set with a key file and first-start setup; libSQL roles, primary URL and namespaces.
- Data paths, including Postgres 18's folder.
- Readiness checks that wait for the real server, not the temporary one images run while initializing.
- Stop-first redeploy with the old container started again on failure.
- Connection URLs: internal by app name, and public by the server's address with percent-encoded credentials, `authSource=admin`, `replicaSet=rs0` inside and `directConnection=true` from outside.
- Public ports: allocated from 20000 to 29999 avoiding app and Compose ports; Make public and Make private restart a deployed database.
- The header shows no Reload, as in 0.1.79, where Reload was hidden.

**Backups and restore**
- Postgres dumps and restores with clean and if-exists; 1.0's plain dumps load in one transaction.
- MongoDB restores drop first.
- 0.1.x's custom-format, single-database and folder-archive files load with the right tool.
- Only a service's own files are listed and accepted.
- A restore loads into the database the file came from, unless the person names another.

**Deployments**
- One deploy runs per service and one waits; a newer request replaces the waiting one; Redeploy and Reload never replace a waiting push.
- Cancel for queued and building deployments.
- Deploys resume after a control-plane restart.
- 50 kept per service (0.1.x kept 10).
- "Redeployment queued", and "Databases are deployed from their own page." for database rows.
- Deploy log: the first line names the version; the live stream resumes.

Not run: no test suites, no servers, no Docker-in-Docker. Findings come from reading both versions' behavior. The console's wording and layout were taken as the spec and 21.10 describe them, unless a gap above says otherwise.
