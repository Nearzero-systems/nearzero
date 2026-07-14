import {
	cancelDeploymentProcess,
	execAsync,
	execAsyncRemote,
	findAllDeploymentsByApplicationId,
	findAllDeploymentsByComposeId,
	findAllDeploymentsByServerId,
	findAllDeploymentsCentralized,
	findDatabaseDeploymentsForService,
	findDeploymentById,
	removeDeployment,
	resolveDeploymentLogServerId,
	resolveServicePath,
	updateDeploymentStatus,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import {
	checkServicePermissionAndAccess,
	findMemberByUserId,
} from "@nearzero/server/services/permission";
import { findServerById } from "@nearzero/server/services/server";
import { TRPCError } from "@trpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import {
	apiFindAllByApplication,
	apiFindAllByCompose,
	apiFindAllByServer,
	apiFindAllByType,
	applications,
	deployments,
} from "@/server/db/schema";
import { myQueue } from "@/server/queues/queueSetup";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

const followApplicationInput = z.object({
	applicationId: z.string().min(1),
	jobId: z.string().min(1).optional(),
	deploymentId: z.string().min(1).optional(),
});

const deploymentFollowColumns = {
	deploymentId: true,
	title: true,
	description: true,
	status: true,
	createdAt: true,
	startedAt: true,
	finishedAt: true,
	errorMessage: true,
	logPath: true,
} as const;

const PUBLIC_DEPLOYMENT_FAILURE_MESSAGE =
	"Deployment failed. Check the build logs for the failing step.";

const toPublicDeployment = <T extends { errorMessage?: string | null }>(
	deployment: T,
) => ({
	...deployment,
	...(Object.hasOwn(deployment, "errorMessage")
		? {
				errorMessage: deployment.errorMessage
					? PUBLIC_DEPLOYMENT_FAILURE_MESSAGE
					: deployment.errorMessage,
			}
		: {}),
});

const queueMessage = (state: string | null | undefined) => {
	switch ((state ?? "").toLowerCase()) {
		case "failed":
			return "Deployment worker failed before build logs were created.";
		case "active":
			return "Deployment worker is starting. Build logs should appear shortly.";
		case "waiting":
		case "delayed":
		case "prioritized":
		case "waiting-children":
			return "Deployment queued. Waiting for the build worker to create logs.";
		case "completed":
			return "Deployment worker completed. Final status is loading.";
		default:
			return "Deployment queued. Waiting for the build worker to create logs.";
	}
};

const deploymentMessage = (deployment: {
	status: string | null;
	errorMessage?: string | null;
}) => {
	switch (deployment.status) {
		case "done":
			return "Deployment complete.";
		case "error":
			return PUBLIC_DEPLOYMENT_FAILURE_MESSAGE;
		case "cancelled":
			return "Deployment was cancelled.";
		default:
			return "Building application. This can take a few minutes on a fresh server.";
	}
};

export const deploymentRouter = createTRPCRouter({
	all: protectedProcedure
		.input(apiFindAllByApplication)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});
			return (await findAllDeploymentsByApplicationId(input.applicationId)).map(
				toPublicDeployment,
			);
		}),

	allByCompose: protectedProcedure
		.input(apiFindAllByCompose)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.composeId, {
				deployment: ["read"],
			});
			return (await findAllDeploymentsByComposeId(input.composeId)).map(
				toPublicDeployment,
			);
		}),

	allByDatabase: protectedProcedure
		.input(
			z.object({
				serviceId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.serviceId, {
				deployment: ["read"],
			});
			return (await findDatabaseDeploymentsForService(input.serviceId)).map(
				toPublicDeployment,
			);
		}),

	allByServer: withPermission("deployment", "read")
		.input(apiFindAllByServer)
		.query(async ({ input, ctx }) => {
			const targetServer = await findServerById(input.serverId);
			if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this server.",
				});
			}
			return (await findAllDeploymentsByServerId(input.serverId)).map(
				toPublicDeployment,
			);
		}),
	allCentralized: withPermission("deployment", "read").query(
		async ({ ctx }) => {
			const orgId = ctx.session.activeOrganizationId;
			const accessedServices =
				ctx.user.role !== "owner" && ctx.user.role !== "admin"
					? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
					: null;
			if (accessedServices !== null && accessedServices.length === 0) {
				return [];
			}
			return (await findAllDeploymentsCentralized(orgId, accessedServices)).map(
				toPublicDeployment,
			);
		},
	),

	followApplication: protectedProcedure
		.input(followApplicationInput)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.applicationId, {
				deployment: ["read"],
			});

			const [applicationStatusRow, deployment] = await Promise.all([
				db.query.applications.findFirst({
					where: eq(applications.applicationId, input.applicationId),
					columns: {
						applicationStatus: true,
					},
				}),
				input.deploymentId
					? db.query.deployments.findFirst({
							where: and(
								eq(deployments.deploymentId, input.deploymentId),
								eq(deployments.applicationId, input.applicationId),
							),
							columns: deploymentFollowColumns,
						})
					: db.query.deployments.findFirst({
							where: eq(deployments.applicationId, input.applicationId),
							orderBy: desc(deployments.createdAt),
							columns: deploymentFollowColumns,
						}),
			]);

			let queue: {
				id: string;
				state: string;
				timestamp?: number;
				processedOn?: number;
				finishedOn?: number;
			} | null = null;

			if (deployment) {
				const state =
					deployment.status === "done"
						? "done"
						: deployment.status === "error"
							? "error"
							: deployment.status === "cancelled"
								? "cancelled"
								: "running";
				return {
					state,
					message: deploymentMessage(deployment),
					applicationStatus: applicationStatusRow?.applicationStatus ?? null,
					queue,
					deployment: {
						deploymentId: deployment.deploymentId,
						title: deployment.title,
						description: deployment.description,
						status: deployment.status,
						createdAt: deployment.createdAt,
						startedAt: deployment.startedAt,
						finishedAt: deployment.finishedAt,
						errorMessage: deployment.errorMessage
							? PUBLIC_DEPLOYMENT_FAILURE_MESSAGE
							: deployment.errorMessage,
					},
					logsAvailable: Boolean(deployment.logPath),
					retryAfterMs:
						state === "done" || state === "error" || state === "cancelled"
							? null
							: 2500,
				};
			}

			let queueLookupFailed = false;
			try {
				if (input.jobId) {
					const job = await myQueue.getJob(input.jobId);
					if (
						job &&
						job.data.applicationType !== "compose" &&
						job.data.applicationId === input.applicationId
					) {
						const state = await job.getState();
						queue = {
							id: String(job.id),
							state,
							timestamp: job.timestamp,
							processedOn: job.processedOn,
							finishedOn: job.finishedOn,
						};
					}
				} else {
					// Reached only when no deployment row exists yet. Scope to
					// in-flight + failed states so this poll does not scan the full
					// (unbounded) job history every 2.5s.
					const jobs = await myQueue.getJobs([
						"active",
						"waiting",
						"waiting-children",
						"prioritized",
						"delayed",
						"paused",
						"failed",
					]);
					const matching = jobs
						.filter(
							(job) =>
								job.data.applicationType !== "compose" &&
								job.data.applicationId === input.applicationId,
						)
						.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
					if (matching) {
						const state = await matching.getState();
						queue = {
							id: String(matching.id),
							state,
							timestamp: matching.timestamp,
							processedOn: matching.processedOn,
							finishedOn: matching.finishedOn,
						};
					}
				}
			} catch (error) {
				queueLookupFailed = true;
				console.warn(
					`Unable to inspect deployment queue for application ${input.applicationId}:`,
					error,
				);
			}

			const queueState = queue?.state?.toLowerCase();
			const failed = queueState === "failed";
			return {
				state: failed
					? "error"
					: queueState === "active"
						? "running"
						: "queued",
				message: queueLookupFailed
					? "Deployment was queued. Waiting for the build worker to create logs."
					: queueMessage(queueState),
				applicationStatus: applicationStatusRow?.applicationStatus ?? null,
				queue,
				deployment: null,
				logsAvailable: false,
				retryAfterMs: failed ? null : 2500,
			};
		}),

	queueList: withPermission("deployment", "read").query(async ({ ctx }) => {
		const orgId = ctx.session.activeOrganizationId;
		const accessedServices =
			ctx.user.role !== "owner" && ctx.user.role !== "admin"
				? (await findMemberByUserId(ctx.user.id, orgId)).accessedServices
				: null;
		// Only in-flight jobs are relevant here: the UI discards terminal-state
		// (completed/failed) queue rows because the database deployment records
		// are the source of truth for finished runs. The deployments queue keeps
		// full job history (no retention), so fetching every job and then running
		// a Redis getState() + DB lookup per job made this endpoint scale with the
		// entire deployment history — the root cause of the slow Deployments page
		// and the long wait when opening a deployment. Scoping the fetch to active
		// states keeps the result identical while bounding the work to a handful
		// of jobs.
		const jobs = await myQueue.getJobs([
			"active",
			"waiting",
			"waiting-children",
			"prioritized",
			"delayed",
			"paused",
		]);
		const rows = await Promise.all(
			jobs.map(async (job) => {
				const state = await job.getState();
				return {
					id: String(job.id),
					name: job.name ?? undefined,
					data: job.data,
					timestamp: job.timestamp,
					processedOn: job.processedOn,
					finishedOn: job.finishedOn,
					state,
				};
			}),
		);
		rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

		const scopedRows = await Promise.all(
			rows.map(async (row) => {
				const rawData = (row.data ?? {}) as Record<string, unknown>;
				const servicePath = await resolveServicePath(orgId, rawData);
				const serviceId = String(
					rawData.applicationId ?? rawData.composeId ?? "",
				);
				if (
					!servicePath.href ||
					(accessedServices !== null && !accessedServices.includes(serviceId))
				) {
					return null;
				}
				return {
					...row,
					data: {
						applicationId: rawData.applicationId,
						composeId: rawData.composeId,
						applicationType: rawData.applicationType,
						type: rawData.type,
						titleLog: rawData.titleLog,
						descriptionLog: rawData.descriptionLog,
					},
					servicePath,
				};
			}),
		);
		return scopedRows.filter((row) => row !== null);
	}),

	allByType: protectedProcedure
		.input(apiFindAllByType)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				deployment: ["read"],
			});
			const deploymentsList = await db.query.deployments.findMany({
				where: eq(deployments[`${input.type}Id`], input.id),
				orderBy: desc(deployments.createdAt),
				with: {
					rollback: {
						columns: {
							rollbackId: true,
							deploymentId: true,
							version: true,
							image: true,
							createdAt: true,
						},
					},
				},
			});
			return deploymentsList.map(toPublicDeployment);
		}),
	killProcess: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			const serviceId = deployment.applicationId || deployment.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					deployment: ["cancel"],
				});
			} else if (deployment.schedule?.serverId) {
				const targetServer = await findServerById(deployment.schedule.serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this deployment.",
					});
				}
			} else if (deployment.serverId) {
				const targetServer = await findServerById(deployment.serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this deployment.",
					});
				}
			}

			if (deployment.applicationId) {
				await cancelDeploymentProcess({
					deploymentId: deployment.deploymentId,
					serverId: resolveDeploymentLogServerId(deployment),
				});
				await updateDeploymentStatus(deployment.deploymentId, "cancelled");
				await audit(ctx, {
					action: "cancel",
					resourceType: "deployment",
					resourceId: deployment.deploymentId,
				});
				return;
			}

			if (!deployment.pid) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Deployment is not running",
				});
			}

			const command = `kill -9 ${deployment.pid}`;
			if (deployment.schedule?.serverId) {
				await execAsyncRemote(deployment.schedule.serverId, command);
			} else {
				await execAsync(command);
			}

			await updateDeploymentStatus(deployment.deploymentId, "error");
			await audit(ctx, {
				action: "cancel",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
		}),

	removeDeployment: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			const serviceId = deployment.applicationId || deployment.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					deployment: ["cancel"],
				});
			} else if (deployment.schedule?.serverId) {
				const targetServer = await findServerById(deployment.schedule.serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this deployment.",
					});
				}
			}
			await removeDeployment(input.deploymentId);
			await audit(ctx, {
				action: "delete",
				resourceType: "deployment",
				resourceId: deployment.deploymentId,
			});
			return { success: true, deploymentId: input.deploymentId };
		}),

	readLogs: protectedProcedure
		.input(
			z.object({
				deploymentId: z.string().min(1),
				tail: z.number().int().min(1).max(10000).default(100),
			}),
		)
		.query(async ({ input, ctx }) => {
			const deployment = await findDeploymentById(input.deploymentId);
			const serviceId = deployment.applicationId || deployment.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					deployment: ["read"],
				});
			} else if (deployment.schedule?.serverId) {
				const targetServer = await findServerById(deployment.schedule.serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this deployment.",
					});
				}
			}

			if (!deployment.logPath) {
				return "";
			}

			const command = `tail -n ${input.tail} "${deployment.logPath}" 2>/dev/null || echo ""`;
			const serverId = resolveDeploymentLogServerId(deployment);
			if (serverId) {
				const { stdout } = await execAsyncRemote(serverId, command);
				return stdout;
			}

			const { stdout } = await execAsync(command);
			return stdout;
		}),
});
