import { beforeEach, describe, expect, it, vi } from "vitest";

const mockFindOtherZone = vi.fn();
const mockUnboundEnvironments = vi.fn();
const mockBoundZoneIds = vi.fn();
const mockFindEnvironmentById = vi.fn();
const mockPublishDnsZone = vi.fn();

vi.mock("@nearzero/server/db", () => ({
	db: {
		query: {
			dnsZones: {
				findFirst: (...args: unknown[]) => mockFindOtherZone(...args),
			},
		},
		select: () => ({
			from: () => ({
				innerJoin: () => ({
					where: () => mockUnboundEnvironments(),
				}),
			}),
		}),
		update: () => ({
			set: (values: { dnsZoneId: string }) => ({
				where: async () => mockBoundZoneIds(values.dnsZoneId),
			}),
		}),
	},
}));

vi.mock("@nearzero/server/services/environment", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@nearzero/server/services/environment")
		>();
	return {
		...actual,
		findEnvironmentById: (...args: unknown[]) =>
			mockFindEnvironmentById(...args),
	};
});

vi.mock("@nearzero/server/services/dns", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@nearzero/server/services/dns")>();
	return {
		...actual,
		publishDnsZone: (...args: unknown[]) => mockPublishDnsZone(...args),
	};
});

const { adoptFirstDnsZone } = await import(
	"@nearzero/server/services/managed-domain-provision"
);

describe("adoptFirstDnsZone", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFindEnvironmentById.mockResolvedValue({
			applications: [],
			compose: [],
		});
		mockPublishDnsZone.mockResolvedValue({});
	});

	it("makes the first zone the default for environments without one", async () => {
		mockFindOtherZone.mockResolvedValue(undefined);
		mockUnboundEnvironments.mockResolvedValue([
			{ environmentId: "env-1" },
			{ environmentId: "env-2" },
		]);

		await adoptFirstDnsZone("zone-1", "org-1");

		expect(mockBoundZoneIds.mock.calls).toEqual([["zone-1"], ["zone-1"]]);
		expect(mockFindEnvironmentById.mock.calls.flat()).toEqual([
			"env-1",
			"env-2",
		]);
		expect(mockPublishDnsZone).toHaveBeenCalledWith("zone-1", "org-1");
	});

	it("leaves environments alone when another zone already exists", async () => {
		mockFindOtherZone.mockResolvedValue({ dnsZoneId: "zone-0" });

		await adoptFirstDnsZone("zone-1", "org-1");

		expect(mockUnboundEnvironments).not.toHaveBeenCalled();
		expect(mockBoundZoneIds).not.toHaveBeenCalled();
		expect(mockPublishDnsZone).not.toHaveBeenCalled();
	});

	it("still finishes when publishing or moving hostnames fails", async () => {
		mockFindOtherZone.mockResolvedValue(undefined);
		mockUnboundEnvironments.mockResolvedValue([{ environmentId: "env-1" }]);
		mockFindEnvironmentById.mockRejectedValue(new Error("gone"));
		mockPublishDnsZone.mockRejectedValue(new Error("CoreDNS is down"));

		await expect(
			adoptFirstDnsZone("zone-1", "org-1"),
		).resolves.toBeUndefined();
		expect(mockBoundZoneIds).toHaveBeenCalledWith("zone-1");
	});
});
