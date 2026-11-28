# 30. Parity round 2 (2026-11-27)

The owner asked for a second comparison of 1.0 with release 0.1.79, covering both functionality and technical behavior. Four parity reviewers wrote down every gap they found, in behavior only:

| File | Area | Gaps |
| --- | --- | --- |
| [30a-identity-shell.md](30a-identity-shell.md) | Sign-in, sessions, two-factor, registration, invitations, onboarding, profile, workspaces, members and policies, settings, the bell, the shell, titles, icons and error pages | 10 (4 P1, 6 P2) |
| [30b-projects-apps-databases.md](30b-projects-apps-databases.md) | Projects, environments, variables, applications (sources, builders, deploys, webhooks, logs), Compose, databases, deployments | 16 (7 P1, 9 P2) |
| [30c-servers-domains-ops.md](30c-servers-domains-ops.md) | Servers and SSH keys, domains, certificates, DNS, router files, tasks, analytics, monitoring, notifications, backups, Git providers | 52 (13 P1, 39 P2) |
| [30d-agent-api-tech.md](30d-agent-api-tech.md) | The Agent, the API surface, webhooks, live updates, background jobs, email, security, performance, the installer and the `nearzero` command | 16 (3 P1, 13 P2) |

## How to use these files

- Each gap's **"Expected 1.0"** line is part of the spec. Each one is an acceptance test.
- Where a gap's expected behavior conflicts with an earlier spec file, the gap wins. This includes the gaps marked "spec gap", "spec is wrong" or "spec likely wrong".
- The owner's look decisions (21.2, 21.7, 21.9a, 21.9b, 21.10) and [27-dropped.md](27-dropped.md) still stand. A gap never brings back something 27 drops.
- The "what 0.1.x does" text describes behavior only. Build 1.0's own way of doing it.

## Decisions on the questions the reviewers raised

- **Registration mode values** (30a R1-03): 1.0 accepts `invite_only`, as 0.1.x wrote it, and `invite-only`. Both mean the same.
- **Image sources get a deploy webhook** (30b R2-03, 30d R4-12): 6.6 no longer hides the webhook for image sources. A call to it redeploys the image only when its image and tag match the app's. Upload sources still have none.
- **Pasted repository links** (30d R4-01): 19.7 is updated by R4-01. A link to github.com, gitlab.com, bitbucket.org or codeberg.org goes through the checked import (a connected account first, then a public check, then an access card), not straight to the model.
- **Background work** (30b R2-15, 30d R4-03): deploys get their own worker lane, separate from tasks, backups, setup and deletes. Schedules run on their own timers. A server builds at most one app at a time unless its setting says otherwise.
- **API keys** (30d): 25 D3's line saying API keys move to 1.0 is stale. As 27 and 29a say, personal API keys are not carried.
- **Agent hostnames** (30d): 20.6 drops its "HTTPS" and "certificate" options to match 10.6. There is no per-hostname HTTPS switch.
- **Email confirmation** (30a R1-02): follow R1-02's expected behavior. Accounts moved from 0.1.x count as confirmed.

## Decisions, part 2 (2026-11-28)

These settle the gaps that offered a choice or named a spec gap. Each one is spec, and each is an acceptance test.

- **Server checks are fresh and open to viewers** (30c R3-06, 09 9.4):
  - Opening a ready server's details re-checks its validation unless the stored result is under a minute old. While the check runs, the dialog says "Checking server configuration…".
  - Anyone who can see the server may run "Check again" and the read-only audit. Changing anything still needs the server's manage rights.
- **Connecting the first zone moves automatic hostnames** (30c R3-13, 10.8):
  - A workspace's first connected zone becomes the default for every environment that has none.
  - Every Nearzero-assigned hostname that follows its environment's default moves into the zone at once, as `<service>.<zone>` or `<service>.<prefix>.<zone>`, and its record is published.
  - The Connect result says how many hostnames moved. Own hostnames and hostnames someone typed in are never moved.
- **HTTP/3** (30c R3-22, 09 9.3 step 10):
  - Every router serves HTTP/3 on UDP 443 next to TCP 443, and its HTTPS answers advertise it with an `Alt-Svc` header.
  - If something else already holds UDP 443 on a server, the router starts without HTTP/3 instead of failing. The server's details say "HTTP/3 is off: UDP port 443 is in use by <program>".
  - Setup's firewall step and the firewall reminder keep 443/udp.
- **Router files show the main settings read-only** (30c R3-23, 18.3):
  - Router files lists the route files as now, plus a read-only "Main settings" entry. It shows the router's entry points, certificate resolvers and global options as Nearzero sets them.
  - The entry says "Nearzero sets these when it starts the router, so they can't be edited here." Nothing there is editable.
- **Server tasks run as the server's SSH user** (30c R3-28, 12.2, 12.3):
  - A task on a remote server runs as the user the server was set up with, in that user's home folder, with that user's HOME, USER, LOGNAME and SHELL set.
  - PATH includes /usr/local/bin and /usr/local/sbin, as on a login shell. On a server set up as `ubuntu`, `id -un; pwd` logs `ubuntu` and `/home/ubuntu`.
  - A server set up as root runs tasks as root in /root.
  - Tasks on the Nearzero host are unchanged: they run as root, from /root.
- **Host tasks belong to their creator** (30c R3-29, 12.4):
  - A task on the Nearzero host belongs to the instance administrator who made it. Other instance administrators don't see it in the list.
  - Anyone else who tries to edit, run or delete it through the API gets 403 "You can only manage your own host-level schedules." It is deleted with its owner's account.
  - A host task moved from 0.1.x keeps its 0.1.x owner. If that person wasn't moved, it goes to the person who ran the move.
- **Missed runs are skipped** (30c R3-30, 12.3, 23.2):
  - A due time that passes while the control plane is stopped is skipped, and the task or backup schedule next runs at its next scheduled time. Nothing runs at start just because a time was missed.
  - This is separate from work that was already running when the control plane stopped. That work is resumed or reported as before (the job-lane decision in the round 2 assignments).
- **Storage usage matches `df`** (30c R3-34, 14.2):
  - The percentage is used / (used + available), so space reserved for root counts as unavailable, and a disk `df` reports at 100% reads 100%.
  - Each server's figure is for that server's own root filesystem (`/` in the host's mount namespace), not the runner container's root. Reading it must not give the runner any new writable access to the host.
  - The runner protocol gains the needed fields additively. An older runner's figure is still shown.
- **Published ports are opened in a remote server's firewall** (30b R2-13, 06 6.8, 08 8.2):
  - A deploy on a remote server opens each published port (app ports, Compose ports and database public ports, with their TCP or UDP protocol) in the server's active host firewall: ufw, then firewalld, then iptables. It uses passwordless sudo when the SSH user isn't root.
  - The deploy log names the firewall and the ports, for example "ufw: allowed 9000/udp", and reminds the person that a cloud firewall must allow them too.
  - With no supported firewall active, it logs "No host firewall is active, so no ports were opened". Without passwordless sudo, it logs that it skipped and which ports to allow.
  - When a port stops being published (made private, removed, or the service deleted), the rule Nearzero added for it is removed and the log says so. Rules Nearzero didn't add are never touched.
  - The Nearzero host is not changed by this.
- **A server's public address can't be another workspace's** (B1-15, which still had a hole):
  - Setting a server's public IPv4 to an address that a server in another workspace already uses is refused with "That address belongs to a server in another workspace." The other server is not named.
  - The Nearzero host's address follows the host-access rule that B1-15 already added.
- **Two-factor toast** (30a R1-07): the code step also shows the toast "Enter the code from your authenticator app.", as 0.1.x did.
