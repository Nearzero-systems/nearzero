import { BACKEND_URL } from "./branding";

function normalizeSiteHostname(hostname: string): string {
	return hostname === "127.0.0.1" ? "localhost" : hostname;
}

/** Console and platform run on different hostnames (e.g. app.* vs api.*). */
export function areConsoleBackendSplit(
	pageHostname: string,
	backendUrl = BACKEND_URL,
) {
	try {
		const backend = new URL(backendUrl);
		return (
			normalizeSiteHostname(backend.hostname) !==
			normalizeSiteHostname(pageHostname)
		);
	} catch {
		return false;
	}
}
