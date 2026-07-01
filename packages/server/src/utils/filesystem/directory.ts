import fs, { promises as fsPromises } from "node:fs";
import path from "node:path";
import { paths } from "@nearzero/server/constants";
import type { Application } from "@nearzero/server/services/application";
import { resolveApplicationBuildExecutionServerId } from "@nearzero/server/services/build-execution";
import { execAsync, execAsyncRemote } from "../process/execAsync";

export const recreateDirectory = async (pathFolder: string): Promise<void> => {
	try {
		await removeDirectoryIfExistsContent(pathFolder);
		await fsPromises.mkdir(pathFolder, { recursive: true });
	} catch (error) {
		console.error(`Error recreating directory '${pathFolder}':`, error);
	}
};

export const recreateDirectoryRemote = async (
	pathFolder: string,
	serverId: string | null,
): Promise<void> => {
	try {
		await execAsyncRemote(
			serverId,
			`rm -rf ${pathFolder}; mkdir -p ${pathFolder}`,
		);
	} catch (error) {
		console.error(`Error recreating directory '${pathFolder}':`, error);
	}
};

export const removeDirectoryIfExistsContent = async (
	path: string,
): Promise<void> => {
	if (fs.existsSync(path) && fs.readdirSync(path).length !== 0) {
		await execAsync(`rm -rf ${path}`);
	}
};

export const removeFileOrDirectory = async (path: string) => {
	try {
		await execAsync(`rm -rf ${path}`);
	} catch (error) {
		console.error(`Error removing ${path}: ${error}`);
		throw error;
	}
};

export const removeDirectoryCode = async (
	appName: string,
	serverId?: string | null,
) => {
	const { APPLICATIONS_PATH } = paths(!!serverId);
	const directoryPath = path.join(APPLICATIONS_PATH, appName);
	const command = `rm -rf ${directoryPath}`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing ${directoryPath}: ${error}`);
		throw error;
	}
};

export const removeComposeDirectory = async (
	appName: string,
	serverId?: string | null,
) => {
	const { COMPOSE_PATH } = paths(!!serverId);
	const directoryPath = path.join(COMPOSE_PATH, appName);
	const command = `rm -rf ${directoryPath}`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing ${directoryPath}: ${error}`);
		throw error;
	}
};

export const removeMonitoringDirectory = async (
	appName: string,
	serverId?: string | null,
) => {
	const { MONITORING_PATH } = paths(!!serverId);
	const directoryPath = path.join(MONITORING_PATH, appName);
	const command = `rm -rf ${directoryPath}`;
	try {
		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		console.error(`Error removing ${directoryPath}: ${error}`);
		throw error;
	}
};

export const getApplicationBuildDirectory = (
	application: Application,
	buildServerId = resolveApplicationBuildExecutionServerId(application),
) => {
	const serverId = buildServerId;
	const { APPLICATIONS_PATH } = paths(!!serverId);
	const { appName, sourceType, customGitBuildPath } = application;
	let buildPath = "";

	if (sourceType === "github") {
		buildPath = application?.buildPath || "";
	} else if (sourceType === "gitlab") {
		buildPath = application?.gitlabBuildPath || "";
	} else if (sourceType === "bitbucket") {
		buildPath = application?.bitbucketBuildPath || "";
	} else if (sourceType === "gitea") {
		buildPath = application?.giteaBuildPath || "";
	} else if (sourceType === "drop") {
		buildPath = application?.dropBuildPath || "";
	} else if (sourceType === "git") {
		buildPath = customGitBuildPath || "";
	}
	return path.join(APPLICATIONS_PATH, appName, "code", buildPath ?? "");
};

export const getBuildAppDirectory = (
	application: Application,
	buildServerId = resolveApplicationBuildExecutionServerId(application),
	buildTypeOverride = application.buildType,
) => {
	const buildDirectory = getApplicationBuildDirectory(
		application,
		buildServerId,
	);
	if (buildTypeOverride === "dockerfile") {
		return path.join(buildDirectory, application.dockerfile || "Dockerfile");
	}

	return buildDirectory;
};

export const getDockerContextPath = (
	application: Application,
	buildServerId = resolveApplicationBuildExecutionServerId(application),
) => {
	const { APPLICATIONS_PATH } = paths(!!buildServerId);
	const { appName, dockerContextPath } = application;

	if (!dockerContextPath) {
		return null;
	}
	return path.join(APPLICATIONS_PATH, appName, "code", dockerContextPath);
};
