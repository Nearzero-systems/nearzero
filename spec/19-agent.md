# 19. The Agent

The Agent is a chat in the console that operates Nearzero for the person. It uses the same actions a person has, under the same permission checks, plus workspace policies that decide what it may change. Its capability list is in [20-agent-capabilities.md](20-agent-capabilities.md).

## 19.1 Page layout

Three parts: the sessions list on the left, the conversation in the middle, the message box docked at the bottom. Under the box, always: "AI answers can be wrong. Check important changes before you rely on them."

The Agent is the first item in the sidebar and the page people land on after sign-in.

## 19.2 The empty chat (home)

- **Greeting**: two large lines, chosen at random for each new chat.
  - Line 1 by time of day: "Good morning, {first name}", "Good afternoon, …", "Good evening, …", or "Hi {first name},".
  - Line 2, one of: "What should we deploy today?", "What are we shipping?", "How can I help?", "What should we work on?".
  - An instance operator may replace the greeting with fixed text that may include the first name.
- **Real names only**: when the stored first name looks derived from the email address (it contains digits, is longer than 12 letters, or is a generic handle such as "owner" or "admin"), the greeting says "there" instead, and a small form appears under it: "What should I call you?" (one field, up to 80 characters, Save). Saving updates the person's profile. The Agent itself never asks for a name.
- **Starters**: four, in this order:
  1. "Deploy a Git repository" (sends at once)
  2. "Which of my servers are ready for deployments?" (sends)
  3. "Why did my last deployment fail?" (sends)
  4. "Set up a server" (only fills the box with "Set up the server " for the person to finish)
- In Dusk, the home shows the moon, the sunrise and the numbered starter grid ([21-design-system.md](21-design-system.md) 21.5).

## 19.3 The message box

- Grows up to about 8 lines.
- On a computer, Enter sends and Shift+Enter adds a line. On a phone, Return adds a line and the send button sends. Ctrl/Cmd+Enter sends everywhere.
- Placeholder: "Ask Agent to deploy, check logs, or set up a server…"; with a quote attached, "Ask about the quoted text…".
- Hint beside the send button: "Enter to send · Shift+Enter for a new line".
- **Attach** ("+" button, drop on the box, or paste): each file becomes a chip with upload progress, which can be cancelled or removed and shows any error or notice on hover. At most 3 uploads run at once. Sending waits until all uploads finish.
- **Deep research** toggle beside the attach button (see 19.10).
- **Send / Stop**: one button. An arrow sends; while the Agent works it becomes Stop.
- No model picker.

## 19.4 How a conversation renders

**The person's message**: a grey bubble on the right (in Dusk, a light purple tint), with attachments (image thumbnails or file chips with name and size) and any quote. Long messages (over 10 lines or 700 characters) fold to 8 lines and expand on click.

**The Agent's answer**: Markdown with headings, lists, quotes, inline code and tables (wide tables scroll sideways). Table syntax written inline is turned into a real table. Code blocks are cards in the theme's `code` color with a language label and Copy, folded after 24 lines ("Show more (N more lines)"). Links open in a new tab. Internal ids are removed from answer text before display.

**The Agent's mark**: shown only above the answer being worked on, animated; it folds away when that answer ends. Finished answers have no mark.

**Live status line** (while working): animated dots, what it is doing (the running step, "Writing", "Thinking" or "Stopping"), elapsed time after the first second, and "esc to stop". While waiting on a form it shows what it waits for (for example "Waiting for the SSH key").

**Steps in line**: every action appears as a row between the Agent's words, in the order it happened:
- icon: spinner, check, cross, lock (needs permission) or stop
- label in the present tense while running ("Setting up server") and past tense when done ("Set up the server")
- a short target, never an id: "prod-1", "acme/web", "web on prod-1", "3 found"
- a state chip when relevant: "Failed" (red), "Stopped", "Needs permission"
- the row expands to show the reason and the raw result (folded after 14 lines or 1,600 characters, capped at 6,000)
- a failed step shows its reason (up to 280 characters) under the row even when collapsed

**Turn footer**: "Worked for 34s · 3 steps" (plus "N failed"), or "Stopped after 12s". Time counts only while the Agent worked, not while it waited for the person.
- **Copy**: copies the turn's answer text; toast "Copied to clipboard".
- **Retry**: only on the last turn, and only when it failed (error, or steps with no final text) or was stopped; re-sends the same question and attachments as a new message.
- **Edit**: only on the last finished question; puts it (and its quote) back in the box. Sending makes a new turn; the old one stays.
- **Errors**: red, with an alert icon; they stay red after a reload.

**Ask about a selection**: selecting text inside an answer shows an "Ask Agent" button under the selection. It attaches up to 1,200 characters as a quote chip above the box; the quote is sent as quoted lines before the question.

**Suggested follow-ups**: after a normal answer (not after an error, stop, form or key prompt), up to 3 next requests appear under "Suggested". Each is written as the person's own words, at most 9 words, names a real resource where possible, and never offers something the Agent can't do (firewalls, logging in to a server, rebooting, editing authorized keys). Clicking one sends it. If none can be produced, nothing shows.

**Scrolling**: the chat follows new text; scrolling up stops following and shows "Jump to latest".

**Acceptance**
- A three-step turn shows three rows in order between the words, each with a target and no id, and a footer with the correct count.
- After a reload, the same turn shows the same rows (guided-flow steps included; today they are lost on reload, see 19.12).
- Retry is absent on a successful last turn and present on a failed one.

## 19.5 Sessions

- **Visibility**: private to their author, with "Share with workspace" (decision D4). Others can read a shared session but not send, rename or delete; shared sessions of others are listed separately. Steps that touched something the viewer can't see show no target or result. Only the author can use "Allow and continue". Whatever is chosen, tool results are filtered by the viewer's own access, and a file sent in a chat is visible to the session's viewers only after it is sent; before that, only to its uploader.
- **List**: up to 50 sessions, newest on top until someone reorders. Each row: a working indicator when that session is running, the title, and a relative time of its last message. "+ New session" on top. Empty state: "No sessions yet. Start one above." Hovering or focusing a row preloads it.
- **Titles**: on send, a provisional title from the first 8 words of the question (at most 72 characters, quotes left out; a files-only message is named after the first file). A small model then writes a 2 to 5 word title in sentence case within 6 seconds ("Greeting" for small talk). A name the person set in the meantime is never overwritten. No title shows "Untitled session".
- **Rename**: from the ⋯ menu or by double-click; the name opens selected; Enter or clicking away saves, Escape cancels. One line, 1 to 80 characters. Errors: "Enter a name for the session." / "Session names can be up to 80 characters."
- **Reorder**: "Move up" / "Move down" in the ⋯ menu, or drag a row (a 4px movement starts the drag; on touch screens only the grip handle drags; Escape cancels a drag without stopping a running answer). Moving swaps the positions sessions already hold, so a new session still lands on top and sessions beyond the 50 shown keep their place. If the list changed meanwhile: "The sessions changed while you were moving them. Try again." New messages do not move a session.
- **Delete**: "Delete…" opens an inline confirm: "Delete "<title>"? Its messages and files are deleted. This can't be undone." with Cancel and Delete. Disabled while the session runs on this page ("Stop this session to delete it."); refused if it runs elsewhere ("This session is still working. Stop it, then delete it."). Deleting a session that is already gone counts as success.
- **Errors**: every failed list action shows its reason in a dismissible line under "New session" (the server's words for 4xx; a generic retry message for 5xx and network errors). Nothing fails silently.
- **Phones** (under 720px): the list slides in from the left over the chat (width the smaller of 18rem and 85%) over a dimmed backdrop that closes it; a bar above the chat has "Chat history" and "New session" buttons; picking a session closes the list.

## 19.6 Turn lifecycle

- **Streaming**: sending opens a live stream from the platform. Headers go out at once and a keep-alive at least every 15 seconds, so long deploys and setups never time out. Every event is saved as it happens.
- **Survives the browser**: closing the tab or navigating away does not stop a turn. Opening the chat again shows what came before, replays the turn's saved events, then follows it live. A page follows one live turn at a time.
- **Survives the platform** (new in 1.0): if the platform restarts mid-turn, the turn is marked "Stopped (Nearzero restarted)" with what was done so far; it is never left half-saved. Actions already running (a deploy) continue on their own and remain visible in Deployments.
- **One turn per chat**: a second message to a busy chat is refused: "The Agent is still working on the last message in this chat. Wait for it to finish, then send this again." The send button is disabled while viewing a running chat.
- **Stop**: the Stop button or Escape in the chat (when no other field or dialog has focus). The model request is cancelled; an action already running (for example a deploy) continues by itself. Words so far are kept; running steps become "Stopped". A Stop pressed before a new chat exists on the server is sent as soon as it does.
- **Step limits**: at most 30 model rounds per request (60 with Deep research). At the limit, the model is asked, with actions disabled, for a closing summary: what was done, what is still running, what to ask next. If that fails: "I reached the maximum number of tool steps for this request. Ask me to continue and I'll pick up from here."
- **Repeat guard**: an identical action with identical inputs that already failed twice in the request is not run again; the model is told to change approach.
- **Deploy cap** (new in 1.0, enforced): at most 6 deployments of the same service per request.
- **Empty replies**: one nudge asking for a summary. If still empty and no actions ran: "Nearzero Agent received an empty model response. Send your message again." If actions ran, a short text points to the step results.
- **Malformed action input** from the model is returned to it as an error asking for a proper call.
- **Action results** given to the model are cut at 12,000 characters.
- **Provider errors**: network errors, timeouts, rate limits and server errors are retried up to 2 more times (1s then 3s, or the provider's retry-after up to 10s), only while nothing has reached the screen. No data from the provider for 120 seconds aborts the request with a message saying so. A rejected key and an out-of-credits answer have their own messages (19.9).
- **Kill switch**: an instance operator can turn the Agent off; every message then gets "Nearzero Agent is disabled."
- **Audit**: every change the Agent makes and every policy refusal is recorded with actor "Agent", the person who asked, their role and the session. Secret-looking values in the record are redacted.

## 19.7 Guided flows

Some requests run a fixed sequence before (or instead of) the model, because a fixed sequence is faster and safer. Each step shows as a row; choices are asked with pickers; replies stream like model text. A message with several clauses ("delete X and then create Y") runs each clause in order; the first clause no flow handles, and everything after it, goes to the model in the same turn. Flows run even without a model key. When "Create and configure services" is off, the variables form is skipped and the missing names are stated in text.

### Create a project
- Triggered by "create/make/add/start/set up a project", optionally "called/named X".
- With a usable name: creates it and replies "Created **X** with a **development** environment."
- No name, or a generic one ("new project", "my project", "project 2", "untitled"): opens the project-name form.
- Not triggered by pronouns ("start it again"), other resources ("create a service"), names longer than 6 words or starting with a preposition, or sentences that merely contain both words.

### Delete a project
- Triggered by a delete verb (remove, delete, drop, destroy, get rid of, eliminate) and a project named as a whole word.
- Left to the model when negated ("don't delete web"), when the target is another kind of thing (service, database, server, domain, key, logs, branch) unless "project" is said, or when, without "project", the name is not an exact project name.
- Policy first ("Delete projects without production"); a refusal is plain text pointing to Agent policies.
- Near match: "Did you mean **X**? To delete it, say "delete X"." Several matches: "Multiple projects match: …". None: "There is no project called "…". Your projects: …".
- A project with any production environment is never deleted by the Agent.
- An empty project is deleted at once. Otherwise the confirmation form appears (19.8). Deletion runs only for the exact services confirmed; if they changed in between, the form shows again.
- Each service's removal is its own step ("Removing service · web on prod-1"). The reply is a table: Service | Server | Result (Removed / Already gone / Not removed) | Notes. The project is kept if any service could not be removed.
- A delete the model asks for goes through the same confirmation.

### "deploy <name>"
- Triggered by a short message that is only "(re)deploy / ship / launch [the|my|our] <name> [app|service|repo] [please|again|now]". Pronouns, generic words and messages with a Git URL go to the model.
- One matching app or Compose service (typos tolerated): deploy it through the keep-going loop below. A never-deployed service with no variables gets the variables form first.
- Several matches: picker "More than one service is called "X". Which one should I deploy?", options labelled project / environment.
- None: database words go to the model; anything else is treated as a repository name and starts the Git import (typos tolerated), or opens the repository picker sorted by closeness: "No service or repository is called "X". Choose the repository to deploy".

### Import from Git
Triggered by import/add/create/connect/set up/run/deploy/launch/spin up together with service/app/repo, or "connect my GitHub". Not triggered by an explicit Git URL (a link to one of the four public hosts is the pasted-link flow below; other URLs go to the model) or by talk of images, databases, Compose or templates without Git words. "just import" or "don't deploy" creates without deploying.

What the request says about the new service is honoured, never dropped (31d G4-06): a builder ("with nixpacks", "with its Dockerfile", "using the static builder", Railpack, Heroku, Paketo, Compose, automatic detection), a folder ("from the apps/api folder", "folder apps/api", "from ./apps/api"), and a name ("as api"). A folder the repository doesn't have, or a named Dockerfile or Compose file that isn't there, creates nothing and says so; a name already taken in the environment creates nothing and says so. A request with details the import has no step for (commands, ports, variables, domains, an environment such as production, a database, several builders, a path outside the repository) goes to the model instead.

Each step is skipped when its answer is already known:
1. **Provider**: none usable → a form with Connect buttons for GitHub, GitLab, Bitbucket and Gitea that go to Git provider settings and come back to the same chat, resuming automatically (the pending return is kept 30 minutes). A person who may not connect accounts gets "You don't have a Git account you can use here. Ask an owner or admin…". Several → picker.
2. **Repository**: the one named ("owner/name", or a name; common words like app/api/web count only as owner/name or right before "repo"), otherwise a searchable list (up to 200). An empty list says to grant the GitHub app access to repositories.
3. **Branch**: the default branch, else main or master, else the only one, else a list (up to 200).
4. **Project**: one named as the destination ("into shop", "in the shop project"), otherwise a picker with "New project "<repo>"" first. Never picks the only existing project silently. Environment: "development", else the first non-production one; a production-only project is refused unless production changes are allowed.
5. **Server**: one named in the request; otherwise, when ready servers exist, a picker of them plus "Nearzero host — the machine Nearzero itself runs on". With no ready server, 1.0 says it will use the Nearzero host in the reply rather than doing so silently.
6. **How to run**: the repository is inspected through the provider's API without cloning (the branch's file list plus up to 12 small manifest files, up to 3 folders deep):
   - a root Dockerfile is used; with a Compose file too, the person chooses;
   - a Compose file alone is used;
   - a root language manifest (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, Gemfile, composer.json, pom.xml and similar) is used;
   - a monorepo lists each runnable folder (Dockerfile folders first; workspace packages only if they start something);
   - a JavaScript workspace root or a root index.html is used directly;
   - nothing fits: "I couldn't tell how to run … Nothing was created. Add a Dockerfile…";
   - several fit: picker "How should owner/repo run?" with a description per option ("Every service in the compose file", "Build this Dockerfile as one app", "Serve the files as a static site", "Nearzero detects the language and builds it").
   - Variable names are collected from example env files (.env.example and similar) and schema files that read env vars.
7. **Create**: the project if new, then the app or Compose service. A repository with a Dockerfile builds with it explicitly.
8. **Variables**: the variables form is always shown before the first deploy, prefilled with the collected names, or asking "Does it need environment variables…".
9. **Deploy and wait**: deploy and follow for up to 20 minutes. Success → the live address(es), or the pending-DNS table, or "It has no domain yet". Still running → "Follow it under the service's Deployments". Cancelled → says so. An address is only ever called live after a successful deploy.

### A pasted repository link
A link to github.com, gitlab.com, bitbucket.org or codeberg.org (https, bare, `.git` or `/tree/<branch>`) runs a checked import when it is alone, or when the message also has a word asking for a deploy (deploy, import, clone, run, launch, host, ship, publish, serve, start, set up, spin up, put it online, go live). Such a message has no length limit, and its clauses about the same repository stay together ("clone it and deploy this frontend", "it is a next.js app"). Questions about a link ("what does github.com/acme/web do?") and other requests ("fork it") go to the model.
1. A connected account that can see the repository is used, so pushes redeploy it.
2. Otherwise the host is asked over Git, with no login, whether anyone may read it. A public repository is deployed from its URL on the branch the link or message names when it has it, else its default branch. The reply ends with "Pushes to the repository don't redeploy it on their own, because no connected account can see it. Connect the account that owns it, or ask me for its deploy webhook."
3. Private or missing: nothing is created, and a card of buttons offers Give access on GitHub (opens the Nearzero GitHub App's install page and comes back to the chat), Connect <Host> and Check again.
Then it is the usual import, with the project, server, name, builder and folder the message gave. When the model creates an app from a link to those hosts, its action is checked the same way: a connected account first, then a public repository on its real default branch, else nothing is created and the same card is shown.

### Keep going after a failed deploy
Used by the import and by "deploy <name>":
- **Missing tool on the build machine** (for example "command not found"): builds run on the app's own server, so say to update Nearzero or re-run server setup on that server.
- **Missing variables named in the log** (recognized from common framework errors, "X is not set", connection refused to localhost on a database port matched against example names): show the variables form again for exactly those names, each asked at most twice.
- **Dockerfile build failed**: switch once to language detection (Railpack) and redeploy; if that fails too, the engine falls back to the repository's Dockerfile.
- **Anything else**: show "The deployment failed. The end of its log:" with the last 25 lines and "I'm finding the cause and fixing it.", then hand over to the model in the same turn with a hidden note (service, repository, branch, builders tried, variable names saved, last 80 log lines). The model fixes and redeploys, up to the deploy cap.
- Without a model key, the failure text is the answer.

### Pending DNS
When an app's address is under its server's own hostname zone and the record does not exist yet: "It's deployed. Its address is … It starts working once this DNS record exists…", a table Type | Name | Value | Proxy (A, the record name, the server's IP, "DNS only"), where the name points now, and an offer to use the person's own domain instead.

**Acceptance**
- "deploy github.com/acme/web" runs the checked pasted-link import; "what does github.com/acme/web do?" goes to the model.
- "deploy https://github.com/acme/web with its Dockerfile" builds with the Dockerfile, and "import gitlab.com/acme/api as api" names the service api.
- "remove the sdrever" (a typo of a server name) never triggers a project delete.
- "create a project and start it again" never creates a project named "it again".
- A Git import with a Dockerfile and a Compose file asks which to use; with only a package.json it builds automatically.
- A deploy failing on a missing DATABASE_URL shows the variables form for DATABASE_URL only, then redeploys.

## 19.8 Secure forms

Values entered in these forms go from the browser to the platform with the person's own session. The model learns only what each row below says.

| Form | Fields and behavior | What the model learns |
| --- | --- | --- |
| **Variables** | Why they're needed, plus "Values go straight to Nearzero; the Agent never sees them." One row per requested name (fixed, not removable); more rows can be added. Pasting a whole env file into any box fills the rows and reports what was filled, added and skipped (by line number only). Values hidden by default ("Show values" / "Hide values"); a counter "N of M set". Multi-line values refused ("put it on one line with \n"); duplicate or invalid names refused. Buttons "Save N variables and deploy" and "Deploy without them"; hint "Saved to the service. The Agent only learns the names." Values merge into the service's variables; the page forgets them after saving. | The names saved, and a note to redeploy and wait (or that nothing was saved) |
| **SSH key** | Name (prefilled with the Agent's suggestion, up to 100 characters) and two tabs. Generate: "Generate an ED25519 key", then the public key with Copy and "Add this public key to ~/.ssh/authorized_keys on the server". Paste: private and public key boxes. "Save key". | The key's name and an internal reference; a key added this way in the chat can be used for that chat's server or Git setup without the "Read SSH keys" policy |
| **Task script** | A summary (task, where it runs, schedule with time zone and next run, shell) and a code box (placeholder starts "set -euo pipefail…", or a database dump example for commands). "Check and schedule" (or "Check and save" when replacing): the script is syntax-checked without running and the schedule is validated; warnings change the button to "Schedule anyway" / "Save anyway". Cancel abandons. | Only that the task was saved; the reply reads it back: "Scheduled **X** on server Y. It runs `0 2 * * *` (UTC); the next run is … Want me to run it once now?" Cancel gives "Didn't create X" / "Kept the script…" |
| **Model-provider key** | A password field ("sk-or-…") inline under the onboarding reply, for owners and admins, if the "Ask for the OpenRouter key in chat" policy is on. After saving, the original question is re-sent and the "add a key" reply is removed from the chat and from the model's history. | Nothing |
| **Research key** | Shown above the box the first time Deep research is turned on with no key. Admins paste it; it is checked with the research provider ("Checking…", "Save and turn on"). Members are told who can add it. | Nothing |
| **Pickers** | Provider (Connect buttons with icons), repository, branch, project, server, how to run, which service. Up to 8 options show as buttons; more than 8, and every repository or branch list, show as an in-chat dropdown with search from 7 options, arrow keys and Enter. The chosen label becomes the person's message ("acme/web", "Project name: shop"). | The chosen label |
| **Project delete** | "Delete X and remove these N services from their servers? Their containers, volumes, files, logs, images, domains and DNS records are wiped. This cannot be undone." One line per service: "name — type on server (environment)". Buttons "Delete X and N services" (sub-text "Wipes their data from the servers") and "Keep it". | The choice |
| **Permission card** | See 19.9. | The choice |

Blanket rule: any form answer marked secret that reaches the chat endpoint is refused: "Secret input cannot be submitted through Agent chat."

**Acceptance**
- A test fills every secure form with unique marker values and then searches every stored message, every model request body and every audit record: no marker appears.
- Reviewing a task later does show its script to the model (the script is not a secret once saved; variables are).

## 19.9 Policies

Policies are per workspace, set in Settings → Agent policies by owners and admins. Intro text: reading projects, servers, deployments and logs is always allowed; every change is checked on the server against these switches and the person's role.

| Group | Policy | Default |
| --- | --- | --- |
| Projects | Create projects | On |
| Projects | Rename and describe projects (also covers creating environments) | On |
| Projects | Delete projects without production | Off |
| Apps and services | Create and configure services | On |
| Apps and services | Import from Git (needs Create and configure) | On |
| Apps and services | Assign domains (needs Create and configure) | On |
| Apps and services | Deploy and run services | On |
| Apps and services | Create and run tasks | On |
| SSH keys | Add SSH keys (through the secure form) | On |
| SSH keys | Read SSH keys | Off |
| SSH keys | Rename SSH keys | Off |
| SSH keys | Delete SSH keys | Off |
| Servers and access | Add and set up servers (also covers editing servers and running setup) | On |
| Servers and access | Remove servers | Off |
| Servers and access | Ask for the OpenRouter key in chat | On |
| Production | Change production environments | Off |

- Production has its own section. Turning it on requires typing `ALLOW PRODUCTION AGENT ACTIONS`; the platform enforces the phrase too, not just the page. With it off, the Agent can read production but cannot create, change or deploy anything there. An environment is production when its name is "production".
- Each switch has a one-line description of what it lets the Agent do; the SSH keys group has a short intro. One Save button for the page. Turning on Import from Git or Assign domains turns on Create and configure, and says "Also turned on <name>, which this needs."; turning that off turns both off and says "Also turned off <names>, which need it." The platform enforces the same dependency.
- Defaults apply to new workspaces and to workspaces that never saved the page.

**How refusals look**
- The step shows a lock and "Needs permission" with the reason.
- A card under the turn: "The Agent needs permission: "<policy>"…". Owners and admins get **Allow and continue** (turns the switches on and sends "Allowed "<policy>". Please continue.") and a link to Agent policies. Production cannot be allowed from the card: "Production changes are turned on in Agent policies, with a typed confirmation." Members see "Owners and admins decide what the Agent may do. Ask one…".
- The model says in one sentence what it needs and stops.
- Refusals inside guided flows are plain text with the settings hint.
- Role or access refusals (not policy) are ordinary failed steps in red.

## 19.10 Model provider, attachments and research

**Provider**
- Each workspace brings its own OpenRouter key. Keys in the server environment are not used for the Agent. The key is stored encrypted.
- The model is chosen by the instance operator (one default for the instance: a current Claude Sonnet model; titles and follow-ups use a current Claude Haiku model). There is no per-workspace or per-chat choice in 1.0. The docs must say this, not "a model you choose".
- No key: admins get "Hi, I'm Nearzero Agent… add your organization's OpenRouter API key" with the inline key field (or, if in-chat entry is off, a pointer to Settings → API keys). Members get "…ask an owner or admin… Settings → API keys", and the waiting label "Waiting for admin to configure OpenRouter". When an admin later adds a key, a member's waiting question is answered automatically (new in 1.0).
- A rejected key: the same prompt, prefixed "OpenRouter rejected the saved API key…". Out of credits: "…out of credits… Add credits at openrouter.ai".

**Attachments**
- Up to 10 files per message. Limits: images 10 MB, PDF 20 MB, Word documents 15 MB, text 10 MB, video 25 MB, with an overall cap of 25 MB the operator can change. Images are shrunk in the browser to 2,048px on the long side.
- Accepted: PNG, JPEG, WebP, GIF; PDF; .docx; text and code files (including logs, diffs and other text such as .out, .err, .patch, .diff, .jsonl, .ndjson, .text, .svg, .config, .nvmrc, and any *.example, *.sample or *.template file); MP4, WebM, MOV. A file without an extension is accepted when its bytes are text, and a text-named file whose bytes aren't text (UTF-8 with no NUL byte) is refused: "This file's contents aren't text, so it isn't accepted as a text file. …" (31d G4-09).
- Refused, with a reason: env files (example, sample, template, dist and defaults variants are allowed), spreadsheets and slide decks ("Export it as CSV or PDF"), archives, HEIC and AVIF, legacy .doc ("Save it as .docx or PDF").
- On upload, a notice says if the model can't see images or watch videos. What the model can take is read from the provider's model listing and cached for 6 hours; unknown means text only.
- Images go to the model only if it supports them: at most 5 MB each, 8 per request, 16 MB in total, newest first. PDFs go through the provider's PDF reading, with its parser named in the request: the model's own reading when it reads PDFs, otherwise OpenRouter's free text parser, never its paid OCR unless the operator chooses it with `NEARZERO_AGENT_PDF_ENGINE` (pdf-text, mistral-ocr or native; 31d G4-10).
- Operator settings 0.1.x documented and 1.0 reads (30d R4-09): `NEARZERO_AGENT_ATTACHMENT_MAX_BYTES` (the overall cap in bytes; 1.0's `NEARZERO_AGENT_ATTACHMENTS_MAX_MB` wins when both are set), `NEARZERO_AGENT_MODEL_INPUTS` (what the chat model takes besides text when the provider's listing can't say, such as "image,file"), and `OPENROUTER_HTTP_REFERER` and `OPENROUTER_X_TITLE`. Model requests carry HTTP-Referer (the console's address by default) and X-Title ("Nearzero" by default), so usage shows as this install in OpenRouter. Word and text files are inlined up to 20,000 characters per file and 60,000 per message. Video only when supported, only for the current message, at most 20 MB.
- The Agent can list a chat's files and read one by offset, by PDF page, or by word search.
- A file sent in one chat cannot be re-sent in another. Opening a file shows images inline; other files download and never run in the page.

**Research**
- Uses the workspace's own Firecrawl key; the research actions exist only when a key is saved.
- Deep research tells the model to search, read official documentation first and link sources, and raises the step limit to 60. With research on but no key, the Agent says so in one sentence and answers from what it knows.
- Search returns 1 to 10 results (default 5; query up to 500 characters). Reading a page returns it as text (http and https only, cut at 10,000 characters). Errors are explained: rejected key, no credits, rate limited.

## 19.11 Grounding and safety

- **Names, not ids**: replies use names. Internal ids are stripped from displayed answers; step targets never contain ids or credentials.
- **References resolved before acting**: names, app names, log paths and ids the model passes are resolved against what the person can access: projects, services and servers by name with typos tolerated (1 typo for 4 to 7 letters, 2 for 8 or more), environments by name, servers by name or address, services also by a deployment log path or container name. If nothing matches, the model gets the real list instead of an error that hides existence.
- **Prompt rules** (built in): ids only come from earlier results; look things up before asking; read past typos; never reuse an earlier repository for a new name; never claim success without a successful result (a queued deploy is not success); explain failures from the result; never repeat a failed call unchanged; ask for the SSH user rather than assuming root.
- **Finishing the job** (31d G4-05): after a failed deploy, read the log, fix what the Agent's actions can fix (builder, source folder, ports, variables), redeploy and follow it, each time with a different fix, within the 6-deploy cap; stop only when the fix is the person's, and say exactly what to change. A failed deployment's result says this, with the deploys left. Prefer a connected Git account that can see a repository over its public URL. Ask for the variables a repository's example file lists before a created service's first deploy. Set up a server that isn't ready before deploying to it. After a Git service's first successful deploy, say whether pushes redeploy it and how to set up its webhook when one is needed.
- **Secrets never shown**: data the model reads has variable values, build arguments, build secrets, database passwords, tokens and Compose file contents removed. It sees variable names and Git URLs without credentials. Secret-looking commands, project-level variable values and file-mount contents are refused as inputs.
- **Content is data**: file contents, pages and logs are labelled as data, not instructions, and the model is told never to repeat secrets found in them.
- **System prompt**: set only by the instance operator; never replaceable or visible from the chat; an operator override is appended to the built-in safety rules, never replaces them.

## 19.12 Changes from today's behavior

| Today | 1.0 |
| --- | --- |
| Guided-flow steps are streamed but not saved, so they vanish after reloading a finished chat | Saved like every other step |
| A running turn lives in one process; a restart leaves it half-saved | Turns survive or are cleanly marked stopped (19.6) |
| "Up to 6 deployments" is only a prompt instruction | Enforced |
| With no ready server, imports silently go to the Nearzero host | The reply says so |
| An SSH-URL import needs "Read SSH keys" even for a key added in the same chat | Not needed for a key added in the same chat |
| The production phrase is checked only by the page | Checked by the platform too |
| A member's question isn't re-answered after an admin adds a key | It is |
| The page allows 4 follow-ups, the platform sends 3 | 3 |
| Rollback, Compose suggestions, create-from-suggestion and direct-queue actions are offered to the model | Dropped (see [27-dropped.md](27-dropped.md)) |
