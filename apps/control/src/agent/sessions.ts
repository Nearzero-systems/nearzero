import { AGENT_LIMITS, AGENT_MESSAGES, AppError } from "@nearzero/shared";
import { sql } from "kysely";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import type { ControlServices } from "../services.ts";
import { eventId, readEvents, type StoredEvent } from "./events.ts";
import { FILE_COLUMNS, type FileRow, type FileView, fileView } from "./files.ts";
import type { ModelInputs } from "./provider/provider.ts";
import "./tables.ts";

/**
 * Agent sessions (spec 19.5, 25 D4): private to their author unless shared with the workspace,
 * listed by position (new on top, moves swap positions), renamed by their author, deleted with
 * their messages and files. Viewers of a shared session see only the steps they may see (G6).
 */

export interface SessionView {
  id: string;
  title: string | null;
  titleSource: "provisional" | "generated" | "person" | null;
  shared: boolean;
  mine: boolean;
  author: { id: string; name: string };
  position: number;
  state: "idle" | "working" | "waiting";
  liveTurnId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  author_id: string;
  title: string | null;
  title_source: SessionView["titleSource"];
  shared: boolean;
  position: number;
  last_message_at: Date | null;
  created_at: Date;
  first_name: string | null;
  last_name: string | null;
  email: string;
}

const isId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);

export const SESSION_NOT_FOUND = "This session doesn't exist, or you can't open it.";

function sessionQuery(services: ControlServices) {
  return services.db
    .selectFrom("agent_session as s")
    .innerJoin("person as p", "p.id", "s.author_id")
    .select([
      "s.id",
      "s.workspace_id",
      "s.author_id",
      "s.title",
      "s.title_source",
      "s.shared",
      "s.position",
      "s.last_message_at",
      "s.created_at",
      "p.first_name",
      "p.last_name",
      "p.email",
    ]);
}

async function openTurns(services: ControlServices, ids: string[]) {
  if (ids.length === 0) return new Map<string, { id: string; state: "working" | "waiting" }>();
  const rows = await services.db
    .selectFrom("agent_turn")
    .select(["id", "session_id", "state"])
    .where("session_id", "in", ids)
    .where("state", "in", ["working", "waiting"])
    .execute();
  return new Map(
    rows.map((row) => [row.session_id, { id: row.id, state: row.state as "working" | "waiting" }]),
  );
}

function view(
  row: SessionRow,
  viewer: WorkspaceActor,
  open?: { id: string; state: "working" | "waiting" },
): SessionView {
  return {
    id: row.id,
    title: row.title,
    titleSource: row.title_source,
    shared: row.shared,
    mine: row.author_id === viewer.personId,
    author: { id: row.author_id, name: displayName(row) },
    position: Number(row.position),
    state: open?.state ?? "idle",
    liveTurnId: open?.id ?? null,
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export async function listSessions(services: ControlServices, actor: WorkspaceActor) {
  const mine = (await sessionQuery(services)
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.author_id", "=", actor.personId)
    .orderBy("s.position", "desc")
    .limit(AGENT_LIMITS.sessionsListed)
    .execute()) as SessionRow[];
  const shared = (await sessionQuery(services)
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.author_id", "!=", actor.personId)
    .where("s.shared", "=", true)
    .orderBy(sql`s.last_message_at desc nulls last`)
    .limit(AGENT_LIMITS.sessionsListed)
    .execute()) as SessionRow[];
  const open = await openTurns(
    services,
    [...mine, ...shared].map((row) => row.id),
  );
  return {
    sessions: mine.map((row) => view(row, actor, open.get(row.id))),
    shared: shared.map((row) => view(row, actor, open.get(row.id))),
    limit: AGENT_LIMITS.sessionsListed,
  };
}

/** A session the person may see: theirs, or one shared with the workspace. */
export async function visibleSession(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  options: { own?: boolean } = {},
): Promise<SessionRow> {
  if (!isId(id)) throw new AppError("not_found", SESSION_NOT_FOUND);
  const row = (await sessionQuery(services)
    .where("s.workspace_id", "=", actor.workspace.id)
    .where("s.id", "=", id)
    .executeTakeFirst()) as SessionRow | undefined;
  if (!row || (row.author_id !== actor.personId && !row.shared)) {
    throw new AppError("not_found", SESSION_NOT_FOUND);
  }
  if (options.own && row.author_id !== actor.personId) {
    throw new AppError("forbidden", "Only the person who started this session can do that.");
  }
  return row;
}

export async function sessionViewOf(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<SessionView> {
  const row = await visibleSession(services, actor, id);
  const open = await openTurns(services, [id]);
  return view(row, actor, open.get(id));
}

export async function createSession(
  services: ControlServices,
  actor: WorkspaceActor,
): Promise<SessionView> {
  await actor.access.require("agent.use");
  const row = await services.db
    .insertInto("agent_session")
    .values({ workspace_id: actor.workspace.id, author_id: actor.personId })
    .returning("id")
    .executeTakeFirstOrThrow();
  return sessionViewOf(services, actor, row.id);
}

export async function renameSession(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  title: string,
): Promise<SessionView> {
  await visibleSession(services, actor, id, { own: true });
  await services.db
    .updateTable("agent_session")
    .set({ title, title_source: "person", updated_at: new Date() })
    .where("id", "=", id)
    .execute();
  return sessionViewOf(services, actor, id);
}

export async function shareSession(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  shared: boolean,
): Promise<{ session: SessionView; message: string }> {
  const row = await visibleSession(services, actor, id, { own: true });
  if (row.shared !== shared) {
    await services.db
      .updateTable("agent_session")
      .set({ shared, updated_at: new Date() })
      .where("id", "=", id)
      .execute();
    await recordAudit(services.db, services.log, auditActor(actor), {
      action: shared ? "agent-session.shared" : "agent-session.unshared",
      workspaceId: actor.workspace.id,
      target: { kind: "agent_session", id },
    });
  }
  return {
    session: await sessionViewOf(services, actor, id),
    message: shared ? "Shared with workspace" : "Only you can see this session now",
  };
}

/** Moves swap the positions sessions already hold; a changed list is refused (spec 19.5). */
export async function reorderSessions(
  services: ControlServices,
  actor: WorkspaceActor,
  input: { seen: { id: string; position: number }[]; order: string[] },
) {
  const seenIds = input.seen.map((item) => item.id);
  const same =
    new Set(seenIds).size === seenIds.length &&
    seenIds.length === input.order.length &&
    input.order.every((id) => seenIds.includes(id));
  if (!same) {
    throw new AppError("invalid_request", "Send the same sessions in `order` as in `seen`.");
  }
  await services.db.transaction().execute(async (trx) => {
    const rows = await trx
      .selectFrom("agent_session")
      .select(["id", "position"])
      .where("workspace_id", "=", actor.workspace.id)
      .where("author_id", "=", actor.personId)
      .where("id", "in", seenIds)
      .forUpdate()
      .execute();
    const current = new Map(rows.map((row) => [row.id, Number(row.position)]));
    const changed = input.seen.some((item) => current.get(item.id) !== item.position);
    if (rows.length !== seenIds.length || changed) {
      throw new AppError("conflict", AGENT_MESSAGES.sessionsChanged);
    }
    const positions = input.seen.map((item) => item.position).sort((a, b) => b - a);
    for (const [index, id] of input.order.entries()) {
      await trx
        .updateTable("agent_session")
        .set({ position: positions[index] as number })
        .where("id", "=", id)
        .execute();
    }
  });
  return listSessions(services, actor);
}

export async function deleteSession(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
): Promise<void> {
  if (!isId(id)) return;
  const row = await services.db
    .selectFrom("agent_session")
    .select(["id", "author_id", "shared"])
    .where("workspace_id", "=", actor.workspace.id)
    .where("id", "=", id)
    .executeTakeFirst();
  // Already gone counts as success (spec 19.5); someone else's private session looks gone too.
  if (!row || (row.author_id !== actor.personId && !row.shared)) return;
  if (row.author_id !== actor.personId) {
    throw new AppError("forbidden", "Only the person who started this session can delete it.");
  }
  const working = await services.db
    .selectFrom("agent_turn")
    .select("id")
    .where("session_id", "=", id)
    .where("state", "=", "working")
    .executeTakeFirst();
  if (working) throw new AppError("conflict", AGENT_MESSAGES.stillWorking);
  await services.db.deleteFrom("agent_session").where("id", "=", id).execute();
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "agent-session.deleted",
    workspaceId: actor.workspace.id,
    target: { kind: "agent_session", id },
  });
}

// ---- The conversation

export interface PersonMessage {
  id: string;
  text: string;
  quote: string | null;
  files: FileView[];
  author: { id: string; name: string } | null;
  createdAt: string;
}

export interface TurnView {
  id: string;
  state: "working" | "waiting" | "finished" | "stopped" | "failed";
  message: PersonMessage;
  events: { id: string; seq: number; type: string; data: Record<string, unknown> }[];
  answerText: string;
  footer: string | null;
  canRetry: boolean;
  canEdit: boolean;
  live: boolean;
  lastEventId: string;
  /**
   * When the current working stretch began (the turn's start, or the last form answer), while
   * it works; null otherwise. The status line's timer counts from it after a reload (19.4).
   */
  workingSince: string | null;
}

/**
 * What one viewer may see of an event: internal fields go, and in someone else's session the
 * viewer's own access decides (spec 19.5, 24 G6; B1-22). A step shows its target and result only
 * when it names what it touched and the viewer can see all of it; anything else (lists of SSH
 * keys, tasks, Git accounts or repositories, a task's script, repository contents, guided rows and
 * sub-steps) shows its label and state only. Forms and the choice made in them are the author's:
 * others see that the chat waited, not what was offered or picked. A guided flow's words name
 * what it touched (repositories, projects, servers), so others get one sentence in their place
 * (C1-15).
 */
export function eventViewFor(
  actor: WorkspaceActor,
  authorId: string,
  hiddenSteps: Set<string>,
): (event: StoredEvent) => Record<string, unknown> {
  const foreign = authorId !== actor.personId;
  // One sentence stands for a run of guided words, however many replies it held.
  let inHiddenWords = false;
  return (event) => {
    const { refs, guided, first, ...data } = event.data as Record<string, unknown> & {
      refs?: unknown;
      guided?: unknown;
      first?: unknown;
    };
    if (!foreign) return data;
    if (event.type === "text") {
      if (guided !== true) {
        if (String(data.delta ?? "").trim() !== "") inHiddenWords = false;
        return data;
      }
      if (first !== true || inHiddenWords) return { ...data, delta: "" };
      inHiddenWords = true;
      const lead = /^\s*/.exec(String(data.delta ?? ""))?.[0] ?? "";
      return { ...data, delta: `${lead}${GUIDED_TEXT_HIDDEN}` };
    }
    if (event.type.startsWith("step.")) inHiddenWords = false;
    // Follow-up suggestions are the author's to click, and they name what the answer touched.
    if (event.type === "suggestions") return { ...data, items: [] };
    const stepId = String(data.stepId);
    if (event.type === "step.finished") {
      const list = Array.isArray(refs)
        ? (refs as { kind: string; id: string; projectId?: string; environmentId?: string }[])
        : [];
      const blocked =
        list.length === 0 ||
        list.some((ref) => !actor.access.can(`${ref.kind}.see` as never, ref as never));
      if (blocked) hiddenSteps.add(stepId);
      else hiddenSteps.delete(stepId);
    }
    if (
      (event.type === "step.started" || event.type === "step.finished") &&
      hiddenSteps.has(stepId)
    ) {
      return {
        ...data,
        target: "",
        result: null,
        reason: data.reason ? "You don't have access to what this step touched." : null,
      };
    }
    if (event.type === "form.requested") {
      const { form: _form, ...rest } = data;
      return rest;
    }
    if (event.type === "form.answered") return { ...data, label: "" };
    return data;
  };
}

/** What others read in place of a guided flow's reply in a shared chat (C1-15). */
export const GUIDED_TEXT_HIDDEN =
  "_This part of the answer is shown only to the person who asked: it may name things you don't have access to._";

/**
 * Steps a viewer may not see, read ahead so even their "started" rows are blanked: in someone
 * else's session every step is hidden until its finished row shows the viewer may see it.
 */
export function hiddenStepsFor(
  actor: WorkspaceActor,
  authorId: string,
  events: StoredEvent[],
): Set<string> {
  const hidden = new Set<string>();
  if (authorId === actor.personId) return hidden;
  for (const event of events) {
    if (event.type === "step.started")
      hidden.add(String((event.data as { stepId?: unknown }).stepId));
  }
  const viewOf = eventViewFor(actor, authorId, hidden);
  for (const event of events) if (event.type === "step.finished") viewOf(event);
  return hidden;
}

/** The newest turn a session shows, which alone may be retried or edited (spec 19.4). */
export async function lastTurnOf(
  services: ControlServices,
  sessionId: string,
): Promise<string | null> {
  const row = await services.db
    .selectFrom("agent_turn")
    .select("id")
    .where("session_id", "=", sessionId)
    .where("hidden", "=", false)
    .orderBy("created_at", "desc")
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();
  return row?.id ?? null;
}

export async function sessionDetail(
  services: ControlServices,
  actor: WorkspaceActor,
  id: string,
  before: string | null,
  inputs: ModelInputs | null,
): Promise<{ session: SessionView; turns: TurnView[]; more: boolean }> {
  const session = await visibleSession(services, actor, id);
  let query = services.db
    .selectFrom("agent_turn as t")
    .innerJoin("agent_message as m", "m.id", "t.message_id")
    .leftJoin("person as p", "p.id", "m.author_id")
    .select([
      "t.id",
      "t.state",
      "t.answer_text",
      "t.created_at",
      "t.closed_at",
      "t.work_started_at",
      "m.id as message_id",
      "m.text",
      "m.quote",
      "m.file_ids",
      "m.created_at as message_at",
      "m.author_id",
      "p.first_name",
      "p.last_name",
      "p.email",
    ])
    .where("t.session_id", "=", id)
    .where("t.hidden", "=", false);
  if (before && isId(before)) {
    const pivot = await services.db
      .selectFrom("agent_turn")
      .select("created_at")
      .where("id", "=", before)
      .executeTakeFirst();
    if (pivot) query = query.where("t.created_at", "<", pivot.created_at);
  }
  const rows = await query
    .orderBy("t.created_at", "desc")
    .limit(AGENT_LIMITS.turnsPerPage + 1)
    .execute();
  const more = rows.length > AGENT_LIMITS.turnsPerPage;
  const page = rows.slice(0, AGENT_LIMITS.turnsPerPage).reverse();
  const fileIds = [...new Set(page.flatMap((row) => row.file_ids))];
  const files =
    fileIds.length === 0
      ? new Map<string, FileRow>()
      : new Map(
          (
            (await services.db
              .selectFrom("agent_file")
              .select(FILE_COLUMNS)
              .where("id", "in", fileIds)
              .execute()) as FileRow[]
          ).map((row) => [row.id, row]),
        );
  // Retry and Edit belong to the session's last turn only (spec 19.4), not to the newest turn of
  // an older page (B1-57).
  const lastTurnId = await lastTurnOf(services, id);
  const turns: TurnView[] = [];
  for (const row of page) {
    const events = await readEvents(services.db, row.id);
    const hidden = hiddenStepsFor(actor, session.author_id, events);
    const viewOf = eventViewFor(actor, session.author_id, hidden);
    const finished = events.findLast((event) => event.type === "turn.finished");
    const last = row.id === lastTurnId;
    const shown = events.map((event) => ({ event, data: viewOf(event) }));
    // Someone else's answer is what their events show them, guided words replaced (C1-15).
    const answerText =
      session.author_id === actor.personId
        ? row.answer_text
        : shown
            .filter((item) => item.event.type === "text")
            .map((item) => String(item.data.delta ?? ""))
            .join("");
    const state = row.state as TurnView["state"];
    turns.push({
      id: row.id,
      state,
      message: {
        id: row.message_id,
        text: row.text,
        quote: row.quote,
        files: row.file_ids
          .map((fileId) => files.get(fileId))
          .filter((file): file is FileRow => !!file)
          .map((file) => fileView(file, inputs)),
        author:
          row.author_id && row.email
            ? {
                id: row.author_id,
                name: displayName(
                  row as { first_name: string | null; last_name: string | null; email: string },
                ),
              }
            : null,
        createdAt: row.message_at.toISOString(),
      },
      events: shown.map(({ event, data }) => ({
        id: eventId(row.id, event.seq),
        seq: event.seq,
        type: event.type,
        data,
      })),
      answerText,
      footer: finished ? String(finished.data.footer ?? "") : null,
      canRetry: last && session.author_id === actor.personId && Boolean(finished?.data.canRetry),
      canEdit:
        last && session.author_id === actor.personId && state !== "working" && state !== "waiting",
      live: row.closed_at === null,
      lastEventId: eventId(row.id, events.at(-1)?.seq ?? 0),
      workingSince:
        state === "working" && row.work_started_at ? row.work_started_at.toISOString() : null,
    });
  }
  const open = await openTurns(services, [id]);
  return { session: view(session, actor, open.get(id)), turns, more };
}
