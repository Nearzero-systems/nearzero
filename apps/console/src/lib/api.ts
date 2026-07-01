export {
	getBackendUpstreamUrl as getControlPlaneUpstreamUrl,
	getSession,
	joinBackendUrl,
} from "./backendProxy";
import { joinBackendUrl } from "./backendProxy";

export const PUBLIC_API_URL = "";

export function getAuthUrl(path: string) {
	return path;
}

export async function getWorkspaceBilling(_request: Request) {
	return {
		currentPlan: { key: "free", label: "Free", detail: "Self-hosted" },
		invoices: [],
	};
}

export async function apiRequest(
	path: string,
	init?: RequestInit & { cookie?: string; body?: unknown },
): Promise<unknown> {
	const res = await fetch(joinBackendUrl(path), {
		method: init?.method ?? "GET",
		headers: {
			...(init?.cookie ? { cookie: init.cookie } : {}),
			"content-type": "application/json",
		},
		body: init?.body ? JSON.stringify(init.body) : undefined,
	});
	if (!res.ok) {
		throw new Error(`API ${path} failed: ${res.status}`);
	}
	return res.json();
}
