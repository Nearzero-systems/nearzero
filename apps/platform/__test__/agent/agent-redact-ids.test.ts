import { describe, expect, it } from "vitest";
import { redactInternalIds } from "../../../console/src/components/dashboard/agent/redactInternalIds";

describe("redactInternalIds", () => {
	it("removes project id parentheticals from assistant text", () => {
		const input =
			"You have 1 project:\n• Hypeframe (ID: `7xHK4A3asOg037JWUEL76`) — created May 26, 2026";
		const output = redactInternalIds(input);
		expect(output).not.toContain("7xHK4A3asOg037JWUEL76");
		expect(output).toContain("Hypeframe");
	});
});
