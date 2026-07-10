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

function normalizeOrigin(value: string) {
	return value.trim().replace(/\/$/, "");
}

function parseOriginList(raw: string | undefined) {
	if (!raw?.trim()) return [];
	return raw
		.split(",")
		.map((entry) => normalizeOrigin(entry))
		.filter(Boolean);
}

function addHostPortVariants(origins: Set<string>, host: string, ports: number[]) {
	if (!host) return;
	for (const port of ports) {
		origins.add(`http://${host}:${port}`);
		origins.add(`https://${host}:${port}`);
	}
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

	const consolePort = Number(env.NEARZERO_CONSOLE_PORT || 4321);
	const platformPort = Number(env.NEARZERO_PLATFORM_PORT || 3000);
	const ports = [
		Number.isFinite(consolePort) ? consolePort : 4321,
		Number.isFinite(platformPort) ? platformPort : 3000,
	];

	for (const configured of [...origins]) {
		try {
			const url = new URL(configured);
			addHostPortVariants(origins, url.hostname, ports);
		} catch {
			// ignore invalid configured origins
		}
	}

	if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
		for (const host of ["localhost", "127.0.0.1"]) {
			addHostPortVariants(origins, host, ports);
		}
	}

	return [...origins];
}
