import {
	chmodSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	getConfiguredPublicIp,
	getManagedDnsSoaEmail,
	getManagedDnsZone,
	getManagementHostname,
} from "@nearzero/server/constants/domains";
import { auth, reloadAuthRuntime } from "@nearzero/server/lib/auth";
import {
	resolveAuthPublicBaseUrl,
	resolveConsoleActionUrl,
	resolveConsoleUrl,
	resolveSharedCookieDomain,
} from "@nearzero/server/lib/public-url";
import {
	persistRuntimePublicConfig,
	readRuntimePublicConfig,
	resolveRuntimePublicConfigPath,
} from "@nearzero/server/lib/runtime-public-config";
import { afterEach, describe, expect, it } from "vitest";

const ENV_KEYS = [
	"NODE_ENV",
	"CONSOLE_URL",
	"BETTER_AUTH_URL",
	"NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH",
	"NEARZERO_MANAGEMENT_HOSTNAME",
	"NEARZERO_MANAGED_DNS_ZONE",
	"NEARZERO_MANAGED_DNS_SOA_EMAIL",
	"NEARZERO_ADMIN_EMAIL",
	"NEARZERO_PUBLIC_IP",
] as const;
const originalEnvironment = new Map(
	ENV_KEYS.map((key) => [key, process.env[key]]),
);
const temporaryRoots: string[] = [];

function temporaryConfigPath() {
	const root = mkdtempSync(path.join(os.tmpdir(), "nearzero-runtime-public-"));
	temporaryRoots.push(root);
	return path.join(root, "config", "runtime-public.json");
}

function persistExample(filePath: string) {
	return persistRuntimePublicConfig(
		{
			managementHostname: "Panel.Example.COM.",
			adminEmail: "Owner@Example.COM",
			publicIp: "8.8.8.8",
			managedDnsZone: "Apps.Example.COM.",
			managedDnsSoaEmail: "DNS@Example.COM",
		},
		{ path: filePath },
	);
}

afterEach(() => {
	for (const key of ENV_KEYS) {
		const original = originalEnvironment.get(key);
		if (original === undefined) delete process.env[key];
		else process.env[key] = original;
	}
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
	// Do not leave later auth tests attached to this test's temporary file.
	reloadAuthRuntime();
});

describe("runtime public configuration", () => {
	it("uses the protected production path unless an explicit test path is supplied", () => {
		expect(
			resolveRuntimePublicConfigPath({ env: { NODE_ENV: "production" } }),
		).toBe("/etc/nearzero/runtime-public.json");
		expect(
			resolveRuntimePublicConfigPath({ env: { NODE_ENV: "test" } }),
		).toBeNull();
	});

	it("atomically persists a normalized, private, strict configuration", () => {
		const filePath = temporaryConfigPath();
		const persisted = persistExample(filePath);

		expect(persisted).toEqual({
			version: 1,
			managementHostname: "panel.example.com",
			consoleUrl: "https://panel.example.com",
			adminEmail: "owner@example.com",
			publicIp: "8.8.8.8",
			managedDnsZone: "apps.example.com",
			managedDnsSoaEmail: "dns@example.com",
		});
		expect(readRuntimePublicConfig({ path: filePath })).toEqual(persisted);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		expect(
			readdirSync(path.dirname(filePath)).filter((name) =>
				name.endsWith(".tmp"),
			),
		).toEqual([]);
	});

	it("supports an explicitly skipped managed DNS zone", () => {
		const filePath = temporaryConfigPath();
		const persisted = persistRuntimePublicConfig(
			{
				managementHostname: "nearzero.example.com",
				adminEmail: "owner@example.com",
				publicIp: "1.1.1.1",
				managedDnsZone: null,
				managedDnsSoaEmail: null,
			},
			{ path: filePath },
		);

		expect(persisted.managedDnsZone).toBeNull();
		expect(persisted.managedDnsSoaEmail).toBeNull();
	});

	it("rejects unsafe files, unknown fields, and non-public addresses", () => {
		const filePath = temporaryConfigPath();
		persistExample(filePath);
		const parsed = readRuntimePublicConfig({ path: filePath });
		writeFileSync(
			filePath,
			JSON.stringify({ ...parsed, consoleUrl: "http://panel.example.com" }),
			{ mode: 0o600 },
		);
		expect(() => readRuntimePublicConfig({ path: filePath })).toThrow(
			"HTTPS origin",
		);
		writeFileSync(filePath, JSON.stringify({ ...parsed, unexpected: true }), {
			mode: 0o600,
		});
		expect(() => readRuntimePublicConfig({ path: filePath })).toThrow(
			"unexpected fields",
		);

		expect(() =>
			persistRuntimePublicConfig(
				{
					managementHostname: "nearzero.example.com",
					adminEmail: "owner@example.com",
					publicIp: "127.0.0.1",
				},
				{ path: filePath },
			),
		).toThrow("publicly routable IPv4");

		const symlinkPath = path.join(path.dirname(filePath), "linked.json");
		symlinkSync(filePath, symlinkPath);
		expect(() => readRuntimePublicConfig({ path: symlinkPath })).toThrow(
			"regular file",
		);
	});

	it("fails closed when permissions expose configuration to other users", () => {
		const filePath = temporaryConfigPath();
		persistExample(filePath);
		chmodSync(filePath, 0o644);
		expect(() => readRuntimePublicConfig({ path: filePath })).toThrow(
			"group/world accessible",
		);
	});
});

describe("runtime public URL precedence", () => {
	it("makes the wizard-selected runtime values canonical for DNS and routing", () => {
		const filePath = temporaryConfigPath();
		persistExample(filePath);
		process.env.NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH = filePath;
		process.env.NEARZERO_MANAGEMENT_HOSTNAME = "stale.example.net";
		process.env.NEARZERO_MANAGED_DNS_ZONE = "stale-apps.example.net";
		process.env.NEARZERO_MANAGED_DNS_SOA_EMAIL = "stale@example.net";
		process.env.NEARZERO_ADMIN_EMAIL = "stale@example.net";
		process.env.NEARZERO_PUBLIC_IP = "1.1.1.1";

		expect(getManagementHostname()).toBe("panel.example.com");
		expect(getManagedDnsZone()).toBe("apps.example.com");
		expect(getManagedDnsSoaEmail()).toBe("dns@example.com");
		expect(getConfiguredPublicIp()).toBe("8.8.8.8");
	});

	it("replaces installer loopback URLs with the persisted HTTPS origin", () => {
		const filePath = temporaryConfigPath();
		persistExample(filePath);
		const env = {
			NODE_ENV: "production",
			CONSOLE_URL: "http://127.0.0.1:4321",
			BETTER_AUTH_URL: "http://127.0.0.1:4321",
			NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH: filePath,
		};

		expect(resolveConsoleUrl(env)).toBe("https://panel.example.com");
		expect(resolveAuthPublicBaseUrl(env)).toBe("https://panel.example.com");
		expect(resolveSharedCookieDomain(env)).toBeNull();
		expect(resolveConsoleActionUrl("/invitation?token=safe", env)).toBe(
			"https://panel.example.com/invitation?token=safe",
		);
	});

	it("preserves explicitly configured non-loopback deployments", () => {
		const filePath = temporaryConfigPath();
		persistExample(filePath);
		const env = {
			NODE_ENV: "production",
			CONSOLE_URL: "https://console.explicit.example",
			BETTER_AUTH_URL: "https://auth.explicit.example",
			NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH: filePath,
		};

		expect(resolveConsoleUrl(env)).toBe("https://console.explicit.example");
		expect(resolveAuthPublicBaseUrl(env)).toBe(
			"https://console.explicit.example",
		);
		expect(resolveSharedCookieDomain(env)).toBe("explicit.example");
	});
});

describe("reloadable auth runtime", () => {
	it("keeps the exported facade stable while reloading the public origin", () => {
		const filePath = temporaryConfigPath();
		persistExample(filePath);
		process.env.NODE_ENV = "production";
		process.env.CONSOLE_URL = "http://127.0.0.1:4321";
		process.env.BETTER_AUTH_URL = "http://127.0.0.1:4321";
		process.env.NEARZERO_RUNTIME_PUBLIC_CONFIG_PATH = filePath;
		const stableHandler = auth.handler;
		const stableCreateApiKey = auth.createApiKey;

		const result = reloadAuthRuntime();

		expect(auth.handler).toBe(stableHandler);
		expect(auth.createApiKey).toBe(stableCreateApiKey);
		expect(result).toEqual({
			publicBaseUrl: "https://panel.example.com",
			secureCookies: true,
		});
	});
});
