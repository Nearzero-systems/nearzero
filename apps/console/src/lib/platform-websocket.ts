import { BACKEND_URL } from "./branding";
import { areConsoleBackendSplit } from "./split-deploy";

export { areConsoleBackendSplit };

export function isPlatformWebSocketSplit() {
	if (typeof window === "undefined") return false;
	return areConsoleBackendSplit(window.location.hostname);
}

function resolveWebSocketHost(): string {
	if (isPlatformWebSocketSplit()) {
		try {
			return new URL(BACKEND_URL).host;
		} catch {
			// Fall back to same-origin proxy.
		}
	}
	return window.location.host;
}

export function getPlatformWebSocketUrl(
	path: string,
	searchParams?: URLSearchParams | string,
): string {
	const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
	const pathname = path.startsWith("/") ? path : `/${path}`;
	const query =
		typeof searchParams === "string"
			? searchParams
				? `?${searchParams}`
				: ""
			: searchParams?.toString()
				? `?${searchParams.toString()}`
				: "";
	return `${protocol}//${resolveWebSocketHost()}${pathname}${query}`;
}

/**
 * Build a WebSocket URL, attaching a short-lived auth ticket when the console
 * and API run on different hostnames. Browsers don't send the console-scoped
 * session cookie on a cross-subdomain WS handshake, so we mint a `wsToken` over
 * the authenticated same-origin proxy and pass it as a query param. On a
 * same-origin (local) setup the cookie works, so no ticket is requested.
 */
export async function getAuthenticatedPlatformWebSocketUrl(
	path: string,
	searchParams?: URLSearchParams | string,
): Promise<string> {
	const params = new URLSearchParams(
		typeof searchParams === "string"
			? searchParams
			: (searchParams?.toString() ?? ""),
	);
	if (isPlatformWebSocketSplit()) {
		try {
			const { trpcMutate } = await import("@/lib/client-api");
			const ticket = await trpcMutate<string>("user.createWsTicket");
			if (ticket) params.set("wsToken", ticket);
		} catch {
			// Fall back to cookie auth (e.g. if the shared-domain cookie is set).
		}
	}
	return getPlatformWebSocketUrl(path, params);
}
