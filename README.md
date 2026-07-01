Nearzero is a self-hostable Platform as a Service (PaaS) for deploying and managing applications and databases.

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

```bash
curl -sSL https://nearzero.dev/install.sh | bash
```

By default this installs a single-node Community stack with local Postgres,
Redis, and host metrics. The installer expects the public Community images to be
available from `ghcr.io/nearzero-systems/*`.

To use managed services instead:

```bash
curl -sSL https://nearzero.dev/install.sh | \
  DATABASE_URL="postgresql://..." REDIS_URL="rediss://..." bash
```

### Local development

```bash
git clone https://github.com/Nearzero-systems/nearzero.git
cd nearzero
bun run setup   # first time: deps + Docker infra + migrations
bun run dev     # platform API (:3000) + console (:4321)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

Documentation: [docs.nearzero.dev](https://docs.nearzero.dev)

Console: [nearzero.dev](https://nearzero.dev)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
