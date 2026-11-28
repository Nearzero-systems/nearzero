/**
 * The Agent's words, limits, event shapes and pure helpers (spec 19, 20), shared by the control
 * plane and the console. Browser-safe: it imports only the browser-safe byte formatter, so the
 * chat can use the same rules (ids stripped from text, provisional titles, attachment checks,
 * the turn footer).
 */

import { formatBytes } from "./bytes.ts";

// ---- Limits (spec 19.3–19.6, 19.10, 20.13)

export const AGENT_LIMITS = {
  sessionsListed: 50,
  sessionTitleMax: 80,
  provisionalTitleWords: 8,
  provisionalTitleMax: 72,
  messageMax: 20_000,
  quoteMax: 1_200,
  filesPerMessage: 10,
  concurrentUploads: 3,
  defaultTotalAttachmentMegabytes: 25,
  stepLimit: 30,
  deepResearchStepLimit: 60,
  deploysPerServicePerRequest: 6,
  toolResultMax: 12_000,
  stepResultMax: 6_000,
  failedReasonMax: 280,
  suggestionsMax: 3,
  suggestionWordsMax: 9,
  titleTimeoutMs: 6_000,
  providerSilenceMs: 120_000,
  turnsPerPage: 30,
} as const;

export const ATTACHMENT_KINDS = ["image", "pdf", "docx", "text", "video"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Megabytes as bytes, in binary steps like every size the console shows. */
const megabytes = (count: number): number => count * 2 ** 20;

/** The largest file of each kind, in megabytes (spec 19.10). */
const KIND_MEGABYTES: readonly (readonly [AttachmentKind, number])[] = [
  ["image", 10],
  ["pdf", 20],
  ["docx", 15],
  ["text", 10],
  ["video", 25],
];

/** The largest file of each kind, in bytes. */
export const ATTACHMENT_KIND_MAX_BYTES = Object.fromEntries(
  KIND_MEGABYTES.map(([kind, size]) => [kind, megabytes(size)]),
) as Record<AttachmentKind, number>;

/** What goes to the model with a message (spec 19.10). */
export const MODEL_INPUT_LIMITS = {
  imageMaxBytes: megabytes(5),
  imagesPerRequest: 8,
  imagesTotalBytes: megabytes(16),
  inlineCharsPerFile: 20_000,
  inlineCharsPerMessage: 60_000,
  videoMaxBytes: megabytes(20),
  readDefaultChars: 6_000,
  readMinChars: 200,
  readMaxChars: 8_000,
  searchMaxLines: 40,
} as const;

// ---- Words (spec 19)

export const AGENT_MESSAGES = {
  disclaimer: "AI answers can be wrong. Check important changes before you rely on them.",
  placeholder: "Ask Agent to deploy, check logs, or set up a server…",
  placeholderWithQuote: "Ask about the quoted text…",
  sendHint: "Enter to send · Shift+Enter for a new line",
  untitled: "Untitled session",
  noSessions: "No sessions yet. Start one above.",
  busy: "The Agent is still working on the last message in this chat. Wait for it to finish, then send this again.",
  disabled: "Nearzero Agent is disabled.",
  secretInput: "Secret input cannot be submitted through Agent chat.",
  renameEmpty: "Enter a name for the session.",
  renameTooLong: "Session names can be up to 80 characters.",
  sessionsChanged: "The sessions changed while you were moving them. Try again.",
  stopToDelete: "Stop this session to delete it.",
  stillWorking: "This session is still working. Stop it, then delete it.",
  stepLimit:
    "I reached the maximum number of tool steps for this request. Ask me to continue and I'll pick up from here.",
  emptyResponse: "Nearzero Agent received an empty model response. Send your message again.",
  emptyAfterSteps:
    "I ran the steps above, but the model gave no summary. Each step's result is in its row.",
  formUnanswered: "The form was left unanswered.",
  fileElsewhere: "This file was already sent in another chat. Attach it again here.",
  messageEmpty: "Type a message or attach a file.",
  messageTooLong: "Messages can be up to 20,000 characters.",
  quoteTooLong: "Quotes can be up to 1,200 characters.",
  tooManyFiles: "Attach up to 10 files per message.",
  productionCard: "Production changes are turned on in Agent policies, with a typed confirmation.",
  membersCard:
    "Owners and admins decide what the Agent may do. Ask one to allow it in Settings → Agent policies.",
  providerSilent:
    "The model sent nothing for 120 seconds, so the request was stopped. Send your message again.",
  providerUnavailable:
    "The model provider couldn't be reached or had a problem. Wait a moment, then send your message again.",
  rateLimited:
    "The model provider is limiting requests right now. Wait a minute, then send your message again.",
  keyRejectedPrefix: "OpenRouter rejected the saved API key.",
  outOfCredits:
    "Your organization's OpenRouter account is out of credits. Add credits at openrouter.ai, then send your message again.",
  waitingForAdminKey: "Waiting for admin to configure OpenRouter",
  waitingForKey: "Waiting for the OpenRouter key",
  noKeyAdmin:
    "Hi, I'm Nearzero Agent. To answer, I need your organization's OpenRouter API key. Add your organization's OpenRouter API key below; it is stored encrypted and used only for this workspace.",
  noKeyAdminSettings:
    "Hi, I'm Nearzero Agent. To answer, I need your organization's OpenRouter API key. Add it in Settings → API keys, and I'll answer this message as soon as it's saved.",
  noKeyMember:
    "Hi, I'm Nearzero Agent. This workspace doesn't have an OpenRouter API key yet, so I can't answer. Ask an owner or admin to add one in Settings → API keys; I'll answer this message as soon as they do.",
  researchNoKey:
    "Ask an owner or admin to add a Firecrawl key in Settings → API keys to turn on Deep research.",
} as const;

export const GREETING_SECOND_LINES = [
  "What should we deploy today?",
  "What are we shipping?",
  "How can I help?",
  "What should we work on?",
] as const;

export const AGENT_STARTERS = [
  { label: "Deploy a Git repository", text: "Deploy a Git repository", send: true },
  {
    label: "Which of my servers are ready for deployments?",
    text: "Which of my servers are ready for deployments?",
    send: true,
  },
  {
    label: "Why did my last deployment fail?",
    text: "Why did my last deployment fail?",
    send: true,
  },
  { label: "Set up a server", text: "Set up the server ", send: false },
] as const;

/** Line 1 of the home greeting, from the browser's own clock (spec 19.2). */
export function greetingFirstLine(hour: number, name: string, variant = 0): string {
  if (variant % 4 === 3) return `Hi ${name},`;
  if (hour >= 5 && hour < 12) return `Good morning, ${name}`;
  if (hour >= 12 && hour < 18) return `Good afternoon, ${name}`;
  return `Good evening, ${name}`;
}

// ---- Events (docs/api/agent.md)

export type StepState = "succeeded" | "failed" | "stopped" | "needs_permission";
export type TurnState = "working" | "waiting" | "finished" | "stopped" | "failed";
export type StatusKind = "thinking" | "writing" | "step" | "stopping" | "waiting";
export type AgentErrorCode =
  | "agent_disabled"
  | "no_model_key"
  | "model_key_rejected"
  | "out_of_credits"
  | "rate_limited"
  | "provider_unavailable"
  | "provider_silent"
  | "empty_response"
  | "step_limit"
  | "internal";

export type PickerPurpose =
  | "provider"
  /** The card that gives Nearzero access to a repository it can't read (always buttons). */
  | "access"
  | "repository"
  | "branch"
  | "project"
  | "server"
  | "how_to_run"
  | "service";

export type FormRequest =
  | {
      kind: "variables";
      service: { id: string; name: string };
      reason: string;
      names: string[];
      saveTo: string;
      deployLabel: string;
      skipLabel: string;
      hint: string;
    }
  | { kind: "ssh_key"; suggestedName: string; reason: string }
  | {
      kind: "task_script";
      mode: "create" | "replace";
      summary: {
        task: string;
        where: string;
        schedule: string;
        timeZone: string;
        nextRun: string | null;
        shell: string;
      };
      placeholder: string;
      saveTo: string;
      /** For a new task: the fields the console posts with the script (never the script itself). */
      draft: {
        name: string;
        description: string;
        cron: string;
        timeZone: string;
        shell: "bash" | "sh";
        place: "container" | "server" | "host";
        serviceId: string | null;
        innerService: string | null;
        serverId: string | null;
      } | null;
    }
  | { kind: "model_key"; placeholder: string; canSave: boolean; settingsPath: string }
  | { kind: "research_key"; canSave: boolean; whoCanAdd: string }
  | { kind: "project_name"; label: string; suggestion: string | null }
  | {
      kind: "picker";
      purpose: PickerPurpose;
      title: string;
      /**
       * `href`: a link instead of an answer (the Git import's Connect buttons, which go to Git
       * provider settings and come back to the same chat).
       */
      options: {
        value: string;
        label: string;
        description?: string;
        icon?: string;
        href?: string;
      }[];
      searchable: boolean;
    }
  | {
      kind: "project_delete";
      project: { id: string; name: string };
      summary: string;
      services: { line: string }[];
      confirmLabel: string;
      confirmHint: string;
      keepLabel: string;
    };

export type FormKind = FormRequest["kind"];

export interface AgentEventMap {
  "turn.started": {
    turnId: string;
    sessionId: string;
    messageId: string;
    deepResearch: boolean;
    startedAt: string;
  };
  status: { kind: StatusKind; label: string };
  text: { delta: string };
  "step.started": {
    stepId: string;
    capability: string;
    label: string;
    target: string;
    startedAt: string;
  };
  "step.finished": {
    stepId: string;
    state: StepState;
    label: string;
    target: string;
    reason: string | null;
    result: string | null;
    resultTruncated: boolean;
    durationMs: number;
  };
  "permission.needed": {
    stepId: string;
    policy: string;
    policyLabel: string;
    production: boolean;
    canAllow: boolean;
    message: string;
    settingsPath: string;
  };
  "form.requested": { formId: string; form: FormRequest };
  waiting: { formId: string | null; label: string };
  "form.answered": { formId: string; outcome: string; label: string; asMessage: boolean };
  notice: { text: string };
  error: { code: AgentErrorCode; message: string };
  "session.titled": { title: string };
  "turn.replaced": { turnId: string };
  "turn.finished": {
    state: "finished" | "stopped" | "failed";
    stoppedBy: "person" | "restart" | null;
    workedMs: number;
    steps: number;
    failedSteps: number;
    footer: string;
    canRetry: boolean;
    finishedAt: string;
  };
  suggestions: { items: string[] };
}

export type AgentEventType = keyof AgentEventMap;

export type AgentEvent = {
  [K in AgentEventType]: { id: string; seq: number; type: K; data: AgentEventMap[K] };
}[AgentEventType];

// ---- Ids out of displayed text (spec 19.4, 19.11)

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ID_GROUP = new RegExp(
  `\\s*[([]\\s*(?:(?:id|ID|Id|ref|reference)\\s*[:=]?\\s*)?\`?${UUID}\`?\\s*[)\\]]`,
  "gi",
);
const LABELLED_ID = new RegExp(
  `[,;]?\\s*\\b(?:id|ID|Id|ref|reference)\\s*[:=]\\s*\`?${UUID}\`?`,
  "gi",
);
const CODE_ID = new RegExp(`\`${UUID}\``, "gi");
const BARE_ID = new RegExp(`\\b${UUID}\\b`, "gi");

/**
 * Removes internal ids from text the console shows: "web (id: 3f…)" becomes "web", a lone id in
 * backticks or plain text disappears. Everything else, Markdown included, is left as it was.
 */
export function stripInternalIds(text: string): string {
  if (!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(text)) return text;
  return text
    .replace(ID_GROUP, "")
    .replace(LABELLED_ID, "")
    .replace(CODE_ID, "")
    .replace(BARE_ID, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ +([,.;:!?])/g, "$1");
}

// ---- Session titles (spec 19.5)

/** The title used until the generated one arrives: the first 8 words, at most 72 characters. */
export function provisionalTitle(text: string, fileNames: readonly string[] = []): string | null {
  const words = text
    .replace(/^>.*$/gm, " ")
    .replace(/["“”'‘’`]/g, "")
    .split(/\s+/)
    .filter((word) => word !== "");
  if (words.length === 0) {
    const first = fileNames[0]?.trim();
    return first ? first.slice(0, AGENT_LIMITS.provisionalTitleMax) : null;
  }
  let title = words.slice(0, AGENT_LIMITS.provisionalTitleWords).join(" ");
  if (title.length > AGENT_LIMITS.provisionalTitleMax) {
    title = title.slice(0, AGENT_LIMITS.provisionalTitleMax).replace(/\s+\S*$/, "") || title;
    title = title.slice(0, AGENT_LIMITS.provisionalTitleMax);
  }
  return title;
}

/** A person's name for a session: one line, 1 to 80 characters. */
export function sessionTitleProblem(title: string): string | null {
  const clean = title.trim();
  if (clean === "") return AGENT_MESSAGES.renameEmpty;
  if (clean.length > AGENT_LIMITS.sessionTitleMax) return AGENT_MESSAGES.renameTooLong;
  return null;
}

/** Cleans a generated title: 2 to 5 words, sentence case, no quotes or final period. */
export function cleanGeneratedTitle(raw: string): string | null {
  const line =
    raw
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part !== "") ?? "";
  const text = line
    .replace(/^title\s*:\s*/i, "")
    .replace(/["“”`*_#]/g, "")
    .replace(/[.!?]+$/, "")
    .trim();
  const words = text.split(/\s+/).filter((word) => word !== "");
  if (words.length === 0 || words.length > 5) return null;
  if (words.length === 1 && words[0]?.toLowerCase() !== "greeting") return null;
  const joined = words.join(" ").slice(0, AGENT_LIMITS.sessionTitleMax);
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

// ---- The turn footer (spec 19.4)

export function formatWorked(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
}

export function turnFooter(input: {
  state: "finished" | "stopped" | "failed";
  stoppedBy: "person" | "restart" | null;
  workedMs: number;
  steps: number;
  failedSteps: number;
}): string {
  if (input.state === "stopped") {
    return input.stoppedBy === "restart"
      ? "Stopped (Nearzero restarted)"
      : `Stopped after ${formatWorked(input.workedMs)}`;
  }
  const parts = [`Worked for ${formatWorked(input.workedMs)}`];
  if (input.steps > 0) parts.push(`${input.steps} ${input.steps === 1 ? "step" : "steps"}`);
  if (input.failedSteps > 0) parts.push(`${input.failedSteps} failed`);
  return parts.join(" · ");
}

// ---- Attachments (spec 19.10)

export type AttachmentCheck =
  | { ok: true; kind: AttachmentKind; contentType: string }
  | { ok: false; reason: string };

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};
const VIDEO_TYPES: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};
const TEXT_EXTENSIONS = new Set(
  (
    "txt md markdown mdx rst log csv tsv json jsonc json5 yaml yml toml ini cfg conf env.example xml html htm css scss sass less " +
    "js mjs cjs jsx ts mts cts tsx vue svelte astro py rb php go rs java kt kts scala swift c h cc cpp hpp cs fs " +
    "sh bash zsh fish ps1 bat sql graphql gql proto lua pl r dart ex exs erl hs clj elm nim zig tf hcl " +
    "dockerfile containerfile makefile gradle properties lock gitignore dockerignore editorconfig prisma " +
    // Logs, diffs and other text 0.1.x read as text (31d G4-09), and *.example, *.sample, *.template.
    "text jsonl ndjson out err diff patch svg config nvmrc example sample template"
  ).split(" "),
);
const TEXT_NAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "procfile",
  "gemfile",
  "rakefile",
  "jenkinsfile",
  "caddyfile",
  "license",
  "readme",
  "changelog",
]);
const SPREADSHEETS_AND_DECKS = new Set([
  "xls",
  "xlsx",
  "xlsm",
  "ods",
  "numbers",
  "ppt",
  "pptx",
  "odp",
  "key",
]);
const ARCHIVES = new Set([
  "zip",
  "tar",
  "gz",
  "tgz",
  "bz2",
  "tbz",
  "xz",
  "txz",
  "7z",
  "rar",
  "zst",
  "lz",
  "lzma",
  "cab",
  "iso",
  "dmg",
  "jar",
  "war",
]);
const ALLOWED_ENV_SUFFIXES = ["example", "sample", "template", "dist", "defaults"];

function extensionOf(name: string): string {
  const base = name.toLowerCase().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1);
}

/** Env files may hold secrets; example, sample, template, dist and defaults variants are fine. */
export function isRefusedEnvFile(name: string): boolean {
  const base = (name.toLowerCase().split(/[\\/]/).pop() ?? "").trim();
  if (base !== ".env" && !base.startsWith(".env.") && !base.endsWith(".env")) return false;
  const parts = base.split(".").filter((part) => part !== "");
  return !parts.some((part) => ALLOWED_ENV_SUFFIXES.includes(part));
}

/** Which kind an upload is, or why it is refused (spec 19.10). */
export function classifyAttachment(name: string, contentType = ""): AttachmentCheck {
  const base = (name.toLowerCase().split(/[\\/]/).pop() ?? "").trim();
  const ext = extensionOf(base);
  const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (isRefusedEnvFile(base)) {
    return {
      ok: false,
      reason:
        "Env files can hold secrets, so they aren't accepted. Paste the variable names instead, or attach .env.example.",
    };
  }
  if (ext === "heic" || ext === "heif" || ext === "avif" || /image\/(heic|heif|avif)/.test(type)) {
    return {
      ok: false,
      reason: "HEIC and AVIF images aren't accepted. Export it as PNG or JPEG, then attach that.",
    };
  }
  if (ext === "doc") {
    return { ok: false, reason: "Save it as .docx or PDF, then attach that." };
  }
  if (SPREADSHEETS_AND_DECKS.has(ext)) {
    return { ok: false, reason: "Export it as CSV or PDF, then attach that." };
  }
  if (ARCHIVES.has(ext) || /zip|x-tar|gzip|x-7z|rar/.test(type)) {
    return { ok: false, reason: "Archives aren't accepted. Attach the files inside it." };
  }
  const image = IMAGE_TYPES[ext];
  if (image) return { ok: true, kind: "image", contentType: image };
  const video = VIDEO_TYPES[ext];
  if (video) return { ok: true, kind: "video", contentType: video };
  if (ext === "pdf") return { ok: true, kind: "pdf", contentType: "application/pdf" };
  if (ext === "docx") {
    return {
      ok: true,
      kind: "docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };
  }
  // A name without an extension (".nvmrc", "Brewfile") is taken as text here; the control plane
  // then reads its bytes, and anything that isn't text is refused (isTextContent, G4-09).
  if (
    TEXT_EXTENSIONS.has(ext) ||
    TEXT_NAMES.has(base) ||
    /(^|\.)env\./.test(base) ||
    ext === "" ||
    type.startsWith("text/")
  ) {
    return { ok: true, kind: "text", contentType: "text/plain; charset=utf-8" };
  }
  return {
    ok: false,
    reason:
      "This kind of file isn't accepted. Attach images (PNG, JPEG, WebP, GIF), PDF, Word (.docx), text or code files, or videos (MP4, WebM, MOV).",
  };
}

/**
 * Whether a file taken as text really holds text (31d G4-09): UTF-8 with no NUL byte, so a binary
 * renamed .txt, or an extensionless program, is refused.
 */
export function isTextContent(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export const NOT_TEXT_CONTENT =
  "This file's contents aren't text, so it isn't accepted as a text file. Attach a text or code file, or images (PNG, JPEG, WebP, GIF), PDF, Word (.docx) or videos (MP4, WebM, MOV).";

/** Attachment limits and sizes in MB, with the shared byte formatter ("10 MB", "12.4 MB"). */
const formatMegabytes = (bytes: number) => formatBytes(bytes, { largest: "MB", trimZeros: true });

/** A size problem for one file of a kind, or null. */
export function attachmentSizeProblem(kind: AttachmentKind, sizeBytes: number): string | null {
  if (sizeBytes <= 0) return "This file is empty.";
  const max = ATTACHMENT_KIND_MAX_BYTES[kind];
  if (sizeBytes > max) {
    const label = {
      image: "Images",
      pdf: "PDFs",
      docx: "Word documents",
      text: "Text files",
      video: "Videos",
    }[kind];
    return `${label} can be up to ${formatMegabytes(max)}. This one is ${formatMegabytes(sizeBytes)}.`;
  }
  return null;
}

export function attachmentTotalProblem(totalBytes: number, capBytes: number): string | null {
  return totalBytes > capBytes
    ? `Attachments can be up to ${formatMegabytes(capBytes)} together per message.`
    : null;
}

// ---- Follow-up suggestions (spec 19.4)

const IMPOSSIBLE =
  /\b(firewall|security group|ufw|iptables|log ?in to|login to|ssh (in)?to|reboot|power ?cycle|authori[sz]ed[_ ]keys|run (a |any )?command on|shell on the server|billing|invoice)\b/i;
const ID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-/i;

/**
 * Keeps up to three suggestions: in the person's own words, at most 9 words, no ids, nothing the
 * Agent can't do, no duplicates.
 */
export function filterSuggestions(items: readonly string[]): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    const text = raw
      .replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "")
      .replace(/^["“'`]+|["”'`]+$/g, "")
      .trim();
    if (text === "") continue;
    const words = text.split(/\s+/);
    if (words.length > AGENT_LIMITS.suggestionWordsMax) continue;
    if (IMPOSSIBLE.test(text) || ID_LIKE.test(text)) continue;
    if (/^(would you|do you want|shall i|should i|i can|i'll|let me)\b/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
    if (kept.length === AGENT_LIMITS.suggestionsMax) break;
  }
  return kept;
}
