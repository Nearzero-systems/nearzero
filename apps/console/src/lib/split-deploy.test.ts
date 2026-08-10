import { describe, expect, test } from "vitest";
import { areConsoleBackendSplit } from "./split-deploy";

describe("areConsoleBackendSplit", () => {
	test("detects same host with a different platform port", () => {
		expect(
			areConsoleBackendSplit("http://127.0.0.1:4321", "http://127.0.0.1:3000"),
		).toBe(true);
	});

	test("keeps a universal OSS loopback fallback on the public origin", () => {
		expect(
			areConsoleBackendSplit(
				"https://nearzero.example.com",
				"http://127.0.0.1:3000",
			),
		).toBe(false);
	});

	test("uses an explicitly configured split platform origin", () => {
		expect(
			areConsoleBackendSplit(
				"https://app.example.com",
				"https://api.example.com",
			),
		).toBe(true);
	});

	test("recognizes an identical public origin", () => {
		expect(
			areConsoleBackendSplit(
				"https://nearzero.example.com",
				"https://nearzero.example.com",
			),
		).toBe(false);
	});
});
