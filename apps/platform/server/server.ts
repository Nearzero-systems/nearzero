import "./load-env.js";
import { bootstrapEdition } from "./edition-bootstrap.js";
bootstrapEdition();
import http from "node:http";
import {
	connectCurrentContainerToNetwork,
	createDefaultMiddlewares,
	createDefaultServerTraefikConfig,
	createDefaultTraefikConfig,
	ensureTraefikSetup,
	ensureWebMonitoring,
	getWebServerSettings,
	initCancelDeployments,
	initCronJobs,
	initializeNetwork,
	initializeSwarm,
	initSchedules,
	initStaleDeploymentWatchdog,
	initVolumeBackupsCronJobs,
	sendNearzeroRestartNotifications,
	setupDirectories,
	updateLetsEncryptEmail,
	updateServerTraefik,
} from "@nearzero/server";
import { isCommunityMode } from "@nearzero/server/services/runtime-mode";
import packageInfo from "../package.json";
import { migration } from "./db/migration";
import "./agent-deployment-bridge";
import { setupDockerContainerLogsWebSocketServer } from "./wss/docker-container-logs";
import { setupDockerContainerTerminalWebSocketServer } from "./wss/docker-container-terminal";
import { setupDockerStatsMonitoringSocketServer } from "./wss/docker-stats";
import { setupDrawerLogsWebSocketServer } from "./wss/drawer-logs";
import { setupDeploymentLogsWebSocketServer } from "./wss/listen-deployment";
import { setupTerminalWebSocketServer } from "./wss/terminal";

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const isCommunity = isCommunityMode();
const shouldBootstrapLocalRuntime = isProduction && isCommunity;

/**
 * Detects Docker engine errors that occur when the node is not a Swarm manager
 * (or Docker is otherwise unavailable). In cloud control-plane mode the platform
 * orchestrates remote runtime servers, so the local node is intentionally not a
 * Swarm manager. Background Docker calls that reject for this reason must never
 * crash the API or spam the logs with raw docker-modem stack traces.
 */
const isDockerUnavailableError = (error: unknown): boolean => {
	if (!error || typeof error !== "object") {
		const message = String(error ?? "");
		return /not a swarm manager|swarm/i.test(message);
	}
	const err = error as {
		statusCode?: number;
		message?: string;
		json?: { message?: string };
		code?: string;
	};
	const message = `${err.message ?? ""} ${err.json?.message ?? ""}`;
	if (/this node is not a swarm manager|not a swarm manager/i.test(message)) {
		return true;
	}
	// Docker socket missing / engine not running.
	if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
		return /docker|\/var\/run\/docker\.sock/i.test(message);
	}
	return false;
};

// Keep the control-plane resilient: a single background Docker/Swarm rejection
// (e.g. a queued deployment targeting a node that is not a Swarm manager) must
// not take down the API process. Genuine programming errors still surface.
process.on("unhandledRejection", (reason) => {
	if (isDockerUnavailableError(reason)) {
		console.warn(
			"[platform] Skipped a Docker/Swarm operation: this node is not a Swarm manager (expected in cloud control-plane mode).",
		);
		return;
	}
	console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
	if (isDockerUnavailableError(error)) {
		console.warn(
			"[platform] Skipped a Docker/Swarm operation: this node is not a Swarm manager (expected in cloud control-plane mode).",
		);
		return;
	}
	console.error("Uncaught exception:", error);
	// Non-Docker uncaught exceptions are unexpected; fail fast so the process
	// manager (PM2) can restart cleanly rather than running in a bad state.
	process.exit(1);
});

if (shouldBootstrapLocalRuntime) {
	setupDirectories();
	createDefaultTraefikConfig();
	createDefaultServerTraefikConfig();
	console.log("✅ initialization complete");
} else if (isProduction) {
	console.log(
		"Cloud control-plane mode: local Docker, Swarm, Traefik, and monitoring bootstrap is disabled.",
	);
}

void (async () => {
	try {
		console.log("Running Nearzero Platform: ", packageInfo.version);
		console.log(
			isCommunity
				? "Community self-hosted platform API"
				: "Nearzero Cloud control-plane API",
		);
		console.log("Headless API — UI served by @nearzero/console on :4321");

		try {
			await migration();
		} catch (migrationError) {
			console.error(
				"Database migration failed. Run `npm run migration:run` from apps/platform.",
				migrationError,
			);
			throw migrationError;
		}

		const { routeRequest } = await import("./routes/index");

		const server = http.createServer(async (req, res) => {
			try {
				if (await routeRequest(req, res)) return;
				res.statusCode = 404;
				res.setHeader("content-type", "application/json");
				res.end(
					JSON.stringify({
						message:
							"Nearzero console UI is served by Astro. Use port 4321 in development.",
					}),
				);
			} catch (error) {
				console.error("Request handler error", error);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.setHeader("content-type", "application/json");
					res.end(JSON.stringify({ message: "Internal server error" }));
				}
			}
		});

		setupDrawerLogsWebSocketServer(server);
		setupDeploymentLogsWebSocketServer(server);
		setupDockerContainerLogsWebSocketServer(server);
		setupDockerContainerTerminalWebSocketServer(server);
		setupTerminalWebSocketServer(server);
		if (isCommunity) {
			setupDockerStatsMonitoringSocketServer(server);
		}

		await new Promise<void>((resolve, reject) => {
			server.once("error", (err: NodeJS.ErrnoException) => {
				if (err.code === "EADDRINUSE") {
					reject(
						new Error(
							`Port ${PORT} is already in use. Stop the other process (lsof -i :${PORT}) or set PORT in apps/platform/.env`,
						),
					);
					return;
				}
				reject(err);
			});
			server.listen(PORT, HOST, () => {
				console.log(`Platform server started on: http://${HOST}:${PORT}`);
				resolve();
			});
		});

		if (isCommunity) {
			try {
				await ensureWebMonitoring();
				console.log("Monitoring service ready");
			} catch (monitoringError) {
				const message =
					monitoringError instanceof Error
						? monitoringError.message
						: String(monitoringError ?? "");
				console.warn(
					`Monitoring auto-enable failed; API will still serve requests.${message ? ` ${message}` : ""}`,
				);
			}
		}

		if (shouldBootstrapLocalRuntime) {
			createDefaultMiddlewares();
			await initializeSwarm();
			await initializeNetwork();
			await connectCurrentContainerToNetwork();
			try {
				const webServerSettings = await getWebServerSettings();
				if (webServerSettings?.host) {
					updateServerTraefik(webServerSettings, webServerSettings.host);
					if (webServerSettings.letsEncryptEmail) {
						updateLetsEncryptEmail(webServerSettings.letsEncryptEmail);
					}
					await ensureTraefikSetup();
					console.log("Public HTTPS proxy ready");
				}
			} catch (traefikError) {
				const message =
					traefikError instanceof Error
						? traefikError.message
						: String(traefikError ?? "");
				console.warn(
					`Public HTTPS proxy auto-repair failed; the platform remains available on port 4321.${message ? ` ${message}` : ""}`,
				);
			}
		}

		if (isProduction) {
			await initCronJobs();
			await initSchedules();
			await initCancelDeployments();
			await initVolumeBackupsCronJobs();
			await sendNearzeroRestartNotifications();
		}
		await initStaleDeploymentWatchdog();

		console.log("Starting Deployment Worker");
		try {
			const { deploymentWorker } = await import("./queues/deployments-queue");
			await deploymentWorker.run();
		} catch (workerError) {
			console.warn(
				"Deployment worker failed to start (is Redis running?). API will still serve requests.",
				workerError,
			);
		}
	} catch (e) {
		console.error("Platform Server Error", e);
		process.exit(1);
	}
})();
