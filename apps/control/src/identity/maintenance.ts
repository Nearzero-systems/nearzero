import { sql } from "kysely";
import { z } from "zod";
import { AUDIT_RETENTION_DAYS } from "../audit/audit.ts";
import { defineJob } from "../jobs/definition.ts";
import { EXPIRED_KEPT_SECONDS } from "../members/invitations.ts";

/**
 * Daily clean-up for identity data: ended sessions and sign-in challenges, expired email
 * confirmation links, old attempt counts,
 * invitations past their 7 days on the list, and audit events older than 90 days. Safe to repeat.
 */
export const pruneIdentityRecords = defineJob({
  kind: "maintenance.prune-identity-records",
  payload: z.object({}),
  maxAttempts: 3,
  lane: "schedule",
  async run(_payload, { db, log }) {
    const sessions = await db
      .deleteFrom("person_session")
      .where("expires_at", "<", sql<Date>`now()`)
      .executeTakeFirst();
    const challenges = await db
      .deleteFrom("sign_in_challenge")
      .where("expires_at", "<", sql<Date>`now() - interval '1 day'`)
      .executeTakeFirst();
    const confirmations = await db
      .deleteFrom("email_confirmation")
      .where("expires_at", "<", sql<Date>`now()`)
      .executeTakeFirst();
    const attempts = await db
      .deleteFrom("attempt_record")
      .where("attempted_at", "<", sql<Date>`now() - interval '1 day'`)
      .executeTakeFirst();
    const invitations = await db
      .deleteFrom("invitation")
      .where((eb) =>
        eb.or([
          eb.and([
            eb("status", "=", "pending"),
            eb(
              "expires_at",
              "<",
              sql<Date>`now() - make_interval(secs => ${EXPIRED_KEPT_SECONDS}::double precision)`,
            ),
          ]),
          eb.and([
            eb("status", "!=", "pending"),
            eb("closed_at", "<", sql<Date>`now() - interval '30 days'`),
          ]),
        ]),
      )
      .executeTakeFirst();
    const audit = await db
      .deleteFrom("audit_event")
      .where(
        "occurred_at",
        "<",
        sql<Date>`now() - make_interval(days => ${AUDIT_RETENTION_DAYS}::integer)`,
      )
      .executeTakeFirst();
    log.info("pruned identity records", {
      sessions: Number(sessions.numDeletedRows),
      challenges: Number(challenges.numDeletedRows),
      emailConfirmations: Number(confirmations.numDeletedRows),
      attempts: Number(attempts.numDeletedRows),
      invitations: Number(invitations.numDeletedRows),
      auditEvents: Number(audit.numDeletedRows),
    });
  },
});
