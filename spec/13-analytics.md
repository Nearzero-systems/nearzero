# 13. Analytics (request logs)

Analytics shows the requests that the Nearzero host's router handled, for every workspace on the install. It is therefore for **instance administrators only**, and the sidebar item shows only for them (today it shows for others too and the page then says they can't see it).

Scope in 1.0: the Nearzero host's router. Requests to apps on other servers are not included; the page says so ("Requests to apps on other servers are not counted yet."). Decision D1's runner makes per-server logs possible later.

## 13.1 Recording

- **On by default**. Each request is written as one structured line, without buffering, so quiet installs still show data.
- Installs that had it off by default get it turned on once at upgrade; an administrator who later turns it off keeps it off.
- **Settings** popover:
  - "Log cleanup schedule": a cron (default daily at midnight); each run keeps the newest 10,000 requests.
  - "Turn off request logging" / "Turn on request logging", with confirm: "The router restarts to apply this, so sites can be unreachable for a few seconds." Turning it off adds "Requests already recorded stay until the next cleanup." (31c G3-16). The restart happens in the background.
  - "Delete all request logs", with confirm: "Every request recorded so far is deleted and can't be brought back." followed by "Request logging stays on, so new requests show up again right away." while logging is on, or "Request logging stays off." while it is off (31c G3-16). Toast "Deleted every recorded request". Recorded in the audit trail.
- Reading uses at most the last 32 MB of the log.

## 13.2 Page

- Header state: "Recording requests" or "Request logging is off" (with "Turn on").
- Filters: ranges 24 hours (default), 3 days, 7 days, 30 days, or custom From–To; "Filter by host or path…"; status chips 2xx, 3xx, 4xx, 5xx (multi-select); "Clear filters".
- **Stats**: Requests; Errors (count, percentage, "N 4xx · N 5xx"); Median response; 95th percentile.
- **Chart**: "Requests per hour" (or per N hours, or per day; at most 200 buckets), lines for Requests and Errors, zero-filled where there was no traffic. A crosshair tooltip shows the values under the pointer or under the arrow keys.
- **Busiest hosts**: top 5; clicking one filters by it.
- **Table**: Time (sortable), Method, Request (host and path), Status, Duration, Client; 25 per page ("1–25 of N"). A row opens a drawer: Request, Response, Client, Routing, "All fields (JSON)", "Copy JSON", "Download JSON".
- One page scroll: the table is not trapped in an inner scroll area.

**Acceptance**
- After 100 requests to a deployed app, the page shows 100 requests, the right status mix, and the app's host in Busiest hosts.
- Turning logging off and upgrading keeps it off.
