import type { ScopeKind } from "@nearzero/shared";
import { loadGrants, WorkspaceAccess } from "../access/grants.ts";
import type { AccessTarget } from "../access/objects.ts";
import type { Db } from "../db/database.ts";
import type { WorkspaceActor } from "../http/actor.ts";
import type { ControlServices } from "../services.ts";

/**
 * Keeping access scopes right as projects, environments and services come and go.
 *
 * - Something a member creates is theirs to see: when their scope wouldn't cover it (their
 *   policy lists specific projects or services), it is added to their direct access.
 * - Deleted objects leave policies and direct access. A ticked node with ticked children covers
 *   only those children, so when the last ticked child goes, its parent goes too: otherwise the
 *   parent would suddenly cover everything under it.
 */

const SEE: Record<
  "project" | "environment" | "service",
  "project.see" | "environment.see" | "service.see"
> = {
  project: "project.see",
  environment: "environment.see",
  service: "service.see",
};

interface Item {
  kind: ScopeKind;
  id: string;
  parentId: string | null;
}

function itemsFor(target: AccessTarget): Item[] {
  switch (target.kind) {
    case "project":
      return [{ kind: "project", id: target.id, parentId: null }];
    case "environment":
      return [
        { kind: "environment", id: target.id, parentId: target.projectId ?? null },
        { kind: "project", id: target.projectId ?? "", parentId: null },
      ];
    case "service":
      return [
        { kind: "service", id: target.id, parentId: target.environmentId ?? null },
        { kind: "environment", id: target.environmentId ?? "", parentId: target.projectId ?? null },
        { kind: "project", id: target.projectId ?? "", parentId: null },
      ];
    default:
      return [];
  }
}

/** Gives a member direct access to what they just created, where their scope doesn't reach it. */
export async function grantToCreator(
  db: Db,
  actor: WorkspaceActor,
  created: readonly AccessTarget[],
): Promise<boolean> {
  if (actor.role !== "member") return false;
  const missing = created.filter(
    (target) =>
      target.kind in SEE && !actor.access.can(SEE[target.kind as keyof typeof SEE], target),
  );
  if (missing.length === 0) return false;
  const workspaceId = actor.workspace.id;
  await db
    .insertInto("member_access")
    .values({ workspace_id: workspaceId, person_id: actor.personId, updated_by: actor.personId })
    .onConflict((conflict) => conflict.columns(["workspace_id", "person_id"]).doNothing())
    .execute();
  const existing = await db
    .selectFrom("access_scope_item")
    .select(["object_kind", "object_id"])
    .where("workspace_id", "=", workspaceId)
    .where("person_id", "=", actor.personId)
    .execute();
  const have = new Set(existing.map((row) => `${row.object_kind}:${row.object_id}`));
  const add: Item[] = [];
  for (const target of missing) {
    for (const item of itemsFor(target)) {
      const key = `${item.kind}:${item.id}`;
      if (have.has(key) || item.id === "") continue;
      have.add(key);
      add.push(item);
    }
  }
  if (add.length === 0) return false;
  await db
    .insertInto("access_scope_item")
    .values(
      add.map((item) => ({
        workspace_id: workspaceId,
        person_id: actor.personId,
        policy_id: null,
        object_kind: item.kind,
        object_id: item.id,
        parent_id: item.parentId,
      })),
    )
    .execute();
  return true;
}

/**
 * Reloads a request's access after its grants changed. The workspace's place on the Nearzero
 * host is kept: it isn't a grant, and losing it mid-request (a project, then a service on the host
 * in one Agent turn) refused what the workspace may do (B1-28).
 */
export async function refreshAccess(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<void> {
  const grants = await loadGrants(services.db, {
    personId: actor.personId,
    workspaceId: actor.workspace.id,
    role: actor.role,
    isInstanceAdmin: actor.isInstanceAdmin,
    hostAllowed: actor.access.grants.hostAllowed === true,
  });
  actor.access = new WorkspaceAccess(services.db, services.objects, grants);
}

export interface RemovedObjects {
  projects?: readonly string[];
  environments?: readonly string[];
  services?: readonly string[];
}

/** Takes deleted objects out of every policy and direct access in the workspace. */
export async function pruneScopes(
  db: Db,
  workspaceId: string,
  removed: RemovedObjects,
): Promise<void> {
  const gone = new Set<string>([
    ...(removed.projects ?? []).map((id) => `project:${id}`),
    ...(removed.environments ?? []).map((id) => `environment:${id}`),
    ...(removed.services ?? []).map((id) => `service:${id}`),
  ]);
  if (gone.size === 0) return;
  const rows = await db
    .selectFrom("access_scope_item")
    .select(["id", "policy_id", "person_id", "object_kind", "object_id", "parent_id"])
    .where("workspace_id", "=", workspaceId)
    .where("object_kind", "in", ["project", "environment", "service"])
    .execute();

  const owners = new Map<string, typeof rows>();
  for (const row of rows) {
    const owner = row.policy_id ? `policy:${row.policy_id}` : `person:${row.person_id}`;
    owners.set(owner, [...(owners.get(owner) ?? []), row]);
  }

  const doomed: number[] = [];
  for (const items of owners.values()) {
    const remaining = new Set(items.map((item) => item.id));
    const drop = (id: number) => {
      if (remaining.delete(id)) doomed.push(id);
    };
    const childrenLeft = (kind: ScopeKind, parentId: string) =>
      items.some(
        (item) =>
          remaining.has(item.id) && item.object_kind === kind && item.parent_id === parentId,
      );
    // Services first, then environments, then projects, so emptied parents follow their children.
    for (const [kind, childKind] of [
      ["service", null],
      ["environment", "service"],
      ["project", "environment"],
    ] as const) {
      for (const item of items) {
        if (item.object_kind !== kind || !remaining.has(item.id)) continue;
        if (gone.has(`${kind}:${item.object_id}`)) {
          drop(item.id);
          continue;
        }
        if (!childKind) continue;
        const hadChildren = items.some(
          (child) => child.object_kind === childKind && child.parent_id === item.object_id,
        );
        const lostThemAll = hadChildren && !childrenLeft(childKind, item.object_id);
        const childWasRemoved = items.some(
          (child) =>
            child.object_kind === childKind &&
            child.parent_id === item.object_id &&
            !remaining.has(child.id),
        );
        if (lostThemAll && childWasRemoved) drop(item.id);
      }
    }
  }
  if (doomed.length > 0) {
    await db.deleteFrom("access_scope_item").where("id", "in", doomed).execute();
  }
}
