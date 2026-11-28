import type {
  AgentPolicy,
  AvatarColor,
  AvatarKind,
  Capability,
  InvitableRole,
  Role,
} from "@nearzero/shared";
import type { AstroCookies } from "astro";
import type { AgentData } from "./agent.ts";
import type { BackupData } from "./backups.ts";
import type { GitData } from "./git.ts";
import type { M10Data } from "./m10.ts";
import type { OperationsData, ServiceDeploySummary } from "./operations-types.ts";

/**
 * What console pages read and change. Pages and components only see these shapes. Identity
 * (people, workspaces, members, policies, keys) comes from the control plane's identity API
 * (identity.ts); projects, environments, services and variables from its projects API
 * (projects.ts); the Agent's home and sessions from its Agent API (agent.ts).
 */

export type { Role } from "@nearzero/shared";

export interface DataContext {
  cookies: AstroCookies;
  request: Request;
  url: URL;
  clientAddress?: string | undefined;
}

// ---------- People and workspaces (docs/api/identity.md)

export interface Avatar {
  kind: AvatarKind;
  /** A named color, or any #rrggbb the person picked (spec 4.6). */
  color: AvatarColor | string;
  initials: string;
  imageUrl: string | null;
}

export type OnboardingStep = "workspace" | "invite" | "name";

export interface Viewer {
  id: string;
  email: string;
  emailVerified: boolean;
  /** A new address waiting for its link to be opened; `email` stays in use until then. */
  pendingEmail: string | null;
  /** Whether the server can email a link that confirms an address (30a R1-02). */
  canEmailLinks: boolean;
  /** Empty when none is stored. */
  firstName: string;
  lastName: string;
  /** "First Last", or the email when there is no name. */
  name: string;
  /** False for empty or email-derived names: greetings say "there" (spec 19.2). */
  hasRealName: boolean;
  avatar: Avatar;
  twoFactor: { enabled: boolean; backupCodesLeft: number };
  /** Owner or admin of the first workspace (spec 22.1). */
  isInstanceAdmin: boolean;
  onboardingStep: OnboardingStep | null;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  /** The untouched "My Workspace" placeholder. */
  personal: boolean;
  /** The install's first workspace. */
  first: boolean;
  role: Role;
}

export interface WorkspaceRights {
  rename: boolean;
  manageMembers: boolean;
  managePolicies: boolean;
  manageAgentPolicies: boolean;
  manageApiKeys: boolean;
  manageEmail: boolean;
  addWithPassword: boolean;
  /** Whether Tasks is for this person: the sidebar hides it otherwise (spec 12.1, R3-31). */
  tasks: boolean;
}

export interface WorkspaceAccess {
  role: Role;
  isInstanceAdmin: boolean;
  /** The person's own effective capabilities (every one for owners and admins). */
  capabilities: Capability[];
  can: WorkspaceRights;
}

export type NextStep =
  | { kind: "invitation"; invitationId: string; workspaceName: string }
  | { kind: "onboarding"; step: OnboardingStep }
  | { kind: "home" };

export type SessionInfo =
  | { signedIn: false; hasOwner: boolean }
  | { signedIn: true; viewer: Viewer; workspace: WorkspaceSummary | null; next: NextStep };

export interface PendingInvitation {
  id: string;
  workspaceName: string;
  role: Role;
  expiresAt: Date;
  /** Who sent it, by their real name, or null (30a R1-09). */
  inviterName?: string | null;
}

/** What /invitations/inspect says about a token. */
export type InvitationInspection =
  | { state: "not_found" }
  | {
      state: "pending" | "expired" | "cancelled" | "accepted";
      workspaceName: string;
      role: Role;
      email: string;
      accountExists?: boolean;
      signedInEmail: string | null;
      forAnotherEmail: boolean;
      /** Who sent it, by their real name, or null (30a R1-09). */
      inviterName?: string | null;
    };

export type SignInOutcome =
  | { status: "signed_in"; next: NextStep }
  | { status: "two_factor_required"; expiresInSeconds: number };

export interface JoinedWorkspace {
  workspace: { id: string; name: string; slug: string };
  message: string;
  next: NextStep;
}

export interface OnboardingView {
  step: OnboardingStep | null;
  suggestedWorkspaceName: string | null;
}

export interface InviteResult {
  email: string;
  emailed: boolean;
  message?: string;
  link?: string;
}

// ---------- Members, invitations, policies (spec 04 4.7)

export interface MemberPerson {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  avatar: Avatar;
}

export interface Member {
  person: MemberPerson;
  role: Role;
  joinedAt: string;
  isYou: boolean;
  /** Whether their address is confirmed (spec 04 4.6). */
  emailConfirmed: boolean;
  access: { everything: boolean; policies: { id: string; name: string }[]; direct: boolean };
}

/** The People tab's members, and whether the viewer may set their addresses (31a G1-02). */
export interface MemberList {
  list: Member[];
  canSetEmail: boolean;
}

export interface WorkspaceInvitation {
  id: string;
  email: string;
  role: InvitableRole;
  state: "pending" | "expired";
  policies: { id: string; name: string }[];
  createdAt: string;
  expiresAt: string;
  lastEmailedAt: string | null;
  invitedBy: { id: string; name: string } | null;
}

export interface AccessScope {
  allProjects: boolean;
  projectIds: string[];
  environmentIds: string[];
  serviceIds: string[];
  allServers: boolean;
  serverIds: string[];
  allGitAccounts: boolean;
  gitAccountIds: string[];
}

export interface AccessPolicy {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  scope: AccessScope;
  holders: { id: string; name: string; email: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface MemberAccess {
  personId: string;
  role: Role;
  policies: { id: string; name: string }[];
  direct: { capabilities: Capability[]; scope: AccessScope };
  effective: {
    capabilities: { key: Capability; from: string[] }[];
    allProjects: boolean;
    allServers: boolean;
    allGitAccounts: boolean;
  };
}

export interface EmailSettings {
  on: boolean;
  source: "workspace" | "instance" | "none";
  detail: string;
  workspace: null | {
    provider: "resend" | "smtp";
    sender: string;
    maskedSecret: string | null;
    secretReadable: boolean;
    smtp: {
      host: string;
      port: number;
      security: "tls" | "starttls" | "none";
      username: string;
    } | null;
    savedAt: string;
    savedBy: { id: string; name: string } | null;
  };
  canManage: boolean;
  canAddWithPassword: boolean;
  /** Why this server's own email settings can't be used, for those who manage email, or null. */
  serverProblem?: string | null;
}

export interface KeyView {
  kind: "model" | "research";
  status: "not_added" | "added" | "unreadable";
  masked: string | null;
  addedAt: string | null;
  addedBy: { id: string; name: string } | null;
}

export interface AgentPolicySettings {
  switches: Record<AgentPolicy, boolean>;
  usingDefaults: boolean;
  savedAt: string | null;
  savedBy: { id: string; name: string } | null;
}

/** A server or Git account a policy can name (empty until M6 and M8). */
export interface ScopeOption {
  id: string;
  name: string;
  detail?: string;
  /** Git accounts shared with everyone: shown ticked and locked. */
  shared?: boolean;
}

// ---------- Projects, environments, services and variables (docs/api/projects.md)

export type ServiceKind =
  | "application"
  | "compose"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongodb"
  | "redis"
  | "libsql";

/** idle: never deployed (every new copy starts there). */
export type ServiceStatus = "idle" | "deploying" | "running" | "stopped" | "failed";

export interface EnvironmentBrief {
  id: string;
  name: string;
  isDefault: boolean;
  isProduction: boolean;
}

export interface ProjectView {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  /** Across all environments, only services the viewer can see. */
  serviceCount: number;
  /** The ones the viewer can open, oldest first. */
  environments: EnvironmentBrief[];
  /** "development", else the default, else the first; null: "No environments available". */
  openEnvironmentId: string | null;
  can: { update: boolean; delete: boolean; createEnvironment: boolean };
}

export interface ProjectList {
  projects: ProjectView[];
  total: number;
  matching: number;
  can: { create: boolean };
}

export interface EnvironmentView {
  id: string;
  projectId: string;
  name: string;
  description: string;
  isDefault: boolean;
  isProduction: boolean;
  serviceCount: number;
  createdAt: Date;
  can: {
    rename: boolean;
    delete: boolean;
    createService: boolean;
    /** Deploy rights on a service created here: Create & deploy (spec 6.1). */
    deployNewService?: boolean;
    sharedVariables: boolean;
  };
}

export interface ServiceView {
  id: string;
  projectId: string;
  environmentId: string;
  kind: ServiceKind;
  kindLabel: string;
  name: string;
  /** The internal name: the chosen part plus "-" and 6 random characters. */
  appName: string;
  description: string;
  status: ServiceStatus;
  /** "host" for the Nearzero host. */
  serverId: string;
  onHost: boolean;
  /** Only what the kind lists as public; never secrets. */
  settings: Record<string, unknown>;
  publicPort: number | null;
  publicPortNote: string | null;
  copyGroupId: string | null;
  deleting: boolean;
  createdAt: Date;
  can: {
    configure: boolean;
    delete: boolean;
    deploy: boolean;
    variables: boolean;
    /** Backups tab / Volume backups section (spec 6.2, 8.3); absent from older answers. */
    backups?: boolean;
  };
  /** The last finished deploy and the one in progress (docs/api/deploys.md, Shapes). */
  deploy?: ServiceDeploySummary;
}

export interface ServiceCopy {
  id: string;
  environmentId: string;
  environmentName: string;
  status: ServiceStatus;
}

export interface ServiceDetail extends ServiceView {
  environment: { id: string; name: string; isProduction: boolean };
  project: { id: string; name: string };
  /** Copies in other environments the viewer can open. */
  copies: ServiceCopy[];
}

/** Where a service can go: the Nearzero host (when the person may use it) or a server. */
export interface ServerTarget {
  id: string;
  name: string;
  readiness: "ready" | "setup_needed" | "setup_running" | "setup_failed" | "inactive";
  host: boolean;
}

/** What a server's record says about where it can be reached, when the viewer can see it. */
export interface ServerBrief {
  id: string;
  name: string;
  /** null when unknown (the Nearzero host until the API says its address). */
  address: string | null;
}

export interface CreatedService {
  service: ServiceView;
  alsoAddedTo: { environmentId: string; environmentName: string; serviceId: string }[];
  notAddedTo: { environmentId: string; environmentName: string; reason: string }[];
  /** "Also added to staging and production, not deployed yet. …", or null. */
  message: string | null;
  notes: string[];
}

export interface MaskedVariables {
  variables: { name: string; empty: boolean }[];
  count: number;
  sizeBytes: number;
  version: number;
  updatedAt: string | null;
  updatedBy: { id: string; name: string } | null;
  /** Saved with another install secret: names known, values lost. */
  unreadable: string | null;
  warnings: { name: string; prefix: string; message: string }[];
}

export interface RevealedVariables {
  text: string;
  rows: { name: string; value: string; line: number; above: string[] }[];
  trailing: string[];
  formProblem: string | null;
  version: number;
}

/** null: "You can't see this environment's variables. …" (the message). */
export type EnvironmentVariablesView =
  | {
      readable: true;
      environment: { id: string; name: string; isProduction: boolean };
      shared: MaskedVariables;
      notice: string | null;
      services: { id: string; name: string; kind: ServiceKind; count: number }[];
      /**
       * `reveal`: the values may be shown (anyone with a service here, C1-20); older control
       * planes don't send it, and there editing was the only way to see them.
       */
      can: { edit: boolean; reveal?: boolean };
      /** Set when the person can't edit: why, and what they can see. */
      message?: string | null;
    }
  | { readable: false; message: string };

export interface ServiceVariablesView {
  service: { id: string; name: string; kind: ServiceKind };
  environment: { id: string; name: string; isProduction: boolean };
  own: MaskedVariables;
  /** null without read rights on the environment's shared variables. */
  shared: {
    variables: { name: string; empty: boolean; overridden: boolean }[];
    count: number;
  } | null;
  can: { edit: boolean; editShared: boolean };
}

export interface DatabaseCredentials {
  user: string | null;
  password: string;
  rootPassword: string | null;
  databaseName: string | null;
}

/** A hostname on a service (spec 10), as the canvas's domain card draws it (lib/domains.ts). */
export interface HostnameView {
  host: string;
  state: "live" | "needs-dns" | "checking";
  /** For "needs-dns": the A record to add. */
  record?: { name: string; value: string };
}

/** A project with its environments and services, for the access trees (spec 04 4.7). */
export interface ProjectTree {
  id: string;
  name: string;
  environments: { id: string; name: string; services: { id: string; name: string }[] }[];
}

/** What starting a deploy answered (docs/api/deploys.md, POST /services/:id/deployments). */
export type DeployStart =
  | {
      status: "started";
      deploymentId: string;
      message: string;
      /** It waits behind the running one. */
      waiting: boolean;
      /** It took the place of one that was already waiting. */
      replaced: boolean;
    }
  | { status: "refused"; message: string; code: string };

// ---------- The two halves of the data module

export interface IdentityData {
  /** Who is signed in, their active workspace and what comes next (memoized per request). */
  session(): Promise<SessionInfo>;
  workspaces(): Promise<{ list: WorkspaceSummary[]; canAdd: boolean }>;
  access(): Promise<WorkspaceAccess>;
  pendingInvitations(): Promise<PendingInvitation[]>;
  switchWorkspace(id: string): Promise<WorkspaceSummary>;

  signIn(input: { email: string; password: string }): Promise<SignInOutcome>;
  verifyCode(code: string): Promise<NextStep>;
  signOut(): Promise<void>;
  register(input: {
    token: string;
    proof?: string | undefined;
    email: string;
    password: string;
  }): Promise<NextStep>;
  inspectInvitation(token: string): Promise<InvitationInspection>;
  /** Opens a link that confirms an email address, as the signed-in account (spec 4.6). */
  confirmEmail(token: string): Promise<{ email: string; changed: boolean; message: string }>;
  acceptInvitation(ref: { token: string } | { id: string }): Promise<JoinedWorkspace>;
  declineInvitation(ref: { token: string } | { id: string }): Promise<{ signedOut: boolean }>;

  onboarding(): Promise<OnboardingView>;
  saveOnboardingWorkspace(input: {
    name: string;
    workspaceName: string;
  }): Promise<{ workspace: { id: string; name: string; slug: string } }>;
  sendOnboardingInvites(emails: string): Promise<InviteResult[]>;
  skipOnboardingInvites(): Promise<void>;
  saveOnboardingName(name: string): Promise<void>;
  updateFirstName(firstName: string): Promise<void>;

  members(): Promise<MemberList>;
  workspaceInvitations(): Promise<WorkspaceInvitation[]>;
  policies(): Promise<AccessPolicy[]>;
  emailSettings(): Promise<EmailSettings>;
  keys(): Promise<KeyView[]>;
  agentPolicies(): Promise<AgentPolicySettings>;
  /** Every project with its environments and services, for the access trees. */
  scopeProjects(): Promise<ProjectTree[]>;
  /** Servers and Git accounts a policy can name; empty until those areas exist. */
  scopeServers(): Promise<ScopeOption[]>;
  scopeGitAccounts(): Promise<ScopeOption[]>;
}

export interface ProjectData {
  projects(sort?: string): Promise<ProjectList>;
  /** null: not found, or out of the person's sight (they look the same). */
  project(projectId: string): Promise<ProjectView | null>;
  createProject(input: {
    name: string;
    description: string;
  }): Promise<{ project: ProjectView; environmentId: string; message: string }>;
  updateProject(projectId: string, input: { name: string; description: string }): Promise<void>;
  environments(projectId: string): Promise<{ list: EnvironmentView[]; canCreate: boolean }>;
  services(environmentId: string): Promise<{ list: ServiceView[]; canCreate: boolean }>;
  service(serviceId: string): Promise<ServiceDetail | null>;
  environmentVariables(environmentId: string): Promise<EnvironmentVariablesView>;
  serviceVariables(serviceId: string): Promise<ServiceVariablesView>;
  /** Where a new service can go (spec 08 8.1, 06 6.1). */
  targets(): Promise<ServerTarget[]>;
  /** A server's name and address; the host's address is unknown to the console. */
  server(serverId: string): Promise<ServerBrief | null>;
  /** Starts a deploy; see lib/deploys.ts, the one place that knows the deploy API. */
  deploy(serviceId: string): Promise<DeployStart>;
}

export interface ConsoleData
  extends IdentityData,
    ProjectData,
    GitData,
    BackupData,
    OperationsData,
    M10Data,
    AgentData {}
