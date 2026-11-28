# R1. Identity and the shell: parity of 0.1.79 and 1.0

Reviewer: parity reviewer (dirty side). Compared: 0.1.79 (the reference behavior) and 1.0 at 9a01ec7, against `spec/` at the same commit. This file describes behavior only.

Scope: sign-in, sign-out, sessions, two-factor, registration and its modes, invitations, onboarding, profile, workspaces and slugs, members, roles, access policies, capabilities, the settings hub, About Nearzero, API keys, email settings, trusted origins, the header, switchers, sidebar, user menu, theme picker, bell, phone layout, page metadata, error pages, toasts, keyboard behavior.

Not counted as gaps: the deliberate changes in `spec/00-index.md`, everything in `spec/27-dropped.md`, the owner's decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10, and punch-list items marked Done. 21.9b (tab icon, `favicon.ico`, touch icon, manifest, link previews, robots, error pages) is specified and being built, so its missing pieces are not repeated here.

## Summary

| Severity | Count |
| --- | --- |
| P0 | 0 |
| P1 | 4 |
| P2 | 6 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| R1-01 | P1 | Plain-HTTP visits to the IP address are not sent to the HTTPS address once the console has one | 04 4.1, 21.9 |
| R1-02 | P1 | Accounts moved from 0.1.x, and anyone who changes their email, stay "unconfirmed" with no way to confirm, so invitations never reach their bell or the redirect after sign-in | 04 4.5, 4.6, 11.5, 29 |
| R1-03 | P1 | The 0.1.x registration-mode value `invite_only` stops the installer and the control plane | 03 3.1, 03 3.5, 04 4.2 (punch list 35) |
| R1-04 | P1 | 0.1.x names for the server's own email settings aren't read. One combination stops the control plane from starting | 03 3.5, 04 4.7 |
| R1-05 | P2 | Welcome email: the owner never gets one, members get it before their name step, and its subject and link differ | 04 4.3 |
| R1-06 | P2 | The bell never refreshes while a page stays open | 11.5 (spec gap) |
| R1-07 | P2 | Two-factor step at sign-in: email and password disappear, the hint is gone, and a code typed with a space is refused | 04 4.1 |
| R1-08 | P2 | Query parameters on old sign-in addresses are dropped, and the path form of the old invitation address gives a 404 | 04 4.1, 29.5 |
| R1-09 | P2 | The invitation page no longer names who sent the invitation | 04 4.5 |
| R1-10 | P2 | The theme a person chose in 0.1.x is lost after the move | 21.2, 29 (spec gap) |

---

## Gaps

### R1-01 · P1 · Plain-HTTP visits aren't moved to the HTTPS address

**0.1.x**
1. When the console's address is an `https://` address, a GET or HEAD page request that arrives at `http://<IPv4>:<console port>/<path>?<query>` gets a redirect to `<https console address>/<path>?<query>`.
2. It does not redirect API paths (`/api/...`), loopback visits (`127.x`, used by SSH tunnels), or requests a proxy has already marked as HTTPS.
3. So once a domain is set up, nobody types a password into the plain-HTTP page.

**1.0 now**
- No such redirect exists. The console port is still published on every interface by default.
- The session cookie is marked Secure per request, so signing in at `http://<ip>:4321` keeps working. But the password and the session token then travel unencrypted after HTTPS is available, and the old bookmarked IP address never moves people to the domain.

**Expected 1.0**
- Acceptance: with the console address set to `https://console.example.com`, `GET http://<server ip>:4321/sign-in?next=/x` answers a redirect to `https://console.example.com/sign-in?next=/x`.
- These are not redirected: `/api/v1/...`, `http://127.0.0.1:4321/...`, a request carrying `X-Forwarded-Proto: https` from a trusted proxy, and POST requests.
- With no HTTPS address set, nothing redirects.

**Spec**: 04 4.1 "Plain HTTP" and 21.9 already require this. It is a missing implementation, not a spec gap.

---

### R1-02 · P1 · "Unconfirmed" email addresses can't be confirmed, and every moved member account is one

**0.1.x**
1. No account's email address is ever checked; 0.1.x has no confirmation step. The only account it marks as confirmed is the one the server's owner command creates.
2. Every account, confirmed or not, sees its pending invitations in the bell ("Accept invitation", confirm "Join this workspace?"). After signing in, any account with a pending invitation is sent to the invitation page.
3. Changing the profile email changes nothing else.

**1.0 now**
- An account whose address is "unconfirmed" gets an empty invitation list in the bell. Signing in no longer sends it to a pending invitation, and accepting an invitation by its id (the bell's path) is refused: "Open the invitation link sent to X to accept it: this account's email address hasn't been confirmed."
- Its Profile shows "Not confirmed yet. Invitations to it need the link from the invitation email." permanently.
- Accounts end up unconfirmed in three ways:
  - **Moved from 0.1.x.** The import keeps 0.1.x's "not verified" flag. Every member who joined a 0.1.x install by invitation therefore arrives unconfirmed; in practice that is everyone except the installer's owner and people added with a password.
  - **Email change.** Changing the email on Profile clears the confirmation. 1.0 sends a notice to the old address but never sends a link to the new address.
  - **Copied link.** Signing up through a copied link (an invitation an instance administrator made that was never emailed) also creates the account unconfirmed.
- No page, email or command can confirm an address later.

**Expected 1.0**
- Spec 4.6 says a new address is unproven "until the person opens a link sent to it". 1.0 must send that link and accept it.
- Accounts carried over from 0.1.x must not lose bell invitations they had before the move. Either import them as confirmed, or let them confirm in one step.
- Acceptance 1: after an email change, the new address receives an email with a link. Opening it while signed in as that account marks the address confirmed, and the Profile hint disappears.
- Acceptance 2: a member account imported from a 0.1.x bundle, with a pending invitation to another workspace, sees that invitation in the bell and is sent to it after sign-in, exactly as it was in 0.1.x. If the owner instead decides that moved accounts must confirm, they get a way to do so from Profile ("Send confirmation link").
- Acceptance 3: invitation links opened from the email still work for unconfirmed accounts (unchanged).

**Spec**: 04 4.6 (a link is promised but never specified: its subject, lifetime and page), 04 4.5, 11.5, 29 (how 0.1.x's flag is imported). The spec should state the confirmation email and the import rule.

---

### R1-03 · P1 · Registration mode `invite_only` is refused

**0.1.x**
- The install setting `NEARZERO_REGISTRATION_MODE` takes `bootstrap`, `invite_only` (with an underscore) or `open`. The installer refuses anything else with "NEARZERO_REGISTRATION_MODE must be bootstrap, invite_only, or open".
- It writes the chosen value into the install's settings file and reuses it on reruns.

**1.0 now**
- The installer accepts only an empty value, `bootstrap`, `invite-only` (with a dash) or `open`, and refuses `invite_only` with "NEARZERO_REGISTRATION_MODE must be bootstrap or invite-only."
- The control plane refuses `invite_only` too ("NEARZERO_REGISTRATION_MODE must be bootstrap or invite-only; it is "invite_only".") and does not start.
- So a 0.1.x settings file, or a scripted install that passes the 0.1.x value, stops.

**Expected 1.0**
- Acceptance: `NEARZERO_REGISTRATION_MODE=invite_only`, given to the installer or found in an existing settings file, is accepted and behaves exactly like `invite-only`. The control plane starts with it.
- `open` keeps meaning `bootstrap` on self-hosted installs.

**Spec**: 03 3.1 promises that every 0.1.x setting "keeps working". 03's settings table and 04 4.2 name the value "invite-only", but 0.1.x's value was `invite_only`, so the spec is wrong here. This is a concrete answer to punch-list 35's open question for this one setting.

---

### R1-04 · P1 · 0.1.x names for the server's email settings

**0.1.x**
- The server's own email (used for invitations when a workspace has no key of its own, and for welcome emails) is read from these settings:
  - the key: `RESEND_API_KEY` or `NEARZERO_RESEND_API_KEY`;
  - the sender: `NEARZERO_AUTH_FROM_EMAIL` or `RESEND_FROM_EMAIL`.
- A sender is accepted as `x@y` or `Name <x@y>`.
- With only one of the two set, sending fails with a message naming the missing one, but the platform still runs.
- The Members page strip says "Sent with this server's email settings." when this is configured.

**1.0 now**
- 1.0 reads only `NEARZERO_RESEND_API_KEY`, `NEARZERO_SMTP_URL` and `NEARZERO_EMAIL_FROM`.
- A settings file carrying `NEARZERO_RESEND_API_KEY` with the 0.1.x sender name `NEARZERO_AUTH_FROM_EMAIL` makes the control plane refuse to start with "NEARZERO_EMAIL_FROM is not set, so this server's email settings can't be used…".
- A file carrying `RESEND_API_KEY` and `RESEND_FROM_EMAIL` is silently ignored, so invitations stop being emailed after the move.

**Expected 1.0**
- Acceptance 1: these combinations all give the same working server email as the 1.0 names:
  - `RESEND_API_KEY` with `RESEND_FROM_EMAIL`;
  - `RESEND_API_KEY` with `NEARZERO_AUTH_FROM_EMAIL`;
  - `NEARZERO_RESEND_API_KEY` with `NEARZERO_AUTH_FROM_EMAIL`.
- The 1.0 name wins when both are set, as with the other aliases.
- Acceptance 2: a half-configured server email (key without sender, or sender without key) logs and shows the problem but never stops the control plane from starting. 0.1.x kept running.

**Spec**: 03 3.5 (the alias table) and 04 4.7 ("Sent with this server's email settings."). The spec doesn't list these 0.1.x names; add them.

---

### R1-05 · P2 · Welcome email

**0.1.x**
1. A welcome email goes out, through the server's own email settings, at these moments:
   - when the installer's owner finishes onboarding (after naming themselves and the organization);
   - when someone with no workspace creates one from the "Create your workspace" step;
   - when an invited member finishes their name step.
2. Subject: "Welcome to Nearzero, <first name>" ("there" when no name is known).
3. Heading: "Welcome to Nearzero, <first name>". Text: "Your organization **<name>** is ready. Nearzero helps your team deploy apps, manage services, and run infrastructure from one place."
4. A button "Open your dashboard" links to that workspace's Agent at `<console>/<slug>/dashboard/agent`, with the link repeated as text. The footer reads "This message was sent to <email>."
5. A failed send is logged and never blocks onboarding.

**1.0 now**
- The welcome goes out only when a member joins a workspace (accepting an invitation, or signing up through one), at the moment of joining. That is before their name step, so it can't greet them by name.
- The installer's owner never gets one.
- Subject: "Welcome to <workspace> on Nearzero". Body: "You're now part of <workspace> on Nearzero." The button "Open Nearzero" links to the console's front page.

**Expected 1.0**
- Acceptance 1: when the owner finishes onboarding ("Send invites and finish" or "Skip for now"), one welcome email goes to them, if the workspace or the server can send email.
- Acceptance 2: an invited member gets one welcome email, after the name step (or at joining when that step is skipped because they already have a real name). It greets them by first name.
- Acceptance 3: the button opens that workspace's Agent (`<console>/<slug>/dashboard/agent`).
- The spec should fix the subject and text. 0.1.x's are above; 1.0's "workspace" wording is fine.

**Spec**: 04 4.3 ("A welcome email goes out…"). It gives no moment, recipient or wording.

---

### R1-06 · P2 · The bell doesn't refresh while a page stays open

**0.1.x**
1. The bell loads the latest 8 deployments when the page opens.
2. It reloads them every 60 seconds while the tab is visible and the panel is closed.
3. It reloads when the tab becomes visible again after more than 60 seconds, and when the panel is opened with data older than 15 seconds.
4. The badge and the list therefore show a new failure without any navigation, for example while someone sits on the Agent page.

**1.0 now**
- The list and the failures it counts come with the page.
- On load the badge also asks the API once for older failures since the last look.
- Nothing refreshes afterwards. A deployment that fails while the person stays on one page shows up only after they navigate.

**Expected 1.0**
- Acceptance: with the Agent page left open and the tab visible, a deployment that fails shows in the bell's badge within about 60 seconds and in the list on the next open, with no navigation.
- Opening the panel with data older than 15 seconds reloads it first.

**Spec**: 11.5 doesn't say. Spec gap: add the refresh rule.

---

### R1-07 · P2 · The two-factor step at sign-in

**0.1.x**
1. After a correct password for an account with two-factor on, the email and password fields stay on screen, read-only.
2. An "Authentication code" field appears with the placeholder "6-digit code or backup code" and the hint "Enter the code from your authenticator app, or one of your backup codes."
3. The button becomes "Verify", and a toast says "Enter the code from your authenticator app."
4. All whitespace inside the code is removed before it is checked, so "123 456" works.
5. An empty code: "Enter your authentication code."

**1.0 now**
- The page switches to a code-only form: there is no email (so the person can't see which account they're verifying), no hint line and no toast.
- Only the ends of the code are trimmed, so a six-digit code typed or pasted as "123 456" is refused with "That code is not valid. Try again." and uses up one of the 3 tries per 10 seconds.
- Backup codes typed with spaces still work.

**Expected 1.0**
- Acceptance 1: the code step shows the email it signs in (read-only), the hint "Enter the code from your authenticator app, or one of your backup codes.", and "Verify".
- Acceptance 2: "123 456" and " 123456 " are accepted when "123456" is the current code.

**Spec**: 04 4.1 "Two-factor sign-in". Add the hint and the whitespace rule.

---

### R1-08 · P2 · Old sign-in and invitation addresses lose their meaning

**0.1.x**
- When signed out, a dashboard page redirects to `/login?callbackUrl=<the page>`. After sign-in the person lands on that page, provided it is a dashboard path, `/register` or an invitation.
- `/login?email=<address>` opens the form with the email filled in. Invitation sign-in links use this.
- `/accept-invitation/<token>` (the token as the last path segment) redirects to `/invitation?token=<token>`.

**1.0 now**
- `/login` redirects to `/sign-in` with the same query, but the sign-in page reads only `next`. A bookmarked or shared `/login?callbackUrl=/dashboard/projects` therefore lands on the Agent, not on Projects.
- The `email` parameter is ignored.
- Only the bare `/accept-invitation` path is mapped. `/accept-invitation/<token>` answers the 404 page.

**Expected 1.0**
- Acceptance 1: `/login?callbackUrl=/dashboard/projects` → sign in → the Projects page of the active workspace. The callback goes through the same safety check as `next` (local paths only).
- Acceptance 2: `/sign-in?email=a@b.c` (and `/login?email=…`) prefills the email field.
- Acceptance 3: `/accept-invitation/<token>` → `/invitation?token=<token>`.

**Spec**: 29.5 (old addresses), 04 4.1. The spec should name `callbackUrl` and `email` as accepted parameters, and the path form of the invitation address.

---

### R1-09 · P2 · The invitation page doesn't say who invited you

**0.1.x**
- Pending: "**<inviter name>** invited you to join **<workspace>** on Nearzero." When signed out, the text ends "Sign in to accept." If the inviter has no usable name: "You're invited to join <workspace> on Nearzero."
- Expired: "Ask **<inviter name>** to send it again." (else "Ask the person who invited you to send it again.").
- Cancelled: "It was withdrawn or declined, so it can't be used anymore. If you still want to join <workspace>, ask <inviter>…".
- Signed in as another account: "<inviter> invited you to join <workspace> as <invited email>. You're signed in as <your email>."

**1.0 now**
- Pending: "You've been invited to join <workspace> on Nearzero."
- Expired, cancelled and accepted: "The invitation to <workspace> can't be used any more."
- The inviter is never named, although the invitation email names them.

**Expected 1.0**
- Acceptance: for an invitation sent by "Ana Ruiz", the pending page reads "Ana Ruiz invited you to join <workspace> on Nearzero." and the expired page asks "Ask Ana Ruiz to send it again."
- With no real inviter name, the current wording stays.

**Spec**: 04 4.5. The states are listed, but not the inviter line or the per-state explanation.

---

### R1-10 · P2 · The theme chosen in 0.1.x is lost after the move

**0.1.x**
- The theme picker saves the choice in the browser's local storage, under the key `nearzero-theme`, with the value `light`, `dark` or `dusk`.
- With nothing saved, a person gets Dusk.

**1.0 now**
- 1.0 keeps the choice in a cookie and never looks at the old stored value.
- After the move (same console address, same browser), everyone opens in Light, including people who had picked Dark or Dusk on purpose.

**Expected 1.0**
- Acceptance: a browser that has `nearzero-theme = dark` in local storage for the console's address, and no 1.0 theme cookie, opens 1.0 in Dark on its first visit. 1.0 then saves Dark its own way, and the old value is no longer needed.
- An old value of Dusk that the person never chose explicitly can't be told apart from a chosen one. Treat it as chosen, or follow the owner's Light-default decision. Either way, write the rule down.

**Spec**: 21.2 (Storage) and 29 (moving). Spec gap: no carry-over rule.

---

## Notes on the spec

- **04 4.1 Sessions.** "7 days, renewed on use" is fine. 0.1.x issued 7-day sessions at sign-in but then renewed them on a rolling 3-day window. 1.0's rule is longer-lived, which is acceptable; no change needed.
- **03 3.1, 04 4.2 registration mode.** The value is `invite_only` in 0.1.x, not "invite-only" (see R1-03).
- **04 4.6 email confirmation.** The promised confirmation link has no specification (see R1-02).

## Checked and at parity

- **Sign-in page**
  - Title "Sign in to Nearzero" and the four footer lines (no owner, invite only, sign up to join, sign in as the invited address with the email filled in).
  - Browser checks and their wording, POST-only forms, and the password and code removed from the address bar on load.
  - "Invalid email or password." with equal timing for unknown accounts.
  - 10 failures per email in 15 minutes. 1.0 adds a per-address limit and keeps the counts across restarts, as the spec asks.
  - "Too many failed sign-in attempts. Wait a few minutes and try again.", and "Signed in, but your session could not be saved in this browser. Try again in a private window."
- **Two-factor at sign-in.** A 10-minute challenge, 3 tries per 10 seconds, "That code is not valid. Try again.", and backup codes used once each.
- **Sessions**
  - HttpOnly, SameSite=Lax cookies, Secure on HTTPS. 1.0 decides Secure per request.
  - Sign-out ends the session and lands on sign-in.
  - A password change signs out the account's other sessions, and so does the server's reset-password command.
  - Dashboard pages are never cached by shared caches.
- **After sign-in, in order:** an invitation, then unfinished onboarding, then the requested page, then the Agent. `/` goes to sign-in, or to the Agent of the active workspace.
- **Registration**
  - No web sign-up without an invitation, and the sign-up page without one goes to sign-in.
  - The email is locked to the invited address, with the errors "Invitation has expired", "…already been used", "Email does not match invitation" and "An account already exists with this email. Log in instead."
  - 1.0 also adds the proof that the person receives mail at the address, as the spec asks.
- **Onboarding**
  - The owner's two steps: name and workspace name ("Acme Inc." placeholder), then up to 10 teammate emails with "Send invites and finish" and "Skip for now". An address that's already a member, already invited, or the person's own is skipped.
  - The invited member's name step and "Finish".
  - The survey steps are dropped, as the spec says.
- **Invitations**
  - Links last 7 days and work for one address. Subject: "You've been invited to join <workspace> on Nearzero".
  - Email goes out with the workspace key, else the server's, else the inviter gets a link.
  - Resend keeps the link and restarts the 7 days, once per 30 seconds: "This invitation was just sent. Try again in N seconds."
  - Duplicate pending: "This email already has a pending invitation. Send it again or copy its link from the list." Already a member: refused. Owner role: refused. An expired invitation is replaced.
  - The 100-member limit.
  - Accept: "You've joined <workspace>", then onboarding. Decline: signs the person out when their onboarding is unfinished.
  - The other-email state with "Stay signed in".
- **Profile**
  - First and last name; a password change needing the current one ("Current password is incorrect", "New password is required", 8 to 128 characters); the "Profile updated" toast.
  - Avatar: initials, any color, upload under 2 MB, or Gravatar.
  - 2FA enable: password, optional issuer, QR code and secret, 10 backup codes with Download and Copy, a 6-digit code, then "2FA configured successfully".
  - 2FA manage: password, then regenerate (new codes shown) or disable (with a confirm). Checking the password never changes the codes.
  - The Agent home's "What should I call you?" form writes the same name fields.
  - 1.0 adds `reset-2fa` on the server command, which 0.1.x had only as an internal script.
- **Members & access**
  - Every 0.1.x refusal for role changes and removals, in the spec's wording: not yourself, not the owner, owner nontransferable, admins only over members, admins can't remove themselves or other admins.
  - Add user with a password: instance administrators only, on a named workspace, 8 to 128 characters, Generate, and copyable sign-in details.
  - Invitations table: Copy link, Resend or Send again, Cancel.
  - The email strip and its Resend dialog. 1.0 adds SMTP, as decision D4 asks.
  - Policies: up to 100, names of at most 60 characters and unique, descriptions of at most 240 characters; the project → environment → service tree, servers, Git accounts, "From <policy>". The capability catalog matches 0.1.x minus the three the spec drops.
- **Workspaces**
  - Slugs from the name, at most 48 characters, a random id when empty or reserved. A wrong slug redirects to the active workspace with the same path.
  - The personal workspace is hidden from the switcher once the person belongs to another.
  - Add and rename for instance administrators only, with Logo URL. 1.0 adds redirects from old slugs.
  - The delete rules in the API (projects first, never the last owned workspace).
- **Shell**
  - Header: organization switcher ("Organizations" heading, check on the active one, switching keeps the page), project and environment crumbs, the environment switcher with "Add environment", the PRODUCTION badge, and the bell.
  - User menu: "My Account", name and email, the Light/Dark/Dusk radio group (arrow keys work), Settings, Documentation, Support, "Log out" in red.
  - The sidebar order. Analytics shows only for people who may use it.
  - Escape and outside clicks close menus and the bell.
- **Bell**
  - Heading "Notifications", "Invitations and recent deployments.", a Channels link.
  - Invitations show "Role" and "Expires" with "Accept invitation" (confirm "Join this workspace?").
  - The latest 8 deployments.
  - The empty texts "You're all caught up." / "Deployments will show up here." and "No recent deployments."
  - The badge counts failures since the last open, the last 24 hours on a first visit, capped at "9+", remembered per browser and workspace.
- **Settings hub.** Entries, order and who sees each match 18.1. "You do not have access to this section." and "Could not load this page. Try refreshing." Old settings addresses redirect (punch list 36).
- **API keys**
  - OpenRouter is "Required" and Firecrawl "Optional", with the badges and masked keys.
  - "Remove" becomes "Confirm remove" for 6 seconds, with a warning that the Agent stops answering or that research turns off.
  - The Firecrawl check messages.
  - Non-administrators are refused.
- **About Nearzero.** The first-time setup checklist, version, server IP with Copy, public URL, "Configure public domain", the Docker cleanup switch, and the host deployment allowance.
- **Trusted origins.** 0.1.x had no screen for them, only the install setting and an unused per-account field. 1.0 accepts the setting, and its install guide states that every address that reaches the console already works, because the API goes through the console.
- **Toasts.** Bottom right, at most 28rem wide, polite announcements. 0.1.x showed one toast at a time for 6.5 seconds; 1.0 stacks up to 4 for 5 seconds and holds one under the pointer. That is not a loss.
- **404.** The page exists and has a way back. Its final wording and the brand mark come with 21.9b. 0.1.x's version read "404 / Page not found / The link may be broken, or this page may have been removed." with "Go back" (history back, else sign-in).
