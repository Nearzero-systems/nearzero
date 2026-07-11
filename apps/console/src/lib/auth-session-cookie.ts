import { makeSignature } from "better-auth/crypto";

const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function readAuthSecret() {
	const fromImport = import.meta.env.BETTER_AUTH_SECRET;
	if (typeof fromImport === "string" && fromImport.trim()) {
		return fromImport.trim();
	}
	if (typeof process !== "undefined" && process.env.BETTER_AUTH_SECRET?.trim()) {
		return process.env.BETTER_AUTH_SECRET.trim();
	}
	return "";
}

function configuredAuthBaseUrl() {
	const runtimeUrl =
		typeof process !== "undefined"
			? process.env.CONSOLE_URL?.trim() || process.env.BETTER_AUTH_URL?.trim()
			: "";
	return (
		runtimeUrl ||
		import.meta.env.CONSOLE_URL?.trim() ||
		import.meta.env.BETTER_AUTH_URL?.trim() ||
		""
	);
}

function isHttpsUrl(value?: string) {
	if (value) {
		try {
			return new URL(value).protocol === "https:";
		} catch {
			// Fall through.
		}
	}
	return false;
}

function useSecureCookiePrefix(
	requestUrl?: string,
	authBaseUrl = configuredAuthBaseUrl(),
) {
	if (authBaseUrl) return isHttpsUrl(authBaseUrl);
	if (requestUrl) return isHttpsUrl(requestUrl);
	return !import.meta.env.DEV;
}

function requireSecureCookieAttribute(requestUrl?: string) {
	if (requestUrl) return isHttpsUrl(requestUrl);
	return useSecureCookiePrefix(requestUrl);
}

export function sessionCookieName(requestUrl?: string, authBaseUrl?: string) {
	const prefix = useSecureCookiePrefix(requestUrl, authBaseUrl) ? "__Secure-" : "";
	return `${prefix}better-auth.session_token`;
}

/** Build a host-scoped Set-Cookie for the console origin from a raw session token. */
export async function buildConsoleSessionSetCookie(
	sessionToken: string,
	requestUrl?: string,
): Promise<string | null> {
	const secret = readAuthSecret();
	if (!secret || !sessionToken) return null;

	const signed = `${sessionToken}.${await makeSignature(sessionToken, secret)}`;
	const parts = [
		`${sessionCookieName(requestUrl)}=${signed}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${SESSION_MAX_AGE_SECONDS}`,
	];
	if (requireSecureCookieAttribute(requestUrl)) parts.push("Secure");
	return parts.join("; ");
}
