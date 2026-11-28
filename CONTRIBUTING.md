# Contributing to Nearzero

Nearzero 1.0 is built clean-room from the product specification in [`spec/`](spec/00-index.md). Read [`spec/28-clean-room.md`](spec/28-clean-room.md) before your first change; this page summarizes it and explains how to work in the repository.

## Clean-room rules

- **Work from `spec/` only.** It describes what Nearzero does; it never shows how another codebase did it. If the spec is unclear, make a sensible choice, note it under "Spec questions" in your pull request, and carry on. The spec author answers by editing `spec/`.
- **Never look at other implementations.** Don't open, search or read the 0.1.x codebase, its history or notes, or the source of other self-hosted deployment platforms. Official documentation of the libraries we use (Bun, Hono, Kysely, Astro, Tailwind, zod, Biome and so on) is fine.
- **Name things fresh**, from the spec's own concepts: workspace, project, environment, service, server, hostname, deployment, task.
- **Third-party code only as declared dependencies** with permissive licenses (MIT, Apache-2.0, BSD, ISC, 0BSD, or MPL-2.0 used unmodified). No copied snippets, no vendored folders without their license, nothing longer than a few lines from answers or blog posts.
- **User-visible strings come from the spec or are new.** Every error says what went wrong and what to do next (spec 01, principle 4).
- **Don't edit `spec/`** unless you are the spec author.

## Commits

- **Sign off every commit** under the [Developer Certificate of Origin](https://developercertificate.org/): `git commit --signoff` adds `Signed-off-by: Your Name <you@example.com>`. CI refuses pull requests with unsigned commits.
- **No AI tool attribution.** Commit messages, pull requests and code carry no `Co-authored-by`, "Generated with" or similar trailers naming an AI tool. CI checks this too.
- **Say which spec sections a commit implements**, for example `Implements spec 23.3 (migrations run at start)`.
- Write messages for people: what changed and why, in plain words.

## Working locally

You need [Bun](https://bun.com) (the version in `package.json` under `packageManager`) and Docker.

```sh
bun install
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL on 127.0.0.1:55440
bun run dev                                      # control plane on :4100, console on :4400
```

| Command | What it does |
| --- | --- |
| `bun run dev` | Starts the control plane and the console against the development database |
| `bun run lint` | Biome lint and format check (CI fails on any finding) |
| `bun run format` | Applies Biome's formatting and safe fixes |
| `bun run typecheck` | TypeScript in every workspace, `astro check` for the console |
| `bun test` | Unit tests; the database tests use throwaway databases on the development PostgreSQL |
| `bun run test:e2e` | Builds the control plane and console, starts them in production mode and checks them over HTTP |
| `bun run build` | Builds the console, the control plane and the runner binaries (linux x64 and arm64) |

Database tests read `NEARZERO_TEST_DATABASE_URL` when it is set, and otherwise use the development database. They create and drop their own databases and never touch your data.

## Rules that apply to every change

From [`spec/26-build-plan.md`](spec/26-build-plan.md) 26.2:

- Every page works in all three themes and at phone width from the start.
- Every endpoint has permission tests: allowed, refused for a member without the capability, and refused for another workspace.
- Long work (builds, deploys, setup, backups, restores, task runs) runs as a background job with a log; no request waits for it.
- Database changes are new numbered files in `apps/control/migrations`. A file that has been applied is never edited.
- Secrets never appear in logs, URLs, error messages or responses.
- Tests never touch your own Docker containers, router or ports.

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for how the pieces fit together.
