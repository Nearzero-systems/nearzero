import {
	importGitApplicationForAgent,
	listAccessibleProjects,
	listAgentImportBranches,
	listAgentImportRuntimeServers,
	listAgentImportGitProviders,
	listAgentImportRepositories,
	runServiceActionForAgent,
	toAgentActorContext,
} from "@nearzero/server/services/agent-workspace";
import { AgentUserInputRequiredError } from "../agent-user-input";
import { formatHarnessToolFailure } from "../harness-tool-result";
import type { ToolContext } from "../tools/registry";
import type { AgentWireEnvelope } from "../../wire";
import {
	findProjectsMentionedInText,
	type ProjectSummary,
} from "./project-resolution";

type Emit = (event: AgentWireEnvelope["event"]) => Promise<void>;

type ImportProjectSummary = ProjectSummary & {
	environments?: Array<{
		environmentId?: string | null;
		name?: string | null;
	}>;
};

const PROVIDER_LABELS: Record<string, string> = {
	github: "GitHub",
	gitlab: "GitLab",
	bitbucket: "Bitbucket",
	gitea: "Gitea",
};

const GIT_PROVIDER_TYPES = ["github", "gitlab", "bitbucket", "gitea"] as const;
type GitProviderType = (typeof GIT_PROVIDER_TYPES)[number];

function gitProviderConnectOptions() {
	return GIT_PROVIDER_TYPES.map((providerType) => ({
		label: PROVIDER_LABELS[providerType] ?? providerType,
		value: `connect:${providerType}`,
		description: "Connect in Settings without sharing secrets with Agent",
		action: "connectGitProvider" as const,
		providerType,
		href: `/dashboard/settings/git-providers?connect=${providerType}`,
	}));
}

export function detectServiceImportIntent(text: string) {
	const normalized = text.toLowerCase();
	const asksToConnectGit =
		/\b(connect|link|authorize|setup|set up)\b/.test(normalized) &&
		/\b(my\s+)?(git|github|gitlab|gitea|bitbucket|git provider|repository|repo)\b/.test(
			normalized,
		);
	const asksForService =
		/\b(import|add|create|connect|set up|setup|run|deploy|launch|spin up)\b/.test(
			normalized,
		) && /\b(service|application|app|repo|repository)\b/.test(normalized);
	const mentionsGit =
		/\b(git|github|gitlab|gitea|bitbucket|repo|repository)\b/.test(
			normalized,
		);
	return (
		asksToConnectGit ||
		(asksForService &&
			(mentionsGit || /\b(service|application|app)\b/.test(normalized)))
	);
}

function pickProject(projects: ImportProjectSummary[], userText: string) {
	if (projects.length === 1) return projects[0]!;
	const mentioned = findProjectsMentionedInText(projects, userText);
	return mentioned[0] ?? null;
}

function pickEnvironment(project: ImportProjectSummary) {
	const environments = project.environments ?? [];
	return (
		environments.find(
			(environment) => environment.name?.trim().toLowerCase() === "development",
		) ??
		environments.find(
			(environment) => environment.name?.trim().toLowerCase() !== "production",
		) ??
		environments[0] ??
		null
	);
}

function parseRepository(value: string) {
	try {
		return JSON.parse(value) as {
			providerType: "github" | "gitlab" | "bitbucket" | "gitea";
			owner: string;
			repository: string;
			defaultBranch?: string;
			gitlabProjectId?: number;
			gitlabPathNamespace?: string;
			bitbucketRepositorySlug?: string;
		};
	} catch {
		throw new Error("Repository selection was invalid. Start the import again.");
	}
}

function providerDescription(type: string) {
	return PROVIDER_LABELS[type] ?? type;
}

function isGitProviderType(value: string): value is GitProviderType {
	return GIT_PROVIDER_TYPES.includes(value as GitProviderType);
}

function shouldDeployAfterImport(text: string) {
	return /\b(deploy|redeploy|launch|run|spin up|start)\b/i.test(text);
}

async function askForRepositorySelection(input: {
	actor: ReturnType<typeof toAgentActorContext>;
	context: Record<string, string>;
	gitProviderId: string;
}) {
	let repositories: Awaited<ReturnType<typeof listAgentImportRepositories>>;
	try {
		repositories = await listAgentImportRepositories(input.actor, {
			gitProviderId: input.gitProviderId,
		});
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		return `Could not list repositories: ${failure.message}${failure.guidance ? ` ${failure.guidance}` : ""}`;
	}
	if (repositories.length === 0) {
		return "That Git provider is connected, but I couldn't find any repositories available to import.";
	}
	throw new AgentUserInputRequiredError({
		field: "gitRepository",
		prompt: "Choose a repository to import",
		waitingLabel: "Waiting for repository",
		submitLabel: "Use repository",
		options: repositories.slice(0, 100),
		context: {
			...input.context,
			gitProviderId: input.gitProviderId,
		},
	});
}

export async function runServiceImportHarness(input: {
	userText: string;
	toolContext: ToolContext;
	emit?: Emit;
}): Promise<string | null> {
	if (!detectServiceImportIntent(input.userText)) return null;

	const actor = toAgentActorContext(input.toolContext);
	const deployAfterImport = shouldDeployAfterImport(input.userText);
	const projects = (await listAccessibleProjects(actor)) as ImportProjectSummary[];
	if (projects.length === 0) {
		return "Create a project first, then I can import a Git service into it.";
	}

	const project = pickProject(projects, input.userText);
	if (!project) {
		return `Which project should I import the service into? Available projects: ${projects.map((item) => item.name).join(", ")}.`;
	}

	const environment = pickEnvironment(project);
	if (!environment?.environmentId) {
		return `I couldn't find an environment inside ${project.name} to import the service into.`;
	}

	let providers: Awaited<ReturnType<typeof listAgentImportGitProviders>>;
	try {
		providers = await listAgentImportGitProviders(actor);
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		return `Could not import a service: ${failure.message}${failure.guidance ? ` ${failure.guidance}` : ""}`;
	}
	if (providers.length === 0) {
		throw new AgentUserInputRequiredError({
			field: "gitProviderId",
			prompt: "Connect a Git provider to import the service",
			waitingLabel: "Waiting for Git provider connection",
			submitLabel: "Connect",
			options: gitProviderConnectOptions(),
			context: {
				environmentId: environment.environmentId,
				projectName: project.name,
				deployAfterImport: String(deployAfterImport),
			},
		});
	}

	throw new AgentUserInputRequiredError({
		field: "gitProviderId",
		prompt: "Choose a Git provider to import from",
		waitingLabel: "Waiting for Git provider",
		submitLabel: "Continue",
		options: providers.map((provider) => ({
			label: providerDescription(provider.providerType),
			value: provider.gitProviderId,
			description: provider.name,
			providerType: provider.providerType,
		})),
		context: {
			environmentId: environment.environmentId,
			projectName: project.name,
			deployAfterImport: String(deployAfterImport),
		},
	});
}

export async function runServiceImportUserInputHarness(input: {
	response: {
		field: string;
		value: string;
		context?: Record<string, string>;
	};
	toolContext: ToolContext;
	emit?: Emit;
}): Promise<string | null> {
	const actor = toAgentActorContext(input.toolContext);
	const context = input.response.context ?? {};

	if (input.response.field === "gitProviderId") {
		if (input.response.value.startsWith("connect:")) {
			const providerType = input.response.value.replace(/^connect:/, "");
			if (!isGitProviderType(providerType)) {
				return "That Git provider selection was invalid. Choose a provider again.";
			}
			const providers = await listAgentImportGitProviders(actor);
			const matchingProviders = providers.filter(
				(provider) => provider.providerType === providerType,
			);
			if (matchingProviders.length === 1) {
				return askForRepositorySelection({
					actor,
					context,
					gitProviderId: matchingProviders[0]!.gitProviderId,
				});
			}
			if (matchingProviders.length > 1) {
				throw new AgentUserInputRequiredError({
					field: "gitProviderId",
					prompt: `Choose the ${providerDescription(providerType)} account to import from`,
					waitingLabel: "Waiting for Git provider",
					submitLabel: "Continue",
					options: matchingProviders.map((provider) => ({
						label: providerDescription(provider.providerType),
						value: provider.gitProviderId,
						description: provider.name,
						providerType: provider.providerType,
					})),
					context,
				});
			}
			throw new AgentUserInputRequiredError({
				field: "gitProviderId",
				prompt: `Connect ${providerDescription(providerType)} to import the service`,
				waitingLabel: `Waiting for ${providerDescription(providerType)} connection`,
				submitLabel: "Connect",
				options: gitProviderConnectOptions().filter(
					(option) => option.providerType === providerType,
				),
				context,
			});
		}
		return askForRepositorySelection({
			actor,
			context,
			gitProviderId: input.response.value,
		});
	}

	if (input.response.field === "gitRepository") {
		const repository = parseRepository(input.response.value);
		const gitProviderId = context.gitProviderId ?? "";
		if (repository.defaultBranch) {
			const serverChoice = await maybeAskForServer({
				actor,
				context,
				gitProviderId,
				repository,
				branch: repository.defaultBranch,
				emit: input.emit,
			});
			if (serverChoice) return serverChoice;
		}
		let branches: Awaited<ReturnType<typeof listAgentImportBranches>>;
		try {
			branches = await listAgentImportBranches(actor, {
				gitProviderId,
				providerType: repository.providerType,
				owner: repository.owner,
				repository: repository.repository,
				gitlabProjectId: repository.gitlabProjectId,
				bitbucketRepositorySlug: repository.bitbucketRepositorySlug,
			});
		} catch (error) {
			const failure = formatHarnessToolFailure(error);
			return `Could not list branches: ${failure.message}${failure.guidance ? ` ${failure.guidance}` : ""}`;
		}
		if (branches.length === 0) {
			return `I couldn't find branches for ${repository.owner}/${repository.repository}.`;
		}
		throw new AgentUserInputRequiredError({
			field: "gitBranch",
			prompt: "Choose a branch to import",
			waitingLabel: "Waiting for branch",
			submitLabel: "Import",
			options: branches.slice(0, 100).map((branch) => ({
				label: branch,
				value: branch,
			})),
			context: {
				...context,
				gitRepository: input.response.value,
			},
		});
	}

	if (input.response.field === "gitBranch") {
		const repository = parseRepository(context.gitRepository ?? "");
		const gitProviderId = context.gitProviderId ?? "";
		const serverChoice = await maybeAskForServer({
			actor,
			context,
			gitProviderId,
			repository,
			branch: input.response.value,
			emit: input.emit,
		});
		if (serverChoice) return serverChoice;
		return importSelectedRepository({
			actor,
			context,
			gitProviderId,
			repository,
			branch: input.response.value,
			emit: input.emit,
		});
	}

	if (input.response.field === "serverId") {
		const repository = parseRepository(context.gitRepository ?? "");
		return importSelectedRepository({
			actor,
			context,
			gitProviderId: context.gitProviderId ?? "",
			repository,
			branch: context.branch ?? "",
			serverId: input.response.value,
			emit: input.emit,
		});
	}

	return null;
}

async function maybeAskForServer(input: {
	actor: ReturnType<typeof toAgentActorContext>;
	context: Record<string, string>;
	gitProviderId: string;
	repository: ReturnType<typeof parseRepository>;
	branch: string;
	emit?: Emit;
}) {
	let runtimeServers: Awaited<ReturnType<typeof listAgentImportRuntimeServers>>;
	try {
		runtimeServers = await listAgentImportRuntimeServers(input.actor);
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		return `Could not choose a server: ${failure.message}${failure.guidance ? ` ${failure.guidance}` : ""}`;
	}
	if (!runtimeServers.required) {
		return importSelectedRepository(input);
	}
	if (runtimeServers.servers.length === 1) {
		return importSelectedRepository({
			...input,
			serverId: runtimeServers.servers[0]!.serverId,
		});
	}
	if (runtimeServers.servers.length === 0) {
		return "A server is required before I can import this service. Add one in Settings > Remote servers, then ask again.";
	}
	throw new AgentUserInputRequiredError({
		field: "serverId",
		prompt: "Choose a server for this service",
		waitingLabel: "Waiting for server",
		submitLabel: "Import",
		options: runtimeServers.servers.map((server) => ({
			label: server.name,
			value: server.serverId,
			description: server.ipAddress,
		})),
		context: {
			...input.context,
			gitProviderId: input.gitProviderId,
			gitRepository: JSON.stringify(input.repository),
			branch: input.branch,
		},
	});
}

async function importSelectedRepository(input: {
	actor: ReturnType<typeof toAgentActorContext>;
	context: Record<string, string>;
	gitProviderId: string;
	repository: ReturnType<typeof parseRepository>;
	branch: string;
	serverId?: string;
	emit?: Emit;
}) {
	let result: Awaited<ReturnType<typeof importGitApplicationForAgent>>;
	const importToolCallId = `harness-import-${Date.now()}`;
	await input.emit?.({
		kind: "tool_start",
		toolCallId: importToolCallId,
		toolName: "createApplicationFromGit",
		detail: "Importing Git application",
	});
	try {
		result = await importGitApplicationForAgent(input.actor, {
			environmentId: input.context.environmentId ?? "",
			gitProviderId: input.gitProviderId,
			providerType: input.repository.providerType,
			owner: input.repository.owner,
			repository: input.repository.repository,
			branch: input.branch,
			gitlabProjectId: input.repository.gitlabProjectId,
			gitlabPathNamespace: input.repository.gitlabPathNamespace,
			bitbucketRepositorySlug: input.repository.bitbucketRepositorySlug,
			serverId: input.serverId,
		});
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		await input.emit?.({
			kind: "tool_result",
			toolCallId: importToolCallId,
			toolName: "createApplicationFromGit",
			resultPreview: JSON.stringify(failure),
			isError: true,
		});
		await input.emit?.({
			kind: "tool_end",
			toolCallId: importToolCallId,
			toolName: "createApplicationFromGit",
		});
		return `Could not import the service: ${failure.message}${failure.guidance ? ` ${failure.guidance}` : ""}`;
	}
	await input.emit?.({
		kind: "tool_result",
		toolCallId: importToolCallId,
		toolName: "createApplicationFromGit",
		resultPreview: JSON.stringify(result),
		isError: false,
	});
	await input.emit?.({
		kind: "tool_end",
		toolCallId: importToolCallId,
		toolName: "createApplicationFromGit",
	});

	const domainNote =
		result.liveUrl
			? ` Live URL: ${result.liveUrl}.`
			: result.domainStatus === "blocked"
				? " Domain assignment is disabled by policy."
				: "";
	if (input.context.deployAfterImport !== "true") {
		return `Imported **${result.serviceName}** from **${result.repository}** on **${result.branch}** into **${result.projectName}**.${domainNote}`;
	}

	const deployToolCallId = `harness-deploy-${result.serviceId}`;
	await input.emit?.({
		kind: "tool_start",
		toolCallId: deployToolCallId,
		toolName: "runServiceAction",
		detail: "Starting deployment",
	});
	try {
		const deployResult = await runServiceActionForAgent(input.actor, {
			serviceType: "application",
			serviceId: result.serviceId,
			action: "deploy",
			title: "Agent deployment",
			description: `Deploy ${result.repository}`,
		});
		await input.emit?.({
			kind: "tool_result",
			toolCallId: deployToolCallId,
			toolName: "runServiceAction",
			resultPreview: JSON.stringify(deployResult),
			isError: false,
		});
		await input.emit?.({
			kind: "tool_end",
			toolCallId: deployToolCallId,
			toolName: "runServiceAction",
		});
		return `Imported **${result.serviceName}** from **${result.repository}** on **${result.branch}** into **${result.projectName}** and queued deployment.${domainNote}`;
	} catch (error) {
		const failure = formatHarnessToolFailure(error);
		await input.emit?.({
			kind: "tool_result",
			toolCallId: deployToolCallId,
			toolName: "runServiceAction",
			resultPreview: JSON.stringify(failure),
			isError: true,
		});
		await input.emit?.({
			kind: "tool_end",
			toolCallId: deployToolCallId,
			toolName: "runServiceAction",
		});
		return `Imported **${result.serviceName}** from **${result.repository}** on **${result.branch}** into **${result.projectName}**, but I could not start deployment: ${failure.message}${failure.guidance ? ` ${failure.guidance}` : ""}${domainNote}`;
	}
}
