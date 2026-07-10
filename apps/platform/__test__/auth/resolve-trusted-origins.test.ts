import { resolveEnvTrustedOrigins } from "@nearzero/server/lib/resolve-trusted-origins";
import { describe, expect, it } from "vitest";

describe("resolveEnvTrustedOrigins", () => {
	it("includes configured URLs and NEARZERO_TRUSTED_ORIGINS entries", () => {
		const origins = resolveEnvTrustedOrigins({
			CONSOLE_URL: "http://13.61.19.252:4321/",
			BETTER_AUTH_URL: "http://13.61.19.252:4321",
			PUBLIC_BACKEND_URL: "http://13.61.19.252:3000",
			NEARZERO_TRUSTED_ORIGINS:
				"http://172.31.0.1:4321,http://127.0.0.1:4321",
			NODE_ENV: "production",
		});

		expect(origins).toContain("http://13.61.19.252:4321");
		expect(origins).toContain("http://13.61.19.252:3000");
		expect(origins).toContain("http://172.31.0.1:4321");
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

	it("includes localhost variants in development", () => {
		const origins = resolveEnvTrustedOrigins({
			CONSOLE_URL: "http://localhost:4321",
			NODE_ENV: "development",
		});

		expect(origins).toContain("http://localhost:4321");
		expect(origins).toContain("http://127.0.0.1:4321");
		expect(origins).toContain("http://localhost:3000");
		expect(origins).toContain("http://127.0.0.1:3000");
	});
});
