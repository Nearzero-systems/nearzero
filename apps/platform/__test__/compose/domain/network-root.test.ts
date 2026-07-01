import { addNearzeroNetworkToRoot } from "@nearzero/server";
import { describe, expect, it } from "vitest";

describe("addNearzeroNetworkToRoot", () => {
	it("should create network object if networks is undefined", () => {
		const result = addNearzeroNetworkToRoot(undefined);
		expect(result).toEqual({ "nearzero-network": { external: true } });
	});

	it("should add network to an empty object", () => {
		const result = addNearzeroNetworkToRoot({});
		expect(result).toEqual({ "nearzero-network": { external: true } });
	});

	it("should not modify existing network configuration", () => {
		const existing = { "nearzero-network": { external: false } };
		const result = addNearzeroNetworkToRoot(existing);
		expect(result).toEqual({ "nearzero-network": { external: true } });
	});

	it("should add network alongside existing networks", () => {
		const existing = { "other-network": { external: true } };
		const result = addNearzeroNetworkToRoot(existing);
		expect(result).toEqual({
			"other-network": { external: true },
			"nearzero-network": { external: true },
		});
	});
});
