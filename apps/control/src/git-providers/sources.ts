import {
  AppError,
  GIT_PROVIDER_LABELS,
  type GitProviderKind,
  NO_GIT_SOURCE,
  type ProviderSourceRequest,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { randomToken } from "../security/tokens.ts";
import {
  type AppSecrets,
  type AppSource,
  readAppSettings,
  readSource,
} from "../service-runtime/app-settings.ts";
import { serviceForAction } from "../service-runtime/runtime.ts";
import {
  type ServiceRow,
  type ServiceView,
  secretsContext,
  serviceView,
} from "../services/records.ts";
import type { ControlServices } from "../services.ts";
import { currentWebhookToken, replaceWebhookToken, webhookUrl } from "../webhooks/tokens.ts";
import type { CloneAccess, RepositorySummary } from "./client.ts";
import { clientFor, withProvider } from "./clients.ts";
import { ProviderError } from "./http.ts";
import { loadProviderRow, type ProviderRow, providerTarget, usableProvider } from "./records.ts";

/**
 * Services that deploy from a connected provider (spec 6.3 provider tabs, 7.1 "From a
 * repository", 16.6): saving the source, what the Source panel shows, disconnecting, the deploy
 * engine's clone credentials, and the provider webhook that GitLab, Bitbucket and Gitea pushes
 * arrive on (registered with the connected token where the host allows it, else added by hand).
 */

export type ProviderSource = Extract<AppSource, { type: "provider" }>;

type HookKind = Exclude<GitProviderKind, "github">;

function isHookKind(kind: GitProviderKind): kind is HookKind {
  return kind !== "github";
}

export const PROVIDER_GONE =
  "This service's Git provider was deleted, so it has no Git source. Pick an account in its Source panel, then deploy.";

/**
 * The deploy engine's seam (docs/api/deploys.md, "Git providers"): short-lived credentials and
 * the clean clone address for one deploy. Throws an Error whose message is for the deploy log.
 */
export async function providerCloneAccess(
  services: ControlServices,
  workspaceId: string,
  source: ProviderSource,
): Promise<CloneAccess> {
  if (!source.providerId) throw new Error(PROVIDER_GONE);
  const row = await loadProviderRow(services.db, workspaceId, source.providerId);
  if (!row) throw new Error(PROVIDER_GONE);
  if (row.status !== "ready") {
    throw new Error(
      `The ${GIT_PROVIDER_LABELS[row.kind]} provider "${row.name}" isn't connected right now. Finish connecting it in Settings → Git providers, then deploy.`,
    );
  }
  try {
    const client = clientFor(services, row);
    const repository = await client.getRepository(source.repository);
    return await client.cloneAccess(repository);
  } catch (error) {
    if (error instanceof ProviderError || error instanceof AppError) {
      throw new Error((error as Error).message);
    }
    throw error;
  }
}

/** The provider source of a service, if it has one. */
export function providerSourceOf(settings: Record<string, unknown> | null): ProviderSource | null {
  const source = readSource(settings?.source);
  return source?.type === "provider" ? source : null;
}

const KINDS_WITH_SOURCES = new Set(["application", "compose"]);

async function serviceToConfigure(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<ServiceRow> {
  const row = await serviceForAction(services, actor, serviceId, "service.configure");
  if (!KINDS_WITH_SOURCES.has(row.kind)) {
    throw new AppError(
      "conflict",
      "Only applications and Compose services deploy from a Git repository.",
    );
  }
  return row;
}

async function saveSettings(
  services: ControlServices,
  actor: WorkspaceActor,
  row: ServiceRow,
  settings: Record<string, unknown>,
  details: Record<string, unknown>,
): Promise<ServiceView> {
  // A Git source never uses a registry password; drop one left from an image source.
  let sealed: string | undefined;
  if (row.kind === "application") {
    const current = await services.db
      .selectFrom("service")
      .select("secrets_sealed")
      .where("id", "=", row.id)
      .executeTakeFirstOrThrow();
    if (current.secrets_sealed) {
      const opened = services.secrets.open(current.secrets_sealed, secretsContext(row.id));
      if (opened.ok) {
        const secrets = JSON.parse(opened.value) as AppSecrets;
        if (secrets.registryPassword !== undefined) {
          delete secrets.registryPassword;
          sealed = services.secrets.seal(JSON.stringify(secrets), secretsContext(row.id));
        }
      }
    }
  }
  const saved = await services.db
    .updateTable("service")
    .set({
      settings: JSON.stringify(settings),
      ...(sealed ? { secrets_sealed: sealed } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", row.id)
    .returningAll()
    .executeTakeFirstOrThrow();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "service.source-changed",
    workspaceId: actor.workspace.id,
    target: { kind: "service", id: row.id },
    details,
  });
  return serviceView(saved, actor.access);
}

export interface PushSetup {
  /** "app": GitHub's app webhook needs nothing; "webhook": GitLab, Bitbucket and Gitea. */
  mode: "app" | "webhook";
  status: "automatic" | "registered" | "manual" | "stale" | "none";
  message: string;
}

export async function saveProviderSource(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
  input: ProviderSourceRequest,
): Promise<{ service: ServiceView; notes: string[]; push: PushSetup }> {
  const row = await serviceToConfigure(services, actor, serviceId);
  const provider = await usableProvider(services, actor, input.providerId);
  if (provider.status !== "ready") {
    throw new AppError(
      "conflict",
      "This Git provider isn't connected yet. Finish connecting it in Settings → Git providers.",
      { fields: { providerId: "Finish connecting this account first." } },
    );
  }
  const repository = await withProvider(services, provider, (client) =>
    client.getRepository(input.repository),
  );
  const previous = readSource(row.settings?.source);
  const branch = input.branch || repository.defaultBranch || "main";
  const source: ProviderSource = {
    type: "provider",
    providerId: provider.id,
    provider: provider.kind as GitProviderKind,
    repository: repository.fullName,
    repositoryId: repository.id || null,
    branch,
    buildPath: row.kind === "application" ? input.buildPath : "",
    composePath: row.kind === "compose" ? input.composePath : null,
    trigger: input.trigger,
    watchPaths: input.watchPaths,
    submodules: input.submodules,
  };
  const settings: Record<string, unknown> = { ...(row.settings ?? {}), source };
  // A new Git source turns Autodeploy on (spec 6.6: on by default for Git sources).
  if (previous?.type !== "git" && previous?.type !== "provider") {
    settings.deploy = { ...readAppSettings(row.settings).deploy, autodeploy: true };
  }
  const service = await saveSettings(services, actor, row, settings, {
    type: "provider",
    provider: provider.kind,
    repository: repository.fullName,
  });
  const notes: string[] = [];
  if (!input.branch && repository.defaultBranch) {
    notes.push(`Using the repository's default branch, ${repository.defaultBranch}.`);
  }
  let push: PushSetup;
  const kind = provider.kind as GitProviderKind;
  if (isHookKind(kind)) {
    push = await registerHook(services, actor, row, provider, repository, source);
  } else {
    await removeHook(services, row.id);
    push = {
      mode: "app",
      status: "automatic",
      message: "Pushes arrive through the GitHub App; no webhook is needed.",
    };
  }
  return { service, notes, push };
}

function hookSealContext(serviceId: string): string {
  return `service:${serviceId}:provider-webhook`;
}

async function hookRow(services: ControlServices, serviceId: string) {
  return services.db
    .selectFrom("git_service_hook")
    .selectAll()
    .where("service_id", "=", serviceId)
    .executeTakeFirst();
}

/** The secret a provider's webhook for this service carries, or null without one. */
export async function hookSecret(
  services: ControlServices,
  serviceId: string,
): Promise<{ secret: string; kind: HookKind; repository: string } | null> {
  const row = await hookRow(services, serviceId);
  if (!row) return null;
  const opened = services.secrets.open(row.secret_sealed, hookSealContext(serviceId));
  return opened.ok ? { secret: opened.value, kind: row.kind, repository: row.repository } : null;
}

/**
 * What happened to the webhook Nearzero registered for a service at GitLab, Gitea or Bitbucket
 * when it was removed (spec 16.6): `removed` (or already gone there), `none` (Nearzero never
 * registered one: GitHub, or the person added it by hand), or `failed` with the reason and what
 * to do, since the host would otherwise keep calling a URL that answers 401.
 */
export type WebhookRemoval =
  | { state: "removed" | "none"; message: null }
  | { state: "failed"; message: string };

/**
 * Removes the service's webhook at the provider when Nearzero added it, then the record. Best
 * effort: it never throws, and a failure comes back with the reason.
 */
export async function removeServiceWebhook(
  services: ControlServices,
  serviceId: string,
): Promise<WebhookRemoval> {
  const hook = await hookRow(services, serviceId).catch(() => undefined);
  if (!hook) return { state: "none", message: null };
  let outcome: WebhookRemoval = { state: "none", message: null };
  if (hook.remote_hook_id) {
    const label = GIT_PROVIDER_LABELS[hook.kind];
    const leftOver = (reason: string): WebhookRemoval => ({
      state: "failed",
      message: `The webhook Nearzero added to ${hook.repository} on ${label} couldn't be removed (${reason}). Delete it in the repository's webhook settings on ${label}.`,
    });
    const provider = hook.provider_id
      ? await loadProviderRow(services.db, hook.workspace_id, hook.provider_id).catch(() => null)
      : null;
    if (!provider) {
      outcome = leftOver(`its ${label} provider was deleted`);
    } else if (provider.status !== "ready") {
      outcome = leftOver(`the ${label} provider "${provider.name}" isn't connected`);
    } else {
      try {
        const client = clientFor(services, provider);
        const repository = await client.getRepository(hook.repository);
        await client.removeWebhook?.(repository, hook.remote_hook_id);
        outcome = { state: "removed", message: null };
      } catch (error) {
        if (error instanceof ProviderError && error.failure === "not_found") {
          // The repository (and its webhooks) is gone at the host already.
          outcome = { state: "removed", message: null };
        } else {
          const text = (error as Error)?.message?.replace(/\.$/, "") || "the host refused";
          outcome = leftOver(text);
        }
      }
    }
  }
  await services.db
    .deleteFrom("git_service_hook")
    .where("service_id", "=", serviceId)
    .execute()
    .catch(() => {});
  return outcome;
}

/** Removes the service's webhook at the provider when Nearzero added it, then the record. */
async function removeHook(services: ControlServices, serviceId: string): Promise<void> {
  await removeServiceWebhook(services, serviceId);
}

async function deployWebhookAddress(
  services: ControlServices,
  service: { id: string; workspace_id: string },
  personId: string,
): Promise<string | null> {
  if (!services.gitPublicUrl()) return null;
  const current = await currentWebhookToken(services, service.id);
  const token = current?.token ?? (await replaceWebhookToken(services, service, personId));
  return webhookUrl(services, token);
}

/**
 * Adds the push webhook at GitLab, Bitbucket or Gitea with the connected token when the host
 * allows it (spec 16.6), with a secret only this service's webhook knows. Falls back to the
 * manual steps.
 */
async function registerHook(
  services: ControlServices,
  actor: WorkspaceActor,
  service: ServiceRow,
  provider: ProviderRow,
  repository: RepositorySummary,
  source: ProviderSource,
): Promise<PushSetup> {
  const kind = provider.kind as HookKind;
  const label = GIT_PROVIDER_LABELS[kind];
  const existing = await hookRow(services, service.id);
  const url = await deployWebhookAddress(services, service, actor.personId);
  if (
    existing &&
    existing.status === "registered" &&
    existing.provider_id === provider.id &&
    existing.repository === repository.fullName &&
    existing.registered_url === url
  ) {
    return {
      mode: "webhook",
      status: "registered",
      message: `Pushes to ${repository.fullName} deploy through the webhook Nearzero added on ${label}.`,
    };
  }
  if (existing) await removeHook(services, service.id);
  const secret = randomToken(24);
  let status: "registered" | "manual" = "manual";
  let remoteId: string | null = null;
  let message: string;
  if (!url) {
    message = `This server has no console address, so ${label} has nowhere to send pushes. Set the console's address under About Nearzero, then register the webhook.`;
  } else {
    try {
      const client = clientFor(services, provider);
      remoteId =
        (await client.registerWebhook?.(repository, url, secret, {
          tags: source.trigger === "tag",
        })) ?? null;
      status = remoteId ? "registered" : "manual";
      message = remoteId
        ? `Nearzero added a webhook to ${repository.fullName} on ${label}, so pushes deploy.`
        : `Add the webhook on ${label} with the steps below.`;
    } catch (error) {
      const reason =
        error instanceof ProviderError || error instanceof AppError
          ? (error as Error).message
          : "it refused the request.";
      message = `Nearzero couldn't add the webhook on ${label}: ${reason} Add it by hand with the steps below.`;
    }
  }
  await services.db
    .insertInto("git_service_hook")
    .values({
      service_id: service.id,
      workspace_id: service.workspace_id,
      provider_id: provider.id,
      kind,
      repository: repository.fullName,
      secret_sealed: services.secrets.seal(secret, hookSealContext(service.id)),
      remote_hook_id: remoteId,
      registered_url: status === "registered" ? url : null,
      status,
      message,
    })
    .onConflict((conflict) =>
      conflict.column("service_id").doUpdateSet({
        provider_id: provider.id,
        kind,
        repository: repository.fullName,
        secret_sealed: services.secrets.seal(secret, hookSealContext(service.id)),
        remote_hook_id: remoteId,
        registered_url: status === "registered" ? url : null,
        status,
        message,
        updated_at: sql<Date>`now()`,
      }),
    )
    .execute();
  return { mode: "webhook", status, message };
}

/** Registers the service's provider webhook again (after the URL was replaced, for example). */
export async function reregisterHook(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<{ push: PushSetup }> {
  const row = await serviceToConfigure(services, actor, serviceId);
  const source = providerSourceOf(row.settings);
  if (!source?.providerId) throw new AppError("conflict", NO_GIT_SOURCE);
  if (!isHookKind(source.provider)) {
    return {
      push: {
        mode: "app",
        status: "automatic",
        message: "Pushes arrive through the GitHub App; no webhook is needed.",
      },
    };
  }
  const provider = await usableProvider(services, actor, source.providerId);
  const repository = await withProvider(services, provider, (client) =>
    client.getRepository(source.repository),
  );
  await removeHook(services, row.id);
  return { push: await registerHook(services, actor, row, provider, repository, source) };
}

export async function disconnectSource(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<{ service: ServiceView; message: string }> {
  const row = await serviceToConfigure(services, actor, serviceId);
  const source = readSource(row.settings?.source);
  if (source?.type !== "provider") {
    throw new AppError("conflict", "This service isn't linked to a Git provider.");
  }
  await removeHook(services, row.id);
  const service = await saveSettings(
    services,
    actor,
    row,
    { ...(row.settings ?? {}), source: null },
    { type: null, disconnected: source.repository },
  );
  return { service, message: "Repository disconnected" };
}

function manualSteps(kind: HookKind, trigger: "push" | "tag"): string[] {
  switch (kind) {
    case "gitlab":
      return [
        "In GitLab, open the project, then Settings → Webhooks → Add new webhook.",
        "Paste the URL, and paste the secret into Secret token.",
        trigger === "tag"
          ? "Tick Tag push events, then Add webhook."
          : "Tick Push events, then Add webhook.",
      ];
    case "gitea":
      return [
        "In Gitea, open the repository, then Settings → Webhooks → Add webhook → Gitea.",
        "Paste the URL, set the content type to application/json and paste the secret.",
        "Choose Push events, keep Active ticked, then Add webhook.",
      ];
    case "bitbucket":
      return [
        "In Bitbucket, open the repository, then Repository settings → Webhooks → Add webhook.",
        "Paste the URL and paste the secret into Secret.",
        "Keep Repository push as the trigger, then Save.",
      ];
  }
}

export interface GitSourceView {
  source: ProviderSource | null;
  /** connected; no_access (linked through an account the viewer can't use); no_git_source. */
  state: "connected" | "no_access" | "no_git_source" | "none";
  provider: {
    id: string;
    name: string;
    kind: GitProviderKind;
    kindLabel: string;
    ready: boolean;
  } | null;
  push: PushSetup & {
    /** Only for people with deploy rights (spec 6.6). */
    url: string | null;
    secret: string | null;
    steps: string[];
    hidden: string | null;
  };
  can: { configure: boolean; deploy: boolean };
}

export async function gitSourceView(
  services: ControlServices,
  actor: WorkspaceActor,
  serviceId: string,
): Promise<GitSourceView> {
  const row = await serviceForAction(services, actor, serviceId, "service.see");
  const view = serviceView(row, actor.access);
  const can = { configure: view.can.configure, deploy: view.can.deploy };
  const source = providerSourceOf(row.settings);
  const none = {
    mode: "app" as const,
    status: "none" as const,
    message: "",
    url: null,
    secret: null,
    steps: [],
    hidden: null,
  };
  if (!source) return { source: null, state: "none", provider: null, push: none, can };
  const provider = source.providerId
    ? await loadProviderRow(services.db, actor.workspace.id, source.providerId)
    : null;
  if (!provider) {
    return {
      source,
      state: "no_git_source",
      provider: null,
      push: { ...none, message: NO_GIT_SOURCE },
      can,
    };
  }
  const usable = actor.access.can("git-account.use", providerTarget(provider));
  const providerInfo = {
    id: provider.id,
    name: usable ? provider.name : "An account you can't use",
    kind: provider.kind as GitProviderKind,
    kindLabel: GIT_PROVIDER_LABELS[provider.kind as GitProviderKind],
    ready: provider.status === "ready",
  };
  const state = usable ? "connected" : "no_access";
  if (!isHookKind(source.provider)) {
    return {
      source,
      state,
      provider: providerInfo,
      push: {
        ...none,
        status: "automatic",
        message: "Pushes arrive through the GitHub App; no webhook is needed.",
      },
      can,
    };
  }
  const hook = await hookRow(services, row.id);
  const current = await currentWebhookToken(services, row.id);
  const url = current?.token ? webhookUrl(services, current.token) : null;
  let status: PushSetup["status"] = hook?.status ?? "none";
  const label = GIT_PROVIDER_LABELS[source.provider];
  let message =
    hook?.message ??
    (url
      ? // No secret of its own (a webhook carried over from 0.1.x, say): calls to the URL deploy
        // with its token alone, like any generic webhook (24 G4), until one is registered.
        `Pushes that reach this service's webhook URL deploy with its token alone, without a secret. Register the webhook so ${label} signs each push, then delete any older webhook for this service on ${label}.`
      : `Pushes don't deploy yet: register the webhook, or add it on ${label} with the steps below.`);
  if (hook?.status === "registered" && hook.registered_url !== url) {
    status = "stale";
    message = `The webhook on ${label} still has this service's old URL. Register it again.`;
  }
  let secret: string | null = null;
  if (can.deploy && hook) {
    const opened = services.secrets.open(hook.secret_sealed, hookSealContext(row.id));
    secret = opened.ok ? opened.value : null;
  }
  return {
    source,
    state,
    provider: providerInfo,
    push: {
      mode: "webhook",
      status,
      message,
      url: can.deploy ? url : null,
      secret,
      steps: status === "registered" ? [] : manualSteps(source.provider, source.trigger),
      hidden: can.deploy ? null : "You need permission to deploy this service to see its webhook",
    },
    can,
  };
}
