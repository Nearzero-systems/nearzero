export type AgentDeploymentJob =
	| {
			applicationId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "application";
			serverId?: string;
	  }
	| {
			composeId: string;
			titleLog: string;
			descriptionLog: string;
			server?: boolean;
			type: "deploy" | "redeploy";
			applicationType: "compose";
			serverId?: string;
	  };

export type AgentDeploymentEnqueue = (
	job: AgentDeploymentJob,
) => Promise<void>;

let enqueueDeployment: AgentDeploymentEnqueue | null = null;

export function registerAgentDeploymentEnqueue(handler: AgentDeploymentEnqueue) {
	enqueueDeployment = handler;
}

export async function triggerAgentDeployment(job: AgentDeploymentJob) {
	if (!enqueueDeployment) {
		throw new Error(
			"Deployment queue is not configured. Restart the platform server.",
		);
	}
	await enqueueDeployment(job);
}
