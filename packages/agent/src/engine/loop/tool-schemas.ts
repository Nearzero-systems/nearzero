const serviceTypes = [
	"application",
	"compose",
	"postgres",
	"mysql",
	"mongo",
	"redis",
	"mariadb",
	"libsql",
] as const;

const databaseServiceTypes = [
	"postgres",
	"mysql",
	"mongo",
	"redis",
	"mariadb",
	"libsql",
] as const;

const gitProviderTypes = ["github", "gitlab", "bitbucket", "gitea"] as const;

const serviceReferenceProperties = {
	serviceType: { type: "string", enum: serviceTypes },
	serviceId: { type: "string" },
};

export const agentToolDefinitions = [
	{
		type: "function" as const,
		function: {
			name: "listProjects",
			description:
				"List projects in the current organization with environments and services. Call this first to discover projectId and environmentId values.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getProject",
			description: "Get one project by projectId, including environments and services.",
			parameters: {
				type: "object",
				properties: { projectId: { type: "string" } },
				required: ["projectId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getEnvironment",
			description:
				"Get one environment by environmentId, including services and whether it is production.",
			parameters: {
				type: "object",
				properties: { environmentId: { type: "string" } },
				required: ["environmentId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getService",
			description:
				"Get one service by type and ID, with recent deployments where available.",
			parameters: {
				type: "object",
				properties: serviceReferenceProperties,
				required: ["serviceType", "serviceId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "createProject",
			description:
				"Create a new project with a default development environment. Omit name if the user did not specify an exact project name.",
			parameters: {
				type: "object",
				properties: { name: { type: "string" }, description: { type: "string" } },
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "updateProject",
			description:
				"Update project name or description. Do not use this for secrets or environment variables.",
			parameters: {
				type: "object",
				properties: {
					projectId: { type: "string" },
					name: { type: "string" },
					description: { type: "string" },
				},
				required: ["projectId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "deleteProject",
			description:
				"Delete a development project entirely after resolving the intended project.",
			parameters: {
				type: "object",
				properties: { projectId: { type: "string" } },
				required: ["projectId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "createEnvironment",
			description: "Create an environment inside an existing project.",
			parameters: {
				type: "object",
				properties: {
					projectId: { type: "string" },
					name: { type: "string" },
					description: { type: "string" },
				},
				required: ["projectId", "name"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "listDeployments",
			description:
				"List recent deployment records for an application, compose, or database service.",
			parameters: {
				type: "object",
				properties: {
					...serviceReferenceProperties,
					limit: { type: "number" },
				},
				required: ["serviceType", "serviceId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getDeploymentLogs",
			description: "Read deployment log tail text by deploymentId.",
			parameters: {
				type: "object",
				properties: {
					deploymentId: { type: "string" },
					tail: { type: "number" },
				},
				required: ["deploymentId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "listRuntimeServers",
			description: "List ready runtime servers the agent may target.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getServer",
			description: "Get one runtime server without exposing private SSH key data.",
			parameters: {
				type: "object",
				properties: { serverId: { type: "string" } },
				required: ["serverId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "validateServer",
			description: "Run server validation checks for Docker, Swarm, build tools, and Nearzero paths.",
			parameters: {
				type: "object",
				properties: { serverId: { type: "string" } },
				required: ["serverId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getServerSetupLogs",
			description: "Read recent setup logs for a runtime server.",
			parameters: {
				type: "object",
				properties: {
					serverId: { type: "string" },
					tail: { type: "number" },
				},
				required: ["serverId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "listSshKeys",
			description: "List saved SSH keys by name and fingerprint. Never returns private keys.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
	{
		type: "function" as const,
		function: {
			name: "requestSshKeySetup",
			description:
				"Request secure UI handoff for adding an SSH key. Do not ask the user for private keys in chat.",
			parameters: {
				type: "object",
				properties: { name: { type: "string" }, description: { type: "string" } },
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "createServer",
			description: "Create a runtime server using a saved SSH key ID.",
			parameters: {
				type: "object",
				properties: {
					name: { type: "string" },
					description: { type: "string" },
					ipAddress: { type: "string" },
					port: { type: "number" },
					username: { type: "string" },
					sshKeyId: { type: "string" },
				},
				required: ["name", "ipAddress", "sshKeyId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "runServerSetup",
			description: "Install and validate Docker, Swarm, Traefik, build tools, and monitoring on a runtime server.",
			parameters: {
				type: "object",
				properties: { serverId: { type: "string" } },
				required: ["serverId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "runServerSecurityAudit",
			description: "Run a server security audit through the existing server audit helper.",
			parameters: {
				type: "object",
				properties: { serverId: { type: "string" } },
				required: ["serverId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "listGitProviders",
			description: "List connected Git providers ready for service import.",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	},
	{
		type: "function" as const,
		function: {
			name: "listGitRepositories",
			description: "List repositories for a connected Git provider.",
			parameters: {
				type: "object",
				properties: { gitProviderId: { type: "string" } },
				required: ["gitProviderId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "listGitBranches",
			description: "List branches for a repository from a connected Git provider.",
			parameters: {
				type: "object",
				properties: {
					gitProviderId: { type: "string" },
					providerType: { type: "string", enum: gitProviderTypes },
					owner: { type: "string" },
					repository: { type: "string" },
					gitlabProjectId: { type: "number" },
					bitbucketRepositorySlug: { type: "string" },
				},
				required: ["gitProviderId", "providerType", "owner", "repository"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "createApplicationFromGit",
			description:
				"Create an application from a connected Git provider. Use saved provider IDs only; never request Git tokens. For monorepos, set buildPath to the selected app path and keep secrets out of custom commands.",
			parameters: {
				type: "object",
				properties: {
					environmentId: { type: "string" },
					gitProviderId: { type: "string" },
					providerType: { type: "string", enum: gitProviderTypes },
					owner: { type: "string" },
					repository: { type: "string" },
					branch: { type: "string" },
					name: { type: "string" },
					serverId: { type: "string" },
					gitlabProjectId: { type: "number" },
					gitlabPathNamespace: { type: "string" },
					bitbucketRepositorySlug: { type: "string" },
					buildPath: {
						type: "string",
						description:
							"Repo-relative app path such as /apps/web. Use / for repository root.",
					},
					buildType: {
						type: "string",
						enum: [
							"dockerfile",
							"heroku_buildpacks",
							"paketo_buildpacks",
							"nixpacks",
							"static",
							"railpack",
						],
					},
					buildSelectionMode: {
						type: "string",
						enum: ["automatic", "explicit"],
					},
					buildExecutionTarget: {
						type: "string",
						enum: ["deploy_server", "nearzero_host"],
					},
					customInstallCommand: {
						type: "string",
						description:
							"Optional non-secret install command override. Do not include tokens, passwords, or env values.",
					},
					customBuildCommand: {
						type: "string",
						description:
							"Optional non-secret build command override. Do not include tokens, passwords, or env values.",
					},
					customStartCommand: {
						type: "string",
						description:
							"Optional non-secret start command override. Do not include tokens, passwords, or env values.",
					},
				},
				required: [
					"environmentId",
					"gitProviderId",
					"providerType",
					"owner",
					"repository",
					"branch",
				],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "createApplicationFromImage",
			description: "Create an application from a Docker image.",
			parameters: {
				type: "object",
				properties: {
					environmentId: { type: "string" },
					name: { type: "string" },
					description: { type: "string" },
					dockerImage: { type: "string" },
					serverId: { type: "string" },
				},
				required: ["environmentId", "name", "dockerImage"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "createComposeService",
			description: "Create a compose service from raw Docker Compose YAML.",
			parameters: {
				type: "object",
				properties: {
					environmentId: { type: "string" },
					name: { type: "string" },
					description: { type: "string" },
					composeFile: { type: "string" },
					composeType: { type: "string", enum: ["docker-compose", "stack"] },
					serverId: { type: "string" },
				},
				required: ["environmentId", "name", "composeFile"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "createDatabaseService",
			description:
				"Create a database service using generated credentials. Do not pass passwords or secret values.",
			parameters: {
				type: "object",
				properties: {
					environmentId: { type: "string" },
					type: { type: "string", enum: databaseServiceTypes },
					name: { type: "string" },
					description: { type: "string" },
					dockerImage: { type: "string" },
					databaseName: { type: "string" },
					databaseUser: { type: "string" },
					serverId: { type: "string" },
				},
				required: ["environmentId", "type", "name"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "assignDomainToService",
			description: "Assign a hostname to an application or compose service.",
			parameters: {
				type: "object",
				properties: {
					serviceType: { type: "string", enum: ["application", "compose"] },
					serviceId: { type: "string" },
					host: { type: "string" },
					port: { type: "number" },
					https: { type: "boolean" },
					certificateType: { type: "string", enum: ["none", "letsencrypt", "custom"] },
					path: { type: "string" },
					dnsZoneId: { type: "string" },
					managedByNearzero: { type: "boolean" },
				},
				required: ["serviceType", "serviceId", "host", "port"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "configureApplicationSource",
			description: "Configure application source without accepting secrets.",
			parameters: {
				type: "object",
				properties: {
					applicationId: { type: "string" },
					sourceType: {
						type: "string",
						enum: ["docker", "git", "github", "gitlab", "bitbucket", "gitea"],
					},
					dockerImage: { type: "string" },
					registryUrl: { type: "string" },
					customGitUrl: { type: "string" },
					customGitBranch: { type: "string" },
					customGitBuildPath: { type: "string" },
					customGitSSHKeyId: { type: "string" },
					gitProviderId: { type: "string" },
					owner: { type: "string" },
					repository: { type: "string" },
					branch: { type: "string" },
					gitlabProjectId: { type: "number" },
					gitlabPathNamespace: { type: "string" },
					bitbucketRepositorySlug: { type: "string" },
					buildPath: { type: "string" },
					watchPaths: { type: "array", items: { type: "string" } },
					enableSubmodules: { type: "boolean" },
				},
				required: ["applicationId", "sourceType"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "configureApplicationBuild",
			description: "Configure application build type and build location.",
			parameters: {
				type: "object",
				properties: {
					applicationId: { type: "string" },
					buildType: {
						type: "string",
						enum: [
							"dockerfile",
							"heroku_buildpacks",
							"paketo_buildpacks",
							"nixpacks",
							"static",
							"railpack",
						],
					},
					buildExecutionTarget: {
						type: "string",
						enum: ["deploy_server", "nearzero_host"],
					},
					dockerfile: { type: "string" },
					dockerContextPath: { type: "string" },
					dockerBuildStage: { type: "string" },
					herokuVersion: { type: "string" },
					railpackVersion: { type: "string" },
					publishDirectory: { type: "string" },
					isStaticSpa: { type: "boolean" },
					command: { type: "string" },
				},
				required: ["applicationId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "configureServicePorts",
			description: "Configure an application port mapping.",
			parameters: {
				type: "object",
				properties: {
					...serviceReferenceProperties,
					targetPort: { type: "number" },
					publishedPort: { type: "number" },
					protocol: { type: "string", enum: ["tcp", "udp"] },
					publishMode: { type: "string", enum: ["ingress", "host"] },
				},
				required: ["serviceType", "serviceId", "targetPort", "publishedPort"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "configureServiceEnv",
			description:
				"Request secure UI handoff for service environment variables. Never accept env secret values in chat.",
			parameters: {
				type: "object",
				properties: serviceReferenceProperties,
				required: ["serviceType", "serviceId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "configureServiceMounts",
			description: "Configure bind or volume mount metadata. Do not pass file content or secrets.",
			parameters: {
				type: "object",
				properties: {
					...serviceReferenceProperties,
					type: { type: "string", enum: ["bind", "volume", "file"] },
					mountPath: { type: "string" },
					hostPath: { type: "string" },
					volumeName: { type: "string" },
					filePath: { type: "string" },
				},
				required: ["serviceType", "serviceId", "type", "mountPath"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "runServiceAction",
			description:
				"Run deploy, redeploy, start, stop, restart, reload, or rebuild against an existing service.",
			parameters: {
				type: "object",
				properties: {
					...serviceReferenceProperties,
					action: {
						type: "string",
						enum: ["deploy", "redeploy", "start", "stop", "restart", "reload", "rebuild"],
					},
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["serviceType", "serviceId", "action"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "rollbackDeployment",
			description: "Rollback an application deployment using a saved rollbackId.",
			parameters: {
				type: "object",
				properties: { rollbackId: { type: "string" } },
				required: ["rollbackId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getRuntimeStatus",
			description: "Compare registered service status with actual Docker Swarm service existence.",
			parameters: {
				type: "object",
				properties: serviceReferenceProperties,
				required: ["serviceType", "serviceId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "getRuntimeLogs",
			description: "Read runtime logs for an existing service.",
			parameters: {
				type: "object",
				properties: {
					...serviceReferenceProperties,
					tail: { type: "number" },
					since: { type: "string" },
					search: { type: "string" },
				},
				required: ["serviceType", "serviceId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "suggest",
			description: "Generate deployable Docker Compose suggestions for a user request.",
			parameters: {
				type: "object",
				properties: {
					input: { type: "string" },
					serverId: { type: "string" },
				},
				required: ["input"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "deploy",
			description:
				"Legacy alias: create a compose service in an environment from a suggestion. Prefer createComposeService, then runServiceAction.",
			parameters: {
				type: "object",
				properties: {
					environmentId: { type: "string" },
					id: { type: "string" },
					name: { type: "string" },
					description: { type: "string" },
					dockerCompose: { type: "string" },
					serverId: { type: "string" },
				},
				required: [
					"environmentId",
					"id",
					"name",
					"description",
					"dockerCompose",
				],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "runDeployment",
			description:
				"Legacy alias: queue a deployment run for an application or compose service. Prefer runServiceAction.",
			parameters: {
				type: "object",
				properties: {
					serviceType: { type: "string", enum: ["application", "compose"] },
					serviceId: { type: "string" },
					title: { type: "string" },
					description: { type: "string" },
				},
				required: ["serviceType", "serviceId"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "webSearch",
			description: "Search the web for deployment or infrastructure information.",
			parameters: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
		},
	},
	{
		type: "function" as const,
		function: {
			name: "analyzeLogs",
			description: "Analyze build or runtime logs and suggest fixes.",
			parameters: {
				type: "object",
				properties: {
					logs: { type: "string" },
					context: { type: "string", enum: ["build", "runtime"] },
				},
				required: ["logs"],
				additionalProperties: false,
			},
		},
	},
];

export const exposedToolNames = new Set(
	agentToolDefinitions.map((tool) => tool.function.name),
);
