# G1. Identity and the shell: parity round 3 (0.1.79 and 1.0)

Reviewer: parity reviewer (dirty side), round 3. Compared: 0.1.79 (the reference behavior) and 1.0 at dac9631 (main), against `spec/` at the same commit. This file describes behavior only.

Scope: sign-in, sign-out, sessions, password reset, two-factor, registration modes, invitations, onboarding, email confirmation, profile, workspaces and slugs, members, roles, access policies and capabilities, the settings hub and its pages, the bell, header, switchers, sidebar, phone layout, theme picker, page metadata, error pages, empty, loading and error states, wording, keyboard and accessibility.

Not counted as gaps: the deliberate changes in `spec/00-index.md`, everything in `spec/27-dropped.md`, the owner's look decisions in 21.2, 21.7, 21.9a, 21.9b and 21.10, the decisions in `spec/30-parity-round-2.md` and `docs/round-2-assignments.md`, gaps already listed in 30a to 30d, and punch-list items marked Done.

## Summary

| Severity | New gaps | Still broken |
| --- | --- | --- |
| P0 | 0 | 0 |
| P1 | 1 | 0 |
| P2 | 13 | 1 |

| Id | Sev | Gap | Spec |
| --- | --- | --- | --- |
| Still broken: R1-02 | P2 | On a server that can't send email, accounts made from a copied invitation link stay unconfirmed for good; the bell hides their invitations and the Profile offers a button that can't work | 04 4.2, 4.6, 30a R1-02 |
| G1-01 | P1 | `sudo nearzero reset-password` reads its input differently: a 0.1.x script sets the owner's password to the email text, and the interactive form no longer asks which account | 03 3.4 (spec gap) |
| G1-02 | P2 | On a server that can't send email, nobody can change an account's email address | 04 4.6 (spec gap) |
| G1-03 | P2 | 0.1.79's own addresses for About Nearzero, Traefik, Monitoring, Home, Get started and the old setup page answer "Page not found" | 18.1, 29.5 (spec gap) |
| G1-04 | P2 | `/register?token=…` (and `/sign-up?token=…`) drops the invitation and lands on sign-in | 29.5, 04 4.2 |
| G1-05 | P2 | Capabilities lost the one-line explanation shown under each one in the policy and access dialogs | 04 4.7 (spec gap) |
| G1-06 | P2 | Capability names and group headings were renamed ("Manage DNS zones", "See router files", "Domains", "Advanced") | 04 4.7 vs 21.10 (spec likely wrong) |
| G1-07 | P2 | The invitation email and the test email say less than 0.1.x's | 04 4.5, 4.7 (spec gap) |
| G1-08 | P2 | The invitee's page: dead-link states lose their details and "Signed in as", and the accepted and unavailable states say the wrong thing | 04 4.5 |
| G1-09 | P2 | The bell shows an invitation's expiry as a relative time, not a full date | 11.5, 21.10 |
| G1-10 | P2 | Organization dialogs end with "Workspace renamed" and "<name> is ready" | 04 4.4, 21.10 |
| G1-11 | P2 | The sign-up page's wording changed | 04 4.2, 21.10 |
| G1-12 | P2 | The backup-code file and copied text are bare, and the two-factor dialogs' wording changed | 04 4.6 |
| G1-13 | P2 | The cookie that carries an invitation link (token and emailed proof) is never marked Secure | 21.9 (spec gap) |
| G1-14 | P2 | `sudo nearzero create-owner` no longer offers the installer's admin email | 03 3.4 |

---

## Round 2 gaps, re-checked

| Id | Result |
| --- | --- |
| R1-01 | Fixed. A GET or HEAD page request to the server's IP address over plain HTTP is sent to the same path and query on the HTTPS address. API paths, loopback addresses, POST requests and requests a trusted proxy marks as HTTPS are left alone. A public domain set under About Nearzero counts once its certificate is valid; with no HTTPS address nothing moves. |
| R1-02 | Partly fixed: see "Still broken: R1-02" below. Accounts moved from 0.1.x count as confirmed. A changed address gets a 24-hour link, the old address stays in use until it's opened, and the old address gets a notice afterwards. Profile offers "Send link again", "Cancel change" and "Send confirmation link". All of this works only when the server can send email. |
| R1-03 | Fixed. `invite_only` is accepted by the installer, written back as `invite-only` on reruns, and accepted by the control plane. |
| R1-04 | Fixed. `RESEND_API_KEY`, `NEARZERO_AUTH_FROM_EMAIL` and `RESEND_FROM_EMAIL` are read. The 1.0 name wins when both are set, and `NEARZERO_AUTH_FROM_EMAIL` wins over `RESEND_FROM_EMAIL`. A half-made setup is reported but never stops the start. |
| R1-05 | Fixed. The owner gets the welcome when they finish onboarding (with or without invites). An invited member gets it after the name step, or at joining when they already have a real name. Subject and heading are "Welcome to Nearzero, <first name>", the button "Open your dashboard" opens the workspace's Agent, and the footer reads "This message was sent to <email>." |
| R1-06 | Fixed. The bell reloads every 60 seconds while the tab shows and the panel is closed, when the tab shows again after more than 60 seconds, and on opening with data older than 15 seconds. |
| R1-07 | Fixed, except the toast "Enter the code from your authenticator app.", which is still being built elsewhere and isn't counted here. The code step keeps the email on screen read-only, shows the hint and "Verify", and accepts "123 456" and " 123456 ". |
| R1-08 | Fixed. `callbackUrl` goes through the same check as `next`, `?email=` fills the form, and `/accept-invitation/<token>` opens the invitation page. |
| R1-09 | Fixed. The pending, other-email, expired and cancelled states name the inviter when they have a real name. |
| R1-10 | Fixed. A browser with 0.1.x's stored theme and no 1.0 theme choice opens in that theme and keeps it from then on. A stored Dusk counts as chosen. |

### Still broken: R1-02 · P2 · Copied-link accounts on a server without email can never be confirmed

**0.1.x**
- Every account sees its pending invitations in the bell and is sent to them after sign-in, whether or not email is set up.

**1.0 now**
- Signing up through a copied invitation link makes the account unconfirmed. This is the usual way people join a fresh install, because new installs have no email set up.
- Such an account gets an empty invitation list in the bell and is never sent to a pending invitation after sign-in.
- Its Profile shows "Not confirmed yet. Invitations to it need the link from the invitation email." and a "Send confirmation link" button. On a server that can't send email the button always fails with "This server can't send email, so a new address can't be confirmed. Ask a Nearzero administrator to set up email, then try again." That message also speaks of "a new address" when the address being confirmed is the account's own.
- No other way to confirm exists. That copied link could only create the account because an instance administrator made the invitation and vouched for the address. Adding someone with a password is vouched the same way, and it does count as confirmed.

**Expected 1.0**
- Acceptance 1: on a server with no email, an account created from a copied link made by an instance administrator counts as confirmed, exactly like an account added with a password. Its later invitations show in the bell, and it is sent to them after sign-in.
- Acceptance 2: when the server can't send email, Profile doesn't offer "Send confirmation link". When it shows a refusal about confirming the account's own address, the refusal doesn't say "a new address".

**Spec**: 04 4.2 (copied links), 4.6, 30a R1-02.

---

## New gaps

### G1-01 · P1 · `reset-password` reads different input, and a 0.1.x script resets the wrong account

**0.1.x**
1. On a terminal, `sudo nearzero reset-password` first asks "Email [<owner's email>]:", so any account can be chosen (Enter keeps the owner). Then it asks "Password (8+ characters):" and "Confirm password:".
2. Without a terminal it reads two lines: the email (an empty line means the owner) and then the password.
3. The 0.1.x docs describe it as "new password for any account".

**1.0 now**
- The email can only be given as an argument (`reset-password [email]`). On a terminal there is no email question: it asks "New password (8+ characters):" without naming the account, and then changes the owner's password and signs the owner out everywhere.
- Without a terminal it reads one line and uses it as the password. So a 0.1.x script, `printf 'bob@example.com\nNewPass123\n' | sudo nearzero reset-password`, sets the owner's password to the text `bob@example.com` and signs the owner out of every session. Bob's password is not changed.

**Expected 1.0**
- Acceptance 1: `printf 'bob@example.com\nNewPass123\n' | sudo nearzero reset-password` sets Bob's password to `NewPass123` and leaves the owner's untouched.
- Acceptance 2: `printf '\nNewPass123\n' | sudo nearzero reset-password` sets the owner's password.
- Acceptance 3: `printf 'NewPass123\n' | sudo nearzero reset-password bob@example.com` keeps working.
- Acceptance 4: on a terminal with no email argument, it asks "Email [<owner's email>]:" first, and it names the account before asking for the new password.

**Spec**: 03 3.4 gives create-owner's input lines but not reset-password's. Spec gap: write down the two-line form.

---

### G1-02 · P2 · No way to change an email address on a server that can't send email

**0.1.x**
- Profile → Email changes the address at once, with or without email set up. This is how a person fixes a typo an administrator made when adding them with a password.

**1.0 now**
- Following the round 2 decision, a new address counts only once its link is opened. The link is the only way.
- When neither the workspace nor the server can send email, saving a new address is refused with "This server can't send email, so a new address can't be confirmed. Ask a Nearzero administrator to set up email, then try again."
- An administrator can't change someone's email, the server command can't either, and accounts can't be deleted. A mistyped address is stuck for good on a fresh install.

**Expected 1.0** (the owner chooses one)
- (a) Acceptance: on a server with no email, an instance administrator can set another account's email address, which counts as confirmed (they vouch for it, as with Add user with a password). The change is audited and the account's other sessions end.
- (b) Acceptance: on a server with no email, `sudo nearzero set-email <old> <new>` does the same from the server.
- Either way, the Profile refusal says who can make the change.

**Spec**: 04 4.6, and the B1-63 decision. Spec gap: the no-email case isn't covered.

---

### G1-03 · P2 · 0.1.79's own addresses for several pages answer "Page not found"

**0.1.x**
- About Nearzero lives at `/<org>/dashboard/about-nearzero`. Every "Settings" link from the user menu opens it, so it's the address people bookmark.
- Traefik (the router files page) lives at `/<org>/dashboard/traefik`, not under settings.
- `/<org>/dashboard/monitoring` redirects to About Nearzero.
- `/<org>/dashboard/home` and `/<org>/dashboard/get-started` redirect to the Agent.
- `/setup` and `/setup/<anything>` (the retired setup wizard) redirect to sign-in.
- The same paths without the organization segment work too.

**1.0 now**
- All of these answer a 404. Dashboard paths show "Page not found / Nothing here" in the shell, and `/setup` shows the public "Page not found". This holds with or without the workspace segment.
- Only `/dashboard/settings/<old entry>` addresses are mapped (punch list 36).

**Expected 1.0**
- Acceptance 1: `/<ws>/dashboard/about-nearzero` and `/dashboard/about-nearzero` open About Nearzero (`/<ws>/dashboard/settings`). So does `/<ws>/dashboard/monitoring`.
- Acceptance 2: `/<ws>/dashboard/traefik` opens Settings → Traefik (router files), with its query kept.
- Acceptance 3: `/<ws>/dashboard/home` and `/<ws>/dashboard/get-started` open the Agent (27 says they redirect today).
- Acceptance 4: `/setup` and `/setup/x` redirect to `/sign-in`.

**Spec**: 18.1 ("Old addresses redirect") lists only the settings pages. 29.5. Spec gap: add these.

---

### G1-04 · P2 · `/register?token=…` drops the invitation

**0.1.x**
- `/register?token=<t>&email=<e>` opens the sign-up form for that invitation, with the email locked. This is where the sign-in page's "Sign up to join <workspace>" and the invitation page sent new invitees.
- Signed in, the same address sends the person to the invitation.

**1.0 now**
- `/register` redirects to `/sign-up` with the query kept. The sign-up page ignores `token` and reads only the invitation it remembered from `/invitation`.
- With nothing remembered, the person lands on `/sign-in` and the invitation is gone. Signed in, they get "This link is incomplete".

**Expected 1.0**
- Acceptance: `/register?token=<t>` and `/sign-up?token=<t>` behave exactly like `/invitation?token=<t>`. The token leaves the address bar and the person continues to sign-up, sign-in or the invitation page as that page decides.

**Spec**: 29.5 (old addresses), 04 4.2.

---

### G1-05 · P2 · Capabilities lost their one-line explanations

**0.1.x**
- In the policy dialog ("What it allows") and the member access dialog ("What they can do"), each capability shows a hint under its name:
  - Create projects: "Start new projects. They get access to the projects they create."
  - Delete projects: "Delete projects they can reach."
  - Create environments: "Add environments to projects they can reach."
  - Delete environments: "Delete environments they can reach."
  - Create services: "Add apps, Compose stacks and databases to environments they can reach."
  - Delete services: "Delete services they can reach."
  - Connect their own Git accounts: "Connect GitHub, GitLab, Gitea or Bitbucket accounts of their own, deploy from them and remove them. Other people's accounts stay private unless shared or granted below."
  - Use the workspace's SSH keys: "See the workspace's SSH keys and use them for Git and servers."
  - Add and remove SSH keys: "Add SSH keys to the workspace and remove them."
  - Add and remove servers: "Add servers to the workspace, set them up and remove them. They can deploy to the servers they add."
  - Back up to the workspace's destinations: "Choose the workspace's backup destinations when backing up services they can reach."
  - Add and remove backup destinations: "Add S3-compatible backup destinations, test them and remove them."
  - Manage notification channels: "Add, change and remove the workspace's notification channels (Slack, Discord, email and others)."
  - Manage certificates: "Add, change and remove TLS certificates."
  - Manage DNS: "Change the DNS records Nearzero manages."
  - See Traefik files: "Read the Traefik configuration files."
- The section intro reads "Everyone can open and deploy the projects and services they're given. These add more." in the member dialog, and "Members with this policy can open and deploy the projects and services below. These add more." in the policy dialog.

**1.0 now**
- Only the capability names show, with no hint. Both dialogs share one intro: "On top of what every member can do with the services they're given: deploy, edit variables, manage domains, backups and tasks, read logs."

**Expected 1.0**
- Acceptance: each capability row in both dialogs shows its one-line explanation under the name, with the wording above (adjusted only where 1.0's behavior differs, for example the DNS one).

**Spec**: 04 4.7 lists names only. Spec gap: add the explanations.

---

### G1-06 · P2 · Capability names and groups were renamed

**0.1.x**
- Groups: "Projects and services", "Git and SSH", "Servers", "Backups", "Notifications", and "Workspace settings". The last one holds Manage certificates, Manage DNS and See Traefik files.
- The names read "Manage DNS" and "See Traefik files".

**1.0 now**
- Two groups replace "Workspace settings": "Domains" (Manage certificates, Manage DNS zones) and "Advanced" (See router files).
- The settings entry itself kept the original word "Traefik" (21.10), so the capability "See router files" points at a page called Traefik.

**Expected 1.0**
- Acceptance: the policy and access dialogs show "Manage DNS" and "See Traefik files" under "Workspace settings", as 0.1.79 did. The policy cards' "Can" line uses the same names.
- If the owner prefers 1.0's groups, at least "See Traefik files" should match the page's name.

**Spec**: 04 4.7's table renamed these. 21.10 says 1.0 uses the original's words where the spec renamed them, so 4.7 is likely wrong.

---

### G1-07 · P2 · The invitation email and the test email say less

**0.1.x invitation email** (subject unchanged)
- A header with the Nearzero logo.
- Heading: "You've been invited to join <workspace>".
- Text: "You have been invited to join **<workspace>** on Nearzero, the platform for deploying your apps to the cloud. Click the button below to accept the invitation."
- Button "Accept Invitation", then "If the button above doesn't work, copy and paste the following link into your browser:" and the link.
- Footer: "This invitation was intended for <email>. … If you were not expecting this invitation, you can safely ignore this email."

**0.1.x test email** (sent on "Save and send a test")
- Subject "Nearzero invitation emails are working".
- Body: "Invitation emails for <workspace> are set up. People you invite will get their invitation from this address."

**1.0 now**
- Invitation: no heading and no brand. The text is "<inviter> invited you to join <workspace> on Nearzero as a member." (or "as an admin"), then "The link works only for <email> and expires in 7 days.", the button "Accept invitation", and "Or open this address: <link>". There is no line telling someone who didn't expect it that they can ignore it.
- Test email: subject "Nearzero test email", body "This is a test from <workspace> on Nearzero. Invitation emails for this workspace will be sent the same way."

**Expected 1.0**
- Acceptance 1: the invitation email has the heading "You've been invited to join <workspace>". It keeps 1.0's inviter, role and expiry lines, and ends with "This invitation was intended for <email>. If you were not expecting this invitation, you can safely ignore this email."
- Acceptance 2: the test email's subject is "Nearzero invitation emails are working", and its body names the workspace and says invitations will come from this address.
- A brand header is optional; if added, it uses the brand kit's mark (21.9b).

**Spec**: 04 4.5 fixes only the subject. 4.7 doesn't describe the test email. Spec gap.

---

### G1-08 · P2 · The invitee's page: dead links say less, and two states read wrong

**0.1.x**
- Expired, cancelled and accepted states still list Workspace, Role and Invited email under the message.
- A signed-in person sees "Signed in as <email>" at the bottom of every state except the other-email one.
- Accepted: signed in, "There's nothing left to do with this link." with "Continue to Nearzero". Signed out, "Sign in to open <workspace>." with "Sign in", which fills in the invited email.
- Couldn't load: "Something went wrong on our side. Try again in a moment." with "Try again" and a second way out ("Continue to Nearzero" or "Back to sign in").
- Not found: "This link doesn't match any invitation. It may be mistyped or replaced by a newer one. Ask the person who invited you to send it again."
- Incomplete: "The invitation link is missing its code. Open the link from your invitation email again."

**1.0 now**
- Dead-link states show only the heading and one sentence, with no details and no "Signed in as".
- Accepted reads "The invitation to <workspace> can't be used any more.", which sounds like a failure although the person already joined. The button is "Go to the console" or "Go to sign in", and sign-in doesn't fill in the email.
- Couldn't load has no sentence at all and only "Try again".
- Not found and Incomplete read "It may have been replaced by a newer invitation. Ask for a new one." and "Open the whole link from the invitation, or ask for a new one."

**Expected 1.0**
- Acceptance 1: expired, cancelled and accepted states show Workspace, Role and Invited email.
- Acceptance 2: every state except other-email shows "Signed in as <email>" when signed in.
- Acceptance 3: the accepted state says "There's nothing left to do with this link." when signed in. Signed out, it says "Sign in to open <workspace>." and its sign-in link fills in the invited email.
- Acceptance 4: "Couldn't load this invitation" says "Something went wrong on our side. Try again in a moment." and offers a second way out besides "Try again".

**Spec**: 04 4.5 names the states but not their text.

---

### G1-09 · P2 · The bell shows invitation expiry as a relative time

**0.1.x**
- Each invitation in the bell shows "Role: <role>" and "Expires: <full local date and time>".

**1.0 now**
- It shows "Expires: in 6 days" (relative). Deployment cards in the same panel do show full dates.

**Expected 1.0**
- Acceptance: a bell invitation shows "Expires:" followed by the full date and time in the viewer's time zone, in the same format as the bell's deployment cards.

**Spec**: 11.5. 21.10 ("the bell shows full dates").

---

### G1-10 · P2 · Organization dialogs end with "Workspace" toasts

**0.1.x**
- Rename organization → toast "Organization renamed".
- Add organization → toast "Organization created successfully".
- Failures: "Failed to update organization" / "Failed to create organization" (or the server's words).

**1.0 now**
- The dialogs say "Rename organization" and "Add organization", but finish with "Workspace renamed" and "<name> is ready".
- Switching into the new organization after Add is an improvement and stays.

**Expected 1.0**
- Acceptance: renaming shows "Organization renamed", and adding shows "Organization created" (switching into it as now).

**Spec**: 04 4.4. 21.10 keeps "Organization(s) in the switcher and its dialogs".

---

### G1-11 · P2 · The sign-up page's wording

**0.1.x**
- Title "Welcome to Nearzero", with "Already have an account? Log in" under it.
- Email placeholder "me@company.com" (locked to the invited address). Password placeholder "At least 8 characters".
- Button "Create an account".
- Refusals "Invitation has expired" and "Invitation has already been used".

**1.0 now**
- Title "Join <workspace>", note "Already have an account? Sign in".
- Email hint "Your invitation is for this address.", password placeholder "Choose a password" with the hint "8 to 128 characters.".
- Button "Create account".
- The refusals read "Invitation has expired" and "This invitation has already been used".

**Expected 1.0**
- Acceptance: the button reads "Create an account", the password placeholder "At least 8 characters", and the used-invitation refusal "Invitation has already been used".
- The workspace in the title can stay, since it adds information.

**Spec**: 04 4.2 gives the refusals ("…already been used"). 21.10 keeps 0.1.79's wording.

---

### G1-12 · P2 · Backup-code file and two-factor wording

**0.1.x**
- Download saves `nearzero-2fa-backup-codes-<YYYYMMDD>.txt`. It is headed "Nearzero - BACKUP VERIFICATION CODES", with the notes "Each code can be used only once." and "Do not share these codes with anyone.", then "Username: <email>", "Generated on: <date>", and the codes numbered 1 to 10. Copy puts the same text on the clipboard and toasts "Backup codes copied to clipboard".
- The dialogs say:
  - "2FA Setup", "Enter your password to begin 2FA setup", the Issuer hint "Use a custom issuer to identify the service you're authenticating with.";
  - "Verify Your Identity" / "Enter your password to manage your 2FA settings";
  - "Regenerate Backup Codes" with "Generate new backup codes to replace your existing ones. This will invalidate all previous backup codes.";
  - "Disable 2FA" with "Completely disable two-factor authentication for your account. This will make your account less secure.", and the confirm "Are you absolutely sure?".
- Toasts: "Backup codes regenerated successfully" and "2FA disabled successfully".

**1.0 now**
- The file is `nearzero-backup-codes.txt`, holding one line naming the account, "Each code works once." and the bare codes. Copy copies only the codes.
- The dialogs and toasts use new wording: "Enable two-factor sign-in", "Manage two-factor sign-in", "New backup codes made. The old ones no longer work.", "Two-factor sign-in is off.". The flow itself is at parity.

**Expected 1.0**
- Acceptance 1: the downloaded file's name carries the date, and it holds the account's email, the date it was made, the two notes, and the codes numbered. Copy copies that same text.
- Acceptance 2: the disable confirm and the two toasts use 0.1.79's wording.

**Spec**: 04 4.6 ("Download and Copy"). 21.10's wording rule.

---

### G1-13 · P2 · The invitation-link cookie is never Secure

**0.1.x**
- An invitation token the browser needed to remember stayed in the tab's own storage and was never sent over the network.

**1.0 now**
- The token and the emailed proof are kept in an HttpOnly cookie for 7 days, but the cookie is never marked Secure, even over HTTPS. That proof is what lets someone create the invited account.
- The session cookie, by contrast, is Secure whenever the console is reached over HTTPS.

**Expected 1.0**
- Acceptance: over HTTPS, every cookie the sign-in, sign-up and invitation pages set (the invitation link and the "already shown this invitation" mark) is Secure, by the same per-request rule as the session cookie. Over plain HTTP they keep working.

**Spec**: 21.9 covers session cookies only. Spec gap.

---

### G1-14 · P2 · `create-owner` no longer offers the installer's admin email

**0.1.x**
- When the install's settings hold an admin email, `sudo nearzero create-owner` on a terminal asks "Email [<that email>]:", so pressing Enter uses it.
- Without a terminal, an empty first line means that email.

**1.0 now**
- It asks "Email:" with no default. An empty answer on a terminal just asks again ("Enter a valid email address, like you@company.com.").
- Without a terminal, an empty first line creates nothing.

**Expected 1.0**
- Acceptance: with `NEARZERO_ADMIN_EMAIL` in the settings file, `sudo nearzero create-owner` shows "Email [<that email>]:". Pressing Enter, or giving an empty first line on standard input, creates the owner with that email.

**Spec**: 03 3.4 (create-owner row).

---

## Notes on the spec

- **04 4.1**: "Page (always in the Light theme)" is stale. 21.2's owner decision (public pages use the saved theme) replaced it.
- **04 4.4**: the switcher heading "Workspaces" is stale. 21.10 says "Organizations", which 1.0 shows.
- **04 4.6**: "A new address counts as unproven until the person opens a link sent to it" no longer describes 1.0. The B1-63 decision keeps the old address in use until the link is opened. Update the text, and cover the no-email case (G1-02).
- **22.4 rule 9**: sign-in is "10 failures per email per 15 minutes". 4.1 (and 1.0) count per email and client address, with a 50-failure backstop per email. Make the two agree.
- **03 3.4**: give reset-password's input lines, as create-owner's are given (G1-01).

## Checked and at parity

- **Sign-in**
  - "Sign in to Nearzero" and the four lines under the title.
  - The browser checks and their wording, POST-only forms, and the password and code removed from the address bar.
  - "Invalid email or password." with equal work for unknown accounts.
  - The lockout message, and "Signed in, but your session could not be saved in this browser. Try again in a private window."
  - Signed-in visits to sign-in go on to their destination.
  - `/login`, `/signin`, `/register` and `/signup` keep their query, and the `callbackUrl` and `email` parameters are honoured.
- **Two-factor at sign-in.** A 10-minute challenge, 3 codes per 10 seconds, "That code is not valid. Try again.", and spaces in a 6-digit code.
  - Backup codes work with or without the dash, in either case, once each.
  - An expired challenge says "This sign-in has expired. Enter your email and password again." and goes back to the password step.
- **Sessions**
  - HttpOnly, SameSite=Lax, Secure on HTTPS, 7 days renewed on use.
  - Log out is POST only and lands on sign-in.
  - A password change from Profile, and the server's reset-password, sign out the account's other sessions.
  - Pages are never kept by shared caches.
- **After sign-in, in order:** an invitation, then unfinished onboarding, then the requested page, then the Agent. `/` sends people to sign-in or to their destination.
- **Registration**
  - No web sign-up without an invitation, and the email is locked to the invited address.
  - "An account already exists with this email. Log in instead." shows before submitting.
  - Registration-mode values behave as in 0.1.x on self-hosted installs, with `open` treated as bootstrap.
- **Onboarding**
  - The owner's two steps with their errors, the 10-address limit, and skipping one's own and already-invited addresses.
  - The member's "Welcome to the team" step.
  - Onboarding pages open only on their own step.
  - Unfinished onboarding is enforced on every dashboard page.
- **Invitations**
  - 7-day single-address links; the subject; the workspace key, else the server's, else a link for the inviter.
  - Resend keeps the link and restarts the 7 days, once per 30 seconds after a real send.
  - The duplicate-pending, already-member and owner-role refusals; an expired invitation is replaced; the 100-member limit.
  - Accept shows "You've joined <workspace>" and switches into it.
  - Decline signs out a person whose onboarding is unfinished.
  - The other-email state with "Sign out and continue as X" / "Stay signed in".
  - Bell accept ("Join this organization?").
  - Expired invitations stay listed 7 days.
  - Removing a member also removes their policies and direct grants, and moves their sessions off that workspace.
- **Profile**
  - One "My Account" form with "Change the details of your profile here.", First and Last Name, Email, Current Password, Password and the avatar; "Enable 2FA" / "Manage 2FA" at the top right.
  - "Current password is incorrect", 8 to 128 characters, and the "Profile updated" toast.
  - Initials on any color, upload under 2 MB, Gravatar.
  - Two-factor enable, regenerate and disable, with the password check never changing codes.
  - Avatars are shown to people who share a workspace.
- **Workspaces**
  - Slugs: lowercase, dashes, 48 characters, a suffix on collision, a random id when empty or reserved.
  - A wrong slug redirects to the active workspace without switching; old slugs keep redirecting.
  - The personal workspace is hidden from the switcher once the person has another.
  - Add and Rename only for instance administrators, with Logo URL (1.0 can also remove a logo).
  - Switching keeps the page (a project page falls back to Projects).
  - The delete rules in the API.
- **Members & access.**
  - Invitation-emails strip and dialog wording.
  - "Saved. A test email was sent to X…" / "Saved, but the test email to X failed. …".
  - People and Invitations tables and their actions, Add user and its password rules.
  - Policy limits, the project tree, "From <policy>", and toasts ("Role updated", "Policy saved", "Policy created", "Access saved").
  - Per-role server refusals for role changes and removals.
- **Shell**
  - Header with switcher, crumbs, PRODUCTION badge and bell.
  - User menu: "My Account" with the email, Light/Dark/Dusk, Settings, Documentation (new tab), Support (mailto) and "Log out" in red.
  - Sidebar order, with Analytics only for instance administrators.
  - The phone sheet closes on navigation and on Escape.
- **Bell**
  - Heading and subtitle, Channels (now only for people with channel rights).
  - Invitation cards with "Accept invitation".
  - The latest deployments with status and full date, the empty texts, and "Recent deployments are not available right now."
  - The badge counts invitations plus unseen failures, caps at "9+", is remembered per browser and workspace, and puts the count in the button's label.
- **Settings hub**
  - Entries, order and visibility; "You do not have access to this section." and "Could not load this page. Try refreshing."
  - Old `/dashboard/settings/<entry>` addresses redirect.
  - About Nearzero's checklist, version, server IP with Copy, public URL and host controls.
- **Page plumbing.**
  - Title format, description, robots meta and `/robots.txt` (`Disallow: /`), tab icons and manifest.
  - Link previews on public pages only.
  - 404 and 500 pages with a way back.
  - The "Nearzero is not answering" page (503) when the API can't be reached.
- **Server email settings and trusted origins.** The 0.1.x setting names, and "Sent with this server's email settings." on the strip.
