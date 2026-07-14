import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

const readRepositoryFile = (path: string) =>
	readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");

test("monitoring credentials stay out of browser-rendered markup", () => {
	const dashboard = readRepositoryFile(
		"apps/console/src/components/dashboard/monitoring/MonitoringDashboard.astro",
	);
	expect(dashboard).not.toContain("data-metrics-token");
	expect(dashboard).not.toContain("PUBLIC_METRICS_TOKEN");
	expect(dashboard).not.toContain("getMetricsToken.query");
	expect(dashboard).toContain(
		'trpcQuery<MetricPoint[]>("server.getServerMetrics", { dataPoints })',
	);
});

test("monitoring process never logs the serialized metrics configuration", () => {
	const source = readRepositoryFile("apps/monitoring/main.go");
	expect(source).not.toMatch(/log\.Print\w*\([^\n]*METRICS_CONFIG/);
	expect(source).not.toContain('os.Getenv("METRICS_CONFIG")');
});

test("monitoring cannot read the host root or host process environments", () => {
	for (const path of [
		"docker-compose.prod.yml",
		"scripts/install.sh",
		"packages/server/src/setup/monitoring-setup.ts",
	]) {
		const source = readRepositoryFile(path);
		expect(source).not.toContain("/:/host/root:ro");
		expect(source).not.toContain("/proc:/host/proc:ro");
		expect(source).not.toContain("HOST_PROC=/host/proc");
	}
});
