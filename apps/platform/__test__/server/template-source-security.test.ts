import {
	fetchTemplateFiles,
	resolveTemplateBaseUrl,
} from "@nearzero/server/templates/github";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("template source boundary", () => {
	const originalTemplateBaseUrl = process.env.NEARZERO_TEMPLATE_BASE_URL;

	afterEach(() => {
		vi.restoreAllMocks();
		if (originalTemplateBaseUrl === undefined) {
			delete process.env.NEARZERO_TEMPLATE_BASE_URL;
		} else {
			process.env.NEARZERO_TEMPLATE_BASE_URL = originalTemplateBaseUrl;
		}
	});

	it("allows only the official or operator-configured template origin", () => {
		delete process.env.NEARZERO_TEMPLATE_BASE_URL;
		expect(resolveTemplateBaseUrl()).toBe("https://templates.nearzero.dev");
		expect(() =>
			resolveTemplateBaseUrl("http://169.254.169.254/latest/meta-data"),
		).toThrow("Template source is not allowed");

		process.env.NEARZERO_TEMPLATE_BASE_URL =
			"https://templates.internal.example/";
		expect(resolveTemplateBaseUrl("https://templates.internal.example")).toBe(
			"https://templates.internal.example",
		);
	});

	it("rejects traversal identifiers before making a request", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch");
		await expect(fetchTemplateFiles("../../metadata")).rejects.toThrow(
			"Invalid template identifier",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
