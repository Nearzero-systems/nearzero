# Setting servers up over SSH (M6)

Endpoints and behavior for setting a server up over SSH, the setup validation, the security audit, the daily Docker cleanup and deleting a server with its services. Implements spec 09 (9.2 host keys, 9.3, 9.4, 9.5 in the dialogs, 9.6), 14.4, 15.3 (the "Docker cleanup" event), 22.5, 23.1 ("Scripts are safe to feed on standard input"), 23.6, 24 G13 and 25 D1 option C: SSH bootstraps and repairs a server, the runner does everything after. Conventions are those of [`identity.md`](identity.md); servers as records are in [`servers.md`](servers.md), the runner's link in [`../runner-protocol.md`](../runner-protocol.md).

Code: `apps/control/src/server-setup/` (`ssh.ts` the SSH client, `connection.ts` signing in, `parse.ts` reading answers, `scripts.ts` every script sent to a server, `pins.ts`, `runner-binaries.ts`, `job.ts` the setup job, `runs.ts`, `log.ts`, `validation.ts`, `audit.ts`, `cleanup.ts`, `removal.ts`, `routes.ts`, `settings.ts`), shared words and shapes in `packages/shared/src/server-setup-rules.ts`, migration 0400. Console: `components/servers/ServerSetupDialogs.astro`, `client/server-setup.ts`, `styles/server-setup.css`.

## Signing in

- The control plane's SSH client is `ssh2` (MIT). The server's private key is opened from the database for one connection and kept in memory only; only the key is offered (no passwords, no keyboard-interactive).
- **Host key.** Every connection reports the server's host key fingerprint (`SHA256:…`, as `ssh-keygen -l` shows it). The first connection records it on the server (`hostKeyFingerprint`), and the log says to compare it with the provider's console. A recorded fingerprint must match; a different one is refused ("This server's host key changed…"). With `NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=true` (install setting) a server whose key wasn't recorded or trusted is refused before signing in, showing the key it presented; **Trust this host key** records it.
- **Timeouts.** 20 s to connect, keep-alives every 10 s, a timeout on every command (10 minutes by default, up to 30 for Docker and the builders).
- **First command.** `echo ::nz-ok::`. A cloud image that refuses the user answers with its own message and runs nothing; "Please login as the user "ubuntu" rather than the user "root"" becomes the wrong-user failure with `suggestedUser`.
- **sudo.** Users other than root need passwordless sudo, checked with `sudo -n true` (never a prompt). Every step then runs through `sudo -n`.

Failures (`failure.kind`, `failure.message`): `key_rejected` ("Couldn't connect to your server — the SSH key was not accepted." with hints), `unreachable` ("Couldn't connect to your server at <address>:<port> (<cause>). The address or port may be wrong, a firewall may block SSH from Nearzero, or the server may be off."), `wrong_user` (`This server does not allow logging in as "root". It asks for the user "ubuntu": change the server's SSH user to "ubuntu" and run setup again.`), `sudo_missing` (`The user "X" needs passwordless sudo for setup. On the server, run: echo 'X ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/X, then run setup again.`, with `fixCommand`; variants when sudo isn't installed or wants a terminal), `host_key_unknown`, `host_key_changed`, `unsupported_system` (the spec's sentence; also for CPUs other than amd64 and arm64), `no_control_address` (the install has no address servers can reach), `step_failed`, `validation_failed`, `stalled`, `internal`.

## Scripts

Every script sent to a server is generated in `scripts.ts`, so the rules hold for every system:

- It travels on standard input to `sh -c 'umask 077; f=$(mktemp …); cat > "$f"; [sudo -n --] bash "$f" </dev/null; …'`: saved to a private temporary file, run from it with standard input from `/dev/null`, and removed. Each script also starts with `exec </dev/null`. No step can read what follows it.
- Steps run under bash with `set -eEuo pipefail` and an ERR trap that prints the failed command and its exit code, so every command's status is checked. Only the facts probe and the bash bootstrap run under plain sh (Alpine has no bash at first; setup installs it).
- Options BusyBox lacks are avoided (`status=none`, `sed -r`, `grep -P`, `xargs -r`, `date -d`, `stat --…`); package managers run non-interactively. `apps/control/test/server-setup-rules.test.ts` checks all of this, and that every script parses, for every supported family, init system and user.
- Steps print `::nz-doing::` (what they are doing: the reason in a failure), `::nz-note::` and `::nz-skip::`; the log shows them as plain lines.
- Secrets (the join token, credentials, keys) are cut out of every log line before it is stored.

A failed step reads: `Setup stopped at step N (<title>): <reason>. Cause: <last error line or the failed command> (exit code X)`. A failure setup decides itself (a port taken, the runner not connecting) reads `Setup stopped at step N (<title>): <reason>.`

## The steps

Before the steps: connect, record the host key, check the user, check sudo, read the facts (system, architecture, C library, init system, memory, disk, swap, Snap), refuse unsupported systems, install bash where missing. Supported: Debian, Ubuntu and derivatives, Raspberry Pi OS (apt); Fedora, RHEL, CentOS, Rocky, Alma, Oracle (dnf/yum); Amazon Linux; SUSE (zypper); Arch (pacman); Alpine (apk).

| # | Title | What it does |
| --- | --- | --- |
| 1 | Clean up leftovers from an earlier run | Temporary files of earlier runs; running workloads and routes are kept |
| 2 | Install basic tools | curl, wget, git, jq, openssl, tar, gzip, unzip, `ss` and CA certificates, only what is missing; on Alpine the C++ runtime the musl runner needs |
| 3 | Check ports 80 and 443 | Free, or held by `nearzero-router`; otherwise stops naming the program or container |
| 4 | Install rclone | 1.71.2, checksum-verified (`pins.ts`) |
| 5 | Install Docker | From Docker's signed repository (apt, dnf) or the distribution's (Amazon, SUSE, Arch, Alpine), with the Compose and buildx plugins (pinned plugin binaries where packages lack them); Snap Docker is refused; an installed Docker is kept; started and enabled at boot (started directly without an init system) |
| 6 | Prepare the container runtime, the private network and the runner | Refuses rootless Docker; creates `nearzero-edge` unless a network of that name exists; sends the runner for the server's architecture and C library (checked against `SHA256SUMS` before sending and on the server), installs `/usr/local/bin/nearzero-runner`, writes `/etc/nearzero/runner.env` (0600) and a systemd unit or OpenRC service, and joins with a fresh one-time token (`nearzero-runner enroll`, the token in the environment only); the credential is `/var/lib/nearzero-runner/credential`, root-only |
| 7 | Add swap | Twice the RAM, 2 to 8 GB, only when there is none, the disk keeps 4 GB free, and the server isn't a container |
| 8 | Create Nearzero's folders | `/etc/nearzero/router` belongs to the SSH user (root on root servers), so the router runs as that user |
| 9 | Start the router | (Re)starts the runner, waits for it to connect (5 minutes) and report the router running with every check passing; the runner keeps the previous router until a new one runs |
| 10 | Open web ports in the firewall | 80/tcp, 443/tcp, 443/udp in ufw, firewalld or iptables when active; never a monitoring port; reminds about the cloud firewall |
| 11 | Install the builders | Railpack, Nixpacks and pack at the versions in `runner/tools/pins.ts`, checksum-verified, defaults linked from `<builders>/bin` |
| 12 | Set up monitoring | The runner collects metrics itself and listens on no port (D5), so nothing is opened |
| 13 | Add the SSH user to the Docker group | Skipped for root |
| 14 | Harden SSH | A block at the top of `sshd_config` (G3-02): key-only sign-in (`PasswordAuthentication no`, `KbdInteractiveAuthentication no` and `ChallengeResponseAuthentication no` where the OpenSSH knows them, `PubkeyAuthentication yes`, `AuthenticationMethods publickey`), root only with a key (a stricter `PermitRootLogin` is kept), `MaxAuthTries 3`, `LoginGraceTime 30`, `AllowAgentForwarding no`, `X11Forwarding no`, `AllowTcpForwarding local` (`no` before OpenSSH 7.4), `GatewayPorts no`, `PermitTunnel no`, `PermitUserEnvironment no`. Checked with `sshd -t`, then `sshd -T -C user=<setup user>,host=localhost,addr=127.0.0.1` must show passwords and keyboard sign-in off and `authenticationmethods publickey` for the setup user, or the step fails and the old file stays; only then it replaces the old file, reloaded through systemd, OpenRC or a HUP; then a new sign-in is tried, and the old configuration is put back if it fails |
| 15 | Configure monitoring | Waits for the runner's first metrics; non-fatal ("Monitoring setup skipped: …") |

Then "Setup Server: ✅" and the validation below; missing mandatory checks fail the run ("Server setup did not complete. Missing: …"). Success marks the server ready (setup is what marks a server set up over SSH ready; the runner connecting only marks servers that joined with the join command).

**Running setup again** keeps apps, databases, the router and its routes: an installed Docker is never reinstalled or restarted, the runner is restarted (containers keep running), the router is recreated only when its settings changed, and routes are sent again when the runner connects. Changing the SSH user and running setup again moves the router's folder to the new user.

## Runs

| Endpoint | Needs | Request | Response |
| --- | --- | --- | --- |
| `POST /servers/:id/setup` | Add and remove servers on that server | `{ sshUser? }` (the wrong-user button: changes the SSH user first, audited) | 202 `{ setup: SetupView, started }` |
| `GET /servers/:id/setup` | Server access | | `{ setup: SetupView }` |
| `GET /servers/:id/setup/events?run=` | Server access | | Server-sent events, below |
| `GET /servers/:id/setup/log?run=` | Server access | | `{ runId, lines: { seq, text }[], text }` |

`host` answers 400 "The Nearzero host is set up by the installer, not over SSH."

- A run is a job (`servers.setup`, two attempts: a control plane that stopped mid-run starts it again from step 1).
- Only one run per server goes at a time. A run is **stalled** when nothing happened for 5 minutes (no log line and no heartbeat; a working run beats every 30 s) or its job is gone. `POST` on a server with a run going answers it with `started: false` and `notice: "Setup is already running…"`; with a stalled one it ends that one (`failure.kind: "stalled"`) and starts another with `retriedStalled: true` and `notice: "Previous setup looks stalled. Retrying…"`. `GET` shows the same notices.

```ts
interface SetupView {
  server: { id; name; target: "user@address:port"; setupState: "not_started" | "running" | "ready" | "failed"; setupStateLabel; hostKeyFingerprint };
  run: SetupRunView | null;   // the newest run
  notice: string | null;
  canManage: boolean;
}
interface SetupRunView {
  id; state: "running" | "succeeded" | "failed";
  step: number | null; stepTitle: string | null;          // running now, or where it stopped
  steps: { number; title; state: "waiting" | "running" | "done" | "skipped" | "failed"; note }[];
  stateLine;                                               // "Step 5 of 15: Install Docker"
  failure: { kind; message; hints: string[]; suggestedUser; fixCommand; presentedFingerprint } | null;
  retriedStalled; startedAt; lastActivityAt; finishedAt; logSeq;
}
```

**Events.** `run` `{ run }` (on open and at every change, including a new run starting: the stream then follows it from its first line) and `log` `{ seq, text }` with id `<run id>:<seq>`; `Last-Event-ID` (or `?lastEventId=`) resumes after that line. Keep-alive comments every 15 s.

## Host keys

| Endpoint | Needs | Request | Response |
| --- | --- | --- | --- |
| `POST /servers/:id/host-key/trust` | Add and remove servers on that server | `{ fingerprint: "SHA256:…" }` | `{ hostKeyFingerprint }` |
| `DELETE /servers/:id/host-key` | same | | `{ hostKeyFingerprint: null }`: the next connection records the key again (after a rebuild) |

## Validation and the security audit (spec 9.4)

| Endpoint | Needs | Response |
| --- | --- | --- |
| `GET /servers/:id/validation` | Server access | `{ validation: ValidationView \| null }`: the newest, kept from setup or the last check. With `?fresh=1` (the details opening), a server that has been set up is checked now unless the stored result is under a minute old; one never checked over SSH (joined with the join command) waits for Check again |
| `POST /servers/:id/validation` | Server access | Signs in and checks now (read-only); two checks of one server at once share one sign-in |
| `GET /servers/:id/security-audit` | Server access | `{ audit: AuditView \| null }` |
| `POST /servers/:id/security-audit` | Server access | Signs in and reads now (read-only) |

Both checks only read the server, so anyone who can see it may run them; changing anything still needs the server's manage rights (spec 30, decisions part 2, R3-06). The Agent's `validate_server` and `security_audit` follow the same rule.

`ValidationView`: `{ checkedAt, checks: { id, label, mandatory, state: "ready" | "not_ready" | "version" | "unknown", value }[], ok, verdict }`. Mandatory: Docker (version, with Compose and buildx), Nearzero's folders, the builders (each pinned version), rclone, the container runtime (Docker Engine, not rootless), passwordless sudo and Docker group membership (non-root users), the private network, the router (running, as which user) and the runner (connected, its version). Optional: swap, monitoring. Verdicts: "All mandatory checks passed and the server is ready for deployments.", "Nearzero reports this server as X (Y). Finish setup before deploying.", "Mandatory checks still missing: …", "Nearzero could not confirm every mandatory server check." (also when the server can't be signed in to, with the reason).

`AuditView`: `{ checkedAt, items: { id: "firewall" | "ssh_password" | "ssh_keys" | "ssh_root" | "intrusion_ban", label, state: "good" | "attention" | "unknown", value, recommendation }[], error }`: ufw, firewalld or iptables, and whether it denies incoming traffic by default (ufw's default incoming policy, the firewalld default zone's target, an iptables DROP or REJECT policy or catch-all rule); an active firewall that lets in what no rule mentions needs attention. `sshd -T`'s password, keyboard-interactive, key, PAM and root settings. fail2ban, sshguard or CrowdSec running, installed or absent, whether it starts on boot (systemd or OpenRC), and for fail2ban whether an SSH jail is on: running without one, or not starting on boot, needs attention (R3-07).

Validation and the audit read the server over SSH (the break-glass path of D1) and ask the runner's link whether the runner is connected.

## Daily Docker cleanup (spec 9.4, 14.4, 15.3)

| Endpoint | Needs | Request | Response |
| --- | --- | --- | --- |
| `GET /servers/:id/docker-cleanup` | Server access (host: instance administrator) | | `{ cleanup: { enabled, defaultEnabled, description, timeZone, nextRunAt, last: { at, freedBytes, freedText, error } \| null } }` |
| `PUT /servers/:id/docker-cleanup` | Add and remove servers on that server (host: instance administrator) | `{ enabled }` | the same; audited `server.docker-cleanup-changed` |

On by default for the host, off for other servers (`server.docker_cleanup`, also settable through `PATCH /servers/:id`). One scheduler job (`servers.docker-cleanup-tick`) ticks every 5 minutes on the grid, each tick booking the next with an idempotency key; a target whose 23:50 (in the time zone its runner reports) passed less than an hour ago gets one `servers.docker-cleanup` job per local day (key `docker-cleanup:<target>:<date>`), which sends the runner `system.prune { images: "unused", buildCache: true }`. A cleanup that ran writes the notification event `server.docker-cleanup` to `notification_outbox` with `{ server: { id, name }, freedBytes, freedText, localDate, ranAt }` (dedupe key as above; the host's goes to the first workspace). Failures are kept on `last.error` after three attempts.

## Deleting a server (spec 9.6)

- `DELETE /servers/:id` without services: as before (`{ deleted: true, message: "Server deleted" }`), then a job (`servers.uninstall-runner`) signs in when it can and removes the runner's service, settings, binary and credential. The credential is revoked either way.
- With services and without `?deleteServices=true`: 409 "Server has active services, please delete them first".
- With `?deleteServices=true` (the dialog's checkbox): 202 `{ deleted: false, removal, message }`. Each project's services on the server become one delete run (the same runs, items and teardown as a project delete), carried out by one job (`servers.remove`); the person needs delete rights on every one of them. When every service is removed, the runner is removed from the server over SSH (when reachable) and the server's records go; otherwise the server is kept with each service's reason.
- `GET /servers/:id/removal` → `{ removal: { id, state, server, message, items: { serviceId, name, projectName, environmentName, state, reason }[], counts, createdAt, finishedAt } | null }`, also after the server is gone.

Docker, the router container and the server's data are left on the server.

## Settings

| Setting | Meaning |
| --- | --- |
| `NEARZERO_SSH_STRICT_HOST_KEY_CHECKING` | true: refuse servers whose host key wasn't recorded or trusted (default false) |
| `NEARZERO_RUNNER_BINARIES_DIR` | The compiled runners and their `SHA256SUMS` (`runner/scripts/build.ts`), as plain files or gzip-compressed (`<file>.gz`; `SHA256SUMS` lists the binaries themselves). Default: `$NEARZERO_APP_DIR/runner-binaries` when it exists (the image compiles all four there, compressed), else `runner/dist` of the checkout |

Setup writes the runner's settings from the install: the encrypted address servers reach (an `https://` `NEARZERO_RUNNER_CONTROL_URL`, the console's hostname once its certificate is valid, or Nearzero's own TLS port on its public IP with `NEARZERO_CONTROL_FINGERPRINT=sha256:<hex>`; never a plain `http://` one, and setup stops with `no_control_address` when there is none; docs/runner-protocol.md), `NEARZERO_ACME_EMAIL`, the install's router image and builder pins (G4-18), and `NEARZERO_RUNNER_CONTAINERIZED=false` (which now wins over guessing from `/.dockerenv`).

## Audit events

`server.setup-started`, `server.setup-finished` (`result: ready | failed`, `kind`), `server.updated` (the wrong-user button), `server.host-key-trusted`, `server.host-key-forgotten`, `server.docker-cleanup-changed`, `server.delete-started`, `server.deleted`.

## Console

The Servers page mounts `ServerSetupDialogs` in `[data-server-setup-mount]` and asks for the dialogs with `nz:server-setup` and `nz:server-details` (`client/servers.ts`). **Server setup**: the name, `user@address:port`, the state badge, the DNS card, the notice, the state line with a 15-segment progress, the failure with its next step (**Use <user> and run setup again**, **Trust this host key and run setup again**, the fix command with Copy, **Run setup again**), and "Setup logs · live" with Copy. On success: the toast "Server setup completed"; a run the dialog followed that fails: the toast "Setup failed" (G3-08); with the DNS record still missing it stays open with "Server setup completed. Add the DNS record above so apps here get their own address.", otherwise it closes and the page reloads. **Server details**: address, port, user, SSH key, host key fingerprint, setup finished, runner, description, the DNS card, the validation grid and verdict (Check again), the security audit (Run audit), the daily cleanup switch, and a placeholder for monitoring (spec 14.2). A ready server's `nz:server-setup` opens the details.

## Tests

- `apps/control/test/server-setup-rules.test.ts`: messages, parsing (wrong user, sudo, facts, ports, audit), swap, verdicts, the cleanup time, redaction, and the script rules for every family, init system and user.
- `apps/control/test/server-setup.test.ts`: runs against a scripted SSH server (wrong user and the button, sudo, key rejected, unreachable, unsupported, host keys and strict mode, a failed step's sentence, already running and stalled, permissions, the cleanup switch, deleting with services).
- `e2e/server-setup/setup.e2e.ts` (`bun run --cwd e2e test:server-setup`, behind the DinD lock): Ubuntu 24.04 with systemd refusing root, a user without passwordless sudo, and Alpine without bash or an init system, as privileged containers with Docker inside.
