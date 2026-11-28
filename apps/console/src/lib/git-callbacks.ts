import type { APIContext } from "astro";
import { isApiError } from "./api-error.ts";
import { consoleData } from "./data/index.ts";
import { setFlash } from "./flash.ts";
import { safeLocalPath } from "./next-step.ts";
import { settingsPath } from "./routes.ts";

/**
 * The pages GitHub, GitLab and Gitea send people back to (spec 16.1–16.5). Each passes what
 * the host sent to the control plane for the signed-in person, then sends them on: to GitHub's
 * install page after the app was created, or back to where they started (an Agent chat, the
 * new-application page) or Settings → Git providers, with the outcome as a toast. The host's
 * code never stays in the address bar.
 */

async function settingsAddress(context: APIContext): Promise<string> {
  try {
    const session = await consoleData(context).session();
    if (session.signedIn && session.workspace) {
      return settingsPath(session.workspace.slug, "git-providers");
    }
  } catch {
    // Fall back to the console's front page, which knows where to go.
  }
  return "/";
}

async function signedIn(context: APIContext): Promise<boolean> {
  try {
    const session = await consoleData(context).session();
    return session.signedIn;
  } catch {
    return false;
  }
}

export async function finishConnect(
  context: APIContext,
  work: () => Promise<{ redirect: string; external?: boolean; message?: string | null }>,
): Promise<Response> {
  if (!(await signedIn(context))) {
    setFlash(context, "Sign in, then connect the Git provider again.", "error");
    return context.redirect("/sign-in", 303);
  }
  try {
    const next = await work();
    if (next.message) setFlash(context, next.message, "success");
    if (next.external) return context.redirect(next.redirect, 303);
    return context.redirect(safeLocalPath(next.redirect) ?? (await settingsAddress(context)), 303);
  } catch (error) {
    if (!isApiError(error)) throw error;
    if (error.code === "control_unreachable") return context.rewrite("/unavailable");
    setFlash(context, error.message, "error");
    return context.redirect(await settingsAddress(context), 303);
  }
}

export function param(context: APIContext, name: string): string {
  return (context.url.searchParams.get(name) ?? "").slice(0, 2000);
}
