import {
	createVolumeBackup,
	findApplicationById,
	findComposeById,
	findMountsByApplicationId,
	findVolumeBackupById,
	removeVolumeBackup,
	removeVolumeBackupJob,
	restoreVolume,
	runVolumeBackup,
	scheduleVolumeBackup,
	updateVolumeBackup,
} from "@nearzero/server";
import { db } from "@nearzero/server/db";
import {
	createVolumeBackupSchema,
	updateVolumeBackupSchema,
	volumeBackups,
} from "@nearzero/server/db/schema";
import { findDestinationById } from "@nearzero/server/services/destination";
import { checkServicePermissionAndAccess } from "@nearzero/server/services/permission";
import { findServerById } from "@nearzero/server/services/server";
import { getDestinationSensitiveValues } from "@nearzero/server/utils/backups/utils";
import { executeSensitiveShellScript } from "@nearzero/server/utils/process/execAsync";
import { TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { removeJob, schedule, updateJob } from "@/server/utils/backup";
import { createTRPCRouter, protectedProcedure, withPermission } from "../trpc";

const VOLUME_BACKUP_SERVICE_RELATIONS = [
	"application",
	"postgres",
	"mysql",
	"mariadb",
	"mongo",
	"redis",
	"compose",
	"libsql",
] as const;

function toPublicVolumeBackup<T extends object>(row: T): T {
	const result = { ...row } as Record<string, unknown>;
	for (const relationName of VOLUME_BACKUP_SERVICE_RELATIONS) {
		const relation = result[relationName];
		if (!relation || typeof relation !== "object") continue;
		const publicRelation = { ...(relation as Record<string, unknown>) };
		for (const key of [
			"databasePassword",
			"databaseRootPassword",
			"password",
			"env",
			"buildArgs",
			"buildSecrets",
			"refreshToken",
		]) {
			delete publicRelation[key];
		}
		delete publicRelation.backups;
		result[relationName] = publicRelation;
	}
	const destination = result.destination;
	if (destination && typeof destination === "object") {
		const publicDestination = {
			...(destination as Record<string, unknown>),
		};
		publicDestination.hasCredentials = Boolean(
			publicDestination.accessKey && publicDestination.secretAccessKey,
		);
		delete publicDestination.accessKey;
		delete publicDestination.secretAccessKey;
		result.destination = publicDestination;
	}
	return result as T;
}

export const volumeBackupsRouter = createTRPCRouter({
	list: protectedProcedure
		.input(
			z.object({
				id: z.string().min(1),
				volumeBackupType: z.enum([
					"application",
					"postgres",
					"mysql",
					"mariadb",
					"mongo",
					"redis",
					"compose",
					"libsql",
				]),
			}),
		)
		.query(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				volumeBackup: ["read"],
			});
			const rows = await db.query.volumeBackups.findMany({
				where: eq(volumeBackups[`${input.volumeBackupType}Id`], input.id),
				with: {
					// Scope columns: the application table has >100 columns; a bare
					// `application: true` exceeds Postgres's 100-argument json_build_array
					// limit and throws. Only these fields are used (backup runner +
					// display).
					application: {
						columns: {
							applicationId: true,
							name: true,
							appName: true,
							serverId: true,
						},
					},
					postgres: true,
					mysql: true,
					mariadb: true,
					mongo: true,
					redis: true,
					compose: true,
					libsql: true,
				},
				orderBy: [desc(volumeBackups.createdAt)],
			});
			return rows.map(toPublicVolumeBackup);
		}),
	create: protectedProcedure
		.input(createVolumeBackupSchema)
		.mutation(async ({ input, ctx }) => {
			const serviceId =
				input.applicationId ||
				input.postgresId ||
				input.mysqlId ||
				input.mariadbId ||
				input.mongoId ||
				input.redisId ||
				input.libsqlId ||
				input.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volumeBackup: ["create"],
				});
			}
			const newVolumeBackup = await createVolumeBackup(input);

			if (newVolumeBackup?.enabled) {
				if (process.env.JOBS_URL) {
					await schedule({
						cronSchedule: newVolumeBackup.cronExpression,
						volumeBackupId: newVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await scheduleVolumeBackup(newVolumeBackup.volumeBackupId);
				}
			}
			await audit(ctx, {
				action: "create",
				resourceType: "volumeBackup",
				resourceId: newVolumeBackup?.volumeBackupId,
			});
			return newVolumeBackup;
		}),
	one: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.query(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			const serviceId =
				vb.applicationId ||
				vb.postgresId ||
				vb.mysqlId ||
				vb.mariadbId ||
				vb.mongoId ||
				vb.redisId ||
				vb.libsqlId ||
				vb.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volumeBackup: ["read"],
				});
			}
			return toPublicVolumeBackup(vb);
		}),
	delete: protectedProcedure
		.input(
			z.object({
				volumeBackupId: z.string().min(1),
			}),
		)
		.mutation(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			const serviceId =
				vb.applicationId ||
				vb.postgresId ||
				vb.mysqlId ||
				vb.mariadbId ||
				vb.mongoId ||
				vb.redisId ||
				vb.libsqlId ||
				vb.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volumeBackup: ["delete"],
				});
			}
			const result = await removeVolumeBackup(input.volumeBackupId);
			await audit(ctx, {
				action: "delete",
				resourceType: "volumeBackup",
				resourceId: input.volumeBackupId,
			});
			return result;
		}),
	update: protectedProcedure
		.input(updateVolumeBackupSchema)
		.mutation(async ({ input, ctx }) => {
			const existingVb = await findVolumeBackupById(input.volumeBackupId);
			const serviceId =
				existingVb.applicationId ||
				existingVb.postgresId ||
				existingVb.mysqlId ||
				existingVb.mariadbId ||
				existingVb.mongoId ||
				existingVb.redisId ||
				existingVb.libsqlId ||
				existingVb.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volumeBackup: ["update"],
				});
			}
			const updatedVolumeBackup = await updateVolumeBackup(
				input.volumeBackupId,
				input,
			);

			if (!updatedVolumeBackup) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Volume backup not found",
				});
			}

			if (process.env.JOBS_URL) {
				if (updatedVolumeBackup.enabled) {
					await updateJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				} else {
					await removeJob({
						cronSchedule: updatedVolumeBackup.cronExpression,
						volumeBackupId: updatedVolumeBackup.volumeBackupId,
						type: "volume-backup",
					});
				}
			} else {
				if (updatedVolumeBackup?.enabled) {
					removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
					scheduleVolumeBackup(updatedVolumeBackup.volumeBackupId);
				} else {
					removeVolumeBackupJob(updatedVolumeBackup.volumeBackupId);
				}
			}
			await audit(ctx, {
				action: "update",
				resourceType: "volumeBackup",
				resourceId: updatedVolumeBackup.volumeBackupId,
			});
			return updatedVolumeBackup;
		}),

	runManually: protectedProcedure
		.input(z.object({ volumeBackupId: z.string().min(1) }))
		.mutation(async ({ input, ctx }) => {
			const vb = await findVolumeBackupById(input.volumeBackupId);
			const serviceId =
				vb.applicationId ||
				vb.postgresId ||
				vb.mysqlId ||
				vb.mariadbId ||
				vb.mongoId ||
				vb.redisId ||
				vb.libsqlId ||
				vb.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					volumeBackup: ["create"],
				});
			}
			try {
				const result = await runVolumeBackup(input.volumeBackupId);
				await audit(ctx, {
					action: "run",
					resourceType: "volumeBackup",
					resourceId: input.volumeBackupId,
				});
				return result;
			} catch (error) {
				console.error(error);
				return false;
			}
		}),
	restoreVolumeBackupWithLogs: withPermission("volumeBackup", "restore")
		.meta({
			openapi: {
				enabled: false,
				path: "/restore-volume-backup-with-logs",
				method: "POST",
				override: true,
			},
		})
		.input(
			z.object({
				backupFileName: z
					.string()
					.min(1)
					.max(255)
					.regex(
						/^[A-Za-z0-9][A-Za-z0-9._-]*\.tar$/,
						"Select a valid volume backup file",
					),
				destinationId: z.string().min(1),
				volumeName: z
					.string()
					.min(1)
					.max(255)
					.regex(
						/^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
						"Select a valid Docker volume",
					),
				id: z.string().min(1),
				serviceType: z.enum(["application", "compose"]),
				serverId: z.string().optional(),
			}),
		)
		.subscription(async ({ input, ctx }) => {
			await checkServicePermissionAndAccess(ctx, input.id, {
				volumeBackup: ["restore"],
			});
			const service =
				input.serviceType === "application"
					? await findApplicationById(input.id)
					: await findComposeById(input.id);
			const expectedServerId = service.serverId ?? null;
			if ((input.serverId ?? null) !== expectedServerId) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The selected server does not host this service",
				});
			}
			const serviceMounts = await findMountsByApplicationId(
				input.id,
				input.serviceType,
			);
			if (
				!serviceMounts.some(
					(mount) =>
						mount.type === "volume" && mount.volumeName === input.volumeName,
				)
			) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "The selected volume is not attached to this service",
				});
			}
			const destination = await findDestinationById(input.destinationId);
			if (destination.organizationId !== ctx.session.activeOrganizationId) {
				throw new TRPCError({
					code: "UNAUTHORIZED",
					message: "You don't have access to this destination.",
				});
			}
			if (input.serverId) {
				const targetServer = await findServerById(input.serverId);
				if (targetServer.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this server.",
					});
				}
			}
			return observable<string>((emit) => {
				const runRestore = async () => {
					try {
						emit.next("🚀 Starting volume restore process...");
						emit.next(`📂 Backup File: ${input.backupFileName}`);
						emit.next(`🔧 Volume Name: ${input.volumeName}`);
						emit.next(`🏷️ Service Type: ${input.serviceType}`);
						emit.next(""); // Empty line for better readability

						// Generate the restore command
						const restoreCommand = await restoreVolume(
							input.id,
							input.destinationId,
							input.volumeName,
							input.backupFileName,
							input.serverId || "",
							input.serviceType,
						);

						emit.next("📋 Generated restore command:");
						emit.next("▶️ Executing restore...");
						emit.next(""); // Empty line

						if (input.serverId) {
							emit.next(`🌐 Executing on remote server: ${input.serverId}`);
						} else {
							emit.next("🖥️ Executing on local server");
						}
						const result = await executeSensitiveShellScript({
							serverId: input.serverId,
							script: restoreCommand,
							sensitiveValues: getDestinationSensitiveValues(destination),
						});
						if (result.stdout.trim()) emit.next(result.stdout);
						if (result.stderr.trim()) emit.next(result.stderr);

						emit.next("");
						emit.next("✅ Volume restore completed successfully!");
						emit.next(
							"🎉 All containers/services have been restarted with the restored volume.",
						);
					} catch {
						emit.next("");
						emit.next("❌ Volume restore failed!");
					} finally {
						emit.complete();
					}
				};

				// Start the restore process
				runRestore();
			});
		}),
});
