Nearzero is a self-hostable Platform as a Service (PaaS) for deploying and managing applications and databases.

This repository is the **Community (open-source) edition**: self-hosted, email and password auth, BYO git providers, and org-scoped agent BYOK. Hosted Cloud/Enterprise features (billing, SSO, audit logs, managed git, etc.) live in a separate private package and are not included here.

## Features

- **Applications:** Deploy Node.js, PHP, Python, Go, Ruby, and more.
- **Databases:** MySQL, PostgreSQL, MongoDB, MariaDB, libsql, and Redis.
- **Backups:** Automated database backups to external storage.
- **Docker Compose:** Native Compose support for complex stacks.
- **Multi Node:** Scale with Docker Swarm.
- **Templates:** One-click open-source templates.
- **Traefik:** Built-in routing and load balancing.
- **Monitoring:** CPU, memory, storage, and network metrics.
- **CLI/API:** Manage deployments programmatically.
- **Notifications:** Slack, Discord, Telegram, email, and more.

## Getting Started

### Self-hosted install

On a fresh Linux server (Ubuntu, Debian, Fedora, RHEL, Amazon Linux and
others), run:

```bash
curl -fsSL https://cdn.nearzero.dev/install.sh | sudo bash
```

The installer asks for two things, your admin email and a password, then
installs Docker if needed, starts Nearzero and creates your account:

```text
  Create your admin account
  Email: you@company.com
  Password (8+ characters):
  Confirm password:

  ✓ Saved the configuration in /opt/nearzero
  ✓ Docker is installed
  ✓ Downloaded Nearzero
  ✓ Nearzero is running
  ✓ Created your admin account

  Nearzero is ready.

    Open      http://203.0.113.10:4321
    Sign in   you@company.com
```

Open the address and sign in. If the page doesn't load, allow inbound TCP 4321
in the server's firewall or cloud security group. To serve the console on your
own domain with HTTPS, open **Settings → About Nearzero** after signing in.

Apps get public addresses from your DNS domain. Open **Domains → Add New →
Connect a domain**, then point the domain's nameservers at this server and allow
inbound TCP 80 and 443 plus TCP and UDP 53. The first domain you connect becomes
the default for every environment, so an app named `web` gets `web.example.com`.
Until then, apps deploy and run without a public URL.

Nobody can create an account from the web until you invite them: the admin
account only comes from the server, so a fresh install can't be claimed by
someone else first.

Run the same command again to upgrade. It keeps your settings and data and
doesn't ask anything.

Manage the server with the `nearzero` command:

| Command | What it does |
| --- | --- |
| `sudo nearzero status` | Show the Nearzero services |
| `sudo nearzero logs [service]` | Follow service logs |
| `sudo nearzero restart` | Restart Nearzero |
| `sudo nearzero update` | Pull the configured images and restart |
| `sudo nearzero reset-password` | Set a new password for an account |
| `sudo nearzero create-owner` | Create the admin account, if the installer didn't |
| `sudo nearzero backup-db [file]` | Dump the bundled Postgres database |

#### Verified install

To check the installer before it runs, pin a published version and verify its
checksum. Nothing runs if a download or the checksum check fails:

```bash
(
  set -Eeuo pipefail
  umask 077
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT
  cd "$workdir"
  version="0.1.53"
  base_url="https://cdn.nearzero.dev/releases/${version}"
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --output install.sh "${base_url}/install.sh"
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --output install.sh.sha256 "${base_url}/install.sh.sha256"
  sha256sum --check install.sh.sha256
  sudo bash install.sh
)
```

The installer expects the public Community images to be available from
`ghcr.io/nearzero-systems/*`. A release is ready only when its matching
`nearzero`, `monitoring`, and `schedule` image tags have all been published.

#### Unattended install

Without a terminal (cloud-init, CI), pass the admin email. The installer
generates a password and prints it once at the end; add
`NEARZERO_ADMIN_PASSWORD` to choose it instead:

```bash
curl -fsSL https://cdn.nearzero.dev/install.sh | sudo NEARZERO_ADMIN_EMAIL=you@company.com bash
```

Without an email it still installs, and you create the account later with
`sudo nearzero create-owner`. `NEARZERO_VERBOSE=true` shows every command's
output; otherwise it goes to `/opt/nearzero/install.log`.

#### Advanced options

By default the installer sets up a single-node Community stack with local
Postgres, Redis, host metrics, and an authoritative CoreDNS service on TCP/UDP
53. Before delegating a production zone, read the
[OSS DNS and remote-server setup](docs/OPEN_SOURCE_CONTROL_PLANE.md); the
control-plane DNS host and remote application servers have different firewall
and routing responsibilities. Set `NEARZERO_ENABLE_MANAGED_DNS=false` when
another DNS provider is authoritative or port 53 is taken.

The console and API listen on ports 4321 and 3000 on all interfaces, so the
first sign-in works at `http://<server-ip>:4321`. That is plaintext HTTP: once
your domain serves HTTPS, block 3000 and 4321 at the public perimeter. To keep
them off the network from the start, set
`NEARZERO_MANAGEMENT_BIND_ADDRESS=127.0.0.1` and reach the console through an
SSH tunnel (`ssh -L 4321:127.0.0.1:4321 <user>@<server>`). Explicit
`CONSOLE_URL`, `BETTER_AUTH_URL`, `PUBLIC_GIT_PROVIDER_BASE_URL` and
`PUBLIC_BACKEND_URL` overrides are preserved.

Automation can also set the domains up front instead of in the dashboard:

```bash
curl -fsSL https://cdn.nearzero.dev/install.sh | sudo \
  NEARZERO_ADMIN_EMAIL=you@company.com \
  NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com \
  NEARZERO_MANAGED_DNS_ZONE=apps.example.com \
  bash
```

- The **management hostname**, for example `nearzero.example.com`, is only for
  the console and API. Point its A record to the server IP and allow TCP
  80/443; Nearzero sets up Traefik and Let's Encrypt for it.
- The **managed application zone**, for example `apps.example.com`, supplies
  hostnames for deployed services. CoreDNS starts with a bootstrap SOA/NS zone
  and in-zone `ns1`/`ns2` A records, and the admin's organization adopts it.
  You still delegate it at the parent DNS provider.
- `NEARZERO_PUBLIC_IP` can be omitted when automatic detection is correct. With
  a public hostname or zone it must be publicly routable; private, shared,
  loopback, link-local, documentation, benchmark, multicast, and reserved
  ranges are rejected. `NEARZERO_MANAGED_DNS_SOA_EMAIL` sets a DNS contact
  other than the admin email.

These values are normalized and stored in `/opt/nearzero/.env`. A rerun keeps
them and rejects changes to the hostname or zone, which need a migration. The
managed application zone is not `NEARZERO_PLATFORM_DOMAIN`: the latter is an
advanced external-wildcard/shared-edge mode and does not create authoritative
DNS records.

To use managed Postgres and Redis without putting credentials in shell history
or command arguments, read them without terminal echo:

```bash
IFS= read -r -s -p "Database URL: " DATABASE_URL; printf '\n'
IFS= read -r -s -p "Redis URL: " REDIS_URL; printf '\n'
export NEARZERO_DATA_MODE=external DATABASE_URL REDIS_URL
sudo --preserve-env=NEARZERO_DATA_MODE,DATABASE_URL,REDIS_URL bash install.sh
unset NEARZERO_DATA_MODE DATABASE_URL REDIS_URL
```

The installer persists `NEARZERO_DATA_MODE=local|external`, so a rerun keeps
the selected mode and external URLs. Supply both URLs together; partial input is
rejected. To return to the bundled Postgres and Redis, unset both URL variables
and run `sudo NEARZERO_DATA_MODE=local bash install.sh`.

A rerun also keeps the installed Postgres user/database, published ports,
metrics settings, startup timeout, and the configured Nearzero, monitoring,
schedule, and CoreDNS images unless you override that exact variable. Extra
single-line `KEY=value` assignments in `/opt/nearzero/.env` (for example,
model-provider credentials) are carried forward without being evaluated or
printed. Fix malformed or duplicate assignments before rerunning; the installer
stops instead of guessing.

`sudo nearzero backup-db /path/to/dump.sql` uses the stored database identity
and writes the dump atomically with mode `0600`. A failed dump leaves any
previous complete backup untouched.

### Uninstall or reinstall

This removes Nearzero and **everything it deployed on the server**: the
control plane, its database, every app, database and Compose project, their
volumes and data, unused images and build cache, `/opt/nearzero`,
`/etc/nearzero` and the `nearzero` helper. It assumes the server is dedicated
to Nearzero (as recommended). Docker itself stays installed. Nothing can be
recovered afterwards.

If you use the installer-managed Postgres, keep a copy of the control-plane
database first:

```bash
sudo install -d -m 0700 /var/backups/nearzero
sudo nearzero backup-db /var/backups/nearzero/control-plane.sql
```

Then remove Nearzero. It asks once before deleting anything:

```bash
curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash
```

In scripts, skip the question with `curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash -s -- --yes`.

To install again, run the install command from
[Self-hosted install](#self-hosted-install). It is a fresh first install: it
asks for the admin email and password again.

- With `NEARZERO_DATA_MODE=external`, the command does not touch your external
  Postgres and Redis. Empty that database and Redis before reinstalling with
  the same URLs, or the old installation comes back.
- Remote servers you added keep their own Traefik, monitoring and apps. Run
  the same command on each one to remove them.
- Reinstalling with the same management hostname requests new Let's Encrypt
  certificates. Let's Encrypt issues at most 5 certificates for the same
  hostnames per week, so avoid repeated reinstalls in a short time.

### Local development

```bash
git clone https://github.com/Nearzero-systems/nearzero.git
cd nearzero
bun run setup   # first time: deps + Docker infra + migrations
bun run dev     # platform API (:3000) + console (:4321)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

### Auth (Community)

Sign-in uses email and password. No third-party email provider is required for authentication.

Documentation: [docs.nearzero.dev](https://docs.nearzero.dev)

Console: [nearzero.dev](https://nearzero.dev)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Nearzero is open source under the [Apache License 2.0](LICENSE.MD). The
monitoring service in `apps/monitoring` is available under the
[MIT License](apps/monitoring/LICENSE.md).

Copyright © 2026-present Nearzero Systems.
