import {
	CLEANUP_CRON_JOB,
	checkGPUStatus,
	checkPortInUse,
	checkPostgresHealth,
	checkRedisHealth,
	checkTraefikHealth,
	cleanupAll,
	cleanupAllBackground,
	cleanupBuilders,
	cleanupContainers,
	cleanupImages,
	cleanupSystem,
	cleanupVolumes,
	DEFAULT_UPDATE_DATA,
	execAsync,
	findServerById,
	getDockerDiskUsage,
	getNearzeroImageTag,
	getLogCleanupStatus,
	getUpdateData,
	getWebServerSettings,
	parseRawConfig,
	paths,
	prepareEnvironmentVariables,
	processLogs,
	readConfig,
	readConfigInPath,
	readDirectory,
	readEnvironmentVariables,
	readMainConfig,
	readMonitoringConfig,
	readPorts,
	recreateDirectory,
	reloadDockerResource,
	sendDockerCleanupNotifications,
	setupGPUSupport,
	spawnAsync,
	startLogCleanup,
	stopLogCleanup,
	updateLetsEncryptEmail,
	updateServerById,
	updateServerTraefik,
	updateWebServerSettings,
	writeConfig,
	writeMainConfig,
	writeTraefikConfigInPath,
	writeTraefikSetup,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import { checkPermission } from "@nearzero/server/services/permission";
import { generateOpenApiDocument } from "@nearzero/trpc-openapi";
import { TRPCError } from "@trpc/server";
import { eq, sql } from "drizzle-orm";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	apiAssignDomain,
	apiEnableDashboard,
	apiModifyTraefikConfig,
	apiReadStatsLogs,
	apiReadTraefikConfig,
	apiSaveSSHKey,
	apiServerSchema,
	apiTraefikConfig,
	apiUpdateDockerCleanup,
	projects,
	server,
} from "@/server/db/schema";
import { cleanAllDeploymentQueue } from "@/server/queues/queueSetup";
import { removeJob, schedule } from "@/server/utils/backup";
import packageInfo from "../../../package.json";
import { appRouter } from "../root";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from "../trpc";

export const settingsRouter = createTRPCRouter({
	getWebServerSettings: protectedProcedure.query(async () => {
		const settings = await getWebServerSettings();
		return settings;
	}),
	reloadServer: adminProcedure.mutation(async ({ ctx }) => {
		await reloadDockerResource("nearzero", undefined, packageInfo.version);
		await audit(ctx, {
			action: "reload",
			resourceType: "settings",
			resourceName: "nearzero",
		});
		return true;
	}),
	cleanRedis: adminProcedure.mutation(async ({ ctx }) => {

		const { stdout: containerId } = await execAsync(
			`docker ps --filter "name=nearzero-redis" --filter "status=running" -q | head -n 1`,
		);

		if (!containerId) {
			throw new Error("Redis container not found");
		}

		const redisContainerId = containerId.trim();

		await execAsync(`docker exec -i ${redisContainerId} redis-cli flushall`);
		await audit(ctx, {
			action: "update",
			resourceType: "settings",
			resourceName: "clean-redis",
		});
		return true;
	}),
	reloadRedis: adminProcedure.mutation(async ({ ctx }) => {
		await reloadDockerResource("nearzero-redis");
		await audit(ctx, {
			action: "reload",
			resourceType: "settings",
			resourceName: "nearzero-redis",
		});
		return true;
	}),
	cleanAllDeploymentQueue: adminProcedure.mutation(async ({ ctx }) => {
		const result = cleanAllDeploymentQueue();
		await audit(ctx, {
			action: "update",
			resourceType: "settings",
			resourceName: "clean-deployment-queue",
		});
		return result;
	}),
	reloadTraefik: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			// Run in background so the request returns immediately; avoids proxy timeouts.
			void reloadDockerResource("nearzero-traefik", input?.serverId).catch(
				(err) => {
					console.error("reloadTraefik background:", err);
				},
			);
			await audit(ctx, {
				action: "reload",
				resourceType: "settings",
				resourceName: "nearzero-traefik",
			});
			return true;
		}),
	toggleDashboard: adminProcedure
		.input(apiEnableDashboard)
		.mutation(async ({ input, ctx }) => {
			const ports = await readPorts("nearzero-traefik", input.serverId);
			const env = await readEnvironmentVariables(
				"nearzero-traefik",
				input.serverId,
			);
			const preparedEnv = prepareEnvironmentVariables(env);
			let newPorts = ports;
			// If receive true, add 8080 to ports
			if (input.enableDashboard) {
				// Check if port 8080 is already in use before enabling dashboard
				const portCheck = await checkPortInUse(8080, input.serverId);
				if (portCheck.isInUse) {
					const conflictInfo = portCheck.conflictingContainer
						? ` by ${portCheck.conflictingContainer}`
						: "";
					throw new TRPCError({
						code: "CONFLICT",
						message: `Port 8080 is already in use${conflictInfo}. Please stop the conflicting service or use a different port for the Traefik dashboard.`,
					});
				}
				newPorts.push({
					targetPort: 8080,
					publishedPort: 8080,
					protocol: "tcp",
				});
			} else {
				newPorts = ports.filter((port) => port.targetPort !== 8080);
			}

			// Run in background so the request returns immediately; client polls /api/health.
			// Avoids proxy timeouts (520) while Traefik is recreated.
			void writeTraefikSetup({
				env: preparedEnv,
				additionalPorts: newPorts,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("toggleDashboard background writeTraefikSetup:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "toggle-dashboard",
			});
			return true;
		}),
	cleanUnusedImages: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupImages(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-images",
			});
			return true;
		}),
	cleanUnusedVolumes: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupVolumes(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-unused-volumes",
			});
			return true;
		}),
	cleanStoppedContainers: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupContainers(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-stopped-containers",
			});
			return true;
		}),
	cleanDockerBuilder: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-builder",
			});
		}),
	cleanDockerPrune: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			await cleanupSystem(input?.serverId);
			await cleanupBuilders(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-docker-prune",
			});
			return true;
		}),
	cleanAll: adminProcedure
		.input(apiServerSchema)
		.mutation(async ({ input, ctx }) => {
			// Execute cleanup in background and return immediately to avoid gateway timeouts
			const result = await cleanupAllBackground(input?.serverId);
			await audit(ctx, {
				action: "delete",
				resourceType: "settings",
				resourceName: "clean-all",
			});
			return result;
		}),
	cleanMonitoring: adminProcedure.mutation(async ({ ctx }) => {
		const { MONITORING_PATH } = paths();
		await recreateDirectory(MONITORING_PATH);
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "clean-monitoring",
		});
		return true;
	}),
	getDockerDiskUsage: adminProcedure.query(async () => {
		return getDockerDiskUsage();
	}),
	saveSSHPrivateKey: adminProcedure
		.input(apiSaveSSHKey)
		.mutation(async ({ input, ctx }) => {
			await updateWebServerSettings({
				sshPrivateKey: input.sshPrivateKey,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "ssh-private-key",
			});
			return true;
		}),
	assignDomainServer: adminProcedure
		.input(apiAssignDomain)
		.mutation(async ({ input, ctx }) => {
			const settings = await updateWebServerSettings({
				host: input.host,
				letsEncryptEmail: input.letsEncryptEmail,
				certificateType: input.certificateType,
				https: input.https,
			});

			if (!settings) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Web server settings not found",
				});
			}

			updateServerTraefik(settings, input.host);
			if (input.letsEncryptEmail) {
				updateLetsEncryptEmail(input.letsEncryptEmail);
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "assign-domain-server",
			});
			return settings;
		}),
	cleanSSHPrivateKey: adminProcedure.mutation(async ({ ctx }) => {
		await updateWebServerSettings({
			sshPrivateKey: null,
		});
		await audit(ctx, {
			action: "delete",
			resourceType: "settings",
			resourceName: "ssh-private-key",
		});
		return true;
	}),
	updateDockerCleanup: adminProcedure
		.input(apiUpdateDockerCleanup)
		.mutation(async ({ input, ctx }) => {
			if (input.serverId) {
				await updateServerById(input.serverId, {
					enableDockerCleanup: input.enableDockerCleanup,
				});

				const server = await findServerById(input.serverId);

				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You are not authorized to access this server",
					});
				}

				if (server.enableDockerCleanup) {
					const server = await findServerById(input.serverId);
					if (server.serverStatus === "inactive") {
						throw new TRPCError({
							code: "NOT_FOUND",
							message: "Server is inactive",
						});
					}
					if (process.env.JOBS_URL) {
					await schedule({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						scheduleJob(server.serverId, CLEANUP_CRON_JOB, async () => {
							console.log(
								`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
							);

							await cleanupAll(server.serverId);

							await sendDockerCleanupNotifications(server.organizationId);
						});
					}
				} else {
					if (process.env.JOBS_URL) {
					await removeJob({
							cronSchedule: CLEANUP_CRON_JOB,
							serverId: input.serverId,
							type: "server",
						});
					} else {
						const currentJob = scheduledJobs[server.serverId];
						currentJob?.cancel();
					}
				}
			} else {
				const settingsUpdated = await updateWebServerSettings({
					enableDockerCleanup: input.enableDockerCleanup,
				});

				if (settingsUpdated?.enableDockerCleanup) {
					scheduleJob("docker-cleanup", CLEANUP_CRON_JOB, async () => {
						console.log(
							`Docker Cleanup ${new Date().toLocaleString()}] Running...`,
						);

						await cleanupAll();

						await sendDockerCleanupNotifications(
							ctx.session.activeOrganizationId,
						);
					});
				} else {
					const currentJob = scheduledJobs["docker-cleanup"];
					currentJob?.cancel();
				}
			}

			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "docker-cleanup",
			});
			return true;
		}),

	readTraefikConfig: adminProcedure.query(() => {
		const traefikConfig = readMainConfig();
		return traefikConfig;
	}),

	updateTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			writeMainConfig(input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-config",
			});
			return true;
		}),

	readWebServerTraefikConfig: adminProcedure.query(() => {
		const traefikConfig = readConfig("nearzero");
		return traefikConfig;
	}),
	updateWebServerTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			writeConfig("nearzero", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "web-server-traefik-config",
			});
			return true;
		}),

	readMiddlewareTraefikConfig: adminProcedure.query(() => {
		const traefikConfig = readConfig("middlewares");
		return traefikConfig;
	}),

	updateMiddlewareTraefikConfig: adminProcedure
		.input(apiTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			writeConfig("middlewares", input.traefikConfig);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "middleware-traefik-config",
			});
			return true;
		}),
	getUpdateData: protectedProcedure.mutation(async () => {

		return await getUpdateData(packageInfo.version);
	}),
	updateServer: adminProcedure.mutation(async ({ ctx }) => {

		const data = await getUpdateData(packageInfo.version);
		if (data.updateAvailable) {
			void spawnAsync("docker", [
				"service",
				"update",
				"--force",
				"--image",
				`ghcr.io/nearzero-systems/nearzero:${data.latestVersion}`,
				"nearzero",
			]);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "nearzero-version",
			});
		}

		return true;
	}),

	getNearzeroVersion: protectedProcedure.query(() => {
		return packageInfo.version;
	}),
	getReleaseTag: protectedProcedure.query(() => {
		return getNearzeroImageTag();
	}),
	readDirectories: protectedProcedure
		.input(apiServerSchema)
		.query(async ({ ctx, input }) => {
			try {
				await checkPermission(ctx, { traefikFiles: ["read"] });
				const { MAIN_TRAEFIK_PATH } = paths(!!input?.serverId);
				const result = await readDirectory(MAIN_TRAEFIK_PATH, input?.serverId);
				return result || [];
			} catch (error) {
				throw error;
			}
		}),

	updateTraefikFile: protectedProcedure
		.input(apiModifyTraefikConfig)
		.mutation(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["write"] });
			await writeTraefikConfigInPath(
				input.path,
				input.traefikConfig,
				input?.serverId,
			);
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-file",
			});
			return true;
		}),

	readTraefikFile: protectedProcedure
		.input(apiReadTraefikConfig)
		.query(async ({ input, ctx }) => {
			await checkPermission(ctx, { traefikFiles: ["read"] });

			if (input.serverId) {
				const server = await findServerById(input.serverId);

				if (server.organizationId !== ctx.session?.activeOrganizationId) {
					throw new TRPCError({ code: "UNAUTHORIZED" });
				}
			}

			return readConfigInPath(input.path, input.serverId);
		}),
	getIp: protectedProcedure.query(async () => {
		const settings = await getWebServerSettings();
		return settings?.serverIp || "";
	}),
	updateServerIp: adminProcedure
		.input(
			z.object({
				serverIp: z.string(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const settings = await updateWebServerSettings({
				serverIp: input.serverIp,
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "server-ip",
			});
			return settings;
		}),

	getOpenApiDocument: protectedProcedure.query(
		async ({ ctx }): Promise<unknown> => {
			const protocol = ctx.req.headers["x-forwarded-proto"];
			const url = `${protocol}://${ctx.req.headers.host}/api`;
			const openApiDocument = generateOpenApiDocument(appRouter, {
				title: "tRPC OpenAPI",
				version: packageInfo.version,
				baseUrl: url,
				docsUrl: `${url}/settings.getOpenApiDocument`,
				tags: [
					"admin",
					"docker",
					"compose",
					"registry",
					"cluster",
					"user",
					"domain",
					"destination",
					"backup",
					"deployment",
					"mounts",
					"certificates",
					"settings",
					"security",
					"redirects",
					"port",
					"project",
					"application",
					"mysql",
					"postgres",
					"redis",
					"mongo",
					"libsql",
					"mariadb",
					"sshRouter",
					"gitProvider",
					"bitbucket",
					"ai",
					"github",
					"gitlab",
					"gitea",
					"tag",
					"patch",
					"server",
					"volumeBackups",
					"environment",
					"auditLog",
					"customRole",
					"whitelabeling",
					"sso",
					"licenseKey",
					"organization",
					"previewDeployment",
				],
			});

			openApiDocument.info = {
				title: "Nearzero API",
				description: "Endpoints for nearzero",
				version: packageInfo.version,
			};

			// Add security schemes configuration
			openApiDocument.components = {
				...openApiDocument.components,
				securitySchemes: {
					apiKey: {
						type: "apiKey",
						in: "header",
						name: "x-api-key",
						description: "API key authentication",
					},
				},
			};

			// Apply security globally to all endpoints
			openApiDocument.security = [
				{
					apiKey: [],
				},
			];
			return openApiDocument;
		},
	),
	readTraefikEnv: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			const envVars = await readEnvironmentVariables(
				"nearzero-traefik",
				input?.serverId,
			);
			return envVars;
		}),

	writeTraefikEnv: adminProcedure
		.input(z.object({ env: z.string(), serverId: z.string().optional() }))
		.mutation(async ({ input, ctx }) => {
			const envs = prepareEnvironmentVariables(input.env);
			const ports = await readPorts("nearzero-traefik", input?.serverId);

			// Run in background so the request returns immediately; client polls /api/health.
			void writeTraefikSetup({
				env: envs,
				additionalPorts: ports,
				serverId: input.serverId,
			}).catch((err) => {
				console.error("writeTraefikEnv background writeTraefikSetup:", err);
			});
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "traefik-env",
			});
			return true;
		}),
	haveTraefikDashboardPortEnabled: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			const ports = await readPorts("nearzero-traefik", input?.serverId);
			return ports.some((port) => port.targetPort === 8080);
		}),

	readStatsLogs: protectedProcedure
		.meta({
			openapi: {
				path: "/read-stats-logs",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(apiReadStatsLogs)
		.query(async ({ input }) => {
			const rawConfig = await readMonitoringConfig(
				!!input.dateRange?.start && !!input.dateRange?.end,
			);

			const parsedConfig = parseRawConfig(
				rawConfig as string,
				input.page,
				input.sort,
				input.search,
				input.status,
				input.dateRange,
			);

			return parsedConfig;
		}),
	readStats: adminProcedure
		.meta({
			openapi: {
				path: "/read-stats",
				method: "POST",
				override: true,
				enabled: false,
			},
		})
		.input(
			z
				.object({
					dateRange: z
						.object({
							start: z.string().optional(),
							end: z.string().optional(),
						})
						.optional(),
				})
				.optional(),
		)
		.query(async ({ input }) => {
			const rawConfig = await readMonitoringConfig(
				!!input?.dateRange?.start || !!input?.dateRange?.end,
			);
			const processedLogs = processLogs(rawConfig as string, input?.dateRange);
			return processedLogs || [];
		}),
	haveActivateRequests: protectedProcedure.query(async () => {
		const config = readMainConfig();

		if (!config) return false;
		const parsedConfig = parse(config) as {
			accessLog?: {
				filePath: string;
			};
		};

		return !!parsedConfig?.accessLog?.filePath;
	}),
	toggleRequests: protectedProcedure
		.input(
			z.object({
				enable: z.boolean(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const mainConfig = readMainConfig();
			if (!mainConfig) return false;

			const currentConfig = parse(mainConfig) as {
				accessLog?: {
					filePath: string;
				};
			};

			if (input.enable) {
				const config = {
					accessLog: {
						filePath: "/etc/nearzero/traefik/dynamic/access.log",
						format: "json",
						bufferingSize: 100,
					},
				};
				currentConfig.accessLog = config.accessLog;
			} else {
				currentConfig.accessLog = undefined;
			}

			writeMainConfig(stringify(currentConfig));
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "toggle-requests",
			});
			return true;
		}),
	isUserSubscribed: protectedProcedure.query(async ({ ctx }) => {
		const haveServers = await db.query.server.findMany({
			where: eq(server.organizationId, ctx.session?.activeOrganizationId || ""),
		});
		const haveProjects = await db.query.projects.findMany({
			where: eq(
				projects.organizationId,
				ctx.session?.activeOrganizationId || "",
			),
		});
		return haveServers.length > 0 || haveProjects.length > 0;
	}),
	health: publicProcedure.query(async () => {
		try {
			await db.execute(sql`SELECT 1`);
			return { status: "ok" };
		} catch (error) {
			console.error("Database connection error:", error);
			throw error;
		}
	}),
	checkInfrastructureHealth: adminProcedure.query(async () => {

		const [postgres, redis, traefik] = await Promise.all([
			checkPostgresHealth(),
			checkRedisHealth(),
			checkTraefikHealth(),
		]);

		return { postgres, redis, traefik };
	}),
	setupGPU: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.mutation(async ({ input, ctx }) => {

			try {
				await setupGPUSupport(input.serverId);
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "setup-gpu",
				});
				return { success: true };
			} catch (error) {
				console.error("GPU Setup Error:", error);
				throw error;
			}
		}),
	checkGPUStatus: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input }) => {
			if (!input.serverId) {
				return {
					driverInstalled: false,
					driverVersion: undefined,
					gpuModel: undefined,
					runtimeInstalled: false,
					runtimeConfigured: false,
					cudaSupport: undefined,
					cudaVersion: undefined,
					memoryInfo: undefined,
					availableGPUs: 0,
					swarmEnabled: false,
					gpuResources: 0,
				};
			}

			try {
				return await checkGPUStatus(input.serverId || "");
			} catch (error) {
				const message =
					error instanceof Error ? error.message : "Failed to check GPU status";
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	updateTraefikPorts: adminProcedure
		.input(
			z.object({
				serverId: z.string().optional(),
				additionalPorts: z.array(
					z.object({
						targetPort: z.number(),
						publishedPort: z.number(),
						protocol: z.enum(["tcp", "udp", "sctp"]),
					}),
				),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			try {
				const env = await readEnvironmentVariables(
					"nearzero-traefik",
					input?.serverId,
				);

				for (const port of input.additionalPorts) {
					const portCheck = await checkPortInUse(
						port.publishedPort,
						input.serverId,
					);
					if (portCheck.isInUse) {
						throw new TRPCError({
							code: "CONFLICT",
							message: `Port ${port.targetPort} is already in use by ${portCheck.conflictingContainer}`,
						});
					}
				}
				const preparedEnv = prepareEnvironmentVariables(env);

				// Run in background so the request returns immediately; client polls /api/health.
				void writeTraefikSetup({
					env: preparedEnv,
					additionalPorts: input.additionalPorts,
					serverId: input.serverId,
				}).catch((err) => {
					console.error(
						"updateTraefikPorts background writeTraefikSetup:",
						err,
					);
				});
				await audit(ctx, {
					action: "update",
					resourceType: "settings",
					resourceName: "traefik-ports",
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message:
						error instanceof Error
							? error.message
							: "Error updating Traefik ports",
					cause: error,
				});
			}
		}),
	getTraefikPorts: adminProcedure
		.input(apiServerSchema)
		.query(async ({ input }) => {
			const ports = await readPorts("nearzero-traefik", input?.serverId);
			return ports;
		}),
	updateLogCleanup: protectedProcedure
		.input(
			z.object({
				cronExpression: z.string().nullable(),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			let result: boolean;
			if (input.cronExpression) {
				result = await startLogCleanup(input.cronExpression);
			} else {
				result = await stopLogCleanup();
			}
			await audit(ctx, {
				action: "update",
				resourceType: "settings",
				resourceName: "log-cleanup",
			});
			return result;
		}),

	getLogCleanupStatus: protectedProcedure.query(async () => {
		return getLogCleanupStatus();
	}),

	getNearzeroCloudIps: adminProcedure.query(async () => {
		const ips = process.env.NEARZERO_CLOUD_IPS?.split(",");
		return ips ?? [];
	}),
});
