# 31. Parity round 3 (2026-11-28)

After round 2 landed, the owner asked for another full comparison with release 0.1.79. Four parity reviewers checked that each round 2 gap really works, then looked deeper for gaps nobody had listed. They wrote it all down in behavior only:

| File | Area | Still broken from round 2 | New gaps |
| --- | --- | --- | --- |
| [31a-identity-shell.md](31a-identity-shell.md) | Identity, the shell, settings | R1-02 | G1-01 to G1-14 |
| [31b-projects-apps-databases.md](31b-projects-apps-databases.md) | Projects, apps, Compose, databases, deployments | R2-11 | G2-01 to G2-08 |
| [31c-servers-domains-ops.md](31c-servers-domains-ops.md) | Servers, domains, tasks, analytics, notifications, backups | R3-03, R3-10, R3-11, R3-37 | G3-01 to G3-21 |
| [31d-agent-api-tech.md](31d-agent-api-tech.md) | The Agent, the API, jobs, security, the installer | R4-01, R4-02, R4-03, R4-09, R4-14 | G4-01 to G4-24 |

## How to use these files

The rules of [30](30-parity-round-2.md) apply here too:
- Each item's **"Expected 1.0"** line is spec and an acceptance test. Where it conflicts with an earlier spec file, it wins.
- Where an item offers a choice, the decision below settles it.
- The owner's look decisions (21.2, 21.7, 21.9a, 21.9b, 21.10), [27-dropped.md](27-dropped.md) and the decisions in 30 still stand.
- The "0.1.x" text describes behavior only. Build 1.0's own way of doing it.
- Each file's "Notes on the spec" lists stale or contradictory lines in earlier chapters. Fix those chapters to match, as part of the item they belong to.

## Decisions

- **Confirmed addresses on a server without email** (31a R1-02, G1-02; replaces part of the round 2 B1-63 decision):
  - An account created from an invitation link that an instance administrator made counts as confirmed, the same as an account added with a password.
  - When the server can't send email, Profile doesn't offer "Send confirmation link".
  - On a server that can't send email, an instance administrator can change another account's email address in Members. So can `sudo nearzero set-email <old> <new>`. The new address counts as confirmed, the change is audited, and the account's other sessions end.
  - Profile's refusal says how: "Ask a Nearzero administrator to change it in Members, or run sudo nearzero set-email on the server."
  - With email set up, the round 2 rule stands: a new address counts only once its link is opened.
- **Capability names** (31a G1-06): the policy and access dialogs use 0.1.79's groups and names, including "Workspace settings" with Manage certificates, "Manage DNS" and "See Traefik files". Spec 4.7's table is amended to match, as 21.10 asks.
- **`reset-password`** (31a G1-01): follow G1-01's acceptance lines. Spec 3.4 gains its input lines: the email (an empty line means the owner), then the password.
- **Remote runners are always encrypted** (31c G3-01; 25 D1, 22.5):
  - A remote runner never uses a plain `http://` or `ws://` control address, and setup refuses to give it one.
  - Without a domain, the control plane serves the runner link over TLS with a certificate of its own. It makes that certificate at install and keeps it across restarts and upgrades.
  - The setup and join commands carry the certificate's SHA-256 fingerprint. The runner accepts only a certificate with that fingerprint at that address.
  - Once the console's domain has a valid certificate, the control plane gives every connected runner the `https://` domain address, and the runner moves to it without setup being run again. Blocking ports 3000 and 4321 afterwards leaves every server connected.
  - No remote runner ever falls back to, or follows a move to, a plain or unpinned address (amended after the C4 review). 1.0 hasn't been released, so no server in the field depends on a plain link.
    - A remote runner whose only address is plain refuses to connect, and its server's page says to run setup again.
    - A move is followed only to an `https://` address that is the console's own domain with a publicly valid certificate, or to the pinned TLS port with its fingerprint.
  - The Nearzero host's own runner keeps its internal address on the host's private network.
- **Cron syntax** (31c G3-14): take the first option. Tasks and backup schedules accept "L", "nL", "#" and "?" as 0.1.x did, and moved tasks and schedules that use them keep their rhythm. Spec 12.2 lists the accepted syntax.
- **0.1.x's own scripts** (31d R4-02, G4-02):
  - 1.0 prints `https://cdn.nearzero.dev/releases/0.1.80/install.sh` and `https://cdn.nearzero.dev/releases/0.1.80/uninstall.sh` for 0.1.x's installer and uninstaller, each with a `.sha256` beside it.
  - The final 0.1.x release publishes both files there. That part belongs to the 0.1.x side and is done there.
- **Job lanes** (31d R4-03; tightens the round 2 decision): every kind of long work has its own lane, so no kind can use up the workers another kind needs. The kinds are backups and restores, task runs, server setups, and deletes. Follow R4-03's acceptance lines.
- **Long actions** (31d G4-13): for every console action whose control plane route can run past 30 seconds, the console waits at least as long as that route's own limit. Examples are Test connection, the restore file list, Check again, the audit, large Analytics reads and Delete all request logs. The 30-second message stays only for routes that end within 30 seconds.
- **The per-server deploy limit** (31b G2-05; refines the round 2 job-lane decision): only builds count toward the one-at-a-time limit per server. Reload, database deploys, image-only deploys, and Make public or Make private start at once.
- **Removing a server through the Agent** (31d G4-01): follow 9.6. The Agent refuses to remove any server that still has services, running or stopped. Where 20.9 says otherwise, 20.9 is amended.

## Decisions on the round 3 bug reports

The clean bug reports are kept outside this repository (C1 control plane and API, C2 runner and installer, C3 console and Agent). Each finding's "Expected" line is spec. These settle the ones that asked for a choice:

- **Mail that proves an address uses only the install's email settings** (C1-01; 24 G5, G9, 04 4.5, 4.6):
  - Confirmation links, email-change notices to the old address, and password reset mail go only through the email settings an instance administrator set for the whole install. They never go through a workspace's own Resend key or SMTP server.
  - When the install has no email settings, that mail can't be sent, and the no-email rules above apply.
  - An invitation sent through a workspace's own settings still works as an invitation. Its link doesn't prove the address, though. An account created from it starts unconfirmed, unless an instance administrator made the invitation.
- **A host approval covers an app's whole definition** (C1-04; 24 G3, 22.5):
  - An instance administrator's approval of an app on the Nearzero host covers everything that shapes what runs: source, builder, commands, mounts, variables (names and values after references are filled in), published ports, the service port, routes and resources.
  - Any change to those needs a new approval before the next deploy on the host, as for Compose (B1-06).
- **Shared variable values** (C1-20; replaces the round 2 B1-33 decision):
  - Every service in an environment receives its shared variables, so anyone who can deploy a service there, edit its variables or open its terminal can read their values anyway.
  - The rule follows that. Anyone who can see the environment sees the names. Anyone who holds the variables capability, the deploy capability or the terminal for at least one service in the environment may also see the values.
  - Editing shared variables still needs the variables capability for the whole environment.
- **Invitation limits** (C1-21, C1-22; 23.9, 22.4 rule 9):
  - One person may send at most 20 invitation emails an hour and 100 a day.
  - A workspace may hold at most 100 pending invitations.
  - Resends claim their 30-second slot before sending.
  - The email's opening words are fixed text: "You've been invited to join <workspace> on Nearzero." Then the inviter's name and email address come in a separate line: "Sent by <name> (<email>)". The name is at most 60 characters.

## Planned, not built yet: servers that can't reach Nearzero (2026-11-28)

> **Status:** planned. The owner deferred this on 2026-11-28, so 1.0 doesn't do it yet. Today a remote server must be able to reach Nearzero's runner link: its domain, or its TLS link port (3443) on the host's public address.

0.1.x managed a server with nothing but SSH from the platform to the server, so a platform on a laptop or behind NAT could still manage a cloud server. 1.0's runner has to connect to Nearzero. That fails when Nearzero's address isn't reachable from the server: an install on a laptop, behind NAT, or with a loopback or private address. The owner hit this while testing. This closes the gap:

- **Setup decides the path.** Setup's reachability check (the quick fix on `quickfix-reach`) runs from the server. If the server reaches the runner link's address directly, the link is direct, as now. If it can't, setup doesn't stop: it sets the server up to connect **through SSH**, and the log says why.
- **Through SSH:**
  - The control plane keeps its own SSH session open to the server, with the same saved key, user and recorded host key setup uses.
  - That session holds a remote port forward bound only to the server's loopback (127.0.0.1, a free port that setup picks and writes into the runner's settings). The forward leads to the control plane's runner link TLS port.
  - The runner connects to `https://127.0.0.1:<port>` with the usual pinned fingerprint. TLS and the pin run end to end through the tunnel, so the tunnel carries only encrypted bytes.
- **Kept alive:**
  - The control plane reopens the session by itself, with backoff, after drops and after its own restarts. Keepalives detect a dead session.
  - The server's page says "Connected through SSH". When the session can't be opened, the page says "Nearzero can't reach this server over SSH" with the SSH error.
  - SSH sessions are opened only for servers set up this way.
- **SSH hardening keeps it working.** Setup's SSH settings (step 14) still turn off forwarding for everyone else. They allow remote forwarding only for the setup user, and only to that loopback port: `PermitListen 127.0.0.1:<port>` in a `Match User` block where the OpenSSH version supports it, otherwise the closest safe form, named in the log.
- **Switching paths:** Run setup again decides the path afresh. So a server set up through SSH moves to a direct link once Nearzero has an address the server can reach, for example after a domain is added. The server page suggests running setup again when that becomes possible.
- **The Nearzero host** is unchanged.
