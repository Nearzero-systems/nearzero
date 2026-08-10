import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockFindEnvironmentForDomain = vi.fn();
const mockResolveDomainTargetIp = vi.fn();
const mockGetWebServerSettings = vi.fn();

vi.mock("@nearzero/server/services/environment", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@nearzero/server/services/environment")
		>();
	return {
		...actual,
		findEnvironmentForDomain: (...args: unknown[]) =>
			mockFindEnvironmentForDomain(...args),
	};
});

vi.mock("@nearzero/server/services/domain-target", () => ({
	resolveDomainTargetIp: (...args: unknown[]) =>
		mockResolveDomainTargetIp(...args),
}));

vi.mock(
	"@nearzero/server/services/web-server-settings",
	async (importOriginal) => {
		const actual =
			await importOriginal<
				typeof import("@nearzero/server/services/web-server-settings")
			>();
		return {
			...actual,
			getWebServerSettings: (...args: unknown[]) =>
				mockGetWebServerSettings(...args),
		};
	},
);

vi.mock("@nearzero/server/db", () => ({
	db: {
		query: {
			dnsZones: {
				findFirst: vi.fn().mockResolvedValue(null),
			},
		},
	},
}));

const { previewServiceDomain } = await import(
	"@nearzero/server/services/managed-domain-provision"
);

describe("previewServiceDomain platform apex", () => {
	const originalPlatformDomain = process.env.NEARZERO_PLATFORM_DOMAIN;
	const originalSharedEdge = process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE;

	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.NEARZERO_PLATFORM_DOMAIN;
		delete process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE;
		mockFindEnvironmentForDomain.mockResolvedValue({
			dnsZoneId: null,
			name: "development",
			isDefault: false,
			domainPrefix: null,
			project: { organizationId: "org-1", name: "Acme" },
		});
		mockResolveDomainTargetIp.mockResolvedValue("13.51.16.1");
	});

	afterEach(() => {
		if (originalPlatformDomain === undefined) {
			delete process.env.NEARZERO_PLATFORM_DOMAIN;
		} else {
			process.env.NEARZERO_PLATFORM_DOMAIN = originalPlatformDomain;
		}
		if (originalSharedEdge === undefined) {
			delete process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE;
		} else {
			process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE = originalSharedEdge;
		}
	});

	it("does not use the web-server settings host as an application apex", async () => {
		mockGetWebServerSettings.mockResolvedValue({ host: "veritus.space" });

		const result = await previewServiceDomain({
			environmentId: "env-1",
			serviceName: "backend",
			serverId: "remote-server-id",
		});

		expect(result.mode).toBe("preview");
		expect(result.host).toBe("dcbf50a721-13-51-16-1.sslip.io");
		expect(result.host).not.toContain("backend");
		expect(result.platformApex).toBeNull();
	});

	it("uses an explicit platform apex remotely only with a shared edge", async () => {
		process.env.NEARZERO_PLATFORM_DOMAIN = "env-apex.com";
		process.env.NEARZERO_PLATFORM_DOMAIN_SHARED_EDGE = "true";
		mockGetWebServerSettings.mockResolvedValue({ host: "veritus.space" });

		const result = await previewServiceDomain({
			environmentId: "env-1",
			serviceName: "backend",
			serverId: "remote-server-id",
		});

		expect(result.mode).toBe("platform");
		expect(result.host).toBe("dcbf50a721.env-apex.com");
		expect(result.host).not.toContain("backend");
		expect(result.platformApex).toBe("env-apex.com");
	});

	it("falls back to sslip.io when no platform apex is configured", async () => {
		mockGetWebServerSettings.mockResolvedValue({ host: null });

		const result = await previewServiceDomain({
			environmentId: "env-1",
			serviceName: "backend",
			serverId: "remote-server-id",
		});

		expect(result.mode).toBe("preview");
		expect(result.host).toBe("dcbf50a721-13-51-16-1.sslip.io");
		expect(result.host).not.toContain("backend");
		expect(result.platformApex).toBeNull();
	});
});
