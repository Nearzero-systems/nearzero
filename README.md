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

The copy-ready path downloads the latest installer and checksum into a private
temporary directory. The fail-closed subshell never executes the installer when
either download or checksum verification fails:

```bash
(
  set -Eeuo pipefail
  umask 077
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT
  cd "$workdir"
  base_url="https://nearzero.dev"
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --output install.sh "${base_url}/install.sh"
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --output install.sh.sha256 "${base_url}/install.sh.sha256"
  sha256sum --check install.sh.sha256
  bash install.sh
)
```

For a reproducible production install, pin an immutable published version
instead of the mutable latest path:

```bash
(
  set -Eeuo pipefail
  umask 077
  workdir="$(mktemp -d)"
  trap 'rm -rf "$workdir"' EXIT
  cd "$workdir"
  version="0.1.43"
  base_url="https://nearzero.dev/releases/${version}"
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --output install.sh "${base_url}/install.sh"
  curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --retry 3 --output install.sh.sha256 "${base_url}/install.sh.sha256"
  sha256sum --check install.sh.sha256
  bash install.sh
)
```

By default this installs a single-node Community stack with local Postgres,
Redis, host metrics, and an opt-out authoritative CoreDNS service on TCP/UDP 53.
The installer expects the public Community images to be available from
`ghcr.io/nearzero-systems/*`. A release is ready only when its matching
`nearzero`, `monitoring`, and `schedule` image tags have all been published.
Before delegating a production zone, read the
[OSS DNS and remote-server setup](docs/OPEN_SOURCE_CONTROL_PLANE.md); the
control-plane DNS host and remote application servers have different firewall
and routing responsibilities.

On a first run attached to a terminal, the installer asks whether to enable
managed DNS on UDP/TCP 53, then prints a one-time browser setup URL. Open that
URL through the documented SSH tunnel and complete the wizard:

- The **management hostname** (required), for example `nearzero.example.com`, is
  only for the console and API. Point its A record to the server IP and allow
  TCP 80/443; Nearzero seeds Traefik and Let's Encrypt for this hostname.
- The **managed application zone** (optional when managed DNS is enabled), for
  example `apps.example.com`, supplies hostnames for deployed services. CoreDNS
  starts with a bootstrap SOA/NS zone and in-zone `ns1`/`ns2` A records. The
  first owner organization adopts that zone after signup; you must still
  delegate it at the parent DNS provider.
- The **administrator email** is the Let's Encrypt contact and the only address
  that may create the first owner account (`NEARZERO_REGISTRATION_MODE=bootstrap`).

The installer stores only `NEARZERO_INSTALL_SETUP_TOKEN_HASH`; the plaintext
token is shown once in the install output. Noninteractive installs may still
supply `NEARZERO_ADMIN_EMAIL`, `NEARZERO_MANAGEMENT_HOSTNAME`, and
`NEARZERO_MANAGED_DNS_ZONE` to skip the wizard.

Raw management ports 3000 and 4321 bind to `127.0.0.1` by default. Public
management traffic enters through Traefik on TCP 80/443. Operators using a
separate private network or VPN may explicitly set
`NEARZERO_MANAGEMENT_BIND_ADDRESS=0.0.0.0`, but must keep both raw HTTP ports
blocked at the public perimeter. If no management hostname is configured, the
generated console, auth, Git callback, and public backend origins all use
`http://127.0.0.1:4321`, matching the documented SSH tunnel. Explicit split URL
overrides are preserved.

For an unattended first install, provide the same values explicitly. Run the
script as your current sudo-capable user so the environment reaches the script;
it invokes `sudo` only for privileged operations:

```bash
NEARZERO_NONINTERACTIVE=true \
NEARZERO_ADMIN_EMAIL=owner@example.com \
NEARZERO_MANAGEMENT_HOSTNAME=nearzero.example.com \
NEARZERO_MANAGED_DNS_ZONE=apps.example.com \
bash install.sh
```

`NEARZERO_PUBLIC_IP` can be omitted when automatic detection is correct. When
set for a public management hostname or managed zone, it must be publicly
routable; private, shared, loopback, link-local, documentation, benchmark,
multicast, and reserved ranges are rejected. Set
`NEARZERO_MANAGED_DNS_SOA_EMAIL` as well only when the DNS contact differs from
the owner email. These values are normalized and stored in
`/opt/nearzero/.env`. A normal rerun does not prompt or change them. To
change the management hostname or managed application zone, use a documented
migration rather than rerunning the installer with a different value; unsafe
renames are rejected. The managed application zone is not
`NEARZERO_PLATFORM_DOMAIN`: the latter is an advanced external-wildcard/shared-
edge mode and does not create authoritative DNS records.

To use managed services with the verified installer without putting credentials
in shell history or command arguments, read them without terminal echo and run
the installer as your current user; it invokes `sudo` only for privileged steps:

```bash
IFS= read -r -s -p "Database URL: " DATABASE_URL; printf '\n'
IFS= read -r -s -p "Redis URL: " REDIS_URL; printf '\n'
export NEARZERO_DATA_MODE=external DATABASE_URL REDIS_URL
bash install.sh
unset NEARZERO_DATA_MODE DATABASE_URL REDIS_URL
```

The installer persists `NEARZERO_DATA_MODE=local|external`, so an ordinary
rerun preserves the selected mode and external URLs. Supply both URLs together;
partial input is rejected. Changing modes is deliberately explicit: use the
command above to switch from local to external, or first unset both URL
variables and run `NEARZERO_DATA_MODE=local bash install.sh` to return to the
bundled Postgres and Redis services.

A plain rerun also preserves the installed Postgres user/database, published
ports, metrics settings, startup timeout, and the configured Nearzero,
monitoring, schedule, and CoreDNS image references unless that exact variable is
supplied as an override. Additional single-line `KEY=value` assignments in
`/opt/nearzero/.env` (for example, model-provider integration credentials) are
carried forward without being evaluated or printed. Fix malformed or duplicate
assignments before rerunning; the installer fails closed instead of guessing.

For installer-managed Postgres, `sudo nearzero backup-db /path/to/dump.sql`
uses the stored database identity and publishes the dump atomically with mode
`0600`. A failed dump leaves any previous complete destination untouched.

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
