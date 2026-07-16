import { bindAnalyticsDashboardActions } from "@/scripts/analytics-dashboard-client";

function parseBootstrap(root: HTMLElement): Array<Record<string, unknown>> {
	const enc = root.dataset.logs;
	if (!enc) return [];
	try {
		return JSON.parse(decodeURIComponent(enc)) as Array<Record<string, unknown>>;
	} catch {
		return [];
	}
}

function runAnalyticsMount() {
	const root = document.getElementById("nz-analytics-root");
	if (!(root instanceof HTMLElement)) return;
	const pageLogs = parseBootstrap(root);
	bindAnalyticsDashboardActions(root, pageLogs);
}

let pageLoadBound = false;

export function mountAnalyticsDashboard() {
	runAnalyticsMount();
	if (pageLoadBound) return;
	pageLoadBound = true;
	document.addEventListener("astro:page-load", runAnalyticsMount);
	document.addEventListener("astro:after-swap", runAnalyticsMount);
}
