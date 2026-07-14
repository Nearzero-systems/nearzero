import {
	createBackup,
	findBackupById,
	findComposeByBackupId,
	findComposeById,
	findLibsqlByBackupId,
	findLibsqlById,
	findMariadbByBackupId,
	findMariadbById,
	findMongoByBackupId,
	findMongoById,
	findMySqlByBackupId,
	findMySqlById,
	findPostgresByBackupId,
	findPostgresById,
	findServerById,
	keepLatestNBackups,
	removeBackupById,
	removeScheduleBackup,
	runLibsqlBackup,
	runMariadbBackup,
	runMongoBackup,
	runMySqlBackup,
	runPostgresBackup,
	runWebServerBackup,
	scheduleBackup,
	updateBackupById,
} from "@nearzero/server";
import { findDestinationById } from "@nearzero/server/services/destination";
import { sanitizePublicErrorMessage } from "@nearzero/server/services/operational-log";
import {
	checkPermission,
	checkServicePermissionAndAccess,
} from "@nearzero/server/services/permission";
import { runComposeBackup } from "@nearzero/server/utils/backups/compose";
import {
	getDestinationSensitiveValues,
	getS3Credentials,
	normalizeS3Path,
	quoteShellArgument,
} from "@nearzero/server/utils/backups/utils";
import { executeSensitiveShellScript } from "@nearzero/server/utils/process/execAsync";
import {
	restoreComposeBackup,
	restoreLibsqlBackup,
	restoreMariadbBackup,
	restoreMongoBackup,
	restoreMySqlBackup,
	restorePostgresBackup,
	restoreWebServerBackup,
} from "@nearzero/server/utils/restore";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import {
	createTRPCRouter,
	protectedProcedure,
	withPermission,
} from "@/server/api/trpc";
import { audit } from "@/server/api/utils/audit";
import {
	apiCreateBackup,
	apiFindOneBackup,
	apiRemoveBackup,
	apiRestoreBackup,
	apiUpdateBackup,
} from "@/server/db/schema";
import { removeJob, schedule, updateJob } from "@/server/utils/backup";

interface RcloneFile {
	Path: string;
	Name: string;
	Size: number;
	IsDir: boolean;
	Tier?: string;
	Hashes?: {
		MD5?: string;
		SHA1?: string;
	};
}

const BACKUP_PRIVATE_KEYS = new Set([
	"accessKey",
	"secretAccessKey",
	"databasePassword",
	"databaseRootPassword",
	"password",
	"privateKey",
	"token",
	"env",
	"buildArgs",
	"buildSecrets",
]);

function redactBackupTree(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redactBackupTree);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.filter(([key]) => !BACKUP_PRIVATE_KEYS.has(key))
			.map(([key, nested]) => [key, redactBackupTree(nested)]),
	);
}

function toPublicBackup<T extends object>(backup: T): T {
	return redactBackupTree(backup) as T;
}

function assertDestinationOrganization(
	destination: { organizationId: string },
	activeOrganizationId: string,
) {
	if (destination.organizationId !== activeOrganizationId) {
		throw new TRPCError({
			code: "UNAUTHORIZED",
			message: "You do not have access to this backup destination",
		});
	}
}

export const backupRouter = createTRPCRouter({
	create: protectedProcedure
		.input(apiCreateBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				assertDestinationOrganization(
					destination,
					ctx.session.activeOrganizationId,
				);
				const serviceId =
					input.postgresId ||
					input.mysqlId ||
					input.mariadbId ||
					input.mongoId ||
					input.libsqlId ||
					input.composeId;
				if (serviceId) {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						backup: ["create"],
					});
				} else {
					await checkPermission(ctx, { backup: ["create"] });
				}

				const newBackup = await createBackup(input);
				const backup = await findBackupById(newBackup.backupId);

				if (backup.enabled) {
					if (process.env.JOBS_URL) {
						const databaseType = backup.databaseType;
						let serverId = "";
						if (databaseType === "postgres" && backup.postgres?.serverId) {
							serverId = backup.postgres.serverId;
						} else if (databaseType === "mysql" && backup.mysql?.serverId) {
							serverId = backup.mysql.serverId;
						} else if (databaseType === "mongo" && backup.mongo?.serverId) {
							serverId = backup.mongo.serverId;
						} else if (databaseType === "mariadb" && backup.mariadb?.serverId) {
							serverId = backup.mariadb.serverId;
						} else if (databaseType === "libsql" && backup.libsql?.serverId) {
							serverId = backup.libsql.serverId;
						} else if (
							backup.backupType === "compose" &&
							backup.compose?.serverId
						) {
							serverId = backup.compose.serverId;
						}
						if (serverId) {
							const remoteServer = await findServerById(serverId);
							if (remoteServer.serverStatus === "inactive") {
								throw new TRPCError({
									code: "NOT_FOUND",
									message: "Server is inactive",
								});
							}
						}
						await schedule({
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
							type: "backup",
						});
					} else {
						scheduleBackup(backup);
					}
				}
				await audit(ctx, {
					action: "create",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: sanitizePublicErrorMessage(
						error instanceof Error ? error.message : error,
						"Error creating the backup",
					),
					cause: error,
				});
			}
		}),
	one: protectedProcedure
		.input(apiFindOneBackup)
		.query(async ({ input, ctx }) => {
			const backup = await findBackupById(input.backupId);
			assertDestinationOrganization(
				backup.destination,
				ctx.session.activeOrganizationId,
			);

			const serviceId =
				backup.postgresId ||
				backup.mysqlId ||
				backup.mariadbId ||
				backup.mongoId ||
				backup.libsqlId ||
				backup.composeId;
			if (serviceId) {
				await checkServicePermissionAndAccess(ctx, serviceId, {
					backup: ["read"],
				});
			} else {
				await checkPermission(ctx, { backup: ["read"] });
			}

			return toPublicBackup(backup);
		}),
	update: protectedProcedure
		.input(apiUpdateBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const existing = await findBackupById(input.backupId);
				assertDestinationOrganization(
					existing.destination,
					ctx.session.activeOrganizationId,
				);
				const nextDestination = await findDestinationById(input.destinationId);
				assertDestinationOrganization(
					nextDestination,
					ctx.session.activeOrganizationId,
				);
				const serviceId =
					existing.postgresId ||
					existing.mysqlId ||
					existing.mariadbId ||
					existing.mongoId ||
					existing.libsqlId ||
					existing.composeId;
				if (serviceId) {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						backup: ["update"],
					});
				} else {
					await checkPermission(ctx, { backup: ["update"] });
				}

				await updateBackupById(input.backupId, input);
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);

				if (process.env.JOBS_URL) {
					if (backup.enabled) {
						await updateJob({
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
							type: "backup",
						});
					} else {
						await removeJob({
							cronSchedule: backup.schedule,
							backupId: backup.backupId,
							type: "backup",
						});
					}
				} else {
					if (backup.enabled) {
						removeScheduleBackup(input.backupId);
						scheduleBackup(backup);
					} else {
						removeScheduleBackup(input.backupId);
					}
				}
				await audit(ctx, {
					action: "update",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
			} catch (error) {
				const message = sanitizePublicErrorMessage(
					error instanceof Error ? error.message : error,
					"Error updating this backup",
				);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	remove: protectedProcedure
		.input(apiRemoveBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);
				const serviceId =
					backup.postgresId ||
					backup.mysqlId ||
					backup.mariadbId ||
					backup.mongoId ||
					backup.libsqlId ||
					backup.composeId;
				if (serviceId) {
					await checkServicePermissionAndAccess(ctx, serviceId, {
						backup: ["delete"],
					});
				} else {
					await checkPermission(ctx, { backup: ["delete"] });
				}

				const value = await removeBackupById(input.backupId);
				if (value) {
					if (process.env.JOBS_URL) {
						await removeJob({
							backupId: input.backupId,
							cronSchedule: value.schedule,
							type: "backup",
						});
					} else {
						removeScheduleBackup(input.backupId);
					}
				}
				await audit(ctx, {
					action: "delete",
					resourceType: "backup",
					resourceId: input.backupId,
				});
				return value;
			} catch (error) {
				const message = sanitizePublicErrorMessage(
					error instanceof Error ? error.message : error,
					"Error deleting this backup",
				);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),
	manualBackupPostgres: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);
				if (backup.postgresId) {
					await checkServicePermissionAndAccess(ctx, backup.postgresId, {
						backup: ["create"],
					});
				}
				const postgres = await findPostgresByBackupId(backup.backupId);
				await runPostgresBackup(postgres, backup);
				await keepLatestNBackups(backup, postgres?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				const message = sanitizePublicErrorMessage(
					error instanceof Error ? error.message : error,
					"Error running manual Postgres backup",
				);
				throw new TRPCError({
					code: "BAD_REQUEST",
					message,
				});
			}
		}),

	manualBackupMySql: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);
				if (backup.mysqlId) {
					await checkServicePermissionAndAccess(ctx, backup.mysqlId, {
						backup: ["create"],
					});
				}
				const mysql = await findMySqlByBackupId(backup.backupId);
				await runMySqlBackup(mysql, backup);
				await keepLatestNBackups(backup, mysql?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual MySQL backup ",
					cause: error,
				});
			}
		}),
	manualBackupMariadb: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);
				if (backup.mariadbId) {
					await checkServicePermissionAndAccess(ctx, backup.mariadbId, {
						backup: ["create"],
					});
				}
				const mariadb = await findMariadbByBackupId(backup.backupId);
				await runMariadbBackup(mariadb, backup);
				await keepLatestNBackups(backup, mariadb?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Mariadb backup ",
					cause: error,
				});
			}
		}),
	manualBackupCompose: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);
				if (backup.composeId) {
					await checkServicePermissionAndAccess(ctx, backup.composeId, {
						backup: ["create"],
					});
				}
				const compose = await findComposeByBackupId(backup.backupId);
				await runComposeBackup(compose, backup);
				await keepLatestNBackups(backup, compose?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Compose backup ",
					cause: error,
				});
			}
		}),
	manualBackupMongo: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);
				if (backup.mongoId) {
					await checkServicePermissionAndAccess(ctx, backup.mongoId, {
						backup: ["create"],
					});
				}
				const mongo = await findMongoByBackupId(backup.backupId);
				await runMongoBackup(mongo, backup);
				await keepLatestNBackups(backup, mongo?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Mongo backup ",
					cause: error,
				});
			}
		}),
	manualBackupLibsql: protectedProcedure
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			try {
				const backup = await findBackupById(input.backupId);
				assertDestinationOrganization(
					backup.destination,
					ctx.session.activeOrganizationId,
				);
				if (backup.libsqlId) {
					await checkServicePermissionAndAccess(ctx, backup.libsqlId, {
						backup: ["create"],
					});
				}
				const libsql = await findLibsqlByBackupId(backup.backupId);
				await runLibsqlBackup(libsql, backup);
				await keepLatestNBackups(backup, libsql?.serverId);
				await audit(ctx, {
					action: "run",
					resourceType: "backup",
					resourceId: backup.backupId,
				});
				return true;
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Error running manual Libsql backup ",
					cause: error,
				});
			}
		}),
	manualBackupWebServer: withPermission("backup", "create")
		.input(apiFindOneBackup)
		.mutation(async ({ input, ctx }) => {
			const backup = await findBackupById(input.backupId);
			assertDestinationOrganization(
				backup.destination,
				ctx.session.activeOrganizationId,
			);
			await runWebServerBackup(backup);
			await keepLatestNBackups(backup);
			await audit(ctx, {
				action: "run",
				resourceType: "backup",
				resourceId: backup.backupId,
			});
			return true;
		}),
	listBackupFiles: withPermission("backup", "read")
		.input(
			z.object({
				destinationId: z.string(),
				search: z.string(),
				serverId: z.string().optional(),
			}),
		)
		.query(async ({ input, ctx }) => {
			try {
				const destination = await findDestinationById(input.destinationId);
				if (destination.organizationId !== ctx.session.activeOrganizationId) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "You don't have access to this destination.",
					});
				}
				if (input.serverId) {
					const targetServer = await findServerById(input.serverId);
					if (
						targetServer.organizationId !== ctx.session.activeOrganizationId
					) {
						throw new TRPCError({
							code: "UNAUTHORIZED",
							message: "You don't have access to this server.",
						});
					}
				}
				const rcloneFlags = getS3Credentials(destination);
				const bucketPath = `:s3:${destination.bucket}`;

				const lastSlashIndex = input.search.lastIndexOf("/");
				const baseDir =
					lastSlashIndex !== -1
						? normalizeS3Path(input.search.slice(0, lastSlashIndex + 1))
						: "";
				const searchTerm =
					lastSlashIndex !== -1
						? input.search.slice(lastSlashIndex + 1)
						: input.search;

				const searchPath = baseDir ? `${bucketPath}/${baseDir}` : bucketPath;
				const listCommand = `rclone lsjson ${rcloneFlags.join(" ")} ${quoteShellArgument(searchPath)} --no-mimetype --no-modtime 2>/dev/null`;
				const { stdout } = await executeSensitiveShellScript({
					serverId: input.serverId,
					script: listCommand,
					sensitiveValues: getDestinationSensitiveValues(destination),
				});

				let files: RcloneFile[] = [];
				try {
					files = JSON.parse(stdout) as RcloneFile[];
				} catch {
					throw new Error("Failed to parse backup files list");
				}

				// Limit to first 100 files

				const results = baseDir
					? files.map((file) => ({
							...file,
							Path: `${baseDir}${file.Path}`,
						}))
					: files;

				if (searchTerm) {
					return results
						.filter((file) =>
							file.Path.toLowerCase().includes(searchTerm.toLowerCase()),
						)
						.slice(0, 100);
				}

				return results.slice(0, 100);
			} catch (error) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: sanitizePublicErrorMessage(
						error instanceof Error ? error.message : error,
						"Error listing backup files",
					),
					cause: error,
				});
			}
		}),

	restoreBackupWithLogs: protectedProcedure
		.meta({
			openapi: {
				enabled: false,
				path: "/restore-backup-with-logs",
				method: "POST",
				override: true,
			},
		})
		.input(apiRestoreBackup)
		.subscription(async function* ({ input, ctx, signal }) {
			if (input.databaseId) {
				await checkServicePermissionAndAccess(ctx, input.databaseId, {
					backup: ["restore"],
				});
			} else {
				await checkPermission(ctx, { backup: ["restore"] });
			}
			const destination = await findDestinationById(input.destinationId);
			assertDestinationOrganization(
				destination,
				ctx.session.activeOrganizationId,
			);
			const queue: string[] = [];
			let done = false;
			const onLog = (log: string) => queue.push(log);
			const runRestore = async () => {
				if (input.backupType === "database") {
					if (input.databaseType === "postgres") {
						const postgres = await findPostgresById(input.databaseId);
						await restorePostgresBackup(postgres, destination, input, onLog);
					} else if (input.databaseType === "mysql") {
						const mysql = await findMySqlById(input.databaseId);
						await restoreMySqlBackup(mysql, destination, input, onLog);
					} else if (input.databaseType === "mariadb") {
						const mariadb = await findMariadbById(input.databaseId);
						await restoreMariadbBackup(mariadb, destination, input, onLog);
					} else if (input.databaseType === "mongo") {
						const mongo = await findMongoById(input.databaseId);
						await restoreMongoBackup(mongo, destination, input, onLog);
					} else if (input.databaseType === "libsql") {
						const libsql = await findLibsqlById(input.databaseId);
						await restoreLibsqlBackup(libsql, destination, input, onLog);
					} else if (input.databaseType === "web-server") {
						await restoreWebServerBackup(destination, input.backupFile, onLog);
					}
				} else if (input.backupType === "compose") {
					const compose = await findComposeById(input.databaseId);
					await restoreComposeBackup(compose, destination, input, onLog);
				}
			};
			runRestore()
				.catch((error) => {
					onLog(
						`Error: ${sanitizePublicErrorMessage(error, "Restore failed. Check the server logs for details.")}`,
					);
				})
				.finally(() => {
					done = true;
				});
			while (!done || queue.length > 0) {
				if (queue.length > 0) {
					yield queue.shift()!;
				} else {
					await new Promise((r) => setTimeout(r, 50));
				}

				if (signal?.aborted) {
					return;
				}
			}
		}),
});
