import type { apiRestoreBackup } from "@nearzero/server/db/schema";
import type { Destination } from "@nearzero/server/services/destination";
import type { Postgres } from "@nearzero/server/services/postgres";
import type { z } from "zod";
import {
	getDestinationSensitiveValues,
	getRestoreFailureMessage,
	getS3Credentials,
	quoteShellArgument,
} from "../backups/utils";
import { executeSensitiveShellScript } from "../process/execAsync";
import { getRestoreCommand } from "./utils";

export const restorePostgresBackup = async (
	postgres: Postgres,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, databaseUser, serverId } = postgres;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;

		const backupPath = `${bucketPath}/${backupInput.backupFile}`;

		const rcloneCommand = `rclone cat ${rcloneFlags.join(" ")} ${quoteShellArgument(backupPath)} | gunzip`;

		emit("Starting restore...");
		emit(`Backup path: ${backupPath}`);

		const command = getRestoreCommand({
			appName,
			credentials: {
				database: backupInput.databaseName,
				databaseUser,
			},
			type: "postgres",
			rcloneCommand,
			restoreType: "database",
		});

		emit("Executing restore command...");
		await executeSensitiveShellScript({
			serverId,
			script: command,
			sensitiveValues: getDestinationSensitiveValues(destination),
		});

		emit("Restore completed successfully!");
	} catch (error) {
		const message = getRestoreFailureMessage(error);
		emit(`Error: ${message}`);
		throw new Error(message);
	}
};
