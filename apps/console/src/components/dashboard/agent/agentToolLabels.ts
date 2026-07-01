const LABELS: Record<string, string> = {
	listProjects: "Reading projects",
	getProject: "Reading project",
	getEnvironment: "Reading environment",
	getService: "Reading service",
	listDeployments: "Reading deployments",
	listRuntimeServers: "Reading servers",
	getServer: "Reading server",
	validateServer: "Validating server",
	getServerSetupLogs: "Reading setup logs",
	listSshKeys: "Reading SSH keys",
	requestSshKeySetup: "Preparing SSH key handoff",
	createServer: "Creating server",
	runServerSetup: "Setting up server",
	runServerSecurityAudit: "Auditing server",
	listGitProviders: "Reading Git providers",
	listGitRepositories: "Reading repositories",
	listGitBranches: "Reading branches",
	createProject: "Creating project",
	updateProject: "Updating project",
	deleteProject: "Deleting project",
	createEnvironment: "Creating environment",
	createApplicationFromGit: "Importing Git application",
	createApplicationFromImage: "Creating image application",
	createComposeService: "Creating compose service",
	createDatabaseService: "Creating database service",
	assignDomainToService: "Assigning domain",
	configureApplicationSource: "Configuring source",
	configureApplicationBuild: "Configuring build",
	configureServicePorts: "Configuring ports",
	configureServiceEnv: "Preparing secure env handoff",
	configureServiceMounts: "Configuring mounts",
	runServiceAction: "Running service action",
	rollbackDeployment: "Rolling back deployment",
	getRuntimeStatus: "Checking runtime",
	getRuntimeLogs: "Reading runtime logs",
	getDeploymentLogs: "Reading logs",
	suggest: "Preparing deployment options",
	deploy: "Creating service",
	runDeployment: "Starting deployment",
	webSearch: "Searching the web",
	analyzeLogs: "Analyzing logs",
};

export function activityFromToolEvent(detail?: string, toolName?: string) {
	if (toolName && LABELS[toolName]) return LABELS[toolName];
	if (!detail) return "Working";
	const match = detail.match(/^Running\s+([A-Za-z0-9_]+)/i);
	if (match?.[1] && LABELS[match[1]]) return LABELS[match[1]];
	return detail.replace(/\.\.\.$/, "").replace(/^Running\s+/i, "");
}
