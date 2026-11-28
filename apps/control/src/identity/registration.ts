import { AppError } from "@nearzero/shared";
import { recordAudit } from "../audit/audit.ts";
import type { ClientInfo } from "../http/client.ts";
import {
  findInvitationByToken,
  joinFromInvitation,
  proofKindOf,
  requireUsable,
} from "../members/invitations.ts";
import type { ControlServices } from "../services.ts";
import { isInstanceAdmin } from "../workspaces/workspaces.ts";
import {
  AttemptsLimited,
  claimAttempts,
  REGISTER_BURST_LIMIT,
  REGISTER_LIMIT,
  secondsUntilAllowed,
} from "./attempts.ts";
import { createPerson, findPersonByEmail, isDuplicateEmail } from "./people.ts";
import { createSession } from "./sessions.ts";

/**
 * Creating an account, which only an invitation allows (spec 04 4.2). The account takes the
 * invited address (spec 24 G5, the C1-01 decision in spec 31):
 * - a link emailed with the install's settings carries an address proof; opening it proves the
 *   person reads mail there, so the account starts confirmed;
 * - a link emailed with a workspace's own settings carries a link proof: it works as the
 *   invitation, but that workspace chose the mail server, so the account starts unconfirmed;
 * - an invitation that was emailed can't create an account without one of those proofs;
 * - an invitation that was never emailed (no email set up) is copy-link only: it creates an
 *   account only when an instance administrator made it, and it is used up by that first sign-up.
 * An instance administrator vouches for every address they invite, as when they add someone with
 * a password, so an account from their invitation always starts confirmed (30a R1-02).
 */

/**
 * Runs the account's creation, answering a sign-up that lost a race for the same invitation (two
 * submits at once) with the invitee page's words instead of an internal error (B1-65).
 */
async function createAccountOnce<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (isDuplicateEmail(error)) {
      throw new AppError("conflict", "This invitation was already accepted");
    }
    throw error;
  }
}

export interface RegisterInput {
  token: string;
  proof?: string | undefined;
  email?: string | undefined;
  password: string;
}

export async function registerFromInvitation(
  services: ControlServices,
  input: RegisterInput,
  context: { client: ClientInfo; userAgent: string | null },
): Promise<{ personId: string; sessionId: string; token: string; workspaceId: string }> {
  const { db, log } = services;
  // Counted per client address before anything is looked up (31d G4-14).
  const address = context.client.address;
  const limits = [REGISTER_BURST_LIMIT, REGISTER_LIMIT];
  const claimed = await claimAttempts(
    db,
    limits.map((limit) => ({ limit, subject: address })),
  );
  if (!claimed) {
    throw new AttemptsLimited(
      (seconds) =>
        `Too many sign-up attempts. Please try again in ${seconds} second${seconds === 1 ? "" : "s"}.`,
      await secondsUntilAllowed(db, limits, address),
    );
  }
  const record = requireUsable(await findInvitationByToken(db, input.token));
  if (input.email !== undefined && input.email !== record.email) {
    throw new AppError("invalid_request", "Email does not match invitation", {
      fields: { email: "Email does not match invitation" },
    });
  }
  if (await findPersonByEmail(db, record.email)) {
    throw new AppError("conflict", "An account already exists with this email. Log in instead.");
  }

  const proof = input.proof !== undefined ? proofKindOf(services, input.token, input.proof) : null;
  const vouched = record.invitedBy !== null && (await isInstanceAdmin(db, record.invitedBy));
  if (proof === null) {
    if (record.everEmailed) {
      throw new AppError(
        "forbidden",
        `To create your account, open the link in the invitation email sent to ${record.email}.`,
      );
    }
    if (!vouched) {
      throw new AppError(
        "forbidden",
        `This invitation was never emailed to ${record.email}, so it can't create a new account. Ask the person who invited you to send it again once email is set up, or a Nearzero administrator to add you.`,
      );
    }
  }
  const proven = proof === "address" || vouched;

  const passwordHash = await services.passwords.hash(input.password);
  const created = await createAccountOnce(async () =>
    db.transaction().execute(async (trx) => {
      const person = await createPerson(trx, {
        email: record.email,
        passwordHash,
        emailVerified: proven,
        onboardingStep: "name",
      });
      await joinFromInvitation(trx, record, person.personId);
      await trx
        .updateTable("person")
        .set({ last_workspace_id: record.workspaceId })
        .where("id", "=", person.personId)
        .execute();
      return person;
    }),
  );

  const session = await createSession(db, {
    personId: created.personId,
    clientAddress: context.client.address,
    userAgent: context.userAgent,
    activeWorkspaceId: record.workspaceId,
  });
  const actor = {
    kind: "person" as const,
    personId: created.personId,
    label: record.email,
    clientAddress: context.client.address,
  };
  await recordAudit(db, log, actor, {
    action: "auth.registered",
    workspaceId: record.workspaceId,
    target: { kind: "person", id: created.personId },
    details: { invitationId: record.id, proven, proof: proof ?? "none" },
  });
  await recordAudit(db, log, actor, {
    action: "member.joined",
    workspaceId: record.workspaceId,
    target: { kind: "person", id: created.personId },
    details: { role: record.role, invitationId: record.id },
  });
  // The welcome goes out after the name step, which every new account has (spec 04 4.3).
  return {
    personId: created.personId,
    sessionId: session.id,
    token: session.token,
    workspaceId: record.workspaceId,
  };
}
