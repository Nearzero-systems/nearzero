import {
  AGENT_LIMITS,
  AGENT_POLICIES,
  type AgentFormAnswer,
  type AgentPolicy,
  AppError,
  type FormRequest,
  stripInternalIds,
} from "@nearzero/shared";
import { recordAudit } from "../../audit/audit.ts";
import { agentAuditActor, auditAgent } from "../capability.ts";
import type { AccessRef, AgentContext } from "../context.ts";
import { redactText } from "../redact.ts";
import { ResolveFailure } from "../resolve.ts";

/**
 * What every guided flow works with (spec 19.7): the person's context, a way to say words that
 * stream like the model's, rows for each step, plain-text policy refusals, and the shapes a
 * flow's step returns to the engine (done, ask a form, hand over to the model…).
 */

export type FlowName =
  | "create_project"
  | "delete_project"
  | "deploy_name"
  | "git_import"
  | "git_link";

/** A flow's own state, kept with a waiting turn (names and ids only, never a typed value). */
export type FlowState = Record<string, unknown>;

export interface FlowRun {
  ctx: AgentContext;
  /** The whole message, for flags such as "just import". */
  message: string;
  /** Whether the workspace has a usable model key: without one, a failure's text is the answer. */
  hasModel: boolean;
  /** Words for the person, streamed like the model's. */
  say(text: string): void;
}

export type FlowResult =
  /** The clause is finished; `summary` tells the model later what happened. */
  | { kind: "done"; summary: string }
  /** Wait for a form; the flow continues with `state` when it is answered. */
  | {
      kind: "ask";
      form: FormRequest;
      waitLabel: string;
      state: FlowState;
      /** The form sends the person to connect a Git account and back (kept 30 minutes). */
      connectReturn?: boolean;
    }
  /** Not this flow's after all (nothing was shown): the model takes the clause. */
  | { kind: "model" }
  /** The model takes over in the same turn, with a note only it sees. */
  | { kind: "handover"; note: string; summary: string }
  /** The person pressed Stop. */
  | { kind: "stopped" };

export interface FlowModule<Intent> {
  start(run: FlowRun, intent: Intent): Promise<FlowResult>;
  resume(run: FlowRun, state: FlowState, answer: AgentFormAnswer): Promise<FlowResult>;
}

export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** **name**, with Markdown's own characters kept literal. */
export function bold(name: string): string {
  return `**${name.replace(/([*_`[\]\\])/g, "\\$1")}**`;
}

/** Refusals inside guided flows are plain text with the settings hint (spec 19.9). */
export function policyRefusalText(policy: AgentPolicy): string {
  if (policy === "production") {
    return `That would change a production environment, and "${AGENT_POLICIES.production.label}" is off for the Agent in this workspace. Owners and admins turn it on in Settings → Agent policies, with a typed confirmation.`;
  }
  return `I can't do that here: the Agent policy "${AGENT_POLICIES[policy].label}" is off in this workspace. Owners and admins can turn it on in Settings → Agent policies.`;
}

/** The first of these policies that is off, recorded like every refusal (spec 19.6, 20.15). */
export async function refusedPolicy(
  run: FlowRun,
  policies: readonly AgentPolicy[],
  capability: string,
  target: string,
): Promise<AgentPolicy | null> {
  const off = policies.find((policy) => !run.ctx.policies[policy]) ?? null;
  if (!off) return null;
  const { ctx } = run;
  await recordAudit(ctx.services.db, ctx.services.log, agentAuditActor(ctx), {
    action: "agent.refused",
    workspaceId: ctx.actor.workspace.id,
    details: {
      capability,
      policy: off,
      role: ctx.actor.role,
      sessionId: ctx.session.id,
      turnId: ctx.turn.id,
      target,
      guided: true,
    },
  });
  return off;
}

/** Says the refusal and finishes the clause. */
export async function refuse(
  run: FlowRun,
  policies: readonly AgentPolicy[],
  capability: string,
  target: string,
): Promise<FlowResult | null> {
  const off = await refusedPolicy(run, policies, capability, target);
  if (!off) return null;
  run.say(policyRefusalText(off));
  return { kind: "done", summary: `Refused: the "${AGENT_POLICIES[off].label}" policy is off.` };
}

/** A failure's words for a row and a reply: the area's own words, never a stack. */
export function reasonOf(error: unknown): string {
  if (!(error instanceof AppError || error instanceof ResolveFailure)) {
    return "Something went wrong inside Nearzero while doing this.";
  }
  const clean = stripInternalIds(redactText(error.message)).trim();
  return clean.length > AGENT_LIMITS.failedReasonMax
    ? `${clean.slice(0, AGENT_LIMITS.failedReasonMax - 1)}…`
    : clean;
}

/** Errors that are the person's situation, not Nearzero's fault: everything else is logged. */
export function expected(error: unknown): boolean {
  return error instanceof AppError || error instanceof ResolveFailure;
}

export interface RowOutcome<T> {
  value: T;
  /** The row's final target, when it is only known at the end ("3 found"). */
  target?: string;
  result?: string | null;
}

/**
 * One step as a row (spec 19.4): present tense while it runs, past tense when done, red with the
 * reason when it fails. The failure is thrown on for the flow to explain.
 */
export async function row<T>(
  run: FlowRun,
  label: { running: string; done: string },
  target: string,
  work: () => Promise<RowOutcome<T>>,
): Promise<T> {
  const step = run.ctx.subStep(label.running, target);
  run.ctx.status(label.running);
  try {
    const outcome = await work();
    await step.finish("succeeded", label.done, null, outcome.result ?? null, outcome.target);
    return outcome.value;
  } catch (error) {
    if (!expected(error)) {
      run.ctx.services.log.error("a guided Agent step failed", { label: label.running, error });
    }
    await step.finish("failed", label.running, reasonOf(error));
    throw error;
  }
}

/** A row for something already done (an address given right after creation). */
export async function doneRow(
  run: FlowRun,
  label: string,
  target: string,
  result: string | null = null,
): Promise<void> {
  const step = run.ctx.subStep(label, target);
  await step.finish("succeeded", label, null, result);
}

/** Every change a flow makes is audited like the model's (actor Agent, spec 20.15). */
export async function audit(
  run: FlowRun,
  capability: string,
  target: string,
  input: unknown,
  ref?: AccessRef,
): Promise<void> {
  await auditAgent(run.ctx, capability, target, input, ref);
}

/**
 * A picker (spec 19.8): more than 8 options, and every repository or branch list, show as a
 * searchable dropdown.
 */
export function picker(
  purpose: Extract<FormRequest, { kind: "picker" }>["purpose"],
  title: string,
  options: Extract<FormRequest, { kind: "picker" }>["options"],
): Extract<FormRequest, { kind: "picker" }> {
  return {
    kind: "picker",
    purpose,
    title,
    options,
    searchable: options.length > 8 || purpose === "repository" || purpose === "branch",
  };
}
