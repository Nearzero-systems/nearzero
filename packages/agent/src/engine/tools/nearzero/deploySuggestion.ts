import { AgentHarnessError } from "@nearzero/server/services/agent-harness-errors";
import {
	assignDomainToServiceForAgent,
	createComposeServiceForAgent,
	toAgentActorContext,
} from "@nearzero/server/services/agent-workspace";
import type { ToolContext } from "../registry";

export type DeploySuggestionInput = {
	environmentId: string;
	id: string;
	dockerCompose: string;
	envVariables?: string;
	serverId?: string;
	name: string;
	description: string;
	domains?: Array<{ host: string; port: number; serviceName: string }>;
	configFiles?: Array<{ filePath: string; content?: string }>;
};

function assertNoRawSecretPayload(input: DeploySuggestionInput) {
	if (input.envVariables?.trim()) {
		throw new AgentHarnessError(
			"policy_secret_exposure_blocked",
			"The legacy deploy tool cannot accept raw environment variable values.",
			"Create the compose service first, then use the secure service settings UI for environment variables.",
		);
	}
	if (input.configFiles?.some((file) => file.content?.trim())) {
		throw new AgentHarnessError(
			"policy_secret_exposure_blocked",
			"The legacy deploy tool cannot accept raw config file content.",
			"Create the compose service first, then add file content through the secure UI if needed.",
		);
	}
}

export async function deploySuggestion(
	ctx: ToolContext,
	input: DeploySuggestionInput,
) {
	assertNoRawSecretPayload(input);
	const actor = toAgentActorContext(ctx);
	const compose = await createComposeServiceForAgent(actor, {
		environmentId: input.environmentId,
		name: input.name,
		description: input.description,
		composeFile: input.dockerCompose,
		serverId: input.serverId,
		composeType: "docker-compose",
	});

	for (const domain of input.domains ?? []) {
		await assignDomainToServiceForAgent(actor, {
			serviceType: "compose",
			serviceId: compose.serviceId,
			host: domain.host,
			port: domain.port,
			https: true,
			certificateType: "letsencrypt",
		});
	}

	return compose;
}
