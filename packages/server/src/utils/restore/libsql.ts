import type { apiRestoreBackup } from "@nearzero/server/db/schema";
import type { Destination } from "@nearzero/server/services/destination";
import type { Libsql } from "@nearzero/server/services/libsql";
import type { z } from "zod";
import {
	getDestinationSensitiveValues,
	getRestoreFailureMessage,
	getS3Credentials,
	getServiceContainerCommand,
	quoteShellArgument,
} from "../backups/utils";
import { executeSensitiveShellScript } from "../process/execAsync";

export const restoreLibsqlBackup = async (
	libsql: Libsql,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		const { appName, serverId } = libsql;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;

		const backupPath = `${bucketPath}/${backupInput.backupFile}`;

		const rcloneCommand = `rclone cat ${rcloneFlags.join(" ")} ${quoteShellArgument(backupPath)}`;

		emit("Starting restore...");
		emit(`Backup path: ${backupPath}`);

		const containerSearch = getServiceContainerCommand(appName);
		const restoreCommand = `docker exec -i "$CONTAINER_ID" sh -c ${quoteShellArgument("tar xzf - -C /var/lib/sqld")}`;

		const command = `CONTAINER_ID=$(${containerSearch}) && ${rcloneCommand} | ${restoreCommand}`;

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
