# R4. The Agent and the technical layer: parity of 0.1.79 and 1.0

Reviewer: parity reviewer (dirty side). Compared: 0.1.79 (the reference behavior) and 1.0 at 9a01ec7, against `spec/` at the same commit. This file describes behavior only: what a person, the model, a Git host, a monitor or a script sees and gets.

Scope: the Agent (chat, sessions, streaming, stop, retry, edit, attachments, deep research, model provider and keys, Agent policies, every action the model can call and its safety, guided flows, answers without keys, errors) and the technical layer (the API surface, programmatic access, webhooks in and out, live updates, background jobs and schedules, email, security, performance, the installer and the `nearzero` command, the platform's own logs, health, version and update checks).

Not counted as gaps: the deliberate changes in `spec/00-index.md` and `spec/19.12`, everything in `spec/27-dropped.md`, the owner's decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10, and punch-list items marked Done. Server email setting names and trusted origins are in the identity review (R1) and are not repeated here.

## Summary

| Severity | Count |
| --- | --- |
| P0 | 0 |
| P1 | 3 |
| P2 | 13 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| R4-01 | P1 | A pasted repository link goes straight to the model, unchecked (0.1.79 runs a checked import with an access card) | 19.7 (spec gap: spec predates 0.1.79) |
| R4-02 | P1 | The 1.0 uninstaller deletes a 0.1.x install's folders but leaves its containers, services and volumes running | 3.3 (spec gap) |
| R4-03 | P1 | All background work shares four worker lanes: long task runs, setups or builds hold up deploys and make backups and tasks start late; no per-server build limit | 23.1, 23.2, 12 (spec gap) |
| R4-04 | P2 | The Agent can't read one service's settings (source, branch, image, builder, autodeploy, recent deployments) | 20.2 (spec gap) |
| R4-05 | P2 | The Agent can't read a task run's output | 20.12 (spec gap) |
| R4-06 | P2 | Agent Git imports can't set the builder or commands when creating the app | 20.3 |
| R4-07 | P2 | The Agent can't choose a database's image, database name or user | 20.5 (spec gap) |
| R4-08 | P2 | With exactly one ready server, the Agent places a new service there without asking | 19.7 step 5 (spec gap for the model path) |
| R4-09 | P2 | 0.1.x Agent operator settings are ignored after a move, including the kill switch | 3.5, 19.6, 19.10 (spec gap) |
| R4-10 | P2 | `sudo nearzero logs platform` (the documented 0.1.x form) is refused | 3.4 (spec gap) |
| R4-11 | P2 | `GET /api/health` no longer answers | 23.1, 29.5 (spec gap) |
| R4-12 | P2 | Image apps lose registry-push redeploys; moved image webhooks deploy on any call | 6.6 (spec likely wrong) |
| R4-13 | P2 | The deploy webhook deploys on Git host events that aren't pushes (including GitHub's ping) and ignores the branch of Bitbucket pushes | 6.6, 24 G4 |
| R4-14 | P2 | The custom webhook channel's JSON body changed shape | 15 (spec gap) |
| R4-15 | P2 | Moved Git providers' registered callback addresses (GitHub App setup, GitLab and Gitea OAuth) aren't answered | 16, 29.5 (spec gap) |
| R4-16 | P2 | Audit records are stored but nothing can read them | 22.4 rule 8 |

---

## Gaps

### R4-01 · P1 · A pasted repository link goes to the model without being checked

**0.1.x (0.1.79)**
1. A message that is a link to a repository on github.com, gitlab.com, bitbucket.org or codeberg.org, alone or with words asking to deploy it, runs the same step-by-step import as the "Deploy a Git repository" starter, not the model. A question about a link ("what does github.com/acme/web do?") still goes to the model, and so do SSH links and other hosts.
2. Link shapes read: `https://host/owner/repo`, `host/owner/repo`, a `.git` ending, and `/tree/<branch>` links. The `/tree/` branch is used only when the repository really has it.
3. Order of checks:
   - A connected account that can see the repository is used, so pushes redeploy it. The public URL is not probed in this case.
   - Otherwise it asks the host over git, with no stored login and only those four hosts, whether anyone may read the repository.
   - Public: it is deployed from its URL, on the `/tree/` branch, else the repository's default branch, else main or master, else the only branch, else a branch picker "Choose the branch of <owner/repo> to deploy". How it runs is read from a clone without file contents. Then the usual project, server, environment and variables questions, deploy and wait. A public repository with no branches: "**<owner/repo>** on <Host> is public, but it has no branches yet. Push some code to it, then ask again."
   - Private or missing (hosts answer both the same way): nothing is created. Text: "I can't open <owner/repo>. It's private or doesn't exist, and none of your connected <Host> accounts can see it." (or "…and no <Host> account is connected to Nearzero."), then "Give Nearzero access to it, then check again. If it's meant to be public, check the link." A card offers **Give access on GitHub** (opens the Nearzero GitHub App's install page; "Give <account> access" when there are several accounts), **Connect <Host>** (Git provider settings, returning to the same chat) and **Check again** (looks again from the start). Status line: "Waiting for access to the repository".
   - Someone who may not connect accounts gets the same first sentence plus "Check the link, or ask an owner or admin to connect the <Host> account that owns it (Settings → Git providers). Nothing was created."
   - Host unreachable: "I couldn't reach <host> to check **<owner/repo>**: <reason> Nothing was created. Try again in a moment."

**1.0 now**
- Any message containing a Git URL or a bare `host/owner/repo` skips the guided flows and goes to the model, as spec 19.7 says.
- The model's "create an app from a Git URL" action creates the app without checking that the repository can be read, and without trying a connected account first.
- When the model gives no branch, the branch is "main", so a repository whose default branch is master fails only at deploy. A `/tree/dev` link is accepted as if it were part of the repository path.
- Nothing shows an access card. The model can promise a deploy that cannot happen.

**Expected 1.0 behavior (acceptance)**
- "deploy https://github.com/acme/web", when a connected GitHub account can see acme/web: imported through that account, with push deploys and the usual project, server and variables pickers. The public URL is not probed.
- The same link for a public repository that no account can see: deployed from its URL on its real default branch. ".../tree/dev" deploys dev. The server is chosen in a picker, never asked for in plain text.
- A private or missing repository: the card with Give access on GitHub, Connect GitHub and Check again. No project, service or record exists afterwards. Check again, after access is granted, continues the import.
- "what does github.com/acme/web do?" still goes to the model.

**Spec**: 19.7 "Import from Git" says "Not triggered by an explicit Git URL (the model handles it)", and its acceptance line expects "deploy github.com/acme/web" to go to the model. The spec was written against 0.1.77 and should adopt 0.1.79's behavior: spec gap.

### R4-02 · P1 · The 1.0 uninstaller half-removes a 0.1.x install

**0.1.x**
- The uninstall command (`curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash`) on a 0.1.x server:
  - stops and removes the control plane and its database and queue store, the router, socket proxy, monitoring and DNS;
  - removes every swarm service and leaves the swarm;
  - removes every app, database and Compose project it deployed;
  - deletes its networks, unused volumes, images and build cache;
  - then deletes `/opt/nearzero`, `/etc/nearzero` and the command.
- `NEARZERO_UNINSTALL_YES=true` works like `--yes`.

**1.0 now**
- The 1.0 uninstaller will be served at the same public address. It treats any `/opt/nearzero`, `/etc/nearzero` or `nearzero` command as an install, but removes only Docker objects that carry 1.0's own label. It then deletes `/opt/nearzero` and `/etc/nearzero` and prints "Removed Nearzero".
- On a server that still runs 0.1.x (never moved, or moved but not finalized), the 0.1.x containers, swarm services, volumes and networks are left behind. They keep running or restart in a loop with their settings, Compose files, router configuration and certificates gone, and the uninstaller doesn't mention them.
- `NEARZERO_UNINSTALL_YES` is ignored.

**Expected 1.0 behavior (acceptance)**
- On a host with a 0.1.x install (alone or beside 1.0), the uninstaller does one of two things:
  - removes the 0.1.x install as completely as 0.1.x's own uninstaller did (containers, swarm services and swarm membership, networks, volumes and data);
  - or stops before deleting anything, names the 0.1.x install, and says what to run.
- It never deletes `/opt/nearzero` or `/etc/nearzero` while containers that use them remain.
- Spec 3.3's acceptance holds afterwards: nothing from Nearzero remains, of either version.
- `NEARZERO_UNINSTALL_YES=true` skips the question like `--yes`.

**Spec**: 3.3 covers only 1.0's own objects. Spec gap.

### R4-03 · P1 · Long jobs share four lanes, so tasks, backups or setups can hold up deploys

**0.1.x**
- Deployments went through their own queue, one at a time for the whole install.
- Scheduled database backups, volume backups, tasks and the daily Docker cleanup started on their own timers at the scheduled minute, independent of builds.
- A long task never delayed a deploy, and a long build never delayed a 02:00 backup.

**1.0 now**
- One pool of 4 workers (an operator setting) carries every kind of background work. That includes whole deploys (build and rollout), task runs (up to 6 hours each), server setup (steps of 10 to 20 minutes), backups and restores, deletes, the Docker cleanup, and the backup and task schedulers' own ticks.
- Four long task runs, or four builds after a monorepo push, leave nothing free:
  - pushes, console deploys and Agent deploys stay "Queued" until a lane frees;
  - scheduled backups and tasks start late, or the schedulers themselves stall.
- There is no per-server limit, so four builds can run on one small server at once. 0.1.x built one at a time.

**Expected 1.0 behavior (acceptance)**
- While 4 task runs of 30 minutes each are running, a push to an app starts its deploy within seconds, and a backup scheduled for that minute starts within a minute.
- Schedulers tick on time whatever else is running.
- Builds on one server are bounded, for example one at a time per server. The rest show "Queued" with a log line saying they wait for the server's other build.

**Spec**: 23.1 ("Long work outlives requests"), 23.2 (one scheduler) and 12 don't set concurrency. Spec gap.

### R4-04 · P2 · The Agent can't read one service's settings

**0.1.x**: The model can read one service and gets:
- its status, project, environment, whether it is production, and a link to its console page;
- where it builds from: source kind, repository (owner/name, or the Git URL with any credentials removed), branch, image;
- its builder, whether autodeploy is on, and the trigger;
- its last 5 deployments with status and title.

**1.0 now**
- "Find service" returns only name, kind, project, environment, production, server, status and internal app name.
- "Read push deploys" adds on/off, trigger and watch paths.
- No action tells the model a service's repository, branch, image, builder or commands. "Which branch does web deploy from?" or "why does api build with Nixpacks?" can't be answered from a result, and the keep-going loop can't see the current builder before it changes it.

**Expected 1.0 behavior (acceptance)**: a read-only action returns a service's source (repository or a URL without credentials, branch, folder, image), its builder and commands, autodeploy and trigger, its hostnames and its last 5 deployments, with no secret values. Asking "which branch does web deploy from?" gets the branch from a step's result.

**Spec**: 20.2 lists only "find". Spec gap.

### R4-05 · P2 · The Agent can't read a task run's output

**0.1.x**: Reviewing a task lists its last ten runs. The model then reads any run's output with the same reader it uses for deployment logs, so "why did the nightly dump fail?" is answered from that run's log.

**1.0 now**: Review gives each run's time, state and exit code only. No action reads a run's output.

**Expected 1.0 behavior (acceptance)**: an action reads one task run's log, by default the last 200 lines and at most 10,000, under the person's Tasks access. After a failing run, "why did <task> fail last night?" quotes lines from that run.

**Spec**: 20.12. Spec gap.

### R4-06 · P2 · Agent Git imports can't set the builder or commands when creating the app

**0.1.x**: Creating an app from a connected repository or a Git URL takes the builder (Dockerfile, Railpack, Nixpacks, Heroku buildpacks, Paketo buildpacks, static; automatic or explicit) and the install, build and start commands in the same action. Secret-looking commands are refused.

**1.0 now**: Both create actions take name, project, environment, server, repository or URL, branch and folder only. The builder and commands need a second "change how it builds" action.

**Expected 1.0 behavior (acceptance)**: as spec 20.3 lists, creation accepts the builder and the three commands with the same refusal rules. "Import acme/web with its Dockerfile" creates it with the Dockerfile builder in one step.

**Spec**: 20.3.

### R4-07 · P2 · The Agent can't choose a database's image, database name or user

**0.1.x**: Creating a database through the Agent can take an image (for example `postgres:15`), a database name and a user name. Passwords are always generated.

**1.0 now**: Creation takes only kind, name, project, environment and server, so a database always gets the default image. "Create a Postgres 15 database" gets the default version, and no Agent action can change the image afterwards.

**Expected 1.0 behavior (acceptance)**: an optional image (checked like the console's image field), database name and user. Passwords are still never accepted. "Create a postgres 15 database called orders" creates one with a 15 image.

**Spec**: 20.5. Spec gap.

### R4-08 · P2 · With one ready server, the Agent places new services there without asking

**0.1.x**: When no server was named and ready servers existed, the Agent asked which one to use, listing them and the Nearzero host. It never placed a service without asking.

**1.0 now**: On the model path:
- exactly one ready server is used without a question;
- several ready servers produce a question;
- with none, the service goes to the Nearzero host and the reply says so.

With one ready server, the person is never offered the Nearzero host.

**Expected 1.0 behavior (acceptance)**: whenever at least one ready server exists and none was named, the person chooses: the ready servers, plus "Nearzero host" when they may use it. This is the same picker the guided import uses.

**Spec**: 19.7 step 5 describes the guided import only. Spec gap for the model path.

### R4-09 · P2 · 0.1.x Agent operator settings are ignored after a move

**0.1.x**: The platform's example settings file documents these settings:
- `NEARZERO_AGENT_ENABLED` (false turns the Agent off);
- `OPENROUTER_CHAT_MODEL`, `OPENROUTER_TITLE_MODEL`, `OPENROUTER_FOLLOWUPS_MODEL`, `OPENROUTER_BASE_URL`;
- `NEARZERO_AGENT_SYSTEM_PROMPT`;
- `NEARZERO_AGENT_GREETING_TITLE` and `NEARZERO_AGENT_GREETING_SUBTITLE` (`{firstName}` is replaced);
- `NEARZERO_AGENT_ONBOARDING_GREETING_ADMIN` and `NEARZERO_AGENT_ONBOARDING_GREETING_MEMBER`;
- `NEARZERO_AGENT_MAX_TURNS`, `NEARZERO_AGENT_DEEP_RESEARCH_MAX_TURNS`, `NEARZERO_AGENT_ATTACHMENTS_PATH`.

**1.0 now**
- 1.0 reads only its own names: kill switch, model, small model, provider address, prompt addition, greeting and attachment cap.
- The 0.1.x lines are carried forward in the settings file but never read.
- An install that turned the Agent off in 0.1.x has it on again after the move. Its custom prompt, models and greeting silently stop applying.

**Expected 1.0 behavior (acceptance)**
- Where a 1.0 setting exists, the 0.1.x name is read as an alias:
  - `NEARZERO_AGENT_ENABLED=false` → the kill switch;
  - the chat model → the model;
  - the title or follow-ups model → the small model;
  - the base URL → the provider address;
  - the greeting title → the greeting.
- The old system prompt is appended as the operator's text and never replaces the built-in rules.
- The installer or the import report names the 0.1.x settings 1.0 ignores.
- A moved install with `NEARZERO_AGENT_ENABLED=false` answers every message with "Nearzero Agent is disabled."

**Spec**: 3.5 lists installer settings only; 19.6 and 19.10 define the operator settings without their 0.1.x names. Spec gap.

### R4-10 · P2 · `nearzero logs` no longer knows the 0.1.x service names

**0.1.x**: `sudo nearzero logs platform` follows the API's logs, as the public self-hosting docs show. The other 0.1.x service names work the same way.

**1.0 now**: The services are control, runner, postgres, router and dns. `platform` gets "There's no Nearzero service called platform. Services: control, runner, postgres, router, dns."

**Expected 1.0 behavior (acceptance)**: `sudo nearzero logs platform` follows the control plane's logs. `console` maps to control and `traefik` to router. `monitoring` and `schedules` get one line saying the runner and the control plane do that work now.

**Spec**: 3.4. Spec gap.

### R4-11 · P2 · The 0.1.x health address is gone

**0.1.x**: `GET /api/health` answers 200 with `ok` and the running version, both at the console's address and on the API port. Uptime monitors point at it.

**1.0 now**: Only `/api/v1/health` exists. It reports status, version and a database check, and answers 503 when degraded. `/api/health` is a 404.

**Expected 1.0 behavior (acceptance)**: `GET /api/health` at the console's address (and on the API port) keeps answering with the version, either the same answer as `/api/v1/health` or 200 with the version.

**Spec**: 23.1 says "the health endpoint reports the version", and 29.5 keeps old console and webhook addresses but not this one. Spec gap.

### R4-12 · P2 · Image apps lose registry-push redeploys

**0.1.x**
- Every app, including one that runs an image, has a deploy webhook (Show URL, Copy, Replace URL).
- For an image app, a call from a registry (a Docker Hub webhook, or GitHub's package-published event) is checked:
  - the pushed image's name must match the app's image, and its tag the app's tag;
  - otherwise the call is refused with a message naming both, for example "Application Image Tag (latest) doesn't match request event payload Image Tag (dev).";
  - a call with no image details redeploys the configured image.

**1.0 now**
- Spec 6.6 hides the webhook for image and upload sources, so a new image app can't be redeployed when its image is pushed.
- A moved image app's old webhook address still answers, but it deploys on any call, whatever image or tag the registry reports.

**Expected 1.0 behavior (acceptance)**
- Image apps keep a deploy webhook.
- A registry call naming another image or tag answers "not deployed" with the reason.
- A matching call, or one without image details, redeploys.

**Spec**: 6.6 ("Not shown for image and upload sources"). I think the spec is wrong for image sources. Upload sources have nothing to redeploy from.

### R4-13 · P2 · The deploy webhook deploys on events that aren't pushes

**0.1.x**: For a Git URL app's webhook:
- GitHub's ping (sent when the webhook is added) answers 200 "Ping received, webhook is active" and deploys nothing;
- a GitHub, Gitea, GitLab, Bitbucket or Soft Serve call is read for its pushed branch, including Bitbucket's push format;
- events with no branch (issues, comments, stars) and pushes to other branches answer "Branch Not Match" and deploy nothing.

**1.0 now**: The generic webhook reads only bodies shaped like GitHub, GitLab or Gitea pushes. Any other body deploys the branch's newest commit, including:
- GitHub's ping, so adding the webhook triggers a deploy;
- any non-push event a person subscribed to;
- every Bitbucket push to any branch, for apps that use a Bitbucket Git URL rather than a connected Bitbucket account.

Each of these restarts the app.

**Expected 1.0 behavior (acceptance)**
- A GitHub ping answers 200 with no deployment.
- A call whose Git host headers name an event other than a push answers "not deployed" with the reason.
- A Bitbucket push to another branch doesn't deploy.
- A plain call with no Git host headers still deploys, as 1.0 intends for CI tools.

**Spec**: 6.6 (trigger and branch rules), 24 G4.

### R4-14 · P2 · The custom webhook channel's body changed shape

**0.1.x**: A custom webhook channel receives JSON with, per event:
- `title` ("Build Success", "Build Error", "Database Backup Successful", "Volume Backup Failed", "Docker Cleanup", "Nearzero Server Restarted", "Server CPU Alert" and so on);
- `message`;
- the project and application names and the application type;
- the build link;
- `timestamp` (ISO) and `date`;
- the domains;
- `status` ("success", "error", "alert");
- `type` ("build", "docker-cleanup", "nearzero-restart" and so on).

**1.0 now**: The body is `event`, `title`, `summary`, `facts`, `link`, `tone`, `data` and `sentAt`. A receiver written for 0.1.x that reads `status`, `type` or the names breaks after the move, and nothing warns.

**Expected 1.0 behavior (acceptance)**
- Spec 15 documents the body.
- Moved channels either keep the 0.1.x fields beside the new ones, or the import report says the receiver must change.
- A receiver that reads `status` and `type` from a build failure keeps working after the move.

**Spec**: 15 gives "URL (POST, JSON body)" with no shape. Spec gap.

### R4-15 · P2 · Moved Git providers' callback addresses aren't answered

**0.1.x**
- A GitHub App was created with its redirect and callback addresses at `/api/providers/github/setup` on the console.
- People registered GitLab and Gitea OAuth apps with the redirect addresses `/api/providers/gitlab/callback` and `/api/providers/gitea/callback`, which the console showed for copying.

**1.0 now**
- 1.0 sends people to `/git-providers/github/created`, `/git-providers/github/installed`, `/git-providers/gitlab/callback` and `/git-providers/gitea/callback`, and the old paths are a 404.
- For a moved GitHub App, installing it on another account or organization returns to the old address, so the new installation isn't recorded.
- For a moved GitLab or Gitea connection, Authorize or Reconnect sends the new redirect address, which the host refuses as unregistered.
- Token refreshes also send the new address. Check whether GitLab refuses those.
- Nothing tells the person to edit the app at their Git host.

**Expected 1.0 behavior (acceptance)**: after a move, either the old callback paths are answered like the new ones, or the import report and the provider's card say exactly which address to change at the Git host. Installing a moved GitHub App on a new organization records the installation, and Reconnect on a moved GitLab connection succeeds.

**Spec**: 16 and 29.5, which keeps webhook and console paths but not callback paths. Spec gap.

### R4-16 · P2 · Audit records are stored but nothing can read them

**0.1.x**: Audit events were produced and discarded, so this is not a regression.

**1.0 now**: Events are stored for 90 days, with actor Agent, the person, role and session for Agent actions. They are not written to the platform log, and the `nearzero` command has no way to export them.

**Expected 1.0 behavior (acceptance)**: as spec 22.4 rule 8 says, `sudo nearzero logs` shows audit events, or a command exports them (for example a date range as JSON lines), with secret-looking fields still redacted.

**Spec**: 22.4 rule 8.

---

## The API surface, 0.1.x to 1.0

0.1.x exposes one internal RPC API that the console and the Agent call, plus plain HTTP routes for webhooks, provider callbacks, health and the Agent. 1.0 exposes one JSON API under `/api/v1`, which the console proxies. Neither is a public API (D4). Per-procedure checks of each console page belong to the page reviews. This table maps the contract by area.

| 0.1.x area | 1.0 equivalent | Notes |
| --- | --- | --- |
| Sign-in, sign-up, sessions, two-factor | `/auth/*`, `/me/two-factor/*` | Identity review (R1) |
| Profile, onboarding, invitations, workspaces, members, access policies | `/me`, `/onboarding/*`, `/invitations/*`, `/workspace*`, `/workspaces` | R1 |
| Projects: create, read, list, rename, delete with plan and status, search | `/projects`, `/projects/:id/delete-plan`, `/delete`, `/delete-run` | Duplicate dropped (27) |
| Environments: create, read, rename, delete, service copies, shared variables, search | `/projects/:id/environments`, `/environments/:id/*` | Duplicate and move dropped (27) |
| Applications: create, read, update, deploy, redeploy, start, stop, reload, sources per provider, builder, variables, webhook URL and token, cancel, logs, upload | `/environments/:id/services`, `/services/:id` and its `source`, `git-source`, `build`, `variables`, `ports`, `mounts`, `deploy-settings`, `webhook`, `logs`, `runtime`, `terminal`, `deployments` and action routes | Per-app router config, move, clear deployments and kill build dropped or replaced by Cancel (27, 11) |
| Compose: the same, plus converted preview, inner services, source type, templates | `/services/:id/compose`, `compose/preview`, `compose/containers`, `compose/volumes` | Templates and isolated or randomized deploys dropped (27) |
| Six database kinds: create, deploy, start, stop, reload, external port, password change, rebuild, move, logs | Services plus `/services/:id/connection`, `public`, `credentials/reveal` | Password change, rebuild and move dropped (27) |
| Deployments: by service, server or type, centralized list, recent, queue, logs, stop a task process | `/deployments`, `/deployments/recent`, `/deployments/stream`, `/deployments/:id/log`, `events`, `cancel`, `redeploy`, `/task-runs/:id/stop` | At parity |
| Domains, server hostnames, DNS zones and records, certificates | `/domains/*`, `/servers/:id/dns-card`, `/environments/:id/hostname-preview` | Domains review |
| Ports and mounts | `/services/:id/ports`, `/mounts` | |
| Servers: create, setup with logs, validate, security audit, remove, update, metrics, ready list | `/servers*` with `setup`, `validation`, `security-audit`, `metrics`, `alerts`, `removal`, `terminal`, `runner`, `host-key` | |
| SSH keys | `/ssh-keys*` | |
| Git providers (GitHub, GitLab, Bitbucket, Gitea): create, test, update, repositories, branches, detect apps, share, linked services, remove | `/git-providers*`, `/git/default-branch` | R4-15 for callbacks |
| Notification channels (12 kinds): create, update, test, remove, events | `/notification-channels*` | Monitoring alert intake replaced by the runner; R4-14 |
| Database backups, volume backups, destinations: schedules, run now, files, restore with logs | `/backup-destinations*`, `/services/:id/backup-*`, `/backup-runs/*`, `/backup-schedules/*`, `/services/:id/restores` | Whole-instance backups dropped (27) |
| Tasks: check script, create, update, delete, list, read, run now | `/tasks*`, `/tasks/check`, `/tasks/places`, `/task-runs/*` | |
| Host settings: version, public domain, server IP, Docker cleanup, request logging, request log cleanup and wipe, router files | `/about/*`, `/servers/:id/docker-cleanup`, `/analytics/settings`, `/analytics/delete-all`, `/servers/:id/router-files` | Web-server panel (reloads, queue store, router env, ports and dashboard, GPU, cleanup buttons, update check) dropped (27) |
| Containers: list, start, stop, restart, kill, remove | `/servers/:id/containers*`, `/services/:id/compose/containers/:id/:action` | Hidden host containers dialog dropped (27) |
| Agent settings and keys: policies, provider status, OpenRouter and Firecrawl keys | `/workspace/agent-policies`, `/workspace/keys/:kind`, `/agent` | |
| Agent chat: message, sessions, events, cancel, attachments, order, rename, delete, follow-ups | `/agent/*` | Log-analysis endpoint and branching dropped (27) |
| Analytics, monitoring | `/analytics`, `/servers/:id/metrics`, `/servers/:id/alerts` | |
| Webhooks in: `/api/deploy/<token>`, `/api/deploy/compose/<token>`, `/api/deploy/github`, `/api/providers/github/webhook` | `/api/v1/webhooks/deploy/<token>`, `/api/v1/webhooks/github/<provider>`; old paths answered after a move | R4-12, R4-13 |
| Provider callbacks: `/api/providers/{gitlab,bitbucket,gitea}/callback`, `/api/providers/gitea/authorize`, `/api/providers/github/setup` | Console pages under `/git-providers/` | R4-15 |
| `POST /api/invitation/decline` | `/invitations/decline` | |
| `GET /api/health` | `/api/v1/health` | R4-11 |
| Dropped (27): personal API keys sent in a header, the REST layer and its document, registries, clusters and swarm nodes, tags, rollbacks, preview deployments, redirects, basic auth, file patches, templates, custom roles, the paid-edition features | none | Not gaps |

**Auth**
- 0.1.x: a session cookie (3 days, renewed daily) or a personal API key header, and a short-lived ticket in the query string for log and terminal sockets.
- 1.0: only an opaque session cookie, HttpOnly, SameSite=Lax and Secure on HTTPS, lasting 7 days and renewed on use (spec 4.1). Terminals go over WebSocket with the same cookie through the console.

**Error shapes**
- 0.1.x: an RPC envelope with a message, a code and flattened field errors. Unknown failures say "Internal server error", Agent routes answer `{error}`, and webhooks answer `{message}`.
- 1.0: one body everywhere, `error: {code, message, fields?, requestId}`. Unknown failures carry a reference that matches a log line, and a 404 names the method and path. 1.0 is better here.

**Pagination**
- 0.1.x: mostly whole lists. The deployments page pages in the browser, and the Agent shows 50 sessions.
- 1.0: deployments are paged by the server (10, 25, 50 or 100), repository and branch lists are capped at 200, sessions at 50, and log tails have fixed caps. At parity or better.

## Checked and found at parity

**Agent**
- The action catalog covers every 0.1.79 model action except the ones spec 27 drops (rollback, Compose suggestions, create from suggestion, direct queue) and R4-04 to R4-08.
- 1.0 adds Compose from a repository, repository inspection, copying services to environments, comparing recorded and real status, and a console-page pointer.
- Policies match: 16 switches with the same defaults and groups. Import from Git and Assign domains depend on Create and configure, both on the page and on the platform. The production phrase is checked by the platform. Refusals show a lock, "Needs permission" and the card with "Allow and continue" for owners and admins, the members' text, and production that can't be allowed from the card.
- Production gate: every create, change and deploy action refuses an environment named "production" unless "Change production environments" is on.
- Input refusals match: Git URLs with a user, token, query or fragment; secret-looking commands; file-mount contents; Compose values and config contents; passwords from the model; generic project names; "prod" and "prd"; "..".
- SSH keys added in the same chat need no "Read SSH keys".
- Loop rules: 30 rounds (60 with Deep research), a closing summary at the limit with the same fallback text, the repeat guard after two identical failures, at most 6 deploys per service (now enforced), malformed input sent back to the model, results cut at 12,000 characters, the empty-reply nudge and its texts, and the kill-switch text.
- Results and audit: secrets and ids are removed from what the model sees and from step targets, content is labelled as data, and the operator's prompt text is appended, never a replacement. Changes and refusals are audited with actor Agent, the person, the role and the session.
- Streaming: server-sent events with a keep-alive, resume from the last event, one turn per chat with the same busy text, Stop and Escape, and turns marked stopped after a restart (new in 1.0).
- Provider: retries at 1 s then 3 s (or retry-after up to 10 s), the 120-second silence cut-off, and the rejected-key and out-of-credits texts.
- Missing keys:
  - owners and admins get the inline key form, and members get the Settings → API keys pointer and the waiting label;
  - a member's waiting question is answered once a key is saved (new);
  - saving the Firecrawl key checks it.
- Attachments and research:
  - attachment limits per kind, accepted and refused types, the 6-hour model capability cache, inlining limits, and listing and reading files by offset, page and search;
  - research search returns 1 to 10 results, and page reads are cut at 10,000 characters.
- Sessions: lists of 50, provisional and generated titles, rename limits and texts, reorder by swapping positions, the delete rules and texts, errors shown under "New session", and Share with workspace (D4).
- Secure forms: variables, SSH key, task script, model-provider key, research key, pickers and project delete, plus the blanket refusal of secret form answers in chat.
- Guided flows: create and delete project, "deploy <name>", import from Git with connect-and-return, keep going after a failed deploy (missing tool, missing variables, the Dockerfile fallback, hand-over to the model) and the pending-DNS table. The exception is R4-01.

**Webhooks**
- Deploy webhook tokens are stored hashed, and a replaced token stops the old URL with 401.
- 30 calls a minute per webhook, and a burst queues one deploy.
- Autodeploy off answers "not deployed".
- Branch, tag and watch-path rules apply to recognized pushes.
- GitLab, Gitea and Bitbucket provider calls and the GitHub App's deliveries are checked against the raw body (better than 0.1.x).
- 0.1.x deploy and GitHub App webhook paths are answered after a move.

**Live updates**
- Deploy logs, setup logs, backup runs, the deployments list and Agent turns stream with resume from the last event and a 15-second keep-alive.
- Terminals and container logs check access before sending anything.

**Jobs and schedules**
- One scheduler in the database (no double scheduling) for backups with retention, tasks, the daily Docker cleanup per server, request-log cleanup, metrics pruning (2 days), deployment pruning and identity clean-up.
- Retries back off, the certificate hold is kept, "Nearzero restart" notifications are sent, and a deploy interrupted by a restart is retried with a log line. Concurrency is R4-03.

**Email**: invitations go out through the workspace's Resend key or the server's email (Resend, and SMTP in 1.0). 0.1.x sign-in codes only went to the log, so nothing is lost.

**Security**
- Only JSON bodies are accepted for changes, and the console's form posts are origin-checked; 0.1.x had neither.
- Sign-in limits survive restarts.
- Secrets are encrypted at rest and never returned.
- API answers are `no-store`, and token checks are constant-time.
- Neither version sends CSP or frame headers, so this is at parity.

**Performance**
- General bodies are limited to 3 MB, uploads to 200 MB (spec 6.3) and webhook bodies to 1 MB.
- Runtime log tails offer 100, 500, 1,000 or all; the Agent's deployment log reads 200 lines by default and at most 10,000.
- The console proxy's time limit covers the first byte only, so streams aren't cut.

**Platform logs, health and version**
- The control plane writes structured logs with request ids, and every log line carries the version.
- "Initializing deployment (Nearzero <version>)" opens deploy logs, and the same line opens setup and backup logs.
- Health reports the version and a database check.
- Neither version has a real update check: 0.1.x's always says "no update", and 1.0 shows none (18.2, D4).

**Installer and `nearzero` command**
- Every 0.1.x command is present (status, logs, restart, update, create-owner, reset-password, backup-db, restore-db, help), and 1.0 adds reset-2fa, import and migrate. restore-db now asks first.
- The 0.1.x setting aliases in 3.5 are read by both the installer and the control plane.
- uninstall takes `--yes` and refuses to run without a terminal.
- A broken settings file is reported before any command runs.

## Spec notes (not gaps)

- 25 D3 lists "API keys (as hashes)" among what moves to 1.0, while 27 and 29a drop personal API keys. 27 and 29a match the build. D3's line is stale.
- 20.6 says the Agent's hostname action takes "HTTPS (on by default), certificate (Let's Encrypt by default)", while 10.6 says there is no per-domain HTTPS switch in 1.0. The build follows 10.6, so 20.6 should drop those two options.
