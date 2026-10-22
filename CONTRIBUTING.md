# Contributing

Hey, thanks for your interest in contributing to Nearzero! We appreciate your help and taking your time to contribute.

Before you start, please first discuss the feature/bug you want to add with the owners and community via github issues.

We have a few guidelines to follow when contributing to this project:

- [Commit Convention](#commit-convention)
- [Setup](#setup)
- [Development](#development)
- [Build](#build)
- [Pull Request](#pull-request)
- [Important Considerations](#important-considerations-for-pull-requests)

## Commit Convention

Before you create a Pull Request, please make sure your commit message follows the [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) specification.

### Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

#### Type

Must be one of the following:

- **feat**: A new feature
- **fix**: A bug fix
- **docs**: Documentation only changes
- **style**: Changes that do not affect the meaning of the code (white-space, formatting, missing semi-colons, etc)
- **refactor**: A code change that neither fixes a bug nor adds a feature
- **perf**: A code change that improves performance
- **test**: Adding missing tests or correcting existing tests
- **build**: Changes that affect the build system or external dependencies (example scopes: gulp, broccoli, npm)
- **ci**: Changes to our CI configuration files and scripts (example scopes: Travis, Circle, BrowserStack, SauceLabs)
- **chore**: Other changes that don't modify `src` or `test` files
- **revert**: Reverts a previous commit

Example:

```
feat: add new feature
```

## Setup

Before you start, clone the repository and create your branch from `main`. Pull requests should target `main`.

We use Node v24.4.0 and recommend this specific version. If you have nvm installed, you can run `nvm install 24.4.0 && nvm use` in the root directory.

### Requirements

- [Bun](https://bun.sh) (see `packageManager` in `package.json`)
- [Docker](/GUIDES.md#docker) — Docker Desktop or the Docker daemon must be running

### First-time setup

From the repo root, run:

```bash
bun run setup
```

This installs dependencies, creates `apps/platform/.env` and `apps/console/.env`, starts local Docker infra (Postgres, Redis, Traefik), applies database migrations, and builds the server package.

Skip `bun install` if you already installed deps:

```bash
bun run setup -- --no-install
```

## Development

Start the full dev stack (Docker infra + platform API + Astro console):

```bash
bun run dev
```

- **Console:** http://localhost:4321
- **Platform API:** http://localhost:3000

If Docker infra is not running, `dev` will run setup automatically.

Legacy script names still work: `bun run nearzero:setup`, `bun run nearzero:dev`.

> [!NOTE]
> This project uses Biome. If your editor is configured to use another formatter such as Prettier, it's recommended to either change it to use Biome or turn it off.

## Build

```bash
bun run platform:build
bun run console:build
```

### Community edition checks

Before opening a PR against the public Community repo, run:

```bash
bun run verify:edition-split
bun run typecheck
bun run platform:build
bun run console:build
bun run test
```

The open-source tree must not import `@nearzero/cloud` or ship proprietary routers (Stripe, SSO admin, audit logs, etc.). See `scripts/verify-edition-split.ts`.

### Auth (local dev)

Community sign-in is email and password only. No Resend or other third-party auth email provider is required.

## Docker

Build the production image (platform API and console) from the repository root:

```bash
docker build -t nearzero:local .
```

Release images are built and published by the `docker-images.yml` workflow to `ghcr.io/nearzero-systems`.

If you want to test the webhooks on development mode using localtunnel, make sure to install [`localtunnel`](https://localtunnel.app/)

```bash
bunx localtunnel --port 3000
```

If you run into permission issues of docker run the following command

```bash
sudo chown -R USERNAME nearzero or sudo chown -R $(whoami) ~/.docker
```

## Application deploy

If you deploy applications on a Linux amd64/arm64 machine with Nixpacks,
Railpack, or Buildpacks, install the repository-pinned binaries after their
SHA-256 digests have been verified:

```bash
sudo sh scripts/install-verified-build-tools.sh nixpacks railpack buildpacks
```

## Pull Request

- `main` is the source of truth for active development and releases.
- Create a new branch for each feature or bug fix.
- Make sure to add tests for your changes.
- Make sure to update the documentation for any user-facing change. See [docs.nearzero.dev](https://docs.nearzero.dev).
- When creating a pull request, please provide a clear and concise description of the changes made.
- If you include a video or screenshot, would be awesome so we can see the changes in action.
- If your pull request fixes an open issue, please reference the issue in the pull request description.
- Once your pull request is merged, you will be automatically added as a contributor to the project.

### Important Considerations for Pull Requests

- **Testing is Mandatory:** All Pull Requests **must be tested** by the PR author before submission. You must verify that your changes work as expected in a local development environment (see [Setup](#setup)). **Pull Requests that have not been tested by their creator will be rejected.** This policy keeps the PR history clean and values contributors who submit verified, working code. Untested PRs are often recognizable by disproportionately large or scattered changes for simple tasks—please test first.
- **Focus and Scope:** Each Pull Request should ideally address a single, well-defined problem or introduce one new feature. This greatly facilitates review and reduces the chances of introducing unintended side effects.
- **Avoid Unfocused Changes:** Please avoid submitting Pull Requests that contain only minor changes such as whitespace adjustments, IDE-generated formatting, or removal of unused variables, unless these are part of a larger, clearly defined refactor or a dedicated "cleanup" Pull Request that addresses a specific `good first issue` or maintenance task.
- **Issue Association:** For any significant change, it's highly recommended to open an issue first to discuss the proposed solution with the community and maintainers. This ensures alignment and avoids duplicated effort. If your PR resolves an existing issue, please link it in the description (e.g., `Fixes #123`, `Closes #456`).
- **Large Features:** Pull Requests that introduce very large or broad features **will not be accepted** unless the idea is first outlined and discussed in a GitHub issue. Large features should be designed together with the Nearzero team so the project stays coherent and moves in the same direction. Open an issue to propose and align on the design before implementing.

Thank you for your contribution!

## Templates

Templates are served from [templates.nearzero.dev](https://templates.nearzero.dev). To propose a new template, [open an issue](https://github.com/Nearzero-systems/nearzero/issues) with the Compose file and the variables it needs.

### Recommendations

- Use the same name of the folder as the id of the template.
- The logo should be in the public folder.
- If you want to show a domain in the UI, please add the `_HOST` suffix at the end of the variable name.
- Test first on a vps or a server to make sure the template works.

## Docs & Website

To report a problem with the Nearzero docs or website, [open an issue](https://github.com/Nearzero-systems/nearzero/issues) or email [contact@nearzero.dev](mailto:contact@nearzero.dev).
