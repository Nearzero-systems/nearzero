import { getAgentConfig } from "../../config";
import {
	insertMessage,
	type AgentIdentity,
} from "../../store";
import type { AgentWireEnvelope } from "../../wire";
import type { AgentProvider } from "../resolve-provider";
import type { ToolContext } from "../tools/registry";
import { AgentUserInputRequiredError } from "../agent-user-input";
import { formatHarnessToolFailure } from "../harness-tool-result";
import { hydrateOpenAiMessages, type OpenAiMessage } from "./hydrate-messages";
import {
	assistantToolTurnMessage,
	assistantToolTurnPayload,
	completeOpenRouterJson,
	streamOpenRouterCompletion,
} from "./openrouter-stream";
import { previewToolResult, runToolCall } from "./run-tool-calls";
import { toolActivityLabel } from "../tool-activity-labels";

type Emit = (event: AgentWireEnvelope["event"]) => Promise<void>;

export async function runAgentToolLoop(input: {
	threadId: string;
	identity: AgentIdentity;
	provider: AgentProvider;
	userText: string;
	deepResearch?: boolean;
	retryAfterProviderSetup?: boolean;
	toolContext: ToolContext;
	emit: Emit;
}) {
	const config = getAgentConfig();

	const history = await hydrateOpenAiMessages(
		input.threadId,
		input.identity,
		!input.retryAfterProviderSetup,
	);

	const messages: OpenAiMessage[] = [
		{
			role: "system",
			content: config.systemPrompt,
		},
		...history,
		...(input.retryAfterProviderSetup
			? []
			: [{ role: "user" as const, content: input.userText }]),
	];

	const maxTurns = input.deepResearch
		? config.deepResearchMaxTurns
		: config.maxTurns;

	for (let turn = 0; turn < maxTurns; turn++) {
		let assistantText = "";
		const streamed = await streamOpenRouterCompletion({
			provider: input.provider,
			messages,
			deepResearch: input.deepResearch,
			onDelta: async (text) => {
				assistantText += text;
				await input.emit({ kind: "assistant_delta", text });
			},
		});

		if (streamed.toolCalls.length === 0) {
			const finalText = (streamed.content || assistantText).trim();
			if (!finalText) {
				throw new Error(
					"Nearzero Agent received an empty model response after tool execution.",
				);
			}
			await insertMessage(input.threadId, "assistant", { text: finalText });
			await input.emit({ kind: "assistant_message", text: finalText });
			return finalText;
		}

		await insertMessage(
			input.threadId,
			"assistant",
			assistantToolTurnPayload(streamed),
		);

		messages.push(assistantToolTurnMessage(streamed));

		for (const toolCall of streamed.toolCalls) {
			await input.emit({
				kind: "tool_start",
				toolCallId: toolCall.id,
				toolName: toolCall.function.name,
				detail: toolActivityLabel(toolCall.function.name),
			});

			let result: unknown;
			let isError = false;
			try {
				result = await runToolCall(input.toolContext, toolCall);
			} catch (error) {
				if (error instanceof AgentUserInputRequiredError) {
					const request = error.request;
					await input.emit({
						kind: "user_input_required",
						field: request.field,
						waitingLabel: request.waitingLabel,
						prompt: request.prompt,
						placeholder: request.placeholder,
						submitLabel: request.submitLabel,
						inputType: request.inputType,
						secret: request.secret,
						options: request.options,
						context: request.context,
					});
					await insertMessage(input.threadId, "assistant", {
						text: "",
						userInputRequest: request,
					});
					return "";
				}
				isError = true;
				result = formatHarnessToolFailure(error);
			}

			const preview = previewToolResult(result);
			await input.emit({
				kind: "tool_result",
				toolCallId: toolCall.id,
				toolName: toolCall.function.name,
				resultPreview: preview,
				isError,
			});
			await input.emit({
				kind: "tool_end",
				toolCallId: toolCall.id,
				toolName: toolCall.function.name,
			});

			await insertMessage(input.threadId, "tool", {
				toolCallId: toolCall.id,
				toolName: toolCall.function.name,
				result,
			});

			messages.push({
				role: "tool",
				tool_call_id: toolCall.id,
				content: preview,
			});
		}
	}

	const fallback = "I reached the maximum number of tool turns for this request.";
	await insertMessage(input.threadId, "assistant", { text: fallback });
	await input.emit({ kind: "assistant_message", text: fallback });
	return fallback;
}

export async function generateThreadTitleWithProvider(
	provider: AgentProvider,
	prompt: string,
) {
	const fallback = prompt.split(/\s+/).slice(0, 8).join(" ").slice(0, 72);
	try {
		const title = await completeOpenRouterJson({
			provider,
			model: getAgentConfig().titleModel,
			messages: [
				{
					role: "system",
					content:
						"Write a short chat title, at most six words. Return plain text only.",
				},
				{ role: "user", content: prompt },
			],
		});
		return (title.replace(/^['"]|['"]$/g, "").trim() || fallback || "New chat").slice(
			0,
			72,
		);
	} catch {
		return fallback || "New chat";
	}
}
