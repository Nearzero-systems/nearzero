# 18. Settings

## 18.1 Settings hub

Opened from **Settings** in the user menu. `/dashboard/settings` opens About Nearzero.

**Layout**: a left column (about 13.5rem) titled "Settings", the current page's title across the top of the main area. Below 1024px (the same breakpoint as the rest of the phone layout), the heading hides and the links become one sideways-scrolling row with the current link centred.

**Entries, in order** (an entry is hidden when the person can't use it):

| # | Entry | Who sees it | Spec |
| --- | --- | --- | --- |
| 1 | About Nearzero | Everyone | 18.2 |
| 2 | Members & access | Owners and admins | [04](04-identity-and-access.md) 4.7 |
| 3 | Agent policies | Owners and admins | [19](19-agent.md) 19.9 |
| 4 | API keys | Owners and admins | [04](04-identity-and-access.md) 4.8 |
| 5 | Git providers | Owners, admins, and people who may connect or use Git accounts | [16](16-git-providers.md) |
| 6 | Router files | Instance administrators, and people with "See Traefik files" for servers they manage | 18.3 |
| 7 | Backups | People with destination rights | [17](17-backup-destinations.md) |
| 8 | Channels | People with channel rights | [15](15-notifications.md) |

Profile is in the user menu, not in this list ([04](04-identity-and-access.md) 4.6).

Old addresses redirect: the server settings page → About Nearzero; certificates → Domains, Uploaded certificates tab; DNS → Domains. 0.1.79's own page addresses redirect too, with or without the workspace in the path and with their query kept (31a G1-03): `/dashboard/about-nearzero` and `/dashboard/monitoring` → About Nearzero (Settings), `/dashboard/traefik` → Settings → Traefik, `/dashboard/home` and `/dashboard/get-started` → the Agent, and the retired setup wizard (`/setup`, `/setup/<anything>`) → sign-in.

No access: "You do not have access to this section." with "Back to Agent". Failure: "Could not load this page. Try refreshing."

## 18.2 About Nearzero

For everyone, with administrator controls marked below.
- **First-time setup** checklist: the console's address (Ready / DNS / HTTPS pending / Needs setup), the managed DNS zone when configured (ready only when it reads Live in 10.8: delegated in public DNS and answered for by the host, otherwise "Delegation pending" with the reasons, 31c G3-10), "Deploy the first application". Each item links to where it's done.
- **Version** (the running Nearzero version) and, when decision D4's update check is accepted, "Update available: <version>" with the install command to run.
- **Server IP** (with Copy). Instance administrators can correct it when detection was wrong (today this control is unreachable, though the domain wizard points to it).
- **Public URL** of the console, and **Configure public domain** for instance administrators ([10](10-domains-and-certificates.md) 10.9).
- **Deploying to the Nearzero host** (instance administrators): which workspaces besides the first may deploy to the host. Default: none (G3 in [24](24-known-gaps.md)).
- **Monitoring** for the Nearzero host ([14](14-monitoring.md) 14.2), for people who may see it.

## 18.3 Router files

An editor for the router's configuration files, for experts. Today it exists for the host as Settings → "Traefik".
- Warning: "Adding invalid configuration to existing files can break your router…".
- A server picker (the host for instance administrators; servers the person manages), a file tree of the router's folder, and an editor with **Edit mode** and **Save** ("Router config updated").
- 1.0 validates YAML and the router's own schema before saving and refuses invalid files with the line and reason (today nothing is validated, and a "Skip validation" switch is shown but ignored). Paths outside the router's folder are refused.
- Files Nearzero generates for services are shown read-only with "Managed by Nearzero; changes are overwritten on the next deploy."

## 18.4 Agent policies and API keys

Specified in [19-agent.md](19-agent.md) 19.9 and [04-identity-and-access.md](04-identity-and-access.md) 4.8.

## 18.5 Settings pages that are not in 1.0

Tags, container registries, the web-server settings panel (reload, Redis cleanup, queue cleanup, GPU setup, router port mappings and environment), custom roles, billing, audit log viewer and white-labeling are not in 1.0. See [27-dropped.md](27-dropped.md).

**Acceptance**: a member with no extra capabilities sees only About Nearzero in the hub; an owner sees all eight entries; every hidden entry also refuses direct access by address.
