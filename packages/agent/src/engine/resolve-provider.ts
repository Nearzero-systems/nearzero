import { getOrgOpenRouterApiKey } from "@nearzero/server/services/agent-openrouter-key";
import { getAgentConfig } from "../config";

export type AgentProviderSource = "env" | "org";

export type AgentProvider = {
	source: AgentProviderSource;
	baseUrl: string;
	apiKey: string;
	model: string;
};

export async function resolveProvider(input: {
	organizationId: string;
	aiId?: string | null;
}): Promise<AgentProvider | null> {
	const config = getAgentConfig();
	const envKey = config.openRouterApiKey.trim();
	if (envKey) {
		return {
			source: "env",
			baseUrl: config.openRouterBaseUrl,
			apiKey: envKey,
			model: config.chatModel,
		};
	}

	const orgKey = await getOrgOpenRouterApiKey(input.organizationId);
	if (orgKey?.trim()) {
		return {
			source: "org",
			baseUrl: config.openRouterBaseUrl,
			apiKey: orgKey.trim(),
			model: config.chatModel,
		};
	}

	return null;
}
