import { domain } from "@nearzero/server/db/validations/domain";
import { describe, expect, it } from "vitest";

const parseHost = (host: string) => domain.shape.host.safeParse(host);
const parsePath = (path: string) => domain.shape.path.safeParse(path);

describe("domain routing validation", () => {
	it.each([
		"example.com",
		"api.example.com",
		"localhost",
		"192.168.1.100",
		"тест.рф",
	])("accepts a valid host: %s", (host) => {
		expect(parseHost(host).success).toBe(true);
	});

	it("normalizes host casing", () => {
		const result = parseHost("API.Example.COM");
		expect(result.success).toBe(true);
		if (result.success) expect(result.data).toBe("api.example.com");
	});

	it.each([
		"https://example.com",
		"example.com:443",
		"*.example.com",
		"example.com/path",
		"example..com",
		"-api.example.com",
		"api_.example.com",
		"example.com` || Host(`attacker.example",
		"example.com\nHost(`attacker.example`)",
	])("rejects an unsafe or malformed host: %s", (host) => {
		expect(parseHost(host).success).toBe(false);
	});

	it.each(["/", "/api", "/api/v1", "/api_v1"])(
		"accepts a valid routing path: %s",
		(path) => {
			expect(parsePath(path).success).toBe(true);
		},
	);

	it.each(["api", "/api` || PathPrefix(`/admin", "/api\n/admin"])(
		"rejects an unsafe routing path: %s",
		(path) => {
			expect(parsePath(path).success).toBe(false);
		},
	);

	it("rejects unsafe Traefik names and middleware references", () => {
		const result = domain.safeParse({
			host: "example.com",
			customEntrypoint: "web,admin",
			customCertResolver: "resolver\ninvalid",
			middlewares: ["auth@file,redirect@file"],
		});
		expect(result.success).toBe(false);
	});
});
