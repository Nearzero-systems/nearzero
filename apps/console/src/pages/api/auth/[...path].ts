import type { APIRoute } from "astro";
import { proxyBackendAuth } from "@/lib/backendProxy";

export const prerender = false;

export const ALL: APIRoute = async ({ request, params }) => {
	const rest = params.path ?? "";
	const url = new URL(request.url);
	const authPath = `/${rest}${url.search}`;
	return proxyBackendAuth(request, authPath);
};
