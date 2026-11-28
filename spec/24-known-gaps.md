# 24. Known gaps 1.0 must close

These are problems in today's product, confirmed in the current release unless marked otherwise. 1.0 must not carry them over. Each has the rule 1.0 follows and how to prove it.

## 24.1 Security gaps

| # | Gap today | 1.0 rule | Proof |
| --- | --- | --- | --- |
| G1 | **Backup browsing is workspace-wide.** Anyone with backup read access can list the files in any of the workspace's backup destinations, including other services' backups, and can name any server of the workspace to run the listing on, even one they cannot reach. | Listing backup files is scoped to a service: a person sees only files under the prefixes of backups for services they can manage, and the listing runs only on a server they can reach. There is no destination-wide browsing. | A member with access to service A cannot list, search or see any file name from service B's backups. |
| G2 | **Restore does not check where the file came from.** A person who can restore into their own database can restore another service's backup file into it, reading that service's data. | A restore accepts only a file that belongs to a backup of the same service. The platform checks the file path against the service's backup prefixes before running anything. | Restoring service B's file into service A is refused with "This backup belongs to another service." |
| G3 | **Any workspace can run Compose and containers on the control-plane host.** Every person owns a personal workspace, and the host is a deploy target for everyone. A Compose file can mount the host's filesystem or Docker socket, which is root on the control plane. | The control-plane host is a deploy target only for instance administrators and for workspaces an instance administrator allows. Privileged options (host mounts, host network, Docker socket, privileged mode, added capabilities) are refused on the host for everyone else, and flagged in review on remote servers. | A personal-workspace owner who is not an instance administrator cannot deploy anything to the host; the option is not offered. |
| G4 | **Deploy webhooks are authenticated only by the token in their URL.** Anyone who sees the URL can trigger deploys. | Generic deploy webhooks keep the token (so existing integrations work) but the token can be regenerated, is shown only to people with deploy rights, is rate-limited, and triggers at most one queued deploy. Provider webhooks (GitHub, GitLab, Bitbucket, Gitea) always verify the provider's signature or secret against the raw request body. | A regenerated token makes the old URL return 401; a burst of 100 calls queues one deploy. |
| G5 | **Invitation sign-up does not verify the email address.** A personal-workspace owner can invite an address that has no account and then sign up as that address. | Creating an account from an invitation requires proving control of the invited address (the link emailed to it carries the proof). Only a link sent with the install's own email settings proves it: a link sent with a workspace's own Resend key or SMTP server still works as the invitation, but the account starts unconfirmed unless an instance administrator made the invitation. A copied link creates an account only when an instance administrator made the invitation, and that account counts as confirmed. | Signing up through an invitation without the emailed link is refused. |
| G6 | **Agent sessions are shared by everyone in a workspace.** Every member sees every chat, including what an owner discussed about servers they can't access. | Decide (see 25 D4): recommended is sessions private to the person who started them, with an explicit "Share with workspace" action. Tool results inside a session are always filtered by the viewer's own access. | A member cannot open another person's private session by id. |
| G7 | **The monitoring service compares its access token in a way that leaks timing.** | All secret comparisons (tokens, webhook secrets, signatures) use constant-time comparison. | Code review checklist plus a unit test on every comparison helper. |
| G8 | **Analytics navigation shows for people who can't use it.** The menu item appears for anyone with container read access, but every analytics action needs an instance administrator, so others get a page that only says so. | Navigation items appear only when the person can use the page. | Each navigation item has a test for "hidden when not allowed". |
| G9 | **A profile's email address changes with no check.** Anyone at an unlocked session can move the account to another address. | Changing the email needs the current password, and a notice goes to the old address. Confirmation links and that notice go only through the install's email settings, never a workspace's own. | Changing the email without the password is refused. |
| G10 | **Sign-in failure limits live in memory** and reset when the platform restarts; per-address limits may see the console proxy's address instead of the client's. | Limits survive restarts and use the real client address. | The 11th failure in 15 minutes is refused after a restart; two clients behind different addresses are limited separately. |
| G11 | **Container terminals on apps and Compose services have no permission check in the console** (the server-side check was not confirmed). | Opening a terminal needs deploy rights on the service, checked by the platform before the shell starts. | A member without access to a service can't open its terminal by any path. |
| G12 | **"Manage 2FA" may silently regenerate backup codes** when it checks the password, invalidating the old ones without showing new ones (read from code, not confirmed by running it). | Codes change only when the person asks, and new codes are always shown. | Checking the password leaves existing codes working. |
| G13 | **Errors are swallowed in places**: adding or editing a server shows only "Error creating a server"; deleting an SSH key silently unlinks it from apps that clone with it. | Every refusal shows the platform's own message; destructive side effects are listed before confirming. | Each named case shows its specific reason. |

Earlier gaps that are already fixed and must stay fixed (each needs a regression test in 1.0):
- Host-level resources (the host's terminal, host-wide settings, host metrics, host schedules, the host's Docker details) belong to instance administrators, never to "owner of the active workspace", because every person owns a workspace.
- Every service, project, deployment, log stream and container action checks that the target belongs to the active workspace, for owners and admins too. Deployment access follows the owner of the deployment: the service, the server, or the host.
- Containers on the host map to services by their labels; control-plane containers are reserved.
- Internal page-data fetches use a fixed internal address and never follow a forwarded host header.
- Sign-in has a per-email failure limit, never reveals whether an account exists, and requires the second factor when one is set.
- Cluster and server detail endpoints check the workspace and the person's server access.
- The Agent's import server list and Git SSH-key use check the workspace and access.
- Destination keys never appear in any service's details.
- Whole-instance backups and restores are for instance administrators only.
- Volume backups need a service that actually mounts the volume, and a destination in the same workspace.
- Sign-in forms POST; addresses never carry passwords.
- Adding a member with a password is for instance administrators on a named workspace only.
- Organization add, rename and delete are for instance administrators only.

## 24.2 Product gaps

| # | Gap today | 1.0 rule |
| --- | --- | --- |
| P1 | The update check always answers "no update". | Implement a real check against a signed release feed, or remove every "check for updates" surface (decision D4). |
| P2 | Server CPU and memory alert thresholds exist but can only be set through the API, and default to off. | Thresholds are set on the server's monitoring settings in the console, with a test notification (see [14-monitoring.md](14-monitoring.md)). |
| P3 | Metric charts exist only for the control-plane host; network numbers are collected but never shown. | Show the same charts for every server, or stop collecting what is not shown. 1.0 shows CPU, memory, disk and uptime per server; network is dropped unless charted. |
| P4 | Volume backups for files written by a Compose file (not declared as mounts) are found only by container labels. | The volume list for a Compose service is built from the stack's own volume definitions plus labels, and the page says which volumes it found. |
| P5 | The optional background worker, when enabled, loads every enabled backup with no server filter while host jobs also run inside the platform, so host backups can run twice. | One scheduler; see [23-non-functional.md](23-non-functional.md) 23.2. |
| P6 | The console's deletion of an Agent session sometimes failed on a user's server with no reproduction. | Every failed request in the sessions list shows its reason under "New session"; the end-to-end suite deletes sessions while a turn runs and after. |
| P7 | A domain record is kept when writing its route fails (for example, no SSH key for the server), leaving a domain that does nothing. | Creating a domain is all or nothing, or the domain shows "Not routed: <reason>" with a Retry. |
| P8 | Remote servers' setup logs live on the control plane; reading them through the server failed once. | Every log has one owner and one place; the console and the Agent read it the same way. |
| P9 | Telemetry was proposed and declined. | No telemetry (see 23.9). |
