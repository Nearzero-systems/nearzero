import type { apiRestoreBackup } from "@nearzero/server/db/schema";
import type { Destination } from "@nearzero/server/services/destination";
import type { Mariadb } from "@nearzero/server/services/mariadb";
import type { z } from "zod";
import {
	getDestinationSensitiveValues,
	getRestoreFailureMessage,
	getS3Credentials,
	quoteShellArgument,
} from "../backups/utils";
import { executeSensitiveShellScript } from "../process/execAsync";
import { getRestoreCommand } from "./utils";

export const restoreMariadbBackup = async (
	mariadb: Mariadb,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, serverId, databaseUser, databasePassword } = mariadb;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;
		const backupPath = `${bucketPath}/${backupInput.backupFile}`;

		const rcloneCommand = `rclone cat ${rcloneFlags.join(" ")} ${quoteShellArgument(backupPath)} | gunzip`;

		const command = getRestoreCommand({
			appName,
			credentials: {
				database: backupInput.databaseName,
				databaseUser,
				databasePassword,
			},
			type: "mariadb",
			rcloneCommand,
			restoreType: "database",
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
