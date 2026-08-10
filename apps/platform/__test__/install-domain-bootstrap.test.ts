import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	adoptConfiguredManagedDnsZone,
	ensureFirstOwnerServerIp,
	getInstallDomainConfig,
	hostnameOwnerInsideZone,
	persistConfiguredDnsZoneAdoptionMarker,
	seedConfiguredManagementDomain,
} from "@nearzero/server/services/install-domain-bootstrap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
	"NEARZERO_ADMIN_EMAIL",
	"NEARZERO_MANAGEMENT_HOSTNAME",
	"NEARZERO_MANAGED_DNS_ZONE",
	"NEARZERO_MANAGED_DNS_SOA_EMAIL",
	"NEARZERO_PUBLIC_IP",
] as const;
const originalEnvironment = new Map(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const original = originalEnvironment.get(key);
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

describe("first-install domain configuration", () => {
	it("keeps the management hostname and authoritative application zone distinct", () => {
		process.env.NEARZERO_MANAGEMENT_HOSTNAME = "Panel.Example.COM.";
		process.env.NEARZERO_MANAGED_DNS_ZONE = "Apps.Example.COM.";
		process.env.NEARZERO_ADMIN_EMAIL = "owner@example.com";

		expect(getInstallDomainConfig()).toEqual({
			managementHostname: "panel.example.com",
			managedDnsZone: "apps.example.com",
			soaEmail: "owner@example.com",
			publicIp: null,
		});
		expect(
			hostnameOwnerInsideZone("panel.example.com", "apps.example.com"),
		).toBeNull();
		expect(
			hostnameOwnerInsideZone("panel.apps.example.com", "apps.example.com"),
		).toBe("panel");
	});

	it("seeds an empty web-server singleton for HTTPS before first login", async () => {
		process.env.NEARZERO_MANAGEMENT_HOSTNAME = "panel.example.com";
		process.env.NEARZERO_ADMIN_EMAIL = "owner@example.com";
		process.env.NEARZERO_PUBLIC_IP = "8.8.8.8";
		const updateSettings = vi.fn(async () => ({
			host: "panel.example.com",
		}));

		const result = await seedConfiguredManagementDomain({
			getSettings: vi.fn(async () => null),
			updateSettings: updateSettings as never,
		});

		expect(result).toMatchObject({
			configured: true,
			changed: true,
			conflict: false,
			host: "panel.example.com",
			publicIp: "8.8.8.8",
			publicIpChanged: true,
		});
		expect(updateSettings).toHaveBeenCalledWith({
			host: "panel.example.com",
			https: true,
			certificateType: "letsencrypt",
			letsEncryptEmail: "owner@example.com",
			serverIp: "8.8.8.8",
		});
	});

	it("seeds a validated public IP without requiring a management hostname", async () => {
		process.env.NEARZERO_PUBLIC_IP = "1.1.1.1";
		const updateSettings = vi.fn(async () => ({
			serverIp: "1.1.1.1",
		}));

		const result = await seedConfiguredManagementDomain({
			getSettings: vi.fn(async () => ({ serverIp: null })) as never,
			updateSettings: updateSettings as never,
		});

		expect(result).toMatchObject({
			configured: false,
			changed: true,
			publicIp: "1.1.1.1",
			publicIpChanged: true,
		});
		expect(updateSettings).toHaveBeenCalledWith({ serverIp: "1.1.1.1" });
	});

	it("rejects a non-public installer IP before writing settings", async () => {
		process.env.NEARZERO_PUBLIC_IP = "10.0.0.5";
		process.env.NEARZERO_MANAGED_DNS_ZONE = "apps.example.com";
		const getSettings = vi.fn();
		const updateSettings = vi.fn();

		await expect(
			seedConfiguredManagementDomain({
				getSettings: getSettings as never,
				updateSettings: updateSettings as never,
			}),
		).rejects.toThrow(
			"NEARZERO_PUBLIC_IP must be a publicly routable IPv4 address",
		);
		expect(getSettings).not.toHaveBeenCalled();
		expect(updateSettings).not.toHaveBeenCalled();
	});

	it("allows a private IPv4 address for an install without public domains", () => {
		process.env.NEARZERO_PUBLIC_IP = "10.0.0.5";

		expect(getInstallDomainConfig()).toMatchObject({
			managementHostname: null,
			managedDnsZone: null,
			publicIp: "10.0.0.5",
		});
	});

	it("keeps a seeded public IP without running outbound discovery", async () => {
		const discoverPublicIp = vi.fn(async () => "9.9.9.9");
		const updateSettings = vi.fn();

		await expect(
			ensureFirstOwnerServerIp(discoverPublicIp, {
				getSettings: vi.fn(async () => ({ serverIp: "1.1.1.1" })) as never,
				updateSettings: updateSettings as never,
			}),
		).resolves.toBe("1.1.1.1");
		expect(discoverPublicIp).not.toHaveBeenCalled();
		expect(updateSettings).not.toHaveBeenCalled();
	});

	it("fails instead of starting with conflicting management hostnames", async () => {
		process.env.NEARZERO_MANAGEMENT_HOSTNAME = "new.example.com";
		process.env.NEARZERO_ADMIN_EMAIL = "owner@example.com";
		const updateSettings = vi.fn();

		await expect(
			seedConfiguredManagementDomain({
				getSettings: vi.fn(async () => ({
					host: "existing.example.com",
				})) as never,
				updateSettings: updateSettings as never,
			}),
		).rejects.toThrow(
			"NEARZERO_MANAGEMENT_HOSTNAME (new.example.com) conflicts with the persisted management hostname (existing.example.com)",
		);
		expect(updateSettings).not.toHaveBeenCalled();
	});
});

describe("first-owner CoreDNS adoption", () => {
	it("persists the adoption marker in the shared DNS root", () => {
		const root = mkdtempSync(
			path.join(os.tmpdir(), "nearzero-adoption-marker-"),
		);
		try {
			const markerPath = persistConfiguredDnsZoneAdoptionMarker(
				"Apps.Example.COM.",
				root,
			);
			expect(path.basename(markerPath)).toBe(
				".nearzero-adopted-apps.example.com",
			);
			expect(readFileSync(markerPath, "utf8")).toBe("apps.example.com\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not mark a configured zone adopted until publication succeeds", async () => {
		process.env.NEARZERO_MANAGED_DNS_ZONE = "apps.example.com";
		process.env.NEARZERO_ADMIN_EMAIL = "owner@example.com";
		const markZoneAdopted = vi.fn();

		await expect(
			adoptConfiguredManagedDnsZone(
				{ organizationId: "org-1", ownerEmail: "owner@example.com" },
				{
					createZone: vi.fn(async () => ({ dnsZoneId: "zone-1" })) as never,
					resolveTargetIp: vi.fn(),
					upsertSystemAddress: vi.fn() as never,
					publishZone: vi.fn(async () => {
						throw new Error("publish failed");
					}) as never,
					markZoneAdopted,
				},
			),
		).rejects.toThrow("publish failed");
		expect(markZoneAdopted).not.toHaveBeenCalled();
	});

	it("publishes in-zone nameserver glue and preserves an in-zone management A record", async () => {
		process.env.NEARZERO_MANAGEMENT_HOSTNAME = "panel.apps.example.com";
		process.env.NEARZERO_MANAGED_DNS_ZONE = "apps.example.com";
		process.env.NEARZERO_ADMIN_EMAIL = "owner@example.com";
		const createZone = vi.fn(async () => ({ dnsZoneId: "zone-1" }));
		const upsertSystemAddress = vi.fn(async () => ({
			dnsRecordId: "record-1",
		}));
		const publishZone = vi.fn(async () => ({
			dnsZoneId: "zone-1",
			status: "active",
		}));
		const markZoneAdopted = vi.fn();

		await adoptConfiguredManagedDnsZone(
			{ organizationId: "org-1", ownerEmail: "owner@example.com" },
			{
				createZone: createZone as never,
				resolveTargetIp: vi.fn(async () => "8.8.8.8"),
				upsertSystemAddress: upsertSystemAddress as never,
				publishZone: publishZone as never,
				markZoneAdopted,
			},
		);

		expect(createZone).toHaveBeenCalledWith("org-1", {
			name: "apps.example.com",
			soaEmail: "owner@example.com",
			ttl: 300,
			nameservers: ["ns1.apps.example.com", "ns2.apps.example.com"],
		});
		expect(upsertSystemAddress).toHaveBeenCalledWith({
			dnsZoneId: "zone-1",
			organizationId: "org-1",
			host: "panel.apps.example.com",
			value: "8.8.8.8",
		});
		expect(publishZone).toHaveBeenCalledWith("zone-1", "org-1");
		expect(markZoneAdopted).toHaveBeenCalledWith("apps.example.com");
		expect(publishZone.mock.invocationCallOrder[0]).toBeLessThan(
			markZoneAdopted.mock.invocationCallOrder[0] as number,
		);
	});

	it("leaves an out-of-zone management hostname with its external DNS provider", async () => {
		process.env.NEARZERO_MANAGEMENT_HOSTNAME = "panel.example.com";
		process.env.NEARZERO_MANAGED_DNS_ZONE = "apps.example.com";
		process.env.NEARZERO_ADMIN_EMAIL = "owner@example.com";
		const resolveTargetIp = vi.fn();
		const upsertSystemAddress = vi.fn();

		await adoptConfiguredManagedDnsZone(
			{ organizationId: "org-1", ownerEmail: "owner@example.com" },
			{
				createZone: vi.fn(async () => ({ dnsZoneId: "zone-1" })) as never,
				resolveTargetIp: resolveTargetIp as never,
				upsertSystemAddress: upsertSystemAddress as never,
				publishZone: vi.fn(async () => ({ status: "active" })) as never,
				markZoneAdopted: vi.fn(),
			},
		);

		expect(resolveTargetIp).not.toHaveBeenCalled();
		expect(upsertSystemAddress).not.toHaveBeenCalled();
	});
});
