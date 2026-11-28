import { CAPABILITIES, type Capability, type Role, type ScopeKind } from "@nearzero/shared";
import { type Action, ruleFor } from "./matrix.ts";
import type { AccessTarget } from "./objects.ts";

/**
 * Answers "may this person do X (on object Y)?" from what they hold in one workspace. Pure, so
 * the whole matrix is unit-tested without a database; {@link loadGrants} in grants.ts fills it.
 */

/** One place access comes from: the member's direct grants, or one attached policy. */
export interface GrantSource {
  /** null for direct grants. */
  policy: { id: string; name: string } | null;
  capabilities: ReadonlySet<Capability>;
  allProjects: boolean;
  allServers: boolean;
  allGitAccounts: boolean;
  projects: ReadonlySet<string>;
  /** Environment id → its project id. */
  environments: ReadonlyMap<string, string>;
  /** Service id → its environment id. */
  services: ReadonlyMap<string, string>;
  servers: ReadonlySet<string>;
  gitAccounts: ReadonlySet<string>;
}

export interface Grants {
  personId: string;
  workspaceId: string;
  role: Role;
  isInstanceAdmin: boolean;
  /** The workspace may deploy to the Nearzero host (spec 24 G3). */
  hostAllowed?: boolean;
  sources: readonly GrantSource[];
}

export type Decision =
  | { allowed: true }
  /**
   * hide: answer as if the object didn't exist (spec 22.4, rule 3). Otherwise refuse with the
   * message, which says what would be needed.
   */
  | { allowed: false; hide: boolean; message: string };

const ALLOWED: Decision = { allowed: true };

export function isWorkspaceAdmin(role: Role): boolean {
  return role === "owner" || role === "admin";
}

/** Whether one source covers an object, with "a ticked node with ticked children covers only those children". */
export function sourceCovers(source: GrantSource, target: AccessTarget): boolean {
  switch (target.kind) {
    case "project":
      return source.allProjects || source.projects.has(target.id);
    case "environment": {
      if (source.allProjects || source.environments.has(target.id)) return true;
      return target.projectId !== undefined && coversWholeProject(source, target.projectId);
    }
    case "service": {
      if (source.allProjects || source.services.has(target.id)) return true;
      if (
        target.environmentId !== undefined &&
        coversWholeEnvironment(source, target.environmentId)
      )
        return true;
      return target.projectId !== undefined && coversWholeProject(source, target.projectId);
    }
    case "server":
      return source.allServers || source.servers.has(target.id);
    case "git_account":
      return source.allGitAccounts || source.gitAccounts.has(target.id);
  }
}

function coversWholeProject(source: GrantSource, projectId: string): boolean {
  if (!source.projects.has(projectId)) return false;
  for (const parent of source.environments.values()) if (parent === projectId) return false;
  return true;
}

function coversWholeEnvironment(source: GrantSource, environmentId: string): boolean {
  if (!source.environments.has(environmentId)) return false;
  for (const parent of source.services.values()) if (parent === environmentId) return false;
  return true;
}

/** Whether a source covers every service of an environment, not only some of them. */
function coversEnvironmentWhole(source: GrantSource, target: AccessTarget): boolean {
  if (source.allProjects || coversWholeEnvironment(source, target.id)) return true;
  return (
    target.kind === "environment" &&
    target.projectId !== undefined &&
    coversWholeProject(source, target.projectId)
  );
}

/** Whether the person can see an object at all (what decides "not found" over "refused"). */
export function canSee(grants: Grants, target: AccessTarget): boolean {
  if (isWorkspaceAdmin(grants.role)) return true;
  if (target.kind === "git_account") {
    // A member always reaches their own accounts and the ones shared with everyone.
    if (target.ownerPersonId === grants.personId || target.sharedWithWorkspace) return true;
  }
  return grants.sources.some((source) => sourceCovers(source, target));
}

export function hasCapability(grants: Grants, capability: Capability): boolean {
  if (isWorkspaceAdmin(grants.role)) return true;
  return grants.sources.some((source) => source.capabilities.has(capability));
}

/** Where a member's capability comes from, for "From <policy>" labels. */
export function capabilitySources(grants: Grants, capability: Capability): string[] {
  return grants.sources
    .filter((source) => source.capabilities.has(capability))
    .map((source) => source.policy?.name ?? "direct");
}

const KIND_WORDS: Record<ScopeKind, string> = {
  project: "project",
  environment: "environment",
  service: "service",
  server: "server",
  git_account: "Git account",
};

/**
 * Decides one action. A target is required for actions whose rule names a scope, and must already
 * be known to belong to the grants' workspace (resolvers only return such objects).
 */
export function decide(grants: Grants, action: Action, target?: AccessTarget): Decision {
  const rule = ruleFor(action);
  const admin = isWorkspaceAdmin(grants.role);

  if (rule.instanceAdmin) {
    const { refusal, workspaceAdminRefusal, roleFirst, orAllowedWorkspace } = rule.instanceAdmin;
    const roleRefusal: Decision | null =
      workspaceAdminRefusal && !admin
        ? { allowed: false, hide: false, message: workspaceAdminRefusal }
        : null;
    if (roleFirst && roleRefusal) return roleRefusal;
    const allowedHere = orAllowedWorkspace === true && grants.hostAllowed === true;
    if (!grants.isInstanceAdmin && !allowedHere) {
      return { allowed: false, hide: false, message: refusal };
    }
    return roleRefusal ?? ALLOWED;
  }

  if (admin) return ALLOWED;

  const member = rule.member;
  switch (member.kind) {
    case "always":
      return ALLOWED;
    case "never":
      return {
        allowed: false,
        hide: false,
        message: `Only owners and admins can ${rule.phrase}. Ask one of them.`,
      };
    case "scope": {
      if (!target || target.kind !== member.within) {
        throw new Error(`The action ${action} needs a ${member.within} to check against.`);
      }
      return canSee(grants, target) ? ALLOWED : hidden(target);
    }
    case "whole": {
      if (target?.kind !== "environment") {
        throw new Error(`The action ${action} needs an environment to check against.`);
      }
      if (!canSee(grants, target)) return hidden(target);
      if (grants.sources.some((source) => coversEnvironmentWhole(source, target))) return ALLOWED;
      return {
        allowed: false,
        hide: false,
        message: `You can't ${rule.phrase}: they reach every service in it, and your access covers only some of them. Ask an owner or admin for access to the whole environment.`,
      };
    }
    case "capability": {
      if (member.within) {
        if (!target || target.kind !== member.within) {
          throw new Error(`The action ${action} needs a ${member.within} to check against.`);
        }
        if (!canSee(grants, target)) return hidden(target);
      }
      if (hasCapability(grants, member.capability)) return ALLOWED;
      return {
        allowed: false,
        hide: false,
        message: `You can't ${rule.phrase}: it needs the "${CAPABILITIES[member.capability].label}" permission. Ask an owner or admin of this workspace.`,
      };
    }
  }
}

function hidden(target: AccessTarget): Decision {
  return {
    allowed: false,
    hide: true,
    message: `This ${KIND_WORDS[target.kind]} doesn't exist in this workspace, or you don't have access to it.`,
  };
}
