import { describe, expect, it } from "vitest";
import { needsProjectNameFromUser } from "../../../../packages/agent/src/engine/project-name-guard";

describe("needsProjectNameFromUser", () => {
	it("requires input for empty and generic names", () => {
		expect(needsProjectNameFromUser("")).toBe(true);
		expect(needsProjectNameFromUser("New Project")).toBe(true);
		expect(needsProjectNameFromUser("My Project")).toBe(true);
		expect(needsProjectNameFromUser("Untitled")).toBe(true);
	});

	it("accepts explicit user-provided names", () => {
		expect(needsProjectNameFromUser("Torchflow")).toBe(false);
		expect(needsProjectNameFromUser("Hypeframe")).toBe(false);
	});
});
