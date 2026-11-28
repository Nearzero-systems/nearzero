import type { AstroCookies } from "astro";
import { looksLikeToken } from "./invitation-view.ts";
import { type CookieContext, isSecureRequest } from "./secure-cookie.ts";

/**
 * An invitation link's token and emailed proof, kept in an HttpOnly cookie once the invitation
 * page has read them, so they leave the address bar at once (spec 21.9) and still reach sign-in,
 * sign-up and the accept button. The cookie lasts as long as an invitation can.
 */

export const INVITATION_COOKIE = "nz_invitation";
const MAX_AGE = 7 * 24 * 60 * 60;

export interface InvitationLink {
  token: string;
  proof?: string;
}

export function readInvitationLink(cookies: AstroCookies): InvitationLink | null {
  const raw = cookies.get(INVITATION_COOKIE)?.value;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { t?: unknown; p?: unknown };
    if (!looksLikeToken(typeof value.t === "string" ? value.t : null)) return null;
    const link: InvitationLink = { token: value.t as string };
    if (typeof value.p === "string" && value.p.length > 0 && value.p.length <= 256) {
      link.proof = value.p;
    }
    return link;
  } catch {
    return null;
  }
}

/** Secure over HTTPS (31a G1-13): the proof in it is what lets someone create the account. */
export function saveInvitationLink(context: CookieContext, link: InvitationLink): void {
  context.cookies.set(INVITATION_COOKIE, JSON.stringify({ t: link.token, p: link.proof }), {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(context),
    maxAge: MAX_AGE,
  });
}

export function forgetInvitationLink(cookies: AstroCookies): void {
  cookies.delete(INVITATION_COOKIE, { path: "/" });
}
