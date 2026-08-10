import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeManagedDnsBootstrapZone } from "@nearzero/server/services/dns-bootstrap-zone";
import {
	generateInstallSetupToken,
	hashInstallSetupToken,
	resetInstallSetupRateLimits,
	verifyInstallSetupToken,
} from "@nearzero/server/services/install-setup";
import { mergeRegistrationPolicyAdminEmail } from "@nearzero/server/lib/registration-policy";
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
