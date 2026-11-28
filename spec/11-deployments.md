# 11. Deployments

A **deployment** is one run of building and starting a service (app, Compose or database), with its own log. Backups and task runs also produce run records with logs, shown where they belong (database Backups tab, Tasks runs panel), not on this page.

## 11.1 List

Sidebar → **Deployments** (people who can see deployments; members see only their services).

- Search "Search by service, project, environment, server..." (applies after a short pause).
- Filters: status (All statuses, Queued, Building, Active, Previous version, Not running, Failed, Cancelled, Removed); type (All types, Application, Compose, Database); page size 10, 25, 50 (default) or 100; Previous / Next with "N total". On phones, search on its own row and the filters in equal widths on the next.
- Columns: **Service** (with the commit subject or title, the short commit hash, and the trigger: push, webhook, manual, Agent), Type, Project, Environment, Server ("Nearzero host" for the host), Deployed (time), Duration ("… so far" while building), Status.
- Status words: Queued (waiting), Building (running), Active (the version serving now), Previous version (an older successful deploy of the same service), Failed (today shown as "Error"; 1.0 says "Failed" everywhere, matching the bell), Cancelled, Not running, Removed (the service was deleted).
- Running and queued rows update live (today the list does not refresh).
- Empty: "No deployments found / Deployment history and queued deployments appear here."

## 11.2 Detail

Opening a row shows (at its own address, so it can be shared):
- Back arrow and the service name; **Open service**; **Redeploy** (apps and Compose, not while building: Redeploying → "Redeployment queued" → "Waiting for logs" → opens the new deployment); **Cancel** (new: for Queued and Building deployments, with confirm; the running version keeps serving).
- Fields: Status, Deployment, URL ("Now serving a newer deployment" when replaced), Error, Type, Source provider, Repository, Branch, Path, Commit, Project, Environment, Server, Deployed, Duration.
- **Build logs**: collapsible, last 500 lines with "Load all", "Find in logs", Copy ("Logs copied"), and "Failure detected on line N: …" pointing at the first error line. Streams while running.
- "Deployment not found / This deployment may have been removed or filtered out."

Not in 1.0: rollback buttons (dropped; see [27-dropped.md](27-dropped.md)).

## 11.3 Retention

- Each service keeps its last 50 deployments and their logs; older ones are pruned.
- Deleting a service keeps its deployment rows marked "Removed" for 30 days, then prunes them.
- Deleting a server removes its deployment records.

## 11.4 Access

Who may see a deployment's log follows who owns it: the service (people with access to the service), the server (people with access to that server), or the host (instance administrators). Live log streams check the same rule before sending a line.

## 11.5 The notifications bell

In the header, for everyone. Panel "Notifications", "Invitations and recent deployments.", with a "Channels" link.
- Invitations: workspace, "Role: …", "Expires: <full date and time>" in the viewer's time zone, in the deployment cards' format (31a G1-09), "Accept invitation" (confirm "Join this workspace?").
- Recent deployments: the latest 8 the person can see, each linking to its detail; statuses Deployed, Failed, Running, Cancelled. Empty: "You're all caught up. Deployments will show up here." / "No recent deployments." Error: "Recent deployments are not available right now."
- Badge: pending invitations plus failed deployments since the person last opened the bell (on a first visit, failures from the last 24 hours), at most "9+". What was seen is remembered per browser and workspace.

**Acceptance**
- A member sees only their services' deployments in the list, the bell and any log stream, and is refused another service's log by id.
- Cancelling a building deployment stops the build within 10 seconds and leaves the previous version serving.
