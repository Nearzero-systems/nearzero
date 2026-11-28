# 09. Servers and SSH keys

A **server** is a Linux machine Nearzero deploys onto. The **Nearzero host** (the control-plane machine) is always available as a deploy target for instance administrators (and workspaces they allow, see G3). Other servers are added over SSH with a saved **SSH key**.

## 9.1 Servers page

Sidebar → Infrastructure → **Servers** (people with server access; members see only servers granted to them). Without access: "You do not have access to servers." On failure: "Could not load servers. Try refreshing the page."

- Title "Servers" with the main button beside it: **Add Server** on the Servers tab, **Add SSH Key** on the SSH keys tab. Tabs: "Servers", "SSH keys" (the second for people who can see keys; `?tab=ssh-keys` opens it).
- Search (name, address, description, SSH user) and a status filter.
- Each server is a card: name, a readiness badge (**Ready**, **Setup needed**, **Setup running**, **Setup failed**, **Inactive**: set up, but its runner isn't connected right now), the description (2 lines) and the last setup error in red.
- Empty states: no keys and no servers: "No SSH keys yet / Add an SSH key first, then connect a server for Nearzero to set up automatically."; no servers: "No servers yet / Add a server to deploy applications on it."; no match: "No servers match your filters / Try adjusting your search or status filter."
- Card menu: **View** (when ready) or **Run setup again**; **Terminal** (an SSH shell in the browser; needs the server's manage rights); **Edit**; **Router files** (a read-only tree of the server's router configuration); **Delete**.

## 9.2 Adding a server

Dialog "Add server" ("Add a server to deploy your applications on it."):

| Field | Rules |
| --- | --- |
| Name | Required; unique in the workspace, case-insensitive: `A server named "X" already exists. Use another name, or change that server instead.` (31c G3-08) |
| Description | Optional |
| SSH key | Required; one of the workspace's keys ("Saved SSH key not found.") |
| Address | Required; an IP or hostname without protocol, path, port or spaces ("Enter an IP address or hostname without a protocol, path, or port") |
| Port | Default 22; 1 to 65535 |
| SSH user | Required, **no default**; placeholder "ubuntu"; up to 32 characters, starts with a letter or `_`, then letters, digits, `_` or `-` |

- Hint under SSH user: "AWS Ubuntu servers use ubuntu, Amazon Linux uses ec2-user, Debian on AWS uses admin, and most VPS providers use root. A user other than root needs passwordless sudo; setup adds it to the Docker group."
- No other server in the workspace may use the same address and port: `"X" already uses <address>:<port>. Change that server instead of adding the same machine twice.` (31c G3-08).
- The dialog shows the server's own error message (today it replaces every error with "Error creating a server").
- On the first connection the server's host key fingerprint is recorded and shown, so the person can compare it with their provider's console. A changed host key is always refused. With strict host key checking enabled at install, an unknown host key is refused and shown, and the person trusts it explicitly before setup continues ("Trust this key"; it can be forgotten later).
- **Create** saves the server and opens the setup dialog, which starts setup at once.

**Edit**: the same fields ("Edit server", "Update"). Changing the SSH user tells the person to run setup again (files are owned by the setup user).

## 9.3 Setup

Dialog "Server setup": "Nearzero installs Docker, the router, build tools and monitoring." Header: name, `user@address:port`, a state badge (not started, running, ready, failed). Then the server's DNS card (9.5), a state line, and "Setup logs · live".

- A run that started less than 5 minutes ago: "Setup is already running…" with its log. An older unfinished run: "Previous setup looks stalled. Retrying…". On a ready server the dialog opens the details instead.

**What setup does** (each step numbered and titled in the log):
1. Clean up leftovers from an earlier run.
2. Install basic tools (curl, wget, git, jq, openssl).
3. Check ports 80 and 443 are free or already held by Nearzero's router; otherwise stop and name the process holding them.
4. Install rclone (pinned, checksum-verified).
5. Install Docker from the distribution's signed repository and the Compose plugin; a Snap-installed Docker is refused.
6. Prepare the container runtime and Nearzero's private network (never replacing an existing different network of the same name). Under decision D1, this step also installs and registers the runner.
7. Add swap if there is none and disk allows: twice the RAM, at least 2 GB, at most 8 GB.
8. Create Nearzero's folders.
9. Start the router with HTTPS and its middlewares, configured only through route files the runner writes (the router gets no access to the container runtime). If the new router fails, the previous one is restored. The router drops all Linux capabilities and runs as the owner of its files: root on servers set up as root, the SSH user otherwise.
10. Open web ports 80/tcp, 443/tcp and 443/udp in the host firewall if one is active (ufw, firewalld or iptables), and remind the person to open their cloud firewall.
11. Install the builders (Nixpacks, buildpacks, Railpack) at the same pinned versions as the Nearzero host.
12. Set up monitoring, kept private (never opened in the firewall).
13. Add a non-root SSH user to the Docker group.
14. Harden SSH (31c G3-02): a managed block at the top of the SSH settings, so it wins over later lines and included files, with key-only sign-in (`PasswordAuthentication no`, keyboard-interactive and challenge-response off, `PubkeyAuthentication yes`, `AuthenticationMethods publickey`), root only with a key (never loosening a stricter setting), `MaxAuthTries 3`, `LoginGraceTime 30`, agent forwarding off, X11 forwarding off, TCP forwarding local only, `GatewayPorts no`, `PermitTunnel no` and `PermitUserEnvironment no`. The new configuration must pass `sshd -t`. Then the settings that actually apply to the setup user are read (`sshd -T -C user=<user>,…`): when a later Match block turns passwords or keyboard sign-in back on for that user, nothing is changed and the step fails: "SSH would still let <user> sign in without a key: a later part of the SSH configuration (often a Match block) sets <settings> for <user>. The old configuration was kept. Remove that setting, then run setup again." A new sign-in with the key is checked after the reload, and the old configuration is put back when it fails; reload works with or without an init system.
15. Configure monitoring (a non-fatal step: "Monitoring setup skipped: …").
- The run ends with "Setup Server: ✅" and a validation (9.4). Missing mandatory checks fail the setup: "Server setup did not complete. Missing: …".
- Re-running setup keeps running workloads and the router's routes.

**Supported systems**: Debian and Ubuntu (and derivatives), Raspberry Pi OS, CentOS, Fedora, RHEL, Oracle, Rocky, Alma, SUSE, Arch, Amazon Linux and Alpine. On Alpine, bash is installed first and the scripts run under it; scripts avoid GNU-only options. Anything else: "This script only supports Debian, Red Hat, Arch Linux, Alpine Linux, or SUSE based operating systems for now."

**Failure messages**
- Wrong user (a cloud image that refuses root): `This server does not allow logging in as "root". It asks for the user "ubuntu": change the server's SSH user to "ubuntu" and run setup again.` with a button **Use ubuntu and run setup again**.
- No passwordless sudo: `The user "X" needs passwordless sudo for setup. On the server, run: echo 'X ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/X, then run setup again.`
- Key rejected: "Couldn't connect to your server — the SSH key was not accepted." with hints.
- Unreachable: "Couldn't connect to your server…" (address or port wrong, firewall, offline).
- Anything else: "Setup stopped at step N (<title>): <reason>. Cause: … (exit code X)".
- The server is kept after a failure; "Run setup again" is offered. Log lines are cleaned of secrets before display.

**Success**: toast "Server setup completed". A run the dialog followed that fails shows the toast "Setup failed" (31c G3-08). If the server's DNS record (9.5) isn't in place, the dialog stays open: "Server setup completed. Add the DNS record above so apps here get their own address."

**Acceptance**: on a cloud image that refuses root, adding the server as root fails with the user hint; the button switches to the default user, setup completes, the router runs as that user, and a route written by that user loads.

## 9.4 Server details, validation and audit

**View** shows: address, port, user, SSH key, host key fingerprint, setup finished time, description, the DNS card, and:
- **Setup validation**: each check as ready, not ready or a version. Mandatory checks: Docker, Nearzero's folders, the builders, rclone, the container runtime mode, passwordless sudo, Docker group membership (non-root users), the private network, the router (and the runner under D1). The verdict is one of: "All mandatory checks passed and the server is ready for deployments.", "Nearzero reports this server as X (Y). Finish setup before deploying.", "Mandatory checks still missing: …", "Nearzero could not confirm every mandatory server check."
- **Security audit** (new in the console; today Agent only): firewall state, SSH configuration (password sign-in, root sign-in), and intrusion-ban service status, each with a plain recommendation. Read-only.
- **Daily Docker cleanup** switch (new; today on for the host and off for others with no switch): removes unused images and build cache at 23:50 server time. On by default for the host, off for other servers. Sends the "Docker cleanup" notification.
- **Monitoring** settings for this server ([14-monitoring.md](14-monitoring.md)).

## 9.5 The server's DNS card

Shown in the setup and details dialogs for every server except the Nearzero host, when the install has a platform domain (see [10](10-domains-and-certificates.md) 10.2).
- Title: "Add one DNS record in <provider>" (or "at your DNS provider"), with "It gives every app on <server> its own address under <server's domain>, with HTTPS set up automatically." The setup dialog adds "Add it now, while setup runs."; the details never show it (31c G3-07).
- Once the record points here, the card collapses to "App addresses are ready" and "Apps on <server> get their own address under <server's domain>, with HTTPS set up automatically.", with no table or steps.
- Table: Type A, Name (relative to the DNS zone, for example `*.prod-1.apps`), Value (the server's public IPv4), Proxy "DNS only", each with Copy. Under it: "In the domain <zone>. The full name is …".
- The provider is detected from the domain's nameservers, with steps for that provider (Cloudflare: "Turn Proxy status off (grey cloud, DNS only)…", and similar for Route 53, GoDaddy, Namecheap, DigitalOcean, Google Cloud DNS, Vercel, Porkbun, Azure). Other recognized providers (Hetzner, OVH, Gandi, Linode, Vultr, IONOS, NameSilo, DNSimple, NS1, Hostinger) get general steps naming the provider.
- Badge: Points here, Points elsewhere, Not added yet, Couldn't check; "App addresses are ready" when ready. "Check again" with "DNS changes usually show up within a few minutes." It ends with one of two toasts: "The record points here. Apps on this server get their own address." or "It doesn't point at this server yet. DNS changes can take a few minutes." (31c G3-07).
- Copying works on plain HTTP; refreshing the card never closes the dialog.

## 9.6 Deleting a server

Dialog "Delete server — This server will be removed from your workspace."
- No services: "This will delete the server and all associated data."
- With services: "This server has N attached services. Deleting it also permanently deletes every attached service and its Docker resources." ("1 attached service" for one, 31c G3-08) plus "This cannot be undone. Back up anything important first." and a checkbox "Also delete all attached services on this server". The button "Delete services and server" stays disabled until ticked. Services are torn down like a project delete, with per-service results.
- The API refuses without that choice: "Server has active services, please delete them first". The Agent always refuses a server with services.
- Success: "Server deleted" once the removal finishes (services first, then the runner and its credential on the server). Docker, the router container and other data stay on the server; running the uninstaller there removes them.

## 9.7 SSH keys

**Tab** "SSH keys": Name, Description, Created, and a menu (Edit, Delete). Empty: "No SSH keys yet / Add an SSH key to connect servers for remote deployments."

**Add** ("Add one of your keys or generate a new one."):
- "Generate RSA key" or "Generate ED25519 key" fill both fields (toast "SSH key generated"); generation happens on the server, never with browser crypto.
- Fields: Name (required), Description, Private key, Public key.
- "Download private key" / "Download public key" save files named after the key.
- The public key must be one `ssh-rsa` or `ssh-ed25519` line ("Invalid public key format"); the private key an OpenSSH or RSA PEM block ("Invalid private key format"). Errors show inline in plain words.

**Edit**: name and description only. The private key shows "Stored private keys cannot be displayed". The public key is shown read-only with Copy and "Download public key" (`<name>.pub`). People who may only use keys get **View** instead of Edit and Delete: the same read-only key, public half, Copy and download, with no Save (31c R3-03).

**Delete**
- Refused while a server uses the key: `This SSH key is attached to server: X. Remove that server first.` (the menu item is disabled with that tooltip).
- If apps or Compose services use it as their Git SSH key, the dialog lists them and says they will stop deploying from Git until another key is chosen (today they are silently unlinked).
- Otherwise: "Delete this SSH key?"

**Where keys are used**: server sign-in, and Git URL sources over SSH. Private keys never leave the platform and are never shown again.

## 9.8 Permissions

| Action | Needs |
| --- | --- |
| See servers | Server access; members only their granted servers |
| Add, edit, set up, delete servers | "Add and remove servers" (owners and admins by default) |
| Terminal on a server | Manage rights on that server |
| Use the Nearzero host | Instance administrator, or a workspace an instance administrator allows |
| See SSH keys / use them in forms | "Use the workspace's SSH keys"; "Add and remove servers" also covers choosing a saved key in the server forms (31c G3-06) |
| Add, edit, delete SSH keys | "Add and remove SSH keys" |
