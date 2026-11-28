import { SESSION_COOKIE } from "@nearzero/shared";
import type { AstroGlobal } from "astro";
import { consoleData } from "./data/index.ts";
import { projectsPath } from "./routes.ts";

/**
 * The way back from the 404 and 500 pages (spec 21.9b): "Go to your projects" for someone signed
 * in, "Sign in" for everyone else.
 */
export interface WayBack {
  label: string;
  href: string;
}

export const SIGN_IN_BACK: WayBack = { label: "Sign in", href: "/sign-in" };

/** The projects of the active workspace, whichever it is (the old /dashboard/… address). */
export const PROJECTS_BACK: WayBack = { label: "Go to your projects", href: "/dashboard/projects" };

/**
 * With `lookup`, asks the control plane whether the session cookie is still good and links
 * straight to the active workspace's projects. Without it (the 500 page, which must not depend on
 * anything that may have just failed) the cookie alone decides; a stale one ends at sign-in anyway.
 */
export async function wayBack(astro: AstroGlobal, options: { lookup: boolean }): Promise<WayBack> {
  if (!astro.cookies.has(SESSION_COOKIE)) return SIGN_IN_BACK;
  if (!options.lookup) return PROJECTS_BACK;
  try {
    const session = await consoleData(astro).session();
    if (!session.signedIn) return SIGN_IN_BACK;
    return session.workspace
      ? { label: PROJECTS_BACK.label, href: projectsPath(session.workspace.slug) }
      : PROJECTS_BACK;
  } catch {
    return PROJECTS_BACK;
  }
}
