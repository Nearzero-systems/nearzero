import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { getNearzeroUrl } from "@nearzero/server/services/admin";
import { sanitizePublicErrorMessage } from "@nearzero/server/services/operational-log";
import { findServerById } from "@nearzero/server/services/server";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "@nearzero/server/services/web-server-settings";
import type { ContainerCreateOptions } from "dockerode";
import { paths } from "../constants";
import { getNearzeroImageTag } from "../services/settings";
import { pullImage, pullRemoteImage } from "../utils/docker/utils";
import { execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";
import {
	TRAEFIK_CONTROL_NETWORK,
	TRAEFIK_DOCKER_ENDPOINT,
} from "./traefik-setup";

const MONITORING_CONTAINER_NAME = "nearzero-monitoring";

export const monitoringLoopbackPortConfig = (port: number) => {
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("Monitoring port must be an integer from 1 to 65535");
	}
	return {
		PortBindings: {
			[`${port}/tcp`]: [
				{
					HostIp: "127.0.0.1",
					HostPort: port.toString(),
				},
			],
		},
		ExposedPorts: {
			[`${port}/tcp`]: {},
		},
	};
};

export const isMonitoringDockerMetadataAllowed = () =>
	process.env.NEARZERO_ALLOW_MONITORING_DOCKER_METADATA?.trim().toLowerCase() ===
	"true";

export const monitoringDockerAccessConfig = (
	includeServices: readonly string[] = [],
) => {
	const enabled = includeServices.length > 0;
	if (enabled && !isMonitoringDockerMetadataAllowed()) {
		throw new Error(
			"Container monitoring is disabled because Docker's read-only CONTAINERS API can expose container metadata and environment variables. Set NEARZERO_ALLOW_MONITORING_DOCKER_METADATA=true only after accepting that exposure.",
		);
	}

	return {
		enabled,
		dockerHost: enabled ? TRAEFIK_DOCKER_ENDPOINT : undefined,
		networkingConfig: {
			EndpointsConfig: {
				"nearzero-network": {},
				...(enabled ? { [TRAEFIK_CONTROL_NETWORK]: {} } : {}),
			},
		},
	};
};

export const isExternallyManagedWebMonitoring = () =>
	Boolean(process.env.NEARZERO_METRICS_URL?.trim());

const monitoringErrorMessage = (error: unknown) => {
	return sanitizePublicErrorMessage(
		error instanceof Error ? error.message : error,
		"Monitoring operation failed",
	);
};

const warnMonitoringPullFailed = (imageName: string, error: unknown) => {
	const message = monitoringErrorMessage(error);
	console.warn(
		`Could not pull monitoring image ${imageName}${message ? `: ${message}` : ""}`,
	);
};

export const getMonitoringImageTag = () => {
	const explicitTag = process.env.NEARZERO_MONITORING_IMAGE_TAG?.trim();
	if (explicitTag) return explicitTag;
	if (process.env.RELEASE_TAG?.trim()) return getNearzeroImageTag().trim();
	return process.env.NODE_ENV === "development" ? "nightly" : "latest";
};

export const getMonitoringImageCandidates = () => {
	const explicitImage = process.env.NEARZERO_MONITORING_IMAGE?.trim();
	if (explicitImage) return [explicitImage];

	const tag = getMonitoringImageTag();
	return [`ghcr.io/nearzero-systems/monitoring:${tag}`];
};

const generateToken = () => {
	const array = new Uint8Array(64);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
};

const positiveNumberFromEnv = (key: string) => {
	const value = Number.parseInt(process.env[key]?.trim() || "", 10);
	return Number.isFinite(value) && value > 0 ? value : null;
};

// Deliberately leave HOST_PROC unset. Mounting the host's complete /proc tree
// would expose other processes' environments (and therefore application
// secrets) to the collector. gopsutil instead reads the container's /proc.
const HOST_METRICS_ENV = [
	"HOST_SYS=/host/sys",
	"NEARZERO_HOST_ROOT=/host/root",
];

const isWebMonitoringRunning = async () => {
	try {
		const docker = await getRemoteDocker();
		const info = await docker.getContainer(MONITORING_CONTAINER_NAME).inspect();
		return info.State.Running === true;
	} catch {
		return false;
	}
};

const getWebMonitoringContainerConfig = async () => {
	try {
		const docker = await getRemoteDocker();
		const info = await docker.getContainer(MONITORING_CONTAINER_NAME).inspect();
		const rawConfig = info.Config?.Env?.find((entry) =>
			entry.startsWith("METRICS_CONFIG="),
		)?.slice("METRICS_CONFIG=".length);
		if (!rawConfig) return null;
		const metricsConfig = JSON.parse(rawConfig) as {
			server?: {
				port?: number;
				token?: string;
				urlCallback?: string;
				cronJob?: string;
			};
			containers?: unknown;
		};
		return {
			...metricsConfig,
			dockerHost: info.Config?.Env?.find((entry) =>
				entry.startsWith("DOCKER_HOST="),
			)?.slice("DOCKER_HOST=".length),
			binds: info.HostConfig?.Binds ?? [],
			networkNames: Object.keys(info.NetworkSettings?.Networks ?? {}),
			portBindings: info.HostConfig?.PortBindings ?? {},
		};
	} catch {
		return null;
	}
};

const monitoringContainerMatchesConfig = async (
	metricsConfig: NonNullable<
		Awaited<ReturnType<typeof getWebServerSettings>>
	>["metricsConfig"],
) => {
	const containerConfig = await getWebMonitoringContainerConfig();
	if (!containerConfig) return false;
	const dockerAccess = monitoringDockerAccessConfig(
		metricsConfig.containers.services.include ?? [],
	);
	const portBindings = (containerConfig.portBindings?.[
		`${metricsConfig.server.port}/tcp`
	] ?? []) as Array<{ HostIp?: string; HostPort?: string }>;

	return (
		containerConfig.server?.token === metricsConfig.server.token &&
		Number(containerConfig.server?.port) ===
			Number(metricsConfig.server.port) &&
		containerConfig.server?.urlCallback === metricsConfig.server.urlCallback &&
		containerConfig.server?.cronJob === metricsConfig.server.cronJob &&
		JSON.stringify(containerConfig.containers ?? null) ===
			JSON.stringify(metricsConfig.containers ?? null) &&
		containerConfig.dockerHost === dockerAccess.dockerHost &&
		!containerConfig.binds?.some((bind) =>
			bind.startsWith("/var/run/docker.sock:"),
		) &&
		!containerConfig.binds.some((bind) => bind.endsWith(":/host/proc:ro")) &&
		!containerConfig.binds.some((bind) => bind.startsWith("/:")) &&
		containerConfig.binds.some((bind) => bind.endsWith(":/host/root:ro")) &&
		containerConfig.networkNames?.includes(TRAEFIK_CONTROL_NETWORK) ===
			dockerAccess.enabled &&
		containerConfig.networkNames.includes("nearzero-network") &&
		portBindings.length > 0 &&
		portBindings.every((binding) => binding.HostIp === "127.0.0.1")
	);
};

const pullFirstRemoteMonitoringImage = async (serverId: string) => {
	const candidates = getMonitoringImageCandidates();
	const docker = await getRemoteDocker(serverId);
	let lastError: unknown;

	for (const imageName of candidates) {
		try {
			await docker.getImage(imageName).inspect();
			return imageName;
		} catch {
			// Image is not already present on the remote Docker host; try pulling it.
		}
		try {
			await pullRemoteImage(imageName, serverId);
			return imageName;
		} catch (error) {
			lastError = error;
			warnMonitoringPullFailed(imageName, error);
		}
	}

	throw new Error(
		`Could not pull any monitoring image (${candidates.join(", ")}). ${monitoringErrorMessage(
			lastError,
		)}`.trim(),
	);
};

const pullFirstLocalMonitoringImage = async () => {
	const candidates = getMonitoringImageCandidates();
	let lastError: unknown;

	for (const imageName of candidates) {
		try {
			await pullImage(imageName);
			return imageName;
		} catch (error) {
			lastError = error;
			warnMonitoringPullFailed(imageName, error);
		}
	}

	throw new Error(
		`Could not pull any monitoring image (${candidates.join(", ")}). ${monitoringErrorMessage(
			lastError,
		)}`.trim(),
	);
};

/**
 * Ensures local web-server monitoring is configured in the DB and the
 * nearzero-monitoring container is running. Idempotent — safe on every boot.
 */
export const ensureWebMonitoring = async () => {
	const settings = await getWebServerSettings();
	if (!settings) return;

	let metricsConfig = settings.metricsConfig;

	const envToken = process.env.NEARZERO_METRICS_TOKEN?.trim();
	const envCallback = process.env.NEARZERO_METRICS_CALLBACK_URL?.trim();
	const envPort = positiveNumberFromEnv("NEARZERO_METRICS_PORT");
	const envRefreshRate = positiveNumberFromEnv(
		"NEARZERO_METRICS_REFRESH_SECONDS",
	);
	const envRetentionDays = positiveNumberFromEnv(
		"NEARZERO_METRICS_RETENTION_DAYS",
	);
	const envCronJob = process.env.NEARZERO_METRICS_CRON?.trim();

	let token = envToken || metricsConfig.server.token;
	let urlCallback = envCallback || metricsConfig.server.urlCallback;
	let cronJob = envCronJob || metricsConfig.server.cronJob;
	const port = envPort || metricsConfig.server.port || 4500;
	const refreshRate = envRefreshRate || metricsConfig.server.refreshRate || 60;
	const retentionDays =
		envRetentionDays || metricsConfig.server.retentionDays || 2;
	let needsConfigUpdate = false;

	if (!token) {
		token = generateToken();
		needsConfigUpdate = true;
	}
	if (metricsConfig.server.token !== token) {
		needsConfigUpdate = true;
	}
	if (!urlCallback) {
		const baseUrl = await getNearzeroUrl();
		urlCallback = `${baseUrl}/api/trpc/notification.receiveNotification`;
		needsConfigUpdate = true;
	}
	if (metricsConfig.server.urlCallback !== urlCallback) {
		needsConfigUpdate = true;
	}
	if (!cronJob) {
		cronJob = "0 0 * * *";
		needsConfigUpdate = true;
	}
	if (
		metricsConfig.server.type !== "Nearzero" ||
		Number(metricsConfig.server.port) !== port ||
		Number(metricsConfig.server.refreshRate) !== refreshRate ||
		Number(metricsConfig.server.retentionDays) !== retentionDays ||
		metricsConfig.server.cronJob !== cronJob
	) {
		needsConfigUpdate = true;
	}

	if (needsConfigUpdate) {
		metricsConfig = {
			...metricsConfig,
			server: {
				...metricsConfig.server,
				type: "Nearzero",
				port,
				refreshRate,
				token,
				urlCallback,
				retentionDays,
				cronJob,
			},
			containers: {
				...metricsConfig.containers,
				refreshRate,
			},
		};
		await updateWebServerSettings({
			metricsConfig,
		});
	}

	// The production Compose stack owns the monitoring container and its
	// `monitoring` DNS alias. Recreating it through the Docker socket detaches it
	// from the Compose network and makes NEARZERO_METRICS_URL unreachable.
	if (isExternallyManagedWebMonitoring()) {
		return;
	}

	const running = await isWebMonitoringRunning();
	const configMatches = running
		? await monitoringContainerMatchesConfig(metricsConfig)
		: false;
	if (!running || needsConfigUpdate || !configMatches) {
		await setupWebMonitoring();
	}
};

export const setupMonitoring = async (serverId: string) => {
	const server = await findServerById(serverId);

	const containerName = MONITORING_CONTAINER_NAME;

	// Defense in depth: the monitoring binary calls log.Fatal (and the
	// container restarts forever) if token/urlCallback are empty or if cronJob
	// is an invalid/empty cron expression. Guarantee a usable config before we
	// (re)create the container so a half-configured server can never produce a
	// crash-looping monitoring container.
	if (
		!server.metricsConfig?.server?.token ||
		!server.metricsConfig?.server?.urlCallback
	) {
		throw new Error(
			"Monitoring config is incomplete (missing token or urlCallback). Run server setup before configuring monitoring.",
		);
	}

	const safeMetricsConfig = {
		...server.metricsConfig,
		server: {
			...server.metricsConfig.server,
			cronJob: server.metricsConfig.server.cronJob || "0 0 * * *",
			retentionDays: server.metricsConfig.server.retentionDays || 2,
		},
	};

	const dockerAccess = monitoringDockerAccessConfig(
		safeMetricsConfig.containers.services.include ?? [],
	);
	const imageName = await pullFirstRemoteMonitoringImage(serverId);
	const loopbackPort = monitoringLoopbackPortConfig(
		safeMetricsConfig.server.port,
	);

	const settings: ContainerCreateOptions = {
		name: containerName,
		Env: [
			`METRICS_CONFIG=${JSON.stringify(safeMetricsConfig)}`,
			...(dockerAccess.dockerHost
				? [`DOCKER_HOST=${dockerAccess.dockerHost}`]
				: []),
			...HOST_METRICS_ENV,
		],
		Image: imageName,
		NetworkingConfig: dockerAccess.networkingConfig,
		HostConfig: {
			// Memory: 100 * 1024 * 1024, // 100MB en bytes
			// PidMode: "host",
			// CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
			// Privileged: true,
			RestartPolicy: {
				Name: "always",
			},
			PortBindings: loopbackPort.PortBindings,
			Binds: [
				"/etc/nearzero/monitoring:/host/root:ro",
				"/sys:/host/sys:ro",
				"/etc/os-release:/etc/os-release:ro",
				"/etc/nearzero/monitoring/monitoring.db:/app/monitoring.db",
			],
		},
		ExposedPorts: loopbackPort.ExposedPorts,
	};
	const docker = await getRemoteDocker(serverId);
	try {
		await execAsyncRemote(
			serverId,
			"mkdir -p /etc/nearzero/monitoring && touch /etc/nearzero/monitoring/monitoring.db",
		);

		// Check if container exists
		const container = docker.getContainer(containerName);
		try {
			await container.inspect();
			await container.remove({ force: true });
			console.log("Removed existing container");
		} catch {
			// Container doesn't exist, continue
		}

		await docker.createContainer(settings);
		const newContainer = docker.getContainer(containerName);
		await newContainer.start();

		console.log("Monitoring Started ");
	} catch (error) {
		const message = monitoringErrorMessage(error);
		console.error(`Monitoring setup failed${message ? `: ${message}` : ""}`);
		throw error;
	}
};

export const setupWebMonitoring = async () => {
	if (isExternallyManagedWebMonitoring()) {
		console.log(
			"Monitoring lifecycle is managed externally; keeping the configured container",
		);
		return;
	}

	const webServerSettings = await getWebServerSettings();
	const { MONITORING_PATH } = paths();
	const monitoringDbPath = `${MONITORING_PATH}/monitoring.db`;

	if (!existsSync(MONITORING_PATH)) {
		mkdirSync(MONITORING_PATH, { recursive: true });
	}
	if (!existsSync(monitoringDbPath)) {
		writeFileSync(monitoringDbPath, "");
	}

	const containerName = MONITORING_CONTAINER_NAME;
	const imageName = await pullFirstLocalMonitoringImage();
	const monitoringPort = webServerSettings?.metricsConfig?.server?.port ?? 4500;
	const loopbackPort = monitoringLoopbackPortConfig(monitoringPort);
	const dockerAccess = monitoringDockerAccessConfig(
		webServerSettings?.metricsConfig.containers.services.include ?? [],
	);

	const settings: ContainerCreateOptions = {
		name: containerName,
		Env: [
			`METRICS_CONFIG=${JSON.stringify(webServerSettings?.metricsConfig)}`,
			...(dockerAccess.dockerHost
				? [`DOCKER_HOST=${dockerAccess.dockerHost}`]
				: []),
			...HOST_METRICS_ENV,
		],
		Image: imageName,
		NetworkingConfig: dockerAccess.networkingConfig,
		HostConfig: {
			// Memory: 100 * 1024 * 1024, // 100MB en bytes
			// PidMode: "host",
			// CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
			// Privileged: true,
			RestartPolicy: {
				Name: "always",
			},
			PortBindings: loopbackPort.PortBindings,
			Binds: [
				`${MONITORING_PATH}:/host/root:ro`,
				"/sys:/host/sys:ro",
				"/etc/os-release:/etc/os-release:ro",
				`${monitoringDbPath}:/app/monitoring.db`,
			],
			// NetworkMode: "host",
		},
		ExposedPorts: loopbackPort.ExposedPorts,
	};
	const docker = await getRemoteDocker();
	try {
		const container = docker.getContainer(containerName);
		try {
			await container.inspect();
			await container.remove({ force: true });
			console.log("Removed existing container");
		} catch {}

		await docker.createContainer(settings);
		const newContainer = docker.getContainer(containerName);
		await newContainer.start();

		console.log("Monitoring Started ");
	} catch (error) {
		const message = monitoringErrorMessage(error);
		console.warn(
			`Monitoring could not be started${message ? `: ${message}` : ""}`,
		);
	}
};
