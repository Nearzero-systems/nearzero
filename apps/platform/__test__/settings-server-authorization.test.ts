import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
	new URL("../server/api/routers/settings.ts", import.meta.url),
	"utf8",
);

function routeBlock(name: string) {
	const marker = `\n\t${name}:`;
	const start = source.indexOf(marker);
	if (start < 0) throw new Error(`Settings route ${name} was not found`);
	const bodyStart = start + marker.length;
	const remainder = source.slice(bodyStart);
	const nextRoute = remainder.search(/\n\t[A-Za-z][A-Za-z0-9]*:/);
	return nextRoute < 0 ? remainder : remainder.slice(0, nextRoute);
}

describe("remote settings server authorization", () => {
	it.each([
		"reloadTraefik",
		"toggleDashboard",
		"cleanUnusedImages",
		"cleanUnusedVolumes",
		"cleanStoppedContainers",
		"cleanDockerBuilder",
		"cleanDockerPrune",
		"cleanAll",
		"updateDockerCleanup",
		"readDirectories",
		"updateTraefikFile",
		"readTraefikFile",
		"readTraefikEnv",
		"writeTraefikEnv",
		"haveTraefikDashboardPortEnabled",
		"setupGPU",
		"checkGPUStatus",
		"updateTraefikPorts",
		"getTraefikPorts",
	])(
		"checks organization ownership before %s accesses a remote server",
		(name) => {
			expect(routeBlock(name)).toContain("assertSettingsServerAccess");
		},
	);

	it("checks ownership before mutating Docker cleanup settings", () => {
		const block = routeBlock("updateDockerCleanup");
		expect(block.indexOf("assertSettingsServerAccess")).toBeGreaterThanOrEqual(
			0,
		);
		expect(block.indexOf("assertSettingsServerAccess")).toBeLessThan(
			block.indexOf("updateServerById"),
		);
	});
});
