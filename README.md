# Nearzero

Nearzero 1.0 is a self-hosted platform for running apps, Compose stacks and databases on Linux servers you own, with a built-in operations Agent. You install it on one server with a single command; it deploys onto that server and onto any other servers you add over SSH, gives every app an HTTPS address, backs up data, runs scheduled tasks, records request analytics and controls who can do what. Its Agent works in a chat: it sets up servers, imports and deploys Git repositories, asks for secrets in forms the model never sees, reads logs and fixes failed deploys, all under workspace policies that keep production changes off until an administrator allows them.

## Install

On a Linux server (amd64 or arm64):

```sh
curl -fsSL https://cdn.nearzero.dev/install.sh | sudo bash
```

The installer asks every question first (the admin account, then a domain when the server has a routable public IPv4 address), installs Docker when it is missing, starts Nearzero and prints the address to open. Running it again upgrades and keeps your settings. On Alpine, install `bash`, `curl` and `sudo` first.

To install a pinned version and check it before running it:

```sh
curl -fsSLO https://cdn.nearzero.dev/v1.0.0/install.sh
curl -fsSLO https://cdn.nearzero.dev/v1.0.0/install.sh.sha256
sha256sum -c install.sh.sha256 && sudo bash install.sh
```

To remove Nearzero, back up with `sudo nearzero backup-db`, then run `curl -fsSL https://cdn.nearzero.dev/uninstall.sh | sudo bash`.

The control-plane image is `ghcr.io/nearzero-systems/nearzero`. [`installer/README.md`](installer/README.md) lists every install setting, what Nearzero creates on a server and how releases are made.

## Documentation

| Where | What it covers |
| --- | --- |
| [`spec/00-index.md`](spec/00-index.md) | The product specification: what Nearzero does, with its rules, limits, error cases and acceptance criteria |
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | How the console, the control plane, the runner and the database fit together |
| [`docs/`](docs/) | The HTTP API for each area in [`docs/api/`](docs/api/), and the runner protocol in [`docs/runner-protocol.md`](docs/runner-protocol.md) |
| [`installer/README.md`](installer/README.md) | The installer, its settings, the `nearzero` server command and the release files |

## Repository layout

| Folder | What lives there |
| --- | --- |
| `apps/control` | The control plane (Hono on Bun): HTTP API, database migrations, background jobs and the Agent |
| `apps/console` | The web console (Astro) |
| `runner` | The runner every server runs, compiled to one binary per architecture |
| `packages/shared` | The product version and the schemas and rules the other parts share |
| `installer` | `install.sh`, `uninstall.sh` and the `nearzero` server command |
| `container` | The image's supervisor, health check and `nearzero-control` command |
| `e2e` | End-to-end suites |

## Develop and test

You need [Bun](https://bun.com) (the version in `package.json` under `packageManager`) and Docker.

```sh
bun install
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL on 127.0.0.1:55440
bun run dev                                      # control plane on :4100, console on :4400
```

| Command | What it does |
| --- | --- |
| `bun run lint` | Biome lint and format check |
| `bun run format` | Applies Biome's formatting and safe fixes |
| `bun run typecheck` | TypeScript in every workspace, `astro check` for the console |
| `bun test` | Unit tests; the database tests create and drop their own databases on the development PostgreSQL |
| `bun run test:e2e` | Builds the control plane and console, starts them in production mode and checks them over HTTP |
| `bun run build` | Builds the console, the control plane and the runner binaries |

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before your first change. Every commit is signed off under the Developer Certificate of Origin (`git commit --signoff`).

## License

Copyright 2026 Nearzero Systems. Licensed under the Apache License 2.0; see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).
