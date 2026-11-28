import type { AgentFormAnswer, FormRequest } from "@nearzero/shared";
import type { AgentContext } from "./context.ts";
import { createProjectFlow } from "./flows/create-project.ts";
import { deleteProjectFlow } from "./flows/delete-project.ts";
import { deployNameFlow } from "./flows/deploy-name.ts";
import { CONNECT_RETURN_MS, gitImportFlow } from "./flows/git-import.ts";
import { gitLinkFlow } from "./flows/git-link.ts";
import type { FlowModule, FlowName, FlowResult, FlowRun } from "./flows/kit.ts";
import { type Intent, intentOf, splitClauses } from "./flows/parse.ts";
import type { ModelItem } from "./history.ts";

/**
 * Guided flows (spec 19.7): create or delete a project, "deploy <name>", the Git import and a
 * pasted repository link (30d R4-01, checked before anything is promised) run a
 * fixed sequence before the model, with rows for their steps, pickers and forms for choices, and
 * replies that stream like the model's. A message with several clauses runs each in order; the
 * first clause that isn't a flow's, and everything after it, goes to the model. A flow either
 * answers itself, waits for a form (its state is kept with the turn, so it survives a restart),
 * or hands over to the model in the same turn with a note only the model sees.
 */

/** The wait's "capability" when a guided flow is the one waiting. */
export const GUIDED_CAPABILITY = "guided_flow";

// biome-ignore lint/suspicious/noExplicitAny: each flow takes its own intent shape.
const FLOWS: Record<FlowName, FlowModule<any>> = {
  create_project: createProjectFlow,
  delete_project: deleteProjectFlow,
  deploy_name: deployNameFlow,
  git_import: gitImportFlow,
  git_link: gitLinkFlow,
};

/** What waits with the turn: the clauses still to run and the flow in progress. */
export interface GuidedState extends Record<string, unknown> {
  v: 1;
  queue: string[];
  current: { flow: FlowName; state: Record<string, unknown> } | null;
  /** What the clauses so far did, for the model's note if it takes over later. */
  done: string[];
  /** A Connect button sent the person away: their return resumes the flow until then. */
  connectUntil: string | null;
}

export interface GuidedHost {
  ctx: AgentContext;
  message: string;
  hasModel: boolean;
  /** Streams words to the person (ids held back like the model's). */
  say(text: string): void;
  /** Saves the person's question for the model, once a flow has taken the message. */
  saveQuestion(): Promise<void>;
  remember(item: ModelItem): Promise<void>;
}

export type GuidedOutcome =
  /** No flow took the message; nothing was shown or saved. */
  | { kind: "none" }
  | { kind: "answered" }
  | { kind: "waiting"; form: FormRequest; waitLabel: string; context: GuidedState }
  | { kind: "handover" }
  | { kind: "stopped" };

/** The run a flow sees, with its words gathered for the model's history. */
function runFor(host: GuidedHost): { run: FlowRun; flush: () => Promise<void> } {
  let words = "";
  const run: FlowRun = {
    ctx: host.ctx,
    message: host.message,
    hasModel: host.hasModel,
    say(text) {
      if (text.trim() === "") return;
      words = words === "" ? text : `${words}\n\n${text}`;
      host.say(text);
    },
  };
  return {
    run,
    async flush() {
      if (words === "") return;
      const text = words;
      words = "";
      await host.remember({ role: "assistant", text, toolCalls: [] });
    },
  };
}

function quoted(clauses: readonly string[]): string {
  return clauses.map((clause) => `"${clause}"`).join(", then ");
}

/** The rest of the message goes to the model (or, without a key, says it needs one). */
async function handRest(
  host: GuidedHost,
  run: FlowRun,
  flush: () => Promise<void>,
  state: GuidedState,
  rest: string[],
): Promise<GuidedOutcome> {
  if (!host.hasModel) {
    run.say(
      `The rest of your message (${quoted(rest)}) needs Nearzero Agent's model, and this workspace has no OpenRouter API key yet. An owner or admin can add one in Settings → API keys; then ask again.`,
    );
    await flush();
    return { kind: "answered" };
  }
  await flush();
  await host.remember({
    role: "note",
    text: `Nearzero's guided steps already handled the first part of the person's message (${state.done.join(" ") || "see the rows above"}). Their results are shown above; don't redo them. Now handle only the rest of what the person asked: ${quoted(rest)}.`,
  });
  return { kind: "handover" };
}

/** Settles one flow result, then runs the following clauses until something waits or ends. */
async function settle(
  host: GuidedHost,
  run: FlowRun,
  flush: () => Promise<void>,
  state: GuidedState,
  flow: FlowName,
  clause: string,
  first: FlowResult,
): Promise<GuidedOutcome> {
  let result = first;
  let name = flow;
  let current = clause;
  for (;;) {
    switch (result.kind) {
      case "ask":
        state.current = { flow: name, state: result.state };
        state.connectUntil = result.connectReturn
          ? new Date(Date.now() + CONNECT_RETURN_MS).toISOString()
          : null;
        await flush();
        return { kind: "waiting", form: result.form, waitLabel: result.waitLabel, context: state };
      case "stopped":
        await flush();
        return { kind: "stopped" };
      case "model":
        return handRest(host, run, flush, state, [current, ...state.queue]);
      case "handover": {
        await flush();
        const rest =
          state.queue.length > 0
            ? `\nAfter that, the person also asked: ${quoted(state.queue)}. Handle that too, in order.`
            : "";
        await host.remember({ role: "note", text: `${result.note}${rest}` });
        return { kind: "handover" };
      }
      case "done":
        state.done.push(result.summary);
        state.current = null;
        break;
    }
    const next = state.queue.shift();
    if (next === undefined) {
      await flush();
      return { kind: "answered" };
    }
    const intent = intentOf(next);
    if (!intent) return handRest(host, run, flush, state, [next, ...state.queue]);
    name = intent.flow;
    current = next;
    result = await FLOWS[name].start(run, flowInput(intent));
  }
}

function flowInput(intent: Intent): unknown {
  const { flow: _flow, ...rest } = intent;
  return rest;
}

/** A fresh message: runs its clauses' flows, or answers `none` when the first isn't a flow's. */
export async function startGuided(host: GuidedHost): Promise<GuidedOutcome> {
  const clauses = splitClauses(host.message);
  if (!clauses) return { kind: "none" };
  const intent = intentOf(clauses[0] as string);
  if (!intent) return { kind: "none" };
  const { run, flush } = runFor(host);
  const result = await FLOWS[intent.flow].start(run, flowInput(intent));
  // Declined before showing anything: the model answers the whole message as usual.
  if (result.kind === "model") return { kind: "none" };
  await host.saveQuestion();
  const state: GuidedState = {
    v: 1,
    queue: clauses.slice(1),
    current: null,
    done: [],
    connectUntil: null,
  };
  return settle(host, run, flush, state, intent.flow, clauses[0] as string, result);
}

/** A form of a guided flow was answered: the flow continues where it waited. */
export async function resumeGuided(
  host: GuidedHost,
  context: Record<string, unknown>,
  answer: AgentFormAnswer,
): Promise<GuidedOutcome> {
  const state = context as GuidedState;
  const { run, flush } = runFor(host);
  if (!state.current) {
    await flush();
    return { kind: "answered" };
  }
  const { flow, state: flowState } = state.current;
  state.connectUntil = null;
  const result = await FLOWS[flow].resume(run, flowState, answer);
  return settle(host, run, flush, state, flow, "", result);
}
