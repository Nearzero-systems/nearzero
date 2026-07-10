import { findServerById } from "@nearzero/server/services/server";
import { getNearzeroUrl } from "@nearzero/server/services/admin";
import {
	getWebServerSettings,
	updateWebServerSettings,
} from "@nearzero/server/services/web-server-settings";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { ContainerCreateOptions } from "dockerode";
import { paths } from "../constants";
import { getNearzeroImageTag } from "../services/settings";
import { pullImage, pullRemoteImage } from "../utils/docker/utils";
import { execAsyncRemote } from "../utils/process/execAsync";
import { getRemoteDocker } from "../utils/servers/remote-docker";

const MONITORING_CONTAINER_NAME = "nearzero-monitoring";

export const isExternallyManagedWebMonitoring = () =>
	Boolean(process.env.NEARZERO_METRICS_URL?.trim());

const monitoringErrorMessage = (error: unknown) => {
	if (error instanceof Error) return error.message.trim();
	return String(error ?? "").trim();
};

const warnMonitoringPullFailed = (imageName: string, error: unknown) => {
	const message = monitoringErrorMessage(error);
	console.warn(
		`Could not pull monitoring image ${imageName}${message ? `: ${message}` : ""}`,
	);
};

const getMonitoringImageTag = () => {
	const explicitTag = process.env.NEARZERO_MONITORING_IMAGE_TAG?.trim();
	if (explicitTag) return explicitTag;
	if (
		getNearzeroImageTag() !== "latest" ||
		process.env.NODE_ENV === "development"
	) {
		return "nightly";
	}
	return "latest";
};

const getMonitoringImageCandidates = () => {
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

const HOST_METRICS_ENV = [
	"HOST_PROC=/host/proc",
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
		return JSON.parse(rawConfig) as {
			server?: {
				port?: number;
				token?: string;
				urlCallback?: string;
				cronJob?: string;
			};
			containers?: unknown;
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

	return (
		containerConfig.server?.token === metricsConfig.server.token &&
		Number(containerConfig.server?.port) ===
			Number(metricsConfig.server.port) &&
		containerConfig.server?.urlCallback === metricsConfig.server.urlCallback &&
		containerConfig.server?.cronJob === metricsConfig.server.cronJob &&
		JSON.stringify(containerConfig.containers ?? null) ===
			JSON.stringify(metricsConfig.containers ?? null)
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
		`Could not pull any monitoring image (${candidates.join(", ")}). ${
			monitoringErrorMessage(lastError)
		}`.trim(),
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
		`Could not pull any monitoring image (${candidates.join(", ")}). ${
			monitoringErrorMessage(lastError)
		}`.trim(),
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
	let port = envPort || metricsConfig.server.port || 4500;
	let refreshRate = envRefreshRate || metricsConfig.server.refreshRate || 60;
	let retentionDays = envRetentionDays || metricsConfig.server.retentionDays || 2;
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

	const imageName = await pullFirstRemoteMonitoringImage(serverId);

	const settings: ContainerCreateOptions = {
		name: containerName,
		Env: [
			`METRICS_CONFIG=${JSON.stringify(safeMetricsConfig)}`,
			...HOST_METRICS_ENV,
		],
		Image: imageName,
		HostConfig: {
			// Memory: 100 * 1024 * 1024, // 100MB en bytes
			// PidMode: "host",
			// CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
			// Privileged: true,
			RestartPolicy: {
				Name: "always",
			},
			PortBindings: {
				[`${safeMetricsConfig.server.port}/tcp`]: [
					{
						HostPort: safeMetricsConfig.server.port.toString(),
					},
				],
			},
			Binds: [
				"/var/run/docker.sock:/var/run/docker.sock:ro",
				"/:/host/root:ro",
				"/sys:/host/sys:ro",
				"/etc/os-release:/etc/os-release:ro",
				"/proc:/host/proc:ro",
				"/etc/nearzero/monitoring/monitoring.db:/app/monitoring.db",
			],
			NetworkMode: "host",
		},
		ExposedPorts: {
			[`${safeMetricsConfig.server.port}/tcp`]: {},
		},
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
		console.error(
			`Monitoring setup failed${message ? `: ${message}` : ""}`,
		);
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

	const settings: ContainerCreateOptions = {
		name: containerName,
		Env: [
			`METRICS_CONFIG=${JSON.stringify(webServerSettings?.metricsConfig)}`,
			...HOST_METRICS_ENV,
		],
		Image: imageName,
		HostConfig: {
			// Memory: 100 * 1024 * 1024, // 100MB en bytes
			// PidMode: "host",
			// CapAdd: ["NET_ADMIN", "SYS_ADMIN"],
			// Privileged: true,
			RestartPolicy: {
				Name: "always",
			},
			PortBindings: {
				[`${webServerSettings?.metricsConfig?.server?.port}/tcp`]: [
					{
						HostPort: webServerSettings?.metricsConfig?.server?.port.toString(),
					},
				],
			},
			Binds: [
				"/var/run/docker.sock:/var/run/docker.sock:ro",
				"/:/host/root:ro",
				"/sys:/host/sys:ro",
				"/etc/os-release:/etc/os-release:ro",
				"/proc:/host/proc:ro",
				`${monitoringDbPath}:/app/monitoring.db`,
			],
			// NetworkMode: "host",
		},
		ExposedPorts: {
			[`${webServerSettings?.metricsConfig?.server?.port}/tcp`]: {},
		},
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
