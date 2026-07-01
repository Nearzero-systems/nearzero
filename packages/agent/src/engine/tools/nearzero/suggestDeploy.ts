import { getWebServerSettings } from "@nearzero/server/services/web-server-settings";
import { getAgentConfig, openRouterHeaders } from "../../../config";
import { resolveProvider } from "../../resolve-provider";

export async function suggestDeployments(input: {
	organizationId: string;
	input: string;
	serverId?: string;
}) {
	const config = getAgentConfig();
	const provider = await resolveProvider({
		organizationId: input.organizationId,
	});

	if (provider) {
		let serverIp = "";
		try {
			serverIp = (await getWebServerSettings())?.serverIp || "";
		} catch {
			serverIp = "";
		}

		const res = await fetch(`${provider.baseUrl}/chat/completions`, {
			method: "POST",
			headers: openRouterHeaders(provider.apiKey, config),
			body: JSON.stringify({
				model: provider.model,
				response_format: { type: "json_object" },
				messages: [
					{
						role: "system",
						content:
							"You are a senior DevOps engineer. Return only valid JSON with a suggestions array. Each suggestion must include id, name, shortDescription, description, dockerCompose, envVariables, domains, and optional configFiles. Docker Compose must be production-minded and deployable by Nearzero.",
					},
					{
						role: "user",
						content: `User request: ${input.input}\nServer IP/domain context: ${serverIp || "unknown"}\nGenerate up to 3 deployable variants.`,
					},
				],
			}),
		});
		if (res.ok) {
			const json = (await res.json()) as {
				choices?: Array<{ message?: { content?: string } }>;
			};
			const content = json.choices?.[0]?.message?.content;
			if (content) {
				const parsed = JSON.parse(content) as { suggestions?: unknown[] };
				if (Array.isArray(parsed.suggestions)) return parsed.suggestions;
			}
		}
	}

	return [
		{
			id: "docker-compose-starter",
			name: "Docker Compose starter",
			shortDescription: "A minimal Compose deployment to adapt in Nearzero.",
			description:
				"I can prepare a compose deployment once a target stack is selected. Configure OpenRouter to generate richer variants.",
			dockerCompose:
				'services:\\n  app:\\n    image: nginx:1.27-alpine\\n    ports:\\n      - "80"\\n',
			envVariables: [],
			domains: [],
		},
	];
}
