# G4. The Agent and the technical layer: parity round 3 (0.1.79 and 1.0)

Reviewer: parity reviewer (dirty side), round 3. Compared: 0.1.79 (the reference behavior) and 1.0 at dac9631 (main), against `spec/` at the same commit. This file describes behavior only: what a person, the model, a Git host, a monitor or a script sees and gets.

Scope: the Agent (chat, sessions, streaming, stop, retry, edit, attachments, deep research, model provider and keys, Agent policies, every action the model can call and its safety, guided flows, answers without keys, errors) and the technical layer (the API surface, webhooks in and out, live updates, background jobs and schedules, email, security, performance, the installer and the `nearzero` command, the platform's own logs, health, version and update checks).

Not counted as gaps: the deliberate changes in `spec/00-index.md` and 19.12, everything in `spec/27-dropped.md`, the owner's decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10, the decisions in `spec/30-parity-round-2.md`, everything already listed in 30a to 30d, and punch-list items marked Done.

Found in this area but already reported by another round 3 reviewer, so not repeated here:
- G1-01: `reset-password` input lines.
- G2-02: the 5 MB deploy log cap.
- G2-04: large push payloads.
- G3-01: runners over plain HTTP.
- G3-18: redirecting notification addresses.
- R3-37 (still broken): the custom webhook body. R4-14 below adds only what R3-37 doesn't cover.

## Summary

| Kind | P0 | P1 | P2 | Total |
| --- | --- | --- | --- | --- |
| Still broken from round 2 | 0 | 3 | 2 | 5 |
| New gaps | 0 | 2 | 22 | 24 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| R4-01 | P1 | Still broken: a pasted link with any other words goes to the model, which creates the app from the URL unchecked, on "main" | 19.7, 30d R4-01 |
| R4-02 | P1 | Still broken: on a server with 0.1.x, the uninstaller points at a 0.1.x uninstaller address that is never published | 3.3, 30d R4-02 |
| R4-03 | P1 | Still broken: backups still wait behind task runs, setups, restores and deletes | 23.1, 23.2, 30 job-lane decision |
| R4-09 | P2 | Still broken: five documented 0.1.x Agent settings are neither read nor named | 19.6, 19.10, 30d R4-09 |
| R4-14 | P2 | Still broken: the custom webhook's `title` and `message` aren't 0.1.x's | 15, 30d R4-14 |
| G4-01 | P1 | Removing a server through the Agent deletes every stopped service on it, with their data | 9.6, 20.9 |
| G4-02 | P1 | The installer tells older 0.1.x servers to run an address 0.1.x never publishes | 29.2, 3.2 (spec gap) |
| G4-03 | P2 | The Agent creates services on, and deploys to, servers that aren't set up | 20.3 to 20.7 (spec gap) |
| G4-04 | P2 | After setup, the Agent gives the DNS record without checking it or naming the provider | 20.9 |
| G4-05 | P2 | On the model path the Agent stops at the first failed deploy and skips the push-deploy follow-up | 19.11 (spec gap) |
| G4-06 | P2 | A builder, folder or commands named in a short import request are silently dropped | 19.7, 20.3 |
| G4-07 | P2 | A public-URL import never says pushes won't redeploy it | 19.7 |
| G4-08 | P2 | The Agent can't add a host-mode port or choose the Railpack version or Heroku stack | 20.3 |
| G4-09 | P2 | Some text files 0.1.x read as attachments are refused | 19.10 |
| G4-10 | P2 | PDFs sent to a model without native PDF input can be billed through the provider's paid OCR | 19.10 (spec gap) |
| G4-11 | P2 | The deploy webhook's secret is written to the control plane's log on every call | 22.4, 23.4 |
| G4-12 | P2 | Members can point a GitLab or Gitea connection at private or internal addresses | 16.1 (spec likely wrong) |
| G4-13 | P2 | The console gives up after 30 seconds on actions the control plane is still running | 23.5 (spec gap) |
| G4-14 | P2 | Registration has no rate limit | 22.4 rule 9 (spec gap) |
| G4-15 | P2 | Runtime log lines carry no timestamps | 6.7 (spec gap) |
| G4-16 | P2 | File mounts over 1 MB are refused, and moved ones fail only at deploy | 6.8 (spec gap) |
| G4-17 | P2 | A GET to a deploy webhook address stops deploying with no clue why | 6.6, 29.5 (spec gap) |
| G4-18 | P2 | Builder image pins and router settings given at install reach only the Nearzero host | 3.5 (spec gap) |
| G4-19 | P2 | 0.1.x setting names that 1.0 neither reads nor names | 3.1, 3.5 (spec gap) |
| G4-20 | P2 | A rerun asks for a domain even when the console's hostname is saved under About Nearzero | 3.2 |
| G4-21 | P2 | Webhook URLs and other generated links ignore the hostname saved under About Nearzero | 6.6, 10.9, 18.2 (spec gap) |
| G4-22 | P2 | An interactive install with only `NEARZERO_ADMIN_EMAIL` set generates a password instead of asking | 3.1 (spec gap) |
| G4-23 | P2 | `sudo nearzero logs` takes one service name and no options | 3.4 |
| G4-24 | P2 | Installer wording: rerun summary, "Apps" line, domain skip | 3.1 |

---

## Round 2 items: what was checked

| Id | Result |
| --- | --- |
| R4-01 | **Still broken (partly).** Fixed: a link alone, or with a short list of deploy words, runs the checked import, with the access card and every message from 30d. Still wrong: see below. |
| R4-02 | **Still broken (partly).** Fixed: 1.0's uninstaller stops before deleting anything when 0.1.x is on the server (an unfinished move, a 0.1.x settings file, unlabelled Nearzero containers or Swarm services), names it, and says what to run. `NEARZERO_UNINSTALL_YES=true` works. Still wrong: see below. |
| R4-03 | **Still broken (partly).** Fixed: deploys have their own workers (4), scheduler ticks have their own (2), and a server builds one app at a time, with "Queued: waiting for <server>'s other deploy to finish…" in the log. Still wrong: see below. |
| R4-04 | Fixed. The Agent reads one service's source (URL without credentials, branch, folder, image), builder, commands, push deploys, hostnames and last 5 deployments, with no secrets. |
| R4-05 | Fixed. The Agent reads one task run's log (a run by id, the newest, or the newest failed; 200 lines by default, at most 10,000) under the person's task access. |
| R4-06 | Fixed for the model's create actions, which take the builder and the three commands with the secret-command refusal. The guided import still drops them (G4-06). |
| R4-07 | Fixed. Database creation takes an image, a database name and a user. Passwords are still always generated. |
| R4-08 | Fixed. With any ready server and none named, the person picks from the ready servers plus "Nearzero host" when allowed. |
| R4-09 | **Still broken (partly).** Fixed: the kill switch, models, provider address, greeting title and system prompt (appended) are read under their 0.1.x names, and the start log names six 0.1.x settings that 1.0 ignores. Still wrong: see below. |
| R4-10 | Fixed. `platform`, `console` and `api` follow the control plane, `traefik` the router, and `monitoring` and `schedules` get one line each. |
| R4-11 | Fixed. `GET /api/health` answers at the console's address and on the API port. |
| R4-12 | Fixed. Image apps have a deploy webhook. A registry call naming another image or tag answers "Not deployed: …" with both, and a matching call or one without image details redeploys. |
| R4-13 | Fixed. Pings answer 200 "Ping received: the webhook is active." Other Git host events answer "Not deployed: only pushes deploy, and <host> sent the <event> event." Bitbucket pushes follow the branch rules, and a plain call still deploys. |
| R4-14 | **Still broken (partly).** R3-37 (G3) lists the field differences. See below for the one it doesn't cover. |
| R4-15 | Fixed. 0.1.x's GitHub App setup, GitLab and Gitea callback addresses are answered. Moved GitLab and Gitea connections keep sending the redirect address the host has registered. |
| R4-16 | Fixed. `sudo nearzero audit [--since DATE] [--until DATE]` prints the audit record as JSON lines, redacted, and says when there's nothing in range. |

### Still broken: R4-01 · P1 · A pasted link with other words is still unchecked

**0.1.x (0.1.79)**
- A link to github.com, gitlab.com, bitbucket.org or codeberg.org runs the checked import in two cases: when it's alone, or when the rest of the message contains a deploy-type word (deploy, import, clone, run, launch, host, ship, publish, serve, start, set up, spin up, put it online, go live).
- So these all get the checked import, with the access card when the repository can't be read:
  - "https://github.com/acme/web.git clone it and deploy this frontend";
  - "deploy https://github.com/acme/web with its Dockerfile";
  - "please deploy this repo https://github.com/acme/web, it is a next.js app";
  - "import gitlab.com/acme/api as api".
- There is no length limit on such a message.

**1.0 now**
- The checked import runs only when every other word in the message is on a short list (deploy, import, host, the project and server names, filler words like "please", "this", "repo").
- Any other word sends the message to the model: "clone", "frontend", "Dockerfile", "its", "next.js", "as api". So do messages over 400 characters.
- All four examples above go to the model.
- The model's "create an app from a Git URL" action then creates the app without checking that the repository can be read, and without trying a connected account that can see it. With no branch given, it uses "main".
- So the R4-01 failures (a promise that can't be kept, no access card, a master-branch repository failing at deploy, no push deploys though a connected account could see it) still happen for the most natural phrasings.

**Expected 1.0 (acceptance)**
- Each of the four examples runs the checked import: a connected account first, then the public check, then the access card. The words that matter are honoured: "with its Dockerfile" picks the Dockerfile builder, and "as api" names the service api.
- When the model creates an app from a github.com, gitlab.com, bitbucket.org or codeberg.org URL, the result is the same as the checked import's:
  - a connected account that can see the repository is used;
  - otherwise a public repository is deployed on its real default branch;
  - otherwise nothing is created and the access card is shown.
- Questions ("what does github.com/acme/web do?") still go to the model.

**Spec**: 19.7 as amended by 30d R4-01.

### Still broken: R4-02 · P1 · The 0.1.x uninstaller the message points to doesn't exist

**0.1.x**: 0.1.x publishes its uninstaller only at the root address `https://cdn.nearzero.dev/uninstall.sh`, never under a version. The final 0.1.x release does the same. Versioned files exist only for the installer, at `https://cdn.nearzero.dev/releases/<version>/install.sh` (with `.sha256`).

**1.0 now**
- On a server that still has 0.1.x, the uninstaller stops with "Nearzero 0.1.x is still on this server: <what>. This uninstaller removes only 1.0, so nothing was removed."
- It then says "Remove 0.1.x with its own uninstaller first: curl -fsSL https://cdn.nearzero.dev/v0.1.80/uninstall.sh | sudo bash".
- That address is never published. Once 1.0 owns the root `uninstall.sh`, nothing serves 0.1.x's uninstaller at all.
- The person who wants Nearzero gone from a 0.1.x server (one that was never moved) has no working command. R4-02's last acceptance line ("nothing from Nearzero remains, of either version") can't be reached.

**Expected 1.0 (acceptance)**
- On a 0.1.x server, every command the uninstaller prints downloads a real script with a checksum beside it. Running it, and then 1.0's uninstaller, leaves no container, Swarm service, volume, network, file or command from either version.
- Either:
  - the final 0.1.x release publishes its uninstaller at the exact address 1.0 prints; or
  - 1.0's uninstaller can remove a 0.1.x install itself, after naming what it will remove and asking.

**Spec**: 3.3, 29 (spec gap: no address for 0.1.x's tools once 1.0 owns the root addresses). See also G4-02.

### Still broken: R4-03 · P1 · Backups still wait behind task runs, setups, restores and deletes

**0.1.x**: scheduled database and volume backups started at their minute, whatever else was running. A long task never delayed a 02:00 backup.

**1.0 now**
- Deploys and scheduler ticks have their own workers now.
- Running a backup, a restore, a task run (up to 6 hours), a server setup (10 to 20 minutes per step) and a delete still share one pool of 4 workers. Each holds its worker until it ends.
- So with 4 task runs going, or 3 runs and a server setup, a backup due at 02:00 is queued on time but doesn't start until one of them ends. That can be hours later.
- The acceptance line of 30d R4-03 fails: "While 4 task runs of 30 minutes each are running … a backup scheduled for that minute starts within a minute".
- A scheduled task run can likewise wait behind 4 restores or setups.

**Expected 1.0 (acceptance)**
- While 4 task runs of 30 minutes each are running, a database backup scheduled for that minute starts within a minute.
- While 4 server setups are running, a task scheduled for that minute starts within a minute.
- Raising the worker count isn't the fix: no kind of long work can use up the workers another kind needs to start on time.

**Spec**: 23.1, 23.2, and the job-lane decision in `spec/30-parity-round-2.md` ("Schedules run on their own timers and never wait behind jobs").

### Still broken: R4-09 · P2 · Five documented 0.1.x Agent settings are neither read nor named

**0.1.x**: the platform's example settings file documents five more Agent settings:
- `NEARZERO_AGENT_ATTACHMENT_MAX_BYTES`: the largest attachment, 25 MB by default;
- `NEARZERO_AGENT_MODEL_INPUTS`: what the chat model takes besides text, when the provider's model listing can't say;
- `NEARZERO_AGENT_PDF_ENGINE`: which PDF parser the provider uses;
- `OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE`: sent as the HTTP-Referer and X-Title headers, so usage shows as "Nearzero" in the person's OpenRouter activity.

**1.0 now**
- None of the five is read, and none is in the start log's list of ignored 0.1.x settings.
- 1.0 has its own attachment cap setting in megabytes, but doesn't read the 0.1.x byte value. A moved install's lower cap is silently lost.
- 1.0 always sends X-Title "Nearzero Agent" and never sends HTTP-Referer. OpenRouter identifies an app by its referer, so usage no longer shows as coming from the install, and an operator can't change either header.
- With a provider address other than OpenRouter's, the model is treated as text only, and nothing can override that.

**Expected 1.0 (acceptance)**
- `NEARZERO_AGENT_ATTACHMENT_MAX_BYTES=5242880` on a moved install refuses a 6 MB upload. 1.0's own setting wins when both are set.
- Model requests carry HTTP-Referer (the console's address by default) and an X-Title, and `OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE` replace them when set.
- `NEARZERO_AGENT_MODEL_INPUTS` and `NEARZERO_AGENT_PDF_ENGINE` are read (see G4-10), or named in the start log as ignored.

**Spec**: 19.6, 19.10 and 30d R4-09.

### Still broken: R4-14 · P2 · The custom webhook's `title` and `message` aren't 0.1.x's

R3-37 (G3) lists the other field differences. This adds the two fields every 0.1.x body had.

**0.1.x**
- `title` is a fixed name per event: "Build Success", "Build Error", "Database Backup Successful", "Database Backup Failed", "Volume Backup Successful", "Volume Backup Failed", "Docker Cleanup", "Nearzero Server Restarted", "Server CPU Alert", "Server Memory Alert".
- `message` is a fixed sentence, for example "Build failed with errors", "Build completed successfully", "Database backup completed successfully", "Docker cleanup completed successfully".

**1.0 now**
- `title` is 1.0's own title, for example "Deploy failed: web", "Deployed web", "Docker cleanup on edge-1" or "Nearzero restarted".
- `message` is 1.0's one-line summary.
- A receiver that sorts or filters on `title == "Build Error"` stops matching after the move.

**Expected 1.0 (acceptance)**
- A build failure's body has `title` "Build Error" and `message` "Build failed with errors". Every other event uses the title and message listed above.
- 1.0's own title and summary go under their 1.0 field names, so the 0.1.x fields aren't overwritten.

**Spec**: 15 and 30d R4-14.

---

## New gaps: the Agent

### G4-01 · P1 · Removing a server through the Agent deletes every stopped service on it

**0.1.x**: The Agent refuses to remove a server that has any service on it, running or not: "<server> still runs N services. Delete those services or move them to another server first." The Agent never deletes an app or a database as a side effect.

**1.0 now**
- The Agent's remove-server action refuses only while a service on the server is running or deploying.
- If every service is stopped, failed or never deployed, it starts the same removal the console runs when "Also delete all attached services" is ticked. That tears down every service on the server, with its volumes and data, production environments included.
- Nothing is confirmed. No production check is made, and the only policy needed is "Remove servers".
- So "remove edge-1", on a server holding a stopped Postgres, deletes the database and its data.

**Expected 1.0 (acceptance)**
- With "Remove servers" on, "remove server edge-1", where edge-1 holds a stopped Postgres, is refused.
- The refusal names the services the person can see (and counts the others), and says to delete or move them first.
- Afterwards, no service, volume or deployment record has been removed, and the server is still there.

**Spec**: 9.6 ("The Agent always refuses a server with services"). 20.9 ("Refused while any service still runs on it") reads as running services only and should say "has any service".

### G4-03 · P2 · The Agent creates services on, and deploys to, servers that aren't set up

**0.1.x**
- Every create, import, deploy, start or stop and domain action checks the server it names.
- A server that isn't ready is refused: "Server "<name>" is not ready yet." with "Open the server setup logs and wait for setup to finish successfully." An inactive server is refused too.
- The built-in rules tell the model to run setup first and say so.

**1.0 now**
- A named server is accepted in any state: set up, failed or never set up. The guided import's named server is accepted the same way.
- The service is created there. Its deploy then fails with "This server's runner isn't connected… It reconnects by itself once the server is back", which is wrong for a server that was never set up.

**Expected 1.0 (acceptance)**
- "Create a postgres on edge-2", when edge-2's setup never ran or failed, is refused with a sentence saying the server isn't set up and pointing to running setup (or offering to run it). Nothing is created.
- A deploy of a service whose server isn't set up says that, not that the runner will reconnect.

**Spec**: 20.3 to 20.7 say nothing about server readiness (spec gap).

### G4-04 · P2 · After setup, the Agent gives the DNS record blindly

**0.1.x**: the result of a successful setup carries the server's app-address guide:
- When the wildcard record already points at the server: "Apps on <server> get their own address under <zone>, with HTTPS, automatically." No record is shown.
- Otherwise:
  - the record with its name relative to the zone;
  - the DNS provider, detected from the zone's nameservers, with that provider's steps (for Cloudflare, "Turn Proxy status off…");
  - where the name points now.

**1.0 now**
- A successful setup always returns the same one-row table (A, `*.<label>.<platform domain>`, the server's address) whenever a platform domain exists.
- It doesn't check whether the record already exists, and names no provider and no steps.
- The console's server DNS card already works these out.

**Expected 1.0 (acceptance)**
- Setup on a server whose wildcard already resolves to it says app addresses are ready, with no record to add.
- Otherwise the result names the DNS provider, gives that provider's steps and says where the name points now, the same as the server's DNS card.

**Spec**: 20.9 ("with the DNS provider detected and its own steps").

### G4-05 · P2 · On the model path the Agent stops at the first failed deploy and skips the push-deploy follow-up

**0.1.x**: the built-in rules tell the model to:
- Finish the job. After a deploy fails, find the cause in the log, fix it with its actions (builder, source folder, ports, variables), redeploy and wait again, up to 6 deploys, each with a different fix. Stop only when the fix is something only the person can do, and then say exactly what.
- Prefer a connected Git account that can see the repository over the public URL, because pushes then redeploy it.
- Ask for the variables the repository's example file lists before the first deploy of a service it created.
- Set up a server that isn't ready before deploying to it, and say so.
- After the first successful deploy of a Git service, check how pushes reach it and give the person the webhook's setup steps when one is needed.

**1.0 now**
- The built-in rules say only "explain the failure from its result in plain words and say what would fix it".
- A failed deploy's result has no fix-and-redeploy guidance. Only the guided flows' hand-over note asks the model to fix and redeploy.
- So "create an app from image X and deploy it", failing on a wrong port, ends with an explanation instead of a fix. The enforced 6-deploy cap (19.6) has nothing to bound.
- Nothing tells the model to prefer a connected account, to ask for variables first, or to report how pushes reach the service.

**Expected 1.0 (acceptance)**
- On the model path, a deploy that fails for a reason the Agent's actions can fix is fixed and redeployed within the cap, without asking first.
- When the fix is the person's, the reply says exactly what to change.
- After a first successful deploy of a Git service, the reply says whether pushes redeploy it and how to set that up.
- An app the model creates for a repository a connected account can see uses that account.

**Spec**: 19.11's prompt rules don't include these (spec gap).

### G4-06 · P2 · A builder, folder or commands named in a short import request are silently dropped

**0.1.x**: "import acme/web with nixpacks", "deploy acme/web from the apps/api folder" or "import acme/web using the static builder" go to the model, because they don't name a repository or app in words the guided import listens for. The model creates the app with that builder or folder in one step.

**1.0 now**
- These messages start the guided Git import. The guided import keeps the repository and branch and drops everything else.
- It then picks how to run from what it finds in the repository (the root Dockerfile, else automatic), or asks.
- "With nixpacks" becomes a Railpack or Dockerfile build, and "from the apps/api folder" is lost. The person isn't told.

**Expected 1.0 (acceptance)**
- "import acme/web with nixpacks" creates acme/web with the Nixpacks builder.
- "deploy acme/web from the apps/api folder" uses that folder, or the guided import asks only what the request left open.
- A detail the guided import can't honour sends the request to the model, never silently drops it.

**Spec**: 19.7 ("Import from Git"), 20.3.

### G4-07 · P2 · A public-URL import never says pushes won't redeploy it

**0.1.x**: after a successful import from a public URL that no connected account can see, the reply ends with "Pushes to the repository don't redeploy it on their own, because no connected account can see it. Connect the account that owns it, or ask me for its deploy webhook."

**1.0 now**: the success reply has no such line. The person learns only later that pushes do nothing.

**Expected 1.0 (acceptance)**: a successful import of a public repository that no account can see ends with that sentence, or one that says the same.

**Spec**: 19.7 (the 30d R4-01 flow).

### G4-08 · P2 · The Agent can't add a host-mode port or choose the Railpack version or Heroku stack

**0.1.x**
- The Agent's port action takes the publish mode (routed or host).
- Its build action takes the Railpack version and the Heroku stack, as the console does.

**1.0 now**
- Every port the Agent adds is routed. The console offers routed or host.
- The build action has no Railpack version or Heroku stack, though the console offers both.

**Expected 1.0 (acceptance)**
- "Publish UDP 9000 in host mode on game" creates a host-mode mapping.
- "Use Heroku stack 22 for web" and "use Railpack <version> for web" set the same fields the console sets.

**Spec**: 20.3 lists "routed or host mode". The versions are a spec gap.

### G4-09 · P2 · Some text files 0.1.x read as attachments are refused

**0.1.x**
- These attach as text: .text, .jsonl, .ndjson, .out, .err, .diff, .patch, .svg, .config, .nvmrc, and any *.example, *.sample or *.template file.
- A file without an extension is accepted when its bytes are text.
- A text-named file whose bytes aren't text is refused.

**1.0 now**
- None of those extensions is on the list. They are accepted only when the browser happens to report a text type.
- So build.out, app.err, fix.patch, events.ndjson or config.yml.example often get "This kind of file isn't accepted".
- Files are classified by name and reported type only. A binary renamed .txt is taken as text.

**Expected 1.0 (acceptance)**
- build.out, app.err, fix.patch, events.jsonl and config.yml.example attach as text in every browser.
- An extensionless text file attaches.
- A binary file renamed .txt is refused.

**Spec**: 19.10 ("text and code files").

### G4-10 · P2 · PDFs can be billed through the provider's paid OCR

**0.1.x**
- A PDF sent with a message names OpenRouter's PDF parser: the model's own reading when it supports PDFs, otherwise the free parser.
- `NEARZERO_AGENT_PDF_ENGINE` can choose the free parser, the paid OCR or native reading.
- If no parser is named, OpenRouter picks its paid OCR.

**1.0 now**
- The current message's PDF is sent as a plain file with no parser named, whatever the model supports.
- On a model without native PDF input, every PDF goes to the paid OCR on the workspace's OpenRouter credits.
- 1.0 already extracts PDF text itself for later turns and for reading by page.

**Expected 1.0 (acceptance)**
- A PDF sent to a model without native PDF input is read without the provider's paid OCR: either the free parser is named, or 1.0's extracted text is sent.
- An operator setting can choose the parser.

**Spec**: 19.10 ("PDFs go through the provider's PDF reading"). Spec gap: the parser and its cost aren't stated.

---

## New gaps: the API, webhooks, security and limits

### G4-11 · P2 · The deploy webhook's secret is written to the control plane's log

**0.1.x**: neither the platform nor the console wrote an access log, so a webhook address's token never reached the service logs.

**1.0 now**
- Every request writes one log line with its full path, and the default log level shows it.
- A deploy webhook's path is the credential itself (`/api/v1/webhooks/deploy/<token>`). Every call therefore puts a working secret into `sudo nearzero logs`, and into any log shipper reading the container's output.
- A moved 0.1.x webhook address is logged twice: once under its 0.1.x form and once under the address it's answered at.
- Log redaction looks at field names only, not at paths.

**Expected 1.0 (acceptance)**
- After calling a deploy webhook, no line of the control plane's or the console's log contains the token's secret part.
- The path is logged with the secret replaced, for example `/api/v1/webhooks/deploy/<id>.[redacted]`. The same holds for moved 0.1.x addresses.

**Spec**: 22.4 rule 6 and 23.4 ("never logged").

### G4-12 · P2 · Members can point a GitLab or Gitea connection at private or internal addresses

**0.1.x**: only a workspace owner or admin may set a self-hosted GitLab or Gitea address (anything other than gitlab.com or gitea.com) or an internal address. Others get "Only an organization owner or admin can configure self-hosted or internal Git provider URLs".

**1.0 now**
- Anyone with "Connect their own Git accounts" can create or edit a GitLab or Gitea connection with any address and internal address.
- The control plane then calls that address, with a 20-second timeout and no check of where it points, and reports what came back ("Connected as <login>", or the error).
- So a member can make the control plane send requests to loopback, the Docker network or a cloud metadata address. Notification channels, backup destinations and public Git checks all refuse such addresses for anyone but an instance administrator.

**Expected 1.0 (acceptance)**
- A member who isn't an owner or admin is refused, with a sentence naming the rule, when creating or editing a GitLab or Gitea connection whose address or internal address resolves to a private, loopback, link-local or internal address.
- Owners and admins (or instance administrators) may still set them.
- Whether members may use public self-hosted addresses is the owner's call. 0.1.x refused them.

**Spec**: 16.1 lets everyone allowed to connect Git accounts set these addresses, which is broader than 0.1.x. I think the spec is wrong for private and internal addresses.

### G4-13 · P2 · The console gives up after 30 seconds on actions the control plane is still running

**0.1.x**: the console waited 45 seconds for the platform's first byte.

**1.0 now**
- The console stops waiting after 30 seconds and shows "The Nearzero API didn't answer within 30 seconds…", while the control plane keeps working.
- These actions answer only when they finish, and can legitimately take longer:
  - a backup destination's Test connection (up to 180 seconds the first time on a server);
  - the backup file list for Restore (120 seconds);
  - a server's Check again (SSH sign-in, then up to 120 seconds);
  - the security audit (60 seconds);
  - Analytics reads of a large request log (60 seconds per piece);
  - Delete all request logs (60 seconds).
- The person sees a timeout for something that then succeeds, or fails, unseen.

**Expected 1.0 (acceptance)**
- On a server whose first destination test takes 50 seconds, Test connection shows the real result.
- No console action whose route can legitimately run past 30 seconds ends in the 30-second message. Either the console waits as long as the route may, or the route answers at once and the console follows its progress.

**Spec**: 23.5 sets no rule for long synchronous actions (spec gap).

### G4-14 · P2 · Registration has no rate limit

**0.1.x**: sign-in and sign-up were each limited to 3 requests per 10 seconds per client address, and every other sign-in-related route to 100 per 10 seconds. Too many got 429 "Too many requests. Please try again later." with a retry time.

**1.0 now**
- Registering has no limit.
- It answers "An account already exists with this email. Log in instead.", so which addresses have accounts can be checked as fast as requests can be sent.
- In open registration, accounts can be created just as fast.
- Limits exist only for sign-in, two-factor, password checks, email confirmation and change, and invitation resends.

**Expected 1.0 (acceptance)**
- More than a few registration attempts from one client address in a short window (for example more than 3 in 10 seconds, or 10 in 15 minutes) get 429 with how long to wait.
- The limit survives a restart, like the sign-in limits.

**Spec**: 22.4 rule 9 lists no registration limit (spec gap).

### G4-15 · P2 · Runtime log lines carry no timestamps

**0.1.x**: container logs, both streamed in the console and read by the Agent, carry the time Docker recorded for every line.

**1.0 now**
- The Logs tab, its Copy and Download, and the Agent's runtime log read have no times.
- A person using "Since" can't tell when any line was printed, and the Agent can't say when an error happened.

**Expected 1.0 (acceptance)**
- Each runtime log line in the Logs tab, and in Copy and Download, starts with the time Docker recorded for it, or a "Show timestamps" switch adds it.
- The Agent's runtime log read includes the times.

**Spec**: 6.7 (spec gap).

### G4-16 · P2 · File mounts over 1 MB are refused

**0.1.x**: a file mount's contents had no practical size limit. Requests up to 1 GB were accepted.

**1.0 now**
- Saving a file mount over 1 MB is refused: "A file mount can hold up to 1 MB."
- A moved app or Compose service with a larger mount (a certificate bundle, a seed file, a large config) fails only when it deploys. The import doesn't mention it.

**Expected 1.0 (acceptance)**
- Spec 6.8 states the limit with that wording, or the limit is raised.
- The import report names every moved file mount over the limit before anything is deployed.

**Spec**: 6.8 (spec gap).

### G4-17 · P2 · A GET to a deploy webhook address stops deploying with no clue why

**0.1.x**: the deploy webhook answered any method, so a GET (a CI step, a cron `curl` without `-X POST`, a registry that sends GET) deployed.

**1.0 now**
- Only POST reaches the webhook.
- A GET to a 1.0 address, or to a moved 0.1.x address, gets a page-not-found or "There is no API endpoint at GET …".
- A script that worked for years stops deploying, and nothing says it's the method.

**Expected 1.0 (acceptance)**
- A GET to a 1.0 or moved 0.1.x deploy webhook address deploys nothing and answers 405 "Call this webhook with POST."
- The import report notes that 0.1.x also accepted GET.
- Deploying only on POST is right (link previewers used to trigger deploys), so this isn't a request to deploy on GET.

**Spec**: 6.6 and 29.5 (spec gap).

---

## New gaps: the installer, the `nearzero` command and settings

### G4-02 · P1 · The installer tells older 0.1.x servers to run an address 0.1.x never publishes

**0.1.x**: 0.1.x's release process, including the final release, publishes versioned installers only at `https://cdn.nearzero.dev/releases/<version>/install.sh` (with `.sha256`).

**1.0 now**
- On a server running a 0.1.x release older than the final one, the installer stops with "This server runs Nearzero <version>. Update it to 0.1.80 first: curl -fsSL https://cdn.nearzero.dev/v0.1.80/install.sh | sudo bash. Then run this install command again."
- That address is never published, so the command fails. The root `install.sh` is 1.0's, so there's no other address to try.
- Everyone on 0.1.79 or older is stuck at the first step of the move.

**Expected 1.0 (acceptance)**
- On a 0.1.79 server, the command the installer prints downloads the final 0.1.x installer with a checksum beside it, and running it updates the server to the final 0.1.x release.
- Either the final 0.1.x release is published at the address 1.0 prints, or 1.0 prints `https://cdn.nearzero.dev/releases/0.1.80/install.sh`.

**Spec**: 29.2 and 3.2 give no address (spec gap). The same root cause is behind R4-02 above.

### G4-18 · P2 · Builder image pins and router settings given at install reach only the Nearzero host

**0.1.x**
- The builder image pins (`NEARZERO_HEROKU_BUILDER_IMAGE`, `NEARZERO_PAKETO_BUILDER_IMAGE`, `NEARZERO_RAILPACK_FRONTEND_IMAGE`, `NEARZERO_STATIC_NGINX_IMAGE`) applied to every build on every server.
- The router image (`TRAEFIK_IMAGE`) applied to the router on the host and on every server set up.

**1.0 now**
- The pins and the router image and ports given at install reach the Nearzero host's runner only.
- Remote servers build with the release's own builder images and run the default router image. The installer's own guide says the pins are "for the host's runner".

**Expected 1.0 (acceptance)**
- A builder pin or router image given at install applies to builds and routers on every server: new setups, and existing servers after a rerun.
- Or spec 3.5 and the install guide say plainly that they apply to the Nearzero host only, and name what applies to remote servers.

**Spec**: 3.5 (spec gap).

### G4-19 · P2 · 0.1.x setting names that 1.0 neither reads nor names

**0.1.x accepted, among its documented and generated settings:**
- `TRAEFIK_IMAGE`; and, when set, `TRAEFIK_PORT`, `TRAEFIK_SSL_PORT` and `TRAEFIK_HTTP3_PORT`.
- `BETTER_AUTH_URL` and `PUBLIC_GIT_PROVIDER_BASE_URL`. The second is documented as the "Public HTTPS URL used in Git provider OAuth callbacks and GitHub App webhooks", and the 0.1.x install guide says explicit overrides of both are kept.
- `NEARZERO_MONITORING_IMAGE`, `NEARZERO_SCHEDULE_IMAGE`, `TRAEFIK_SOCKET_PROXY_IMAGE`, `NEARZERO_ALLOW_MONITORING_DOCKER_METADATA`, `JOBS_URL`, `API_KEY`, `POSTGRES_USER` and `POSTGRES_DB`.

**1.0 now**
- None of these is read, and none is named as ignored. Only two metrics settings get an "ignored" note.
- After a move, the router goes back to the default image and ports.
- A Git callback address an operator set through `PUBLIC_GIT_PROVIDER_BASE_URL` is no longer used.

**Expected 1.0 (acceptance)**
- Where 1.0 has a matching setting, the 0.1.x name is read as an alias:
  - `TRAEFIK_IMAGE` → the router image;
  - `TRAEFIK_PORT` and `TRAEFIK_SSL_PORT` → the HTTP and HTTPS ports;
  - `BETTER_AUTH_URL` → the console address, when `NEARZERO_CONSOLE_URL` and `CONSOLE_URL` aren't set;
  - `PUBLIC_GIT_PROVIDER_BASE_URL` → the address used for Git callbacks and webhook URLs.
- Every other 0.1.x name is named once as ignored, by the installer and in the control plane's start log.

**Spec**: 3.1 says every setting name 0.1.x accepted keeps working, but the 3.5 table is incomplete (spec gap). Punch item 35's "Not done" note is stale: everything the 3.5 table lists is read by both the installer and the control plane. The names above are what's left.

### G4-20 · P2 · A rerun asks for a domain even when the console's hostname is saved under About Nearzero

**0.1.x**: a rerun skipped the domain question when the console already had a hostname saved, including one saved from the console.

**1.0 now**
- The installer asks whenever its settings file has no platform domain or console hostname.
- A hostname saved under About Nearzero → Configure public domain is stored only in the database, so a rerun asks again.
- Answering writes a second, different console hostname with no refusal, against the "changing an existing hostname is refused" rule.

**Expected 1.0 (acceptance)**
- With a hostname saved under About Nearzero, a rerun doesn't ask for a domain.
- A different `NEARZERO_MANAGEMENT_HOSTNAME` on that rerun is refused with the migration steps, unless `NEARZERO_CONFIRM_ADDRESS_CHANGE=true` is set.

**Spec**: 3.2 ("unless the console already has a hostname saved").

### G4-21 · P2 · Webhook URLs and other generated links ignore the hostname saved under About Nearzero

**0.1.x**: once the console had a saved hostname, deploy webhook URLs used `https://<hostname>`. Otherwise they used the console address setting.

**1.0 now**
- Every address 1.0 generates comes from the console address fixed at start (the console address setting, the install's hostname, or `http://<public IP>:4321`).
- After Configure public domain, these still use the old address until the installer runs again with the hostname:
  - the Webhook tab's Copy and the Agent's webhook answers;
  - webhooks Nearzero registers at GitLab, Gitea and Bitbucket;
  - GitLab and Gitea OAuth redirect addresses;
  - invitation links and notification links.
- Once the person blocks ports 4321 and 3000, as the security guide advises when HTTPS works, pushes registered that way stop deploying and links stop opening.
- New servers' runner addresses have the same cause (G3-01).

**Expected 1.0 (acceptance)**
- Once the saved hostname's certificate is valid, Copy on the Webhook tab gives `https://<hostname>/api/v1/webhooks/deploy/<token>`.
- Webhooks registered from then on, invitation and notification links, and OAuth redirects use the hostname, without a rerun.

**Spec**: 6.6, 10.9 and 18.2 don't say which address generated links use (spec gap).

### G4-22 · P2 · An interactive install with only `NEARZERO_ADMIN_EMAIL` set generates a password instead of asking

**0.1.x**: at a terminal it asked "Email [<given>]:" and then the password twice. A password was generated only when there was no terminal.

**1.0 now**: when an email is given, it never asks for the account, even at a terminal. It generates a password and prints it once.

**Expected 1.0 (acceptance)**: at a terminal, without `--unattended`, with only `NEARZERO_ADMIN_EMAIL` set, the installer asks for the password (twice), with the email filled in. Unattended runs keep generating one, as 3.1 says.

**Spec**: 3.1 defines the email-only rule for unattended installs only (spec gap for interactive ones).

### G4-23 · P2 · `sudo nearzero logs` takes one service name and no options

**0.1.x**: everything after `logs` went to Docker Compose's logs command. Several services, `--tail N`, `--since T` and `--timestamps` all worked, as did `sudo nearzero logs --tail 100 platform`.

**1.0 now**
- Only the first word is read.
- `sudo nearzero logs --tail 50 control` answers "There's no Nearzero service called --tail…".
- Extra service names are ignored, and output always starts from the last 200 lines.

**Expected 1.0 (acceptance)**
- `sudo nearzero logs control runner` follows both.
- `--tail N`, `--since T` and `--timestamps` work with any service, the 0.1.x names included.

**Spec**: 3.4 (`logs [service]`).

### G4-24 · P2 · Installer wording

**0.1.x and spec 3.1**
- **Rerun summary:** "Sign in <email>  (the existing account and its password)", then "Forgot that password? Run: sudo nearzero reset-password".
- **Apps line:** shows the form apps' addresses take under the domain.
- **Domain skip:** answering "n" or Enter at "Add a domain…? [y/N]" prints "Skipped. Run this install command again to add one." Spec 3.1 asks for that wording on every skip.

**1.0 now**
- **Rerun summary:** shows only "Sign in <email>".
- **Apps line:** shows a made-up random address that belongs to no app, which reads as if an app were already live there.
- **Domain skip:** answering "n" or Enter at the y/N question prints nothing. Only skipping later, at the domain or records step, prints the line.

**Expected 1.0 (acceptance)**: each line appears as in 0.1.x. The Apps line is plainly an example ("Apps get addresses like https://<label>.<domain>").

**Spec**: 3.1.

---

## The API surface, 0.1.x to 1.0 (changes since round 2)

Round 2's mapping by area (30d, "The API surface") still holds. Every route a person can reach through the console or the Agent has a 1.0 equivalent, except the ones spec 27 drops. This round adds:

| 0.1.x | 1.0 | Note |
| --- | --- | --- |
| `GET /api/health` (console and API port) | Answered, the same as `/api/v1/health` | R4-11 fixed |
| Deploy webhooks, any method | POST only | G4-17 |
| Deploy webhook bodies of any size; the GitHub App webhook too | 1 MB for deploy webhooks, 3 MB elsewhere | G2-04 |
| 0.1.x GitHub App setup, GitLab and Gitea callback addresses | Answered with a redirect to 1.0's pages, query kept | R4-15 fixed |
| Audit events: produced, never readable | `sudo nearzero audit` with a date range | R4-16 fixed |
| Webhook and other generated addresses follow the saved console hostname | Fixed at start | G4-21 |

**Auth, errors and pagination**: unchanged from round 2.
- A session cookie only (HttpOnly, SameSite=Lax, Secure on HTTPS, 7 days, renewed on use).
- One error shape with a request id.
- Server-side paging of deployments, with fixed caps on lists and log tails.
- New this round: registration has no attempt limit (G4-14).

---

## Checked and found at parity

**Agent actions and safety**
- Every 0.1.79 model action has a 1.0 equivalent, except spec 27's drops and the items above.
- Inputs are refused as before: Git URLs with a user, token, query or fragment; secret-looking commands; file-mount and Compose contents; passwords; generic project names; "prod" and "prd"; "..".
- A new server needs an explicit SSH user. A key added in the same chat needs no "Read SSH keys". Rename, list and delete keys each have their own policy.
- Policies: 16 switches with the same defaults, groups and dependencies.
  - The production gate covers every create, change and deploy, environment creation included.
  - "Allow and continue" is for owners and admins only and never allows production. Members get their own text.
  - Policies are re-checked when an answered form runs.
- Results the model sees have secrets and ids removed and URL credentials stripped, and content is labelled as data. The operator's text is appended, never a replacement. Changes and refusals are audited with actor Agent.

**Guided flows**
- Create project: generic names go to the name form, and odd names are refused.
- Delete project:
  - near-match, several and none texts;
  - production is never deleted;
  - the service list is re-checked at confirmation;
  - an empty project is deleted at once.
- "deploy <name>":
  - typos are tolerated, and duplicates get a picker;
  - databases go to the model, and anything else unmatched goes to the Git import;
  - the variables form comes first for a never-deployed service.
- Git import:
  - picks, in order: provider, repository, branch, project ("New project" never silently), then server with the Nearzero host;
  - inspection, variables before the first deploy, and a 20-minute follow;
  - connect-and-return within 30 minutes, and the members' text.
- Keep-going after a failed guided deploy:
  - a missing tool;
  - missing variables from the log, each asked at most twice;
  - one switch from Dockerfile to Railpack;
  - the 25-line tail, then hand-over to the model.
- The pasted-link flow's access card, its texts, Check again and the branch picker (R4-01's fixed part).

**Sessions, streaming and errors**
- Sessions: 50 listed; provisional and generated titles; rename limits and texts; reorder; the delete rules and texts; Share with workspace.
- Retry and Edit only on the last turn, as in 0.1.x.
- Streaming: server-sent events with a 15-second keep-alive and resume from the last event.
- One turn per chat. Stop by the author or with Escape. Turns are marked stopped after a restart (new).
- Loop rules:
  - 30 rounds (60 with Deep research), with a closing summary and its fallback;
  - the repeat guard and the 6-deploy cap;
  - malformed input sent back, and results cut at 12,000 characters;
  - the empty-reply nudge and texts, and the kill-switch text.

**Provider, keys, attachments and research**
- Provider:
  - retries at 1 s and 3 s, or retry-after up to 10 s, and the 120-second silence cut;
  - rejected-key and out-of-credits texts;
  - no server-environment key is used.
- Missing keys: owners and admins get the inline form, members the pointer and waiting label. A member's waiting question is answered once a key is saved.
- Attachments:
  - per-kind limits, refused kinds and their wording;
  - Word and PDF text extraction and inline caps, and the image budget;
  - unsent uploads pruned after a day and capped per person;
  - images open inline, everything else downloads.
- Research: 1 to 10 results, queries up to 500 characters, pages cut at 10,000, Firecrawl's 401, 402 and 429 explained, and actions offered only with a key.

**Webhooks in and out**
- Deploy webhooks:
  - tokens are stored hashed and checked in constant time, and a replaced token stops the old address;
  - 30 calls a minute, and a burst queues one deploy;
  - autodeploy off, pings, non-push events, branch, tag, watch-path and skip-keyword rules, Bitbucket push bodies, and registry image and tag matching;
  - upload sources are refused.
- GitHub App and provider webhooks: signatures are checked on the raw body. Duplicate deliveries are ignored (new).
- Notifications out:
  - all 12 kinds;
  - a 10-second timeout per send, with 3 retries (0.1.x had none);
  - secrets scrubbed from failure reasons;
  - private addresses refused unless an instance administrator set them;
  - SMTP over TLS or STARTTLS.

**Live updates**
- Deploy, setup and backup logs, the deployments list and Agent turns stream with resume.
- Container logs check access first and offer tail 100, 500, 1,000 or all, a since time, search and follow.
- Terminals need deploy rights, offer sh or bash, resize, send pings and are audited.

**Security**
- Changes and WebSocket upgrades are origin-checked, only JSON bodies are accepted for changes, and sign-out is POST only.
- OAuth state is per person, single use, and lasts 30 minutes.
- Forwarded headers are trusted only from known proxies.
- Sign-in, two-factor, password, email-change and invitation-resend limits survive restarts.
- Secrets are sealed at rest and never returned. API answers are no-store.
- A scan of every route found an access check on each, except health, runner enrollment and the token- or signature-checked webhooks.
- Neither version sends CSP or frame headers.

**Performance**
- Bodies are limited to 3 MB, uploads to 200 MB and WebSocket frames to 4 MB.
- Branch lists are capped at 200, with a field to type any name. Deployments are paged by the server, and 50 are kept per service.
- The console's time limit covers the first byte only, so streams aren't cut (but see G4-13).

**Email**
- Invitations go through the workspace's Resend key, or the server's Resend or SMTP settings. Without email, the inviter gets a link to copy.
- SMTP security can be TLS, STARTTLS or none, and there's a test email.

**Background jobs and schedules**
- One scheduler, kept in the database, runs:
  - backups with retention, and tasks;
  - the Docker cleanup at 23:50 in each server's time zone, with its notification;
  - request-log cleanup and metrics pruning (2 days);
  - deployment retention, and pruning of identity records and finished jobs.
- Retries back off (5 s, doubling, up to 10 minutes). Work runs on leases that are renewed, and a task run never runs twice.
- Builds are capped at 60 minutes, as 0.1.x's build phase was. "Nearzero restart" notifications are sent. The router renews certificates.

**Installer and `nearzero` command**
- Checks and Docker:
  - root check with a sudo rerun, and Linux and architecture checks;
  - Docker from each distribution's packages, and `SKIP_DOCKER_INSTALL`;
  - a pinned Compose plugin with a checksum.
- Questions:
  - every question comes before any download;
  - the domain flow with its DNS check, "skip" and "use";
  - unattended account rules;
  - value rules, and a broken settings line stops with its line number.
- Images only move to a newer version, and custom ones are kept. Address changes need `NEARZERO_CONFIRM_ADDRESS_CHANGE`.
- Failure output: the last 25 lines, or the service states and last 60 lines after a 300-second start timeout.
- The install log is kept at mode 0600, and `REDIS_URL` is accepted with a note.
- New in 1.0: port checks, the "data without its settings" stop, a dry-run report, and log rotation.
- Every 0.1.x subcommand is present, and `status`, `restart` and `update` now wait until Nearzero is healthy. `restore-db` asks first. `reset-2fa`, `audit`, `import` and `migrate` are new.
- The uninstaller: root only, `--yes` and `NEARZERO_UNINSTALL_YES`, refuses without a terminal, and removes only what carries 1.0's label.

**Platform**
- Structured logs carry the request id and the version.
- The image's health check tests both the API and the console.
- `/api/health` and `/api/v1/health` report the version and the database check.
- The version shows on About Nearzero and in `nearzero status`.
- Neither version has a real update check (D4 still open).

---

## Notes for builders and the spec

- **20.9 against 9.6:** 20.9's "Refused while any service still runs on it" is what led to G4-01. It should read like 9.6: the Agent refuses any server that has services.
- **R3-06, being built now:** spec 30's decision opens Check again and the read-only audit to anyone who can see the server. The Agent's validate and audit actions still need the server's manage rights, so they must change with it. Acceptance: a member who can see but not manage a server can ask the Agent to validate or audit it.
- **Punch item 35:** its "Not done" status is stale for the names the 3.5 table lists. What's left is in G4-19.
- **An action the model can't use:** the Agent offers the model a "copy a service to other environments" action that always answers "This isn't available in this version of Nearzero yet…". 0.1.x had no such action, so this isn't a parity gap. Either hide it from the model or build it.
