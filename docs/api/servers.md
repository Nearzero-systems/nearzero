# Servers, SSH keys, the host and the runner API (M3a)

Endpoints for servers and SSH keys as records, the Nearzero host as a deploy target, the runner's status and metrics, containers, live logs, terminals, router files and routes. Implements spec 09 (9.1, 9.2, 9.4, 9.6–9.8; setup over SSH comes later), 10.2 (server labels), 10.7 (the certificate hold, with the runner), 14.1–14.2, 22.2–22.5, 24 (G3, G7, P7, P8) and 25 D1. The runner's own link is in [`docs/runner-protocol.md`](../runner-protocol.md).

Conventions (errors, JSON bodies, the session cookie, `Cache-Control: no-store`) are those of [`identity.md`](identity.md). Request schemas are in `packages/shared/src/servers.ts` and `runner-protocol.ts`.

Wherever a path takes `:id`, a server id works, and so does `host` for the Nearzero host. The host belongs to no workspace: deploying to it needs **Use the Nearzero host** (instance administrators, or a workspace they allowed); reading or operating it (containers, logs, terminals, metrics, router files, routes) is for instance administrators only (spec 22.2).

## Shapes

```ts
type Readiness = "ready" | "setup_needed" | "setup_running" | "setup_failed" | "inactive";
// Labels: Ready, Setup needed, Setup running, Setup failed, Inactive (SERVER_READINESS_LABELS).
// ready: setup done and the runner connected; inactive: setup done, runner not connected.

interface RunnerView {
  state: "online" | "offline" | "never_connected" | "update_needed";
  version: string | null; protocol: number | null;
  connectedAt: string | null; lastSeenAt: string | null;
  message: string | null;          // why it isn't working, in plain words
  updateNeeded: boolean;           // its message says to run setup again (G3-05)
  system: SystemInfo | null;       // spec 14.1 system information
  checks: { docker: boolean; network: boolean; router: boolean; routerDirectory: boolean } | null;
  credentialIssuedAt: string | null;
  // R3-22, from a connected runner that reports it: message is "HTTP/3 is off: UDP port 443 is
  // in use by <program>" when something else holds the port; null when unknown.
  http3: { enabled: boolean; message: string | null } | null;
}

interface Server {
  id; name; description; address; port; sshUser;
  sshKey: { id; name } | null;
  label: string;                   // hostnames live under <label>.<platform domain>; never changes
  hostKeyFingerprint: string | null;
  setup: { state: "not_started" | "running" | "ready" | "failed"; error; startedAt; finishedAt };
  readiness: Readiness;
  dockerCleanup: boolean;          // nightly Docker cleanup (spec 9.4), off by default
  runner: RunnerView;
  services: number;
  createdAt; updatedAt;
}

interface SshKey {
  id; name; description; type: "rsa" | "ed25519";
  publicKey: string; fingerprint: string;          // SHA256:…
  createdAt; updatedAt;
  usedBy: { id; name }[];                          // servers signing in with it, that you can see
  hiddenServers: number;                           // the others using it (C1-13)
}
```

Private keys are never in any response after they are saved.

## SSH keys (spec 9.7)

| Endpoint | Needs | Request | Response |
| --- | --- | --- | --- |
| `GET /ssh-keys` | Use the workspace's SSH keys | | `{ keys: SshKey[] }` |
| `GET /ssh-keys/:id` | same | | `{ key }` |
| `POST /ssh-keys/generate` | Add and remove SSH keys | `{ type: "rsa" \| "ed25519", name? }` | `{ type, publicKey, privateKey, fingerprint, message: "SSH key generated" }` — not saved; fills the Add dialog. RSA is 4096 bits; ED25519's private key is OpenSSH format, RSA's is an RSA PEM block. |
| `POST /ssh-keys` | Add and remove SSH keys | `{ name, description?, publicKey, privateKey }` | 201 `{ key }` |
| `PATCH /ssh-keys/:id` | Add and remove SSH keys | `{ name?, description? }` | `{ key }` |
| `DELETE /ssh-keys/:id` | Add and remove SSH keys | | `{ deleted: true }` |

Checks and refusals: "Invalid public key format" (not one `ssh-rsa`/`ssh-ed25519` line, or a damaged one), "Invalid private key format" (not an OpenSSH or RSA PEM block, or damaged), "The private key doesn't belong to this public key. …", a passphrase-protected key ("… Remove it (ssh-keygen -p -N "" -f <key file>) and paste it again."), and on delete `This SSH key is attached to server: X. Remove that server first.` (409). Errors name the field in `fields.publicKey` / `fields.privateKey`.

## Servers (spec 9.1, 9.2, 9.6)

| Endpoint | Needs | Request | Response |
| --- | --- | --- | --- |
| `GET /servers?q=&status=` | Server access (members: their granted servers) | `q` searches name, address, description and SSH user; `status` is a readiness or `all` | `{ servers: Server[] }` |
| `GET /servers/targets` | | | `{ targets: { id, name, readiness, host }[] }`: where a service can go; the host only when the person may use it |
| `POST /servers` | Add and remove servers, plus Use the workspace's SSH keys | `{ name, description?, sshKeyId, address, port?: 22, sshUser }` | 201 `{ server }` |
| `GET /servers/:id` | Server access | | `{ server }` (for `host`: `{ host }`, below) |
| `PATCH /servers/:id` | Add and remove servers on that server | any of the create fields, `dockerCleanup?` | `{ server, notices: string[] }` — changing the SSH user adds "Run setup again: …" |
| `DELETE /servers/:id` | same | | `{ deleted: true, message: "Server deleted" }`; revokes the runner and drops its routes and metrics |
| `POST /servers/:id/join-command` | same (instance administrators for `host`) | | `{ token, expiresAt, controlUrl, controlFingerprint, command, note }`: `command` is `sudo nearzero-runner join <control url>`, with `--fingerprint sha256:<hex>` when the address is Nearzero's own TLS port (no domain), and only ever an `https://` address (null, with a note, when there is none; docs/runner-protocol.md), which asks for the `token` (or reads it from standard input), so the token stays out of process lists and shell history; it works once within an hour; running it on the server enrolls the runner, and issuing a new one later rotates the credential |
| `POST /servers/:id/runner/revoke` | same | | `{ revoked: true }`; the runner is disconnected and can't come back until it joins again |

Validation (spec words): "Enter an IP address or hostname without a protocol, path, or port" (`fields.address`), "Enter a port from 1 to 65535.", SSH user "Use up to 32 characters: a letter or _ first, then letters, digits, _ or -." (no default), "Saved SSH key not found." (`fields.sshKeyId`; also for another workspace's key), `A server named "X" already exists in this workspace. Pick another name.` (409, ignoring case), `"X" already uses <address>:<port>. Each server needs its own address and port.` (409).

Labels (spec 10.2) are chosen once, at creation, from the name: lowercase letters, digits and dashes, at most 40 characters, `server-` before a leading digit, `-2`, `-3`… on clashes across the install. Renaming never changes them.

Delete with services: "Server has active services, please delete them first" (409), unless `?deleteServices=true` ([`server-setup.md`](server-setup.md)).

A server that joined with the join command becomes ready when its runner connects and reports every mandatory check (Docker, the private network, the router and its folder). A server set up over SSH (spec 9.3) is marked ready by its setup run, after the validation of spec 9.4: see [`server-setup.md`](server-setup.md), which also covers deleting a server with its services.

## The Nearzero host (spec 24 G3)

| Endpoint | Needs | Response |
| --- | --- | --- |
| `GET /host` | Use the Nearzero host | `{ host: { id: "host", name: "Nearzero host", available: true, canManage, runner } }`; `runner` has only `state`, `version`, `message`, `updateNeeded` unless `canManage`. Others get 404 ("The Nearzero host isn't available to this workspace."). |
| `GET /host/allowed-workspaces` | instance administrator | `{ workspaces: { workspaceId, name, first, allowed, allowedAt }[] }` |
| `PUT /host/allowed-workspaces/:workspaceId` | instance administrator | `{ allowed: boolean }` → the same list; audited. Withdrawing an allowance stops the workspace's deploys and Reloads on the host (403 `This workspace isn't allowed on the Nearzero host any more, so nothing of it deploys there. …`; push and webhook deploys fail with it), and its new environments don't copy its host services (they are in `notCopied`); what runs there keeps running |

People in an allowed workspace may place services on the host; the host's containers, logs, terminals, metrics and router files stay with instance administrators.

## Runner status and metrics (spec 14.2)

| Endpoint | Needs | Response |
| --- | --- | --- |
| `GET /servers/:id/runner` | Server access (host: instance administrator) | `{ runner, readiness? }` |
| `GET /servers/:id/metrics?points=50\|200\|500\|all` | same | `{ samples: { at, cpuPercent, memoryUsedBytes, memoryTotalBytes, diskUsedBytes, diskTotalBytes, diskAvailableBytes?, uptimeSeconds }[], latest, system, reporting: { current, lastSampleAt, message } }`, oldest first; a sample every 5 s, kept 2 days. `diskAvailableBytes` is df's "Available" (absent from older runners' samples; 30c R3-34). Once the runner has been gone for over a minute, `latest` is null and `reporting` says "<server> isn't reporting. The last sample was taken <time>." (30c R3-33) |

## Containers, logs and terminals (spec 22.4 rules 2 and 4)

Access is checked before anything is sent. Nearzero's own containers (anything labeled `dev.nearzero.component`: control, database, runner, router, DNS) are reserved: "That container is part of Nearzero itself, so it can't be opened from here. On the host, use: sudo nearzero logs" (403). A server's runner that isn't connected answers 503 with the server's name ("The runner on "X" isn't connected, …"; for the host: "… On the host, check it with: sudo nearzero status").

| Endpoint | Needs | Response |
| --- | --- | --- |
| `GET /servers/:id/containers` | Add and remove servers on that server (host: instance administrator) | `{ containers: { id, name, image, state, status, serviceId, createdAt }[] }` without reserved ones; `serviceId` from the `dev.nearzero.service` label |
| `GET /servers/:id/containers/:container/logs?tail=200&timestamps=1` | same | Server-sent events (below) |
| `GET /servers/:id/containers/:container/terminal?cols=80&rows=24` | same | WebSocket (below); opening one is audited |
| `GET /servers/:id/terminal?cols=80&rows=24` | Add and remove servers on that server (not for `host`: 400) | WebSocket (below): an SSH login shell on the server itself, the server card's Terminal (spec 9.1). Signs in like setup (the server's key, its recorded host key; the first sign-in records it); a sign-in or shell problem ends the socket with `{ "type": "exit", "error" }` in setup's words. Audited as `terminal.opened` with `{ ssh: true, user }` |

Per-service logs and terminals (deploy rights on the service, gap G11) build on these in the next milestone; they use the same streams.

**Log stream (SSE).** `Content-Type: text/event-stream`; a `: keep-alive` comment at least every 15 s.

| Event | `data` (JSON) | `id` |
| --- | --- | --- |
| `open` | `{ streamId }` | |
| `output` | `{ text, offset }` | `<streamId>:<end offset>` |
| `status` | `{ connected, message }` — the server's link dropped or came back; the log continues where it stopped | |
| `gap` | `{ from, to, message }` — output lost while the server was away longer than its buffer holds | |
| `end` | `{ exitCode, error }` | `<streamId>:<offset>` |

Reconnecting with `Last-Event-ID` (or `?lastEventId=`) within 30 seconds continues the same stream from exactly that offset; later, a new stream starts with no tail.

**Terminal (WebSocket).** Binary frames from the browser are keystrokes; text frames are JSON: `{ "type": "resize", "cols", "rows" }` or `{ "type": "input", "data": "…" }` (other text is sent as typed). From the server: binary frames are terminal output; text frames are `{ "type": "status", "connected" }` and, when the shell ends, `{ "type": "exit", "exitCode", "error" }` followed by a close. The shell is `bash` when the image has it, otherwise `sh`. The SSH terminal sends `{ "type": "status", "connected": true }` once the server's shell has started. The session cookie authenticates the upgrade; the console's proxy must pass WebSocket upgrades through for this path.

## Router files and routes (spec 9.1 Router files, 10)

| Endpoint | Needs | Response |
| --- | --- | --- |
| `GET /servers/:id/router-files` | See router files on that server (host: instance administrator) | `{ canEdit, files: { name, contents, managed, editable }[], mainSettings }`: every configuration file in the router's folder. `mainSettings` (R3-23) is `{ name: "main-settings", title: "Main settings", contents, note, managed: true, editable: false }`: the router's entry points, certificate resolvers and global options as Nearzero starts it with them, read-only for everyone ("Nearzero sets these when it starts the router, so they can't be edited here."); null from an older runner. `managed`: the runner's own (`route-*`, `nearzero-*`), always read-only ("Managed by Nearzero; changes are overwritten on the next deploy."); `editable`: a YAML file this person may save |
| `PUT /servers/:id/router-files/:name` | See router files, plus Add and remove servers on that server (host: instance administrator) | `{ contents }` → `{ file, message: "Router config updated" }`. Settings → Router files (spec 18.3). Refused with 400 and the line and reason when the YAML or the router's dynamic configuration is invalid (`fields.contents`, e.g. "Line 3: \"http.routers.web\" needs a rule."), for names with folders or outside the folder, non-YAML names, the runner's own files and `main-settings`. Audited as `router-file.saved` |
| `GET /servers/:id/routes` | instance administrator, plus Add and remove servers there | `{ routes: Route[], held: { hostname, reason }[] }` |
| `PUT /servers/:id/routes/:key` | same | `{ hostnames, path?: "/", upstream: { host, port, scheme?: "http" }, certificate?: "letsencrypt" \| "hold" \| "none" }` → `{ route }` |
| `DELETE /servers/:id/routes/:key` | same | `{ removed: true }` |

Routes are internal plumbing: later milestones (deploys, hostnames) call `upsertRoute` / `removeRoute` in `apps/control/src/routing/routes.ts` directly, and these endpoints exist for administrators and tests. Writing is all or nothing (gap P7): the route is saved only after the runner wrote its file, so an unreachable server refuses it with the reason and nothing is kept. A hostname can route to one place on the install ("<host> already routes somewhere else on this Nearzero. Remove it there first.", 409). Every route the control plane holds is sent to a runner again each time it connects. Hold reasons: `not_public`, `address_unknown`, `no_record`, `points_elsewhere`, `lookup_failed` (see the runner protocol's certificate hold).

## The runner gateway

Used by runners, not browsers; see [`docs/runner-protocol.md`](../runner-protocol.md): `POST /runner/enroll` (join token → credential, 201; a used, expired or wrong token answers 401 "This join token isn't valid any more: …"), `GET /runner/check` (credential check; 401 "This runner's credential isn't accepted: …"), `GET /runner/connect` (the WebSocket).

## Audit events

`ssh-key.added`, `ssh-key.updated`, `ssh-key.deleted`, `server.added`, `server.updated`, `server.deleted`, `runner.join-token-issued`, `runner.enrolled`, `runner.revoked`, `host.workspace-allowed`, `host.workspace-disallowed`, `terminal.opened`, `router-file.saved`.

## Code map

`apps/control/src/`: `ssh-keys/` (formats, generation, records, routes), `servers/` (records, labels, readiness, host, targets, routes), `runners/` (hub, gateway, credentials, streams, metrics, host handoff, sockets), `routing/` (route records). Migrations 0150–0153.
