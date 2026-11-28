import {
  AppError,
  type bitbucketProviderRequestSchema,
  GIT_CALLBACK_PATHS,
  GIT_PROVIDER_LABELS,
  GITHUB_NEEDS_HTTPS,
  type GitProviderKind,
  type giteaProviderRequestSchema,
  type githubManifestRequestSchema,
  githubWebhookPath,
  type gitlabProviderRequestSchema,
  isIPv4,
  PROVIDER_SHARED_MESSAGE,
  PROVIDER_UNSHARED_MESSAGE,
  providerInUseMessage,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import { consoleHostname } from "../domains/addresses.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { checkOutboundHost, OutboundRefused, systemResolve } from "../security/outbound.ts";
import { readableCode } from "../security/tokens.ts";
import type { ControlServices } from "../services.ts";
import { BitbucketClient } from "./bitbucket.ts";
import { oauthClient, redirectUriFor } from "./clients.ts";
import { consumeFlow, markFlowUsed, startFlow, usableFlow } from "./flows.ts";
import {
  convertManifest,
  forgetInstallationTokens,
  GithubClient,
  githubManifest,
  installationOfApp,
  installUrl,
  manifestActionUrl,
} from "./github.ts";
import { ProviderError } from "./http.ts";
import { authorizeAddress, exchangeCode, type OAuthKind } from "./oauth.ts";
import {
  type BitbucketSecrets,
  type BitbucketSettings,
  canShareProvider,
  type GithubSecrets,
  type GithubSettings,
  type GitProviderView,
  loadProviderRow,
  managedProvider,
  type OAuthSecrets,
  type OAuthSettings,
  openProviderSecrets,
  type ProviderRow,
  providerNotFound,
  providerUsage,
  sealProviderSecrets,
  settingsOf,
  usableProvider,
  viewOf,
} from "./records.ts";

/**
 * Connecting, editing, testing, sharing and deleting Git providers (spec 16.1–16.5). Every
 * secret is sealed before it is stored and never comes back; flows carry a state bound to the
 * person; a connection is only "ready" once the host confirmed it works.
 */

type GitlabInput = z.output<typeof gitlabProviderRequestSchema>;
type GiteaInput = z.output<typeof giteaProviderRequestSchema>;
type BitbucketInput = z.output<typeof bitbucketProviderRequestSchema>;
type ManifestInput = z.output<typeof githubManifestRequestSchema>;

async function audit(
  services: ControlServices,
  actor: WorkspaceActor,
  action: string,
  providerId: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await recordAudit(services.db, services.log, auditActor(actor), {
    action,
    workspaceId: actor.workspace.id,
    target: { kind: "git_provider", id: providerId },
    details,
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * The console's public HTTPS address (spec 16.2), or null: GitHub sends events there, so a
 * plain-HTTP address, an IP address or localhost doesn't do.
 */
export async function publicHttpsBase(services: ControlServices): Promise<string | null> {
  // NEARZERO_GIT_PUBLIC_URL (0.1.x's PUBLIC_GIT_PROVIDER_BASE_URL) when set (31d G4-19).
  const configured = services.gitPublicUrl();
  const usable = (url: string) => {
    const host = hostOf(url);
    return (
      url.startsWith("https://") &&
      host !== null &&
      !isIPv4(host) &&
      !host.includes(":") &&
      host !== "localhost" &&
      !host.endsWith(".localhost") &&
      host.includes(".")
    );
  };
  if (configured && usable(configured)) return configured.replace(/\/+$/, "");
  const hostname = await consoleHostname(services);
  if (hostname && usable(`https://${hostname}`)) return `https://${hostname}`;
  return null;
}

function refuseWithFields(message: string, fields: Record<string, string>): AppError {
  return new AppError("invalid_request", message, { fields });
}

async function testedLogin(work: () => Promise<string>, field: string): Promise<string> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.failure === "unreachable") throw error.toAppError();
      throw refuseWithFields(error.message, { [field]: error.message });
    }
    throw error;
  }
}

// ---------------------------------------------------------------- GitHub (spec 16.2)

export async function startGithubManifest(
  services: ControlServices,
  actor: WorkspaceActor,
  input: ManifestInput,
): Promise<{ action: string; manifest: string; appName: string; providerId: string }> {
  await actor.access.require("git-accounts.connect-own");
  const base = await publicHttpsBase(services);
  if (!base) throw new AppError("conflict", GITHUB_NEEDS_HTTPS);
  const providerId = crypto.randomUUID();
  const date = new Date(services.now()).toISOString().slice(0, 10);
  const appName = `Nearzero-${date}-${readableCode(6)}`;
  const state = await startFlow(services, actor, {
    purpose: "github-manifest",
    returnTo: input.returnTo ?? null,
    details: { providerId, organization: input.organization, appName },
  });
  const manifest = githubManifest({
    name: appName,
    consoleBase: base,
    webhookUrl: `${base}${githubWebhookPath(providerId)}`,
    createdUrl: `${base}${GIT_CALLBACK_PATHS.githubCreated}`,
    installedUrl: `${base}${GIT_CALLBACK_PATHS.githubInstalled}`,
  });
  return {
    action: manifestActionUrl(input.organization, state),
    manifest: JSON.stringify(manifest),
    appName,
    providerId,
  };
}

export async function completeGithubManifest(
  services: ControlServices,
  actor: WorkspaceActor,
  input: { code: string; state: string },
): Promise<{ provider: GitProviderView; installUrl: string; returnTo: string | null }> {
  await actor.access.require("git-accounts.connect-own");
  const flow = await consumeFlow(services, actor, input.state, "github-manifest");
  const details = flow.details as { providerId?: string; organization?: string; appName?: string };
  const providerId = details.providerId ?? crypto.randomUUID();
  let app: Awaited<ReturnType<typeof convertManifest>>;
  try {
    app = await convertManifest(services.http, input.code);
  } catch (error) {
    if (error instanceof ProviderError) throw error.toAppError();
    throw error;
  }
  const settings: GithubSettings = {
    appId: app.id,
    slug: app.slug,
    htmlUrl: app.htmlUrl,
    clientId: app.clientId,
    ownerLogin: app.owner.login,
    ownerType: app.owner.type,
    ownerId: app.owner.id,
    organization: details.organization ?? "",
  };
  const secrets: GithubSecrets = {
    privateKey: app.pem,
    webhookSecret: app.webhookSecret,
    clientSecret: app.clientSecret,
  };
  const existing = await services.db
    .selectFrom("git_provider")
    .select("id")
    .where("github_app_id", "=", String(app.id))
    .executeTakeFirst();
  if (existing) {
    throw new AppError("conflict", "This GitHub App is already connected to Nearzero.");
  }
  const row = await services.db
    .insertInto("git_provider")
    .values({
      id: providerId,
      workspace_id: actor.workspace.id,
      owner_person_id: actor.personId,
      kind: "github",
      name: app.name || details.appName || "GitHub",
      status: "pending",
      settings: JSON.stringify(settings),
      secrets_sealed: sealProviderSecrets(services, providerId, secrets),
      github_app_id: app.id,
      account_login: app.owner.login || null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(services, actor, "git-provider.connected", row.id, {
    kind: "github",
    appId: app.id,
  });
  const state = await startFlow(services, actor, {
    purpose: "github-install",
    providerId: row.id,
    returnTo: flow.returnTo,
  });
  return {
    provider: await viewOf(services, actor, row),
    installUrl: installUrl(app.slug, state, app.owner.id),
    returnTo: flow.returnTo,
  };
}

/** Row action "Install" (spec 16.1): the install page on the app's owner. */
export async function startGithubInstall(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  returnTo: string | undefined,
): Promise<{ installUrl: string }> {
  const row = await managedProvider(services, actor, providerId);
  if (row.kind !== "github") throw new AppError("conflict", "Only GitHub providers are installed.");
  const state = await startFlow(services, actor, {
    purpose: "github-install",
    providerId: row.id,
    returnTo: returnTo ?? null,
  });
  const settings = settingsOf<GithubSettings>(row);
  return { installUrl: installUrl(settings.slug, state, settings.ownerId ?? null) };
}

async function bindInstallation(
  services: ControlServices,
  row: ProviderRow,
  installationId: number,
  account: string,
): Promise<ProviderRow> {
  forgetInstallationTokens();
  return services.db
    .updateTable("git_provider")
    .set({
      installation_id: installationId,
      status: "ready",
      account_login: account || row.account_login,
      last_error: null,
      connected_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
}

/**
 * GitHub came back from the install page (spec 16.2). With a valid state the installation goes
 * to that app; returning late or without one, it binds to the signed-in person's waiting app
 * whose credentials GitHub confirms own the installation.
 */
export async function completeGithubInstall(
  services: ControlServices,
  actor: WorkspaceActor,
  input: { installationId: number; state?: string | undefined; setupAction?: string | undefined },
): Promise<{ provider: GitProviderView; returnTo: string | null; message: string }> {
  const { db } = services;
  const flow = await usableFlow(services, actor, input.state, "github-install");
  const bound = await db
    .selectFrom("git_provider")
    .selectAll()
    .where("installation_id", "=", String(input.installationId))
    .executeTakeFirst();
  if (bound) {
    if (bound.workspace_id !== actor.workspace.id) throw providerNotFound();
    await usableProvider(services, actor, bound.id);
    if (flow) await markFlowUsed(services, flow.id);
    return {
      provider: await viewOf(services, actor, bound),
      returnTo: flow?.returnTo ?? null,
      message: "GitHub App updated",
    };
  }
  let candidates: ProviderRow[] = [];
  if (flow?.providerId) {
    const row = await loadProviderRow(db, actor.workspace.id, flow.providerId);
    if (row) candidates = [row];
  }
  if (candidates.length === 0) {
    candidates = await db
      .selectFrom("git_provider")
      .selectAll()
      .where("workspace_id", "=", actor.workspace.id)
      .where("owner_person_id", "=", actor.personId)
      .where("kind", "=", "github")
      .where("installation_id", "is", null)
      .orderBy("created_at", "desc")
      .limit(5)
      .execute();
  }
  for (const row of candidates) {
    const settings = settingsOf<GithubSettings>(row);
    let confirmed: Awaited<ReturnType<typeof installationOfApp>> = null;
    try {
      confirmed = await installationOfApp(
        services.http,
        settings,
        openProviderSecrets<GithubSecrets>(services, row),
        input.installationId,
        Math.floor(services.now() / 1000),
      );
    } catch (error) {
      if (error instanceof ProviderError && error.failure === "unreachable") {
        throw error.toAppError();
      }
      confirmed = null;
    }
    if (!confirmed) continue;
    const updated = await bindInstallation(services, row, input.installationId, confirmed.account);
    if (flow) await markFlowUsed(services, flow.id);
    await audit(services, actor, "git-provider.installed", row.id, {
      installationId: input.installationId,
      late: !flow,
    });
    return {
      provider: await viewOf(services, actor, updated),
      returnTo: flow?.returnTo ?? null,
      message: "GitHub App installed",
    };
  }
  throw new AppError(
    "conflict",
    "GitHub says this installation doesn't belong to a GitHub App you're connecting here. Start from Settings → Git providers and choose Install.",
  );
}

/**
 * Installation events on the app's own webhook (signed by the app): a late install binds to the
 * app that has none, and a removed one sends the provider back to "Action required".
 */
export async function applyInstallationEvent(
  services: ControlServices,
  row: ProviderRow,
  event: { action: string; installationId: number | null; account: string | null },
): Promise<void> {
  if (!event.installationId) return;
  if (event.action === "deleted" || event.action === "suspend") {
    if (row.installation_id && Number(row.installation_id) === event.installationId) {
      forgetInstallationTokens();
      await services.db
        .updateTable("git_provider")
        .set({
          installation_id: null,
          status: "pending",
          last_error:
            event.action === "deleted"
              ? "The GitHub App was uninstalled on GitHub. Install it again to keep deploying."
              : "The GitHub App's installation was suspended on GitHub.",
          updated_at: sql<Date>`now()`,
        })
        .where("id", "=", row.id)
        .execute();
    }
    return;
  }
  if ((event.action === "created" || event.action === "unsuspend") && !row.installation_id) {
    const taken = await services.db
      .selectFrom("git_provider")
      .select("id")
      .where("installation_id", "=", String(event.installationId))
      .executeTakeFirst();
    if (!taken) await bindInstallation(services, row, event.installationId, event.account ?? "");
  }
}

// ---------------------------------------------------------------- GitLab and Gitea (16.3, 16.5)

function oauthInput(kind: OAuthKind, input: GitlabInput | GiteaInput) {
  if (kind === "gitlab") {
    const value = input as GitlabInput;
    return {
      clientId: value.applicationId,
      clientSecret: value.applicationSecret,
      filter: value.group,
      idField: "applicationId",
      secretField: "applicationSecret",
    };
  }
  const value = input as GiteaInput;
  return {
    clientId: value.clientId,
    clientSecret: value.clientSecret,
    filter: value.organization,
    idField: "clientId",
    secretField: "clientSecret",
  };
}

function idLabel(kind: OAuthKind): string {
  return kind === "gitlab" ? "Application ID" : "Client ID";
}

function secretLabel(kind: OAuthKind): string {
  return kind === "gitlab" ? "Application secret" : "Client secret";
}

/**
 * A self-hosted GitLab's or Gitea's address and internal address may be private or internal only
 * when a workspace owner or admin, or an instance administrator, sets them (31d G4-12, spec 23.9:
 * the control plane calls them, so a member could otherwise make it reach loopback, the Docker
 * network or a cloud's metadata address). Checked before anything is saved or called.
 */
export const INTERNAL_GIT_ADDRESS =
  "Only a workspace owner or admin can point a Git connection at a private or internal address";

async function checkProviderAddresses(
  services: ControlServices,
  actor: WorkspaceActor,
  addresses: { url: string; internalUrl?: string | undefined },
): Promise<void> {
  if (actor.isInstanceAdmin || actor.role === "owner" || actor.role === "admin") return;
  for (const [field, value] of [
    ["url", addresses.url],
    ["internalUrl", addresses.internalUrl ?? ""],
  ] as const) {
    if (!value) continue;
    let host: string;
    try {
      host = new URL(value).hostname;
    } catch {
      continue; // The request schema reports a malformed address.
    }
    try {
      await checkOutboundHost(host, services.resolveHost ?? systemResolve, false);
    } catch (error) {
      if (!(error instanceof OutboundRefused)) throw error;
      if (error.kind === "lookup") {
        const message = `Nearzero couldn't look up ${host}. Check the address.`;
        throw refuseWithFields(message, { [field]: message });
      }
      const message = `${INTERNAL_GIT_ADDRESS}: ${host.replace(/^\[|\]$/g, "")} is one.`;
      throw refuseWithFields(message, { [field]: message });
    }
  }
}

export async function createOAuthProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  kind: OAuthKind,
  input: GitlabInput | GiteaInput,
): Promise<{ provider: GitProviderView; authorizeUrl: string | null }> {
  await actor.access.require("git-accounts.connect-own");
  await checkProviderAddresses(services, actor, input);
  const fields = oauthInput(kind, input);
  const tokenMode = input.accessToken !== "" && fields.clientId === "";
  const id = crypto.randomUUID();
  const settings: OAuthSettings = {
    url: input.url,
    internalUrl: input.internalUrl,
    clientId: tokenMode ? "" : fields.clientId,
    filter: fields.filter,
    auth: tokenMode ? "token" : "oauth",
  };
  if (tokenMode) {
    const secrets: OAuthSecrets = { accessToken: input.accessToken };
    const login = await testedLogin(
      () => oauthClient(services, kind, settings, secrets, null).whoAmI(),
      "accessToken",
    );
    const row = await services.db
      .insertInto("git_provider")
      .values({
        id,
        workspace_id: actor.workspace.id,
        owner_person_id: actor.personId,
        kind,
        name: input.name,
        status: "ready",
        settings: JSON.stringify(settings),
        secrets_sealed: sealProviderSecrets(services, id, secrets),
        account_login: login || null,
        connected_at: sql<Date>`now()`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await audit(services, actor, "git-provider.connected", row.id, { kind, auth: "token" });
    return { provider: await viewOf(services, actor, row), authorizeUrl: null };
  }
  const problems: Record<string, string> = {};
  if (!fields.clientId) problems[fields.idField] = `Enter the ${idLabel(kind)}.`;
  if (!fields.clientSecret) problems[fields.secretField] = `Enter the ${secretLabel(kind)}.`;
  const [first] = Object.values(problems);
  if (first) throw refuseWithFields(first, problems);
  const redirectUri = redirectUriFor(services, kind);
  if (!redirectUri) {
    throw new AppError(
      "conflict",
      "This server has no console address yet, so there is no redirect URI to give GitLab or Gitea. Set the console's address under About Nearzero first.",
    );
  }
  const secrets: OAuthSecrets = { clientSecret: fields.clientSecret };
  const row = await services.db
    .insertInto("git_provider")
    .values({
      id,
      workspace_id: actor.workspace.id,
      owner_person_id: actor.personId,
      kind,
      name: input.name,
      status: "pending",
      settings: JSON.stringify(settings),
      secrets_sealed: sealProviderSecrets(services, id, secrets),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(services, actor, "git-provider.connected", row.id, { kind, auth: "oauth" });
  const state = await startFlow(services, actor, {
    purpose: "oauth",
    providerId: row.id,
    returnTo: input.returnTo ?? null,
  });
  return {
    provider: await viewOf(services, actor, row),
    authorizeUrl: authorizeAddress(kind, settings, redirectUri, state),
  };
}

/** Row action "Authorize" / "Reconnect" (spec 16.1). */
export async function startAuthorization(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  returnTo: string | undefined,
): Promise<{ authorizeUrl: string }> {
  const row = await managedProvider(services, actor, providerId);
  if (row.kind !== "gitlab" && row.kind !== "gitea") {
    throw new AppError("conflict", "Only GitLab and Gitea providers are authorized this way.");
  }
  const settings = settingsOf<OAuthSettings>(row);
  if (settings.auth !== "oauth") {
    throw new AppError(
      "conflict",
      "This provider connects with an access token. Edit it to paste a new token.",
    );
  }
  const redirectUri = redirectUriFor(services, row.kind, settings);
  if (!redirectUri) {
    throw new AppError(
      "conflict",
      "This server has no console address yet. Set it under About Nearzero first.",
    );
  }
  const state = await startFlow(services, actor, {
    purpose: "oauth",
    providerId: row.id,
    returnTo: returnTo ?? null,
  });
  return { authorizeUrl: authorizeAddress(row.kind, settings, redirectUri, state) };
}

export async function completeOAuth(
  services: ControlServices,
  actor: WorkspaceActor,
  input: { kind: OAuthKind; code: string; state: string; error?: string | undefined },
): Promise<{ provider: GitProviderView; returnTo: string | null; message: string }> {
  const flow = await consumeFlow(services, actor, input.state, "oauth");
  const row = flow.providerId
    ? await loadProviderRow(services.db, actor.workspace.id, flow.providerId)
    : null;
  if (!row || (row.kind !== "gitlab" && row.kind !== "gitea")) throw providerNotFound();
  const label = GIT_PROVIDER_LABELS[row.kind];
  if (input.error || !input.code) {
    throw new AppError(
      "conflict",
      `${label} didn't authorize Nearzero${input.error ? ` (${input.error.slice(0, 60)})` : ""}. Choose Authorize in Settings → Git providers to try again.`,
    );
  }
  const settings = settingsOf<OAuthSettings>(row);
  const saved = openProviderSecrets<OAuthSecrets>(services, row);
  let login: string;
  let tokens: OAuthSecrets;
  try {
    tokens = await exchangeCode(
      services.http,
      row.kind,
      settings,
      saved.clientSecret ?? "",
      input.code,
      redirectUriFor(services, row.kind, settings) ?? "",
      services.now(),
    );
    login = await oauthClient(services, row.kind, settings, tokens, null).whoAmI();
  } catch (error) {
    if (error instanceof ProviderError) {
      await services.db
        .updateTable("git_provider")
        .set({ last_error: error.message })
        .where("id", "=", row.id)
        .execute();
      throw error.toAppError();
    }
    throw error;
  }
  const updated = await services.db
    .updateTable("git_provider")
    .set({
      secrets_sealed: sealProviderSecrets(services, row.id, {
        clientSecret: saved.clientSecret,
        ...tokens,
      }),
      status: "ready",
      account_login: login || null,
      last_error: null,
      connected_at: sql<Date>`now()`,
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(services, actor, "git-provider.authorized", row.id, { kind: row.kind });
  return {
    provider: await viewOf(services, actor, updated),
    returnTo: flow.returnTo,
    message: `${label} connected`,
  };
}

// ---------------------------------------------------------------- Bitbucket (spec 16.4)

function bitbucketParts(
  input: Omit<BitbucketInput, "returnTo">,
  saved: { settings: Partial<BitbucketSettings>; secrets: BitbucketSecrets } | null,
): { settings: BitbucketSettings; secrets: BitbucketSecrets } {
  const apiToken = input.apiToken || (input.appPassword ? "" : (saved?.secrets.apiToken ?? ""));
  const appPassword =
    input.appPassword || (input.apiToken ? "" : (saved?.secrets.appPassword ?? ""));
  if (apiToken) {
    if (!input.email) {
      throw refuseWithFields("Enter your Atlassian account email.", {
        email: "Enter your Atlassian account email.",
      });
    }
    return {
      settings: {
        username: input.username,
        email: input.email,
        workspace: input.workspace,
        auth: "api_token",
      },
      secrets: { apiToken },
    };
  }
  if (appPassword) {
    return {
      settings: {
        username: input.username,
        email: input.email,
        workspace: input.workspace,
        auth: "app_password",
      },
      secrets: { appPassword },
    };
  }
  throw refuseWithFields("Paste an API token.", { apiToken: "Paste an API token." });
}

export async function createBitbucketProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  input: BitbucketInput,
): Promise<{ provider: GitProviderView }> {
  await actor.access.require("git-accounts.connect-own");
  const { settings, secrets } = bitbucketParts(input, null);
  const login = await testedLogin(
    () => new BitbucketClient(services.http, settings, secrets).whoAmI(),
    settings.auth === "api_token" ? "apiToken" : "appPassword",
  );
  const id = crypto.randomUUID();
  const row = await services.db
    .insertInto("git_provider")
    .values({
      id,
      workspace_id: actor.workspace.id,
      owner_person_id: actor.personId,
      kind: "bitbucket",
      name: input.name,
      status: "ready",
      settings: JSON.stringify(settings),
      secrets_sealed: sealProviderSecrets(services, id, secrets),
      account_login: login || input.username,
      connected_at: sql<Date>`now()`,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(services, actor, "git-provider.connected", row.id, {
    kind: "bitbucket",
    auth: settings.auth,
  });
  return { provider: await viewOf(services, actor, row) };
}

// ---------------------------------------------------------------- Edit and test (spec 16.1)

interface Candidate {
  row: ProviderRow;
  name: string;
  settings: Record<string, unknown>;
  secrets: Record<string, unknown>;
  /** A change that makes earlier OAuth tokens useless (another host or application). */
  reauthorize: boolean;
}

/**
 * An edit that moves a GitLab or Gitea connection to another address is checked as a new one is
 * (G4-12); a kept address isn't asked about again.
 */
async function checkMovedAddresses(
  services: ControlServices,
  actor: WorkspaceActor,
  candidate: Candidate,
): Promise<void> {
  const { row } = candidate;
  if (row.kind !== "gitlab" && row.kind !== "gitea") return;
  const before = settingsOf<OAuthSettings>(row);
  const after = candidate.settings as unknown as OAuthSettings;
  const changed = (a: string | undefined, b: string | undefined) => (a ?? "") !== (b ?? "");
  await checkProviderAddresses(services, actor, {
    url: changed(after.url, before.url) ? after.url : "",
    internalUrl: changed(after.internalUrl, before.internalUrl) ? after.internalUrl : "",
  });
}

/** The provider as it would be after an edit, blank secrets kept. Nothing is saved. */
function editedCandidate(services: ControlServices, row: ProviderRow, body: unknown): Candidate {
  const input = body as Record<string, unknown>;
  const kind = row.kind as GitProviderKind;
  if (kind === "github") {
    return {
      row,
      name: String(input.name ?? row.name),
      settings: settingsOf(row),
      secrets: openProviderSecrets(services, row),
      reauthorize: false,
    };
  }
  if (kind === "bitbucket") {
    const value = input as unknown as Omit<BitbucketInput, "returnTo">;
    const parts = bitbucketParts(value, {
      settings: settingsOf<BitbucketSettings>(row),
      secrets: openProviderSecrets<BitbucketSecrets>(services, row),
    });
    return {
      row,
      name: value.name,
      settings: parts.settings as unknown as Record<string, unknown>,
      secrets: parts.secrets as unknown as Record<string, unknown>,
      reauthorize: false,
    };
  }
  const value = input as unknown as GitlabInput | GiteaInput;
  const fields = oauthInput(kind, value);
  const before = settingsOf<OAuthSettings>(row);
  const saved = openProviderSecrets<OAuthSecrets>(services, row);
  // A saved secret goes only to the address it was saved for (spec 16.7, 23.4): a changed
  // address needs it entered again, so nobody can send someone else's token elsewhere.
  const moved =
    value.url !== before.url || (value.internalUrl ?? "") !== (before.internalUrl ?? "");
  const tokenMode =
    value.accessToken !== "" ? fields.clientId === "" : before.auth === "token" && !fields.clientId;
  const settings: OAuthSettings = {
    url: value.url,
    internalUrl: value.internalUrl,
    clientId: tokenMode ? "" : fields.clientId,
    filter: fields.filter,
    auth: tokenMode ? "token" : "oauth",
    // A moved connection keeps 0.1.x's redirect address, the one its dialog shows (R3-41).
    ...(!tokenMode && before.legacyCallback
      ? { legacyCallback: true, ...(before.redirectUri ? { redirectUri: before.redirectUri } : {}) }
      : {}),
  };
  if (tokenMode) {
    if (moved && !value.accessToken) {
      const message = `Paste the access token again: Nearzero sends a saved token only to the address it was saved for, and this one changed.`;
      throw refuseWithFields(message, { accessToken: message });
    }
    const accessToken = value.accessToken || saved.accessToken || "";
    if (!accessToken) {
      throw refuseWithFields("Paste an access token.", { accessToken: "Paste an access token." });
    }
    return {
      row,
      name: value.name,
      settings: settings as unknown as Record<string, unknown>,
      secrets: { accessToken },
      reauthorize: false,
    };
  }
  if (!fields.clientId) {
    throw refuseWithFields(`Enter the ${idLabel(kind)}.`, {
      [fields.idField]: `Enter the ${idLabel(kind)}.`,
    });
  }
  if (moved && !fields.clientSecret) {
    const message = `Enter the ${secretLabel(kind)} again: Nearzero sends a saved secret only to the address it was saved for, and this one changed.`;
    throw refuseWithFields(message, { [fields.secretField]: message });
  }
  const clientSecret = fields.clientSecret || saved.clientSecret || "";
  if (!clientSecret) {
    throw refuseWithFields(`Enter the ${secretLabel(kind)}.`, {
      [fields.secretField]: `Enter the ${secretLabel(kind)}.`,
    });
  }
  const reauthorize =
    before.auth !== "oauth" ||
    before.url !== settings.url ||
    before.clientId !== settings.clientId ||
    (fields.clientSecret !== "" && fields.clientSecret !== saved.clientSecret);
  return {
    row,
    name: value.name,
    settings: settings as unknown as Record<string, unknown>,
    secrets: reauthorize ? { clientSecret } : { ...saved, clientSecret },
    reauthorize,
  };
}

async function loginOf(services: ControlServices, candidate: Candidate): Promise<string> {
  const { row } = candidate;
  if (row.kind === "github") {
    if (!row.installation_id) {
      throw new ProviderError(
        "credentials",
        "The GitHub App isn't installed yet. Choose Install first.",
      );
    }
    return new GithubClient(
      services.http,
      candidate.settings as unknown as GithubSettings,
      candidate.secrets as unknown as GithubSecrets,
      Number(row.installation_id),
      services.now,
    ).whoAmI();
  }
  if (row.kind === "bitbucket") {
    return new BitbucketClient(
      services.http,
      candidate.settings as unknown as BitbucketSettings,
      candidate.secrets as unknown as BitbucketSecrets,
    ).whoAmI();
  }
  const settings = candidate.settings as unknown as OAuthSettings;
  if (settings.auth === "oauth" && (candidate.reauthorize || !candidate.secrets.accessToken)) {
    throw new ProviderError(
      "credentials",
      `Save, then choose Authorize to let Nearzero into ${GIT_PROVIDER_LABELS[row.kind]}.`,
    );
  }
  return oauthClient(
    services,
    row.kind,
    settings,
    candidate.secrets as OAuthSecrets,
    row.account_login,
  ).whoAmI();
}

/** "Test connection" in the Edit dialog: the values in the form, without saving them. */
export async function testProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  body: unknown,
): Promise<{ ok: true; account: string; message: string }> {
  const row = await managedProvider(services, actor, providerId);
  const candidate = editedCandidate(services, row, body ?? viewDefaults(row));
  // Testing calls the address in the form, so a changed one is checked first (G4-12).
  await checkMovedAddresses(services, actor, candidate);
  const where = (candidate.settings as { url?: unknown }).url;
  let login: string;
  try {
    login = await loginOf(services, candidate);
  } catch (error) {
    await audit(services, actor, "git-provider.tested", row.id, {
      kind: row.kind,
      ...(typeof where === "string" ? { url: where } : {}),
      ok: false,
    });
    if (error instanceof ProviderError) throw error.toAppError();
    throw error;
  }
  // Test sends the saved credentials out, so it is recorded like a save (B1-10).
  await audit(services, actor, "git-provider.tested", row.id, {
    kind: row.kind,
    ...(typeof where === "string" ? { url: where } : {}),
    ok: true,
  });
  return {
    ok: true,
    account: login,
    message: login ? `Connected as ${login}.` : "The connection works.",
  };
}

/**
 * The saved values as an edit body (blank secrets), for testing what is saved and for filling
 * the fields an edit leaves out, so a PATCH with only a name keeps the saved address.
 */
export function viewDefaults(row: ProviderRow): Record<string, unknown> {
  const settings = settingsOf<Record<string, unknown>>(row);
  if (row.kind === "gitlab" || row.kind === "gitea") {
    const value = settings as unknown as OAuthSettings;
    return {
      name: row.name,
      url: value.url,
      internalUrl: value.internalUrl,
      [row.kind === "gitlab" ? "applicationId" : "clientId"]: value.clientId,
      [row.kind === "gitlab" ? "applicationSecret" : "clientSecret"]: "",
      accessToken: "",
      [row.kind === "gitlab" ? "group" : "organization"]: value.filter,
    };
  }
  if (row.kind === "bitbucket") {
    const value = settings as unknown as BitbucketSettings;
    return {
      name: row.name,
      username: value.username,
      email: value.email,
      workspace: value.workspace,
      apiToken: "",
      appPassword: "",
    };
  }
  return { name: row.name };
}

export async function updateProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  body: unknown,
): Promise<{ provider: GitProviderView; authorizeUrl: string | null; message: string }> {
  const row = await managedProvider(services, actor, providerId);
  const candidate = editedCandidate(services, row, body);
  await checkMovedAddresses(services, actor, candidate);
  const settings = candidate.settings as Record<string, unknown>;
  let status: "pending" | "ready" = row.status;
  let account = row.account_login;
  const testsOnSave =
    row.kind === "bitbucket" ||
    ((row.kind === "gitlab" || row.kind === "gitea") && settings.auth === "token");
  if (testsOnSave) {
    const field =
      row.kind === "bitbucket"
        ? settings.auth === "api_token"
          ? "apiToken"
          : "appPassword"
        : "accessToken";
    account = await testedLogin(() => loginOf(services, candidate), field);
    status = "ready";
  } else if (candidate.reauthorize) {
    status = "pending";
  }
  const updated = await services.db
    .updateTable("git_provider")
    .set({
      name: candidate.name,
      settings: JSON.stringify(settings),
      secrets_sealed: sealProviderSecrets(services, row.id, candidate.secrets),
      status,
      account_login: account,
      ...(testsOnSave ? { last_error: null, connected_at: sql<Date>`now()` } : {}),
      updated_at: sql<Date>`now()`,
    })
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(services, actor, "git-provider.updated", row.id, { kind: row.kind });
  let authorizeUrl: string | null = null;
  if (candidate.reauthorize && (row.kind === "gitlab" || row.kind === "gitea")) {
    authorizeUrl = (await startAuthorization(services, actor, row.id, undefined)).authorizeUrl;
  }
  return {
    provider: await viewOf(services, actor, updated),
    authorizeUrl,
    message: candidate.reauthorize
      ? "Provider saved. Authorize it again to finish."
      : "Provider saved",
  };
}

// ---------------------------------------------------------------- Share and delete (spec 16.1)

export async function shareProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  shared: boolean,
): Promise<{ provider: GitProviderView; message: string }> {
  const row = await usableProvider(services, actor, providerId);
  if (!canShareProvider(actor, row)) {
    throw new AppError(
      "forbidden",
      "Only the person who connected this Git provider can share it with the workspace.",
    );
  }
  const updated = await services.db
    .updateTable("git_provider")
    .set({ shared, updated_at: sql<Date>`now()` })
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await audit(services, actor, shared ? "git-provider.shared" : "git-provider.unshared", row.id);
  return {
    provider: await viewOf(services, actor, updated),
    message: shared ? PROVIDER_SHARED_MESSAGE : PROVIDER_UNSHARED_MESSAGE,
  };
}

export async function deletePlan(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
) {
  const row = await managedProvider(services, actor, providerId);
  const usage = await providerUsage(services.db, actor.workspace.id, row.id);
  const inUse = usage.apps + usage.composeServices > 0;
  return {
    plan: {
      providerId: row.id,
      name: row.name,
      shared: row.shared,
      apps: usage.apps,
      composeServices: usage.composeServices,
      needsUnderstood: inUse,
      warning: inUse ? providerInUseMessage(usage.apps, usage.composeServices) : null,
    },
  };
}

export async function deleteProvider(
  services: ControlServices,
  actor: WorkspaceActor,
  providerId: string,
  understood: boolean,
): Promise<{ deleted: true; message: string; servicesWithoutSource: number }> {
  const row = await managedProvider(services, actor, providerId);
  const usage = await providerUsage(services.db, actor.workspace.id, row.id);
  if (usage.apps + usage.composeServices > 0 && !understood) {
    const message = providerInUseMessage(usage.apps, usage.composeServices);
    throw new AppError("conflict", message, {
      fields: { understood: 'Tick "I understand" to delete it.' },
    });
  }
  await services.db.transaction().execute(async (trx) => {
    // The services keep their repository and branch but no account: "No Git source" (16.1).
    if (usage.serviceIds.length > 0) {
      await trx
        .updateTable("service")
        .set({
          settings: sql<string>`jsonb_set(settings, '{source,providerId}', 'null'::jsonb)`,
          updated_at: new Date(),
        })
        .where("id", "in", usage.serviceIds)
        .execute();
    }
    // Their provider webhooks stop being accepted: pushes would only fail to clone now.
    await trx.deleteFrom("git_service_hook").where("provider_id", "=", row.id).execute();
    await trx
      .deleteFrom("access_scope_item")
      .where("object_kind", "=", "git_account")
      .where("object_id", "=", row.id)
      .execute();
    await trx.deleteFrom("git_provider").where("id", "=", row.id).execute();
  });
  await audit(services, actor, "git-provider.deleted", row.id, {
    kind: row.kind,
    name: row.name,
    servicesWithoutSource: usage.serviceIds.length,
  });
  return {
    deleted: true,
    message:
      row.kind === "github"
        ? "Provider deleted. The GitHub App still exists on GitHub; delete it there if you no longer need it."
        : "Provider deleted",
    servicesWithoutSource: usage.serviceIds.length,
  };
}
