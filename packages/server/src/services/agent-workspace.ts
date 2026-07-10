import { createHash } from "node:crypto";
import { db } from "@nearzero/server/db";
import {
	gitProvider as gitProviderTable,
	server as serverTable,
	sshKeys as sshKeysTable,
	type AuditAction,
	type AuditResourceType,
} from "@nearzero/server/db/schema";
import { TRPCError } from "@trpc/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { findOrganizationById, findUserById } from "./admin";
import {
	type AgentDeploymentJob,
	triggerAgentDeployment,
} from "./agent-deploy-trigger";
import { auditAgentAction } from "./agent-audit";
import {
	assertAgentPolicy,
	sanitizeAgentPolicyMetadata,
} from "./agent-policy";
import { AgentHarnessError } from "./agent-harness-errors";
import {
	assertRuntimePlacementPolicy,
	getReadyRuntimeServers,
	requiresRemoteRuntimeServer,
	RuntimePlacementPolicyError,
	type RuntimePlacementAction,
	type RuntimePlacementContext,
} from "./runtime-policy";
import {
	createApplication,
	findApplicationById,
	updateApplication,
	updateApplicationStatus,
} from "./application";
import {
	createCompose,
	findComposeById,
	updateCompose,
} from "./compose";
import {
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findDeploymentById,
	resolveDeploymentLogServerId,
	resolveServicePath,
} from "./deployment";
import { findDatabaseDeploymentsForService } from "./database-deployment";
import { createDomain } from "./domain";
import {
	ensureDefaultServiceDomain,
	previewServiceDomain,
} from "./managed-domain-provision";
import {
	DEFAULT_PROJECT_ENVIRONMENT_NAME,
	createEnvironment,
	findEnvironmentById,
	isProductionEnvironment,
} from "./environment";
import { createLibsql, deployLibsql, findLibsqlById, updateLibsqlById } from "./libsql";
import { createMariadb, deployMariadb, findMariadbById, updateMariadbById } from "./mariadb";
import { createMongo, deployMongo, findMongoById, updateMongoById } from "./mongo";
import { createMysql, deployMySql, findMySqlById, updateMySqlById } from "./mysql";
import { createPort } from "./port";
import { createPostgres, deployPostgres, findPostgresById, updatePostgresById } from "./postgres";
import {
	addNewEnvironment,
	addNewProject,
	addNewService,
	checkEnvironmentCreationPermission,
	checkEnvironmentAccess,
	checkPermission,
	checkProjectAccess,
	checkServiceAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
	type PermissionCtx,
} from "./permission";
import { createRedis, deployRedis, findRedisById, updateRedisById } from "./redis";
import {
	createProject,
	deleteProject,
	findProjectById,
	updateProjectById,
} from "./project";
import { createMount } from "./mount";
import { findRollbackById, rollback } from "./rollbacks";
import {
	queryAccessibleProject,
	queryAccessibleProjects,
	type ProjectAccessContext,
} from "./project-queries";
import {
	createServer,
	findServerById,
	findServersByUserId,
	getAccessibleServerIds,
} from "./server";
import { serverAudit } from "../setup/server-audit";
import { serverSetup } from "../setup/server-setup";
import { serverValidate } from "../setup/server-validate";
import { getContainerLogs } from "./docker";
import {
	startService,
	startServiceRemote,
	stopService,
	stopServiceRemote,
	swarmServiceExists,
} from "../utils/docker/utils";
import { rebuildDatabase } from "../utils/databases/rebuild";
import {
	getBitbucketBranches,
	getBitbucketRepositories,
} from "../utils/providers/bitbucket";
import {
	getGithubBranches,
	getGithubRepositories,
} from "../utils/providers/github";
import {
	getGiteaBranches,
	getGiteaRepositories,
} from "../utils/providers/gitea";
import {
	getGitlabBranches,
	getGitlabRepositories,
} from "../utils/providers/gitlab";
import { getAccessibleGitProviderIds } from "./git-provider";
import { execAsync, execAsyncRemote } from "../utils/process/execAsync";

export type AgentActorContext = {
	userId: string;
	organizationId: string;
	userEmail?: string;
	userRole?: string;
	threadId?: string | null;
};

export type AgentServiceType =
	| "application"
	| "compose"
	| "postgres"
	| "mysql"
	| "mongo"
	| "redis"
	| "mariadb"
	| "libsql";

async function assertAgentRuntimePlacement(
	actor: AgentActorContext,
	action: RuntimePlacementAction,
	context: RuntimePlacementContext,
) {
	try {
		return await assertRuntimePlacementPolicy(
			{
				organizationId: actor.organizationId,
				userId: actor.userId,
				userEmail: actor.userEmail ?? "Agent",
				userRole: actor.userRole ?? "agent",
				actorType: "agent",
			},
			action,
			context,
		);
	} catch (error) {
		if (error instanceof RuntimePlacementPolicyError) {
			throw new AgentHarnessError(
				"policy_deploy_server_required",
				error.message,
				error.guidance,
			);
		}
		throw error;
	}
}

const createProjectInputSchema = z.object({
	name: z.string().trim().min(1).max(255),
	description: z.string().optional(),
});

const updateProjectInputSchema = z.object({
	projectId: z.string().min(1),
	name: z.string().trim().min(1).max(255).optional(),
	description: z.string().optional(),
	env: z.string().optional(),
});

const deleteProjectInputSchema = z.object({
	projectId: z.string().min(1),
});

const readLogsInputSchema = z.object({
	deploymentId: z.string().min(1),
	tail: z.number().int().min(1).max(10_000).default(200),
});

const applicationBuildTypeSchema = z.enum([
	"dockerfile",
	"heroku_buildpacks",
	"paketo_buildpacks",
	"nixpacks",
	"static",
	"railpack",
]);

const buildExecutionTargetSchema = z.enum(["deploy_server", "nearzero_host"]);
const buildSelectionModeSchema = z.enum(["automatic", "explicit"]);

const runDeploymentInputSchema = z.object({
	serviceType: z.enum(["application", "compose"]),
	serviceId: z.string().min(1),
	title: z.string().optional(),
	description: z.string().optional(),
});

const importGitApplicationInputSchema = z.object({
	environmentId: z.string().min(1),
	gitProviderId: z.string().min(1),
	repository: z.string().min(1),
	owner: z.string().min(1),
	branch: z.string().min(1),
	name: z.string().min(1).max(255).optional(),
	serverId: z.string().optional(),
	providerType: z.enum(["github", "gitlab", "bitbucket", "gitea"]),
	gitlabProjectId: z.number().int().optional(),
	gitlabPathNamespace: z.string().optional(),
	bitbucketRepositorySlug: z.string().optional(),
	buildPath: z.string().trim().max(2048).optional(),
	buildType: applicationBuildTypeSchema.optional(),
	buildSelectionMode: buildSelectionModeSchema.optional(),
	buildExecutionTarget: buildExecutionTargetSchema.optional(),
	customInstallCommand: z.string().trim().max(4096).optional(),
	customBuildCommand: z.string().trim().max(4096).optional(),
	customStartCommand: z.string().trim().max(4096).optional(),
});

const serviceTypeSchema = z.enum([
	"application",
	"compose",
	"postgres",
	"mysql",
	"mongo",
	"redis",
	"mariadb",
	"libsql",
]);

const databaseServiceTypeSchema = z.enum([
	"postgres",
	"mysql",
	"mongo",
	"redis",
	"mariadb",
	"libsql",
]);

const serviceActionSchema = z.enum([
	"deploy",
	"redeploy",
	"start",
	"stop",
	"restart",
	"reload",
	"rebuild",
]);

const createEnvironmentInputSchema = z.object({
	projectId: z.string().min(1),
	name: z.string().trim().min(1).max(255),
	description: z.string().optional(),
});

const createImageApplicationInputSchema = z.object({
	environmentId: z.string().min(1),
	name: z.string().trim().min(1).max(255),
	description: z.string().optional(),
	dockerImage: z.string().trim().min(1),
	serverId: z.string().optional(),
});

const createComposeServiceInputSchema = z.object({
	environmentId: z.string().min(1),
	name: z.string().trim().min(1).max(255),
	description: z.string().optional(),
	composeFile: z.string().min(1),
	composeType: z.enum(["docker-compose", "stack"]).default("docker-compose"),
	serverId: z.string().optional(),
});

const createDatabaseServiceInputSchema = z.object({
	environmentId: z.string().min(1),
	type: databaseServiceTypeSchema,
	name: z.string().trim().min(1).max(255),
	description: z.string().optional(),
	dockerImage: z.string().trim().optional(),
	databaseName: z.string().trim().optional(),
	databaseUser: z.string().trim().optional(),
	serverId: z.string().optional(),
});

const assignDomainInputSchema = z.object({
	serviceType: z.enum(["application", "compose"]),
	serviceId: z.string().min(1),
	host: z.string().trim().min(1),
	port: z.number().int().min(1).max(65535),
	https: z.boolean().optional(),
	certificateType: z.enum(["none", "letsencrypt", "custom"]).optional(),
	path: z.string().optional(),
	dnsZoneId: z.string().optional(),
	managedByNearzero: z.boolean().optional(),
});

const configureApplicationSourceInputSchema = z.object({
	applicationId: z.string().min(1),
	sourceType: z.enum(["docker", "git", "github", "gitlab", "bitbucket", "gitea"]),
	dockerImage: z.string().optional(),
	registryUrl: z.string().optional(),
	customGitUrl: z.string().optional(),
	customGitBranch: z.string().optional(),
	customGitBuildPath: z.string().optional(),
	customGitSSHKeyId: z.string().optional(),
	gitProviderId: z.string().optional(),
	owner: z.string().optional(),
	repository: z.string().optional(),
	branch: z.string().optional(),
	gitlabProjectId: z.number().int().optional(),
	gitlabPathNamespace: z.string().optional(),
	bitbucketRepositorySlug: z.string().optional(),
	buildPath: z.string().optional(),
	watchPaths: z.array(z.string()).optional(),
	enableSubmodules: z.boolean().optional(),
});

const configureApplicationBuildInputSchema = z.object({
	applicationId: z.string().min(1),
	buildType: applicationBuildTypeSchema.optional(),
	buildExecutionTarget: buildExecutionTargetSchema.optional(),
	dockerfile: z.string().optional(),
	dockerContextPath: z.string().optional(),
	dockerBuildStage: z.string().optional(),
	herokuVersion: z.string().optional(),
	railpackVersion: z.string().optional(),
	publishDirectory: z.string().optional(),
	isStaticSpa: z.boolean().optional(),
	command: z.string().optional(),
});

const configureServicePortsInputSchema = z.object({
	serviceType: serviceTypeSchema,
	serviceId: z.string().min(1),
	targetPort: z.number().int().min(1).max(65535),
	publishedPort: z.number().int().min(1).max(65535),
	protocol: z.enum(["tcp", "udp"]).default("tcp"),
	publishMode: z.enum(["ingress", "host"]).default("ingress"),
});

const configureServiceMountsInputSchema = z.object({
	serviceType: serviceTypeSchema,
	serviceId: z.string().min(1),
	type: z.enum(["bind", "volume", "file"]),
	mountPath: z.string().min(1),
	hostPath: z.string().optional(),
	volumeName: z.string().optional(),
	filePath: z.string().optional(),
	content: z.string().optional(),
});

const serviceReferenceInputSchema = z.object({
	serviceType: serviceTypeSchema,
	serviceId: z.string().min(1),
});

const runServiceActionInputSchema = serviceReferenceInputSchema.extend({
	action: serviceActionSchema,
	title: z.string().optional(),
	description: z.string().optional(),
});

const runtimeLogsInputSchema = serviceReferenceInputSchema.extend({
	tail: z.number().int().min(1).max(10_000).default(200),
	since: z.string().default("all"),
	search: z.string().optional(),
});

const createServerInputSchema = z.object({
	name: z.string().trim().min(1).max(255),
	description: z.string().optional(),
	ipAddress: z.string().trim().min(1),
	port: z.number().int().min(1).max(65535).default(22),
	username: z.string().trim().min(1).default("root"),
	sshKeyId: z.string().min(1),
});

const serverIdInputSchema = z.object({
	serverId: z.string().min(1),
});

const rollbackDeploymentInputSchema = z.object({
	rollbackId: z.string().min(1),
});

type AgentGitProviderType = "github" | "gitlab" | "bitbucket" | "gitea";

function hasText(value: unknown) {
	return typeof value === "string" && value.trim().length > 0;
}

const COMMAND_SECRET_VALUE_PATTERN =
	/(^|\s)([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Z0-9_]*=|sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;

function commandInputContainsSecret(...values: Array<string | undefined>) {
	return values.some(
		(value) => typeof value === "string" && COMMAND_SECRET_VALUE_PATTERN.test(value),
	);
}

function normalizeAgentBuildPath(value?: string) {
	const trimmed = value?.trim() || "/";
	const normalized =
		trimmed === "." ? "/" : trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
	const segments = normalized.split("/").filter(Boolean);
	if (segments.includes("..")) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Build path cannot include '..' segments.",
		});
	}
	return `/${segments.join("/")}` || "/";
}

function isAgentImportGitProviderReady(provider: {
	providerType: string;
	github?: {
		githubAppId?: number | null;
		githubPrivateKey?: string | null;
		githubInstallationId?: string | null;
	} | null;
	gitlab?: {
		accessToken?: string | null;
		refreshToken?: string | null;
	} | null;
	bitbucket?: {
		apiToken?: string | null;
		bitbucketEmail?: string | null;
		bitbucketUsername?: string | null;
		appPassword?: string | null;
	} | null;
	gitea?: {
		accessToken?: string | null;
		refreshToken?: string | null;
		clientId?: string | null;
		clientSecret?: string | null;
	} | null;
}) {
	if (provider.providerType === "github") {
		return Boolean(
			provider.github?.githubAppId &&
				hasText(provider.github.githubPrivateKey) &&
				hasText(provider.github.githubInstallationId),
		);
	}
	if (provider.providerType === "gitlab") {
		return Boolean(
			hasText(provider.gitlab?.accessToken) &&
				hasText(provider.gitlab?.refreshToken),
		);
	}
	if (provider.providerType === "bitbucket") {
		return Boolean(
			(hasText(provider.bitbucket?.apiToken) &&
				hasText(provider.bitbucket?.bitbucketEmail)) ||
				(hasText(provider.bitbucket?.bitbucketUsername) &&
					hasText(provider.bitbucket?.appPassword)),
		);
	}
	if (provider.providerType === "gitea") {
		return Boolean(
			hasText(provider.gitea?.clientId) &&
				hasText(provider.gitea?.clientSecret) &&
				(hasText(provider.gitea?.accessToken) ||
					hasText(provider.gitea?.refreshToken)),
		);
	}
	return false;
}

export function buildAgentPermissionCtx(actor: AgentActorContext): PermissionCtx {
	return {
		user: { id: actor.userId },
		session: { activeOrganizationId: actor.organizationId },
	};
}

function toProjectAccessContext(actor: AgentActorContext): ProjectAccessContext {
	return {
		userId: actor.userId,
		organizationId: actor.organizationId,
		userRole: actor.userRole,
	};
}

export async function auditAgentMutation(
	actor: AgentActorContext,
	event: {
		action: AuditAction;
		resourceType: AuditResourceType;
		resourceId?: string;
		resourceName?: string;
		metadata?: Record<string, unknown>;
	},
) {
	await auditAgentAction({
		organizationId: actor.organizationId,
		userId: actor.userId,
		userEmail: actor.userEmail ?? "agent@nearzero.local",
		userRole: actor.userRole ?? "member",
		threadId: actor.threadId,
		...event,
		metadata: sanitizeAgentPolicyMetadata(event.metadata ?? {}) as Record<
			string,
			unknown
		>,
	});
}

function redactEnv(value: unknown) {
	if (typeof value === "string" && value.trim().length > 0) {
		return "[redacted]";
	}
	return value;
}

export function sanitizeProjectTree<T extends Record<string, unknown>>(project: T) {
	const copy = structuredClone(project) as Record<string, unknown>;
	if ("env" in copy) {
		copy.env = redactEnv(copy.env);
	}
	if (Array.isArray(copy.environments)) {
		copy.environments = copy.environments.map((env) => {
			const envCopy = { ...(env as Record<string, unknown>) };
			if ("env" in envCopy) {
				envCopy.env = redactEnv(envCopy.env);
			}
			return envCopy;
		});
	}
	return copy;
}

function normalizeService(
	serviceType: AgentServiceType,
	row: Record<string, unknown>,
	environmentId: string,
	projectId: string,
) {
	const idKey =
		serviceType === "application"
			? "applicationId"
			: serviceType === "compose"
				? "composeId"
				: `${serviceType}Id`;
	const serviceId = String(row[idKey] ?? "");
	const name = String(row.name ?? row.appName ?? serviceId);
	const status = String(
		row.applicationStatus ?? row.composeStatus ?? row.status ?? "unknown",
	);
	return {
		serviceType,
		serviceId,
		name,
		status,
		environmentId,
		projectId,
	};
}

export async function listAccessibleProjects(actor: AgentActorContext) {
	const rows = await queryAccessibleProjects(toProjectAccessContext(actor));
	return rows.map((project) => sanitizeProjectTree(project));
}

export async function getAccessibleProject(
	actor: AgentActorContext,
	projectId: string,
) {
	const project = await queryAccessibleProject(
		toProjectAccessContext(actor),
		projectId,
	);
	return sanitizeProjectTree(project);
}

export async function getAccessibleEnvironment(
	actor: AgentActorContext,
	environmentId: string,
) {
	await checkEnvironmentAccess(buildAgentPermissionCtx(actor), environmentId, "read");
	const environment = await findEnvironmentById(environmentId);
	if (environment.project.organizationId !== actor.organizationId) {
		throw new TRPCError({
			code: "FORBIDDEN",
			message: "You are not allowed to access this environment",
		});
	}
	const sanitized = sanitizeProjectTree(
		environment as unknown as Record<string, unknown>,
	);
	return {
		...sanitized,
		isProduction: isProductionEnvironment(environment),
		projectId: environment.projectId,
	};
}

async function loadServiceRecord(serviceType: AgentServiceType, serviceId: string) {
	switch (serviceType) {
		case "application":
			return findApplicationById(serviceId);
		case "compose":
			return findComposeById(serviceId);
		case "postgres":
			return findPostgresById(serviceId);
		case "mysql":
			return findMySqlById(serviceId);
		case "mongo":
			return findMongoById(serviceId);
		case "redis":
			return findRedisById(serviceId);
		case "mariadb":
			return findMariadbById(serviceId);
		case "libsql":
			return findLibsqlById(serviceId);
		default:
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Unsupported service type: ${serviceType}`,
			});
	}
}

type LoadedAgentService = Awaited<ReturnType<typeof loadServiceRecord>>;

function serviceAuditName(service: LoadedAgentService) {
	return String(
		(service as unknown as { appName?: string; name?: string }).appName ??
			(service as unknown as { name?: string }).name ??
			"service",
	);
}

function serviceAppName(service: LoadedAgentService) {
	const appName = (service as unknown as { appName?: string }).appName;
	if (!appName) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Service does not have a runtime app name.",
		});
	}
	return appName;
}

function serviceServerId(service: LoadedAgentService) {
	return (service as unknown as { serverId?: string | null }).serverId ?? null;
}

function serviceEnvironment(service: LoadedAgentService) {
	return service.environment;
}

function serviceDatabaseType(serviceType: AgentServiceType) {
	if (serviceType === "application" || serviceType === "compose") return null;
	return serviceType;
}

function defaultDatabaseImage(serviceType: z.infer<typeof databaseServiceTypeSchema>) {
	switch (serviceType) {
		case "postgres":
			return "postgres:17";
		case "mysql":
			return "mysql:8";
		case "mongo":
			return "mongo:8";
		case "redis":
			return "redis:8";
		case "mariadb":
			return "mariadb:11";
		case "libsql":
			return "ghcr.io/tursodatabase/libsql-server:latest";
	}
}

function databaseId(
	serviceType: z.infer<typeof databaseServiceTypeSchema>,
	service: Record<string, unknown>,
) {
	const key = `${serviceType}Id`;
	const id = service[key];
	if (typeof id !== "string" || id.length === 0) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: "Created database service did not return an ID.",
		});
	}
	return id;
}

async function assertServiceBelongsToActor(
	actor: AgentActorContext,
	service: LoadedAgentService,
) {
	if (serviceEnvironment(service).project.organizationId !== actor.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this service",
		});
	}
}

async function loadAgentServiceContext(
	actor: AgentActorContext,
	input: { serviceType: AgentServiceType; serviceId: string },
) {
	const service = await loadServiceRecord(input.serviceType, input.serviceId);
	await assertServiceBelongsToActor(actor, service);
	const environment = serviceEnvironment(service);
	return {
		service,
		appName: serviceAppName(service),
		name: serviceAuditName(service),
		serverId: serviceServerId(service),
		environmentId: environment.environmentId,
		projectId: environment.projectId,
		organizationId: environment.project.organizationId,
	};
}

async function assertAccessibleServer(
	actor: AgentActorContext,
	serverId: string,
) {
	const accessibleServers = await getAccessibleServerIds({
		userId: actor.userId,
		activeOrganizationId: actor.organizationId,
	});
	if (!accessibleServers.has(serverId)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this server.",
		});
	}
	const server = await findServerById(serverId);
	if (server.organizationId !== actor.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You are not authorized to access this server.",
		});
	}
	return server;
}

function fingerprintPublicKey(publicKey: string) {
	const digest = createHash("sha256")
		.update(publicKey.trim())
		.digest("base64")
		.replace(/=+$/g, "");
	return `SHA256:${digest}`;
}

async function deployDatabaseService(serviceType: AgentServiceType, serviceId: string) {
	switch (serviceType) {
		case "postgres":
			return deployPostgres(serviceId);
		case "mysql":
			return deployMySql(serviceId);
		case "mongo":
			return deployMongo(serviceId);
		case "redis":
			return deployRedis(serviceId);
		case "mariadb":
			return deployMariadb(serviceId);
		case "libsql":
			return deployLibsql(serviceId);
		default:
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Unsupported database service type: ${serviceType}`,
			});
	}
}

async function updateServiceStatus(
	serviceType: AgentServiceType,
	serviceId: string,
	status: "idle" | "running" | "done" | "error",
) {
	switch (serviceType) {
		case "application":
			await updateApplicationStatus(serviceId, status);
			return;
		case "compose":
			await updateCompose(serviceId, { composeStatus: status });
			return;
		case "postgres":
			await updatePostgresById(serviceId, { applicationStatus: status });
			return;
		case "mysql":
			await updateMySqlById(serviceId, { applicationStatus: status });
			return;
		case "mongo":
			await updateMongoById(serviceId, { applicationStatus: status });
			return;
		case "redis":
			await updateRedisById(serviceId, { applicationStatus: status });
			return;
		case "mariadb":
			await updateMariadbById(serviceId, { applicationStatus: status });
			return;
		case "libsql":
			await updateLibsqlById(serviceId, { applicationStatus: status });
			return;
		default:
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: `Unsupported service type: ${serviceType}`,
			});
	}
}

export async function getAccessibleService(
	actor: AgentActorContext,
	input: { serviceType: AgentServiceType; serviceId: string },
) {
	await checkServiceAccess(buildAgentPermissionCtx(actor), input.serviceId, "read");
	const service = await loadServiceRecord(input.serviceType, input.serviceId);
	const environment = service.environment;
	if (environment.project.organizationId !== actor.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this service",
		});
	}
	const path = await resolveServicePath(actor.organizationId, {
		...(input.serviceType === "application"
			? { applicationId: input.serviceId }
			: input.serviceType === "compose"
				? { composeId: input.serviceId }
				: {}),
	});
	const deploymentRows =
		input.serviceType === "compose"
			? await findAllDeploymentsByComposeId(input.serviceId)
			: input.serviceType === "application"
				? await findAllDeploymentsByApplicationId(input.serviceId)
				: [];
	return {
		service: normalizeService(
			input.serviceType,
			service as unknown as Record<string, unknown>,
			environment.environmentId,
			environment.projectId,
		),
		environmentId: environment.environmentId,
		projectId: environment.projectId,
		isProduction: isProductionEnvironment(environment),
		href: path.href,
		recentDeployments: deploymentRows.slice(0, 5).map((deployment) => ({
			deploymentId: deployment.deploymentId,
			status: deployment.status,
			title: deployment.title,
			createdAt: deployment.createdAt,
			logPath: deployment.logPath,
		})),
	};
}

export async function listServiceDeployments(
	actor: AgentActorContext,
	input: { serviceType: AgentServiceType; serviceId: string; limit?: number },
) {
	await checkServicePermissionAndAccess(
		buildAgentPermissionCtx(actor),
		input.serviceId,
		{ deployment: ["read"] },
	);
	const service = await loadServiceRecord(input.serviceType, input.serviceId);
	if (service.environment.project.organizationId !== actor.organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You don't have access to this service",
		});
	}
	const limit = input.limit ?? 5;
	const rows =
		input.serviceType === "compose"
			? await findAllDeploymentsByComposeId(input.serviceId)
			: input.serviceType === "application"
				? await findAllDeploymentsByApplicationId(input.serviceId)
				: await findDatabaseDeploymentsForService(input.serviceId);
	return rows.slice(0, limit).map((deployment) => ({
		deploymentId: deployment.deploymentId,
		status: deployment.status,
		title: deployment.title,
		createdAt: deployment.createdAt,
		logPath: deployment.logPath,
	}));
}

function slugifyServiceName(value: string) {
	return (
		value
			.trim()
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 48) || "service"
	);
}

async function loadAccessibleGitProvider(
	actor: AgentActorContext,
	gitProviderId: string,
) {
	const accessibleIds = await getAccessibleGitProviderIds({
		userId: actor.userId,
		activeOrganizationId: actor.organizationId,
	});
	if (!accessibleIds.has(gitProviderId)) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You do not have access to this Git provider.",
		});
	}
	const provider = await db.query.gitProvider.findFirst({
		where: eq(gitProviderTable.gitProviderId, gitProviderId),
		with: {
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
		},
	});
	if (!provider || provider.organizationId !== actor.organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Git provider not found.",
		});
	}
	return provider;
}

export async function listAgentImportGitProviders(actor: AgentActorContext) {
	await assertAgentPolicy(actor, "agent.service.importGit", {
		resourceType: "gitProvider",
		resourceName: "git-provider-list",
	});
	const accessibleIds = await getAccessibleGitProviderIds({
		userId: actor.userId,
		activeOrganizationId: actor.organizationId,
	});
	if (accessibleIds.size === 0) return [];

	const rows = await db.query.gitProvider.findMany({
		where: inArray(gitProviderTable.gitProviderId, [...accessibleIds]),
		with: {
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
		},
	});

	return rows
		.filter(
			(provider) =>
				provider.organizationId === actor.organizationId &&
				isAgentImportGitProviderReady(provider),
		)
		.map((provider) => ({
			gitProviderId: provider.gitProviderId,
			name: provider.name,
			providerType: provider.providerType as AgentGitProviderType,
		}));
}

export async function listAgentImportRepositories(
	actor: AgentActorContext,
	input: { gitProviderId: string },
) {
	await assertAgentPolicy(actor, "agent.service.importGit", {
		resourceType: "gitProvider",
		resourceId: input.gitProviderId,
		resourceName: "git-provider-repositories",
	});
	const provider = await loadAccessibleGitProvider(actor, input.gitProviderId);
	if (provider.providerType === "github" && provider.github) {
		const repos = await getGithubRepositories(provider.github.githubId);
		return repos.map((repo) => ({
			label: `${repo.owner.login}/${repo.name}`,
			value: JSON.stringify({
				providerType: "github",
				owner: repo.owner.login,
				repository: repo.name,
				defaultBranch: repo.default_branch || "",
			}),
			description: repo.private ? "Private repository" : "Public repository",
		}));
	}
	if (provider.providerType === "gitlab" && provider.gitlab) {
		const repos = await getGitlabRepositories(provider.gitlab.gitlabId);
		return repos.map((repo) => ({
			label: repo.url,
			value: JSON.stringify({
				providerType: "gitlab",
				owner: repo.owner.username,
				repository: repo.name,
				gitlabProjectId: repo.id,
				gitlabPathNamespace: repo.url,
			}),
		}));
	}
	if (provider.providerType === "bitbucket" && provider.bitbucket) {
		const repos = await getBitbucketRepositories(provider.bitbucket.bitbucketId);
		return repos.map((repo) => ({
			label: `${repo.owner.username}/${repo.name}`,
			value: JSON.stringify({
				providerType: "bitbucket",
				owner: repo.owner.username,
				repository: repo.name,
				bitbucketRepositorySlug: repo.slug || repo.name,
			}),
		}));
	}
	if (provider.providerType === "gitea" && provider.gitea) {
		const repos = await getGiteaRepositories(provider.gitea.giteaId);
		return repos.map((repo) => ({
			label: repo.url,
			value: JSON.stringify({
				providerType: "gitea",
				owner: repo.owner.username,
				repository: repo.name,
			}),
		}));
	}
	return [];
}

export async function listAgentImportBranches(
	actor: AgentActorContext,
	input: {
		gitProviderId: string;
		providerType: AgentGitProviderType;
		owner: string;
		repository: string;
		gitlabProjectId?: number;
		bitbucketRepositorySlug?: string;
	},
) {
	await assertAgentPolicy(actor, "agent.service.importGit", {
		resourceType: "gitProvider",
		resourceId: input.gitProviderId,
		resourceName: `${input.owner}/${input.repository}`,
		auditMetadata: {
			providerType: input.providerType,
			repository: `${input.owner}/${input.repository}`,
		},
	});
	const provider = await loadAccessibleGitProvider(actor, input.gitProviderId);
	if (provider.providerType !== input.providerType) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Git provider type changed. Start the import again.",
		});
	}
	if (provider.providerType === "github" && provider.github) {
		const branches = await getGithubBranches({
			githubId: provider.github.githubId,
			owner: input.owner,
			repo: input.repository,
		});
		return branches.map((branch) => branch.name);
	}
	if (provider.providerType === "gitlab" && provider.gitlab) {
		const branches = await getGitlabBranches({
			gitlabId: provider.gitlab.gitlabId,
			owner: input.owner,
			repo: input.repository,
			id: input.gitlabProjectId,
		});
		return branches.map((branch) => branch.name);
	}
	if (provider.providerType === "bitbucket" && provider.bitbucket) {
		const branches = await getBitbucketBranches({
			bitbucketId: provider.bitbucket.bitbucketId,
			owner: input.owner,
			repo: input.bitbucketRepositorySlug || input.repository,
		});
		return branches.map((branch) => branch.name);
	}
	if (provider.providerType === "gitea" && provider.gitea) {
		const branches = await getGiteaBranches({
			giteaId: provider.gitea.giteaId,
			owner: input.owner,
			repo: input.repository,
		});
		return branches.map((branch) => branch.name);
	}
	return [];
}

export async function listAgentImportRuntimeServers(actor: AgentActorContext) {
	await assertAgentPolicy(actor, "agent.service.importGit", {
		resourceType: "server",
		resourceName: "server-list",
	});
	const accessibleIds = await getAccessibleServerIds({
		userId: actor.userId,
		activeOrganizationId: actor.organizationId,
	});
	if (accessibleIds.size === 0) {
		return { required: requiresRemoteRuntimeServer(), servers: [] };
	}
	const rows = await db.query.server.findMany({
		where: inArray(serverTable.serverId, [...accessibleIds]),
		columns: {
			serverId: true,
			name: true,
			ipAddress: true,
			serverStatus: true,
			setupStatus: true,
		},
	});
	const runtimeServers = rows.filter(
		(server) =>
			server.serverStatus === "active" &&
			(!requiresRemoteRuntimeServer() || server.setupStatus === "ready"),
	);
	return {
		required: requiresRemoteRuntimeServer(),
		servers: runtimeServers.map((server) => ({
			serverId: server.serverId,
			name: server.name,
			ipAddress: server.ipAddress ?? undefined,
			setupStatus: server.setupStatus,
		})),
	};
}

export async function listRuntimeServersForAgent(actor: AgentActorContext) {
	await checkPermission(buildAgentPermissionCtx(actor), { server: ["read"] });
	const accessibleIds = await getAccessibleServerIds({
		userId: actor.userId,
		activeOrganizationId: actor.organizationId,
	});
	if (accessibleIds.size === 0) {
		return { required: requiresRemoteRuntimeServer(), servers: [] };
	}
	const readyServers = await getReadyRuntimeServers(actor.organizationId);
	return {
		required: requiresRemoteRuntimeServer(),
		servers: readyServers
			.filter((server) => accessibleIds.has(server.serverId))
			.map((server) => ({
				serverId: server.serverId,
				name: server.name,
				ipAddress: server.ipAddress ?? undefined,
				port: server.port,
				setupStatus: server.setupStatus,
			})),
	};
}

export async function getServerForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof serverIdInputSchema>,
) {
	const parsed = serverIdInputSchema.parse(input);
	await checkPermission(buildAgentPermissionCtx(actor), { server: ["read"] });
	const server = await assertAccessibleServer(actor, parsed.serverId);
	return {
		serverId: server.serverId,
		name: server.name,
		description: server.description,
		ipAddress: server.ipAddress,
		port: server.port,
		username: server.username,
		serverStatus: server.serverStatus,
		setupStatus: server.setupStatus,
		setupError: server.setupError,
		setupStartedAt: server.setupStartedAt,
		setupFinishedAt: server.setupFinishedAt,
		sshKeyId: server.sshKeyId,
		sshKeyName: server.sshKey?.name ?? null,
	};
}

export async function validateServerForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof serverIdInputSchema>,
) {
	const parsed = serverIdInputSchema.parse(input);
	await checkPermission(buildAgentPermissionCtx(actor), { server: ["read"] });
	await assertAccessibleServer(actor, parsed.serverId);
	return serverValidate(parsed.serverId);
}

export async function getServerSetupLogsForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof serverIdInputSchema> & { tail?: number },
) {
	const parsed = serverIdInputSchema.extend({
		tail: z.number().int().min(1).max(10_000).default(300),
	}).parse(input);
	await checkPermission(buildAgentPermissionCtx(actor), { server: ["read"] });
	await assertAccessibleServer(actor, parsed.serverId);
	const deployments = await findAllDeploymentsByServerId(parsed.serverId);
	const setupDeployment = deployments
		.filter((deployment) => deployment.title === "Setup Server")
		.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
	if (!setupDeployment?.logPath) {
		return { serverId: parsed.serverId, deploymentId: null, logs: "" };
	}
	const command = `tail -n ${parsed.tail} "${setupDeployment.logPath}" 2>/dev/null || echo ""`;
	const { stdout } = await execAsyncRemote(parsed.serverId, command);
	return {
		serverId: parsed.serverId,
		deploymentId: setupDeployment.deploymentId,
		status: setupDeployment.status,
		logs: stdout,
	};
}

export async function listSshKeysForAgent(actor: AgentActorContext) {
	await checkPermission(buildAgentPermissionCtx(actor), { sshKeys: ["read"] });
	const rows = await db.query.sshKeys.findMany({
		where: eq(sshKeysTable.organizationId, actor.organizationId),
		columns: {
			sshKeyId: true,
			name: true,
			description: true,
			publicKey: true,
			createdAt: true,
			lastUsedAt: true,
		},
	});
	return rows.map((key) => ({
		sshKeyId: key.sshKeyId,
		name: key.name,
		description: key.description,
		fingerprint: fingerprintPublicKey(key.publicKey),
		createdAt: key.createdAt,
		lastUsedAt: key.lastUsedAt,
	}));
}

export async function requestSshKeySetupForAgent(
	actor: AgentActorContext,
	input: { name?: string; description?: string } = {},
) {
	await assertAgentPolicy(actor, "agent.service.setupSsh", {
		resourceType: "sshKey",
		resourceName: input.name || "ssh-key-setup",
	});
	await checkPermission(buildAgentPermissionCtx(actor), { sshKeys: ["create"] });
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "sshKey",
		resourceName: input.name || "ssh-key-setup-request",
		metadata: { requestedVia: "agent" },
	});
	return {
		ok: false as const,
		code: "secure_input_required",
		message:
			"SSH keys must be added through the secure SSH key UI. The agent cannot receive private keys.",
		guidance:
			"Open Infrastructure > Servers > SSH keys, add the key, then ask the agent to use the saved SSH key ID.",
	};
}

export async function createServerForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof createServerInputSchema>,
) {
	const parsed = createServerInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	await assertAgentPolicy(actor, "agent.server.create", {
		resourceType: "server",
		resourceName: parsed.name,
		auditMetadata: { ipAddress: parsed.ipAddress, port: parsed.port },
	});
	await checkPermission(permCtx, { server: ["create"] });
	const sshKey = await db.query.sshKeys.findFirst({
		where: eq(sshKeysTable.sshKeyId, parsed.sshKeyId),
		columns: { sshKeyId: true, organizationId: true, name: true },
	});
	if (!sshKey || sshKey.organizationId !== actor.organizationId) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Saved SSH key not found.",
		});
	}
	const organization = await findOrganizationById(actor.organizationId);
	if (!organization) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Organization not found",
		});
	}
	const created = await createServer(
		{
			...parsed,
			description: parsed.description ?? null,
			sshKeyId: parsed.sshKeyId,
		},
		actor.organizationId,
	);
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "server",
		resourceId: created.serverId,
		resourceName: created.name,
		metadata: { ipAddress: created.ipAddress, port: created.port },
	});
	return {
		ok: true as const,
		serverId: created.serverId,
		name: created.name,
		setupStatus: created.setupStatus,
	};
}

export async function runServerSetupForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof serverIdInputSchema>,
) {
	const parsed = serverIdInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	await assertAgentPolicy(actor, "agent.server.create", {
		resourceType: "server",
		resourceId: parsed.serverId,
		resourceName: "server-setup",
	});
	await checkPermission(permCtx, { server: ["create"] });
	const server = await assertAccessibleServer(actor, parsed.serverId);
	try {
		await serverSetup(parsed.serverId);
		await auditAgentMutation(actor, {
			action: "update",
			resourceType: "server",
			resourceId: parsed.serverId,
			resourceName: server.name,
			metadata: { action: "setup" },
		});
		return { ok: true as const, serverId: parsed.serverId };
	} catch (error) {
		await auditAgentMutation(actor, {
			action: "update",
			resourceType: "server",
			resourceId: parsed.serverId,
			resourceName: server.name,
			metadata: {
				action: "setup",
				status: "error",
				error: error instanceof Error ? error.message : String(error),
			},
		});
		throw error;
	}
}

export async function runServerSecurityAuditForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof serverIdInputSchema>,
) {
	const parsed = serverIdInputSchema.parse(input);
	await checkPermission(buildAgentPermissionCtx(actor), { server: ["read"] });
	await assertAccessibleServer(actor, parsed.serverId);
	return serverAudit(parsed.serverId);
}

export async function createEnvironmentForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof createEnvironmentInputSchema>,
) {
	const parsed = createEnvironmentInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	const project = await findProjectById(parsed.projectId);
	await assertAgentPolicy(actor, "agent.project.update", {
		organizationId: project.organizationId,
		resourceType: "environment",
		resourceName: parsed.name,
		projectId: project.projectId,
	});
	if (parsed.name.trim().toLowerCase() === "production") {
		await assertAgentPolicy(actor, "agent.production.mutate", {
			organizationId: project.organizationId,
			resourceType: "environment",
			resourceName: parsed.name,
			projectId: project.projectId,
			isProduction: true,
		});
	}
	await checkEnvironmentCreationPermission(permCtx, parsed.projectId);
	const environment = await createEnvironment(parsed);
	await addNewEnvironment(permCtx, environment.environmentId);
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "environment",
		resourceId: environment.environmentId,
		resourceName: environment.name,
		metadata: { projectId: environment.projectId },
	});
	return {
		ok: true as const,
		environmentId: environment.environmentId,
		name: environment.name,
		projectId: environment.projectId,
	};
}

async function ensureServiceCreateAllowed(
	actor: AgentActorContext,
	input: {
		environmentId: string;
		name: string;
		serviceType: AgentServiceType;
		serverId?: string | null;
		policyAction?: "agent.service.create" | "agent.service.importGit";
	},
) {
	const environment = await findEnvironmentById(input.environmentId);
	const project = await findProjectById(environment.projectId);
	const permCtx = buildAgentPermissionCtx(actor);
	await assertAgentPolicy(actor, input.policyAction ?? "agent.service.create", {
		organizationId: project.organizationId,
		resourceType: "service",
		resourceName: input.name,
		environmentId: input.environmentId,
		projectId: project.projectId,
	});
	await checkServiceAccess(permCtx, project.projectId, "create");
	if (input.serverId) {
		await assertAccessibleServer(actor, input.serverId);
	}
	await assertAgentRuntimePlacement(actor, "service.create", {
		serverId: input.serverId ?? null,
		resourceType: "service",
		resourceName: input.name,
		serviceType: input.serviceType,
		environmentId: input.environmentId,
		projectId: project.projectId,
	});
	return { environment, project, permCtx };
}

export async function createApplicationFromImageForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof createImageApplicationInputSchema>,
) {
	const parsed = createImageApplicationInputSchema.parse(input);
	const { project, environment, permCtx } = await ensureServiceCreateAllowed(actor, {
		environmentId: parsed.environmentId,
		name: parsed.name,
		serviceType: "application",
		serverId: parsed.serverId ?? null,
	});
	const created = await createApplication({
		name: parsed.name,
		appName: slugifyServiceName(`${project.name}-${parsed.name}`),
		description: parsed.description ?? "",
		environmentId: parsed.environmentId,
		serverId: parsed.serverId,
	});
	await updateApplication(created.applicationId, {
		sourceType: "docker",
		dockerImage: parsed.dockerImage,
		applicationStatus: "idle",
		buildExecutionTarget: "deploy_server",
	});
	await addNewService(permCtx, created.applicationId);
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "service",
		resourceId: created.applicationId,
		resourceName: created.name,
		metadata: {
			serviceType: "application",
			sourceType: "docker",
			environmentId: environment.environmentId,
			serverId: parsed.serverId ?? null,
		},
	});
	return {
		ok: true as const,
		serviceType: "application" as const,
		serviceId: created.applicationId,
		name: created.name,
	};
}

export async function createComposeServiceForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof createComposeServiceInputSchema>,
) {
	const parsed = createComposeServiceInputSchema.parse(input);
	const { project, environment, permCtx } = await ensureServiceCreateAllowed(actor, {
		environmentId: parsed.environmentId,
		name: parsed.name,
		serviceType: "compose",
		serverId: parsed.serverId ?? null,
	});
	const created = await createCompose({
		name: parsed.name,
		appName: slugifyServiceName(`${project.name}-${parsed.name}`),
		description: parsed.description ?? "",
		environmentId: parsed.environmentId,
		composeFile: parsed.composeFile,
		composeType: parsed.composeType,
		serverId: parsed.serverId,
	});
	await updateCompose(created.composeId, {
		sourceType: "raw",
		composeStatus: "idle",
	});
	await addNewService(permCtx, created.composeId);
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "service",
		resourceId: created.composeId,
		resourceName: created.name,
		metadata: {
			serviceType: "compose",
			environmentId: environment.environmentId,
			serverId: parsed.serverId ?? null,
		},
	});
	return {
		ok: true as const,
		serviceType: "compose" as const,
		serviceId: created.composeId,
		name: created.name,
	};
}

export async function createDatabaseServiceForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof createDatabaseServiceInputSchema>,
) {
	const parsed = createDatabaseServiceInputSchema.parse(input);
	const { project, environment, permCtx } = await ensureServiceCreateAllowed(actor, {
		environmentId: parsed.environmentId,
		name: parsed.name,
		serviceType: parsed.type,
		serverId: parsed.serverId ?? null,
	});
	const appName = slugifyServiceName(`${project.name}-${parsed.name}`);
	const databaseName =
		parsed.databaseName || slugifyServiceName(parsed.name).replace(/-/g, "_");
	const databaseUser =
		parsed.databaseUser || slugifyServiceName(parsed.name).replace(/-/g, "_");
	const common = {
		name: parsed.name,
		appName,
		dockerImage: parsed.dockerImage || defaultDatabaseImage(parsed.type),
		environmentId: parsed.environmentId,
		description: parsed.description ?? "",
		serverId: parsed.serverId,
	};
	const created =
		parsed.type === "postgres"
			? await createPostgres({
					...common,
					databaseName,
					databaseUser,
					databasePassword: "",
				})
			: parsed.type === "mysql"
				? await createMysql({
						...common,
						databaseName,
						databaseUser,
						databasePassword: "",
						databaseRootPassword: "",
					})
				: parsed.type === "mongo"
					? await createMongo({
							...common,
							databaseUser,
							databasePassword: "",
							replicaSets: false,
						})
					: parsed.type === "redis"
						? await createRedis({
								...common,
								databasePassword: "",
							})
						: parsed.type === "mariadb"
							? await createMariadb({
									...common,
									databaseName,
									databaseUser,
									databasePassword: "",
									databaseRootPassword: "",
								})
							: await createLibsql({
									...common,
									description: parsed.description ?? null,
									serverId: parsed.serverId ?? null,
									databaseUser,
									databasePassword: "",
									sqldNode: "primary",
									sqldPrimaryUrl: "",
									enableNamespaces: false,
								});
	const serviceId = databaseId(parsed.type, created as Record<string, unknown>);
	await addNewService(permCtx, serviceId);
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "service",
		resourceId: serviceId,
		resourceName: parsed.name,
		metadata: {
			serviceType: parsed.type,
			environmentId: environment.environmentId,
			serverId: parsed.serverId ?? null,
		},
	});
	return {
		ok: true as const,
		serviceType: parsed.type,
		serviceId,
		name: parsed.name,
	};
}

export async function assignDomainToServiceForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof assignDomainInputSchema>,
) {
	const parsed = assignDomainInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	await checkPermission(permCtx, { domain: ["create"] });
	const { service, name, serverId, environmentId, projectId } =
		await loadAgentServiceContext(actor, parsed);
	await assertAgentPolicy(actor, "agent.domain.assign", {
		resourceType: "domain",
		resourceName: parsed.host,
		environmentId,
		projectId,
		auditMetadata: {
			serviceType: parsed.serviceType,
			serviceId: parsed.serviceId,
			host: parsed.host,
		},
	});
	await assertAgentRuntimePlacement(actor, "domain.assign", {
		serverId,
		resourceType: "domain",
		resourceId: parsed.serviceId,
		resourceName: parsed.host,
		serviceType: parsed.serviceType,
		environmentId,
		projectId,
	});
	const domain = await createDomain({
		host: parsed.host,
		path: parsed.path ?? "/",
		port: parsed.port,
		https: parsed.https ?? true,
		certificateType: parsed.certificateType ?? "letsencrypt",
		domainType: parsed.serviceType,
		dnsZoneId: parsed.dnsZoneId,
		managedByNearzero: parsed.managedByNearzero,
		...(parsed.serviceType === "application"
			? { applicationId: parsed.serviceId }
			: { composeId: parsed.serviceId }),
	});
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "domain",
		resourceId: domain.domainId,
		resourceName: domain.host,
		metadata: {
			serviceType: parsed.serviceType,
			serviceId: parsed.serviceId,
			serviceName: serviceAuditName(service),
			serverId,
		},
	});
	return {
		ok: true as const,
		domainId: domain.domainId,
		host: domain.host,
		serviceName: name,
	};
}

export async function configureApplicationSourceForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof configureApplicationSourceInputSchema>,
) {
	const parsed = configureApplicationSourceInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	await checkServicePermissionAndAccess(permCtx, parsed.applicationId, {
		service: ["create"],
	});
	const application = await findApplicationById(parsed.applicationId);
	await assertAgentPolicy(
		actor,
		parsed.sourceType === "docker" || parsed.sourceType === "git"
			? "agent.service.create"
			: "agent.service.importGit",
		{
			organizationId: application.environment.project.organizationId,
			resourceType: "service",
			resourceId: parsed.applicationId,
			resourceName: application.name,
			environmentId: application.environmentId,
			projectId: application.environment.projectId,
			auditMetadata: { sourceType: parsed.sourceType },
		},
	);
	if (parsed.sourceType === "docker") {
		if (!parsed.dockerImage) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "dockerImage is required for Docker image sources.",
			});
		}
		await updateApplication(parsed.applicationId, {
			sourceType: "docker",
			dockerImage: parsed.dockerImage,
			registryUrl: parsed.registryUrl,
		});
	} else if (parsed.sourceType === "git") {
		await updateApplication(parsed.applicationId, {
			sourceType: "git",
			customGitUrl: parsed.customGitUrl,
			customGitBranch: parsed.customGitBranch,
			customGitBuildPath: parsed.customGitBuildPath,
			customGitSSHKeyId: parsed.customGitSSHKeyId,
		});
	} else {
		if (!parsed.gitProviderId || !parsed.owner || !parsed.repository || !parsed.branch) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message:
					"gitProviderId, owner, repository, and branch are required for Git provider sources.",
			});
		}
		const provider = await loadAccessibleGitProvider(actor, parsed.gitProviderId);
		if (provider.providerType !== parsed.sourceType) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Git provider type does not match sourceType.",
			});
		}
		const buildPath = parsed.buildPath ?? "/";
		if (parsed.sourceType === "github" && provider.github) {
			await updateApplication(parsed.applicationId, {
				sourceType: "github",
				githubId: provider.github.githubId,
				owner: parsed.owner,
				repository: parsed.repository,
				branch: parsed.branch,
				buildPath,
				watchPaths: parsed.watchPaths ?? [],
				enableSubmodules: parsed.enableSubmodules ?? false,
			});
		} else if (parsed.sourceType === "gitlab" && provider.gitlab) {
			await updateApplication(parsed.applicationId, {
				sourceType: "gitlab",
				gitlabId: provider.gitlab.gitlabId,
				gitlabOwner: parsed.owner,
				gitlabRepository: parsed.repository,
				gitlabBranch: parsed.branch,
				gitlabBuildPath: buildPath,
				gitlabProjectId: parsed.gitlabProjectId,
				gitlabPathNamespace: parsed.gitlabPathNamespace,
				watchPaths: parsed.watchPaths ?? [],
				enableSubmodules: parsed.enableSubmodules ?? false,
			});
		} else if (parsed.sourceType === "bitbucket" && provider.bitbucket) {
			await updateApplication(parsed.applicationId, {
				sourceType: "bitbucket",
				bitbucketId: provider.bitbucket.bitbucketId,
				bitbucketOwner: parsed.owner,
				bitbucketRepository: parsed.repository,
				bitbucketRepositorySlug:
					parsed.bitbucketRepositorySlug || parsed.repository,
				bitbucketBranch: parsed.branch,
				bitbucketBuildPath: buildPath,
				watchPaths: parsed.watchPaths ?? [],
				enableSubmodules: parsed.enableSubmodules ?? false,
			});
		} else if (parsed.sourceType === "gitea" && provider.gitea) {
			await updateApplication(parsed.applicationId, {
				sourceType: "gitea",
				giteaId: provider.gitea.giteaId,
				giteaOwner: parsed.owner,
				giteaRepository: parsed.repository,
				giteaBranch: parsed.branch,
				giteaBuildPath: buildPath,
				watchPaths: parsed.watchPaths ?? [],
				enableSubmodules: parsed.enableSubmodules ?? false,
			});
		} else {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Selected Git provider is not configured.",
			});
		}
	}
	await auditAgentMutation(actor, {
		action: "update",
		resourceType: "service",
		resourceId: parsed.applicationId,
		resourceName: application.name,
		metadata: { sourceType: parsed.sourceType },
	});
	return { ok: true as const, applicationId: parsed.applicationId };
}

export async function configureApplicationBuildForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof configureApplicationBuildInputSchema>,
) {
	const parsed = configureApplicationBuildInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	await checkServicePermissionAndAccess(permCtx, parsed.applicationId, {
		service: ["create"],
	});
	const application = await findApplicationById(parsed.applicationId);
	await assertAgentPolicy(actor, "agent.service.create", {
		organizationId: application.environment.project.organizationId,
		resourceType: "service",
		resourceId: parsed.applicationId,
		resourceName: application.name,
		environmentId: application.environmentId,
		projectId: application.environment.projectId,
		containsSecretValue: commandInputContainsSecret(parsed.command),
		auditMetadata: { buildType: parsed.buildType },
	});
	if (
		parsed.buildExecutionTarget === "nearzero_host" &&
		application.serverId &&
		!application.registryId
	) {
		throw new AgentHarnessError(
			"policy_action_disabled",
			"Building on the Nearzero host while deploying remotely requires a registry.",
			"Configure a registry or keep build location set to deploy server.",
		);
	}
	const { applicationId: _applicationId, ...updates } = parsed;
	await updateApplication(parsed.applicationId, updates);
	await auditAgentMutation(actor, {
		action: "update",
		resourceType: "service",
		resourceId: parsed.applicationId,
		resourceName: application.name,
		metadata: {
			buildType: parsed.buildType,
			buildExecutionTarget: parsed.buildExecutionTarget,
		},
	});
	return { ok: true as const, applicationId: parsed.applicationId };
}

export async function configureServicePortsForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof configureServicePortsInputSchema>,
) {
	const parsed = configureServicePortsInputSchema.parse(input);
	if (parsed.serviceType !== "application") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Port records are configurable for application services.",
		});
	}
	const permCtx = buildAgentPermissionCtx(actor);
	await checkServicePermissionAndAccess(permCtx, parsed.serviceId, {
		service: ["create"],
	});
	const { service, environmentId, projectId } = await loadAgentServiceContext(
		actor,
		parsed,
	);
	await assertAgentPolicy(actor, "agent.service.create", {
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName: serviceAuditName(service),
		environmentId,
		projectId,
		auditMetadata: {
			targetPort: parsed.targetPort,
			publishedPort: parsed.publishedPort,
			protocol: parsed.protocol,
		},
	});
	const port = await createPort({
		applicationId: parsed.serviceId,
		targetPort: parsed.targetPort,
		publishedPort: parsed.publishedPort,
		protocol: parsed.protocol,
		publishMode: parsed.publishMode,
	});
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName: serviceAuditName(service),
		metadata: { portId: port.portId },
	});
	return { ok: true as const, portId: port.portId };
}

export async function configureServiceEnvForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof serviceReferenceInputSchema>,
) {
	const parsed = serviceReferenceInputSchema.parse(input);
	const { service, environmentId, projectId } = await loadAgentServiceContext(
		actor,
		parsed,
	);
	await assertAgentPolicy(actor, "agent.service.create", {
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName: serviceAuditName(service),
		environmentId,
		projectId,
	});
	return {
		ok: false as const,
		code: "secure_input_required",
		message:
			"Environment variables must be entered through the secure service settings UI. The agent cannot receive secret values.",
		guidance:
			"Open the service settings, add environment variables there, then ask the agent to continue.",
	};
}

export async function configureServiceMountsForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof configureServiceMountsInputSchema>,
) {
	const parsed = configureServiceMountsInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	await checkServicePermissionAndAccess(permCtx, parsed.serviceId, {
		service: ["create"],
	});
	const { service, environmentId, projectId } = await loadAgentServiceContext(
		actor,
		parsed,
	);
	if (parsed.type === "file" && parsed.content !== undefined) {
		throw new AgentHarnessError(
			"policy_secret_exposure_blocked",
			"File mount content cannot be supplied through the agent.",
			"Create file content through the secure UI or provide only non-secret bind/volume metadata.",
		);
	}
	await assertAgentPolicy(actor, "agent.service.create", {
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName: serviceAuditName(service),
		environmentId,
		projectId,
		auditMetadata: { mountType: parsed.type, mountPath: parsed.mountPath },
	});
	const mount = await createMount({
		type: parsed.type,
		hostPath: parsed.hostPath,
		volumeName: parsed.volumeName,
		filePath: parsed.filePath,
		mountPath: parsed.mountPath,
		serviceType: parsed.serviceType,
		serviceId: parsed.serviceId,
	});
	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName: serviceAuditName(service),
		metadata: { mountId: mount.mountId, mountType: parsed.type },
	});
	return { ok: true as const, mountId: mount.mountId };
}

export async function runServiceActionForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof runServiceActionInputSchema>,
) {
	const parsed = runServiceActionInputSchema.parse(input);
	if (
		(parsed.action === "deploy" ||
			parsed.action === "redeploy" ||
			parsed.action === "rebuild") &&
		(parsed.serviceType === "application" || parsed.serviceType === "compose")
	) {
		return runDeploymentForAgent(actor, {
			serviceType: parsed.serviceType,
			serviceId: parsed.serviceId,
			title: parsed.title,
			description: parsed.description,
		});
	}
	const permCtx = buildAgentPermissionCtx(actor);
	await checkServicePermissionAndAccess(permCtx, parsed.serviceId, {
		deployment: ["create"],
	});
	const { service, appName, serverId, environmentId, projectId, name } =
		await loadAgentServiceContext(actor, parsed);
	await assertAgentPolicy(actor, "agent.deploy.run", {
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName: name,
		environmentId,
		projectId,
		auditMetadata: { action: parsed.action, serviceType: parsed.serviceType },
	});
	const placementAction: RuntimePlacementAction =
		parsed.action === "start" ? "service.start" :
		parsed.action === "stop" ? "service.stop" :
		parsed.action === "restart" || parsed.action === "reload"
			? "service.start"
			: "deploy.run";
	await assertAgentRuntimePlacement(actor, placementAction, {
		serverId,
		resourceType: parsed.serviceType,
		resourceId: parsed.serviceId,
		resourceName: name,
		serviceType: parsed.serviceType,
		environmentId,
		projectId,
		auditMetadata: { action: parsed.action },
	});
	if (parsed.action === "deploy") {
		await deployDatabaseService(parsed.serviceType, parsed.serviceId);
	} else if (parsed.action === "redeploy" || parsed.action === "rebuild") {
		const databaseType = serviceDatabaseType(parsed.serviceType);
		if (!databaseType) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Use runDeployment for application and compose redeploys.",
			});
		}
		await rebuildDatabase(parsed.serviceId, databaseType);
	} else if (parsed.action === "stop") {
		if (serverId) await stopServiceRemote(serverId, appName);
		else await stopService(appName);
		await updateServiceStatus(parsed.serviceType, parsed.serviceId, "idle");
	} else if (parsed.action === "start") {
		if (serverId) await startServiceRemote(serverId, appName);
		else await startService(appName);
		await updateServiceStatus(parsed.serviceType, parsed.serviceId, "done");
	} else if (parsed.action === "restart" || parsed.action === "reload") {
		if (serverId) {
			await stopServiceRemote(serverId, appName);
			await startServiceRemote(serverId, appName);
		} else {
			await stopService(appName);
			await startService(appName);
		}
		await updateServiceStatus(parsed.serviceType, parsed.serviceId, "done");
	}
	await auditAgentMutation(actor, {
		action:
			parsed.action === "stop"
				? "stop"
				: parsed.action === "start"
					? "start"
					: "deploy",
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName: serviceAuditName(service),
		metadata: { action: parsed.action, serviceType: parsed.serviceType, serverId },
	});
	return {
		ok: true as const,
		action: parsed.action,
		serviceType: parsed.serviceType,
		serviceId: parsed.serviceId,
	};
}

export async function rollbackDeploymentForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof rollbackDeploymentInputSchema>,
) {
	const parsed = rollbackDeploymentInputSchema.parse(input);
	const rollbackRecord = await findRollbackById(parsed.rollbackId);
	const application = rollbackRecord.deployment.application;
	if (!application) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Only application deployments can be rolled back.",
		});
	}
	await checkServicePermissionAndAccess(
		buildAgentPermissionCtx(actor),
		application.applicationId,
		{ deployment: ["create"] },
	);
	await assertAgentPolicy(actor, "agent.deploy.run", {
		organizationId: application.environment.project.organizationId,
		resourceType: "service",
		resourceId: application.applicationId,
		resourceName: application.name,
		environmentId: application.environmentId,
		projectId: application.environment.projectId,
		auditMetadata: { rollbackId: parsed.rollbackId, serviceType: "application" },
	});
	await assertAgentRuntimePlacement(actor, "deploy.run", {
		serverId: application.serverId ?? null,
		resourceType: "application",
		resourceId: application.applicationId,
		resourceName: application.name,
		serviceType: "application",
		environmentId: application.environmentId,
		projectId: application.environment.projectId,
	});
	await rollback(parsed.rollbackId);
	await auditAgentMutation(actor, {
		action: "restore",
		resourceType: "deployment",
		resourceId: rollbackRecord.deploymentId,
		resourceName: application.name,
		metadata: { rollbackId: parsed.rollbackId },
	});
	return {
		ok: true as const,
		rollbackId: parsed.rollbackId,
		deploymentId: rollbackRecord.deploymentId,
	};
}

export async function getRuntimeStatusForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof serviceReferenceInputSchema>,
) {
	const parsed = serviceReferenceInputSchema.parse(input);
	await checkServiceAccess(buildAgentPermissionCtx(actor), parsed.serviceId, "read");
	const { service, appName, serverId } = await loadAgentServiceContext(
		actor,
		parsed,
	);
	let exists = false;
	try {
		exists = await swarmServiceExists(appName, serverId);
	} catch {
		exists = false;
	}
	return {
		serviceType: parsed.serviceType,
		serviceId: parsed.serviceId,
		name: serviceAuditName(service),
		appName,
		serverId,
		registeredStatus:
			(service as unknown as { applicationStatus?: string; composeStatus?: string })
				.applicationStatus ??
			(service as unknown as { composeStatus?: string }).composeStatus ??
			"unknown",
		runtimeServiceExists: exists,
	};
}

export async function getRuntimeLogsForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof runtimeLogsInputSchema>,
) {
	const parsed = runtimeLogsInputSchema.parse(input);
	await checkServiceAccess(buildAgentPermissionCtx(actor), parsed.serviceId, "read");
	const { appName, serverId } = await loadAgentServiceContext(actor, parsed);
	const logs = await getContainerLogs(
		appName,
		parsed.tail,
		parsed.since,
		parsed.search,
		serverId,
		false,
	);
	return {
		serviceType: parsed.serviceType,
		serviceId: parsed.serviceId,
		logs,
	};
}

export async function importGitApplicationForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof importGitApplicationInputSchema>,
) {
	const parsed = importGitApplicationInputSchema.parse(input);
	const environment = await findEnvironmentById(parsed.environmentId);
	const project = await findProjectById(environment.projectId);
	const permCtx = buildAgentPermissionCtx(actor);

	await assertAgentPolicy(actor, "agent.service.importGit", {
		organizationId: project.organizationId,
		resourceType: "service",
		resourceName: parsed.name || parsed.repository,
		environmentId: parsed.environmentId,
		projectId: project.projectId,
		containsSecretValue: commandInputContainsSecret(
			parsed.customInstallCommand,
			parsed.customBuildCommand,
			parsed.customStartCommand,
		),
		auditMetadata: {
			providerType: parsed.providerType,
			repository: `${parsed.owner}/${parsed.repository}`,
			buildPath: parsed.buildPath,
			buildType: parsed.buildType,
			buildExecutionTarget: parsed.buildExecutionTarget,
		},
	});

	await checkServiceAccess(permCtx, project.projectId, "create");

	if (parsed.serverId) {
		const accessibleServers = await getAccessibleServerIds({
			userId: actor.userId,
			activeOrganizationId: actor.organizationId,
		});
		if (!accessibleServers.has(parsed.serverId)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You are not authorized to access this server.",
			});
		}
	}

	await assertAgentRuntimePlacement(actor, "service.importGit", {
		serverId: parsed.serverId ?? null,
		resourceType: "service",
		resourceName: parsed.name || parsed.repository,
		serviceType: "application",
		environmentId: parsed.environmentId,
		projectId: project.projectId,
		auditMetadata: {
			providerType: parsed.providerType,
			repository: `${parsed.owner}/${parsed.repository}`,
		},
	});
	if (parsed.buildExecutionTarget === "nearzero_host" && parsed.serverId) {
		throw new AgentHarnessError(
			"policy_action_disabled",
			"Building on the Nearzero host while deploying remotely requires a registry.",
			"Configure a registry or keep build location set to deploy server.",
		);
	}

	const provider = await loadAccessibleGitProvider(actor, parsed.gitProviderId);
	if (provider.providerType !== parsed.providerType) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Git provider type changed. Start the import again.",
		});
	}

	const serviceName = parsed.name || parsed.repository;
	const created = await createApplication({
		name: serviceName,
		appName: slugifyServiceName(`${project.name}-${serviceName}`),
		description: `Imported from ${parsed.owner}/${parsed.repository}`,
		environmentId: parsed.environmentId,
		serverId: parsed.serverId,
	});

	await addNewService(permCtx, created.applicationId);

	const buildPath = normalizeAgentBuildPath(parsed.buildPath);
	const commonUpdate = {
		applicationStatus: "idle" as const,
		watchPaths: [] as string[],
		enableSubmodules: false,
		buildSelectionMode:
			parsed.buildSelectionMode ??
			(parsed.buildPath ||
			parsed.customInstallCommand ||
			parsed.customBuildCommand ||
			parsed.customStartCommand
				? "explicit"
				: "automatic"),
		...(parsed.buildType ? { buildType: parsed.buildType } : {}),
		...(parsed.buildExecutionTarget
			? { buildExecutionTarget: parsed.buildExecutionTarget }
			: {}),
		...(parsed.customInstallCommand !== undefined
			? { customInstallCommand: parsed.customInstallCommand }
			: {}),
		...(parsed.customBuildCommand !== undefined
			? { customBuildCommand: parsed.customBuildCommand }
			: {}),
		...(parsed.customStartCommand !== undefined
			? { customStartCommand: parsed.customStartCommand }
			: {}),
	};
	if (parsed.providerType === "github" && provider.github) {
		await updateApplication(created.applicationId, {
			...commonUpdate,
			sourceType: "github",
			githubId: provider.github.githubId,
			owner: parsed.owner,
			repository: parsed.repository,
			branch: parsed.branch,
			buildPath,
		});
	} else if (parsed.providerType === "gitlab" && provider.gitlab) {
		await updateApplication(created.applicationId, {
			...commonUpdate,
			sourceType: "gitlab",
			gitlabId: provider.gitlab.gitlabId,
			gitlabOwner: parsed.owner,
			gitlabRepository: parsed.repository,
			gitlabBranch: parsed.branch,
			gitlabBuildPath: buildPath,
			gitlabProjectId: parsed.gitlabProjectId,
			gitlabPathNamespace: parsed.gitlabPathNamespace,
		});
	} else if (parsed.providerType === "bitbucket" && provider.bitbucket) {
		await updateApplication(created.applicationId, {
			...commonUpdate,
			sourceType: "bitbucket",
			bitbucketId: provider.bitbucket.bitbucketId,
			bitbucketOwner: parsed.owner,
			bitbucketRepository: parsed.repository,
			bitbucketRepositorySlug:
				parsed.bitbucketRepositorySlug || parsed.repository,
			bitbucketBranch: parsed.branch,
			bitbucketBuildPath: buildPath,
		});
	} else if (parsed.providerType === "gitea" && provider.gitea) {
		await updateApplication(created.applicationId, {
			...commonUpdate,
			sourceType: "gitea",
			giteaId: provider.gitea.giteaId,
			giteaOwner: parsed.owner,
			giteaRepository: parsed.repository,
			giteaBranch: parsed.branch,
			giteaBuildPath: buildPath,
		});
	} else {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Selected Git provider is not configured.",
		});
	}

	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "service",
		resourceId: created.applicationId,
		resourceName: created.appName,
		metadata: {
			sourceType: parsed.providerType,
			repository: `${parsed.owner}/${parsed.repository}`,
			environmentId: parsed.environmentId,
			buildPath,
			buildType: parsed.buildType,
			buildExecutionTarget: parsed.buildExecutionTarget,
		},
	});

	let liveUrl: string | null = null;
	let domainStatus: "assigned" | "blocked" | "failed" | "skipped" = "skipped";
	try {
		const preview = await previewServiceDomain({
			environmentId: parsed.environmentId,
			serviceName,
			serverId: parsed.serverId,
		});
		if (preview.enabled && preview.host) {
			await assertAgentPolicy(actor, "agent.domain.assign", {
				organizationId: project.organizationId,
				resourceType: "domain",
				resourceName: preview.host,
				environmentId: parsed.environmentId,
				projectId: project.projectId,
				auditMetadata: {
					host: preview.host,
					mode: preview.mode,
					serviceId: created.applicationId,
				},
			});
			await assertAgentRuntimePlacement(actor, "domain.assign", {
				serverId: parsed.serverId ?? null,
				resourceType: "domain",
				resourceId: created.applicationId,
				resourceName: preview.host,
				serviceType: "application",
				environmentId: parsed.environmentId,
				projectId: project.projectId,
				auditMetadata: {
					host: preview.host,
					mode: preview.mode,
				},
			});
			const domain = await ensureDefaultServiceDomain({
				serviceType: "application",
				serviceId: created.applicationId,
			});
			if (domain?.host) {
				liveUrl = `${domain.https ? "https" : "http"}://${domain.host}`;
				domainStatus = "assigned";
				await auditAgentMutation(actor, {
					action: "create",
					resourceType: "domain",
					resourceId: domain.domainId,
					resourceName: domain.host,
					metadata: {
						serviceId: created.applicationId,
						environmentId: parsed.environmentId,
						mode: preview.mode,
					},
				});
			}
		}
	} catch (error) {
		domainStatus = error instanceof AgentHarnessError ? "blocked" : "failed";
	}

	return {
		ok: true as const,
		serviceType: "application" as const,
		serviceId: created.applicationId,
		serviceName,
		projectName: project.name,
		environmentName: environment.name,
		repository: `${parsed.owner}/${parsed.repository}`,
		branch: parsed.branch,
		buildPath,
		liveUrl,
		domainStatus,
	};
}

export async function updateProjectCore(
	projectId: string,
	data: Partial<{ name: string; description: string | null; env: string }>,
) {
	return updateProjectById(projectId, data);
}

export async function createDevProjectForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof createProjectInputSchema>,
) {
	const parsed = createProjectInputSchema.parse(input);
	await assertAgentPolicy(actor, "agent.project.create", {
		resourceType: "project",
		resourceName: parsed.name,
	});
	const permCtx = buildAgentPermissionCtx(actor);
	await checkProjectAccess(permCtx, "create");

	const organization = await findOrganizationById(actor.organizationId);
	if (!organization) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Organization not found",
		});
	}

	const created = await createProject(parsed, actor.organizationId);
	const defaultEnvName = created.environment?.name?.trim().toLowerCase();
	if (defaultEnvName !== DEFAULT_PROJECT_ENVIRONMENT_NAME) {
		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `New projects must start with a ${DEFAULT_PROJECT_ENVIRONMENT_NAME} environment`,
		});
	}

	await addNewProject(permCtx, created.project.projectId);
	await addNewEnvironment(permCtx, created.environment?.environmentId ?? "");

	await auditAgentMutation(actor, {
		action: "create",
		resourceType: "project",
		resourceId: created.project.projectId,
		resourceName: created.project.name,
	});
	if (created.environment?.environmentId) {
		await auditAgentMutation(actor, {
			action: "create",
			resourceType: "environment",
			resourceId: created.environment.environmentId,
			resourceName: created.environment.name,
		});
	}

	return {
		projectId: created.project.projectId,
		projectName: created.project.name,
		environmentId: created.environment?.environmentId ?? null,
		environmentName: created.environment?.name ?? DEFAULT_PROJECT_ENVIRONMENT_NAME,
	};
}

export async function updateProjectForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof updateProjectInputSchema>,
) {
	const parsed = updateProjectInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	const currentProject = await findProjectById(parsed.projectId);
	await assertAgentPolicy(actor, "agent.project.update", {
		organizationId: currentProject.organizationId,
		resourceType: "project",
		resourceId: currentProject.projectId,
		resourceName: currentProject.name,
		projectId: currentProject.projectId,
		containsSecretValue: parsed.env !== undefined,
		auditMetadata: {
			updates: Object.keys(parsed).filter((key) => key !== "projectId"),
		},
	});

	if (actor.userRole !== "owner" && actor.userRole !== "admin") {
		const { accessedProjects } = await findMemberByUserId(
			actor.userId,
			actor.organizationId,
		);
		if (!accessedProjects.includes(parsed.projectId)) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this project",
			});
		}
	}

	if (parsed.env !== undefined) {
		await checkPermission(permCtx, { projectEnvVars: ["write"] });
	}

	const { projectId, ...updateData } = parsed;
	const project = await updateProjectCore(projectId, updateData);
	if (project) {
		await auditAgentMutation(actor, {
			action: "update",
			resourceType: "project",
			resourceId: projectId,
			resourceName: project.name,
		});
	}
	return project;
}

export async function deleteDevProjectForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof deleteProjectInputSchema>,
) {
	const parsed = deleteProjectInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);

	const currentProject = await findProjectById(parsed.projectId);
	await assertAgentPolicy(actor, "agent.project.delete", {
		organizationId: currentProject.organizationId,
		resourceType: "project",
		resourceId: currentProject.projectId,
		resourceName: currentProject.name,
		projectId: currentProject.projectId,
		isProduction: currentProject.environments.some((environment) =>
			isProductionEnvironment(environment),
		),
	});

	for (const environment of currentProject.environments) {
		if (isProductionEnvironment(environment)) {
			throw new AgentHarnessError(
				"policy_project_has_production",
				"This project has production environments and cannot be deleted by the Agent.",
				"Remove or migrate production environments first, or delete the project manually in the dashboard.",
			);
		}
	}

	await checkProjectAccess(permCtx, "delete", parsed.projectId);

	const deletedProject = await deleteProject(parsed.projectId);
	if (!deletedProject) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Project not found",
		});
	}

	await auditAgentMutation(actor, {
		action: "delete",
		resourceType: "project",
		resourceId: currentProject.projectId,
		resourceName: currentProject.name,
	});

	return {
		projectId: currentProject.projectId,
		projectName: currentProject.name,
		deleted: true,
		ok: true as const,
	};
}

export async function readDeploymentLogsForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof readLogsInputSchema>,
) {
	const parsed = readLogsInputSchema.parse(input);
	const deployment = await findDeploymentById(parsed.deploymentId);
	const serviceId = deployment.applicationId || deployment.composeId;
	if (serviceId) {
		await checkServicePermissionAndAccess(buildAgentPermissionCtx(actor), serviceId, {
			deployment: ["read"],
		});
		const service =
			deployment.applicationId != null
				? await findApplicationById(deployment.applicationId)
				: await findComposeById(deployment.composeId!);
		if (service.environment.project.organizationId !== actor.organizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this deployment.",
			});
		}
	} else if (deployment.schedule?.serverId) {
		const targetServer = await findServerById(deployment.schedule.serverId);
		if (targetServer.organizationId !== actor.organizationId) {
			throw new TRPCError({
				code: "UNAUTHORIZED",
				message: "You don't have access to this deployment.",
			});
		}
	}

	if (!deployment.logPath) {
		return {
			deploymentId: parsed.deploymentId,
			status: deployment.status,
			logs: "",
		};
	}

	const command = `tail -n ${parsed.tail} "${deployment.logPath}" 2>/dev/null || echo ""`;
	const serverId = resolveDeploymentLogServerId(deployment);
	let stdout = "";
	if (serverId) {
		({ stdout } = await execAsyncRemote(serverId, command));
	} else {
		({ stdout } = await execAsync(command));
	}

	return {
		deploymentId: parsed.deploymentId,
		status: deployment.status,
		title: deployment.title,
		logs: stdout,
	};
}

export async function runDeploymentForAgent(
	actor: AgentActorContext,
	input: z.infer<typeof runDeploymentInputSchema>,
) {
	const parsed = runDeploymentInputSchema.parse(input);
	const permCtx = buildAgentPermissionCtx(actor);
	await checkServicePermissionAndAccess(permCtx, parsed.serviceId, {
		deployment: ["create"],
	});

	let job: AgentDeploymentJob;
	let resourceName: string;
	let environmentId: string;
	let organizationId: string;

	if (parsed.serviceType === "compose") {
		const composeRecord = await findComposeById(parsed.serviceId);
		environmentId = composeRecord.environmentId;
		organizationId = composeRecord.environment.project.organizationId;
		resourceName = composeRecord.name;
		job = {
			composeId: parsed.serviceId,
			titleLog: parsed.title || "Agent deployment",
			descriptionLog: parsed.description || "",
			type: "deploy",
			applicationType: "compose",
			server: !!composeRecord.serverId,
			...(composeRecord.serverId ? { serverId: composeRecord.serverId } : {}),
		};
	} else {
		const application = await findApplicationById(parsed.serviceId);
		environmentId = application.environmentId;
		organizationId = application.environment.project.organizationId;
		resourceName = application.name;
		job = {
			applicationId: parsed.serviceId,
			titleLog: parsed.title || "Agent deployment",
			descriptionLog: parsed.description || "",
			type: "deploy",
			applicationType: "application",
			server: !!application.serverId,
			...(application.serverId ? { serverId: application.serverId } : {}),
		};
	}

	await assertAgentPolicy(actor, "agent.deploy.run", {
		organizationId,
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName,
		environmentId,
		auditMetadata: {
			serviceType: parsed.serviceType,
			titleLog: job.titleLog,
		},
	});
	await assertAgentRuntimePlacement(actor, "deploy.run", {
		serverId: job.serverId ?? null,
		resourceType: parsed.serviceType,
		resourceId: parsed.serviceId,
		resourceName,
		serviceType: parsed.serviceType,
		environmentId,
		auditMetadata: {
			titleLog: job.titleLog,
		},
	});

	await triggerAgentDeployment(job);

	await auditAgentMutation(actor, {
		action: "deploy",
		resourceType: "service",
		resourceId: parsed.serviceId,
		resourceName,
		metadata: {
			serviceType: parsed.serviceType,
			environmentId,
			titleLog: job.titleLog,
		},
	});

	return {
		queued: true,
		serviceType: parsed.serviceType,
		serviceId: parsed.serviceId,
		title: job.titleLog,
	};
}

export function toAgentActorContext(ctx: {
	organizationId: string;
	userId: string;
	userEmail?: string;
	userRole?: string;
	threadId?: string | null;
}): AgentActorContext {
	return {
		organizationId: ctx.organizationId,
		userId: ctx.userId,
		userEmail: ctx.userEmail,
		userRole: ctx.userRole,
		threadId: ctx.threadId,
	};
}
