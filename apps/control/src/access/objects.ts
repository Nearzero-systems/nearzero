import type { ScopeKind } from "@nearzero/shared";
import type { Db } from "../db/database.ts";

/**
 * Where the permission module learns about workspace objects. Each area that owns a kind of
 * object (projects, environments, services, servers, Git accounts…) registers a resolver when it
 * arrives; until then a kind has none, and every id of that kind is "not in this workspace".
 *
 * A resolver answers only for objects inside the given workspace, so the workspace boundary
 * (spec 22.4, rule 1) holds for everyone, owners and admins included.
 */

/** An object a permission is checked against, with what scope rules need to know about it. */
export interface AccessTarget {
  kind: ScopeKind;
  id: string;
  /** For environments and services. */
  projectId?: string;
  /** For services. */
  environmentId?: string;
  /** For Git accounts: who connected it, and whether it is shared with the whole workspace. */
  ownerPersonId?: string;
  sharedWithWorkspace?: boolean;
}

export interface ObjectResolver {
  /**
   * Looks up objects of one kind inside one workspace. Ids that aren't there are left out of
   * the result.
   */
  resolve(db: Db, workspaceId: string, ids: readonly string[]): Promise<AccessTarget[]>;
}

export class ObjectRegistry {
  readonly #resolvers = new Map<ScopeKind, ObjectResolver>();

  register(kind: ScopeKind, resolver: ObjectResolver): void {
    if (this.#resolvers.has(kind)) {
      throw new Error(`A resolver for ${kind} objects is already registered.`);
    }
    this.#resolvers.set(kind, resolver);
  }

  has(kind: ScopeKind): boolean {
    return this.#resolvers.has(kind);
  }

  async resolveMany(
    db: Db,
    workspaceId: string,
    kind: ScopeKind,
    ids: readonly string[],
  ): Promise<Map<string, AccessTarget>> {
    const unique = [...new Set(ids)];
    const resolver = this.#resolvers.get(kind);
    if (!resolver || unique.length === 0) return new Map();
    const found = await resolver.resolve(db, workspaceId, unique);
    return new Map(found.filter((target) => target.kind === kind).map((t) => [t.id, t]));
  }

  async resolveOne(
    db: Db,
    workspaceId: string,
    kind: ScopeKind,
    id: string,
  ): Promise<AccessTarget | null> {
    return (await this.resolveMany(db, workspaceId, kind, [id])).get(id) ?? null;
  }
}
