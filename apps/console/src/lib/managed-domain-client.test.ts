import { describe, expect, it } from "vitest";
import { selectConfiguredManagedDnsZone } from "./managed-domain-client";

describe("selectConfiguredManagedDnsZone", () => {
	it("selects the installer-configured zone instead of the first alphabetical zone", () => {
		const zones = [
			{ name: "alpha.example.com", authoritative: true },
			{ name: "apps.example.com", authoritative: false },
		];

		expect(selectConfiguredManagedDnsZone(zones, "APPS.EXAMPLE.COM.")).toEqual(
			zones[1],
		);
	});

	it("does not substitute an unrelated zone when the configured zone is missing", () => {
		expect(
			selectConfiguredManagedDnsZone(
				[{ name: "unrelated.example.com" }],
				"apps.example.com",
			),
		).toBeNull();
	});

	it("keeps the legacy first-zone behavior when no install zone is configured", () => {
		const zone = { name: "apps.example.com" };
		expect(selectConfiguredManagedDnsZone([zone], null)).toBe(zone);
	});
});
