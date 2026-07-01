# Nearzero open-source control plane

Nearzero ships the control plane as open source: workspace RBAC, managed DNS, Traefik routing, preview deployments, and Agent safety policies are available without a commercial DNS provider.

## Core (OSS)

- **Workspace agent policy** — `organization_settings.allowAgentProductionActions` defaults to `false`. Admins enable production Agent mutations in Settings → Agent.
- **Managed DNS** — Authoritative zones stored in Postgres, rendered to BIND zone files, served by the `nearzero-dns` CoreDNS container on port 53.
- **Managed service domains** — Route domains in Traefik stay synchronized with DNS A records; managed domains default to HTTPS + Let's Encrypt.
- **Environment DNS defaults** — Optional `dnsZoneId` and `domainPrefix` per environment for predictable hostnames (bind under Project → Domains).
- **Auto service domains** — Three modes share one server API (`previewServiceDomain` / `provisionServiceDomain` / `ensureDefaultServiceDomain`):
  - **Mode A (org zone):** environment has `dnsZoneId` → hostname `{service}.{env}.{zone}` (or prefix/production rules); CoreDNS A records via `createDomain`.
  - **Mode B (platform apex):** set `NEARZERO_PLATFORM_DOMAIN` → `{service}.{env}.{project}.{apex}`; no authoritative writes (wildcard at infra).
  - **Mode C (BYOD):** manual host in Add Domain; edge IP from `resolveDomainTargetIp` for validation hints.
- **Deploy hook** — `deployApplication` / `deployCompose` call `ensureDefaultServiceDomain` when a service has no domains yet.
- **PR previews** — Existing GitHub preview flow; when an environment has a managed zone, previews use managed DNS and SSL annotations in PR comments.

## Self-hosted setup

1. Run database migrations (`0170_organization_settings`, `0171_managed_dns`).
2. Create a DNS zone under **Settings → DNS** and delegate nameservers at your registrar.
3. Publish zones after record changes.
4. Bind a DNS zone per environment under **Project → Domains** (or set `NEARZERO_PLATFORM_DOMAIN` for wildcard platform URLs).
5. Configure **Settings → Web Server → Server IP** (self-hosted) or each remote server’s IP so managed A records and Traefik agree.
6. Enable Agent production actions only if your team intentionally wants Agent mutations in production.

## Commercial / hosted path

Hosted Nearzero can operate the same control plane with managed reliability: anycast DNS, automated health checks, multi-region nodes, support, and billing. The OSS codebase does not require Cloudflare, Route53, or other paid DNS APIs for core functionality.
