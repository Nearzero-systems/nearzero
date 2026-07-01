import { listMessages, type AgentIdentity } from "../../store";

export type OpenAiMessage =
	| { role: "system"; content: string }
	| { role: "user"; content: string }
	| {
			role: "assistant";
			content: string | null;
			tool_calls?: OpenAiToolCall[];
			reasoning?: string;
			reasoning_details?: unknown[];
	  }
	| { role: "tool"; tool_call_id: string; content: string };

export type OpenAiToolCall = {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
};

type StoredMessage = Awaited<ReturnType<typeof listMessages>>[number];

function messageText(contentJson: unknown) {
	if (
		typeof contentJson === "object" &&
		contentJson !== null &&
		"text" in contentJson &&
		typeof (contentJson as { text?: unknown }).text === "string"
	) {
		return (contentJson as { text: string }).text;
	}
	if (
		typeof contentJson === "object" &&
		contentJson !== null &&
		"result" in contentJson
	) {
		return JSON.stringify((contentJson as { result: unknown }).result);
	}
	return "";
}

export async function hydrateOpenAiMessages(
	threadId: string,
	identity: AgentIdentity,
	excludeLatestUser = true,
) {
	const rows = await listMessages(threadId, identity);
	const slice = excludeLatestUser ? rows.slice(0, -1) : rows;
	const messages: OpenAiMessage[] = [];

	for (const row of slice) {
		if (row.role === "user") {
			const text = messageText(row.contentJson);
			if (text) messages.push({ role: "user", content: text });
			continue;
		}
		if (row.role === "assistant") {
			const contentJson = row.contentJson as {
				text?: string;
				tool_calls?: OpenAiToolCall[];
				reasoning?: string;
				reasoning_details?: unknown[];
			};
			const text = contentJson.text ?? messageText(row.contentJson);
			const reasoningFields = {
				...(contentJson.reasoning_details?.length
					? { reasoning_details: contentJson.reasoning_details }
					: {}),
				...(contentJson.reasoning ? { reasoning: contentJson.reasoning } : {}),
			};
			if (contentJson.tool_calls?.length) {
				messages.push({
					role: "assistant",
					content: text || null,
					tool_calls: contentJson.tool_calls,
					...reasoningFields,
				});
			} else if (text) {
				messages.push({ role: "assistant", content: text });
			}
			continue;
		}
		if (row.role === "tool") {
			const contentJson = row.contentJson as {
				toolCallId?: string;
				result?: unknown;
			};
			if (contentJson.toolCallId) {
				messages.push({
					role: "tool",
					tool_call_id: contentJson.toolCallId,
					content: JSON.stringify(contentJson.result ?? ""),
				});
			}
		}
	}

	return messages;
}
