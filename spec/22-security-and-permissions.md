# 22. Security and permissions

## 22.1 Who is who

| Role | Scope | How someone gets it |
| --- | --- | --- |
| **Instance administrator** | The whole install: the Nearzero host and everything global | Owner or admin of the **first workspace** (the one the installer's owner set up). Never "owner of whatever workspace is active", because every person owns a personal workspace. |
| **Owner** | One workspace | Creates the workspace, or is the installer's owner. One per workspace; cannot be given away or removed. |
| **Admin** | One workspace | Given by the owner (or by another admin, promoting a member) |
| **Member** | One workspace, limited to what is granted | Invitation, or added with a password by an instance administrator |

Capabilities and access policies ([04](04-identity-and-access.md) 4.7) only widen what a member can do. A member who creates a project or a service (with its copies) gets direct access to what they created, so it never vanishes from their own view; creating an environment does not widen their access to the copies inside it. Owners and admins already reach everything in their workspace. Nobody edits their own access or role.

## 22.2 What only instance administrators can do

- Add, rename (and, if ever offered, delete) workspaces.
- Add people with a password.
- Deploy to, run tasks on, open a terminal on, and read containers, stats, logs and router files of the Nearzero host; or allow a workspace to deploy to the host. People in an allowed workspace may place their services on the host; the host's own containers, logs, metrics and router files stay with instance administrators.
- See Analytics (requests for every workspace).
- Configure the console's public domain and correct the server IP.
- Receive "Nearzero restart" notifications (their workspace only).

## 22.3 Permission matrix (defaults)

"Own services" means the projects, environments and services a member was given. ✓ allowed, — refused.

| Action | Owner / Admin | Member (default) | Member capability that adds it |
| --- | --- | --- | --- |
| See projects, environments, services | ✓ all | own services | (policy scope) |
| Create projects | ✓ | — | Create projects |
| Rename and describe projects | ✓ | — | Create projects |
| Delete projects | ✓ | — | Delete projects |
| Create / delete environments | ✓ | — | Create environments / Delete environments |
| Rename environments | ✓ | — | Create environments |
| Create / delete services | ✓ | — | Create services / Delete services |
| Deploy, start, stop, reload, cancel, terminal | ✓ | own services | |
| Configure a service (source, builder, ports, mounts, autodeploy, webhook) | ✓ | — | Create services |
| Edit service variables | ✓ | own services | |
| See shared variable names | ✓ | environments they can see | |
| Show shared variable values | ✓ | environments where they have a service (they receive them, C1-20) | |
| Edit shared variables | ✓ | whole environments only | |
| Add / remove hostnames on services | ✓ | own services | |
| Certificates | ✓ | — | Manage certificates |
| DNS zones and environment defaults | ✓ | — | Manage DNS |
| Database and volume backup schedules, run now | ✓ | own services (with a usable destination) | |
| Restore backups | ✓ | own services | |
| Destinations: use / manage | ✓ / ✓ | — / — | Back up to the workspace's destinations / Add and remove backup destinations |
| Tasks in service containers | ✓ | own services | |
| Tasks on servers | ✓ | — | Add and remove servers |
| See servers | ✓ | granted servers | (policy scope) |
| Add, edit, set up, delete servers; server terminal | ✓ | — | Add and remove servers |
| SSH keys: use / manage | ✓ / ✓ | — / — | Use the workspace's SSH keys / Add and remove SSH keys |
| Git accounts: use shared / connect own | ✓ / ✓ | shared ones / — | (policy scope) / Connect their own Git accounts |
| Notification channels | ✓ | — | Manage notification channels |
| Router files on managed servers | ✓ | — | See Traefik files |
| Deployments list and logs | ✓ | own services | |
| Members, invitations, policies | ✓ (admins only for members) | — | — |
| Agent policies, API keys, workspace email | ✓ | — | — |
| Use the Agent | ✓ | ✓ (within all of the above) | |

The Agent applies the same matrix for the person who asked, plus Agent policies ([19](19-agent.md) 19.9).

## 22.4 Rules every request follows

1. **Workspace boundary**: every object an action touches (service, project, environment, deployment, server, key, provider, destination, channel, backup file) must belong to the active workspace. This holds for owners and admins too.
2. **Ownership of logs and streams**: a deployment's log belongs to its service, its server, or the host; access follows the owner. Live streams (logs, terminals, metrics) check access before sending anything.
3. **Hide existence**: a person without access to something gets the same answer as for something that doesn't exist, except in the Agent, which resolves names only among what the person can access.
4. **Host containers**: containers on the host map to services by their labels; Nearzero's own containers are reserved and never reachable through service actions. So are its own volumes, which no backup copies and no restore writes over: `nearzero-postgres-data`, `nearzero-runner-state`, `nearzero-runner-handoff`, `nearzero-runner-link` (the runner link's certificate and key), `nearzero-router-certificates`, `nearzero-buildkit-state` and each backup run's scratch volume (`RESERVED_VOLUMES`, C4-10).
5. **No browser trust**: internal page-data requests go to a fixed internal address and never follow forwarded host headers.
6. **Secrets** are encrypted, never returned, never logged, and never shown to the model ([23](23-non-functional.md) 23.4).
7. **Constant-time** comparison for every token, signature and secret.
8. **Audit**: sign-ins, member and policy changes, Agent actions and refusals, key changes, server setup, deletes, and request-log wipes are recorded with who, when and from where. (Today audit events are produced and discarded; 1.0 stores them for 90 days. A viewer is not in 1.0; `sudo nearzero logs` and an export command can read them.)
9. **Rate limits**, all counted in the database so they survive a restart:
   - sign-in: 10 failures per email and client address per 15 minutes, with a backstop of 50 per email from all addresses (4.1); 3 two-factor attempts per 10 seconds per account;
   - sign-up through an invitation: 3 attempts per client address per 10 seconds and 10 per 15 minutes, whatever each answers, then 429 "Too many sign-up attempts. Please try again in N seconds." with a Retry-After header (31d G4-14);
   - invitations: a resend at most once per 30 seconds per invitation, the slot claimed before sending; each person sends at most 20 invitation emails an hour and 100 a day (past that, the invitation is created and its link given instead); a workspace holds at most 100 pending invitations (the C1-21 and C1-22 decisions in 31);
   - webhooks (one queued deploy per service per burst), Agent messages (one turn per chat).

## 22.5 Server trust boundaries

- Docker access on a server is root-equivalent. Setup recommends a dedicated server and a dedicated SSH identity, records the host key fingerprint, and offers strict host key checking.
- Ports 3000 and 4321 on the control plane are plain HTTP and are not a public edge: the installer and docs say to block them once HTTPS works, or bind them to localhost. Remote runners never use them (spec 31 "Remote runners are always encrypted").
- The runner link is always encrypted, and the control plane's identity is always checked: through the console's domain with a publicly trusted certificate, or, without a domain, on the control plane's own TLS port (3443) with a certificate it made at install, which runners pin by its SHA-256 fingerprint (given in the setup and join commands). The runner checks the certificate on each connection before it writes anything (its credential, a join token), for every request it makes; a public authority's certificate counts only by name, never for an IP address or at a pinned address. No remote runner uses, falls back to or is moved to a plain or unpinned address, and one that reaches the control plane over plain HTTP gets no work. Port 3443 carries only runner routes; once every server has moved to the domain it may be blocked too, but every server, also one set up on the domain, keeps it with its fingerprint as the fallback it tries when the domain stops answering. The pair is replaced with `sudo nearzero runner-link rotate` and `switch`, which gives every server the new fingerprint over its current link before the switch; a runner given a newer fingerprint never accepts the replaced one again, whatever its settings say, and the replaced key is deleted once every server has reconnected, or after 7 days. Pinned connections are TLS 1.3 only. The Nearzero host's own runner, on the host's private network, is never moved and takes no address from its link.
- The router's dashboard, the Docker socket proxy and the monitoring port are never public. The router runs with all capabilities dropped.
- Authoritative DNS runs only on the control-plane host; app servers expose only 80 and 443 (and SSH).
- Privileged Compose options are host-administrator power (G3).

## 22.6 Agent-specific safety

Summarized from [19](19-agent.md): the model never sees secrets; production changes need a separate typed opt-in; deletions need explicit confirmation forms; the Agent can't run arbitrary commands on servers; every Agent action is audited with the person who asked; the system prompt can't be replaced from chat.

**Acceptance**: the members end-to-end suite exercises every row of 22.3 through the console, the API and the Agent, with an allowed case, a refused case, and a cross-workspace case.
