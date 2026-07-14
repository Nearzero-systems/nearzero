import type { apiRestoreBackup } from "@nearzero/server/db/schema";
import type { Destination } from "@nearzero/server/services/destination";
import type { MySql } from "@nearzero/server/services/mysql";
import type { z } from "zod";
import {
	getDestinationSensitiveValues,
	getRestoreFailureMessage,
	getS3Credentials,
	quoteShellArgument,
} from "../backups/utils";
import { executeSensitiveShellScript } from "../process/execAsync";
import { getRestoreCommand } from "./utils";

export const restoreMySqlBackup = async (
	mysql: MySql,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databaseRootPassword, serverId } = mysql;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;
		const backupPath = `${bucketPath}/${backupInput.backupFile}`;

		const rcloneCommand = `rclone cat ${rcloneFlags.join(" ")} ${quoteShellArgument(backupPath)} | gunzip`;

		const command = getRestoreCommand({
			appName,
			type: "mysql",
			credentials: {
				database: backupInput.databaseName,
				databasePassword: databaseRootPassword,
			},
			restoreType: "database",
			rcloneCommand,
		});

		emit("Starting restore...");

		emit("Executing restore command...");
		await executeSensitiveShellScript({
			serverId,
			script: command,
			sensitiveValues: getDestinationSensitiveValues(
				destination,
				databaseRootPassword,
			),
		});

		emit("Restore completed successfully!");
	} catch (error) {
		const message = getRestoreFailureMessage(error);
		emit(`Error: ${message}`);
		throw new Error(message);
	}
};
