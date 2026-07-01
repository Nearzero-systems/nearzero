import { generateConfigContainer } from "@nearzero/server/utils/docker/utils";
import { describe, expect, it } from "vitest";

describe("application routing service spec", () => {
	it("attaches applications to the shared Traefik network by default", () => {
		const config = generateConfigContainer({ replicas: 1 });

		expect(config.Networks).toEqual([{ Target: "nearzero-network" }]);
	});

	it("keeps custom Swarm networks while preserving Traefik reachability", () => {
		const config = generateConfigContainer({
			replicas: 1,
			networkSwarm: [{ Target: "private-network" }],
		});

		expect(config.Networks).toEqual([
			{ Target: "private-network" },
			{ Target: "nearzero-network" },
		]);
	});

	it("does not duplicate the shared Traefik network", () => {
		const config = generateConfigContainer({
			replicas: 1,
			networkSwarm: [{ Target: "nearzero-network" }],
		});

		expect(config.Networks).toEqual([{ Target: "nearzero-network" }]);
	});
});
