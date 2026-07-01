import type { APIRoute } from "astro";
import { proxyBackendRequest } from "@/lib/backendProxy";

export const prerender = false;

export const ALL: APIRoute = async ({ request, params }) => {
	const url = new URL(request.url);
	const agentPath = params.agent ? `/${params.agent}` : "";
	return proxyBackendRequest(request, `/api/agent${agentPath}${url.search}`);
};
