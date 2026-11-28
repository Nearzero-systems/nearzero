import type { APIRoute } from "astro";
import { isApiError } from "../../lib/api-error.ts";
import { consoleData } from "../../lib/data/index.ts";
import { setFlash } from "../../lib/flash.ts";
import { destinationAfter } from "../../lib/next-step.ts";

/** "Accept invitation" from the bell (spec 11.5), after its "Join this workspace?" confirm. */
export const POST: APIRoute = async (context) => {
  const form = await context.request.formData();
  const id = form.get("invitationId");
  const back = form.get("back");
  const fallback = typeof back === "string" && /^\/[\w\-./~%]*$/.test(back) ? back : "/";
  if (typeof id !== "string" || !id) return context.redirect(fallback, 303);
  try {
    const joined = await consoleData(context).acceptInvitation({ id: id.slice(0, 64) });
    setFlash(context, joined.message);
    return context.redirect(
      destinationAfter({ next: joined.next, workspaceSlug: joined.workspace.slug }),
      303,
    );
  } catch (error) {
    if (!isApiError(error)) throw error;
    if (error.code === "unauthenticated") return context.redirect("/sign-in", 303);
    setFlash(context, error.message, "error");
    return context.redirect(fallback, 303);
  }
};

export const GET: APIRoute = (context) => context.redirect("/");
