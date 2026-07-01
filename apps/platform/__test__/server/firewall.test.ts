import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	buildPublishedPortFirewallScript,
	normalizePublishedPortSpecs,
} from "@nearzero/server/utils/servers/firewall";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

describe("remote published port firewall", () => {
	it("normalizes valid Docker published ports and skips unsafe values", () => {
		expect(
			normalizePublishedPortSpecs([
				{ PublishedPort: 8080, Protocol: "tcp" },
				{ PublishedPort: "8080", Protocol: "tcp" },
				{ PublishedPort: 8443, Protocol: "udp" },
				{ PublishedPort: 0, Protocol: "tcp" },
				{ PublishedPort: 70000, Protocol: "tcp" },
				{ PublishedPort: 9000, Protocol: "sctp" },
			]),
		).toEqual([
			{ publishedPort: 8080, protocol: "tcp" },
			{ publishedPort: 8443, protocol: "udp" },
		]);
	});

	it("generates valid host firewall script without enabling firewalls", async () => {
		const script = buildPublishedPortFirewallScript([
			{ publishedPort: 8080, protocol: "tcp" },
			{ publishedPort: 8443, protocol: "udp" },
		]);

		await expect(
			execFileAsync("bash", ["-n", "-c", script]),
		).resolves.toBeDefined();

		expect(script).toContain('PORT_SPECS="8080/tcp 8443/udp"');
		expect(script).toContain('ufw allow "$SPEC"');
		expect(script).toContain('firewall-cmd --permanent --add-port="$SPEC"');
		expect(script).toContain("iptables -I INPUT");
		expect(script).not.toContain("ufw enable");
	});
});
