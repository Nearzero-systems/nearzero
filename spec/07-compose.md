# 07. Compose

A Compose service runs a multi-container stack from a Compose file, on one server.

## 7.1 Creating

- From the console (new in 1.0; today only the Agent can create one): **Add New → Compose** on a project's Overview, with Name, Server, Description and a source:
  - **From a repository**: provider account (GitHub, GitLab, Bitbucket or Gitea), repository, branch, Compose file path (default `./docker-compose.yml`).
  - **Paste YAML**: a Compose file editor.
  - Compose format: **Compose** (default) or **Stack**. Fixed after creation.
- From the Agent: pasted YAML, or a repository through the guided import ([19-agent.md](19-agent.md) 19.7).
- Values for `${VAR}` placeholders go into the service's variables, never into the YAML. The Agent refuses YAML with inline secret values.
- Copies are added to the project's other environments as for any service.

## 7.2 The Compose page

**Header**: name, a **Compose** or **Stack** badge, and actions (deploy rights): **Deploy**, **Reload** (redeploy), both disabled while deploying; **Start** (Compose format, when stopped) or **Stop**; **Terminal** (pick a container; needs deploy rights). **Autodeploy** switch (configure rights).

Sections on one scrolling page (1.0 may split them into tabs like the app page; the content is the same):
- **Source**, with **Preview Compose** (shows the final file Nearzero runs, after its own additions). Tabs: the four Git providers and **Raw** ("Compose file (YAML)"; saving shows "Compose file saved" and marks the service as needing a deploy). Today only GitHub and Raw work; 1.0 renders all four providers.
- **Deploy webhook**: as for apps ([06](06-applications.md) 6.6); hidden for Raw sources.
- **Logs**: a container picker and live logs (follow, search, Copy).
- **Variables**: [05](05-projects-environments-variables.md) 5.5; delivered to Compose as an env file.
- **Containers**: Name, State, Status, Container id, Refresh; row menu: View logs, Restart, Start, Stop, Kill.
- **Domains**: per inner service, added through the Add domain dialog's "Compose service" field ([10](10-domains-and-certificates.md) 10.6).
- **Volume backups**: [17-backup-destinations.md](17-backup-destinations.md) 17.3.
- **Danger zone**: Delete (today only from the Services list). Deleting a Compose service always removes its volumes, and the dialog says so.

## 7.3 Rules

- The model can never read back a Compose file.
- Privileged options (host network, privileged mode, Docker socket, host paths outside the service's own folder) are refused on the Nearzero host for anyone but instance administrators (G3 in [24-known-gaps.md](24-known-gaps.md)), and shown as a warning on Preview elsewhere.
- Nearzero adds its own network and router labels for domains; Preview shows them.
- Compose never inherits Docker or Compose control variables from shared variables.

**Acceptance**
- A three-service stack from a repository deploys; its web service gets a hostname; its logs show per container.
- A stack pasted with `image: postgres` and `${POSTGRES_PASSWORD}` deploys once the variable is set on the Variables section.
