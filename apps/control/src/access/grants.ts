import {
  AppError,
  type Capability,
  isCapability,
  type Role,
  type ScopeKind,
} from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import type { AccessScopeItemTable } from "../db/schema.ts";
import {
  type Decision,
  decide,
  type GrantSource,
  type Grants,
  isWorkspaceAdmin,
} from "./evaluate.ts";
import type { Action } from "./matrix.ts";
import type { AccessTarget, ObjectRegistry } from "./objects.ts";

/**
 * Loads what a person holds in a workspace and exposes the one question every endpoint asks:
 * may they do this action on this object? Everything goes through {@link WorkspaceAccess}, and
 * the Agent will call the same functions with the asking person's identity (spec 01 principle 1).
 */

interface ScopeRow {
  policy_id: string | null;
  object_kind: AccessScopeItemTable["object_kind"];
  object_id: string;
  parent_id: string | null;
}

interface SourceRow {
  policyId: string | null;
  policyName: string | null;
  capabilities: string[];
  all_projects: boolean;
  all_servers: boolean;
  all_git_accounts: boolean;
}

function buildSource(row: SourceRow, items: ScopeRow[]): GrantSource {
  const projects = new Set<string>();
  const environments = new Map<string, string>();
  const services = new Map<string, string>();
  const servers = new Set<string>();
  const gitAccounts = new Set<string>();
  for (const item of items) {
    switch (item.object_kind) {
      case "project":
        projects.add(item.object_id);
        break;
      case "environment":
        environments.set(item.object_id, item.parent_id ?? "");
        break;
      case "service":
        services.set(item.object_id, item.parent_id ?? "");
        break;
      case "server":
        servers.add(item.object_id);
        break;
      case "git_account":
        gitAccounts.add(item.object_id);
        break;
    }
  }
  return {
    policy: row.policyId ? { id: row.policyId, name: row.policyName ?? "" } : null,
    capabilities: new Set(row.capabilities.filter(isCapability) as Capability[]),
    allProjects: row.all_projects,
    allServers: row.all_servers,
    allGitAccounts: row.all_git_accounts,
    projects,
    environments,
    services,
    servers,
    gitAccounts,
  };
}

export interface GrantsSubject {
  personId: string;
  workspaceId: string;
  role: Role;
  isInstanceAdmin: boolean;
  hostAllowed?: boolean;
}

/** Reads a member's direct grants and every attached policy. Owners and admins need none. */
export async function loadGrants(db: Db, subject: GrantsSubject): Promise<Grants> {
  if (isWorkspaceAdmin(subject.role)) return { ...subject, sources: [] };

  const [direct, policies, directItems, policyItems] = await Promise.all([
    db
      .selectFrom("member_access")
      .select(["capabilities", "all_projects", "all_servers", "all_git_accounts"])
      .where("workspace_id", "=", subject.workspaceId)
      .where("person_id", "=", subject.personId)
      .executeTakeFirst(),
    db
      .selectFrom("policy_attachment as a")
      .innerJoin("access_policy as p", (join) =>
        join.onRef("p.id", "=", "a.policy_id").onRef("p.workspace_id", "=", "a.workspace_id"),
      )
      .select([
        "p.id",
        "p.name",
        "p.capabilities",
        "p.all_projects",
        "p.all_servers",
        "p.all_git_accounts",
      ])
      .where("a.workspace_id", "=", subject.workspaceId)
      .where("a.person_id", "=", subject.personId)
      .orderBy("p.name")
      .execute(),
    db
      .selectFrom("access_scope_item")
      .select(["policy_id", "object_kind", "object_id", "parent_id"])
      .where("workspace_id", "=", subject.workspaceId)
      .where("person_id", "=", subject.personId)
      .execute(),
    db
      .selectFrom("access_scope_item as i")
      .innerJoin("policy_attachment as a", (join) =>
        join
          .onRef("a.policy_id", "=", "i.policy_id")
          .onRef("a.workspace_id", "=", "i.workspace_id"),
      )
      .select(["i.policy_id", "i.object_kind", "i.object_id", "i.parent_id"])
      .where("a.workspace_id", "=", subject.workspaceId)
      .where("a.person_id", "=", subject.personId)
      .execute(),
  ]);

  const sources: GrantSource[] = [];
  if (direct) {
    sources.push(
      buildSource({ policyId: null, policyName: null, ...direct }, directItems as ScopeRow[]),
    );
  }
  for (const policy of policies) {
    sources.push(
      buildSource(
        { policyId: policy.id, policyName: policy.name, ...policy },
        (policyItems as ScopeRow[]).filter((item) => item.policy_id === policy.id),
      ),
    );
  }
  return { ...subject, sources };
}

export interface ObjectRef {
  kind: ScopeKind;
  id: string;
}

/** A person's access in their active workspace, for one request. */
export class WorkspaceAccess {
  constructor(
    private readonly db: Db,
    private readonly objects: ObjectRegistry,
    readonly grants: Grants,
  ) {}

  get workspaceId(): string {
    return this.grants.workspaceId;
  }

  get role(): Role {
    return this.grants.role;
  }

  /** The decision for an action, on an object already resolved inside this workspace. */
  decide(action: Action, target?: AccessTarget): Decision {
    return decide(this.grants, action, target);
  }

  can(action: Action, target?: AccessTarget): boolean {
    return this.decide(action, target).allowed;
  }

  /**
   * Refuses unless the action is allowed. With an object reference, first finds the object in
   * this workspace: anything outside it, or out of the person's sight, is "not found"
   * (spec 22.4, rules 1 and 3). Returns the resolved object.
   */
  async require(action: Action, ref?: ObjectRef): Promise<AccessTarget | undefined> {
    let target: AccessTarget | undefined;
    if (ref) {
      const found = await this.objects.resolveOne(this.db, this.workspaceId, ref.kind, ref.id);
      if (!found) throw notFound(ref.kind);
      target = found;
    }
    const decision = this.decide(action, target);
    if (decision.allowed) return target;
    if (decision.hide) throw new AppError("not_found", decision.message);
    throw new AppError("forbidden", decision.message);
  }

  /** Keeps the objects the person can see, for lists and pickers. */
  visible<T extends AccessTarget>(targets: readonly T[]): T[] {
    const action: Record<ScopeKind, Action> = {
      project: "project.see",
      environment: "environment.see",
      service: "service.see",
      server: "server.see",
      git_account: "git-account.use",
    };
    return targets.filter((target) => this.can(action[target.kind], target));
  }
}

const KIND_NAMES: Record<ScopeKind, string> = {
  project: "project",
  environment: "environment",
  service: "service",
  server: "server",
  git_account: "Git account",
};

export function notFound(kind: ScopeKind): AppError {
  return new AppError(
    "not_found",
    `This ${KIND_NAMES[kind]} doesn't exist in this workspace, or you don't have access to it.`,
  );
}
