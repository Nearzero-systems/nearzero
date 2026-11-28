import { AppError, isEmailAddress, normalizeEmail, ONBOARDING_INVITE_MAX } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import type { OnboardingStep } from "../db/schema.ts";
import { type Actor, auditActor, type WorkspaceActor } from "../http/actor.ts";
import { createInvitation, sendWelcome } from "../members/invitations.ts";
import type { ControlServices } from "../services.ts";
import { firstWorkspaceId, renameWorkspace } from "../workspaces/workspaces.ts";
import { isRealName, splitFullName } from "./names.ts";

/**
 * First sign-in steps (spec 04 4.3). The instance owner names themselves and their workspace,
 * then may invite up to 10 teammates. An invited member gives their name, unless the account
 * already has a real one.
 */

export interface OnboardingView {
  step: OnboardingStep | null;
  /** "<First>'s workspace" when a real first name is known; the field's starting value. */
  suggestedWorkspaceName: string | null;
}

export async function onboardingView(db: Db, personId: string): Promise<OnboardingView> {
  const person = await db
    .selectFrom("person")
    .select(["onboarding_step", "first_name"])
    .where("id", "=", personId)
    .executeTakeFirstOrThrow();
  return {
    step: person.onboarding_step,
    suggestedWorkspaceName: isRealName(person.first_name)
      ? `${person.first_name}'s workspace`
      : null,
  };
}

async function requireStep(db: Db, personId: string, step: OnboardingStep): Promise<void> {
  const person = await db
    .selectFrom("person")
    .select("onboarding_step")
    .where("id", "=", personId)
    .executeTakeFirstOrThrow();
  if (person.onboarding_step !== step) {
    throw new AppError(
      "conflict",
      person.onboarding_step === null
        ? "Onboarding is already finished."
        : "This onboarding step isn't the current one. Reload the page to continue.",
    );
  }
}

async function finish(db: Db, personId: string): Promise<void> {
  await db
    .updateTable("person")
    .set({
      onboarding_step: null,
      onboarding_completed_at: sql<Date>`now()`,
      updated_at: new Date(),
    })
    .where("id", "=", personId)
    .execute();
}

/**
 * Step 1 for the owner: their name and their workspace's name. The workspace gets a matching web
 * address. The workspace named is the install's first one when they own it, else their own.
 */
export async function saveOwnerWorkspace(
  services: ControlServices,
  actor: Actor,
  input: { name: string; workspaceName: string },
): Promise<{ workspace: { id: string; name: string; slug: string } }> {
  const { db } = services;
  await requireStep(db, actor.personId, "workspace");
  const first = await firstWorkspaceId(db);
  const owned = await db
    .selectFrom("membership as m")
    .innerJoin("workspace as w", "w.id", "m.workspace_id")
    .select(["w.id", "w.is_personal"])
    .where("m.person_id", "=", actor.personId)
    .where("m.role", "=", "owner")
    .execute();
  const target = owned.find((w) => w.id === first) ?? owned.find((w) => w.is_personal) ?? owned[0];
  if (!target) {
    throw new AppError(
      "conflict",
      "You don't own a workspace to name. Ask an administrator for help.",
    );
  }
  const { firstName, lastName } = splitFullName(input.name);
  const result = await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("person")
      .set({
        first_name: firstName,
        last_name: lastName || null,
        onboarding_step: "invite",
        updated_at: new Date(),
      })
      .where("id", "=", actor.personId)
      .execute();
    const renamed = await renameWorkspace(trx, target.id, input.workspaceName);
    await trx
      .updateTable("person_session")
      .set({ active_workspace_id: target.id })
      .where("id", "=", actor.sessionId)
      .execute();
    return renamed;
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "workspace.renamed",
    workspaceId: target.id,
    target: { kind: "workspace", id: target.id },
    details: { name: input.workspaceName, slug: result.slug, onboarding: true },
  });
  return { workspace: { id: target.id, name: input.workspaceName, slug: result.slug } };
}

export interface OnboardingInviteResult {
  email: string;
  emailed: boolean;
  /** Present when it wasn't emailed or wasn't created. */
  message?: string;
  link?: string;
}

/** Step 2 for the owner: invite up to 10 teammates as members, then finish. */
export async function sendOnboardingInvites(
  services: ControlServices,
  actor: WorkspaceActor,
  emails: string[],
): Promise<OnboardingInviteResult[]> {
  await requireStep(services.db, actor.personId, "invite");
  const unique = [...new Set(emails.map(normalizeEmail))];
  const invalid = unique.filter((email) => !isEmailAddress(email));
  if (invalid.length > 0) {
    const message = `${invalid.map((email) => `"${email}"`).join(", ")} ${invalid.length === 1 ? "is not a valid email address" : "are not valid email addresses"}. Fix ${invalid.length === 1 ? "it" : "them"} or remove ${invalid.length === 1 ? "it" : "them"}.`;
    throw new AppError("invalid_request", message, { fields: { emails: message } });
  }
  if (unique.length > ONBOARDING_INVITE_MAX) {
    const message = `Invite up to ${ONBOARDING_INVITE_MAX} people here. You can invite more from Settings → Members & access.`;
    throw new AppError("invalid_request", message, { fields: { emails: message } });
  }
  const results: OnboardingInviteResult[] = [];
  for (const email of unique) {
    if (email === actor.email) continue;
    try {
      const { delivery } = await createInvitation(services, actor, {
        email,
        role: "member",
        policyIds: [],
      });
      results.push(
        delivery.emailed
          ? { email, emailed: true }
          : {
              email,
              emailed: false,
              message: delivery.reason ?? "Not emailed.",
              link: delivery.link,
            },
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.status >= 500) throw error;
      results.push({ email, emailed: false, message: error.message });
    }
  }
  await finish(services.db, actor.personId);
  void sendWelcome(services, { personId: actor.personId, workspaceId: actor.workspace.id });
  return results;
}

export async function skipOnboardingInvites(
  services: ControlServices,
  actor: Actor,
): Promise<void> {
  await requireStep(services.db, actor.personId, "invite");
  await finish(services.db, actor.personId);
  const workspaceId = await activeWorkspaceOf(services.db, actor);
  if (workspaceId) void sendWelcome(services, { personId: actor.personId, workspaceId });
}

/** The workspace the person is in: the session's, else the one their next sign-in opens. */
async function activeWorkspaceOf(db: Db, actor: Actor): Promise<string | null> {
  const row = await db
    .selectFrom("person_session as s")
    .innerJoin("person as p", "p.id", "s.person_id")
    .select(["s.active_workspace_id", "p.last_workspace_id"])
    .where("s.id", "=", actor.sessionId)
    .executeTakeFirst();
  return row?.active_workspace_id ?? row?.last_workspace_id ?? null;
}

/** The invited member's step: their name. */
export async function saveMemberName(
  services: ControlServices,
  actor: Actor,
  name: string,
): Promise<void> {
  await requireStep(services.db, actor.personId, "name");
  const { firstName, lastName } = splitFullName(name);
  await services.db
    .updateTable("person")
    .set({
      first_name: firstName,
      last_name: lastName || null,
      onboarding_step: null,
      onboarding_completed_at: sql<Date>`now()`,
      updated_at: new Date(),
    })
    .where("id", "=", actor.personId)
    .execute();
  // The member's welcome waits for this step, so it can greet them by name (30a R1-05).
  const workspaceId = await activeWorkspaceOf(services.db, actor);
  if (workspaceId) void sendWelcome(services, { personId: actor.personId, workspaceId });
}
