import {
  AGENT_LIMITS,
  AGENT_MESSAGES,
  AGENT_POLICIES,
  type AgentErrorCode,
  type AgentFormAnswer,
  type AgentPolicy,
  type FormRequest,
  turnFooter,
} from "@nearzero/shared";
import { sql } from "kysely";
import type { WorkspaceActor } from "../http/actor.ts";
import type { ControlServices } from "../services.ts";
import { agentPoliciesFor } from "../settings/agent-policies.ts";
import { readWorkspaceKey } from "../settings/keys.ts";
import { pause } from "./abort.ts";
import { agentActor } from "./actor.ts";
import {
  type AnyCapability,
  answeredRow,
  auditAgent,
  type CallBook,
  modelResultText,
  newStepId,
  runCall,
  runWithChosenServer,
  safeTarget,
  toolDefinitions,
} from "./capability.ts";
import { capabilityCatalog } from "./catalog/index.ts";
import {
  type AgentContext,
  type CapabilityOutcome,
  isServerChoice,
  PolicyRefusal,
  type SubStep,
} from "./context.ts";
import { agentBus, readEvents, TurnEvents } from "./events.ts";
import { GUIDED_CAPABILITY, type GuidedHost, resumeGuided, startGuided } from "./flows.ts";
import { buildMessages, loadItems, type ModelItem, type StoredItem, saveItem } from "./history.ts";
import { CLOSING_SUMMARY_NOTE, EMPTY_REPLY_NOTE, PERMISSION_NOTE, systemPrompt } from "./prompt.ts";
import { OpenRouterProvider } from "./provider/openrouter.ts";
import {
  type ModelMessage,
  type ModelProvider,
  ProviderError,
  TEXT_ONLY,
  type ToolDefinition,
} from "./provider/provider.ts";
import { agentSettings } from "./settings.ts";
import { IdSafeText } from "./text-stream.ts";
import { generateTitle, suggestFollowUps } from "./titles.ts";
import "./tables.ts";

/**
 * A turn: one question and the Agent's answer (spec 19.6). The loop asks the model, runs the
 * actions it calls through the capability runner, and repeats until the model answers in words,
 * the step limit is reached, a form needs the person, or the person stops it. Everything it does
 * is an event saved as it happens; its state lives in the database, so a turn waiting on a form
 * continues after a restart, and a working turn left behind by a restart is marked stopped.
 */

export type WaitState =
  | {
      kind: "form";
      formId: string;
      formKind: FormRequest["kind"];
      label: string;
      toolCallId: string;
      capability: string;
      context: Record<string, unknown>;
      since: string;
    }
  | { kind: "model_key"; formId: string | null; label: string; since: string };

interface LocalTurn {
  controller: AbortController;
  openSteps: Map<string, { label: string; target: string; capability: string }>;
  stopping: boolean;
}

/** Turns this process is carrying out right now. */
const running = new Map<string, LocalTurn>();

export function runningHere(turnId: string): boolean {
  return running.has(turnId);
}

const providers = new WeakMap<ControlServices, ModelProvider>();

export function providerFor(services: ControlServices): ModelProvider {
  const settings = agentSettings(services);
  if (settings.provider) return settings.provider;
  let provider = providers.get(services);
  if (!provider) {
    provider = new OpenRouterProvider(settings.providerUrl, settings.fetch, settings.now, () => {
      const current = agentSettings(services);
      return {
        referer: current.providerReferer ?? services.consoleUrl(),
        title: current.providerTitle,
      };
    });
    providers.set(services, provider);
  }
  return provider;
}

interface TurnRow {
  id: string;
  session_id: string;
  workspace_id: string;
  person_id: string | null;
  message_id: string;
  state: string;
  deep_research: boolean;
  rounds: number;
  steps: number;
  failed_steps: number;
  deploys: unknown;
  failures: unknown;
  worked_ms: number;
  work_started_at: Date | null;
  answer_text: string;
  wait: unknown;
}

async function loadTurn(services: ControlServices, turnId: string): Promise<TurnRow | undefined> {
  return services.db
    .selectFrom("agent_turn")
    .select([
      "id",
      "session_id",
      "workspace_id",
      "person_id",
      "message_id",
      "state",
      "deep_research",
      "rounds",
      "steps",
      "failed_steps",
      "deploys",
      "failures",
      "worked_ms",
      "work_started_at",
      "answer_text",
      "wait",
    ])
    .where("id", "=", turnId)
    .executeTakeFirst() as Promise<TurnRow | undefined>;
}

export type TurnStart =
  | { kind: "fresh" }
  | { kind: "answer"; wait: Extract<WaitState, { kind: "form" }>; answer: AgentFormAnswer };

/**
 * Carries a turn out in this process until it finishes or waits. Never throws: anything
 * unexpected ends the turn with an error the person can read.
 */
export async function driveTurn(
  services: ControlServices,
  turnId: string,
  start: TurnStart,
): Promise<void> {
  if (running.has(turnId)) return;
  const local: LocalTurn = {
    controller: new AbortController(),
    openSteps: new Map(),
    stopping: false,
  };
  running.set(turnId, local);
  const settings = agentSettings(services);
  const { db, log } = services;
  const events = await TurnEvents.open(db, log, turnId, settings.textFlushMs);
  const heartbeat = setInterval(() => {
    void db
      .updateTable("agent_turn")
      .set({ heartbeat_at: new Date(), owner: settings.owner })
      .where("id", "=", turnId)
      .where("state", "=", "working")
      .execute()
      .catch(() => {});
  }, settings.heartbeatMs);
  const stopPoll = setInterval(() => {
    void db
      .selectFrom("agent_turn")
      .select(["stop_requested_at"])
      .where("id", "=", turnId)
      .executeTakeFirst()
      .then((row) => {
        if (row?.stop_requested_at && !local.controller.signal.aborted)
          stopLocal(services, turnId, local);
      })
      .catch(() => {});
  }, settings.stopPollMs);
  try {
    await runLoop(services, turnId, start, local, events);
  } catch (error) {
    log.error("an Agent turn failed", { turnId, error });
    try {
      await events.emit("error", {
        code: "internal",
        message: "Something went wrong inside Nearzero while answering. Send your message again.",
      });
      await finishTurn(services, turnId, events, local, {
        state: "failed",
        stoppedBy: null,
        suggest: false,
      });
    } catch (inner) {
      log.error("couldn't end an Agent turn", { turnId, error: inner });
    }
  } finally {
    clearInterval(heartbeat);
    clearInterval(stopPoll);
    running.delete(turnId);
  }
}

function stopLocal(services: ControlServices, turnId: string, local: LocalTurn): void {
  if (local.stopping) return;
  local.stopping = true;
  void TurnEvents.open(services.db, services.log, turnId, agentSettings(services).textFlushMs).then(
    (events) => events.emit("status", { kind: "stopping", label: "Stopping" }),
  );
  local.controller.abort();
}

/** Stop (spec 19.6): cancels the model request; actions already running keep going. */
export async function requestStop(services: ControlServices, turnId: string): Promise<boolean> {
  const { db } = services;
  const row = await db
    .updateTable("agent_turn")
    .set({ stop_requested_at: new Date() })
    .where("id", "=", turnId)
    .where("state", "in", ["working", "waiting"])
    .returning(["state"])
    .executeTakeFirst();
  if (!row) return false;
  const local = running.get(turnId);
  if (row.state === "waiting") {
    // Nothing runs: end it here, with the form left unanswered.
    const claimed = await db
      .updateTable("agent_turn")
      .set({ state: "working", work_started_at: null })
      .where("id", "=", turnId)
      .where("state", "=", "waiting")
      .executeTakeFirst();
    if (Number(claimed.numUpdatedRows) > 0) {
      const events = await TurnEvents.open(
        db,
        services.log,
        turnId,
        agentSettings(services).textFlushMs,
      );
      await finishTurn(services, turnId, events, null, {
        state: "stopped",
        stoppedBy: "person",
        suggest: false,
      });
    }
    return true;
  }
  // Here, the loop stops at once; elsewhere, its process notices the request within a second.
  if (local) stopLocal(services, turnId, local);
  return true;
}

interface LoopState {
  rounds: number;
  steps: number;
  failedSteps: number;
  answer: string;
  book: CallBook;
}

async function runLoop(
  services: ControlServices,
  turnId: string,
  start: TurnStart,
  local: LocalTurn,
  events: TurnEvents,
): Promise<void> {
  const { db } = services;
  const settings = agentSettings(services);
  const turn = await loadTurn(services, turnId);
  if (turn?.state !== "working") return;
  const session = await db
    .selectFrom("agent_session")
    .select(["id", "author_id", "title_source"])
    .where("id", "=", turn.session_id)
    .executeTakeFirstOrThrow();
  const message = await db
    .selectFrom("agent_message")
    .select(["id", "text", "quote", "file_ids"])
    .where("id", "=", turn.message_id)
    .executeTakeFirstOrThrow();
  const state: LoopState = {
    rounds: turn.rounds,
    steps: turn.steps,
    failedSteps: turn.failed_steps,
    answer: turn.answer_text,
    book: {
      failures: (turn.failures as Record<string, number>) ?? {},
      deploys: (turn.deploys as Record<string, number>) ?? {},
    },
  };
  const persist = () =>
    db
      .updateTable("agent_turn")
      .set({
        rounds: state.rounds,
        steps: state.steps,
        failed_steps: state.failedSteps,
        answer_text: state.answer,
        deploys: JSON.stringify(state.book.deploys),
        failures: JSON.stringify(state.book.failures),
      })
      .where("id", "=", turnId)
      .execute();
  // The generated title, started below, lands before the turn closes (within 6 seconds).
  let titling: Promise<void> = Promise.resolve();
  const end = async (outcome: "finished" | "failed" | "stopped", suggest: boolean) => {
    await persist();
    await Promise.race([titling, Bun.sleep(settings.titleTimeoutMs + 500)]);
    await finishTurn(services, turnId, events, local, {
      state: outcome,
      stoppedBy: outcome === "stopped" ? "person" : null,
      suggest,
    });
  };
  const fail = async (code: AgentErrorCode, text: string) => {
    await events.emit("error", { code, message: text });
    await end("failed", false);
  };

  if (settings.disabled) return fail("agent_disabled", AGENT_MESSAGES.disabled);

  let actor: WorkspaceActor;
  try {
    actor = await agentActor(services, {
      personId: turn.person_id ?? "",
      workspaceId: turn.workspace_id,
      sessionId: turn.session_id,
      turnId,
    });
  } catch (error) {
    return fail("internal", (error as Error).message);
  }
  const policies = (await agentPoliciesFor(db, turn.workspace_id)).switches;

  const key = await readWorkspaceKey(services, turn.workspace_id, "model");
  const modelKey = key.status === "ok" ? key.value : null;
  // Guided flows (spec 19.7) run before the model, and also without a model key.
  const guided = start.kind === "fresh" || start.wait.capability === GUIDED_CAPABILITY;
  if (modelKey === null && !guided) {
    return waitForKey(services, turnId, events, local, actor, policies["keys.ask-model-key"], null);
  }
  const provider = providerFor(services);
  const research = await readWorkspaceKey(services, turn.workspace_id, "research");
  const signal = local.controller.signal;
  const modelInputs =
    modelKey === null
      ? TEXT_ONLY
      : ((await provider.modelInputs(modelKey, settings.model, signal).catch(() => null)) ??
        settings.modelInputsFallback ??
        TEXT_ONLY);
  const fileCount = await db
    .selectFrom("agent_file")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("session_id", "=", turn.session_id)
    .where("sent_at", "is not", null)
    .executeTakeFirst();
  const sessionKeys = new Set(
    (
      await db
        .selectFrom("agent_session_key")
        .select("ssh_key_id")
        .where("session_id", "=", turn.session_id)
        .execute()
    ).map((row) => row.ssh_key_id),
  );

  let lastStatus = "";
  const status = (
    kind: "thinking" | "writing" | "step" | "stopping" | "waiting",
    label: string,
  ) => {
    const keyed = `${kind}:${label}`;
    if (keyed === lastStatus) return;
    lastStatus = keyed;
    void events.emit("status", { kind, label });
  };

  const ctx: AgentContext = {
    services,
    settings,
    actor,
    policies,
    session: { id: session.id, authorId: session.author_id },
    turn: { id: turnId, deepResearch: turn.deep_research },
    signal,
    provider,
    modelKey: modelKey ?? "",
    modelInputs,
    researchKey: research.status === "ok" ? research.value : null,
    events,
    hasFiles: Number(fileCount?.count ?? 0) > 0,
    sessionKeys,
    deploys: state.book.deploys,
    status: (label) => status("step", label),
    subStep: (label, target) => openSubStep(ctx, local, state, label, target),
  };

  const catalog = new Map(capabilityCatalog().map((capability) => [capability.name, capability]));
  const offered = [...catalog.values()].filter(
    (capability) => !capability.available || capability.available(ctx),
  );
  const tools = toolDefinitions(offered);
  const system = systemPrompt({
    personName: actor.email,
    role: actor.role,
    workspaceName: actor.workspace.name,
    policies,
    deepResearch: turn.deep_research,
    researchAvailable: ctx.researchKey !== null,
    hasFiles: ctx.hasFiles,
    modelSeesImages: modelInputs.images,
    today: new Date(settings.now()).toISOString().slice(0, 10),
    operatorText: settings.promptAppend,
  });
  const person = await db
    .selectFrom("person")
    .select(["first_name", "last_name"])
    .where("id", "=", actor.personId)
    .executeTakeFirst();
  const personName = [person?.first_name, person?.last_name]
    .filter((part) => part?.trim())
    .join(" ");
  const systemText = personName ? system.replace(` ${actor.email} (`, ` ${personName} (`) : system;

  const items: StoredItem[] = await loadItems(db, turn.session_id);
  const remember = async (item: ModelItem) => {
    await saveItem(db, turn.session_id, turnId, item);
    items.push({ turnId, item });
  };

  // Titles start at once, in parallel with the answer (spec 19.5: within 6 seconds).
  if (modelKey !== null && start.kind === "fresh" && session.title_source === "provisional") {
    const previous = items.some((entry) => entry.item.role === "user");
    if (!previous) {
      titling = generateTitle(services, provider, modelKey, session.id, message.text || "(files)")
        .then(async (title) => {
          if (title) await events.emit("session.titled", { title });
        })
        .catch(() => {});
    }
  }

  let questionSaved = false;
  const saveQuestion = async () => {
    if (questionSaved) return;
    questionSaved = true;
    const quoted = message.quote
      ? `${message.quote
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n\n`
      : "";
    await remember({ role: "user", text: `${quoted}${message.text}`, fileIds: message.file_ids });
  };

  if (guided) {
    const host: GuidedHost = {
      ctx,
      message: message.text,
      hasModel: modelKey !== null,
      say: (text) => {
        status("writing", "Writing");
        state.answer = streamAnswer(state.answer, text, events);
      },
      saveQuestion,
      remember,
    };
    const outcome =
      start.kind === "fresh"
        ? await startGuided(host)
        : await resumeGuided(host, start.wait.context, start.answer);
    if (outcome.kind === "stopped" || signal.aborted) return end("stopped", false);
    if (outcome.kind === "answered") return end("finished", true);
    if (outcome.kind === "waiting") {
      return enterWait(
        services,
        turnId,
        events,
        state,
        persist,
        {
          kind: "form",
          formId: newFormId(),
          formKind: outcome.form.kind,
          label: outcome.waitLabel,
          toolCallId: "",
          capability: GUIDED_CAPABILITY,
          context: outcome.context,
          since: new Date().toISOString(),
        },
        outcome.form,
      );
    }
    // "none": no flow took it; "handover": the model goes on in this turn with the flow's note.
  }
  if (modelKey === null) {
    return waitForKey(services, turnId, events, local, actor, policies["keys.ask-model-key"], null);
  }

  if (start.kind === "fresh") {
    await saveQuestion();
  } else if (start.wait.capability !== GUIDED_CAPABILITY) {
    // A form answer: the action that asked for it continues and gives the model its result.
    const capability = catalog.get(start.wait.capability);
    let outcome: CapabilityOutcome;
    if (capability && isServerChoice(start.wait.context)) {
      // The server the person picked for an action that was given none (30d R4-08).
      try {
        for (const policy of capability.policies) {
          if (!ctx.policies[policy]) throw new PolicyRefusal(policy);
        }
        outcome = await runWithChosenServer(ctx, capability, start.wait.context, start.answer);
      } catch (error) {
        outcome = {
          target: "",
          result: { error: (error as Error).message },
          failed: (error as Error).message,
        };
      }
    } else if (!capability?.answer) {
      outcome = { target: "", result: { outcome: start.answer.outcome } };
    } else {
      try {
        // Checked against the switches as they are now, not when the form was shown (19.9).
        for (const policy of capability.policies) {
          if (!ctx.policies[policy]) throw new PolicyRefusal(policy);
        }
        outcome = await capability.answer(ctx, start.wait.context, start.answer);
      } catch (error) {
        outcome = {
          target: "",
          result: { error: (error as Error).message },
          failed: (error as Error).message,
        };
      }
    }
    // The server picked for an action, or the access card's Check again, run the action itself
    // now: it gets its own row (C1-17). Other answers make their own rows, or none.
    if (capability && (isServerChoice(start.wait.context) || "gitAccess" in start.wait.context)) {
      await answeredRow(ctx, capability, outcome);
    }
    await remember({
      role: "tool",
      toolCallId: start.wait.toolCallId,
      name: start.wait.capability,
      content: modelResultText(outcome.result),
    });
    if (capability?.changes && !outcome.failed && !outcome.form && outcome.target) {
      await auditAgent(ctx, capability.name, outcome.target, start.wait.context, outcome.refs?.[0]);
    }
    if (outcome.form && capability) {
      // Asked again (variables named in a failed deploy, a changed delete plan).
      return enterWait(
        services,
        turnId,
        events,
        state,
        persist,
        {
          kind: "form",
          formId: newFormId(),
          formKind: outcome.form.form.kind,
          label: outcome.form.waitLabel,
          toolCallId: start.wait.toolCallId,
          capability: capability.name,
          context: outcome.form.context,
          since: new Date().toISOString(),
        },
        outcome.form.form,
      );
    }
    if (outcome.reply) {
      const shown = new IdSafeText();
      const text = shown.push(outcome.reply) + shown.flush();
      state.answer = joinAnswer(state.answer, text, events);
      await remember({ role: "assistant", text: outcome.reply, toolCalls: [] });
      return end("finished", true);
    }
  }

  const limit = turn.deep_research ? AGENT_LIMITS.deepResearchStepLimit : AGENT_LIMITS.stepLimit;
  let note: string | null = null;
  let toolsOff = false;
  let permissionStop = false;
  let nudged = false;

  for (;;) {
    if (signal.aborted) return end("stopped", false);
    const atLimit = state.rounds >= limit;
    if (atLimit) {
      note = CLOSING_SUMMARY_NOTE;
      toolsOff = true;
    }
    status("thinking", "Thinking");
    const messages: ModelMessage[] = [
      { role: "system", content: systemText },
      ...(await buildMessages(db, turn.session_id, items, turnId, modelInputs)),
      ...(note
        ? [
            {
              role: "user" as const,
              content: `[Note from Nearzero, not written by the person] ${note}`,
            },
          ]
        : []),
    ];
    note = null;
    const reply = await askModel(
      services,
      ctx,
      messages,
      toolsOff ? [] : tools,
      state,
      events,
      status,
    );
    if (!atLimit) state.rounds++;
    if (reply.kind === "stopped") {
      if (reply.text) await remember({ role: "assistant", text: reply.text, toolCalls: [] });
      return end("stopped", false);
    }
    if (reply.kind === "error") {
      if (reply.text) await remember({ role: "assistant", text: reply.text, toolCalls: [] });
      if (reply.error.kind === "rejected_key") {
        await persist();
        return waitForKey(
          services,
          turnId,
          events,
          local,
          actor,
          policies["keys.ask-model-key"],
          AGENT_MESSAGES.keyRejectedPrefix,
        );
      }
      if (atLimit) {
        state.answer = joinAnswer(state.answer, AGENT_MESSAGES.stepLimit, events);
        return end("finished", false);
      }
      const [code, text] = errorWords(reply.error);
      return fail(code, text);
    }
    const calls = toolsOff ? [] : reply.calls;
    await remember({ role: "assistant", text: reply.text, toolCalls: calls });

    if (atLimit) {
      if (!reply.text.trim())
        state.answer = joinAnswer(state.answer, AGENT_MESSAGES.stepLimit, events);
      return end("finished", false);
    }
    if (calls.length === 0) {
      if (reply.text.trim() !== "") return end("finished", !permissionStop);
      if (!nudged) {
        nudged = true;
        note = EMPTY_REPLY_NOTE;
        continue;
      }
      if (state.steps > 0) {
        state.answer = joinAnswer(state.answer, AGENT_MESSAGES.emptyAfterSteps, events);
        return end("finished", false);
      }
      return fail("empty_response", AGENT_MESSAGES.emptyResponse);
    }
    if (permissionStop) return end("finished", false);

    // Run the calls in order.
    let pendingForm: {
      callId: string;
      capability: AnyCapability;
      outcome: NonNullable<CapabilityOutcomeForm>;
    } | null = null;
    const toShow: string[] = [];
    for (const call of calls) {
      if (signal.aborted) {
        await remember({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: "Not run: the person stopped the request.",
        });
        continue;
      }
      if (pendingForm || permissionStop) {
        await remember({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: permissionStop
            ? "Not run: an earlier action in this reply needs permission first."
            : "Not run: the person must answer a form first. Call it again afterwards if it's still needed.",
        });
        continue;
      }
      const capability = catalog.get(call.name);
      const outcome = await runCall(ctx, catalog, call, state.book, {
        started: (stepId) => {
          state.steps++;
          local.openSteps.set(stepId, {
            label: capability?.label.running ?? call.name,
            target: "",
            capability: call.name,
          });
        },
        finished: (stepId) => {
          local.openSteps.delete(stepId);
        },
        stopped: () => signal.aborted,
      });
      if (outcome.state === "failed") state.failedSteps++;
      // An action waiting on a form gets its result when the form is answered.
      if (!(outcome.form && capability)) {
        await remember({
          role: "tool",
          toolCallId: call.id,
          name: call.name,
          content: outcome.toolResult,
        });
      }
      if (outcome.showFiles) toShow.push(...outcome.showFiles);
      if (outcome.permission && outcome.stepId) {
        permissionStop = true;
        await permissionCard(ctx, outcome.stepId, outcome.permission.policy);
      }
      if (outcome.form && capability) {
        pendingForm = { callId: call.id, capability, outcome: outcome.form };
      }
      await persist();
    }
    if (toShow.length > 0 && (modelInputs.images || modelInputs.pdfs)) {
      await remember({ role: "files", fileIds: [...new Set(toShow)] });
    }
    if (signal.aborted) return end("stopped", false);
    if (pendingForm) {
      return enterWait(
        services,
        turnId,
        events,
        state,
        persist,
        {
          kind: "form",
          formId: newFormId(),
          formKind: pendingForm.outcome.form.kind,
          label: pendingForm.outcome.waitLabel,
          toolCallId: pendingForm.callId,
          capability: pendingForm.capability.name,
          context: pendingForm.outcome.context,
          since: new Date().toISOString(),
        },
        pendingForm.outcome.form,
      );
    }
    if (permissionStop) {
      note = PERMISSION_NOTE;
      toolsOff = true;
    }
  }
}

type CapabilityOutcomeForm = CapabilityOutcome["form"];

/** Separates words of consecutive rounds and records them as the answer's text. */
function joinAnswer(answer: string, text: string, events: TurnEvents): string {
  if (text === "") return answer;
  const separator = answer !== "" && !answer.endsWith("\n") ? "\n\n" : "";
  events.text(separator + text);
  return answer + separator + text;
}

/**
 * A guided flow's words, streamed in small pieces like the model's (ids held back), and marked
 * as the flow's, so others who open a shared chat don't read the names in them (C1-15).
 */
function streamAnswer(answer: string, text: string, events: TurnEvents): string {
  const shown = new IdSafeText();
  const clean = shown.push(text) + shown.flush();
  if (clean === "") return answer;
  const separator = answer !== "" && !answer.endsWith("\n") ? "\n\n" : "";
  const pieces = `${separator}${clean}`.match(/(?:\S+\s*){1,6}|\s+/g) ?? [];
  pieces.forEach((piece, index) => {
    events.guidedText(piece, index === 0);
  });
  return answer + separator + clean;
}

function newFormId(): string {
  return `f${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

type ModelReply =
  | { kind: "ok"; text: string; calls: { id: string; name: string; arguments: string }[] }
  | { kind: "stopped"; text: string }
  | { kind: "error"; text: string; error: ProviderError };

/**
 * One model call, streamed: words go to the screen as they come (ids held back until safe),
 * action calls are gathered. Network errors, timeouts, rate limits and server errors are tried
 * again up to twice (1 s, then 3 s, or the provider's retry-after up to 10 s), but only while
 * nothing of this call has reached the screen (spec 19.6).
 */
async function askModel(
  services: ControlServices,
  ctx: AgentContext,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  state: LoopState,
  events: TurnEvents,
  status: (kind: "thinking" | "writing" | "step" | "stopping" | "waiting", label: string) => void,
): Promise<ModelReply> {
  const settings = agentSettings(services);
  const delays = settings.retryDelaysMs;
  for (let attempt = 0; ; attempt++) {
    const text = new IdSafeText();
    let raw = "";
    let shownAny = false;
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    const show = (piece: string) => {
      if (piece === "") return;
      if (!shownAny) {
        status("writing", "Writing");
        const separator = state.answer !== "" && !state.answer.endsWith("\n") ? "\n\n" : "";
        if (separator) {
          events.text(separator);
          state.answer += separator;
        }
      }
      shownAny = true;
      events.text(piece);
      state.answer += piece;
    };
    try {
      for await (const chunk of ctx.provider.stream(
        ctx.modelKey,
        {
          model: settings.model,
          messages,
          ...(tools.length > 0
            ? { tools, toolChoice: "auto" as const }
            : { toolChoice: "none" as const }),
          // Never the provider's paid OCR unless the operator chose it (31d G4-10).
          pdfEngine: settings.pdfEngine ?? (ctx.modelInputs.pdfs ? "native" : "pdf-text"),
        },
        { signal: ctx.signal, silenceMs: settings.providerSilenceMs },
      )) {
        if (chunk.type === "text") {
          raw += chunk.delta;
          show(text.push(chunk.delta));
        } else if (chunk.type === "tool_call") {
          const entry = calls.get(chunk.index) ?? { id: "", name: "", arguments: "" };
          if (chunk.id) entry.id = chunk.id;
          if (chunk.name) entry.name += chunk.name;
          if (chunk.argumentsDelta) entry.arguments += chunk.argumentsDelta;
          calls.set(chunk.index, entry);
        }
      }
      show(text.flush());
      if (ctx.signal.aborted) return { kind: "stopped", text: raw };
      const gathered = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          id: call.id || `call_${state.rounds}_${index}`,
          name: call.name,
          arguments: call.arguments,
        }))
        .filter((call) => call.name !== "");
      return { kind: "ok", text: raw, calls: gathered };
    } catch (error) {
      show(text.flush());
      if (ctx.signal.aborted) return { kind: "stopped", text: raw };
      const failure =
        error instanceof ProviderError
          ? error
          : new ProviderError("unavailable", (error as Error)?.message ?? "The provider failed.");
      if (failure.kind === "aborted") return { kind: "stopped", text: raw };
      if (!failure.retryable || shownAny || attempt >= delays.length) {
        return { kind: "error", text: raw, error: failure };
      }
      const wait =
        failure.retryAfterMs !== null
          ? Math.min(failure.retryAfterMs, settings.retryAfterMaxMs)
          : (delays[attempt] ?? 1_000);
      await pause(wait, ctx.signal);
      if (ctx.signal.aborted) return { kind: "stopped", text: "" };
    }
  }
}

function errorWords(error: ProviderError): [AgentErrorCode, string] {
  switch (error.kind) {
    case "out_of_credits":
      return ["out_of_credits", AGENT_MESSAGES.outOfCredits];
    case "rate_limited":
      return ["rate_limited", AGENT_MESSAGES.rateLimited];
    case "silent":
      return ["provider_silent", AGENT_MESSAGES.providerSilent];
    case "bad_request":
      return [
        "internal",
        `The model provider refused the request: ${error.message.replace(/^The model provider refused this request: /, "")} Send your message again, or rephrase it.`,
      ];
    default:
      return ["provider_unavailable", AGENT_MESSAGES.providerUnavailable];
  }
}

async function permissionCard(
  ctx: AgentContext,
  stepId: string,
  policy: AgentPolicy,
): Promise<void> {
  const admin = ctx.actor.role === "owner" || ctx.actor.role === "admin";
  const production = policy === "production";
  await ctx.events.emit("permission.needed", {
    stepId,
    policy,
    policyLabel: AGENT_POLICIES[policy].label,
    production,
    canAllow: admin && !production,
    message: production
      ? `The Agent needs permission: "${AGENT_POLICIES[policy].label}". ${AGENT_MESSAGES.productionCard}`
      : admin
        ? `The Agent needs permission: "${AGENT_POLICIES[policy].label}". Allow it to continue, or change it in Agent policies.`
        : `The Agent needs permission: "${AGENT_POLICIES[policy].label}". ${AGENT_MESSAGES.membersCard}`,
    settingsPath: "/dashboard/settings/agent-policies",
  });
}

function openSubStep(
  ctx: AgentContext,
  local: LocalTurn,
  state: LoopState,
  label: string,
  target: string,
): SubStep {
  const stepId = newStepId();
  const started = Date.now();
  state.steps++;
  local.openSteps.set(stepId, { label, target, capability: "step" });
  void ctx.events.emit("step.started", {
    stepId,
    capability: "step",
    label,
    target: safeTarget(target),
    startedAt: new Date().toISOString(),
  });
  return {
    async finish(outcome, doneLabel, reason = null, result = null, finalTarget = target) {
      local.openSteps.delete(stepId);
      if (outcome === "failed") state.failedSteps++;
      await ctx.events.emit("step.finished", {
        stepId,
        state: outcome,
        label: doneLabel,
        target: safeTarget(finalTarget),
        reason,
        result,
        resultTruncated: false,
        durationMs: Date.now() - started,
      });
    },
  };
}

async function enterWait(
  services: ControlServices,
  turnId: string,
  events: TurnEvents,
  state: LoopState,
  persist: () => Promise<unknown>,
  wait: WaitState,
  form: FormRequest | null,
): Promise<void> {
  if (form && wait.formId) await events.emit("form.requested", { formId: wait.formId, form });
  await events.emit("waiting", { formId: wait.formId, label: wait.label });
  await events.settle();
  await persist();
  await services.db
    .updateTable("agent_turn")
    .set({
      state: "waiting",
      wait: JSON.stringify(wait),
      worked_ms: sql<number>`worked_ms + greatest(0, (extract(epoch from (now() - coalesce(work_started_at, now()))) * 1000)::bigint)`,
      work_started_at: null,
    })
    .where("id", "=", turnId)
    .execute();
  void state;
}

/**
 * No usable model key (spec 19.10): owners and admins get the key form (or a pointer to
 * Settings → API keys), members are told who can add it; the turn waits and the question is
 * answered as soon as a key is saved.
 */
async function waitForKey(
  services: ControlServices,
  turnId: string,
  events: TurnEvents,
  local: LocalTurn,
  actor: WorkspaceActor,
  askInChat: boolean,
  prefix: string | null,
): Promise<void> {
  const admin = actor.role === "owner" || actor.role === "admin";
  const words = admin
    ? askInChat
      ? AGENT_MESSAGES.noKeyAdmin
      : AGENT_MESSAGES.noKeyAdminSettings
    : AGENT_MESSAGES.noKeyMember;
  const text = prefix ? `${prefix} ${words.replace(/^Hi, I'm Nearzero Agent\. /, "")}` : words;
  events.text(text);
  await services.db
    .updateTable("agent_turn")
    .set({ answer_text: text })
    .where("id", "=", turnId)
    .execute();
  const formId = admin && askInChat ? newFormId() : null;
  const wait: WaitState = {
    kind: "model_key",
    formId,
    label: admin ? AGENT_MESSAGES.waitingForKey : AGENT_MESSAGES.waitingForAdminKey,
    since: new Date().toISOString(),
  };
  void local;
  await enterWait(
    services,
    turnId,
    events,
    { rounds: 0, steps: 0, failedSteps: 0, answer: text, book: { failures: {}, deploys: {} } },
    async () => {},
    wait,
    formId
      ? {
          kind: "model_key",
          placeholder: "sk-or-…",
          canSave: true,
          settingsPath: "/dashboard/settings/api-keys",
        }
      : null,
  );
}

export interface FinishOptions {
  state: "finished" | "failed" | "stopped";
  stoppedBy: "person" | "restart" | null;
  suggest: boolean;
}

/** Ends a turn: running rows stopped, the footer, follow-ups after a normal answer, then closed. */
export async function finishTurn(
  services: ControlServices,
  turnId: string,
  events: TurnEvents,
  local: LocalTurn | null,
  options: FinishOptions,
): Promise<void> {
  const { db } = services;
  await events.settle();
  const reason =
    options.stoppedBy === "restart"
      ? "Stopped because Nearzero restarted. An action already started keeps going on its own."
      : "Stopped. An action already started keeps going on its own.";
  const open = local ? [...local.openSteps.entries()] : await openStepsOf(services, turnId);
  for (const [stepId, step] of open) {
    await events.emit("step.finished", {
      stepId,
      state: "stopped",
      label: step.label,
      target: step.target,
      reason,
      result: null,
      resultTruncated: false,
      durationMs: 0,
    });
  }
  local?.openSteps.clear();
  const row = await db
    .updateTable("agent_turn")
    .set({
      state: options.state,
      stopped_by: options.state === "stopped" ? options.stoppedBy : null,
      wait: null,
      finished_at: new Date(),
      worked_ms: sql<number>`worked_ms + greatest(0, (extract(epoch from (now() - coalesce(work_started_at, now()))) * 1000)::bigint)`,
      work_started_at: null,
    })
    .where("id", "=", turnId)
    .returning([
      "worked_ms",
      "steps",
      "failed_steps",
      "answer_text",
      "session_id",
      "message_id",
      "person_id",
      "workspace_id",
    ])
    .executeTakeFirstOrThrow();
  const failedSteps = row.failed_steps;
  const footer = turnFooter({
    state: options.state,
    stoppedBy: options.stoppedBy,
    workedMs: Number(row.worked_ms),
    steps: row.steps,
    failedSteps,
  });
  const canRetry = options.state !== "finished" || (row.steps > 0 && row.answer_text.trim() === "");
  await events.emit("turn.finished", {
    state: options.state,
    stoppedBy: options.state === "stopped" ? options.stoppedBy : null,
    workedMs: Number(row.worked_ms),
    steps: row.steps,
    failedSteps,
    footer,
    canRetry,
    finishedAt: new Date().toISOString(),
  });
  if (options.suggest && options.state === "finished" && row.answer_text.trim() !== "") {
    try {
      const key = await readWorkspaceKey(services, row.workspace_id, "model");
      if (key.status === "ok") {
        const question = await db
          .selectFrom("agent_message")
          .select("text")
          .where("id", "=", row.message_id)
          .executeTakeFirst();
        const steps = (await readEvents(db, turnId))
          .filter((event) => event.type === "step.finished")
          .map((event) => `${String(event.data.label)} ${String(event.data.target)}`.trim());
        const items = await suggestFollowUps(services, providerFor(services), key.value, {
          question: question?.text ?? "",
          answer: row.answer_text,
          steps,
        });
        if (items.length > 0) await events.emit("suggestions", { items });
      }
    } catch (error) {
      services.log.warn("couldn't suggest follow-ups", { turnId, error });
    }
  }
  await closeTurn(services, turnId, events);
}

export async function closeTurn(
  services: ControlServices,
  turnId: string,
  events: TurnEvents,
): Promise<void> {
  await events.settle();
  await services.db
    .updateTable("agent_turn")
    .set({ closed_at: new Date() })
    .where("id", "=", turnId)
    .execute();
  TurnEvents.release(turnId);
  agentBus.publish(turnId, "closed");
}

/** Rows a turn started and never finished (for a turn carried out by a process that is gone). */
export async function openStepsOf(
  services: ControlServices,
  turnId: string,
): Promise<[string, { label: string; target: string; capability: string }][]> {
  const open = new Map<string, { label: string; target: string; capability: string }>();
  for (const event of await readEvents(services.db, turnId)) {
    const stepId = String(event.data.stepId ?? "");
    if (event.type === "step.started") {
      open.set(stepId, {
        label: String(event.data.label ?? ""),
        target: String(event.data.target ?? ""),
        capability: String(event.data.capability ?? ""),
      });
    } else if (event.type === "step.finished") {
      open.delete(stepId);
    }
  }
  return [...open.entries()];
}
