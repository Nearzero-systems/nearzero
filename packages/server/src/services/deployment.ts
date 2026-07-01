import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import {
	type apiCreateDeployment,
	type apiCreateDeploymentBackup,
	type apiCreateDeploymentCompose,
	type apiCreateDeploymentPreview,
	type apiCreateDeploymentSchedule,
	type apiCreateDeploymentServer,
	type apiCreateDeploymentVolumeBackup,
	applications,
	compose,
	deployments,
	environments,
	projects,
} from "@nearzero/server/db/schema";
import { removeDirectoryIfExistsContent } from "@nearzero/server/utils/filesystem/directory";
import {
	execAsync,
	execAsyncRemote,
} from "@nearzero/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { format } from "date-fns";
import { and, desc, eq, inArray, or } from "drizzle-orm";
import type { z } from "zod";
import {
	type Application,
	findApplicationById,
	updateApplicationStatus,
} from "./application";
import { findBackupById } from "./backup";
import {
	type ApplicationExecutionPlacement,
	assertApplicationExecutionPlacementSnapshot,
	resolveApplicationExecutionPlacement,
} from "./build-execution";
import { cancelDeploymentProcess } from "./deployment-runner";
import { type Compose, findComposeById, updateCompose } from "./compose";
import {
	findPreviewDeploymentById,
	type PreviewDeployment,
	updatePreviewDeployment,
} from "./preview-deployment";
import { removeRollbackById } from "./rollbacks";
import { findScheduleById } from "./schedule";
import { findServerById, type Server } from "./server";
import { findVolumeBackupById } from "./volume-backups";
import { findDatabaseDeploymentsCentralized } from "./database-deployment";

export type ServicePath = { href: string | null; label: string };

export async function resolveServicePath(
	orgId: string,
	data: Record<string, unknown>,
): Promise<ServicePath> {
	try {
		const applicationId = data?.applicationId as string | undefined;
		const composeId = data?.composeId as string | undefined;
		if (applicationId) {
			const app = await findApplicationById(applicationId);
			if (app.environment.project.organizationId !== orgId) {
				return { href: null, label: "Application" };
			}
			return {
				href: `/dashboard/project/${app.environment.project.projectId}/environment/${app.environment.environmentId}/services/application/${app.applicationId}`,
				label: "Application",
			};
		}
		if (composeId) {
			const comp = await findComposeById(composeId);
			if (comp.environment.project.organizationId !== orgId) {
				return { href: null, label: "Compose" };
			}
			return {
				href: `/dashboard/project/${comp.environment.project.projectId}/environment/${comp.environment.environmentId}/services/compose/${comp.composeId}`,
				label: "Compose",
			};
		}
	} catch {
		// not found or unauthorized
	}
	return { href: null, label: "—" };
}

export type Deployment = typeof deployments.$inferSelect;

type DeploymentLogPlacement = Deployment & {
	application?: Pick<
		Application,
		"buildExecutionTarget" | "serverId" | "sourceType"
	> | null;
	schedule?: { serverId?: string | null } | null;
};

export const resolveDeploymentLogServerId = (
	deployment: DeploymentLogPlacement,
) => {
	if (deployment.buildLocation === "local") {
		return null;
	}

	if (deployment.buildLocation === "remote") {
		return deployment.buildServerId ?? deployment.serverId ?? null;
	}

	if (deployment.application) {
		return resolveApplicationExecutionPlacement(deployment.application)
			.buildServerId;
	}

	return deployment.serverId ?? deployment.schedule?.serverId ?? null;
};

export const findDeploymentById = async (deploymentId: string) => {
	const deployment = await db.query.deployments.findFirst({
		where: eq(deployments.deploymentId, deploymentId),
		with: {
			application: {
				columns: {
					applicationId: true,
					buildExecutionTarget: true,
					serverId: true,
					sourceType: true,
				},
			},
			schedule: {
				columns: {
					scheduleId: true,
					serverId: true,
				},
			},
		},
	});
	if (!deployment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Deployment not found",
		});
	}
	return deployment;
};

const deploymentLogPlacementWith = {
	application: {
		columns: {
			applicationId: true,
			buildExecutionTarget: true,
			serverId: true,
			sourceType: true,
		},
	},
	schedule: {
		columns: {
			scheduleId: true,
			serverId: true,
		},
	},
} as const;

export const findDeploymentByApplicationId = async (applicationId: string) => {
	const deployment = await db.query.deployments.findFirst({
		where: eq(deployments.applicationId, applicationId),
	});

	if (!deployment) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Deployment not found",
		});
	}
	return deployment;
};

export const createDeployment = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeployment>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
	placement: ApplicationExecutionPlacement,
) => {
	const application = await findApplicationById(deployment.applicationId);
	assertApplicationExecutionPlacementSnapshot(
		resolveApplicationExecutionPlacement(application),
		placement,
	);
	await cancelPreviousRunningDeployments(
		deployment.applicationId,
		"application",
	);
	await removeLastTenDeployments(deployment.applicationId, "application");
	try {
		const serverId = placement.buildServerId;
		const buildTargetLabel = serverId
			? "selected application server"
			: "local Nearzero runtime";

		const { LOGS_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${application.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, application.appName, fileName);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
				mkdir -p ${LOGS_PATH}/${application.appName};
            	echo "Initializing deployment" >> ${logFilePath};
			    echo "Building on ${buildTargetLabel}" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, application.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing deployment\n");
		}

		const deploymentCreate = await db
			.insert(deployments)
			.values({
				applicationId: deployment.applicationId,
				serverId: placement.deployServerId,
				buildServerId: placement.buildServerId,
				executionMode: placement.mode,
				buildLocation: placement.buildLocation,
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				startedAt: new Date().toISOString(),
			})
			.returning();
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await db
			.insert(deployments)
			.values({
				applicationId: deployment.applicationId,
				serverId: placement.deployServerId,
				buildServerId: placement.buildServerId,
				executionMode: placement.mode,
				buildLocation: placement.buildLocation,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			})
			.returning();
		await updateApplicationStatus(application.applicationId, "error");
		console.log(error);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentPreview = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentPreview>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
	placement: ApplicationExecutionPlacement,
) => {
	const previewDeployment = await findPreviewDeploymentById(
		deployment.previewDeploymentId,
	);
	const application = await findApplicationById(
		previewDeployment.applicationId,
	);
	assertApplicationExecutionPlacementSnapshot(
		resolveApplicationExecutionPlacement(application),
		placement,
	);
	await cancelPreviousRunningDeployments(
		deployment.previewDeploymentId,
		"previewDeployment",
	);
	await removeLastTenDeployments(
		deployment.previewDeploymentId,
		"previewDeployment",
	);
	try {
		const appName = `${previewDeployment.appName}`;
		const { LOGS_PATH } = paths(!!placement.buildServerId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, appName, fileName);

		if (placement.buildServerId) {
			const server = await findServerById(placement.buildServerId);

			const command = `
				mkdir -p ${LOGS_PATH}/${appName};
            	echo "Initializing deployment" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing deployment");
		}

		const deploymentCreate = await db
			.insert(deployments)
			.values({
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				previewDeploymentId: deployment.previewDeploymentId,
				serverId: placement.deployServerId,
				buildServerId: placement.buildServerId,
				executionMode: placement.mode,
				buildLocation: placement.buildLocation,
				startedAt: new Date().toISOString(),
			})
			.returning();
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await db
			.insert(deployments)
			.values({
				previewDeploymentId: deployment.previewDeploymentId,
				serverId: placement.deployServerId,
				buildServerId: placement.buildServerId,
				executionMode: placement.mode,
				buildLocation: placement.buildLocation,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			})
			.returning();
		await updatePreviewDeployment(deployment.previewDeploymentId, {
			previewStatus: "error",
		});
		console.log(error);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentCompose = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentCompose>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const compose = await findComposeById(deployment.composeId);
	await cancelPreviousRunningDeployments(deployment.composeId, "compose");
	await removeLastTenDeployments(
		deployment.composeId,
		"compose",
	);
	try {
		const { LOGS_PATH } = paths(!!compose.serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${compose.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, compose.appName, fileName);

		if (compose.serverId) {
			const server = await findServerById(compose.serverId);

			const command = `
mkdir -p ${LOGS_PATH}/${compose.appName};
echo "Initializing deployment\n" >> ${logFilePath};
`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, compose.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing deployment\n");
		}

		const deploymentCreate = await db
			.insert(deployments)
			.values({
				composeId: deployment.composeId,
				...(compose.serverId && { serverId: compose.serverId }),
				title: deployment.title || "Deployment",
				description: deployment.description || "",
				status: "running",
				logPath: logFilePath,
				startedAt: new Date().toISOString(),
			})
			.returning();
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await db
			.insert(deployments)
			.values({
				composeId: deployment.composeId,
				...(compose.serverId && { serverId: compose.serverId }),
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			})
			.returning();
		await updateCompose(compose.composeId, {
			composeStatus: "error",
		});
		console.log(error);
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentBackup = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentBackup>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const backup = await findBackupById(deployment.backupId);

	let serverId: string | null | undefined;
	if (backup.backupType === "database") {
		serverId =
			backup.postgres?.serverId ||
			backup.mariadb?.serverId ||
			backup.mysql?.serverId ||
			backup.mongo?.serverId;
	} else if (backup.backupType === "compose") {
		serverId = backup.compose?.serverId;
	}
	await cancelPreviousRunningDeployments(deployment.backupId, "backup");
	await removeLastTenDeployments(deployment.backupId, "backup");
	try {
		const { LOGS_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${backup.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, backup.appName, fileName);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
mkdir -p ${LOGS_PATH}/${backup.appName};
echo "Initializing backup\n" >> ${logFilePath};
`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(LOGS_PATH, backup.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing backup\n");
		}

		const deploymentCreate = await db
			.insert(deployments)
			.values({
				backupId: deployment.backupId,
				title: deployment.title || "Backup",
				description: deployment.description || "",
				status: "running",
				logPath: logFilePath,
				startedAt: new Date().toISOString(),
			})
			.returning();
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the backup",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		await db
			.insert(deployments)
			.values({
				backupId: deployment.backupId,
				title: deployment.title || "Backup",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			})
			.returning();
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the backup",
		});
	}
};

export const createDeploymentSchedule = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentSchedule>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const schedule = await findScheduleById(deployment.scheduleId);

	const serverId =
		schedule.application?.serverId ||
		schedule.compose?.serverId ||
		schedule.server?.serverId;
	await cancelPreviousRunningDeployments(deployment.scheduleId, "schedule");
	await removeLastTenDeployments(deployment.scheduleId, "schedule");
	try {
		const { SCHEDULES_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${schedule.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(SCHEDULES_PATH, schedule.appName, fileName);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
				mkdir -p ${SCHEDULES_PATH}/${schedule.appName};
            	echo "Initializing schedule" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(path.join(SCHEDULES_PATH, schedule.appName), {
				recursive: true,
			});
			await fsPromises.writeFile(logFilePath, "Initializing schedule\n");
		}

		const deploymentCreate = await db
			.insert(deployments)
			.values({
				scheduleId: deployment.scheduleId,
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				startedAt: new Date().toISOString(),
			})
			.returning();
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		console.log(error);
		await db
			.insert(deployments)
			.values({
				scheduleId: deployment.scheduleId,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			})
			.returning();

		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const createDeploymentVolumeBackup = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentVolumeBackup>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	const volumeBackup = await findVolumeBackupById(deployment.volumeBackupId);

	const serverId =
		volumeBackup.application?.serverId || volumeBackup.compose?.serverId;
	await cancelPreviousRunningDeployments(
		deployment.volumeBackupId,
		"volumeBackup",
	);
	await removeLastTenDeployments(
		deployment.volumeBackupId,
		"volumeBackup",
	);
	try {
		const { VOLUME_BACKUPS_PATH } = paths(!!serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${volumeBackup.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(
			VOLUME_BACKUPS_PATH,
			volumeBackup.appName,
			fileName,
		);

		if (serverId) {
			const server = await findServerById(serverId);

			const command = `
				mkdir -p ${VOLUME_BACKUPS_PATH}/${volumeBackup.appName};
            	echo "Initializing volume backup" >> ${logFilePath};
			`;

			await execAsyncRemote(server.serverId, command);
		} else {
			await fsPromises.mkdir(
				path.join(VOLUME_BACKUPS_PATH, volumeBackup.appName),
				{
					recursive: true,
				},
			);
			await fsPromises.writeFile(logFilePath, "Initializing volume backup\n");
		}

		const deploymentCreate = await db
			.insert(deployments)
			.values({
				volumeBackupId: deployment.volumeBackupId,
				title: deployment.title || "Deployment",
				status: "running",
				logPath: logFilePath,
				description: deployment.description || "",
				startedAt: new Date().toISOString(),
			})
			.returning();
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		console.log(error);
		await db
			.insert(deployments)
			.values({
				volumeBackupId: deployment.volumeBackupId,
				title: deployment.title || "Deployment",
				status: "error",
				logPath: "",
				description: deployment.description || "",
				errorMessage: `An error have occurred: ${error instanceof Error ? error.message : error}`,
				startedAt: new Date().toISOString(),
				finishedAt: new Date().toISOString(),
			})
			.returning();

		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error creating the deployment",
		});
	}
};

export const removeDeployment = async (deploymentId: string) => {
	try {
		const existingDeployment = await db.query.deployments.findFirst({
			where: eq(deployments.deploymentId, deploymentId),
			with: deploymentLogPlacementWith,
		});

		const deployment = await db
			.delete(deployments)
			.where(eq(deployments.deploymentId, deploymentId))
			.returning()
			.then((result) => result[0]);

		if (!deployment) {
			return null;
		}

		const logPath = path.join(deployment.logPath);
		if (logPath && logPath !== ".") {
			const command = `rm -f ${logPath};`;
			const logServerId = existingDeployment
				? resolveDeploymentLogServerId(existingDeployment)
				: deployment.serverId;
			if (logServerId) {
				await execAsyncRemote(logServerId, command);
			} else {
				await execAsync(command);
			}
		}

		return deployment;
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Error removing the deployment";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};

export const removeDeploymentsByApplicationId = async (
	applicationId: string,
) => {
	await db
		.delete(deployments)
		.where(eq(deployments.applicationId, applicationId))
		.returning();
};

const getDeploymentsByType = async (
	id: string,
	type:
		| "application"
		| "compose"
		| "server"
		| "schedule"
		| "previewDeployment"
		| "backup"
		| "volumeBackup",
) => {
	const deploymentList = await db.query.deployments.findMany({
		where: eq(deployments[`${type}Id`], id),
		orderBy: desc(deployments.createdAt),
		with: {
			rollback: true,
		},
	});
	return deploymentList;
};

export const removeDeployments = async (application: Application) => {
	const deploymentList = await db.query.deployments.findMany({
		where: eq(deployments.applicationId, application.applicationId),
	});

	for (const deployment of deploymentList) {
		await removeDeployment(deployment.deploymentId);
	}
};

export const clearApplicationDeploymentLogs = async (
	applicationId: string,
) => {
	const deploymentList = await db.query.deployments.findMany({
		where: eq(deployments.applicationId, applicationId),
		with: deploymentLogPlacementWith,
	});

	for (const deployment of deploymentList) {
		if (!deployment.logPath) continue;
		const logPath = path.join(deployment.logPath);
		if (!logPath || logPath === ".") continue;
		const serverId = resolveDeploymentLogServerId(deployment);
		if (serverId) {
			await execAsyncRemote(serverId, `rm -f ${quotePath(logPath)}`);
		} else {
			await execAsync(`rm -f ${quotePath(logPath)}`);
		}
	}
};

const quotePath = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export const cancelRunningApplicationDeployment = async (
	applicationId: string,
) => {
	const deployment = await db.query.deployments.findFirst({
		where: and(
			eq(deployments.applicationId, applicationId),
			eq(deployments.status, "running"),
		),
		orderBy: desc(deployments.createdAt),
		with: deploymentLogPlacementWith,
	});

	if (!deployment) {
		return null;
	}

	await cancelDeploymentProcess({
		deploymentId: deployment.deploymentId,
		serverId: resolveDeploymentLogServerId(deployment),
	});
	await updateDeploymentStatus(deployment.deploymentId, "cancelled");
	await updateApplicationStatus(applicationId, "idle");
	return deployment;
};

const cancelPreviousRunningDeployments = async (
	id: string,
	type:
		| "application"
		| "compose"
		| "server"
		| "schedule"
		| "previewDeployment"
		| "backup"
		| "volumeBackup",
) => {
	try {
		const runningDeployments = await db.query.deployments.findMany({
			where: and(
				eq(deployments[`${type}Id`], id),
				eq(deployments.status, "running"),
			),
		});

		if (runningDeployments.length > 0) {
			if (type === "application" || type === "previewDeployment") {
				for (const deployment of runningDeployments) {
					const placementDeployment =
						await db.query.deployments.findFirst({
							where: eq(
								deployments.deploymentId,
								deployment.deploymentId,
							),
							with: deploymentLogPlacementWith,
						});
					if (!placementDeployment) continue;
					await cancelDeploymentProcess({
						deploymentId: placementDeployment.deploymentId,
						serverId:
							resolveDeploymentLogServerId(placementDeployment),
					}).catch(() => undefined);
				}
			}
			await db
				.update(deployments)
				.set({
					status: "cancelled",
					finishedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(deployments[`${type}Id`], id),
						eq(deployments.status, "running"),
					),
				);
		}
	} catch (err) {
		console.error(
			`Failed to cancel previous running deployments for ${type} ${id}:`,
			err,
		);
	}
};

const removeLastTenDeployments = async (
	id: string,
	type:
		| "application"
		| "compose"
		| "server"
		| "schedule"
		| "previewDeployment"
		| "backup"
		| "volumeBackup",
) => {
	const deploymentList = await getDeploymentsByType(id, type);
	if (deploymentList.length > 10) {
		const deploymentsToDelete = deploymentList.slice(10);
		for (const oldDeployment of deploymentsToDelete) {
			try {
				if (oldDeployment.rollbackId) {
					await removeRollbackById(oldDeployment.rollbackId);
				}
				await removeDeployment(oldDeployment.deploymentId);
			} catch (err) {
				console.error(
					`Failed to remove deployment ${oldDeployment.deploymentId} during cleanup:`,
					err,
				);
			}
		}
	}
};

export const removeDeploymentsByPreviewDeploymentId = async (
	previewDeployment: PreviewDeployment,
) => {
	const deploymentList = await db.query.deployments.findMany({
		where: eq(
			deployments.previewDeploymentId,
			previewDeployment.previewDeploymentId,
		),
	});

	for (const deployment of deploymentList) {
		await removeDeployment(deployment.deploymentId);
	}
};

export const removeDeploymentsByComposeId = async (compose: Compose) => {
	const { appName } = compose;
	const { LOGS_PATH } = paths(!!compose.serverId);
	const logsPath = path.join(LOGS_PATH, appName);
	if (compose.serverId) {
		await execAsyncRemote(compose.serverId, `rm -rf ${logsPath}`);
	} else {
		await removeDirectoryIfExistsContent(logsPath);
	}

	await db
		.delete(deployments)
		.where(eq(deployments.composeId, compose.composeId))
		.returning();
};

export const findAllDeploymentsByApplicationId = async (
	applicationId: string,
) => {
	const deploymentsList = await db.query.deployments.findMany({
		where: eq(deployments.applicationId, applicationId),
		orderBy: desc(deployments.createdAt),
		with: {
			rollback: true,
		},
	});
	return deploymentsList;
};

export const findAllDeploymentsByComposeId = async (composeId: string) => {
	const deploymentsList = await db.query.deployments.findMany({
		where: eq(deployments.composeId, composeId),
		orderBy: desc(deployments.createdAt),
	});
	return deploymentsList;
};

const centralizedDeploymentsWith = {
	application: {
		columns: {
			applicationId: true,
			name: true,
			appName: true,
			applicationStatus: true,
			sourceType: true,
			repository: true,
			owner: true,
			branch: true,
			buildPath: true,
			triggerType: true,
			gitlabRepository: true,
			gitlabOwner: true,
			gitlabBranch: true,
			gitlabBuildPath: true,
			giteaRepository: true,
			giteaOwner: true,
			giteaBranch: true,
			giteaBuildPath: true,
			bitbucketRepository: true,
			bitbucketRepositorySlug: true,
			bitbucketOwner: true,
			bitbucketBranch: true,
			bitbucketBuildPath: true,
			dockerImage: true,
			customGitUrl: true,
			customGitBranch: true,
			customGitBuildPath: true,
			dropBuildPath: true,
		},
		with: {
			environment: {
				columns: { environmentId: true, name: true },
				with: {
					project: {
						columns: { projectId: true, name: true },
					},
				},
			},
			server: {
				columns: { serverId: true, name: true },
			},
		},
	},
	compose: {
		columns: {
			composeId: true,
			name: true,
			appName: true,
			composeStatus: true,
			sourceType: true,
			repository: true,
			owner: true,
			branch: true,
			triggerType: true,
			gitlabRepository: true,
			gitlabOwner: true,
			gitlabBranch: true,
			giteaRepository: true,
			giteaOwner: true,
			giteaBranch: true,
			bitbucketRepository: true,
			bitbucketRepositorySlug: true,
			bitbucketOwner: true,
			bitbucketBranch: true,
			customGitUrl: true,
			customGitBranch: true,
			composePath: true,
		},
		with: {
			environment: {
				columns: { environmentId: true, name: true },
				with: {
					project: {
						columns: { projectId: true, name: true },
					},
				},
			},
			server: {
				columns: { serverId: true, name: true },
			},
		},
	},
	server: {
		columns: { serverId: true, name: true },
	},
	rollback: {
		columns: { rollbackId: true, version: true, image: true, createdAt: true },
	},
} as const;

async function getApplicationIdsInOrg(
	orgId: string,
	accessedServices: string[] | null,
): Promise<string[]> {
	const rows = await db
		.select({ applicationId: applications.applicationId })
		.from(applications)
		.innerJoin(
			environments,
			eq(applications.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			accessedServices !== null
				? and(
						eq(projects.organizationId, orgId),
						inArray(applications.applicationId, accessedServices),
					)
				: eq(projects.organizationId, orgId),
		);
	return rows.map((r) => r.applicationId);
}

async function getComposeIdsInOrg(
	orgId: string,
	accessedServices: string[] | null,
): Promise<string[]> {
	const rows = await db
		.select({ composeId: compose.composeId })
		.from(compose)
		.innerJoin(
			environments,
			eq(compose.environmentId, environments.environmentId),
		)
		.innerJoin(projects, eq(environments.projectId, projects.projectId))
		.where(
			accessedServices !== null
				? and(
						eq(projects.organizationId, orgId),
						inArray(compose.composeId, accessedServices),
					)
				: eq(projects.organizationId, orgId),
		);
	return rows.map((r) => r.composeId);
}

/**
 * All deployments for applications and compose in the org.
 * Pass accessedServices for members (only those services), null for owner/admin.
 */
export const findAllDeploymentsCentralized = async (
	orgId: string,
	accessedServices: string[] | null,
) => {
	if (accessedServices !== null && accessedServices.length === 0) {
		return [];
	}

	const [appIds, compIds, dbDeploymentRows] = await Promise.all([
		getApplicationIdsInOrg(orgId, accessedServices),
		getComposeIdsInOrg(orgId, accessedServices),
		findDatabaseDeploymentsCentralized(orgId, accessedServices),
	]);

	let standardRows: Awaited<
		ReturnType<typeof db.query.deployments.findMany>
	> = [];

	if (appIds.length > 0 || compIds.length > 0) {
		const conditions = [
			...(appIds.length > 0 ? [inArray(deployments.applicationId, appIds)] : []),
			...(compIds.length > 0 ? [inArray(deployments.composeId, compIds)] : []),
		];
		const whereClause =
			conditions.length === 1 ? conditions[0] : or(...conditions);

		standardRows = await db.query.deployments.findMany({
			where: whereClause,
			orderBy: desc(deployments.createdAt),
			with: centralizedDeploymentsWith,
		});
	}

	return [...dbDeploymentRows, ...standardRows].sort(
		(a, b) =>
			new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
};

export const updateDeployment = async (
	deploymentId: string,
	deploymentData: Partial<Deployment>,
) => {
	const application = await db
		.update(deployments)
		.set({
			...deploymentData,
		})
		.where(eq(deployments.deploymentId, deploymentId))
		.returning();

	return application;
};

export const updateDeploymentStatus = async (
	deploymentId: string,
	deploymentStatus: Deployment["status"],
) => {
	const application = await db
		.update(deployments)
		.set({
			status: deploymentStatus,
			finishedAt:
				deploymentStatus === "done" || deploymentStatus === "error"
					? new Date().toISOString()
					: null,
		})
		.where(eq(deployments.deploymentId, deploymentId))
		.returning();

	return application;
};

export const createServerDeployment = async (
	deployment: Omit<
		z.infer<typeof apiCreateDeploymentServer>,
		"deploymentId" | "createdAt" | "status" | "logPath"
	>,
) => {
	try {
		const { LOGS_PATH } = paths();

		const server = await findServerById(deployment.serverId);
		await removeLastFiveDeployments(deployment.serverId);
		const formattedDateTime = format(new Date(), "yyyy-MM-dd:HH:mm:ss");
		const fileName = `${server.appName}-${formattedDateTime}.log`;
		const logFilePath = path.join(LOGS_PATH, server.appName, fileName);
		await fsPromises.mkdir(path.join(LOGS_PATH, server.appName), {
			recursive: true,
		});
		await fsPromises.writeFile(logFilePath, "Initializing Setup Server");
		const deploymentCreate = await db
			.insert(deployments)
			.values({
				serverId: server.serverId,
				title: deployment.title || "Deployment",
				description: deployment.description || "",
				status: "running",
				logPath: logFilePath,
			})
			.returning();
		if (deploymentCreate.length === 0 || !deploymentCreate[0]) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Error creating the deployment",
			});
		}
		return deploymentCreate[0];
	} catch (error) {
		const message =
			error instanceof Error ? error.message : "Error creating the deployment";
		throw new TRPCError({
			code: "BAD_REQUEST",
			message,
		});
	}
};

export const removeLastFiveDeployments = async (serverId: string) => {
	const deploymentList = await db.query.deployments.findMany({
		where: eq(deployments.serverId, serverId),
		orderBy: desc(deployments.createdAt),
	});
	if (deploymentList.length >= 5) {
		const deploymentsToDelete = deploymentList.slice(4);
		for (const oldDeployment of deploymentsToDelete) {
			const logPath = path.join(oldDeployment.logPath);
			if (existsSync(logPath)) {
				await fsPromises.unlink(logPath);
			}
			await removeDeployment(oldDeployment.deploymentId);
		}
	}
};

export const removeDeploymentsByServerId = async (server: Server) => {
	const { LOGS_PATH } = paths();
	const { appName } = server;
	const logsPath = path.join(LOGS_PATH, appName);
	await removeDirectoryIfExistsContent(logsPath);
	await db
		.delete(deployments)
		.where(eq(deployments.serverId, server.serverId))
		.returning();
};

export const findAllDeploymentsByServerId = async (serverId: string) => {
	const deploymentsList = await db.query.deployments.findMany({
		where: eq(deployments.serverId, serverId),
		orderBy: desc(deployments.createdAt),
	});
	return deploymentsList;
};

export const clearOldDeployments = async (
	appName: string,
	serverId: string | null,
) => {
	const { LOGS_PATH } = paths(!!serverId);
	const folder = path.join(LOGS_PATH, appName);
	const command = `
		rm -rf ${folder};
	`;
	if (serverId) {
		await execAsyncRemote(serverId, command);
	} else {
		await execAsync(command);
	}
};
