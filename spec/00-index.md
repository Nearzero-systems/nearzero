# Nearzero 1.0 product specification

This specification describes what Nearzero 1.0 does: what people see, do and get, with rules, limits, error cases and acceptance criteria. It contains no code and does not describe how today's code is built. Engineers build 1.0 from these files alone.

Status: draft for the owner's review, written 2026-11-25 against the behavior of release 0.1.77.

## How to read it

- Quoted text in "double quotes" is the wording people see. Keep it unless a later review changes it.
- "Today" describes 0.1.77; "1.0" describes what to build. Where they differ, 1.0 wins.
- **Acceptance** lists are the tests a milestone must pass ([26-build-plan.md](26-build-plan.md)).
- Capabilities the Agent has must also exist in the console (principle 1 in [01-vision.md](01-vision.md)).

## Files

| # | File | Covers |
| --- | --- | --- |
| 01 | [01-vision.md](01-vision.md) | Vision, positioning, audience, what 1.0 must do on day one, product principles |
| 02 | [02-concepts.md](02-concepts.md) | Concepts and how they relate |
| 03 | [03-install-and-cli.md](03-install-and-cli.md) | Install, upgrade, uninstall, the `nearzero` server command |
| 04 | [04-identity-and-access.md](04-identity-and-access.md) | Sign-in, registration, onboarding, workspaces, invitations, profile, members and access policies, model and research keys |
| 05 | [05-projects-environments-variables.md](05-projects-environments-variables.md) | Projects, environments, service copies, variables |
| 06 | [06-applications.md](06-applications.md) | Applications: sources, builders, deploys, push deploys and webhooks, logs, terminal, ports, mounts |
| 07 | [07-compose.md](07-compose.md) | Compose |
| 08 | [08-databases.md](08-databases.md) | The six databases, connection URLs, public ports, backups and restore |
| 09 | [09-servers-and-ssh-keys.md](09-servers-and-ssh-keys.md) | Servers, setup, validation, security audit, the server DNS card, SSH keys |
| 10 | [10-domains-and-certificates.md](10-domains-and-certificates.md) | Hostnames, per-server hostnames, managed DNS, certificates |
| 11 | [11-deployments.md](11-deployments.md) | The deployments list and detail, the notifications bell |
| 12 | [12-tasks.md](12-tasks.md) | Scheduled tasks |
| 13 | [13-analytics.md](13-analytics.md) | Request logs and analytics |
| 14 | [14-monitoring.md](14-monitoring.md) | Metrics and alerts |
| 15 | [15-notifications.md](15-notifications.md) | Notification channels and events |
| 16 | [16-git-providers.md](16-git-providers.md) | GitHub, GitLab, Bitbucket, Gitea |
| 17 | [17-backup-destinations.md](17-backup-destinations.md) | Destinations, volume backups, shared backup rules |
| 18 | [18-settings.md](18-settings.md) | Settings hub, About Nearzero, router files |
| 19 | [19-agent.md](19-agent.md) | The Agent: chat, sessions, lifecycle, guided flows, secure forms, policies, provider, attachments, research, safety |
| 20 | [20-agent-capabilities.md](20-agent-capabilities.md) | Everything the Agent can do, with its policy gate |
| 21 | [21-design-system.md](21-design-system.md) | Light, Dark and Dusk themes, tokens, fonts, layout, phone layout, plain-HTTP constraints |
| 22 | [22-security-and-permissions.md](22-security-and-permissions.md) | Roles, instance administrators, permission matrix, request rules |
| 23 | [23-non-functional.md](23-non-functional.md) | Reliability, upgrades, secrets, performance, compatibility, accessibility, privacy |
| 24 | [24-known-gaps.md](24-known-gaps.md) | Problems in today's product that 1.0 must close |
| 25 | [25-open-decisions.md](25-open-decisions.md) | Architecture, license for paid parts, migration from 0.1.x, the 1.0 stack, smaller decisions |
| 26 | [26-build-plan.md](26-build-plan.md) | Milestones, definition of done, test strategy |
| 27 | [27-dropped.md](27-dropped.md) | What 1.0 does not build |
| 28 | [28-clean-room.md](28-clean-room.md) | Clean-room roles, rules and provenance checks |
| 29 | [29-migration.md](29-migration.md) | Moving a 0.1.x install to 1.0: the export bundle and import rules |
| 29a | [29a-bundle-records.md](29a-bundle-records.md) | The export bundle field by field: bytes, manifest, every record kind and its labels |
| 30 | [30-parity-round-2.md](30-parity-round-2.md) | Parity round 2 (2026-11-27): every remaining gap with 0.1.79, as acceptance lines (30a to 30d) |
| 31 | [31-parity-round-3.md](31-parity-round-3.md) | Parity round 3 (2026-11-28): round 2 gaps still broken and new gaps with 0.1.79, as acceptance lines (31a to 31d) |

## Changes from today's product at a glance

1.0 keeps today's behavior unless a file says otherwise. The deliberate changes:
- The console gains what only the Agent or the API could do: creating Compose services, app ports and mounts, runtime logs for apps and databases, server security audit, service and server tasks on the Tasks page, removing hostnames and zones, renaming and deleting environments, Bitbucket and Gitea source editing, database Start and image change, per-server metrics and alert thresholds, a Profile link, cancelling deployments.
- Security gaps in [24-known-gaps.md](24-known-gaps.md) are closed.
- "Workspace" replaces "organization" in everything people read, except where [21-design-system.md](21-design-system.md) 21.10 keeps the original's word (the organization switcher and its dialogs, and wording shown on the 0.1.79 screens).
- Items in [27-dropped.md](27-dropped.md) are not built.
