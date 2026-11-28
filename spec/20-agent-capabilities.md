# 20. Agent capabilities

What the Agent can do, in plain words. Every capability runs through the same permission checks as the console for the person who asked: the Agent can never do more than that person could. Changes also need the Agent policy named in the "Policy" column ([19-agent.md](19-agent.md) 19.9). Anything that would change an environment named "production" also needs "Change production environments" (off by default). Reading needs no policy beyond the person's own access.

A server that isn't set up (setup never ran, failed or is still running) takes nothing (31d G4-03): every create, import, deploy, start or stop and domain action that names one is refused with 'Server "<name>" isn't ready for deployments: <why>, so nothing was <created|deployed|changed>. Run setup from the server's page (or ask me to set it up), then ask again.' The Nearzero host is set up by the installer.

A 1.0 rule: every capability below must also exist in the console (principle 1 in [01-vision.md](01-vision.md)). Where today's console lacks it, the area spec adds it.

## 20.1 Projects and environments

| Capability | Policy | Rules |
| --- | --- | --- |
| List projects with their environments and services; read one project or environment, including whether it is production | none | |
| Create a project | Create projects | Starts with one environment, "development". Generic names ("new project", "my project", "project 2", "untitled") are refused and the name form is shown. |
| Rename a project, change its description | Rename and describe projects | |
| Create an environment | Rename and describe projects (and production, for "production") | Name normalized to lowercase with dashes; unique in the project; "prod" and "prd" are refused in favor of "production". Starts with no variable values; the project's services are copied in, not deployed, with variable names only. |
| Delete a project and all its services | Delete projects without production | Only through the confirmation in 19.7; never a project with a production environment. |

## 20.2 Finding things

| Capability | Rules |
| --- | --- |
| Find a service across all projects | By name (typos tolerated), internal app name, a deployment log path, a container name, or id. Returns the real candidates when nothing matches. |

## 20.3 Applications

| Capability | Policy | Rules |
| --- | --- | --- |
| Create an app from a connected Git provider (GitHub, GitLab, Bitbucket, Gitea) | Import from Git (needs Create and configure services) | Branch, app folder for monorepos (".." refused), builder (automatic, Dockerfile, Railpack, Nixpacks, Heroku buildpacks, Paketo buildpacks, static), install/build/start commands. |
| Create an app from a Git URL | Import from Git | Accepts https, a bare host/owner/repo, or SSH (git@… or ssh://) with a saved deploy key. Refuses URLs with a user name or token, query strings or fragments, and any other scheme. |
| Create an app from a container image | Create and configure services | |
| Change an app's source (image, Git URL, provider repository with branch, path, watch paths, submodules) | Create and configure services | Same credential rules as creation. |
| Change how an app builds (builder, Dockerfile path, context, stage, publish folder, single-page app, commands) | Create and configure services | Commands that look like they contain secrets are refused (assignments to TOKEN, SECRET, PASSWORD, API_KEY; provider key formats; private-key headers). |
| Add a port mapping (container port, published port, TCP or UDP, routed or host mode) | Create and configure services | Apps only. |
| Add a mount (bind, named volume or file path) | Create and configure services | File contents are refused (they may be secret). |
| Ask for variables through the secure form | Create and configure services | Apps and Compose. Values never reach the model. |
| Read or change push deploys (on/off, push or tag trigger, watch paths) and point the person to the deploy webhook | The model is never given the webhook URL (it carries a token); it learns whether one exists and tells the person where to copy it. Changing needs Create and configure services | Explains whether the GitHub App delivers pushes or a webhook is needed, with GitHub setup steps; warns when the console isn't reachable from the internet and that the URL works like a password. |
| Copy new services into the project's other environments | as for creation | Not deployed, variable names only; the reply lists the environments. |

Every Git import gets a default hostname if "Assign domains" allows it, reported as "not live until deployed".

## 20.4 Compose

| Capability | Policy | Rules |
| --- | --- | --- |
| Create a Compose service from pasted YAML (Compose or stack format) | Create and configure services | Variable values and config file contents in the YAML are refused; they go through the variables form. |
| Create a Compose service from a file in a connected repository | Import from Git | Through the guided import. |

The model can never read back an existing Compose file (it may hold secrets).

## 20.5 Databases

| Capability | Policy | Rules |
| --- | --- | --- |
| Create a Postgres, MySQL, MariaDB, MongoDB, Redis or libSQL database | Create and configure services | Credentials are always generated; passwords are never accepted from the model. Each gets its own data volume and an automatic public port. The result gives internal and public host and port, never the password, and points to the database's page for full URLs. |

Default images are the same in the console and the Agent (today they differ; see [08-databases.md](08-databases.md)).

## 20.6 Domains

| Capability | Policy | Rules |
| --- | --- | --- |
| Add a hostname to an app or Compose service | Assign domains (needs Create and configure services) | Port and path (HTTPS and its certificate follow 10.6; there is no per-hostname switch). Returns the A record to add as a table, unless the name already points at the server. |

## 20.7 Deploying and running

| Capability | Policy | Rules |
| --- | --- | --- |
| Deploy, redeploy, rebuild | Deploy and run services | Apps and Compose queue a build; databases deploy. |
| Start, stop, restart, reload | Deploy and run services | Restart and reload mean stop then start. |
| Follow the latest deployment | none | For 5 to 900 seconds (default 300), checking every 3 seconds. Outcomes: succeeded (with live addresses, plus any pending DNS record or a note that there is no domain), failed (last 80 log lines), cancelled, still running (last 20 lines), not started. |

## 20.8 Logs and troubleshooting

| Capability | Rules |
| --- | --- |
| List recent deployments of a service | Default 5. |
| Read a deployment's log | Default last 200 lines, at most 10,000. |
| Read a running service's logs | Tail, since a time, or search. |
| Compare a service's recorded status with what is actually running | Finds services marked running that no longer exist and the reverse. |
| Analyze log text or an attached log file | A separate model call returns the likely cause and fixes; input up to 12,000 characters. |

## 20.9 Servers

| Capability | Policy | Rules |
| --- | --- | --- |
| List servers the person can reach, with "ready for deployments" and the next step for each; read one server | none | The private key is never shown. |
| Add a server | Add and set up servers | Needs a name, address, SSH port (default 22), SSH user and a saved SSH key. The user is never assumed; without one the Agent asks (ubuntu on AWS Ubuntu, ec2-user on Amazon Linux, admin on Debian on AWS, root on most VPS providers). Duplicate addresses are refused. |
| Edit a server (name, address, port, user, key) | Add and set up servers | Used instead of deleting and re-adding. |
| Run setup | Add and set up servers | On success: ready, plus the one DNS record that gives every app on that server an address (with the DNS provider detected and its own steps). If the server demands another SSH user, the result names it and the Agent switches and retries. Other failures return the step, the reason and the last 40 log lines. |
| Validate a server (SSH login and installed tools), read its latest setup log (default 300 lines), run a security audit | none beyond the person's manage rights on that server | |
| Remove a server | Remove servers | Refused while any service is on it, running, stopped or never deployed (9.6): the refusal names the services the person can see, counts the others, and says to delete or move them first. Nothing is deleted with it. |

The Agent cannot run arbitrary commands on a server, edit its files, or change firewalls or cloud security groups. It says so and gives the steps.

## 20.10 SSH keys

| Capability | Policy | Rules |
| --- | --- | --- |
| Ask for a key through the secure form (generate ED25519 or paste) | Add SSH keys | |
| List keys by name and fingerprint | Read SSH keys | |
| Rename or redescribe a key (1 to 100 characters) | Rename SSH keys | |
| Delete a key | Delete SSH keys | Refused for keys a server uses. |

## 20.11 Git providers

| Capability | Policy | Rules |
| --- | --- | --- |
| List connected providers that are fully set up, their repositories and branches | Import from Git | Repository file lists and small manifest files are read through the provider's API, never by cloning. |

## 20.12 Tasks

| Capability | Policy | Rules |
| --- | --- | --- |
| List tasks (where each runs, schedule, time zone, next and last run), optionally for one service or server | none beyond Tasks access | |
| Review a task: its script (up to 6,000 characters shown) and its last 10 runs | none beyond Tasks access | |
| Create a task | Create and run tasks (and production, for production services) | Name up to 100 characters, description up to 500, a 5-field cron, a time zone (UTC by default), and exactly one place to run: inside an app's or Compose service's container (a command, bash or sh; Compose needs the inner service when there are several), on a server (owners and admins), or on the Nearzero host (instance administrators). The script is pasted by the person in the task form. |
| Change a task's name, description, schedule, time zone or on/off; replace its script | Create and run tasks | Replacing the script opens the form again. |
| Run a task once now | Create and run tasks | In the background. |

## 20.13 Research and attachments

| Capability | Rules |
| --- | --- |
| Search the web; read a web page | Only when the workspace has a research key. Limits in 19.10. |
| List a chat's files; read one by offset (200 to 8,000 characters, default 6,000), by PDF page, or by word search (up to 40 matching lines with line numbers) | Only in chats with attachments. Images and PDFs without text are shown to the model again when it supports them. |

## 20.14 Not offered

The Agent has no capability for: notifications channels, members and access policies, backup destinations and schedules, workspace settings, Agent policies (other than the permission card), analytics, or deleting individual services outside project deletion. It says it can't and points to the console page.

## 20.15 Audit

Every change and every policy refusal is recorded with actor "Agent", the person, their role and the session. Secret-looking values are redacted.
