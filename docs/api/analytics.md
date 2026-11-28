# Analytics (M10)

The requests the Nearzero host's router handled, for every workspace on the install. Implements spec 13 (all), 22.2 ("See Analytics" is for instance administrators), 24 G8 (the sidebar item is hidden for everyone else), 23.9 (nothing leaves the install).

Scope in 1.0: the host's router. Requests to apps on other servers aren't counted ("Requests to apps on other servers are not counted yet."); other routers don't log requests.

## Recording (spec 13.1)

- The host's router (Traefik) writes one JSON line per request, unbuffered (`--accesslog.format=json`, `--accesslog.bufferingsize=0`, header fields dropped except `User-Agent` and `Referer`) to `access-log/access.log` in the router folder (`/opt/nearzero/router/access-log/` on the host), mounted into the router at `/var/log/nearzero-router`.
- **On by default.** The setting is one row (`analytics_setting`, migration 0501), which the migration creates turned on: installs that had logging off are turned on once at upgrade, and an administrator who later turns it off keeps it off (the migration never runs again). When the host's runner connects it gets the setting (`access-log.configure`), saves it in its state folder, and recreates the router only when its fingerprint changed (the old router stays until the new one runs).
- Turning it on or off answers at once ("Request logging is off. The router restarts in the background."); the console's confirm says "The router restarts to apply this, so sites can be unreachable for a few seconds."
- **Cleanup schedule**: a cron in the host's time zone, default daily at midnight (`0 0 * * *`); each run (`analytics.cleanup`) keeps the newest 10,000 requests (`access-log.trim`).
- **Delete all request logs** empties the file (`access-log.clear`) and is audited (`analytics.request-logs-deleted`).
- **Reading**: the control plane reads the file through the runner in whole-line pieces of at most 2 MB (`access-log.read`), remembering where it stopped, so a page load reads only what is new. A first read starts at most 32 MB before the end; entries older than the last 32 MB are dropped. A replaced or shortened file is read again from its end.

## Endpoints (instance administrators; others get 403 "Only Nearzero administrators can see Analytics.")

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /analytics?range=24h\|3d\|7d\|30d\|custom&from=&to=&q=&status=2xx,4xx&page=&sort=time-desc\|time-asc` | | below |
| `GET /analytics/settings` | | `{ settings }` |
| `PATCH /analytics/settings` | `{ enabled?, cleanupCron? }` | `{ settings, message }` |
| `POST /analytics/delete-all` | | `{ message: "Deleted every recorded request" }`; 503 when the host's runner is away |

```ts
{
  recording: { enabled, message: "Recording requests" | "Request logging is off", runnerOnline },
  settings: { enabled, cleanupCron, cleanupText, timeZone, nextCleanupAt, lastCleanupAt, lastCleanupError, appliedAt, applyError },
  window: { range, from, to },
  stats: { requests, errors, errorRate /* 0–1 */, clientErrors /* 4xx */, serverErrors /* 5xx */, medianMs, p95Ms },
  chart: { bucketMs, label /* "Requests per hour" | "Requests per 4 hours" | "Requests per day" … */, buckets: { start, requests, errors }[] },
  hosts: { host, requests }[],            // top 5
  table: { entries: { id, at, method, host, path, status, durationMs, client, fields }[], page, pages, pageSize: 25, total, rangeText /* "1–25 of N" */, sort },
  source: { sizeBytes, limited /* the 32 MB limit cut older requests */, error },
  note: "Requests to apps on other servers are not counted yet.",
}
```

- **Filters**: the range (custom `from`/`to` are ISO times), `q` matches host and path together ("app.example.com/api"), `status` is any of 2xx, 3xx, 4xx, 5xx. Every figure on the page follows the filters.
- **Stats**: errors are 4xx plus 5xx; the median and the 95th percentile interpolate between the nearest ranks (the median of 1, 2, 3, 4 ms is 2.5 ms).
- **Chart**: the smallest bucket of 1, 2, 3, 4, 6, 8, 12 hours, 1, 2, 3, 7, 14 or 30 days that gives at most 200 buckets, aligned in UTC, zero-filled.
- The pure rules (parsing Traefik's lines, the quantiles, the buckets, the summary) are `packages/shared/src/analytics-rules.ts`.

## Runner commands (`packages/shared/src/runner-access-log.ts`)

| Kind | Params | Answer |
| --- | --- | --- |
| `access-log.configure` | `{ enabled }` | `{ enabled, changed }`; the router is recreated in the background |
| `access-log.status` | | `{ enabled, applied, exists, sizeBytes }` |
| `access-log.read` | `{ fromOffset: number \| null, maxBytes ≤ 2 MB, tailBytes ≤ 32 MB }` | `{ exists, size, fileId, start, end, data (base64, whole lines) }` |
| `access-log.trim` | `{ keepLines }` (10,000) | `{ kept, removedBytes }` |
| `access-log.clear` | | `{ cleared: true }` |

## Code map

`apps/control/src/analytics/`: `tables.ts`, `reader.ts` (the incremental reader), `area.ts` (page, settings, delete all, cleanup job, host-runner hook), `routes.ts`. Migration 0501. `runner/src/access-log/`: `runtime.ts`, `file.ts`, `handlers.ts`; the router's flags in `runner/src/router/router.ts`. Console: `src/pages/[workspace]/dashboard/analytics/index.astro`, `src/components/analytics/AnalyticsDialogs.astro`, `src/client/analytics.ts`, `src/lib/line-chart.ts`, `src/client/charts.ts` (the crosshair, pointer and arrow keys). Tests: `packages/shared/test/analytics.test.ts`, `runner/test/tasks.test.ts` (the file), `apps/console/e2e/m10.e2e.ts`, `e2e/m10/m10.e2e.ts` (100 real requests through Traefik).
