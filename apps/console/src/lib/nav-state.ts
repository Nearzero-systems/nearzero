/**
 * The primary sidebar on pages with the icon rail (spec 21.6). It starts open on the Agent page
 * and collapsed on a project's pages; once the person opens or closes it, that choice holds on
 * every rail page until they change it. Kept in a cookie so the server renders it on first paint.
 */

export type NavState = "open" | "closed";
export type RailPage = "agent" | "project";

export const NAV_COOKIE = "nz_nav";
export const NAV_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function parseNavState(value: unknown): NavState | null {
  return value === "open" || value === "closed" ? value : null;
}

export function resolveNavState(saved: unknown, page: RailPage): NavState {
  return parseNavState(saved) ?? (page === "agent" ? "open" : "closed");
}
