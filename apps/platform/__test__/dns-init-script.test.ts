import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const scriptPath = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../docker/dns-init.ts",
);

function runDnsInit(overrides: Record<string, string>) {
	const root = mkdtempSync(path.join(os.tmpdir(), "nearzero-dns-init-"));
	temporaryDirectories.push(root);
	const result = spawnSync("bun", [scriptPath], {
		encoding: "utf8",
		env: {
			...process.env,
			NEARZERO_DNS_ROOT: root,
			NEARZERO_LEGACY_DNS_ZONES_PATH: path.join(root, "legacy"),
			NEARZERO_ADMIN_EMAIL: "owner@example.com",
			NEARZERO_MANAGED_DNS_ZONE: "apps.example.com",
			NEARZERO_PUBLIC_IP: "8.8.8.8",
			...overrides,
		},
	});
	return { root, result };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("CoreDNS pre-signup zone bootstrap", () => {
	it("writes SOA, nameserver glue, and an in-zone management address", () => {
		const { root, result } = runDnsInit({
			NEARZERO_MANAGEMENT_HOSTNAME: "panel.apps.example.com",
		});
		expect(result.status, result.stderr).toBe(0);
		const zone = readFileSync(
			path.join(root, "zones/apps.example.com.zone"),
			"utf8",
		);
		expect(zone).toContain("@ IN SOA ns1.apps.example.com.");
		expect(zone).toContain("@ IN NS ns2.apps.example.com.");
		expect(zone).toContain("ns1 300 IN A 8.8.8.8");
		expect(zone).toContain("panel 300 IN A 8.8.8.8");
	});

	it("does not claim an out-of-zone management hostname", () => {
		const { root, result } = runDnsInit({
			NEARZERO_MANAGEMENT_HOSTNAME: "panel.example.com",
		});
		expect(result.status, result.stderr).toBe(0);
		const zone = readFileSync(
			path.join(root, "zones/apps.example.com.zone"),
			"utf8",
		);
		expect(zone).not.toContain("panel 300 IN A");
	});

	it("never overwrites a runtime-published zone", () => {
		const { root, result } = runDnsInit({
			NEARZERO_MANAGEMENT_HOSTNAME: "panel.apps.example.com",
		});
		expect(result.status, result.stderr).toBe(0);
		const zonePath = path.join(root, "zones/apps.example.com.zone");
		writeFileSync(zonePath, "$ORIGIN apps.example.com.\n; runtime zone\n");
		const second = spawnSync("bun", [scriptPath], {
			encoding: "utf8",
			env: {
				...process.env,
				NEARZERO_DNS_ROOT: root,
				NEARZERO_LEGACY_DNS_ZONES_PATH: path.join(root, "legacy"),
				NEARZERO_ADMIN_EMAIL: "owner@example.com",
				NEARZERO_MANAGED_DNS_ZONE: "apps.example.com",
				NEARZERO_MANAGEMENT_HOSTNAME: "panel.apps.example.com",
				NEARZERO_PUBLIC_IP: "1.1.1.1",
			},
		});
		expect(second.status, second.stderr).toBe(0);
		expect(readFileSync(zonePath, "utf8")).toBe(
			"$ORIGIN apps.example.com.\n; runtime zone\n",
		);
	});

	it("does not resurrect an adopted zone after intentional deletion", () => {
		const { root, result } = runDnsInit({
			NEARZERO_MANAGEMENT_HOSTNAME: "panel.apps.example.com",
		});
		expect(result.status, result.stderr).toBe(0);
		const zonePath = path.join(root, "zones/apps.example.com.zone");
		writeFileSync(
			path.join(root, ".nearzero-adopted-apps.example.com"),
			"apps.example.com\n",
		);
		rmSync(zonePath);

		const second = spawnSync("bun", [scriptPath], {
			encoding: "utf8",
			env: {
				...process.env,
				NEARZERO_DNS_ROOT: root,
				NEARZERO_LEGACY_DNS_ZONES_PATH: path.join(root, "legacy"),
				NEARZERO_ADMIN_EMAIL: "owner@example.com",
				NEARZERO_MANAGED_DNS_ZONE: "apps.example.com",
				NEARZERO_MANAGEMENT_HOSTNAME: "panel.apps.example.com",
				NEARZERO_PUBLIC_IP: "8.8.8.8",
			},
		});

		expect(second.status, second.stderr).toBe(0);
		expect(existsSync(zonePath)).toBe(false);
		expect(
			existsSync(path.join(root, ".nearzero-adopted-apps.example.com")),
		).toBe(true);
	});

	it("rejects a private address instead of publishing unusable public DNS", () => {
		const { result } = runDnsInit({
			NEARZERO_MANAGEMENT_HOSTNAME: "panel.apps.example.com",
			NEARZERO_PUBLIC_IP: "10.0.0.5",
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("must be a public IPv4 address");
	});
});
