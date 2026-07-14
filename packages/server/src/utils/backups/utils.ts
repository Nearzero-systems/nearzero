import {
	ADDITIONAL_FLAG_ERROR,
	ADDITIONAL_FLAG_REGEX,
} from "@nearzero/server/db/validations/destination";
import { logger } from "@nearzero/server/lib/logger";
import type { BackupSchedule } from "@nearzero/server/services/backup";
import type { Destination } from "@nearzero/server/services/destination";
import { sanitizePublicErrorMessage } from "@nearzero/server/services/operational-log";
import { scheduledJobs, scheduleJob } from "node-schedule";
import { keepLatestNBackups } from ".";
import { runComposeBackup } from "./compose";
import { runLibsqlBackup } from "./libsql";
import { runMariadbBackup } from "./mariadb";
import { runMongoBackup } from "./mongo";
import { runMySqlBackup } from "./mysql";
import { runPostgresBackup } from "./postgres";
import { runWebServerBackup } from "./web-server";

export const scheduleBackup = (backup: BackupSchedule) => {
	const {
		schedule,
		backupId,
		databaseType,
		postgres,
		mysql,
		mongo,
		mariadb,
		libsql,
		compose,
	} = backup;
	scheduleJob(backupId, schedule, async () => {
		if (backup.backupType === "database") {
			if (databaseType === "postgres" && postgres) {
				await runPostgresBackup(postgres, backup);
				await keepLatestNBackups(backup, postgres.serverId);
			} else if (databaseType === "mysql" && mysql) {
				await runMySqlBackup(mysql, backup);
				await keepLatestNBackups(backup, mysql.serverId);
			} else if (databaseType === "mongo" && mongo) {
				await runMongoBackup(mongo, backup);
				await keepLatestNBackups(backup, mongo.serverId);
			} else if (databaseType === "mariadb" && mariadb) {
				await runMariadbBackup(mariadb, backup);
				await keepLatestNBackups(backup, mariadb.serverId);
			} else if (databaseType === "libsql" && libsql) {
				await runLibsqlBackup(libsql, backup);
				await keepLatestNBackups(backup, libsql.serverId);
			} else if (databaseType === "web-server") {
				await runWebServerBackup(backup);
				await keepLatestNBackups(backup);
			}
		} else if (backup.backupType === "compose" && compose) {
			await runComposeBackup(compose, backup);
			await keepLatestNBackups(backup, compose.serverId);
		}
	});
};

export const removeScheduleBackup = (backupId: string) => {
	const currentJob = scheduledJobs[backupId];
	currentJob?.cancel();
};

export const getBackupTimestamp = () =>
	new Date().toISOString().replace(/[:.]/g, "-");

export const normalizeS3Path = (prefix: string) => {
	// Trim whitespace and remove leading/trailing slashes
	const normalizedPrefix = prefix.trim().replace(/^\/+|\/+$/g, "");
	// Return empty string if prefix is empty, otherwise append trailing slash
	return normalizedPrefix ? `${normalizedPrefix}/` : "";
};

export const quoteShellArgument = (value: string) =>
	`'${value.replaceAll("'", `'\\''`)}'`;

type S3CredentialSource = Pick<
	Destination,
	| "accessKey"
	| "secretAccessKey"
	| "region"
	| "endpoint"
	| "provider"
	| "additionalFlags"
>;

export const getS3Credentials = (destination: S3CredentialSource) => {
	const { accessKey, secretAccessKey, region, endpoint, provider } =
		destination;
	const rcloneFlags = [
		quoteShellArgument(`--s3-access-key-id=${accessKey}`),
		quoteShellArgument(`--s3-secret-access-key=${secretAccessKey}`),
		quoteShellArgument(`--s3-region=${region}`),
		quoteShellArgument(`--s3-endpoint=${endpoint}`),
		"--s3-no-check-bucket",
		"--s3-force-path-style",
	];

	if (provider) {
		rcloneFlags.unshift(quoteShellArgument(`--s3-provider=${provider}`));
	}

	if (destination.additionalFlags?.length) {
		for (const flag of destination.additionalFlags) {
			// Revalidate persisted rows as well as API input. Legacy rows predate the
			// schema guard and must not become shell fragments during a backup.
			if (!ADDITIONAL_FLAG_REGEX.test(flag)) {
				throw new Error(ADDITIONAL_FLAG_ERROR);
			}
			rcloneFlags.push(quoteShellArgument(flag));
		}
	}

	return rcloneFlags;
};

export const getBackupSensitiveValues = (backup: BackupSchedule): string[] => {
	const values = [
		backup.destination.accessKey,
		backup.destination.secretAccessKey,
		backup.mysql?.databaseRootPassword,
		backup.mariadb?.databasePassword,
		backup.mongo?.databasePassword,
		backup.metadata?.mysql?.databaseRootPassword,
		backup.metadata?.mariadb?.databasePassword,
		backup.metadata?.mongo?.databasePassword,
	];
	return values.filter((value): value is string => Boolean(value));
};

export const getDestinationSensitiveValues = (
	destination: Pick<Destination, "accessKey" | "secretAccessKey">,
	...values: Array<string | null | undefined>
): string[] =>
	[destination.accessKey, destination.secretAccessKey, ...values].filter(
		(value): value is string => Boolean(value),
	);

export const getBackupFailureMessage = (error: unknown) =>
	sanitizePublicErrorMessage(
		error instanceof Error ? error.message : error,
		"Backup failed. Check the server logs for details.",
	);

export const getRestoreFailureMessage = (error: unknown) =>
	sanitizePublicErrorMessage(
		error instanceof Error ? error.message : error,
		"Restore failed. Check the server logs for details.",
	);

export const getPostgresBackupCommand = (
	database: string,
	databaseUser: string,
) => {
	const inner = `set -o pipefail; pg_dump -Fc --no-acl --no-owner -h localhost -U ${quoteShellArgument(databaseUser)} --no-password ${quoteShellArgument(database)} | gzip`;
	return `docker exec -i "$CONTAINER_ID" bash -c ${quoteShellArgument(inner)}`;
};

export const getMariadbBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	const inner = `set -o pipefail; mariadb-dump --user=${quoteShellArgument(databaseUser)} --password=${quoteShellArgument(databasePassword)} --single-transaction --quick --databases ${quoteShellArgument(database)} | gzip`;
	return `docker exec -i "$CONTAINER_ID" bash -c ${quoteShellArgument(inner)}`;
};

export const getMysqlBackupCommand = (
	database: string,
	databasePassword: string,
) => {
	const inner = `set -o pipefail; mysqldump --default-character-set=utf8mb4 -u root --password=${quoteShellArgument(databasePassword)} --single-transaction --no-tablespaces --quick ${quoteShellArgument(database)} | gzip`;
	return `docker exec -i "$CONTAINER_ID" bash -c ${quoteShellArgument(inner)}`;
};

export const getMongoBackupCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	const inner = `set -o pipefail; mongodump -d ${quoteShellArgument(database)} -u ${quoteShellArgument(databaseUser)} -p ${quoteShellArgument(databasePassword)} --archive --authenticationDatabase admin --gzip`;
	return `docker exec -i "$CONTAINER_ID" bash -c ${quoteShellArgument(inner)}`;
};

export const getLibsqlBackupCommand = (database: string) => {
	const inner = `tar cf - -C /var/lib/sqld ${quoteShellArgument(database)} | gzip`;
	return `docker exec -i "$CONTAINER_ID" sh -c ${quoteShellArgument(inner)}`;
};

export const getServiceContainerCommand = (appName: string) => {
	return `docker ps -q --filter ${quoteShellArgument("status=running")} --filter ${quoteShellArgument(`label=com.docker.swarm.service.name=${appName}`)} | head -n 1`;
};

export const getComposeContainerCommand = (
	appName: string,
	serviceName: string,
	composeType: "stack" | "docker-compose" | undefined,
) => {
	if (composeType === "stack") {
		return `docker ps -q --filter ${quoteShellArgument("status=running")} --filter ${quoteShellArgument(`label=com.docker.stack.namespace=${appName}`)} --filter ${quoteShellArgument(`label=com.docker.swarm.service.name=${appName}_${serviceName}`)} | head -n 1`;
	}
	return `docker ps -q --filter ${quoteShellArgument("status=running")} --filter ${quoteShellArgument(`label=com.docker.compose.project=${appName}`)} --filter ${quoteShellArgument(`label=com.docker.compose.service=${serviceName}`)} | head -n 1`;
};

const getContainerSearchCommand = (backup: BackupSchedule) => {
	const {
		backupType,
		postgres,
		mysql,
		mariadb,
		mongo,
		libsql,
		compose,
		serviceName,
	} = backup;

	if (backupType === "database") {
		const appName =
			postgres?.appName ||
			mysql?.appName ||
			mariadb?.appName ||
			mongo?.appName ||
			libsql?.appName;
		return getServiceContainerCommand(appName || "");
	}
	if (backupType === "compose") {
		const { appName, composeType } = compose || {};
		return getComposeContainerCommand(
			appName || "",
			serviceName || "",
			composeType,
		);
	}
};

export const generateBackupCommand = (backup: BackupSchedule) => {
	const { backupType, databaseType } = backup;
	switch (databaseType) {
		case "postgres": {
			const postgres = backup.postgres;
			if (backupType === "database" && postgres) {
				return getPostgresBackupCommand(backup.database, postgres.databaseUser);
			}
			if (backupType === "compose" && backup.metadata?.postgres) {
				return getPostgresBackupCommand(
					backup.database,
					backup.metadata.postgres.databaseUser,
				);
			}
			break;
		}
		case "mysql": {
			const mysql = backup.mysql;
			if (backupType === "database" && mysql) {
				return getMysqlBackupCommand(
					backup.database,
					mysql.databaseRootPassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mysql) {
				return getMysqlBackupCommand(
					backup.database,
					backup.metadata?.mysql?.databaseRootPassword || "",
				);
			}
			break;
		}
		case "mariadb": {
			const mariadb = backup.mariadb;
			if (backupType === "database" && mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					mariadb.databaseUser,
					mariadb.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mariadb) {
				return getMariadbBackupCommand(
					backup.database,
					backup.metadata.mariadb.databaseUser,
					backup.metadata.mariadb.databasePassword,
				);
			}
			break;
		}
		case "mongo": {
			const mongo = backup.mongo;
			if (backupType === "database" && mongo) {
				return getMongoBackupCommand(
					backup.database,
					mongo.databaseUser,
					mongo.databasePassword,
				);
			}
			if (backupType === "compose" && backup.metadata?.mongo) {
				return getMongoBackupCommand(
					backup.database,
					backup.metadata.mongo.databaseUser,
					backup.metadata.mongo.databasePassword,
				);
			}
			break;
		}
		case "libsql": {
			if (backupType === "database") {
				return getLibsqlBackupCommand(backup.database);
			}
			break;
		}
		default:
			throw new Error(`Database type not supported: ${databaseType}`);
	}

	return null;
};

export const getBackupCommand = (
	backup: BackupSchedule,
	rcloneCommand: string,
	logPath: string,
) => {
	const containerSearch = getContainerSearchCommand(backup);
	const backupCommand = generateBackupCommand(backup);

	logger.info(
		{ databaseType: backup.databaseType, backupType: backup.backupType },
		"Executing backup job",
	);
	const quotedLogPath = quoteShellArgument(logPath);

	return `
	set -eo pipefail;
	echo "[$(date)] Starting backup process..." >> ${quotedLogPath};
	echo "[$(date)] Executing backup command..." >> ${quotedLogPath};
	CONTAINER_ID=$(${containerSearch})

	if [ -z "$CONTAINER_ID" ]; then
		echo "[$(date)] ❌ Error: Container not found" >> ${quotedLogPath};
		exit 1;
	fi

	echo "[$(date)] Container found" >> ${quotedLogPath};

	# Run the backup command and capture the exit status
	BACKUP_OUTPUT=$(${backupCommand} 2>&1 >/dev/null) || {
		echo "[$(date)] ❌ Error: Backup failed" >> ${quotedLogPath};
		exit 1;
	}

	echo "[$(date)] ✅ backup completed successfully" >> ${quotedLogPath};
	echo "[$(date)] Starting upload to S3..." >> ${quotedLogPath};

	# Run the upload command and capture the exit status
	UPLOAD_OUTPUT=$(${backupCommand} | ${rcloneCommand} 2>&1 >/dev/null) || {
		echo "[$(date)] ❌ Error: Upload to S3 failed" >> ${quotedLogPath};
		exit 1;
	}

	echo "[$(date)] ✅ Upload to S3 completed successfully" >> ${quotedLogPath};
	echo "Backup done ✅" >> ${quotedLogPath};
	`;
};
