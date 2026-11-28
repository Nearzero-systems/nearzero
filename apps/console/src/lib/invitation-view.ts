import type { Role } from "@nearzero/shared";
import { type ApiError, isApiError } from "./api-error.ts";
import type { InvitationInspection, PendingInvitation } from "./data/types.ts";

/**
 * Every state of the invitee's page (spec 4.5), worked out from what the API says about the
 * link and whether someone is signed in.
 */

/** Who sent the invitation, by their real name, or null: the page then keeps its plain words. */
type Inviter = { inviterName: string | null };
/** What a used-up link still lists under its message (31a G1-08). */
type Details = { role: Role; email: string };

export type InvitationView =
  | { kind: "incomplete" }
  | { kind: "not-found" }
  | { kind: "unavailable" }
  | ({ kind: "expired"; workspaceName: string } & Inviter & Details)
  | ({ kind: "cancelled"; workspaceName: string } & Inviter & Details)
  | ({ kind: "accepted"; workspaceName: string } & Inviter & Details)
  | ({
      kind: "other-email";
      workspaceName: string;
      email: string;
      signedInEmail: string;
    } & Inviter)
  /** Signed out with a live link: the sign-in page (existing account) or sign-up. */
  | { kind: "sign-in"; workspaceName: string; email: string }
  | { kind: "sign-up"; workspaceName: string; email: string }
  | ({ kind: "pending"; workspaceName: string; role: Role; email: string } & Inviter);

/**
 * The line under the heading (spec 4.5, 30a R1-09, 31a G1-08): it names who sent the invitation
 * when they have a real name, as the invitation email does. An accepted link says there's nothing
 * left to do, or to sign in when signed out. Null for states without one.
 */
export function invitationNote(view: InvitationView, signedIn = true): string | null {
  const who = "inviterName" in view ? view.inviterName : null;
  switch (view.kind) {
    case "pending":
      return who
        ? `${who} invited you to join ${view.workspaceName} on Nearzero.`
        : `You've been invited to join ${view.workspaceName} on Nearzero.`;
    case "other-email":
      return who
        ? `${who} invited you to join ${view.workspaceName} as ${view.email}. You're signed in as ${view.signedInEmail}.`
        : `It was sent to ${view.email}, and you're signed in as ${view.signedInEmail}.`;
    case "expired":
      return who
        ? `The invitation to ${view.workspaceName} can't be used any more. Ask ${who} to send it again.`
        : `The invitation to ${view.workspaceName} can't be used any more.`;
    case "cancelled":
      return who
        ? `The invitation to ${view.workspaceName} was withdrawn or declined, so it can't be used any more. If you still want to join, ask ${who} for a new one.`
        : `The invitation to ${view.workspaceName} can't be used any more.`;
    case "accepted":
      return signedIn
        ? "There's nothing left to do with this link."
        : `Sign in to open ${view.workspaceName}.`;
    case "incomplete":
      return "The invitation link is missing its code. Open the link from your invitation email again.";
    case "not-found":
      return "This link doesn't match any invitation. It may be mistyped or replaced by a newer one. Ask the person who invited you to send it again.";
    case "unavailable":
      return "Something went wrong on our side. Try again in a moment.";
    default:
      return null;
  }
}

export const INVITATION_TITLES = {
  incomplete: "This link is incomplete",
  "not-found": "Invitation not found",
  unavailable: "Couldn't load this invitation",
  expired: "This invitation has expired",
  cancelled: "This invitation was cancelled",
  accepted: "This invitation was already accepted",
  "other-email": "This invitation is for another email",
} as const;

/** A token from a link: at least 16 characters, as the API requires. */
export function looksLikeToken(token: string | null | undefined): token is string {
  return typeof token === "string" && token.trim().length >= 16 && token.length <= 256;
}

export function invitationView(
  result: InvitationInspection | ApiError | null,
  signedIn: boolean,
): InvitationView {
  if (result === null) return { kind: "incomplete" };
  if (isApiError(result)) {
    if (result.code === "invalid_request" && result.field("token")) return { kind: "incomplete" };
    if (result.code === "not_found") return { kind: "not-found" };
    return { kind: "unavailable" };
  }
  if (result.state === "not_found") return { kind: "not-found" };
  const { workspaceName } = result;
  const inviterName = result.inviterName ?? null;
  const details = { role: result.role, email: result.email };
  if (result.state === "expired")
    return { kind: "expired", workspaceName, inviterName, ...details };
  if (result.state === "cancelled") {
    return { kind: "cancelled", workspaceName, inviterName, ...details };
  }
  if (result.state === "accepted") {
    return { kind: "accepted", workspaceName, inviterName, ...details };
  }
  if (result.forAnotherEmail && result.signedInEmail) {
    return {
      kind: "other-email",
      workspaceName,
      email: result.email,
      signedInEmail: result.signedInEmail,
      inviterName,
    };
  }
  if (!signedIn) {
    return result.accountExists
      ? { kind: "sign-in", workspaceName, email: result.email }
      : { kind: "sign-up", workspaceName, email: result.email };
  }
  return { kind: "pending", workspaceName, role: result.role, email: result.email, inviterName };
}

/** An invitation the bell or the API's next step named by id, for the signed-in person. */
export function invitationByIdView(
  list: PendingInvitation[] | ApiError,
  id: string,
  email: string,
): InvitationView {
  if (isApiError(list)) return { kind: "unavailable" };
  const found = list.find((item) => item.id === id);
  if (!found) return { kind: "not-found" };
  return {
    kind: "pending",
    workspaceName: found.workspaceName,
    role: found.role,
    email,
    inviterName: found.inviterName ?? null,
  };
}
