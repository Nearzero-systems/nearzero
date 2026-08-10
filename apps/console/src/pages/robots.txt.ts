import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
	return new Response("User-agent: *\nDisallow: /\n", {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"X-Robots-Tag": "noindex, nofollow",
		},
	});
};
