export type AgentConfig = {
	enabled: boolean;
	openRouterApiKey: string;
	openRouterBaseUrl: string;
	openRouterReferer: string;
	openRouterTitle: string;
	chatModel: string;
	titleModel: string;
	followupsModel: string;
	greetingTitle: string;
	greetingSubtitle: string;
	onboardingGreetingAdmin: string;
	onboardingGreetingMember: string;
	systemPrompt: string;
	maxTurns: number;
	deepResearchMaxTurns: number;
	attachmentsPath: string;
	tavilyApiKey: string;
};

function intEnv(name: string, fallback: number) {
	const value = Number.parseInt(process.env[name] ?? "", 10);
	return Number.isFinite(value) ? value : fallback;
}

export function getAgentConfig(): AgentConfig {
	const consoleUrl = process.env.CONSOLE_URL || "http://localhost:4321";
	return {
		enabled: process.env.NEARZERO_AGENT_ENABLED !== "false",
		openRouterApiKey: process.env.OPENROUTER_API_KEY || "",
		openRouterBaseUrl:
			process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1",
		openRouterReferer:
			process.env.OPENROUTER_HTTP_REFERER ||
			process.env.OPENROUTER_APP_URL ||
			consoleUrl,
		openRouterTitle: process.env.OPENROUTER_X_TITLE || "Nearzero",
		chatModel: process.env.OPENROUTER_CHAT_MODEL || "moonshotai/kimi-k2.6",
		titleModel: process.env.OPENROUTER_TITLE_MODEL || "openai/gpt-4o-mini",
		followupsModel:
			process.env.OPENROUTER_FOLLOWUPS_MODEL ||
			process.env.OPENROUTER_TITLE_MODEL ||
			"openai/gpt-4o-mini",
		greetingTitle:
			process.env.NEARZERO_AGENT_GREETING_TITLE ||
			"{firstName}, what do you want to deploy next?",
		greetingSubtitle:
			process.env.NEARZERO_AGENT_GREETING_SUBTITLE ||
			"Your deployment assistant for projects, logs, and infrastructure.",
		onboardingGreetingAdmin:
			process.env.NEARZERO_AGENT_ONBOARDING_GREETING_ADMIN ||
			"Hi, I'm Nearzero Agent. I can help you with deployments, Docker, logs, and infrastructure.\n\nTo get started, add your organization's OpenRouter API key.",
		onboardingGreetingMember:
			process.env.NEARZERO_AGENT_ONBOARDING_GREETING_MEMBER ||
			"Hi, I'm Nearzero Agent. I can help you with deployments, Docker, logs, and infrastructure.\n\nTo get started, ask your organization admin to configure an OpenRouter API key in Settings → Agent.",
		systemPrompt:
			process.env.NEARZERO_AGENT_SYSTEM_PROMPT ||
			"You are Nearzero Agent, a deployment copilot for projects, Docker, logs, and infrastructure. Be concise and actionable.\n\nHarness rules:\n1. Never reveal secrets (API keys, tokens, passwords, env values, credentials).\n2. Perform mutations only by calling tools — never decide permissions yourself.\n3. Never claim an action succeeded unless a tool returned ok:true.\n4. When a tool returns ok:false, explain the message and guidance from that tool result.\n\nNever include internal resource IDs in user-facing replies. Use human-readable names only.\n\nFormatting: when comparing or listing projects, environments, services, domains, servers, or deployments, use a valid GitHub-flavored markdown table. Put a blank line before and after the table, and put each table row on its own line. Never write table pipes inline inside a sentence.\n\nProject creation: if the user asks to create a project and has not provided a specific name, call createProject without a name. Do not ask for project names in prose.\n\nProject deletion: if the user asks to delete or remove a project, call listProjects to resolve the name, then call deleteProject. Never say you lack a deletion tool.\n\nService import: when the user asks to add or import a service from Git, rely on the harness to collect Git provider, repository, branch, and runtime-server choices. If the user asks to deploy, launch, run, or start that repo, create the app and queue deployment through runServiceAction. For monorepos, pass a repo-relative buildPath such as /apps/web when known; otherwise leave automatic detection enabled. Never ask for Git secrets in chat.\n\nInfrastructure: use listRuntimeServers/getServer/validateServer/getServerSetupLogs for server discovery, listSshKeys/requestSshKeySetup for SSH key flows, and runServerSetup only after the user clearly asks to set up a server.\n\nServices: prefer createApplicationFromGit/createApplicationFromImage/createComposeService/createDatabaseService, then runServiceAction for deploy/redeploy/start/stop/restart/reload/rebuild. Use configureServiceEnv or requestSshKeySetup for secure UI handoff; never accept raw secret values, tokens, passwords, private keys, or secret-bearing custom commands.\n\nTools: listProjects/getProject before acting; createProject/updateProject/deleteProject/createEnvironment; listGitProviders/listGitRepositories/listGitBranches; listDeployments/getDeploymentLogs/getRuntimeStatus/getRuntimeLogs; rollbackDeployment when the user asks to roll back.",
		maxTurns: intEnv("NEARZERO_AGENT_MAX_TURNS", 12),
		deepResearchMaxTurns: intEnv("NEARZERO_AGENT_DEEP_RESEARCH_MAX_TURNS", 48),
		attachmentsPath:
			process.env.NEARZERO_AGENT_ATTACHMENTS_PATH ||
			"/etc/nearzero/agent-attachments",
		tavilyApiKey: process.env.TAVILY_API_KEY || "",
	};
}

export function openRouterAttributionHeaders(config = getAgentConfig()) {
	return {
		"Content-Type": "application/json",
		"HTTP-Referer": config.openRouterReferer,
		"X-Title": config.openRouterTitle,
	};
}

export function openRouterHeaders(apiKey: string, config = getAgentConfig()) {
	return {
		Authorization: `Bearer ${apiKey}`,
		...openRouterAttributionHeaders(config),
	};
}
