# Identity and access API (M1a)

The control plane's endpoints for sign-in, registration, profile, two-factor sign-in, onboarding, workspaces, members, invitations, access policies, Agent policies, API keys and invitation email. Implements spec 04, 19.9 (storage only), 22 and the identity gaps in 24 (G5, G9, G10, G12).

Everything is JSON under `/api/v1`. Request schemas live in `packages/shared/src/identity.ts` and `access.ts` (import them from `@nearzero/shared` to validate forms with the same words).

## Conventions

**Errors.** Every error has the M0 shape:

```json
{ "error": { "code": "invalid_request", "message": "Enter your email address.", "fields": { "email": "Enter your email address." }, "reference": "req_k3m9x2p7q4wz" } }
```

| Code | Status | Meaning here |
| --- | --- | --- |
| `invalid_request` | 400 | A field is wrong; `fields` has one message per field (dotted paths for nested fields, `_` for the whole body) and `message` is the first one. Also: body isn't JSON. |
| `unauthenticated` | 401 | No live session, wrong email or password, wrong or expired two-factor code |
| `forbidden` | 403 | Signed in but not allowed; the message says what would be needed |
| `not_found` | 404 | Doesn't exist, isn't in the active workspace, or the person can't see it (these look the same on purpose) |
| `conflict` | 409 | The current state refuses it (duplicate, limit reached, invitation used, workspace has projects …) |
| `payload_too_large` | 413 | Avatar image over 2 MB |
| `rate_limited` | 429 | Sign-in lockout, two-factor attempts, invitation resend spacing, password and email-change limits |

Show `message` as is: every refusal is in the spec's words or new words that name the fix.

**Bodies.** Requests with a body must send `Content-Type: application/json` (the avatar upload sends the image's own type). Unknown fields are ignored unless noted.

**Session cookie.** `nz_session`: HttpOnly, SameSite=Lax, Path=/, Max-Age 7 days, renewed on use (at most every 10 minutes, with a fresh `Set-Cookie`). It is Secure only when the browser reached the console over HTTPS. A two-factor challenge rides in `nz_challenge` (HttpOnly, SameSite=Lax, 10 minutes). The console proxy must pass `Set-Cookie` through unchanged and send the browser's `Cookie` header.

**Client address and HTTPS (console proxy contract).** The control plane believes `X-Forwarded-For` (last entry) and `X-Forwarded-Proto` only from trusted peers: loopback by default, or `NEARZERO_TRUSTED_PROXIES` (comma-separated addresses or IPv4 ranges). From anyone else they are ignored. So the console's `/api/v1` proxy must:
- drop whatever `X-Forwarded-For` / `X-Forwarded-Proto` its own client sent (it does today), then
- set `X-Forwarded-For: <real client address>` and `X-Forwarded-Proto: https|http` for the browser's connection.

Without these, sign-in limits see the console's address and cookies are never marked Secure.

**Changes only from the console's own pages (spec 22.4, 24 G11).** Every request that can change something (any method but GET, HEAD and OPTIONS) and every WebSocket upgrade is refused with 403 `forbidden` ("This request came from another site, so Nearzero refused it. Make the change from Nearzero's own pages.") when it comes from a page on another site, with or without a body:
- `Sec-Fetch-Site` must be `same-origin` or `none`;
- without it, `Origin` must be one of this console's addresses: the one the browser used, `NEARZERO_CONSOLE_URL`, the console's HTTPS hostname and `NEARZERO_TRUSTED_ORIGINS`;
- a request with neither header isn't from a web page and passes. `/api/v1/webhooks/` and `/api/v1/runner/` are never checked.

The console's proxy and terminal bridge check the origin against the address the browser used, then send `X-Nearzero-Origin-Checked: 1`, which the control plane believes only from a trusted peer. A request that reaches the API port straight is compared with the API's own address and the console's configured ones.

**Caching.** Every API answer is `Cache-Control: no-store` unless stated.

**Shapes used below.**

```ts
type Role = "owner" | "admin" | "member";

interface WorkspaceSummary {
  id: string; name: string; slug: string; logoUrl: string | null;
  personal: boolean;   // the untouched "My Workspace" placeholder
  first: boolean;      // the install's first workspace (its owners/admins are instance administrators)
  role: Role;          // the signed-in person's role in it
}

interface Avatar { kind: "initials" | "image" | "gravatar"; color: string; initials: string; imageUrl: string | null }

interface Me {
  id: string; email: string; emailVerified: boolean;
  pendingEmail: string | null;   // a new address waiting for its link
  canEmailLinks: boolean;  // the install can email confirmation links (30a R1-02)
  firstName: string | null; lastName: string | null;
  name: string;            // "First Last", or the email when there's no name
  hasRealName: boolean;    // false for empty or email-derived names: greet with "Hi there"
  avatar: Avatar;
  twoFactor: { enabled: boolean; backupCodesLeft: number };
  isInstanceAdmin: boolean;
  onboarding: { step: "workspace" | "invite" | "name" | null };
  createdAt: string;
}

type Next =
  | { kind: "invitation"; invitationId: string; workspaceName: string }  // open the invitation page
  | { kind: "onboarding"; step: "workspace" | "invite" | "name" }
  | { kind: "home" };                                                    // requested page or the Agent
```

`Next` follows spec 4.1's order: a pending invitation (only for accounts whose address is proven), unfinished onboarding, then home.

## Sign-in and sessions (spec 4.1)

| Endpoint | Auth | Request | Response |
| --- | --- | --- | --- |
| `GET /auth/session` | none | | Signed out: `{ signedIn: false, setup: { hasOwner } }` (hasOwner false → show the `create-owner` line). Signed in: `{ signedIn: true, person: Me, workspace: WorkspaceSummary \| null, next: Next }` |
| `POST /auth/sign-in` | none | `{ email, password }` | `{ status: "signed_in", next }` + session cookie, or `{ status: "two_factor_required", expiresInSeconds: 600 }` + challenge cookie (no session) |
| `POST /auth/two-factor` | challenge cookie | `{ code }` (6 digits or a backup code, dash optional) | `{ status: "signed_in", next }` + session cookie |
| `POST /auth/sign-out` | optional | | `{ signedOut: true }`, cookie cleared |
| `GET /auth/console-address` | none | | `{ httpsUrl: string \| null }`: the console's HTTPS address, which the console sends plain-HTTP visits to the server's IP address to (spec 4.1). `NEARZERO_CONSOLE_URL` when it is `https://`, else the public domain set under About Nearzero once the host's router holds a valid certificate for it, else null (nothing is redirected) |

Errors:
- 400 with the page's words: "Enter your email address." / "Use a valid email address." / "Enter your password." / "Password must be at least 8 characters."
- 401 "Invalid email or password." Same words, status and time for unknown emails.
- 429 "Too many failed sign-in attempts. Wait a few minutes and try again." after 10 failures for one email from one client address in 15 minutes (persisted; survives restarts). A backstop of 50 failures per email across all addresses also applies.
- Each attempt is counted before the password is checked, so attempts sent at once can't pass the limit.
- Two-factor: 401 "That code is not valid. Try again." (`fields.code`), 401 "This sign-in has expired. Enter your email and password again." (no or expired challenge), 429 "Too many codes tried. Wait a few seconds and try again." (more than 3 per 10 seconds per account, across every challenge it opens), 429 "Too many wrong codes for this account. Wait 15 minutes, then sign in again." (after 10 wrong codes in 15 minutes; a right code clears the count).

Signing in again in a browser ends that browser's previous session.

## Registration and invitations, invitee side (spec 4.2, 4.5, G5)

| Endpoint | Auth | Request | Response |
| --- | --- | --- | --- |
| `POST /invitations/inspect` | optional | `{ token }` | `{ state: "not_found" }` or `{ state: "pending" \| "expired" \| "cancelled" \| "accepted", workspaceName, role, email, inviterName (the inviter's real name, or null), accountExists? (pending only), signedInEmail, forAnotherEmail }` |
| `POST /auth/register` | none | `{ token, proof?, email?, password }` | 201 `{ status: "signed_in", next }` + session cookie; the new account is a member of the workspace with the invitation's role and policies |
| `POST /invitations/accept` | session | `{ token }` | `{ workspace: { id, name, slug }, message: "You've joined <workspace>", next }`; the workspace becomes active |
| `POST /invitations/decline` | session | `{ token }` | `{ declined: true, signedOut: boolean }`; signed out when onboarding is unfinished |
| `GET /me/invitations` | session | | `{ invitations: [{ id, workspaceName, role, expiresAt, inviterName }] }` (the bell; empty when the address isn't proven) |
| `POST /me/invitations/:id/accept` | session | | as `/invitations/accept` |
| `POST /me/invitations/:id/decline` | session | | as `/invitations/decline` |

Invitation links look like `<console>/invitation?token=…`. The copy sent by email adds `&proof=…`: an address proof when it went out with the install's email settings, a link proof when it went out with the workspace's own (C1-01). The invitation page must pass both `token` and `proof` (when present) to `/auth/register`, and must strip them from the address bar after reading them (spec 21.9).

Proof of the invited address (G5, C1-01):
- With an address proof, the account is created and its address counts as proven.
- With a link proof (the workspace's own Resend key or SMTP server carried the email), the account is created, but its address counts as proven only when an instance administrator made the invitation. Links emailed before this rule carry a link proof.
- An instance administrator's invitation always makes a proven address, emailed or copied (30a R1-02).
- Without a proof: if the invitation was ever emailed → 403 "To create your account, open the link in the invitation email sent to <email>."; if it was never emailed (copy-link only) it works only when an instance administrator created it, and it is used up by that sign-up; otherwise 403 "This invitation was never emailed to <email>, so it can't create a new account. …".

Other errors (spec wording): 404 "Invitation not found", 409 "This invitation has expired", 409 "This invitation was cancelled", 409 "This invitation was already accepted", 400 "Email does not match invitation" (when `email` is sent and differs), 409 "An account already exists with this email. Log in instead.", 403 "This invitation is for another email" (accept/decline signed in as someone else), 409 "This workspace has reached its limit of 100 members. Ask an owner or admin to remove someone first.", 403 for `/me/invitations/:id/*` when the account's address isn't proven (use the emailed link).

The sign-up page's "This link is incomplete" comes from the schema (missing or short token → 400 with `fields.token`).

## Profile (spec 4.6)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /me` | | `Me` |
| `PATCH /me` | any of `{ firstName, lastName, avatarKind, avatarColor }` | `{ person: Me, message: "Profile updated" }` |
| `PUT /me/avatar` | raw PNG, JPEG, GIF or WebP bytes, under 2 MB, `Content-Type: image/*` | `{ person: Me, message }`; avatar kind becomes `image` |
| `DELETE /me/avatar` | | `{ person: Me, message }`; back to initials |
| `GET /people/:personId/avatar` | | the image (`Cache-Control: private, max-age=86400`); 404 unless it's you or someone sharing a workspace |
| `POST /me/email` | `{ email, currentPassword }` | `{ person: Me, confirmationSentTo, message }`. A link goes to the new address (24 hours), only with the install's email settings, never a workspace's own; the account keeps its current address, for sign-in and invitations, until the link is opened. `Me.pendingEmail` names the waiting address. 409 when this server has no console address, or can't send email: "This server can't send email, so a new address can't be confirmed. Ask a Nearzero administrator to change it in Members, or run sudo nearzero set-email on the server." |
| `POST /me/email/confirmation` | | `{ person: Me, sentTo, message }`: sends the link again, to the waiting new address, else to the account's own unconfirmed address; 409 "Your email address is already confirmed." when there's nothing to confirm; 409 "This server can't send email, so your address can't be confirmed by email. …" without install email; 5 per hour |
| `DELETE /me/email/change` | | `{ person: Me }`: the waiting change is dropped |
| `POST /me/email/confirm` | `{ token }` | `{ person: Me, email, changed, noticeSent, message }`: opening the link signed in as its account. A new address becomes the account's, confirmed, and a notice goes to the old one (with the install's email settings only). 404 for an expired or used link, 403 for another account's link, 409 when another account took the address meanwhile |
| `POST /me/password` | `{ currentPassword, newPassword }` | `{ changed: true, otherSessionsEnded: number }`; this session stays |

Errors: "Enter your first name." (a name can't be cleared), "Current password is incorrect", "New password is required", "Use 8 to 128 characters.", "Use an image under 2 MB." (413), "Use a PNG, JPEG, GIF or WebP image.", "Upload an image first, then choose it.", "Another account already uses this email address." (409), 429 "Too many wrong passwords. Wait a few minutes and try again." (10 per 15 minutes per account), 429 "Too many email changes in the last hour. …" (5 per hour). `avatarColor` is one of `violet blue teal green amber orange rose slate`. For Gravatar the server builds `imageUrl`.

## Two-factor (spec 4.6, G12)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /me/two-factor` | | `{ enabled, backupCodesLeft }` |
| `POST /me/two-factor/setup` | `{ password, issuer? }` | `{ secret, otpauthUri, qrSvg, backupCodes: string[10] }` (`xxxxx-xxxxx`); nothing changes until enabled |
| `POST /me/two-factor/enable` | `{ code }` (6 digits) | `{ enabled: true, message: "2FA configured successfully" }` |
| `POST /me/two-factor/verify-password` | `{ password }` | `{ ok: true }`: the Manage dialog's password step; never changes codes |
| `POST /me/two-factor/backup-codes` | `{ password }` | `{ backupCodes: string[10] }`; old codes stop working |
| `POST /me/two-factor/disable` | `{ password }` | `{ enabled: false }` |

`qrSvg` is a complete SVG document drawn on the server (no browser crypto or QR library needed on plain HTTP). Errors: "Current password is incorrect" (`fields.password`), "That code is not valid. Try again.", 409 "Two-factor sign-in is already on. …".

## Onboarding (spec 4.3)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /onboarding` | | `{ step, suggestedWorkspaceName }` (`"<First>'s workspace"` when a real first name is known) |
| `POST /onboarding/workspace` | `{ name, workspaceName }` (owner step 1; `name` is the full name) | `{ workspace: { id, name, slug }, onboarding }`; names the workspace and gives it a matching slug |
| `POST /onboarding/invitations` | `{ emails }`: a string split on commas, semicolons and new lines, or a list; up to 10 | `{ results: [{ email, emailed, message?, link? }], onboarding }`; finishes onboarding |
| `POST /onboarding/skip-invitations` | | `{ onboarding }`; finishes onboarding |
| `POST /onboarding/name` | `{ name }` (invited member) | `{ onboarding }`; finishes onboarding |

Errors: "Enter your name.", "Enter a workspace name.", `"x@" is not a valid email address. Fix it or remove it.` (blocks only this step), "Invite up to 10 people here. …", 409 when the step isn't the current one.

## Workspaces (spec 4.4, 22.2)

Workspace endpoints act on the session's **active** workspace (`/workspace/...`); `/workspaces` is the switcher.

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /workspaces` | | `{ activeId, workspaces: WorkspaceSummary[], canAdd }` (the personal workspace is left out once the person belongs to another, unless active) |
| `POST /workspaces` | `{ name, logoUrl? }` | 201 `{ workspace }`; instance administrators only; the creator is owner |
| `POST /workspaces/:id/switch` | | `{ workspace }`; also the default for new sessions |
| `GET /workspaces/by-slug/:slug` | | `{ activeSlug, isActive, workspace: WorkspaceSummary \| null, renamed }`: for `/<slug>/dashboard/...`, redirect to `activeSlug` when `isActive` is false (no switching) |
| `GET /workspace` | | `{ workspace, role, isInstanceAdmin, can: { rename, manageMembers, managePolicies, manageAgentPolicies, manageApiKeys, manageEmail, addWithPassword, tasks } }`; `tasks` says whether Tasks is for this person (owners, admins, instance administrators, or a member with somewhere to run one) |
| `PATCH /workspace` | `{ name?, logoUrl? }` (`null` or `""` removes the logo) | `{ workspace }`; the slug follows the name, old slugs keep redirecting |
| `DELETE /workspace` | | `{ deleted: true, activeWorkspace }`; API only |

Slugs: lowercase, other characters become dashes, at most 48 characters, `-2`, `-3`… on collision (old slugs count), `ws-<random>` when empty or reserved (`dashboard`, `api`, `settings`, …).

Errors: 403 "Only Nearzero administrators can add, rename or delete workspaces." (everyone who isn't an owner or admin of the first workspace, even for their own personal workspace); 403 "Only this workspace's owner and admins can rename it."; 409 for delete of the install's first workspace, of a workspace with projects (the message comes from the projects area, M3), or of its owner's last owned workspace.

## Members and invitations (spec 4.5, 4.7)

Owners and admins only (members get 403 "Only owners and admins can … Ask one of them.").

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /workspace/members` | | `{ members: Member[], count, canSetEmail }`; `canSetEmail` is true for an instance administrator while the server can't send email |
| `PUT /workspace/members/:personId/email` | `{ email }` | `{ member: Member, changed, sessionsEnded, message }`: an instance administrator vouches for a member's address on a server that can't send email (31a G1-02). It counts as confirmed; a changed address ends all of their sessions; the same unconfirmed address is confirmed. Audited as `person.email-set` or `person.email-confirmed` |
| `PATCH /workspace/members/:personId` | `{ role: "admin" \| "member" }` | `{ updated: true }` |
| `DELETE /workspace/members/:personId` | | `{ removed: true }`; the account isn't deleted |
| `POST /workspace/members` | `{ email, role, policyIds?, password }` (add with a password) | 201 `{ member: Member, signIn: { address, email } }`; the password isn't echoed |
| `GET /workspace/members/:personId/access` | | `MemberAccess` |
| `PUT /workspace/members/:personId/access` | `{ policyIds, capabilities, scope }` | `MemberAccess` (replaces policies and direct grants) |
| `GET /workspace/invitations` | | `{ invitations: Invitation[] }` (pending, and expired up to 7 days) |
| `POST /workspace/invitations` | `{ email, role, policyIds? }` | 201 `{ invitation: Invitation, delivery }` |
| `POST /workspace/invitations/:id/resend` | | `{ invitation, delivery }`; same link, 7 days restart |
| `GET /workspace/invitations/:id/link` | | `{ link }` (Copy link; never carries the emailed proof) |
| `DELETE /workspace/invitations/:id` | | `{ cancelled: true }` |

```ts
interface Member {
  person: { id; email; name; firstName; lastName; avatar: Avatar };
  role: Role; joinedAt: string; isYou: boolean; emailConfirmed: boolean;
  access: { everything: boolean; policies: { id; name }[]; direct: boolean };  // note under the role
}
interface Invitation {
  id; email; role: "admin" | "member"; state: "pending" | "expired";
  policies: { id; name }[]; createdAt; expiresAt; lastEmailedAt: string | null;
  invitedBy: { id; name } | null;
}
interface Delivery { emailed: boolean; reason?: string; link: string }
// reason: "Not emailed: email isn't set up for this workspace or this server." or "Not emailed. <provider's reason>"
```

Refusals (spec wording): "Cannot invite a user with the owner role" (400), "User is already a member of this workspace" (409), "This email already has a pending invitation. Send it again or copy its link from the list." (409; an expired one is replaced instead), "No link to copy: this server has no console address set." (409; nothing is created), "This invitation was just sent. Try again in N seconds." (429; the 30 s wait starts only after an email went out), "Access policies are for members only: …" (400), "A policy in the list isn't in this workspace any more. Reload the page and try again." (409), 100-member limit (409).

Roles: "You cannot change your own role", "The owner role is nontransferable", "Only the workspace owner can change admin roles. Ask the owner to make this change." Admins may promote members; promoting drops the member's policies and direct grants.

Setting an address (instance administrator who is an owner or admin here, server without email): "Only owners and admins can change a member's email address.", "Only this server's administrators can change someone's email address. Ask a Nearzero administrator.", "This server can send email, so people change their address from Profile and confirm it from the link sent to it." (409), "You can't change your own address here. …", "The workspace owner's address can't be changed here. …", "Only the workspace owner can change an admin's email address. …", "Another account already uses this email address. Use a different one." (409), "That is already their email address." (400).

Removal: "The workspace owner can't be removed.", "Admins can't remove themselves from a workspace. Ask the owner to remove you.", "Admins can't remove other admins. Ask the workspace owner to do it."

Add with a password (owner or admin here, instance administrator, named workspace): "Only owners and admins can add people with a password.", "Only this server's administrators can add people with a password. Send an invitation instead.", "Give this workspace its own name before adding people with a password.", "<email> already has an account on this server. Send an invitation instead, so they can accept it.", "Remove the spaces at the start or end of the password." The person finishes their name on first sign-in (`next.step: "name"`).

Member access: "You can't change your own access. Ask another owner or admin." (403), "Owners and admins already reach everything. Change their role to Member to give them specific access." (409).

```ts
interface MemberAccess {
  personId; role: Role;
  policies: { id; name }[];
  direct: { capabilities: Capability[]; scope: Scope };
  effective: {
    capabilities: { key: Capability; from: string[] }[];  // policy names, or "direct"; ["role"] for owners/admins
    allProjects: boolean; allServers: boolean; allGitAccounts: boolean;
  };
}
```

## Access policies (spec 4.7)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /workspace/policies` | | `{ policies: Policy[], count }` |
| `POST /workspace/policies` | `{ name, description?, capabilities?, scope? }` | 201 `{ policy }` |
| `PUT /workspace/policies/:id` | same | `{ policy }` |
| `DELETE /workspace/policies/:id` | | `{ deleted: true, holdersAffected }` |

```ts
interface Scope {
  allProjects: boolean; projectIds: string[]; environmentIds: string[]; serviceIds: string[];
  allServers: boolean; serverIds: string[];
  allGitAccounts: boolean; gitAccountIds: string[];
}
interface Policy { id; name; description; capabilities: Capability[]; scope: Scope; holders: { id; name; email }[]; createdAt; updatedAt }
```

Capabilities (`CAPABILITIES` in shared, with group and label): `projects.create`, `projects.delete`, `environments.create`, `environments.delete`, `services.create`, `services.delete`, `git.connect-own`, `ssh-keys.use`, `ssh-keys.manage`, `servers.manage`, `backups.use-destinations`, `backups.manage-destinations`, `notifications.manage`, `certificates.manage`, `dns.manage`, `router-files.read`.

Scope rules: the server adds missing parents (a service brings its environment and project). A ticked node with no ticked children covers everything under it, including things created later; with ticked children it covers only those. Every id must be in the active workspace: "A project in the list isn't in this workspace any more. Reload the page and try again." (409). Until projects, servers and Git accounts exist (M3, M6, M8), any id is refused this way; the "all" switches work.

Limits: "Enter a name for the policy.", name up to 60 and unique ignoring case ("There is already a policy called "X"." 409), description up to 240, 100 per workspace (409).

## Agent policies (spec 19.9)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /workspace/agent-policies` | | `{ switches: Record<AgentPolicy, boolean>, usingDefaults, savedAt, savedBy }` |
| `PUT /workspace/agent-policies` | `{ switches: Partial<…>, productionConfirmation? }` | same as GET |

Keys and labels are `AGENT_POLICIES` in shared. Turning on `services.import-git` or `services.assign-domains` turns on `services.configure`; turning that off turns both off. Turning `production` on needs `productionConfirmation: "ALLOW PRODUCTION AGENT ACTIONS"` exactly (400 otherwise). Owners and admins only.

## API keys (spec 4.8)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /workspace/keys` | | `{ keys: [KeyView(model), KeyView(research)] }` |
| `PUT /workspace/keys/model` | `{ key }` | `{ key: KeyView, message: "Saved." }` |
| `PUT /workspace/keys/research` | `{ key }` | `{ key: KeyView, message }` after checking with Firecrawl |
| `DELETE /workspace/keys/:kind` | | `{ removed: true }` |

```ts
interface KeyView {
  kind: "model" | "research";
  status: "not_added" | "added" | "unreadable";   // unreadable → badge "Add it again"
  masked: string | null;                          // "sk-…wxyz", "fc-…1234"
  addedAt: string | null; addedBy: { id; name } | null;
}
```

Messages: "Paste the whole key." (8 to 512 characters), "That doesn't look like a Firecrawl API key. Keys start with fc-.", "Firecrawl rejected this key. …" (400, not saved), "Saved. Firecrawl accepted the key.", "Saved. Firecrawl couldn't be reached to check it; it is checked again on first use.". Members: 403 "Only owners and admins can see the workspace's API keys. …".

## Invitation email (spec 4.7, decision D4)

| Endpoint | Request | Response |
| --- | --- | --- |
| `GET /workspace/email` | | `EmailSettings` (owners and admins) |
| `PUT /workspace/email` | Resend: `{ provider: "resend", apiKey?, from }`; SMTP: `{ provider: "smtp", host, port, security: "tls" \| "starttls" \| "none", username?, password?, from }` | `{ settings: EmailSettings, testSent, message }` |
| `DELETE /workspace/email` | | `{ settings }` |

```ts
interface EmailSettings {
  on: boolean; source: "workspace" | "instance" | "none";
  detail: string;   // "Sent from <sender> with your Resend key re_…abcd." / "Sent with this server's email settings." / "New invitations give you a link to send yourself"
  workspace: null | {
    provider: "resend" | "smtp"; sender: string;
    maskedSecret: string | null; secretReadable: boolean;   // false → "The saved key can't be read on this server anymore. Paste it again."
    smtp: { host; port; security; username } | null;
    savedAt: string; savedBy: { id; name } | null;
  };
  canManage: boolean; canAddWithPassword: boolean;
}
```

A blank `apiKey`/`password` keeps the saved one. Saving sends a test to the saver: "Saved. A test email was sent to X. Check that it arrived." or "Saved, but the test email to X failed. <reason>". Errors: "Paste your Resend API key.", "That doesn't look like a Resend API key. Resend keys start with re_.", "Enter the sender as team@yourdomain.com or Your Team <team@yourdomain.com>.", "The saved key can't be read on this server anymore. Paste it again.", "Enter the SMTP password.", "Use a port from 1 to 65535.".

Order of email routes everywhere: the workspace's own settings, else the install's (`NEARZERO_EMAIL_FROM` with `NEARZERO_RESEND_API_KEY` or `NEARZERO_SMTP_URL`), else none (links only). Sending never fails a request.

## Install settings read by M1a

| Variable | Meaning |
| --- | --- |
| `NEARZERO_CONSOLE_URL` | The console's public address for links. Else `https://$NEARZERO_MANAGEMENT_HOSTNAME`, else `http://$NEARZERO_PUBLIC_IP:$NEARZERO_CONSOLE_PORT` (4321). With none, invitations can't be created. |
| `NEARZERO_TRUSTED_PROXIES` | Peers whose forwarded headers are believed (default loopback) |
| `NEARZERO_EMAIL_FROM`, `NEARZERO_RESEND_API_KEY` or `NEARZERO_SMTP_URL` (`smtp://user:pass@host:587` STARTTLS, `smtps://…:465` TLS) | This server's email settings |

## Server commands (spec 3.4)

`apps/control/dist/cli.js` (or `bun apps/control/src/cli.ts`), run inside the container with the control plane's environment. Applies pending migrations first.

| Command | Behavior |
| --- | --- |
| `create-owner` | Prompts "Email:", "Password (8+ characters):", "Confirm password:" on a terminal; otherwise reads two lines (email, password). Creates the owner with no name (onboarding runs) and the first workspace. Refuses with "This server already has an owner: X" / "Forgot the password? Run: sudo nearzero reset-password". Success: "Admin account created. Sign in at <address> as <email>". With `--json` (the installer) it answers one JSON line on standard output — `{"result":"created","email"}`, `{"result":"owner_exists","email"}`, `{"result":"account_exists","email"}`, `{"result":"invalid_input","field":"email"\|"password"}` or `{"result":"no_input"}` — with exit codes 0, 3, 4, 2 and 2, and the sentences above go to standard error (`{"result":"database_unavailable"}`, exit 1, when the database can't be reached or prepared). |
| `owner-status [--json]` | Read-only, for the installer: "The admin account is X." or "This server has no owner yet. Run: sudo nearzero create-owner"; with `--json`, `{"owner":"exists","email"}` or `{"owner":"missing"}`. Exits 0. |
| `reset-password [email]` | Defaults to the owner. Terminal: new password twice; otherwise one line. Signs out all its sessions and lifts its sign-in lockout. "No account exists for X.", "Use a password between 8 and 128 characters.", "Password updated for X. Its other sessions were signed out." |
| `reset-2fa [email] [--yes]` | Defaults to the owner. Asks "Turn off two-factor sign-in for X? [y/N]" on a terminal; without one, needs `--yes`. |

Exit code 0 on success, 1 otherwise. Nothing printed contains a password. When the database can't be reached: "Nearzero is not running. Start it with: sudo nearzero restart".

## For later milestones: the permission module

`apps/control/src/access/`:
- `matrix.ts`: every action of spec 22.3 and 22.2 with its rule (owners/admins always; members never, always, by capability, or by scope).
- `evaluate.ts`: `decide(grants, action, target?)`, pure.
- `grants.ts`: `WorkspaceAccess` (on every `WorkspaceActor` as `actor.access`): `require(action, { kind, id }?)` resolves the object inside the active workspace and throws `not_found` (outside the workspace or out of sight) or `forbidden` (seen, not allowed); `can(...)`; `visible(targets)` for lists and pickers.
- `objects.ts`: `ObjectRegistry`. Projects (M3), servers (M6) and Git accounts (M8) register a resolver for their kind (`project`, `environment`, `service`, `server`, `git_account`) returning `{ kind, id, projectId?, environmentId?, ownerPersonId?, sharedWithWorkspace? }` for ids inside a workspace. Policy scope validation uses the same registry.
- `services.workspaceDeletionChecks`: M3 adds the "Delete this workspace's N projects first…" check here.
