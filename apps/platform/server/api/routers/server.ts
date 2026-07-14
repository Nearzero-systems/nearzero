import type { ServerServiceInventory } from "@nearzero/server";
import {
	createServer,
	defaultCommand,
	deleteAllMiddlewares,
	deleteServer,
	ensureWebMonitoring,
	findApplicationById,
	findBackupsByDbId,
	findComposeById,
	findDomainsByApplicationId,
	findDomainsByPreviewDeploymentIds,
	findLibsqlById,
	findMariadbById,
	findMongoById,
	findMySqlById,
	findPostgresById,
	findRedisById,
	findServerById,
	getAccessibleServerIds,
	getPublicIpWithFallback,
	getReadyRuntimeServers,
	getServerServiceInventory,
	removeCompose,
	removeComposeDirectory,
	removeDeployments,
	removeDeploymentsByComposeId,
	removeDeploymentsByServerId,
	removeDirectoryCode,
	removeDomainById,
	removeLibsqlById,
	removeMariadbById,
	removeMongoById,
	removeMonitoringDirectory,
	removeMySqlById,
	removePostgresById,
	removeRedisById,
	removeService,
	removeTraefikConfig,
	serverAudit,
	serverSetup,
	serverValidate,
	setupMonitoring,
	toPublicServer,
	updateServerById,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { hasValidLicense } from "@nearzero/server/services/license-key";
import { requestMonitoring } from "@nearzero/server/services/monitoring-client";
import {
	checkServiceAccess,
	type PermissionCtx,
} from "@nearzero/server/services/permission";
import { monitoringDockerAccessConfig } from "@nearzero/server/setup/monitoring-setup";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { and, desc, eq, getTableColumns, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	assertServerRemoveAllowed,
	assertServerRemoveCleanupComplete,
	preflightServerAttachedServiceDeleteAccess,
} from "@/server/api/utils/server-delete";
import {
	apiCreateServer,
	apiFindOneServer,
	apiRemoveServer,
	apiUpdateServer,
	apiUpdateServerMonitoring,
	applications,
	compose,
	libsql,
	mariadb,
	mongo,
	mysql,
	organization,
	postgres,
	redis,
	server,
} from "@/server/db/schema";
import {
	getJobsByApplicationId,
	getJobsByComposeId,
	prepareDeploymentJobsForServiceDeletion,
} from "@/server/queues/queueSetup";
import { cancelJobs } from "@/server/utils/backup";
import { cancelQueuedDeployment } from "@/server/utils/deploy";

type ServerDeleteCtx = Parameters<typeof audit>[0] & PermissionCtx;

type AttachedApplication = Awaited<ReturnType<typeof findApplicationById>>;
type AttachedCompose = Awaited<ReturnType<typeof findComposeById>>;
type AttachedRedis = Awaited<ReturnType<typeof findRedisById>>;
type AttachedMariadb = Awaited<ReturnType<typeof findMariadbById>>;
type AttachedMongo = Awaited<ReturnType<typeof findMongoById>>;
type AttachedMysql = Awaited<ReturnType<typeof findMySqlById>>;
type AttachedPostgres = Awaited<ReturnType<typeof findPostgresById>>;
type AttachedLibsql = Awaited<ReturnType<typeof findLibsqlById>>;

type AttachedServicesForServerDelete = {
	applications: AttachedApplication[];
	compose: AttachedCompose[];
	redis: AttachedRedis[];
	mariadb: AttachedMariadb[];
	mongo: AttachedMongo[];
	mysql: AttachedMysql[];
	postgres: AttachedPostgres[];
	libsql: AttachedLibsql[];
};

const assertServiceBelongsToOrganization = (
	service: {
		environment: { project: { organizationId: string } };
	},
	organizationId: string,
	message: string,
) => {
	if (service.environment.project.organizationId !== organizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message,
		});
	}
};

const assertServiceStillAttachedToServer = (
	service: { serverId?: string | null },
	serverId: string,
) => {
	if (service.serverId !== serverId) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Attached services changed. Refresh and try again.",
		});
	}
};

const throwIfCleanupReturnedError = (result: unknown) => {
	if (result instanceof Error) {
		throw result;
	}
};

const wrapAttachedServiceCleanupError = (
	serviceName: string,
	error: unknown,
) => {
	throw new TRPCError({
		code: "BAD_REQUEST",
		message: `Failed to delete attached service "${serviceName}" before deleting server`,
		cause: error,
	});
};

const loadAttachedServicesForServerDelete = async (
	serverId: string,
	inventory: ServerServiceInventory,
	ctx: ServerDeleteCtx,
): Promise<AttachedServicesForServerDelete> => {
	const services: AttachedServicesForServerDelete = {
		applications: [],
		compose: [],
		redis: [],
		mariadb: [],
		mongo: [],
		mysql: [],
		postgres: [],
		libsql: [],
	};

	for (const item of inventory.applications) {
		const application = await findApplicationById(item.applicationId);
		assertServiceBelongsToOrganization(
			application,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this application",
		);
		assertServiceStillAttachedToServer(application, serverId);
		services.applications.push(application);
	}

	for (const item of inventory.compose) {
		const composeService = await findComposeById(item.composeId);
		assertServiceBelongsToOrganization(
			composeService,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this compose",
		);
		assertServiceStillAttachedToServer(composeService, serverId);
		services.compose.push(composeService);
	}

	for (const item of inventory.redis) {
		const redisService = await findRedisById(item.redisId);
		assertServiceBelongsToOrganization(
			redisService,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this Redis",
		);
		assertServiceStillAttachedToServer(redisService, serverId);
		services.redis.push(redisService);
	}

	for (const item of inventory.mariadb) {
		const mariadbService = await findMariadbById(item.mariadbId);
		assertServiceBelongsToOrganization(
			mariadbService,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this Mariadb",
		);
		assertServiceStillAttachedToServer(mariadbService, serverId);
		services.mariadb.push(mariadbService);
	}

	for (const item of inventory.mongo) {
		const mongoService = await findMongoById(item.mongoId);
		assertServiceBelongsToOrganization(
			mongoService,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this mongo",
		);
		assertServiceStillAttachedToServer(mongoService, serverId);
		services.mongo.push(mongoService);
	}

	for (const item of inventory.mysql) {
		const mysqlService = await findMySqlById(item.mysqlId);
		assertServiceBelongsToOrganization(
			mysqlService,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this MySQL",
		);
		assertServiceStillAttachedToServer(mysqlService, serverId);
		services.mysql.push(mysqlService);
	}

	for (const item of inventory.postgres) {
		const postgresService = await findPostgresById(item.postgresId);
		assertServiceBelongsToOrganization(
			postgresService,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this Postgres",
		);
		assertServiceStillAttachedToServer(postgresService, serverId);
		services.postgres.push(postgresService);
	}

	for (const item of inventory.libsql) {
		const libsqlService = await findLibsqlById(item.libsqlId);
		assertServiceBelongsToOrganization(
			libsqlService,
			ctx.session.activeOrganizationId,
			"You are not authorized to delete this Libsql",
		);
		assertServiceStillAttachedToServer(libsqlService, serverId);
		services.libsql.push(libsqlService);
	}

	return services;
};

const deleteAttachedApplicationForServerDelete = async (
	application: AttachedApplication,
	ctx: ServerDeleteCtx,
) => {
	try {
		await cancelQueuedDeployment({
			applicationId: application.applicationId,
			applicationType: "application",
		});
		const currentApplication = await findApplicationById(
			application.applicationId,
		);
		if (
			currentApplication.applicationStatus === "running" ||
			currentApplication.previewDeployments.some(
				(preview) => preview.previewStatus === "running",
			)
		) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Wait for or cancel active application and preview deployments before deleting the server",
			});
		}
		const queueJobs = await getJobsByApplicationId(application.applicationId);
		if (!(await prepareDeploymentJobsForServiceDeletion(queueJobs))) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Wait for or cancel the active deployment before deleting the server",
			});
		}
		const attachedDomains = await findDomainsByApplicationId(
			currentApplication.applicationId,
		);
		const previewDomains = await findDomainsByPreviewDeploymentIds(
			currentApplication.previewDeployments.map(
				(preview) => preview.previewDeploymentId,
			),
		);
		const attachedDomainIds = new Set([
			...attachedDomains.map((domain) => domain.domainId),
			...previewDomains.map((domain) => domain.domainId),
			...currentApplication.previewDeployments
				.map((preview) => preview.domainId)
				.filter((domainId): domainId is string => Boolean(domainId)),
		]);
		for (const domainId of attachedDomainIds) {
			await removeDomainById(domainId);
		}

		await deleteAllMiddlewares(application);
		await removeDeployments(application);
		await removeDirectoryCode(application.appName, application.serverId);
		await removeMonitoringDirectory(application.appName, application.serverId);
		await removeTraefikConfig(application.appName, application.serverId);
		throwIfCleanupReturnedError(
			await removeService(
				application.appName,
				application.serverId,
				true,
				true,
			),
		);
		await db
			.delete(applications)
			.where(eq(applications.applicationId, application.applicationId))
			.returning();

		await audit(ctx, {
			action: "delete",
			resourceType: "service",
			resourceId: application.applicationId,
			resourceName: application.appName,
		});
	} catch (error) {
		wrapAttachedServiceCleanupError(application.appName, error);
	}
};

const deleteAttachedComposeForServerDelete = async (
	composeService: AttachedCompose,
	ctx: ServerDeleteCtx,
) => {
	try {
		await cancelQueuedDeployment({
			composeId: composeService.composeId,
			applicationType: "compose",
		});
		const currentCompose = await findComposeById(composeService.composeId);
		if (currentCompose.composeStatus === "running") {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Wait for the active Compose deployment to finish before deleting the server",
			});
		}
		const queueJobs = await getJobsByComposeId(composeService.composeId);
		if (!(await prepareDeploymentJobsForServiceDeletion(queueJobs))) {
			throw new TRPCError({
				code: "CONFLICT",
				message:
					"Wait for the active Compose deployment to finish before deleting the server",
			});
		}
		for (const domain of currentCompose.domains) {
			await removeDomainById(domain.domainId);
		}

		await removeCompose(composeService, true);
		await removeDeploymentsByComposeId(composeService);
		await removeComposeDirectory(
			composeService.appName,
			composeService.serverId,
		);
		await db
			.delete(compose)
			.where(eq(compose.composeId, composeService.composeId))
			.returning();

		await audit(ctx, {
			action: "delete",
			resourceType: "service",
			resourceId: composeService.composeId,
			resourceName: composeService.name,
		});
	} catch (error) {
		wrapAttachedServiceCleanupError(composeService.name, error);
	}
};

const deleteAttachedDatabaseForServerDelete = async (
	service: {
		id: string;
		appName: string;
		serverId?: string | null;
		backupType?: "postgres" | "mysql" | "mariadb" | "mongo" | "libsql";
		removeRecord: () => Promise<unknown>;
	},
	ctx: ServerDeleteCtx,
) => {
	try {
		throwIfCleanupReturnedError(
			await removeService(service.appName, service.serverId, true, true),
		);
		if (service.backupType) {
			const backups = await findBackupsByDbId(service.id, service.backupType);
			await cancelJobs(backups);
		}
		await service.removeRecord();

		await audit(ctx, {
			action: "delete",
			resourceType: "service",
			resourceId: service.id,
			resourceName: service.appName,
		});
	} catch (error) {
		wrapAttachedServiceCleanupError(service.appName, error);
	}
};

const deleteAttachedServicesForServerDelete = async (
	services: AttachedServicesForServerDelete,
	ctx: ServerDeleteCtx,
) => {
	for (const application of services.applications) {
		await deleteAttachedApplicationForServerDelete(application, ctx);
	}

	for (const composeService of services.compose) {
		await deleteAttachedComposeForServerDelete(composeService, ctx);
	}

	for (const redisService of services.redis) {
		await deleteAttachedDatabaseForServerDelete(
			{
				id: redisService.redisId,
				appName: redisService.appName,
				serverId: redisService.serverId,
				removeRecord: () => removeRedisById(redisService.redisId),
			},
			ctx,
		);
	}

	for (const mariadbService of services.mariadb) {
		await deleteAttachedDatabaseForServerDelete(
			{
				id: mariadbService.mariadbId,
				appName: mariadbService.appName,
				serverId: mariadbService.serverId,
				backupType: "mariadb",
				removeRecord: () => removeMariadbById(mariadbService.mariadbId),
			},
			ctx,
		);
	}

	for (const mongoService of services.mongo) {
		await deleteAttachedDatabaseForServerDelete(
			{
				id: mongoService.mongoId,
				appName: mongoService.appName,
				serverId: mongoService.serverId,
				backupType: "mongo",
				removeRecord: () => removeMongoById(mongoService.mongoId),
			},
			ctx,
		);
	}

	for (const mysqlService of services.mysql) {
		await deleteAttachedDatabaseForServerDelete(
			{
				id: mysqlService.mysqlId,
				appName: mysqlService.appName,
				serverId: mysqlService.serverId,
				backupType: "mysql",
				removeRecord: () => removeMySqlById(mysqlService.mysqlId),
			},
			ctx,
		);
	}

	for (const postgresService of services.postgres) {
		await deleteAttachedDatabaseForServerDelete(
			{
				id: postgresService.postgresId,
				appName: postgresService.appName,
				serverId: postgresService.serverId,
				backupType: "postgres",
				removeRecord: () => removePostgresById(postgresService.postgresId),
			},
			ctx,
		);
	}

	for (const libsqlService of services.libsql) {
		await deleteAttachedDatabaseForServerDelete(
			{
				id: libsqlService.libsqlId,
				appName: libsqlService.appName,
				serverId: libsqlService.serverId,
				backupType: "libsql",
				removeRecord: () => removeLibsqlById(libsqlService.libsqlId),
			},
			ctx,
		);
	}
};

export const serverRouter = createTRPCRouter({
	create: withPermission("server", "create")
		.input(apiCreateServer)
		.mutation(async ({ ctx, input }) => {
			try {
				const project = await createServer(
					input,
					ctx.session.activeOrganizationId,
				);
				await audit(ctx, {
					action: "create",
					resourceType: "server",
					resourceId: project.serverId,
					resourceName: project.name,
				});
				return toPublicServer(project);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error creating the server",
					cause: error,
				});
			}
		}),

	one: withPermission("server", "read")
		.input(apiFindOneServer)
		.query(async ({ input, ctx }) => {
			const server = await findServerById(input.serverId);
			if (server.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this server",
				});
			}

			const accessibleIds = await getAccessibleServerIds(ctx.session);
			if (!accessibleIds.has(input.serverId)) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You are not authorized to access this server",
				});
			}

			return toPublicServer(server);
		}),
	getDefaultCommand: withPermission("server", "read")
		.input(apiFindOneServer)
		.query(async ({ input }) => {
			await findServerById(input.serverId);
			return defaultCommand();
		}),
	all: withPermission("server", "read").query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleServerIds(ctx.session);

		const result = await db
			.select({
				...getTableColumns(server),
				totalSum: sql<number>`cast(count(distinct ${applications.applicationId}) + count(distinct ${compose.composeId}) + count(distinct ${redis.redisId}) + count(distinct ${mariadb.mariadbId}) + count(distinct ${mongo.mongoId}) + count(distinct ${mysql.mysqlId}) + count(distinct ${postgres.postgresId}) + count(distinct ${libsql.libsqlId}) as integer)`,
			})
			.from(server)
			.leftJoin(applications, eq(applications.serverId, server.serverId))
			.leftJoin(compose, eq(compose.serverId, server.serverId))
			.leftJoin(redis, eq(redis.serverId, server.serverId))
			.leftJoin(mariadb, eq(mariadb.serverId, server.serverId))
			.leftJoin(mongo, eq(mongo.serverId, server.serverId))
			.leftJoin(mysql, eq(mysql.serverId, server.serverId))
			.leftJoin(postgres, eq(postgres.serverId, server.serverId))
			.leftJoin(libsql, eq(libsql.serverId, server.serverId))
			.where(eq(server.organizationId, ctx.session.activeOrganizationId))
			.orderBy(desc(server.createdAt))
			.groupBy(server.serverId);

		return result
			.filter((s) => accessibleIds.has(s.serverId))
			.map(toPublicServer);
	}),
	allForPermissions: withPermission("member", "update")
		.use(async ({ ctx, next }) => {
			const licensed = await hasValidLicense(ctx.session.activeOrganizationId);
			if (!licensed) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Valid enterprise license required",
				});
			}
			return next();
		})
		.query(async ({ ctx }) => {
			return await db.query.server.findMany({
				columns: {
					serverId: true,
					name: true,
					ipAddress: true,
				},
				orderBy: desc(server.createdAt),
				where: eq(server.organizationId, ctx.session.activeOrganizationId),
			});
		}),
	count: protectedProcedure.query(async ({ ctx }) => {
		const organizations = await db.query.organization.findMany({
			where: eq(organization.ownerId, ctx.user.id),
			with: {
				servers: true,
			},
		});

		const servers = organizations.flatMap((org) => org.servers);

		return servers.length ?? 0;
	}),
	withSSHKey: withPermission("server", "read").query(async ({ ctx }) => {
		const accessibleIds = await getAccessibleServerIds(ctx.session);

		const result = await db.query.server.findMany({
			orderBy: desc(server.createdAt),
			where: and(
				isNotNull(server.sshKeyId),
				eq(server.organizationId, ctx.session.activeOrganizationId),
			),
		});
		return result
			.filter((s) => accessibleIds.has(s.serverId))
			.map(toPublicServer);
	}),
	readyRuntimeServers: withPermission("server", "read").query(
		async ({ ctx }) => {
			const accessibleIds = await getAccessibleServerIds(ctx.session);
			const result = await getReadyRuntimeServers(
				ctx.session.activeOrganizationId,
			);
			return result
				.filter((s) => accessibleIds.has(s.serverId))
				.map(toPublicServer);
		},
	),
	setup: withPermission("server", "create")
		.input(apiFindOneServer)
		.mutation(async ({ input, ctx }) => {
			try {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to setup this server",
					});
				}
				await audit(ctx, {
					action: "run",
					resourceType: "server",
					resourceId: input.serverId,
					resourceName: server.name,
					metadata: {
						event: "server_setup_started",
					},
				});
				const currentServer = await serverSetup(input.serverId);
				await audit(ctx, {
					action: "update",
					resourceType: "server",
					resourceId: input.serverId,
					resourceName: server.name,
					metadata: {
						event: "server_setup_succeeded",
					},
				});
				return currentServer;
			} catch (error) {
				const server = await findServerById(input.serverId).catch(() => null);
				if (server) {
					await audit(ctx, {
						action: "update",
						resourceType: "server",
						resourceId: input.serverId,
						resourceName: server.name,
						metadata: {
							event: "server_setup_failed",
						},
					});
				}
				throw error;
			}
		}),
	setupWithLogs: withPermission("server", "create")
		.meta({
			openapi: {
				path: "/deploy/server-with-logs",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiFindOneServer)
		.subscription(async ({ input, ctx }) => {
			try {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to setup this server",
					});
				}
				return observable<string>((emit) => {
					void audit(ctx, {
						action: "run",
						resourceType: "server",
						resourceId: input.serverId,
						resourceName: server.name,
						metadata: {
							event: "server_setup_log_opened",
						},
					});
					serverSetup(input.serverId, (log) => {
						emit.next(log);
					})
						.then(() => {
							void audit(ctx, {
								action: "update",
								resourceType: "server",
								resourceId: input.serverId,
								resourceName: server.name,
								metadata: {
									event: "server_setup_succeeded",
								},
							});
							emit.complete();
						})
						.catch((error) => {
							void audit(ctx, {
								action: "update",
								resourceType: "server",
								resourceId: input.serverId,
								resourceName: server.name,
								metadata: {
									event: "server_setup_failed",
								},
							});
							emit.error(error);
						});
				});
			} catch (error) {
				throw error;
			}
		}),
	validate: withPermission("server", "read")
		.input(apiFindOneServer)
		.query(async ({ input, ctx }) => {
			try {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to validate this server",
					});
				}
				const response = await serverValidate(input.serverId);
				return response as unknown as {
					docker: {
						enabled: boolean;
						version: string;
					};
					rclone: {
						enabled: boolean;
						version: string;
					};
					nixpacks: {
						enabled: boolean;
						version: string;
					};
					buildpacks: {
						enabled: boolean;
						version: string;
					};
					railpack: {
						enabled: boolean;
						version: string;
					};
					isNearzeroNetworkInstalled: boolean;
					isSwarmInstalled: boolean;
					isMainDirectoryInstalled: boolean;
					privilegeMode: string;
					dockerGroupMember: boolean;
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
					cause: error as Error,
				});
			}
		}),

	security: withPermission("server", "read")
		.input(apiFindOneServer)
		.query(async ({ input, ctx }) => {
			try {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to validate this server",
					});
				}
				const response = await serverAudit(input.serverId);
				return response as unknown as {
					ufw: {
						installed: boolean;
						active: boolean;
						defaultIncoming: string;
					};
					ssh: {
						enabled: boolean;
						keyAuth: boolean;
						permitRootLogin: string;
						passwordAuth: string;
						usePam: string;
					};
					nonRootUser: {
						hasValidSudoUser: boolean;
					};
					unattendedUpgrades: {
						installed: boolean;
						active: boolean;
						updateEnabled: number;
						upgradeEnabled: number;
					};
					fail2ban: {
						installed: boolean;
						enabled: boolean;
						active: boolean;
						sshEnabled: string;
						sshMode: string;
					};
				};
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: error instanceof Error ? error?.message : `Error: ${error}`,
					cause: error as Error,
				});
			}
		}),
	setupMonitoring: withPermission("server", "create")
		.input(apiUpdateServerMonitoring)
		.mutation(async ({ input, ctx }) => {
			try {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to setup this server",
					});
				}
				monitoringDockerAccessConfig(
					input.metricsConfig.containers.services.include ?? [],
				);

				await updateServerById(input.serverId, {
					metricsConfig: {
						server: {
							type: "Remote",
							refreshRate: input.metricsConfig.server.refreshRate,
							retentionDays: input.metricsConfig.server.retentionDays,
							port: input.metricsConfig.server.port,
							token: input.metricsConfig.server.token,
							urlCallback: input.metricsConfig.server.urlCallback,
							cronJob: input.metricsConfig.server.cronJob,
							thresholds: {
								cpu: input.metricsConfig.server.thresholds.cpu,
								memory: input.metricsConfig.server.thresholds.memory,
							},
						},
						containers: {
							refreshRate: input.metricsConfig.containers.refreshRate,
							services: {
								include: input.metricsConfig.containers.services.include || [],
								exclude: input.metricsConfig.containers.services.exclude || [],
							},
						},
					},
				});
				const currentServer = await setupMonitoring(input.serverId);
				await audit(ctx, {
					action: "update",
					resourceType: "server",
					resourceId: input.serverId,
					resourceName: server.name,
				});
				return currentServer;
			} catch (error) {
				throw error;
			}
		}),
	remove: withPermission("server", "delete")
		.input(apiRemoveServer)
		.mutation(async ({ input, ctx }) => {
			try {
				const currentServer = await findServerById(input.serverId);
				if (currentServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to delete this server",
					});
				}

				const accessibleIds = await getAccessibleServerIds(ctx.session);
				if (!accessibleIds.has(input.serverId)) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to delete this server",
					});
				}

				const inventory = await getServerServiceInventory(input.serverId);
				assertServerRemoveAllowed(inventory, input.deleteAttachedServices);

				if (input.deleteAttachedServices && inventory.total > 0) {
					await preflightServerAttachedServiceDeleteAccess(
						inventory,
						async (service) => {
							await checkServiceAccess(ctx, service.id, "delete");
						},
					);
					const attachedServices = await loadAttachedServicesForServerDelete(
						input.serverId,
						inventory,
						ctx,
					);
					await deleteAttachedServicesForServerDelete(attachedServices, ctx);
					assertServerRemoveCleanupComplete(
						await getServerServiceInventory(input.serverId),
					);
				}

				await audit(ctx, {
					action: "delete",
					resourceType: "server",
					resourceId: currentServer.serverId,
					resourceName: currentServer.name,
				});
				await removeDeploymentsByServerId(currentServer);
				await deleteServer(input.serverId);

				return toPublicServer(currentServer);
			} catch (error) {
				throw error;
			}
		}),
	update: withPermission("server", "create")
		.input(apiUpdateServer)
		.mutation(async ({ input, ctx }) => {
			try {
				const server = await findServerById(input.serverId);
				if (server.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this server",
					});
				}

				if (server.serverStatus === "inactive") {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Server is inactive",
					});
				}
				const currentServer = await updateServerById(input.serverId, {
					...input,
				});

				await audit(ctx, {
					action: "update",
					resourceType: "server",
					resourceId: input.serverId,
					resourceName: server.name,
				});
				return currentServer ? toPublicServer(currentServer) : currentServer;
			} catch (error) {
				throw error;
			}
		}),
	publicIp: protectedProcedure.query(async () => {
		if (process.env.JOBS_URL) {
			return "";
		}
		const ip = await getPublicIpWithFallback();
		return ip;
	}),
	getServerTime: protectedProcedure.query(() => {
		if (process.env.JOBS_URL) {
			return null;
		}
		return {
			time: new Date(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		};
	}),
	getServerMetrics: withPermission("monitoring", "read")
		.input(
			z.object({
				serverId: z.string().min(1).optional(),
				dataPoints: z.string(),
			}),
		)
		.query(async ({ input, ctx }) => {
			try {
				if (input.serverId) {
					const target = await findServerById(input.serverId);
					if (target.organizationId !== ctx.session.activeOrganizationId) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to monitor this server",
						});
					}
					const accessibleIds = await getAccessibleServerIds(ctx.session);
					if (!accessibleIds.has(input.serverId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You are not authorized to monitor this server",
						});
					}
				}

				const fetchMetrics = () =>
					requestMonitoring({
						serverId: input.serverId,
						endpoint: { kind: "server" },
						limit: input.dataPoints,
					});
				let response: Awaited<ReturnType<typeof requestMonitoring>>;
				try {
					response = await fetchMetrics();
				} catch (error) {
					if (input.serverId) throw error;
					await ensureWebMonitoring();
					response = await fetchMetrics();
				}
				if (!input.serverId && response.status === 401) {
					await ensureWebMonitoring();
					response = await fetchMetrics();
				}
				if (response.status < 200 || response.status >= 300) {
					throw new Error(
						`Error ${response.status}: ${response.statusText}. Ensure the container is running and this service is included in the monitoring configuration.`,
					);
				}

				const data = JSON.parse(response.body) as unknown;
				if (!Array.isArray(data) || data.length === 0) {
					throw new Error(
						[
							"No monitoring data available. This could be because:",
							"",
							"1. You don't have setup the monitoring service, you can do in web server section.",
							"2. If you already have setup the monitoring service, wait a few minutes and refresh the page.",
						].join("\n"),
					);
				}
				return data as {
					cpu: string;
					cpuModel: string;
					cpuCores: number;
					cpuPhysicalCores: number;
					cpuSpeed: number;
					os: string;
					distro: string;
					kernel: string;
					arch: string;
					memUsed: string;
					memUsedGB: string;
					memTotal: string;
					uptime: number;
					diskUsed: string;
					totalDisk: string;
					networkIn: string;
					networkOut: string;
					timestamp: string;
				}[];
			} catch (error) {
				console.error("[getServerMetrics] Error:", error);
				if (error instanceof Error) {
					console.error(`[getServerMetrics] Error message: ${error.message}`);
					console.error("[getServerMetrics] Error cause:", error.cause);
				}
				throw error;
			}
		}),
});
