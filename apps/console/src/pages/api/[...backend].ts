import type { APIRoute } from "astro";
import { proxyBackendRequest } from "@/lib/backendProxy";

export const prerender = false;

const passthrough = (prefix: string): APIRoute => {
	return async ({ request, params }) => {
		const url = new URL(request.url);
		const rest = Object.values(params).filter(Boolean).join("/");
		return proxyBackendRequest(
			request,
			`${prefix}/${rest}${url.search}`.replace(/\/+/g, "/"),
		);
	};
};

export const ALL: APIRoute = async (context) => {
	const url = new URL(context.request.url);
	const pathname = url.pathname;

	if (pathname.startsWith("/api/deploy/")) {
		return proxyBackendRequest(context.request, `${pathname}${url.search}`);
	}
	if (pathname.startsWith("/api/agent/")) {
		return proxyBackendRequest(context.request, `${pathname}${url.search}`);
	}
	if (pathname === "/api/health") {
		return proxyBackendRequest(context.request, `/api/health${url.search}`);
	}
	if (pathname.startsWith("/api/providers/")) {
		return proxyBackendRequest(context.request, `${pathname}${url.search}`);
	}

	return new Response(JSON.stringify({ error: "Not found" }), {
		status: 404,
		headers: { "content-type": "application/json" },
	});
};
