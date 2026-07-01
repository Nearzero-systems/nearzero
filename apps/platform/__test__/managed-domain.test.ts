import { afterEach, describe, expect, it } from "vitest";
import {
	buildManagedServiceHost,
	buildPlatformDefaultServiceHost,
	slugifyServiceName,
} from "@nearzero/server/services/managed-domain";
import { getPlatformDefaultDomain } from "@nearzero/server/constants";

describe("slugifyServiceName", () => {
	it("normalizes service labels", () => {
		expect(slugifyServiceName("My API")).toBe("my-api");
	});
});

describe("buildPlatformDefaultServiceHost", () => {
	const original = process.env.NEARZERO_PLATFORM_DOMAIN;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.NEARZERO_PLATFORM_DOMAIN;
		} else {
			process.env.NEARZERO_PLATFORM_DOMAIN = original;
		}
	});

	it("includes project and environment for non-production", () => {
		process.env.NEARZERO_PLATFORM_DOMAIN = "nearzero.dev";
		expect(
			buildPlatformDefaultServiceHost({
				serviceName: "API",
				projectName: "Acme App",
				environment: { name: "staging", domainPrefix: null },
			}),
		).toBe("api.staging.acme-app.nearzero.dev");
	});

	it("omits environment label for production", () => {
		process.env.NEARZERO_PLATFORM_DOMAIN = "nearzero.dev";
		expect(
			buildPlatformDefaultServiceHost({
				serviceName: "API",
				projectName: "Acme App",
				environment: { name: "production", domainPrefix: null },
			}),
		).toBe("api.acme-app.nearzero.dev");
	});
});

describe("getPlatformDefaultDomain", () => {
	const original = process.env.NEARZERO_PLATFORM_DOMAIN;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.NEARZERO_PLATFORM_DOMAIN;
		} else {
			process.env.NEARZERO_PLATFORM_DOMAIN = original;
		}
	});

	it("returns null when unset", () => {
		delete process.env.NEARZERO_PLATFORM_DOMAIN;
		expect(getPlatformDefaultDomain()).toBeNull();
	});

	it("strips trailing dot and lowercases", () => {
		process.env.NEARZERO_PLATFORM_DOMAIN = "Example.COM.";
		expect(getPlatformDefaultDomain()).toBe("example.com");
	});
});

describe("buildManagedServiceHost", () => {
	it("uses domain prefix when set", () => {
		expect(
			buildManagedServiceHost({
				serviceName: "web",
				zoneName: "example.com",
				environment: {
					name: "staging",
					isDefault: false,
					domainPrefix: "apps",
				},
			}),
		).toBe("web.apps.example.com");
	});
});
