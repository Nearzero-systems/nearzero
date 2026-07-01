import {
	assertAgentPolicy,
	type AgentPolicyAction,
	type AgentPolicyActor,
	type AgentPolicyResourceContext,
} from "@nearzero/server/services/agent-policy";
import { formatHarnessToolFailure } from "./harness-tool-result";

export type HarnessPolicyCheck =
	| { allowed: true }
	| { allowed: false; reply: string };

export async function checkHarnessPolicy(
	actor: AgentPolicyActor,
	action: AgentPolicyAction,
	resourceContext: AgentPolicyResourceContext = {},
): Promise<HarnessPolicyCheck> {
	try {
		await assertAgentPolicy(actor, action, resourceContext);
		return { allowed: true };
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		const lines = [failure.message];
		if (failure.guidance) lines.push(failure.guidance);
		return { allowed: false, reply: lines.join("\n\n") };
	}
}
