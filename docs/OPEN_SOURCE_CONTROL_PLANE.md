# Nearzero open-source control plane

Nearzero ships the control plane as open source: workspace RBAC, managed DNS, Traefik routing, preview deployments, and Agent safety policies are available without a commercial DNS provider.

## Core (OSS)

- **Workspace agent policy** — `organization_settings.allowAgentProductionActions` defaults to `false`. Admins enable production Agent mutations in Settings → Agent.
- **Managed DNS** — Authoritative zones stored in Postgres, rendered to BIND zone files, and served by the Compose-owned `nearzero-dns` CoreDNS container on both TCP and UDP port 53. The platform writes through `/etc/nearzero/dns`; CoreDNS reads the same persistent `nearzero-dns` volume at `/etc/coredns`.
- **Managed service domains** — Route domains in Traefik stay synchronized with DNS A records; managed domains default to HTTPS + Let's Encrypt.
- **Environment DNS defaults** — Optional `dnsZoneId` and `domainPrefix` per environment for predictable hostnames (bind under Project → Domains).
- **Auto service domains** — Three modes share one server API (`previewServiceDomain` / `provisionServiceDomain` / `ensureDefaultServiceDomain`):
  - **Mode A (org zone):** environment has `dnsZoneId` → hostname `{service}.{env}.{zone}` (or prefix/production rules); CoreDNS A records via `createDomain`.
  - **Mode B (platform apex):** set `NEARZERO_PLATFORM_DOMAIN` → `{service}.{env}.{project}.{apex}`; no authoritative writes. This requires an external wildcard record and a shared edge capable of routing every hostname. Remote servers use this mode only when `NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE=true`; otherwise Nearzero refuses to present the platform apex as working per-server DNS and uses a temporary fallback until an environment is bound to a managed zone.
  - **Mode C (BYOD):** manual host in Add Domain; edge IP from `resolveDomainTargetIp` for validation hints.
- **Deploy hook** — `deployApplication` / `deployCompose` call `ensureDefaultServiceDomain` when a service has no domains yet.
- **PR previews** — Existing GitHub preview flow; when an environment has a managed zone, previews use managed DNS and SSL annotations in PR comments.

## Self-hosted setup

1. Run the installer with managed DNS enabled (the default). It activates the `managed-dns` Compose profile, initializes the persistent Corefile, and publishes CoreDNS on `${NEARZERO_DNS_BIND_ADDRESS:-0.0.0.0}:${NEARZERO_DNS_PORT:-53}` over TCP and UDP. Set `NEARZERO_ENABLE_MANAGED_DNS=false` only when another authoritative DNS provider will be used or port 53 cannot be dedicated to Nearzero.
2. Allow inbound TCP/UDP 53 to the **control-plane host only**. Remote application servers do not run authoritative DNS and should not expose port 53 for Nearzero. Public resolvers always contact destination port 53; a different `NEARZERO_DNS_PORT` only works when an upstream firewall/NAT forwards public port 53 to it.
3. Create a zone under **Settings → DNS**. For production, delegate the zone or a dedicated subzone at the parent DNS provider. If nameservers such as `ns1.example.com` are inside the delegated zone, configure registrar glue/host records pointing to the control-plane public IP.
4. Publish the zone, then verify delegation and authoritative answers from outside the host before relying on it.
5. Bind that zone to each environment under **Project → Domains**. Nearzero then creates a distinct A record for every app or service, targeting the IP of its selected local or remote server.
6. Configure each server with its correct, stable public IPv4 address. On every remote app server, allow inbound TCP 80 for Traefik's ACME HTTP-01 challenge and redirects, and TCP 443 for HTTPS. UDP 443 is optional and serves HTTP/3; it is not used for certificate validation. Before requesting a certificate, the hostname's A record must resolve publicly to that same server. If the zone uses CAA records, permit Let's Encrypt with an `issue` value for `letsencrypt.org`.
7. Enable Agent production actions only if your team intentionally wants Agent mutations in production.

### Network and host-security boundaries

| Host role | Required inbound traffic | Traffic that must remain private |
| --- | --- | --- |
| Control plane with managed DNS | TCP/UDP 53 from public resolvers; an operator-provided HTTPS management endpoint if used; SSH only from administrative source ranges | Ports 3000 and 4321 must sit behind an HTTPS reverse proxy, VPN, or management firewall rather than being exposed as public plaintext HTTP |
| Remote application server | TCP 80, TCP 443, optional UDP 443; SSH only from the control plane and administrative source ranges | Docker API/proxy ports 2375 and 2376, Traefik dashboard port 8080, monitoring port 4500, and application ports that were not intentionally configured as published ports |
| Multi-node Swarm peer network only | TCP 2377, TCP/UDP 7946, and UDP 4789 between the exact trusted node addresses | Never permit these Swarm ports at the public perimeter; VXLAN on UDP 4789 is unauthenticated unless the overlay is explicitly encrypted |

Nearzero's remote-server setup opens the web ports in an already-active UFW or firewalld policy. Its raw `iptables` fallback is not guaranteed to survive a reboot, and no host-side rule can change a cloud security group, provider firewall, router, or NAT. Verify the effective policy externally after setup and after every reboot. A single-node server does not need public Swarm ports even though Nearzero initializes it as a one-node manager.

The curl installer publishes control-plane ports 3000 and 4321 but does not terminate TLS for them. Do not send login credentials over those public HTTP listeners. Bind or firewall them to a management network, or put an authenticated HTTPS reverse proxy in front before allowing Internet access.

The generated remote Traefik configuration uses a private internal network and a Docker socket proxy whose HTTP policy denies POST/write operations; neither the proxy nor the dashboard is published. A `:ro` bind on a Unix socket does **not** itself make the Docker API read-only, so compromise of the socket-proxy process remains host-root-equivalent. A compromised Traefik process can query the proxy's allowed discovery endpoints, which can reveal container and service metadata including environment-variable names and values. Treat both components as trusted host infrastructure, never attach application workloads to `nearzero-traefik-control`, and never publish that proxy network or port. The SSH account used by setup receives passwordless privilege and Docker access; both are root-equivalent, so use a dedicated account and protect/rotate its key.

The control-plane `platform` container intentionally has the host Docker socket because it manages local Docker resources. That socket is also root-equivalent. Run the control plane on a dedicated host, restrict dashboard access, and do not colocate unrelated or untrusted containers there. The installer protects `/opt/nearzero/.env` with mode `0600`, but Docker inspection and backups remain privileged data paths.

Remote SSH host keys use trust on first use by default. The first key is written only after SSH authentication succeeds; later key changes are rejected. Verify the first recorded fingerprint through an independent provider console or another trusted channel. For pre-provisioned trust, set `NEARZERO_SSH_STRICT_HOST_KEY_CHECKING=true` and seed `/etc/nearzero/ssh/remote-host-keys.json` (or `NEARZERO_SSH_HOST_KEYS_PATH`) before the first connection. The JSON key is the lowercase `host:port`, and its `fingerprint` is the OpenSSH `SHA256:...` host-key fingerprint. Protect the store as mode `0600`; strict mode deliberately rejects an unseeded server.

Application environment variables require a separate trust decision. Framework prefixes such as `NEXT_PUBLIC_`, `PUBLIC_`, and `VITE_` deliberately make values available to browser code; a credential must never use one of those names. Docker build arguments are also not a secret channel. Keep private values server-only, use the dedicated build-secret field when a Dockerfile needs a credential during a build, and assume a host administrator with Docker access can inspect runtime container environment values.

Nearzero-generated build phases keep configured values out of phase-script text, SSH command strings, and ordinary command arguments. The deployment runner sends an encoded envelope over standard input, materializes it only in a retry-scoped mode-`0700` directory with mode-`0600` value files, and removes that directory on exit. Managed Dockerfile, Nixpacks, and Railpack builds use BuildKit secret mounts where supported; generated plans are checked for literal configured values, protected credential paths are excluded from managed build contexts, and durable build output is redacted before it is stored. Pack builders receive their build environment through a private file rather than the process argument list.

This transport boundary cannot make untrusted build code safe. An application Dockerfile, dependency lifecycle hook, buildpack, install command, or build command that receives a value can deliberately print, transmit, or bake it into an image or browser bundle; redaction is defense in depth, not a sandbox. Give build secrets only to repositories and build dependencies you trust, keep public build arguments non-sensitive, and rotate a credential after any suspicious build. The Nixpacks/Railpack/Pack binaries in the production image are checksum-verified, but application `FROM` images and the default managed builder/frontend images may still resolve through mutable tags. Production operators can set `NEARZERO_HEROKU_BUILDER_IMAGE`, `NEARZERO_PAKETO_BUILDER_IMAGE`, `NEARZERO_RAILPACK_FRONTEND_IMAGE`, and `NEARZERO_STATIC_NGINX_IMAGE` to complete OCI references pinned by SHA-256 digest; Nearzero rejects mutable values in those overrides. Pin user-authored Dockerfile base images separately.

API redaction is not encryption at rest. Git-provider tokens, SSH private keys, notification credentials, application environment values, and backup destinations remain privileged database material unless the deployment adds storage/KMS encryption. Restrict Postgres and backup access, encrypt host volumes and off-host backups, rotate credentials after suspected database exposure, and do not treat the browser's write-only/readiness flags as protection from a database administrator.

Compose runtime environment files are kept outside source checkouts under `/etc/nearzero/secrets/compose-env`, written with mode `0600`, and promoted only after a deployment succeeds so rollback can retain the last working values. This prevents accidental Git inclusion and ordinary process-list exposure; it is not tenant isolation. A person allowed to deploy arbitrary Compose on a Docker host can request bind mounts, privileged containers, or the Docker socket and is therefore effectively a host administrator. Put only mutually trusted deployers on one Nearzero server, restrict Compose deployment permissions accordingly, and never treat file modes as protection from host root or a Docker manager.

Host monitoring is loopback-only and does not receive the Docker socket or the host's `/proc` tree. Container metrics are disabled by default. Setting `NEARZERO_ALLOW_MONITORING_DOCKER_METADATA=true` permits dynamically managed collectors with a non-empty service include list to join the internal read-only Docker proxy. Docker's `CONTAINERS` API can expose inspect metadata, including container environment variables, so enable this only when that disclosure is explicitly accepted.

For a multi-server installation, Mode A (an environment-bound managed zone) is the supported direct-routing design:

```text
resolver -> control-plane CoreDNS:53 -> app.example.com A 203.0.113.20
                                      -> api.example.com A 203.0.113.21
client   -> selected remote IP:443   -> that server's Traefik -> service
```

The control-plane host is a single authoritative DNS failure domain. The default `ns1` and `ns2` names can point to that same host and therefore do not provide redundancy. A production installation should provide a genuinely independent second authoritative server or secondary-DNS service and arrange restricted zone replication outside Nearzero before delegating a critical apex. Nearzero does not enable public AXFR in its generated Corefile. Delegating a dedicated application subzone limits the impact on existing mail and other apex records.

The generated Corefile is authoritative-only: it has no recursive `forward` plugin, runs with a read-only root filesystem, and receives only `NET_BIND_SERVICE`. Apply host/network DNS rate limits appropriate to expected traffic. Generated zones are not DNSSEC-signed; remove any stale parent DS record before delegation or operate an external signing/secondary-DNS pipeline. Pin `NEARZERO_IMAGE`, `NEARZERO_MONITORING_IMAGE`, `NEARZERO_SCHEDULE_IMAGE`, `NEARZERO_DNS_IMAGE`, `TRAEFIK_IMAGE`, `TRAEFIK_SOCKET_PROXY_IMAGE`, and the database/cache images to verified registry digests when promoting a production release.

A release is installable only after the matching `nearzero`, `monitoring`, and `schedule` multi-architecture image tags have all been published. The release workflow now treats that three-image build as a prerequisite and rejects an installer whose defaults do not match the release version. Do not publish or recommend an older installer until any missing companion tags have been backfilled.

`NEARZERO_PLATFORM_DOMAIN` is only Mode B. It is persisted by the installer across reruns, but setting it does not create a CoreDNS zone, wildcard record, or cross-server edge router. Use a managed zone binding for direct remote-server assignment. Set `NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE=true` only if an independently configured shared edge really can forward each generated hostname to the correct server.

On upgrade, apply the database migrations through `0186_domain_system_assignment` before changing environment DNS bindings. Migration 0184 intentionally aborts when normalized duplicate zones, hostnames, or managed address owners exist; resolve the rows it reports before retrying. Migration 0186 records whether Nearzero generated a hostname, allowing environment zone/prefix changes to reconcile system-assigned DNS and routes without overwriting operator-chosen domains. It conservatively backfills only unambiguous legacy platform and `sslip.io` assignments.

`dns-init` copies any existing `*.zone` files from the older `nearzero-data:/etc/nearzero/dns/zones` layout into the dedicated DNS volume without overwriting newer files. Postgres remains the source of truth; republish each active zone after upgrading to reconcile its serial and contents.

### Git provider OAuth boundary

Git provider credentials are write-only at the API boundary. Provider responses expose explicit `has*` readiness flags instead of client secrets, private keys, passwords, or access/refresh tokens. Reads and external repository actions are restricted to providers accessible in the active organization; updates require the provider owner or an organization owner/admin.

GitLab and Gitea base URLs are parsed as HTTP(S) base URLs and cannot contain embedded credentials, query strings, or fragments. Members may configure the standard `https://gitlab.com` and `https://gitea.com` origins. A self-hosted origin or any separate internal URL can direct server-side traffic into a private network, so only an organization owner/admin may configure it.

BYO GitHub, GitLab, and Gitea authorization starts through an authenticated API mutation. Nearzero stores only a SHA-256 hash of a 256-bit random state token in `git_provider_oauth_state`, with the initiating organization/user, provider type, optional target Git provider, and a ten-minute expiry. Callbacks consume the matching unexpired row with one conditional `UPDATE ... RETURNING`, so replay fails atomically. Migration `0185_git_provider_oauth_state_target.sql` adds the nullable target-provider foreign key and its cleanup index; deleting the provider cascades any outstanding target-bound states. Raw organization, user, or provider IDs are never accepted as OAuth state.

## Commercial / hosted path

Hosted Nearzero can operate the same control plane with managed reliability: anycast DNS, automated health checks, multi-region nodes, support, and billing. The OSS codebase does not require Cloudflare, Route53, or other paid DNS APIs for core functionality.
