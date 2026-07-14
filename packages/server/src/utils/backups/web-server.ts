import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@nearzero/server/constants";
import type { BackupSchedule } from "@nearzero/server/services/backup";
import {
	createDeploymentBackup,
	updateDeploymentStatus,
} from "@nearzero/server/services/deployment";
import { findDestinationById } from "@nearzero/server/services/destination";
import { sendNearzeroBackupNotifications } from "../notifications/nearzero-backup";
import { execAsync, executeSensitiveShellScript } from "../process/execAsync";
import {
	getBackupFailureMessage,
	getBackupTimestamp,
	getDestinationSensitiveValues,
	getS3Credentials,
	normalizeS3Path,
	quoteShellArgument,
} from "./utils";

function formatBytes(bytes?: number) {
	if (bytes === undefined) return "Unknown size";
	if (bytes === 0) return "0 B";
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const value = bytes / 1024 ** i;
	return `${value.toFixed(2)} ${sizes[i]} (${bytes} bytes)`;
}

export const runWebServerBackup = async (backup: BackupSchedule) => {
	const deployment = await createDeploymentBackup({
		backupId: backup.backupId,
		title: "Web Server Backup",
		description: "Web Server Backup",
	});
	const writeStream = createWriteStream(deployment.logPath, { flags: "a" });
	let computedBackupSize: number | undefined;
	try {
		const destination = await findDestinationById(backup.destinationId);
		const rcloneFlags = getS3Credentials(destination);
		const timestamp = getBackupTimestamp();
		const { BASE_PATH } = paths();
		const tempDir = await mkdtemp(join(tmpdir(), "nearzero-backup-"));
		const backupFileName = `webserver-backup-${timestamp}.zip`;
		const s3Path = `:s3:${destination.bucket}/${backup.appName}/${normalizeS3Path(backup.prefix)}${backupFileName}`;

		try {
			await execAsync(`mkdir -p ${tempDir}/filesystem`);

			// First get the container ID
			const { stdout: containerId } = await execAsync(
				`docker ps --filter "name=nearzero-postgres" --filter "status=running" -q | head -n 1`,
			);

			if (!containerId) {
				writeStream.write("Nearzero postgres container not found❌\n");
				writeStream.end();
				throw new Error("Nearzero postgres container not found");
			}

			writeStream.write(`Nearzero postgres container ID: ${containerId}\n`);

			const postgresContainerId = containerId.trim();

			// First dump the database inside the container
			const dumpCommand = `docker exec ${postgresContainerId} pg_dump -v -Fc -U nearzero -d nearzero -f /tmp/database.sql`;
			writeStream.write(`Running dump command: ${dumpCommand}\n`);
			await execAsync(dumpCommand);

			// Then copy the file from the container to host
			const copyCommand = `docker cp ${postgresContainerId}:/tmp/database.sql ${tempDir}/database.sql`;
			writeStream.write(`Copying database dump: ${copyCommand}\n`);
			await execAsync(copyCommand);

			// Clean up the temp file in the container
			const cleanupCommand = `docker exec ${postgresContainerId} rm -f /tmp/database.sql`;
			writeStream.write(`Cleaning up temp file: ${cleanupCommand}\n`);
			await execAsync(cleanupCommand);

			await execAsync(
				`rsync -a --ignore-errors --no-specials --no-devices --exclude='volume-backups/' ${BASE_PATH}/ ${tempDir}/filesystem/`,
			);

			writeStream.write("Copied filesystem to temp directory\n");

			await execAsync(
				// Zip all .sql files since we created more than one
				`cd ${tempDir} && zip -r ${backupFileName} *.sql filesystem/ > /dev/null 2>&1`,
			);

			writeStream.write("Zipped database and filesystem\n");

			const zipPath = join(tempDir, backupFileName);
			try {
				const { size } = await stat(zipPath);
				computedBackupSize = size;
				writeStream.write(`Backup size: ${size} bytes\n`);
			} catch {
				// If stat fails, keep undefined
			}

			const uploadCommand = `rclone copyto ${rcloneFlags.join(" ")} ${quoteShellArgument(zipPath)} ${quoteShellArgument(s3Path)}`;
			writeStream.write("Running command to upload backup to S3\n");
			await executeSensitiveShellScript({
				script: uploadCommand,
				sensitiveValues: getDestinationSensitiveValues(destination),
			});
			writeStream.write("Uploaded backup to S3 ✅\n");
			writeStream.end();
			await sendNearzeroBackupNotifications({
				type: "success",
				backupSize: formatBytes(computedBackupSize),
			});
			await updateDeploymentStatus(deployment.deploymentId, "done");
			return true;
		} finally {
			try {
				await rm(tempDir, { recursive: true, force: true });
			} catch (cleanupError) {
				console.error("Cleanup error:", cleanupError);
			}
		}
	} catch (error) {
		const message = getBackupFailureMessage(error);
		writeStream.write("Backup error❌\n");
		writeStream.write(`${message}\n`);
		writeStream.end();
		await sendNearzeroBackupNotifications({
			type: "error",
			errorMessage: message,
			backupSize: formatBytes(computedBackupSize),
		});
		await updateDeploymentStatus(deployment.deploymentId, "error");
		throw error;
	}
};
