import { updateProjectForAgent, toAgentActorContext } from "@nearzero/server/services/agent-workspace";
import type { ToolContext } from "../registry";

export async function updateProjectTool(
	ctx: ToolContext,
	input: {
		projectId: string;
		name?: string;
		description?: string;
		env?: string;
	},
) {
	return updateProjectForAgent(toAgentActorContext(ctx), input);
}
