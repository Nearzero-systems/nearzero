# 27. Dropped from 1.0

Things that exist in today's code but that people can't use through the console, installer, `nearzero` command or Agent, or that the owner chose not to keep. 1.0 does not build them. One line each.

## Features with no way in

- **Templates (one-click apps)**: a "Create from template" dialog exists but nothing opens it.
- **Preview deployments for pull requests**: run only when an app has previews turned on, which nothing in the console or Agent can do.
- **Rollbacks**: "Instant rollback" and "Rollback" buttons appear only when a rollback record exists, which needs settings with no screen; the Agent's rollback action can never get the reference it needs.
- **Public REST API and its document page**: the REST layer returns 404 for every path, the generated API document has no paths, and the page that would show it is a placeholder. (Decision D4 covers a future API.)
- **Personal HTTP API keys**: the platform can create them, but no screen or Agent action does.
- **"Use the API and CLI" capability**: checked nowhere; there is no app CLI.
- **Container registries**: a backend and a grantable capability, but no screen.
- **Building on the Nearzero host for an app on another server**: needs a registry, which has no screen; builds run on the app's own server.
- **Multi-server clusters (worker and manager nodes)**: backend only; the "Cluster nodes" dialog is never opened.
- **Tags**: a settings page that redirects away and assignment that only the API can do.
- **Custom roles**: the backend allows up to 10, but no screen creates them.
- **Whole-instance (control-plane) backups and restore**: backend only; replaced by `nearzero backup-db` / `restore-db`. The "Nearzero backup" notification event goes with it.
- **Compose database backups**: backend only.
- **Project-level variables**: accepted by the API with no screen; values move into each environment's shared variables during migration.
- **Project duplication and environment duplication**: API only; "Copy names from" in Add environment covers the need.
- **Moving a service to another environment**: API only.
- **App settings with no screen**: redirects, basic auth, replica count, resource limits, health check settings, custom command and arguments, build arguments and build secrets, per-app router configuration, swarm placement.
- **Database settings with no screen**: changing the password after creation, custom start command, editing the public port number, rebuild, moving, duplicating, changing Mongo replica-set mode after creation.
- **Deleting a workspace from the console**: the dialog exists but nothing opens it (the API rule stays).
- **"Set default workspace"**: no button.
- **"Organization" workspace mode in onboarding**: onboarding always chooses the personal mode.
- **Onboarding survey steps** ("Tell us about your setup", "How did you hear about us?"): answers go only to an audit stream the community edition discards.
- **Email verification step, single sign-on registration route, impersonation, user banning**: present in the auth library setup, never enabled.
- **The web-server settings panel**: reload, terminal, logs, GPU setup, server IP update, Redis and queue cleanup, router reload/logs/environment/dashboard/port mappings, space cleanup, "Check for updates"; none of it is mounted. (Server IP correction comes back on About Nearzero.)
- **Hidden dialogs on the Servers page**: web server settings, Docker containers, Cluster nodes, Tasks; never opened.
- **Server alerts with thresholds set only by API**: replaced by the monitoring settings screen in [14](14-monitoring.md).
- **Managed (hosted-edition) Git connections**: refused in the community edition.
- **Billing, SSO, audit log viewer, white-labeling**: switched off in the community edition with no screens.
- **The update check**: a stub that always says "no update" (decision D4 decides whether 1.0 implements it).
- **Telemetry**: proposed and declined; none.
- **Shared edge for the platform domain** (an install setting that sent other servers' apps through the host's router): per-server hostnames replace it.

## Unused screens and components

- The old dashboard home (`/dashboard/home`) and the Get started guide: both redirect to the Agent.
- The standalone monitoring page: redirects to About Nearzero.
- Global search: written but never mounted.
- Demo sections (queues, storage, story, logs, help, API keys mock) and an unused notifications popover, an unused account menu (the one with a Profile link), an older projects view, an environment dashboard, and project analytics, logs and domains panels.
- The settings home page and the tags page components.
- The Agent's unused paths: "verify" and "delegate" actions, branching a chat from a transcript, a standalone log-analysis endpoint, a conversation menu, a multiple-choice accessory above the composer, an answer "sources" row, and the Agent's legacy Compose-suggestion, create-from-suggestion and direct-queue actions.
- Marketing comparison pages and docs pages built into the console (the public site and docs live on their own site).

## Stale files (not product behavior; listed so nobody ports them)

- An outdated database diagram file that lacks newer data.
- A finished console migration note.
- A deployment config for a hosting platform the console doesn't use.
- An unused edition-policy helper.
- A gitignored local build folder missing the owner tool.

## Kept although rarely used

Listed so they aren't dropped by mistake: the Upload (.zip) source, Heroku and Paketo buildpacks, uploaded certificates, environment defaults for DNS zones, router files, `nearzero restore-db`, libSQL replicas and namespaces, Telegram threads and Pushover emergency priority.
