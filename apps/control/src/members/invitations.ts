import { AppError, INVITATION_DAYS, MEMBER_LIMIT } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import type { Db } from "../db/database.ts";
import type { InvitationStatus } from "../db/schema.ts";
import { invitationEmail, welcomeEmail } from "../email/messages.ts";
import { type DeliveryResult, emailRouteFor } from "../email/transport.ts";
import { type Actor, auditActor, type WorkspaceActor } from "../http/actor.ts";
import {
  type AttemptLimit,
  claimAttempts,
  countAttempts,
  releaseAttempts,
} from "../identity/attempts.ts";
import { displayName, isRealName } from "../identity/names.ts";
import { hasRealName } from "../identity/people.ts";
import { constantTimeEqual, hashToken, hmac, randomToken } from "../security/tokens.ts";
import type { ControlServices } from "../services.ts";

/**
 * Invitations (spec 04 4.5): a 7-day link for one email address to join a workspace with a role
 * and policies. The link is rebuilt from a sealed token for Copy link and Resend. The copy of the
 * link that goes by email also carries a proof, which is what lets someone create an account as
 * the invited address (spec 24 G5). Two kinds of proof exist (C1-01):
 * - an address proof, only in links sent with the install's email settings: whoever opens it
 *   reads mail at the address, so the account it creates starts confirmed;
 * - a link proof, in links sent with a workspace's own settings: it works as the invitation, but
 *   that workspace chose the mail server, so the account starts unconfirmed unless an instance
 *   administrator made the invitation.
 */

export const INVITATION_SECONDS = INVITATION_DAYS * 24 * 60 * 60;
/** Expired invitations stay listed this long so they can be sent again. */
export const EXPIRED_KEPT_SECONDS = 7 * 24 * 60 * 60;
export const RESEND_SPACING_SECONDS = 30;

export const NO_CONSOLE_ADDRESS = "No link to copy: this server has no console address set.";
/** Pending invitations one workspace may hold (the C1-22 decision in spec 31). */
export const PENDING_INVITATION_LIMIT = 100;
export const PENDING_LIMIT_REACHED = `This workspace already has ${PENDING_INVITATION_LIMIT} pending invitations, the most it may hold. Cancel some, or wait until they're accepted or expire.`;

/** Invitation emails one person may send (the C1-22 decision in spec 31): 20 an hour, 100 a day. */
export const INVITATION_EMAIL_LIMITS: AttemptLimit[] = [
  { bucket: "invitation-email-hour", max: 20, windowSeconds: 60 * 60 },
  { bucket: "invitation-email-day", max: 100, windowSeconds: 24 * 60 * 60 },
];
export const MEMBER_LIMIT_REACHED = `This workspace has reached its limit of ${MEMBER_LIMIT} members. Ask an owner or admin to remove someone first.`;

function tokenContext(invitationId: string): string {
  return `invitation:${invitationId}`;
}

/** What an emailed link's proof shows: who could read it (see the top of this file). */
export type ProofKind = "address" | "link";

/**
 * The proof for one kind. Links emailed before 1.0 told the two apart carry the link kind's
 * value, so they still work as invitations but no longer prove the address on their own.
 */
export function invitationProof(services: ControlServices, token: string, kind: ProofKind): string {
  const purpose = kind === "address" ? "invitation address proof" : "invitation proof";
  return hmac(services.secrets.deriveKey(purpose), token).toString("base64url").slice(0, 32);
}

/** Which kind of proof `proof` is for this token, or null when it is neither. */
export function proofKindOf(
  services: ControlServices,
  token: string,
  proof: string,
): ProofKind | null {
  if (constantTimeEqual(invitationProof(services, token, "address"), proof)) return "address";
  if (constantTimeEqual(invitationProof(services, token, "link"), proof)) return "link";
  return null;
}

export function invitationLink(
  services: ControlServices,
  token: string,
  options: { proof: ProofKind | null },
): string {
  const base = services.consoleUrl();
  if (!base) throw new AppError("conflict", NO_CONSOLE_ADDRESS);
  const params = new URLSearchParams({ token });
  if (options.proof) params.set("proof", invitationProof(services, token, options.proof));
  return `${base}/invitation?${params.toString()}`;
}

function openToken(services: ControlServices, invitation: { id: string; token_sealed: string }) {
  const opened = services.secrets.open(invitation.token_sealed, tokenContext(invitation.id));
  if (!opened.ok) {
    throw new AppError(
      "conflict",
      "This invitation's link can't be rebuilt on this server anymore. Cancel it and invite the person again.",
    );
  }
  return opened.value;
}

export type InvitationState = "pending" | "expired" | "cancelled" | "accepted";

export interface InvitationView {
  id: string;
  email: string;
  role: "admin" | "member";
  state: "pending" | "expired";
  policies: { id: string; name: string }[];
  createdAt: string;
  expiresAt: string;
  /** When an email last actually went out, or null if it was never emailed. */
  lastEmailedAt: string | null;
  invitedBy: { id: string; name: string } | null;
}

export interface Delivery {
  emailed: boolean;
  /** Why it wasn't emailed, in words for the inviter. Absent when emailed. */
  reason?: string;
  /** The link to share by hand. */
  link: string;
}

async function policiesOf(db: Db, invitationIds: string[]) {
  if (invitationIds.length === 0) return new Map<string, { id: string; name: string }[]>();
  const rows = await db
    .selectFrom("invitation_policy as ip")
    .innerJoin("access_policy as p", "p.id", "ip.policy_id")
    .select(["ip.invitation_id", "p.id", "p.name"])
    .where("ip.invitation_id", "in", invitationIds)
    .orderBy("p.name")
    .execute();
  const map = new Map<string, { id: string; name: string }[]>();
  for (const row of rows) {
    const list = map.get(row.invitation_id) ?? [];
    list.push({ id: row.id, name: row.name });
    map.set(row.invitation_id, list);
  }
  return map;
}

/** Pending invitations and ones that expired in the last 7 days, newest first. */
export async function listInvitations(db: Db, workspaceId: string): Promise<InvitationView[]> {
  const rows = await db
    .selectFrom("invitation as i")
    .leftJoin("person as p", "p.id", "i.invited_by")
    .select([
      "i.id",
      "i.email",
      "i.role",
      "i.created_at",
      "i.expires_at",
      "i.last_emailed_at",
      "p.id as inviter_id",
      "p.first_name",
      "p.last_name",
      "p.email as inviter_email",
      sql<boolean>`i.expires_at <= now()`.as("expired"),
    ])
    .where("i.workspace_id", "=", workspaceId)
    .where("i.status", "=", "pending")
    .where(
      "i.expires_at",
      ">",
      sql<Date>`now() - make_interval(secs => ${EXPIRED_KEPT_SECONDS}::double precision)`,
    )
    .orderBy("i.created_at", "desc")
    .execute();
  const policies = await policiesOf(
    db,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: row.role,
    state: row.expired ? "expired" : "pending",
    policies: policies.get(row.id) ?? [],
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastEmailedAt: row.last_emailed_at?.toISOString() ?? null,
    invitedBy:
      row.inviter_id && row.inviter_email
        ? {
            id: row.inviter_id,
            name: displayName({
              first_name: row.first_name,
              last_name: row.last_name,
              email: row.inviter_email,
            }),
          }
        : null,
  }));
}

export async function memberCount(db: Db, workspaceId: string): Promise<number> {
  const row = await db
    .selectFrom("membership")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("workspace_id", "=", workspaceId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** Checks policy ids belong to the workspace; policies are for members only. */
export async function checkPolicyIds(
  db: Db,
  workspaceId: string,
  role: "admin" | "member",
  policyIds: readonly string[],
): Promise<string[]> {
  const unique = [...new Set(policyIds)];
  if (unique.length === 0) return [];
  if (role !== "member") {
    throw new AppError(
      "invalid_request",
      "Access policies are for members only: owners and admins already reach everything.",
      { fields: { policyIds: "Access policies are for members only." } },
    );
  }
  const found = await db
    .selectFrom("access_policy")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`id::text = any(${unique})`)
    .execute();
  if (found.length !== unique.length) {
    throw new AppError(
      "conflict",
      "A policy in the list isn't in this workspace any more. Reload the page and try again.",
    );
  }
  return unique;
}

async function deliver(
  services: ControlServices,
  invitation: { id: string; email: string; role: "admin" | "member"; workspace_id: string },
  token: string,
  inviterId: string | null,
): Promise<Delivery> {
  const link = invitationLink(services, token, { proof: null });
  const route = await emailRouteFor(services, invitation.workspace_id);
  if (!route) {
    return {
      emailed: false,
      reason: "Not emailed: email isn't set up for this workspace or this server.",
      link,
    };
  }
  const [workspace, inviter] = await Promise.all([
    services.db
      .selectFrom("workspace")
      .select("name")
      .where("id", "=", invitation.workspace_id)
      .executeTakeFirstOrThrow(),
    inviterId
      ? services.db
          .selectFrom("person")
          .select(["first_name", "last_name", "email"])
          .where("id", "=", inviterId)
          .executeTakeFirst()
      : undefined,
  ]);
  // Each person sends at most 20 invitation emails an hour and 100 a day, so no account can use
  // this server's sender for spam (the C1-22 decision in spec 31). Past that, the link is given.
  const claimed = inviterId
    ? await claimAttempts(
        services.db,
        INVITATION_EMAIL_LIMITS.map((limit) => ({ limit, subject: inviterId })),
      )
    : [];
  if (!claimed) {
    const hourly = INVITATION_EMAIL_LIMITS[0] as AttemptLimit;
    const full =
      inviterId !== null && (await countAttempts(services.db, hourly, inviterId)) >= hourly.max;
    return {
      emailed: false,
      reason: full
        ? "Not emailed: you've sent 20 invitation emails in the last hour, the most one person may. Share the link, or send it again later."
        : "Not emailed: you've sent 100 invitation emails today, the most one person may. Share the link, or send it again tomorrow.",
      link,
    };
  }
  const result: DeliveryResult = await route.send(
    invitationEmail({
      to: invitation.email,
      workspaceName: workspace.name,
      inviter: inviter
        ? {
            name: isRealName(inviter.first_name)
              ? [inviter.first_name, inviter.last_name].filter(Boolean).join(" ")
              : null,
            email: inviter.email,
          }
        : null,
      role: invitation.role,
      // Only the install's own mail can carry a proof of the address (C1-01).
      link: invitationLink(services, token, {
        proof: route.source === "instance" ? "address" : "link",
      }),
    }),
  );
  if (!result.sent) {
    // An email that didn't go out doesn't count.
    await releaseAttempts(services.db, claimed);
    return { emailed: false, reason: `Not emailed. ${result.reason}`, link };
  }
  await services.db
    .updateTable("invitation")
    .set({ last_emailed_at: sql<Date>`now()` })
    .where("id", "=", invitation.id)
    .execute();
  return { emailed: true, link };
}

export interface NewInvitation {
  email: string;
  role: "admin" | "member";
  policyIds: string[];
}

export async function createInvitation(
  services: ControlServices,
  actor: WorkspaceActor,
  input: NewInvitation,
): Promise<{ invitation: InvitationView; delivery: Delivery }> {
  await actor.access.require("invitations.manage");
  const { db } = services;
  const workspaceId = actor.workspace.id;
  if (!services.consoleUrl()) throw new AppError("conflict", NO_CONSOLE_ADDRESS);
  const policyIds = await checkPolicyIds(db, workspaceId, input.role, input.policyIds);

  const member = await db
    .selectFrom("membership as m")
    .innerJoin("person as p", "p.id", "m.person_id")
    .select("p.id")
    .where("m.workspace_id", "=", workspaceId)
    .where("p.email", "=", input.email)
    .executeTakeFirst();
  if (member) {
    throw new AppError("conflict", "User is already a member of this workspace", {
      fields: { email: "User is already a member of this workspace" },
    });
  }
  if ((await memberCount(db, workspaceId)) >= MEMBER_LIMIT) {
    throw new AppError("conflict", MEMBER_LIMIT_REACHED);
  }

  const id = crypto.randomUUID();
  const token = randomToken(32);
  await db.transaction().execute(async (trx) => {
    // One at a time per workspace, so the pending cap holds however many arrive together.
    await trx
      .selectFrom("workspace")
      .select("id")
      .where("id", "=", workspaceId)
      .forUpdate()
      .execute();
    const open = await trx
      .selectFrom("invitation")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("workspace_id", "=", workspaceId)
      .where("status", "=", "pending")
      .where("expires_at", ">", sql<Date>`now()`)
      .executeTakeFirstOrThrow();
    if (Number(open.count) >= PENDING_INVITATION_LIMIT) {
      throw new AppError("conflict", PENDING_LIMIT_REACHED);
    }
    const pending = await trx
      .selectFrom("invitation")
      .select(["id", sql<boolean>`expires_at <= now()`.as("expired")])
      .where("workspace_id", "=", workspaceId)
      .where("email", "=", input.email)
      .where("status", "=", "pending")
      .forUpdate()
      .executeTakeFirst();
    if (pending && !pending.expired) {
      throw new AppError(
        "conflict",
        "This email already has a pending invitation. Send it again or copy its link from the list.",
        // The field shows the whole guidance too, since the dialog shows field messages only
        // (B3-19, spec 04 4.5).
        {
          fields: {
            email:
              "This email already has a pending invitation. Send it again or copy its link from the list.",
          },
        },
      );
    }
    if (pending) {
      // An expired invitation is replaced by the new one.
      await trx
        .updateTable("invitation")
        .set({ status: "cancelled", closed_at: sql<Date>`now()` })
        .where("id", "=", pending.id)
        .execute();
    }
    await trx
      .insertInto("invitation")
      .values({
        id,
        workspace_id: workspaceId,
        email: input.email,
        role: input.role,
        token_hash: hashToken(token),
        token_sealed: services.secrets.seal(token, tokenContext(id)),
        invited_by: actor.personId,
        expires_at: sql<Date>`now() + make_interval(secs => ${INVITATION_SECONDS}::double precision)`,
      })
      .execute();
    if (policyIds.length > 0) {
      await trx
        .insertInto("invitation_policy")
        .values(
          policyIds.map((policyId) => ({
            invitation_id: id,
            policy_id: policyId,
            workspace_id: workspaceId,
          })),
        )
        .execute();
    }
  });

  const delivery = await deliver(
    services,
    { id, email: input.email, role: input.role, workspace_id: workspaceId },
    token,
    actor.personId,
  );
  await recordAudit(db, services.log, auditActor(actor), {
    action: "member.invited",
    workspaceId,
    target: { kind: "invitation", id },
    details: { email: input.email, role: input.role, policyIds, emailed: delivery.emailed },
  });
  const view = (await listInvitations(db, workspaceId)).find((item) => item.id === id);
  if (!view) throw new Error("The new invitation could not be read back.");
  return { invitation: view, delivery };
}

async function workspaceInvitation(db: Db, workspaceId: string, invitationId: string) {
  const row = await db
    .selectFrom("invitation")
    .selectAll()
    .where("workspace_id", "=", workspaceId)
    .where(sql<boolean>`id::text = ${invitationId}`)
    .where("status", "=", "pending")
    .executeTakeFirst();
  if (!row) {
    throw new AppError(
      "not_found",
      "This invitation isn't in this workspace any more. Reload the page to see the current list.",
    );
  }
  return row;
}

/**
 * Sends an invitation again with the same link and restarts its 7 days, at most once per 30
 * seconds after an email actually went out.
 */
export async function resendInvitation(
  services: ControlServices,
  actor: WorkspaceActor,
  invitationId: string,
): Promise<{ invitation: InvitationView; delivery: Delivery }> {
  await actor.access.require("invitations.manage");
  const { db } = services;
  const invitation = await workspaceInvitation(db, actor.workspace.id, invitationId);
  const token = openToken(services, invitation);
  // The 30-second slot is claimed before sending, in one statement, so resends sent together
  // can't all get through (C1-21); it is given back when no email went out.
  const slot = await db.transaction().execute(async (trx) => {
    const row = await trx
      .selectFrom("invitation")
      .select([
        "last_emailed_at",
        sql<number>`ceil(extract(epoch from (last_emailed_at + make_interval(secs => ${RESEND_SPACING_SECONDS}::double precision) - now())))`.as(
          "seconds",
        ),
      ])
      .where("id", "=", invitation.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const seconds = row.last_emailed_at ? Number(row.seconds) : 0;
    if (seconds > 0) return { seconds, previous: row.last_emailed_at };
    const claimed = await trx
      .updateTable("invitation")
      .set({
        last_emailed_at: sql<Date>`now()`,
        expires_at: sql<Date>`now() + make_interval(secs => ${INVITATION_SECONDS}::double precision)`,
      })
      .where("id", "=", invitation.id)
      // As text, so it matches again to the microsecond (a Date keeps milliseconds only).
      .returning(sql<string>`last_emailed_at::text`.as("at"))
      .executeTakeFirstOrThrow();
    return { seconds: 0, previous: row.last_emailed_at, claimed: claimed.at };
  });
  if (slot.seconds > 0) {
    throw new AppError(
      "rate_limited",
      `This invitation was just sent. Try again in ${slot.seconds} second${slot.seconds === 1 ? "" : "s"}.`,
    );
  }
  const delivery = await deliver(services, invitation, token, actor.personId);
  if (!delivery.emailed && "claimed" in slot && slot.claimed) {
    // Nothing went out: the wait starts only after a real send (spec 04 4.5).
    await db
      .updateTable("invitation")
      .set({ last_emailed_at: slot.previous })
      .where("id", "=", invitation.id)
      .where(sql<boolean>`last_emailed_at = ${slot.claimed}::timestamptz`)
      .execute();
  }
  await recordAudit(db, services.log, auditActor(actor), {
    action: "member.invitation-resent",
    workspaceId: actor.workspace.id,
    target: { kind: "invitation", id: invitation.id },
    details: { email: invitation.email, emailed: delivery.emailed },
  });
  const view = (await listInvitations(db, actor.workspace.id)).find(
    (item) => item.id === invitation.id,
  );
  if (!view) throw new Error("The invitation could not be read back.");
  return { invitation: view, delivery };
}

/** The link to copy and share by hand (without the emailed proof). */
export async function copyInvitationLink(
  services: ControlServices,
  actor: WorkspaceActor,
  invitationId: string,
): Promise<string> {
  await actor.access.require("invitations.manage");
  const invitation = await workspaceInvitation(services.db, actor.workspace.id, invitationId);
  return invitationLink(services, openToken(services, invitation), { proof: null });
}

export async function cancelInvitation(
  services: ControlServices,
  actor: WorkspaceActor,
  invitationId: string,
): Promise<void> {
  await actor.access.require("invitations.manage");
  const invitation = await workspaceInvitation(services.db, actor.workspace.id, invitationId);
  await services.db
    .updateTable("invitation")
    .set({ status: "cancelled", closed_at: sql<Date>`now()` })
    .where("id", "=", invitation.id)
    .where("status", "=", "pending")
    .execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "member.invitation-cancelled",
    workspaceId: actor.workspace.id,
    target: { kind: "invitation", id: invitation.id },
    details: { email: invitation.email },
  });
}

// ---- The invitee's side

export interface InvitationRecord {
  id: string;
  workspaceId: string;
  workspaceName: string;
  email: string;
  role: "admin" | "member";
  status: InvitationStatus;
  expired: boolean;
  everEmailed: boolean;
  invitedBy: string | null;
}

export async function findInvitationByToken(
  db: Db,
  token: string,
): Promise<InvitationRecord | null> {
  const row = await db
    .selectFrom("invitation as i")
    .innerJoin("workspace as w", "w.id", "i.workspace_id")
    .select([
      "i.id",
      "i.workspace_id",
      "w.name as workspace_name",
      "i.email",
      "i.role",
      "i.status",
      "i.invited_by",
      sql<boolean>`i.last_emailed_at is not null`.as("ever_emailed"),
      sql<boolean>`i.expires_at <= now()`.as("expired"),
    ])
    .where("i.token_hash", "=", hashToken(token))
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    email: row.email,
    role: row.role,
    status: row.status,
    expired: row.expired,
    everEmailed: row.ever_emailed,
    invitedBy: row.invited_by,
  };
}

export function stateOf(record: InvitationRecord): InvitationState {
  if (record.status === "accepted") return "accepted";
  if (record.status === "cancelled" || record.status === "declined") return "cancelled";
  return record.expired ? "expired" : "pending";
}

/** Refuses an invitation that can't be used, in the invitee page's words. */
export function requireUsable(record: InvitationRecord | null): InvitationRecord {
  if (!record) throw new AppError("not_found", "Invitation not found");
  switch (stateOf(record)) {
    case "accepted":
      throw new AppError("conflict", "This invitation was already accepted");
    case "cancelled":
      throw new AppError("conflict", "This invitation was cancelled");
    case "expired":
      throw new AppError("conflict", "This invitation has expired");
    case "pending":
      return record;
  }
}

/**
 * Adds the person to the invitation's workspace with its role and policies and marks it
 * accepted. Run inside a transaction. Refused at 100 members.
 */
export async function joinFromInvitation(
  db: Db,
  record: InvitationRecord,
  personId: string,
): Promise<void> {
  const claimed = await db
    .updateTable("invitation")
    .set({ status: "accepted", closed_at: sql<Date>`now()`, accepted_by: personId })
    .where("id", "=", record.id)
    .where("status", "=", "pending")
    .where("expires_at", ">", sql<Date>`now()`)
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) !== 1) {
    throw new AppError("conflict", "This invitation was already accepted");
  }
  const existing = await db
    .selectFrom("membership")
    .select("role")
    .where("workspace_id", "=", record.workspaceId)
    .where("person_id", "=", personId)
    .executeTakeFirst();
  if (existing) return;

  // Lock the workspace row so two acceptances can't both take the last place.
  await db
    .selectFrom("workspace")
    .select("id")
    .where("id", "=", record.workspaceId)
    .forUpdate()
    .execute();
  if ((await memberCount(db, record.workspaceId)) >= MEMBER_LIMIT) {
    throw new AppError("conflict", MEMBER_LIMIT_REACHED);
  }
  await db
    .insertInto("membership")
    .values({ workspace_id: record.workspaceId, person_id: personId, role: record.role })
    .execute();
  if (record.role === "member") {
    await sql`
      insert into policy_attachment (policy_id, workspace_id, person_id, attached_by)
      select ip.policy_id, ip.workspace_id, ${personId}::uuid, ${record.invitedBy}::uuid
      from invitation_policy ip
      where ip.invitation_id = ${record.id}::uuid
      on conflict do nothing
    `.execute(db);
  }
}

/**
 * Sends the welcome email (spec 04 4.3, 30a R1-05) when the workspace or the install can send
 * email: to the owner when they finish onboarding, and to an invited member after their name
 * step, or when they join if they already have a real name. It greets the person by first name
 * and opens the workspace's Agent. A failed send is logged and never fails anything.
 */
export async function sendWelcome(
  services: ControlServices,
  input: { personId: string; workspaceId: string },
): Promise<void> {
  try {
    const route = await emailRouteFor(services, input.workspaceId);
    if (!route) return;
    const [person, workspace] = await Promise.all([
      services.db
        .selectFrom("person")
        .select(["email", "first_name"])
        .where("id", "=", input.personId)
        .executeTakeFirstOrThrow(),
      services.db
        .selectFrom("workspace")
        .select(["name", "slug"])
        .where("id", "=", input.workspaceId)
        .executeTakeFirstOrThrow(),
    ]);
    const base = services.consoleUrl()?.replace(/\/+$/, "") ?? null;
    const result = await route.send(
      welcomeEmail({
        to: person.email,
        firstName: isRealName(person.first_name) ? person.first_name : null,
        workspaceName: workspace.name,
        agentUrl: base ? `${base}/${encodeURIComponent(workspace.slug)}/dashboard/agent` : null,
      }),
    );
    if (!result.sent) services.log.warn("welcome email not sent", { reason: result.reason });
  } catch (error) {
    services.log.warn("welcome email not sent", { error });
  }
}

export interface AcceptResult {
  workspace: { id: string; name: string; slug: string };
  message: string;
}

/** Accepts an invitation for the signed-in person, whose email must be the invited one. */
export async function acceptInvitation(
  services: ControlServices,
  actor: Actor,
  record: InvitationRecord,
): Promise<AcceptResult> {
  const { db } = services;
  requireUsable(record);
  if (record.email !== actor.email) {
    throw new AppError("forbidden", "This invitation is for another email");
  }
  const nameStepNext = await db.transaction().execute(async (trx) => {
    await joinFromInvitation(trx, record, actor.personId);
    const person = await trx
      .selectFrom("person")
      .select(["first_name", "onboarding_step"])
      .where("id", "=", actor.personId)
      .executeTakeFirstOrThrow();
    // The name step runs unless the account already has a real name (spec 04 4.3).
    let nameStep = person.onboarding_step === "name";
    if (person.onboarding_step === null && !hasRealName(person)) {
      await trx
        .updateTable("person")
        .set({ onboarding_step: "name", onboarding_completed_at: null })
        .where("id", "=", actor.personId)
        .execute();
      nameStep = true;
    }
    await trx
      .updateTable("person_session")
      .set({ active_workspace_id: record.workspaceId })
      .where("id", "=", actor.sessionId)
      .execute();
    await trx
      .updateTable("person")
      .set({ last_workspace_id: record.workspaceId })
      .where("id", "=", actor.personId)
      .execute();
    return nameStep;
  });
  await recordAudit(db, services.log, auditActor(actor), {
    action: "member.joined",
    workspaceId: record.workspaceId,
    target: { kind: "person", id: actor.personId },
    details: { role: record.role, invitationId: record.id },
  });
  // With a name step ahead, the welcome waits for it, so it can greet them by name.
  if (!nameStepNext) {
    void sendWelcome(services, { personId: actor.personId, workspaceId: record.workspaceId });
  }
  const workspace = await db
    .selectFrom("workspace")
    .select(["id", "name", "slug"])
    .where("id", "=", record.workspaceId)
    .executeTakeFirstOrThrow();
  return { workspace, message: `You've joined ${workspace.name}` };
}

/** Declines an invitation for the signed-in person; it can't be used afterwards. */
export async function declineInvitation(
  services: ControlServices,
  actor: Actor,
  record: InvitationRecord,
): Promise<void> {
  requireUsable(record);
  if (record.email !== actor.email) {
    throw new AppError("forbidden", "This invitation is for another email");
  }
  await services.db
    .updateTable("invitation")
    .set({ status: "declined", closed_at: sql<Date>`now()` })
    .where("id", "=", record.id)
    .where("status", "=", "pending")
    .execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "member.invitation-declined",
    workspaceId: record.workspaceId,
    target: { kind: "invitation", id: record.id },
  });
}

/**
 * The inviter as the invitee's page names them (30a R1-09): their real name, or null when they
 * have none (an email-derived name is never shown), so the page keeps its plain wording.
 */
function inviterName(row: {
  inviter_first_name: string | null;
  inviter_last_name: string | null;
}): string | null {
  if (!isRealName(row.inviter_first_name)) return null;
  return [row.inviter_first_name, row.inviter_last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
}

export async function inviterNameOf(db: Db, personId: string | null): Promise<string | null> {
  if (!personId) return null;
  const row = await db
    .selectFrom("person")
    .select(["first_name as inviter_first_name", "last_name as inviter_last_name"])
    .where("id", "=", personId)
    .executeTakeFirst();
  return row ? inviterName(row) : null;
}

/** Live invitations addressed to a person's email, for the bell and the after-sign-in redirect. */
export async function pendingInvitationsFor(
  db: Db,
  email: string,
): Promise<
  {
    id: string;
    workspaceName: string;
    role: "admin" | "member";
    expiresAt: string;
    inviterName: string | null;
  }[]
> {
  const rows = await db
    .selectFrom("invitation as i")
    .innerJoin("workspace as w", "w.id", "i.workspace_id")
    .leftJoin("person as p", "p.id", "i.invited_by")
    .select([
      "i.id",
      "w.name",
      "i.role",
      "i.expires_at",
      "p.first_name as inviter_first_name",
      "p.last_name as inviter_last_name",
    ])
    .where("i.email", "=", email)
    .where("i.status", "=", "pending")
    .where("i.expires_at", ">", sql<Date>`now()`)
    .orderBy("i.created_at")
    .execute();
  return rows.map((row) => ({
    id: row.id,
    workspaceName: row.name,
    role: row.role,
    expiresAt: row.expires_at.toISOString(),
    inviterName: inviterName(row),
  }));
}

export async function findInvitationForPerson(
  db: Db,
  invitationId: string,
  email: string,
): Promise<InvitationRecord | null> {
  const row = await db
    .selectFrom("invitation as i")
    .innerJoin("workspace as w", "w.id", "i.workspace_id")
    .select([
      "i.id",
      "i.workspace_id",
      "w.name as workspace_name",
      "i.email",
      "i.role",
      "i.status",
      "i.invited_by",
      sql<boolean>`i.last_emailed_at is not null`.as("ever_emailed"),
      sql<boolean>`i.expires_at <= now()`.as("expired"),
    ])
    .where(sql<boolean>`i.id::text = ${invitationId}`)
    .where("i.email", "=", email)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    email: row.email,
    role: row.role,
    status: row.status,
    expired: row.expired,
    everEmailed: row.ever_emailed,
    invitedBy: row.invited_by,
  };
}
