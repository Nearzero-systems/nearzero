import type { Kysely } from "kysely";
import type { AuditActorKind, Database } from "../db/schema.ts";
import type { Logger } from "../log.ts";

/**
 * The audit record (spec 22.4, rule 8): who did what, when and from where. Kept 90 days, then
 * pruned by the daily identity maintenance job. Secret-looking detail fields are redacted before
 * anything is written.
 */

export const AUDIT_RETENTION_DAYS = 90;

export interface AuditActor {
  kind: AuditActorKind;
  personId?: string | null;
  label?: string | null;
  clientAddress?: string | null;
}

export interface AuditEvent {
  action: string;
  workspaceId?: string | null;
  target?: { kind: string; id: string };
  details?: Record<string, unknown>;
}

const SECRET_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|private[-_]?key|credential|code/i;

/** Detail fields whose names look like secrets, replaced by "[redacted]" (also on export). */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SECRET_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1);
  }
  return out;
}

/**
 * Writes one audit event. Inside a transaction, pass the transaction so the record commits with
 * the change. A failure to record is logged and never turns a done change into an error.
 */
export async function recordAudit(
  db: Kysely<Database>,
  log: Logger,
  actor: AuditActor,
  event: AuditEvent,
): Promise<void> {
  try {
    await db
      .insertInto("audit_event")
      .values({
        workspace_id: event.workspaceId ?? null,
        actor_kind: actor.kind,
        actor_person_id: actor.personId ?? null,
        actor_label: actor.label ?? null,
        action: event.action,
        target_kind: event.target?.kind ?? null,
        target_id: event.target?.id ?? null,
        client_address: actor.clientAddress ?? null,
        details: JSON.stringify(redact(event.details ?? {})),
      })
      .execute();
  } catch (error) {
    log.error("couldn't record an audit event", { action: event.action, error });
  }
}
