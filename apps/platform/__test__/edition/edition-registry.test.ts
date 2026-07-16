import { describe, expect, it, vi } from "vitest";

describe("edition registry", () => {
	it("survives duplicated or reloaded edition-contract modules", async () => {
		const community = await import("@nearzero/edition-community");
		const firstContract = await import("@nearzero/edition-contract");
		firstContract.setEdition(community.communityEdition);

		vi.resetModules();
		const secondContract = await import("@nearzero/edition-contract");

		expect(secondContract.getEdition().edition).toBe("community");
		expect(secondContract.getEdition()).toBe(community.communityEdition);
	});
});
