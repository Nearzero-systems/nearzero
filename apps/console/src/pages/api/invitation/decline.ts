import type { APIRoute } from "astro";
import { proxyBackendRequest } from "@/lib/backendProxy";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
	// Proxy to backend platform server
	return proxyBackendRequest(request, "/api/invitation/decline");
};
