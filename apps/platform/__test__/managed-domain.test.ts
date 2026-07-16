import { getPlatformDefaultDomain } from "@nearzero/server/constants";
import {
	buildManagedServiceHost,
	buildPlatformDefaultServiceHost,
	buildRandomPlatformServiceHost,
	canUsePlatformDomainForServer,
	isNearzeroAssignedDomain,
	managedZoneDnsSetupHints,
	normalizeConfiguredPlatformApex,
	platformDomainDnsSetupHints,
	platformDomainWildcardDnsHint,
	resolvePlatformDefaultDomain,
	slugifyServiceName,
} from "@nearzero/server/services/managed-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetWebServerSettings = vi.fn();

vi.mock("@nearzero/server/services/web-server-settings", () => ({
	getWebServerSettings: (...args: unknown[]) =>
		mockGetWebServerSettings(...args),
}));

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
	it("requires a configured platform apex", () => {
		expect(canUsePlatformDomainForServer(null)).toBe(false);
		expect(canUsePlatformDomainForServer("remote-server-id")).toBe(false);
	});

	it("allows platform hostnames locally and on remote servers when an apex exists", () => {
		expect(canUsePlatformDomainForServer(null, "veritus.space")).toBe(true);
		expect(canUsePlatformDomainForServer("remote-server-id", "veritus.space")).toBe(
			true,
		);
	});
});

describe("resolvePlatformDefaultDomain", () => {
	const original = process.env.NEARZERO_PLATFORM_DOMAIN;

	beforeEach(() => {
		mockGetWebServerSettings.mockReset();
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env.NEARZERO_PLATFORM_DOMAIN;
		} else {
			process.env.NEARZERO_PLATFORM_DOMAIN = original;
		}
	});

	it("returns the env apex when configured", async () => {
		process.env.NEARZERO_PLATFORM_DOMAIN = "Example.COM.";
		mockGetWebServerSettings.mockResolvedValue({ host: "veritus.space" });
		await expect(resolvePlatformDefaultDomain()).resolves.toBe("example.com");
	});

	it("falls back to the configured web-server host", async () => {
		delete process.env.NEARZERO_PLATFORM_DOMAIN;
		mockGetWebServerSettings.mockResolvedValue({ host: "https://Veritus.Space/" });
		await expect(resolvePlatformDefaultDomain()).resolves.toBe("veritus.space");
	});
});

describe("platform hostname helpers", () => {
	it("normalizes configured apex values", () => {
		expect(normalizeConfiguredPlatformApex("https://Veritus.Space/console")).toBe(
			"veritus.space",
		);
		expect(normalizeConfiguredPlatformApex("")).toBeNull();
	});

	it("builds short managed hostnames under the platform apex", () => {
		expect(
			buildManagedServiceHost({
				serviceName: "backend",
				zoneName: "veritus.space",
				environment: {
					name: "development",
					isDefault: false,
					domainPrefix: null,
				},
			}),
		).toBe("backend.veritus.space");
	});

	it("builds stable random platform hostnames that omit the service name", () => {
		expect(
			buildRandomPlatformServiceHost({
				zoneName: "veritus.space",
				seed: "env-1:backend",
			}),
		).toBe("dcbf50a721.veritus.space");
		expect(
			buildRandomPlatformServiceHost({
				zoneName: "veritus.space",
				seed: "env-1:backend",
			}),
		).toBe(
			buildRandomPlatformServiceHost({
				zoneName: "veritus.space",
				seed: "env-1:backend",
			}),
		);
	});

	it("documents DNS setup options for platform and managed zones", () => {
		expect(platformDomainWildcardDnsHint("veritus.space", "13.51.16.1")).toContain(
			"*.veritus.space",
		);
		expect(
			platformDomainDnsSetupHints({
				host: "backend.veritus.space",
				platformApex: "veritus.space",
				targetIp: "13.51.16.1",
			}),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining("Wildcard A"),
				expect.stringContaining("backend.veritus.space A 13.51.16.1"),
				expect.stringContaining("Managed DNS (NS)"),
			]),
		);
		expect(
			managedZoneDnsSetupHints({
				host: "backend.veritus.space",
				zoneName: "veritus.space",
				targetIp: "13.51.16.1",
				zoneActive: true,
			})[0],
		).toContain("Nearzero will publish");
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
