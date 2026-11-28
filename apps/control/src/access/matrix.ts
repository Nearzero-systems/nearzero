import type { Capability, ScopeKind } from "@nearzero/shared";

/**
 * The permission matrix of spec 22.3 (and the instance-administrator rules of 22.2) as data.
 * Every endpoint names one of these actions; {@link decide} in evaluate.ts applies the rule.
 * Later milestones add nothing here except new rows; the rules for each row are already set.
 *
 * Owners and admins reach everything inside their workspace. A member's rule says what they
 * need on top of that:
 * - never: owners and admins only.
 * - always: every member.
 * - capability: the named capability (and, with `within`, the target must be in their scope).
 * - scope: the target must be in their scope ("own services").
 */
export type MemberRule =
  | { kind: "never" }
  | { kind: "always" }
  | { kind: "capability"; capability: Capability; within?: ScopeKind }
  | { kind: "scope"; within: ScopeKind }
  /**
   * Access to the whole object: every service in it, not only some (an environment ticked only
   * as the parent of a granted service doesn't count). Seeing it is still enough to be told no
   * rather than "not found".
   */
  | { kind: "whole"; within: "environment" };

export interface ActionRule {
  /** Finishes "You can't …" in refusals, so it reads as plain words. */
  phrase: string;
  member: MemberRule;
  /** Instance administrators only (spec 22.2). */
  instanceAdmin?: InstanceAdminRule;
}

export interface InstanceAdminRule {
  /** The refusal for someone who isn't an instance administrator. */
  refusal: string;
  /**
   * When set, the person must also be an owner or admin of the workspace the action is in, and
   * this is the refusal otherwise. That check comes first when `roleFirst` is true.
   */
  workspaceAdminRefusal?: string;
  roleFirst?: boolean;
  /** Also allowed in a workspace an instance administrator allowed on the host (spec 24 G3). */
  orAllowedWorkspace?: boolean;
}

const WORKSPACES_REFUSAL = "Only Nearzero administrators can add, rename or delete workspaces.";

const never: MemberRule = { kind: "never" };
const capability = (cap: Capability, within?: ScopeKind): MemberRule =>
  within
    ? { kind: "capability", capability: cap, within }
    : { kind: "capability", capability: cap };
const scope = (within: ScopeKind): MemberRule => ({ kind: "scope", within });

export const ACTIONS = {
  // Projects, environments and services.
  "project.see": { phrase: "see this project", member: scope("project") },
  "project.create": { phrase: "create projects", member: capability("projects.create") },
  "project.delete": {
    phrase: "delete this project",
    member: capability("projects.delete", "project"),
  },
  // Not a row of spec 22.3: renaming and describing go with the right to create them.
  "project.update": {
    phrase: "rename or describe this project",
    member: capability("projects.create", "project"),
  },
  "environment.see": { phrase: "see this environment", member: scope("environment") },
  "environment.create": {
    phrase: "create environments in this project",
    member: capability("environments.create", "project"),
  },
  "environment.delete": {
    phrase: "delete this environment",
    member: capability("environments.delete", "environment"),
  },
  "environment.update": {
    phrase: "rename or describe this environment",
    member: capability("environments.create", "environment"),
  },
  // Shared values reach every service of the environment, so editing them needs access to all
  // of it (B1-33). Anyone who can see the environment sees their names, and anyone with a
  // service there their values (the C1-20 decision in spec 31; variables/editor.ts).
  "environment.shared-variables": {
    phrase: "edit this environment's shared variables",
    member: { kind: "whole", within: "environment" },
  },
  "service.see": { phrase: "see this service", member: scope("service") },
  "service.create": {
    phrase: "create services in this environment",
    member: capability("services.create", "environment"),
  },
  "service.delete": {
    phrase: "delete this service",
    member: capability("services.delete", "service"),
  },
  "service.deploy": {
    phrase: "deploy, start, stop, reload or cancel this service, or open its terminal",
    member: scope("service"),
  },
  "service.configure": {
    phrase: "change this service's settings",
    member: capability("services.create", "service"),
  },
  "service.variables": { phrase: "edit this service's variables", member: scope("service") },
  "service.hostnames": {
    phrase: "add or remove this service's hostnames",
    member: scope("service"),
  },
  "service.backups": {
    phrase: "manage this service's backups",
    member: scope("service"),
  },
  "service.restore": { phrase: "restore this service's backups", member: scope("service") },
  "service.tasks": { phrase: "manage this service's tasks", member: scope("service") },
  "service.deployments": {
    phrase: "see this service's deployments and logs",
    member: scope("service"),
  },
  // Domains.
  "certificates.manage": {
    phrase: "manage certificates",
    member: capability("certificates.manage"),
  },
  "dns.manage": {
    phrase: "manage DNS zones and environment defaults",
    member: capability("dns.manage"),
  },
  // Backups.
  "destinations.use": {
    phrase: "back up to the workspace's destinations",
    member: capability("backups.use-destinations"),
  },
  "destinations.manage": {
    phrase: "add or remove backup destinations",
    member: capability("backups.manage-destinations"),
  },
  // Servers.
  "server.see": { phrase: "see this server", member: scope("server") },
  "servers.add": { phrase: "add servers", member: capability("servers.manage") },
  "server.manage": {
    phrase: "edit, set up or delete this server, or open its terminal",
    member: capability("servers.manage", "server"),
  },
  "server.tasks": {
    phrase: "run tasks on this server",
    member: capability("servers.manage", "server"),
  },
  "server.router-files": {
    phrase: "see this server's router files",
    member: capability("router-files.read", "server"),
  },
  // SSH keys and Git.
  "ssh-keys.use": {
    phrase: "use the workspace's SSH keys",
    member: capability("ssh-keys.use"),
  },
  "ssh-keys.manage": {
    phrase: "add or remove SSH keys",
    member: capability("ssh-keys.manage"),
  },
  "git-account.use": { phrase: "use this Git account", member: scope("git_account") },
  "git-accounts.connect-own": {
    phrase: "connect your own Git accounts",
    member: capability("git.connect-own"),
  },
  // Notifications.
  "notifications.manage": {
    phrase: "manage notification channels",
    member: capability("notifications.manage"),
  },
  // People, policies and workspace settings.
  "members.see": { phrase: "see this workspace's members", member: never },
  "members.manage": { phrase: "manage this workspace's members", member: never },
  "invitations.manage": { phrase: "invite people to this workspace", member: never },
  "policies.manage": { phrase: "manage access policies", member: never },
  "agent-policies.manage": { phrase: "change the Agent's policies", member: never },
  "api-keys.manage": { phrase: "see the workspace's API keys", member: never },
  "workspace-email.manage": { phrase: "change how invitation emails are sent", member: never },
  "agent.use": { phrase: "use the Agent", member: { kind: "always" } },
  // Instance administrators (spec 22.2).
  "workspaces.add": {
    phrase: "add workspaces",
    member: never,
    instanceAdmin: { refusal: WORKSPACES_REFUSAL },
  },
  "workspace.rename": {
    phrase: "rename this workspace",
    member: never,
    instanceAdmin: {
      refusal: WORKSPACES_REFUSAL,
      workspaceAdminRefusal: "Only this workspace's owner and admins can rename it.",
    },
  },
  "workspace.delete": {
    phrase: "delete this workspace",
    member: never,
    instanceAdmin: {
      refusal: WORKSPACES_REFUSAL,
      workspaceAdminRefusal: "Only this workspace's owner and admins can delete it.",
    },
  },
  "members.add-with-password": {
    phrase: "add people with a password",
    member: never,
    instanceAdmin: {
      refusal:
        "Only this server's administrators can add people with a password. Send an invitation instead.",
      workspaceAdminRefusal: "Only owners and admins can add people with a password.",
      roleFirst: true,
    },
  },
  // On a server that can't send email, an administrator vouches for someone's new address
  // (31a G1-02, the decision in spec 31).
  "members.set-email": {
    phrase: "change other people's email addresses",
    member: never,
    instanceAdmin: {
      refusal:
        "Only this server's administrators can change someone's email address. Ask a Nearzero administrator.",
      workspaceAdminRefusal: "Only owners and admins can change a member's email address.",
      roleFirst: true,
    },
  },
  // Deploying to the host: instance administrators, and workspaces they allow (spec 24 G3).
  "host.use": {
    phrase: "use the Nearzero host",
    member: never,
    instanceAdmin: {
      refusal: "Only Nearzero administrators can use the Nearzero host.",
      orAllowedWorkspace: true,
    },
  },
  // The host's containers, logs, terminals, metrics, routes and router files (spec 22.2).
  "host.manage": {
    phrase: "manage the Nearzero host",
    member: never,
    instanceAdmin: {
      refusal:
        "Only Nearzero administrators can see the Nearzero host's containers, logs, terminals, metrics and router files.",
    },
  },
  "analytics.see": {
    phrase: "see Analytics",
    member: never,
    instanceAdmin: { refusal: "Only Nearzero administrators can see Analytics." },
  },
  "console-domain.configure": {
    phrase: "configure the console's public domain",
    member: never,
    instanceAdmin: {
      refusal: "Only Nearzero administrators can configure the console's public domain.",
    },
  },
} as const satisfies Record<string, ActionRule>;

export type Action = keyof typeof ACTIONS;

export function ruleFor(action: Action): ActionRule {
  return ACTIONS[action];
}
