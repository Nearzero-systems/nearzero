import { AppError, MEMBER_LIMIT, type Role } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import { addressMailRoute } from "../email/transport.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { setVouchedEmail } from "../identity/email-confirmation.ts";
import {
  avatarImageIds,
  createPerson,
  findPersonByEmail,
  isDuplicateEmail,
  type PersonSummary,
  summarizePerson,
} from "../identity/people.ts";
import type { ControlServices } from "../services.ts";
import { checkPolicyIds, MEMBER_LIMIT_REACHED, memberCount } from "./invitations.ts";

/** The People tab (spec 04 4.7): the member list, role changes, removal and adding with a password. */

export interface MemberView {
  person: PersonSummary;
  role: Role;
  joinedAt: string;
  isYou: boolean;
  /** Whether the account's address is confirmed (spec 04 4.6). */
  emailConfirmed: boolean;
  /** For the note under each role: "Everything", the policy names, or "Only what's granted to them". */
  access: { everything: boolean; policies: { id: string; name: string }[]; direct: boolean };
}

export async function listMembers(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<MemberView[]> {
  await actor.access.require("members.see");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  const [rows, attachments, direct] = await Promise.all([
    db
      .selectFrom("membership as m")
      .innerJoin("person as p", "p.id", "m.person_id")
      .selectAll("p")
      .select(["m.role", "m.created_at as joined_at"])
      .where("m.workspace_id", "=", workspaceId)
      .orderBy(sql`case m.role when 'owner' then 0 when 'admin' then 1 else 2 end`)
      .orderBy("m.created_at")
      .execute(),
    db
      .selectFrom("policy_attachment as a")
      .innerJoin("access_policy as pol", "pol.id", "a.policy_id")
      .select(["a.person_id", "pol.id", "pol.name"])
      .where("a.workspace_id", "=", workspaceId)
      .orderBy("pol.name")
      .execute(),
    db
      .selectFrom("member_access")
      .select("person_id")
      .where("workspace_id", "=", workspaceId)
      .execute(),
  ]);
  const images = await avatarImageIds(
    db,
    rows.map((row) => row.id),
  );
  const directIds = new Set(direct.map((row) => row.person_id));
  return rows.map((row) => {
    const everything = row.role !== "member";
    return {
      person: summarizePerson(row, images.has(row.id)),
      role: row.role,
      joinedAt: row.joined_at.toISOString(),
      isYou: row.id === actor.personId,
      emailConfirmed: row.email_verified_at !== null,
      access: {
        everything,
        policies: everything
          ? []
          : attachments
              .filter((item) => item.person_id === row.id)
              .map((item) => ({ id: item.id, name: item.name })),
        direct: !everything && directIds.has(row.id),
      },
    };
  });
}

async function targetMembership(db: Db, workspaceId: string, personId: string) {
  const row = await db
    .selectFrom("membership as m")
    .innerJoin("person as p", "p.id", "m.person_id")
    .select(["m.role", "p.id", "p.email", "p.email_verified_at", "p.first_name", "p.last_name"])
    .where("m.workspace_id", "=", workspaceId)
    .where(sql<boolean>`m.person_id::text = ${personId}`)
    .executeTakeFirst();
  if (!row) {
    throw new AppError(
      "not_found",
      "This person isn't a member of this workspace any more. Reload the page.",
    );
  }
  return row;
}

/**
 * Owners change anyone but themselves; admins change only members (and may promote them).
 * The owner role is never given away (spec 04 4.7, spec 22.1).
 */
export async function changeRole(
  services: ControlServices,
  actor: WorkspaceActor,
  personId: string,
  role: "admin" | "member",
): Promise<void> {
  await actor.access.require("members.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  if (personId === actor.personId) {
    throw new AppError("forbidden", "You cannot change your own role");
  }
  const target = await targetMembership(db, workspaceId, personId);
  if (target.role === "owner") throw new AppError("forbidden", "The owner role is nontransferable");
  if (actor.role === "admin" && target.role === "admin") {
    throw new AppError(
      "forbidden",
      "Only the workspace owner can change admin roles. Ask the owner to make this change.",
    );
  }
  if (target.role === role) return;
  await db.transaction().execute(async (trx) => {
    await trx
      .updateTable("membership")
      .set({ role })
      .where("workspace_id", "=", workspaceId)
      .where("person_id", "=", target.id)
      .execute();
    if (role === "admin") {
      // Admins reach everything, so member-only grants would only linger unseen.
      await trx
        .deleteFrom("policy_attachment")
        .where("workspace_id", "=", workspaceId)
        .where("person_id", "=", target.id)
        .execute();
      await trx
        .deleteFrom("member_access")
        .where("workspace_id", "=", workspaceId)
        .where("person_id", "=", target.id)
        .execute();
    }
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "member.role-changed",
    workspaceId,
    target: { kind: "person", id: target.id },
    details: { email: target.email, from: target.role, to: role },
  });
}

/**
 * Removes someone from the workspace; their account isn't deleted. Nobody removes the owner;
 * admins remove only members, never themselves (spec 04 4.7).
 */
export async function removeMember(
  services: ControlServices,
  actor: WorkspaceActor,
  personId: string,
): Promise<void> {
  await actor.access.require("members.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  const target = await targetMembership(db, workspaceId, personId);
  if (target.role === "owner") {
    throw new AppError("forbidden", "The workspace owner can't be removed.");
  }
  if (actor.role === "admin" && target.id === actor.personId) {
    throw new AppError(
      "forbidden",
      "Admins can't remove themselves from a workspace. Ask the owner to remove you.",
    );
  }
  if (actor.role === "admin" && target.role === "admin") {
    throw new AppError(
      "forbidden",
      "Admins can't remove other admins. Ask the workspace owner to do it.",
    );
  }
  await db.transaction().execute(async (trx) => {
    await trx
      .deleteFrom("membership")
      .where("workspace_id", "=", workspaceId)
      .where("person_id", "=", target.id)
      .execute();
    await trx
      .updateTable("person")
      .set({ last_workspace_id: null })
      .where("id", "=", target.id)
      .where("last_workspace_id", "=", workspaceId)
      .execute();
    await trx
      .updateTable("person_session")
      .set({ active_workspace_id: null })
      .where("person_id", "=", target.id)
      .where("active_workspace_id", "=", workspaceId)
      .execute();
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "member.removed",
    workspaceId,
    target: { kind: "person", id: target.id },
    details: { email: target.email, role: target.role },
  });
}

/**
 * Whether the actor may set other members' addresses here (31a G1-02): instance administrators
 * who are owners or admins of this workspace, and only while the server can't send email.
 */
export function canSetMemberEmail(services: ControlServices, actor: WorkspaceActor): boolean {
  return actor.access.can("members.set-email") && addressMailRoute(services) === null;
}

export const EMAIL_SET_NEEDS_NO_EMAIL =
  "This server can send email, so people change their address from Profile and confirm it from the link sent to it.";

/**
 * Sets another member's email address on a server that can't send email (31a G1-02, the decision
 * in spec 31): an instance administrator vouches for it, so it counts as confirmed, the change is
 * audited and the account's sessions end. With email set up, a new address counts only once its
 * link is opened, so this is refused. The role rules match changing a role: owners change anyone
 * else, admins only members.
 */
export async function setMemberEmail(
  services: ControlServices,
  actor: WorkspaceActor,
  personId: string,
  email: string,
): Promise<{ member: MemberView; changed: boolean; sessionsEnded: number }> {
  await actor.access.require("members.set-email");
  if (addressMailRoute(services)) throw new AppError("conflict", EMAIL_SET_NEEDS_NO_EMAIL);
  const { db } = services;
  const workspaceId = actor.workspace.id;
  if (personId === actor.personId) {
    throw new AppError(
      "forbidden",
      "You can't change your own address here. Run sudo nearzero set-email on the server, or ask another Nearzero administrator.",
    );
  }
  const target = await targetMembership(db, workspaceId, personId);
  if (target.role === "owner") {
    throw new AppError(
      "forbidden",
      "The workspace owner's address can't be changed here. They can run sudo nearzero set-email on the server.",
    );
  }
  if (target.email === email && target.email_verified_at !== null) {
    throw new AppError("invalid_request", "That is already their email address.", {
      fields: { email: "That is already their email address." },
    });
  }
  if (actor.role === "admin" && target.role === "admin") {
    throw new AppError(
      "forbidden",
      "Only the workspace owner can change an admin's email address. Ask the owner to make this change.",
    );
  }
  const result = await setVouchedEmail(services, target.id, email, {
    actor: auditActor(actor),
    workspaceId,
  });
  const member = (await listMembers(services, actor)).find((item) => item.person.id === target.id);
  if (!member) throw new Error("The member could not be read back.");
  return { member, changed: result.changed, sessionsEnded: result.sessionsEnded };
}

export interface AddWithPasswordInput {
  email: string;
  role: "admin" | "member";
  policyIds: string[];
  password: string;
}

/**
 * Creates an account with a password an administrator chose (spec 04 4.7): only owners and
 * admins of this workspace who are instance administrators, and only on a workspace with a real
 * name. The person finishes their profile on first sign-in.
 */
export async function addWithPassword(
  services: ControlServices,
  actor: WorkspaceActor,
  input: AddWithPasswordInput,
): Promise<{ member: MemberView; signIn: { address: string | null; email: string } }> {
  await actor.access.require("members.add-with-password");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  if (actor.workspace.personal) {
    throw new AppError(
      "conflict",
      "Give this workspace its own name before adding people with a password.",
    );
  }
  if (await findPersonByEmail(db, input.email)) {
    throw new AppError(
      "conflict",
      `${input.email} already has an account on this server. Send an invitation instead, so they can accept it.`,
      { fields: { email: "This email already has an account on this server." } },
    );
  }
  const policyIds = await checkPolicyIds(db, workspaceId, input.role, input.policyIds);
  if ((await memberCount(db, workspaceId)) >= MEMBER_LIMIT) {
    throw new AppError("conflict", MEMBER_LIMIT_REACHED);
  }
  const passwordHash = await services.passwords.hash(input.password);
  const alreadyHasAccount = new AppError(
    "conflict",
    `${input.email} already has an account on this server. Send an invitation instead, so they can accept it.`,
    { fields: { email: "This email already has an account on this server." } },
  );
  // Two adds of the same address at once: the second gets the same answer as a later one (B1-65).
  const personId = await db
    .transaction()
    .execute(async (trx) => {
      const created = await createPerson(trx, {
        email: input.email,
        passwordHash,
        // An instance administrator vouches for the address.
        emailVerified: true,
        onboardingStep: "name",
      });
      await trx
        .insertInto("membership")
        .values({ workspace_id: workspaceId, person_id: created.personId, role: input.role })
        .execute();
      await trx
        .updateTable("person")
        .set({ last_workspace_id: workspaceId })
        .where("id", "=", created.personId)
        .execute();
      if (policyIds.length > 0) {
        await trx
          .insertInto("policy_attachment")
          .values(
            policyIds.map((policyId) => ({
              policy_id: policyId,
              workspace_id: workspaceId,
              person_id: created.personId,
              attached_by: actor.personId,
            })),
          )
          .execute();
      }
      return created.personId;
    })
    .catch((error: unknown) => {
      if (isDuplicateEmail(error)) throw alreadyHasAccount;
      throw error;
    });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "member.added-with-password",
    workspaceId,
    target: { kind: "person", id: personId },
    details: { email: input.email, role: input.role, policyIds },
  });
  const member = (await listMembers(services, actor)).find((item) => item.person.id === personId);
  if (!member) throw new Error("The new member could not be read back.");
  return { member, signIn: { address: services.consoleUrl(), email: input.email } };
}
