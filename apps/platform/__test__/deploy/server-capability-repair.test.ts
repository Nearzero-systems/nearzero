import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildServerCapabilityRepairScript,
	getRepairableServerCapabilities,
} from "@nearzero/server/setup/server-capability-repair";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("server capability repair", () => {
	it("keeps repair selection unique and limited to supported capabilities", () => {
		expect(
			getRepairableServerCapabilities([
				"docker-group",
				"railpack",
				"docker-group",
				"swarm",
				"git",
				"nearzero-network",
			]),
		).toEqual(["docker-group", "railpack", "swarm", "nearzero-network"]);
	});

	it("generates valid, non-destructive repair scripts", async () => {
		const script = buildServerCapabilityRepairScript({
			capabilities: [
				"docker-daemon",
				"docker-group",
				"main-directory",
				"swarm",
				"swarm-manager",
				"nearzero-network",
				"nixpacks",
				"railpack",
				"buildpacks",
			],
			advertiseAddress: "10.0.0.10",
		});

		await expect(
			execFileAsync("bash", ["-n", "-c", script]),
		).resolves.toBeDefined();

		expect(script).toContain("docker_cmd swarm init");
		expect(script).toContain("docker_cmd network create");
		expect(script).toContain("usermod -aG docker");
		expect(script).not.toContain("docker swarm leave");
		expect(script).not.toContain("docker network rm");
		expect(script).toContain("NIXPACKS_VERSION");
		expect(script).toContain("RAILPACK_VERSION");
		expect(script).toContain("BUILDPACKS_VERSION");
		expect(script).toContain(
			"github.com/railwayapp/nixpacks/releases/download",
		);
		expect(script).toContain(
			"github.com/railwayapp/railpack/releases/download",
		);
		expect(script).toContain("github.com/buildpacks/pack/releases/download");
		expect(script).toContain("sha256sum -c -");
		expect(script).not.toContain("nixpacks.com/install.sh");
		expect(script).not.toContain("railpack.com/install.sh");
		expect(script).not.toMatch(/(?:curl|wget)[^\n]*\|[^\n]*(?:bash|sh)\b/);
	});
});
