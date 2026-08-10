import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "@nearzero/server/constants";
import type { webServerSettings } from "@nearzero/server/db/schema/web-server-settings";
import { parse, stringify } from "yaml";
import { loadOrCreateConfig, writeTraefikConfig } from "./application";
import type { FileConfig } from "./file-types";
import type { MainTraefikConfig } from "./types";

const PLATFORM_WEBSOCKET_PATHS = [
	"/drawer-logs",
	"/listen-deployment",
	"/docker-container-logs",
	"/docker-container-terminal",
	"/terminal",
	"/listen-docker-stats-monitoring",
] as const;

function platformWebSocketRule(host: string) {
	const paths = PLATFORM_WEBSOCKET_PATHS.map(
		(path) => `PathPrefix(\`${path}\`)`,
	).join(" || ");
	return `Host(\`${host}\`) && (${paths})`;
}

export const updateServerTraefik = (
	settings: typeof webServerSettings.$inferSelect | null,
	newHost: string | null,
) => {
	// A missing hostname means the control-plane domain has not been configured.
	// Keep the generated local route intact instead of deleting its config during
	// startup; domain removal is not exposed by the validated settings API.
	if (!newHost) return;

	const { https, certificateType } = settings || {};
	const appName = "nearzero";
	const consolePort =
		Number.parseInt(process.env.NEARZERO_CONSOLE_INTERNAL_PORT || "4321", 10) ||
		4321;
	const platformPort =
		Number.parseInt(
			process.env.NEARZERO_PLATFORM_INTERNAL_PORT || "3000",
			10,
		) || 3000;
	const config: FileConfig = loadOrCreateConfig(appName);

	config.http = config.http || { routers: {}, services: {} };
	config.http.routers = config.http.routers || {};
	config.http.services = config.http.services || {};

	// Get or create router config, but always update the rule with newHost
	const currentRouterConfig = config.http.routers[`${appName}-router-app`] || {
		service: `${appName}-service-app`,
		entryPoints: ["web"],
		rule: `Host(\`${newHost}\`)`,
	};

	// Always update the rule with the new host
	if (newHost) {
		currentRouterConfig.rule = `Host(\`${newHost}\`)`;
	}

	config.http.routers[`${appName}-router-app`] = currentRouterConfig;

	config.http.services = {
		...config.http.services,
		[`${appName}-service-app`]: {
			loadBalancer: {
				servers: [
					{
						// Git provider callbacks and the dashboard are served by the
						// console, which proxies API requests to the platform.
						url: `http://nearzero:${consolePort}`,
					},
				],
				passHostHeader: true,
			},
		},
		[`${appName}-service-platform`]: {
			loadBalancer: {
				servers: [{ url: `http://nearzero:${platformPort}` }],
				passHostHeader: true,
			},
		},
	};

	// The production Astro server proxies normal HTTP API calls, but it cannot
	// upgrade WebSocket connections. Route the known live-log and terminal paths
	// directly to the platform process so the public management hostname remains
	// a true single-origin endpoint.
	config.http.routers[`${appName}-router-platform-ws`] = {
		rule: platformWebSocketRule(newHost),
		service: `${appName}-service-platform`,
		entryPoints: ["web"],
		priority: 1_000,
	};

	if (https) {
		currentRouterConfig.middlewares = ["redirect-to-https"];
		config.http.routers[`${appName}-router-platform-ws`]!.middlewares = [
			"redirect-to-https",
		];

		if (certificateType === "letsencrypt") {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
				tls: { certResolver: "letsencrypt" },
			};
			config.http.routers[`${appName}-router-platform-ws-secure`] = {
				rule: platformWebSocketRule(newHost),
				service: `${appName}-service-platform`,
				entryPoints: ["websecure"],
				priority: 1_000,
				tls: { certResolver: "letsencrypt" },
			};
		} else {
			config.http.routers[`${appName}-router-app-secure`] = {
				rule: `Host(\`${newHost}\`)`,
				service: `${appName}-service-app`,
				entryPoints: ["websecure"],
			};
			config.http.routers[`${appName}-router-platform-ws-secure`] = {
				rule: platformWebSocketRule(newHost),
				service: `${appName}-service-platform`,
				entryPoints: ["websecure"],
				priority: 1_000,
				tls: {},
			};
		}
	} else {
		delete config.http.routers[`${appName}-router-app-secure`];
		delete config.http.routers[`${appName}-router-platform-ws-secure`];
		currentRouterConfig.middlewares = [];
		config.http.routers[`${appName}-router-platform-ws`]!.middlewares = [];
	}

	writeTraefikConfig(config, appName);
};

export const updateLetsEncryptEmail = (newEmail: string | null) => {
	try {
		if (!newEmail) return;
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		const configContent = readFileSync(configPath, "utf8");
		const config = parse(configContent) as MainTraefikConfig;
		if (config?.certificatesResolvers?.letsencrypt?.acme) {
			config.certificatesResolvers.letsencrypt.acme.email = newEmail;
		} else {
			throw new Error("Invalid Let's Encrypt configuration structure.");
		}
		const newYamlContent = stringify(config);
		writeFileSync(configPath, newYamlContent, "utf8");
	} catch (error) {
		throw error;
	}
};

export const readMainConfig = () => {
	const { MAIN_TRAEFIK_PATH } = paths();
	const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
	if (existsSync(configPath)) {
		const yamlStr = readFileSync(configPath, "utf8");
		return yamlStr;
	}
	return null;
};

export const writeMainConfig = (traefikConfig: string) => {
	try {
		const { MAIN_TRAEFIK_PATH } = paths();
		const configPath = join(MAIN_TRAEFIK_PATH, "traefik.yml");
		writeFileSync(configPath, traefikConfig, "utf8");
	} catch (e) {
		console.error("Error saving the YAML config file:", e);
	}
};
