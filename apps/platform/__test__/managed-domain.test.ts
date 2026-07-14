import { getPlatformDefaultDomain } from "@nearzero/server/constants";
import {
	buildManagedServiceHost,
	buildPlatformDefaultServiceHost,
	canUsePlatformDomainForServer,
	isNearzeroAssignedDomain,
	slugifyServiceName,
} from "@nearzero/server/services/managed-domain";
import { afterEach, describe, expect, it } from "vitest";

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
				organizationId: "org-123",
				environment: { name: "staging", domainPrefix: null },
			}),
		).toBe("api.staging.acme-app-org-123.nearzero.dev");
	});

	it("omits environment label for production", () => {
		process.env.NEARZERO_PLATFORM_DOMAIN = "nearzero.dev";
		expect(
			buildPlatformDefaultServiceHost({
				serviceName: "API",
				projectName: "Acme App",
				organizationId: "org-123",
				environment: { name: "production", domainPrefix: null },
			}),
		).toBe("api.acme-app-org-123.nearzero.dev");
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

describe("platform domain routing scope", () => {
	const original = process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE;

	afterEach(() => {
		if (original === undefined) {
			delete process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE;
		} else {
			process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE = original;
		}
	});

	it("uses a platform wildcard locally but not for a direct remote server", () => {
		delete process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE;
		expect(canUsePlatformDomainForServer(null)).toBe(true);
		expect(canUsePlatformDomainForServer("remote-server-id")).toBe(false);
	});

	it("allows remote use only when a shared edge is explicitly configured", () => {
		process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE = "true";
		expect(canUsePlatformDomainForServer("remote-server-id")).toBe(true);
	});
});

describe("Nearzero-assigned domain recognition", () => {
	it("migrates managed, platform, and temporary IP domains", () => {
		expect(
			isNearzeroAssignedDomain({
				host: "api.example.com",
				dnsMode: "nearzero_managed",
				isSystemAssigned: true,
			}),
		).toBe(true);
		expect(
			isNearzeroAssignedDomain({
				host: "api.platform.example",
				dnsMode: "platform",
			}),
		).toBe(true);
		expect(
			isNearzeroAssignedDomain({
				host: "api-203-0-113-10.sslip.io",
				dnsMode: "external",
			}),
		).toBe(true);
	});

	it("never treats a user-owned external domain as system-assigned", () => {
		expect(
			isNearzeroAssignedDomain({
				host: "customer.example.com",
				dnsMode: "nearzero_managed",
				isSystemAssigned: false,
			}),
		).toBe(false);
	});
});
