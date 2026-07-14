import {
	cancelRunningApplicationDeployment,
	clearApplicationDeploymentLogs,
	createApplication,
	deleteAllMiddlewares,
	findApplicationById,
	findDomainsByApplicationId,
	findDomainsByPreviewDeploymentIds,
	findRegistryById,
	findSSHKeyById,
	getAccessibleGitProviderIds,
	getAccessibleServerIds,
	getApplicationStats,
	getContainerLogs,
	mechanizeDockerContainer,
	readConfig,
	readRemoteConfig,
	removeDeployments,
	removeDirectoryCode,
	removeDomainById,
	removeMonitoringDirectory,
	removeService,
	removeTraefikConfig,
	sanitizePublicErrorMessage,
	startService,
	startServiceRemote,
	stopService,
	stopServiceRemote,
	unzipDrop,
	updateApplication,
	updateApplicationStatus,
	writeConfig,
	writeConfigRemote,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import {
	addNewService,
	checkServiceAccess,
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@nearzero/server/services/permission";
import { isCloudMode } from "@nearzero/server/services/runtime-mode";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import { zfd } from "zod-form-data";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import { assertGitProviderAssociationsReadable } from "@/server/api/utils/git-provider-security";
import { toPublicService } from "@/server/api/utils/public-service";
import { assertRuntimePlacement } from "@/server/api/utils/runtime-policy";
import { runServiceScaleAction } from "@/server/api/utils/service-scale";
import {
	apiCreateApplication,
	apiDeployApplication,
	apiFindMonitoringStats,
	apiFindOneApplication,
	apiRedeployApplication,
	apiReloadApplication,
	apiSaveBitbucketProvider,
	apiSaveBuildCommands,
	apiSaveBuildType,
	apiSaveDockerProvider,
	apiSaveEnvironmentVariables,
	apiSaveGiteaProvider,
	apiSaveGithubProvider,
	apiSaveGitlabProvider,
	apiSaveGitProvider,
	apiUpdateApplication,
	applications,
	environments,
	projects,
} from "@/server/db/schema";
import type { DeploymentJob } from "@/server/queues/queue-types";
import {
	cleanQueuesByApplication,
	getJobsByApplicationId,
	prepareDeploymentJobsForServiceDeletion,
} from "@/server/queues/queueSetup";
import {
	cancelQueuedDeployment,
	enqueueDeployment,
} from "@/server/utils/deploy";

export const applicationRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateApplication)
		.mutation(async ({ input, ctx }) => {
			try {
				const environment = await db.query.environments.findFirst({
					where: eq(environments.environmentId, input.environmentId),
					columns: {
						environmentId: true,
						projectId: true,
					},
					with: {
						project: {
							columns: {
								projectId: true,
								organizationId: true,
								name: true,
							},
						},
					},
				});
				if (!environment?.project) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Environment not found",
					});
				}
				const project = environment.project;

				await checkServiceAccess(ctx, project.projectId, "create");

				if (project.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this project",
					});
				}

				// Honor the explicitly selected server. We intentionally do NOT
				// fall back to the "first ready server" here — silently
				// auto-picking caused applications to deploy to an unintended
				// server. In Cloud mode an empty selection is rejected by
				// assertRuntimePlacement below; in Community mode null means the
				// Nearzero host.
				const requestedServerId = input.serverId?.trim();
				const serverId =
					!requestedServerId || requestedServerId === "nearzero"
						? null
						: requestedServerId;
				await assertRuntimePlacement(ctx, "service.create", {
					serverId,
					resourceType: "service",
					resourceName: input.name,
					serviceType: "application",
					environmentId: input.environmentId,
					projectId: project.projectId,
				});

				if (serverId) {
					const accessibleIds = await getAccessibleServerIds(ctx.session);
					if (!accessibleIds.has(serverId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to access this server",
						});
					}
				}

				const newApplication = await createApplication({
					...input,
					serverId: serverId ?? undefined,
				});

				await addNewService(ctx, newApplication.applicationId);
				await audit(ctx, {
					action: "create",
					resourceType: "service",
					resourceId: newApplication.applicationId,
					resourceName: newApplication.appName,
				});
				return toPublicService(newApplication);
			} catch (error: unknown) {
				if (error instanceof TRPCError) {
					throw error;
				}
				console.error(
					"Failed to create application:",
					sanitizePublicErrorMessage(error, "application creation failed"),
				);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the application",
				});
			}
		}),
	one: protectedProcedure
		.input(apiFindOneApplication)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.applicationId, "read");
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}

			let hasGitProviderAccess = true;
			let unauthorizedProvider: string | null = null;

			const getGitProviderId = () => {
				switch (application.sourceType) {
					case "github":
						return application.github?.gitProviderId;
					case "gitlab":
						return application.gitlab?.gitProviderId;
					case "bitbucket":
						return application.bitbucket?.gitProviderId;
					case "gitea":
						return application.gitea?.gitProviderId;
					default:
						return null;
				}
			};

			const gitProviderId = getGitProviderId();

			if (gitProviderId) {
				const accessibleIds = await getAccessibleGitProviderIds(ctx.session);
				if (!accessibleIds.has(gitProviderId)) {
					hasGitProviderAccess = false;
					unauthorizedProvider = application.sourceType;
				}
			}

			return toPublicService({
				...application,
				hasGitProviderAccess,
				unauthorizedProvider,
			});
		}),

	reload: protectedProcedure
		.input(apiReloadApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const application = await findApplicationById(input.applicationId);

			try {
				await updateApplicationStatus(input.applicationId, "idle");
				await mechanizeDockerContainer(application);
				await updateApplicationStatus(input.applicationId, "done");
				await audit(ctx, {
					action: "reload",
					resourceType: "application",
					resourceId: application.applicationId,
					resourceName: application.appName,
				});
				return true;
			} catch (error) {
				await updateApplicationStatus(input.applicationId, "error");
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Error reloading application",
					cause: error,
				});
			}
		}),

	delete: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.applicationId, "delete");
			let application = await findApplicationById(input.applicationId);

			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to delete this application",
				});
			}
			await cancelQueuedDeployment({
				applicationId: input.applicationId,
				applicationType: "application",
			});
			application = await findApplicationById(input.applicationId);
			if (
				application.applicationStatus === "running" ||
				application.previewDeployments.some(
					(preview) => preview.previewStatus === "running",
				)
			) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"Wait for or cancel active application and preview deployments before deleting this service",
				});
			}

			const queueJobs = await getJobsByApplicationId(input.applicationId);
			if (!(await prepareDeploymentJobsForServiceDeletion(queueJobs))) {
				throw new TRPCError({
					code: "CONFLICT",
					message:
						"Wait for or cancel the active deployment before deleting this service",
				});
			}

			// Remove published routes and managed DNS while the parent row still
			// exists. If any cleanup fails, retain the application so the operation
			// can be retried without orphaning externally reachable resources.
			const attachedDomains = await findDomainsByApplicationId(
				input.applicationId,
			);
			const previewDomains = await findDomainsByPreviewDeploymentIds(
				application.previewDeployments.map(
					(preview) => preview.previewDeploymentId,
				),
			);
			const attachedDomainIds = new Set([
				...attachedDomains.map((domain) => domain.domainId),
				...previewDomains.map((domain) => domain.domainId),
				...application.previewDeployments
					.map((preview) => preview.domainId)
					.filter((domainId): domainId is string => Boolean(domainId)),
			]);
			for (const domainId of attachedDomainIds) {
				await removeDomainById(domainId);
			}
			const serviceRemoval = await removeService(
				application.appName,
				application.serverId,
				true,
				true,
			);
			if (serviceRemoval instanceof Error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"The application could not be removed from its server; its database record was retained for a safe retry",
					cause: serviceRemoval,
				});
			}

			await db
				.delete(applications)
				.where(eq(applications.applicationId, input.applicationId))
				.returning();

			const cleanupOperations: Array<{
				name: string;
				run: () => Promise<unknown>;
			}> = [
				{
					name: "deleteAllMiddlewares",
					run: () => deleteAllMiddlewares(application),
				},
				{
					name: "removeDeployments",
					run: () => removeDeployments(application),
				},
				{
					name: "removeDirectoryCode",
					run: () =>
						removeDirectoryCode(application.appName, application.serverId),
				},
				{
					name: "removeMonitoringDirectory",
					run: () =>
						removeMonitoringDirectory(
							application.appName,
							application.serverId,
						),
				},
				{
					name: "removeTraefikConfig",
					run: () =>
						removeTraefikConfig(application.appName, application.serverId),
				},
			];

			// Best-effort cleanup: we still delete the DB record even if a remote
			// step fails, but failures must NOT be swallowed silently — that is how
			// a "deleted" service ends up with an orphaned Swarm container still
			// running on the server with no trace of why. Log each failure with the
			// app/server context so it is diagnosable (the most important one is
			// removeService, which runs `docker service rm` over SSH).
			for (const operation of cleanupOperations) {
				try {
					await operation.run();
				} catch (error) {
					console.error(
						`[application.delete] cleanup step "${operation.name}" failed for ` +
							`app="${application.appName}" serverId="${
								application.serverId ?? "local"
							}":`,
						sanitizePublicErrorMessage(error, "remote cleanup failed"),
					);
				}
			}

			await audit(ctx, {
				action: "delete",
				resourceType: "service",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return {
				success: true,
				applicationId: application.applicationId,
			};
		}),

	stop: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const service = await findApplicationById(input.applicationId);
			await assertRuntimePlacement(ctx, "service.stop", {
				serverId: service.serverId ?? null,
				resourceType: "application",
				resourceId: service.applicationId,
				resourceName: service.appName,
				serviceType: "application",
				environmentId: service.environmentId,
			});
			await runServiceScaleAction("stop", async () => {
				if (service.serverId) {
					await stopServiceRemote(service.serverId, service.appName);
				} else {
					await stopService(service.appName);
				}
			});
			await updateApplicationStatus(input.applicationId, "idle");
			await audit(ctx, {
				action: "stop",
				resourceType: "application",
				resourceId: service.applicationId,
				resourceName: service.appName,
			});
			return { success: true, applicationId: service.applicationId };
		}),

	start: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const service = await findApplicationById(input.applicationId);
			await assertRuntimePlacement(ctx, "service.start", {
				serverId: service.serverId ?? null,
				resourceType: "application",
				resourceId: service.applicationId,
				resourceName: service.appName,
				serviceType: "application",
				environmentId: service.environmentId,
			});
			const replicas = service.replicas ?? 1;
			await runServiceScaleAction("start", async () => {
				if (service.serverId) {
					await startServiceRemote(service.serverId, service.appName, replicas);
				} else {
					await startService(service.appName, replicas);
				}
			});
			await updateApplicationStatus(input.applicationId, "done");
			await audit(ctx, {
				action: "start",
				resourceType: "application",
				resourceId: service.applicationId,
				resourceName: service.appName,
			});
			return { success: true, applicationId: service.applicationId };
		}),

	redeploy: protectedProcedure
		.input(apiRedeployApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const application = await findApplicationById(input.applicationId);
			await assertRuntimePlacement(ctx, "deploy.run", {
				serverId: application.serverId ?? null,
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
				serviceType: "application",
				environmentId: application.environmentId,
			});
			const jobData: DeploymentJob = {
				applicationId: input.applicationId,
				titleLog: input.title || "Rebuild deployment",
				descriptionLog: input.description || "",
				type: "redeploy",
				applicationType: "application",
				server: !!application.serverId,
			};

			if (application.serverId) {
				jobData.serverId = application.serverId;
			}
			const queued = await enqueueDeployment(jobData);
			await audit(ctx, {
				action: "rebuild",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return {
				success: true,
				message: queued.message,
				jobId: queued.jobId,
				applicationId: application.applicationId,
			};
		}),
	saveEnvironment: protectedProcedure
		.input(apiSaveEnvironmentVariables)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				envVars: ["write"],
			});
			await updateApplication(input.applicationId, {
				env: input.env,
				buildArgs: input.buildArgs,
				buildSecrets: input.buildSecrets,
				createEnvFile: input.createEnvFile,
			});
			await db
				.update(applications)
				.set({
					customInstallCommand: input.customInstallCommand,
					customBuildCommand: input.customBuildCommand,
					customStartCommand: input.customStartCommand,
				})
				.where(eq(applications.applicationId, input.applicationId));
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveBuildCommands: protectedProcedure
		.input(apiSaveBuildCommands)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await db
				.update(applications)
				.set({
					customInstallCommand: input.customInstallCommand,
					customBuildCommand: input.customBuildCommand,
					customStartCommand: input.customStartCommand,
				})
				.where(eq(applications.applicationId, input.applicationId));
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveBuildType: protectedProcedure
		.input(apiSaveBuildType)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			const current = await findApplicationById(input.applicationId);
			const buildExecutionTarget = isCloudMode()
				? "deploy_server"
				: (input.buildExecutionTarget ?? "deploy_server");
			if (
				buildExecutionTarget === "nearzero_host" &&
				current.serverId &&
				current.sourceType !== "docker" &&
				!current.registryId
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						"Building on the Nearzero host while deploying to a remote server requires a registry.",
				});
			}
			await updateApplication(input.applicationId, {
				buildType: input.buildType,
				buildSelectionMode: "explicit",
				buildExecutionTarget,
				dockerfile: input.dockerfile,
				publishDirectory: input.publishDirectory,
				dockerContextPath: input.dockerContextPath,
				dockerBuildStage: input.dockerBuildStage,
				herokuVersion: input.herokuVersion,
				isStaticSpa: input.isStaticSpa,
				railpackVersion: input.railpackVersion,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveGithubProvider: protectedProcedure
		.input(apiSaveGithubProvider)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await assertGitProviderAssociationsReadable(ctx.session, {
				githubId: input.githubId,
			});
			await updateApplication(input.applicationId, {
				repository: input.repository,
				branch: input.branch,
				sourceType: "github",
				owner: input.owner,
				buildPath: input.buildPath,
				applicationStatus: "idle",
				githubId: input.githubId,
				watchPaths: input.watchPaths,
				triggerType: input.triggerType,
				enableSubmodules: input.enableSubmodules,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveGitlabProvider: protectedProcedure
		.input(apiSaveGitlabProvider)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await assertGitProviderAssociationsReadable(ctx.session, {
				gitlabId: input.gitlabId,
			});
			await updateApplication(input.applicationId, {
				gitlabRepository: input.gitlabRepository,
				gitlabOwner: input.gitlabOwner,
				gitlabBranch: input.gitlabBranch,
				gitlabBuildPath: input.gitlabBuildPath,
				sourceType: "gitlab",
				applicationStatus: "idle",
				gitlabId: input.gitlabId,
				gitlabProjectId: input.gitlabProjectId,
				gitlabPathNamespace: input.gitlabPathNamespace,
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveBitbucketProvider: protectedProcedure
		.input(apiSaveBitbucketProvider)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await assertGitProviderAssociationsReadable(ctx.session, {
				bitbucketId: input.bitbucketId,
			});
			await updateApplication(input.applicationId, {
				bitbucketRepository: input.bitbucketRepository,
				bitbucketRepositorySlug: input.bitbucketRepositorySlug,
				bitbucketOwner: input.bitbucketOwner,
				bitbucketBranch: input.bitbucketBranch,
				bitbucketBuildPath: input.bitbucketBuildPath,
				sourceType: "bitbucket",
				applicationStatus: "idle",
				bitbucketId: input.bitbucketId,
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveGiteaProvider: protectedProcedure
		.input(apiSaveGiteaProvider)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await assertGitProviderAssociationsReadable(ctx.session, {
				giteaId: input.giteaId,
			});
			await updateApplication(input.applicationId, {
				giteaRepository: input.giteaRepository,
				giteaOwner: input.giteaOwner,
				giteaBranch: input.giteaBranch,
				giteaBuildPath: input.giteaBuildPath,
				sourceType: "gitea",
				applicationStatus: "idle",
				giteaId: input.giteaId,
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveDockerProvider: protectedProcedure
		.input(apiSaveDockerProvider)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			const current = await findApplicationById(input.applicationId);
			await updateApplication(input.applicationId, {
				dockerImage: input.dockerImage,
				username: input.username,
				password:
					input.password && input.password.length > 0
						? input.password
						: current.password,
				sourceType: "docker",
				applicationStatus: "idle",
				registryUrl: input.registryUrl,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	saveGitProvider: protectedProcedure
		.input(apiSaveGitProvider)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			if (input.customGitSSHKeyId) {
				const sshKey = await findSSHKeyById(input.customGitSSHKeyId);
				if (sshKey.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "SSH key not found",
					});
				}
			}
			await updateApplication(input.applicationId, {
				customGitBranch: input.customGitBranch,
				customGitBuildPath: input.customGitBuildPath,
				customGitUrl: input.customGitUrl,
				customGitSSHKeyId: input.customGitSSHKeyId,
				sourceType: "git",
				applicationStatus: "idle",
				watchPaths: input.watchPaths,
				enableSubmodules: input.enableSubmodules,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	disconnectGitProvider: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await updateApplication(input.applicationId, {
				repository: null,
				branch: null,
				owner: null,
				buildPath: "/",
				githubId: null,
				triggerType: "push",

				gitlabRepository: null,
				gitlabOwner: null,
				gitlabBranch: null,
				gitlabBuildPath: null,
				gitlabId: null,
				gitlabProjectId: null,
				gitlabPathNamespace: null,

				bitbucketRepository: null,
				bitbucketOwner: null,
				bitbucketBranch: null,
				bitbucketBuildPath: null,
				bitbucketId: null,

				giteaRepository: null,
				giteaOwner: null,
				giteaBranch: null,
				giteaBuildPath: null,
				giteaId: null,

				customGitBranch: null,
				customGitBuildPath: null,
				customGitUrl: null,
				customGitSSHKeyId: null,

				sourceType: "github", // Reset to default
				applicationStatus: "idle",
				watchPaths: null,
				enableSubmodules: false,
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	markRunning: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			await updateApplicationStatus(input.applicationId, "running");
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "deploy",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
		}),
	update: protectedProcedure
		.input(apiUpdateApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			const { applicationId, ...rest } = input;
			const current = await findApplicationById(applicationId);
			const updateData = { ...rest };
			await assertGitProviderAssociationsReadable(ctx.session, updateData);

			const secretFields = [
				"env",
				"previewEnv",
				"buildArgs",
				"buildSecrets",
				"previewBuildArgs",
				"previewBuildSecrets",
				"password",
			] as const;
			if (secretFields.some((field) => Object.hasOwn(updateData, field))) {
				await checkServicePermissionAndAccess(ctx, applicationId, {
					envVars: ["write"],
				});
			}
			if (Object.hasOwn(updateData, "refreshToken")) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Refresh tokens can only be rotated by the token endpoint",
				});
			}

			if (
				updateData.environmentId &&
				updateData.environmentId !== current.environmentId
			) {
				const target = await db.query.environments.findFirst({
					where: eq(environments.environmentId, updateData.environmentId),
					columns: { environmentId: true, projectId: true },
					with: {
						project: {
							columns: { projectId: true, organizationId: true },
						},
					},
				});
				if (
					!target?.project ||
					target.project.organizationId !== ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Environment not found",
					});
				}
				await checkServiceAccess(ctx, target.projectId, "create");
			}

			for (const registryId of [
				updateData.registryId,
				updateData.rollbackRegistryId,
			]) {
				if (!registryId) continue;
				const targetRegistry = await findRegistryById(registryId);
				if (
					targetRegistry.organizationId !== ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Registry not found",
					});
				}
			}

			if (updateData.customGitSSHKeyId) {
				const sshKey = await findSSHKeyById(updateData.customGitSSHKeyId);
				if (sshKey.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "SSH key not found",
					});
				}
			}
			if (updateData.buildExecutionTarget) {
				updateData.buildExecutionTarget = isCloudMode()
					? "deploy_server"
					: updateData.buildExecutionTarget;
				if (
					updateData.buildExecutionTarget === "nearzero_host" &&
					current.serverId &&
					current.sourceType !== "docker" &&
					!current.registryId
				) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message:
							"Building on the Nearzero host while deploying to a remote server requires a registry.",
					});
				}
			}
			const updateApp = await updateApplication(applicationId, updateData);

			if (!updateApp) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error updating application",
				});
			}
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: updateApp.applicationId,
				resourceName: updateApp.appName,
			});
			return true;
		}),
	refreshToken: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});
			await updateApplication(input.applicationId, {
				refreshToken: nanoid(),
			});
			const application = await findApplicationById(input.applicationId);
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	deploy: protectedProcedure
		.input(apiDeployApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const application = await findApplicationById(input.applicationId);
			await assertRuntimePlacement(ctx, "deploy.run", {
				serverId: application.serverId ?? null,
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
				serviceType: "application",
				environmentId: application.environmentId,
			});
			const jobData: DeploymentJob = {
				applicationId: input.applicationId,
				titleLog: input.title || "Manual deployment",
				descriptionLog: input.description || "",
				type: "deploy",
				applicationType: "application",
				server: !!application.serverId,
			};
			if (application.serverId) {
				jobData.serverId = application.serverId;
			}
			const queued = await enqueueDeployment(jobData);
			await audit(ctx, {
				action: "deploy",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return {
				success: true,
				message: queued.message,
				jobId: queued.jobId,
				applicationId: application.applicationId,
			};
		}),

	cleanQueues: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["cancel"],
			});
			await cleanQueuesByApplication(input.applicationId);
		}),
	clearDeployments: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["create"],
			});
			const application = await findApplicationById(input.applicationId);
			await clearApplicationDeploymentLogs(application.applicationId);
			await audit(ctx, {
				action: "delete",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	killBuild: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["cancel"],
			});
			const application = await findApplicationById(input.applicationId);
			await cancelRunningApplicationDeployment(application.applicationId);
			await cancelQueuedDeployment({
				applicationId: application.applicationId,
				applicationType: "application",
			});
			await audit(ctx, {
				action: "stop",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
		}),
	readTraefikConfig: protectedProcedure
		.input(apiFindOneApplication)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				traefikFiles: ["read"],
			});
			const application = await findApplicationById(input.applicationId);
			let traefikConfig = null;
			if (application.serverId) {
				traefikConfig = await readRemoteConfig(
					application.serverId,
					application.appName,
				);
			} else {
				traefikConfig = readConfig(application.appName);
			}
			return traefikConfig;
		}),

	dropDeployment: protectedProcedure
		.input(
			zfd.formData({
				applicationId: z.string(),
				zip: zfd.file(),
				dropBuildPath: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const zipFile = input.zip;
			const applicationId = input.applicationId;
			const dropBuildPath = input.dropBuildPath ?? null;

			await checkServicePermissionAndAccess(ctx, applicationId, {
				deployment: ["create"],
			});
			const app = await findApplicationById(applicationId);

			await updateApplication(applicationId, {
				sourceType: "drop",
				dropBuildPath: dropBuildPath || "",
			});

			await unzipDrop(zipFile, app);
			const jobData: DeploymentJob = {
				applicationId: app.applicationId,
				titleLog: "Manual deployment",
				descriptionLog: "",
				type: "deploy",
				applicationType: "application",
				server: !!app.serverId,
			};
			if (app.serverId) {
				jobData.serverId = app.serverId;
			}
			await enqueueDeployment(jobData);
			await audit(ctx, {
				action: "deploy",
				resourceType: "application",
				resourceId: app.applicationId,
				resourceName: app.appName,
			});
			return true;
		}),
	updateTraefikConfig: protectedProcedure
		.input(z.object({ applicationId: z.string(), traefikConfig: z.string() }))
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				traefikFiles: ["write"],
			});
			const application = await findApplicationById(input.applicationId);
			if (application.serverId) {
				await writeConfigRemote(
					application.serverId,
					application.appName,
					input.traefikConfig,
				);
			} else {
				writeConfig(application.appName, input.traefikConfig);
			}
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: application.applicationId,
				resourceName: application.appName,
			});
			return true;
		}),
	readAppMonitoring: withPermission("monitoring", "read")
		.input(apiFindMonitoringStats)
		.query(async ({ input }) => {
			const stats = await getApplicationStats(input.appName);

			return stats;
		}),
	move: protectedProcedure
		.input(
			z.object({
				applicationId: z.string(),
				targetEnvironmentId: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				service: ["create"],
			});

			const updatedApplication = await db
				.update(applications)
				.set({
					environmentId: input.targetEnvironmentId,
				})
				.where(eq(applications.applicationId, input.applicationId))
				.returning()
				.then((res) => res[0]);

			if (!updatedApplication) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: "Failed to move application",
				});
			}
			await audit(ctx, {
				action: "update",
				resourceType: "application",
				resourceId: updatedApplication.applicationId,
				resourceName: updatedApplication.appName,
			});
			return {
				success: true,
				applicationId: updatedApplication.applicationId,
			};
		}),

	cancelDeployment: protectedProcedure
		.input(apiFindOneApplication)
		.mutation(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["cancel"],
			});
			const application = await findApplicationById(input.applicationId);

			try {
				await cancelQueuedDeployment({
					applicationId: input.applicationId,
					applicationType: "application",
				});
				await cancelRunningApplicationDeployment(input.applicationId);
				await updateApplicationStatus(input.applicationId, "idle");
				await audit(ctx, {
					action: "stop",
					resourceType: "application",
					resourceId: application.applicationId,
					resourceName: application.appName,
				});
				return {
					success: true,
					message: "Deployment cancellation requested",
				};
			} catch (error) {
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message:
						error instanceof Error
							? error.message
							: "Failed to cancel deployment",
				});
			}
		}),

	search: protectedProcedure
		.input(
			z.object({
				q: z.string().optional(),
				name: z.string().optional(),
				appName: z.string().optional(),
				description: z.string().optional(),
				repository: z.string().optional(),
				owner: z.string().optional(),
				dockerImage: z.string().optional(),
				projectId: z.string().optional(),
				environmentId: z.string().optional(),
				limit: z.number().min(1).max(100).default(20),
				offset: z.number().min(0).default(0),
			}),
		)
		.query(async ({ ctx, input }) => {
			const baseConditions = [
				eq(projects.organizationId, ctx.session.activeOrganizationId),
			];

			if (input.projectId) {
				baseConditions.push(eq(environments.projectId, input.projectId));
			}
			if (input.environmentId) {
				baseConditions.push(
					eq(applications.environmentId, input.environmentId),
				);
			}

			if (input.q?.trim()) {
				const term = `%${input.q.trim()}%`;
				baseConditions.push(
					or(
						ilike(applications.name, term),
						ilike(applications.appName, term),
						ilike(applications.description ?? "", term),
						ilike(applications.repository ?? "", term),
						ilike(applications.owner ?? "", term),
						ilike(applications.dockerImage ?? "", term),
					)!,
				);
			}

			if (input.name?.trim()) {
				baseConditions.push(ilike(applications.name, `%${input.name.trim()}%`));
			}
			if (input.appName?.trim()) {
				baseConditions.push(
					ilike(applications.appName, `%${input.appName.trim()}%`),
				);
			}
			if (input.description?.trim()) {
				baseConditions.push(
					ilike(
						applications.description ?? "",
						`%${input.description.trim()}%`,
					),
				);
			}
			if (input.repository?.trim()) {
				baseConditions.push(
					ilike(applications.repository ?? "", `%${input.repository.trim()}%`),
				);
			}
			if (input.owner?.trim()) {
				baseConditions.push(
					ilike(applications.owner ?? "", `%${input.owner.trim()}%`),
				);
			}
			if (input.dockerImage?.trim()) {
				baseConditions.push(
					ilike(
						applications.dockerImage ?? "",
						`%${input.dockerImage.trim()}%`,
					),
				);
			}

			const { accessedServices } = await findMemberByUserId(
				ctx.user.id,
				ctx.session.activeOrganizationId,
			);
			if (accessedServices.length === 0) return { items: [], total: 0 };
			baseConditions.push(
				sql`${applications.applicationId} IN (${sql.join(
					accessedServices.map((id) => sql`${id}`),
					sql`, `,
				)})`,
			);

			const where = and(...baseConditions);

			const [items, countResult] = await Promise.all([
				db
					.select({
						applicationId: applications.applicationId,
						name: applications.name,
						appName: applications.appName,
						description: applications.description,
						environmentId: applications.environmentId,
						applicationStatus: applications.applicationStatus,
						sourceType: applications.sourceType,
						createdAt: applications.createdAt,
					})
					.from(applications)
					.innerJoin(
						environments,
						eq(applications.environmentId, environments.environmentId),
					)
					.innerJoin(projects, eq(environments.projectId, projects.projectId))
					.where(where)
					.orderBy(desc(applications.createdAt))
					.limit(input.limit)
					.offset(input.offset),
				db
					.select({ count: sql<number>`count(*)::int` })
					.from(applications)
					.innerJoin(
						environments,
						eq(applications.environmentId, environments.environmentId),
					)
					.innerJoin(projects, eq(environments.projectId, projects.projectId))
					.where(where),
			]);

			return {
				items,
				total: countResult[0]?.count ?? 0,
			};
		}),

	readLogs: protectedProcedure
		.input(
			apiFindOneApplication.extend({
				tail: z.number().int().min(1).max(10000).default(100),
				since: z
					.string()
					.regex(/^(all|\d+[smhd])$/, "Invalid since format")
					.default("all"),
				search: z
					.string()
					.regex(/^[a-zA-Z0-9 ._-]{0,500}$/)
					.optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServiceAccess(ctx, input.applicationId, "read");
			const application = await findApplicationById(input.applicationId);
			if (
				application.environment.project.organizationId !==
				ctx.session.activeOrganizationId
			) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this application",
				});
			}
			return await getContainerLogs(
				application.appName,
				input.tail,
				input.since,
				input.search,
				application.serverId,
			);
		}),
});
