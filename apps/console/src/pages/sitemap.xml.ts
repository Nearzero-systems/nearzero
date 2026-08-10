import type { APIRoute } from "astro";

export const GET: APIRoute = () => {
	const xml =
		'<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>';

	return new Response(xml, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"X-Robots-Tag": "noindex, nofollow",
		},
	});
};
