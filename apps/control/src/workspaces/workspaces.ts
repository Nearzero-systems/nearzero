import { AppError, type Role } from "@nearzero/shared";
import type { Db } from "../db/database.ts";
import { chooseSlug, lockSlugs } from "./slugs.ts";

/**
 * Workspaces: the unit of ownership and access (spec 02, spec 04 4.4). Every person has a
 * personal "My Workspace"; the first workspace's owners and admins administer the install
 * (spec 22.1).
 */

export const PERSONAL_WORKSPACE_NAME = "My Workspace";

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  /** True while this is a person's untouched "My Workspace". */
  personal: boolean;
  /** True for the install's first workspace, whose owners and admins administer Nearzero. */
  first: boolean;
  role: Role;
}

export async function firstWorkspaceId(db: Db): Promise<string | null> {
  const row = await db.selectFrom("install_state").select("first_workspace_id").executeTakeFirst();
  return row?.first_workspace_id ?? null;
}

/** An owner or admin of the first workspace (spec 22.1), never "owner of the active one". */
export async function isInstanceAdmin(db: Db, personId: string): Promise<boolean> {
  const row = await db
    .selectFrom("install_state as s")
    .innerJoin("membership as m", "m.workspace_id", "s.first_workspace_id")
    .select("m.role")
    .where("m.person_id", "=", personId)
    .where("m.role", "in", ["owner", "admin"])
    .executeTakeFirst();
  return row !== undefined;
}

export interface NewWorkspace {
  name: string;
  logoUrl?: string | null;
  ownerId: string;
  personal?: boolean;
}

/** Creates a workspace with its owner. Run inside a transaction. */
export async function createWorkspace(
  db: Db,
  input: NewWorkspace,
): Promise<{ id: string; slug: string }> {
  await lockSlugs(db);
  const slug = await chooseSlug(db, input.name);
  const workspace = await db
    .insertInto("workspace")
    .values({
      name: input.name,
      slug,
      logo_url: input.logoUrl ?? null,
      is_personal: input.personal ?? false,
      created_by: input.ownerId,
    })
    .returning(["id", "slug"])
    .executeTakeFirstOrThrow();
  await db
    .insertInto("membership")
    .values({ workspace_id: workspace.id, person_id: input.ownerId, role: "owner" })
    .execute();
  return workspace;
}

/**
 * Gives a workspace a new name; the slug follows and the old one keeps redirecting. A renamed
 * personal workspace is no longer the placeholder. Run inside a transaction.
 */
export async function renameWorkspace(
  db: Db,
  workspaceId: string,
  name: string,
): Promise<{ slug: string; previousSlug: string }> {
  await lockSlugs(db);
  const current = await db
    .selectFrom("workspace")
    .select(["slug"])
    .where("id", "=", workspaceId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const slug = await chooseSlug(db, name, workspaceId);
  if (slug !== current.slug) {
    await db
      .insertInto("workspace_old_slug")
      .values({ slug: current.slug, workspace_id: workspaceId })
      .onConflict((conflict) => conflict.column("slug").doNothing())
      .execute();
    // Renaming back to an earlier name takes that slug back.
    await db
      .deleteFrom("workspace_old_slug")
      .where("slug", "=", slug)
      .where("workspace_id", "=", workspaceId)
      .execute();
  }
  await db
    .updateTable("workspace")
    .set({ name, slug, is_personal: false, updated_at: new Date() })
    .where("id", "=", workspaceId)
    .execute();
  return { slug, previousSlug: current.slug };
}

/** The workspaces a person belongs to, in the order the switcher shows them. */
export async function listMemberships(db: Db, personId: string): Promise<WorkspaceSummary[]> {
  const first = await firstWorkspaceId(db);
  const rows = await db
    .selectFrom("membership as m")
    .innerJoin("workspace as w", "w.id", "m.workspace_id")
    .select(["w.id", "w.name", "w.slug", "w.logo_url", "w.is_personal", "m.role", "m.created_at"])
    .where("m.person_id", "=", personId)
    .orderBy("w.is_personal", "desc")
    .orderBy("m.created_at")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    logoUrl: row.logo_url,
    personal: row.is_personal,
    first: row.id === first,
    role: row.role,
  }));
}

/**
 * The switcher's list: the personal workspace is hidden once the person belongs to any other
 * (spec 04 4.4), unless it is the active one.
 */
export function switcherList(all: WorkspaceSummary[], activeId: string | null): WorkspaceSummary[] {
  const others = all.filter((workspace) => !workspace.personal);
  if (others.length === 0) return all;
  return all.filter((workspace) => !workspace.personal || workspace.id === activeId);
}

export async function membershipRole(
  db: Db,
  workspaceId: string,
  personId: string,
): Promise<Role | null> {
  const row = await db
    .selectFrom("membership")
    .select("role")
    .where("workspace_id", "=", workspaceId)
    .where("person_id", "=", personId)
    .executeTakeFirst();
  return row?.role ?? null;
}

/**
 * The workspace a session works in: the one it chose, else the person's last one, else their
 * first team workspace, else their personal one. Saved on the session when it changes.
 */
export async function resolveActiveWorkspace(
  db: Db,
  session: { id: string; personId: string; activeWorkspaceId: string | null },
): Promise<WorkspaceSummary | null> {
  const all = await listMemberships(db, session.personId);
  if (all.length === 0) return null;
  const person = await db
    .selectFrom("person")
    .select("last_workspace_id")
    .where("id", "=", session.personId)
    .executeTakeFirst();
  const pick =
    all.find((workspace) => workspace.id === session.activeWorkspaceId) ??
    all.find((workspace) => workspace.id === person?.last_workspace_id) ??
    all.find((workspace) => !workspace.personal) ??
    all[0];
  if (!pick) return null;
  if (pick.id !== session.activeWorkspaceId) {
    await db
      .updateTable("person_session")
      .set({ active_workspace_id: pick.id })
      .where("id", "=", session.id)
      .execute();
  }
  return pick;
}

/** Makes a workspace the session's active one and the person's default for new sessions. */
export async function switchWorkspace(
  db: Db,
  session: { id: string; personId: string },
  workspaceId: string,
): Promise<WorkspaceSummary> {
  const all = await listMemberships(db, session.personId);
  const target = all.find((workspace) => workspace.id === workspaceId);
  if (!target) {
    throw new AppError(
      "not_found",
      "This workspace doesn't exist, or you aren't a member of it. Pick one from the switcher.",
    );
  }
  await db
    .updateTable("person_session")
    .set({ active_workspace_id: target.id })
    .where("id", "=", session.id)
    .execute();
  await db
    .updateTable("person")
    .set({ last_workspace_id: target.id })
    .where("id", "=", session.personId)
    .execute();
  return target;
}

/**
 * Finds a workspace the person belongs to by its current or an earlier slug. `renamed` says the
 * slug was an earlier one, so the console can redirect to the current address.
 */
export async function findBySlug(
  db: Db,
  personId: string,
  slug: string,
): Promise<{ workspace: WorkspaceSummary; renamed: boolean } | null> {
  const all = await listMemberships(db, personId);
  const current = all.find((workspace) => workspace.slug === slug);
  if (current) return { workspace: current, renamed: false };
  const old = await db
    .selectFrom("workspace_old_slug")
    .select("workspace_id")
    .where("slug", "=", slug)
    .executeTakeFirst();
  const renamed = old ? all.find((workspace) => workspace.id === old.workspace_id) : undefined;
  return renamed ? { workspace: renamed, renamed: true } : null;
}
