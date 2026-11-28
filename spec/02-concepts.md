# 02. Concepts and relationships

This file defines the nouns used everywhere else. It describes how they relate as a person experiences them; it is not a data model.

## 2.1 The map

```
Install (one control plane)
├── Instance administrators (owners/admins of the first workspace)
├── Nearzero host  ── also a deploy target
└── Workspaces
    ├── Members (owner, admins, members) ── access policies, capabilities
    ├── Servers ── SSH keys
    ├── Git providers (owned by a person, optionally shared)
    ├── Backup destinations
    ├── Notification channels
    ├── DNS zones, uploaded certificates
    ├── Agent: sessions, policies, model and research keys
    └── Projects
        └── Environments (development, staging, production, …)
            ├── Shared variables
            └── Services: application | Compose | Postgres | MySQL | MariaDB | MongoDB | Redis | libSQL
                ├── runs on one server (or the Nearzero host)
                ├── own variables
                ├── hostnames (apps and Compose)
                ├── deployments (each with a log)
                ├── backups (database or volume)
                └── tasks (in its container)
```

## 2.2 Definitions

**Install / control plane**: one Nearzero installation on one Linux server: the console, the API, the Agent, monitoring, the bundled database and the router. Everything is managed from it.

**Nearzero host**: the machine the control plane runs on. It is also a place to deploy, for instance administrators and the workspaces they allow.

**Instance administrator**: an owner or admin of the first workspace. Controls host-level things for everyone on the install.

**Workspace**: the unit of ownership and access. Every person has a personal workspace and can belong to others. Everything below belongs to exactly one workspace. A workspace has a name and a web address segment (its slug).

**Member**: a person's membership in a workspace, with a role: **owner** (one per workspace), **admin**, or **member**. Members reach only what they are granted.

**Capability**: a named right added to a member (for example "Create projects", "Add and remove servers").

**Access policy**: a reusable bundle of capabilities plus a scope (which projects, environments, services, servers and Git accounts), attached to many members. A member's access is the union of their direct grants and their policies.

**Invitation**: a 7-day link for one email address to join a workspace with a role and policies.

**Project**: a group of related services (an app, its database, its workers). It has one or more environments.

**Environment**: one copy of a project's services with their own variables, data and hostnames: for example development, staging, production. Every project starts with "development". An environment named "production" is production: it gets a badge and the Agent's production gate.

**Service**: one runnable thing inside an environment, of one of eight kinds:
- **Application**: one container built from Git, an uploaded archive, or a container image.
- **Compose**: a multi-container stack from a Compose file (Compose or Stack format).
- **Database**: PostgreSQL, MySQL, MariaDB, MongoDB, Redis or libSQL, each with a generated password, its own data volume, an internal URL and (by default) a public port.

**Service copies**: every environment of a project holds the same services. Adding a service adds a linked, undeployed copy to the other environments, with variable names but no values. Deleting asks which copies go.

**Variables**: name and value pairs delivered to a service at deploy. Two levels: the environment's **shared variables** and the service's **own variables** (own wins). Values are secrets.

**Server**: a Linux machine added over SSH (address, port, user, key), set up by Nearzero (Docker, router, builders, monitoring), and checked. A service runs on exactly one server or the host. A server has a fixed **label** used for its hostnames.

**SSH key**: a key pair stored in the workspace, used to sign in to servers and to clone Git repositories over SSH. Private keys are never shown again.

**Router**: the reverse proxy on every server (Traefik today) that receives web traffic on ports 80 and 443, terminates HTTPS and routes each hostname to its service.

**Hostname (domain)**: a name that routes to a service's port and path, with HTTPS. It comes from the **platform domain**, a **per-server wildcard** under it, a **managed DNS zone**, or the person's **own domain**.

**Platform domain**: the domain given at install; its wildcard record gives generated hostnames.

**Managed DNS zone**: a zone served by Nearzero's built-in DNS server, where Nearzero writes records itself. The first one becomes every environment's default.

**Certificate**: an HTTPS certificate per hostname from Let's Encrypt, requested only once DNS points at the right server; or an uploaded certificate.

**Deployment**: one run of building and starting a service, with status, log, commit and trigger. The newest successful one is **Active**; older successful ones are **Previous version**.

**Push deploy**: a deployment triggered by a Git push (through the GitHub App, or a service's **deploy webhook** URL).

**Task**: a script that runs on a schedule or on demand, in a service's container, on a server, or on the host; each run has a log.

**Backup destination**: S3-compatible storage for backups.

**Backup schedule**: for a database (a dump) or a volume (an archive), with a cron, folder and "keep N"; each run has a log.

**Notification channel**: where event messages go (Slack, email, a webhook, and nine more).

**Agent**: the chat that operates Nearzero for a person, under their permissions and the workspace's **Agent policies**. A **session** is one chat; a **turn** is one question and the work that answers it; **steps** are the actions it took; **secure forms** collect secrets without the model seeing them.

**Model key / research key**: the workspace's own OpenRouter and Firecrawl keys.

**Request log (analytics)**: the host router's record of every request, summarized for instance administrators.

## 2.3 Relationships and rules

| Relationship | Rule |
| --- | --- |
| Service → server | Exactly one; chosen at creation; fixed in 1.0. |
| Service → environment → project → workspace | Exactly one each. |
| Hostname → service | At most one service (a hostname may exist unconnected); a service may have many hostnames. Compose hostnames name an inner service. |
| Hostname → server | Follows its service's server; certificates are issued on that server. |
| Server → workspace | Exactly one. The Nearzero host belongs to no workspace. |
| SSH key → servers | A key used by any server can't be deleted. |
| Git provider → person | Owned by the person who connected it; visible to others only when shared or granted. |
| Backup schedule → service and destination | Both in the same workspace; volume schedules need the service to mount the volume. |
| Task → place | Exactly one place, fixed after creation. |
| Agent session → workspace | Belongs to a workspace; visibility per decision D4. |
| Copies → group | Each service belongs to one group of copies across the project's environments. |
