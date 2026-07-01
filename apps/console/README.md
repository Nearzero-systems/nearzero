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

## Environment

Copy `.env.example` from `apps/platform` to `apps/platform/.env`.

Set `BACKEND_URL=http://127.0.0.1:3000` in `apps/console/.env` (default).

Optional client env (see `src/lib/client-env.ts`):

- `PUBLIC_METRICS_URL` / `PUBLIC_METRICS_TOKEN` — monitoring charts
- `PUBLIC_STRIPE_PUBLISHABLE_KEY` — billing checkout

## Build

```bash
bun run platform:build
bun run console:build
```

## Regenerate dashboard pages

```bash
cd apps/console && bun scripts/generate-dashboard-pages.ts
```

## Architecture

Dashboard routes are pure Astro: server data via `createServerTrpcClient()` in `.astro` frontmatter, client mutations via `src/lib/client-api.ts` and `src/scripts/ui.ts`. See `MIGRATION.md` for the porting checklist.
