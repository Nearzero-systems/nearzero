import "./load-env.js";
import {
	type AgentDeploymentJob,
	registerAgentDeploymentEnqueue,
} from "@nearzero/server/services/agent-deploy-trigger";
import { enqueueDeployment } from "@/server/utils/deploy";

registerAgentDeploymentEnqueue(async (job: AgentDeploymentJob) => {
	await enqueueDeployment(job);
});
