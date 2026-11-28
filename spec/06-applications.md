# 06. Applications

An application is one container built from a Git repository, an uploaded archive, or an existing container image, running on one server, optionally reachable at one or more hostnames.

## 6.1 Creating an application

**Page**: "Create a new application" with "← Overview" and steps **Provider → Repository → Configure**.

**Provider step**
- Cards for GitHub, GitLab, Bitbucket and Gitea. With no account: "No <provider> accounts connected. Connect one to import repositories." with links to Git provider settings and "Connect account" (returns here afterwards).
- "OR" **Public repository URL**: any host over HTTPS or `git@host:owner/repo`. Invalid: "Enter a valid public Git URL (HTTPS or git@host:owner/repo)." The default branch is looked up where the host allows it; otherwise "main". The branch stays editable.

**Repository step**: account picker and "Filter repositories…".

**Configure step**
- Display name and App name. The app name is prefilled from the project and must use lowercase letters, numbers and single dashes, start with a letter and end with a letter or number. "A unique suffix is added automatically" (a dash and 6 random characters).
- Branch; Build path (for monorepos, a picker of detected app folders plus "Custom build path").
- Server (the Nearzero host or a ready server the person can use; see 22 for who may use the host).
- Description.
- Domain: a preview of the generated hostname, **Service port** (default 3000; "Enter a valid service port (1–65535).") and "Also assign a hostname from the workspace's DNS zone" when one exists.
- "Advanced build commands": Install, Build, Start (optional).
- "Environment variables": rows with Show and remove, "+ Add variable", "Paste .env format". Secret-looking names with a public prefix (NEXT_PUBLIC_, VITE_, PUBLIC_, REACT_APP_, NUXT_PUBLIC_) block creation with a warning naming them.
- Builds start in automatic mode: a Dockerfile at the build path is used; otherwise the language is detected (Railpack for known frameworks, else Nixpacks). The builder can be changed afterwards (6.4).
- Buttons: **Create & deploy** (people who can deploy) or **Create application**.
  - Create & deploy switches to a build panel: Queued → Building → "Deployment complete. It's live at: <url>" with Copy and Visit, and the build log with Copy. The panel's title follows the state.
  - If setup fails after the app was created: "…The application was created, but setup did not finish. Open the service to repair it."
- The other environments' copies are reported (see [05](05-projects-environments-variables.md) 5.4).

**Create without Git** (toggle): Name, Server, App name, Container image (optional; examples "nginx:alpine" or "ghcr.io/acme/api:1.2.0"; no spaces), Description. If the image can't be saved, the new app is removed again rather than left half-made.

**Acceptance**
- A public repository with a Dockerfile, created with "Create & deploy", ends live at its generated hostname with no other input.
- An app name that breaks the rules is refused before anything is created.

## 6.2 The application page

**Header**: back arrow, name, and actions (all need deploy rights):
- **Deploy** / **Redeploy** (confirm "Rebuild application"), hidden while deploying.
- **Reload** (restart without rebuilding) when running.
- **Start** when stopped; **Stop** unless stopped or deploying.
- **Terminal** when running (see 6.7).
- **Visit**, or **Create URL** when there is no domain, a generated hostname is available, and the person can add domains.
- Each action confirms first ("Confirm action"). Success toasts name the action; errors stay until dismissed.
- A **"Live at"** banner (address, Copy, Visit, Dismiss) shows once after Create URL or after the creation page.
- While a deploy runs the page follows it and refreshes when it ends.

**Tabs**: **Overview**, **Logs** (new), **Variables**, **Advanced** (new: ports and mounts), **Backups** (when the person can see volume backups), **Settings**.

## 6.3 Overview tab

- Domain (the first hostname, "+N" more, Copy, Visit), or the suggested hostname, or "Add a domain".
- Status, Source, Branch, Repository, Container.
- **Source** panel (collapsible) with tabs:
  - **GitHub**: Account, Repository, Branch, Build path, Trigger (On push / On tag), Watch paths (type and Enter), Submodules. Button "Save & deploy" (or "Save" without deploy rights).
  - **GitLab**, **Bitbucket**, **Gitea**: account, repository, branch, build path, watch paths, submodules. (Today Bitbucket and Gitea show only "Connect … in Settings" even when connected; 1.0 renders them.)
  - **Image**: image (required), registry address, user name, password ("Stored — leave blank to keep").
  - **Git URL**: repository URL (HTTPS or SSH; plain HTTP is refused), branch, build path, SSH key (or none), watch paths, submodules. Credentials inside the URL are refused.
  - **Upload**: build path and a .zip archive, then "Deploy". Maximum archive size 200 MB (today undefined).
  - A repository linked through an account the viewer can't use shows "Disconnect repository".
- **Build** panel (not for image sources): see 6.4.
- **Deployments** list (open by default): title (commit subject), what started it (Manual, Push, Tag, Webhook, Agent, Redeploy), time, short commit, and a status pill (Active, Previous version, Building, Queued, Failed, Cancelled). Clicking a row opens "Deployment logs" with Copy and Close.

## 6.4 Builders

| Builder | Fields |
| --- | --- |
| Automatic (default) | none: Dockerfile if present, else Railpack for known frameworks, else Nixpacks; if a language build fails and the repository has a Dockerfile, it falls back to the Dockerfile |
| Dockerfile | Dockerfile path, build context path, build stage |
| Railpack | Railpack version (a short list of supported versions, newest default) |
| Nixpacks | Publish directory |
| Heroku buildpacks | Stack version |
| Paketo buildpacks | none |
| Static | Single-page app (serve index.html for unknown paths). With install/build commands, they run in a Node image first and the built folder (dist, build, out or public) is served |

All builders accept custom Install, Build and Start commands. Saving makes the choice explicit. Builds always run on the app's own server (dropped: building on the Nearzero host for another server, which needs a registry 1.0 doesn't offer).

Before a build starts, the build machine is checked for the tools the builder needs; a missing tool stops the build with "<tool> is not installed on the build machine" and the fix (re-run server setup).

## 6.5 Deploys

- A deploy: fetch the source (clone at the commit, unpack the upload, or pull the image), build, start the new container, wait until it is healthy and stable (10 seconds of running by default), then route traffic to it and stop the old one. A failure at any step leaves the old version serving.
- An app with published ports can't run two copies on the same ports, so it deploys stop-first, with a short gap; the deploy log says so.
- The container receives `PORT` set to the service port unless the person set their own.
- The deploy log starts with "Initializing deployment (Nearzero <version>)" and streams live. If the new container exits or never becomes healthy, the log ends with its last output and the deploy is "Failed".
- "Clean cache" (Settings) makes the next build start without cached layers.
- Only one deploy per app runs at a time; see 6.6 for queuing.
- A deploy of an app with no domain says so at the end of the log, with the DNS record that would give it one (see [10-domains-and-certificates.md](10-domains-and-certificates.md)).

## 6.6 Push deploys and webhooks

Settings tab → "Deployment settings" (people who can configure services):
- **Autodeploy** switch (on by default for Git sources).
- **Deploy webhook**: "Show URL", Copy, "Replace URL" (confirm; the old URL stops working). Visible only to people who can deploy ("You need permission to deploy this service to see its webhook"). Warnings: "Autodeploy is off, so calls to this URL are ignored…", "GitHub can't reach <host>…" (the console isn't reachable from the internet), "This service has no webhook URL yet…". Not shown for image and upload sources.
- **Clean cache** switch.

Rules:
- GitHub repositories connected through the GitHub App redeploy on push with no webhook to paste. GitLab, Bitbucket and Gitea repositories use the deploy webhook, which the person adds at their Git host (the page gives the steps).
- Provider signatures and secrets are checked against the exact raw request body.
- Trigger "On push" deploys pushes to the app's branch; "On tag" deploys new tags.
- **Watch paths**: when set, a push deploys only if an added, modified or removed file matches one of them.
- A push arriving while a deploy waits replaces the waiting one; a push during a running deploy queues one more after it. Pushes are never dropped.
- Webhook tokens are secrets (see G4 in [24-known-gaps.md](24-known-gaps.md)).

**Acceptance**: two pushes 5 seconds apart during a 3-minute build produce exactly two deploys, the second at the later commit; a push touching only `docs/` doesn't deploy an app watching `src/**`.

## 6.7 Logs and terminal

- **Logs tab** (new in the console; today only the Agent reads them): live output of the running container, with a line count (100, 500, 1,000, all since start), "Since" (a time), search, follow on/off, Copy and Download. For apps with several replicas or restarts, a container picker.
- **Terminal**: opens a shell in the running container in a dialog: Options → container and shell (sh or bash); closing asks "Close terminal?". Needs deploy rights on the service (today it has no permission gate at all). Sessions end when the dialog closes.

## 6.8 Ports and mounts (Advanced tab)

New console screens for what the Agent can already do.

**Ports**: list and add/remove port mappings: container port, published port (1 to 65535, unique on the server; ports Nearzero itself uses are refused), protocol TCP or UDP. Published ports are not needed for web traffic, which goes through hostnames; the tab says so.

**Mounts**: list and add/remove: named volume (name, container path), bind mount (host path, container path), or file mount (container path and content, up to 1 MB: "A file mount can hold up to 1 MB."; content is treated as a secret and never shown to the Agent; a move from 0.1.x names every file mount over the limit in its report, 31d G4-16). Removing a volume mount asks whether to keep the volume's data.

Changes apply on the next deploy, which the page offers to start.

## 6.9 Settings tab

- Deployment settings (6.6).
- **Domains**: "Service port" ("Traffic is routed to container port N", editable), each hostname with path and port plus Copy, Visit and **Manage** (opens it in Domains), **Add domain** (the dialog in [10](10-domains-and-certificates.md) 10.6), DNS hints.
- **Danger zone**: **Delete service** (the dialog in [05](05-projects-environments-variables.md) 5.2).

## 6.10 Variables and Backups tabs

- Variables: [05](05-projects-environments-variables.md) 5.5.
- Backups: volume backups, [17-backup-destinations.md](17-backup-destinations.md) 17.3.

## 6.11 Permissions

| Action | Needs |
| --- | --- |
| See the app | Access to its service |
| Deploy, redeploy, reload, start, stop, terminal, see the webhook | Deploy rights on the service |
| Change source, builder, ports, mounts, autodeploy, webhook token, clean cache | Configure rights on the service |
| Edit its variables | Variable write rights on the service |
| Add a domain | Domain rights |
| Delete | Delete-service rights |

**Acceptance (whole area)**
- An app from a private GitHub repository, a private repository over SSH with a deploy key, an uploaded zip and a container image from a private registry each deploy and serve.
- A build that fails leaves the previous version answering at the same hostname.
- A container that exits right after start produces a Failed deploy whose log ends with the container's output.
