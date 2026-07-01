type PublicUrlEnv = {
	[key: string]: string | undefined;
	BETTER_AUTH_URL?: string;
	CONSOLE_URL?: string;
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

export function resolveConsoleUrl(env: PublicUrlEnv = process.env) {
	const configured = env.CONSOLE_URL?.trim();
	if (configured) {
		return normalizePublicUrl(configured, "CONSOLE_URL");
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
	const consoleUrl = env.CONSOLE_URL?.trim();
	const authUrl = env.BETTER_AUTH_URL?.trim();

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
		return normalizePublicUrl(consoleUrl, "CONSOLE_URL");
	}
	if (authUrl) {
		return normalizePublicUrl(authUrl, "BETTER_AUTH_URL");
	}
	if (env.NODE_ENV === "development" || env.NODE_ENV === "test") {
		return "http://localhost:4321";
	}
	return undefined;
}

/** Parent domain shared by console and API hosts (e.g. `nearzero.dev`). */
export function resolveSharedCookieDomain(env: PublicUrlEnv = process.env) {
	if (env.NODE_ENV !== "production") return null;

	const consoleUrl = env.CONSOLE_URL?.trim();
	const authUrl = env.BETTER_AUTH_URL?.trim();
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
