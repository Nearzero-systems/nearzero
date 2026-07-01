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

export function mountAnalyticsDashboard() {
	const run = () => {
		const root = document.getElementById("nz-analytics-root");
		if (!(root instanceof HTMLElement)) return;
		const pageLogs = parseBootstrap(root);
		bindAnalyticsDashboardActions(root, pageLogs);
	};

	run();
	document.addEventListener("astro:page-load", run);
}
