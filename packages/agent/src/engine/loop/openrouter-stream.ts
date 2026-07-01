import { getAgentConfig, openRouterHeaders } from "../../config";
import type { AgentProvider } from "../resolve-provider";
import type { OpenAiMessage, OpenAiToolCall } from "./hydrate-messages";
import { agentToolDefinitions } from "./tool-schemas";

export type StreamedAssistant = {
	content: string;
	toolCalls: OpenAiToolCall[];
	reasoning?: string;
	reasoningDetails: unknown[];
};

type DeltaToolCall = {
	index?: number;
	id?: string;
	function?: { name?: string; arguments?: string };
};

type StreamChoice = {
	delta?: {
		content?: string | null;
		reasoning?: string | null;
		reasoning_details?: unknown[];
		tool_calls?: DeltaToolCall[];
	};
	message?: {
		content?: string | null;
		reasoning?: string | null;
		reasoning_details?: unknown[];
	};
	finish_reason?: string | null;
};

/**
 * Kimi K2.6 returns empty `content` when `reasoning.exclude` is set alongside tools.
 * `effort: "none"` disables reasoning output while keeping tool calling working.
 */
export function openRouterReasoningConfig() {
	return { effort: "none" as const };
}

export function buildOpenRouterChatBody(input: {
	model: string;
	messages: OpenAiMessage[];
	stream?: boolean;
	tools?: typeof agentToolDefinitions;
	toolChoice?: "auto" | "none";
	responseFormat?: { type: "json_object" };
}) {
	return {
		model: input.model,
		stream: input.stream ?? false,
		messages: input.messages,
		reasoning: openRouterReasoningConfig(),
		...(input.tools?.length
			? {
					tools: input.tools,
					tool_choice: input.toolChoice ?? "auto",
				}
			: {}),
		...(input.responseFormat ? { response_format: input.responseFormat } : {}),
	};
}

function appendReasoningDetails(target: unknown[], incoming: unknown[] | undefined) {
	if (!incoming?.length) return;
	target.push(...incoming);
}

function appendContent(content: string, piece: string | null | undefined) {
	if (piece == null || piece === "") return content;
	return content + piece;
}

export async function streamOpenRouterCompletion(input: {
	provider: AgentProvider;
	messages: OpenAiMessage[];
	onDelta: (text: string) => Promise<void>;
	deepResearch?: boolean;
}) {
	const config = getAgentConfig();
	const res = await fetch(`${input.provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: openRouterHeaders(input.provider.apiKey, config),
		body: JSON.stringify(
			buildOpenRouterChatBody({
				model: input.provider.model,
				messages: input.messages,
				stream: true,
				tools: agentToolDefinitions,
				toolChoice: "auto",
			}),
		),
	});

	if (!res.ok || !res.body) {
		throw new Error(await res.text());
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let content = "";
	let reasoning = "";
	const reasoningDetails: unknown[] = [];
	const toolCalls = new Map<number, OpenAiToolCall>();

	while (true) {
		const read = await reader.read();
		if (read.done) break;
		buffer += decoder.decode(read.value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith("data:")) continue;
			const payload = trimmed.slice(5).trim();
			if (!payload || payload === "[DONE]") continue;

			const json = JSON.parse(payload) as { choices?: StreamChoice[] };
			const choice = json.choices?.[0];
			const delta = choice?.delta;
			const message = choice?.message;

			if (delta?.content) {
				content = appendContent(content, delta.content);
				await input.onDelta(delta.content);
			}
			if (typeof delta?.reasoning === "string" && delta.reasoning) {
				reasoning += delta.reasoning;
			}
			appendReasoningDetails(reasoningDetails, delta?.reasoning_details);

			if (message?.content) {
				const next = appendContent(content, message.content);
				const deltaText = next.slice(content.length);
				content = next;
				if (deltaText) await input.onDelta(deltaText);
			}
			if (typeof message?.reasoning === "string" && message.reasoning) {
				reasoning += message.reasoning;
			}
			appendReasoningDetails(reasoningDetails, message?.reasoning_details);

			for (const toolDelta of delta?.tool_calls ?? []) {
				const index = toolDelta.index ?? 0;
				const existing = toolCalls.get(index) ?? {
					id: toolDelta.id ?? "",
					type: "function" as const,
					function: { name: "", arguments: "" },
				};
				if (toolDelta.id) existing.id = toolDelta.id;
				if (toolDelta.function?.name) {
					existing.function.name += toolDelta.function.name;
				}
				if (toolDelta.function?.arguments) {
					existing.function.arguments += toolDelta.function.arguments;
				}
				toolCalls.set(index, existing);
			}
		}
	}

	return {
		content,
		toolCalls: [...toolCalls.values()].filter((call) => call.id && call.function.name),
		reasoning: reasoning || undefined,
		reasoningDetails,
	} satisfies StreamedAssistant;
}

export async function completeOpenRouterJson(input: {
	provider: AgentProvider;
	model: string;
	messages: OpenAiMessage[];
	responseFormat?: { type: "json_object" };
}) {
	const config = getAgentConfig();
	const res = await fetch(`${input.provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: openRouterHeaders(input.provider.apiKey, config),
		body: JSON.stringify(
			buildOpenRouterChatBody({
				model: input.model,
				messages: input.messages,
				stream: false,
				responseFormat: input.responseFormat,
			}),
		),
	});
	if (!res.ok) throw new Error(await res.text());
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string | null } }>;
	};
	return json.choices?.[0]?.message?.content ?? "";
}

export function assistantToolTurnPayload(streamed: StreamedAssistant) {
	return {
		text: streamed.content,
		tool_calls: streamed.toolCalls,
		...(streamed.reasoningDetails.length
			? { reasoning_details: streamed.reasoningDetails }
			: {}),
		...(streamed.reasoning ? { reasoning: streamed.reasoning } : {}),
	};
}

export function assistantToolTurnMessage(streamed: StreamedAssistant): OpenAiMessage {
	return {
		role: "assistant",
		content: streamed.content || null,
		tool_calls: streamed.toolCalls,
		...(streamed.reasoningDetails.length
			? { reasoning_details: streamed.reasoningDetails }
			: {}),
		...(streamed.reasoning ? { reasoning: streamed.reasoning } : {}),
	};
}
