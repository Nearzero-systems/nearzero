import {
  AppError,
  AVATAR_IMAGE_MAX_BYTES,
  type AvatarColor,
  type AvatarKind,
} from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { addressMailRoute } from "../email/transport.ts";
import { type Actor, auditActor } from "../http/actor.ts";
import { pendingInvitationsFor } from "../members/invitations.ts";
import type { ControlServices } from "../services.ts";
import { isInstanceAdmin, resolveActiveWorkspace } from "../workspaces/workspaces.ts";
import { claimAttempts, PASSWORD_CHECK_LIMIT, releaseAttempts } from "./attempts.ts";
import { pendingEmailOf, startEmailChange } from "./email-confirmation.ts";
import { displayName } from "./names.ts";
import { type AvatarView, avatarImageIds, avatarOf, getPerson, hasRealName } from "./people.ts";
import { endOtherSessions } from "./sessions.ts";
import { twoFactorStatus } from "./two-factor.ts";

/** The signed-in person's own account (spec 04 4.6). */

export interface MeView {
  id: string;
  email: string;
  emailVerified: boolean;
  /** A new address waiting for its link to be opened; `email` stays in use until then. */
  pendingEmail: string | null;
  /**
   * Whether this server can email a link that confirms an address (the install's email
   * settings). Without it Profile offers no confirmation link (30a R1-02).
   */
  canEmailLinks: boolean;
  firstName: string | null;
  lastName: string | null;
  name: string;
  /** False for empty or email-derived names; greetings then say "Hi there". */
  hasRealName: boolean;
  avatar: AvatarView;
  twoFactor: { enabled: boolean; backupCodesLeft: number };
  isInstanceAdmin: boolean;
  onboarding: { step: "workspace" | "invite" | "name" | null };
  createdAt: string;
}

export async function meView(services: ControlServices, personId: string): Promise<MeView> {
  const { db } = services;
  const person = await getPerson(db, personId);
  const [images, twoFactor, instanceAdmin, pendingEmail] = await Promise.all([
    avatarImageIds(db, [personId]),
    twoFactorStatus(db, personId),
    isInstanceAdmin(db, personId),
    pendingEmailOf(db, personId),
  ]);
  return {
    id: person.id,
    email: person.email,
    emailVerified: person.email_verified_at !== null,
    pendingEmail,
    canEmailLinks: addressMailRoute(services) !== null,
    firstName: person.first_name,
    lastName: person.last_name,
    name: displayName(person),
    hasRealName: hasRealName(person),
    avatar: avatarOf(person, images.has(personId)),
    twoFactor,
    isInstanceAdmin: instanceAdmin,
    onboarding: { step: person.onboarding_step },
    createdAt: person.created_at.toISOString(),
  };
}

export type NextStep =
  | { kind: "invitation"; invitationId: string; workspaceName: string }
  | { kind: "onboarding"; step: "workspace" | "invite" | "name" }
  | { kind: "home" };

/**
 * Where to go after signing in, in order: a pending invitation, unfinished onboarding, then the
 * requested page or the Agent (spec 04 4.1). Invitations are offered here only to accounts whose
 * address is proven; others accept through the emailed link.
 */
export async function nextStepFor(db: Db, personId: string): Promise<NextStep> {
  const person = await getPerson(db, personId);
  if (person.email_verified_at !== null) {
    const [invitation] = await pendingInvitationsFor(db, person.email);
    if (invitation) {
      return {
        kind: "invitation",
        invitationId: invitation.id,
        workspaceName: invitation.workspaceName,
      };
    }
  }
  if (person.onboarding_step) return { kind: "onboarding", step: person.onboarding_step };
  return { kind: "home" };
}

export async function sessionView(
  services: ControlServices,
  session: { id: string; personId: string; activeWorkspaceId: string | null },
) {
  const { db } = services;
  const [me, workspace, next] = await Promise.all([
    meView(services, session.personId),
    resolveActiveWorkspace(db, session),
    nextStepFor(db, session.personId),
  ]);
  return { signedIn: true as const, person: me, workspace, next };
}

export const WRONG_CURRENT_PASSWORD = "Current password is incorrect";

/** Checks the person's own password before a sensitive change, with a per-account limit. */
export async function checkOwnPassword(
  services: ControlServices,
  personId: string,
  password: string,
  field = "currentPassword",
): Promise<void> {
  const { db } = services;
  // Counted before the check, so wrong passwords sent all at once still stop at the limit.
  const claimed = await claimAttempts(db, [{ limit: PASSWORD_CHECK_LIMIT, subject: personId }]);
  if (!claimed) {
    throw new AppError(
      "rate_limited",
      "Too many wrong passwords. Wait a few minutes and try again.",
    );
  }
  const person = await db
    .selectFrom("person")
    .select("password_hash")
    .where("id", "=", personId)
    .executeTakeFirstOrThrow();
  if (!(await services.passwords.verify(password, person.password_hash))) {
    throw new AppError("invalid_request", WRONG_CURRENT_PASSWORD, {
      fields: { [field]: WRONG_CURRENT_PASSWORD },
    });
  }
  await releaseAttempts(db, claimed);
}

export interface ProfileChanges {
  firstName?: string | undefined;
  lastName?: string | undefined;
  avatarKind?: AvatarKind | undefined;
  /** A named color or a custom #rrggbb (spec 4.6). */
  avatarColor?: AvatarColor | string | undefined;
}

export async function updateProfile(
  services: ControlServices,
  actor: Actor,
  changes: ProfileChanges,
): Promise<MeView> {
  const { db } = services;
  if (changes.avatarKind === "image") {
    const image = await avatarImageIds(db, [actor.personId]);
    if (!image.has(actor.personId)) {
      throw new AppError("invalid_request", "Upload an image first, then choose it.", {
        fields: { avatarKind: "Upload an image first, then choose it." },
      });
    }
  }
  await db
    .updateTable("person")
    .set({
      ...(changes.firstName !== undefined ? { first_name: changes.firstName } : {}),
      ...(changes.lastName !== undefined ? { last_name: changes.lastName || null } : {}),
      ...(changes.avatarKind !== undefined ? { avatar_kind: changes.avatarKind } : {}),
      ...(changes.avatarColor !== undefined ? { avatar_color: changes.avatarColor } : {}),
      updated_at: new Date(),
    })
    .where("id", "=", actor.personId)
    .execute();
  return meView(services, actor.personId);
}

/**
 * A new email needs the current password (spec 24 G9) and counts only once the person opens the
 * link sent to it (spec 04 4.6): until then the current address stays in use. The notice goes to
 * the old address when the change takes effect (email-confirmation.ts).
 */
export async function changeEmail(
  services: ControlServices,
  actor: Actor,
  input: { email: string; currentPassword: string },
): Promise<{ me: MeView; confirmationSentTo: string }> {
  await checkOwnPassword(services, actor.personId, input.currentPassword);
  await startEmailChange(services, actor, input.email);
  return { me: await meView(services, actor.personId), confirmationSentTo: input.email };
}

/** A new password signs out the account's other sessions (spec 04 4.1). */
export async function changePassword(
  services: ControlServices,
  actor: Actor,
  input: { currentPassword: string; newPassword: string },
): Promise<{ otherSessionsEnded: number }> {
  const { db } = services;
  await checkOwnPassword(services, actor.personId, input.currentPassword);
  const hash = await services.passwords.hash(input.newPassword);
  await db
    .updateTable("person")
    .set({ password_hash: hash, password_changed_at: sql<Date>`now()`, updated_at: new Date() })
    .where("id", "=", actor.personId)
    .execute();
  const ended = await endOtherSessions(db, actor.personId, actor.sessionId);
  await recordAudit(db, services.log, auditActor(actor), {
    action: "person.password-changed",
    target: { kind: "person", id: actor.personId },
    details: { otherSessionsEnded: ended },
  });
  return { otherSessionsEnded: ended };
}

const IMAGE_SIGNATURES: { type: string; test: (bytes: Uint8Array) => boolean }[] = [
  {
    type: "image/png",
    test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { type: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    type: "image/webp",
    test: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45,
  },
];

/** Stores an uploaded avatar (PNG, JPEG, GIF or WebP under 2 MB) and makes it the avatar. */
export async function saveAvatarImage(
  services: ControlServices,
  actor: Actor,
  bytes: Uint8Array,
): Promise<MeView> {
  if (bytes.length === 0) throw new AppError("invalid_request", "Choose an image to upload.");
  if (bytes.length > AVATAR_IMAGE_MAX_BYTES) {
    throw new AppError("payload_too_large", "Use an image under 2 MB.");
  }
  const kind = IMAGE_SIGNATURES.find((signature) => signature.test(bytes));
  if (!kind) {
    throw new AppError("invalid_request", "Use a PNG, JPEG, GIF or WebP image.");
  }
  const { db } = services;
  await db
    .insertInto("person_avatar_image")
    .values({ person_id: actor.personId, content_type: kind.type, bytes: Buffer.from(bytes) })
    .onConflict((conflict) =>
      conflict.column("person_id").doUpdateSet({
        content_type: kind.type,
        bytes: Buffer.from(bytes),
        updated_at: sql<Date>`now()`,
      }),
    )
    .execute();
  await db
    .updateTable("person")
    .set({ avatar_kind: "image", updated_at: new Date() })
    .where("id", "=", actor.personId)
    .execute();
  return meView(services, actor.personId);
}

export async function removeAvatarImage(services: ControlServices, actor: Actor): Promise<MeView> {
  const { db } = services;
  await db.deleteFrom("person_avatar_image").where("person_id", "=", actor.personId).execute();
  await db
    .updateTable("person")
    .set({ avatar_kind: "initials", updated_at: new Date() })
    .where("id", "=", actor.personId)
    .where("avatar_kind", "=", "image")
    .execute();
  return meView(services, actor.personId);
}

/** An avatar image, for the person themselves and anyone who shares a workspace with them. */
export async function readAvatarImage(
  db: Db,
  viewerId: string,
  personId: string,
): Promise<{ contentType: string; bytes: Buffer } | null> {
  if (!/^[0-9a-f-]{36}$/i.test(personId)) return null;
  if (viewerId !== personId) {
    const shared = await db
      .selectFrom("membership as a")
      .innerJoin("membership as b", "b.workspace_id", "a.workspace_id")
      .select("a.workspace_id")
      .where("a.person_id", "=", viewerId)
      .where("b.person_id", "=", personId)
      .executeTakeFirst();
    if (!shared) return null;
  }
  const image = await db
    .selectFrom("person_avatar_image")
    .select(["content_type", "bytes"])
    .where("person_id", "=", personId)
    .executeTakeFirst();
  return image ? { contentType: image.content_type, bytes: image.bytes } : null;
}
