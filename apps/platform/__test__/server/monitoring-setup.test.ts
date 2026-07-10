import { isExternallyManagedWebMonitoring } from "@nearzero/server";
import { afterEach, expect, test } from "vitest";

const originalMetricsUrl = process.env.NEARZERO_METRICS_URL;

afterEach(() => {
	if (originalMetricsUrl === undefined) {
		delete process.env.NEARZERO_METRICS_URL;
	} else {
		process.env.NEARZERO_METRICS_URL = originalMetricsUrl;
	}
});

test("treats a configured metrics URL as externally managed", () => {
	process.env.NEARZERO_METRICS_URL = "http://monitoring:4500/metrics";
	expect(isExternallyManagedWebMonitoring()).toBe(true);
});

test("allows local lifecycle management without a metrics URL", () => {
	delete process.env.NEARZERO_METRICS_URL;
	expect(isExternallyManagedWebMonitoring()).toBe(false);
});
