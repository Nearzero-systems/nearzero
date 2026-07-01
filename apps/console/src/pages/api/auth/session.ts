import type { APIRoute } from "astro";
import { getSession } from "@/lib/backendProxy";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	const session = await getSession(request);
	return new Response(JSON.stringify(session ?? { user: null }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
};
