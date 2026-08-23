import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mergeRegistrationPolicyAdminEmail } from "@nearzero/server/lib/registration-policy";
import { writeManagedDnsBootstrapZone } from "@nearzero/server/services/dns-bootstrap-zone";
import {
	deriveInstallSetupLifecycle,
	generateInstallSetupToken,
	hashInstallSetupToken,
	resetInstallSetupRateLimits,
	resolveInstallSetupConfiguration,
	resolveInstallSetupResumeStep,
	runInstallSetupSubmissionExclusive,
	verifyInstallSetupToken,
} from "@nearzero/server/services/install-setup";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ENV_KEYS = ["NEARZERO_INSTALL_SETUP_TOKEN_HASH"] as const;
const originalEnvironment = new Map(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);

beforeEach(() => {
	for (const key of ENV_KEYS) delete process.env[key];
	resetInstallSetupRateLimits();
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		const original = originalEnvironment.get(key);
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
});

describe("install setup token", () => {
	it("hashes and verifies with constant-time comparison", () => {
		const token = generateInstallSetupToken();
		const hash = hashInstallSetupToken(token);
		process.env.NEARZERO_INSTALL_SETUP_TOKEN_HASH = hash;
		expect(verifyInstallSetupToken(token)).toBe(true);
		expect(verifyInstallSetupToken(`${token}x`)).toBe(false);
		expect(verifyInstallSetupToken("")).toBe(false);
	});

	it("rejects when no hash is configured", () => {
		expect(verifyInstallSetupToken("any-token-value-here")).toBe(false);
	});
});

const setupRequest = {
	token: "a-valid-setup-token",
	managementHostname: "nearzero.example.com",
	adminEmail: "owner@example.com",
	publicIp: "8.8.8.8",
	managedDnsZone: "apps.example.com",
	managedDnsSoaEmail: "dns@example.com",
	skipManagedDns: false,
};

describe("install setup fixed-value validation", () => {
	it("adopts omitted installer-fixed values and accepts the selected HTTPS origin", () => {
		const resolved = resolveInstallSetupConfiguration(
			{
				...setupRequest,
				publicIp: undefined,
				managedDnsZone: null,
				managedDnsSoaEmail: null,
			},
			{
				env: {
					NEARZERO_MANAGEMENT_HOSTNAME: "Nearzero.Example.com.",
					NEARZERO_ADMIN_EMAIL: "OWNER@example.com",
					NEARZERO_PUBLIC_IP: "8.8.8.8",
					NEARZERO_MANAGED_DNS_ZONE: "Apps.Example.com.",
					NEARZERO_MANAGED_DNS_SOA_EMAIL: "dns@example.com",
					CONSOLE_URL: "https://nearzero.example.com/",
					BETTER_AUTH_URL: "https://nearzero.example.com",
				},
			},
		);

		expect(resolved).toEqual({
			managementHostname: "nearzero.example.com",
			adminEmail: "owner@example.com",
			publicIp: "8.8.8.8",
			managedDnsZone: "apps.example.com",
			managedDnsSoaEmail: "dns@example.com",
			skipManagedDns: false,
		});
	});

	it.each([
		[
			"administrator email",
			{ NEARZERO_ADMIN_EMAIL: "fixed@example.com" },
			setupRequest,
		],
		[
			"management hostname",
			{ NEARZERO_MANAGEMENT_HOSTNAME: "fixed.example.com" },
			setupRequest,
		],
		["public IP", { NEARZERO_PUBLIC_IP: "1.1.1.1" }, setupRequest],
		[
			"managed DNS zone",
			{ NEARZERO_MANAGED_DNS_ZONE: "fixed.example.com" },
			setupRequest,
		],
		[
			"SOA email",
			{ NEARZERO_MANAGED_DNS_SOA_EMAIL: "fixed@example.com" },
			setupRequest,
		],
		[
			"console origin",
			{ CONSOLE_URL: "https://other.example.com" },
			setupRequest,
		],
		[
			"auth origin",
			{ BETTER_AUTH_URL: "http://nearzero.example.com" },
			setupRequest,
		],
	] as const)(
		"rejects a conflicting installer-fixed %s",
		(_label, env, request) => {
			expect(() =>
				resolveInstallSetupConfiguration(request, { env }),
			).toThrowError(/fixed|must be/i);
		},
	);

	it("rejects skipping an installer-fixed managed zone", () => {
		expect(() =>
			resolveInstallSetupConfiguration(
				{ ...setupRequest, managedDnsZone: null, skipManagedDns: true },
				{ env: { NEARZERO_MANAGED_DNS_ZONE: "apps.example.com" } },
			),
		).toThrowError(/cannot be skipped/i);
	});

	it("allows loopback bootstrap URLs and an idempotent pending-host retry", () => {
		expect(
			resolveInstallSetupConfiguration(setupRequest, {
				env: {
					CONSOLE_URL: "http://127.0.0.1:4321",
					BETTER_AUTH_URL: "http://localhost:4321",
				},
				persistedManagementHostname: "nearzero.example.com",
			}),
		).toMatchObject({ managementHostname: "nearzero.example.com" });
	});

	it("rejects changing the hostname left by a pending partial attempt", () => {
		expect(() =>
			resolveInstallSetupConfiguration(setupRequest, {
				env: {},
				persistedManagementHostname: "first.example.com",
			}),
		).toThrowError(/pending setup attempt/i);
	});
});

describe("install setup lifecycle and single writer", () => {
	it("keeps a pending row retryable regardless of partially written settings", () => {
		expect(
			deriveInstallSetupLifecycle({
				community: true,
				bootstrapClaimed: false,
				setupTokenConfigured: true,
				rowPhase: "pending",
			}),
		).toEqual({ phase: "pending", required: true, canSubmit: true });
		expect(
			resolveInstallSetupResumeStep({
				required: true,
				bootstrapClaimed: false,
				managementConfigured: true,
				phase: "pending",
			}),
		).toBe("management");
		expect(
			resolveInstallSetupResumeStep({
				required: false,
				bootstrapClaimed: false,
				managementConfigured: true,
				phase: "configured",
			}),
		).toBe("register");
		expect(
			deriveInstallSetupLifecycle({
				community: true,
				bootstrapClaimed: false,
				setupTokenConfigured: true,
				rowPhase: "configured",
			}),
		).toEqual({ phase: "configured", required: false, canSubmit: false });
	});

	it("runs concurrent setup applications one at a time", async () => {
		const events: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = runInstallSetupSubmissionExclusive(async () => {
			events.push("first:start");
			await firstGate;
			events.push("first:end");
		});
		const second = runInstallSetupSubmissionExclusive(async () => {
			events.push("second:start");
		});

		await Promise.resolve();
		expect(events).toEqual(["first:start"]);
		releaseFirst();
		await Promise.all([first, second]);
		expect(events).toEqual(["first:start", "first:end", "second:start"]);
	});

	it("releases the single-writer boundary after a failure", async () => {
		await expect(
			runInstallSetupSubmissionExclusive(async () => {
				throw new Error("apply failed");
			}),
		).rejects.toThrow("apply failed");
		await expect(
			runInstallSetupSubmissionExclusive(async () => "retried"),
		).resolves.toBe("retried");
	});
});

describe("registration policy merge", () => {
	it("prefers env admin email over wizard email", () => {
		expect(
			mergeRegistrationPolicyAdminEmail(
				{ mode: "bootstrap", adminEmail: "env@example.com" },
				"wizard@example.com",
			),
		).toEqual({ mode: "bootstrap", adminEmail: "env@example.com" });
	});

	it("fills missing env admin email from wizard state", () => {
		expect(
			mergeRegistrationPolicyAdminEmail(
				{ mode: "bootstrap", adminEmail: null },
				" Wizard@Example.com ",
			),
		).toEqual({ mode: "bootstrap", adminEmail: "wizard@example.com" });
	});
});

describe("managed DNS bootstrap zone writer", () => {
	it("writes a bootstrap zone file with glue and optional management A", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "nz-dns-"));
		try {
			const result = writeManagedDnsBootstrapZone({
				zoneName: "apps.example.com",
				publicIp: "8.8.8.8",
				soaEmail: "owner@example.com",
				managementHostname: "panel.apps.example.com",
				dnsRootPath: root,
			});
			expect(result.written).toBe(true);
			const contents = readFileSync(result.zonePath, "utf8");
			expect(contents).toContain("Nearzero bootstrap zone");
			expect(contents).toContain("ns1.apps.example.com.");
			expect(contents).toContain("panel 300 IN A 8.8.8.8");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
