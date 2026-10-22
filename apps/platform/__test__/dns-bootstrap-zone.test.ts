import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeManagedDnsBootstrapZone } from "@nearzero/server/services/dns-bootstrap-zone";
import { describe, expect, it } from "vitest";

describe("managed DNS bootstrap zone writer", () => {
	it("writes a bootstrap zone file with glue and optional management A", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "nz-dns-"));
		try {
			const result = writeManagedDnsBootstrapZone({
				zoneName: "apps.example.com",
				publicIp: "8.8.8.8",
				soaEmail: "owner@example.com",
				managementHostname: "panel.apps.example.com",
				dnsRootPath: root,
			});
			expect(result.written).toBe(true);
			const contents = readFileSync(result.zonePath, "utf8");
			expect(contents).toContain("Nearzero bootstrap zone");
			expect(contents).toContain("ns1.apps.example.com.");
			expect(contents).toContain("panel 300 IN A 8.8.8.8");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
