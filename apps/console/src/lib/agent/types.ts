import type {
  AgentErrorCode,
  AttachmentKind,
  FormRequest,
  StatusKind,
  StepState,
  TurnState,
} from "@nearzero/shared/browser";

/**
 * The Agent API's shapes as the console reads them (docs/api/agent.md). Browser-safe: types only.
 */

export interface HomeView {
  enabled: boolean;
  greeting: { name: string; askName: boolean; secondLine: string; fixed: string | null };
  starters: { label: string; text: string; send: boolean }[];
  research: { keySaved: boolean; canAddKey: boolean; whoCanAdd: string };
  model: { keySaved: boolean; keyUsable: boolean };
  limits: {
    filesPerMessage: number;
    totalBytes: number;
    perKind: Record<AttachmentKind, number>;
    quoteChars: number;
    messageChars: number;
    concurrentUploads: number;
  };
  can: { allowPolicies: boolean };
}

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

export interface SessionList {
  sessions: SessionView[];
  shared: SessionView[];
  limit: number;
}

export interface FileView {
  id: string;
  name: string;
  kind: AttachmentKind;
  contentType: string;
  sizeBytes: number;
  sent: boolean;
  notice: string | null;
  url: string;
}

export interface PersonMessage {
  id: string;
  text: string;
  quote: string | null;
  files: FileView[];
  author: { id: string; name: string } | null;
  createdAt: string;
}

/** One saved or streamed event: `id` is "<turn id>:<seq>". */
export interface WireEvent {
  id: string;
  seq?: number;
  type: string;
  data: Record<string, unknown>;
}

export interface TurnView {
  id: string;
  state: TurnState;
  message: PersonMessage;
  events: WireEvent[];
  answerText: string;
  footer: string | null;
  canRetry: boolean;
  canEdit: boolean;
  live: boolean;
  lastEventId: string;
  /** When the current working stretch began (after a form answer, that answer); ISO time. */
  workingSince?: string | null;
}

export interface SessionDetail {
  session: SessionView;
  turns: TurnView[];
  more: boolean;
}

export interface SentMessage {
  session: SessionView;
  message: PersonMessage;
  turn: { id: string; lastEventId: string };
}

// ---- The console's own model of a turn, built from its events

export interface TextPart {
  kind: "text";
  key: string;
  text: string;
}

export interface StepPart {
  kind: "step";
  key: string;
  stepId: string;
  capability: string;
  label: string;
  target: string;
  state: "running" | StepState;
  reason: string | null;
  result: string | null;
  resultTruncated: boolean;
  durationMs: number | null;
}

export interface FormPart {
  kind: "form";
  key: string;
  formId: string;
  form: FormRequest;
  answered: { outcome: string; label: string; asMessage: boolean } | null;
}

export interface NoticePart {
  kind: "notice";
  key: string;
  text: string;
}

export interface ErrorPart {
  kind: "error";
  key: string;
  code: AgentErrorCode | string;
  message: string;
}

export type TurnPart = TextPart | StepPart | FormPart | NoticePart | ErrorPart;

export interface PermissionCard {
  stepId: string;
  policy: string;
  policyLabel: string;
  production: boolean;
  canAllow: boolean;
  message: string;
  settingsPath: string;
  /** Set once "Allow and continue" went through on this page. */
  allowed: boolean;
}

export interface TurnModel {
  id: string;
  /** False until the platform accepted the message (the turn shows "Thinking" at once). */
  accepted: boolean;
  state: TurnState;
  message: PersonMessage;
  parts: TurnPart[];
  status: { kind: StatusKind; label: string } | null;
  permissions: PermissionCard[];
  footer: string | null;
  canRetry: boolean;
  /** From the platform's view; the page also requires the turn to be the last one. */
  canEdit: boolean;
  suggestions: string[];
  answerText: string;
  lastEventId: string;
  live: boolean;
  /** When the current working stretch started (ms since epoch), for the status line's timer. */
  workingSince: number | null;
  /** This turn was the "add a key" reply and another turn answers the same question. */
  replacedBy: string | null;
  deepResearch: boolean;
  /** A send that the platform refused: the reason, shown in red. */
  sendError: string | null;
}
