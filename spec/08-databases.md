# 08. Databases

Six types: **PostgreSQL, MySQL, MariaDB, MongoDB, Redis, libSQL**. Each runs as one container on one server with its own data volume.

## 8.1 Creating

**Dialog** "Databases" (from Add New → Database): type (Postgres preselected), then:

| Field | Applies to | Rules |
| --- | --- | --- |
| Name | all | Required |
| Server | all | The Nearzero host ("Nearzero (local)") or a ready server the person can use |
| App name | all | Prefilled from the project and the name; a random suffix is added; duplicates refused ("Service with this app name already exists") |
| Description | all | Optional |
| Database name | Postgres, MySQL, MariaDB | Defaults "postgres", "app" (MySQL's own "mysql" schema is a system schema), "mariadb". Backups refuse system schemas |
| Database user | all but Redis | Defaults "postgres", "mysql", "mariadb", "mongo", "libsql" |
| Password | all | "Generated if left empty": 24 random letters and digits from a secure generator. A typed password is 8 to 128 characters and may not contain `$ ! ' " \ /` or spaces |
| Root password | MySQL, MariaDB | Generated if left empty |
| Image | all | Defaults below |
| Use replica set | MongoDB | Only at creation |
| Node role (primary or replica), primary URL (replicas), namespaces | libSQL | Only at creation |

**Default images** (the same in the console and the Agent; today they differ): the newest stable major of each at release time. At the time of writing: `postgres:18`, `mysql:8`, `mariadb:11`, `mongo:8`, `redis:8`, and a pinned libSQL server release.

**On create**
- The database gets its own data volume (also when the Agent creates it).
- A database redeploy is stop-first (one data volume can't be shared by two copies), with a short gap.
- It gets a **public port automatically**: a free port from 20000 to 29999 on its server. If none is free, it is created private with a note.
- The console starts the first deploy and opens the database's page.
- Copies are added to the other environments, each with its own password, volume and public port.
- A MongoDB replica set always runs with authentication (a key file derived from the password); the first start initializes the set and creates the user.

**Acceptance**: each of the six types deploys, accepts a connection from an app on the same server by its internal URL and from outside by its public URL, and keeps its data across a redeploy.

## 8.2 The database page

**Header actions** (deploy rights): **Deploy** (when stopped or failed), **Stop** (when running; disabled while deploying), **Start** (new: today people must Deploy again after Stop), **Terminal** (sh or bash in the container).

**Tabs**: **Overview**, **Logs** (new, as for apps), **Variables**, **Backups**, **Settings**.

**Overview**
- Status, Type, Public port, Container, then the **Connection** card:
  - Before the database runs: "Works once the database is deployed and running."
  - **Public URL** ("From anywhere"): masked, with a Show password eye and Copy. When public: "If it doesn't connect, allow inbound TCP N in the server's firewall or cloud security group." When private: "Not reachable from outside this server." If the server's public address is unknown: "Port N on this database's server… use its IP with port N."
  - **Make public** / **Make private** (configure rights): confirms, then restarts the database in the background if it was deployed. A full range: "No free port between 20000 and 29999…".
  - **Internal URL** ("From apps on this server"): uses the container's internal name and the type's standard port.
  - User, Password and Database rows, each with Copy and reveal.
  - URL formats (credentials percent-encoded): `postgresql://user:pass@host:port/db`, `mysql://…` (MySQL and MariaDB), `mongodb://user:pass@host:port/?authSource=admin` (replica set: `replicaSet=rs0` inside, `directConnection=true` from outside), `redis://default:pass@host:port`, and `http://…` for libSQL.
- Build log panel while deploying; the Deployments list with a log dialog (every type records deployments; today only MongoDB did before 0.1.75).

**Settings** (today read-only and it shows the server's raw id; 1.0 shows the server's name)
- App name, public port, server, image.
- **Change image or version** (new): saved, applied on the next deploy, with a warning that major version changes may need a manual upgrade of the data.
- **Danger zone**: Delete (today only from the Services list), with the dialog in [05](05-projects-environments-variables.md) 5.2.

Not in 1.0 (no screen today): changing the password after creation, resource limits, a custom start command, editing the public port number, moving to another server, duplicating.

## 8.3 Database backups

**Backups tab** for Postgres, MySQL, MariaDB, MongoDB and libSQL (needs backup rights on the service).
- With no destination: "Add a destination first", with a link for people who can add destinations, otherwise "Ask an owner or admin…".
- **Schedule list**: On or Paused, the schedule in words ("Every hour", "Every day at 03:00", "Every Sunday at 03:00", "On the 1st of each month at 03:00", or "Cron …"), the destination, the folder (`<app name>/<folder>/`), "Keeps all" or "Keeps last N", and the last run (Succeeded, Failed, Running, Queued, or "Not run yet").
- **Add / Edit**: Destination, Database (which database to dump), Schedule (preset or a 5-field cron with the syntax of 12.2, `L`, `nL`, `#` and `?` included; times are in the server's time zone, and the form says so), Folder (required), Keep (blank keeps all; otherwise at least 1; older files are deleted after each successful run), On switch.
- Files are compressed dumps named by timestamp (for example `2026-11-25T03-00-00.sql.gz`).
- **Run now**: starts in the background and returns at once: "Backup started…"; the row shows it running and then its result without a reload (today it says "Reload to see it finish").
- **Delete** a schedule: the files already in the bucket stay.
- Every run is a backup run record with a live log (shown in this tab, not on the Deployments page), and sends the "Database backup" notification. A run waiting when a new one starts ends as "Cancelled". Backup files are named by the run's start time in UTC. Run records are kept 100 per service.

**Redis**: the Backups tab offers volume backups of its data volume ([17](17-backup-destinations.md) 17.3) instead of saying "back it up with a volume backup" with no way to do it (today's dead end).

**Restore** (needs restore rights on the service):
1. Pick a destination and folder, "Find backups", choose a file. Only files from this service's own backups are listed and accepted (G1 and G2 in [24-known-gaps.md](24-known-gaps.md)).
2. "Restore into database".
3. Type the service name to confirm: "The restore overwrites the data in this database. It can't be undone."
4. A live log follows; the button ends as "Restored" or "Restore failed", with the reason in the log.

**Acceptance**
- A Postgres backup run writes a non-empty dump; dropping a table and restoring that dump brings it back.
- With "Keep 2", after three runs exactly two files remain.
- A backup step that fails marks the run Failed with the reason; a run never reports success having uploaded nothing.
