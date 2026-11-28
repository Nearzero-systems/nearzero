import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { AGENT_LIMITS } from "@nearzero/shared";
import type { ControlServices, HttpFetch } from "../services.ts";
import { defaultPublicReader, type PublicRepositoryReader } from "./flows/public-repo.ts";
import type { ModelInputs, ModelProvider } from "./provider/provider.ts";

/**
 * How the provider reads a PDF sent with a message (31d G4-10): OpenRouter's free text parser,
 * its paid OCR, or the model's own reading. Without a choice, the model's own reading when it
 * has one, else the free parser, so no PDF is ever billed through the paid OCR by default.
 */
export const PDF_ENGINES = ["pdf-text", "mistral-ocr", "native"] as const;
export type PdfEngine = (typeof PDF_ENGINES)[number];

/**
 * The Agent's settings for one control-plane process (spec 19.6, 19.10, 19.11): the install's
 * choices (kill switch, models, the operator's prompt text and greeting, the attachment cap)
 * read from the environment, plus what tests replace (the model provider, outbound calls, the
 * timers). main.ts calls {@link configureAgent} at start; everything else reads
 * {@link agentSettings}.
 */

export interface AgentSettings {
  disabled: boolean;
  model: string;
  smallModel: string;
  providerUrl: string;
  researchUrl: string;
  /** The operator's text, appended after the built-in rules (never replacing them). */
  promptAppend: string | null;
  greeting: string | null;
  attachmentsMaxBytes: number;
  /** The operator's PDF parser (NEARZERO_AGENT_PDF_ENGINE), or null for the default above. */
  pdfEngine: PdfEngine | null;
  /**
   * What the chat model takes besides text when the provider's model listing can't say
   * (NEARZERO_AGENT_MODEL_INPUTS), or null for text only (30d R4-09).
   */
  modelInputsFallback: ModelInputs | null;
  /**
   * Sent to the provider as HTTP-Referer and X-Title, so usage shows as this install in the
   * workspace's OpenRouter activity: the console's address and "Nearzero" unless the operator set
   * OPENROUTER_HTTP_REFERER or OPENROUTER_X_TITLE (30d R4-09).
   */
  providerReferer: string | null;
  providerTitle: string;
  /** Outbound calls for the model and research providers. */
  fetch: HttpFetch;
  /** Replaces the OpenRouter provider (tests). */
  provider: ModelProvider | null;
  /** No data from the provider for this long aborts the request (spec 19.6). */
  providerSilenceMs: number;
  /** Waits between provider retries: 1 s then 3 s, retry-after up to 10 s. */
  retryDelaysMs: readonly number[];
  retryAfterMaxMs: number;
  titleTimeoutMs: number;
  heartbeatMs: number;
  /** A working turn whose heartbeat is older than this belongs to a process that is gone. */
  staleAfterMs: number;
  /** How often waiting turns, stale turns and stop requests from other processes are checked. */
  sweepMs: number;
  /** How a follower of a turn run by another process looks for new events. */
  followPollMs: number;
  /** How often a working turn checks for a Stop sent to another process. */
  stopPollMs: number;
  /** Who this process is, for turns it carries out. */
  owner: string;
  /** Text deltas are written at most this often, so a long answer isn't thousands of rows. */
  textFlushMs: number;
  /** "Follow the latest deployment" checks this often (spec 20.7). */
  followDeployIntervalMs: number;
  /**
   * Reads public repositories a pasted link names, without any login (30d R4-01): their refs
   * over smart HTTP and their files from a clone without contents. Tests pass their own.
   */
  publicRepositories: PublicRepositoryReader;
  now: () => number;
}

const BOOT_ID = crypto.randomUUID().slice(0, 8);
export const THIS_HOST = hostname();

const flag = (value: string | undefined) => /^(1|true|yes|on)$/i.test(value?.trim() ?? "");
const off = (value: string | undefined) => /^(0|false|no|off)$/i.test(value?.trim() ?? "");

/** The first of the names that is set (1.0's name first, then 0.1.x's), trimmed. */
function firstSet(env: NodeJS.ProcessEnv, ...names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function promptAppendFrom(env: NodeJS.ProcessEnv): string | null {
  const inline = env.NEARZERO_AGENT_PROMPT_APPEND?.trim();
  if (inline) return inline;
  const file = env.NEARZERO_AGENT_PROMPT_FILE?.trim();
  if (file) {
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) return text;
    } catch {
      // An unreadable file adds nothing.
    }
  }
  // 0.1.x's system prompt is the operator's text too: appended, never replacing the rules.
  return env.NEARZERO_AGENT_SYSTEM_PROMPT?.trim() || null;
}

/**
 * 0.1.x Agent settings 1.0 has nothing for (30d R4-09). They are carried in the settings file
 * but change nothing, so the start log names any that are set.
 */
/** "image,file", "images pdfs video": what NEARZERO_AGENT_MODEL_INPUTS says, or null. */
export function modelInputsFrom(value: string | undefined): ModelInputs | null {
  const words = (value ?? "")
    .toLowerCase()
    .split(/[\s,;|]+/)
    .filter(Boolean);
  if (words.length === 0) return null;
  const has = (...names: string[]) => words.some((word) => names.includes(word));
  return {
    images: has("image", "images", "vision"),
    pdfs: has("pdf", "pdfs", "file", "files"),
    video: has("video", "videos"),
  };
}

export const IGNORED_LEGACY_AGENT_SETTINGS = [
  "NEARZERO_AGENT_GREETING_SUBTITLE",
  "NEARZERO_AGENT_ONBOARDING_GREETING_ADMIN",
  "NEARZERO_AGENT_ONBOARDING_GREETING_MEMBER",
  "NEARZERO_AGENT_MAX_TURNS",
  "NEARZERO_AGENT_DEEP_RESEARCH_MAX_TURNS",
  "NEARZERO_AGENT_ATTACHMENTS_PATH",
] as const;

export function ignoredLegacyAgentSettings(env: NodeJS.ProcessEnv = process.env): string[] {
  return IGNORED_LEGACY_AGENT_SETTINGS.filter((name) => env[name]?.trim());
}

/**
 * The install's Agent settings (spec 19.6, 19.10). Where 1.0 has a setting, 0.1.x's name for it
 * is read too, and 1.0's name wins when both are set (30d R4-09):
 * NEARZERO_AGENT_ENABLED=false is the kill switch, OPENROUTER_CHAT_MODEL the model,
 * OPENROUTER_TITLE_MODEL or OPENROUTER_FOLLOWUPS_MODEL the small model, OPENROUTER_BASE_URL the
 * provider's address, NEARZERO_AGENT_GREETING_TITLE the greeting and NEARZERO_AGENT_SYSTEM_PROMPT
 * the operator's text.
 */
export function agentSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<AgentSettings> {
  const megabytes = Number(env.NEARZERO_AGENT_ATTACHMENTS_MAX_MB);
  // 0.1.x's cap in bytes; 1.0's megabytes win when both are set (30d R4-09).
  const legacyBytes = Number(env.NEARZERO_AGENT_ATTACHMENT_MAX_BYTES);
  const pdfEngine = env.NEARZERO_AGENT_PDF_ENGINE?.trim().toLowerCase() ?? "";
  const modelInputs = modelInputsFrom(env.NEARZERO_AGENT_MODEL_INPUTS);
  const referer = env.OPENROUTER_HTTP_REFERER?.trim();
  const title = env.OPENROUTER_X_TITLE?.trim();
  const disabled = env.NEARZERO_AGENT_DISABLED?.trim()
    ? flag(env.NEARZERO_AGENT_DISABLED)
    : off(env.NEARZERO_AGENT_ENABLED);
  const model = firstSet(env, "NEARZERO_AGENT_MODEL", "OPENROUTER_CHAT_MODEL");
  const smallModel = firstSet(
    env,
    "NEARZERO_AGENT_SMALL_MODEL",
    "OPENROUTER_TITLE_MODEL",
    "OPENROUTER_FOLLOWUPS_MODEL",
  );
  const providerUrl = firstSet(env, "NEARZERO_AGENT_PROVIDER_URL", "OPENROUTER_BASE_URL");
  return {
    disabled,
    ...(model ? { model } : {}),
    ...(smallModel ? { smallModel } : {}),
    ...(providerUrl ? { providerUrl: providerUrl.replace(/\/+$/, "") } : {}),
    ...(env.NEARZERO_AGENT_RESEARCH_URL?.trim()
      ? { researchUrl: env.NEARZERO_AGENT_RESEARCH_URL.trim().replace(/\/+$/, "") }
      : {}),
    promptAppend: promptAppendFrom(env),
    // 0.1.x wrote the name as {firstName}; 1.0's greeting says {first name}.
    greeting:
      env.NEARZERO_AGENT_GREETING?.trim() ||
      env.NEARZERO_AGENT_GREETING_TITLE?.trim().replaceAll("{firstName}", "{first name}") ||
      null,
    ...(Number.isFinite(megabytes) && megabytes > 0
      ? { attachmentsMaxBytes: Math.round(megabytes * 1024 * 1024) }
      : Number.isFinite(legacyBytes) && legacyBytes > 0
        ? { attachmentsMaxBytes: Math.round(legacyBytes) }
        : {}),
    ...((PDF_ENGINES as readonly string[]).includes(pdfEngine)
      ? { pdfEngine: pdfEngine as PdfEngine }
      : {}),
    ...(modelInputs ? { modelInputsFallback: modelInputs } : {}),
    ...(referer ? { providerReferer: referer } : {}),
    ...(title ? { providerTitle: title } : {}),
  };
}

function defaults(services: ControlServices): AgentSettings {
  return {
    disabled: false,
    model: "anthropic/claude-sonnet-4.5",
    smallModel: "anthropic/claude-haiku-4.5",
    providerUrl: "https://openrouter.ai/api/v1",
    researchUrl: "https://api.firecrawl.dev",
    promptAppend: null,
    greeting: null,
    attachmentsMaxBytes: AGENT_LIMITS.defaultTotalAttachmentMegabytes * 1024 * 1024,
    pdfEngine: null,
    modelInputsFallback: null,
    providerReferer: null,
    providerTitle: "Nearzero",
    fetch: services.http,
    provider: null,
    providerSilenceMs: AGENT_LIMITS.providerSilenceMs,
    retryDelaysMs: [1_000, 3_000],
    retryAfterMaxMs: 10_000,
    titleTimeoutMs: AGENT_LIMITS.titleTimeoutMs,
    heartbeatMs: 10_000,
    staleAfterMs: 45_000,
    sweepMs: 10_000,
    followPollMs: 500,
    stopPollMs: 1_000,
    owner: `${THIS_HOST}/${BOOT_ID}`,
    textFlushMs: 80,
    followDeployIntervalMs: 3_000,
    publicRepositories: defaultPublicReader(services.http),
    now: () => Date.now(),
  };
}

const known = new WeakMap<ControlServices, AgentSettings>();

export function configureAgent(
  services: ControlServices,
  overrides: Partial<AgentSettings>,
): AgentSettings {
  const next = { ...agentSettings(services), ...overrides };
  known.set(services, next);
  return next;
}

export function agentSettings(services: ControlServices): AgentSettings {
  const found = known.get(services);
  if (found) return found;
  const fresh = defaults(services);
  known.set(services, fresh);
  return fresh;
}
