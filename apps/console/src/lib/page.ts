import type { AstroGlobal } from "astro";
import { isApiError } from "./api-error.ts";
import {
  type ConsoleData,
  consoleData,
  type PendingInvitation,
  type SessionInfo,
  type Viewer,
  type WorkspaceAccess,
  type WorkspaceSummary,
} from "./data/index.ts";
import { onboardingPath, signInPath } from "./next-step.ts";
import { pathAfterWorkspace } from "./routes.ts";
import { isSecureRequest } from "./secure-cookie.ts";

export interface DashboardContext {
  data: ConsoleData;
  viewer: Viewer;
  workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  canAddWorkspace: boolean;
  access: WorkspaceAccess;
  /** Invitations waiting for the person (the bell). */
  invitations: PendingInvitation[];
}

/** Remembers which invitation this browser was already sent to, so it is shown once. */
export const SEEN_INVITATION_COOKIE = "nz_invitation_seen";

/** The session, or the page to show when the API can't be reached. */
export async function sessionOrUnavailable(astro: AstroGlobal): Promise<SessionInfo | Response> {
  try {
    return await consoleData(astro).session();
  } catch (error) {
    if (isApiError(error) && error.code !== "control_unreachable" && error.status < 500)
      throw error;
    return astro.rewrite("/unavailable");
  }
}

/**
 * Loads what every dashboard page needs (spec 4.1, 4.4):
 * - signed out: to sign-in, coming back here afterwards;
 * - a pending invitation the person hasn't been shown yet: to its page, once;
 * - unfinished onboarding: to its next step;
 * - a workspace slug that isn't the active workspace's (another one, or an old name): to the
 *   same page under the active workspace's address. It never switches workspaces.
 */
export async function dashboardContext(
  astro: AstroGlobal,
  options: { checkSlug?: boolean } = {},
): Promise<DashboardContext | Response> {
  const data = consoleData(astro);
  const session = await sessionOrUnavailable(astro);
  if (session instanceof Response) return session;
  if (!session.signedIn) return astro.redirect(signInPath(astro.url.pathname + astro.url.search));

  const { next } = session;
  if (next.kind === "invitation") {
    if (astro.cookies.get(SEEN_INVITATION_COOKIE)?.value !== next.invitationId) {
      astro.cookies.set(SEEN_INVITATION_COOKIE, next.invitationId, {
        path: "/",
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureRequest(astro),
        maxAge: 7 * 24 * 60 * 60,
      });
      return astro.redirect(`/invitation?id=${encodeURIComponent(next.invitationId)}`);
    }
  } else if (next.kind === "onboarding") {
    return astro.redirect(onboardingPath(next.step));
  }

  const workspace = session.workspace;
  if (!workspace) return astro.redirect("/no-workspace");
  if (options.checkSlug !== false && astro.params.workspace !== workspace.slug) {
    const rest = pathAfterWorkspace(astro.url.pathname);
    return astro.redirect(`/${workspace.slug}/dashboard${rest}${astro.url.search}`);
  }

  // The bell's recent deployments (spec 11.5) start loading now, beside the rest; the shell
  // reads the same answer later.
  void data.recent();
  try {
    const [workspaces, access, invitations] = await Promise.all([
      data.workspaces(),
      data.access(),
      data.pendingInvitations().catch(() => []),
    ]);
    return {
      data,
      viewer: session.viewer,
      workspace,
      workspaces: workspaces.list,
      canAddWorkspace: workspaces.canAdd,
      access,
      invitations,
    };
  } catch (error) {
    if (isApiError(error) && error.code === "unauthenticated") {
      return astro.redirect(signInPath(astro.url.pathname + astro.url.search));
    }
    return astro.rewrite("/unavailable");
  }
}

/** Reads one trimmed text field from a submitted form. */
export function formText(form: FormData, name: string, max = 1000): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Reads a password exactly as typed (never trimmed), capped. */
export function formSecret(form: FormData, name: string, max = 1024): string {
  const value = form.get(name);
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Whether the role reaches everything in its workspace. */
export function isManager(role: WorkspaceSummary["role"]): boolean {
  return role === "owner" || role === "admin";
}

export interface OnboardingContext {
  data: ConsoleData;
  viewer: Viewer;
  workspace: WorkspaceSummary | null;
}

/**
 * Onboarding pages open only on their own step (spec 4.3): someone signed out goes to sign-in,
 * someone on another step goes to it, and someone finished goes on to the Agent.
 */
export async function onboardingContext(
  astro: AstroGlobal,
  step: "workspace" | "invite" | "name",
): Promise<OnboardingContext | Response> {
  const data = consoleData(astro);
  const session = await sessionOrUnavailable(astro);
  if (session instanceof Response) return session;
  if (!session.signedIn) return astro.redirect("/sign-in");
  const current = session.viewer.onboardingStep;
  if (current !== step) {
    if (current) return astro.redirect(onboardingPath(current));
    return astro.redirect(session.workspace ? `/${session.workspace.slug}/dashboard/agent` : "/");
  }
  return { data, viewer: session.viewer, workspace: session.workspace };
}
