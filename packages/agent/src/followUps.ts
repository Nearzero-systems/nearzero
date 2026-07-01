import { getAgentConfig, openRouterHeaders } from "./config";
import { buildOpenRouterChatBody } from "./engine/loop/openrouter-stream";
import { resolveProvider } from "./engine/resolve-provider";

export async function generateFollowUpSuggestions(input: {
	organizationId: string;
	userMessage: string;
	assistantMessage: string;
	recentUserMessages?: string[];
}) {
	const config = getAgentConfig();
	const fallback = [
		"How do I deploy this safely?",
		"What should I check in the logs?",
		"Can you turn this into a concrete plan?",
		"What should I do next?",
	];
	const provider = await resolveProvider({
		organizationId: input.organizationId,
	});
	if (!provider) return fallback;

	const res = await fetch(`${provider.baseUrl}/chat/completions`, {
		method: "POST",
		headers: openRouterHeaders(provider.apiKey, config),
		body: JSON.stringify(
			buildOpenRouterChatBody({
				model: config.followupsModel,
				messages: [
					{
						role: "system",
						content:
							'Return JSON only: {"suggestions":["..."]}. Suggest up to four concise follow-up prompts for a deployment assistant. Keep them specific to the recent user intent and avoid repeating the current user message.',
					},
					{
						role: "user",
						content: [
							`Recent user messages:\n${(input.recentUserMessages ?? []).slice(-6).map((message) => `- ${message}`).join("\n") || "- none"}`,
							`Current user: ${input.userMessage}`,
							`Assistant: ${input.assistantMessage}`,
						].join("\n\n"),
					},
				],
				responseFormat: { type: "json_object" },
			}),
		),
	});
	if (!res.ok) return fallback;
	const json = (await res.json()) as {
		choices?: Array<{ message?: { content?: string } }>;
	};
	const content = json.choices?.[0]?.message?.content;
	if (!content) return fallback;
	try {
		const parsed = JSON.parse(content) as { suggestions?: unknown[] };
		const suggestions = dedupeAndShuffle(
			(parsed.suggestions ?? [])
				.filter((item): item is string => typeof item === "string")
				.map((item) => item.trim())
				.filter(Boolean),
		).slice(0, 4);
		return suggestions.length ? suggestions : fallback;
	} catch {
		return fallback;
	}
}

function dedupeAndShuffle(items: string[]) {
	const seen = new Set<string>();
	const unique = items.filter((item) => {
		const key = item.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return unique
		.map((value) => ({ value, sort: Math.random() }))
		.sort((a, b) => a.sort - b.sort)
		.map((item) => item.value);
}
