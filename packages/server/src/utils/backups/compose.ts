import type { BackupSchedule } from "@nearzero/server/services/backup";
import type { Compose } from "@nearzero/server/services/compose";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@nearzero/server/services/deployment";
import { findEnvironmentById } from "@nearzero/server/services/environment";
import { findProjectById } from "@nearzero/server/services/project";
import { sendDatabaseBackupNotifications } from "../notifications/database-backup";
import { executeSensitiveShellScript } from "../process/execAsync";
import {
	getBackupCommand,
	getBackupFailureMessage,
	getBackupSensitiveValues,
	getBackupTimestamp,
	getS3Credentials,
	normalizeS3Path,
	quoteShellArgument,
} from "./utils";

export const runComposeBackup = async (
	compose: Compose,
	backup: BackupSchedule,
) => {
	const { environmentId, name, appName } = compose;
	const environment = await findEnvironmentById(environmentId);
	const project = await findProjectById(environment.projectId);
	const { prefix, databaseType, serviceName } = backup;
	const destination = backup.destination;
	const backupFileName = `${getBackupTimestamp()}.${databaseType === "mongo" ? "bson" : "sql"}.gz`;
	const s3AppName = serviceName ? `${appName}_${serviceName}` : appName;
	const bucketDestination = `${s3AppName}/${normalizeS3Path(prefix)}${backupFileName}`;
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "Compose Backup",
		description: "Compose Backup",
	});

	try {
		const rcloneFlags = getS3Credentials(destination);
		const rcloneDestination = `:s3:${destination.bucket}/${bucketDestination}`;
		const rcloneCommand = `rclone rcat ${rcloneFlags.join(" ")} ${quoteShellArgument(rcloneDestination)}`;

		const backupCommand = getBackupCommand(
			backup,
			rcloneCommand,
			deployment.logPath,
		);
		await executeSensitiveShellScript({
			serverId: compose.serverId,
			script: backupCommand,
			sensitiveValues: getBackupSensitiveValues(backup),
		});

		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: getDatabaseType(databaseType),
			type: "success",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});

		await updateDeploymentStatus(deployment.deploymentId, "done");
	} catch (error) {
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: getDatabaseType(databaseType),
			type: "error",
			errorMessage: getBackupFailureMessage(error),
			organizationId: project.organizationId,
			databaseName: backup.database,
		});

		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};

const getDatabaseType = (databaseType: BackupSchedule["databaseType"]) => {
	if (databaseType === "mongo") {
		return "mongodb";
	}
	if (databaseType === "postgres") {
		return "postgres";
	}
	if (databaseType === "mariadb") {
		return "mariadb";
	}
	if (databaseType === "mysql") {
		return "mysql";
	}
	return "mongodb";
};
