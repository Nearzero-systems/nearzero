import { SLUG_MAX, slugify } from "@nearzero/shared";
import { sql } from "kysely";
import type { Db } from "../db/database.ts";
import { readableCode } from "../security/tokens.ts";

/**
 * Workspace web addresses (spec 04 4.4): from the name, lowercase, other characters become
 * dashes, at most 48 characters, a numeric suffix on collision, and a random id when the result
 * is empty or reserved. Slugs a workspace used before keep redirecting, so they are never given
 * to another workspace.
 */

/** Words the console uses for its own pages, which a workspace can't take. */
export const RESERVED_SLUGS = new Set([
  "_astro",
  "admin",
  "api",
  "app",
  "assets",
  "auth",
  "dashboard",
  "favicon",
  "health",
  "invitation",
  "invitations",
  "login",
  "logout",
  "me",
  "nearzero",
  "new",
  "onboarding",
  "profile",
  "register",
  "settings",
  "sign-in",
  "sign-out",
  "sign-up",
  "signin",
  "signup",
  "static",
  "www",
]);

/** A workspace's slug from its name: the shared slug rule, at most 48 characters. */
export function slugFromName(name: string): string {
  return slugify(name, SLUG_MAX);
}

function randomSlug(): string {
  return `ws-${readableCode(10)}`;
}

/**
 * The slug a workspace with this name gets. Call it inside the transaction that writes the slug,
 * after {@link lockSlugs}, so two workspaces never take the same one.
 */
export async function chooseSlug(db: Db, name: string, workspaceId?: string): Promise<string> {
  const base = slugFromName(name);
  if (base === "" || RESERVED_SLUGS.has(base)) return randomSlug();

  const pattern = `^${base}(-[0-9]+)?$`;
  const taken = await sql<{ slug: string; workspace_id: string }>`
    select slug, id as workspace_id from workspace where slug ~ ${pattern}
    union all
    select slug, workspace_id from workspace_old_slug where slug ~ ${pattern}
  `.execute(db);
  const usedByOthers = new Set(
    taken.rows.filter((row) => row.workspace_id !== workspaceId).map((row) => row.slug),
  );
  if (!usedByOthers.has(base)) return base;
  for (let n = 2; n < 100_000; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!usedByOthers.has(candidate)) return candidate;
  }
  return randomSlug();
}

/** Serializes slug choices for the rest of the transaction. */
export async function lockSlugs(db: Db): Promise<void> {
  await sql`select pg_advisory_xact_lock(7204315119)`.execute(db);
}
