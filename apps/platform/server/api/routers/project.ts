import {
	createApplication,
	createBackup,
	createCompose,
	createLibsql,
	createMariadb,
	createMongo,
	createMount,
	createMysql,
	createPort,
	createPostgres,
	createPreviewDeployment,
	createProject,
	createRedirect,
	createRedis,
	createSecurity,
	DEFAULT_PROJECT_ENVIRONMENT_NAME,
	deleteProject,
	findApplicationById,
	findComposeById,
	findEnvironmentById,
	findLibsqlById,
	findMariadbById,
	findMongoById,
	findMySqlById,
	findPostgresById,
	findProjectById,
	findRedisById,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { updateProjectCore } from "@nearzero/server/services/agent-workspace";
import {
	addNewEnvironment,
	addNewProject,
	checkPermission,
	checkProjectAccess,
	findMemberByUserId,
} from "@nearzero/server/services/permission";
import {
	buildServiceFilter,
	queryAccessibleProject,
	queryAccessibleProjects,
} from "@nearzero/server/services/project-queries";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateProject,
	apiFindOneProject,
	apiRemoveProject,
	apiUpdateProject,
	applications,
	compose,
	environments,
	libsql,
	mariadb,
	mongo,
	mysql,
	postgres,
	projects,
	redis,
} from "@/server/db/schema";

export const projectRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateProject)
		.mutation(async ({ ctx, input }) => {
			try {
				await checkProjectAccess(ctx, "create");

				const project = await createProject(
					input,
					ctx.session.activeOrganizationId,
				);

				const defaultEnvName = project.environment?.name?.trim().toLowerCase();
				if (defaultEnvName !== DEFAULT_PROJECT_ENVIRONMENT_NAME) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: `New projects must start with a ${DEFAULT_PROJECT_ENVIRONMENT_NAME} environment`,
					});
				}

				await addNewProject(ctx, project.project.projectId);

				const defaultEnvironmentId = project.environment?.environmentId?.trim();
				if (!defaultEnvironmentId) {
					throw new TRPCError({
						code: "INTERNAL_SERVER_ERROR",
						message: "Project was created without a default environment",
					});
				}
				await addNewEnvironment(ctx, defaultEnvironmentId);

				await audit(ctx, {
					action: "create",
					resourceType: "project",
					resourceId: project.project.projectId,
					resourceName: project.project.name,
				});
				return project;
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				const needsMigration =
					detail.includes("dnsZoneId") ||
					detail.includes("domainPrefix") ||
					detail.includes('relation "dns_zone"');
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: needsMigration
						? `Error creating the project: database schema is out of date (${detail}). Restart the platform server after migrations run, or execute npm run migration:run in apps/platform.`
						: `Error creating the project: ${detail}`,
					cause: error,
				});
			}
		}),

	one: protectedProcedure
		.input(apiFindOneProject)
		.query(async ({ input, ctx }) => {
			return queryAccessibleProject(
				{
					userId: ctx.user.id,
					organizationId: ctx.session.activeOrganizationId,
					userRole: ctx.user.role,
				},
				input.projectId,
			);
		}),
	all: protectedProcedure.query(async ({ ctx }) => {
		return queryAccessibleProjects({
			userId: ctx.user.id,
			organizationId: ctx.session.activeOrganizationId,
			userRole: ctx.user.role,
		});
	}),

	allForPermissions: withPermission("member", "update").query(
		async ({ ctx }) => {
			return await db.query.projects.findMany({
				where: eq(projects.organizationId, ctx.session.activeOrganizationId),
				orderBy: desc(projects.createdAt),
				columns: {
					projectId: true,
					name: true,
				},
				with: {
					environments: {
						columns: {
							environmentId: true,
							name: true,
							isDefault: true,
						},
						with: {
							applications: {
								columns: {
									applicationId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							mariadb: {
								columns: {
									mariadbId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							postgres: {
								columns: {
									postgresId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							mysql: {
								columns: {
									mysqlId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							mongo: {
								columns: {
									mongoId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							redis: {
								columns: {
									redisId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
							compose: {
								columns: {
									composeId: true,
									appName: true,
									name: true,
									createdAt: true,
									composeStatus: true,
									description: true,
									serverId: true,
								},
							},
							libsql: {
								columns: {
									libsqlId: true,
									appName: true,
									name: true,
									createdAt: true,
									applicationStatus: true,
									description: true,
									serverId: true,
								},
							},
						},
					},
				},
			});
		},
	),

	homeStats: protectedProcedure.query(async ({ ctx }) => {
		const isPrivileged = ctx.user.role === "owner" || ctx.user.role === "admin";

		let accessedProjects: string[] = [];
		let accessedEnvironments: string[] = [];
		let accessedServices: string[] = [];

		if (!isPrivileged) {
			const member = await findMemberByUserId(
				ctx.user.id,
				ctx.session.activeOrganizationId,
			);
			accessedProjects = member.accessedProjects;
			accessedEnvironments = member.accessedEnvironments;
			accessedServices = member.accessedServices;

			if (accessedProjects.length === 0) {
				return {
					projects: 0,
					environments: 0,
					applications: 0,
					compose: 0,
					databases: 0,
					services: 0,
					status: { running: 0, error: 0, idle: 0 },
				};
			}
		}

		const projectIdFilter = isPrivileged
			? eq(projects.organizationId, ctx.session.activeOrganizationId)
			: and(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((id) => sql`${id}`),
						sql`, `,
					)})`,
					eq(projects.organizationId, ctx.session.activeOrganizationId),
				);

		const environmentFilter = isPrivileged
			? undefined
			: accessedEnvironments.length === 0
				? sql`false`
				: sql`${environments.environmentId} IN (${sql.join(
						accessedEnvironments.map((envId) => sql`${envId}`),
						sql`, `,
					)})`;

		const applyFilter = (col: AnyPgColumn) =>
			isPrivileged ? undefined : buildServiceFilter(col, accessedServices);

		const rows = await db.query.projects.findMany({
			where: projectIdFilter,
			columns: { projectId: true },
			with: {
				environments: {
					where: environmentFilter,
					columns: { environmentId: true },
					with: {
						applications: {
							where: applyFilter(applications.applicationId),
							columns: { applicationStatus: true },
						},
						compose: {
							where: applyFilter(compose.composeId),
							columns: { composeStatus: true },
						},
						libsql: {
							where: applyFilter(libsql.libsqlId),
							columns: { applicationStatus: true },
						},
						mariadb: {
							where: applyFilter(mariadb.mariadbId),
							columns: { applicationStatus: true },
						},
						mongo: {
							where: applyFilter(mongo.mongoId),
							columns: { applicationStatus: true },
						},
						mysql: {
							where: applyFilter(mysql.mysqlId),
							columns: { applicationStatus: true },
						},
						postgres: {
							where: applyFilter(postgres.postgresId),
							columns: { applicationStatus: true },
						},
						redis: {
							where: applyFilter(redis.redisId),
							columns: { applicationStatus: true },
						},
					},
				},
			},
		});

		let applicationsCount = 0;
		let composeCount = 0;
		let databasesCount = 0;
		let environmentsCount = 0;
		const status = { running: 0, error: 0, idle: 0 };
		const bump = (s?: string | null) => {
			if (s === "done") status.running++;
			else if (s === "error") status.error++;
			else status.idle++;
		};

		for (const project of rows) {
			for (const env of project.environments) {
				environmentsCount++;
				applicationsCount += env.applications.length;
				composeCount += env.compose.length;
				databasesCount +=
					env.libsql.length +
					env.mariadb.length +
					env.mongo.length +
					env.mysql.length +
					env.postgres.length +
					env.redis.length;

				for (const a of env.applications) bump(a.applicationStatus);
				for (const c of env.compose) bump(c.composeStatus);
				for (const s of env.libsql) bump(s.applicationStatus);
				for (const s of env.mariadb) bump(s.applicationStatus);
				for (const s of env.mongo) bump(s.applicationStatus);
				for (const s of env.mysql) bump(s.applicationStatus);
				for (const s of env.postgres) bump(s.applicationStatus);
				for (const s of env.redis) bump(s.applicationStatus);
			}
		}

		return {
			projects: rows.length,
			environments: environmentsCount,
			applications: applicationsCount,
			compose: composeCount,
			databases: databasesCount,
			services: applicationsCount + composeCount + databasesCount,
			status,
		};
	}),

	search: protectedProcedure
		.input(
			z.object({
				q: z.string().optional(),
				name: z.string().optional(),
				description: z.string().optional(),
				limit: z.number().min(1).max(100).default(20),
				offset: z.number().min(0).default(0),
			}),
		)
		.query(async ({ ctx, input }) => {
			const baseConditions = [
				eq(projects.organizationId, ctx.session.activeOrganizationId),
			];

			if (input.q?.trim()) {
				const term = `%${input.q.trim()}%`;
				baseConditions.push(
					or(
						ilike(projects.name, term),
						ilike(projects.description ?? "", term),
					)!,
				);
			}

			if (input.name?.trim()) {
				baseConditions.push(ilike(projects.name, `%${input.name.trim()}%`));
			}
			if (input.description?.trim()) {
				baseConditions.push(
					ilike(projects.description ?? "", `%${input.description.trim()}%`),
				);
			}

			if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
				const { accessedProjects } = await findMemberByUserId(
					ctx.user.id,
					ctx.session.activeOrganizationId,
				);
				if (accessedProjects.length === 0) return { items: [], total: 0 };
				baseConditions.push(
					sql`${projects.projectId} IN (${sql.join(
						accessedProjects.map((id) => sql`${id}`),
						sql`, `,
					)})`,
				);
			}

			const where = and(...baseConditions);

			const [items, countResult] = await Promise.all([
				db.query.projects.findMany({
					where,
					limit: input.limit,
					offset: input.offset,
					orderBy: desc(projects.createdAt),
					columns: {
						projectId: true,
						name: true,
						description: true,
						createdAt: true,
						organizationId: true,
						env: true,
					},
				}),
				db
					.select({ count: sql<number>`count(*)::int` })
					.from(projects)
					.where(where),
			]);

			return {
				items,
				total: countResult[0]?.count ?? 0,
			};
		}),

	remove: protectedProcedure
		.input(apiRemoveProject)
		.mutation(async ({ input, ctx }) => {
			try {
				const currentProject = await db.query.projects.findFirst({
					where: and(
						eq(projects.projectId, input.projectId),
						eq(projects.organizationId, ctx.session.activeOrganizationId),
					),
					columns: {
						projectId: true,
						name: true,
						organizationId: true,
					},
				});

				if (!currentProject) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Project not found",
					});
				}

				await checkProjectAccess(ctx, "delete", input.projectId);
				const deletedProject = await deleteProject(input.projectId);

				if (!deletedProject) {
					throw new TRPCError({
						code: "NOT_FOUND",
						message: "Project not found",
					});
				}

				await audit(ctx, {
					action: "delete",
					resourceType: "project",
					resourceId: currentProject.projectId,
					resourceName: currentProject.name,
				});
				return deletedProject;
			} catch (error) {
				if (error instanceof TRPCError) {
					throw error;
				}
				throw new TRPCError({
					code: "INTERNAL_SERVER_ERROR",
					message: `Error deleting the project: ${error instanceof Error ? error.message : error}`,
					cause: error,
				});
			}
		}),
	update: protectedProcedure
		.input(apiUpdateProject)
		.mutation(async ({ input, ctx }) => {
			try {
				const currentProject = await findProjectById(input.projectId);
				if (
					currentProject.organizationId !== ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to update this project",
					});
				}

				if (ctx.user.role !== "owner" && ctx.user.role !== "admin") {
					const { accessedProjects } = await findMemberByUserId(
						ctx.user.id,
						ctx.session.activeOrganizationId,
					);
					if (!accessedProjects.includes(input.projectId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this project",
						});
					}
				}

				if (input.env !== undefined) {
					await checkPermission(ctx, { projectEnvVars: ["write"] });
				}

				const { projectId, ...updateData } = input;
				const project = await updateProjectCore(projectId, updateData);

				if (project) {
					await audit(ctx, {
						action: "update",
						resourceType: "project",
						resourceId: input.projectId,
						resourceName: project.name,
					});
				}
				return project;
			} catch (error) {
				throw error;
			}
		}),
	duplicate: protectedProcedure
		.input(
			z.object({
				sourceEnvironmentId: z.string(),
				name: z.string(),
				description: z.string().optional(),
				includeServices: z.boolean().default(true),
				selectedServices: z
					.array(
						z.object({
							id: z.string(),
							type: z.enum([
								"application",
								"compose",
								"libsql",
								"mariadb",
								"mongo",
								"mysql",
								"postgres",
								"redis",
							]),
						}),
					)
					.optional(),
				duplicateInSameProject: z.boolean().default(false),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			try {
				await checkProjectAccess(ctx, "create");

				const sourceEnvironment = input.duplicateInSameProject
					? await findEnvironmentById(input.sourceEnvironmentId)
					: null;

				if (
					input.duplicateInSameProject &&
					sourceEnvironment?.project.organizationId !==
						ctx.session.activeOrganizationId
				) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this project",
					});
				}

				if (
					input.duplicateInSameProject &&
					sourceEnvironment &&
					ctx.user.role !== "owner" &&
					ctx.user.role !== "admin"
				) {
					const { accessedProjects } = await findMemberByUserId(
						ctx.user.id,
						ctx.session.activeOrganizationId,
					);
					if (!accessedProjects.includes(sourceEnvironment.project.projectId)) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this project",
						});
					}
				}

				const targetProject = input.duplicateInSameProject
					? sourceEnvironment
					: await createProject(
							{
								name: input.name,
								description: input.description,
								env: sourceEnvironment?.project.env,
							},
							ctx.session.activeOrganizationId,
						).then((value) => value.environment);

				if (input.includeServices) {
					const servicesToDuplicate = input.selectedServices || [];

					const duplicateService = async (id: string, type: string) => {
						switch (type) {
							case "application": {
								const {
									applicationId,
									domains,
									security,
									ports,
									registry,
									redirects,
									previewDeployments,
									mounts,
									appName,
									refreshToken,
									...application
								} = await findApplicationById(id);
								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newApplication = await createApplication({
									...application,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${application.name} (copy)`
										: application.name,
									environmentId: targetProject?.environmentId || "",
								});

								// Hostnames are globally exclusive claims. A duplicated service
								// receives a new default hostname on deployment instead of
								// copying a route that still belongs to the source service.
								void domains;

								for (const port of ports) {
									const { portId, ...rest } = port;
									await createPort({
										...rest,
										applicationId: newApplication.applicationId,
									});
								}

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newApplication.applicationId,
										serviceType: "application",
									});
								}

								for (const redirect of redirects) {
									const { redirectId, ...rest } = redirect;
									await createRedirect({
										...rest,
										applicationId: newApplication.applicationId,
									});
								}

								for (const secure of security) {
									const { securityId, ...rest } = secure;
									await createSecurity({
										...rest,
										applicationId: newApplication.applicationId,
									});
								}

								for (const previewDeployment of previewDeployments) {
									const { previewDeploymentId, ...rest } = previewDeployment;
									await createPreviewDeployment({
										...rest,
										applicationId: newApplication.applicationId,
										domainId: undefined,
									});
								}

								break;
							}
							case "compose": {
								const {
									composeId,
									mounts,
									domains,
									appName,
									refreshToken,
									...compose
								} = await findComposeById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newCompose = await createCompose({
									...compose,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${compose.name} (copy)`
										: compose.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newCompose.composeId,
										serviceType: "compose",
									});
								}

								void domains;

								break;
							}
							case "libsql": {
								const { libsqlId, mounts, appName, ...libsql } =
									await findLibsqlById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newLibsql = await createLibsql({
									...libsql,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${libsql.name} (copy)`
										: libsql.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newLibsql.libsqlId,
										serviceType: "libsql",
									});
								}

								break;
							}
							case "mariadb": {
								const { mariadbId, mounts, backups, appName, ...mariadb } =
									await findMariadbById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newMariadb = await createMariadb({
									...mariadb,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${mariadb.name} (copy)`
										: mariadb.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newMariadb.mariadbId,
										serviceType: "mariadb",
									});
								}

								for (const backup of backups) {
									const { backupId, appName: _appName, ...rest } = backup;
									await createBackup({
										...rest,
										mariadbId: newMariadb.mariadbId,
									});
								}
								break;
							}
							case "mongo": {
								const { mongoId, mounts, backups, appName, ...mongo } =
									await findMongoById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newMongo = await createMongo({
									...mongo,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${mongo.name} (copy)`
										: mongo.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newMongo.mongoId,
										serviceType: "mongo",
									});
								}

								for (const backup of backups) {
									const { backupId, appName: _appName, ...rest } = backup;
									await createBackup({
										...rest,
										mongoId: newMongo.mongoId,
									});
								}
								break;
							}
							case "mysql": {
								const { mysqlId, mounts, backups, appName, ...mysql } =
									await findMySqlById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newMysql = await createMysql({
									...mysql,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${mysql.name} (copy)`
										: mysql.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newMysql.mysqlId,
										serviceType: "mysql",
									});
								}

								for (const backup of backups) {
									const { backupId, appName: _appName, ...rest } = backup;
									await createBackup({
										...rest,
										mysqlId: newMysql.mysqlId,
									});
								}
								break;
							}
							case "postgres": {
								const { postgresId, mounts, backups, appName, ...postgres } =
									await findPostgresById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newPostgres = await createPostgres({
									...postgres,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${postgres.name} (copy)`
										: postgres.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newPostgres.postgresId,
										serviceType: "postgres",
									});
								}

								for (const backup of backups) {
									const { backupId, ...rest } = backup;
									await createBackup({
										...rest,
										postgresId: newPostgres.postgresId,
									});
								}
								break;
							}
							case "redis": {
								const { redisId, mounts, appName, ...redis } =
									await findRedisById(id);

								const newAppName = appName.substring(
									0,
									appName.lastIndexOf("-"),
								);

								const newRedis = await createRedis({
									...redis,
									appName: newAppName,
									name: input.duplicateInSameProject
										? `${redis.name} (copy)`
										: redis.name,
									environmentId: targetProject?.environmentId || "",
								});

								for (const mount of mounts) {
									const { mountId, ...rest } = mount;
									await createMount({
										...rest,
										serviceId: newRedis.redisId,
										serviceType: "redis",
									});
								}

								break;
							}
						}
					};

					for (const service of servicesToDuplicate) {
						await duplicateService(service.id, service.type);
					}
				}

				if (!input.duplicateInSameProject) {
					await addNewProject(ctx, targetProject?.projectId || "");
				}

				await audit(ctx, {
					action: "create",
					resourceType: "project",
					resourceId: targetProject?.projectId || "",
					resourceName: input.name,
					metadata: { duplicatedFrom: input.sourceEnvironmentId },
				});
				return targetProject;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Error duplicating the project: ${error instanceof Error ? error.message : error}`,
					cause: error,
				});
			}
		}),
});
