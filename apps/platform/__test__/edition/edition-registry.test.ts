import { describe, expect, it } from "vitest";

describe("edition registry", () => {
	it("survives duplicated or reloaded edition-contract modules", async () => {
		const community = await import("@nearzero/edition-community");
		const firstContract = await import(
			"../../../../packages/edition-contract/src/registry.ts?copy=first"
		);
		const secondContract = await import(
			"../../../../packages/edition-contract/src/registry.ts?copy=second"
		);
		firstContract.setEdition(community.communityEdition);

		expect(secondContract.getEdition().edition).toBe("community");
		expect(secondContract.getEdition()).toBe(community.communityEdition);
	});
});
