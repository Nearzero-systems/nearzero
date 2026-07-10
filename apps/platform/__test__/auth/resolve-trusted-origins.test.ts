import { bootstrapCommunityEdition } from "@nearzero/edition-community";
import {
	appendRequestOrigin,
	isAllowedSelfHostedOrigin,
	resolveEnvTrustedOrigins,
} from "@nearzero/server/lib/resolve-trusted-origins";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

function restoreEnv() {
	for (const key of Object.keys(process.env)) {
		if (!(key in ORIGINAL_ENV)) {
			delete process.env[key];
		}
	}
	Object.assign(process.env, ORIGINAL_ENV);
}

beforeEach(() => {
	bootstrapCommunityEdition();
});

afterEach(() => {
	restoreEnv();
	bootstrapCommunityEdition();
});

describe("resolveEnvTrustedOrigins", () => {
	it("includes configured URLs and NEARZERO_TRUSTED_ORIGINS entries", () => {
		const origins = resolveEnvTrustedOrigins({
			CONSOLE_URL: "http://203.0.113.10:4321/",
			BETTER_AUTH_URL: "http://203.0.113.10:4321",
			PUBLIC_BACKEND_URL: "http://203.0.113.10:3000",
			NEARZERO_TRUSTED_ORIGINS:
				"http://10.0.0.5:4321,http://127.0.0.1:4321",
			NODE_ENV: "production",
		});

		expect(origins).toContain("http://203.0.113.10:4321");
		expect(origins).toContain("http://203.0.113.10:3000");
		expect(origins).toContain("http://10.0.0.5:4321");
		expect(origins).toContain("http://127.0.0.1:4321");
	});

	it("adds port variants for each configured host", () => {
		const origins = resolveEnvTrustedOrigins({
			CONSOLE_URL: "http://203.0.113.10:4321",
			NEARZERO_CONSOLE_PORT: "4321",
			NEARZERO_PLATFORM_PORT: "3000",
			NODE_ENV: "production",
		});

		expect(origins).toContain("http://203.0.113.10:4321");
		expect(origins).toContain("http://203.0.113.10:3000");
		expect(origins).toContain("https://203.0.113.10:4321");
		expect(origins).toContain("https://203.0.113.10:3000");
	});

	it("includes localhost variants from network interfaces", () => {
		const origins = resolveEnvTrustedOrigins({
			CONSOLE_URL: "http://example.test:4321",
			NODE_ENV: "production",
		});

		expect(origins).toContain("http://localhost:4321");
		expect(origins).toContain("http://127.0.0.1:4321");
		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://127.0.0.1:3000");
	});

	it("adds community port wildcards for any self-host IP or domain", () => {
		const origins = resolveEnvTrustedOrigins({
			CONSOLE_URL: "http://example.test:4321",
			NEARZERO_CONSOLE_PORT: "4321",
			NEARZERO_PLATFORM_PORT: "3000",
			NODE_ENV: "production",
		});

		expect(origins).toContain("http://*:4321");
		expect(origins).toContain("http://*:3000");
		expect(origins).toContain("https://*:4321");
		expect(origins).toContain("https://*:3000");
	});
});

describe("isAllowedSelfHostedOrigin", () => {
	it("accepts any host on console and platform ports in community mode", () => {
		expect(isAllowedSelfHostedOrigin("http://203.0.113.10:4321")).toBe(true);
		expect(isAllowedSelfHostedOrigin("http://10.0.0.5:3000")).toBe(true);
		expect(isAllowedSelfHostedOrigin("https://nearzero.example.com:4321")).toBe(
			true,
		);
	});

	it("rejects unrelated ports", () => {
		expect(isAllowedSelfHostedOrigin("http://203.0.113.10:8080")).toBe(false);
	});
});

describe("appendRequestOrigin", () => {
	it("adds whatever origin the browser sent on the console port", () => {
		const request = new Request("http://example.com", {
			headers: { origin: "http://198.51.100.20:4321" },
		});

		const origins = appendRequestOrigin([], request, 4321, 3000);
		expect(origins).toContain("http://198.51.100.20:4321");
	});

	it("falls back to Host header when Origin is missing", () => {
		const request = new Request("http://platform:3000/api/auth/sign-up/email", {
			headers: { host: "198.51.100.20:4321" },
		});

		const origins = appendRequestOrigin([], request, 4321, 3000);
		expect(origins).toContain("http://198.51.100.20:4321");
	});
});
