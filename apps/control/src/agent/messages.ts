import {
  AGENT_MESSAGES,
  AGENT_POLICIES,
  AGENT_POLICY_KEYS,
  type AgentFormAnswer,
  type AgentPolicy,
  AppError,
  provisionalTitle,
  type SendAgentMessageRequest,
} from "@nearzero/shared";
import { recordAudit } from "../audit/audit.ts";
import { auditActor, type WorkspaceActor } from "../http/actor.ts";
import { displayName } from "../identity/names.ts";
import type { ControlServices } from "../services.ts";
import { saveAgentPolicies } from "../settings/agent-policies.ts";
import { readWorkspaceKey } from "../settings/keys.ts";
import { agentBus, eventId, TurnEvents } from "./events.ts";
import { type FileRow, filesForMessage, fileView } from "./files.ts";
import {
  createSession,
  lastTurnOf,
  type PersonMessage,
  type SessionView,
  sessionViewOf,
  visibleSession,
} from "./sessions.ts";
import { agentSettings } from "./settings.ts";
import { closeTurn, driveTurn, finishTurn, type WaitState } from "./turns.ts";
import "./tables.ts";

/**
 * Sending a message, answering a form and the permission card's "Allow and continue"
 * (spec 19.5, 19.6, 19.8, 19.9). Each starts or continues a turn and returns at once; the turn
 * runs in the background and is followed through its event stream.
 */

export interface Sent {
  session: SessionView;
  message: PersonMessage;
  turn: { id: string; lastEventId: string };
}

interface PgError {
  code?: string;
  constraint?: string;
}

const busy = () => new AppError("conflict", AGENT_MESSAGES.busy);

/** Starts a turn for a message: one turn per session (spec 19.6, 22.4 rule 9). */
export async function sendMessage(
  services: ControlServices,
  actor: WorkspaceActor,
  sessionId: string | null,
  input: SendAgentMessageRequest,
): Promise<Sent> {
  await actor.access.require("agent.use");
  const { db } = services;
  if (!sessionId && input.text.trim() === "" && input.fileIds.length === 0) {
    throw new AppError("invalid_request", AGENT_MESSAGES.messageEmpty, {
      fields: { text: AGENT_MESSAGES.messageEmpty },
    });
  }
  const session = sessionId
    ? await visibleSession(services, actor, sessionId, { own: true })
    : await visibleSession(services, actor, (await createSession(services, actor)).id, {
        own: true,
      });
  let text = input.text;
  let quote = input.quote;
  let fileIds = input.fileIds;
  if (input.retryOf) {
    const previous = await db
      .selectFrom("agent_turn as t")
      .innerJoin("agent_message as m", "m.id", "t.message_id")
      .select(["t.id", "m.text", "m.quote", "m.file_ids"])
      .where("t.session_id", "=", session.id)
      .where("t.id", "=", input.retryOf)
      .executeTakeFirst();
    if (!previous) throw new AppError("not_found", "That message isn't in this session any more.");
    // Only the last message is retried or edited (spec 19.4, B1-57).
    if ((await lastTurnOf(services, session.id)) !== previous.id) {
      throw new AppError(
        "conflict",
        "Only the last message in a chat can be retried or edited. Send a new message instead.",
      );
    }
    text = previous.text;
    quote = previous.quote;
    fileIds = previous.file_ids;
  }
  if (text.trim() === "" && fileIds.length === 0) {
    throw new AppError("invalid_request", AGENT_MESSAGES.messageEmpty, {
      fields: { text: AGENT_MESSAGES.messageEmpty },
    });
  }
  const files = await filesForMessage(services, actor, session.id, fileIds);
  const settings = agentSettings(services);

  const outcome = await (async () => {
    try {
      return await db.transaction().execute(async (trx) => {
        await trx
          .selectFrom("agent_session")
          .select("id")
          .where("id", "=", session.id)
          .forUpdate()
          .executeTakeFirstOrThrow();
        const open = await trx
          .selectFrom("agent_turn")
          .select(["id", "state"])
          .where("session_id", "=", session.id)
          .where("state", "in", ["working", "waiting"])
          .executeTakeFirst();
        if (open?.state === "working") throw busy();
        if (open) {
          // A turn only waiting on a form ends: the new message moves the chat on.
          await trx
            .updateTable("agent_turn")
            .set({ state: "finished", wait: null, finished_at: new Date() })
            .where("id", "=", open.id)
            .execute();
        }
        const priorMessages = await trx
          .selectFrom("agent_message")
          .select((eb) => eb.fn.countAll<number>().as("count"))
          .where("session_id", "=", session.id)
          .executeTakeFirstOrThrow();
        const message = await trx
          .insertInto("agent_message")
          .values({
            session_id: session.id,
            author_id: actor.personId,
            text,
            quote,
            file_ids: files.map((file) => file.id),
          })
          .returning(["id", "created_at"])
          .executeTakeFirstOrThrow();
        if (files.length > 0) {
          await trx
            .updateTable("agent_file")
            .set({ session_id: session.id, message_id: message.id, sent_at: new Date() })
            .where(
              "id",
              "in",
              files.map((file) => file.id),
            )
            .where((eb) => eb.or([eb("session_id", "is", null), eb("session_id", "=", session.id)]))
            .execute();
        }
        const turn = await trx
          .insertInto("agent_turn")
          .values({
            session_id: session.id,
            workspace_id: actor.workspace.id,
            person_id: actor.personId,
            message_id: message.id,
            state: "working",
            deep_research: input.deepResearch,
            owner: settings.owner,
            heartbeat_at: new Date(),
            work_started_at: new Date(),
          })
          .returning("id")
          .executeTakeFirstOrThrow();
        let title: string | null = null;
        if (Number(priorMessages.count) === 0 && session.title === null) {
          title = provisionalTitle(
            text,
            files.map((file) => file.name),
          );
        }
        await trx
          .updateTable("agent_session")
          .set({
            last_message_at: new Date(),
            updated_at: new Date(),
            ...(title ? { title, title_source: "provisional" as const } : {}),
          })
          .where("id", "=", session.id)
          .execute();
        return {
          closed: open?.id ?? null,
          messageId: message.id,
          createdAt: message.created_at,
          turnId: turn.id,
          title,
        };
      });
    } catch (error) {
      const pg = error as PgError;
      if (pg?.code === "23505" && pg.constraint === "agent_turn_one_open_idx") throw busy();
      throw error;
    }
  })();

  if (outcome.closed) {
    const events = await TurnEvents.open(db, services.log, outcome.closed, settings.textFlushMs);
    await events.emit("notice", { text: AGENT_MESSAGES.formUnanswered });
    await finishTurn(services, outcome.closed, events, null, {
      state: "finished",
      stoppedBy: null,
      suggest: false,
    });
  }
  const events = await TurnEvents.open(db, services.log, outcome.turnId, settings.textFlushMs);
  await events.emit("turn.started", {
    turnId: outcome.turnId,
    sessionId: session.id,
    messageId: outcome.messageId,
    deepResearch: input.deepResearch,
    startedAt: new Date().toISOString(),
  });
  await events.emit("status", { kind: "thinking", label: "Thinking" });
  if (outcome.title) await events.emit("session.titled", { title: outcome.title });
  void driveTurn(services, outcome.turnId, { kind: "fresh" });
  return {
    session: await sessionViewOf(services, actor, session.id),
    message: {
      id: outcome.messageId,
      text,
      quote,
      files: files.map((file: FileRow) => fileView({ ...file, sent_at: new Date() }, null)),
      author: { id: actor.personId, name: await personName(services, actor) },
      createdAt: outcome.createdAt.toISOString(),
    },
    turn: { id: outcome.turnId, lastEventId: eventId(outcome.turnId, events.lastSeq) },
  };
}

async function personName(services: ControlServices, actor: WorkspaceActor): Promise<string> {
  const person = await services.db
    .selectFrom("person")
    .select(["first_name", "last_name", "email"])
    .where("id", "=", actor.personId)
    .executeTakeFirst();
  return person ? displayName(person) : actor.email;
}

/** Field names a form answer never carries: values go to the normal APIs (spec 19.8). */
const SECRET_FIELDS = new Set([
  "value",
  "values",
  "password",
  "privatekey",
  "key",
  "apikey",
  "script",
  "secret",
  "token",
]);

/** True when a body carries anything marked secret or a field that holds a secret value. */
export function carriesSecret(body: unknown, strictFields: boolean, depth = 0): boolean {
  if (body === null || typeof body !== "object" || depth > 8) return false;
  if (Array.isArray(body)) return body.some((item) => carriesSecret(item, strictFields, depth + 1));
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (key === "secret" && value) return true;
    if (strictFields && SECRET_FIELDS.has(key.toLowerCase())) return true;
    if (carriesSecret(value, strictFields, depth + 1)) return true;
  }
  return false;
}

function answerLabel(
  wait: Extract<WaitState, { kind: "form" }>,
  answer: AgentFormAnswer,
): { label: string; asMessage: boolean } {
  switch (wait.formKind) {
    case "picker":
      return { label: answer.label ?? answer.outcome, asMessage: true };
    case "project_name":
      return answer.outcome === "named"
        ? { label: `Project name: ${answer.name ?? ""}`, asMessage: true }
        : { label: "No name given", asMessage: false };
    case "variables":
      return answer.outcome === "saved"
        ? {
            label: `Saved ${(answer.names ?? []).length} variable${(answer.names ?? []).length === 1 ? "" : "s"}`,
            asMessage: false,
          }
        : { label: "Went on without variables", asMessage: false };
    case "ssh_key":
      return answer.outcome === "saved"
        ? { label: "Added an SSH key", asMessage: false }
        : { label: "No key added", asMessage: false };
    case "task_script":
      return answer.outcome === "saved"
        ? { label: "Saved the task script", asMessage: false }
        : { label: "Cancelled", asMessage: false };
    case "project_delete":
      return { label: answer.outcome === "delete" ? "Delete it" : "Keep it", asMessage: true };
    default:
      return { label: answer.outcome, asMessage: false };
  }
}

async function ownTurn(services: ControlServices, actor: WorkspaceActor, turnId: string) {
  if (!/^[0-9a-f-]{36}$/.test(turnId)) throw new AppError("not_found", "This turn doesn't exist.");
  const turn = await services.db
    .selectFrom("agent_turn as t")
    .innerJoin("agent_session as s", "s.id", "t.session_id")
    .select(["t.id", "t.state", "t.wait", "t.session_id", "s.author_id", "s.shared"])
    .where("t.id", "=", turnId)
    .where("t.workspace_id", "=", actor.workspace.id)
    .executeTakeFirst();
  if (!turn || (turn.author_id !== actor.personId && !turn.shared))
    throw new AppError("not_found", "This turn doesn't exist.");
  if (turn.author_id !== actor.personId)
    throw new AppError("forbidden", "Only the person who started this session can do that.");
  return turn;
}

const STALE_FORM = "This form was already answered, or the chat moved on.";

export async function answerForm(
  services: ControlServices,
  actor: WorkspaceActor,
  turnId: string,
  formId: string,
  answer: AgentFormAnswer,
): Promise<{ turn: { id: string; lastEventId: string } }> {
  const turn = await ownTurn(services, actor, turnId);
  const wait = turn.wait as WaitState | null;
  if (turn.state !== "waiting" || !wait || wait.formId !== formId)
    throw new AppError("conflict", STALE_FORM);
  const settings = agentSettings(services);
  if (wait.kind === "model_key") {
    const key = await readWorkspaceKey(services, actor.workspace.id, "model");
    if (key.status !== "ok")
      throw new AppError("conflict", "The key isn't saved yet. Save it, then continue.");
    const next = await rerunAfterKey(services, turnId);
    if (!next) throw new AppError("conflict", STALE_FORM);
    return { turn: next };
  }
  const claimed = await services.db
    .updateTable("agent_turn")
    .set({
      state: "working",
      wait: null,
      work_started_at: new Date(),
      owner: settings.owner,
      heartbeat_at: new Date(),
    })
    .where("id", "=", turnId)
    .where("state", "=", "waiting")
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) === 0) throw new AppError("conflict", STALE_FORM);
  const events = await TurnEvents.open(services.db, services.log, turnId, settings.textFlushMs);
  const { label, asMessage } = answerLabel(wait, answer);
  await events.emit("form.answered", { formId, outcome: answer.outcome, label, asMessage });
  await events.emit("status", { kind: "thinking", label: "Thinking" });
  void driveTurn(services, turnId, { kind: "answer", wait, answer });
  return { turn: { id: turnId, lastEventId: eventId(turnId, events.lastSeq) } };
}

/**
 * A key was saved while a question waited for it (spec 19.10): the "add a key" reply is hidden
 * from the chat and the model, and the same question is answered in a new turn.
 */
export async function rerunAfterKey(
  services: ControlServices,
  turnId: string,
): Promise<{ id: string; lastEventId: string } | null> {
  const settings = agentSettings(services);
  const created = await services.db.transaction().execute(async (trx) => {
    const old = await trx
      .updateTable("agent_turn")
      .set({ state: "finished", hidden: true, wait: null, finished_at: new Date() })
      .where("id", "=", turnId)
      .where("state", "=", "waiting")
      .returning(["session_id", "workspace_id", "person_id", "message_id", "deep_research"])
      .executeTakeFirst();
    if (!old) return null;
    const turn = await trx
      .insertInto("agent_turn")
      .values({
        session_id: old.session_id,
        workspace_id: old.workspace_id,
        person_id: old.person_id,
        message_id: old.message_id,
        state: "working",
        deep_research: old.deep_research,
        owner: settings.owner,
        heartbeat_at: new Date(),
        work_started_at: new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return {
      id: turn.id,
      sessionId: old.session_id,
      messageId: old.message_id,
      deepResearch: old.deep_research,
    };
  });
  if (!created) return null;
  const oldEvents = await TurnEvents.open(services.db, services.log, turnId, settings.textFlushMs);
  await oldEvents.emit("turn.replaced", { turnId: created.id });
  await closeTurn(services, turnId, oldEvents);
  const events = await TurnEvents.open(services.db, services.log, created.id, settings.textFlushMs);
  await events.emit("turn.started", {
    turnId: created.id,
    sessionId: created.sessionId,
    messageId: created.messageId,
    deepResearch: created.deepResearch,
    startedAt: new Date().toISOString(),
  });
  await events.emit("status", { kind: "thinking", label: "Thinking" });
  void driveTurn(services, created.id, { kind: "fresh" });
  agentBus.publish(turnId, "closed");
  return { id: created.id, lastEventId: eventId(created.id, events.lastSeq) };
}

/**
 * "Allow and continue" (spec 19.9): owners and admins turn the policy on (with its dependencies)
 * and the chat continues with "Allowed "<policy>". Please continue." Production is never allowed
 * from here: it needs the typed confirmation in Agent policies.
 */
export async function allowPolicy(
  services: ControlServices,
  actor: WorkspaceActor,
  turnId: string,
  policy: string,
): Promise<Sent> {
  const turn = await ownTurn(services, actor, turnId);
  if (!(AGENT_POLICY_KEYS as readonly string[]).includes(policy)) {
    throw new AppError("invalid_request", "There is no such Agent policy.");
  }
  const key = policy as AgentPolicy;
  if (key === "production") throw new AppError("forbidden", AGENT_MESSAGES.productionCard);
  if (actor.role !== "owner" && actor.role !== "admin")
    throw new AppError("forbidden", AGENT_MESSAGES.membersCard);
  await saveAgentPolicies(services, actor, { switches: { [key]: true } });
  await recordAudit(services.db, services.log, auditActor(actor), {
    action: "agent.policy-allowed",
    workspaceId: actor.workspace.id,
    details: { policy: key, sessionId: turn.session_id, turnId, role: actor.role },
  });
  return sendMessage(services, actor, turn.session_id, {
    text: `Allowed "${AGENT_POLICIES[key].label}". Please continue.`,
    quote: null,
    fileIds: [],
    deepResearch: false,
    retryOf: null,
  });
}
