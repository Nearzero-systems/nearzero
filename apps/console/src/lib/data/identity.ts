import { SESSION_COOKIE } from "@nearzero/shared";
import { ApiError } from "../api-error.ts";
import { ControlClient } from "../control-client.ts";
import type {
  AccessPolicy,
  AgentPolicySettings,
  Avatar,
  DataContext,
  EmailSettings,
  IdentityData,
  InvitationInspection,
  InviteResult,
  JoinedWorkspace,
  KeyView,
  Member,
  NextStep,
  OnboardingStep,
  OnboardingView,
  PendingInvitation,
  ProjectTree,
  SessionInfo,
  SignInOutcome,
  Viewer,
  WorkspaceAccess,
  WorkspaceInvitation,
  WorkspaceSummary,
} from "./types.ts";

/**
 * People, workspaces and access from the control plane's identity API (docs/api/identity.md).
 * Reads are remembered for the request; the browser's own changes on settings pages go straight
 * to /api/v1 through the console's proxy instead (client/api.ts).
 */

interface ApiMe {
  id: string;
  email: string;
  emailVerified: boolean;
  pendingEmail?: string | null;
  canEmailLinks?: boolean;
  firstName: string | null;
  lastName: string | null;
  name: string;
  hasRealName: boolean;
  avatar: Avatar;
  twoFactor: { enabled: boolean; backupCodesLeft: number };
  isInstanceAdmin: boolean;
  onboarding: { step: OnboardingStep | null };
}

type ApiSession =
  | { signedIn: false; setup: { hasOwner: boolean } }
  | { signedIn: true; person: ApiMe; workspace: WorkspaceSummary | null; next: NextStep };

export function viewerFrom(me: ApiMe): Viewer {
  return {
    id: me.id,
    email: me.email,
    emailVerified: me.emailVerified,
    pendingEmail: me.pendingEmail ?? null,
    // An older control plane always sent links when it could.
    canEmailLinks: me.canEmailLinks ?? true,
    firstName: me.firstName ?? "",
    lastName: me.lastName ?? "",
    name: me.name,
    hasRealName: me.hasRealName,
    avatar: me.avatar,
    twoFactor: me.twoFactor,
    isInstanceAdmin: me.isInstanceAdmin,
    onboardingStep: me.onboarding.step,
  };
}

function ref(input: { token: string } | { id: string }) {
  return "token" in input
    ? { path: "/invitations", body: { token: input.token } }
    : { path: `/me/invitations/${encodeURIComponent(input.id)}`, body: undefined };
}

export function identityData(ctx: DataContext): IdentityData {
  const api = new ControlClient(ctx);
  let session: Promise<SessionInfo> | null = null;

  const loadSession = async (): Promise<SessionInfo> => {
    const raw = await api.get<ApiSession>("/auth/session");
    if (!raw.signedIn) return { signedIn: false, hasOwner: raw.setup.hasOwner };
    return {
      signedIn: true,
      viewer: viewerFrom(raw.person),
      workspace: raw.workspace,
      next: raw.next,
    };
  };

  const fresh = () => {
    session = null;
  };

  return {
    session() {
      session ??= loadSession();
      return session;
    },
    async workspaces() {
      const result = await api.get<{ workspaces: WorkspaceSummary[]; canAdd: boolean }>(
        "/workspaces",
      );
      return { list: result.workspaces, canAdd: result.canAdd };
    },
    async access(): Promise<WorkspaceAccess> {
      const result = await api.get<
        Partial<WorkspaceAccess> & Omit<WorkspaceAccess, "capabilities">
      >("/workspace");
      return {
        role: result.role,
        isInstanceAdmin: result.isInstanceAdmin,
        capabilities: result.capabilities ?? [],
        can: result.can,
      };
    },
    async pendingInvitations(): Promise<PendingInvitation[]> {
      const result = await api.get<{
        invitations: {
          id: string;
          workspaceName: string;
          role: PendingInvitation["role"];
          expiresAt: string;
          inviterName?: string | null;
        }[];
      }>("/me/invitations");
      return result.invitations.map((item) => ({ ...item, expiresAt: new Date(item.expiresAt) }));
    },
    async switchWorkspace(id) {
      const result = await api.post<{ workspace: WorkspaceSummary }>(
        `/workspaces/${encodeURIComponent(id)}/switch`,
      );
      fresh();
      return result.workspace;
    },

    async signIn(input): Promise<SignInOutcome> {
      const result = await api.post<SignInOutcome>("/auth/sign-in", input);
      fresh();
      return result;
    },
    async verifyCode(code) {
      const result = await api.post<{ next: NextStep }>("/auth/two-factor", { code });
      fresh();
      return result.next;
    },
    async signOut() {
      if (api.hasCookie(SESSION_COOKIE)) await api.post("/auth/sign-out");
      fresh();
    },
    async register(input) {
      const body: Record<string, string> = {
        token: input.token,
        email: input.email,
        password: input.password,
      };
      if (input.proof) body.proof = input.proof;
      const result = await api.post<{ next: NextStep }>("/auth/register", body);
      fresh();
      return result.next;
    },
    inspectInvitation(token) {
      return api.post<InvitationInspection>("/invitations/inspect", { token });
    },
    async confirmEmail(token) {
      const result = await api.post<{ email: string; changed: boolean; message: string }>(
        "/me/email/confirm",
        { token },
      );
      fresh();
      return result;
    },
    async acceptInvitation(input) {
      const target = ref(input);
      const result = await api.post<JoinedWorkspace>(`${target.path}/accept`, target.body);
      fresh();
      return result;
    },
    async declineInvitation(input) {
      const target = ref(input);
      const result = await api.post<{ signedOut: boolean }>(`${target.path}/decline`, target.body);
      fresh();
      return { signedOut: result.signedOut };
    },

    async onboarding(): Promise<OnboardingView> {
      return api.get<OnboardingView>("/onboarding");
    },
    async saveOnboardingWorkspace(input) {
      const result = await api.post<{ workspace: { id: string; name: string; slug: string } }>(
        "/onboarding/workspace",
        input,
      );
      fresh();
      return result;
    },
    async sendOnboardingInvites(emails) {
      const result = await api.post<{ results: InviteResult[] }>("/onboarding/invitations", {
        emails,
      });
      fresh();
      return result.results;
    },
    async skipOnboardingInvites() {
      await api.post("/onboarding/skip-invitations");
      fresh();
    },
    async saveOnboardingName(name) {
      await api.post("/onboarding/name", { name });
      fresh();
    },
    async updateFirstName(firstName) {
      await api.patch("/me", { firstName });
      fresh();
    },

    async members() {
      const result = await api.get<{ members: Member[]; canSetEmail?: boolean }>(
        "/workspace/members",
      );
      return { list: result.members, canSetEmail: result.canSetEmail === true };
    },
    async workspaceInvitations() {
      return (await api.get<{ invitations: WorkspaceInvitation[] }>("/workspace/invitations"))
        .invitations;
    },
    async policies() {
      return (await api.get<{ policies: AccessPolicy[] }>("/workspace/policies")).policies;
    },
    emailSettings() {
      return api.get<EmailSettings>("/workspace/email");
    },
    async keys() {
      return (await api.get<{ keys: KeyView[] }>("/workspace/keys")).keys;
    },
    agentPolicies() {
      return api.get<AgentPolicySettings>("/workspace/agent-policies");
    },
    async scopeProjects(): Promise<ProjectTree[]> {
      // The projects API (docs/api/projects.md): every project, environment and service the
      // person can see. An install without it yet shows an empty tree rather than failing.
      try {
        const { projects } = await api.get<{ projects: { id: string; name: string }[] }>(
          "/projects?sort=name-asc",
        );
        return await Promise.all(
          projects.map(async (project) => {
            const { environments } = await api.get<{
              environments: { id: string; name: string }[];
            }>(`/projects/${encodeURIComponent(project.id)}/environments`);
            return {
              id: project.id,
              name: project.name,
              environments: await Promise.all(
                environments.map(async (environment) => {
                  const { services } = await api.get<{ services: { id: string; name: string }[] }>(
                    `/environments/${encodeURIComponent(environment.id)}/services`,
                  );
                  return {
                    id: environment.id,
                    name: environment.name,
                    services: services.map((service) => ({ id: service.id, name: service.name })),
                  };
                }),
              ),
            };
          }),
        );
      } catch (error) {
        if (error instanceof ApiError && error.code === "control_unreachable") throw error;
        return [];
      }
    },
    // Servers (M6) have no API yet: the list is empty until then.
    async scopeServers() {
      return [];
    },
    // Git accounts (M8): shared ones show ticked and locked in the policy dialog (spec 4.7).
    async scopeGitAccounts() {
      try {
        const { providers } = await api.get<{
          providers: {
            id: string;
            name: string;
            kindLabel: string;
            shared: boolean;
            owner: { name: string } | null;
          }[];
        }>("/git-providers");
        return providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          detail: provider.owner
            ? `${provider.kindLabel} · ${provider.owner.name}`
            : provider.kindLabel,
          shared: provider.shared,
        }));
      } catch (error) {
        if (error instanceof ApiError && error.code === "control_unreachable") throw error;
        return [];
      }
    },
  };
}
