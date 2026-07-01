import { makeSignature } from "better-auth/crypto";
import { IS_COMMUNITY } from "./branding";

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

function useSecureSessionCookies() {
	if (import.meta.env.DEV) return false;
	return !IS_COMMUNITY;
}

export function sessionCookieName() {
	const prefix = useSecureSessionCookies() ? "__Secure-" : "";
	return `${prefix}better-auth.session_token`;
}

/** Build a host-scoped Set-Cookie for the console origin from a raw session token. */
export async function buildConsoleSessionSetCookie(
	sessionToken: string,
): Promise<string | null> {
	const secret = readAuthSecret();
	if (!secret || !sessionToken) return null;

	const signed = `${sessionToken}.${await makeSignature(sessionToken, secret)}`;
	const parts = [
		`${sessionCookieName()}=${signed}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${SESSION_MAX_AGE_SECONDS}`,
	];
	if (useSecureSessionCookies()) parts.push("Secure");
	return parts.join("; ");
}
