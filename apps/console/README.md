# Nearzero Console (Astro)

Astro SSR frontend — Nearzero console UI on port **4321**.

Backend API runs in **`@nearzero/platform`** on port **3000** (no Next.js).

## Development

```bash
# From repo root — starts platform + console
bun run dev

# Or separately:
bun run platform:dev   # :3000 API
bun run console:dev    # :4321 UI
```

Open http://localhost:4321 — auth and tRPC go through the Astro BFF to the platform server.

Sign-in uses **email and password** (no third-party auth email provider required).

## Environment

Copy `.env.example` from `apps/platform` to `apps/platform/.env`.

Set `BACKEND_URL=http://127.0.0.1:3000` in `apps/console/.env` (default).

Monitoring credentials belong only on the platform server. Never add metrics tokens,
API keys, or other credentials to `PUBLIC_*` variables: Astro/Vite embeds those
values in browser assets.

For Git provider OAuth, set `PUBLIC_GIT_PROVIDER_BASE_URL` to your console’s public HTTPS URL (see `apps/console/.env.example`).

## Build

```bash
bun run platform:build
bun run console:build
```

Verify the Community edition boundary before publishing:

```bash
bun run verify:edition-split
bun run typecheck
```

## Regenerate dashboard pages

```bash
cd apps/console && bun scripts/generate-dashboard-pages.ts
```

## Architecture

Dashboard routes are pure Astro: server data via `createServerTrpcClient()` in `.astro` frontmatter, client mutations via `src/lib/client-api.ts` and `src/scripts/ui.ts`. See `MIGRATION.md` for the porting checklist.
