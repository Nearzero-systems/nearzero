import type { APIRoute } from "astro";
import {
	DASHBOARD_FRAGMENT_HEADER,
	dashboardAsyncPath,
	type DashboardAsyncParams,
	type DashboardAsyncRouteId,
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

export const POST: APIRoute = async ({ request, url }) => {
	const started = performance.now();
	let routeId = "unknown";

	try {
		const input = (await request.json().catch(() => null)) as PageDataInput | null;
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
			orgSlug && fragmentPath.startsWith("/dashboard") ?
				`/${encodeURIComponent(orgSlug)}${fragmentPath}`
			:	fragmentPath;

		const fragmentUrl = new URL(scopedPath, url.origin);
		const headers = new Headers();
		const cookie = request.headers.get("cookie");
		if (cookie) headers.set("cookie", cookie);
		headers.set(DASHBOARD_FRAGMENT_HEADER, "1");
		headers.set("accept", "text/html");

		const fragmentStarted = performance.now();
		const response = await fetch(fragmentUrl, {
			method: "GET",
			headers,
			redirect: "follow",
		});
		const html = await response.text();
		const fragmentMs = Math.round(performance.now() - fragmentStarted);
		const finalPath = new URL(response.url).pathname;

		if (response.redirected && finalPath === "/login") {
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
					message: html || `Unable to load ${input.routeId}`,
				},
				response.status,
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
				message: error instanceof Error ? error.message : "Unable to load page",
			},
			500,
		);
	}
};
