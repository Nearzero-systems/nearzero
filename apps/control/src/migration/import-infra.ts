import {
  AppError,
  BACKUP_PROVIDERS,
  type BackupProvider,
  type ChannelType,
  checkChannel,
  checkHostnameInput,
  checkZoneName,
  DNS_RECORD_TYPES,
  type NotificationEvent,
} from "@nearzero/shared";
import { sql } from "kysely";
import { hostAddress } from "../domains/addresses.ts";
import { checkKeyMatches, keyContext, parseCertificate } from "../domains/certificates.ts";
import { sealContext as gitProviderContext } from "../git-providers/records.ts";
import { chooseLabel } from "../servers/servers.ts";
import { checkKeyPair } from "../ssh-keys/format.ts";
import { routerStoreFrom } from "./acme.ts";
import { type ImportRun, NotImported } from "./importer.ts";
import { threshold } from "./install.ts";
import { CHANNEL_FIELDS, channelKindNamed, eventNamed, gitProviderKindNamed } from "./labels.ts";
import { legacyWorkloads } from "./legacy-fields.ts";
import type { BundlePlace, BundleRecord } from "./records.ts";

/**
 * SSH keys, servers, Git providers, DNS zones, uploaded certificates, each server's certificate
 * authority state, backup destinations and notification channels (spec 29.4). Every secret is
 * sealed with this install's key, bound to the row it belongs to, as it is written.
 */

const LABEL_PATTERN = /^[a-z]([a-z0-9-]*[a-z0-9])?$/;
const SSH_USER_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;

export function sshKeyContext(workspaceId: string, keyId: string): string {
  return `workspace:${workspaceId}:ssh-key:${keyId}`;
}

export function destinationContext(workspaceId: string, destinationId: string): string {
  return `workspace:${workspaceId}:backup-destination:${destinationId}`;
}

export function channelContext(channelId: string): string {
  return `notification-channel:${channelId}`;
}

export function acmeContext(target: string): string {
  return `migration-acme:${target}`;
}

function workspaceOf(run: ImportRun, ref: string, label: string): string {
  const id = run.id("workspaces", ref);
  if (!id) throw new NotImported(label, "its workspace wasn't imported.");
  return id;
}

/** "host", or the 1.0 id of a server ref; undefined when the server wasn't imported. */
export function targetOf(run: ImportRun, ref: string | null | undefined): string | undefined {
  if (!ref || ref === "host") return "host";
  return run.id("servers", ref);
}

/** Where a place (29a.5.1) runs on 1.0: "host" or a server id; undefined for an unknown server. */
export function placeTarget(run: ImportRun, place: BundlePlace): string | undefined {
  if (!place || place.host || !place.serverRef) return "host";
  return run.id("servers", place.serverRef);
}

function problemOf(error: unknown): string | null {
  return error instanceof AppError ? error.message : null;
}

async function uniqueName(
  candidates: (name: string) => Promise<boolean>,
  name: string,
  max: number,
): Promise<string> {
  if (!(await candidates(name))) return name;
  for (let n = 2; n < 1000; n++) {
    const next = `${name.slice(0, max - 4)} (${n})`;
    if (!(await candidates(next))) return next;
  }
  return `${name.slice(0, max - 9)} ${crypto.randomUUID().slice(0, 8)}`;
}

// ---- SSH keys and servers

async function importSshKey(run: ImportRun, record: BundleRecord<"sshKeys">): Promise<string> {
  const label = `SSH key ${record.name}`;
  const workspaceId = workspaceOf(run, record.workspaceRef, label);
  let info: ReturnType<typeof checkKeyPair>;
  try {
    info = checkKeyPair(record.publicKey, record.privateKey);
  } catch (error) {
    throw new NotImported(label, problemOf(error) ?? "its key pair can't be read.");
  }
  const id = crypto.randomUUID();
  await run.db
    .insertInto("ssh_key")
    .values({
      id,
      workspace_id: workspaceId,
      name: record.name.trim().slice(0, 100),
      description: (record.description ?? "").slice(0, 1000),
      key_type: info.type,
      public_key: info.line,
      fingerprint: info.fingerprint,
      private_key_sealed: run.services.secrets.seal(
        `${record.privateKey.trim()}\n`,
        sshKeyContext(workspaceId, id),
      ),
    })
    .execute();
  return id;
}

async function importServer(run: ImportRun, record: BundleRecord<"servers">): Promise<string> {
  const label = `Server ${record.name}`;
  const workspaceId = workspaceOf(run, record.workspaceRef, label);
  const keyId = run.id("sshKeys", record.sshKeyRef);
  if (!keyId) {
    throw new NotImported(
      label,
      record.sshKeyRef
        ? "its SSH key wasn't imported, so it can't be reached."
        : "it has no SSH key, and 1.0 reaches servers with one. Add it again under Servers.",
    );
  }
  const port = record.port ?? 22;
  const sshUser = record.sshUser || "root";
  if (/[\s/]/.test(record.address)) throw new NotImported(label, "its address isn't valid.");
  if (!SSH_USER_PATTERN.test(sshUser)) throw new NotImported(label, "its SSH user isn't valid.");
  const sameAddress = await run.db
    .selectFrom("server")
    .select("name")
    .where("workspace_id", "=", workspaceId)
    .where(sql<string>`lower(address)`, "=", record.address.toLowerCase())
    .where("port", "=", port)
    .executeTakeFirst();
  if (sameAddress) {
    throw new NotImported(label, `${sameAddress.name} already uses this address.`);
  }
  const name = await uniqueName(
    async (candidate) =>
      (await run.db
        .selectFrom("server")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where(sql<string>`lower(name)`, "=", candidate.toLowerCase())
        .executeTakeFirst()) !== undefined,
    record.name.trim().slice(0, 100),
    100,
  );
  if (name !== record.name.trim()) {
    run.collision(
      "servers",
      record.name,
      `${label}: the name is taken in this workspace, so it is ${name}.`,
    );
  }
  // The label its hostnames live under is kept exactly, so they keep resolving (spec 29.5).
  const given = (record.hostnameLabel ?? "").toLowerCase();
  let serverLabel = given;
  const unusable =
    given === "" ||
    !LABEL_PATTERN.test(given) ||
    given.length > 40 ||
    (await run.db
      .selectFrom("server")
      .select("id")
      .where("label", "=", given)
      .executeTakeFirst()) !== undefined;
  if (unusable) {
    serverLabel = await chooseLabel(run.db, name);
    if (given) {
      run.collision(
        "servers",
        name,
        `${label}: its hostname label ${given} can't be used here, so its new hostnames use ${serverLabel}. Hostnames under ${given} still need their DNS records.`,
      );
    }
  }
  const id = crypto.randomUUID();
  await run.db
    .insertInto("server")
    .values({
      id,
      workspace_id: workspaceId,
      name,
      description: (record.description ?? "").slice(0, 1000),
      address: record.address,
      port,
      ssh_user: sshUser,
      ssh_key_id: keyId,
      label: serverLabel,
      host_key_fingerprint: record.hostKeyFingerprint ?? null,
      docker_cleanup: record.dailyCleanup === true,
    })
    .execute();
  // 0 means off (29a.5.7).
  const cpu = threshold(record.alertThresholds?.cpuPercent);
  const memory = threshold(record.alertThresholds?.memoryPercent);
  if (cpu !== null || memory !== null) {
    await run.db
      .insertInto("server_alert_setting")
      .values({ target: id, cpu_threshold: cpu, memory_threshold: memory })
      .execute();
  }
  const legacy = legacyWorkloads(record.legacy);
  if (legacy.length > 0) run.serverLegacy.set(id, legacy);
  return id;
}

// ---- Git providers

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ""),
  );
}

async function importGitProvider(
  run: ImportRun,
  record: BundleRecord<"gitProviders">,
): Promise<string> {
  const label = `Git provider ${record.name}`;
  const workspaceId = workspaceOf(run, record.workspaceRef, label);
  const kind = gitProviderKindNamed(record.kind);
  if (!kind) throw new NotImported(label, `${record.kind} isn't a Git host 1.0 connects to.`);
  const urls = record.urls ?? {};
  const tokens = record.tokens ?? {};
  let settings: Record<string, unknown>;
  let secrets: Record<string, unknown>;
  let appId: number | null = null;
  let ready: boolean;
  if (kind === "github") {
    const app = record.app;
    appId =
      app?.appId !== undefined && app?.appId !== null && /^\d+$/.test(String(app.appId))
        ? Number(app.appId)
        : null;
    if (!app || appId === null || !app.privateKey) {
      throw new NotImported(
        label,
        record.connection === "Shared app"
          ? "it used the install's shared GitHub App, which 1.0 doesn't have. Connect GitHub again under Git."
          : "its GitHub App's id or private key is missing. Connect GitHub again under Git.",
      );
    }
    settings = defined({
      appId,
      slug: app.appName,
      htmlUrl: urls.web,
      clientId: app.clientId,
      ownerLogin: record.account?.username ?? "",
      ownerType: "User",
      organization: "",
    });
    secrets = defined({
      privateKey: app.privateKey,
      webhookSecret: app.webhookSecret,
      clientSecret: app.clientSecret,
    });
    ready = true;
  } else if (kind === "bitbucket") {
    settings = defined({
      username: record.account?.username,
      email: record.account?.email,
      workspace: record.account?.workspace,
      auth: tokens.apiToken ? "api_token" : "app_password",
    });
    secrets = defined({ apiToken: tokens.apiToken, appPassword: tokens.appPassword });
    ready = Boolean(tokens.apiToken || tokens.appPassword);
  } else {
    const oauth = record.oauth;
    settings = {
      url: urls.web ?? "",
      internalUrl: urls.internal ?? "",
      clientId: oauth?.clientId ?? "",
      filter: record.account?.group ?? "",
      auth: oauth?.clientId ? "oauth" : "token",
      // Its OAuth application was registered with 0.1.x's redirect address (R3-41, R4-15):
      // the one the bundle names, or 0.1.x's own path on this console.
      ...(oauth?.clientId
        ? {
            legacyCallback: true,
            ...(movedRedirectUri(urls.redirect)
              ? { redirectUri: movedRedirectUri(urls.redirect) }
              : {}),
          }
        : {}),
    };
    const expires = tokens.expiresAt ? Date.parse(tokens.expiresAt) : Number.NaN;
    secrets = defined({
      clientSecret: oauth?.clientSecret,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Number.isNaN(expires) ? undefined : expires,
    });
    ready = Boolean(tokens.accessToken);
  }
  const installations = (record.installationIds ?? [])
    .map(String)
    .filter((item) => /^\d+$/.test(item));
  if (installations.length > 1) {
    run.changed(
      "gitProviders",
      record.name,
      `${label}: 1.0 keeps one installation per GitHub App, so the first was kept; install the app on the other accounts again.`,
    );
  }
  const sameApp =
    appId !== null
      ? await run.db
          .selectFrom("git_provider")
          .select("name")
          .where("github_app_id", "=", String(appId))
          .executeTakeFirst()
      : undefined;
  const sameInstallation = installations[0]
    ? await run.db
        .selectFrom("git_provider")
        .select("name")
        .where("installation_id", "=", installations[0])
        .executeTakeFirst()
    : undefined;
  const other = sameApp ?? sameInstallation;
  if (other) throw new NotImported(label, `it is connected here already as ${other.name}.`);
  const id = crypto.randomUUID();
  await run.db
    .insertInto("git_provider")
    .values({
      id,
      workspace_id: workspaceId,
      owner_person_id: run.id("people", record.ownerRef) ?? null,
      kind,
      name: record.name.trim().slice(0, 100),
      shared: record.shared === true,
      status: ready ? "ready" : "pending",
      settings: JSON.stringify(settings),
      secrets_sealed:
        Object.keys(secrets).length > 0
          ? run.services.secrets.seal(JSON.stringify(secrets), gitProviderContext(id))
          : null,
      github_app_id: appId,
      installation_id: installations[0] ?? null,
      account_login: record.account?.username ?? null,
      connected_at: ready ? new Date() : null,
    })
    .execute();
  if (!ready) {
    run.changed(
      "gitProviders",
      record.name,
      `${label}: its credentials are incomplete, so it waits to be connected again under Git.`,
    );
  }
  return id;
}

// ---- DNS zones

async function zoneNameserverRecords(
  run: ImportRun,
  zoneId: string,
  zone: string,
  nameservers: string[],
): Promise<void> {
  const rows: {
    zone_id: string;
    name: string;
    type: "NS" | "A";
    value: string;
    ttl: number;
    managed: boolean;
  }[] = nameservers.map((ns) => ({
    zone_id: zoneId,
    name: "@",
    type: "NS",
    value: ns,
    ttl: 3600,
    managed: true,
  }));
  const inside = nameservers.filter((ns) => ns.endsWith(`.${zone}`));
  if (inside.length > 0) {
    const ip = await hostAddress(run.services);
    if (ip) {
      for (const ns of inside) {
        rows.push({
          zone_id: zoneId,
          name: ns.slice(0, -(zone.length + 1)),
          type: "A",
          value: ip,
          ttl: 3600,
          managed: true,
        });
      }
    }
  }
  if (rows.length > 0) await run.db.insertInto("dns_record").values(rows).execute();
}

async function importZone(run: ImportRun, record: BundleRecord<"zones">): Promise<string> {
  const label = `DNS zone ${record.domain}`;
  const workspaceId = workspaceOf(run, record.workspaceRef, label);
  const checked = checkZoneName(record.domain);
  if (!checked.ok) throw new NotImported(label, checked.message);
  const zone = checked.hostname;
  const nameservers = [
    ...new Set(
      (record.nameservers ?? [])
        .map((ns) => ns.trim().toLowerCase().replace(/\.$/, ""))
        .filter(Boolean),
    ),
  ].slice(0, 13);
  const servers = nameservers.length > 0 ? nameservers : [`ns1.${zone}`, `ns2.${zone}`];

  let zoneId: string;
  const existing = await run.db
    .selectFrom("dns_zone")
    .select(["id", "workspace_id"])
    .where("name", "=", zone)
    .executeTakeFirst();
  if (existing) {
    // The zone named at install (NEARZERO_MANAGED_DNS_ZONE) may exist already; it is taken over
    // when nothing uses it yet.
    const used = await run.db
      .selectFrom("hostname")
      .select("id")
      .where("zone_id", "=", existing.id)
      .limit(1)
      .execute();
    const own = await run.db
      .selectFrom("dns_record")
      .select("id")
      .where("zone_id", "=", existing.id)
      .where("managed", "=", false)
      .limit(1)
      .execute();
    if (used.length > 0 || own.length > 0) {
      throw new NotImported(label, "this server already serves it.");
    }
    await run.db
      .updateTable("dns_zone")
      .set({
        workspace_id: workspaceId,
        admin_email: record.adminEmail,
        nameservers: servers,
        updated_at: new Date(),
      })
      .where("id", "=", existing.id)
      .execute();
    await run.db.deleteFrom("dns_record").where("zone_id", "=", existing.id).execute();
    zoneId = existing.id;
  } else {
    zoneId = (
      await run.db
        .insertInto("dns_zone")
        .values({
          workspace_id: workspaceId,
          name: zone,
          admin_email: record.adminEmail,
          nameservers: servers,
        })
        .returning("id")
        .executeTakeFirstOrThrow()
    ).id;
  }
  await zoneNameserverRecords(run, zoneId, zone, servers);
  let left = 0;
  const defaultTtl = record.ttl ?? 300;
  for (const item of record.records ?? []) {
    const type = item.type.toUpperCase();
    let name = item.name.trim().toLowerCase().replace(/\.$/, "");
    if (name === zone) name = "@";
    else if (name.endsWith(`.${zone}`)) name = name.slice(0, -(zone.length + 1));
    if (!(DNS_RECORD_TYPES as readonly string[]).includes(type) || name === "") {
      left++;
      continue;
    }
    await run.db
      .insertInto("dns_record")
      .values({
        zone_id: zoneId,
        name,
        type: type as (typeof DNS_RECORD_TYPES)[number],
        value: item.value,
        ttl: Math.min(86_400, Math.max(60, item.ttl ?? defaultTtl)),
        priority: item.priority ?? null,
        managed: false,
      })
      .execute();
  }
  if (left > 0)
    run.changed(
      "zones",
      zone,
      `${label}: ${left} records of a type 1.0 doesn't serve were left out.`,
    );
  return zoneId;
}

// ---- Uploaded certificates and certificate authority state

async function importCertificate(
  run: ImportRun,
  record: BundleRecord<"certificates">,
): Promise<string> {
  const label = `Certificate ${record.name}`;
  const workspaceId = workspaceOf(run, record.workspaceRef, label);
  const target = placeTarget(run, record.place);
  if (!target) throw new NotImported(label, "its server wasn't imported.");
  let parsed: ReturnType<typeof parseCertificate>;
  let keyPem: string;
  try {
    parsed = parseCertificate(record.certificatePem);
    keyPem = checkKeyMatches(parsed.pem, record.privateKeyPem);
  } catch (error) {
    throw new NotImported(label, problemOf(error) ?? "it can't be read.");
  }
  const id = crypto.randomUUID();
  await run.db
    .insertInto("uploaded_certificate")
    .values({
      id,
      workspace_id: workspaceId,
      name: record.name.trim().slice(0, 100),
      target,
      certificate_pem: parsed.pem,
      key_sealed: run.services.secrets.seal(keyPem, keyContext(id)),
      names: parsed.names.slice(0, 500),
      not_before: parsed.notBefore,
      not_after: parsed.notAfter,
      issuer: parsed.issuer,
      fingerprint: parsed.fingerprint,
    })
    .execute();
  return id;
}

/** Each `acme/<host or server ref>/acme.json` store (29a.3), sealed until the move places it. */
async function importAcmeStates(run: ImportRun): Promise<void> {
  for (const [path, bytes] of run.bundle.files) {
    const match = /^acme\/([^/]+)\/acme\.json$/.exec(path);
    if (!match) continue;
    const ref = match[1] as string;
    const target = targetOf(run, ref);
    const serverName =
      target === "host"
        ? "the Nearzero host"
        : target
          ? ((
              await run.db
                .selectFrom("server")
                .select("name")
                .where("id", "=", target)
                .executeTakeFirst()
            )?.name ?? ref)
          : ref;
    if (!target) {
      run.report.install.push({
        kind: "install",
        name: ref,
        message: `Certificates for server ${ref} were left out: the server wasn't imported.`,
      });
      continue;
    }
    const already = await run.db
      .selectFrom("migration_acme_state")
      .select("target")
      .where("target", "=", target)
      .executeTakeFirst();
    if (already) continue;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      value = null;
    }
    const parsed = routerStoreFrom(value);
    if (!parsed.ok) {
      run.report.install.push({
        kind: "install",
        name: serverName,
        message: `Certificates for ${serverName} can't be carried over (${parsed.reason}); its hostnames get new certificates when their DNS points at it.`,
      });
      continue;
    }
    await run.db
      .insertInto("migration_acme_state")
      .values({
        target,
        import_id: run.importId,
        sealed: run.services.secrets.seal(JSON.stringify(parsed.store), acmeContext(target)),
        certificate_count: parsed.certificates,
      })
      .execute();
    run.report.install.push({
      kind: "install",
      name: serverName,
      message: `${serverName}: ${parsed.certificates} certificate${parsed.certificates === 1 ? "" : "s"} and the certificate authority account are kept, so nothing is ordered again${parsed.skipped > 0 ? ` (${parsed.skipped} unreadable entries were left out)` : ""}.`,
    });
  }
}

// ---- Backup destinations and notification channels

/** The provider as the person chose it ("AWS", "Cloudflare") to 1.0's presets; else "other". */
function providerOf(given: string | null | undefined): BackupProvider | null {
  const text = (given ?? "").trim().toLowerCase();
  const table: [RegExp, BackupProvider][] = [
    [/^(aws|amazon|s3|amazon s3)$/, "aws"],
    [/cloudflare|^r2$/, "cloudflare-r2"],
    [/digital ?ocean|spaces/, "digitalocean"],
    [/wasabi/, "wasabi"],
    [/scaleway/, "scaleway"],
    [/akamai|linode/, "akamai"],
    [/minio/, "minio"],
    [/^other$|^custom|^s3.compatible/, "other"],
  ];
  for (const [pattern, provider] of table) if (pattern.test(text)) return provider;
  return (BACKUP_PROVIDERS as readonly string[]).includes(text) ? (text as BackupProvider) : null;
}

async function importDestination(
  run: ImportRun,
  record: BundleRecord<"destinations">,
): Promise<string> {
  const label = `Backup destination ${record.name}`;
  const workspaceId = workspaceOf(run, record.workspaceRef, label);
  let provider = providerOf(record.provider);
  if (!provider) {
    provider = "other";
    if (record.provider) {
      run.changed(
        "destinations",
        record.name,
        `${label}: the provider "${record.provider}" is saved as "other" with the same endpoint.`,
      );
    }
  }
  if ((record.extraFlags ?? []).length > 0) {
    run.dropped(
      "destinations",
      record.name,
      `${label}: extra options for the S3 client aren't in 1.0, so they were left out.`,
    );
  }
  const name = await uniqueName(
    async (candidate) =>
      (await run.db
        .selectFrom("backup_destination")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where(sql<string>`lower(name)`, "=", candidate.toLowerCase())
        .executeTakeFirst()) !== undefined,
    record.name.trim().slice(0, 100),
    100,
  );
  if (name !== record.name.trim()) {
    run.collision(
      "destinations",
      record.name,
      `${label}: the name is taken in this workspace, so it is ${name}.`,
    );
  }
  const id = crypto.randomUUID();
  await run.db
    .insertInto("backup_destination")
    .values({
      id,
      workspace_id: workspaceId,
      name,
      provider,
      endpoint: record.endpoint,
      bucket: record.bucket,
      region: record.region || "auto",
      keys_sealed: run.services.secrets.seal(
        JSON.stringify({ accessKeyId: record.accessKey, secretAccessKey: record.secretKey }),
        destinationContext(workspaceId, id),
      ),
    })
    .execute();
  return id;
}

/** Settings and secrets by their 29a labels, as the 1.0 field keys checkChannel reads. */
function channelInput(
  type: ChannelType,
  record: BundleRecord<"channels">,
): { input: Record<string, unknown>; unknown: string[] } {
  const names = CHANNEL_FIELDS[type];
  const lookup = new Map(Object.entries(names).map(([label, key]) => [label.toLowerCase(), key]));
  const input: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [label, value] of [
    ...Object.entries(record.fields ?? {}),
    ...Object.entries(record.secrets ?? {}),
  ]) {
    if (value === null || value === undefined) continue;
    const key = lookup.get(label.toLowerCase());
    if (!key) {
      unknown.push(label);
      continue;
    }
    // Headers come as a name-to-value object; 1.0 keeps them as rows.
    input[key] =
      key === "headers" && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value as Record<string, unknown>).map(([name, item]) => ({
            name,
            value: String(item),
          }))
        : value;
  }
  return { input, unknown };
}

async function importChannel(run: ImportRun, record: BundleRecord<"channels">): Promise<string> {
  const label = `Notification channel ${record.name}`;
  const workspaceId = workspaceOf(run, record.workspaceRef, label);
  const type = channelKindNamed(record.kind);
  if (!type) throw new NotImported(label, `${record.kind} isn't a channel type 1.0 sends to.`);
  const { input, unknown } = channelInput(type, record);
  for (const name of unknown) {
    run.dropped(
      "channels",
      record.name,
      `${label}: the setting "${name}" isn't in 1.0, so it was left out.`,
    );
  }
  const checked = checkChannel(type, input);
  const problem = Object.values(checked.problems ?? {})[0];
  if (problem) throw new NotImported(label, problem);
  const events: NotificationEvent[] = [];
  for (const event of record.events ?? []) {
    const known = eventNamed(event);
    if (known) {
      if (!events.includes(known)) events.push(known);
    } else {
      run.dropped(
        "channels",
        record.name,
        `${label}: the event "${event}" isn't in 1.0, so it was left out.`,
      );
    }
  }
  const name = await uniqueName(
    async (candidate) =>
      (await run.db
        .selectFrom("notification_channel")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where(sql<string>`lower(name)`, "=", candidate.toLowerCase())
        .executeTakeFirst()) !== undefined,
    record.name.trim().slice(0, 100),
    100,
  );
  if (name !== record.name.trim()) {
    run.collision(
      "channels",
      record.name,
      `${label}: the name is taken in this workspace, so it is ${name}.`,
    );
  }
  const id = crypto.randomUUID();
  await run.db
    .insertInto("notification_channel")
    .values({
      id,
      workspace_id: workspaceId,
      name,
      type,
      settings: JSON.stringify(checked.settings),
      secrets_sealed:
        Object.keys(checked.secrets).length > 0
          ? run.services.secrets.seal(JSON.stringify(checked.secrets), channelContext(id))
          : null,
      events,
      // The move is an instance administrator's, and 0.1.x's administrators set these up.
      internal_allowed: true,
    })
    .execute();
  return id;
}

/** A hostname as 1.0 accepts it, or null. */
export function cleanHost(raw: string): string | null {
  const checked = checkHostnameInput(raw);
  return checked.ok ? checked.hostname : null;
}

export async function importInfrastructure(run: ImportRun): Promise<void> {
  await run.each("sshKeys", (record) => importSshKey(run, record));
  await run.each("servers", (record) => importServer(run, record));
  await run.each("gitProviders", (record) => importGitProvider(run, record));
  await run.each("zones", (record) => importZone(run, record));
  await run.each("certificates", (record) => importCertificate(run, record));
  await importAcmeStates(run);
  await run.each("destinations", (record) => importDestination(run, record));
  await run.each("channels", (record) => importChannel(run, record));
}

/** A moved OAuth redirect address worth keeping: http(s), absolute, with no credentials. */
function movedRedirectUri(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}
