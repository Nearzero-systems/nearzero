# 03. Install, upgrade, uninstall and the `nearzero` command

## 3.1 Install

**Command**

```
curl -fsSL https://cdn.nearzero.dev/install.sh | sudo bash
```

Each release's installer is also published at a versioned address with a SHA-256 checksum file beside it, so a person can pin a version and verify it before running it. Nothing runs if a download or the checksum check fails.

**Preflight**
- Runs as root, or re-runs itself through sudo. Without sudo: "Run the installer as root: …".
- Installs Docker if missing, using the distribution's own packages: Ubuntu, Debian and Debian-likes, Alpine, Arch, Amazon Linux, Fedora and the RHEL family (CentOS, Rocky, Alma, Oracle), SUSE. Any other distribution stops with a link to Docker's install guide.
- Installs the Docker Compose plugin if missing, from a pinned version with a checked checksum (amd64 and arm64).
- Banner: "Self-hosted Platform as a Service · Community Edition" (wording may change; the edition name stays).
- On a first install, checks that ports 80, 443, 3000, 4321 and 3443 (and 53 when a managed zone is set) are free, naming the process that holds one. A port held by one of Nearzero's own containers (its router, its control plane) isn't counted, and a rerun with saved settings checks only a port it adds (the runner link's 3443 on an upgrade), so a rerun with the control plane stopped isn't refused (C2-14).
- On the RHEL family, Docker comes from Docker's own repository, since the distribution doesn't package it.
- Alpine needs `bash`, `curl` and `sudo` installed before `curl … | sudo bash` can run; the install guide says so.
- The public IPv4 address is detected with a DNS query to a public resolver, falling back to a plain HTTPS address-echo service only when no DNS tool exists (both are "public DNS lookups for checks" in 23.9).

**Interactive first install** (all questions come before any download; answers are read from the terminal, so piping the script works):

1. "Create your admin account"
   - "Email:" → "Enter a valid email address, like you@company.com." on a bad address. With `NEARZERO_ADMIN_EMAIL` given at a terminal, "Email [<given>]:" (Enter keeps it), and the password is still asked for (G4-22).
   - "Password (8+ characters):" and "Confirm password:" → "Use 8 to 128 characters." / "The passwords don't match. Try again."
2. The domain question, asked only when the server's public IPv4 address is publicly routable (otherwise skipped silently):
   - "Add a domain for HTTPS on the dashboard and your apps? [y/N]" (Enter means no; anything other than y or n gets "Answer y or n.").
   - "Domain, like example.com or apps.example.com (Enter to skip)". A leading `*.` is removed; an IP address gets "Enter a domain name only, like example.com." The domain may be a root domain or a subdomain.
   - "Dashboard address [nearzero.<domain>]". Any hostname with a dot.
   - It lists the records to create: `*.<domain> A <ip>`, plus `<dashboard> A <ip>` when the wildcard does not cover the dashboard address, and "allow inbound TCP 80 and 443". Then: 'Press Enter once they exist, or "skip"'.
   - **DNS check**: it resolves a random name under the domain and the dashboard address; both must point at the server. On a mismatch: "<name> points at <x | nothing yet>, not <ip>." and "Once a domain is set you sign in there, so DNS has to be right first." Then Enter re-checks, "skip" goes without a domain, "use" accepts it anyway (for a proxy in front).
   - If a hostname is chosen and no contact email is known (on reruns), it asks "Email for HTTPS certificates:".
   - Skipping, by "n" or Enter at the y/N question or later, prints "Skipped. Run this install command again to add one."
3. Progress, one line each, with a check mark when done:
   - "Saved the configuration in /opt/nearzero"
   - "Docker is installed"
   - "Downloading Nearzero: N% · x of y images · Mm SSs" → "Downloaded Nearzero" (images download side by side with a live percentage)
   - "Starting Nearzero" → "Nearzero is running"
   - "Checking your admin account" → "Created your admin account" or "Kept your admin account"
4. Summary:
   - "Nearzero is ready.", then Open <address>, Sign in <email>, and "Then add your name and your workspace name when you first sign in". On a rerun that kept the account: "Sign in <email>  (the existing account and its password)", then "Forgot that password? Run: sudo nearzero reset-password".
   - With a domain: "Apps get addresses like https://<label>.<domain>", plainly an example (no app lives at a made-up address).
   - Firewall advice for the chosen setup: allow TCP 80 and 443 ("The first visit can take a minute while the HTTPS certificate is issued"), or allow TCP 4321 (no domain), or an SSH tunnel recipe (console bound to localhost), plus "Delegate <zone> to ns1/ns2 (glue <ip>) and allow TCP and UDP 53" when a managed DNS zone is set.
   - The runner link, in every setup: "Servers you add reach Nearzero over an encrypted link on TCP 3443: allow it from them." (with a domain: through `https://<dashboard>` once its certificate is issued, and through TCP 3443 until then), and the link certificate's SHA-256 fingerprint, which setup and join commands carry.
   - "Add a domain with HTTPS any time: run this install command again."

**What a domain changes**
- Apps get generated addresses under it, like `https://a3f9c2b1.example.com` (a short random label, not the service name).
- The console moves to the dashboard address over HTTPS; the plain `http://<ip>:4321` address redirects there, because sign-in cookies are Secure on HTTPS.
- Without a domain, the console stays at `http://<ip>:4321` and apps deploy and run without a public address until a domain is set.

**Unattended install** (no terminal, or explicitly non-interactive):
- `NEARZERO_ADMIN_EMAIL` alone: the installer generates a password and prints it once at the end, "(shown once; change it after you sign in)". (At a terminal, without `--unattended`, the password is asked for instead.)
- With `NEARZERO_ADMIN_PASSWORD` too (8 to 128 characters, one line, never written to disk): uses it. A password without an email stops with a message saying it needs the email.
- Neither: installs, and says to run `sudo nearzero create-owner`.
- No questions are asked; the domain is set up front with the variables below.

**Public install settings** (environment variables; these names are part of the product's documented interface and stay the same in 1.0):

| Setting | Meaning | Default |
| --- | --- | --- |
| `NEARZERO_ADMIN_EMAIL`, `NEARZERO_ADMIN_PASSWORD` | Admin account for unattended installs | none |
| `NEARZERO_PLATFORM_DOMAIN` | Domain whose wildcard gives apps generated hostnames; creates no DNS records itself | none |
| `NEARZERO_MANAGEMENT_HOSTNAME` | The console's address | `nearzero.<domain>` when a domain is given interactively |
| `NEARZERO_MANAGED_DNS_ZONE` | A zone Nearzero serves itself with its built-in DNS server | none |
| `NEARZERO_ENABLE_MANAGED_DNS` | Run the built-in DNS server (TCP and UDP 53) | true (1.0: false unless a zone is set; see note) |
| `NEARZERO_MANAGED_DNS_SOA_EMAIL` | DNS contact | the admin email |
| `NEARZERO_PUBLIC_IP` | Override the detected public address; must be publicly routable when a hostname or zone is set (private, shared, loopback, link-local, documentation, benchmark, multicast and reserved ranges are rejected) | detected |
| `NEARZERO_MANAGEMENT_BIND_ADDRESS` | Where the console and API listen (set 127.0.0.1 to keep them off the network and use an SSH tunnel) | all interfaces |
| `NEARZERO_DATA_MODE` with `DATABASE_URL` (and `REDIS_URL` while a queue store exists) | Use an external database instead of the bundled one; URLs must be supplied together; partial input is rejected | local |
| `NEARZERO_SSH_STRICT_HOST_KEY_CHECKING` | Refuse servers whose host key wasn't seeded beforehand | false |
| `NEARZERO_VERBOSE` | Show every command's output (otherwise it goes to `/opt/nearzero/install.log`, mode 0600) | false |

Other settings exist for ports, builder image overrides (Heroku, Paketo, Railpack, the static server), metrics retention and refresh, extra trusted sign-in origins, the registration mode, the startup timeout, skipping every question, and a dry run; they are documented in the install guide, not on the first screen. Every setting name 0.1.x accepted keeps working in 1.0 (as an alias where 1.0 uses a new name), so scripted installs and reruns behave the same. Values may not contain whitespace, quotes, `#`, `$` or backslashes (credentials must be percent-encoded). Ports must be 1 to 65535.

Note on DNS: today the built-in DNS server starts by default and takes port 53 even with no zone, and the installer does not check that the port is free. In 1.0 it starts only when a managed zone is configured, and the installer checks port 53 first and explains the conflict.

**What runs on the control-plane host**
- The Nearzero service (console and API), listening on 4321 and 3000, and the runner link's TLS port 3443, which only runners use (on every address, even when the console is bound to localhost).
- Monitoring, on localhost only.
- The bundled database (and queue store, if kept) in local mode, not published.
- The built-in DNS server, only with a managed zone.
- The router on 80 and 443, started and checked by Nearzero itself on every start.

**Failures**
- A failed step shows the last 25 lines of the log and "Fix the problem above, then run the same install command again."
- A failed start shows the service states and the last 60 log lines, then "Nearzero did not start…", after a startup timeout (default 300 seconds).

**Security of a fresh install**
- No account can be created from the web on a fresh install. The admin account only comes from the server (installer or `nearzero create-owner`), so nobody can claim the install first.
- Per-install secrets (database password, authentication secret, metrics token) are generated randomly and stored in `/opt/nearzero/.env` with owner-only permissions.
- The README and the summary warn that 3000 and 4321 are plain HTTP and should be blocked at the perimeter once the domain serves HTTPS.

**Acceptance**
- The interactive install on each supported distribution ends with a sign-in that works at the printed address.
- With a domain whose records are wrong, the installer refuses to save it until the person fixes DNS, skips, or chooses "use".
- An unattended install with only an email prints a working password once and never writes it to disk or the log.
- After install, the web sign-up page is closed: a request to register without an invitation is refused.

## 3.2 Upgrade

- **Upgrade is the same command.** A rerun keeps settings, data, accounts and passwords, extra `KEY=value` lines added to `/opt/nearzero/.env` (carried forward without being evaluated or printed; a malformed or duplicate line stops the run with the line named), the data mode and external URLs, ports, and custom image choices.
- Official images move to the installer's version only when it is newer.
- The domain question is offered again until a domain is set, unless the console already has a hostname saved. Changing an existing hostname or zone is refused ("requires a migration") with the steps to do it; a person who has followed the steps confirms with an explicit setting (`NEARZERO_CONFIRM_ADDRESS_CHANGE=true`). Switching between local and external data mode on a rerun is refused.
- Comments in `/opt/nearzero/.env` are not carried forward; only settings are.
- Running apps and databases keep running; only the control plane restarts. When the host's runner is replaced too (a newer image, other settings), the control plane is updated first and the runner once no task run, backup or restore runs on the host, waiting up to 30 minutes with a line saying what it waits for; work still running then stops there, its runs say so, and the summary names it (C2-10).
- 0.1.x installs move to 1.0 through the migration in [25-open-decisions.md](25-open-decisions.md) D3.

- **Data without its settings**: if the installer finds 1.0's database volume, or other volumes carrying 1.0's label, but no `/opt/nearzero/.env`, it never starts Nearzero with new secrets over the old data. It stops before starting anything with "Found Nearzero's data (<volume>) but not its settings file /opt/nearzero/.env. Put the settings file back and run this command again, or run the uninstall command to remove the old data and start fresh."
**Acceptance**: a rerun on a working install changes nothing a person can see except the version, and every app keeps answering during it.

## 3.3 Uninstall

```
curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash
```

- On a server that still has 0.1.x (a 0.1.x settings file, its containers or Swarm services, an unfinished move, or a move rolled back), it removes nothing and names it, with 0.1.x's own uninstaller to run first: `curl -fsSL https://cdn.nearzero.dev/releases/0.1.80/uninstall.sh | sudo bash`, whose checksum is beside it (`….sha256`). During an unfinished move it names `sudo nearzero migrate finalize` and `migrate rollback` instead.
- Root only. Asks once: "This deletes Nearzero and everything it deployed… This cannot be undone. Remove Nearzero? [y/N]". `bash -s -- --yes` skips the question for scripts. With no terminal and no `--yes`: "No terminal to confirm on, so nothing was removed…".
- Removes: the control plane and its database, the router, monitoring and DNS, every app, Compose project and database Nearzero deployed on this server with their volumes and data, Nearzero's networks, `/opt/nearzero`, `/etc/nearzero` and the `nearzero` command.
- 1.0 change: it removes only images, volumes and build cache that Nearzero created (by label), not every unused one on the host. It lists anything else it left. The networks of the Compose stacks Nearzero deployed (`<project>_default` and any a stack declares) go with them, found by their project (C2-13). Docker's own builder keeps the cache of Dockerfile, Nixpacks and static builds unlabelled, mixed with the person's own, so it stays and the uninstaller says so with its size and `docker builder prune` (C2-12); Railpack's builder, Nearzero's own, is removed.
- Leaves: Docker, the swap file, rclone and SSH hardening that server setup may have added, external databases, and remote servers (which have their own uninstall run).
- The README recommends `sudo nearzero backup-db` first and warns that reinstalling with the same dashboard hostname requests new certificates, which are rate-limited (5 per week for the same names).

**Acceptance**: after uninstall, no container, volume, network, file or command from Nearzero remains, and unrelated containers and volumes on the host are untouched.

## 3.4 The `nearzero` server command

Installed at `/usr/local/bin/nearzero`. Needs root for everything that touches accounts or data ("run: sudo nearzero <command>"). With no argument it runs `status`. An unknown command prints usage and exits 1.

| Command | Behavior |
| --- | --- |
| `status` | Shows the Nearzero services and their state. |
| `logs [service...] [--tail N] [--since T] [--timestamps]` | Follows the logs of all services, or of those named, together (the router, and the DNS server the runner starts for a zone connected in the console, included); the options are Docker's, and 0.1.x's service names work. Starts from the last 200 lines unless `--tail` says. `status` lists that DNS server too. |
| `restart` | Restarts Nearzero. |
| `update` | Re-pulls the configured release and restarts. It does not move to a newer version (the install command does); the help text says so. |
| `create-owner` | Creates the admin account if none exists. Prompts for email and password, or reads two lines (email, password) from standard input without a terminal. When the settings file holds `NEARZERO_ADMIN_EMAIL`, the prompt reads "Email [<that email>]:" and Enter, or an empty first line on standard input, uses it. "This server already has an owner: X" plus "Forgot the password? Run: sudo nearzero reset-password". "Nearzero is not running. Start it with: sudo nearzero restart". Success: "Admin account created. Sign in at <address> as <email>". |
| `reset-password [email]` | Sets a new password for any account, signs out that account's other sessions. Without an email argument: on a terminal it asks "Email [<owner's email>]:" (Enter keeps the owner), then "New password for <email> (8+ characters):" and "Confirm password:"; without a terminal it reads two lines, the email (an empty line means the owner) and then the password, as 0.1.x did. With an email argument it reads only the password line. Errors: "No account exists for X.", "Use a password between 8 and 128 characters." Success: "Password updated for X. Its other sessions were signed out." |
| `set-email <old> <new>` | New in 1.0, for servers without email (04 4.6): gives the account a new address that counts as confirmed (the same unconfirmed address confirms it), signs out all of its sessions and records it in the audit. Errors: "No account exists for X.", "Another account already uses this email address. Use a different one.", "Enter a valid email address, like you@company.com." |
| `reset-2fa` | New in the command list for 1.0 (the capability exists today but has no command): turns off two-factor sign-in for one account after confirmation, for a person who lost both their authenticator and backup codes. |
| `backup-db [file]` | Bundled database only. Dumps the control-plane database to the file (default `/opt/nearzero/nearzero-db-<timestamp>.sql`), written atomically with mode 0600; prints the path. A failed dump leaves any earlier file untouched. Errors name the problem ("backup destination directory does not exist"). |
| `restore-db <file>` | Bundled database only. Loads a dump made by `backup-db` after a typed confirmation that the current data will be replaced. Today this command exists without being documented or confirmed; 1.0 documents it and asks first. |
| `export` / `import` | Added for the 0.1.x migration (decision D3). |
| `help` | Usage. |

A broken configuration file gives "missing or duplicate X in /opt/nearzero/.env; rerun the installer" before any command runs.

**Acceptance**: each command works over SSH without a terminal where it reads from standard input, and none of them prints a password or secret.

## 3.5 0.1.x setting names 1.0 keeps accepting

Scripted installs and reruns written for 0.1.x keep working. These are the install settings 0.1.x documented; 1.0 reads each one (as itself or as an alias for its 1.0 setting) and the install guide lists both names.

| 0.1.x setting | Meaning in 1.0 |
| --- | --- |
| `NEARZERO_NONINTERACTIVE` | Ask nothing (unattended mode) |
| `NEARZERO_STARTUP_TIMEOUT_SECONDS` | How long the installer waits for Nearzero to start |
| `NEARZERO_PLATFORM_PORT` | The API's port (3000) |
| `NEARZERO_CONSOLE_PORT` | The console's port (4321) |
| `NEARZERO_TRUSTED_ORIGINS` | Extra addresses allowed to sign in (comma-separated) |
| `NEARZERO_REGISTRATION_MODE` | Registration mode (bootstrap or invite-only; "open" behaves as bootstrap) |
| `NEARZERO_HEROKU_BUILDER_IMAGE`, `NEARZERO_PAKETO_BUILDER_IMAGE`, `NEARZERO_RAILPACK_FRONTEND_IMAGE`, `NEARZERO_STATIC_NGINX_IMAGE` | Builder image overrides, pinned by digest, for builds on every server: the host's runner, and each server setup sets up (one set up before takes them when setup runs again). The router image (`NEARZERO_ROUTER_IMAGE`) reaches every server the same way (31d G4-18) |
| `NEARZERO_METRICS_REFRESH_SECONDS`, `NEARZERO_METRICS_RETENTION_DAYS` | Metrics sample interval and retention |
| `NEARZERO_METRICS_PORT`, `NEARZERO_METRICS_CRON` | Accepted and ignored: 1.0's runner collects metrics itself; the installer says so once |
| `NEARZERO_DNS_BIND_ADDRESS`, `NEARZERO_DNS_PORT` | Where the built-in DNS server listens |
| `CONSOLE_URL`, `PUBLIC_BACKEND_URL` | The console's public address (alias for the 1.0 console address setting) |
| `DRY_RUN`, `SKIP_DOCKER_INSTALL`, `NO_COLOR`, `INSTALL_DIR` | Same meaning |
| `EXTERNAL_SERVICES` | Accepted as the old form of external data mode |
| `TRAEFIK_IMAGE`, `TRAEFIK_PORT`, `TRAEFIK_SSL_PORT` | The router's image and its HTTP and HTTPS ports (`NEARZERO_ROUTER_IMAGE`, `NEARZERO_HTTP_PORT`, `NEARZERO_HTTPS_PORT`) (31d G4-19) |
| `BETTER_AUTH_URL` | The console's address, when neither `NEARZERO_CONSOLE_URL` nor `CONSOLE_URL`/`PUBLIC_BACKEND_URL` is set |
| `PUBLIC_GIT_PROVIDER_BASE_URL` | `NEARZERO_GIT_PUBLIC_URL`: the address Git providers call back and send webhooks to, when it isn't the console's |
| `NEARZERO_MONITORING_IMAGE`, `NEARZERO_ALLOW_MONITORING_DOCKER_METADATA`, `NEARZERO_SCHEDULE_IMAGE`, `JOBS_URL`, `API_KEY`, `TRAEFIK_SOCKET_PROXY_IMAGE`, `TRAEFIK_HTTP3_PORT`, `POSTGRES_USER`, `POSTGRES_DB` | Accepted and ignored, as 1.0 has nothing they set: each is named once, with why, by the installer and in the control plane's start log |
