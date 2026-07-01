import { join } from "node:path";
import { paths } from "@nearzero/server/constants";
import { db } from "@nearzero/server/db";
import {
	type apiCreateCompose,
	buildAppName,
	cleanAppName,
	compose,
} from "@nearzero/server/db/schema";
import { getBuildComposeCommand } from "@nearzero/server/utils/builders/compose";
import { loginOrganizationRegistries } from "@nearzero/server/services/registry";
import { dockerComposeEnvPrefix } from "@nearzero/server/utils/docker/utils";
import { randomizeSpecificationFile } from "@nearzero/server/utils/docker/compose";
import {
	cloneCompose,
	loadDockerCompose,
	loadDockerComposeRemote,
} from "@nearzero/server/utils/docker/domain";
import type { ComposeSpecification } from "@nearzero/server/utils/docker/types";
import { sendBuildErrorNotifications } from "@nearzero/server/utils/notifications/build-error";
import { sendBuildSuccessNotifications } from "@nearzero/server/utils/notifications/build-success";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
} from "@nearzero/server/utils/process/execAsync";
import { cloneBitbucketRepository } from "@nearzero/server/utils/providers/bitbucket";
import {
	cloneGitRepository,
	getGitCommitInfo,
} from "@nearzero/server/utils/providers/git";
import { cloneGiteaRepository } from "@nearzero/server/utils/providers/gitea";
import { cloneGithubRepository } from "@nearzero/server/utils/providers/github";
import { cloneGitlabRepository } from "@nearzero/server/utils/providers/gitlab";
import { getCreateComposeFileCommand } from "@nearzero/server/utils/providers/raw";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { quote } from "shell-quote";
import type { z } from "zod";
import { encodeBase64 } from "../utils/docker/utils";
import { getConsoleUrl } from "./admin";
import {
	createDeploymentCompose,
	updateDeployment,
	updateDeploymentStatus,
} from "./deployment";
import { generateApplyPatchesCommand } from "./patch";
import { validUniqueServerAppName } from "./project";

export type Compose = typeof compose.$inferSelect;

export const createCompose = async (
	input: z.infer<typeof apiCreateCompose>,
) => {
	const appName = buildAppName("compose", input.appName);

	const valid = await validUniqueServerAppName(appName);
	if (!valid) {
		throw new TRPCError({
			code: "CONFLICT",
			message: "Service with this 'AppName' already exists",
		});
	}

	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			composeFile: input.composeFile || "",
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const createComposeByTemplate = async (
	input: typeof compose.$inferInsert,
) => {
	const appName = cleanAppName(input.appName);
	if (appName) {
		const valid = await validUniqueServerAppName(appName);

		if (!valid) {
			throw new TRPCError({
				code: "CONFLICT",
				message: "Service with this 'AppName' already exists",
			});
		}
	}
	const newDestination = await db
		.insert(compose)
		.values({
			...input,
			appName,
		})
		.returning()
		.then((value) => value[0]);

	if (!newDestination) {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Error input: Inserting compose",
		});
	}

	return newDestination;
};

export const findComposeById = async (composeId: string) => {
	const result = await db.query.compose.findFirst({
		where: eq(compose.composeId, composeId),
		with: {
			environment: {
				with: {
					project: true,
				},
			},
			deployments: true,
			mounts: true,
			domains: true,
			github: true,
			gitlab: true,
			bitbucket: true,
			gitea: true,
			server: true,
			backups: {
				with: {
					destination: true,
					deployments: true,
				},
			},
		},
	});
	if (!result) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Compose not found",
		});
	}
	return result;
};

export const loadServices = async (
	composeId: string,
	type: "fetch" | "cache" = "fetch",
) => {
	const compose = await findComposeById(composeId);

	if (type === "fetch") {
		const command = await cloneCompose(compose);
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
	}

	let composeData: ComposeSpecification | null;

	if (compose.serverId) {
		composeData = await loadDockerComposeRemote(compose);
	} else {
		composeData = await loadDockerCompose(compose);
	}

	if (compose.randomize && composeData) {
		const randomizedCompose = randomizeSpecificationFile(
			composeData,
			compose.suffix,
		);
		composeData = randomizedCompose;
	}

	if (!composeData?.services) {
		throw new TRPCError({
			code: "NOT_FOUND",
			message: "Services not found",
		});
	}

	const services = Object.keys(composeData.services);

	return [...services];
};

export const updateCompose = async (
	composeId: string,
	composeData: Partial<Compose>,
) => {
	const { appName, ...rest } = composeData;
	const composeResult = await db
		.update(compose)
		.set({
			...rest,
		})
		.where(eq(compose.composeId, composeId))
		.returning();

	return composeResult[0];
};

export const deployCompose = async ({
	composeId,
	titleLog = "Manual deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);
	const { ensureDefaultServiceDomain } = await import(
		"./managed-domain-provision"
	);
	await ensureDefaultServiceDomain({
		serviceType: "compose",
		serviceId: composeId,
		serverId: compose.serverId,
	});

	const buildLink = `${await getConsoleUrl()}/dashboard/project/${
		compose.environment.projectId
	}/environment/${compose.environmentId}/services/compose/${compose.composeId}?tab=deployments`;
	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		const entity = {
			...compose,
			type: "compose" as const,
		};
		let command = "set -e;";
		if (compose.sourceType === "github") {
			command += await cloneGithubRepository(entity);
		} else if (compose.sourceType === "gitlab") {
			command += await cloneGitlabRepository(entity);
		} else if (compose.sourceType === "bitbucket") {
			command += await cloneBitbucketRepository(entity);
		} else if (compose.sourceType === "git") {
			command += await cloneGitRepository(entity);
		} else if (compose.sourceType === "gitea") {
			command += await cloneGiteaRepository(entity);
		} else if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(entity);
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}
		if (compose.sourceType !== "raw") {
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		command = "set -e;";
		command += await getBuildComposeCommand(entity);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});

		await sendBuildSuccessNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			buildLink,
			organizationId: compose.environment.project.organizationId,
			domains: compose.domains,
			environmentName: compose.environment.name,
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		await sendBuildErrorNotifications({
			projectName: compose.environment.project.name,
			applicationName: compose.name,
			applicationType: "compose",
			// @ts-ignore
			errorMessage: error?.message || "Error building",
			buildLink,
			organizationId: compose.environment.project.organizationId,
		});
		throw error;
	} finally {
		if (compose.sourceType !== "raw") {
			const commitInfo = await getGitCommitInfo({
				...compose,
				type: "compose",
			});
			if (commitInfo) {
				await updateDeployment(deployment.deploymentId, {
					title: commitInfo.message,
					description: `Commit: ${commitInfo.hash}`,
				});
			}
		}
	}
};

export const rebuildCompose = async ({
	composeId,
	titleLog = "Rebuild deployment",
	descriptionLog = "",
}: {
	composeId: string;
	titleLog: string;
	descriptionLog: string;
}) => {
	const compose = await findComposeById(composeId);

	const deployment = await createDeploymentCompose({
		composeId: composeId,
		title: titleLog,
		description: descriptionLog,
	});

	try {
		let command = "set -e;";
		if (compose.sourceType === "raw") {
			command += getCreateComposeFileCommand(compose);
		}

		let commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		if (compose.sourceType !== "raw") {
			command = "set -e;";
			command += await generateApplyPatchesCommand({
				id: compose.composeId,
				type: "compose",
				serverId: compose.serverId,
			});
			commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, commandWithLog);
			} else {
				await execAsync(commandWithLog);
			}
		}

		command = "set -e;";
		command += await getBuildComposeCommand(compose);
		commandWithLog = `(${command}) >> ${deployment.logPath} 2>&1`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, commandWithLog);
		} else {
			await execAsync(commandWithLog);
		}

		await updateDeploymentStatus(deployment.deploymentId, "done");
		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		let command = "";

		// Only log details for non-ExecError errors
		if (!(error instanceof ExecError)) {
			const message = error instanceof Error ? error.message : String(error);
			const encodedMessage = encodeBase64(message);
			command += `echo "${encodedMessage}" | base64 -d >> "${deployment.logPath}";`;
		}

		command += `echo "\nError occurred ❌, check the logs for details." >> ${deployment.logPath};`;
		if (compose.serverId) {
			await execAsyncRemote(compose.serverId, command);
		} else {
			await execAsync(command);
		}
		await updateDeploymentStatus(deployment.deploymentId, "error");
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};

export const removeCompose = async (
	compose: Compose,
	deleteVolumes: boolean,
) => {
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		const projectPath = join(COMPOSE_PATH, compose.appName);
		const appNameArg = quote([compose.appName]);
		const projectPathArg = quote([projectPath]);

		if (compose.composeType === "stack") {
			const command = `
STACK_SERVICES=$(docker service ls --filter label=com.docker.stack.namespace=${appNameArg} --format '{{.Name}}' 2>/dev/null || true)
STACK_IMAGES=""
STACK_VOLUMES=""
if [ "${deleteVolumes ? "1" : "0"}" = "1" ]; then
	for service_name in $STACK_SERVICES; do
		STACK_IMAGES="$STACK_IMAGES
$(docker service inspect "$service_name" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null | sed 's/@sha256:.*//' || true)"
		STACK_VOLUMES="$STACK_VOLUMES
$(docker service inspect "$service_name" --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{if eq .Type "volume"}}{{.Source}}{{"\\n"}}{{end}}{{end}}' 2>/dev/null || true)"
	done
fi

docker network disconnect ${appNameArg} nearzero-traefik >/dev/null 2>&1 || true
docker stack rm ${appNameArg} >/dev/null 2>&1 || true

for attempt in 1 2 3 4 5; do
	if docker service ls --filter label=com.docker.stack.namespace=${appNameArg} --format '{{.Name}}' | grep -q .; then
		sleep 1
	else
		break
	fi
done

if [ "${deleteVolumes ? "1" : "0"}" = "1" ]; then
	printf '%s\n' "$STACK_VOLUMES" | while IFS= read -r volume_name; do
		if [ -n "$volume_name" ]; then
			docker volume rm -f "$volume_name" >/dev/null 2>&1 || true
		fi
	done
	printf '%s\n' "$STACK_IMAGES" | while IFS= read -r image_name; do
		if [ -n "$image_name" ]; then
			docker image rm -f "$image_name" >/dev/null 2>&1 || true
		fi
	done
fi

rm -rf ${projectPathArg}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		} else {
			const command = `
docker network disconnect ${appNameArg} nearzero-traefik >/dev/null 2>&1 || true
${dockerComposeEnvPrefix} docker compose -p ${appNameArg} down ${
				deleteVolumes ? "--volumes --rmi all" : ""
			}
rm -rf ${projectPathArg}`;

			if (compose.serverId) {
				await execAsyncRemote(compose.serverId, command);
			} else {
				await execAsync(command);
			}
		}
	} catch (error) {
		throw error;
	}

	return true;
};

export const startCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);

		await loginOrganizationRegistries(
			compose.environment.project.organizationId,
			compose.serverId,
		);

		const projectPath = join(COMPOSE_PATH, compose.appName, "code");
		const path =
			compose.sourceType === "raw" ? "docker-compose.yml" : compose.composePath;
		const baseCommand = `${dockerComposeEnvPrefix} docker compose -p ${compose.appName} -f ${path} up -d`;
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${projectPath} && ${baseCommand}`,
				);
			} else {
				await execAsync(baseCommand, {
					cwd: projectPath,
				});
			}
		}

		await updateCompose(composeId, {
			composeStatus: "done",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "idle",
		});
		throw error;
	}

	return true;
};

export const stopCompose = async (composeId: string) => {
	const compose = await findComposeById(composeId);
	try {
		const { COMPOSE_PATH } = paths(!!compose.serverId);
		if (compose.composeType === "docker-compose") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`cd ${join(COMPOSE_PATH, compose.appName)} && ${dockerComposeEnvPrefix} docker compose -p ${
						compose.appName
					} stop`,
				);
			} else {
				await execAsync(
					`${dockerComposeEnvPrefix} docker compose -p ${compose.appName} stop`,
					{
						cwd: join(COMPOSE_PATH, compose.appName),
					},
				);
			}
		}

		if (compose.composeType === "stack") {
			if (compose.serverId) {
				await execAsyncRemote(
					compose.serverId,
					`docker stack rm ${compose.appName}`,
				);
			} else {
				await execAsync(`docker stack rm ${compose.appName}`);
			}
		}

		await updateCompose(composeId, {
			composeStatus: "idle",
		});
	} catch (error) {
		await updateCompose(composeId, {
			composeStatus: "error",
		});
		throw error;
	}

	return true;
};
