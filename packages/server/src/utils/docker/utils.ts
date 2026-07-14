import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { getDocker, paths } from "@nearzero/server/constants";
import type { Compose } from "@nearzero/server/services/compose";
import type { ContainerInfo, ResourceRequirements } from "dockerode";
import { parse } from "dotenv";
import { quote } from "shell-quote";
import { findServerById } from "../../services/server";
import type { ApplicationNested } from "../builders";
import type { LibsqlNested } from "../databases/libsql";
import type { MariadbNested } from "../databases/mariadb";
import type { MongoNested } from "../databases/mongo";
import type { MysqlNested } from "../databases/mysql";
import type { PostgresNested } from "../databases/postgres";
import type { RedisNested } from "../databases/redis";
import type { ServiceScaleErrorCode } from "../process/ExecError";
import {
	ExecError,
	execAsync,
	execAsyncRemote,
	ServiceScaleError,
} from "../process/execAsync";
import { spawnAsync } from "../process/spawnAsync";
import {
	formatPublishedPortSpecs,
	normalizePublishedPortSpecs,
	openPublishedPortsOnRemoteServer,
} from "../servers/firewall";
import { getRemoteDocker } from "../servers/remote-docker";

interface RegistryAuth {
	username: string;
	password: string;
	registryUrl: string;
}

export const pullImage = async (
	dockerImage: string,
	onData?: (data: any) => void,
	authConfig?: Partial<RegistryAuth>,
): Promise<void> => {
	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}

		if (authConfig?.username && authConfig?.password) {
			const login = spawnAsync(
				"docker",
				[
					"login",
					...(authConfig.registryUrl ? [authConfig.registryUrl] : []),
					"-u",
					authConfig.username,
					"--password-stdin",
				],
				onData,
			);
			if (!login.child.stdin) {
				login.child.kill();
				throw new Error("Docker login stdin is unavailable");
			}
			login.child.stdin.end(`${authConfig.password}\n`);
			await login;
		}
		const localImage = spawnSync("docker", ["image", "inspect", dockerImage], {
			stdio: "ignore",
		});
		if (localImage.status === 0) {
			return;
		}
		await spawnAsync("docker", ["pull", dockerImage], onData);
	} catch (error) {
		throw error;
	}
};

export const pullRemoteImage = async (
	dockerImage: string,
	serverId: string,
	onData?: (data: any) => void,
	authConfig?: Partial<RegistryAuth>,
): Promise<void> => {
	try {
		if (!dockerImage) {
			throw new Error("Docker image not found");
		}

		const remoteDocker = await getRemoteDocker(serverId);

		await new Promise((resolve, reject) => {
			remoteDocker.pull(
				dockerImage,
				{ authconfig: authConfig },
				(err, stream) => {
					if (err) {
						reject(err);
						return;
					}

					remoteDocker.modem.followProgress(
						stream as Readable,
						(err: Error | null, res) => {
							if (!err) {
								resolve(res);
							}
							if (err) {
								reject(err);
							}
						},
						(event) => {
							onData?.(event);
						},
					);
				},
			);
		});
	} catch (error) {
		throw error;
	}
};

export const containerExists = async (containerName: string) => {
	const container = getDocker().getContainer(containerName);
	try {
		await container.inspect();
		return true;
	} catch {
		return false;
	}
};

interface ServiceScaleTarget {
	appName: string;
	serverId?: string | null;
	serverName?: string | null;
	serverHost?: string | null;
}

const trimErrorDetail = (value: string | undefined | null) => {
	const detail = value?.trim();
	if (!detail) return undefined;
	return detail.length > 300 ? `${detail.slice(0, 300)}...` : detail;
};

const getErrorDetail = (error: unknown) => {
	if (error instanceof ExecError) {
		return trimErrorDetail(error.stderr || error.message);
	}
	if (error instanceof Error) {
		return trimErrorDetail(error.message);
	}
	return undefined;
};

const isSshAuthError = (error: unknown) => {
	const detail = getErrorDetail(error) ?? "";
	const originalLevel =
		error instanceof ExecError
			? (error.originalError as { level?: string } | undefined)?.level
			: undefined;

	return (
		originalLevel === "client-authentication" ||
		/authentication failed|client-authentication|ssh key was not accepted|all configured authentication methods failed/i.test(
			detail,
		)
	);
};

const isMissingSwarmServiceError = (error: unknown) => {
	const detail = getErrorDetail(error) ?? "";
	return /no such service|service .* not found|not found/i.test(detail);
};

const serviceScaleError = (
	target: ServiceScaleTarget,
	code: ServiceScaleErrorCode,
	message: string,
	guidance: string,
	error?: unknown,
) =>
	new ServiceScaleError(message, {
		code,
		appName: target.appName,
		serverId: target.serverId,
		serverName: target.serverName,
		serverHost: target.serverHost,
		guidance,
		detail: getErrorDetail(error),
		cause: error,
	});

export const preflightRemoteServiceScale = async (
	serverId: string,
	appName: string,
): Promise<ServiceScaleTarget> => {
	let target: ServiceScaleTarget = { appName, serverId };

	try {
		const server = await findServerById(serverId);
		target = {
			appName,
			serverId,
			serverName: server.name,
			serverHost: `${server.ipAddress}:${server.port}`,
		};

		if (!server.sshKeyId || !server.sshKey?.privateKey) {
			throw serviceScaleError(
				target,
				"server_missing_ssh_key",
				`Server "${server.name}" is selected for service "${appName}", but it has no SSH key attached.`,
				"Attach an SSH key to this server, then try again.",
			);
		}
	} catch (error) {
		if (error instanceof ServiceScaleError) throw error;
		throw serviceScaleError(
			target,
			"remote_docker_unreachable",
			`Nearzero could not load the server for service "${appName}".`,
			"Confirm the application is assigned to an existing server.",
			error,
		);
	}

	try {
		await execAsyncRemote(
			serverId,
			"docker info --format '{{json .ServerVersion}}'",
		);
	} catch (error) {
		if (isSshAuthError(error)) {
			throw serviceScaleError(
				target,
				"ssh_auth_failed",
				`Nearzero could not authenticate to the server for service "${appName}".`,
				"Verify the server SSH key is installed in authorized_keys and matches the key configured in Nearzero.",
				error,
			);
		}
		throw serviceScaleError(
			target,
			"remote_docker_unreachable",
			`Nearzero connected to the server, but Docker is not reachable for service "${appName}".`,
			"Make sure Docker is installed, running, and accessible to the configured SSH user.",
			error,
		);
	}

	try {
		await execAsyncRemote(
			serverId,
			`docker service inspect ${quote([appName])} --format '{{.ID}}'`,
		);
	} catch (error) {
		if (isSshAuthError(error)) {
			throw serviceScaleError(
				target,
				"ssh_auth_failed",
				`Nearzero could not authenticate to the server for service "${appName}".`,
				"Verify the server SSH key is installed in authorized_keys and matches the key configured in Nearzero.",
				error,
			);
		}
		if (isMissingSwarmServiceError(error)) {
			throw serviceScaleError(
				target,
				"swarm_service_missing",
				`Docker service "${appName}" was not found on the server.`,
				"Deploy or redeploy this application before trying to start or stop it.",
				error,
			);
		}
		throw serviceScaleError(
			target,
			"remote_docker_unreachable",
			`Nearzero could not inspect Docker service "${appName}" on the server.`,
			"Check Docker Swarm status on the server, then try again.",
			error,
		);
	}

	return target;
};

export const preflightLocalServiceScale = async (
	appName: string,
): Promise<ServiceScaleTarget> => {
	const target: ServiceScaleTarget = {
		appName,
		serverId: null,
		serverName: "local Docker",
	};

	let dockerClient: Awaited<ReturnType<typeof getRemoteDocker>>;
	try {
		dockerClient = await getRemoteDocker(null);
		const info = await dockerClient.info();
		const swarmState = info.Swarm?.LocalNodeState?.toLowerCase();
		if (swarmState !== "active") {
			throw new Error(
				`Docker Swarm is ${swarmState || "not active"} on the local Docker engine`,
			);
		}
	} catch (error) {
		throw serviceScaleError(
			target,
			"local_docker_unreachable",
			`Nearzero could not reach the local Docker engine for service "${appName}".`,
			"Make sure Docker Desktop is running, the Docker socket is healthy, and Docker Swarm is active, then try again.",
			error,
		);
	}

	try {
		const inspect = await dockerClient.getService(appName).inspect();
		if (inspect.Spec?.Mode?.Global) {
			throw serviceScaleError(
				target,
				"local_service_scale_failed",
				`Service "${appName}" uses global mode and cannot be scaled by replica count.`,
				"Global-mode services run on every Swarm node and cannot be started or stopped with start/stop controls.",
			);
		}
	} catch (error) {
		if (error instanceof ServiceScaleError) throw error;
		if (isMissingSwarmServiceError(error)) {
			throw serviceScaleError(
				target,
				"swarm_service_missing",
				`Docker service "${appName}" was not found in local Docker Swarm.`,
				"Deploy or redeploy this service before trying to start or stop it.",
				error,
			);
		}
		throw serviceScaleError(
			target,
			"local_docker_unreachable",
			`Nearzero could not inspect Docker service "${appName}" in local Docker Swarm.`,
			"Check Docker Desktop and Docker Swarm state, then try again.",
			error,
		);
	}

	return target;
};

export const swarmServiceExists = async (
	appName: string,
	serverId?: string | null,
): Promise<boolean> => {
	try {
		if (serverId) {
			await preflightRemoteServiceScale(serverId, appName);
		} else {
			await preflightLocalServiceScale(appName);
		}
		return true;
	} catch (error) {
		if (
			error instanceof ServiceScaleError &&
			error.code === "swarm_service_missing"
		) {
			return false;
		}
		throw error;
	}
};

const inspectSwarmService = async (
	appName: string,
	serverId?: string | null,
) => {
	const dockerClient = await getRemoteDocker(serverId);
	const service = dockerClient.getService(appName);
	return {
		dockerClient,
		service,
		inspect: await service.inspect(),
	};
};

const isDockerTransportDrop = (error: unknown) =>
	/socket hang up|ECONNRESET|connection reset|socket closed/i.test(
		getErrorDetail(error) ?? "",
	);

// Docker Swarm can reject a partial ServiceSpec update with a 400
// "mismatched Runtime and *Spec fields" error. The `docker service scale`
// CLI command merges the spec correctly, so we use it as a fallback.
const isServiceSpecMismatch = (error: unknown) =>
	/mismatched Runtime and \*Spec fields/i.test(getErrorDetail(error) ?? "");

const scaleServiceReplicasWithCli = async (
	appName: string,
	replicas: number,
	serverId?: string | null,
) => {
	const command = `docker service scale ${quote([`${appName}=${replicas}`])}`;
	if (serverId) {
		await execAsyncRemote(serverId, command);
		return;
	}
	await execAsync(command);
};

// Docker Engine 29.x can reject BOTH the Dockerode spec update AND
// `docker service scale` with "mismatched Runtime and *Spec fields".
// `docker service update --replicas` (with --force) rebuilds the spec
// server-side and merges the replica change cleanly, so it is the most
// reliable fallback for scaling on newer engines.
const updateServiceReplicasWithCli = async (
	appName: string,
	replicas: number,
	serverId?: string | null,
) => {
	const command = `docker service update --detach --force --replicas ${quote([String(replicas), appName])}`;
	if (serverId) {
		await execAsyncRemote(serverId, command);
		return;
	}
	await execAsync(command);
};

/**
 * Scale a swarm service by replica count via Dockerode first, then retry via
 * the Docker CLI if Dockerode drops the transport during the scale operation.
 */
export const scaleServiceReplicas = async (
	appName: string,
	replicas: number,
	serverId?: string | null,
): Promise<void> => {
	const target = serverId
		? await preflightRemoteServiceScale(serverId, appName)
		: await preflightLocalServiceScale(appName);

	try {
		const { service, inspect } = await inspectSwarmService(appName, serverId);
		const version = Number.parseInt(inspect.Version.Index, 10);
		const currentSpec = inspect.Spec ?? {};
		const mode = currentSpec.Mode;

		if (mode?.Global) {
			throw new Error(
				`Service "${appName}" uses global mode and cannot be scaled to ${replicas} replicas`,
			);
		}

		// Docker Swarm requires the COMPLETE ServiceSpec on update. Sending only
		// { version, Mode } produces a "mismatched Runtime and *Spec fields"
		// error because the TaskTemplate (and its Runtime) is dropped. We spread
		// the existing spec and override only the replica count so the rest of
		// the service definition is preserved exactly as-is.
		await service.update({
			version,
			...currentSpec,
			Mode: {
				...mode,
				Replicated: {
					...(mode?.Replicated ?? {}),
					Replicas: replicas,
				},
			},
		});
	} catch (error) {
		if (error instanceof ServiceScaleError) throw error;
		let scaleError = error;
		if (isDockerTransportDrop(error) || isServiceSpecMismatch(error)) {
			try {
				await scaleServiceReplicasWithCli(appName, replicas, serverId);
				return;
			} catch (fallbackError) {
				scaleError = fallbackError;
				// Docker 29.x can reject `docker service scale` with the same
				// "mismatched Runtime and *Spec fields" error. As a final attempt,
				// use `docker service update --force --replicas`, which rebuilds the
				// spec server-side and avoids the mismatch.
				if (
					isServiceSpecMismatch(fallbackError) ||
					isDockerTransportDrop(fallbackError)
				) {
					try {
						await updateServiceReplicasWithCli(appName, replicas, serverId);
						return;
					} catch (updateError) {
						scaleError = updateError;
					}
				}
			}
		}
		const globalModeMessage =
			scaleError instanceof Error && /global mode/i.test(scaleError.message)
				? scaleError.message
				: null;
		if (target.serverId) {
			throw serviceScaleError(
				target,
				"remote_service_scale_failed",
				globalModeMessage
					? globalModeMessage
					: `Nearzero reached the server, but Docker could not scale service "${appName}".`,
				globalModeMessage
					? "Global-mode services run on every Swarm node and cannot be started or stopped by replica count."
					: "Check the service state on the server, then try again or redeploy the application.",
				scaleError,
			);
		}
		throw serviceScaleError(
			target,
			"local_service_scale_failed",
			globalModeMessage
				? globalModeMessage
				: `Nearzero reached local Docker, but Docker could not scale service "${appName}".`,
			globalModeMessage
				? "Global-mode services run on every Swarm node and cannot be started or stopped by replica count."
				: "Check the service state in local Docker Swarm, then try again or redeploy the service.",
			scaleError,
		);
	}
};

export const stopService = async (appName: string) => {
	await scaleServiceReplicas(appName, 0, null);
};

export const stopServiceRemote = async (serverId: string, appName: string) => {
	await scaleServiceReplicas(appName, 0, serverId);
};

export const getContainerByName = (name: string): Promise<ContainerInfo> => {
	const opts = {
		limit: 1,
		filters: {
			name: [name],
		},
	};
	return new Promise((resolve, reject) => {
		getDocker().listContainers(opts, (err, containers) => {
			if (err) {
				reject(err);
			} else if (containers?.length === 0) {
				reject(new Error(`No container found with name: ${name}`));
			} else if (containers && containers?.length > 0 && containers[0]) {
				resolve(containers[0]);
			}
		});
	});
};

/**
 * Docker commands sent using this method are held in a hold when Docker is busy.
 *
 * https://github.com/Nearzero-systems/nearzero/pull/3064
 */
export const dockerSafeExec = (exec: string) => `
CHECK_INTERVAL=10

echo "Preparing for execution..."

while true; do
    PROCESSES=$(ps aux | grep -E "^.*docker [A-Za-z]" | grep -v grep)

    if [ -z "$PROCESSES" ]; then
        echo "Docker is idle. Starting execution..."
        break
    else
        echo "Docker is busy. Will check again in $CHECK_INTERVAL seconds..."
        sleep $CHECK_INTERVAL
    fi
done

${exec}

echo "Execution completed."
`;

const cleanupCommands = {
	containers: "docker container prune --force",
	images: "docker image prune --all --force",
	volumes: "docker volume prune --all --force",
	builders: "docker builder prune --all --force",
	system: "docker system prune --all --force",
};

export const cleanupContainers = async (serverId?: string) => {
	try {
		const command = cleanupCommands.containers;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupImages = async (serverId?: string) => {
	try {
		const command = cleanupCommands.images;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else await execAsync(dockerSafeExec(command));
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupVolumes = async (serverId?: string) => {
	try {
		const command = cleanupCommands.volumes;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupBuilders = async (serverId?: string) => {
	try {
		const command = cleanupCommands.builders;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export const cleanupSystem = async (serverId?: string) => {
	try {
		const command = cleanupCommands.system;

		if (serverId) {
			await execAsyncRemote(serverId, dockerSafeExec(command));
		} else {
			await execAsync(dockerSafeExec(command));
		}
	} catch (error) {
		console.error(error);

		throw error;
	}
};

export interface DockerDiskUsageItem {
	type: string;
	totalCount: number;
	active: number;
	size: string;
	reclaimable: string;
	sizeBytes: number;
}

const parseSizeToBytes = (size: string): number => {
	const match = size.match(/^([\d.]+)\s*([KMGT]?B)$/i);
	if (!match) return 0;
	const value = Number.parseFloat(match[1] as string);
	const unit = (match[2] as string).toUpperCase();
	const multipliers: Record<string, number> = {
		B: 1,
		KB: 1024,
		MB: 1024 ** 2,
		GB: 1024 ** 3,
		TB: 1024 ** 4,
	};
	return value * (multipliers[unit] || 0);
};

export const getDockerDiskUsage = async (): Promise<DockerDiskUsageItem[]> => {
	const command = "docker system df --format '{{json .}}'";
	const { stdout } = await execAsync(command);

	const lines = stdout.trim().split("\n").filter(Boolean);
	return lines.map((line) => {
		const data = JSON.parse(line);
		return {
			type: data.Type,
			totalCount: Number.parseInt(data.TotalCount, 10) || 0,
			active: Number.parseInt(data.Active, 10) || 0,
			size: data.Size,
			reclaimable: data.Reclaimable,
			sizeBytes: parseSizeToBytes(data.Size),
		};
	});
};

/**
 * Volume cleanup should always be performed manually by the user. The reason is that during automatic cleanup, a volume may be deleted due to a stopped container, which is a dangerous situation.
 *
 * https://github.com/Nearzero-systems/nearzero/pull/3267
 */
const excludedCleanupAllCommands: (keyof typeof cleanupCommands)[] = [
	"volumes",
];

export const cleanupAll = async (serverId?: string) => {
	for (const [key, command] of Object.entries(cleanupCommands) as [
		keyof typeof cleanupCommands,
		string,
	][]) {
		if (excludedCleanupAllCommands.includes(key)) continue;

		try {
			if (serverId) {
				await execAsyncRemote(serverId, dockerSafeExec(command));
			} else {
				await execAsync(dockerSafeExec(command));
			}
		} catch {}
	}
};

export const cleanupAllBackground = async (serverId?: string) => {
	Promise.allSettled(
		(
			Object.entries(cleanupCommands) as [
				keyof typeof cleanupCommands,
				string,
			][]
		)
			.filter(([key]) => !excludedCleanupAllCommands.includes(key))
			.map(async ([, command]) => {
				if (serverId) {
					await execAsyncRemote(serverId, dockerSafeExec(command));
				} else {
					await execAsync(dockerSafeExec(command));
				}
			}),
	)
		.then((results) => {
			const failed = results.filter((r) => r.status === "rejected");
			if (failed.length > 0) {
				console.error(`Docker cleanup: ${failed.length} operations failed`);
			} else {
				console.log("Docker cleanup completed successfully");
			}
		})
		.catch((error) => console.error("Error in cleanup:", error));

	return {
		status: "scheduled",
		message: "Docker cleanup has been initiated in the background",
	};
};

export const startService = async (appName: string, replicas = 1) => {
	await scaleServiceReplicas(appName, replicas, null);
};

export const startServiceRemote = async (
	serverId: string,
	appName: string,
	replicas = 1,
) => {
	await scaleServiceReplicas(appName, replicas, serverId);
};

export const removeService = async (
	appName: string,
	serverId?: string | null,
	_deleteVolumes = false,
	_deleteImages = false,
) => {
	if (!appName) return;

	try {
		const command = `
SERVICE_NAME=${quote([appName])}
DELETE_VOLUMES=${_deleteVolumes ? "1" : "0"}
DELETE_IMAGES=${_deleteImages ? "1" : "0"}
SERVICE_IMAGE=$(docker service inspect "$SERVICE_NAME" --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}' 2>/dev/null | sed 's/@sha256:.*//' || true)
SERVICE_VOLUMES=$(docker service inspect "$SERVICE_NAME" --format '{{range .Spec.TaskTemplate.ContainerSpec.Mounts}}{{if eq .Type "volume"}}{{.Source}}{{"\\n"}}{{end}}{{end}}' 2>/dev/null || true)

docker service rm "$SERVICE_NAME" >/dev/null 2>&1 || true

for attempt in 1 2 3 4 5; do
	if docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
		sleep 1
	else
		break
	fi
done

if docker service inspect "$SERVICE_NAME" >/dev/null 2>&1; then
	printf 'Docker service %s still exists after removal timeout\n' "$SERVICE_NAME" >&2
	exit 1
fi

if [ "$DELETE_VOLUMES" = "1" ]; then
	printf '%s\n' "$SERVICE_VOLUMES" | while IFS= read -r volume_name; do
		if [ -n "$volume_name" ]; then
			docker volume rm -f "$volume_name" >/dev/null 2>&1 || true
		fi
	done
fi

if [ "$DELETE_IMAGES" = "1" ] && [ -n "$SERVICE_IMAGE" ]; then
	docker image rm -f "$SERVICE_IMAGE" >/dev/null 2>&1 || true
fi

true`;

		if (serverId) {
			await execAsyncRemote(serverId, command);
		} else {
			await execAsync(command);
		}
	} catch (error) {
		// This catches transport failures and the explicit post-removal verification
		// above. Callers deleting parent records must treat the returned error as a
		// fail-closed result so a running service never becomes untracked.
		console.error(
			`[removeService] failed to remove service "${appName}" on serverId="${
				serverId ?? "local"
			}":`,
			error,
		);
		return error;
	}
};

const sleepMs = (ms: number) =>
	new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_SERVICE_STABILITY_TIMEOUT_MS = 30_000;
const DEFAULT_SERVICE_STABILITY_POLL_MS = 2_000;
const DEFAULT_SERVICE_STABILITY_STABLE_MS = 10_000;

export class SwarmServiceStabilityError extends Error {
	constructor(message: string, readonly diagnostics: string) {
		super(diagnostics ? `${message}\n\n${diagnostics}` : message);
		this.name = "SwarmServiceStabilityError";
	}
}

const getTaskTimestamp = (task: any) =>
	new Date(task?.Status?.Timestamp ?? task?.UpdatedAt ?? task?.CreatedAt ?? 0)
		.getTime();

const summarizeSwarmTasks = (tasks: any[]) => {
	if (!tasks.length) return "No Swarm tasks were created for this service.";

	return tasks
		.slice()
		.sort((a, b) => getTaskTimestamp(b) - getTaskTimestamp(a))
		.slice(0, 8)
		.map((task) => {
			const state = task?.Status?.State ?? "unknown";
			const desired = task?.DesiredState ?? "unknown";
			const error = task?.Status?.Err ? ` error="${task.Status.Err}"` : "";
			const message =
				task?.Status?.Message ? ` message="${task.Status.Message}"` : "";
			const container =
				task?.Status?.ContainerStatus?.ContainerID ?
					` container=${String(task.Status.ContainerStatus.ContainerID).slice(0, 12)}`
				:	"";
			return `- ${task?.Name ?? task?.ID ?? "task"} desired=${desired} state=${state}${container}${error}${message}`;
		})
		.join("\n");
};

const collectLatestTaskLogs = async (dockerClient: any, tasks: any[]) => {
	const taskWithContainer = tasks
		.slice()
		.sort((a, b) => getTaskTimestamp(b) - getTaskTimestamp(a))
		.find((task) => task?.Status?.ContainerStatus?.ContainerID);
	const containerId = taskWithContainer?.Status?.ContainerStatus?.ContainerID;
	if (!containerId) return "";

	try {
		const logs = await dockerClient.getContainer(containerId).logs({
			stdout: true,
			stderr: true,
			tail: 80,
			timestamps: false,
		});
		const text = Buffer.isBuffer(logs) ? logs.toString("utf8") : String(logs);
		const cleaned = text.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, "").trim();
		return cleaned ? `\n\nLatest container logs:\n${cleaned.slice(-4000)}` : "";
	} catch {
		return "";
	}
};

export const assertSwarmServiceStable = async (
	appName: string,
	serverId?: string | null,
	options: {
		replicas?: number | null;
		timeoutMs?: number;
		pollMs?: number;
		stableMs?: number;
		dockerClient?: Awaited<ReturnType<typeof getRemoteDocker>>;
		onProgress?: (progress: SwarmServiceProgress) => void | Promise<void>;
	} = {},
) => {
	const timeoutMs = options.timeoutMs ?? DEFAULT_SERVICE_STABILITY_TIMEOUT_MS;
	const pollMs = options.pollMs ?? DEFAULT_SERVICE_STABILITY_POLL_MS;
	const stableMs = options.stableMs ?? DEFAULT_SERVICE_STABILITY_STABLE_MS;
	const startedAt = Date.now();
	let runningSince = 0;
	let lastTasks: any[] = [];
	let lastProgressKey = "";
	let dockerClient = options.dockerClient ?? null;

	const reportProgress = async (progress: SwarmServiceProgress) => {
		if (!options.onProgress) return;
		await options.onProgress(progress);
	};

	while (Date.now() - startedAt < timeoutMs) {
		dockerClient ??= await getRemoteDocker(serverId);
		const service = dockerClient.getService(appName);
		const inspect = await service.inspect();
		const fallbackReplicas =
			inspect.Spec?.Mode?.Replicated?.Replicas ??
			(inspect.Spec?.Mode?.Global ? 1 : 1);
		const replicas = options.replicas ?? fallbackReplicas;

		if (!replicas || replicas <= 0) return;

		lastTasks = await dockerClient.listTasks({
			filters: JSON.stringify({
				service: [appName],
			}),
		});

		const desiredRunningTasks = lastTasks.filter(
			(task) =>
				String(task?.DesiredState ?? "").toLowerCase() === "running",
		);
		const runningTasks = desiredRunningTasks.filter(
			(task) => String(task?.Status?.State ?? "").toLowerCase() === "running",
		);
		const progressKey = `${runningTasks.length}/${replicas}:${lastTasks
			.map((task) => String(task?.Status?.State ?? "unknown").toLowerCase())
			.sort()
			.join(",")}`;
		if (progressKey !== lastProgressKey) {
			lastProgressKey = progressKey;
			await reportProgress({
				stage: "wait",
				message:
					runningTasks.length >= replicas
						? `Swarm task is running; verifying stability (${runningTasks.length}/${replicas}).`
						: `Waiting for Swarm task (${runningTasks.length}/${replicas} running).`,
			});
		}

		if (runningTasks.length >= replicas) {
			runningSince = runningSince || Date.now();
			if (Date.now() - runningSince >= stableMs) {
				await reportProgress({
					stage: "stable",
					message: `Swarm service is stable (${runningTasks.length}/${replicas} running).`,
				});
				return;
			}
		} else {
			runningSince = 0;
		}

		const failedAttempts = lastTasks.filter((task) =>
			["failed", "rejected"].includes(
				String(task?.Status?.State ?? "").toLowerCase(),
			),
		);
		if (
			failedAttempts.length >= Math.max(3, replicas * 2) &&
			Date.now() - startedAt >= stableMs
		) {
			break;
		}

		await sleepMs(pollMs);
	}

	const diagnostics =
		`Recent Swarm task states:\n${summarizeSwarmTasks(lastTasks)}` +
		(dockerClient ? await collectLatestTaskLogs(dockerClient, lastTasks) : "");

	throw new SwarmServiceStabilityError(
		`Docker service "${appName}" did not become stable after deployment.`,
		diagnostics,
	);
};

export type SwarmServiceProgress = {
	stage: "inspect" | "create" | "update" | "wait" | "stable" | "firewall";
	message: string;
};

export const upsertSwarmService = async ({
	dockerClient,
	settings,
	serverId,
	appName = settings.Name,
	replicas,
	removeCreatedServiceOnFailure = true,
	stabilityOptions,
	onProgress,
}: {
	dockerClient: Awaited<ReturnType<typeof getRemoteDocker>>;
	settings: any;
	serverId?: string | null;
	appName?: string;
	replicas?: number | null;
	removeCreatedServiceOnFailure?: boolean;
	stabilityOptions?: {
		timeoutMs?: number;
		pollMs?: number;
		stableMs?: number;
	};
	onProgress?: (progress: SwarmServiceProgress) => void | Promise<void>;
}) => {
	if (!appName) {
		throw new Error("Cannot create Docker service without a service name");
	}

	const reportProgress = async (progress: SwarmServiceProgress) => {
		if (!onProgress) return;
		await onProgress(progress);
	};

	let createdService = false;

	await reportProgress({
		stage: "inspect",
		message: "Inspecting the remote Swarm service.",
	});
	const service = dockerClient.getService(appName);
	let inspect: any | null = null;
	try {
		inspect = await service.inspect();
	} catch {
		inspect = null;
	}

	if (inspect) {
		await reportProgress({
			stage: "update",
			message: "Updating the existing remote Swarm service.",
		});
		await service.update({
			version: Number.parseInt(inspect.Version.Index, 10),
			...settings,
			TaskTemplate: {
				...settings.TaskTemplate,
				ForceUpdate: (inspect.Spec?.TaskTemplate?.ForceUpdate ?? 0) + 1,
			},
		});
	} else {
		await reportProgress({
			stage: "create",
			message: "Creating the remote Swarm service.",
		});
		await dockerClient.createService(settings);
		createdService = true;
	}

	try {
		await assertSwarmServiceStable(appName, serverId, {
			replicas,
			dockerClient,
			onProgress,
			...stabilityOptions,
		});
	} catch (error) {
		if (createdService && removeCreatedServiceOnFailure) {
			await removeService(appName, serverId);
		}
		throw error;
	}

	if (serverId) {
		const publishedPorts = normalizePublishedPortSpecs(
			settings.EndpointSpec?.Ports,
		);
		if (publishedPorts.length > 0) {
			const formattedPorts = formatPublishedPortSpecs(publishedPorts);
			await reportProgress({
				stage: "firewall",
				message: `Configuring remote firewall for published ports: ${formattedPorts}.`,
			});
			try {
				const result = await openPublishedPortsOnRemoteServer({
					serverId,
					ports: settings.EndpointSpec?.Ports,
				});
				const output = [result.stdout, result.stderr]
					.filter(Boolean)
					.join("\n")
					.trim();
				await reportProgress({
					stage: "firewall",
					message:
						output ||
						`Remote firewall checked for published ports: ${formattedPorts}.`,
				});
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error);
				await reportProgress({
					stage: "firewall",
					message: `Could not automatically configure the remote firewall for ${formattedPorts}. Allow these ports on the server/cloud firewall. ${detail}`,
				});
			}
		}
	}
};

export const prepareEnvironmentVariables = (
	serviceEnv: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
) => {
	const projectVars = parse(projectEnv ?? "");
	const environmentVars = parse(environmentEnv ?? "");
	const serviceVars = parse(serviceEnv ?? "");

	const resolvedVars = Object.entries(serviceVars).map(([key, value]) => {
		let resolvedValue = value;

		// Replace project variables
		if (projectVars) {
			resolvedValue = resolvedValue.replace(
				/\$\{\{project\.(.*?)\}\}/g,
				(_, ref) => {
					if (projectVars[ref] !== undefined) {
						return projectVars[ref];
					}
					throw new Error(
						`Invalid project environment variable: project.${ref}`,
					);
				},
			);
		}

		// Replace environment variables
		if (environmentVars) {
			resolvedValue = resolvedValue.replace(
				/\$\{\{environment\.(.*?)\}\}/g,
				(_, ref) => {
					if (environmentVars[ref] !== undefined) {
						return environmentVars[ref];
					}
					throw new Error(`Invalid environment variable: environment.${ref}`);
				},
			);
		}

		// Replace self-references (service variables)
		resolvedValue = resolvedValue.replace(/\$\{\{(.*?)\}\}/g, (_, ref) => {
			if (serviceVars[ref] !== undefined) {
				return serviceVars[ref];
			}
			throw new Error(`Invalid service environment variable: ${ref}`);
		});

		return `${key}=${resolvedValue}`;
	});

	return resolvedVars;
};

export const prepareEnvironmentVariablesForShell = (
	serviceEnv: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
): string[] => {
	const envVars = prepareEnvironmentVariables(
		serviceEnv,
		projectEnv,
		environmentEnv,
	);
	// Using shell-quote library to properly escape shell arguments
	// This is the standard way to handle special characters in shell commands
	return envVars.map((env) => quote([env]));
};

export const parseEnvironmentKeyValuePair = (
	pair: string,
): [string, string] => {
	const [key, ...valueParts] = pair.split("=");
	if (!key || !valueParts.length) {
		throw new Error(`Invalid environment variable pair: ${pair}`);
	}

	return [key, valueParts.join("=")];
};

export const getEnvironmentVariablesObject = (
	input: string | null,
	projectEnv?: string | null,
	environmentEnv?: string | null,
) => {
	const envs = prepareEnvironmentVariables(input, projectEnv, environmentEnv);

	const jsonObject: Record<string, string> = {};

	for (const pair of envs) {
		const [key, value] = parseEnvironmentKeyValuePair(pair);
		if (key && value) {
			jsonObject[key] = value;
		}
	}

	return jsonObject;
};

export const generateVolumeMounts = (mounts: ApplicationNested["mounts"]) => {
	if (!mounts || mounts.length === 0) {
		return [];
	}

	return mounts
		.filter((mount) => mount.type === "volume")
		.map((mount) => ({
			Type: "volume" as const,
			Source: mount.volumeName || "",
			Target: mount.mountPath,
		}));
};

type Resources = {
	memoryLimit: string | null;
	memoryReservation: string | null;
	cpuLimit: string | null;
	cpuReservation: string | null;
};
export const calculateResources = ({
	memoryLimit,
	memoryReservation,
	cpuLimit,
	cpuReservation,
}: Resources): ResourceRequirements => {
	return {
		Limits: {
			MemoryBytes: memoryLimit ? Number.parseInt(memoryLimit) : undefined,
			NanoCPUs: cpuLimit ? Number.parseInt(cpuLimit) : undefined,
		},
		Reservations: {
			MemoryBytes: memoryReservation
				? Number.parseInt(memoryReservation)
				: undefined,
			NanoCPUs: cpuReservation ? Number.parseInt(cpuReservation) : undefined,
		},
	};
};

export const generateConfigContainer = (
	application: Partial<ApplicationNested>,
) => {
	const {
		healthCheckSwarm,
		restartPolicySwarm,
		placementSwarm,
		updateConfigSwarm,
		rollbackConfigSwarm,
		modeSwarm,
		labelsSwarm,
		replicas,
		mounts,
		networkSwarm,
		stopGracePeriodSwarm,
		endpointSpecSwarm,
		ulimitsSwarm,
	} = application;

	const haveMounts = mounts && mounts.length > 0;
	const networks =
		networkSwarm && networkSwarm.length > 0
			? networkSwarm.some((network) => network.Target === "nearzero-network")
				? networkSwarm
				: [...networkSwarm, { Target: "nearzero-network" }]
			: [{ Target: "nearzero-network" }];

	return {
		...(healthCheckSwarm && {
			HealthCheck: healthCheckSwarm,
		}),
		...(restartPolicySwarm && {
			RestartPolicy: restartPolicySwarm,
		}),
		...(!restartPolicySwarm && {
			// Swarm's implicit default is unlimited "any" restarts. That hides bad
			// images behind endless task churn, so Nearzero retries failed tasks a
			// few times and then lets deployment stabilization surface the error.
			RestartPolicy: {
				Condition: "on-failure",
				Delay: 5_000_000_000,
				MaxAttempts: 3,
				Window: 120_000_000_000,
			},
		}),
		...(placementSwarm
			? {
					Placement: placementSwarm,
				}
			: {
					// if app have mounts keep manager as constraint
					Placement: {
						Constraints: haveMounts ? ["node.role==manager"] : [],
					},
				}),
		...(labelsSwarm && {
			Labels: labelsSwarm,
		}),
		...(modeSwarm
			? {
					Mode: modeSwarm,
				}
			: {
					// use replicas value if no modeSwarm provided
					Mode: {
						Replicated: {
							Replicas: replicas,
						},
					},
				}),
		...(rollbackConfigSwarm
			? { RollbackConfig: rollbackConfigSwarm }
			: {
					// default rollback config to match update config
					RollbackConfig: {
						Parallelism: 1,
						Order: "stop-first",
					},
				}),
		...(updateConfigSwarm
			? { UpdateConfig: updateConfigSwarm }
			: {
					// Stop-first avoids start-first collisions on host ports and
					// stateful volumes; user-supplied swarm config still wins.
					UpdateConfig: {
						Parallelism: 1,
						Order: "stop-first",
						FailureAction: "rollback",
					},
				}),
		...(stopGracePeriodSwarm !== null &&
			stopGracePeriodSwarm !== undefined && {
				StopGracePeriod: stopGracePeriodSwarm,
			}),
		Networks: networks,
		...(endpointSpecSwarm && {
			EndpointSpec: {
				...(endpointSpecSwarm.Mode && { Mode: endpointSpecSwarm.Mode }),
				Ports:
					endpointSpecSwarm.Ports?.map((port) => ({
						Protocol: (port.Protocol || "tcp") as "tcp" | "udp" | "sctp",
						TargetPort: port.TargetPort || 0,
						PublishedPort: port.PublishedPort || 0,
						PublishMode: (port.PublishMode || "host") as "ingress" | "host",
					})) || [],
			},
		}),
		...(ulimitsSwarm &&
			ulimitsSwarm.length > 0 && {
				Ulimits: ulimitsSwarm,
			}),
	};
};

export const generateBindMounts = (mounts: ApplicationNested["mounts"]) => {
	if (!mounts || mounts.length === 0) {
		return [];
	}

	return mounts
		.filter((mount) => mount.type === "bind")
		.map((mount) => ({
			Type: "bind" as const,
			Source: mount.hostPath || "",
			Target: mount.mountPath,
		}));
};

export const generateFileMounts = (
	appName: string,
	service:
		| ApplicationNested
		| LibsqlNested
		| MongoNested
		| MariadbNested
		| MysqlNested
		| PostgresNested
		| RedisNested,
) => {
	const { mounts } = service;
	const { APPLICATIONS_PATH } = paths(!!service.serverId);
	if (!mounts || mounts.length === 0) {
		return [];
	}

	return mounts
		.filter((mount) => mount.type === "file")
		.map((mount) => {
			const fileName = mount.filePath;
			const absoluteBasePath = path.resolve(APPLICATIONS_PATH);
			const directory = path.join(absoluteBasePath, appName, "files");
			const sourcePath = path.join(directory, fileName || "");
			return {
				Type: "bind" as const,
				Source: sourcePath,
				Target: mount.mountPath,
			};
		});
};

export const createFile = async (
	outputPath: string,
	filePath: string,
	content: string,
) => {
	try {
		const fullPath = path.join(outputPath, filePath);
		if (fullPath.endsWith(path.sep) || filePath.endsWith("/")) {
			fs.mkdirSync(fullPath, { recursive: true });
			return;
		}

		const directory = path.dirname(fullPath);
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(fullPath, content || "");
	} catch (error) {
		throw error;
	}
};
export const encodeBase64 = (content: string) =>
	Buffer.from(content, "utf-8").toString("base64");

export const getCreateFileCommand = (
	outputPath: string,
	filePath: string,
	content: string,
) => {
	const fullPath = path.join(outputPath, filePath);
	if (fullPath.endsWith(path.sep) || filePath.endsWith("/")) {
		return `mkdir -p ${fullPath};`;
	}

	const directory = path.dirname(fullPath);
	const encodedContent = encodeBase64(content);
	return `
		mkdir -p ${directory};
		echo "${encodedContent}" | base64 -d > "${fullPath}";
	`;
};

export const getServiceContainer = async (
	appName: string,
	serverId?: string | null,
) => {
	try {
		const filter = {
			status: ["running"],
			label: [`com.docker.swarm.service.name=${appName}`],
		};
		const remoteDocker = await getRemoteDocker(serverId);
		const containers = await remoteDocker.listContainers({
			filters: JSON.stringify(filter),
		});

		if (containers.length === 0 || !containers[0]) {
			return null;
		}

		const container = containers[0];

		return container;
	} catch (error) {
		throw error;
	}
};

export const getComposeContainer = async (
	compose: Compose,
	serviceName: string,
) => {
	try {
		const { appName, composeType, serverId } = compose;
		// 1. Determine the correct labels based on composeType
		const labels: string[] = [];
		if (composeType === "stack") {
			// Labels for Docker Swarm stack services
			labels.push(`com.docker.stack.namespace=${appName}`);
			labels.push(`com.docker.swarm.service.name=${appName}_${serviceName}`);
		} else {
			// Labels for Docker Compose projects (default)
			labels.push(`com.docker.compose.project=${appName}`);
			labels.push(`com.docker.compose.service=${serviceName}`);
		}
		const filter = {
			status: ["running"],
			label: labels,
		};

		const remoteDocker = await getRemoteDocker(serverId);
		const containers = await remoteDocker.listContainers({
			filters: JSON.stringify(filter),
			limit: 1,
		});

		if (containers.length === 0 || !containers[0]) {
			return null;
		}

		const container = containers[0];
		return container;
	} catch (error) {
		throw error;
	}
};

type ServiceHealthStatus = {
	status: "healthy" | "unhealthy";
	message?: string;
};

const checkSwarmServiceRunning = async (
	serviceName: string,
): Promise<ServiceHealthStatus> => {
	try {
		const service = getDocker().getService(serviceName);
		const info = await service.inspect();
		const replicas = info.Spec?.Mode?.Replicated?.Replicas ?? 0;
		if (replicas === 0) {
			return {
				status: "unhealthy",
				message: "Service has 0 replicas configured",
			};
		}

		// Check that at least one task is actually running
		const tasks = await getDocker().listTasks({
			filters: JSON.stringify({
				service: [serviceName],
				"desired-state": ["running"],
			}),
		});

		const runningTask = tasks.find((t) => t.Status?.State === "running");

		if (!runningTask) {
			const latestTask = tasks[0];
			const taskState = latestTask?.Status?.State ?? "unknown";
			return {
				status: "unhealthy",
				message: `No running tasks (current state: ${taskState})`,
			};
		}

		return { status: "healthy" };
	} catch (error) {
		return {
			status: "unhealthy",
			message: error instanceof Error ? error.message : "Service not found",
		};
	}
};

const getSwarmServiceContainerId = async (
	serviceName: string,
): Promise<string | null> => {
	try {
		const tasks = await getDocker().listTasks({
			filters: JSON.stringify({
				service: [serviceName],
				"desired-state": ["running"],
			}),
		});

		const runningTask = tasks.find((t) => t.Status?.State === "running");

		return runningTask?.Status?.ContainerStatus?.ContainerID ?? null;
	} catch {
		return null;
	}
};

export const checkPostgresHealth = async (): Promise<ServiceHealthStatus> => {
	const serviceCheck = await checkSwarmServiceRunning("nearzero-postgres");
	if (serviceCheck.status === "unhealthy") {
		return serviceCheck;
	}

	// Verify PostgreSQL actually accepts connections
	const containerId = await getSwarmServiceContainerId("nearzero-postgres");
	if (!containerId) {
		return { status: "unhealthy", message: "Could not find running container" };
	}

	try {
		const exec = await getDocker().getContainer(containerId).exec({
			Cmd: ["pg_isready", "-U", "nearzero"],
			AttachStdout: true,
			AttachStderr: true,
		});
		const stream = await exec.start({});

		const output = await new Promise<string>((resolve) => {
			let data = "";
			stream.on("data", (chunk: Buffer) => {
				data += chunk.toString();
			});
			stream.on("end", () => resolve(data));
		});

		const inspectResult = await exec.inspect();
		if (inspectResult.ExitCode !== 0) {
			return {
				status: "unhealthy",
				message: `PostgreSQL not ready: ${output.trim()}`,
			};
		}

		return { status: "healthy" };
	} catch (error) {
		return {
			status: "unhealthy",
			message:
				error instanceof Error ? error.message : "Failed to check PostgreSQL",
		};
	}
};

export const checkRedisHealth = async (): Promise<ServiceHealthStatus> => {
	const serviceCheck = await checkSwarmServiceRunning("nearzero-redis");
	if (serviceCheck.status === "unhealthy") {
		return serviceCheck;
	}

	// Verify Redis actually responds to PING
	const containerId = await getSwarmServiceContainerId("nearzero-redis");
	if (!containerId) {
		return { status: "unhealthy", message: "Could not find running container" };
	}

	try {
		const exec = await getDocker().getContainer(containerId).exec({
			Cmd: ["redis-cli", "ping"],
			AttachStdout: true,
			AttachStderr: true,
		});
		const stream = await exec.start({});

		const output = await new Promise<string>((resolve) => {
			let data = "";
			stream.on("data", (chunk: Buffer) => {
				data += chunk.toString();
			});
			stream.on("end", () => resolve(data));
		});

		if (!output.includes("PONG")) {
			return {
				status: "unhealthy",
				message: `Redis did not respond with PONG: ${output.trim()}`,
			};
		}

		return { status: "healthy" };
	} catch (error) {
		return {
			status: "unhealthy",
			message: error instanceof Error ? error.message : "Failed to check Redis",
		};
	}
};

export const checkTraefikHealth = async (): Promise<ServiceHealthStatus> => {
	// Traefik can run as a standalone container or a swarm service
	try {
		const container = getDocker().getContainer("nearzero-traefik");
		const info = await container.inspect();
		if (!info.State.Running) {
			return {
				status: "unhealthy",
				message: "Container is not running",
			};
		}
		return { status: "healthy" };
	} catch {
		// Not a standalone container, check as swarm service
		return checkSwarmServiceRunning("nearzero-traefik");
	}
};

/** Clears inherited env for compose runs while keeping registry auth config readable. */
export const dockerComposeEnvPrefix =
	'env -i PATH="$PATH" HOME="$HOME" DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"';
