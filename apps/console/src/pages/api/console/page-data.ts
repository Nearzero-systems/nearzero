import type { APIRoute } from "astro";
import {
	DASHBOARD_FRAGMENT_HEADER,
	type DashboardAsyncParams,
	type DashboardAsyncRouteId,
	dashboardAsyncPath,
} from "@/lib/dashboard-async-routes";
import { normalizeDashboardPath } from "@/lib/org-routes";

type PageDataInput = {
	routeId?: DashboardAsyncRouteId;
	params?: DashboardAsyncParams;
	search?: string;
	orgSlug?: string | null;
};

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "private, no-store, must-revalidate",
			vary: "Cookie",
		},
	});
}

function isDev() {
	return import.meta.env.DEV || import.meta.env.MODE === "development";
}

const MAX_FRAGMENT_REDIRECTS = 5;

/**
 * Where the console fetches its own dashboard fragments. The request URL's
 * origin comes from the client-controlled Host / X-Forwarded-Host headers, so
 * it must never be the fetch target (that would let anyone make this route
 * request, and return, arbitrary URLs).
 */
function resolveFragmentOrigin(requestUrl: URL): string {
	const explicit = process.env.NEARZERO_CONSOLE_INTERNAL_ORIGIN?.trim();
	if (explicit) return new URL(explicit).origin;
	if (process.env.VERCEL) {
		const consoleUrl = process.env.CONSOLE_URL?.trim();
		if (consoleUrl) return new URL(consoleUrl).origin;
		if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
	}
	if (isDev()) {
		// `astro dev` may pick another port; the target stays on loopback.
		return `http://127.0.0.1:${requestUrl.port || process.env.PORT?.trim() || "4321"}`;
	}
	const port = process.env.PORT?.trim() || "4321";
	return `http://127.0.0.1:${port}`;
}

export const POST: APIRoute = async ({ request, url }) => {
	const started = performance.now();
	let routeId = "unknown";

	try {
		const input = (await request
			.json()
			.catch(() => null)) as PageDataInput | null;
		if (!input?.routeId) {
			return json(
				{ ok: false, code: "bad_request", message: "Missing routeId" },
				400,
			);
		}
		routeId = input.routeId;

		const fragmentPath = dashboardAsyncPath(
			input.routeId,
			input.params ?? {},
			input.search ?? "",
		);
		const referer = request.headers.get("referer");
		const refererPath = referer ? new URL(referer).pathname : url.pathname;
		const orgSlug =
			input.orgSlug?.trim() ||
			normalizeDashboardPath(refererPath).orgSlug ||
			null;
		const scopedPath =
			orgSlug && fragmentPath.startsWith("/dashboard")
				? `/${encodeURIComponent(orgSlug)}${fragmentPath}`
				: fragmentPath;

		const fragmentOrigin = resolveFragmentOrigin(url);
		let fragmentUrl = new URL(scopedPath, fragmentOrigin);
		if (fragmentUrl.origin !== fragmentOrigin) {
			return json(
				{ ok: false, code: "bad_request", message: "Invalid route" },
				400,
			);
		}
		const headers = new Headers();
		const cookie = request.headers.get("cookie");
		if (cookie) headers.set("cookie", cookie);
		headers.set(DASHBOARD_FRAGMENT_HEADER, "1");
		headers.set("accept", "text/html");
		// Keep Astro.url in the fragment render identical to the page the user
		// is on; this only affects URL construction, not the fetch target.
		headers.set("x-forwarded-host", url.host);
		headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));

		const fragmentStarted = performance.now();
		let response = await fetch(fragmentUrl, {
			method: "GET",
			headers,
			redirect: "manual",
		});
		// Follow redirects by hand so they can never leave the console itself.
		for (
			let hops = 0;
			response.status >= 300 &&
			response.status < 400 &&
			hops < MAX_FRAGMENT_REDIRECTS;
			hops++
		) {
			const location = response.headers.get("location");
			if (!location) break;
			const next = new URL(location, fragmentUrl);
			if (next.pathname === "/login") {
				return json(
					{
						ok: false,
						code: "unauthorized",
						message: "Sign in again to load this page.",
					},
					401,
				);
			}
			const sameConsole =
				next.origin === fragmentOrigin || next.host === url.host;
			if (!sameConsole) {
				return json(
					{
						ok: false,
						code: "fragment_load_failed",
						message: `Unable to load ${input.routeId}`,
					},
					502,
				);
			}
			fragmentUrl = new URL(`${next.pathname}${next.search}`, fragmentOrigin);
			response = await fetch(fragmentUrl, {
				method: "GET",
				headers,
				redirect: "manual",
			});
		}
		const html = await response.text();
		const fragmentMs = Math.round(performance.now() - fragmentStarted);
		const finalPath = fragmentUrl.pathname;

		if (finalPath === "/login") {
			return json(
				{
					ok: false,
					code: "unauthorized",
					message: "Sign in again to load this page.",
				},
				401,
			);
		}

		if (!response.ok) {
			return json(
				{
					ok: false,
					code: "fragment_load_failed",
					message: `Unable to load ${input.routeId}`,
				},
				response.status >= 400 ? response.status : 502,
			);
		}

		if (isDev()) {
			console.info("[console:page-data]", {
				routeId,
				status: response.status,
				fragmentMs,
				totalMs: Math.round(performance.now() - started),
			});
		}

		return json({
			ok: true,
			shell: null,
			page: { html },
		});
	} catch (error) {
		if (isDev()) {
			console.warn("[console:page-data] failed", {
				routeId,
				totalMs: Math.round(performance.now() - started),
				error: error instanceof Error ? error.message : String(error),
			});
		}
		return json(
			{
				ok: false,
				code: "internal_error",
				message: "Unable to load page",
			},
			500,
		);
	}
};
