# 01. Vision and positioning

## 1.1 What Nearzero is

Nearzero is a self-hosted platform for running software on Linux servers you own or rent, with an operations Agent built in. One command installs it on a server. From then on a person can deploy Git repositories, container images, Compose stacks and six kinds of database onto that server or onto any other server they add over SSH. Every app gets an HTTPS address. Data is backed up to S3-compatible storage. Scheduled scripts run as tasks. Requests are logged and summarized. Members get exactly the access an administrator gives them.

The headline is the Agent. In a chat, a person says what they want ("set up my new server", "deploy github.com/acme/web", "why did the last deploy fail?") and the Agent does it with the same actions a person has in the console. It asks for secrets in forms whose values the model never sees, follows each deploy to the end, reads the logs when something fails and fixes what it can. Workspace policies decide what it may do; production changes stay off until an administrator turns them on.

One-line pitch: **the AI agent that runs your servers.** Second line: run production as if you had an operations team, on servers that cost what a server costs.

## 1.2 Who it is for

| Person | What they want | What Nearzero gives them |
| --- | --- | --- |
| A solo developer or small team with a VPS | Heroku-like deploys without per-seat or per-request bills | One install, Git push deploys, HTTPS, databases with backups |
| A startup that outgrew a managed platform's pricing | The same comfort on their own cloud account | Several servers, environments, members and policies |
| An agency running many client apps | One place to see and operate many small apps | Projects per client, members limited to their projects |
| Someone who is not an operations engineer | Servers that keep running without learning Docker, Traefik and DNS | The Agent sets up servers, explains DNS records for their own DNS provider, and fixes failed deploys |
| A team that must keep data on its own machines | No third party holding their code or data | Everything runs on their servers; the only outside calls are the ones they configure (model provider, Git host, email, backups) |

Not for 1.0: large fleets with autoscaling, Kubernetes users, multi-region high availability of the control plane, regulated environments that need SSO and audit export.

## 1.3 Positioning

- Managed platforms are easy until the bill grows; a bare server is cheap until it breaks at night. Nearzero keeps the server's price and removes the night shift.
- Deploy panels make deploying simpler but leave the operations to you. Nearzero's Agent does the operations work itself, on your servers, under your rules.
- Open source under Apache 2.0. Anything paid later lives in clearly separate parts (see the license decision in [25-open-decisions.md](25-open-decisions.md)).
- Honest claims only. Product copy never promises something the product does not do (for example: no one-click rollbacks, no template catalog, no pull-request previews, no network charts, no app CLI, unless a later release builds them).

## 1.4 What 1.0 must do on day one

A person with a fresh Linux server and a domain must be able to do all of this without reading code, and every item is covered by an end-to-end test on a real server (see [26-build-plan.md](26-build-plan.md)):

1. Install with one command, answer a few questions in the terminal (admin email, password, optional domain), and sign in at the address the installer prints.
2. Pick a theme (Dusk by default), finish onboarding, and land on the Agent.
3. Save a model-provider key and ask the Agent to deploy a public or private Git repository. Get a working HTTPS address, or a clear explanation and a fix attempt if the build fails.
4. Do the same by hand in the console: create a project, add an app from Git or from an image, set variables, deploy, watch the log, open a terminal in the container.
5. Add a database of any of the six types, connect to it from an app by its internal URL and from a laptop by its public URL, schedule backups to S3-compatible storage and restore one.
6. Add a second server over SSH (including cloud images that refuse root logins), run setup, pass its checks, and deploy to it with an automatic hostname once one DNS record exists.
7. Turn on push deploys for a GitHub repository and see a push redeploy the app.
8. Invite a member, give them a reusable access policy, and see them limited to it, in the console and through the Agent.
9. Schedule a task, see its runs and logs.
10. See request analytics for the apps, and get a notification on a failed deploy in at least one channel.
11. Use the whole console on a phone.
12. Upgrade an existing 0.1.x install to 1.0 without losing data or stopping running apps (see the migration decision).
13. Uninstall cleanly with one command.

## 1.5 Product principles

1. **The Agent and the console are equal clients.** Anything the Agent can do, a person can do in the console, through the same permission checks. The Agent never gets a private path.
2. **Secrets never reach the model.** Values typed into secure forms go straight to the platform; the model learns names only.
3. **Safe by default.** Production changes, deletions and SSH key access by the Agent are off until an administrator turns them on. A fresh install cannot be claimed from the web.
4. **Say what to do next.** Every error names the cause and the fix in plain words (which DNS record to add at which provider, which SSH user the server expects, which variable the build is missing).
5. **Nothing silently fails.** Every action either succeeds visibly, or shows a readable error where the person is looking.
6. **Fewer, finished features.** 1.0 drops anything a person cannot use today (see [27-dropped.md](27-dropped.md)) rather than carrying half-built backends.
