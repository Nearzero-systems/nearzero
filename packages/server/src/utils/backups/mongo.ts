import type { BackupSchedule } from "@nearzero/server/services/backup";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@nearzero/server/services/deployment";
import { findEnvironmentById } from "@nearzero/server/services/environment";
import type { Mongo } from "@nearzero/server/services/mongo";
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

export const runMongoBackup = async (mongo: Mongo, backup: BackupSchedule) => {
	const { environmentId, name, appName } = mongo;
	const environment = await findEnvironmentById(environmentId);
	const project = await findProjectById(environment.projectId);
	const { prefix } = backup;
	const destination = backup.destination;
	const backupFileName = `${getBackupTimestamp()}.bson.gz`;
	const bucketDestination = `${appName}/${normalizeS3Path(prefix)}${backupFileName}`;
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "MongoDB Backup",
		description: "MongoDB Backup",
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
			serverId: mongo.serverId,
			script: backupCommand,
			sensitiveValues: getBackupSensitiveValues(backup),
		});

		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mongodb",
			type: "success",
			organizationId: project.organizationId,
			databaseName: backup.database,
		});
		await updateDeploymentStatus(deployment.deploymentId, "done");
	} catch (error) {
		await sendDatabaseBackupNotifications({
			applicationName: name,
			projectName: project.name,
			databaseType: "mongodb",
			type: "error",
			errorMessage: getBackupFailureMessage(error),
			organizationId: project.organizationId,
			databaseName: backup.database,
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};
