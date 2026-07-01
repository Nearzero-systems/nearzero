import { db } from "@nearzero/server/db";
import {
	type apiCreateMongo,
	backups,
	buildAppName,
	compose,
	mongo,
} from "@nearzero/server/db/schema";
import { generatePassword } from "@nearzero/server/templates";
import {
	appendDatabaseDeploymentLog,
	createDatabaseServiceDeployment,
	finalizeDatabaseDeployment,
	hasInProgressDatabaseDeployment,
} from "@nearzero/server/services/database-deployment";
import { findEnvironmentById } from "@nearzero/server/services/environment";
import { findProjectById } from "@nearzero/server/services/project";
import { buildMongo } from "@nearzero/server/utils/databases/mongo";
import {
	pullImage,
	SwarmServiceStabilityError,
} from "@nearzero/server/utils/docker/utils";
import { execAsyncRemote } from "@nearzero/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { eq, getTableColumns } from "drizzle-orm";
import type { z } from "zod";
import { validUniqueServerAppName } from "./project";

export type Mongo = typeof mongo.$inferSelect;

export const createMongo = async (input: z.infer<typeof apiCreateMongo>) => {
	const appName = buildAppName("mongo", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newMongo = await db
		.insert(mongo)
		.values({
			...input,
			databasePassword: input.databasePassword
				? input.databasePassword
				: generatePassword(),
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newMongo) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting mongo database",
		});
	}

	return newMongo;
};

export const findMongoById = async (mongoId: string) => {
	const result = await db.query.mongo.findFirst({
		where: eq(mongo.mongoId, mongoId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			mounts: true,
			server: true,
			backups: {
				with: {
					destination: true,
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Mongo not found",
		});
	}
	return result;
};

export const updateMongoById = async (
	mongoId: string,
	mongoData: Partial<Mongo>,
) => {
	const { appName, ...rest } = mongoData;
	const result = await db
		.update(mongo)
		.set({
			...rest,
		})
		.where(eq(mongo.mongoId, mongoId))
		.returning();

	return result[0];
};

export const findMongoByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(mongo),
		})
		.from(mongo)
		.innerJoin(backups, eq(mongo.mongoId, backups.mongoId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Mongo not found",
		});
	}
	return result[0];
};

export const findComposeByBackupId = async (backupId: string) => {
	const result = await db
		.select({
			...getTableColumns(compose),
		})
		.from(compose)
		.innerJoin(backups, eq(compose.composeId, backups.composeId))
		.where(eq(backups.backupId, backupId))
		.limit(1);

	if (!result || !result[0]) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result[0];
};

export const removeMongoById = async (mongoId: string) => {
	const result = await db
		.delete(mongo)
		.where(eq(mongo.mongoId, mongoId))
		.returning();

	return result[0];
};

export const deployMongo = async (
	mongoId: string,
	onData?: (data: any) => void,
) => {
	const mongo = await findMongoById(mongoId);

	// Idempotency guard: if a deployment for this service is already in progress,
	// don't start a second overlapping one. This prevents duplicate deployment
	// records when a deploy is triggered twice in quick succession (e.g. the
	// auto-deploy on create plus a manual deploy click).
	if (await hasInProgressDatabaseDeployment(mongoId)) {
		onData?.("A deployment is already in progress for this service; skipping duplicate.");
		return mongo;
	}

	const environment = await findEnvironmentById(mongo.environmentId);
	const project = await findProjectById(environment.projectId);
	let deploymentRecord: Awaited<
		ReturnType<typeof createDatabaseServiceDeployment>
	> | null = null;

	const emit = async (line: string) => {
		onData?.(line);
		if (deploymentRecord?.logPath) {
			await appendDatabaseDeploymentLog(
				deploymentRecord.logPath,
				line,
				mongo.serverId,
			);
		}
	};

	try {
		deploymentRecord = await createDatabaseServiceDeployment({
			meta: {
				variant: "mongo",
				serviceId: mongo.mongoId,
				environmentId: mongo.environmentId,
				projectId: environment.projectId,
				name: mongo.name,
				projectName: project.name,
				environmentName: environment.name,
			},
			appName: mongo.appName,
			serverId: mongo.serverId,
			title: `Deploy MongoDB: ${mongo.name}`,
		});

		await updateMongoById(mongoId, {
			applicationStatus: "running",
		});

		await emit("Starting mongo deployment...");
		if (mongo.serverId) {
			await execAsyncRemote(
				mongo.serverId,
				`docker pull ${mongo.dockerImage}`,
				(line) => {
					void emit(String(line));
				},
			);
		} else {
			await pullImage(mongo.dockerImage, (line) => {
				void emit(String(line));
			});
		}

		await buildMongo(mongo);
		await updateMongoById(mongoId, {
			applicationStatus: "done",
		});
		await emit("Deployment completed successfully!");
		if (deploymentRecord) {
			await finalizeDatabaseDeployment(
				deploymentRecord.deploymentId,
				"done",
				deploymentRecord.logPath,
				mongo.serverId,
				"Deployment completed successfully!",
			);
		}
	} catch (error) {
		// Surface stability diagnostics (repeating Swarm task states, exit codes,
		// and the latest mongod container logs) to the deploy log so a churning
		// MongoDB service reports WHY it never stabilized (e.g. SIGILL on a CPU
		// without AVX, or an OOM kill) instead of a bare failure.
		if (error instanceof SwarmServiceStabilityError && error.diagnostics) {
			await emit(
				"MongoDB did not stabilize after deployment. Diagnostics:",
			);
			await emit(error.diagnostics);
		}
		const message = `Error: ${error instanceof Error ? error.message : error}`;
		await emit(message);
		await updateMongoById(mongoId, {
			applicationStatus: "error",
		});
		if (deploymentRecord) {
			await finalizeDatabaseDeployment(
				deploymentRecord.deploymentId,
				"error",
				deploymentRecord.logPath,
				mongo.serverId,
				message,
			);
		}

		throw new TRPCError({
			code: "INTERNAL_SERVER_ERROR",
			message: `Error on deploy mongo${error}`,
		});
	}
	return mongo;
};
