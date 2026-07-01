import { buildConsoleSessionSetCookie } from "./auth-session-cookie";
import { rewriteAuthRedirectLocation } from "./auth-redirect";
import { BACKEND_URL } from "./branding";
import { areConsoleBackendSplit } from "./split-deploy";

const AUTH_SESSION_BOOTSTRAP_PREFIXES = [
	"/sign-in/email-otp",
	"/email-otp/verify-email",
] as const;

/** Split a joined Set-Cookie header without breaking Expires commas. */
function splitSetCookieHeader(setCookie: string): string[] {
	if (!setCookie) return [];
	const result: string[] = [];
	let start = 0;
	for (let i = 0; i < setCookie.length; i++) {
		if (setCookie[i] !== ",") continue;
		let j = i + 1;
		while (j < setCookie.length && setCookie[j] === " ") j++;
		while (j < setCookie.length && setCookie[j] !== "=" && setCookie[j] !== ";") {
			j++;
		}
		if (j < setCookie.length && setCookie[j] === "=") {
			const part = setCookie.slice(start, i).trim();
			if (part) result.push(part);
			start = i + 1;
			while (start < setCookie.length && setCookie[start] === " ") start++;
			i = start - 1;
		}
	}
	const last = setCookie.slice(start).trim();
	if (last) result.push(last);
	return result;
}

function collectUpstreamSetCookies(headers: Headers): string[] {
	if (typeof headers.getSetCookie === "function") {
		const cookies = headers.getSetCookie();
		if (cookies.length > 0) return cookies;
	}
	const joined = headers.get("set-cookie");
	return joined ? splitSetCookieHeader(joined) : [];
}

/** Bind proxied auth cookies to the console host the browser actually uses. */
function rewriteSetCookieForConsole(value: string) {
	return value.replace(/;\s*domain=[^;]*/gi, "").replace(/;+\s*$/, "");
}

function shouldBootstrapConsoleSession(pathWithQuery: string) {
	const path = pathWithQuery.split("?")[0] ?? pathWithQuery;
	return AUTH_SESSION_BOOTSTRAP_PREFIXES.some((prefix) => path.endsWith(prefix));
}

async function maybeAppendConsoleSessionCookie(
	request: Request,
	pathWithQuery: string,
	upstream: Response,
	headers: Headers,
) {
	if (!pathWithQuery.startsWith("/api/auth") || !upstream.ok) return;
	if (!shouldBootstrapConsoleSession(pathWithQuery)) return;

	let hostname = "";
	try {
		hostname = new URL(request.url).hostname;
	} catch {
		return;
	}
	if (!areConsoleBackendSplit(hostname)) return;

	const body = (await upstream.clone().json().catch(() => null)) as {
		token?: unknown;
	} | null;
	const token = typeof body?.token === "string" ? body.token : null;
	if (!token) return;

	const bootstrap = await buildConsoleSessionSetCookie(token);
	if (bootstrap) headers.append("set-cookie", bootstrap);
}

export function getBackendUpstreamUrl() {
	return BACKEND_URL.replace(/\/$/, "");
}

export function joinBackendUrl(pathWithQuery: string) {
	const base = getBackendUpstreamUrl();
	return `${base}${pathWithQuery.startsWith("/") ? "" : "/"}${pathWithQuery}`;
}

const UPSTREAM_TIMEOUT_MS = 45_000;

function delay(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function localLoopbackVariant(urlString: string): string | null {
	try {
		const url = new URL(urlString);
		if (url.hostname === "localhost") {
			url.hostname = "127.0.0.1";
			return url.toString();
		}
		if (url.hostname === "127.0.0.1") {
			url.hostname = "localhost";
			return url.toString();
		}
	} catch {
		return null;
	}
	return null;
}

async function fetchBackendWithRetry(
	target: string,
	init: RequestInit,
): Promise<Response> {
	const candidates = [target];
	const alternate = localLoopbackVariant(target);
	if (alternate && alternate !== target) {
		candidates.push(alternate);
	}

	let lastError: unknown = null;
	for (const candidate of candidates) {
		try {
			return await fetch(candidate, {
				...init,
				signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
			});
		} catch (err) {
			lastError = err;
			await delay(250);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("Backend request failed");
}

function forwardHeaders(request: Request, extra?: Record<string, string>) {
	const cookie = request.headers.get("cookie") ?? "";
	const origin = request.headers.get("origin");
	const referer = request.headers.get("referer");
	const invitationToken = request.headers.get("x-nearzero-token");
	const authIntent = request.headers.get("x-nearzero-auth-intent");
	return {
		...(cookie ? { cookie } : {}),
		...(origin ? { origin } : {}),
		...(referer ? { referer } : {}),
		...(invitationToken ? { "x-nearzero-token": invitationToken } : {}),
		...(authIntent ? { "x-nearzero-auth-intent": authIntent } : {}),
		...(request.headers.get("content-type")
			? { "content-type": request.headers.get("content-type")! }
			: {}),
		...extra,
	};
}

/** Proxy arbitrary backend paths (tRPC, health, deploy webhooks, etc.). */
export async function proxyBackendRequest(
	request: Request,
	pathWithQuery: string,
	init?: {
		method?: string;
		body?: string | ArrayBuffer | null;
		extra?: Record<string, string>;
	},
): Promise<Response> {
	const target = joinBackendUrl(pathWithQuery);
	const method = init?.method ?? request.method;
	const body =
		init?.body !== undefined
			? init.body
			: method !== "GET" && method !== "HEAD"
				? await request.arrayBuffer()
				: undefined;

	const bodySize =
		typeof body === "string"
			? body.length
			: body instanceof ArrayBuffer
				? body.byteLength
				: 0;

	let upstream: Response;
	try {
		upstream = await fetchBackendWithRetry(target, {
			method,
			headers: forwardHeaders(request, init?.extra),
			body: body && bodySize > 0 ? body : undefined,
			redirect: "manual",
		});
	} catch (err) {
		// Never let an upstream connection failure propagate as a thrown error:
		// some runtimes reset the connection on a thrown handler, which the
		// browser surfaces only as a generic "Failed to fetch". Return a real
		// response so callers (e.g. tRPC clients) get an actionable message.
		const detail =
			err instanceof Error ? err.message : "Backend request failed";
		return new Response(
			JSON.stringify({
				error: "Upstream backend request failed",
				detail,
				target: pathWithQuery,
			}),
			{
				status: 502,
				headers: { "content-type": "application/json" },
			},
		);
	}

	const headers = new Headers();
	const relayAuthCookies = pathWithQuery.startsWith("/api/auth");
	let requestOrigin = "";
	try {
		requestOrigin = new URL(request.url).origin;
	} catch {
		requestOrigin = "";
	}
	const backendOrigin = getBackendUpstreamUrl();

	for (const [key, value] of upstream.headers.entries()) {
		const lower = key.toLowerCase();
		// Drop hop-by-hop and encoding headers. The upstream body has already
		// been decoded by fetch, so relaying the original content-encoding /
		// content-length makes the browser try to decode/length-check an
		// already-decoded stream and fail with a generic "Failed to fetch".
		if (
			lower === "transfer-encoding" ||
			lower === "content-encoding" ||
			lower === "content-length" ||
			lower === "set-cookie" ||
			(relayAuthCookies && lower === "location")
		) {
			continue;
		}
		headers.append(key, value);
	}

	if (relayAuthCookies) {
		for (const cookie of collectUpstreamSetCookies(upstream.headers)) {
			headers.append("set-cookie", rewriteSetCookieForConsole(cookie));
		}
		await maybeAppendConsoleSessionCookie(
			request,
			pathWithQuery,
			upstream,
			headers,
		);

		const location = upstream.headers.get("location");
		if (location && requestOrigin) {
			const rewritten = rewriteAuthRedirectLocation(
				location,
				requestOrigin,
				backendOrigin,
			);
			if (rewritten) headers.set("location", rewritten);
		}
	}

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

/** Proxy better-auth `/api/auth/*` routes. */
export async function proxyBackendAuth(
	request: Request,
	authPathWithQuery: string,
): Promise<Response> {
	const path = authPathWithQuery.startsWith("/")
		? authPathWithQuery
		: `/${authPathWithQuery}`;
	const extra: Record<string, string> = {};
	if (!request.headers.get("origin")) {
		try {
			extra.origin = new URL(request.url).origin;
		} catch {
			// ignore invalid request URL
		}
	}
	return proxyBackendRequest(request, `/api/auth${path}`, { extra });
}

export type SessionUser = {
	id: string;
	name: string;
	email: string;
	image?: string | null;
};

export type SessionPayload = {
	user: SessionUser;
	session?: Record<string, unknown>;
};

export async function getSession(
	request: Request,
): Promise<SessionPayload | null> {
	const cookie = request.headers.get("cookie") ?? "";
	if (!cookie) return null;

	try {
		const res = await fetchBackendWithRetry(
			joinBackendUrl("/api/auth/get-session"),
			{
				method: "GET",
				headers: { cookie },
			},
		);
		if (!res.ok) return null;
		const data = (await res.json()) as SessionPayload | null;
		return data?.user ? data : null;
	} catch {
		return null;
	}
}
