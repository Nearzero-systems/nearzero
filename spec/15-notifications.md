# 15. Notifications

Notification **channels** send messages about events to chat apps, email or webhooks. Channels belong to a workspace. The header bell is separate ([11-deployments.md](11-deployments.md) 11.5).

## 15.1 Channels page

Settings → **Channels** (page title "Notifications"), for people who can see channels (owners and admins, or "Manage notification channels").
- Table: Name, Type, Events (short labels: Deploys, Failed deploys, Database backups, Volume backups, Docker cleanup, Server alerts, Nearzero restarts, or "No events"), Edit, Delete; "N total".
- **Add notification** (create rights), Edit (update rights), Delete (delete rights: "Delete X? It stops getting notifications. This can't be undone.").
- Empty: "To send notifications, add at least one channel."

## 15.2 Channel types (12)

| Type | Fields |
| --- | --- |
| Slack | Webhook URL, Channel |
| Telegram | Bot token, Chat ID, Message thread ID (optional, numeric) |
| Discord | Webhook URL, Decoration (on by default) |
| Lark | Webhook URL |
| Microsoft Teams | Webhook URL |
| Email (SMTP) | SMTP server, port (1 to 65535), user name, password, From address, To addresses (at least one, each valid) |
| Resend | API key, From address, To addresses |
| Gotify | Server URL, App token, Priority (1 to 10, default 5), Decoration |
| ntfy | Server URL, Topic, Access token (optional), Priority (1 to 5, default 3) |
| Mattermost | Webhook URL, Channel (optional), User name (optional) |
| Pushover | User key, API token, Priority (−2 to 2, default 0); priority 2 adds Retry (at least 30 seconds) and Expire (1 to 10,800 seconds) |
| Custom webhook | URL (POST, JSON body as in 15.4), Headers (rows) |

Provider webhook URLs (Slack, Discord, Lark, Teams, Mattermost) are secrets; a custom webhook's URL is shown and its headers are secret. Email over SMTP uses TLS from the start on port 465 and STARTTLS when offered on other ports. Retries wait 15 seconds, 1 minute, then 4 minutes.

- **Addresses are called exactly as typed** (31c G3-17): a custom webhook saved as "https://example.com/hook/" is shown with its slash and posted to "https://example.com/hook/", moved channels included. Only Gotify's and ntfy's server addresses, which Nearzero adds paths to, lose a trailing "/".
- **Redirects aren't followed**, as they could lead to an address nobody checked (23.9). One is reported as such (31c G3-18): "Test failed: <host> answered with a redirect (301); use the final address", and the same reason in "Last delivery failed: …".
- **The address that was checked is the one connected to** (31c C1-07, 23.9): a typed name is looked up once, every address checked, and the request goes to the checked address with the name kept for the Host header and the certificate check, so a name that answers differently a moment later (DNS rebinding) reaches nothing new. The same holds for SMTP. A provider's answer is quoted in a failure reason only from that provider's own hosts; any other address gets its status, or Lark's code, never its words.
- **Discord** messages post under the name the webhook was given in Discord (31c G3-19); Nearzero sets no sender name. Mattermost posts as "Nearzero" unless the channel names another user.

Validation: name required; URLs start with http:// or https://; each field has a plain message ("Bot token is required.", "Priority must be a number from 1 to 10.").

**Secrets**: tokens, passwords, keys and custom headers are never shown again. Blank fields on edit keep the saved values. Changing where a channel sends (URL, server, chat) requires entering its secrets again: "Enter the X again when you change where this channel sends."

**Test notification**: checks the fields and sends a test: "Test sent. Check <type> for the message." or "Test failed: <reason>".

## 15.3 Events

| Event | When | Message includes |
| --- | --- | --- |
| Deploy succeeded | A deploy finishes and the new version serves | Service, project, environment, commit, address |
| Deploy failed | A deploy fails, including a container that never becomes healthy | Service, project, environment, the failure line, a link to the log |
| Database backup | A scheduled or manual database backup finishes (success or failure) | Service, destination, result |
| Volume backup | Same for volume backups | Service, volume, result |
| Docker cleanup | The daily cleanup ran on a server | Server, space freed |
| Server alert | CPU or memory above its threshold ([14](14-monitoring.md) 14.3) | Server, metric, value, threshold |
| Nearzero restart | The control plane started after a stop or crash | Version; shown only to the workspace of the instance administrators |

Dropped event: "Nearzero backup" (whole-instance backups have no screen; see [27-dropped.md](27-dropped.md)).

Rules: messages never include secrets or variable values; each event is sent once per channel; a failing channel is retried 3 times with back-off and the failure is visible on the channel's row ("Last delivery failed: <reason>").

**Acceptance**: a failed deploy produces exactly one message on Slack, Discord, email and a custom webhook subscribed to "Deploy failed", each naming the service and linking to the log.

## 15.4 The custom webhook body

A custom webhook gets one JSON POST per event. The body carries the flat fields 0.1.x posted, so a receiver written for 0.1.x keeps working after a move (30c R3-37, 31c R3-37, 31d R4-14), and 1.0's own fields beside them. Neither set overwrites the other.

**0.1.x's fields:**
- `title` and `message`: a fixed title and sentence per event, the same every time:

  | Event | `title` | `message` |
  | --- | --- | --- |
  | Deploy succeeded | Build Success | Build completed successfully |
  | Deploy failed | Build Error | Build failed with errors |
  | Database backup, success | Database Backup Successful | Database backup completed successfully |
  | Database backup, failure | Database Backup Failed | Database backup failed |
  | Volume backup, success | Volume Backup Successful | Volume backup completed successfully |
  | Volume backup, failure | Volume Backup Failed | Volume backup failed |
  | Docker cleanup | Docker Cleanup | Docker cleanup completed successfully |
  | Nearzero restart | Nearzero Server Restarted | Nearzero server restarted |
  | Server alert, CPU | Server CPU Alert | Server CPU usage is above its threshold |
  | Server alert, memory | Server Memory Alert | Server memory usage is above its threshold |
  | Test notification | Test notification from Nearzero | If you can read this, the channel <name> works. |

- `status`: "success", "error" or "alert".
- `type`: "build" for deploys; for backups the result, the same as `status` ("success" or "error"); "docker-cleanup"; "nearzero-restart"; for a server alert the metric, "CPU" or "Memory"; "test".
- `timestamp`: when the event happened, as an ISO time: a deploy's or a backup's end, the cleanup's run, the start, and for a server alert the sample that crossed the threshold. A late retry doesn't change it. `date` is the same instant in the control plane's own local format.
- Deploys: `projectName`, `environmentName`, `applicationName`, `applicationType` (the service kind under its 0.1.x name: "application", "compose", "postgres", "mysql", "mariadb", "mongo", "redis", "libsql"), `buildLink` (the deploy's log, or null without a console address). A success has `domains`, every hostname of the service once, without a scheme, joined by ", " ("a.example.com, b.example.com"). A failure has `errorMessage`, the failure line.
- Backups: `projectName`, `environmentName`, `applicationName`, `databaseType` (the service kind as above), `errorMessage` ("" on success, else the reason) and `backupSize` (the size in words, such as "1.5 MB", when known). A database backup has `databaseName`, the database that was dumped ("" for every database). A volume backup has `volumeName` and `serviceType` (the service kind as above).
- Docker cleanup: `serverName` and `cleanupMessage`: "Docker cleanup for Server <name> (<id>)" for a server, "Docker cleanup for nearzero" for the Nearzero host.
- Server alerts: `serverName`, `alertType` ("server-threshold"), `currentValue` and `threshold`.

**1.0's own fields:** `event` (the event's id, such as `deploy.failed`, or `test`), `headline` (1.0's title, such as "Deploy failed: web"), `summary` (its one-line summary), `facts` (label and value pairs, the time last), `link` (label and address, or null), `tone` ("success", "failure", "warning", "info"), `data` (the event's own names and results) and `sentAt` (when this delivery was sent).

The body never carries secrets or variable values.
