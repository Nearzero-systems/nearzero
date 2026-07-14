import type { apiRestoreBackup } from "@nearzero/server/db/schema";
import type { Destination } from "@nearzero/server/services/destination";
import type { Mongo } from "@nearzero/server/services/mongo";
import type { z } from "zod";
import {
	getDestinationSensitiveValues,
	getRestoreFailureMessage,
	getS3Credentials,
	quoteShellArgument,
} from "../backups/utils";
import { executeSensitiveShellScript } from "../process/execAsync";
import { getRestoreCommand } from "./utils";

export const restoreMongoBackup = async (
	mongo: Mongo,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databasePassword, databaseUser, serverId } = mongo;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;
		const backupPath = `${bucketPath}/${backupInput.backupFile}`;
		const rcloneCommand = `rclone copy ${rcloneFlags.join(" ")} ${quoteShellArgument(backupPath)}`;

		const command = getRestoreCommand({
			appName,
			type: "mongo",
			credentials: {
				database: backupInput.databaseName,
				databaseUser,
				databasePassword,
			},
			restoreType: "database",
			rcloneCommand,
			backupFile: backupInput.backupFile,
		});

		emit("Starting restore...");

		emit("Executing restore command...");
		await executeSensitiveShellScript({
			serverId,
			script: command,
			sensitiveValues: getDestinationSensitiveValues(
				destination,
				databasePassword,
			),
		});

		emit("Restore completed successfully!");
	} catch (error) {
		const message = getRestoreFailureMessage(error);
		emit(`Error: ${message}`);
		throw new Error(message);
	}
};
