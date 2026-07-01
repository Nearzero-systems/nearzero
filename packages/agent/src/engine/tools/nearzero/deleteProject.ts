import {
	deleteDevProjectForAgent,
	toAgentActorContext,
} from "@nearzero/server/services/agent-workspace";
import type { ToolContext } from "../registry";

export async function deleteProjectTool(
	ctx: ToolContext,
	input: { projectId: string },
) {
	return deleteDevProjectForAgent(toAgentActorContext(ctx), input);
}
