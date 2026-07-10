import os from "node:os";

type TrustedOriginEnv = {
	[key: string]: string | undefined;
	CONSOLE_URL?: string;
	BETTER_AUTH_URL?: string;
	BACKEND_URL?: string;
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
	const normalizedHost = host.replace(/^\[|\]$/g, "");
	for (const port of ports) {
		origins.add(`http://${normalizedHost}:${port}`);
		origins.add(`https://${normalizedHost}:${port}`);
	}
}

export function resolveConsoleAndPlatformPorts(
	env: TrustedOriginEnv = process.env,
) {
	const consolePort = Number(env.NEARZERO_CONSOLE_PORT || 4321);
	const platformPort = Number(env.NEARZERO_PLATFORM_PORT || 3000);
	return {
		consolePort: Number.isFinite(consolePort) ? consolePort : 4321,
		platformPort: Number.isFinite(platformPort) ? platformPort : 3000,
	};
}

function isIPv4Family(family: string | number) {
	return family === "IPv4" || family === 4;
}

export function getNetworkInterfaceHosts() {
	const hosts = new Set<string>(["127.0.0.1", "localhost"]);

	for (const interfaces of Object.values(os.networkInterfaces())) {
		if (!interfaces) continue;
		for (const iface of interfaces) {
			if (!isIPv4Family(iface.family) || !iface.address) continue;
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
		"BACKEND_URL",
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

	// Trust any host on the published console/platform ports.
	// Covers public IPs, private IPs, and custom domains without hardcoding hosts.
	for (const port of ports) {
		origins.add(`http://*:${port}`);
		origins.add(`https://*:${port}`);
	}

	return [...origins];
}

/**
 * Trust any http(s) origin on the console or platform port.
 * This covers public IPs, private IPs, and custom domains without hardcoding hosts.
 */
export function isAllowedSelfHostedOrigin(
	origin: string,
	consolePort = 4321,
	platformPort = 3000,
) {
	try {
		const url = new URL(origin);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (!url.hostname) return false;

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

function originFromRequest(request: Request | undefined) {
	if (!request) return null;

	const originHeader = request.headers.get("origin")?.trim();
	if (originHeader) return normalizeOrigin(originHeader);

	const referer = request.headers.get("referer")?.trim();
	if (referer) {
		try {
			return normalizeOrigin(new URL(referer).origin);
		} catch {
			// ignore
		}
	}

	const forwardedHost = request.headers.get("x-forwarded-host")?.trim();
	const forwardedProto = request.headers.get("x-forwarded-proto")?.trim();
	const host = forwardedHost || request.headers.get("host")?.trim();
	if (host) {
		const proto =
			forwardedProto?.split(",")[0]?.trim() ||
			(new URL(request.url).protocol === "https:" ? "https" : "http");
		return normalizeOrigin(`${proto}://${host}`);
	}

	try {
		return normalizeOrigin(new URL(request.url).origin);
	} catch {
		return null;
	}
}

export function appendRequestOrigin(
	origins: Iterable<string>,
	request: Request | undefined,
	consolePort: number,
	platformPort: number,
) {
	const merged = new Set(origins);
	const requestOrigin = originFromRequest(request);
	if (
		requestOrigin &&
		isAllowedSelfHostedOrigin(requestOrigin, consolePort, platformPort)
	) {
		merged.add(requestOrigin);
	}
	return [...merged];
}
