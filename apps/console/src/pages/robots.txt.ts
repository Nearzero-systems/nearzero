import type { APIRoute } from "astro";
import { isMarketingHomeEnabled } from "@/lib/marketing-home";
import { publicSiteUrl } from "@/lib/public-site";

export const GET: APIRoute = () => {
	const indexingEnabled = isMarketingHomeEnabled();
	const body = indexingEnabled
		? `User-agent: *\nAllow: /\nSitemap: ${publicSiteUrl("/sitemap.xml").toString()}\n`
		: "User-agent: *\nDisallow: /\n";

	return new Response(body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			...(indexingEnabled ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
		},
	});
};
