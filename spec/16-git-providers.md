# 16. Git providers

A **Git provider** is a connected account on GitHub, GitLab, Bitbucket or Gitea that Nearzero uses to list repositories and branches, read repository files without cloning (for the Agent's inspection), clone for builds, and receive pushes. Providers belong to the person who connected them and can be shared with the whole workspace.

## 16.1 Page

Settings → **Git providers** (owners and admins, or people with "Connect their own Git accounts"; others who only use shared accounts see the shared list).
- **Add provider** chips: GitHub, GitLab, Bitbucket, Gitea (people who can connect). Without that right: "You can use the Git accounts shared with this workspace… To connect your own, ask an owner or admin to allow 'Connect their own Git accounts'…".
- Who sees which: owners and admins see every provider in the workspace; members see their own, the shared ones, and ones granted to them directly or by a policy.
- Table: Name (with "Shared" when not yours, "Action required" when the connection is incomplete), Provider, Created, Actions.
- Edit and delete: the provider's owner, and workspace owners and admins. Self-hosted GitLab and Gitea may use `http://` and private addresses, but only workspace owners and admins (and instance administrators) may set an address or internal address that resolves to a private, loopback, link-local or internal address: others are refused with "Only a workspace owner or admin can point a Git connection at a private or internal address: <host> is one." before anything is saved, tested or called (31d G4-12, 23.9). Members may use public self-hosted addresses. Clones go only to the configured host.
- Row actions: **Share with entire workspace** (the provider's owner only: "Provider shared with workspace" / "Provider unshared"); **Install** (GitHub) or **Authorize / Reconnect** (GitLab, Gitea); **Open** (the GitHub App's page); **Edit** (with "Test connection"; saved secrets show "Configured - leave blank to keep"); **Delete**.
- **Delete**: "Delete this Git provider?" If shared: "…Deleting it will remove access for all members." If services use it, an "I understand" tick is required: "N apps and M compose services use this provider. They will stop deploying from Git until you pick another provider."
- After connecting, the person returns to where they started (an Agent chat resumes its import; the new-application page reopens).

## 16.2 GitHub (your own GitHub App)

- "Connect GitHub" dialog. The console's public HTTPS address is shown as the callback base; without a public HTTPS address "Continue on GitHub" is disabled, and admins get "Configure a domain first." linking to About Nearzero.
- Optional "Install for a GitHub organization" with the organization's slug (GitHub's rules, up to 39 characters), and a link "View installed GitHub Apps".
- Continuing creates a private GitHub App on the person's account from a manifest: name "Nearzero-<date>-<random>", permissions to read contents, metadata and email and to write pull requests, events push and pull request, a webhook to the console, and a return address to the console.
- Then **Install** opens the install page on the app's owner (account or organization). An install that returns late or without its state still binds to the signed-in person's waiting app when GitHub confirms that app owns the installation.
- The OAuth state is bound to the signed-in person and expires.
- Pushes arrive through the app's webhook; signatures are checked on the raw body; no per-repository webhook is needed.

## 16.3 GitLab

Name, GitLab URL (default `https://gitlab.com`), Internal URL (optional, for self-hosted GitLab reachable on a private address), Redirect URI (read-only, shown to copy into GitLab), Application ID, Application secret, Group name (optional, limits the repository list). "Save and connect" starts the authorization. "Use an access token instead" connects with a personal access token when OAuth isn't possible.

## 16.4 Bitbucket

Name, Bitbucket user name, Atlassian account email, API token, Workspace name (optional). "Save connection". Connections made with a legacy app password are marked "Deprecated" with a prompt to switch to an API token.

## 16.5 Gitea

Name, Gitea URL (default `https://gitea.com`), Internal URL (optional), Redirect URI (read-only), Client ID, Client secret, Organization name (optional). "Save and connect" starts the authorization.

## 16.6 Push deploys

- GitHub: automatic through the app.
- GitLab, Bitbucket, Gitea: saving a service's repository registers a webhook at the Git host with the connected token and a per-service secret. When that isn't possible, the Source panel shows the manual steps, URL and secret to people with deploy rights; a replaced URL shows as stale with "Register webhook". Deleting a service removes the webhooks Nearzero registered for it.

## 16.7 Rules

- Tokens and secrets are encrypted, never returned to the browser and never shown to the Agent.
- Repository lists are capped at 200 per request with search.
- Errors from the provider are shown in plain words ("GitHub says the app has no access to this repository. Grant access on GitHub.").
- Managed connections that only a hosted edition offered are not part of 1.0.

**Acceptance**
- Connecting GitHub on a console with a public HTTPS address, installing on an organization, and importing a private repository works end to end; a push redeploys.
- A member without "Connect their own Git accounts" sees no Connect button and can use a shared account.
- Deleting a provider in use requires the tick and leaves the services marked "No Git source".
