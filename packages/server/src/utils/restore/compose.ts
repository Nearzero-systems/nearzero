import type { apiRestoreBackup } from "@nearzero/server/db/schema";
import type { Compose } from "@nearzero/server/services/compose";
import type { Destination } from "@nearzero/server/services/destination";
import type { z } from "zod";
import {
	getDestinationSensitiveValues,
	getRestoreFailureMessage,
	getS3Credentials,
	quoteShellArgument,
} from "../backups/utils";
import { executeSensitiveShellScript } from "../process/execAsync";
import { getRestoreCommand } from "./utils";

interface DatabaseCredentials {
	databaseUser?: string;
	databasePassword?: string;
}

export const restoreComposeBackup = async (
	compose: Compose,
	destination: Destination,
	backupInput: z.infer<typeof apiRestoreBackup>,
	emit: (log: string) => void,
) => {
	try {
		if (backupInput.databaseType === "web-server") {
			return;
		}
		const { serverId, appName, composeType } = compose;

		const rcloneFlags = getS3Credentials(destination);
		const bucketPath = `:s3:${destination.bucket}`;
		const backupPath = `${bucketPath}/${backupInput.backupFile}`;
		let rcloneCommand = `rclone cat ${rcloneFlags.join(" ")} ${quoteShellArgument(backupPath)} | gunzip`;

		if (backupInput.metadata?.mongo) {
			rcloneCommand = `rclone copy ${rcloneFlags.join(" ")} ${quoteShellArgument(backupPath)}`;
		}

		let credentials: DatabaseCredentials = {};

		switch (backupInput.databaseType) {
			case "postgres":
				credentials = {
					databaseUser: backupInput.metadata?.postgres?.databaseUser,
				};
				break;
			case "mariadb":
				credentials = {
					databaseUser: backupInput.metadata?.mariadb?.databaseUser,
					databasePassword: backupInput.metadata?.mariadb?.databasePassword,
				};
				break;
			case "mysql":
				credentials = {
					databasePassword: backupInput.metadata?.mysql?.databaseRootPassword,
				};
				break;
			case "mongo":
				credentials = {
					databaseUser: backupInput.metadata?.mongo?.databaseUser,
					databasePassword: backupInput.metadata?.mongo?.databasePassword,
				};
				break;
		}

		const restoreCommand = getRestoreCommand({
			appName: appName,
			serviceName: backupInput.metadata?.serviceName,
			type: backupInput.databaseType as
				| "postgres"
				| "mariadb"
				| "mysql"
				| "mongo",
			credentials: {
				database: backupInput.databaseName,
				...credentials,
			},
			restoreType: composeType,
			rcloneCommand,
			backupFile: backupInput.backupFile,
		});

		emit("Starting restore...");
		emit(`Backup path: ${backupPath}`);

		emit("Executing restore command...");
		await executeSensitiveShellScript({
			serverId,
			script: restoreCommand,
			sensitiveValues: getDestinationSensitiveValues(
				destination,
				credentials.databasePassword,
			),
		});

		emit("Restore completed successfully!");
	} catch (error) {
		const message = getRestoreFailureMessage(error);
		emit(`Error: ${message}`);
		throw new Error(message);
	}
};
