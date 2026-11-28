import {
  type AccessScope,
  AppError,
  CAPABILITY_KEYS,
  type Capability,
  isCapability,
  POLICY_LIMITS,
  type ScopeKind,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import type { ControlServices } from "../services.ts";
import { capabilitySources, isWorkspaceAdmin } from "./evaluate.ts";
import { loadGrants } from "./grants.ts";

/**
 * Access policies and a member's direct access (spec 04 4.7). Both are a set of capabilities
 * plus a scope: projects → environments → services, servers, and Git accounts, each with an
 * "all, including new ones" choice.
 *
 * Scope rules: ticking a child ticks its parents, so an environment always comes with its project
 * and a service with its environment. A ticked node with no ticked children covers everything
 * under it, including things added later; with ticked children it covers only those.
 */

interface ScopeItem {
  kind: ScopeKind;
  id: string;
  parentId: string | null;
}

const KIND_WORDS: Record<ScopeKind, string> = {
  project: "project",
  environment: "environment",
  service: "service",
  server: "server",
  git_account: "Git account",
};

/**
 * Checks every named object is in the workspace, adds missing parents, and returns the rows to
 * store. Something deleted since the page loaded is refused with a reload hint.
 */
export async function resolveScope(
  services: ControlServices,
  workspaceId: string,
  scope: AccessScope,
): Promise<ScopeItem[]> {
  const { db, objects } = services;
  const lookups: [ScopeKind, string[]][] = [
    ["project", scope.projectIds],
    ["environment", scope.environmentIds],
    ["service", scope.serviceIds],
    ["server", scope.serverIds],
    ["git_account", scope.gitAccountIds],
  ];
  const items = new Map<string, ScopeItem>();
  const add = (item: ScopeItem) => items.set(`${item.kind}:${item.id}`, item);

  for (const [kind, ids] of lookups) {
    if (ids.length === 0) continue;
    const found = await objects.resolveMany(db, workspaceId, kind, ids);
    for (const id of ids) {
      const target = found.get(id);
      if (!target) {
        throw new AppError(
          "conflict",
          `A ${KIND_WORDS[kind]} in the list isn't in this workspace any more. Reload the page and try again.`,
        );
      }
      if (kind === "environment") {
        if (!target.projectId)
          throw new Error(`Environment ${id} was resolved without its project.`);
        add({ kind, id, parentId: target.projectId });
        add({ kind: "project", id: target.projectId, parentId: null });
      } else if (kind === "service") {
        if (!target.projectId || !target.environmentId) {
          throw new Error(`Service ${id} was resolved without its environment and project.`);
        }
        add({ kind, id, parentId: target.environmentId });
        add({ kind: "environment", id: target.environmentId, parentId: target.projectId });
        add({ kind: "project", id: target.projectId, parentId: null });
      } else {
        add({ kind, id, parentId: null });
      }
    }
  }
  return [...items.values()];
}

export interface ScopeView {
  allProjects: boolean;
  projectIds: string[];
  environmentIds: string[];
  serviceIds: string[];
  allServers: boolean;
  serverIds: string[];
  allGitAccounts: boolean;
  gitAccountIds: string[];
}

function scopeView(
  flags: { all_projects: boolean; all_servers: boolean; all_git_accounts: boolean },
  items: { object_kind: ScopeKind; object_id: string }[],
): ScopeView {
  const ids = (kind: ScopeKind) =>
    items
      .filter((item) => item.object_kind === kind)
      .map((item) => item.object_id)
      .sort();
  return {
    allProjects: flags.all_projects,
    projectIds: ids("project"),
    environmentIds: ids("environment"),
    serviceIds: ids("service"),
    allServers: flags.all_servers,
    serverIds: ids("server"),
    allGitAccounts: flags.all_git_accounts,
    gitAccountIds: ids("git_account"),
  };
}

function orderedCapabilities(values: readonly string[]): Capability[] {
  const set = new Set(values);
  return CAPABILITY_KEYS.filter((key) => set.has(key));
}

export interface PolicyView {
  id: string;
  name: string;
  description: string;
  capabilities: Capability[];
  scope: ScopeView;
  holders: { id: string; name: string; email: string }[];
  createdAt: string;
  updatedAt: string;
}

export async function listPolicies(db: Db, workspaceId: string): Promise<PolicyView[]> {
  const [policies, items, holders] = await Promise.all([
    db
      .selectFrom("access_policy")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy(sql`lower(name)`)
      .execute(),
    db
      .selectFrom("access_scope_item")
      .select(["policy_id", "object_kind", "object_id"])
      .where("workspace_id", "=", workspaceId)
      .where("policy_id", "is not", null)
      .execute(),
    db
      .selectFrom("policy_attachment as a")
      .innerJoin("person as p", "p.id", "a.person_id")
      .select(["a.policy_id", "p.id", "p.email", "p.first_name", "p.last_name"])
      .where("a.workspace_id", "=", workspaceId)
      .orderBy("a.created_at")
      .execute(),
  ]);
  return policies.map((policy) => ({
    id: policy.id,
    name: policy.name,
    description: policy.description,
    capabilities: orderedCapabilities(policy.capabilities),
    scope: scopeView(
      policy,
      items.filter((item) => item.policy_id === policy.id),
    ),
    holders: holders
      .filter((holder) => holder.policy_id === policy.id)
      .map((holder) => ({ id: holder.id, email: holder.email, name: displayName(holder) })),
    createdAt: policy.created_at.toISOString(),
    updatedAt: policy.updated_at.toISOString(),
  }));
}

export interface PolicyInput {
  name: string;
  description: string;
  capabilities: Capability[];
  scope: AccessScope;
}

function duplicateName(name: string): AppError {
  const message = `There is already a policy called "${name}".`;
  return new AppError("conflict", message, { fields: { name: message } });
}

async function writeScopeItems(
  db: Db,
  owner: { workspaceId: string; policyId?: string; personId?: string },
  items: ScopeItem[],
): Promise<void> {
  if (items.length === 0) return;
  await db
    .insertInto("access_scope_item")
    .values(
      items.map((item) => ({
        workspace_id: owner.workspaceId,
        policy_id: owner.policyId ?? null,
        person_id: owner.personId ?? null,
        object_kind: item.kind,
        object_id: item.id,
        parent_id: item.parentId,
      })),
    )
    .execute();
}

async function savePolicy(
  services: ControlServices,
  actor: WorkspaceActor,
  policyId: string | null,
  input: PolicyInput,
): Promise<PolicyView> {
  await actor.access.require("policies.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  const items = await resolveScope(services, workspaceId, input.scope);
  const flags = {
    all_projects: input.scope.allProjects,
    all_servers: input.scope.allServers,
    all_git_accounts: input.scope.allGitAccounts,
  };

  const id = await db.transaction().execute(async (trx) => {
    // Serialize policy writes per workspace so the limit and name checks hold.
    await sql`select pg_advisory_xact_lock(hashtext('access-policy'), hashtext(${workspaceId}))`.execute(
      trx,
    );
    const clash = await trx
      .selectFrom("access_policy")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where(sql`lower(name)`, "=", input.name.toLowerCase())
      .executeTakeFirst();
    if (clash && clash.id !== policyId) throw duplicateName(input.name);

    if (policyId === null) {
      const count = await trx
        .selectFrom("access_policy")
        .select((eb) => eb.fn.countAll<number>().as("count"))
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirstOrThrow();
      if (Number(count.count) >= POLICY_LIMITS.perWorkspace) {
        throw new AppError(
          "conflict",
          `A workspace can have up to ${POLICY_LIMITS.perWorkspace} access policies. Delete one you no longer use first.`,
        );
      }
      const created = await trx
        .insertInto("access_policy")
        .values({
          workspace_id: workspaceId,
          name: input.name,
          description: input.description,
          capabilities: orderedCapabilities(input.capabilities),
          ...flags,
          created_by: actor.personId,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await writeScopeItems(trx, { workspaceId, policyId: created.id }, items);
      return created.id;
    }

    const updated = await trx
      .updateTable("access_policy")
      .set({
        name: input.name,
        description: input.description,
        capabilities: orderedCapabilities(input.capabilities),
        ...flags,
        updated_at: new Date(),
      })
      .where("workspace_id", "=", workspaceId)
      .where(sql<boolean>`id::text = ${policyId}`)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows) !== 1) throw policyNotFound();
    await trx
      .deleteFrom("access_scope_item")
      .where("workspace_id", "=", workspaceId)
      .where("policy_id", "=", policyId)
      .execute();
    await writeScopeItems(trx, { workspaceId, policyId }, items);
    return policyId;
  });

  await recordAudit(db, services.log, auditActor(actor), {
    action: policyId === null ? "policy.created" : "policy.updated",
    workspaceId,
    target: { kind: "access-policy", id },
    details: {
      name: input.name,
      capabilities: input.capabilities,
      scope: { ...input.scope },
    },
  });
  const view = (await listPolicies(db, workspaceId)).find((policy) => policy.id === id);
  if (!view) throw new Error("The saved policy could not be read back.");
  return view;
}

function policyNotFound(): AppError {
  return new AppError(
    "not_found",
    "This policy isn't in this workspace any more. Reload the page to see the current list.",
  );
}

export function createPolicy(services: ControlServices, actor: WorkspaceActor, input: PolicyInput) {
  return savePolicy(services, actor, null, input);
}

export function updatePolicy(
  services: ControlServices,
  actor: WorkspaceActor,
  policyId: string,
  input: PolicyInput,
) {
  return savePolicy(services, actor, policyId, input);
}

/** Deletes a policy; its holders lose what it granted, and keep anything given directly. */
export async function deletePolicy(
  services: ControlServices,
  actor: WorkspaceActor,
  policyId: string,
): Promise<{ holdersAffected: number }> {
  await actor.access.require("policies.manage");
  const { db } = services;
  const policy = await db
    .selectFrom("access_policy")
    .select(["id", "name"])
    .where("workspace_id", "=", actor.workspace.id)
    .where(sql<boolean>`id::text = ${policyId}`)
    .executeTakeFirst();
  if (!policy) throw policyNotFound();
  const holders = await db
    .selectFrom("policy_attachment")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("policy_id", "=", policy.id)
    .executeTakeFirstOrThrow();
  await db.deleteFrom("access_policy").where("id", "=", policy.id).execute();
  await recordAudit(db, services.log, auditActor(actor), {
    action: "policy.deleted",
    workspaceId: actor.workspace.id,
    target: { kind: "access-policy", id: policy.id },
    details: { name: policy.name, holders: Number(holders.count) },
  });
  return { holdersAffected: Number(holders.count) };
}

// ---- A member's access

export interface MemberAccessView {
  personId: string;
  role: "owner" | "admin" | "member";
  policies: { id: string; name: string }[];
  /** Given directly, beside the policies. */
  direct: { capabilities: Capability[]; scope: ScopeView };
  /** The union of direct grants and policies, with where each capability comes from. */
  effective: {
    capabilities: { key: Capability; from: string[] }[];
    allProjects: boolean;
    allServers: boolean;
    allGitAccounts: boolean;
  };
}

async function memberRole(db: Db, workspaceId: string, personId: string) {
  const row = await db
    .selectFrom("membership")
    .select("role")
    .where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`person_id::text = ${personId}`)
    .executeTakeFirst();
  if (!row) {
    throw new AppError(
      "not_found",
      "This person isn't a member of this workspace any more. Reload the page.",
    );
  }
  return row.role;
}

export async function memberAccessView(
  services: ControlServices,
  actor: WorkspaceActor,
  personId: string,
): Promise<MemberAccessView> {
  await actor.access.require("members.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  const role = await memberRole(db, workspaceId, personId);
  const [direct, directItems, grants] = await Promise.all([
    db
      .selectFrom("member_access")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("person_id", "=", personId)
      .executeTakeFirst(),
    db
      .selectFrom("access_scope_item")
      .select(["object_kind", "object_id"])
      .where("workspace_id", "=", workspaceId)
      .where("person_id", "=", personId)
      .execute(),
    loadGrants(db, { personId, workspaceId, role, isInstanceAdmin: false }),
  ]);
  const admin = isWorkspaceAdmin(role);
  return {
    personId,
    role,
    policies: grants.sources
      .filter((source) => source.policy !== null)
      .map((source) => ({ id: source.policy?.id ?? "", name: source.policy?.name ?? "" })),
    direct: {
      capabilities: orderedCapabilities(direct?.capabilities ?? []),
      scope: scopeView(
        direct ?? { all_projects: false, all_servers: false, all_git_accounts: false },
        directItems,
      ),
    },
    effective: {
      capabilities: CAPABILITY_KEYS.filter(
        (key) => admin || grants.sources.some((source) => source.capabilities.has(key)),
      ).map((key) => ({
        key,
        from: admin ? ["role"] : capabilitySources(grants, key),
      })),
      allProjects: admin || grants.sources.some((source) => source.allProjects),
      allServers: admin || grants.sources.some((source) => source.allServers),
      allGitAccounts: admin || grants.sources.some((source) => source.allGitAccounts),
    },
  };
}

export interface MemberAccessInput {
  policyIds: string[];
  capabilities: Capability[];
  scope: AccessScope;
}

/**
 * Replaces a member's attached policies and direct grants. Only for members (owners and admins
 * already reach everything), and never for yourself (spec 04 4.7).
 */
export async function setMemberAccess(
  services: ControlServices,
  actor: WorkspaceActor,
  personId: string,
  input: MemberAccessInput,
): Promise<MemberAccessView> {
  await actor.access.require("members.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  if (personId === actor.personId) {
    throw new AppError(
      "forbidden",
      "You can't change your own access. Ask another owner or admin.",
    );
  }
  const role = await memberRole(db, workspaceId, personId);
  if (role !== "member") {
    throw new AppError(
      "conflict",
      "Owners and admins already reach everything. Change their role to Member to give them specific access.",
    );
  }
  const policyIds = [...new Set(input.policyIds)];
  if (policyIds.length > 0) {
    const found = await db
      .selectFrom("access_policy")
      .select("id")
      .where("workspace_id", "=", workspaceId)
      .where(sql<boolean>`id::text = any(${policyIds})`)
      .execute();
    if (found.length !== policyIds.length) {
      throw new AppError(
        "conflict",
        "A policy in the list isn't in this workspace any more. Reload the page and try again.",
      );
    }
  }
  const items = await resolveScope(services, workspaceId, input.scope);
  const capabilities = orderedCapabilities(input.capabilities.filter((key) => isCapability(key)));

  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("policy_attachment")
      .where("workspace_id", "=", workspaceId)
      .where("person_id", "=", personId)
      .execute();
    if (policyIds.length > 0) {
      await trx
        .insertInto("policy_attachment")
        .values(
          policyIds.map((policyId) => ({
            policy_id: policyId,
            workspace_id: workspaceId,
            person_id: personId,
            attached_by: actor.personId,
          })),
        )
        .execute();
    }
    // Replacing the member_access row also removes its scope items (they cascade).
    await trx
      .deleteFrom("member_access")
      .where("workspace_id", "=", workspaceId)
      .where("person_id", "=", personId)
      .execute();
    const hasDirect =
      capabilities.length > 0 ||
      items.length > 0 ||
      input.scope.allProjects ||
      input.scope.allServers ||
      input.scope.allGitAccounts;
    if (hasDirect) {
      await trx
        .insertInto("member_access")
        .values({
          workspace_id: workspaceId,
          person_id: personId,
          capabilities,
          all_projects: input.scope.allProjects,
          all_servers: input.scope.allServers,
          all_git_accounts: input.scope.allGitAccounts,
          updated_by: actor.personId,
        })
        .execute();
      await writeScopeItems(trx, { workspaceId, personId }, items);
    }
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "member.access-changed",
    workspaceId,
    target: { kind: "person", id: personId },
    details: { policyIds, capabilities, scope: { ...input.scope } },
  });
  return memberAccessView(services, actor, personId);
}
