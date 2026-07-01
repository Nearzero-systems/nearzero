import { getAgentConfig, openRouterHeaders } from "../../../config";
import { resolveProvider } from "../../resolve-provider";

export async function analyzeLogs(input: {
	organizationId?: string;
	logs: string;
	context: "build" | "runtime";
}) {
	const config = getAgentConfig();
	const provider = input.organizationId
		? await resolveProvider({ organizationId: input.organizationId })
		: config.openRouterApiKey.trim()
			? {
					source: "env" as const,
					baseUrl: config.openRouterBaseUrl,
					apiKey: config.openRouterApiKey.trim(),
					model: config.chatModel,
				}
			: null;

	if (!provider) {
		return "OpenRouter is not configured. Add an OpenRouter API key to enable log analysis.";
	}

	const res = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: openRouterHeaders(provider.apiKey, config),
		body: JSON.stringify({
			model: provider.model,
			messages: [
				{
					role: "system",
					content:
						"You are a senior DevOps engineer. Summarize logs, identify root cause, and suggest precise fixes.",
				},
				{
					role: "user",
					content: `Context: ${input.context}\n\nLogs:\n${input.logs.slice(0, 12000)}`,
				},
			],
		}),
	});
	if (!res.ok) throw new Error(await res.text());
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	return json.choices?.[0]?.message?.content || "No analysis returned.";
}
