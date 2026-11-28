import {
  GIT_PROVIDER_KINDS,
  GIT_PROVIDER_LABELS,
  type GitProviderKind,
  isConsoleReturnPath,
  isGitProviderKind,
} from "@nearzero/shared/browser";
import type { GitProviderView, ServiceView } from "./data/index.ts";
import type { DashboardContext } from "./page.ts";
import { settingsPath } from "./routes.ts";

/**
 * The console's side of Git providers (spec 16, 6.1, 6.3, 7.1): who sees Settings → Git
 * providers, the address that opens a connect dialog and comes back afterwards, the badges a
 * provider's row carries, and what a service's provider source says in its summary.
 */

export const PROVIDER_ORDER: readonly GitProviderKind[] = GIT_PROVIDER_KINDS;

/** Members who can't connect accounts see the page when one is shared with or granted to them. */
export async function usesGitAccounts(ctx: DashboardContext): Promise<boolean> {
  const { role, capabilities } = ctx.access;
  if (role === "owner" || role === "admin" || capabilities.includes("git.connect-own")) {
    return true;
  }
  try {
    return (await ctx.data.usableGitProviders()).providers.length > 0;
  } catch {
    return false;
  }
}

/** Settings → Git providers with the connect dialog open, coming back to `returnTo` afterwards. */
export function connectPath(workspace: string, kind: GitProviderKind, returnTo?: string): string {
  const query = new URLSearchParams({ connect: kind });
  if (returnTo && isConsoleReturnPath(returnTo)) query.set("return", returnTo);
  return `${settingsPath(workspace, "git-providers")}?${query.toString()}`;
}

/**
 * The ?connect=, ?install= and ?return= of the settings page, checked. `install` names a GitHub
 * provider whose app install page to open at once (the Agent's "Give access on GitHub", C3-01).
 */
export function connectRequest(url: URL): {
  kind: GitProviderKind | null;
  install: string | null;
  returnTo: string | null;
} {
  const kind = url.searchParams.get("connect");
  const install = url.searchParams.get("install");
  const returnTo = url.searchParams.get("return");
  return {
    kind: isGitProviderKind(kind) ? kind : null,
    install: install && /^[0-9a-f-]{36}$/i.test(install) ? install.toLowerCase() : null,
    returnTo: returnTo && isConsoleReturnPath(returnTo) ? returnTo : null,
  };
}

export interface ProviderBadge {
  label: string;
  tone: "neutral" | "warn" | "info";
}

/** "Shared" when not yours, "Action required" while incomplete, "Deprecated" for app passwords. */
export function providerBadges(provider: GitProviderView): ProviderBadge[] {
  const badges: ProviderBadge[] = [];
  if (!provider.mine && provider.shared) badges.push({ label: "Shared", tone: "neutral" });
  if (provider.mine && provider.shared) {
    badges.push({ label: "Shared with workspace", tone: "neutral" });
  }
  if (provider.status === "action_required") {
    badges.push({ label: "Action required", tone: "warn" });
  }
  if (provider.deprecated) badges.push({ label: "Deprecated", tone: "warn" });
  return badges;
}

/** Authorize while incomplete, Reconnect once connected (spec 16.1, GitLab and Gitea). */
export function authorizeLabel(provider: GitProviderView): string {
  return provider.status === "action_required" ? "Authorize" : "Reconnect";
}

export interface SourceFacts {
  source: string;
  branch: string | null;
  repository: string | null;
}

/** What a service's summary says about where its code comes from. */
export function sourceFacts(service: Pick<ServiceView, "settings">): SourceFacts | null {
  const source = service.settings.source as Record<string, unknown> | null | undefined;
  if (source?.type !== "provider") return null;
  const kind = isGitProviderKind(source.provider) ? source.provider : null;
  return {
    source: source.providerId === null || !kind ? "No Git source" : GIT_PROVIDER_LABELS[kind],
    branch: typeof source.branch === "string" ? source.branch : null,
    repository: typeof source.repository === "string" ? source.repository : null,
  };
}

/** The new-application page's address with a provider chosen, for coming back after connecting. */
export function withProvider(path: string, kind: GitProviderKind): string {
  return `${path}?provider=${kind}`;
}
