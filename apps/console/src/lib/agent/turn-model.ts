import {
  type AgentErrorCode,
  type FormRequest,
  type StatusKind,
  type StepState,
  stripInternalIds,
  type TurnState,
} from "@nearzero/shared/browser";
import type {
  PermissionCard,
  PersonMessage,
  StepPart,
  TurnModel,
  TurnPart,
  TurnView,
  WireEvent,
} from "./types.ts";

/**
 * A turn as the chat shows it (spec 19.4, 19.6), built by applying its events in order. The
 * same function runs for saved events (a reload replays them) and live ones, so a turn looks the
 * same after a reload as it did while it ran. Pure and immutable: every change returns a new
 * turn, and parts that didn't change keep their identity.
 */

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

export function emptyTurn(id: string, message: PersonMessage, accepted: boolean): TurnModel {
  return {
    id,
    accepted,
    state: "working",
    message,
    parts: [],
    status: accepted ? null : { kind: "thinking", label: "Thinking" },
    permissions: [],
    footer: null,
    canRetry: false,
    canEdit: false,
    suggestions: [],
    answerText: "",
    lastEventId: `${id}:0`,
    live: true,
    workingSince: null,
    replacedBy: null,
    deepResearch: false,
    sendError: null,
  };
}

/** A turn from the session's saved view: its events replayed, then the view's own fields. */
export function turnFromView(view: TurnView, now = Date.now()): TurnModel {
  let turn = emptyTurn(view.id, view.message, true);
  for (const event of view.events) turn = applyEvent(turn, event, { now, replay: true });
  return {
    ...turn,
    state: view.state,
    live: view.live,
    footer: view.footer ?? turn.footer,
    canRetry: view.canRetry,
    canEdit: view.canEdit,
    lastEventId: view.lastEventId || turn.lastEventId,
    answerText: view.answerText || turn.answerText,
    status: view.live ? turn.status : null,
    workingSince: workingSinceOf(view, turn.workingSince, now),
  };
}

/**
 * The status timer's start after a reload: the platform's own record of when this working
 * stretch began (so time spent waiting on a form doesn't count), else what the replayed events
 * said; never while the turn waits or is over.
 */
function workingSinceOf(view: TurnView, replayed: number | null, now: number): number | null {
  if (view.state !== "working") return null;
  const since = view.workingSince ? Date.parse(view.workingSince) : Number.NaN;
  return Number.isFinite(since) ? Math.min(since, now) : replayed;
}

function setStep(parts: TurnPart[], step: StepPart): TurnPart[] {
  const index = parts.findIndex((part) => part.kind === "step" && part.stepId === step.stepId);
  if (index === -1) return [...parts, step];
  const next = parts.slice();
  next[index] = step;
  return next;
}

function addText(parts: TurnPart[], delta: string, seq: string): TurnPart[] {
  const last = parts[parts.length - 1];
  if (last?.kind === "text") {
    const next = parts.slice();
    next[next.length - 1] = { ...last, text: last.text + delta };
    return next;
  }
  return [...parts, { kind: "text", key: `text-${seq}`, text: delta }];
}

export interface ApplyOptions {
  /** The time the event was seen, for the status line's timer. */
  now?: number;
  /** Saved events being replayed (no live timer changes from their arrival time). */
  replay?: boolean;
}

/** Applies one event; unknown types change nothing (the API may add types). */
export function applyEvent(
  turn: TurnModel,
  event: WireEvent,
  options: ApplyOptions = {},
): TurnModel {
  const now = options.now ?? Date.now();
  const data = event.data ?? {};
  const base: TurnModel = { ...turn, lastEventId: event.id || turn.lastEventId, accepted: true };
  const seq = event.id.split(":").pop() ?? String(turn.parts.length);
  switch (event.type) {
    case "turn.started": {
      const started = Date.parse(str(data.startedAt));
      return {
        ...base,
        state: "working",
        live: true,
        deepResearch: data.deepResearch === true,
        workingSince: Number.isFinite(started) ? Math.min(started, now) : now,
        status: base.status ?? { kind: "thinking", label: "Thinking" },
      };
    }
    case "status": {
      const kind = str(data.kind, "thinking") as StatusKind;
      return { ...base, status: { kind, label: str(data.label, "Thinking") } };
    }
    case "text": {
      const delta = str(data.delta);
      if (delta === "") return base;
      return {
        ...base,
        parts: addText(base.parts, delta, seq),
        answerText: base.answerText + delta,
        status:
          base.status && base.status.kind !== "stopping"
            ? { kind: "writing", label: "Writing" }
            : base.status,
      };
    }
    case "step.started": {
      const step: StepPart = {
        kind: "step",
        key: `step-${str(data.stepId)}`,
        stepId: str(data.stepId),
        capability: str(data.capability),
        label: str(data.label),
        target: str(data.target),
        state: "running",
        reason: null,
        result: null,
        resultTruncated: false,
        durationMs: null,
      };
      return {
        ...base,
        parts: setStep(base.parts, step),
        status: { kind: "step", label: step.label },
      };
    }
    case "step.finished": {
      const stepId = str(data.stepId);
      const existing = base.parts.find(
        (part): part is StepPart => part.kind === "step" && part.stepId === stepId,
      );
      const step: StepPart = {
        kind: "step",
        key: existing?.key ?? `step-${stepId}`,
        stepId,
        capability: existing?.capability ?? "",
        label: str(data.label, existing?.label ?? ""),
        target: str(data.target, existing?.target ?? ""),
        state: str(data.state, "succeeded") as StepState,
        reason: typeof data.reason === "string" ? data.reason : null,
        result: typeof data.result === "string" ? data.result : null,
        resultTruncated: data.resultTruncated === true,
        durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
      };
      return { ...base, parts: setStep(base.parts, step) };
    }
    case "permission.needed": {
      const card: PermissionCard = {
        stepId: str(data.stepId),
        policy: str(data.policy),
        policyLabel: str(data.policyLabel),
        production: data.production === true,
        canAllow: data.canAllow === true && data.production !== true,
        message: str(data.message),
        settingsPath: str(data.settingsPath, "/dashboard/settings/agent-policies"),
        allowed: false,
      };
      return {
        ...base,
        permissions: [...base.permissions.filter((item) => item.stepId !== card.stepId), card],
      };
    }
    case "form.requested": {
      const formId = str(data.formId);
      const form = data.form as FormRequest | undefined;
      if (!form || base.parts.some((part) => part.kind === "form" && part.formId === formId)) {
        return base;
      }
      return {
        ...base,
        parts: [
          ...base.parts,
          { kind: "form", key: `form-${formId}`, formId, form, answered: null },
        ],
      };
    }
    case "waiting": {
      const working = base.workingSince;
      return {
        ...base,
        state: "waiting",
        status: { kind: "waiting", label: str(data.label, "Waiting for you") },
        workingSince: options.replay ? working : null,
      };
    }
    case "form.answered": {
      const formId = str(data.formId);
      const answered = {
        outcome: str(data.outcome),
        label: str(data.label),
        asMessage: data.asMessage === true,
      };
      return {
        ...base,
        state: "working",
        workingSince: options.replay ? base.workingSince : now,
        parts: base.parts.map((part) =>
          part.kind === "form" && part.formId === formId ? { ...part, answered } : part,
        ),
      };
    }
    case "notice":
      return {
        ...base,
        parts: [...base.parts, { kind: "notice", key: `notice-${seq}`, text: str(data.text) }],
      };
    case "error":
      return {
        ...base,
        parts: [
          ...base.parts,
          {
            kind: "error",
            key: `error-${seq}`,
            code: str(data.code, "internal") as AgentErrorCode,
            message: str(data.message),
          },
        ],
      };
    case "turn.replaced":
      return { ...base, replacedBy: str(data.turnId) || null };
    case "turn.finished": {
      const state = str(data.state, "finished") as TurnState;
      return {
        ...base,
        state,
        live: false,
        status: null,
        workingSince: null,
        footer: str(data.footer) || base.footer,
        canRetry: data.canRetry === true,
        canEdit: true,
        // Rows still spinning end as stopped (the platform sends that too; this covers a gap).
        parts: base.parts.map((part) =>
          part.kind === "step" && part.state === "running"
            ? { ...part, state: "stopped" as const }
            : part,
        ),
      };
    }
    case "suggestions": {
      const items = Array.isArray(data.items)
        ? data.items.filter((item): item is string => typeof item === "string").slice(0, 3)
        : [];
      return { ...base, suggestions: items };
    }
    case "end":
      return { ...base, live: false, status: base.state === "working" ? null : base.status };
    default:
      return turn;
  }
}

// ---- What the chat shows for a turn

export function isWorking(turn: TurnModel): boolean {
  return turn.live && (turn.state === "working" || turn.state === "waiting");
}

/** Retry: only on the last turn, and only when it failed or was stopped (spec 19.4). */
export function retryVisible(turn: TurnModel, isLast: boolean, mine: boolean): boolean {
  if (!isLast || !mine || isWorking(turn) || turn.sendError) return false;
  return turn.canRetry || turn.state === "failed" || turn.state === "stopped";
}

/** Edit: only on the last finished question (spec 19.4). */
export function editVisible(turn: TurnModel, isLast: boolean, mine: boolean): boolean {
  if (!isLast || !mine || isWorking(turn)) return false;
  return turn.accepted && (turn.canEdit || turn.state === "finished" || turn.sendError !== null);
}

/** Suggestions show only after a normal answer (not an error, stop, form or key prompt). */
export function suggestionsVisible(turn: TurnModel, isLast: boolean): boolean {
  if (!isLast || isWorking(turn) || turn.state !== "finished") return false;
  if (turn.parts.some((part) => part.kind === "error" || part.kind === "form")) return false;
  return turn.suggestions.length > 0;
}

/** The answer's words for Copy, with ids removed like everything shown. */
export function copyTextOf(turn: TurnModel): string {
  const text =
    turn.answerText ||
    turn.parts
      .filter((part) => part.kind === "text")
      .map((part) => (part as { text: string }).text)
      .join("\n\n");
  return stripInternalIds(text).trim();
}

/** The status line's words: "Thinking", the running step, "Writing", "Stopping", or a wait. */
export function statusLabel(turn: TurnModel): string | null {
  if (!isWorking(turn) && turn.accepted) return null;
  return turn.status?.label ?? "Thinking";
}

/** "12s" once the first second has passed, else null (spec 19.4). */
export function elapsedLabel(since: number | null, now: number): string | null {
  if (since === null) return null;
  const seconds = Math.floor((now - since) / 1000);
  if (seconds < 1) return null;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The number of steps and failed steps, for a turn that is still running. */
export function stepCounts(turn: TurnModel): { steps: number; failed: number } {
  let steps = 0;
  let failed = 0;
  for (const part of turn.parts) {
    if (part.kind !== "step") continue;
    steps += 1;
    if (part.state === "failed") failed += 1;
  }
  return { steps, failed };
}
