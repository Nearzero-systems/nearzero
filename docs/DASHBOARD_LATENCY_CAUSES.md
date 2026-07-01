# Dashboard Latency Causes

Started: 2026-06-20

## Current Observations

- Local Postgres simple queries are not the root cause:
  - `SELECT 1` average: about 40-50 ms
  - first query including connection: about 277 ms
- Remote Redis was a local multiplier before switching:
  - remote Redis `PING` average: about 262 ms
  - remote Redis `SET` + `GET` average: about 554 ms
  - BullMQ `deployments.getJobs()` with only 3 jobs: about 2361 ms
- Local Redis after switching:
  - local Redis `PING` average: about 0.54 ms
- After switching Redis local, the Agent route is still not instant:
  - `/BvnYoAcw_3/dashboard/agent` rewrites: about 3.1-5.4 seconds
  - `/api/console/page-data` for `dashboard:agent`: about 3.6 seconds
  - `/api/agent/threads`: about 631 ms
- The same pattern affects multiple sidebar options after Redis is local:
  - `/dashboard/projects`: about 5.3-5.5 seconds
  - `/dashboard/analytics`: about 5.7 seconds
  - `/dashboard/deployments`: about 3.0-6.0 seconds
  - `/dashboard/agent`: about 3.1-5.4 seconds
- This means the slowdown is not isolated to Agent. It is a shared dashboard navigation/render path problem.

## Root Cause

The dashboard behaves like a multi-page Astro app during navigation.

When the user clicks a sidebar option, the current dashboard component is not simply swapped inside the already-loaded shell. Instead:

1. The browser/Astro navigates to a new dashboard URL.
2. Astro prepares a new page document through `<ViewTransitions />`.
3. The new page renders the dashboard shell again.
4. The shell renders `DashboardAsyncRegion`.
5. `DashboardAsyncRegion` then calls `/api/console/page-data`.
6. `/api/console/page-data` internally fetches the target dashboard route again with the fragment header.
7. The fragment route renders the actual page component.
8. The HTML is injected and scripts are rerun.

So one sidebar click can cause:

- a full Astro route preparation
- a dashboard shell render
- shared shell TRPC calls
- a second internal Astro route render
- page-specific TRPC calls
- script rebinds/hydration

This is why all options inside the Astro dashboard feel the same. The root issue is not a single slow component; it is the navigation architecture.

The dashboard needs to behave like a persistent app shell:

> Sidebar click should keep the shell mounted and swap only the page/content component.

The current architecture reloads/re-prepares too much of Astro for each dashboard click.

## Confirmed Request Path

Clicking a sidebar route such as Agent, Projects, Analytics, Deployments, Servers, Domains, Settings, or an item inside a sidebar group does not only load that page.

1. The page first renders the dashboard shell.
2. `DashboardAsyncRegion` then posts to `/api/console/page-data`.
3. `/api/console/page-data` internally fetches the dashboard fragment route.
4. The fragment route renders the actual dashboard page HTML.
5. Client-side scripts rerun after the fragment HTML is inserted.
6. Agent hydrates its React island with `client:load`.
7. Agent then fetches thread/session data from `/api/agent/threads`.

Most dashboard pages under `apps/console/src/pages/dashboard/**` use the same pattern:

- they render `<Dashboard>`
- they render `<DashboardAsyncRegion>`
- the region calls `/api/console/page-data`
- `page-data` internally fetches the fragment route

So the "More options" / grouped sidebar entries feel slow for the same reason as top-level sidebar entries.

## Ranked Causes

### 1. Dashboard navigation reloads the shell instead of swapping content

Sidebar links are regular anchors. With Astro View Transitions, navigation is smoother than a hard reload, but Astro still prepares the next page document and swaps DOM. The dashboard shell is rebuilt instead of being treated as a long-lived application shell.

This means component/page loading causes the whole dashboard Astro route to be prepared again.

Desired behavior:

- keep header, sidebar, mobile shell, account menu, org switcher, and toasts mounted
- intercept internal dashboard link clicks
- update the URL with `history.pushState`
- fetch only the target page fragment
- replace only the main content outlet
- update active nav/breadcrumb/title without rebuilding the shell

### 2. Dashboard shell data is loaded for every dashboard page

`Dashboard.astro` fetches shared chrome data before content:

- `user.get`
- `user.getPermissions`
- `organization.all`
- `whitelabeling.get`
- `user.getInvitations`
- `organization.active`
- sometimes `deployment.allCentralized`

Even when clicking Agent, the route still pays the shared shell cost.

This affects almost every sidebar option, because the sidebar links are regular dashboard hrefs and nearly every dashboard page wraps itself in the same `Dashboard` layout plus `DashboardAsyncRegion`.

### 3. Async page loading doubles the work

The browser asks `/api/console/page-data`, and that endpoint performs an internal `GET` back to the dashboard route to render the fragment. This adds overhead compared with directly rendering the content once.

The dev server logs show both the internal dashboard rewrite and the outer `/api/console/page-data` request. That makes a single click look like multiple server renders.

### 4. Agent route still performs server-side user lookup

`AgentDashboard.astro` calls `user.get` to compute:

- first name for greeting
- owner/admin ability for OpenRouter settings

That call happens in the fragment render, even though the dashboard shell already fetched user data.

### 5. Agent React island hydrates on load

`AgentHomeAsk` uses `client:load`, so the browser hydrates the full Agent workspace immediately. This includes a large interactive UI and then calls `/api/agent/threads`.

### 6. Deployment notification data can slow unrelated pages

The shell passes `deployments` into `NotificationsBell`. When `deployment.allCentralized` runs for global notifications, pages unrelated to deployments can still wait on deployment history.

### 7. Deployment history queries are heavy and mostly unbounded

`findAllDeploymentsCentralized()` gathers:

- application IDs in org
- compose IDs in org
- database deployments
- all matching deployment rows sorted by `createdAt`
- related application/compose/environment/project/server/rollback data

There are no obvious indexes in the deployment schema for:

- `createdAt`
- `applicationId`
- `composeId`
- `serverId`

This gets worse as deployment history grows.

### 8. Database deployment listing has N+1 behavior

`findDatabaseDeploymentsCentralized()` loads up to 300 rows, decodes metadata, and loops through project/runtime lookups. That can multiply DB round trips.

### 9. Queue reads can block deployments pages

`deployment.queueList` calls BullMQ:

- `myQueue.getJobs()`
- `job.getState()` for each job
- `resolveServicePath()` per job

With remote Redis this was very slow. Local Redis fixes most of this locally, but the architecture should still avoid putting queue reads in unrelated page load paths.

### 10. Logs can block on SSH

`deployment.readLogs` runs `tail -n 500` through `execAsyncRemote()` for remote deployments.

Remote log reads include:

- DB lookup
- permission checks
- SSH connection
- remote command execution

The SSH timeout is very high, so slow or unreachable remote servers can create very long waits.

## Most Likely Reasons Agent Still Took 5 Seconds Locally

- It still goes through `/api/console/page-data`.
- The page-data endpoint internally renders the Agent fragment.
- The fragment still calls backend TRPC for `user.get`.
- The dashboard shell still has shared dashboard overhead.
- React hydration for the Agent workspace happens immediately.
- `/api/agent/threads` adds another backend round trip after hydration.

## Why All Sidebar Options Feel Slow

- Most sidebar options share the same dashboard layout.
- Most pages are not directly rendered into the current shell; they are loaded through the async fragment system.
- The async fragment system does a server-side fetch back into Astro.
- Shared shell data is fetched repeatedly instead of being reused from the already-loaded shell.
- Some pages add their own heavy calls on top:
  - Deployments: `deployment.allCentralized`, `deployment.queueList`, and sometimes log reads.
  - Agent: `user.get`, React hydration, and `/api/agent/threads`.
  - Projects/Servers/Domains/Analytics: page-specific TRPC queries after the same shared shell path.

Opening a sidebar group with `<details>` should be instant because it is only DOM state. Clicking an actual item inside the group triggers the slow path.

## Fix Plan For A Lightning Fast Dashboard

Goal:

> Component/page loads must not reload the entire Astro dashboard shell.

### Phase 1: Make Dashboard Shell Persistent

Add a dashboard client router for internal dashboard links.

Behavior:

- Intercept clicks on internal `/dashboard/**` links.
- Prevent the default Astro document navigation for dashboard-to-dashboard transitions.
- Immediately show a lightweight content loading state in the existing main outlet.
- Call `/api/console/page-data` directly for the target route.
- Replace only the dashboard content region.
- Use `history.pushState()` / `popstate` for back and forward.
- Re-run only scripts inside the replaced content.
- Update active sidebar item, document title, and breadcrumb state.

Expected result:

- no full dashboard shell re-render
- no repeated header/sidebar/mobile shell render
- no repeated org/sidebar/toast/modal setup on every click
- one content request instead of document navigation plus content request

### Phase 2: Stop Fetching Shared Shell Data On Every Content Change

Cache or bootstrap shell data once per session/org:

- current user
- permissions
- organizations
- active organization
- whitelabeling
- invitations count

Refresh explicitly when something changes instead of every sidebar click.

Expected result:

- sidebar clicks no longer wait for shell TRPC calls
- more stable UI because the shell never disappears/rebuilds

### Phase 3: Remove Deployment Data From Global Shell

Do not load full `deployment.allCentralized` just to render the notification bell.

Replace with a small endpoint/query such as:

- recent deployment count
- latest 5 deployment notifications
- unread/error/running summary

Expected result:

- Agent, Projects, Settings, Domains, etc. stop paying deployments query cost.

### Phase 4: Make Page Fragments Direct And Cheap

`/api/console/page-data` currently fetches the Astro route internally. Better options:

- map route IDs directly to server-side fragment renderers
- or create dedicated lightweight fragment endpoints
- or move page data to JSON endpoints and render content client-side where appropriate

Expected result:

- no server-side self-fetch back into Astro
- fewer duplicated routing/layout checks

### Phase 5: Page-Specific Optimizations

After navigation is fixed, optimize individual heavy pages:

- Deployments: SQL pagination, indexes, bounded queue reads.
- Servers: avoid fetching deployment history for each server until needed.
- Agent: render a fast shell first, lazy-load sessions/threads.
- Analytics: defer expensive metrics until the visible panel needs them.
- Logs: never SSH during initial navigation; load logs only after the detail panel is open.

### Phase 6: Instrument Before And After

Add timing logs around:

- dashboard shell data fetch
- `/api/console/page-data`
- fragment render route ID
- every page-specific TRPC call
- client-side content swap duration
- hydration time for large islands

Target:

- dashboard sidebar click to visible content shell: under 200 ms
- normal page content loaded: under 500-800 ms locally
- heavy pages should progressively load details instead of blocking navigation

## Quick Wins Before The Full Router

- Remove `deployment.allCentralized` from `Dashboard.astro`.
- Pass shell user data into Agent so `AgentDashboard.astro` does not call `user.get` again.
- Add a short in-memory/session cache for permissions/org/whitelabeling during dev session.
- Disable `data-astro-prefetch` for heavy dashboard pages if it is competing with active navigation.
- Make loading states show instantly and progressively fill sections instead of blocking the whole content area.

## What Would Make It Faster

- Pass already-loaded shell user data into Agent instead of calling `user.get` again.
- Avoid fetching deployment notification data on pages where it is not needed.
- Cache dashboard shell data briefly per session/org.
- Make `/api/console/page-data` avoid a full internal page fetch where possible.
- Split Agent into lighter first paint plus lazy-loaded thread/history panels.
- Make `deployment.allCentralized` paginated and indexed.
- Keep Redis local/same-region as the platform API.
- Avoid SSH log reads during initial page render; load logs only on demand with short timeout.

## Measurements To Keep Tracking

- `/api/console/page-data` duration by `routeId`
- fragment route duration for the same `routeId`
- each server-side TRPC call duration inside `Dashboard.astro`
- `deployment.allCentralized` duration and row count
- `deployment.queueList` duration and Redis job count
- `deployment.readLogs` duration and target server ID
- Agent bundle/hydration time
- `/api/agent/threads` duration
