import type { APIRoute } from "astro";
import { isApiError } from "../lib/api-error.ts";
import { consoleData } from "../lib/data/index.ts";
import { safeLocalPath } from "../lib/next-step.ts";

/**
 * Log out (POST only): ends the session in the control plane and clears its cookie. An optional
 * `next` stays on this console: a path, never another site.
 */
export const POST: APIRoute = async (context) => {
  const form = await context.request.formData().catch(() => null);
  try {
    await consoleData(context).signOut();
  } catch (error) {
    if (!isApiError(error)) throw error;
    // The session is gone on this side either way: drop the cookie and carry on.
    context.cookies.delete("nz_session", { path: "/" });
  }
  const next = form?.get("next");
  const target = (typeof next === "string" && safeLocalPath(next)) || "/sign-in";
  return context.redirect(target, 303);
};

export const GET: APIRoute = (context) => context.redirect("/sign-in");
