import { describe, expect, test } from "bun:test";
import {
	isEnabledMarketingHomeValue,
	resolveMarketingHomeEnabled,
} from "./marketing-home";

describe("isEnabledMarketingHomeValue", () => {
	test.each(["true", "1", "yes", "on", " TRUE ", "Yes", "ON"])(
		"enables the marketing homepage for %p",
		(value) => {
			expect(isEnabledMarketingHomeValue(value)).toBe(true);
		},
	);

	test.each([
		undefined,
		null,
		"",
		"false",
		"0",
		"no",
		"off",
		"enabled",
		"true-ish",
	])("keeps the marketing homepage disabled for %p", (value) => {
		expect(isEnabledMarketingHomeValue(value)).toBe(false);
	});
});

describe("resolveMarketingHomeEnabled", () => {
	test("uses the build value when no runtime value is defined", () => {
		expect(resolveMarketingHomeEnabled(undefined, "yes")).toBe(true);
	});

	test("lets an explicit runtime value disable a build-time value", () => {
		expect(resolveMarketingHomeEnabled("false", "true")).toBe(false);
	});
});
