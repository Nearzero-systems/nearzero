# Backups API (M5)

Backup destinations, database backups and restores, volume backups and in-place restores, the one backup scheduler, and the runner commands that carry them out. Implements spec 08 8.3, 15.3 (the backup events, written to an outbox), 17 (all), 22.3 (the backup rows), 23.1 (background runs, the stdin rule, "never report success having uploaded nothing"), 23.2 (one scheduler), 23.4 (destination keys), 24 G1, G2, P4, P5, and 25 D5 (rclone called by the runner).

Conventions (errors, cookies, `Cache-Control: no-store`, ids, `"host"`) are those of [identity.md](identity.md) and [projects.md](projects.md). Request schemas are in `packages/shared/src/backups.ts`; the words and pure rules (providers, cron, the schedule in words, folders, file names, prefixes, messages) are in `packages/shared/src/backup-rules.ts`, also exported from `@nearzero/shared/browser`.

## Who may do what

| Action | Needs (owners and admins: everything in their workspace) |
| --- | --- |
| See destinations, test one, choose one in a schedule | "Back up to the workspace's destinations" (`destinations.use`); seeing the list also works with the manage right |
| Add, edit, delete destinations | "Add and remove backup destinations" (`destinations.manage`) |
| See a service's Backups panel, its runs and their logs | Backup rights on the service (`service.backups`; members: their own services) |
| Add, edit, delete, run a schedule | Backup rights on the service **and** `destinations.use` |
| Find backups and restore | Restore rights on the service (`service.restore`) **and** `destinations.use` |

A service, schedule, run or destination outside the active workspace, or out of the person's sight, answers `not_found` (spec 22.4 rules 1 and 3); a destination of another workspace in a schedule is "Pick a destination from the list." Runs of a deleted service are for owners and admins.

## Destinations (spec 17.1)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /backup-destinations` | | `{ destinations: DestinationView[], can: { use, manage } }` |
| `POST /backup-destinations` | `{ name, provider, endpoint, bucket, region?: "auto", accessKeyId, secretAccessKey }` | 201 `{ destination, message: "Destination added" }`; a taken name: 409 |
| `GET /backup-destinations/:id` | | `{ destination }` |
| `PATCH /backup-destinations/:id` | any field; **blank keys keep the saved ones**, one new key replaces only that one | `{ destination, message: "Destination saved" }` |
| `DELETE /backup-destinations/:id` | | `{ deleted, schedulesRemoved, message }`: its schedules go with it (their waiting runs are cancelled); files stay in the bucket |
| `POST /backup-destinations/test` | `{ destinationId?, provider, endpoint, bucket, region?, accessKeyId?, secretAccessKey?, serverId? }` | The Add / Edit dialog's Test connection, with the typed values and before saving (Add and remove backup destinations). With `destinationId`, blank keys use that destination's saved ones; otherwise both keys are needed (400 naming the missing one). Same answer as below; nothing is stored. |
| `POST /backup-destinations/:id/test` | `{ serverId? }` | `{ ok, message, detail, server }`: "Connected. Nearzero can list <bucket>." or "Could not reach the bucket. Check the endpoint, bucket, region and keys." with what the store said in `detail` |

```ts
type BackupProvider = "aws" | "cloudflare-r2" | "digitalocean" | "wasabi" | "scaleway" | "akamai" | "minio" | "other";
interface DestinationView {
  id; name; provider; providerLabel; endpoint; bucket; region;
  keys: { savedAt: string; savedBy: string | null; readable: boolean };   // never the keys themselves
  schedules: number; createdAt; updatedAt;
}
```

- Providers prefill a sample endpoint and region (`PROVIDER_PRESETS`); a sample with `<account-id>` left in is refused. Endpoints are `https://` (or `http://` on your own network), without keys, query or fragment. An empty region is `auto`.
- Keys are sealed together with the install key (context `workspace:<id>:backup-destination:<id>`), never returned, never in any service's details, never logged; runs' logs cut them out a second time behind the runner's own redaction. `keys.readable: false` means the install secret changed: edit and paste them again.
- **Test** lists the bucket through a runner: the server asked for (one the person can see, or `host` for people who may use it), else the Nearzero host for people who may use it, else their first connected server, else (a workspace with no server of its own, R3-49) the Nearzero host for an endpoint on the public internet only: its name is resolved, every address must be public (no private, loopback, link-local, carrier-grade NAT, documentation, multicast or reserved address, IPv4 or IPv6), and the helper reaches the name only at the address checked (pinned in its hosts file). A private endpoint answers `ok: false` with "Nearzero tests this destination from the Nearzero host, which only reaches stores on the public internet, and <host> isn't one. …" in `detail`, and nothing runs. The listing itself gets 10 seconds; the first test on a server also fetches the helper image. Neither a server nor the host connected: "Nearzero tests a destination from one of your servers, and none is connected. …"

## A service's backups (spec 08 8.3, 17.3)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /services/:serviceId/backups` | | `BackupsPanel` (below) |
| `POST /services/:serviceId/backup-schedules` | `{ destinationId, folder, cron, keep: number \| null, enabled?: true, database?, volume?, stopService?: false }` | 201 `{ schedule, message }` |
| `PATCH /backup-schedules/:id` | any of those | `{ schedule, message: "Backup schedule saved" }` |
| `DELETE /backup-schedules/:id` | | `{ deleted, message: "Backup schedule deleted. Backups already in the bucket stay." }` |
| `POST /backup-schedules/:id/run` | `Idempotency-Key` header (optional) | 202 `{ run, message, replaced, waiting }`: "Backup started. …", "Backup queued. It starts when the running one ends.", or "A backup was already waiting; this one takes its place." |
| `GET /services/:serviceId/backup-runs?limit=&scheduleId=` | | `{ runs: RunView[] }` newest first |
| `GET /services/:serviceId/backup-runs/events` | SSE | `open`, then `run { run: RunView }` whenever one of the service's runs changes status (the rows follow it without a reload) |

```ts
interface BackupsPanel {
  kind: "database" | "volume";             // Postgres, MySQL, MariaDB, MongoDB, libSQL: database; Redis, apps, Compose: volume
  service: { id; name; appName; kind };
  schedules: ScheduleView[];
  destinations: { id; name; bucket; providerLabel }[];   // empty without destinations.use
  hasDestinations: boolean;
  notice: { text; action: "add-destination" | "ask-admin" | "ask-permission" } | null;   // "Add a destination first"
  timeZone: string; timeZoneHint: string;  // "Times are in the server's time zone (Europe/Berlin)."
  defaultDatabase: string | null;
  volumes: { volumes: ServiceVolume[]; checkedServer: boolean; note: string | null } | null;
  recentRestores: RunView[];
  can: { manage; restore; addDestination };
}
interface ScheduleView {
  id; kind; enabled; stateLabel: "On" | "Paused";
  cron; scheduleText;        // "Every hour", "Every day at 03:00", "Every Sunday at 03:00", "On the 1st of each month at 03:00", "Cron …"
  preset: "hourly" | "daily" | "weekly" | "monthly" | null;
  destination: { id; name } | null; folder; prefix;   // prefix: <app name>[_<inner service>]/<folder>/
  keep: number | null; keepText;   // "Keeps all" / "Keeps last N"
  database; volume; innerService; stopService;
  nextRunAt: string | null; lastRun: RunView | null; openRun: RunView | null;
  lastRunText;               // Succeeded, Failed, Running, Queued, or "Not run yet"
}
interface ServiceVolume { name; sources: ("mount" | "container" | "compose-file" | "label")[]; sourceLabels: string[]; innerServices: string[]; paths: string[] }
```

- **Schedules** are a preset or a 5-field cron (`*`, numbers, ranges, lists, steps, month and day names; day of month and day of week both restricted means either, as cron reads them) in the **server's time zone**, which its runner reports (`system.timeZone`: TZ, `/etc/timezone` or the `/etc/localtime` link, or for the host's containerized runner the Docker Engine clock's offset, like `UTC+05:30`; UTC when unknown). A time clocks skip runs right after the gap; a repeated one runs once.
- **Folder** (required; the console starts with `nightly`): up to 5 levels of letters, digits, `.`, `_`, `-`. Files go to `<app name>/<folder>/` (Compose volumes used by one inner service: `<app name>_<inner service>/<folder>/`). One schedule per folder of a service on a destination ("Another backup schedule of this service already writes to this folder …"). A schedule moved from 0.1.x may have no folder: its files are straight under `<app name>/` (list them with `folder=`).
- **Keep**: blank keeps all; otherwise 1 to 1000 ("Keep at least 1, or leave it blank to keep all."). After a successful upload, the files of that prefix **this schedule's runs wrote** (each successful upload is recorded in `backup_file`, migration 0750) beyond the newest N are deleted; other files, other folders, and files another schedule wrote into the same folder of the same bucket through another destination are never touched (B1-52). **Decision (R2-06, R3-44):** a schedule moved from 0.1.x (`legacy_files`) also counts the files 0.1.x wrote in its folder, by their 0.1.x names, so its Keep N prunes them together with new ones, newest first by the time in the name. A failed run prunes nothing. A failed prune fails the run ("The backup was uploaded, but deleting older backups failed: …").
- **Database**: Postgres, MySQL and MariaDB default to the service's database; MongoDB blank dumps every database; libSQL dumps its database. MySQL and MariaDB refuse their system databases (`mysql`, `sys`, `performance_schema`, `information_schema`): "… is the server's own system database, which Nearzero can't back up and restore safely. Enter the database your app uses."
- **Volumes** (17.3, P4): the service's saved volume mounts (apps: `<app name>-<mount>`; databases: their data volume), the named volumes its containers mount (label `dev.nearzero.service`, and for Compose `com.docker.compose.project=<app name>`), for Compose the volumes its own file declares (`<project>_<key>`, `name:`, or the key for external ones) with the inner services using each, and volumes carrying those labels. Never chosen by name prefix. When the server can't be asked, only saved mounts are listed, with a note. **Only the service's own** (B1-03): Nearzero's own volumes (`nearzero-postgres-data`, `nearzero-runner-state`, `nearzero-runner-handoff`, `nearzero-runner-link`, `nearzero-router-certificates`, `nearzero-buildkit-state`, backup scratch volumes), any volume another service on the same server keeps (its mounts, its data volume, a stack's volumes and `<its app name>_…`), and a Compose file's `external` volumes and `name:`s outside `<app name>_…`/`<app name>-…` are left out of `volumes` and listed in `excluded: { name, reason }[]`; naming one answers 403 with its reason. A run refuses a volume another service's container also uses ("Another service also uses this volume, so Nearzero won't back it up."). A volume not in the list: 403 "This service doesn't mount that volume, so it can't back it up. …". "Stop the service while copying" stops this service's running containers that use the volume, and is refused for Compose when no inner service is known to use it.

## Runs (spec 17.2, 23.1)

| Endpoint | Response |
| --- | --- |
| `GET /backup-runs/:id` | `{ run: RunView }` |
| `GET /backup-runs/:id/log` | `{ text, complete, lastEventId }` |
| `GET /backup-runs/:id/events` | SSE: `open { runId, status }`, `log { text, seq }` (id `<run id>:<seq>`), `status { run }`, `end { run }`. `Last-Event-ID` resumes after that piece; a finished run answers its stored log, then `end`. Keep-alive every 15 s. |

```ts
interface RunView {
  id; operation: "backup" | "restore"; kind: "database" | "volume";
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  statusLabel;   // backups: Queued, Running, Succeeded, Failed, Cancelled; restores: Queued, Restoring, Restored, Restore failed, Cancelled
  trigger: "schedule" | "manual"; scheduleId; service: { id; name }; destination: { id; name };
  database; volume; file: { key; name; sizeBytes } | null; error;
  createdAt; startedAt; finishedAt; durationMs; log: { lines; bytes }; open: boolean;
}
```

- Every run is a record with a log, carried out by the background job `backups.run` on the service's own server through its runner. The log starts with `Initializing backup (Nearzero <version>)` (or `restore`), then each step: `→ <step>`, its output (secrets cut out), `✓ <step>` or `✗ <step> failed (exit code N).`, and ends with "Backup finished." or "Backup failed: <reason>".
- **Never overlapping**: one run per schedule runs and at most one waits. A new run (scheduled or Run now) cancels a waiting one ("Replaced by a newer run of this schedule.") and never touches a running one; the run that ends starts the one waiting behind it. Unique indexes back this up. A request carrying the same `Idempotency-Key` gets the run it already started (the console sends one per click), so a proxy or client retry never starts a second run.
- One restore at a time goes into a service (409 "A restore of this service is already running. …"). A volume backup that stops the service, and any restore, are `exclusive`: one at a time per service, whichever schedule they come from; the next waits (Queued) and starts when the running one ends (R3-48).
- A run whose control plane stopped mid-way is marked Failed ("The control plane stopped while this run was in progress. Run it again."), never started twice. Each service keeps its newest 100 runs; runs of deleted services go after 30 days.
- **Notification events** (15.3): each finished backup run (succeeded or failed, scheduled or manual) writes one row to `notification_outbox` (event `backup.database` or `backup.volume`, dedupe key `backup-run:<id>`) with `{ runId, trigger, service, project, environment, destination, volume, database, databaseType, result, error, file, sizeBytes, finishedAt }` and never a secret. The messages name the project, environment, service, the database type and database (or the volume), the destination, the result and the size or reason (R3-47). The notifications milestone sends them and sets `delivered_at`. Restores write none (15.3 has no restore event).

## Finding and restoring (spec 08 8.3, 17.3, 24 G1, G2)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /services/:serviceId/backup-files?destinationId=&folder=&volume=` | | `{ prefix, files: { key, name, sizeBytes, modifiedAt, database }[] }` newest first; `database` is what a database backup restores into by default |
| `POST /services/:serviceId/restores` | `{ destinationId, key, confirm, volume?, database? }`, `Idempotency-Key` header (optional) | 202 `{ run, message: "Restore started. Follow it in the log." }` |

- **G1**: the listing asks the service's own server for exactly this service's prefix (`<app name>[_<inner service>]/<folder>/`) and keeps only files directly in it that Nearzero named for this kind of backup: 1.0's names, and 0.1.x's (R2-06, R3-44: `YYYY-MM-DDTHH-MM-SS-mmmZ.sql.gz`, `.bson.gz` for MongoDB, `<volume>-YYYY-MM-DDTHH-MM-SS-mmmZ.tar` for volumes), sorted together by time. Another service's files are never listed or named. Destination-wide browsing isn't offered.
- **G2**: before anything runs, and again in the job, the key must be under one of the service's prefixes (its first folder is the app name, or the app name, `_` and an inner Compose service; app names never contain `_`), relative, without `.`/`..` segments, and of this service's kind; else 403 "This backup belongs to another service." (or 400 "That file isn't a backup of this kind. …").
- `confirm` is the service's name as typed: else 400 `fields.confirm` "Type the service name, <name>, to confirm."
- **Which database** (R3-45, B1-19): `database` when given (letters, digits, `_`, `$`, `-`; MySQL's system databases refused), else the one the file was dumped from: the run that wrote it, else the schedule writing to its folder, else the service's own (its type's default filled in). MongoDB: a backup of every database restores every database; one of a named database restores into the one asked for (`--nsFrom`/`--nsTo`). A Postgres or MySQL database that doesn't exist is made first.
- **Database restores** read the whole file from the bucket once first (it must arrive whole and decompress), tell its format from its first bytes, then stream it into the database, so no copy is kept on the server's disk (R3-50). They overwrite what the backup holds: a Postgres restore runs in one transaction with `ON_ERROR_STOP` that first drops every schema of the database with what is in it and makes `public` again as Postgres makes it (so tables, views, foreign keys and triggers added since the backup can't stop it, C2-03), then runs the SQL dump (`--clean --if-exists`), or for a Postgres archive (0.1.x's) the SQL `pg_restore --clean --if-exists --no-owner --file=-` turns it into, and commits only when the whole file arrived and was read; MySQL and MariaDB drop and create each dumped table (a dump's own `CREATE DATABASE … ; USE …;` lines are dropped, so it loads into the database asked for); MongoDB restores with `--drop`; libSQL drops its tables, views and triggers and runs an SQL dump in one transaction (up to 512 MB of SQL, stated in the dialog), or, for an archive of its data folder (namespaced backups, and 0.1.x's libSQL backups), stops the database, empties its data volume, unpacks the archive and starts it again.
- **Volume restores** are refused when any container outside this service uses the volume (409 "Another service also uses this volume, so Nearzero won't overwrite it.", checked by the control plane and again by the runner). A volume the service's saved mounts or Compose file name that isn't on the server yet is made, with the labels its deploy would give it (R3-52). The archive (gzipped, or 0.1.x's plain `.tar`) is downloaded and checked before anything is touched, after a check that the disk can hold it (else it fails at once saying how much space it needs); then this service's containers using the volume are stopped, the volume emptied, the archive unpacked (owners and modes as numbers), and the containers started again **even when the restore failed**; the run reports the real result, including a container that didn't start.

## The scheduler (spec 23.2, 24 P5)

One job kind, `backups.tick`, in the control plane's job queue, is the only scheduler; there is no separate worker. A tick claims due schedules (`enabled AND next_run_at <= now()`) with `FOR UPDATE SKIP LOCKED`, moves each one's `next_run_at` to its next time after now and adds its run in the same transaction, so two processes ticking at once start a schedule once, and a schedule missed while Nearzero was stopped runs once, then keeps its rhythm. A tick also recovers runs left behind and prunes old runs, then books the next tick at the next due time or the next point of a 5-minute grid, keyed by its time to the second (`backups.tick:<time>`), so every chain of ticks lands on the same jobs. The control plane books a tick at start; saving a schedule books one at its next time.

## The runner's side

New commands (`packages/shared/src/runner-backups.ts`, `runner/src/backups/`; additive, protocol 1; older runners answer `unsupported`):

| Kind | What it does | Streams |
| --- | --- | --- |
| `backup.test` | Lists the bucket with a 10-second limit | |
| `backup.files` | `rclone lsjson` of one prefix | |
| `backup.prune` | Deletes the given keys | |
| `backup.database` | Dumps through gzip straight into the bucket (`rclone rcat`), checks the upload isn't empty, removes a partial upload on failure; `archive: true` (libSQL with namespaces) archives the data volume with the database stopped, then uploads; returns `{ key, bytes }` | yes |
| `restore.database` | Reads the file once to check it and tell its format, then streams it into `database` (`sourceDatabase`: what it was dumped from, for MongoDB) or unpacks a data-folder archive into `dataVolume` | yes |
| `backup.volume` | Stops the given containers, archives the volume, starts them again (always), checks, uploads, checks | yes |
| `restore.volume` | Refuses a volume used outside `allowedContainers`; downloads and checks the archive; stops the users, empties, unpacks, starts them again (always) | yes |
| `backup.volumes` | Containers by label sets with their named-volume mounts, volumes by label sets, and every container using the named volumes | |

- **Every step is its own short-lived helper container** with standard input closed (`AttachStdin`, `OpenStdin` and `StdinOnce` false, no TTY), its program and arguments as an array (never a script fed on standard input: spec 23.1; a step that pipes a dump into rclone runs `sh` on a script written into the helper, whose first line cuts standard input off and which checks every stage's exit status), and its exit status checked before the next step; the first failure stops the run and names the step. The work passes through a per-run scratch volume (`nearzero-backup-<run id>`, removed afterwards); helpers carry the label `dev.nearzero.backup-run` and are always removed.
- **Tools**: dumps and loads run in a helper made from the database container's own image (so `pg_dump`/`psql`/`pg_restore`, `mysqldump`/`mysql`, `mariadb-dump`/`mariadb`, `mongodump`/`mongorestore` match the server), on its network, reaching it by name, with the tools image's static rclone and certificate list copied into the scratch volume. Compression, tar, libSQL's HTTP calls (`/dump`, `/v2/pipeline`) and every transfer run in the pinned helper image `rclone/rclone:1.71.2` (rclone, MIT; busybox gives gzip, tar, find and nc). `NEARZERO_BACKUP_TOOLS_IMAGE` on the runner points at a mirror.
- **Secrets**: database passwords go into a file written into the helper before it starts (`pgpass`, a MySQL option file, a mongo tools config); the destination's keys into an `rclone.conf` written the same way. libSQL's HTTP requests (HTTP/1.0, so the answer is never chunked) are sent by busybox `nc -e` running a script written into the helper: the request's head with its `Authorization` header is a file there too, the body comes from the scratch volume, and the script keeps the answer's body only on a 200 (otherwise it stops with libSQL's status line). None is on a command line or in an environment variable. Output is redacted on the runner and again on the control plane.
- **Files**: `<UTC start time>.sql.gz` (Postgres, MySQL, MariaDB, libSQL), `.archive.gz` (MongoDB `--archive --gzip`), `<volume>-<UTC start time>.tar.gz` (volumes; files written before 31c G3-20 have no volume in front) and `<UTC start time>.tar.gz` (libSQL with namespaces). Volume schedules of one service may share a folder on a destination, one per volume (409 "Another backup schedule of this service already backs up this volume to this folder on this destination. …"); a database has one schedule per folder. Keep N counts only the files a schedule wrote, and for a moved schedule 0.1.x's files of its own volume (C1-12).
- **Nearzero's own volumes** (`RESERVED_VOLUMES`, backup scratch volumes, a volume labelled as a component or used by a component container) are refused by `backup.volume`, `restore.volume` and the data-folder archive steps, whatever the control plane asks (B1-03). Containers stopped for a copy start again even when stopping a later one failed (B2-17).
- The runner's `system` (hello) gains the optional `timeZone`.

## Audit events

`backup-destination.added`, `backup-destination.updated` (`keysReplaced`, never the keys), `backup-destination.deleted`, `backup-schedule.added`, `backup-schedule.updated`, `backup-schedule.deleted`, `backup.run-requested`, `backup.restore-requested`.

## Code map

`apps/control/src/backups/`: `destinations.ts`, `schedules.ts` (and the panel), `runs.ts` (records, overlap rules, log, live bus), `job.ts` (`backups.run`), `scheduler.ts` (`backups.tick`), `scheduler-wake.ts`, `files.ts` (G1, G2, restores), `volumes.ts` (17.3, P4), `events.ts` (outbox), `routes.ts`, `tables.ts`. Migrations 0300 and 0750. `addresses.ts` (R3-49). `runner/src/backups/`: `steps.ts`, `helpers.ts`, `rclone.ts`, `database-steps.ts`, `volume-steps.ts`, `libsql.ts`, `handlers.ts`, `time-zone.ts`. Console: `src/pages/[workspace]/dashboard/settings/backups.astro`, `src/components/services/BackupsPanel.astro`, `src/components/backups/`, `src/client/backups.ts`, `src/lib/data/backups.ts`, `src/styles/backups.css`. Tests: `packages/shared/test/backups.test.ts`, `runner/test/backups.test.ts` (the stdin rule), `runner/test/backup-scripts.test.ts` (the helper scripts, run with a real shell), `runner/test/backup-handlers.test.ts` (reserved volumes, restarts), `apps/control/test/backups.test.ts` (a fake runner speaking the real protocol), `apps/control/test/backup-volumes.test.ts` (Compose volumes, P4), `apps/console/e2e/backups.e2e.ts` (the console flow against a pretend runner over a real WebSocket), and the Docker-in-Docker suite `e2e/backups/backups.e2e.ts` (`bun run --cwd e2e test:backups`, MinIO inside the host).
