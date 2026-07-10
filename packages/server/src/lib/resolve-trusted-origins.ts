import os from "node:os";
import { isCommunityMode } from "../services/runtime-mode";

type TrustedOriginEnv = {
	[key: string]: string | undefined;
	CONSOLE_URL?: string;
	BETTER_AUTH_URL?: string;
	PUBLIC_BACKEND_URL?: string;
	PUBLIC_GIT_PROVIDER_BASE_URL?: string;
	NEARZERO_TRUSTED_ORIGINS?: string;
	NEARZERO_CONSOLE_PORT?: string;
	NEARZERO_PLATFORM_PORT?: string;
	NODE_ENV?: string;
};

export function normalizeOrigin(value: string) {
	return value.trim().replace(/\/$/, "");
}

function parseOriginList(raw: string | undefined) {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((entry) => normalizeOrigin(entry))
		.filter(Boolean);
}

function addHostPortVariants(
	origins: Set<string>,
	host: string,
	ports: number[],
) {
	if (!host) return;
	for (const port of ports) {
		origins.add(`http://${host}:${port}`);
		origins.add(`https://${host}:${port}`);
	}
}

export function resolveConsoleAndPlatformPorts(env: TrustedOriginEnv = process.env) {
	const consolePort = Number(env.NEARZERO_CONSOLE_PORT || 4321);
	const platformPort = Number(env.NEARZERO_PLATFORM_PORT || 3000);
	return {
		consolePort: Number.isFinite(consolePort) ? consolePort : 4321,
		platformPort: Number.isFinite(platformPort) ? platformPort : 3000,
	};
}

export function getNetworkInterfaceHosts() {
	const hosts = new Set<string>(["127.0.0.1", "localhost"]);

	for (const interfaces of Object.values(os.networkInterfaces())) {
		if (!interfaces) continue;
		for (const iface of interfaces) {
			const family = iface.family;
			const isIPv4 = family === "IPv4" || family === 4;
			if (!isIPv4 || !iface.address) continue;
			hosts.add(iface.address);
		}
	}

	return [...hosts];
}

export function buildHostPortOrigins(
	hosts: string[],
	consolePort: number,
	platformPort: number,
) {
	const origins = new Set<string>();
	for (const host of hosts) {
		addHostPortVariants(origins, host, [consolePort, platformPort]);
	}
	return [...origins];
}

export function resolveEnvTrustedOrigins(env: TrustedOriginEnv = process.env) {
	const origins = new Set<string>();

	for (const key of [
		"CONSOLE_URL",
		"BETTER_AUTH_URL",
		"PUBLIC_BACKEND_URL",
		"PUBLIC_GIT_PROVIDER_BASE_URL",
	] as const) {
		const value = env[key]?.trim();
		if (value) origins.add(normalizeOrigin(value));
	}

	for (const origin of parseOriginList(env.NEARZERO_TRUSTED_ORIGINS)) {
		origins.add(origin);
	}

	const { consolePort, platformPort } = resolveConsoleAndPlatformPorts(env);
	const ports = [consolePort, platformPort];

	for (const configured of [...origins]) {
		try {
			const url = new URL(configured);
			addHostPortVariants(origins, url.hostname, ports);
		} catch {
			// ignore invalid configured origins
		}
	}

	for (const host of getNetworkInterfaceHosts()) {
		addHostPortVariants(origins, host, ports);
	}

	if (
		isCommunityMode() ||
		env.NODE_ENV === "development" ||
		env.NODE_ENV === "test"
	) {
		for (const host of ["localhost", "127.0.0.1"]) {
			addHostPortVariants(origins, host, ports);
		}
	}

	return [...origins];
}

export function isAllowedSelfHostedOrigin(
	origin: string,
	consolePort = 4321,
	platformPort = 3000,
) {
	if (!isCommunityMode()) return false;

	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;

		const port = url.port
			? Number(url.port)
			: url.protocol === "https:"
				? 443
				: 80;

		return port === consolePort || port === platformPort;
	} catch {
		return false;
	}
}

export function appendRequestOrigin(
	origins: Iterable<string>,
	request: Request | undefined,
	consolePort: number,
	platformPort: number,
) {
	const merged = new Set(origins);
	const originHeader = request?.headers.get("origin")?.trim();
	if (
		originHeader &&
		isAllowedSelfHostedOrigin(originHeader, consolePort, platformPort)
	) {
		merged.add(normalizeOrigin(originHeader));
	}
	return [...merged];
}
