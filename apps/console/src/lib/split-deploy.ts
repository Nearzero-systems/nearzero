import { BACKEND_URL } from "./branding";

function normalizeSiteHostname(hostname: string): string {
	return hostname === "127.0.0.1" ? "localhost" : hostname;
}

function isLoopbackHostname(hostname: string) {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1"
	);
}

/** Console and platform run on different browser-reachable origins. */
export function areConsoleBackendSplit(
	pageOrigin: string,
	backendUrl = BACKEND_URL,
) {
	try {
		const backend = new URL(backendUrl);
		const page = pageOrigin.includes("://")
			? new URL(pageOrigin)
			: new URL(`http://${pageOrigin}`);
		const backendHostname = normalizeSiteHostname(backend.hostname);
		const pageHostname = normalizeSiteHostname(page.hostname);

		// The universal OSS image is built with a loopback backend fallback. A
		// remote browser must never be sent to its own 127.0.0.1; the public
		// management hostname routes WebSocket paths through Traefik instead.
		if (
			isLoopbackHostname(backendHostname) &&
			!isLoopbackHostname(pageHostname)
		) {
			return false;
		}

		return backendHostname !== pageHostname || backend.port !== page.port;
	} catch {
		return false;
	}
}
