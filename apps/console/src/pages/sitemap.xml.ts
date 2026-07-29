import type { APIRoute } from "astro";
import { isMarketingHomeEnabled } from "@/lib/marketing-home";
import {
	comparisonNavigation,
	docsNavigation,
	publicSiteLinks,
	publicSiteUrl,
} from "@/lib/public-site";

function escapeXml(value: string) {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export const GET: APIRoute = () => {
	const indexingEnabled = isMarketingHomeEnabled();
	const paths = indexingEnabled
		? [
				"/",
				...docsNavigation.map((item) => item.href),
				publicSiteLinks.compare,
				...comparisonNavigation.map((item) => item.href),
			]
		: [];
	const urls = paths
		.filter((path, index) => paths.indexOf(path) === index)
		.map(
			(path) =>
				`<url><loc>${escapeXml(publicSiteUrl(path).toString())}</loc></url>`,
		)
		.join("");
	const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;

	return new Response(xml, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			...(indexingEnabled ? {} : { "X-Robots-Tag": "noindex, nofollow" }),
		},
	});
};
