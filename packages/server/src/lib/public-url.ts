import { readRuntimePublicConfig } from "./runtime-public-config";

type PublicUrlEnv = {
	[key: string]: string | undefined;
	BETTER_AUTH_URL?: string;
	CONSOLE_URL?: string;
	NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH?: string;
	NODE_ENV?: string;
};

function normalizePublicUrl(value: string, variableName: string) {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${variableName} must be a valid absolute URL.`);
	}

	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`${variableName} must use http or https.`);
	}
	if (url.username || url.password) {
		throw new Error(`${variableName} must not contain credentials.`);
	}

	return url.toString().replace(/\/$/, "");
}

function isLoopbackUrl(value: string) {
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return (
			hostname === "localhost" ||
			hostname === "127.0.0.1" ||
			hostname === "::1" ||
			hostname === "0.0.0.0"
		);
	} catch {
		return false;
	}
}

function runtimeConsoleUrl(env: PublicUrlEnv) {
	// Keep the public-url helpers deterministic for callers that supply a
	// synthetic environment. Tests and tooling can opt in with an explicit path.
	if (env !== process.env && !env.NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH?.trim()) {
		return null;
	}
	return readRuntimePublicConfig({ env })?.consoleUrl ?? null;
}

function resolveEffectiveUrl(
	value: string | undefined,
	variableName: string,
	persistedConsoleUrl: string | null,
) {
	const configured = value?.trim()
		? normalizePublicUrl(value.trim(), variableName)
		: null;
	if (persistedConsoleUrl && (!configured || isLoopbackUrl(configured))) {
		return persistedConsoleUrl;
	}
	return configured;
}

export function resolveConsoleUrl(env: PublicUrlEnv = process.env) {
	const configured = resolveEffectiveUrl(
		env.CONSOLE_URL,
		"CONSOLE_URL",
		runtimeConsoleUrl(env),
	);
	if (configured) {
		return configured;
	}
	if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
		return "http://localhost:4321";
	}
	throw new Error(
		"CONSOLE_URL is required outside development so authentication and invitation emails use the public console URL.",
	);
}

export function resolveConsoleActionUrl(
	input: string,
	env: PublicUrlEnv = process.env,
) {
	const consoleUrl = resolveConsoleUrl(env);
	const source = new URL(input, `${consoleUrl}/`);
	return new URL(
		`${source.pathname}${source.search}${source.hash}`,
		`${consoleUrl}/`,
	).toString();
}

/**
 * Public URL browsers use for auth (OAuth callbacks, post-login redirects).
 * In split deploys the console BFF serves `/api/auth/*`, so this must be CONSOLE_URL.
 */
export function resolveAuthPublicBaseUrl(env: PublicUrlEnv = process.env) {
	const persistedConsoleUrl = runtimeConsoleUrl(env);
	const consoleUrl = resolveEffectiveUrl(
		env.CONSOLE_URL,
		"CONSOLE_URL",
		persistedConsoleUrl,
	);
	const authUrl = resolveEffectiveUrl(
		env.BETTER_AUTH_URL,
		"BETTER_AUTH_URL",
		persistedConsoleUrl,
	);

	if (consoleUrl && authUrl) {
		try {
			const consoleHost = new URL(consoleUrl).hostname;
			const authHost = new URL(authUrl).hostname;
			if (consoleHost !== authHost) {
				return normalizePublicUrl(consoleUrl, "CONSOLE_URL");
			}
		} catch {
			// fall through
		}
	}

	if (consoleUrl) {
		return consoleUrl;
	}
	if (authUrl) {
		return authUrl;
	}
	if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
		return "http://localhost:4321";
	}
	return undefined;
}

/** Parent domain shared by console and API hosts (e.g. `nearzero.dev`). */
export function resolveSharedCookieDomain(env: PublicUrlEnv = process.env) {
	if (env.NODE_ENV !== "production") return null;

	const persistedConsoleUrl = runtimeConsoleUrl(env);
	const consoleUrl = resolveEffectiveUrl(
		env.CONSOLE_URL,
		"CONSOLE_URL",
		persistedConsoleUrl,
	);
	const authUrl = resolveEffectiveUrl(
		env.BETTER_AUTH_URL,
		"BETTER_AUTH_URL",
		persistedConsoleUrl,
	);
	if (!consoleUrl || !authUrl) return null;

	try {
		const consoleHost = new URL(consoleUrl).hostname;
		const authHost = new URL(authUrl).hostname;
		if (consoleHost === authHost) return null;

		const consoleParent = consoleHost.split(".").slice(-2).join(".");
		const authParent = authHost.split(".").slice(-2).join(".");
		if (consoleParent !== authParent) return null;
		if (consoleHost.split(".").length < 3) return null;

		return consoleParent;
	} catch {
		return null;
	}
}
