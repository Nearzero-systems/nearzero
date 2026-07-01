import { describe, expect, it } from "vitest";
import {
	DEFAULT_PROJECT_ENVIRONMENT_NAME,
	isProductionEnvironment,
} from "@nearzero/server/services/environment";
import { renderZoneFile } from "@nearzero/server/utils/dns/zone-file";
import { buildManagedServiceHost } from "@nearzero/server/services/managed-domain";

describe("agent production safety", () => {
	it("defaults new projects to development", () => {
		expect(DEFAULT_PROJECT_ENVIRONMENT_NAME).toBe("development");
	});

	it("does not treat default environment as production", () => {
		expect(
			isProductionEnvironment({ name: "development", isDefault: true }),
		).toBe(false);
	});

	it("detects production by name", () => {
		expect(
			isProductionEnvironment({ name: "production", isDefault: false }),
		).toBe(true);
	});

	it("allows non-production environments", () => {
		expect(
			isProductionEnvironment({ name: "staging", isDefault: false }),
		).toBe(false);
	});
});

describe("managed domain helpers", () => {
	it("builds staging host with environment label", () => {
		expect(
			buildManagedServiceHost({
				serviceName: "API",
				zoneName: "example.com",
				environment: { name: "staging", isDefault: false, domainPrefix: null },
			}),
		).toBe("api.staging.example.com");
	});
});

describe("dns zone writer", () => {
	it("renders deterministic sorted records", () => {
		const contents = renderZoneFile({
			zoneName: "example.com",
			soaEmail: "hostmaster@example.com",
			defaultTtl: 300,
			nameservers: ["ns1.example.com"],
			serial: "2026010101",
			records: [
				{ name: "www", type: "A", value: "1.2.3.4" },
				{ name: "@", type: "A", value: "1.2.3.4" },
			],
		});
		expect(contents).toContain("$ORIGIN example.com.");
		expect(contents.indexOf("@ IN A")).toBeLessThan(contents.indexOf("www"));
	});
});
