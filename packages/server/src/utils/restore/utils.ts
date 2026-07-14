import {
	getComposeContainerCommand,
	getServiceContainerCommand,
	quoteShellArgument,
} from "../backups/utils";

export const getPostgresRestoreCommand = (
	database: string,
	databaseUser: string,
) => {
	const inner = `pg_restore -U ${quoteShellArgument(databaseUser)} -d ${quoteShellArgument(database)} -O --clean --if-exists`;
	return `docker exec -i "$CONTAINER_ID" sh -c ${quoteShellArgument(inner)}`;
};

export const getMariadbRestoreCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	const inner = `mariadb -u ${quoteShellArgument(databaseUser)} -p${quoteShellArgument(databasePassword)} ${quoteShellArgument(database)}`;
	return `docker exec -i "$CONTAINER_ID" sh -c ${quoteShellArgument(inner)}`;
};

export const getMysqlRestoreCommand = (
	database: string,
	databasePassword: string,
) => {
	const inner = `mysql -u root -p${quoteShellArgument(databasePassword)} ${quoteShellArgument(database)}`;
	return `docker exec -i "$CONTAINER_ID" sh -c ${quoteShellArgument(inner)}`;
};

export const getMongoRestoreCommand = (
	database: string,
	databaseUser: string,
	databasePassword: string,
) => {
	const inner = `mongorestore --username ${quoteShellArgument(databaseUser)} --password ${quoteShellArgument(databasePassword)} --authenticationDatabase admin --db ${quoteShellArgument(database)} --archive --drop`;
	return `docker exec -i "$CONTAINER_ID" sh -c ${quoteShellArgument(inner)}`;
};

export const getComposeSearchCommand = (
	appName: string,
	type: "stack" | "docker-compose" | "database",
	serviceName?: string,
) => {
	if (type === "database") {
		return getServiceContainerCommand(appName || "");
	}
	return getComposeContainerCommand(appName || "", serviceName || "", type);
};

interface DatabaseCredentials {
	database: string;
	databaseUser?: string;
	databasePassword?: string;
}

const generateRestoreCommand = (
	type: "postgres" | "mariadb" | "mysql" | "mongo",
	credentials: DatabaseCredentials,
) => {
	const { database, databaseUser, databasePassword } = credentials;
	switch (type) {
		case "postgres":
			return getPostgresRestoreCommand(database, databaseUser || "");
		case "mariadb":
			return getMariadbRestoreCommand(
				database,
				databaseUser || "",
				databasePassword || "",
			);
		case "mysql":
			return getMysqlRestoreCommand(database, databasePassword || "");
		case "mongo":
			return getMongoRestoreCommand(
				database,
				databaseUser || "",
				databasePassword || "",
			);
	}
};

const getMongoSpecificCommand = (
	rcloneCommand: string,
	restoreCommand: string,
	backupFile: string,
): string => {
	const tempDir = "/tmp/nearzero-restore";
	const fileName = backupFile.split("/").pop() || "backup.sql.gz";
	const decompressedName = fileName.replace(".gz", "");
	const quotedTempDir = quoteShellArgument(tempDir);
	const quotedFileName = quoteShellArgument(fileName);
	const quotedDecompressedName = quoteShellArgument(decompressedName);
	return `
rm -rf -- ${quotedTempDir} && \
mkdir -p -- ${quotedTempDir} && \
${rcloneCommand} ${quotedTempDir} && \
cd ${quotedTempDir} && \
gunzip -f -- ${quotedFileName} && \
${restoreCommand} < ${quotedDecompressedName} && \
rm -rf -- ${quotedTempDir}
	`;
};

interface RestoreOptions {
	appName: string;
	type: "postgres" | "mariadb" | "mysql" | "mongo";
	restoreType: "stack" | "docker-compose" | "database";
	credentials: DatabaseCredentials;
	serviceName?: string;
	rcloneCommand: string;
	backupFile?: string;
}

export const getRestoreCommand = ({
	appName,
	type,
	restoreType,
	credentials,
	serviceName,
	rcloneCommand,
	backupFile,
}: RestoreOptions) => {
	const containerSearch = getComposeSearchCommand(
		appName,
		restoreType,
		serviceName,
	);
	const restoreCommand = generateRestoreCommand(type, credentials);
	let cmd = `CONTAINER_ID=$(${containerSearch})`;

	if (type !== "mongo") {
		cmd += ` && ${rcloneCommand} | ${restoreCommand}`;
	} else {
		cmd += ` && ${getMongoSpecificCommand(rcloneCommand, restoreCommand, backupFile || "")}`;
	}

	return cmd;
};
