import {
  AGENT_POLICIES,
  type AgentPolicy,
  type AgentPolicySwitches,
  type FormRequest,
} from "@nearzero/shared";
import type { WorkspaceActor } from "../http/actor.ts";
import type { ControlServices } from "../services.ts";
import type { TurnEvents } from "./events.ts";
import type { ModelInputs, ModelProvider } from "./provider/provider.ts";
import type { AgentSettings } from "./settings.ts";

/**
 * What a capability gets while it runs: the person's actor (their own permissions), the
 * workspace's Agent policies, the turn it belongs to and its stop signal.
 */

export interface AgentContext {
  services: ControlServices;
  settings: AgentSettings;
  actor: WorkspaceActor;
  policies: AgentPolicySwitches;
  session: { id: string; authorId: string };
  turn: { id: string; deepResearch: boolean };
  /** Fires when the person presses Stop: waits end, running actions keep going. */
  signal: AbortSignal;
  provider: ModelProvider;
  modelKey: string;
  modelInputs: ModelInputs;
  researchKey: string | null;
  events: TurnEvents;
  /** Whether the chat has files (the file capabilities exist only then). */
  hasFiles: boolean;
  /** SSH keys added through this chat's form: usable without "Read SSH keys". */
  sessionKeys: Set<string>;
  /** Deploys requested in this request, by service (the deploy cap, spec 19.6). */
  deploys: Record<string, number>;
  /** Replaces the live status line while a long step runs ("Following web · 40s"). */
  status(label: string): void;
  /** A row of its own inside a capability (each service of a project delete). */
  subStep(label: string, target: string): SubStep;
}

export interface SubStep {
  finish(
    state: "succeeded" | "failed",
    label: string,
    reason?: string | null,
    result?: string | null,
    /** The final target, when it is only known at the end ("3 found"). */
    target?: string,
  ): Promise<void>;
}

/** Turns into a "Needs permission" row and the permission card (spec 19.9). */
export class PolicyRefusal extends Error {
  constructor(
    readonly policy: AgentPolicy,
    message?: string,
  ) {
    super(
      message ??
        (policy === "production"
          ? `This changes a production environment, which needs the "${AGENT_POLICIES.production.label}" Agent policy.`
          : `This needs the "${AGENT_POLICIES[policy].label}" Agent policy, which is off in this workspace.`),
    );
    this.name = "PolicyRefusal";
  }
}

/** A refusal of the model's input itself (a secret-looking command, file contents…). */
/**
 * No server was named and at least one ready server exists (30d R4-08): the person picks one,
 * or the Nearzero host when they may use it, in the same picker the guided import uses, and the
 * action runs again with their choice.
 */
export class ServerChoiceNeeded extends Error {
  constructor(readonly options: { value: string; label: string; description?: string }[]) {
    super("The person is choosing the server in a form.");
    this.name = "ServerChoiceNeeded";
  }
}

/** The wait's context while the person picks a server for an action. */
export interface ServerChoiceContext extends Record<string, unknown> {
  serverChoice: { input: Record<string, unknown>; offered: string[] };
}

export function isServerChoice(context: Record<string, unknown>): context is ServerChoiceContext {
  const choice = context.serverChoice as ServerChoiceContext["serverChoice"] | undefined;
  return (
    typeof choice === "object" &&
    choice !== null &&
    typeof choice.input === "object" &&
    Array.isArray(choice.offered)
  );
}

export class InputRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InputRefusal";
  }
}

export function requirePolicy(ctx: AgentContext, policy: AgentPolicy): void {
  if (!ctx.policies[policy]) throw new PolicyRefusal(policy);
}

/** Anything that would change an environment named "production" (spec 19.9, 20 intro). */
export function requireProductionAllowed(ctx: AgentContext, environmentName: string): void {
  if (environmentName === "production" && !ctx.policies.production) {
    throw new PolicyRefusal("production");
  }
}

/**
 * What the Agent passes when it creates a service (B1-56): while production changes are off, the
 * copy every other environment gets is left out of production, and the result says so.
 */
export function agentCreateOptions(ctx: AgentContext): {
  skipCopy: (environment: { name: string }) => string | null;
} {
  return {
    skipCopy: (environment) =>
      environment.name === "production" && !ctx.policies.production
        ? `Not copied: "${AGENT_POLICIES.production.label}" is off for the Agent. Add it there from the console, or turn the policy on.`
        : null,
  };
}

export interface FormAsk {
  form: FormRequest;
  /** The status line while it waits ("Waiting for the SSH key"). */
  waitLabel: string;
  /** Kept with the turn until the answer comes (never a value the person typed). */
  context: Record<string, unknown>;
}

export interface AccessRef {
  kind: "project" | "environment" | "service" | "server";
  id: string;
  projectId?: string;
  environmentId?: string;
}

export interface CapabilityOutcome {
  /** The row's short target: names only ("web on prod-1", "3 found"). */
  target: string;
  /** What the model reads (secrets are removed again before it goes anywhere). */
  result: unknown;
  /** The row's raw result, when it should differ from `result`. */
  display?: string;
  /** What the step touched, so viewers of a shared session see only what they may (G6). */
  refs?: AccessRef[];
  /** Marks the row failed with this reason; the model still gets `result`. */
  failed?: string | null;
  form?: FormAsk;
  /** A deploy was requested for this service (the deploy cap, spec 19.6). */
  deployedServiceId?: string;
  /** Files to show the model again (images, PDFs without text), when it takes them. */
  showFiles?: string[];
  /** After a form answer: Nearzero's own reply, which ends the turn without asking the model. */
  reply?: string;
}
