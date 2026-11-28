import type { GitProviderKind } from "@nearzero/shared/browser";
import { ApiError } from "../api-error.ts";
import { ControlClient } from "../control-client.ts";
import type { DataContext } from "./types.ts";

/**
 * Git providers from the control plane (docs/api/git-providers.md, spec 16): the settings list,
 * the providers a person may use for pickers, a service's provider source, and the return pages
 * that finish connecting after GitHub, GitLab or Gitea send the person back.
 */

export interface GitProviderView {
  id: string;
  kind: GitProviderKind;
  kindLabel: string;
  name: string;
  owner: { id: string; name: string } | null;
  mine: boolean;
  shared: boolean;
  status: "ready" | "action_required";
  statusMessage: string | null;
  deprecated: boolean;
  account: string | null;
  lastError: string | null;
  createdAt: string;
  connectedAt: string | null;
  details: Record<string, unknown>;
  configured: Record<string, boolean>;
  openUrl: string | null;
  can: { share: boolean; edit: boolean; delete: boolean; install: boolean; authorize: boolean };
}

export interface GitProvidersPage {
  providers: GitProviderView[];
  can: { connect: boolean };
  noConnectMessage: string | null;
  console: {
    httpsBase: string | null;
    redirectUris: { gitlab: string | null; gitea: string | null };
  };
  isAdmin: boolean;
}

export interface UsableGitProvider {
  id: string;
  kind: GitProviderKind;
  kindLabel: string;
  name: string;
  account: string | null;
  ready: boolean;
  mine: boolean;
  shared: boolean;
}

export interface ProviderSourceView {
  type: "provider";
  providerId: string | null;
  provider: GitProviderKind;
  repository: string;
  repositoryId: string | null;
  branch: string;
  buildPath: string;
  composePath: string | null;
  trigger: "push" | "tag";
  watchPaths: string[];
  submodules: boolean;
}

export interface GitSourceView {
  source: ProviderSourceView | null;
  state: "connected" | "no_access" | "no_git_source" | "none";
  provider: {
    id: string;
    name: string;
    kind: GitProviderKind;
    kindLabel: string;
    ready: boolean;
  } | null;
  push: {
    mode: "app" | "webhook";
    status: "automatic" | "registered" | "manual" | "stale" | "none";
    message: string;
    url: string | null;
    secret: string | null;
    steps: string[];
    hidden: string | null;
  };
  can: { configure: boolean; deploy: boolean };
}

export interface FlowFinish {
  message: string;
  returnTo: string | null;
}

export interface GitData {
  gitProviders(): Promise<GitProvidersPage>;
  usableGitProviders(): Promise<{ providers: UsableGitProvider[]; canConnect: boolean }>;
  /** null when the service has no provider source, or it can't be read. */
  gitSource(serviceId: string): Promise<GitSourceView | null>;
  completeGithubManifest(code: string, state: string): Promise<{ installUrl: string }>;
  completeGithubInstall(input: {
    installationId: string;
    state: string | null;
    setupAction: string | null;
  }): Promise<FlowFinish>;
  completeOAuth(input: {
    kind: "gitlab" | "gitea";
    code: string;
    state: string;
    error: string | null;
  }): Promise<FlowFinish>;
}

export function gitData(ctx: DataContext): GitData {
  const api = new ControlClient(ctx);
  return {
    gitProviders: () => api.get<GitProvidersPage>("/git-providers"),
    async usableGitProviders() {
      const raw = await api.get<{ providers: UsableGitProvider[]; can: { connect: boolean } }>(
        "/git-providers/usable",
      );
      return { providers: raw.providers, canConnect: raw.can.connect };
    },
    async gitSource(serviceId) {
      try {
        return await api.get<GitSourceView>(
          `/services/${encodeURIComponent(serviceId)}/git-source`,
        );
      } catch (error) {
        if (error instanceof ApiError && error.code !== "control_unreachable") return null;
        throw error;
      }
    },
    async completeGithubManifest(code, state) {
      const raw = await api.post<{ installUrl: string }>(
        "/git-providers/github/manifest/complete",
        {
          code,
          state,
        },
      );
      return { installUrl: raw.installUrl };
    },
    async completeGithubInstall(input) {
      const raw = await api.post<FlowFinish>("/git-providers/github/installations", {
        installationId: input.installationId,
        ...(input.state ? { state: input.state } : {}),
        ...(input.setupAction ? { setupAction: input.setupAction } : {}),
      });
      return { message: raw.message, returnTo: raw.returnTo };
    },
    async completeOAuth(input) {
      const raw = await api.post<FlowFinish>("/git-providers/oauth/complete", {
        kind: input.kind,
        code: input.code,
        state: input.state,
        ...(input.error ? { error: input.error } : {}),
      });
      return { message: raw.message, returnTo: raw.returnTo };
    },
  };
}
