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

The recommended path downloads a versioned installer, verifies its published
SHA-256 digest, and only then executes it:

```bash
version="REPLACE_WITH_PUBLISHED_RELEASE_VERSION"
base_url="https://nearzero.dev/releases/${version}"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output install.sh "${base_url}/install.sh"
curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 \
  --output install.sh.sha256 "${base_url}/install.sh.sha256"
sha256sum --check install.sh.sha256
sudo bash install.sh
rm -f install.sh install.sh.sha256
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

To use managed services with the verified installer without putting credentials
in shell history or command arguments, read them without terminal echo and run
the installer as your current user; it invokes `sudo` only for privileged steps:

```bash
IFS= read -r -s -p "Database URL: " DATABASE_URL; printf '\n'
IFS= read -r -s -p "Redis URL: " REDIS_URL; printf '\n'
export DATABASE_URL REDIS_URL
bash install.sh
unset DATABASE_URL REDIS_URL
```

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
