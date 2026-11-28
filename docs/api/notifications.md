# Notification channels (M10)

Where a workspace's events go: chat apps, email, push services and webhooks. Implements spec 15 (all), 22.2 ("Nearzero restart" for the instance administrators' workspace), 22.3 ("Manage notification channels"), 23.4 (secrets sealed, never returned), 23.9 (the only outbound calls are to channels people configured).

## Who may do what

Owners and admins, and members with "Manage notification channels" (`notifications.manage`): see, add, edit, delete and test channels. Everyone else gets 403; another workspace's channel is "not found".

## Endpoints

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /notification-channels` | | `{ channels: ChannelView[], total, can: { create, update, delete }, events }` (`events`: what this workspace may subscribe to; "nearzero.restart" only in the first workspace) |
| `POST /notification-channels` | `{ name, type, fields, events }` | 201 `{ channel, message: "Notification channel added" }` |
| `GET /notification-channels/:id` | | `{ channel }` |
| `PATCH /notification-channels/:id` | `{ name?, fields?, events? }` | `{ channel, message: "Notification channel saved" }` |
| `DELETE /notification-channels/:id` | | `{ deleted: true, message: "Notification channel deleted" }` |
| `POST /notification-channels/test` | `{ type, fields, channelId?, name? }` | `{ ok: true, message: "Test sent. Check <type> for the message." }` or `{ ok: false, message: "Test failed: <reason>" }` |

```ts
type ChannelView = {
  id; name; type; typeLabel; events: string[]; eventsText /* "Deploys, Failed deploys" | "No events" */;
  settings: Record<string, value>;                       // never a secret
  secrets: Record<string, { saved: boolean; hint: string | null }>;  // provider webhooks: "https://hooks.slack.com/…"
  readable /* false when the install secret changed */; lastDeliveryAt; lastFailure /* "Last delivery failed: <reason>" */; lastFailureAt; createdAt; updatedAt;
};
```

Field problems come back as `fields["fields.<key>"]` (and `fields.name`), in the spec's words: "Bot token is required.", "Webhook URL must start with http:// or https://.", "Priority must be a number from 1 to 10.", "Enter the bot token again when you change where this channel sends.". Names are unique per workspace, ignoring case (409).

## The 12 types (spec 15.2; `CHANNEL_TYPE_INFO` in `packages/shared/src/notification-rules.ts`)

| Type | Fields (secret ones marked *) | Sent as |
| --- | --- | --- |
| Slack | Webhook URL*, Channel | POST `{ text, attachments: [{ color, text, fields, footer, ts }], channel? }`: the title, then one attachment in the event's color (green success, red failure) with the summary, links and a field per fact |
| Telegram | Bot token*, Chat ID, Message thread ID | POST `api.telegram.org/bot<token>/sendMessage` `{ chat_id, text (HTML), parse_mode: "HTML", message_thread_id?, reply_markup? }`; a deploy's log is an inline keyboard button "Deployment Logs" |
| Discord | Webhook URL*, Decoration (on) | POST an embed (title, description, color, fields, timestamp); Decoration puts an emoji before the title, and off sends the same embed without it |
| Lark | Webhook URL* | POST `{ msg_type: "interactive", card }`: a card with the title in the event's color, the summary, the facts as fields, and buttons ("View Build Details" for a deploy's log) |
| Microsoft Teams | Webhook URL* | POST a `message` with an Adaptive Card 1.4 (title, summary, facts, link) |
| Email (SMTP) | SMTP server, Port (1–65535), User name, Password*, From address, To addresses | SMTP; port 465 is TLS from the start, others upgrade with STARTTLS when offered |
| Resend | API key*, From address, To addresses | POST `api.resend.com/emails` |
| Gotify | Server URL, App token*, Priority (1–10, 5), Decoration | POST `<server>/message` with `X-Gotify-Key`; markdown when decorated |
| ntfy | Server URL (https://ntfy.sh), Topic, Access token*, Priority (1–5, 3) | POST JSON to the server root `{ topic, title, message, priority, tags, click?, actions? }`; a deploy's log is a "Build details" view action |
| Mattermost | Webhook URL*, Channel, User name | POST `{ text (markdown), channel?, username }`; the user name is "Nearzero" unless one is set |
| Pushover | User key*, API token*, Priority (−2 to 2, 0); with 2, Retry (≥ 30) and Expire (1–10,800) | POST form to `api.pushover.net/1/messages.json` |
| Custom webhook | URL, Headers* (rows) | POST JSON with the headers: 0.1.x's flat fields and 1.0's `{ event, headline, summary, facts, link, tone, data, sentAt }` (below) |

- **Every message** says when its event happened (a "Time" fact, in UTC: a deploy's or a backup's end, a cleanup's run, a restart, an alert's sample, a test's send), and a deploy's message names the service kind ("Type": Application, Compose, or the database type). Buttons and links to the console need its public address; a link a chat app can't open (localhost, a single-label name) stays in the text.
- **The custom webhook's body** (spec 15.4): 0.1.x's flat fields, so receivers written for 0.1.x keep working after a move: `title` and `message` (0.1.x's fixed title and sentence per event, such as "Build Error" and "Build failed with errors"), `status` (`success`, `error`, `alert`), `type` (`build`; a backup's result, `success` or `error`; `docker-cleanup`; `nearzero-restart`; an alert's metric, `CPU` or `Memory`; `test`), `timestamp` (ISO, when the event happened: an alert's sample) and `date` (the same instant in the control plane's local format), and per event `projectName`, `environmentName`, `applicationName`, `applicationType` and `serviceType` (0.1.x kind names, `mongo` for MongoDB), `buildLink`, `domains` (every hostname, comma-separated, no scheme), `errorMessage` (`""` for a successful backup), `databaseType`, `databaseName` (the database dumped), `volumeName`, `backupSize` (a size in words), `serverName`, `cleanupMessage`, `alertType` (`server-threshold`), `currentValue`, `threshold`. 1.0's own fields sit beside them: `event`, `headline` (1.0's title), `summary`, `facts`, `link`, `tone`, `data` and `sentAt`.
- **Private and internal addresses**: a destination a person typed (webhook URLs, Gotify and ntfy servers, the SMTP server) is looked up before saving and before every send; one that resolves to a loopback, private, link-local or reserved address is refused unless an instance administrator saved the channel. A failed answer from a typed address is reported by status only.
- **Secrets** (tokens, passwords, keys, provider webhook URLs, custom headers) are sealed with the install key (context `notification-channel:<id>`), never returned, and kept when left blank on edit. Changing where a channel sends (a destination field: SMTP server and port, Gotify and ntfy server and topic, Telegram chat, a custom webhook's URL) needs its saved secrets entered again.
- Failure reasons name the provider's answer ("Slack answered 404: no_team", "couldn't reach 10.0.0.9:8080 (no answer within 10 seconds)") and never carry a secret: any saved secret value in a reason is cut out.

## Events (spec 15.3)

| Event key | Short label | Written by | Payload (names and results only) |
| --- | --- | --- | --- |
| `deploy.succeeded` | Deploys | `deploys/queue.ts` → `notifications/emit.ts` | `{ deploymentId, service, project, environment, commit, address, finishedAt }` |
| `deploy.failed` | Failed deploys | same | `{ deploymentId, service, project, environment, error (the engine's failure line), finishedAt }`; the message links to `<console>/<workspace>/dashboard/deployments/<id>` |
| `backup.database`, `backup.volume` | Database backups, Volume backups | `backups/events.ts` ([backups.md](backups.md)) | |
| `server.docker-cleanup` | Docker cleanup | `server-setup/cleanup.ts` | `{ server, freedBytes, freedText, localDate, ranAt }` |
| `server.alert` | Server alerts | `monitoring/alerts.ts` ([monitoring.md](monitoring.md)) | `{ server, metric, value, threshold, at, test }` |
| `nearzero.restart` | Nearzero restarts | `main.ts` at start (`recordStart`), first workspace only | `{ version, startedAt, after: "stop" \| "crash" }` (a clean stop is recorded by `recordStop`) |

Every event has a dedupe key (for example `deploy:<id>:failed`), so a retried job never writes it twice. Messages never include secrets or variable values.

## Delivery

- **The dispatcher** (`startNotificationDispatcher`, started by `main.ts`) runs a pass every 2 seconds and at once after an event is recorded in this process. A pass turns new outbox rows into one `notification_delivery` per subscribed channel (unique on event and channel: each event is sent once per channel), marks the outbox row `delivered_at` (fanned out), then claims due deliveries with `FOR UPDATE SKIP LOCKED` and a 2-minute lease and sends them, 10 seconds at most each.
- **Retries**: a failed delivery is retried 3 times, after 15 seconds, 1 minute and 4 minutes, then marked failed. Every failure sets the channel's "Last delivery failed: <reason>"; the next success clears it.
- Delivered events and finished deliveries are kept 30 days.

## Code map

`apps/control/src/notifications/`: `tables.ts`, `outbox.ts` (`recordEvent`), `emit.ts` (deploy and restart events), `messages.ts`, `senders.ts` (the 12 types), `smtp.ts`, `transport.ts` (outbound settings; tests point it at fakes), `channels.ts`, `dispatcher.ts`, `routes.ts`. Migration 0503. Console: `src/pages/[workspace]/dashboard/settings/channels.astro`, `src/components/notifications/ChannelDialogs.astro`, `src/client/channels.ts`. Tests: `packages/shared/test/notifications.test.ts`, `apps/control/test/notifications.test.ts` (all 12 types against local fake HTTP and SMTP servers, retries, deploy, restart and alert events), `apps/control/test/support/fake-notifiers.ts`, `apps/console/e2e/m10.e2e.ts`.
