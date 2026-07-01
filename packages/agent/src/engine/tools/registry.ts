import {
	assignDomainToServiceForAgent,
	configureApplicationBuildForAgent,
	configureApplicationSourceForAgent,
	configureServiceEnvForAgent,
	configureServiceMountsForAgent,
	configureServicePortsForAgent,
	createApplicationFromImageForAgent,
	createComposeServiceForAgent,
	createDatabaseServiceForAgent,
	createEnvironmentForAgent,
	createServerForAgent,
	getAccessibleEnvironment,
	getAccessibleProject,
	getAccessibleService,
	getRuntimeLogsForAgent,
	getRuntimeStatusForAgent,
	getServerForAgent,
	getServerSetupLogsForAgent,
	listAccessibleProjects,
	listAgentImportBranches,
	listAgentImportGitProviders,
	listAgentImportRepositories,
	listRuntimeServersForAgent,
	listServiceDeployments,
	listSshKeysForAgent,
	readDeploymentLogsForAgent,
	requestSshKeySetupForAgent,
	rollbackDeploymentForAgent,
	runServerSecurityAuditForAgent,
	runServerSetupForAgent,
	runServiceActionForAgent,
	toAgentActorContext,
	validateServerForAgent,
	type AgentServiceType,
	importGitApplicationForAgent,
} from "@nearzero/server/services/agent-workspace";
import { getAgentConfig } from "../../config";
import { analyzeLogs } from "./nearzero/analyzeLogs";
import { createProjectTool } from "./nearzero/createProject";
import { deleteProjectTool } from "./nearzero/deleteProject";
import { deploySuggestion } from "./nearzero/deploySuggestion";
import { runDeploymentTool } from "./nearzero/runDeployment";
import { suggestDeployments } from "./nearzero/suggestDeploy";
import { updateProjectTool } from "./nearzero/updateProject";

export type ToolContext = {
	organizationId: string;
	userId: string;
	userEmail?: string;
	userRole?: string;
	threadId?: string | null;
	aiId?: string | null;
};

export const deploymentTools = {
	suggest: suggestDeployments,
	analyzeLogs,
	listProjects(ctx: ToolContext) {
		return listAccessibleProjects(toAgentActorContext(ctx));
	},
	getProject(ctx: ToolContext, input: { projectId: string }) {
		return getAccessibleProject(toAgentActorContext(ctx), input.projectId);
	},
	getEnvironment(ctx: ToolContext, input: { environmentId: string }) {
		return getAccessibleEnvironment(toAgentActorContext(ctx), input.environmentId);
	},
	getService(
		ctx: ToolContext,
		input: { serviceType: AgentServiceType; serviceId: string },
	) {
		return getAccessibleService(toAgentActorContext(ctx), input);
	},
	listDeployments(
		ctx: ToolContext,
		input: { serviceType: AgentServiceType; serviceId: string; limit?: number },
	) {
		return listServiceDeployments(toAgentActorContext(ctx), input);
	},
	listRuntimeServers(ctx: ToolContext) {
		return listRuntimeServersForAgent(toAgentActorContext(ctx));
	},
	getServer(ctx: ToolContext, input: { serverId: string }) {
		return getServerForAgent(toAgentActorContext(ctx), input);
	},
	validateServer(ctx: ToolContext, input: { serverId: string }) {
		return validateServerForAgent(toAgentActorContext(ctx), input);
	},
	getServerSetupLogs(ctx: ToolContext, input: { serverId: string; tail?: number }) {
		return getServerSetupLogsForAgent(toAgentActorContext(ctx), input);
	},
	listSshKeys(ctx: ToolContext) {
		return listSshKeysForAgent(toAgentActorContext(ctx));
	},
	requestSshKeySetup(
		ctx: ToolContext,
		input: { name?: string; description?: string },
	) {
		return requestSshKeySetupForAgent(toAgentActorContext(ctx), input);
	},
	createServer(
		ctx: ToolContext,
		input: {
			name: string;
			description?: string;
			ipAddress: string;
			port?: number;
			username?: string;
			sshKeyId: string;
		},
	) {
		return createServerForAgent(toAgentActorContext(ctx), {
			...input,
			port: input.port ?? 22,
			username: input.username ?? "root",
		});
	},
	runServerSetup(ctx: ToolContext, input: { serverId: string }) {
		return runServerSetupForAgent(toAgentActorContext(ctx), input);
	},
	runServerSecurityAudit(ctx: ToolContext, input: { serverId: string }) {
		return runServerSecurityAuditForAgent(toAgentActorContext(ctx), input);
	},
	listGitProviders(ctx: ToolContext) {
		return listAgentImportGitProviders(toAgentActorContext(ctx));
	},
	listGitRepositories(ctx: ToolContext, input: { gitProviderId: string }) {
		return listAgentImportRepositories(toAgentActorContext(ctx), input);
	},
	listGitBranches(
		ctx: ToolContext,
		input: {
			gitProviderId: string;
			providerType: "github" | "gitlab" | "bitbucket" | "gitea";
			owner: string;
			repository: string;
			gitlabProjectId?: number;
			bitbucketRepositorySlug?: string;
		},
	) {
		return listAgentImportBranches(toAgentActorContext(ctx), input);
	},
	createEnvironment(
		ctx: ToolContext,
		input: { projectId: string; name: string; description?: string },
	) {
		return createEnvironmentForAgent(toAgentActorContext(ctx), input);
	},
	createApplicationFromGit(
		ctx: ToolContext,
		input: Parameters<typeof importGitApplicationForAgent>[1],
	) {
		return importGitApplicationForAgent(toAgentActorContext(ctx), input);
	},
	createApplicationFromImage(
		ctx: ToolContext,
		input: Parameters<typeof createApplicationFromImageForAgent>[1],
	) {
		return createApplicationFromImageForAgent(toAgentActorContext(ctx), input);
	},
	createComposeService(
		ctx: ToolContext,
		input: Parameters<typeof createComposeServiceForAgent>[1],
	) {
		return createComposeServiceForAgent(toAgentActorContext(ctx), input);
	},
	createDatabaseService(
		ctx: ToolContext,
		input: Parameters<typeof createDatabaseServiceForAgent>[1],
	) {
		return createDatabaseServiceForAgent(toAgentActorContext(ctx), input);
	},
	assignDomainToService(
		ctx: ToolContext,
		input: Parameters<typeof assignDomainToServiceForAgent>[1],
	) {
		return assignDomainToServiceForAgent(toAgentActorContext(ctx), input);
	},
	configureApplicationSource(
		ctx: ToolContext,
		input: Parameters<typeof configureApplicationSourceForAgent>[1],
	) {
		return configureApplicationSourceForAgent(toAgentActorContext(ctx), input);
	},
	configureApplicationBuild(
		ctx: ToolContext,
		input: Parameters<typeof configureApplicationBuildForAgent>[1],
	) {
		return configureApplicationBuildForAgent(toAgentActorContext(ctx), input);
	},
	configureServicePorts(
		ctx: ToolContext,
		input: Parameters<typeof configureServicePortsForAgent>[1],
	) {
		return configureServicePortsForAgent(toAgentActorContext(ctx), input);
	},
	configureServiceEnv(
		ctx: ToolContext,
		input: Parameters<typeof configureServiceEnvForAgent>[1],
	) {
		return configureServiceEnvForAgent(toAgentActorContext(ctx), input);
	},
	configureServiceMounts(
		ctx: ToolContext,
		input: Parameters<typeof configureServiceMountsForAgent>[1],
	) {
		return configureServiceMountsForAgent(toAgentActorContext(ctx), input);
	},
	runServiceAction(
		ctx: ToolContext,
		input: Parameters<typeof runServiceActionForAgent>[1],
	) {
		return runServiceActionForAgent(toAgentActorContext(ctx), input);
	},
	rollbackDeployment(
		ctx: ToolContext,
		input: Parameters<typeof rollbackDeploymentForAgent>[1],
	) {
		return rollbackDeploymentForAgent(toAgentActorContext(ctx), input);
	},
	getRuntimeStatus(
		ctx: ToolContext,
		input: Parameters<typeof getRuntimeStatusForAgent>[1],
	) {
		return getRuntimeStatusForAgent(toAgentActorContext(ctx), input);
	},
	getRuntimeLogs(
		ctx: ToolContext,
		input: Parameters<typeof getRuntimeLogsForAgent>[1],
	) {
		return getRuntimeLogsForAgent(toAgentActorContext(ctx), input);
	},
	createProject: createProjectTool,
	updateProject: updateProjectTool,
	deleteProject: deleteProjectTool,
	runDeployment: runDeploymentTool,
	getDeploymentLogs(
		ctx: ToolContext,
		input: { deploymentId: string; tail?: number },
	) {
		return readDeploymentLogsForAgent(toAgentActorContext(ctx), {
			deploymentId: input.deploymentId,
			tail: input.tail ?? 200,
		});
	},
	deploy: deploySuggestion,
	async webSearch(input: { query: string }) {
		const config = getAgentConfig();
		if (!config.tavilyApiKey) {
			return { results: [], message: "TAVILY_API_KEY is not configured." };
		}
		const res = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({
				api_key: config.tavilyApiKey,
				query: input.query,
				search_depth: "advanced",
				max_results: 5,
			}),
		});
		if (!res.ok) throw new Error(await res.text());
		return res.json();
	},
	async verify(input: { statement: string }) {
		return {
			verified: false,
			statement: input.statement,
			message: "Verification requires live project context or web search results.",
		};
	},
	async delegate(input: { task: string }) {
		return {
			status: "queued_for_user",
			task: input.task,
			message: "Delegation is surfaced to the user; background subagents are not spawned from the hosted agent.",
		};
	},
};
