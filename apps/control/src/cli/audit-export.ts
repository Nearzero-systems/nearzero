import { sql } from "kysely";
import { AUDIT_RETENTION_DAYS, redact } from "../audit/audit.ts";
import type { ControlServices } from "../services.ts";
import type { CliIo } from "./commands.ts";

/**
 * `nearzero-control audit [--since DATE] [--until DATE]` (spec 22.4 rule 8, 30d R4-16): the audit
 * record as JSON lines, oldest first, for `sudo nearzero audit`. A date is YYYY-MM-DD (a whole day
 * in UTC) or a full ISO time; without --since, everything kept (90 days). Secret-looking detail
 * fields are redacted again on the way out, whatever was stored.
 */

export const AUDIT_USAGE =
  "  audit [--since DATE] [--until DATE] Print audit events as JSON lines (dates YYYY-MM-DD or ISO)";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 1_000;

/** A --since or --until value; a bare day ends at the end of that day for --until. */
export function auditDate(value: string, end: boolean): Date | null {
  const text = value.trim();
  if (DAY.test(text)) {
    const start = new Date(`${text}T00:00:00Z`);
    if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== text) return null;
    return end ? new Date(start.getTime() + 24 * 60 * 60 * 1000) : start;
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text)) return null;
  const time = new Date(text);
  return Number.isNaN(time.getTime()) ? null : time;
}

function option(args: readonly string[], name: string): { value: string | null; ok: boolean } {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === name) {
      const next = args[i + 1];
      return next && !next.startsWith("--")
        ? { value: next, ok: true }
        : { value: null, ok: false };
    }
    if (arg.startsWith(`${name}=`)) return { value: arg.slice(name.length + 1), ok: true };
  }
  return { value: null, ok: true };
}

export async function exportAudit(
  services: ControlServices,
  io: CliIo,
  args: readonly string[],
): Promise<number> {
  const known = new Set(["--since", "--until"]);
  for (const arg of args) {
    if (arg.startsWith("--") && !known.has(arg.split("=")[0] as string)) {
      io.err(`Unknown option: ${arg}. Use --since DATE and --until DATE.`);
      return 2;
    }
  }
  const range: { since: Date | null; until: Date | null } = { since: null, until: null };
  for (const [name, end] of [
    ["--since", false],
    ["--until", true],
  ] as const) {
    const given = option(args, name);
    if (!given.ok) {
      io.err(`${name} needs a date, like 2026-11-01.`);
      return 2;
    }
    if (given.value === null) continue;
    const date = auditDate(given.value, end);
    if (!date) {
      io.err(`${name} must be a date like 2026-11-01 or a time like 2026-11-01T09:30:00Z.`);
      return 2;
    }
    range[end ? "until" : "since"] = date;
  }
  if (range.since && range.until && range.since >= range.until) {
    io.err("--since must be before --until.");
    return 2;
  }
  let after = 0;
  let count = 0;
  for (;;) {
    let query = services.db
      .selectFrom("audit_event")
      .selectAll()
      .where("id", ">", after)
      .orderBy("id")
      .limit(PAGE);
    if (range.since) query = query.where("occurred_at", ">=", range.since);
    if (range.until) query = query.where("occurred_at", "<", range.until);
    const rows = await query.execute();
    for (const row of rows) {
      io.out(
        JSON.stringify({
          at: row.occurred_at.toISOString(),
          action: row.action,
          actor: {
            kind: row.actor_kind,
            personId: row.actor_person_id,
            label: row.actor_label,
            clientAddress: row.client_address,
          },
          workspaceId: row.workspace_id,
          target: row.target_kind ? { kind: row.target_kind, id: row.target_id } : null,
          details: redact(row.details ?? {}),
        }),
      );
      count++;
    }
    if (rows.length < PAGE) break;
    after = Number(rows.at(-1)?.id ?? after);
  }
  if (count === 0) {
    const oldest = await services.db
      .selectFrom("audit_event")
      .select(sql<Date | null>`min(occurred_at)`.as("oldest"))
      .executeTakeFirst();
    io.err(
      oldest?.oldest
        ? "No audit events in that range."
        : `No audit events yet. Events are kept for ${AUDIT_RETENTION_DAYS} days.`,
    );
  }
  return 0;
}
