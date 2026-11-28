import type { APIRoute } from "astro";
import { isApiError } from "../../lib/api-error.ts";
import { consoleData } from "../../lib/data/index.ts";
import { setFlash } from "../../lib/flash.ts";

/**
 * Switches the active workspace and keeps the current page under the new address (spec 4.4).
 * The kept path is checked so it can only point inside the dashboard.
 */
export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const id = form.get("workspaceId");
  const path = form.get("path");
  const data = consoleData(context);
  const rest = typeof path === "string" && /^(\/[\w\-.~%]+)*$/.test(path) ? path : "";
  // A project page doesn't exist in another workspace: land on its list instead.
  const kept = rest.startsWith("/projects/") ? "/projects" : rest;
  try {
    const workspace = typeof id === "string" ? await data.switchWorkspace(id.slice(0, 64)) : null;
    if (workspace) return context.redirect(`/${workspace.slug}/dashboard${kept}`, 303);
  } catch (error) {
    if (!isApiError(error)) throw error;
    if (error.code === "unauthenticated") return context.redirect("/sign-in", 303);
    setFlash(context, error.message, "error");
  }
  return context.redirect("/", 303);
};

export const GET: APIRoute = (context) => context.redirect("/");
