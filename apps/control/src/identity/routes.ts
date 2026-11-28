import {
  AppError,
  AVATAR_IMAGE_MAX_BYTES,
  CHALLENGE_COOKIE,
  changeEmailRequestSchema,
  changePasswordRequestSchema,
  emailConfirmationRequestSchema,
  invitationTokenSchema,
  onboardingInvitesRequestSchema,
  onboardingNameRequestSchema,
  onboardingWorkspaceRequestSchema,
  passwordConfirmationSchema,
  registerRequestSchema,
  signInRequestSchema,
  splitEmailList,
  twoFactorCodeRequestSchema,
  twoFactorEnableRequestSchema,
  twoFactorSetupRequestSchema,
  updateProfileRequestSchema,
} from "@nearzero/shared";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { recordAudit } from "../audit/audit.ts";
import { actorFor, auditActor, workspaceActorFor } from "../http/actor.ts";
import { clientInfo } from "../http/client.ts";
import type { AppEnv } from "../http/context.ts";
import { readBody } from "../http/validate.ts";
import {
  acceptInvitation,
  declineInvitation,
  findInvitationByToken,
  findInvitationForPerson,
  inviterNameOf,
  pendingInvitationsFor,
  stateOf,
} from "../members/invitations.ts";
import type { ControlServices } from "../services.ts";
import { firstWorkspaceId } from "../workspaces/workspaces.ts";
import { httpsConsoleAddress } from "./console-address.ts";
import { cancelEmailChange, confirmEmail, resendConfirmation } from "./email-confirmation.ts";
import {
  onboardingView,
  saveMemberName,
  saveOwnerWorkspace,
  sendOnboardingInvites,
  skipOnboardingInvites,
} from "./onboarding.ts";
import { findPersonByEmail } from "./people.ts";
import {
  changeEmail,
  changePassword,
  checkOwnPassword,
  meView,
  nextStepFor,
  readAvatarImage,
  removeAvatarImage,
  saveAvatarImage,
  sessionView,
  updateProfile,
} from "./profile.ts";
import { registerFromInvitation } from "./registration.ts";
import { clearSessionCookie, endSession, requireSession, setSessionCookie } from "./sessions.ts";
import { CHALLENGE_SECONDS, completeTwoFactor, signIn } from "./sign-in.ts";
import {
  confirmSetup,
  disableTwoFactor,
  regenerateBackupCodes,
  startSetup,
  twoFactorStatus,
} from "./two-factor.ts";

/**
 * Sign-in, sign-up through an invitation, the invitee's page, the signed-in person's profile and
 * two-factor settings, and onboarding (spec 04 4.1 to 4.6).
 */
export function identityRoutes(services: ControlServices): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const { db, log } = services;

  const client = (c: Context<AppEnv>) => clientInfo(c, services.trustedProxies);
  const requestContext = (c: Context<AppEnv>) => ({
    client: client(c),
    userAgent: c.req.header("user-agent") ?? null,
  });

  /** A browser that signs in again leaves its previous session behind, ended. */
  async function replaceSession(c: Context<AppEnv>): Promise<void> {
    const previous = c.get("session");
    if (previous) await endSession(db, previous.id);
  }

  // ---- Sign-in (spec 04 4.1)

  /** Where the console sends plain-HTTP visits to the server's IP address (spec 04 4.1). */
  app.get("/auth/console-address", async (c) => {
    return c.json({ httpsUrl: await httpsConsoleAddress(services) });
  });

  app.get("/auth/session", async (c) => {
    c.header("cache-control", "no-store");
    const session = c.get("session");
    if (!session) {
      return c.json({
        signedIn: false,
        setup: { hasOwner: (await firstWorkspaceId(db)) !== null },
      });
    }
    return c.json(await sessionView(services, session));
  });

  app.post("/auth/sign-in", async (c) => {
    const input = await readBody(c, signInRequestSchema);
    const context = requestContext(c);
    const outcome = await signIn(services, input.email, input.password, context);
    if (outcome.kind === "two_factor") {
      setCookie(c, CHALLENGE_COOKIE, outcome.challengeToken, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        secure: context.client.secure,
        maxAge: CHALLENGE_SECONDS,
      });
      return c.json({ status: "two_factor_required", expiresInSeconds: CHALLENGE_SECONDS });
    }
    await replaceSession(c);
    setSessionCookie(c, outcome.token, context.client.secure);
    return c.json({ status: "signed_in", next: await nextStepFor(db, outcome.personId) });
  });

  app.post("/auth/two-factor", async (c) => {
    const input = await readBody(c, twoFactorCodeRequestSchema);
    const context = requestContext(c);
    const challenge = getCookie(c, CHALLENGE_COOKIE);
    if (!challenge) {
      throw new AppError(
        "unauthenticated",
        "This sign-in has expired. Enter your email and password again.",
      );
    }
    const result = await completeTwoFactor(services, challenge, input.code, context);
    deleteCookie(c, CHALLENGE_COOKIE, { path: "/", secure: context.client.secure });
    await replaceSession(c);
    setSessionCookie(c, result.token, context.client.secure);
    return c.json({ status: "signed_in", next: await nextStepFor(db, result.personId) });
  });

  app.post("/auth/sign-out", async (c) => {
    const session = c.get("session");
    const secure = client(c).secure;
    if (session) {
      await endSession(db, session.id);
      await recordAudit(
        db,
        log,
        { kind: "person", personId: session.personId, clientAddress: client(c).address },
        { action: "auth.sign-out" },
      );
    }
    clearSessionCookie(c, secure);
    return c.json({ signedOut: true });
  });

  // ---- Registration through an invitation (spec 04 4.2, spec 24 G5)

  app.post("/auth/register", async (c) => {
    const input = await readBody(c, registerRequestSchema);
    const context = requestContext(c);
    const result = await registerFromInvitation(services, input, context);
    await replaceSession(c);
    setSessionCookie(c, result.token, context.client.secure);
    return c.json({ status: "signed_in", next: await nextStepFor(db, result.personId) }, 201);
  });

  // ---- The invitee's page (spec 04 4.5)

  app.post("/invitations/inspect", async (c) => {
    const { token } = await readBody(c, invitationTokenSchema);
    const record = await findInvitationByToken(db, token);
    if (!record) return c.json({ state: "not_found" });
    const state = stateOf(record);
    const session = c.get("session");
    const signedInEmail = session
      ? ((
          await db
            .selectFrom("person")
            .select("email")
            .where("id", "=", session.personId)
            .executeTakeFirst()
        )?.email ?? null)
      : null;
    return c.json({
      state,
      workspaceName: record.workspaceName,
      role: record.role,
      email: record.email,
      // Who sent it, by their real name, so the page can say so (30a R1-09).
      inviterName: await inviterNameOf(db, record.invitedBy),
      // Only a holder of a live link learns whether the invited address has an account, which
      // decides between the sign-in and sign-up pages.
      ...(state === "pending"
        ? { accountExists: (await findPersonByEmail(db, record.email)) !== undefined }
        : {}),
      signedInEmail,
      forAnotherEmail: signedInEmail !== null && signedInEmail !== record.email,
    });
  });

  app.post("/invitations/accept", async (c) => {
    const { token } = await readBody(c, invitationTokenSchema);
    const actor = await actorFor(c, services);
    const result = await acceptInvitation(services, actor, await requireRecord(token));
    return c.json({ ...result, next: await nextStepFor(db, actor.personId) });
  });

  app.post("/invitations/decline", async (c) => {
    const { token } = await readBody(c, invitationTokenSchema);
    const actor = await actorFor(c, services);
    await declineInvitation(services, actor, await requireRecord(token));
    return c.json(await afterDecline(c, actor.personId, actor.sessionId));
  });

  async function requireRecord(token: string) {
    const record = await findInvitationByToken(db, token);
    if (!record) throw new AppError("not_found", "Invitation not found");
    return record;
  }

  /** Declining signs the person out when their onboarding is unfinished (spec 04 4.5). */
  async function afterDecline(c: Context<AppEnv>, personId: string, sessionId: string) {
    const person = await db
      .selectFrom("person")
      .select("onboarding_step")
      .where("id", "=", personId)
      .executeTakeFirstOrThrow();
    if (person.onboarding_step !== null) {
      await endSession(db, sessionId);
      clearSessionCookie(c, client(c).secure);
      return { declined: true, signedOut: true };
    }
    return { declined: true, signedOut: false };
  }

  // ---- The signed-in person's invitations (the bell)

  app.get("/me/invitations", async (c) => {
    const actor = await actorFor(c, services);
    const me = await meView(services, actor.personId);
    return c.json({
      invitations: me.emailVerified ? await pendingInvitationsFor(db, actor.email) : [],
    });
  });

  async function invitationById(personId: string, email: string, invitationId: string) {
    const me = await meView(services, personId);
    if (!me.emailVerified) {
      throw new AppError(
        "forbidden",
        `Open the invitation link sent to ${email} to accept it: this account's email address hasn't been confirmed.`,
      );
    }
    const record = await findInvitationForPerson(db, invitationId, email);
    if (!record) throw new AppError("not_found", "Invitation not found");
    return record;
  }

  app.post("/me/invitations/:invitationId/accept", async (c) => {
    const actor = await actorFor(c, services);
    const record = await invitationById(actor.personId, actor.email, c.req.param("invitationId"));
    const result = await acceptInvitation(services, actor, record);
    return c.json({ ...result, next: await nextStepFor(db, actor.personId) });
  });

  app.post("/me/invitations/:invitationId/decline", async (c) => {
    const actor = await actorFor(c, services);
    const record = await invitationById(actor.personId, actor.email, c.req.param("invitationId"));
    await declineInvitation(services, actor, record);
    return c.json(await afterDecline(c, actor.personId, actor.sessionId));
  });

  // ---- Profile (spec 04 4.6)

  app.get("/me", async (c) => {
    const actor = await actorFor(c, services);
    return c.json(await meView(services, actor.personId));
  });

  app.patch("/me", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, updateProfileRequestSchema);
    const me = await updateProfile(services, actor, input);
    return c.json({ person: me, message: "Profile updated" });
  });

  app.post("/me/email", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, changeEmailRequestSchema);
    const result = await changeEmail(services, actor, input);
    return c.json({
      person: result.me,
      confirmationSentTo: result.confirmationSentTo,
      message: `We sent a link to ${result.confirmationSentTo}. Open it to finish the change; until then ${actor.email} stays in use.`,
    });
  });

  // ---- Confirming an email address (spec 04 4.6, 30a R1-02)

  app.post("/me/email/confirmation", async (c) => {
    const actor = await actorFor(c, services);
    const { sentTo } = await resendConfirmation(services, actor);
    return c.json({
      person: await meView(services, actor.personId),
      sentTo,
      message: `We sent a link to ${sentTo}. Open it while signed in to confirm the address.`,
    });
  });

  app.delete("/me/email/change", async (c) => {
    const actor = await actorFor(c, services);
    await cancelEmailChange(services, actor);
    return c.json({ person: await meView(services, actor.personId) });
  });

  app.post("/me/email/confirm", async (c) => {
    const actor = await actorFor(c, services);
    const { token } = await readBody(c, emailConfirmationRequestSchema);
    const result = await confirmEmail(services, actor, token);
    return c.json({
      person: await meView(services, actor.personId),
      ...result,
      message: result.changed
        ? `Your email address is now ${result.email}.`
        : `${result.email} is confirmed.`,
    });
  });

  app.post("/me/password", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, changePasswordRequestSchema);
    const result = await changePassword(services, actor, input);
    return c.json({ changed: true, ...result });
  });

  app.put("/me/avatar", async (c) => {
    const actor = await actorFor(c, services);
    const declared = Number(c.req.header("content-length") ?? "0");
    if (declared > AVATAR_IMAGE_MAX_BYTES) {
      throw new AppError("payload_too_large", "Use an image under 2 MB.");
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const me = await saveAvatarImage(services, actor, bytes);
    return c.json({ person: me, message: "Profile updated" });
  });

  app.delete("/me/avatar", async (c) => {
    const actor = await actorFor(c, services);
    return c.json({ person: await removeAvatarImage(services, actor), message: "Profile updated" });
  });

  app.get("/people/:personId/avatar", async (c) => {
    const session = requireSession(c);
    const image = await readAvatarImage(db, session.personId, c.req.param("personId"));
    if (!image) throw new AppError("not_found", "There is no avatar image here.");
    return c.body(new Uint8Array(image.bytes), 200, {
      "content-type": image.contentType,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    });
  });

  // ---- Two-factor (spec 04 4.6, spec 24 G12)

  app.get("/me/two-factor", async (c) => {
    const actor = await actorFor(c, services);
    return c.json(await twoFactorStatus(db, actor.personId));
  });

  app.post("/me/two-factor/setup", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, twoFactorSetupRequestSchema);
    await checkOwnPassword(services, actor.personId, input.password, "password");
    const setup = await startSetup(
      db,
      services.secrets,
      { id: actor.personId, email: actor.email },
      input.issuer,
    );
    c.header("cache-control", "no-store");
    return c.json(setup);
  });

  app.post("/me/two-factor/enable", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, twoFactorEnableRequestSchema);
    await confirmSetup(db, services.secrets, actor.personId, input.code, services.now());
    await recordAudit(db, log, auditActor(actor), {
      action: "person.two-factor-enabled",
      target: { kind: "person", id: actor.personId },
    });
    return c.json({ enabled: true, message: "2FA configured successfully" });
  });

  /** The Manage dialog's password step. Only checks; codes never change here (spec 24 G12). */
  app.post("/me/two-factor/verify-password", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, passwordConfirmationSchema);
    await checkOwnPassword(services, actor.personId, input.password, "password");
    return c.json({ ok: true });
  });

  app.post("/me/two-factor/backup-codes", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, passwordConfirmationSchema);
    await checkOwnPassword(services, actor.personId, input.password, "password");
    const codes = await regenerateBackupCodes(db, actor.personId);
    await recordAudit(db, log, auditActor(actor), {
      action: "person.backup-codes-regenerated",
      target: { kind: "person", id: actor.personId },
    });
    c.header("cache-control", "no-store");
    return c.json({ backupCodes: codes });
  });

  app.post("/me/two-factor/disable", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, passwordConfirmationSchema);
    await checkOwnPassword(services, actor.personId, input.password, "password");
    const wasOn = await disableTwoFactor(db, actor.personId);
    if (wasOn) {
      await recordAudit(db, log, auditActor(actor), {
        action: "person.two-factor-disabled",
        target: { kind: "person", id: actor.personId },
      });
    }
    return c.json({ enabled: false });
  });

  // ---- Onboarding (spec 04 4.3)

  app.get("/onboarding", async (c) => {
    const actor = await actorFor(c, services);
    return c.json(await onboardingView(db, actor.personId));
  });

  app.post("/onboarding/workspace", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, onboardingWorkspaceRequestSchema);
    const result = await saveOwnerWorkspace(services, actor, input);
    return c.json({ ...result, onboarding: await onboardingView(db, actor.personId) });
  });

  app.post("/onboarding/invitations", async (c) => {
    const actor = await workspaceActorFor(c, services);
    const input = await readBody(c, onboardingInvitesRequestSchema);
    const results = await sendOnboardingInvites(services, actor, splitEmailList(input.emails));
    return c.json({ results, onboarding: await onboardingView(db, actor.personId) });
  });

  app.post("/onboarding/skip-invitations", async (c) => {
    const actor = await actorFor(c, services);
    await skipOnboardingInvites(services, actor);
    return c.json({ onboarding: await onboardingView(db, actor.personId) });
  });

  app.post("/onboarding/name", async (c) => {
    const actor = await actorFor(c, services);
    const input = await readBody(c, onboardingNameRequestSchema);
    await saveMemberName(services, actor, input.name);
    return c.json({ onboarding: await onboardingView(db, actor.personId) });
  });

  return app;
}
