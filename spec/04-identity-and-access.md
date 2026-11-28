# 04. Sign-in, onboarding, workspaces, members, access policies and keys

Terminology: today's screens say both "organization" and "workspace" for the same thing. 1.0 says **workspace** everywhere a person reads it, except where 21.10 keeps the original's word "organization" (the switcher and its dialogs, and wording shown on the 0.1.79 screens).

## 4.1 Sign-in

**Page** (in the saved theme, as 21.2 decides for public pages): "Sign in to Nearzero", Email, Password (at least 8 characters), Sign in. The line under the form depends on the install:
- No admin yet: "No admin account yet. On the server, run `sudo nearzero create-owner`, then sign in here."
- Otherwise: "New accounts are by invitation. Ask a workspace owner to invite you."
- Arriving from an invitation for a new address: "Don't have an account? Sign up to join <workspace>".
- Arriving from an invitation for an existing account: "Sign in as <email> to accept your invitation to <workspace>." (email prefilled).

**Errors and limits**
- In the browser: "Enter your email address." / "Use a valid email address." / "Enter your password." / "Password must be at least 8 characters."
- Wrong email or password: "Invalid email or password." Same wording and same response time whether or not the account exists. No endpoint reveals whether an account exists (today one direct API path does; 1.0 closes it).
- After 10 failures for one email from one client address in 15 minutes, or 50 for one email from all addresses together: "Too many failed sign-in attempts. Wait a few minutes and try again." The counters survive a platform restart (today they are in memory). Limits use the real client address, which the console's proxy forwards.
- An account with no password answers "Invalid email or password." like any other failure, so the answer never reveals that the account exists.
- "Signed in, but your session could not be saved in this browser. Try again in a private window."
- No "forgot password" link: recovery is `sudo nearzero reset-password` on the server, or an administrator.

**Two-factor sign-in**: after the password, an "Authentication code" field ("6-digit code or backup code") and the button becomes "Verify". The challenge lasts 10 minutes. Invalid: "That code is not valid. Try again." At most 3 attempts per 10 seconds.

**Sessions**: 7 days, renewed on use. Changing the password signs out the account's other sessions.

**The root address** `/` sends a signed-in person to the Agent of their active workspace and everyone else to sign-in.

**After sign-in**, in order: a pending invitation opens the invitation page; unfinished onboarding opens its next step; otherwise the requested page or the Agent.

**Plain HTTP**: once the console has an HTTPS address, a page request to `http://<ip>:4321/...` redirects to the same path on the HTTPS address. Not redirected: API paths, localhost (SSH tunnels), and requests already secure behind a proxy.

**Forms** submit with POST, and the page strips any password or code from its own address on load ([21-design-system.md](21-design-system.md) 21.9).

**Acceptance**
- A wrong password for an existing and a non-existing email produce identical responses and timings within noise.
- The 11th failure in 15 minutes is refused even after a platform restart.
- With 2FA on, the password alone never creates a session.

## 4.2 Registration

- **Nobody can sign up from the web without an invitation.** The first account (the instance owner) comes from the installer or `sudo nearzero create-owner`.
- The registration page without an invitation token redirects to sign-in.
- Sign-up from an invitation: the email is locked to the invited address; the password placeholder is "At least 8 characters" and the button "Create an account" (31a G1-11). Errors: "Invitation has expired", "…already been used", "Email does not match invitation", "An account already exists with this email. Log in instead."
- 1.0 change: sign-up through an invitation proves control of the address (G5 in [24-known-gaps.md](24-known-gaps.md)). An invitation link emailed with the install's email settings carries that proof. A link emailed with a workspace's own settings still works as the invitation, but the account it creates starts unconfirmed, unless an instance administrator made the invitation. A copied link (an invitation that was never emailed) can create an account only when an instance administrator created the invitation; otherwise the invitee must sign up from the emailed link.
- An instance administrator vouches for every address they invite, as when they add someone with a password: an account created from their invitation, emailed or copied, counts as confirmed.
- The install setting for registration mode stays, but "open" is not offered for self-hosted installs (it already behaves as "bootstrap").

## 4.3 Onboarding

**Owner** (first sign-in of the installer-created account, which has no name yet):
1. "Set up your workspace": Your name and Workspace name (prefilled with "<First>'s workspace" when a real first name is known; placeholder "Acme Inc."). Errors: "Enter your name." / "Enter a workspace name." Saving names the workspace and gives it a matching web address.
2. "Invite your team": "Teammate emails" (comma, semicolon or newline separated, up to 10). "Send invites and finish" or "Skip for now". An invalid address names itself and blocks only that step.

**Invited member** (after accepting): "Welcome to the team", Your name, "Finish". The name step is skipped only when the account already has a real name (never an email-derived one).

A welcome email goes out when the instance or workspace can send email.

Dropped from today's onboarding: the two survey steps ("Tell us about your setup", "How did you hear about us?"); their answers are stored nowhere a person can read. See [27-dropped.md](27-dropped.md).

**Acceptance**: a fresh owner signs in, completes both steps, and lands on the Agent with their real first name in the greeting.

## 4.4 Workspaces

- Everything a person deploys belongs to a workspace: projects, servers, SSH keys, Git providers, backup destinations, notification channels, Agent sessions, policies and keys.
- **Addresses**: every dashboard page lives under `/<workspace-slug>/dashboard/...`. Slugs come from the name: lowercase, other characters become dashes, at most 48 characters, a numeric suffix on collision, a random id if the result is empty or reserved. A slug that is not the active workspace's redirects to the active one with the same path (it does not switch workspaces). After a rename, old slugs keep redirecting.
- **Personal workspace**: every account gets one, named "My Workspace", where the person is owner. The switcher hides it when the person belongs to any other workspace.
- **Switcher** (header, left): heading "Organizations" (21.10), a check on the active one. Switching keeps the current page under the new address.
- **Add workspace** (instance administrators only): the switcher's "Add organization" dialog with Name (required) and Logo URL; the creator becomes owner; the slug follows the name; it ends with the toast "Organization created" and switches into it (31a G1-10).
- **Rename workspace** (instance administrators who are also owner or admin of that workspace): "The name everyone in this workspace sees.", "Save name"; the slug follows. A logo can be changed or removed. The switcher's dialog ends with "Organization renamed".
- Everyone else gets, from the API: "Only Nearzero administrators can add, rename or delete workspaces."
- **Delete**: no screen in 1.0 (none today). The rule stays for any future screen and for the API: a workspace with projects cannot be deleted ("Delete this workspace's N projects first…"), nor a person's last owned workspace.

## 4.5 Invitations

**Inviting** (Settings → Members & access, 4.7): email, role, policies. Links look like `<console>/invitation?token=…`, last 7 days, and work only for that email.
- Email is sent with the workspace's own email key, else the instance's, else not at all (the inviter gets the link to share). Mail that proves an address (confirmation links, the notice to an old address) uses only the instance's settings; see 4.6.
- Subject: "You've been invited to join <workspace> on Nearzero". The email has the heading "You've been invited to join <workspace>", then fixed opening words, "You've been invited to join <workspace> on Nearzero.", then "Sent by <name> (<email>)" on its own line (the name cut at 60 characters, the email alone when there is no real name), the role and "The link works only for <email> and expires in 7 days.", the "Accept invitation" button with the address written out, and "This invitation was intended for <email>. If you were not expecting this invitation, you can safely ignore this email."
- Limits: each person sends at most 20 invitation emails an hour and 100 a day (past that the invitation is created and its link given), and a workspace holds at most 100 pending invitations (22.4 rule 9).
- Resend keeps the same link and restarts the 7 days, at most once per 30 seconds per invitation ("This invitation was just sent. Try again in N seconds."); the wait starts only when an email actually went out; if it could not be emailed, the link dialog opens instead.
- Inviting an address with a pending invitation: "This email already has a pending invitation. Send it again or copy its link from the list." An expired one is replaced.
- Inviting a member: "User is already a member of this workspace".
- Without a console address configured, no invitation is created: "No link to copy: this server has no console address set."
- Expired invitations stay listed for 7 days so they can be sent again, then disappear.

**Invitee's page** states: "This link is incomplete" ("The invitation link is missing its code. Open the link from your invitation email again."), "Invitation not found" ("This link doesn't match any invitation. It may be mistyped or replaced by a newer one. Ask the person who invited you to send it again."), "Couldn't load this invitation" ("Something went wrong on our side. Try again in a moment.", with Try again and a second way out), "This invitation has expired", "This invitation was cancelled", "This invitation was already accepted" (signed in: "There's nothing left to do with this link."; signed out: "Sign in to open <workspace>.", whose Sign in fills in the invited email), "This invitation is for another email" ("Sign out and continue as X" / "Stay signed in"), and pending: "Join <workspace>" with Workspace, Role, Invited email, and "Accept invitation" / "Decline". The expired, cancelled and accepted states also list Workspace, Role and Invited email, and every state but the other-email one ends with "Signed in as <email>" when signed in; the way out is "Continue to Nearzero" (signed in) or "Back to sign in" (31a G1-08).
- `/register?token=…` and `/sign-up?token=…` behave exactly like `/invitation?token=…` (31a G1-04).
- Signed out with a live link: to sign-in (existing account) or sign-up with the email locked.
- Accept: "You've joined <workspace>", then onboarding if unfinished. Refused when the workspace has 100 members.
- Decline: cancels the invitation; if onboarding is unfinished, signs the person out.
- A signed-in person with a pending invitation is sent to it once per browser on their next dashboard page (so declining is never forced on every page); the bell keeps listing it with "Accept invitation".

## 4.6 Profile

Reached from **Profile** in the user menu (1.0 adds this link; today the page has no link).
- First name, last name (a name cannot be cleared to empty).
- Email: 1.0 requires the current password to change it and sends a notice to the old address (today it changes with no check; G9 in [24-known-gaps.md](24-known-gaps.md)). A link goes to the new address and lasts 24 hours; the old address stays the account's (for sign-in, invitations and the bell) until the link is opened while signed in, and the notice goes to the old address then. Profile shows the waiting address with "Send link again" and "Cancel change"; an account whose own address is unconfirmed gets "Send confirmation link". An address already in use is refused, and email changes are limited to 5 per hour so the refusal can't be used to probe for accounts.
- These links and the notice go only through the install's email settings, never a workspace's own Resend key or SMTP server, which whoever runs that workspace chooses.
- **Without install email** nothing can be confirmed by email, so Profile offers no confirmation link. Saving a new address is refused with "This server can't send email, so a new address can't be confirmed. Ask a Nearzero administrator to change it in Members, or run sudo nearzero set-email on the server." Instead, an instance administrator who is an owner or admin of the workspace sets a member's address in Members (row menu "Change email", with the same reach as Change role and never the owner's), or root runs `sudo nearzero set-email <old> <new>`. The address counts as confirmed (giving the same unconfirmed address confirms it), the change is audited, and the account's sessions end.
- Password: current password and new password (8 to 128 characters); changing it signs out other sessions. Errors: "Current password is incorrect", "New password is required".
- Avatar: initials on a chosen color, an uploaded image (under 2 MB), or Gravatar. Toast "Profile updated".
- **Two-factor**: Enable → password (and optional issuer label) → QR code, the secret, and 10 backup codes (`xxxxx-xxxxx`, Download and Copy) → a 6-digit code → "Enable 2FA" → "2FA configured successfully". Manage → password → "Regenerate backup codes" (shows the new codes; toast "Backup codes regenerated successfully") or "Disable 2FA" (confirm "Are you absolutely sure?"; toast "2FA disabled successfully"). Checking the password never regenerates codes by itself.
- Download saves `nearzero-2fa-backup-codes-<YYYYMMDD>.txt`, headed "Nearzero - BACKUP VERIFICATION CODES", with "Each code can be used only once.", "Do not share these codes with anyone.", "Username: <email>", "Generated on: <date>" and the codes numbered 1 to 10. Copy puts the same text on the clipboard and says "Backup codes copied to clipboard" (31a G1-12).
- The Agent home's "What should I call you?" form writes to the same name fields.

**Acceptance**: enabling 2FA, signing out and signing in requires the code; a used backup code fails the second time; after regenerating, old codes fail.

## 4.7 Members and access

**Page**: Settings → "Members & access", for owners and admins (people with any member-management right). Tabs "People (n)" and "Access policies (n)".

**Invitation emails strip** (top of the page)
- "Invitation emails are on" / "… are off", with the detail: "Sent from <sender> with your Resend key <masked>.", "Sent with this server's email settings.", or "New invitations give you a link to send yourself" (plus "You can also add people with a password" where allowed).
- Owners and admins: "Set up email" / "Use your own Resend key" / "Change", and "Remove" when a workspace key exists; others: "An owner or admin can set this up."
- "Save and send a test" sends "Nearzero invitation emails are working": "Invitation emails for <workspace> are set up. People you invite will get their invitation from this address."
- Dialog "Invitation emails": Resend API key (password field; "stored encrypted and never shown again"; when one is saved, "Saved (masked). Leave empty to keep it."), Send from (`x@y` or `Name <x@y>`, up to 320 characters), "Save and send a test". Errors: "That doesn't look like a Resend API key. Resend keys start with re_.", "Paste your Resend API key.", "Enter the sender as team@yourdomain.com or Your Team <team@yourdomain.com>.", "The saved key can't be read on this server anymore. Paste it again." Results: "Saved. A test email was sent to X…" or "Saved, but the test email to X failed. …"
- Remove: confirm "Turn off invitation emails"; new invitations fall back to links.
- 1.0 adds SMTP as an alternative to Resend (decision D4).

**People tab**
- "Filter by name or email" ("No one matches this filter.") and **Add user**.
- Members table: Name (initials avatar, name, email, "You" on your row), Role (Owner, Admin, Member), Joined. Owners and admins see an access note under each role: "Everything" for owners and admins, otherwise the member's policy names or "Only what's granted to them".
- Row menu:
  - **Change role**: never for the owner or yourself. Owners can change anyone else; admins only members. Choices Admin or Member; "The owner role can't be given away"; "Update role". Server refusals: "You cannot change your own role", "The owner role is nontransferable", "Only the workspace owner can change admin roles…".
  - **Access**: only for members (not owners or admins) and not yourself. Refusals: "You can't change your own access. Ask another owner or admin." / "Owners and admins already reach everything. Change their role to Member…".
  - **Remove from workspace**: "X will lose access to this workspace. Their account isn't deleted." Owners and admins only; nobody removes the owner; admins cannot remove themselves or other admins.
- Invitations table: Email, Role, Status ("Sent <time>", policy names, Pending or Expired with "Expires in …" / "Expired … ago"). Actions: "Copy link", "Resend" ("Send again" when expired), "Cancel" ("The invitation link for X will stop working.").

**Add user** dialog
- A switch "Send invitation" / "Set a password" (the second only where allowed).
- Email; Role (Member: "Members reach only what you give them."; Admin: "Admins reach everything and can manage people."); Access policies (checkboxes, members only; the server refuses policies for other roles).
- Submit "Send invitation" (or "Create invitation" when email is off). Result: "Emailed to X." / "Not emailed: email isn't set up…" / "Not emailed. <reason>…", with the link and Copy.
- **Set a password** is allowed only when the person adding is an owner or admin of this workspace, is an instance administrator, and the workspace has a real name (not the personal placeholder). Refusals: "Only owners and admins can add people with a password.", "Only this server's administrators can add people with a password. Send an invitation instead.", "Give this workspace its own name before adding people with a password." Password: 8 to 128 characters, no leading or trailing space, "Show", "Generate" (16 characters without look-alike letters). An existing account: "X already has an account on this server. Send an invitation instead…". Result: copyable sign-in details (address, email, password). The person finishes their profile on first sign-in.
- Inviting as owner is refused: "Cannot invite a user with the owner role".

**Access policies tab**
- Intro: what policies are; owners and admins don't need them. "New policy". Empty state suggests a "Developers" example.
- Card: name, description, Can (first two capabilities "and N more", or "No extra permissions"), Projects ("All projects", "No projects", or "N projects, M environments"), Servers, Git ("All Git accounts", "Shared Git accounts", "N Git accounts"), holders ("Given to A, B, C and N more" or "Not given to anyone yet."). Edit and Delete ("X is given to N people. They lose what it grants; anything given to them directly stays.").
- Policy dialog: Name (required, up to 60 characters, unique: "There is already a policy called "X"."), Description (up to 240), "What it allows" (capabilities by group), "Projects and environments" (a tree of project → environment → service, with "All projects, environments and services, including new ones"; ticking a child ticks its parents, unticking a parent unticks its children), "Servers" (with "All servers, including new ones"), "Git accounts" (with "All Git accounts, including other people's private ones"; accounts shared with everyone are shown ticked and locked with "Shared with everyone"). "Save policy".
- Up to 100 policies per workspace. Something deleted since the page loaded: "A project … in the list isn't in this workspace any more. Reload…".

**Member access dialog** ("Access for <name>", "Save access"): attached policies, "What they can do", the projects tree, servers, Git accounts. Anything a policy already grants shows "From <policy>" (or "From A and B", "From A, B and N more"). A member's effective access is the union of direct grants and all attached policies; "all" choices include things created later.

**Capabilities** (1.0 catalog; each adds rights on top of a member's defaults). The groups and names are 0.1.79's (21.10, the G1-06 decision in 31), and each row shows its one-line explanation under the name in both dialogs (31a G1-05):

| Group | Capability | Explanation |
| --- | --- | --- |
| Projects and services | Create projects | Start new projects. They get access to the projects they create. |
| | Delete projects | Delete projects they can reach. |
| | Create environments | Add environments to projects they can reach. |
| | Delete environments | Delete environments they can reach. |
| | Create services | Add apps, Compose stacks and databases to environments they can reach. |
| | Delete services | Delete services they can reach. |
| Git and SSH | Connect their own Git accounts | Connect GitHub, GitLab, Gitea or Bitbucket accounts of their own, deploy from them and remove them. Other people's accounts stay private unless shared or granted below. |
| | Use the workspace's SSH keys | See the workspace's SSH keys and use them for Git and servers. |
| | Add and remove SSH keys | Add SSH keys to the workspace and remove them. |
| Servers | Add and remove servers | Add servers to the workspace, set them up and remove them. They can deploy to the servers they add. |
| Backups | Back up to the workspace's destinations | Choose the workspace's backup destinations when backing up services they can reach. |
| | Add and remove backup destinations | Add S3-compatible backup destinations, test them and remove them. |
| Notifications | Manage notification channels | Add, change and remove the workspace's notification channels (Slack, Discord, email and others). |
| Workspace settings | Manage certificates | Add, change and remove TLS certificates. |
| | Manage DNS | Add and remove the DNS zones Nearzero manages, and change the environments' default domains. |
| | See Traefik files | Read the Traefik configuration files. |

The intro above them reads "Everyone can open and deploy the projects and services they're given. These add more." in the member access dialog, and "Members with this policy can open and deploy the projects and services below. These add more." in the policy dialog.

Dropped from today's catalog because nothing uses them: "Manage container registries", "See the Docker tab" (unless the server page keeps a container list, see [09-servers-and-ssh-keys.md](09-servers-and-ssh-keys.md)), "Use the API and CLI".

**What a member can do by default** (no capabilities): within the projects, environments and services they are given: see them, deploy and cancel, edit service variables, manage domains, mounts, backups, volume backups and tasks of those services, read logs and monitoring. Nothing else: no members, servers, SSH keys, Git, destinations, channels, certificates, DNS, router files.

**Owners and admins** reach everything in the workspace. Only they edit members and policies. Nobody edits their own access. Promoting a member to admin removes their policies and direct grants (they no longer need them); demoting an admin to member starts them with none.

The full matrix is in [22-security-and-permissions.md](22-security-and-permissions.md).

**Acceptance**
- A member with a policy granting one project and one server sees only that project in Projects, only that server in Servers and in every server picker (console and Agent), and gets a refusal for anything else through the API.
- Removing the policy removes the access at once, except anything given directly.
- A member granted "Connect their own Git accounts" can connect GitHub, and sees their own and shared accounts only.

## 4.8 API keys (model and research keys)

Settings → "API keys", owners and admins only (others: "Only owners and admins can see the workspace's API keys."). Text: "Nearzero ships no keys of its own and never reads one from the server's environment."

Two cards:
- **OpenRouter** ("Required"): runs the Agent's model. Placeholder `sk-or-v1-…`, link to get a key.
- **Firecrawl** ("Optional"): web research. Placeholder `fc-…`. Saving checks the key: "Saved. Firecrawl accepted the key.", "Saved. Firecrawl couldn't be reached to check it; it is checked again on first use.", "That doesn't look like a Firecrawl API key. Keys start with fc-.", "Firecrawl rejected this key…".

Each card: badge (Not added, Added, or "Add it again" when the saved key can't be decrypted because the instance secret changed), the masked key (its prefix up to the first dash when that falls within the first 8 characters, else the first 3 characters; then "…" and the last 4), "Added <date> by <person>", a password field with "Add key" / "Replace", and "Remove" (a second click on "Confirm remove" within 6 seconds; the warning says the Agent stops answering, or research turns off). Input: at least 8 and at most 512 characters ("Paste the whole key.").

There are no personal HTTP API keys in 1.0's console unless decision D4 adds a public API ([25-open-decisions.md](25-open-decisions.md)).
