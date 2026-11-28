# Installer

Installs, upgrades and removes Nearzero on one Linux server, and provides the `nearzero` server command. Built from [`spec/03-install-and-cli.md`](../spec/03-install-and-cli.md).

| File | What it is |
| --- | --- |
| `install.sh` | The installer and upgrader: `curl -fsSL https://cdn.nearzero.dev/install.sh \| sudo bash` |
| `uninstall.sh` | The uninstaller: `curl -fsSL https://cdn.nearzero.dev/uninstall.sh \| sudo bash` (`-s -- --yes` skips the question) |
| `nearzero` | The server command, installed at `/usr/local/bin/nearzero` |
| `compose.yml` | The services on the control-plane host, written to `/opt/nearzero/compose.yml` |
| `scripts/embed.ts` | Copies `compose.yml` and `nearzero` into `install.sh` (run it after editing either) |
| `scripts/release.ts` | Lays out a release's installer files with their checksums |

The published installer is one file: `compose.yml` and `nearzero` travel inside `install.sh` as here-documents, and a unit test fails when the copies are out of date. Run `bun installer/scripts/embed.ts` after changing either.

## What `install.sh` does

1. Runs as root, or re-runs itself through sudo (keeping the install settings).
2. Asks every question first, on the terminal (so piping works): the admin account, then a domain when the server's public IPv4 address is routable, with the DNS check (Enter re-checks, `skip`, `use`). The check asks public DNS (1.1.1.1, then 8.8.8.8, with `dig` or `nslookup`, or Cloudflare's DNS JSON API over HTTPS without them), never `/etc/hosts`; the public IPv4 address is asked of OpenDNS the same way, and of an HTTPS address echo only on a server with no DNS tool.
3. Writes `/opt/nearzero/.env` (mode 0600) with generated per-install secrets, `compose.yml`, the router's console route and, with a managed zone, the DNS server's files.
4. Installs Docker from the distribution's packages when missing (Docker's own repository on the RHEL family, which doesn't package it) and the pinned Docker Compose plugin after checking its SHA-256.
5. Downloads the images side by side with a live percentage, starts Nearzero and waits for it to be healthy (`NEARZERO_STARTUP_TIMEOUT`, 300 seconds by default).
6. Creates the admin account by piping the email and password to the control plane's `create-owner --json` on standard input, then prints the summary. The installer reads the command's machine-readable answer (one JSON line and its exit code: 0 created, 2 missing or invalid input, 3 an owner exists, 4 the email has an account), and on reruns asks `owner-status --json` whether an owner exists; it never matches the wording of the messages people read.

Command output goes to `/opt/nearzero/install.log` (mode 0600); `NEARZERO_VERBOSE=true` shows it too. A failed step prints the log's last 25 lines; a failed start prints the services' states and their last 60 log lines.

A rerun is an upgrade: it keeps every saved value and any `KEY=value` lines added to `.env` (never evaluated or printed), stops on a malformed or duplicate line and names it, and refuses to change a saved console hostname, platform domain or DNS zone without the migration steps. The Nearzero image moves to the installer's version only when that is newer; custom images stay. The router belongs to the host's runner, which keeps it through upgrades and recreates it only when its settings change, so apps keep answering.

On Alpine, install `bash`, `curl` and `sudo` first (`apk add bash curl sudo`): the install command pipes into bash.

## Settings

The public settings in spec 3.1 keep their names. The others:

| Setting | Meaning | Default |
| --- | --- | --- |
| `NEARZERO_CONSOLE_PORT`, `NEARZERO_API_PORT` | Host ports of the console and the API | 4321, 3000 |
| `NEARZERO_HTTP_PORT`, `NEARZERO_HTTPS_PORT` | Host ports of the router | 80, 443 |
| `NEARZERO_RUNNER_LINK_PORT`, `NEARZERO_RUNNER_LINK_BIND_ADDRESS` | The runner link's TLS port, which servers reach Nearzero at, encrypted, until the dashboard's domain has its certificate (then they move to the domain by themselves). Only runners connect there, so it listens on every address even with the console on 127.0.0.1. Its certificate is made at the first start and kept in the `nearzero-runner-link` volume; setup and join commands carry its SHA-256 fingerprint, which the summary prints too. Servers set up on the domain keep it as their fallback. To replace the pair: `sudo nearzero runner-link rotate`, check `sudo nearzero runner-link status`, then `sudo nearzero runner-link switch` (every connected server is given the new fingerprint first) | 3443, 0.0.0.0 |
| `NEARZERO_IMAGE`, `NEARZERO_POSTGRES_IMAGE`, `NEARZERO_ROUTER_IMAGE`, `NEARZERO_DNS_IMAGE` | Image overrides (each must name a tag). An image from a registry you ran `sudo docker login` for (or `docker login` as the person running sudo) is pulled with that login; one that can't be pulled but is already on the server is used as it is | the release's images |
| `NEARZERO_ACME_EMAIL` | Contact for HTTPS certificates | the admin's email |
| `NEARZERO_DNS_BIND_ADDRESS` | Address the built-in DNS server listens on | all, or the server's own address when a local resolver holds port 53 on loopback |
| `NEARZERO_METRICS_RETENTION_DAYS` | Days of server metrics the control plane keeps (1 to 365) | 2 |
| `NEARZERO_TIME_ZONE` | The host's time zone name, given to the host's runner as `TZ` so backup times follow daylight saving (the runner runs in a container and can't read the host's zone itself) | read from the host at the first install (`timedatectl`, `/etc/timezone` or the `/etc/localtime` link); rerun with it set to change it |
| `NEARZERO_STARTUP_TIMEOUT` | Seconds to wait for Nearzero to start (30 to 3600) | 300 |
| `NEARZERO_UNATTENDED` | Ask nothing even with a terminal (`--unattended`) | false |
| `NEARZERO_DRY_RUN` | Check settings and print the plan; change nothing (`--dry-run`) | false |
| `NEARZERO_INSTALL_DIR` | The folder for Nearzero's settings, compose file, router and DNS files: a new or empty folder, or one holding Nearzero's `.env` (a rerun, or 0.1.x kept there). The `nearzero` command is written for it, so reruns and the uninstaller find it without the setting | `/opt/nearzero` |
| `NEARZERO_CONFIRM_ADDRESS_CHANGE` | Allow changing a saved hostname, domain or zone, after the migration steps | false |
| `NEARZERO_CONSOLE_URL`, `NEARZERO_TRUSTED_PROXIES`, `NEARZERO_EMAIL_FROM` with `NEARZERO_RESEND_API_KEY` or `NEARZERO_SMTP_URL` | Optional control-plane settings, saved and passed through when given (see the control plane's configuration) | none |
| `NEARZERO_DNS_PORT` | Port the built-in DNS server listens on | 53 |
| `NEARZERO_METRICS_REFRESH_SECONDS` | Seconds between the host runner's metrics samples (1 to 3600) | 5 |
| `NEARZERO_TRUSTED_ORIGINS` | Extra addresses people sign in from, comma-separated (every address that reaches the console already works) | none |
| `NEARZERO_REGISTRATION_MODE` | `bootstrap` or `invite-only` (0.1.x's `invite_only` is read as `invite-only`); both mean invitations only in 1.0, and `open` is read as `bootstrap` | bootstrap |
| `NEARZERO_HEROKU_BUILDER_IMAGE`, `NEARZERO_PAKETO_BUILDER_IMAGE`, `NEARZERO_RAILPACK_FRONTEND_IMAGE`, `NEARZERO_STATIC_NGINX_IMAGE` | Builder image overrides, each pinned by digest (`name@sha256:…`), for the host's runner and every server setup sets up (servers set up before take them when setup runs again). `NEARZERO_ROUTER_IMAGE` reaches every server the same way | the runner's own pins |

Every line of `.env` reaches the control-plane container, so settings added there by hand apply after `sudo nearzero restart`.

### 0.1.x setting names (spec 3.5)

Scripted installs and reruns written for 0.1.x keep working. These names are read as the 1.0 setting beside them; when both are given, the 1.0 name wins. `sudo` keeps the ones without the `NEARZERO_` prefix.

| 0.1.x name | Read as |
| --- | --- |
| `NEARZERO_NONINTERACTIVE` | `NEARZERO_UNATTENDED` |
| `NEARZERO_STARTUP_TIMEOUT_SECONDS` | `NEARZERO_STARTUP_TIMEOUT` |
| `NEARZERO_PLATFORM_PORT` | `NEARZERO_API_PORT` |
| `CONSOLE_URL`, `PUBLIC_BACKEND_URL`, then `BETTER_AUTH_URL` | `NEARZERO_CONSOLE_URL` |
| `PUBLIC_GIT_PROVIDER_BASE_URL` | `NEARZERO_GIT_PUBLIC_URL`: the address Git providers call back and send webhooks to, when it isn't the console's |
| `TRAEFIK_IMAGE`, `TRAEFIK_PORT`, `TRAEFIK_SSL_PORT` | `NEARZERO_ROUTER_IMAGE`, `NEARZERO_HTTP_PORT`, `NEARZERO_HTTPS_PORT` |
| `DRY_RUN`, `INSTALL_DIR` | `NEARZERO_DRY_RUN`, `NEARZERO_INSTALL_DIR` |
| `RESEND_API_KEY` | `NEARZERO_RESEND_API_KEY` |
| `NEARZERO_AUTH_FROM_EMAIL`, `RESEND_FROM_EMAIL` (the first wins) | `NEARZERO_EMAIL_FROM` |
| `EXTERNAL_SERVICES=true` | `NEARZERO_DATA_MODE=external` |
| `SKIP_DOCKER_INSTALL=true` | Stop when Docker is missing instead of installing it |
| `NO_COLOR` | Kept for the commands the installer runs (its own output has no colors) |
| `NEARZERO_METRICS_PORT`, `NEARZERO_METRICS_CRON` | Accepted and ignored with one note: 1.0's runner collects metrics itself |
| `NEARZERO_MONITORING_IMAGE`, `NEARZERO_ALLOW_MONITORING_DOCKER_METADATA`, `NEARZERO_SCHEDULE_IMAGE`, `JOBS_URL`, `API_KEY`, `TRAEFIK_SOCKET_PROXY_IMAGE`, `TRAEFIK_HTTP3_PORT`, `POSTGRES_USER`, `POSTGRES_DB` | Accepted and ignored, each named once with why (1.0 has no separate monitoring, schedule, jobs or socket-proxy service; HTTP/3 uses the HTTPS port; the bundled database's user and name are fixed), by the installer and in the control plane's start log |

`NEARZERO_CONSOLE_PORT`, `NEARZERO_TRUSTED_ORIGINS`, `NEARZERO_REGISTRATION_MODE`, the builder image overrides, `NEARZERO_METRICS_REFRESH_SECONDS`, `NEARZERO_METRICS_RETENTION_DAYS`, `NEARZERO_DNS_BIND_ADDRESS` and `NEARZERO_DNS_PORT` keep their 0.1.x names. On a move, the same renames apply to the 0.1.x settings file. The control plane reads the old console address and email names too (`withLegacySettingNames` in `packages/shared/src/config.ts`). Server email that is only half set up (a key without a sender, a sender without a key, or both Resend and SMTP) never stops the control plane: it is logged at start, shown on the Members page, and invitations fall back to links.

## What Nearzero creates, and how uninstall finds it

Everything Nearzero creates on a server carries the labels `dev.nearzero.managed=true` and `dev.nearzero.edition=1` (the one naming 1.0; uninstall and `migrate rollback` remove only what carries it, spec 29.5): its containers, volumes, networks and the images it builds. Its names are its own and never 0.1.x's: the Compose project `nearzero1`, the containers `nearzero-control`, `nearzero-runner`, `nearzero1-postgres`, `nearzero1-dns` and `nearzero-router`, the networks `nearzero-internal` and `nearzero-edge` and the volumes `nearzero-postgres-data`, `nearzero-runner-state`, `nearzero-runner-handoff`, `nearzero-runner-link` (the runner link's certificate) and `nearzero-router-certificates`. The installer creates the networks and volumes itself (they are external in `compose.yml`), and before anything starts it stops when one of these names is already taken by something without 1.0's label. The apps, Compose projects and databases it deploys keep this rule, and so do the build caches: the BuildKit container `nearzero-buildkit` and its cache volume `nearzero-buildkit-state` that Railpack builds use (through the buildx builder `nearzero-railpack`), and the buildpacks' cache volumes `nearzero-pack-<app>-build` and `nearzero-pack-<app>-launch`, which teardown removes with their service. The installer records the images it downloads in `/opt/nearzero/.pulled-images`; images that were already on the server are left and listed by the uninstaller. Images `pack` uses by their own names (the Heroku and Paketo builder and run images) can't carry the label, so the runner records the ones a build brought onto the server in `pulled-images` in its work folder (on the Nearzero host, inside the `nearzero-runner-state` volume), and the uninstaller removes those too unless a container still uses them.

The router isn't in `compose.yml`: the host's runner (the `runner` service, the same runner every server runs) creates `nearzero-router`, checks it every minute, and restarts it when it stops (spec 23.2). The runner enrolls itself with a one-time token the control plane leaves in the `nearzero-runner-handoff` volume at every start. The installer still downloads the router image, so the runner finds it on the server.

## Tests

- `bun test installer` checks settings, reruns, the embedded copies, the release layout and the commands without root, using dry runs.
- `bun run --cwd e2e test:install` builds the image and runs the real `install.sh` in a Docker-in-Docker host (`nz1-e2e-host`) with answers typed at the prompts: an interactive install, the `nearzero` command, an interactive rerun, uninstall, and an unattended install with only an email. `NZ1_E2E_KEEP=1` keeps the host afterwards; `NZ1_E2E_HOST` and `NZ1_E2E_IMAGE` rename the host and image, and `NZ1_E2E_PREBUILT=1` tests an image just built from the checkout instead of building it again. The suite also checks that the image carries the four runners server setup sends, matching `SHA256SUMS` and each on its own C library.
- Before every release, the install matrix in spec 26.3 runs the same flow on fresh VMs.

## Releases

`bun installer/scripts/release.ts --version 1.0.0 --image-repository ghcr.io/nearzero-systems/nearzero --out <dir>` writes `install.sh`, `uninstall.sh` and a `.sha256` beside each, at the top (latest) and under `v1.0.0/` (pinned). Without `--image-repository` the files name `ghcr.io/nearzero-systems/nearzero`, the same image the release workflow publishes: it names the image after the GitHub repository, lowercased (`Nearzero-systems/nearzero` becomes `nearzero-systems/nearzero`). The release workflow publishes them only after every image the installer references exists for amd64 and arm64. To pin and check a version:

```sh
curl -fsSLO https://cdn.nearzero.dev/v1.0.0/install.sh
curl -fsSLO https://cdn.nearzero.dev/v1.0.0/install.sh.sha256
sha256sum -c install.sh.sha256 && sudo bash install.sh
```

Before uninstalling, back up with `sudo nearzero backup-db`: the uninstaller keeps those dumps, moving them to `/var/backups/nearzero`, and says so. It stops before removing anything while Docker is stopped or Nearzero 0.1.x is still on the server, and on a server set up from Nearzero it removes the runner, its credential and its files too. Reinstalling with the same dashboard hostname requests new certificates, which Let's Encrypt limits to 5 per week for the same names.
