import { addNearzeroNetworkToService } from "@nearzero/server";
import { describe, expect, it } from "vitest";

describe("addNearzeroNetworkToService", () => {
	it("should add network to an empty array", () => {
		const result = addNearzeroNetworkToService([]);
		expect(result).toEqual(["nearzero-network", "default"]);
	});

	it("should not add duplicate network to an array", () => {
		const result = addNearzeroNetworkToService(["nearzero-network"]);
		expect(result).toEqual(["nearzero-network", "default"]);
	});

	it("should add network to an existing array with other networks", () => {
		const result = addNearzeroNetworkToService(["other-network"]);
		expect(result).toEqual(["other-network", "nearzero-network", "default"]);
	});

	it("should add network to an object if networks is an object", () => {
		const result = addNearzeroNetworkToService({ "other-network": {} });
		expect(result).toEqual({
			"other-network": {},
			"nearzero-network": {},
			default: {},
		});
	});

	it("should not duplicate default network when already present", () => {
		const result = addNearzeroNetworkToService(["default", "nearzero-network"]);
		expect(result).toEqual(["default", "nearzero-network"]);
	});
});
