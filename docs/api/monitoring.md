# Monitoring and alerts (M10)

CPU, memory, disk and uptime of every server, as charts and cards, and alerts when CPU or memory stays above a threshold. Implements spec 14 (all), 18.2 (monitoring on About Nearzero), 22.2 (the host's metrics are for instance administrators), 24 G7 (constant-time token checks: the runner's credential, [runner-protocol.md](../runner-protocol.md)), P2 (thresholds in the console, with a test) and P3 (the same charts for every server; network isn't collected).

## Collection (spec 14.1)

Each server's runner is its monitoring service (decision D1): it samples every 5 seconds (CPU, memory used and total, root filesystem used, total and available, uptime) and reports over its authenticated link; samples taken while the link is down are kept for an hour and sent together. The control plane stores them in `server_metric` for 2 days ([servers.md](servers.md), `GET /servers/:id/metrics?points=50|200|500|all`). Nothing listens on the server.

## Alerts (spec 14.3)

| Endpoint | Needs | Request | Response |
| --- | --- | --- | --- |
| `GET /servers/:id/alerts` | Server access (host: instance administrator) | | `{ alerts: { target, cpuThreshold, memoryThreshold, canEdit, channels } }` |
| `PUT /servers/:id/alerts` | Manage rights on the server (host: instance administrator) | `{ cpuThreshold: number \| null, memoryThreshold: number \| null }` | `{ alerts, message: "Alert settings saved" }`; audited |
| `POST /servers/:id/alerts/test` | same | | `{ channels, message: "Test alert sent to 2 channels." }` or `{ channels: 0, message: "No notification channel subscribes to Server alerts yet. Add one in Settings → Channels." }` |

- A threshold is a whole percentage from 1 to 100; null (blank) is off, the default. Memory is used ÷ total.
- **The rule** (`stepAlert` in `packages/shared/src/monitoring-rules.ts`): an alert fires when the value is above the threshold for 3 consecutive samples; then not again for 30 minutes unless the value drops to or below the threshold and rises again (which needs 3 samples above it once more). A 30-second load sends exactly one alert.
- Every metrics message goes through `evaluateAlerts` (the runner hub's `onMetrics` hook), one message at a time per server, with the state in `server_alert_state` (migration 0502). Samples older than 5 minutes when they arrive (a reconnecting runner's backlog) are stored but never fire. Saving thresholds starts the count again.
- A firing alert writes the **Server alert** event (`server.alert`, [notifications.md](notifications.md)) for the server's workspace (the host's go to the first workspace): `{ server: { id, name }, metric: "cpu" | "memory", value, threshold, at, test }`. The test alert is the same event with `test: true`.

## The console (spec 14.2)

`src/components/monitoring/MonitoringPanel.astro` (driven by `src/client/monitoring.ts`) shows Uptime, CPU usage, RAM usage (used / total GB), Storage usage, a System information block, "CPU history" and "RAM history" charts with a crosshair, the data points (50, 200, 500, All) and refresh (5, 10, 20, 30 seconds; none with All) controls, "Error fetching metrics" with the platform's reason under it when a fetch fails, and, once a server's runner has been gone for over a minute, "<server> isn't reporting. The last sample was taken <time>." with dashes instead of its old figures (30c R3-33); Storage usage is used / (used + available) of the server's own root filesystem, rounded up as df does (30c R3-34), and the alert fields with "Send a test alert" for people who may change them. It stops refreshing when it leaves the screen.

- **About Nearzero** mounts it for the host, for instance administrators: "Track host CPU, RAM, and storage usage for this Nearzero install."
- **Server details** mounts it inside the dialog's Monitoring section; `client/server-setup.ts` points it at the server it opens with the `nz:monitoring-target` event, and closing the dialog stops it.

## Code map

`apps/control/src/monitoring/`: `tables.ts`, `alerts.ts`, `routes.ts` (with the per-server queue `alertsOnMetrics`). Migration 0502. The hook in `runners/hub.ts` (`onMetrics`) and `runners/wiring.ts`. Tests: `packages/shared/test/monitoring.test.ts` (the hysteresis), `apps/control/test/notifications.test.ts` (one alert to a webhook, the test alert, rights), `e2e/m10/m10.e2e.ts` (real samples and a real CPU load).
