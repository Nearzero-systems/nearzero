# Astro migration guide

Migration complete — all dashboard routes render in Astro with no React islands.

Per-route checklist when porting a screen (reference for future work):

- [ ] Same HTML structure and Tailwind classes as source TSX
- [ ] Same tRPC procedures with same inputs/outputs
- [ ] Same permission gates and conditional rendering
- [ ] Same loading, error, and empty states (text + styling)
- [ ] Same navigation URLs
- [ ] Same toast messages on success/failure
- [ ] Same dialog/modal open-close behavior
- [ ] `bun run console:build` passes
- [ ] Manual smoke test of primary actions

## Pattern

1. Server-fetch in `.astro` frontmatter via `createServerTrpcClient(Astro.request)`
2. Render markup in `components/dashboard/<area>/*.astro`
3. Client mutations via `client-api.ts` + `scripts/ui.ts`
4. Delete ported TSX files when done

## Key files

| Purpose | Path |
|---------|------|
| Server tRPC (SSR) | `src/lib/server-api.ts` |
| Client tRPC | `src/lib/client-api.ts` |
| Toasts / dialogs | `src/scripts/ui.ts` |
| Settings bootstrap | `src/components/dashboard/settings/settingsDashboardBootstrap.ts` |
| Settings gates | `src/components/dashboard/settings/settingsDashboardGates.ts` |
