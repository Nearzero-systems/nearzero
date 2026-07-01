import { z } from "zod";

export const agentWirePayloadSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("assistant_delta"), text: z.string() }),
	z.object({ kind: z.literal("assistant_message"), text: z.string() }),
	z.object({ kind: z.literal("thread_title"), title: z.string() }),
	z.object({
		kind: z.literal("tool_start"),
		toolCallId: z.string(),
		toolName: z.string(),
		detail: z.string().optional(),
		researchQueries: z.array(z.string()).optional(),
	}),
	z.object({
		kind: z.literal("tool_end"),
		toolCallId: z.string(),
		toolName: z.string(),
	}),
	z.object({
		kind: z.literal("tool_result"),
		toolCallId: z.string(),
		toolName: z.string().optional(),
		resultPreview: z.string(),
		isError: z.boolean(),
	}),
	z.object({ kind: z.literal("error"), code: z.string(), message: z.string() }),
	z.object({ kind: z.literal("done"), completed: z.boolean() }),
	z.object({
		kind: z.literal("provider_setup_required"),
		canConfigure: z.boolean(),
		waitingLabel: z.string(),
	}),
	z.object({
		kind: z.literal("user_input_required"),
		field: z.enum([
			"projectName",
			"gitProviderId",
			"gitRepository",
			"gitBranch",
			"serverId",
		]),
		waitingLabel: z.string(),
		prompt: z.string(),
		placeholder: z.string().optional(),
		submitLabel: z.string().optional(),
		inputType: z.enum(["text", "password"]).optional(),
		secret: z.boolean().optional(),
		options: z
			.array(
				z.object({
					label: z.string(),
					value: z.string(),
					description: z.string().optional(),
					action: z.enum(["submit", "connectGitProvider"]).optional(),
					providerType: z
						.enum(["github", "gitlab", "bitbucket", "gitea"])
						.optional(),
					href: z.string().optional(),
				}),
			)
			.optional(),
		context: z.record(z.string(), z.string()).optional(),
	}),
	z.object({
		kind: z.literal("interrupted"),
		recoverable: z.boolean(),
		reason: z.string().optional(),
		lastSeq: z.number().int().optional(),
	}),
]);

export type AgentWirePayload = z.infer<typeof agentWirePayloadSchema>;

export type AgentWireEnvelope = {
	seq: number;
	threadId: string;
	event: AgentWirePayload;
};

export function sseFrame(envelope: AgentWireEnvelope) {
	return `id: ${envelope.seq}\nevent: message\ndata: ${JSON.stringify(envelope)}\n\n`;
}
