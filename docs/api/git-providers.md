# Git providers API (M8)

Connected GitHub, GitLab, Bitbucket and Gitea accounts, the reads the console and the Agent make through them without cloning, provider sources on services, and push deploys. Implements spec 16 (all), 06 6.1 (Provider and Repository steps), 6.3 (the Source panel's provider tabs), 6.6, 07 7.1 (Compose from a repository), 19.7 steps 1–3 and 6 (the reads), 22.3 (Git accounts), 23.4 and 24 (G4, G7).

Conventions (errors, cookies, `Cache-Control: no-store`) are those of [identity.md](identity.md); service permissions are those of [projects.md](projects.md) and [deploys.md](deploys.md). Request schemas are in `packages/shared/src/git-providers.ts`; the words, limits and pure checks (labels, `noAccountsMessage`, `providerInUseMessage`, `githubOrganizationProblem`, `isConsoleReturnPath`, `repositoryNameProblem`, `composePathProblem`, the callback paths) are in `packages/shared/src/git-provider-rules.ts`, also exported from `@nearzero/shared/browser`.

## Who may do what

| Action | Owner / Admin | Member |
| --- | --- | --- |
| See a provider, list its repositories, branches and files, pick it as a source | every provider in the workspace | their own, the ones shared with the workspace, and ones granted directly or by a policy (`git-account.use`, scope `allGitAccounts` / `gitAccountIds`) |
| Connect a provider | ✓ | with "Connect their own Git accounts" (`git.connect-own`) |
| Edit, test, install, authorize / reconnect, delete | ✓ | the provider's owner (the person who connected it) |
| Share with the entire workspace, stop sharing | the provider's owner only (admins only when the owner's account is gone) | the provider's owner |
| Set or disconnect a service's provider source, register its webhook | configure rights on the service (and use of the provider to set one) | same |
| See a service's webhook URL and secret | deploy rights on the service | same |

A provider the person can't see answers `not_found`, exactly like one that doesn't exist or is in another workspace. Policies can now name Git accounts (`registerGitAccountObjects` in `records.ts` is the resolver); deleting a provider removes it from every policy and direct grant.

## Shapes

```ts
type GitProviderKind = "github" | "gitlab" | "bitbucket" | "gitea";

interface GitProviderView {
  id: string; kind: GitProviderKind; kindLabel: string; name: string;
  owner: { id: string; name: string } | null;
  mine: boolean;            // connected by the viewer
  shared: boolean;          // shared with the whole workspace
  status: "ready" | "action_required";   // "Action required": not installed / not authorized yet
  statusMessage: string | null;          // "Install the GitHub App to finish connecting." …
  deprecated: boolean;      // Bitbucket with a legacy app password
  account: string | null;   // "Connected as <login>"
  lastError: string | null; // the host's last refusal of the credentials
  createdAt: string; connectedAt: string | null;
  details: object;          // non-secret settings for the Edit dialog (per kind, below)
  configured: Record<string, boolean>;   // which secrets are saved: "Configured - leave blank to keep"
  openUrl: string | null;   // the GitHub App's page ("Open")
  can: { share; edit; delete; install; authorize: boolean };
}
// details: github { appSlug, appId, organization, ownerLogin, installationId }
//          gitlab { url, internalUrl, applicationId, group, auth: "oauth" | "token", redirectUri }
//          gitea  { url, internalUrl, clientId, organization, auth, redirectUri }
//          bitbucket { username, email, workspace, auth: "api_token" | "app_password" }

interface Repository { id; fullName /* owner/name */; name; owner; private: boolean; defaultBranch: string | null; webUrl: string | null; cloneUrl: string; updatedAt: string | null }
```

Secrets (GitHub App private keys, webhook and client secrets, OAuth access and refresh tokens, access tokens, Bitbucket API tokens and app passwords) are sealed with the install key (`secrets_sealed`, context `git-provider:<id>`), never returned, never logged, and never given to the Agent.

## The list and connecting (spec 16.1–16.5)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /git-providers` | | `{ providers: GitProviderView[], can: { connect }, noConnectMessage, console: { httpsBase, redirectUris: { gitlab, gitea } }, isAdmin }`. `noConnectMessage` (without the right): "You can use the Git accounts shared with this workspace. To connect your own, ask an owner or admin to allow "Connect their own Git accounts" for you." `httpsBase` is the console's public HTTPS address or null. |
| `GET /git-providers/usable?kind=` | | `{ providers: { id, kind, kindLabel, name, account, ready, mine, shared }[], can: { connect } }` (pickers; ready ones first) |
| `GET /git-providers/:id` | | `{ provider }` |
| `POST /git-providers/github/manifest` | `{ organization?: "", returnTo? }` | `{ action, manifest, appName, providerId }`: the browser posts `manifest` (a JSON string) as a form field to `action` (`https://github.com/settings/apps/new?state=…` or `…/organizations/<org>/settings/apps/new?state=…`). 409 without a public HTTPS console address: "GitHub sends its events to the console, so the console needs a public HTTPS address first." |
| `POST /git-providers/github/manifest/complete` | `{ code, state }` | 201 `{ provider, installUrl, returnTo }`; the console sends the person on to `installUrl` |
| `POST /git-providers/github/installations` | `{ installationId, state?, setupAction? }` | `{ provider, returnTo, message: "GitHub App installed" \| "GitHub App updated" }` |
| `POST /git-providers/gitlab` | `{ name, url: "https://gitlab.com", internalUrl?, applicationId, applicationSecret, group?, returnTo? }` or `{ name, url, internalUrl?, accessToken, group? }` | 201 `{ provider, authorizeUrl }`: send the person to `authorizeUrl` ("Save and connect"); with an access token it is checked at once and `authorizeUrl` is null |
| `POST /git-providers/gitea` | `{ name, url: "https://gitea.com", internalUrl?, clientId, clientSecret, organization?, returnTo? }` or with `accessToken` | as GitLab |
| `POST /git-providers/bitbucket` | `{ name, username, email, apiToken, workspace? }` (legacy: `appPassword` instead of `apiToken`) | 201 `{ provider, message: "Bitbucket connected" }`; checked with Bitbucket first |
| `POST /git-providers/oauth/complete` | `{ kind: "gitlab" \| "gitea", code, state, error? }` | `{ provider, returnTo, message: "GitLab connected" \| "Gitea connected" }` |
| `POST /git-providers/:id/install` | `{ returnTo? }` | `{ installUrl }` (row action Install) |
| `POST /git-providers/:id/authorize` | `{ returnTo? }` | `{ authorizeUrl }` (Authorize / Reconnect) |
| `PATCH /git-providers/:id` | the kind's fields (`name` only for GitHub); a blank secret keeps the saved one | `{ provider, authorizeUrl, message }`; Bitbucket and access tokens are checked before saving; a new OAuth host or application asks to authorize again (`authorizeUrl`) |
| `POST /git-providers/:id/test` | optional: the Edit form's values | `{ ok: true, account, message: "Connected as <login>." }` (nothing is saved) |
| `POST /git-providers/:id/share` | `{ shared }` | `{ provider, message: "Provider shared with workspace" \| "Provider unshared" }` |
| `GET /git-providers/:id/delete-plan` | | `{ plan: { providerId, name, shared, apps, composeServices, needsUnderstood, warning } }`; `warning`: "N apps and M compose services use this provider. They will stop deploying from Git until you pick another provider." |
| `DELETE /git-providers/:id?understood=true` | | `{ deleted, message, servicesWithoutSource }`; in use without `understood`: 409 with `fields.understood`. Its services keep repository and branch with `providerId: null` ("No Git source"). For GitHub the message adds that the app still exists on GitHub. |

**Return addresses.** `returnTo` is a console path (`isConsoleReturnPath`: one leading slash, no scheme or `//`). It rides in the flow's state and comes back from the `complete` calls, so the person returns where they started (an Agent chat, the new-application page). The console's Settings page takes `?connect=<kind>&return=<path>` to open a connect dialog with it.

**States** (`git_provider_flow`): the state sent to the host is 32 random bytes; only its SHA-256 is stored, with the person, the workspace, the purpose (`github-manifest`, `github-install`, `oauth`), the provider and `returnTo`. It works once and expires after 30 minutes. Finishing it as someone else: 403 "This connection was started by someone else. …"; used: 409 "This connection was already finished. …"; expired: 409 "This connection wasn't finished within 30 minutes, so it expired. …"; in another workspace: 409.

**GitHub App** (spec 16.2): the manifest names a private app `Nearzero-<YYYY-MM-DD>-<6 random>` with read access to contents, metadata and email, write access to pull requests, the `push` and `pull_request` events, the webhook `<console>/api/v1/webhooks/github/<provider id>`, the redirect `<console>/git-providers/github/created` and the setup URL `<console>/git-providers/github/installed`. The conversion's private key, webhook secret and client secret are sealed. An install binds to the flow's app; without a usable state (late, or GitHub dropped it) it binds to the signed-in person's newest waiting GitHub app in the workspace whose JWT GitHub confirms owns the installation (`GET /app/installations/:id`). `installation` events on the app's webhook also bind a waiting app, and an uninstall sends the provider back to "Action required". API calls and clones use installation tokens (an hour; reused until five minutes before they expire).

**GitLab and Gitea** (spec 16.3, 16.5): OAuth with the redirect URI `<console>/git-providers/gitlab/callback` or `…/gitea/callback` (GitLab scopes `api read_user`). Token calls go to the internal URL when set; the browser goes to the public URL. Tokens are refreshed a minute before they expire and saved back. An access token can replace OAuth ("Use an access token instead"; it is what the integration test connects with).

**Bitbucket** (spec 16.4): an Atlassian API token, with the account email for the API and the static user `x-bitbucket-api-token-auth` for clones. A legacy app password still works and is marked Deprecated with "This connection uses a Bitbucket app password, which Atlassian is retiring. Edit it and paste an API token instead."

**Host errors** are plain words naming the host and the fix, for example "GitHub says the app has no access to this repository. Grant access on GitHub.", "<Host> refused Nearzero's credentials. Reconnect the account in Settings → Git providers." (also kept as the provider's `lastError`), "<Host> can't be reached from Nearzero at <host>: … Check the address and the network, then try again." (503).

## Reads without cloning (spec 16.7, 19.7)

All need a ready provider the person may use (409 "This Git provider isn't connected yet. …" while incomplete).

| Endpoint | Response |
| --- | --- |
| `GET /git-providers/:id/repositories?search=` | `{ repositories: Repository[], truncated, cap: 200 }`, most recently changed first; `search` matches owner/name |
| `GET /git-providers/:id/repository?repository=owner/name` | `{ repository }` |
| `GET /git-providers/:id/branches?repository=` | `{ repository, defaultBranch, branches: { name, commit }[], truncated }`: the default branch first, then by name, at most 200 |
| `GET /git-providers/:id/files?repository=&ref=&depth=` | `{ ref, files: { path, type: "file" \| "folder", size }[], truncated }`; `ref` defaults to the default branch; `depth` limits how many folders deep (none: all); at most 10,000 entries |
| `GET /git-providers/:id/file?repository=&ref=&path=` | `{ ref, path, size, content }` for a UTF-8 text file up to 100 KB; 404 "There is no file <path> on <ref>."; 413 "This file is larger than 100 KB, so it isn't read without cloning."; paths with `..` are refused |
| `GET /git-providers/:id/inspect?repository=&ref=` | `{ repository, ref, files (3 folders deep), truncated, manifests: { path, content }[] (up to 12: Dockerfiles, Compose files, language manifests, index.html, example env files; shallow first), skipped, appFolders: { path, dockerfile }[] }`: the Agent's step 6 and the Configure step's build path picker |

For the Agent the same functions are in `apps/control/src/git-providers/area.ts`, called with the asking person's actor.

## Service sources (spec 6.3, 7.1)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /services/:serviceId/git-source` | | `{ source, state: "connected" \| "no_access" \| "no_git_source" \| "none", provider, push: { mode: "app" \| "webhook", status: "automatic" \| "registered" \| "manual" \| "stale" \| "none", message, url, secret, steps, hidden }, can: { configure, deploy } }`. `no_access` is "Disconnect repository"; `url` and `secret` only with deploy rights ("You need permission to deploy this service to see its webhook"). |
| `PUT /services/:serviceId/git-source` | `{ providerId, repository, branch?: "" (the default branch), buildPath?: "", composePath?: "./docker-compose.yml", trigger?: "push" \| "tag", watchPaths?: [], submodules?: false }` | `{ service, notes, push }`; applications and Compose services only. The repository is checked through the provider. A first Git source turns Autodeploy on. |
| `DELETE /services/:serviceId/git-source` | | `{ service, message: "Repository disconnected" }`; removes the webhook Nearzero added |
| `POST /services/:serviceId/git-source/webhook` | | `{ push }`: registers the provider webhook again (after "Replace URL", for example) |

The stored source is `settings.source = { type: "provider", providerId, provider, repository, repositoryId, branch, buildPath, composePath, trigger, watchPaths, submodules }` (read by `readSource` in `service-runtime/app-settings.ts`). Copies in other environments take it with the rest of the source (spec 5.4).

## Push deploys (spec 6.6, 16.2, 16.6, G4)

- **GitHub**: `POST /api/v1/webhooks/github/:providerId` (no session). `X-Hub-Signature-256` is checked on the raw body against the app's webhook secret before anything is parsed, in constant time also when no provider matches (401 otherwise). `ping` answers 200; `installation` events bind or unbind; `push` events go to every application and Compose service of the provider's workspace linked to that repository through that provider. A delivery id seen in the last day is answered `{ duplicate: true }` and deploys nothing.
- **GitLab, Bitbucket, Gitea**: through the service's deploy webhook URL (`POST /api/v1/webhooks/deploy/<token>`, deploys.md). Each service has its own secret (`git_service_hook`, sealed). Once a service linked to one of these hosts has one, every call to its URL must pass the host's own check on the raw body, whatever headers it carries (24 G4; leaving the host's event header out doesn't make it a generic call): GitLab `X-Gitlab-Token` equals the secret, Gitea `X-Gitea-Signature` (or `X-Hub-Signature-256`) is HMAC-SHA256, Bitbucket `X-Hub-Signature: sha256=…`. A wrong or missing one is 401, and so is a secret that can't be opened any more. A service with no secret of its own (a 0.1.x webhook a person added by hand, carried over by the move, 29.5) is called like any generic token webhook (deploys.md): its pushes keep deploying by branch and watch paths, pushes naming another repository are ignored, and both its Source panel and the move report ask for **Register webhook** so the host signs each push (30c R3-36). After that, unsigned calls are refused. GitHub pushes whose head commit message carries a skip keyword (`[skip ci]` and the rest, deploys.md) don't deploy, and the answer says why. A GitHub delivery is remembered only once it was handled: one that failed (answered 500) deploys when GitHub redelivers it. Saving the source registers the webhook with the connected token where the host's API allows it (GitLab project hooks, Gitea repository hooks, Bitbucket repository hooks), with the secret; otherwise the Source panel shows the URL, the secret and the steps. A replaced URL makes a registered webhook `stale` until it is registered again.
- The trigger (On push / On tag) and watch paths decide with the deploy engine's `shouldDeployPush`; Bitbucket pushes don't list files, so with watch paths the changed files come from its diffstat. Deploys are requested with trigger `push`, the pushed commit and the head commit's subject as the title. The deploy queue keeps one deploy running and one waiting: a push during a running deploy queues exactly one more, and later pushes replace the waiting one. Autodeploy off answers `{ deployed: false }`.

## The deploy engine's seam

`providerCloneAccess(services, workspaceId, source)` (`git-providers/sources.ts`) returns `{ url, username, password }` for one deploy: the clean HTTPS clone address (the internal URL's host when one is set) and short-lived credentials (a GitHub installation token, the current OAuth token, or the Bitbucket token). The pipeline sends them to the runner's `source.git` as `httpAuth`; the runner gives git an `Authorization` header scoped to the repository's own origin through `GIT_CONFIG_*` environment variables, so the token is never in the URL, on disk or in the log (it is also cut out of output). A deleted provider fails the deploy with "This service's Git provider was deleted, so it has no Git source. …". The deployment's `source` shows `{ type: "git", provider: "GitHub" | "GitLab" | "Bitbucket" | "Gitea", repository, branch, path }`.

## Console return pages

`/git-providers/github/created`, `/git-providers/github/installed`, `/git-providers/gitlab/callback` and `/git-providers/gitea/callback` (console, not `/api/v1`) pass what the host sent to the calls above for the signed-in person and redirect at once (to GitHub's install page, to `returnTo`, or to Settings → Git providers), with the outcome as a toast; the host's code never stays in the address bar.

**0.1.x's return addresses** (R3-41, R4-15). `/api/providers/github/setup`, `/api/providers/gitlab/callback` and `/api/providers/gitea/callback` on the console, where Git hosts set up for 0.1.x still send people, redirect with their query to the pages above (a GitHub return with only a `code` is the app just created; any other is an install). A GitLab or Gitea OAuth connection moved from 0.1.x keeps sending the redirect address its OAuth application was registered with (`legacyCallback`: the one the bundle names, or `<console>/api/providers/<kind>/callback`), in Authorize, the token exchange and refreshes, and shows it as its `redirectUri`, so Reconnect needs no change at the Git host; editing the connection keeps it. A GitHub App's own install page is aimed at the app's owner (`/installations/new/permissions?target_id=<owner id>`, R3-42), and GitLab's group filter takes several groups, comma-separated (R3-40).

## Audit events

`git-provider.connected`, `git-provider.authorized`, `git-provider.installed`, `git-provider.updated`, `git-provider.shared`, `git-provider.unshared`, `git-provider.deleted`, `service.source-changed`, and `service.deploy-requested` (via `github`, `gitlab`, `gitea` or `bitbucket`).

## Code map

`apps/control/src/git-providers/`: `records.ts` (rows, views, access, the Git account resolver), `connect.ts` (flows, edit, test, share, delete), `flows.ts` (states), `github.ts`, `gitlab.ts`, `gitea.ts`, `bitbucket.ts`, `oauth.ts`, `http.ts`, `client.ts`, `clients.ts`, `reads.ts`, `sources.ts`, `push.ts`, `events.ts`, `signatures.ts`, `routes.ts`, `area.ts`, `tables.ts`. Migration 0350. Runner: `runner/src/sources/git.ts` (`httpAuth`). Console: `src/pages/[workspace]/dashboard/settings/git-providers.astro`, `src/components/settings/GitProviderDialogs.astro`, `src/components/services/ProviderSourceTab.astro`, `src/pages/git-providers/**`, `src/client/git-providers.ts`, `git-import.ts`, `git-source.ts`, `src/lib/git-providers.ts`, `git-callbacks.ts`, `data/git.ts`, `src/styles/git.css`. Tests: `apps/control/test/git-providers.test.ts` (fake hosts in `test/support/fake-git-hosts.ts`), `git-providers-gitea.test.ts` (a Gitea-compatible server over HTTP), `runner/test/git-auth.test.ts` (a real git smart-HTTP server behind Basic auth), `apps/console/test/git-providers.test.ts`, `apps/console/e2e/git-providers.e2e.ts`, `apps/console/sweep/git-providers.ts`.
