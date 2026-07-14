import { paths } from "@nearzero/server/constants";
import {
	apiModifyTraefikConfig,
	apiReadTraefikConfig,
} from "@nearzero/server/db/schema";
import { resolveTraefikConfigPath } from "@nearzero/server/utils/traefik/application";
import { describe, expect, it } from "vitest";

describe("Traefik config path safety", () => {
	it.each(["dynamic/app.yml", "dynamic/nested/app.yaml"])(
		"accepts a managed relative YAML path: %s",
		(input) => {
			const result = resolveTraefikConfigPath(input);
			expect(result.candidatePath).toBe(
				`${paths().MAIN_TRAEFIK_PATH}/${input}`,
			);
		},
	);

	it("accepts a managed absolute YAML path", () => {
		const input = `${paths().MAIN_TRAEFIK_PATH}/dynamic/app.yml`;
		expect(resolveTraefikConfigPath(input).candidatePath).toBe(input);
	});

	it.each([
		"../outside.yml",
		"dynamic/../../outside.yml",
		"dynamic/app.json",
		"dynamic/acme.json",
		"dynamic/app.yml;id",
		"dynamic/$(id).yml",
		"dynamic/app\nname.yml",
		"dynamic/app'quote.yml",
		'dynamic/app"quote.yml',
	])("rejects an unsafe path: %s", (input) => {
		expect(() => resolveTraefikConfigPath(input)).toThrow();
	});

	it("rejects a sibling directory that only shares the managed prefix", () => {
		const input = `${paths().MAIN_TRAEFIK_PATH}-evil/app.yml`;
		expect(() => resolveTraefikConfigPath(input)).toThrow();
	});

	it.each([
		"../outside.yml",
		"dynamic/../../outside.yml",
		"dynamic/app.json",
		"dynamic/app.yml;id",
		"dynamic/$(id).yml",
		"dynamic/app\nname.yml",
	])("rejects an unsafe API path before file access: %s", (path) => {
		expect(apiReadTraefikConfig.safeParse({ path }).success).toBe(false);
		expect(
			apiModifyTraefikConfig.safeParse({ path, traefikConfig: "http: {}" })
				.success,
		).toBe(false);
	});

	it("limits API configuration payload size", () => {
		expect(
			apiModifyTraefikConfig.safeParse({
				path: "dynamic/app.yml",
				traefikConfig: "x".repeat(2 * 1024 * 1024 + 1),
			}).success,
		).toBe(false);
	});
});
