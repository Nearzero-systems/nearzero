# Nearzero Schedules

Optional worker that runs Nearzero's scheduled jobs (database and volume
backups, Docker cleanup, and scheduled commands) for **remote servers** using
BullMQ on Redis. Jobs for the local Nearzero host always run inside the
platform process.

It is enabled with the `schedules` Compose profile; the platform reaches it at
`JOBS_URL` and authenticates with `API_KEY`.

## Development

```bash
bun install
API_KEY=dev-key REDIS_URL=redis://localhost:6379 bun run dev
```

The dev server listens on `http://localhost:4001` (`PORT`).

Part of [Nearzero](https://github.com/Nearzero-systems/nearzero), by Nearzero Systems.
