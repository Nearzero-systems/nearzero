import {
  AppError,
  GIT_CALLBACK_PATHS,
  GIT_PROVIDER_LABELS,
  type GitProviderKind,
  LEGACY_GIT_CALLBACK_PATHS,
} from "@nearzero/shared";
import type { Selectable } from "kysely";
import { sql } from "kysely";
import type { AccessTarget, ObjectRegistry } from "../access/objects.ts";
import type { Db } from "../db/database.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import { isOurId, ourIds } from "../projects/objects.ts";
import type { ControlServices } from "../services.ts";
import type { GitProviderTable } from "./tables.ts";

/**
 * Git providers as stored (spec 16): one row per connected account, owned by the person who
 * connected it, shared with the whole workspace only by its owner. Settings are plain JSON;
 * everything secret is sealed with the install key (spec 23.4) and opened only here, never
 * returned to a browser or shown to the Agent.
 */

export type ProviderRow = Selectable<GitProviderTable>;

export interface GithubSettings {
  appId: number;
  slug: string;
  htmlUrl: string;
  clientId: string;
  ownerLogin: string;
  ownerType: "User" | "Organization";
  ownerId: number | null;
  /** The organization it was created for, or "" for the person's own account. */
  organization: string;
}

export interface GithubSecrets {
  privateKey: string;
  webhookSecret: string;
  clientSecret?: string;
}

export interface OAuthSettings {
  url: string;
  internalUrl: string;
  /** GitLab application id or Gitea client id; "" when connected with an access token. */
  clientId: string;
  /** GitLab group or Gitea organization that limits the repository list. */
  filter: string;
  auth: "oauth" | "token";
  /**
   * Moved from 0.1.x: its OAuth application at the Git host was registered with 0.1.x's
   * redirect address, so 1.0 keeps using that one (R3-41, R4-15).
   */
  legacyCallback?: boolean;
  /** The exact redirect address 0.1.x registered, when the move carried it. */
  redirectUri?: string;
}

/** The OAuth redirect address of a GitLab or Gitea connection: 1.0's, or 0.1.x's when moved. */
export function oauthCallbackPath(
  kind: "gitlab" | "gitea",
  settings: Partial<Pick<OAuthSettings, "legacyCallback">> | null | undefined,
): string {
  return settings?.legacyCallback ? LEGACY_GIT_CALLBACK_PATHS[kind] : GIT_CALLBACK_PATHS[kind];
}

export interface OAuthSecrets {
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  /** Milliseconds since the epoch; absent for tokens that don't expire. */
  expiresAt?: number;
}

export interface BitbucketSettings {
  username: string;
  email: string;
  workspace: string;
  auth: "api_token" | "app_password";
}

export interface BitbucketSecrets {
  apiToken?: string;
  appPassword?: string;
}

export function sealContext(providerId: string): string {
  return `git-provider:${providerId}`;
}

export const SECRETS_UNREADABLE =
  "The saved keys of this Git provider can't be read on this server anymore. Edit it and enter them again.";

export function openProviderSecrets<T>(services: ControlServices, row: ProviderRow): T {
  if (!row.secrets_sealed) return {} as T;
  const opened = services.secrets.open(row.secrets_sealed, sealContext(row.id));
  if (!opened.ok) throw new AppError("conflict", SECRETS_UNREADABLE);
  return JSON.parse(opened.value) as T;
}

export function sealProviderSecrets(
  services: ControlServices,
  providerId: string,
  secrets: object,
): string {
  return services.secrets.seal(JSON.stringify(secrets), sealContext(providerId));
}

export function settingsOf<T>(row: ProviderRow): T {
  const value = row.settings;
  return (typeof value === "object" && value !== null ? value : {}) as T;
}

/** The provider as the permission module sees it: who owns it and whether it is shared. */
export function providerTarget(row: {
  id: string;
  owner_person_id: string | null;
  shared: boolean;
}): AccessTarget {
  return {
    kind: "git_account",
    id: row.id,
    ...(row.owner_person_id ? { ownerPersonId: row.owner_person_id } : {}),
    sharedWithWorkspace: row.shared,
  };
}

/** Lets policies and checks find Git accounts inside one workspace (spec 22.4, rule 1). */
export function registerGitAccountObjects(registry: ObjectRegistry): void {
  if (registry.has("git_account")) return;
  registry.register("git_account", {
    async resolve(db: Db, workspaceId, ids) {
      const wanted = ourIds(ids);
      if (wanted.length === 0) return [];
      const rows = await db
        .selectFrom("git_provider")
        .select(["id", "owner_person_id", "shared"])
        .where("workspace_id", "=", workspaceId)
        .where("id", "in", wanted)
        .execute();
      return rows.map(providerTarget);
    },
  });
}

export async function loadProviderRow(
  db: Db,
  workspaceId: string,
  providerId: string,
): Promise<ProviderRow | null> {
  if (!isOurId(providerId)) return null;
  const row = await db
    .selectFrom("git_provider")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where("id", "=", providerId)
    .executeTakeFirst();
  return row ?? null;
}

export function providerNotFound(): AppError {
  return new AppError(
    "not_found",
    "This Git provider doesn't exist in this workspace, or you don't have access to it.",
  );
}

/** A provider the person may use (their own, shared, or granted), or not found (spec 22.3). */
export async function usableProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
): Promise<ProviderRow> {
  await actor.access.require("git-account.use", { kind: "git_account", id: providerId });
  const row = await loadProviderRow(services.db, actor.workspace.id, providerId);
  if (!row) throw providerNotFound();
  return row;
}

function isManager(actor: WorkspaceActor): boolean {
  return actor.role === "owner" || actor.role === "admin";
}

/** Editing, reconnecting and deleting: the provider's owner, or the workspace's owners and admins. */
export function canManageProvider(actor: WorkspaceActor, row: ProviderRow): boolean {
  return isManager(actor) || row.owner_person_id === actor.personId;
}

/** Sharing: the provider's owner only (spec 16.1); admins when its owner's account is gone. */
export function canShareProvider(actor: WorkspaceActor, row: ProviderRow): boolean {
  if (row.owner_person_id) return row.owner_person_id === actor.personId;
  return isManager(actor);
}

/** A provider the person may manage, or the refusal that says who can. */
export async function managedProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
): Promise<ProviderRow> {
  const row = await usableProvider(services, actor, providerId);
  if (!canManageProvider(actor, row)) {
    throw new AppError(
      "forbidden",
      "Only the person who connected this Git provider, and the workspace's owners and admins, can change or delete it.",
    );
  }
  return row;
}

/** Services whose source is this provider, by kind (spec 16.1's delete warning). */
export async function providerUsage(
  db: Db,
  workspaceId: string,
  providerId: string,
): Promise<{ apps: number; composeServices: number; serviceIds: string[] }> {
  const rows = await db
    .selectFrom("service")
    .select(["id", "kind"])
    .where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`settings -> 'source' ->> 'type' = 'provider'`)
    .where(sql<boolean>`settings -> 'source' ->> 'providerId' = ${providerId}`)
    .execute();
  return {
    apps: rows.filter((row) => row.kind === "application").length,
    composeServices: rows.filter((row) => row.kind === "compose").length,
    serviceIds: rows.map((row) => row.id),
  };
}

export interface GitProviderView {
  id: string;
  kind: GitProviderKind;
  kindLabel: string;
  name: string;
  owner: { id: string; name: string } | null;
  mine: boolean;
  shared: boolean;
  /** "ready", or "action_required" while the connection is incomplete (spec 16.1). */
  status: "ready" | "action_required";
  statusMessage: string | null;
  /** Bitbucket connections made with a legacy app password. */
  deprecated: boolean;
  account: string | null;
  lastError: string | null;
  createdAt: string;
  connectedAt: string | null;
  /** Non-secret settings, per kind, for the Edit dialog. */
  details: Record<string, unknown>;
  /** Which secrets are saved ("Configured - leave blank to keep"); never the values. */
  configured: Record<string, boolean>;
  /** The GitHub App's page on GitHub ("Open"). */
  openUrl: string | null;
  can: {
    share: boolean;
    edit: boolean;
    delete: boolean;
    install: boolean;
    authorize: boolean;
  };
}

/** The console's address for a callback path, or null without one. */
export function consoleAddress(services: ControlServices, path: string): string | null {
  // Git providers call back at NEARZERO_GIT_PUBLIC_URL when it is set (31d G4-19).
  const base = services.gitPublicUrl();
  return base ? `${base.replace(/\/+$/, "")}${path}` : null;
}

function statusMessage(row: ProviderRow): string | null {
  if (row.status === "ready") return null;
  if (row.kind === "github") return "Install the GitHub App to finish connecting.";
  if (row.kind === "bitbucket") return "Test the connection to finish connecting.";
  return `Authorize Nearzero on ${GIT_PROVIDER_LABELS[row.kind]} to finish connecting.`;
}

export function providerView(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ProviderRow,
  owner: { id: string; name: string } | null,
): GitProviderView {
  const kind = row.kind as GitProviderKind;
  const mine = row.owner_person_id === actor.personId;
  const manage = canManageProvider(actor, row);
  let secrets: Record<string, unknown> = {};
  try {
    secrets = openProviderSecrets<Record<string, unknown>>(services, row);
  } catch {
    secrets = {};
  }
  const has = (key: string) => typeof secrets[key] === "string" && secrets[key] !== "";
  let details: Record<string, unknown> = {};
  let configured: Record<string, boolean> = {};
  let openUrl: string | null = null;
  let deprecated = false;
  if (kind === "github") {
    const settings = settingsOf<Partial<GithubSettings>>(row);
    details = {
      appSlug: settings.slug ?? null,
      appId: settings.appId ?? null,
      organization: settings.organization ?? "",
      ownerLogin: settings.ownerLogin ?? null,
      installationId: row.installation_id ? Number(row.installation_id) : null,
    };
    openUrl = settings.htmlUrl ?? null;
    configured = { privateKey: has("privateKey"), webhookSecret: has("webhookSecret") };
  } else if (kind === "gitlab" || kind === "gitea") {
    const settings = settingsOf<Partial<OAuthSettings>>(row);
    const idKey = kind === "gitlab" ? "applicationId" : "clientId";
    const secretKey = kind === "gitlab" ? "applicationSecret" : "clientSecret";
    details = {
      url: settings.url ?? "",
      internalUrl: settings.internalUrl ?? "",
      [idKey]: settings.clientId ?? "",
      [kind === "gitlab" ? "group" : "organization"]: settings.filter ?? "",
      auth: settings.auth ?? "oauth",
      redirectUri:
        (settings.legacyCallback ? settings.redirectUri : undefined) ??
        consoleAddress(services, oauthCallbackPath(kind, settings)),
    };
    configured = { [secretKey]: has("clientSecret"), accessToken: has("accessToken") };
  } else {
    const settings = settingsOf<Partial<BitbucketSettings>>(row);
    details = {
      username: settings.username ?? "",
      email: settings.email ?? "",
      workspace: settings.workspace ?? "",
      auth: settings.auth ?? "api_token",
    };
    configured = { apiToken: has("apiToken"), appPassword: has("appPassword") };
    deprecated = settings.auth === "app_password";
  }
  const oauth = (kind === "gitlab" || kind === "gitea") && details.auth === "oauth";
  return {
    id: row.id,
    kind,
    kindLabel: GIT_PROVIDER_LABELS[kind],
    name: row.name,
    owner,
    mine,
    shared: row.shared,
    status: row.status === "ready" ? "ready" : "action_required",
    statusMessage: statusMessage(row),
    deprecated,
    account: row.account_login,
    lastError: row.last_error,
    createdAt: new Date(row.created_at).toISOString(),
    connectedAt: row.connected_at ? new Date(row.connected_at).toISOString() : null,
    details,
    configured,
    openUrl,
    can: {
      share: canShareProvider(actor, row),
      edit: manage,
      delete: manage,
      install: manage && kind === "github",
      authorize: manage && oauth,
    },
  };
}

/** Owners' names for a list of rows, in one query. */
export async function ownerNames(
  db: Db,
  rows: readonly { owner_person_id: string | null }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.owner_person_id).filter(Boolean))] as string[];
  if (ids.length === 0) return new Map();
  const people = await db
    .selectFrom("person")
    .select(["id", "first_name", "last_name", "email"])
    .where("id", "in", ids)
    .execute();
  return new Map(people.map((person) => [person.id, displayName(person)]));
}

export async function viewOf(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ProviderRow,
): Promise<GitProviderView> {
  const names = await ownerNames(services.db, [row]);
  const owner = row.owner_person_id
    ? { id: row.owner_person_id, name: names.get(row.owner_person_id) ?? "Someone" }
    : null;
  return providerView(services, actor, row, owner);
}
