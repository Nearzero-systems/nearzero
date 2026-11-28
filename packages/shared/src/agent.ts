import { z } from "zod";
import { AGENT_LIMITS, AGENT_MESSAGES } from "./agent-rules.ts";

/**
 * Request schemas of the Agent API (docs/api/agent.md). The words come from agent-rules.ts so
 * the console's own checks say the same thing.
 */

const id = z.string().regex(/^[0-9a-f-]{36}$/, "That id isn't valid.");

export const sendAgentMessageRequestSchema = z.object({
  text: z.string().max(AGENT_LIMITS.messageMax, AGENT_MESSAGES.messageTooLong).default(""),
  quote: z
    .string()
    .max(AGENT_LIMITS.quoteMax, AGENT_MESSAGES.quoteTooLong)
    .nullish()
    .transform((value) => (value?.trim() ? value : null)),
  fileIds: z.array(id).max(AGENT_LIMITS.filesPerMessage, AGENT_MESSAGES.tooManyFiles).default([]),
  deepResearch: z.boolean().default(false),
  retryOf: id.nullish().transform((value) => value ?? null),
});
export type SendAgentMessageRequest = z.output<typeof sendAgentMessageRequestSchema>;

export const renameAgentSessionRequestSchema = z.object({
  title: z
    .string({ error: AGENT_MESSAGES.renameEmpty })
    .transform((value) => value.replace(/\s+/g, " ").trim())
    .pipe(
      z
        .string()
        .min(1, AGENT_MESSAGES.renameEmpty)
        .max(AGENT_LIMITS.sessionTitleMax, AGENT_MESSAGES.renameTooLong),
    ),
});

export const shareAgentSessionRequestSchema = z.object({ shared: z.boolean() });

export const reorderAgentSessionsRequestSchema = z.object({
  seen: z
    .array(z.object({ id, position: z.number().int() }))
    .min(1)
    .max(AGENT_LIMITS.sessionsListed),
  order: z.array(id).min(1).max(AGENT_LIMITS.sessionsListed),
});

export const allowAgentPolicyRequestSchema = z.object({ policy: z.string().min(1).max(80) });

/** A form answer: the outcome plus the form's own non-secret fields (checked per kind). */
export const agentFormAnswerRequestSchema = z
  .object({
    outcome: z.string().min(1).max(40),
    names: z.array(z.string().max(256)).max(500).optional(),
    keyId: id.optional(),
    taskId: id.optional(),
    name: z.string().max(200).optional(),
    option: z.string().max(500).optional(),
    label: z.string().max(300).optional(),
  })
  .passthrough();
export type AgentFormAnswer = z.output<typeof agentFormAnswerRequestSchema>;
