import { runDeploymentForAgent, toAgentActorContext } from "@nearzero/server/services/agent-workspace";
import type { ToolContext } from "../registry";

export async function runDeploymentTool(
	ctx: ToolContext,
	input: {
		serviceType: "application" | "compose";
		serviceId: string;
		title?: string;
		description?: string;
	},
) {
	return runDeploymentForAgent(toAgentActorContext(ctx), input);
}
