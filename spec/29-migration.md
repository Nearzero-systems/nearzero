# 29. Moving a 0.1.x install to 1.0

This file is the contract for decision D3 ([25-open-decisions.md](25-open-decisions.md)). A final 0.1.x release writes an **export bundle**; 1.0 reads it. The bundle is described in 1.0's own concepts ([02-concepts.md](02-concepts.md)), so the 1.0 importer never needs to know how 0.1.x stored anything.

## 29.1 What changes from D3 as first written

0.1.x runs services as Docker Swarm services; 1.0 runs plain containers under its runner (D1.1). A running 0.1.x service therefore can't be adopted as is. Instead, the import **redeploys every service onto the 1.0 runner, reusing its existing data volumes, hostnames and certificates**. Each service restarts once, briefly; data is untouched, and no new certificate is requested. The owner should confirm this tradeoff (see the open question at the end).

## 29.2 Flow for the person

1. On the 0.1.x server, update to the final 0.1.x release (`curl … | sudo bash` as today).
2. Run the 1.0 install command. The installer finds the 0.1.x install and:
   - It is a 0.1.x install when `/opt/nearzero/.env` has `NEARZERO_VERSION` starting with `0.1.`, or, for installs older than the final 0.1.x release (which don't write that line), when `/opt/nearzero/.env` exists without a 1.0 marker and a 0.1.x control-plane container is running or present. 1.0 writes its own marker (`NEARZERO_EDITION=1`) so it never mistakes itself for 0.1.x.
   Then the installer:
   - if the 0.1.x version is older than the final release, stops: "This server runs Nearzero <version>. Update it to <final version> first: <command>. Then run this install command again." The command is `curl -fsSL https://cdn.nearzero.dev/releases/0.1.80/install.sh | sudo bash`, the final 0.1.x installer at the versioned address 0.1.x publishes it at, and the next line names its checksum, `https://cdn.nearzero.dev/releases/0.1.80/install.sh.sha256` (spec 31 "0.1.x's own scripts": 1.0 owns the root `install.sh` and `uninstall.sh`; the final 0.1.x release publishes both of its scripts under `releases/0.1.80/`, each with a `.sha256`);
   - otherwise explains what will happen and asks: "Move this install to Nearzero 1.0? Your apps restart once, briefly; data, addresses and passwords are kept. [y/N]".
3. It runs `nearzero export` (from the final 0.1.x release) to a file in `/opt/nearzero/migration/`, encrypted with a passphrase it generates and shows once ("Keep this passphrase: you need it to undo the move."), or one given with `NEARZERO_MIGRATION_PASSPHRASE`.
4. It runs `nearzero import --dry-run <bundle>` with the new 1.0 control plane stopped against a fresh database, and prints the report (29.5). The person confirms.
5. It stops the 0.1.x control plane (apps keep running), installs 1.0, imports, then redeploys services server by server, oldest-deployed first, printing one line per service ("web on prod-1: moved"). Remote servers are re-set-up over SSH with their saved keys (the 1.0 runner replaces the 0.1.x agentless setup) before their services move.
6. The 0.1.x control-plane data stays on disk, stopped. `sudo nearzero migrate rollback` restores 0.1.x (and stops the 1.0 control plane) until `sudo nearzero migrate finalize` deletes the old data.

`nearzero import <bundle>` also works on a fresh 1.0 server (moving to a new machine); then services deploy fresh with their data restored from the bundle's optional volume archives (29.4).

## 29.2a The export command (final 0.1.x release)

`sudo nearzero export [--out <file>] [--no-deployments] [--volumes]`

- Passphrase: from `NEARZERO_MIGRATION_PASSPHRASE` when set (at least 16 characters), otherwise prompted twice on the terminal. Never accepted as an argument.
- Output: `--out`, or `/opt/nearzero/migration/nearzero-export-<UTC timestamp>.nzx`, written with mode 0600; the folder is created with mode 0700.
- `--no-deployments` leaves out `deployments.jsonl`. `--volumes` adds each database's and volume's data as archives under `volumes/` (used only when moving to another machine).
- Runs while 0.1.x keeps serving; reads a consistent snapshot of the control-plane database.
- Prints, on success, exactly one machine-readable last line: `NEARZERO_EXPORT_OK <absolute path> <sha256 of the file>`; on failure, a plain message and exit code 1. Exit code 2 means the install isn't the final 0.1.x release.
- `sudo nearzero export --version` prints the bundle format version it writes (`1`).

## 29.3 Bundle format

- One file, `nearzero-export-<timestamp>.nzx`: a tar archive, encrypted as a whole with AES-256-GCM under a key derived from the passphrase with scrypt (N = 2^17, r = 8, p = 1), with the parameters and salt in a small clear header.
- Inside: `manifest.json` (format version `1`, source version, export time, counts per record kind, SHA-256 of every other file), and one JSON Lines file per record kind (29.4). Secrets inside are plain text, protected by the bundle's encryption, so the importer can re-encrypt them with the 1.0 install's key.
- Every record has a stable `ref` (an opaque string unique within the bundle). References between records use these refs, never source ids.
- Unknown fields are ignored; missing optional fields take 1.0 defaults. A bundle with a format version newer than the importer knows is refused.

## 29.4 Record kinds

| File | One record per | Fields (1.0 terms) |
| --- | --- | --- |
| `people.jsonl` | person | email, first and last name, password hash with its algorithm and parameters, two-factor secret and hashed backup codes (if enabled), avatar choice, created time |
| `workspaces.jsonl` | workspace | name, slug, old slugs, logo, personal flag, first-workspace flag (instance administrators), Agent policies, model key, research key, invitation email key and sender, hosts-allowed flag |
| `memberships.jsonl` | person in a workspace | person ref, workspace ref, role, direct capabilities, scope (project/environment/service/server/Git account refs, "all" flags), attached policy refs |
| `policies.jsonl` | access policy | workspace ref, name, description, capabilities, scope |
| `invitations.jsonl` | pending invitation | workspace ref, email, role, policy refs, expiry (tokens are not carried; invitees get a new link on first resend) |
| `servers.jsonl` | server | workspace ref, name, description, address, port, SSH user, SSH key ref, host key fingerprint, hostname label, daily cleanup flag, alert thresholds |
| `ssh-keys.jsonl` | SSH key | workspace ref, name, description, public key, private key |
| `git-providers.jsonl` | Git provider | workspace ref, owner person ref, shared flag, kind, name, URLs, app or OAuth credentials, installation ids, tokens |
| `projects.jsonl` | project | workspace ref, name, description, created time |
| `environments.jsonl` | environment | project ref, name, description, default flag, shared variables (text with comments), hostname defaults (source, zone ref, prefix) |
| `services.jsonl` | service | environment ref, copy-group ref, kind, name, internal app name, server ref (or host), description, own variables (text), kind settings (source, builder and its fields, commands, ports, mounts with file contents, autodeploy, trigger, watch paths, webhook token, database credentials, image, public port, replica-set or libSQL options, Compose file or repository path and format), the names of its data volumes on its server |
| `hostnames.jsonl` | hostname | service ref and inner service (or server ref when unconnected), host, port, path, source (platform domain, server wildcard, zone, own), generated flag |
| `zones.jsonl` | managed DNS zone | workspace ref, domain, admin email, nameservers, manual records |
| `certificates.jsonl` | uploaded certificate | workspace ref, name, server ref, certificate PEM, private key |
| `acme.json` (single file per server) | server or host | the certificate authority account and every issued certificate with its key, so nothing is re-issued |
| `destinations.jsonl` | backup destination | workspace ref, name, provider, endpoint, bucket, region, keys |
| `backup-schedules.jsonl` | database or volume backup schedule | service ref, destination ref, kind, database name or volume, folder, cron, time zone, keep, enabled, stop-while-copying |
| `tasks.jsonl` | task | place (service ref with inner service, server ref, or host), name, description, cron, time zone, shell, script, enabled |
| `channels.jsonl` | notification channel | workspace ref, kind, name, fields, secrets, events |
| `agent-sessions.jsonl` | Agent session | workspace ref, author ref (when known; otherwise the workspace's owner, marked shared), title, position, messages as text with step summaries (no raw tool payloads) |
| `deployments.jsonl` (optional, on by default) | deployment | service ref, status, commit, trigger, times, the last 50 per service, log text |
| `install.json` | the install | platform domain, console hostname, managed zone, public IP, data mode, registration mode, monitoring and analytics settings |

Not carried: request analytics history, metrics history, audit events older than 30 days, sessions (everyone signs in again), invitation tokens, webhook delivery history.

## 29.5 Import rules

- **Dry run first**: the report lists counts per kind, every record that can't be imported with the reason (for example "Service web uses a builder 1.0 doesn't offer; it will build automatically"), names that collide, and settings dropped in 1.0 (from [27-dropped.md](27-dropped.md)) with what happens instead.
- **Identity**: password hashes from 0.1.x are accepted at sign-in and re-hashed with 1.0's algorithm on first success; two-factor secrets work unchanged.
- **Secrets** are re-encrypted with the 1.0 install's key on import and the bundle's plain copies never touch disk unencrypted.
- **Names and addresses**: workspace slugs, old slugs, generated hostnames, server labels, database public ports and webhook URLs are kept exactly, so links, DNS records, app connection strings and Git webhooks keep working. Webhook tokens are re-hashed.
- **Workloads**: each service redeploys from its saved source onto the 1.0 runner with its existing volumes attached, then its hostnames route to the new container. Databases keep their volumes and passwords. A service that fails to redeploy keeps its 0.1.x container running and is listed for the person with the failure; 1.0 won't remove it until the person retries or finalizes.
  - Order for each service: stop its 0.1.x workload (29a.9 `legacy`), wait until the ports it published are free, start the 1.0 container, and wait for it to run. If any step fails, remove the 1.0 container, start the 0.1.x workload again exactly as it was, and list the service with the reason.
  - **Compose stacks with the same project name**: a moved Compose stack keeps its 0.1.x project name, so its volume names stay the same. Compose treats every container with that project and service name as its own, so 1.0's deploy may replace 0.1.x's stopped containers, and 1.0 never relies on them surviving. Whenever 0.1.x's copy must come back (a failed move or a rollback), 1.0 first removes its own labelled containers in that project, removing their anonymous volumes with them. Then it starts 0.1.x's copy from its own files, which `legacy` names (`folder`, `composeFiles`, `envFile`), the same way as the control plane. While the stack is moved and not yet finalized, 1.0 never passes `--remove-orphans`.
  - **0.1.x's files stay**: before finalize, 1.0 never changes or removes a folder named in `controlPlaneDetails` or in any service's `legacy`. There is one exception. `/opt/nearzero` is both 1.0's install folder and, on most installs, 0.1.x's control-plane folder. In it, the move sets aside only the files 1.0 has to replace (such as `.env`), under `/opt/nearzero/migration/0.1`, and rollback puts them back before starting 0.1.x.
  - **Volumes**: a mount of type volume uses the volume the bundle names, never a new one, and every name in the service's `volumes` is attached under the same name. A moved service never gets an empty volume in place of one the bundle names.
  - **Public ports**: a database or app keeps the exact published and public ports from the bundle. The import never picks another port. If the port is still taken once the 0.1.x workload has stopped, that service's move fails as above, with the port and what holds it.
  - **Data already in a database's volume is loaded, never ignored**: 1.0 starts a moved database with settings that read the files its volume already holds. For Redis, 0.1.x writes snapshots (29a.9 `persistence`). When a moved Redis volume holds a snapshot and no append-only files, 1.0 loads the snapshot first, then turns on its own persistence from the loaded data. The same keys answer after the move.
- **No shared names with 0.1.x**: 1.0's control plane uses its own Compose project name and its own container, volume and network names, so starting it can never replace, adopt or delete a 0.1.x one. 0.1.x's control plane runs as the Compose project and containers that the bundle lists in `controlPlane`, `controlPlaneDetails` and `controlPlaneVolumes`. On a typical install that is the project `nearzero`, with containers such as `nearzero-postgres` and `nearzero-dns` and its data in volumes such as `nearzero_nearzero-postgres`. 1.0's names are fixed for every 1.0 install, moved or fresh: the Compose project `nearzero1`, with containers such as `nearzero1-postgres` and `nearzero1-dns`. Every container, volume, network and image 1.0 creates on a host carries the label `dev.nearzero.edition=1`, plus `dev.nearzero.migration-attempt=<attempt id>` while a move is in progress. Rollback waits for 0.1.x's console on the ports in `controlPlaneDetails`, where any 2xx or 3xx answer on its sign-in path or `/` counts as up. Before starting anything, the installer checks for a collision with a name that exists on the host without 1.0's label. If it finds one, it stops with a plain message naming it.
- **Certificates**: the ACME state is placed into each server's router store before routes switch, so certificates continue without new orders.
- **Old install settings**: 0.1.x setting names that 1.0 renamed are read from the old settings file and written under the 1.0 names; dropped ones are listed in the report.
- **Old addresses**: 1.0 keeps redirects for the 0.1.x console paths people bookmarked or received in notifications (settings pages, service pages, deployment detail links, sign-in, registration and invitation pages).
- **Idempotent**: importing the same bundle twice changes nothing the second time.
- **Old webhook paths**: 1.0 keeps answering the 0.1.x deploy webhook paths and the GitHub App's old webhook path (29a.9), so nobody has to change settings at their Git host.
- **Unreadable two-factor secrets** turn two-factor off for that person and the dry-run report names them, so they can set it up again.
- **Rollback** discards the 1.0 database created by the attempt, so a later move starts clean. It runs in this order:
  1. Stop and remove only what carries 1.0's label: its control plane, routers, runners and moved service containers, plus the 1.0 database volume made by the attempt. It never removes a volume named in `controlPlaneVolumes` or in any service's `volumes`, or any volume without 1.0's label.
  2. Bring the 0.1.x control plane back from `controlPlaneDetails`: create and start its Compose project from its folder with its Compose files and env file (29a.9), whether or not any of its containers still exist, then start every `controlPlane` entry the move stopped.
  3. Start each moved service's 0.1.x workload as it was before the move (the same replica count for Swarm services; containers and Compose projects started again), and the 0.1.x router on each server.
  4. Wait up to 5 minutes until the 0.1.x console answers its sign-in page and its database accepts connections. Then print "Nearzero <version> is back. The move to 1.0 was undone." If it doesn't come back in time, print what didn't come back and exit 1.

  After a rollback, `nearzero export` on 0.1.x works again and a second move succeeds.
- **Finalize** removes the 0.1.x control plane, its volumes and the stopped 0.1.x workloads, and waits up to 2 minutes for them to be gone. It then says it is done, or names what is still being removed.
  - It removes things one by one, and only those without 1.0's label. A moved Compose stack keeps its Compose project name so its volume names stay the same. Finalize therefore never removes a Compose project as a whole by name: it removes only that project's unlabelled containers. A container, service, volume or network carrying `dev.nearzero.edition=1` is never touched.
  - When it removes a container, it also removes that container's anonymous volumes, never a named one. 1.0 does the same wherever it removes a container it created.
  - Afterwards, it removes each network the 0.1.x control plane or a moved 0.1.x workload used, once no container is attached and the network has no 1.0 label. These include 0.1.x's shared network, its router network, the control plane's Compose default network, and each moved stack's old default network.
  - After finalize, a moved service is running exactly as before finalize, and `migrate status` reports what is actually running.
- **Moving to another machine** restores each volume archive from `--volumes` into the service's new volume before its first deploy.

## 29.6 Acceptance

- A 0.1.77 install with two workspaces, members with policies, apps from GitHub and from an image, a Compose stack, all six database types with data, generated and own-domain hostnames with real certificates, a remote server, backups, tasks and channels moves to 1.0 with one command.
- After the move: everyone signs in with their old password (and two-factor), every hostname serves the same app over HTTPS with the same certificate, every database answers at the same internal and public URL with the same data, a push to GitHub redeploys, backups and tasks run on schedule, and no certificate was ordered.
- `nearzero migrate rollback` brings 0.1.77 back with everything as it was before the move.

## 29.7 Open question for the owner

The move restarts each service once (because 1.0 drops Swarm). Alternatives: keep a Swarm compatibility mode in the 1.0 runner just for adopted services (more code to carry forever), or accept the brief restarts (recommended).
