# 26. Build plan

Milestones are ordered; each depends on the ones before it. A milestone is done only when its end-to-end runs pass on real servers (see 26.3), not when its unit tests pass.

## 26.1 Milestones

| # | Milestone | Covers | Done means |
| --- | --- | --- | --- |
| M0 | Foundations | Repository, build, release pipeline, signed multi-architecture images (amd64 and arm64), installer skeleton, the server runner skeleton (if D1 picks B or C), test harness that creates throwaway servers | A tagged build produces images for both architectures and a checksummed installer; the harness can create and destroy a real server and a Docker-in-Docker host |
| M1 | Install and identity | [03](03-install-and-cli.md), [04](04-identity-and-access.md) without access policies | Interactive and unattended installs work on Ubuntu, Debian, Fedora, Amazon Linux and an Alpine-based image; the owner signs in over plain HTTP on an IP and over HTTPS on a domain; 2FA, onboarding, workspace switch and rename work; `nearzero` server commands work; uninstall leaves nothing behind |
| M2 | Design system and shell | [21](21-design-system.md), [18](18-settings.md), navigation, phone layout | All three themes pass the contrast sweep; the phone sweep passes at 375px; plain-HTTP simulation passes |
| M3 | Projects, environments, applications | [05](05-projects-environments-variables.md), [06](06-applications.md), [11](11-deployments.md) | An app from a public Git repo, a private repo over SSH, and a container image each deploy on the host with logs, terminal, variables, ports and mounts; a failed build leaves the running version serving |
| M4 | Domains and certificates | [10](10-domains-and-certificates.md) | Generated hostnames, custom domains and managed DNS zones issue real certificates on a real domain; a hostname with wrong DNS is held, not retried into a rate limit |
| M5 | Databases and backups | [08](08-databases.md), [17](17-backup-destinations.md) | All six databases deploy, keep data across redeploys, connect by internal and public URL, back up to S3-compatible storage, restore, and prune to "keep latest N"; volume backups restore in place |
| M6 | Remote servers | [09](09-servers-and-ssh-keys.md), per-server hostnames | A cloud server that refuses root is added, set up as its default user, passes checks, and serves an app on its per-server hostname; Alpine works; deleting a project wipes it from the remote server |
| M7 | Compose | [07](07-compose.md) | A stack from Git and one from pasted YAML deploy with per-service domains and logs |
| M8 | Git providers and push deploys | [16](16-git-providers.md), webhooks in [06](06-applications.md) | GitHub App, GitLab, Bitbucket and Gitea connect; a push redeploys; a push during a running deploy is queued, not dropped; watch paths filter |
| M9 | Members and access | access policies, API keys in [04](04-identity-and-access.md), [22](22-security-and-permissions.md) | A member with a policy sees and changes only what it grants, in the console, the API and the Agent; every check in the permission matrix has a test |
| M10 | Tasks, analytics, monitoring, notifications | [12](12-tasks.md), [13](13-analytics.md), [14](14-monitoring.md), [15](15-notifications.md) | A task runs on schedule and on demand with its log; analytics shows real traffic; a failed deploy notifies at least Slack, Discord, email and a webhook |
| M11 | The Agent | [19](19-agent.md), [20](20-agent-capabilities.md) | The scripted-model suite passes; the real-model suite passes the day-one scenarios in [01](01-vision.md); no secret entered in a form appears in any stored model message |
| M12 | Migration from 0.1.x | D3 in [25](25-open-decisions.md) | A real 0.1.x install with apps, databases, domains, members and a remote server upgrades to 1.0; every app keeps serving during the upgrade; nobody resets a password; no certificate is re-issued; rollback works until finalize |
| M13 | Release candidate | Everything, [23](23-non-functional.md), [24](24-known-gaps.md) | Every acceptance criterion in this spec has a passing test or a signed-off manual check; every known gap in 24 is closed; docs and site copy are checked against the product |

## 26.2 Rules that apply to every milestone

- Every user-visible string is reviewed for plain language and gives the fix along with the failure.
- Every page is built in all three themes and at phone width from the start, not retrofitted.
- Every endpoint gets a permission test for "allowed", "refused for a member without the capability" and "refused for another workspace".
- Every long action (build, deploy, setup, backup, restore, task run) runs in the background and is followed through its log; no request waits on it.
- Release notes are written for people, one paragraph per change, no internal names.
- Commits carry no AI tool attribution trailers or footers.

## 26.3 Test strategy

**Unit and component tests** for rules that are easy to get wrong: name and hostname validation, cron and timezone parsing, connection URL encoding, permission resolution with policies, variable parsing that keeps comments, DNS record names relative to a zone, script checks for tasks.

**Real-server end-to-end runs** are the release gate. Each run creates fresh machines, installs from the release candidate exactly as a person would (`curl … | sudo bash` with answers typed at the prompts), drives the product through the browser and the Agent, and checks results from outside the server.

| Suite | Environment | What it proves |
| --- | --- | --- |
| Install matrix | Fresh VMs: Ubuntu LTS, Debian, Fedora, Amazon Linux, an Alpine-based image; amd64 and arm64 | Interactive, unattended, with and without a domain, managed DNS, external Postgres; rerun upgrades keep data; uninstall is clean |
| Cloud-like remote server | A VM that refuses root logins and gives a default user passwordless sudo | Setup switches to the right user, the router runs as that user, routes written by that user load |
| Day-one scenarios | One control plane plus one remote server, a real domain, real certificates | Every item in [01](01-vision.md) section 1.4 |
| Databases and backups | Control plane plus an S3-compatible store | Six databases: deploy, connect internally and publicly, back up, restore, prune |
| Members | Owner plus three members with different policies | The permission matrix in [22](22-security-and-permissions.md), through the console, the API and the Agent |
| Agent, scripted | A scripted model that returns fixed tool calls | Every guided flow and form, stop and rejoin, refusals by policy, no secret in stored messages |
| Agent, real model | A real model through the model provider | The day-one scenarios phrased the way people write them, including typos |
| Migration | A 0.1.x install seeded with realistic data | Decision D3 end to end, including rollback |
| Phone and themes | Headless browser sweep of every route | No overflow at 375px; contrast in Dark and Dusk; plain-HTTP simulation |
| Push deploys | A Git host (a real GitHub App on a test organization, and a self-hosted Gitea) | Pushes redeploy; signatures checked against the raw body; pushes during a deploy are queued |

Local runs use a Docker-in-Docker host to stand in for a server, with an in-host image registry, so the installer can be tested without publishing images. Domain and certificate tests need a real VM and a real domain.

Rules for the harness:
- Tests never touch the developer's own Docker, router or ports.
- The harness builds what it tests; it never runs a stale build.
- Test secrets live only inside the harness's working folder, which is excluded from image builds.
- A flaky test is fixed or quarantined with an owner; it is never retried until green in the release gate.
