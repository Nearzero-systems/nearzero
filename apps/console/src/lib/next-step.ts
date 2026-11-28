import type { NextStep, OnboardingStep } from "./data/types.ts";
import { agentPath } from "./routes.ts";

/**
 * Where a person goes after signing in, accepting an invitation or finishing a step (spec 4.1):
 * a pending invitation first, then unfinished onboarding, then the page they asked for, then the
 * Agent of their active workspace.
 */

export const ONBOARDING_PATHS: Record<OnboardingStep, string> = {
  workspace: "/onboarding/workspace",
  invite: "/onboarding/team",
  name: "/onboarding/welcome",
};

export function onboardingPath(step: OnboardingStep): string {
  return ONBOARDING_PATHS[step];
}

/**
 * A path on this console that is safe to send someone to: it starts with one slash, never
 * names another host, and holds only plain path and query characters.
 */
export function safeLocalPath(value: string | null | undefined): string | null {
  if (!value || value.length > 600) return null;
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  if (!/^\/[\w\-./~%?=&+]*$/.test(value)) return null;
  // Never back to the forms that sent them here.
  if (/^\/(sign-in|sign-up|sign-out)(\/|\?|$)/.test(value)) return null;
  return value;
}

export interface DestinationInput {
  next: NextStep;
  /** The active workspace's slug, when the person has one. */
  workspaceSlug: string | null;
  /** The page the person asked for before signing in (already checked with safeLocalPath). */
  requested?: string | null;
  /** The person arrived through an invitation link that is still pending. */
  invitationLink?: boolean;
}

export function destinationAfter(input: DestinationInput): string {
  if (input.invitationLink) return "/invitation";
  if (input.next.kind === "invitation") {
    return `/invitation?id=${encodeURIComponent(input.next.invitationId)}`;
  }
  if (input.next.kind === "onboarding") return onboardingPath(input.next.step);
  if (input.requested) return input.requested;
  return input.workspaceSlug ? agentPath(input.workspaceSlug) : "/no-workspace";
}

/** "/sign-in", with the page to return to when there is one. */
export function signInPath(requested: string | null | undefined): string {
  const safe = safeLocalPath(requested);
  return safe ? `/sign-in?next=${encodeURIComponent(safe)}` : "/sign-in";
}

/**
 * The page to open after signing in, from the sign-in address: `next`, or 0.1.x's `callbackUrl`
 * (old bookmarks and links, spec 29.5), with the same check (this console's paths only). A
 * callback written as a full address counts only when it names this console's own host.
 */
export function requestedPage(query: URLSearchParams, here: URL): string | null {
  const next = safeLocalPath(query.get("next"));
  if (next) return next;
  const callback = query.get("callbackUrl");
  if (!callback) return null;
  if (callback.startsWith("/")) return safeLocalPath(callback);
  try {
    const url = new URL(callback);
    if (!/^https?:$/.test(url.protocol) || url.host !== here.host) return null;
    return safeLocalPath(`${url.pathname}${url.search}`);
  } catch {
    return null;
  }
}

/** An address from `?email=` to fill the sign-in form with (invitation sign-in links use it). */
export function prefilledEmail(query: URLSearchParams): string {
  const value = query.get("email")?.trim() ?? "";
  return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : "";
}
