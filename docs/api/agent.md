# Agent API (M11a)

The Agent's backend: sessions and their messages, turns streamed as server-sent events, the secure forms the chat shows, the permission card, attachments, research, follow-up suggestions and the home's greeting. Implements spec 19 (19.2 data, 19.3–19.6, 19.8–19.12), 20 (all), 22.6, 23.4 (rule 1), 23.5 (first-token and Thinking targets), 24 G6 and 25 D4 (sessions private by default, OpenRouter behind a provider interface).

Everything is JSON under `/api/v1` and acts on the session's **active workspace**. Conventions (errors, cookies, `Cache-Control: no-store`) are those of [identity.md](identity.md). Request schemas are in `packages/shared/src/agent.ts`; the event types, limits and pure helpers (`stripInternalIds`, `provisionalTitle`, `attachmentProblem`, `filterSuggestions`, `greetingFirstLine`, `turnFooter`) are in `packages/shared/src/agent-rules.ts`, also exported from `@nearzero/shared/browser`.

The guided flows of spec 19.7 (M11c) run before the model and use the same events, forms and steps described here; see "Guided flows" below.

## Who may do what

| Action | Needs |
| --- | --- |
| Use the Agent, create sessions, send messages | any member (`agent.use`) |
| See a session | its author; anyone in the workspace once the author shared it |
| Send, rename, reorder, share, delete, stop, answer a form | the session's author |
| Allow a policy from the permission card | owner or admin (never production) |

A session someone can't see answers `not_found`. Every capability runs with the asking person's own permissions (an action they couldn't do in the console fails as a red step) plus the workspace's Agent policies (a refusal becomes the permission card). When someone other than the author opens a shared session, the viewer's own access decides (G6, B1-22): a step shows its target and result only when it names what it touched and the viewer can see all of it; anything else (lists of SSH keys, tasks, Git accounts or repositories, a task's script, repository contents, guided rows and sub-steps) shows its label and state only. `form.requested` reaches others without its `form`, and `form.answered` without its `label`.

## Shapes

```ts
interface SessionView {
  id: string;
  title: string | null;            // null: show "Untitled session"
  titleSource: "provisional" | "generated" | "person" | null;
  shared: boolean; mine: boolean;
  author: { id: string; name: string };
  position: number;                // higher is nearer the top
  state: "idle" | "working" | "waiting";   // the row's working indicator
  liveTurnId: string | null;       // the turn to follow while working or waiting
  lastMessageAt: string | null; createdAt: string;
}

interface FileView {
  id: string; name: string; kind: "image" | "pdf" | "docx" | "text" | "video";
  contentType: string; sizeBytes: number;
  sent: boolean;                   // false: visible to the uploader only
  notice: string | null;           // "This model can't see images…" (spec 19.10)
  url: string;                     // GET it: images inline, everything else as a download
}

interface PersonMessage {
  id: string; text: string; quote: string | null; files: FileView[];
  author: { id: string; name: string }; createdAt: string;
}

interface TurnView {
  id: string;
  state: "working" | "waiting" | "finished" | "stopped" | "failed";
  message: PersonMessage;          // the question this turn answers
  events: AgentEvent[];            // every saved event, in order (see below)
  answerText: string;              // the answer's words, for Copy
  footer: string | null;           // "Worked for 34s · 3 steps · 1 failed", "Stopped after 12s", "Stopped (Nearzero restarted)"
  canRetry: boolean;               // last turn only, when it failed (error, or steps with no words) or was stopped
  canEdit: boolean;                // last finished question only
  live: boolean;                   // follow GET /agent/turns/:id/events
  lastEventId: string;             // "<turn id>:<seq>": resume right after what `events` holds
  workingSince: string | null;     // while working: when this working stretch began (the start, or the last form answer), for the status timer after a reload
}
```

## Home (spec 19.2, 19.10)

`GET /agent` → `{ enabled, greeting, starters, research, model, limits, can }`

- `enabled`: false when the instance operator turned the Agent off (every message then answers "Nearzero Agent is disabled.").
- `greeting`: `{ name, askName, secondLine, fixed }`. `name` is the first name, or `"there"` when it looks derived from the email (`askName: true`: show "What should I call you?"; saving goes to `PATCH /me`). `secondLine` is one of the four lines, chosen at random. `fixed` is the operator's greeting with the name filled in, or null. The console picks line 1 with `greetingFirstLine(hour, name)` from the browser's own clock.
- `starters`: the four starters in order, `{ label, text, send }` (`send: false` only fills the box).
- `research`: `{ keySaved, canAddKey, whoCanAdd }` for the research-key form above the box (`whoCanAdd`: "Ask an owner or admin to add a Firecrawl key in Settings → API keys.").
- `model`: `{ keySaved, keyUsable }`.
- `limits`: `{ filesPerMessage: 10, totalBytes, perKind: { image, pdf, docx, text, video }, quoteChars: 1200, messageChars: 20000, concurrentUploads: 3 }`.
- `can`: `{ allowPolicies }` (owners and admins).

## Sessions (spec 19.5, D4)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /agent/sessions` | | `{ sessions: SessionView[] (yours, up to 50, by position, top first), shared: SessionView[] (others' shared sessions, up to 50, newest message first), limit: 50 }` |
| `POST /agent/sessions` | `{}` | 201 `{ session }`: an empty chat |
| `GET /agent/sessions/:id?before=<turnId>` | | `{ session, turns: TurnView[] (the newest 30, oldest first), more: boolean }`; `before` pages back |
| `PATCH /agent/sessions/:id` | `{ title }` | `{ session }`. 1 to 80 characters on one line: "Enter a name for the session." / "Session names can be up to 80 characters." A title set here is never replaced by a generated one. |
| `POST /agent/sessions/:id/share` | `{ shared: boolean }` | `{ session, message: "Shared with workspace" \| "Only you can see this session now" }` |
| `PUT /agent/sessions/order` | `{ seen: { id, position }[], order: string[] }` | `{ sessions }` (as the list). `seen` is the rows as the page has them, `order` the same ids in their new order (Move up, Move down, or a drag). The positions those rows hold are given out again in the new order, so a new session still lands on top and sessions beyond the 50 shown keep theirs. If any row's position changed meanwhile, or a row is gone or not yours: 409 "The sessions changed while you were moving them. Try again." |
| `DELETE /agent/sessions/:id` | | `{ deleted: true }`; messages and files go with it. A session that is already gone also answers `{ deleted: true }`. While a turn works: 409 "This session is still working. Stop it, then delete it." |

New messages never move a session. The console disables Delete while it shows the session working ("Stop this session to delete it.").

## Sending and following (spec 19.6)

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /agent/sessions/:id/messages` | `{ text, quote?, fileIds?: string[], deepResearch?: boolean, retryOf?: turnId }` | 202 `{ session, message: PersonMessage, turn: { id, lastEventId } }` |
| `POST /agent/messages` | the same | 202, the same, in a new session (for the first message of a new chat) |
| `GET /agent/turns/:turnId/events` | `Last-Event-ID` (or `?lastEventId=`) | Server-sent events, below |
| `POST /agent/turns/:turnId/stop` | | `{ stopping: true }`; a finished turn answers `{ stopping: false }` |

- `text` up to 20,000 characters; empty text needs at least one file. `quote` up to 1,200 characters; it is sent as quoted lines before the question. `retryOf` re-sends that turn's question, quote and files as a new message, only for the session's last turn: any other answers 409 "Only the last message in a chat can be retried or edited. Send a new message instead." (`canEdit` and `canRetry` are true only on the session's last turn, on whichever page it is.)
- A second message while a turn works: 409 "The Agent is still working on the last message in this chat. Wait for it to finish, then send this again." A turn that is only waiting on a form is closed ("The form was left unanswered.") and the new message starts a new turn.
- A body with `secret: true` anywhere: 400 "Secret input cannot be submitted through Agent chat."
- Files: up to 10 per message, each sent only in the chat it was sent in first ("This file was already sent in another chat. Attach it again here.").
- On the first message of a session its provisional title is set from the question (first 8 words, at most 72 characters, quotes left out; a files-only message is named after the first file); a 2 to 5 word title follows within 6 seconds unless the person renamed it.

### The event stream

`GET /agent/turns/:turnId/events` sends headers at once and a `: keep-alive` comment at least every 15 seconds. It replays the saved events after `Last-Event-ID`, then follows the turn live, wherever it runs, and closes with `end` once the turn is over. Opening it on a finished turn replays and ends. A page follows one live turn at a time.

Each event is `event: <type>`, `id: <turn id>:<seq>` and `data: <JSON>`. Every event except `end` is saved the moment it happens, so a reload, another tab or another device sees exactly the same rows. Clients ignore types they don't know.

| Type | `data` | Meaning |
| --- | --- | --- |
| `turn.started` | `{ turnId, sessionId, messageId, deepResearch, startedAt }` | First event, written when the message is accepted |
| `status` | `{ kind: "thinking" \| "writing" \| "step" \| "stopping" \| "waiting", label }` | The live status line: "Thinking" (within 200 ms of sending), "Writing", the running step's present-tense label, "Stopping", or what a form waits for |
| `text` | `{ delta }` | Answer words, in order. Deltas are joined; the whole is Markdown. Ids are already removed (`stripInternalIds`) |
| `step.started` | `{ stepId, capability, label, target, startedAt }` | A row with a spinner: present-tense `label` ("Deploying"), `target` ("web on prod-1", "3 found"), never an id or a credential |
| `step.finished` | `{ stepId, state: "succeeded" \| "failed" \| "stopped" \| "needs_permission", label, target, reason, result, resultTruncated, durationMs }` | The row's final state: check, cross, stop or lock. `label` is past tense when it succeeded ("Deployed"). `reason` is set for failed, stopped and needs-permission rows (failed: up to 280 characters, shown under the row). `result` is the raw result (capped at 6,000 characters; fold after 14 lines or 1,600 characters) or null |
| `permission.needed` | `{ stepId, policy, policyLabel, production, canAllow, message, settingsPath: "/dashboard/settings/agent-policies" }` | The card under the turn (spec 19.9). `canAllow` for owners and admins, never for `production` |
| `form.requested` | `{ formId, form: FormRequest }` | Show a secure form or picker (below) |
| `waiting` | `{ formId \| null, label }` | The turn waits for the person ("Waiting for the SSH key", "Waiting for admin to configure OpenRouter"). Waiting time is not counted in the footer |
| `form.answered` | `{ formId, outcome, label, asMessage }` | The form was answered. With `asMessage`, show `label` as the person's message ("acme/web") |
| `notice` | `{ text }` | A plain line from Nearzero itself |
| `error` | `{ code, message }` | Red, with an alert icon; stays red after a reload. Codes: `agent_disabled`, `no_model_key`, `model_key_rejected`, `out_of_credits`, `rate_limited`, `provider_unavailable`, `provider_silent`, `empty_response`, `step_limit`, `internal` |
| `session.titled` | `{ title }` | The session's new title (provisional or generated) |
| `turn.replaced` | `{ turnId }` | This turn was the "add a key" reply; a key was saved, so it is hidden and the same question is answered in turn `turnId`: follow that one |
| `turn.finished` | `{ state: "finished" \| "stopped" \| "failed", stoppedBy: "person" \| "restart" \| null, workedMs, steps, failedSteps, footer, canRetry, finishedAt }` | The turn is over; the mark folds away. `workedMs` counts only working time |
| `suggestions` | `{ items: string[] }` | Up to 3 follow-ups, after a normal answer only; may be absent |
| `end` | `{}` | Not saved: the stream is closing because nothing more will come |

Order within a turn: `turn.started`, then any mix of `status`, `text`, `step.*`, `permission.needed`, `form.*`, `waiting`, `notice`, `error`, then `turn.finished`, then optionally `session.titled` and `suggestions`, then `end`. `session.titled` may also come earlier.

**Stop.** The model request is cancelled at once. Words so far stay. Running rows get `step.finished` with `state: "stopped"`; the action itself (a deploy, a setup) keeps going and stays visible where it normally is. `turn.finished` has `state: "stopped"`, footer "Stopped after 12s". A Stop for a turn that is waiting on a form ends it the same way.

**Restarts.** A turn that was working when Nearzero restarted is finished with `state: "stopped"`, `stoppedBy: "restart"` and the footer "Stopped (Nearzero restarted)", and its running rows are marked stopped. A turn waiting on a form survives a restart and continues when the form is answered.

## Secure forms (spec 19.8)

Values typed into these forms go from the browser to the normal API with the person's own session; the chat endpoint only learns the outcome. A form answer is posted with:

`POST /agent/turns/:turnId/forms/:formId` → 202 `{ turn: { id, lastEventId } }` (the turn continues on the same stream), or 409 when the form was already answered or the turn is over.

Any answer carrying `secret: true`, or a field named `value`, `values`, `password`, `privateKey`, `key`, `apiKey` or `script`, is refused: 400 "Secret input cannot be submitted through Agent chat."

```ts
type FormRequest =
  | { kind: "variables"; service: { id; name }; reason: string; names: string[];   // fixed rows; more can be added
      saveTo: "/api/v1/services/:id/variables"; deployLabel: string;              // "Save N variables and deploy"
      skipLabel: "Deploy without them"; hint: "Saved to the service. The Agent only learns the names." }
  | { kind: "ssh_key"; suggestedName: string; reason: string }                     // POST /ssh-keys/generate, POST /ssh-keys
  | { kind: "task_script"; mode: "create" | "replace"; summary: { task; where; schedule; timeZone; nextRun; shell };
      placeholder: string; saveTo: string;                                           // POST /api/v1/tasks, or PATCH /api/v1/tasks/:id
      draft: { name; description; cron; timeZone; shell; place; serviceId; innerService; serverId } | null }  // posted with the script
  | { kind: "model_key"; placeholder: "sk-or-…"; canSave: boolean; settingsPath: string }   // PUT /workspace/keys/model
  | { kind: "research_key"; canSave: boolean; whoCanAdd: string }                  // PUT /workspace/keys/research
  | { kind: "project_name"; label: "Project name"; suggestion: string | null }
  | { kind: "picker"; purpose: "provider" | "access" | "repository" | "branch" | "project" | "server" | "how_to_run" | "service";
      title: string; options: { value: string; label: string; description?: string; icon?: string }[];
      searchable: boolean }                                                         // > 8 options or any repository/branch list: dropdown with search from 7
  | { kind: "project_delete"; project: { id; name }; summary: string;
      services: { line: string }[];                                                 // "name — type on server (environment)"
      confirmLabel: string; confirmHint: "Wipes their data from the servers"; keepLabel: "Keep it" };
```

| Form | Answer body | What the model learns |
| --- | --- | --- |
| variables | `{ outcome: "saved", names: string[] }` or `{ outcome: "skipped" }` | The names (checked against the service's saved names) and "redeploy and wait", or that nothing was saved |
| ssh_key | `{ outcome: "saved", keyId }` or `{ outcome: "cancelled" }` | The key's name and an internal reference; that key works for this chat's server or Git setup without "Read SSH keys" |
| task_script | `{ outcome: "saved", taskId }` or `{ outcome: "cancelled" }` | Only that it was saved; Nearzero writes the read-back reply itself |
| model_key | `{ outcome: "saved" }` | Nothing: the "add a key" reply is hidden from the chat and the model, and the question is asked again in a new turn |
| research_key | `{ outcome: "saved" }` | Nothing |
| project_name | `{ outcome: "named", name }` | The name |
| picker | `{ outcome: "chosen", option, label }` (`option` is the option's `value`) | The chosen label |
| project_delete | `{ outcome: "delete" }` or `{ outcome: "keep" }` | The choice |

## Guided flows (spec 19.7, M11c)

Some messages run a fixed sequence before the model, with no new endpoints: their steps are ordinary rows (`step.started` / `step.finished`, `capability: "step"`), their choices are the forms above, and their replies are `text` events. They run without a model key too; a flow that needs the model then ends with its own words instead.

- **Which messages.** A message of up to 400 characters without code is split into clauses (sentences, `;`, and "and" / "then" / "and then" / "after that" / commas when another request follows, so "delete X and then create Y" is two clauses and "delete live and shop" is one). Clauses run in order. Each is matched against, in this order: delete a project, create a project, "deploy <name>", import from Git. The first clause that matches none of them, and everything after it, goes to the model in the same turn with a note naming what the flows already did. A message whose first clause matches none of them is the model's as before.
- **Create a project**: "create/make/add/start/set up a project [called/named X]". A usable name creates it ("Created **X** with a **development** environment."); no name or a generic one opens `project_name`. Not triggered by pronouns, other resources, names over 6 words or starting with a preposition.
- **Delete a project**: a delete verb with a name; without the word "project", only an exact project name (anything else, negations, and other kinds of things go to the model). The policy is checked first (a refusal is plain text pointing to Settings → Agent policies, audited as `agent.refused` with `guided: true`). Near match, several matches and no match are answered in words; a project with production is never deleted; an empty one is deleted at once; otherwise `project_delete` lists `name — type on server (environment)`, is shown again when the services changed before the answer, and each service's removal is a row ("Removing service · web on prod-1"), followed by a Service | Server | Result | Notes table ("Already gone" marks services that were never deployed). The model's `delete_project` uses the same code.
- **"deploy <name>"**: only "(re)deploy / ship / launch [the|my|our] <name> [app|service|repo] [please|again|now]" with a one- or two-word name. One app or Compose service of that name (typos tolerated) is deployed through the keep-going loop, after the `variables` form when it was never deployed and has no variables; several give a `service` picker labelled "project / environment"; a database name or database word goes to the model; anything else starts the Git import with that repository name (typos tolerated), or the `repository` picker sorted by closeness ("No service or repository is called "X". Choose the repository to deploy").
- **A pasted repository link** (30d R4-01, 31d R4-01): a link to github.com, gitlab.com, bitbucket.org or codeberg.org (`https://host/owner/repo`, `host/owner/repo`, a `.git` ending, `/tree/<branch>`), alone or with a word asking to deploy it (deploy, import, clone, run, launch, host, ship, publish, serve, start, set up, spin up, put it online, go live), however long the message; the clauses about the same repository stay with it. The service's name ("as api"), the builder ("with its Dockerfile", "with nixpacks") and the folder ("from the apps/api folder") are honoured (31d G4-06); details the import has no step for (commands, ports, variables, domains, an environment, a database) send the message to the model, whose `create_app_from_git_url` checks those four hosts the same way: a connected account first, then a public repository on its real default branch, else nothing is created and the access card is shown (Check again, or coming back from connecting, continues). A question about a link, SSH links and other hosts go to the model. A connected account that can see the repository is used first (pushes redeploy it; the public URL isn't asked). Otherwise the host is asked over Git's smart HTTP with no login: a public repository is deployed from its URL (the `/tree/` branch when it has it, else its default branch, else main or master, else its only branch, else "Choose the branch of <owner/repo> to deploy"), how it runs read from a clone without file contents; "**<owner/repo>** on <Host> is public, but it has no branches yet. Push some code to it, then ask again." A private or missing repository creates nothing: "I can't open <owner/repo>. It's private or doesn't exist, and none of your connected <Host> accounts can see it." (or "…and no <Host> account is connected to Nearzero."), "Give Nearzero access to it, then check again. If it's meant to be public, check the link.", and a card of buttons (picker purpose `access`) with Give access on GitHub (a console address, `…/settings/git-providers?install=<provider>&return=<this chat>`, that opens the app's install page when clicked; "Give <account> access" with several), Connect <Host> and Check again, waiting as "Waiting for access to the repository". A public-URL import ends with "Pushes to the repository don't redeploy it on their own, because no connected account can see it. Connect the account that owns it, or ask me for its deploy webhook." (31d G4-07). Someone who may not connect accounts is told to ask an owner or admin. An unreachable host: "I couldn't reach <host> to check **<owner/repo>**: <reason> Nothing was created. Try again in a moment." Then the usual import steps below.
- **Import from Git**: import/add/create/connect/set up/run/deploy/launch/spin up with service/app/repo (or an owner/name), or "connect my GitHub"; never with a Git URL (see the pasted link above), or for images, databases, Compose or templates without Git words. "just import" / "don't deploy" creates without deploying. Steps, each skipped when already known: provider (none usable: a `provider` picker of Connect buttons, below; several: a picker), repository (named, else a searchable picker of up to 200; none listed: how to grant access), branch (default, main, master, the only one, else a picker), project (named as "into X" / "in the X project", else a picker with `New project "<repo>"` first; with no projects at all, a new one), environment (development, else the first non-production one; production needs the production policy), server (named, else a picker of ready servers plus "Nearzero host — the machine Nearzero itself runs on"; with none ready, the host, and the reply says so), how to run (`inspect` through the provider; a `how_to_run` picker when several fit; "I couldn't tell how to run … Nothing was created." when none does), create (project, then the app or Compose service with the provider source; a Dockerfile builds with the `dockerfile` builder; a default hostname when "Assign domains" allows it), the `variables` form prefilled with names from example env files and env schema files, then deploy.
- **Keep going after a failed deploy** (import and "deploy <name>"): each deploy is followed for up to 20 minutes. A tool missing on the build machine is explained (re-run server setup, or update Nearzero on the host); variables named in the log (common framework errors, or a refused connection to a database's port on localhost matched against the example names) are asked for again with exactly those names, each at most twice; a failed Dockerfile build switches once to automatic language detection (Railpack) and deploys again; anything else shows "The deployment failed. The end of its log:" with the last 25 lines and "I'm finding the cause and fixing it.", then the model takes over in the same turn with a note only it sees (service, repository, branch, builders tried, variable names saved, deploys used, last 80 log lines, redacted). Without a model key the failure text is the answer. Deploys count toward the 6-per-service cap shared with the model.
- **Replies after a deploy**: live addresses only after success; for an automatic address whose DNS record doesn't exist yet, "It's deployed. Its address is …" with a Type | Name | Value | Proxy table, where the name points now and an offer to use the person's own domain; "It has no domain yet" when it has none; still running after 20 minutes, or cancelled, say so.

**Connect buttons.** A picker option may carry `href` (a console path) instead of being an answer: the Git import's Connect buttons point at `/<workspace>/dashboard/settings/git-providers?connect=<kind>&return=<path>`, where `<path>` is `/<workspace>/dashboard/agent?session=<session id>`. The console opens the link; it does not answer the form. For 30 minutes after the form appears, `GET /agent/sessions/:id` by the session's author continues the waiting import by itself as soon as that person has a usable Git account (the form is answered with `{ outcome: "connected" }`, shown as "Connected a Git account"). Any other answer to that form also looks for an account again.

**Waiting.** A flow waiting on a form keeps its state with the turn (`wait.capability: "guided_flow"`: clause queue, the flow's step, names and ids only), so it survives a restart and continues when the form is answered.

## The permission card (spec 19.9)

`POST /agent/turns/:turnId/permission` `{ policy }` (owners and admins; the turn's author) turns that Agent policy on (with its dependencies: Import from Git and Assign domains turn on Create and configure) and sends "Allowed "<policy label>". Please continue." as a new message → 202 `{ session, message, turn }`. Production is refused here: 403 "Production changes are turned on in Agent policies, with a typed confirmation." Members get 403 "Owners and admins decide what the Agent may do. Ask one to allow it in Settings → Agent policies."

## Attachments (spec 19.10)

| Endpoint | Request | Response |
| --- | --- | --- |
| `POST /agent/files?name=<file name>&sessionId=` | the file's bytes as the body with its own `Content-Type` | 201 `{ file: FileView }`. Only the uploader sees it until it is sent. It belongs to `sessionId`'s chat (deleted with it). At most 20 unsent files and 100 MB unsent per person and workspace (409 "You have N files (…) waiting to be sent. Send them, or remove some, before attaching more."); unsent files are deleted after a day. A Word document that can't be read answers 400 "This Word document couldn't be read. Save it again as .docx or PDF." |
| `GET /agent/files/:id` | | the bytes: images `inline`, everything else `attachment`, with `X-Content-Type-Options: nosniff` and a sandboxing CSP |
| `DELETE /agent/files/:id` | | `{ deleted: true }` (unsent files only) |

Limits: images (PNG, JPEG, WebP, GIF) 10 MB, PDF 20 MB, Word (.docx) 15 MB, text and code 10 MB, video (MP4, WebM, MOV) 25 MB, at most 25 MB together per message (the operator can change it with `NEARZERO_AGENT_ATTACHMENTS_MAX_MB`). Refused with a reason (400, `fields.file`): env files ("Env files can hold secrets, so they aren't accepted. Paste the variable names instead, or attach .env.example."; `.env.example`, `.sample`, `.template`, `.dist` and `.defaults` are fine), spreadsheets and slide decks ("Export it as CSV or PDF, then attach that."), archives ("Archives aren't accepted. Attach the files inside it."), HEIC and AVIF ("HEIC and AVIF images aren't accepted. Export it as PNG or JPEG."), legacy .doc ("Save it as .docx or PDF, then attach that."), anything else ("This kind of file isn't accepted…"). Over a limit: 413. The browser shrinks images to 2,048 px first.

What the model gets: images only when the model takes images (at most 5 MB each, 8 per request, 16 MB in total, newest first); PDFs through the provider's PDF reading; Word and text files inlined up to 20,000 characters each and 60,000 per message, labelled as data; video only when supported, only with the current message, at most 20 MB. The model can list a chat's files and read one by offset, by PDF page, or by word search.

## Capabilities (spec 20)

The model's actions are the capability catalog in `apps/control/src/agent/catalog/` (one module per area of spec 20). Each declares its Agent policy, its step labels (present and past tense) and how its target is named, resolves names first (typos tolerated: 1 for 4 to 7 letters, 2 for 8 or more; returning the real candidates when nothing matches), calls the area's own exported function with the person's actor, and returns a result with secrets removed (variable values, build arguments and secrets, database passwords, tokens, Compose file contents, credentials in URLs). Results reach the model cut at 12,000 characters. Changes are audited with actor "Agent" (`agent.<capability>`), and so are policy refusals (`agent.refused`).

Round 2 (30d R4-04 to R4-07): `read_service` reads one service's source, builder and commands, push deploys, hostnames and last 5 deployments; `read_task_run_log` reads a task run's output (200 lines by default, at most 10,000); `create_app_from_git_url` and `create_app_from_provider` take the builder and commands like `change_app_build`; `create_database` takes an image, a database name and a user (never a password). `add_hostname` takes a port, a path and the Compose service only (spec 20.6). A name that matches nothing fails with a reason that lists the candidates itself.

`GET /agent/capabilities` (owners and admins) lists the catalog for the settings page: `{ capabilities: { name, area, policy, policyLabel, changes, available, pending }[] }`. `pending` names a module that isn't finished yet (the capability answers that it isn't available yet).

## Install settings

| Variable | Meaning |
| --- | --- |
| `NEARZERO_AGENT_DISABLED` | `true` turns the Agent off for the whole install |
| `NEARZERO_AGENT_MODEL` | The model every workspace uses (default `anthropic/claude-sonnet-4.5`) |
| `NEARZERO_AGENT_SMALL_MODEL` | Titles, follow-ups (default `anthropic/claude-haiku-4.5`) |
| `NEARZERO_AGENT_PROVIDER_URL` | The OpenRouter-compatible API (default `https://openrouter.ai/api/v1`) |
| `NEARZERO_AGENT_RESEARCH_URL` | Firecrawl's API (default `https://api.firecrawl.dev`) |
| `NEARZERO_AGENT_PROMPT_APPEND` / `NEARZERO_AGENT_PROMPT_FILE` | The operator's prompt text, appended after the built-in rules, never replacing them |
| `NEARZERO_AGENT_GREETING` | A fixed greeting; `{first name}` is replaced |
| `NEARZERO_AGENT_ATTACHMENTS_MAX_MB` | The per-message attachment cap (default 25) |

0.1.x's names keep working where 1.0 has the setting, and 1.0's name wins when both are set (30d R4-09): `NEARZERO_AGENT_ENABLED=false` (the kill switch), `OPENROUTER_CHAT_MODEL` (the model), `OPENROUTER_TITLE_MODEL` or `OPENROUTER_FOLLOWUPS_MODEL` (the small model), `OPENROUTER_BASE_URL` (the provider), `NEARZERO_AGENT_GREETING_TITLE` (the greeting; `{firstName}` is read as `{first name}`) and `NEARZERO_AGENT_SYSTEM_PROMPT` (appended like the operator's text). The start log names the 0.1.x Agent settings 1.0 ignores: `NEARZERO_AGENT_GREETING_SUBTITLE`, the onboarding greetings, `NEARZERO_AGENT_MAX_TURNS`, `NEARZERO_AGENT_DEEP_RESEARCH_MAX_TURNS` and `NEARZERO_AGENT_ATTACHMENTS_PATH`.

Model keys come only from the workspace's own saved key (Settings → API keys), never from the server's environment.

## Audit events

`agent.<capability>` (each change, with the person, their role, the session and the target), `agent.refused` (policy refusals, with the policy), `agent.policy-allowed` (Allow and continue), `agent-session.shared`, `agent-session.unshared`, `agent-session.deleted`. Changes made through area functions are also recorded by those areas with `actor_kind = "agent"`.

## Code map

`apps/control/src/agent/`: `tables.ts` (migration 0550's types), `settings.ts` (install settings and test overrides), `actor.ts` (the person the Agent acts for, rebuilt per stretch of a turn), `sessions.ts`, `messages.ts` (send, form answers, Allow and continue, re-asking after a key), `turns.ts` (the loop, Stop, waiting, finishing), `events.ts` (one writer per turn, the bus, following), `history.ts` (what the model was told), `text-stream.ts` (ids held back across deltas), `provider/` (`provider.ts` interface, `openrouter.ts`), `prompt.ts`, `context.ts`, `capability.ts` (the runner: policies, production, repeat guard, deploy cap, redaction, audit), `resolve.ts`, `redact.ts`, `files.ts`, `extract.ts` (text, Word, PDF), `research.ts`, `titles.ts` (titles and follow-ups), `restart.ts` (the sweep), `flows.ts` (guided flows plug in here), `catalog/` (one module per area of spec 20), `adapters/` (server setup and tasks), `routes.ts`, `abort.ts` (waits that Stop ends), `flows.ts` (the guided-flow engine: clauses, waits, hand-over) with `flows/` (`parse.ts` triggers and clauses, `kit.ts`, `create-project.ts`, `delete-project.ts` and `project-delete.ts` (shared with the model's delete), `deploy-name.ts`, `git-import.ts`, `git-link.ts` and `public-repo.ts` (pasted links), `inspect.ts` (how to run, variable names), `deploy-loop.ts` (deploy, follow, keep going, replies), `log-rules.ts`, `connect-return.ts`). Shared: `packages/shared/src/agent.ts`, `agent-rules.ts`. Migration 0550. Tests: `apps/control/test/agent/` (`support.ts` has the scripted OpenAI-compatible model server and the Firecrawl-compatible research server; databases are named `nz_m11_*`, and `nz_m11c_*` for `flows.test.ts`; `flows-rules.test.ts` needs no database).

## Round 2 rules the runner applies (W1)

- **Server choice** (30d R4-08): an action that creates a service with no server named, when any server is ready, asks the person in a `server` picker (the ready servers, plus "Nearzero host — the machine Nearzero itself runs on" when they may use it) and runs again with their choice; with no ready server it goes to the Nearzero host and says so.
- **Checked again when a form is answered** (19.9, B1-55): an action's Agent policies are checked again when its form is answered, and a project delete checks "Delete projects without production" and its environments again right before it runs (B1-21).
- **Production copies** (B1-56): while "Change production environments" is off, a service the Agent creates isn't copied into a production environment; the result says so.
