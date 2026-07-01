import { createDevProjectForAgent, toAgentActorContext } from "@nearzero/server/services/agent-workspace";
import type { ToolContext } from "../registry";

export async function createProjectTool(
	ctx: ToolContext,
	input: { name: string; description?: string },
) {
	return createDevProjectForAgent(toAgentActorContext(ctx), input);
}
