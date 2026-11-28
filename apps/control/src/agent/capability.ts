import {
  AGENT_LIMITS,
  AGENT_POLICIES,
  type AgentFormAnswer,
  type AgentPolicy,
  AppError,
  stripInternalIds,
} from "@nearzero/shared";
import { z } from "zod";
import { recordAudit } from "../audit/audit.ts";
import type { ControlServices } from "../services.ts";
import { raceStop } from "./abort.ts";
import type { AccessRef, AgentContext, CapabilityOutcome, FormAsk } from "./context.ts";
import { InputRefusal, PolicyRefusal, ServerChoiceNeeded } from "./context.ts";
import { redactForModel, redactText } from "./redact.ts";
import { ResolveFailure } from "./resolve.ts";

/**
 * The capability catalog's shape and the one runner every action goes through (spec 19.6, 19.9,
 * 19.11, 20): input checked against its schema (malformed input goes back to the model asking for
 * a proper call), the repeat guard, the Agent policies, the person's own permissions (inside the
 * area functions), labels and targets without ids, results redacted and cut, audit records with
 * actor "Agent".
 */

export interface Capability<Input = unknown> {
  name: string;
  /** The area of spec 20 it belongs to. */
  area: string;
  description: string;
  input: z.ZodType<Input>;
  /** Agent policies that must all be on (none for reading). */
  policies: AgentPolicy[];
  /** Changes something: audited as an Agent action. */
  changes: boolean;
  label: { running: string; done: string };
  /** The row's target before the run resolves the real one. */
  startTarget?: (input: Input) => string;
  /** A module that isn't finished yet; the capability answers that it isn't available. */
  pending?: string | ((services: ControlServices) => string | null);
  /** Whether the model is offered it in this chat at all (research needs a key, files need files). */
  available?: (ctx: AgentContext) => boolean;
  run(ctx: AgentContext, input: Input): Promise<CapabilityOutcome>;
  /** Continues after the form this capability asked for was answered. */
  answer?(
    ctx: AgentContext,
    context: Record<string, unknown>,
    answer: AgentFormAnswer,
  ): Promise<CapabilityOutcome>;
}

// biome-ignore lint/suspicious/noExplicitAny: the catalog holds capabilities of every input type.
export type AnyCapability = Capability<any>;

export function pendingOf(capability: AnyCapability, services: ControlServices): string | null {
  return typeof capability.pending === "function"
    ? capability.pending(services)
    : (capability.pending ?? null);
}

export function defineCapability<Input>(capability: Capability<Input>): Capability<Input> {
  return capability;
}

/** Thrown by a capability whose module isn't finished yet (server setup, Compose, tasks). */
export class PendingModule extends Error {
  constructor(readonly module: string) {
    super(`Not available yet: it arrives with ${module}.`);
    this.name = "PendingModule";
  }
}

export const PENDING_MESSAGE = (module: string) =>
  `This isn't available in this version of Nearzero yet (it arrives with ${module}). Tell the person, and point them to the console page instead if there is one.`;

/** One action call from the model, after the stream ended. */
export interface ToolCallInput {
  id: string;
  name: string;
  arguments: string;
}

export interface CallOutcome {
  /** The text the model gets as the action's result. */
  toolResult: string;
  stepId: string | null;
  state: "succeeded" | "failed" | "stopped" | "needs_permission" | "rejected";
  form?: FormAsk;
  permission?: { policy: AgentPolicy };
  deployedServiceId?: string;
  showFiles?: string[];
}

export interface CallBook {
  /** Failures by identical call, for the repeat guard. */
  failures: Record<string, number>;
  /** Deploy requests by service, for the deploy cap. */
  deploys: Record<string, number>;
}

export function callKey(name: string, input: unknown): string {
  return `${name}:${stableJson(input)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, inner]) => inner !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stableJson(inner)}`).join(",")}}`;
}

/** The result text for the model: redacted, labelled where it carries outside content, cut at 12,000. */
export function modelResultText(value: unknown): string {
  const redacted = redactForModel(value);
  const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted, null, 1);
  if (text.length <= AGENT_LIMITS.toolResultMax) return text;
  return `${text.slice(0, AGENT_LIMITS.toolResultMax)}\n[Result cut at ${AGENT_LIMITS.toolResultMax.toLocaleString("en-US")} characters.]`;
}

function displayText(outcome: CapabilityOutcome): { text: string | null; truncated: boolean } {
  const raw =
    outcome.display !== undefined
      ? redactText(outcome.display)
      : (() => {
          const redacted = redactForModel(outcome.result);
          return typeof redacted === "string" ? redacted : JSON.stringify(redacted, null, 2);
        })();
  if (!raw) return { text: null, truncated: false };
  const clean = stripInternalIds(raw);
  return clean.length > AGENT_LIMITS.stepResultMax
    ? { text: clean.slice(0, AGENT_LIMITS.stepResultMax), truncated: true }
    : { text: clean, truncated: false };
}

/** Step targets never carry ids or credentials (spec 19.4, 19.11). */
export function safeTarget(text: string): string {
  return stripInternalIds(redactText(text)).replace(/\s+/g, " ").trim().slice(0, 120);
}

function shortReason(text: string): string {
  const clean = stripInternalIds(redactText(text)).trim();
  return clean.length > AGENT_LIMITS.failedReasonMax
    ? `${clean.slice(0, AGENT_LIMITS.failedReasonMax - 1)}…`
    : clean;
}

function issueText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "input"}: ${issue.message}`)
    .join("; ");
}

let stepCounter = 0;
export function newStepId(): string {
  stepCounter = (stepCounter + 1) % 1_000_000;
  return `s${Date.now().toString(36)}${stepCounter.toString(36)}`;
}

export interface StepHooks {
  started(stepId: string): void;
  finished(stepId: string): void;
  stopped(): boolean;
}

/** Runs one action call to completion and writes its row. */
export async function runCall(
  ctx: AgentContext,
  catalog: ReadonlyMap<string, AnyCapability>,
  call: ToolCallInput,
  book: CallBook,
  hooks: StepHooks,
): Promise<CallOutcome> {
  const capability = catalog.get(call.name);
  if (!capability || (capability.available && !capability.available(ctx))) {
    return {
      toolResult: `There is no action called "${call.name}" here. Use one of the actions you were given.`,
      stepId: null,
      state: "rejected",
    };
  }
  let parsedJson: unknown;
  try {
    parsedJson = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
  } catch {
    return {
      toolResult: `The input for ${call.name} wasn't valid JSON. Call it again with a JSON object that matches its parameters.`,
      stepId: null,
      state: "rejected",
    };
  }
  const parsed = capability.input.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      toolResult: `The input for ${call.name} didn't match its parameters (${issueText(parsed.error)}). Call it again with proper input.`,
      stepId: null,
      state: "rejected",
    };
  }
  const input = parsed.data;
  const key = callKey(call.name, input);
  const stepId = newStepId();
  const startTarget = safeTarget(capability.startTarget?.(input) ?? "");
  const started = Date.now();
  const finish = async (
    state: "succeeded" | "failed" | "stopped" | "needs_permission",
    target: string,
    reason: string | null,
    outcome: CapabilityOutcome | null,
    refs: AccessRef[] = [],
  ) => {
    const shown = outcome ? displayText(outcome) : { text: null, truncated: false };
    const stopped = hooks.stopped() && state !== "needs_permission";
    hooks.finished(stepId);
    await ctx.events.emit("step.finished", {
      stepId,
      state: stopped ? "stopped" : state,
      label:
        state === "succeeded" && !stopped
          ? outcome?.form
            ? askedLabel(outcome.form.waitLabel)
            : capability.label.done
          : capability.label.running,
      target: safeTarget(target),
      reason: stopped
        ? "Stopped. An action already started keeps going on its own."
        : reason
          ? shortReason(reason)
          : null,
      result: shown.text,
      resultTruncated: shown.truncated,
      durationMs: Date.now() - started,
      refs,
    });
    return stopped ? "stopped" : state;
  };

  // The repeat guard: the same failing call twice in this request is not run a third time.
  if ((book.failures[key] ?? 0) >= 2) {
    await ctx.events.emit("step.started", {
      stepId,
      capability: capability.name,
      label: capability.label.running,
      target: startTarget,
      startedAt: new Date().toISOString(),
    });
    hooks.started(stepId);
    await finish(
      "failed",
      startTarget,
      "Not run again: it already failed twice with the same input.",
      null,
    );
    return {
      toolResult:
        "This exact action with this exact input already failed twice in this request, so it was not run again. Change your approach: look things up, fix the input, or explain the failure to the person.",
      stepId,
      state: "failed",
    };
  }

  await ctx.events.emit("step.started", {
    stepId,
    capability: capability.name,
    label: capability.label.running,
    target: startTarget,
    startedAt: new Date().toISOString(),
  });
  hooks.started(stepId);
  ctx.status(capability.label.running);

  try {
    const pending = pendingOf(capability, ctx.services);
    if (pending) {
      book.failures[key] = (book.failures[key] ?? 0) + 1;
      await finish("failed", startTarget, `Not available yet: it arrives with ${pending}.`, null);
      return { toolResult: PENDING_MESSAGE(pending), stepId, state: "failed" };
    }
    for (const policy of capability.policies) {
      if (!ctx.policies[policy]) throw new PolicyRefusal(policy);
    }
    const raced = await raceStop(capability.run(ctx, input), ctx.signal);
    if (raced.stopped) {
      await finish("stopped", startTarget, null, null);
      return {
        toolResult:
          "Stopped by the person. If this action had already started something (a deploy, a setup), it keeps going on its own.",
        stepId,
        state: "stopped",
      };
    }
    return await settle(ctx, capability, input, raced.value, key, book, stepId, finish);
  } catch (error) {
    if (error instanceof ServerChoiceNeeded) {
      return await settle(
        ctx,
        capability,
        input,
        serverChoiceOutcome(startTarget, input, error),
        key,
        book,
        stepId,
        finish,
      );
    }
    return await failCall(ctx, capability, error, key, book, stepId, startTarget, finish);
  }
}

/**
 * The row of an action that stopped to ask the person something says it asked ("Asked for a
 * server"), never that the action is done: nothing exists yet (spec 19.4, C1-17).
 */
export function askedLabel(waitLabel: string): string {
  return /^Waiting for /.test(waitLabel)
    ? waitLabel.replace(/^Waiting for /, "Asked for ")
    : "Asked you";
}

/**
 * The row of an action carried out once its form was answered (C1-17): the server picked, a
 * delete confirmed, the access card's Check again. One row per action, as when the model runs it.
 * Nothing is shown when the answer only closed the form.
 */
export async function answeredRow(
  ctx: AgentContext,
  capability: AnyCapability,
  outcome: CapabilityOutcome,
): Promise<void> {
  if (outcome.target === "" && !outcome.failed && !outcome.form) return;
  const stepId = newStepId();
  const started = Date.now();
  const target = safeTarget(outcome.target);
  await ctx.events.emit("step.started", {
    stepId,
    capability: capability.name,
    label: capability.label.running,
    target,
    startedAt: new Date(started).toISOString(),
  });
  const shown = displayText(outcome);
  await ctx.events.emit("step.finished", {
    stepId,
    state: outcome.failed ? "failed" : "succeeded",
    label: outcome.failed
      ? capability.label.running
      : outcome.form
        ? askedLabel(outcome.form.waitLabel)
        : capability.label.done,
    target,
    reason: outcome.failed ? shortReason(outcome.failed) : null,
    result: shown.text,
    resultTruncated: shown.truncated,
    durationMs: Date.now() - started,
    refs: outcome.refs ?? [],
  });
}

/**
 * The server picker for an action that was given no server (30d R4-08). The answer runs the same
 * action again with the chosen server (see runWithChosenServer).
 */
export function serverChoiceOutcome(
  target: string,
  input: unknown,
  choice: ServerChoiceNeeded,
): CapabilityOutcome {
  return {
    target,
    result: {
      waiting:
        "The person is choosing the server in a form. Nothing was created yet; it is created once they pick.",
    },
    form: {
      form: {
        kind: "picker",
        purpose: "server",
        title: "Which server should it run on?",
        options: choice.options,
        searchable: choice.options.length > 8,
      },
      waitLabel: "Waiting for a server",
      context: {
        serverChoice: {
          input: input as Record<string, unknown>,
          offered: choice.options.map((option) => option.value),
        },
      },
    },
  };
}

/** Runs an action again with the server the person picked in its picker. */
export async function runWithChosenServer(
  ctx: AgentContext,
  capability: AnyCapability,
  context: { serverChoice: { input: Record<string, unknown>; offered: string[] } },
  answer: AgentFormAnswer,
): Promise<CapabilityOutcome> {
  const chosen =
    answer.outcome === "chosen" && typeof answer.option === "string" ? answer.option : null;
  if (!chosen || !context.serverChoice.offered.includes(chosen)) {
    return {
      target: "",
      result: { outcome: "The person closed the server picker, so nothing was created." },
    };
  }
  const input = capability.input.parse({ ...context.serverChoice.input, server: chosen });
  try {
    return await capability.run(ctx, input);
  } catch (error) {
    if (error instanceof ServerChoiceNeeded) {
      return serverChoiceOutcome("", input, error);
    }
    throw error;
  }
}

type Finish = (
  state: "succeeded" | "failed" | "stopped" | "needs_permission",
  target: string,
  reason: string | null,
  outcome: CapabilityOutcome | null,
  refs?: AccessRef[],
) => Promise<"succeeded" | "failed" | "stopped" | "needs_permission">;

/** Writes the row and the audit record for an outcome, from a run or a form answer. */
export async function settle(
  ctx: AgentContext,
  capability: AnyCapability,
  input: unknown,
  outcome: CapabilityOutcome,
  key: string,
  book: CallBook,
  stepId: string,
  finish: Finish,
): Promise<CallOutcome> {
  if (outcome.failed) book.failures[key] = (book.failures[key] ?? 0) + 1;
  if (outcome.deployedServiceId) {
    book.deploys[outcome.deployedServiceId] = (book.deploys[outcome.deployedServiceId] ?? 0) + 1;
  }
  const state = await finish(
    outcome.failed ? "failed" : "succeeded",
    outcome.target,
    outcome.failed ?? null,
    outcome,
    outcome.refs ?? [],
  );
  if (capability.changes && !outcome.failed && !outcome.form) {
    await auditAgent(ctx, capability.name, outcome.target, input, outcome.refs?.[0]);
  }
  return {
    toolResult: modelResultText(outcome.result),
    stepId,
    state,
    ...(outcome.form ? { form: outcome.form } : {}),
    ...(outcome.deployedServiceId ? { deployedServiceId: outcome.deployedServiceId } : {}),
    ...(outcome.showFiles ? { showFiles: outcome.showFiles } : {}),
  };
}

async function failCall(
  ctx: AgentContext,
  capability: AnyCapability,
  error: unknown,
  key: string,
  book: CallBook,
  stepId: string,
  target: string,
  finish: Finish,
): Promise<CallOutcome> {
  if (error instanceof PolicyRefusal) {
    await finish("needs_permission", target, error.message, null);
    await recordAudit(ctx.services.db, ctx.services.log, agentAuditActor(ctx), {
      action: "agent.refused",
      workspaceId: ctx.actor.workspace.id,
      details: {
        capability: capability.name,
        policy: error.policy,
        role: ctx.actor.role,
        sessionId: ctx.session.id,
        turnId: ctx.turn.id,
        target,
      },
    });
    return {
      toolResult: `Refused by the workspace's Agent policies: ${error.message} The person sees a permission card for "${AGENT_POLICIES[error.policy].label}". In one sentence, say what you need permission for, then stop.`,
      stepId,
      state: "needs_permission",
      permission: { policy: error.policy },
    };
  }
  book.failures[key] = (book.failures[key] ?? 0) + 1;
  if (error instanceof PendingModule) {
    await finish("failed", target, error.message, null);
    return { toolResult: PENDING_MESSAGE(error.module), stepId, state: "failed" };
  }
  if (error instanceof ResolveFailure) {
    await finish("failed", target, error.message, null);
    return {
      toolResult: modelResultText({ error: error.message, candidates: error.candidates }),
      stepId,
      state: "failed",
    };
  }
  if (error instanceof InputRefusal || error instanceof AppError) {
    const fields = error instanceof AppError && error.fields ? { fields: error.fields } : {};
    await finish("failed", target, error.message, null);
    return {
      toolResult: modelResultText({ error: error.message, ...fields }),
      stepId,
      state: "failed",
    };
  }
  ctx.services.log.error("an Agent action failed", { capability: capability.name, error });
  await finish("failed", target, "Something went wrong inside Nearzero while doing this.", null);
  return {
    toolResult:
      "Something went wrong inside Nearzero while doing this. Tell the person it failed unexpectedly; don't claim it worked.",
    stepId,
    state: "failed",
  };
}

export function agentAuditActor(ctx: AgentContext) {
  return {
    kind: "agent" as const,
    personId: ctx.actor.personId,
    label: ctx.actor.email,
    clientAddress: null,
  };
}

/** Every change the Agent makes (spec 19.6, 20.15): actor Agent, the person, their role, the session. */
export async function auditAgent(
  ctx: AgentContext,
  capability: string,
  target: string,
  input: unknown,
  ref?: AccessRef,
): Promise<void> {
  await recordAudit(ctx.services.db, ctx.services.log, agentAuditActor(ctx), {
    action: `agent.${capability.replaceAll("_", "-")}`,
    workspaceId: ctx.actor.workspace.id,
    ...(ref ? { target: { kind: ref.kind, id: ref.id } } : {}),
    details: {
      role: ctx.actor.role,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      target: safeTarget(target),
      input: redactForModel(input),
    },
  });
}

/** Builds the tool list the model is offered: name, description and JSON Schema of the input. */
export function toolDefinitions(capabilities: readonly AnyCapability[]) {
  return capabilities.map((capability) => {
    const schema = z.toJSONSchema(capability.input, {
      io: "input",
      unrepresentable: "any",
    }) as Record<string, unknown>;
    delete schema.$schema;
    return {
      type: "function" as const,
      function: {
        name: capability.name,
        description: capability.description,
        parameters: schema,
      },
    };
  });
}
