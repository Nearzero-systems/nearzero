import type { APIRoute } from "astro";
import { proxyBackendRequest } from "@/lib/backendProxy";

export const prerender = false;

export const ALL: APIRoute = async ({ request, params }) => {
	const trpcPath = params.trpc ?? "";
	const url = new URL(request.url);
	return proxyBackendRequest(
		request,
		`/api/trpc/${trpcPath}${url.search}`,
	);
};
