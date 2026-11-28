/**
 * Roles, capabilities and Agent policies: the vocabulary of who may do what (spec 04 4.7,
 * spec 19 19.9, spec 22). Shared so the console's dialogs and the control plane's checks use the
 * same keys and labels.
 */

export const ROLES = ["owner", "admin", "member"] as const;
export type Role = (typeof ROLES)[number];

/** Roles an invitation or "Add user" may give. The owner role is never given away. */
export const INVITABLE_ROLES = ["admin", "member"] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

/** 0.1.79's groups and names (31a G1-06, the decision in spec 31; spec 04 4.7 and 21.10). */
export const CAPABILITY_GROUPS = [
  "Projects and services",
  "Git and SSH",
  "Servers",
  "Backups",
  "Notifications",
  "Workspace settings",
] as const;
export type CapabilityGroup = (typeof CAPABILITY_GROUPS)[number];

/**
 * The 1.0 capability catalog. Each adds a right on top of a member's defaults; owners and admins
 * already have all of them. Keys are stored, so they never change once released.
 */
export const CAPABILITIES = {
  "projects.create": {
    group: "Projects and services",
    label: "Create projects",
    hint: "Start new projects. They get access to the projects they create.",
  },
  "projects.delete": {
    group: "Projects and services",
    label: "Delete projects",
    hint: "Delete projects they can reach.",
  },
  "environments.create": {
    group: "Projects and services",
    label: "Create environments",
    hint: "Add environments to projects they can reach.",
  },
  "environments.delete": {
    group: "Projects and services",
    label: "Delete environments",
    hint: "Delete environments they can reach.",
  },
  "services.create": {
    group: "Projects and services",
    label: "Create services",
    hint: "Add apps, Compose stacks and databases to environments they can reach.",
  },
  "services.delete": {
    group: "Projects and services",
    label: "Delete services",
    hint: "Delete services they can reach.",
  },
  "git.connect-own": {
    group: "Git and SSH",
    label: "Connect their own Git accounts",
    hint: "Connect GitHub, GitLab, Gitea or Bitbucket accounts of their own, deploy from them and remove them. Other people's accounts stay private unless shared or granted below.",
  },
  "ssh-keys.use": {
    group: "Git and SSH",
    label: "Use the workspace's SSH keys",
    hint: "See the workspace's SSH keys and use them for Git and servers.",
  },
  "ssh-keys.manage": {
    group: "Git and SSH",
    label: "Add and remove SSH keys",
    hint: "Add SSH keys to the workspace and remove them.",
  },
  "servers.manage": {
    group: "Servers",
    label: "Add and remove servers",
    hint: "Add servers to the workspace, set them up and remove them. They can deploy to the servers they add.",
  },
  "backups.use-destinations": {
    group: "Backups",
    label: "Back up to the workspace's destinations",
    hint: "Choose the workspace's backup destinations when backing up services they can reach.",
  },
  "backups.manage-destinations": {
    group: "Backups",
    label: "Add and remove backup destinations",
    hint: "Add S3-compatible backup destinations, test them and remove them.",
  },
  "notifications.manage": {
    group: "Notifications",
    label: "Manage notification channels",
    hint: "Add, change and remove the workspace's notification channels (Slack, Discord, email and others).",
  },
  "certificates.manage": {
    group: "Workspace settings",
    label: "Manage certificates",
    hint: "Add, change and remove TLS certificates.",
  },
  "dns.manage": {
    group: "Workspace settings",
    label: "Manage DNS",
    hint: "Add and remove the DNS zones Nearzero manages, and change the environments' default domains.",
  },
  "router-files.read": {
    group: "Workspace settings",
    label: "See Traefik files",
    hint: "Read the Traefik configuration files.",
  },
} as const satisfies Record<string, { group: CapabilityGroup; label: string; hint: string }>;

/** The intro above the capabilities: in a member's access dialog, and in a policy's (31a G1-05). */
export const CAPABILITIES_INTRO = {
  member: "Everyone can open and deploy the projects and services they're given. These add more.",
  policy:
    "Members with this policy can open and deploy the projects and services below. These add more.",
} as const;

export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_KEYS = Object.keys(CAPABILITIES) as Capability[];

export function isCapability(value: string): value is Capability {
  return Object.hasOwn(CAPABILITIES, value);
}

/** Kinds of objects an access policy's scope can name (spec 04 4.7). */
export const SCOPE_KINDS = ["project", "environment", "service", "server", "git_account"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

/** Limits on access policies (spec 04 4.7). */
export const POLICY_LIMITS = {
  perWorkspace: 100,
  nameMax: 60,
  descriptionMax: 240,
} as const;

/** A workspace holds at most this many members (spec 04 4.5). */
export const MEMBER_LIMIT = 100;

export const AGENT_POLICY_GROUPS = [
  "Projects",
  "Apps and services",
  "SSH keys",
  "Servers and access",
  "Production",
] as const;

/**
 * The Agent's switches per workspace, with the defaults that apply to new workspaces and to
 * workspaces that never saved the page (spec 19 19.9).
 */
export const AGENT_POLICIES = {
  "projects.create": { group: "Projects", label: "Create projects", default: true },
  "projects.rename": {
    group: "Projects",
    label: "Rename and describe projects (also covers creating environments)",
    default: true,
  },
  "projects.delete-without-production": {
    group: "Projects",
    label: "Delete projects without production",
    default: false,
  },
  "services.configure": {
    group: "Apps and services",
    label: "Create and configure services",
    default: true,
  },
  "services.import-git": {
    group: "Apps and services",
    label: "Import from Git (needs Create and configure)",
    default: true,
  },
  "services.assign-domains": {
    group: "Apps and services",
    label: "Assign domains (needs Create and configure)",
    default: true,
  },
  "services.deploy": {
    group: "Apps and services",
    label: "Deploy and run services",
    default: true,
  },
  "tasks.run": { group: "Apps and services", label: "Create and run tasks", default: true },
  "ssh-keys.add": {
    group: "SSH keys",
    label: "Add SSH keys (through the secure form)",
    default: true,
  },
  "ssh-keys.read": { group: "SSH keys", label: "Read SSH keys", default: false },
  "ssh-keys.rename": { group: "SSH keys", label: "Rename SSH keys", default: false },
  "ssh-keys.delete": { group: "SSH keys", label: "Delete SSH keys", default: false },
  "servers.setup": {
    group: "Servers and access",
    label: "Add and set up servers (also covers editing servers and running setup)",
    default: true,
  },
  "servers.remove": { group: "Servers and access", label: "Remove servers", default: false },
  "keys.ask-model-key": {
    group: "Servers and access",
    label: "Ask for the OpenRouter key in chat",
    default: true,
  },
  production: { group: "Production", label: "Change production environments", default: false },
} as const satisfies Record<
  string,
  { group: (typeof AGENT_POLICY_GROUPS)[number]; label: string; default: boolean }
>;

export type AgentPolicy = keyof typeof AGENT_POLICIES;
export const AGENT_POLICY_KEYS = Object.keys(AGENT_POLICIES) as AgentPolicy[];
export type AgentPolicySwitches = Record<AgentPolicy, boolean>;

/**
 * One line per switch on Settings → Agent policies: what it lets the Agent do, in the words of
 * the visual reference (spec 19.9, 21.10). Rollbacks are not in 1.0, so "Deploy and run
 * services" doesn't mention them.
 */
export const AGENT_POLICY_DESCRIPTIONS: Record<AgentPolicy, string> = {
  "projects.create": "Create a new project when you ask for one.",
  "projects.rename": "Change a project's name and description.",
  "projects.delete-without-production":
    "Delete a project and wipe its services from their servers when you ask, only if none of its environments is production. You confirm the list of services first.",
  "services.configure":
    "Create apps from Docker images, Compose services and databases, and change their build, ports, mounts and auto deploy. Git imports and domains below need this on.",
  "services.import-git":
    "Read your connected Git providers, repositories and branches, and create apps from them or from a Git URL.",
  "services.assign-domains": "Attach a domain to a service.",
  "services.deploy": "Deploy, redeploy, start, stop and restart services.",
  "tasks.run":
    "Create, change and run scheduled tasks. You paste each script in a form in the chat; the Agent never writes or sees it until it's saved.",
  "ssh-keys.add":
    "Show a secure form in the chat to generate or paste a key when one is needed. Only the key's name reaches the Agent.",
  "ssh-keys.read":
    "List saved keys by name and fingerprint, so the Agent can pick one for a server or a private repository.",
  "ssh-keys.rename": "Change a saved key's name or description. The key itself never changes.",
  "ssh-keys.delete": "Delete a saved key when you ask. Keys a server still uses are refused.",
  "servers.setup":
    "Add a server you name and run server setup on it (Docker, Traefik, monitoring).",
  "servers.remove":
    "Remove a server from Nearzero when you ask. Servers that still run services are refused.",
  "keys.ask-model-key":
    "When no key is added, an owner or admin can paste it right in the chat. When off, keys are added only in API keys.",
  production:
    "Let the policies above apply to environments marked production too. When off, the Agent can read production and plan changes, but can't deploy, create or change anything there.",
};

/** The SSH keys group's short intro on Settings → Agent policies (spec 19.9, 21.10). */
export const AGENT_POLICY_SSH_KEYS_INTRO =
  "What the Agent may do with the organization's SSH keys. It never sees a private key: keys are added through a secure form in the chat and saved straight to the key store.";

/** Policies that only work together with "Create and configure services". */
export const AGENT_POLICIES_NEEDING_CONFIGURE: readonly AgentPolicy[] = [
  "services.import-git",
  "services.assign-domains",
];

/** Typed to turn on production changes; the control plane checks it too (spec 19 19.9). */
export const PRODUCTION_CONFIRMATION_PHRASE = "ALLOW PRODUCTION AGENT ACTIONS";

export function defaultAgentPolicies(): AgentPolicySwitches {
  const result = {} as AgentPolicySwitches;
  for (const key of AGENT_POLICY_KEYS) result[key] = AGENT_POLICIES[key].default;
  return result;
}
