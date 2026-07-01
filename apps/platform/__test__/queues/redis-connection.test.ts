import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../server/load-env.js", () => ({}));

describe("redis-connection", () => {
	const originalRedisUrl = process.env.REDIS_URL;

	afterEach(() => {
		if (originalRedisUrl === undefined) {
			delete process.env.REDIS_URL;
		} else {
			process.env.REDIS_URL = originalRedisUrl;
		}
		vi.resetModules();
	});

	it("requires REDIS_URL instead of falling back to localhost", async () => {
		delete process.env.REDIS_URL;
		await expect(import("../../server/queues/redis-connection")).rejects.toThrow(
			/REDIS_URL is required/,
		);
	});

	it("parses REDIS_URL host and credentials", async () => {
		process.env.REDIS_URL = "redis://NZARY:Aryansh%40379@redis.example.com:6380";
		const mod = await import("../../server/queues/redis-connection");
		expect(mod.redisConfig).toMatchObject({
			host: "redis.example.com",
			port: 6380,
			username: "NZARY",
			password: "Aryansh@379",
		});
	});
});
