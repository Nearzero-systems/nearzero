import { assertHostnameIsNotReservedForPlatform } from "@nearzero/server/services/domain";
import {
	isPublicIpv4,
	resolvePublicIpv4Target,
} from "@nearzero/server/services/domain-target";
import {
	buildManagedPreviewHost,
	buildManagedServiceHost,
	buildPreviewServiceSlug,
} from "@nearzero/server/services/managed-domain";
import {
	createSoaSerial,
	normalizeDnsRecordName,
	normalizeDnsRecordValue,
	normalizeDnsZoneName,
	renderZoneFile,
} from "@nearzero/server/utils/dns/zone-file";
import { describe, expect, it } from "vitest";

describe("DNS input safety", () => {
	it("normalizes valid internationalized zones and rejects traversal or controls", () => {
		expect(normalizeDnsZoneName("BÜCHER.Example.")).toBe(
			"xn--bcher-kva.example",
		);
		expect(() => normalizeDnsZoneName("../../etc/passwd")).toThrow();
		expect(() =>
			normalizeDnsZoneName("example.com\n$INCLUDE /tmp/file"),
		).toThrow(/control characters/);
	});

	it("allows safe service labels and left-most wildcard record names only", () => {
		expect(normalizeDnsRecordName("_acme-challenge", "example.com")).toBe(
			"_acme-challenge",
		);
		expect(normalizeDnsRecordName("*.preview", "example.com")).toBe(
			"*.preview",
		);
		expect(() => normalizeDnsRecordName("preview.*", "example.com")).toThrow(
			/left-most/,
		);
		expect(() =>
			normalizeDnsRecordName("outside.example.net.", "example.com"),
		).toThrow(/not inside/);
	});

	it("validates and normalizes each record value instead of emitting raw zone text", () => {
		expect(normalizeDnsRecordValue("A", "1.2.3.4", "example.com")).toBe(
			"1.2.3.4",
		);
		expect(normalizeDnsRecordValue("CNAME", "origin", "example.com")).toBe(
			"origin.example.com.",
		);
		expect(
			normalizeDnsRecordValue("CAA", "0 ISSUE letsencrypt.org", "example.com"),
		).toBe('0 issue "letsencrypt.org"');
		expect(() =>
			normalizeDnsRecordValue("A", "127.0.0.1\nwww A 1.2.3.4", "example.com"),
		).toThrow(/control characters/);
		expect(() =>
			normalizeDnsRecordValue("AAAA", "1.2.3.4", "example.com"),
		).toThrow(/IPv6/);
		expect(
			normalizeDnsRecordValue(
				"TXT",
				'"safe" "www 60 IN A 6.6.6.6"',
				"example.com",
			),
		).toBe('safe" "www 60 IN A 6.6.6.6');
	});

	it("uses the configured primary nameserver in SOA and rejects CNAME conflicts", () => {
		const rendered = renderZoneFile({
			zoneName: "example.com",
			soaEmail: "host.master@example.com",
			defaultTtl: 300,
			nameservers: ["dns1.provider.net", "dns2.provider.net"],
			serial: "123",
			records: [{ name: "www", type: "A", value: "1.2.3.4" }],
		});
		expect(rendered).toContain(
			"@ IN SOA dns1.provider.net. host\\.master.example.com.",
		);
		expect(rendered).toContain("@ IN NS dns2.provider.net.");

		expect(() =>
			renderZoneFile({
				zoneName: "example.com",
				soaEmail: "hostmaster@example.com",
				defaultTtl: 300,
				nameservers: ["ns1.example.com"],
				serial: "124",
				records: [
					{ name: "www", type: "CNAME", value: "origin.example.com" },
					{ name: "www", type: "TXT", value: "conflict" },
				],
			}),
		).toThrow(/CNAME conflict/);
	});

	it("increments an SOA serial for every write in the same millisecond", () => {
		const first = Number(createSoaSerial(1_700_000_000_000));
		const second = Number(createSoaSerial(1_700_000_000_000));
		const third = Number(createSoaSerial(1_700_000_000_000));
		expect(second).toBe((first + 1) % 2 ** 32);
		expect(third).toBe((second + 1) % 2 ** 32);
		expect(Number(createSoaSerial(1_699_000_000_000, third))).toBe(
			(third + 1) % 2 ** 32,
		);
	});
});

describe("managed DNS target safety", () => {
	it("reserves the configured platform namespace for generated hostnames", () => {
		const previous = process.env.NEARZERO_PLATFORM_DOMAIN;
		process.env.NEARZERO_PLATFORM_DOMAIN = "veritus.space";
		try {
			expect(() =>
				assertHostnameIsNotReservedForPlatform(
					"customer.veritus.space",
					"external",
				),
			).toThrow(/reserved/);
			expect(() =>
				assertHostnameIsNotReservedForPlatform(
					"customer.veritus.space",
					"platform",
				),
			).not.toThrow();
			expect(() =>
				assertHostnameIsNotReservedForPlatform(
					"customer.example.com",
					"external",
				),
			).not.toThrow();
		} finally {
			if (previous === undefined) delete process.env.NEARZERO_PLATFORM_DOMAIN;
			else process.env.NEARZERO_PLATFORM_DOMAIN = previous;
		}
	});

	it("accepts public IPv4 and rejects non-public address classes", () => {
		expect(isPublicIpv4("8.8.8.8")).toBe(true);
		for (const address of [
			"0.0.0.0",
			"10.0.0.1",
			"100.64.0.1",
			"127.0.0.1",
			"169.254.1.1",
			"172.16.0.1",
			"192.168.1.1",
			"198.51.100.1",
			"224.0.0.1",
		]) {
			expect(isPublicIpv4(address), address).toBe(false);
		}
	});

	it("requires one stable public address and rejects mixed or ambiguous answers", async () => {
		await expect(
			resolvePublicIpv4Target("node.example.com", async () => [
				"8.8.8.8",
				"1.1.1.1",
			]),
		).rejects.toThrow(/exactly one/);
		await expect(
			resolvePublicIpv4Target("node.example.com", async () => ["8.8.8.8"]),
		).resolves.toBe("8.8.8.8");
		await expect(
			resolvePublicIpv4Target("node.example.com", async () => [
				"8.8.8.8",
				"10.0.0.1",
			]),
		).rejects.toThrow(/only to public IPv4/);
		await expect(resolvePublicIpv4Target("2001:db8::1")).rejects.toThrow(
			/IPv6-only/,
		);
	});
});

describe("managed hostname plans", () => {
	it("uses the zone apex for production and an environment label otherwise", () => {
		expect(
			buildManagedServiceHost({
				serviceName: "Web App",
				zoneName: "veritus.space",
				environment: {
					name: "production",
					isDefault: false,
					domainPrefix: null,
				},
			}),
		).toBe("web-app.veritus.space");
		expect(
			buildManagedServiceHost({
				serviceName: "Web App",
				zoneName: "veritus.space",
				environment: {
					name: "staging",
					isDefault: false,
					domainPrefix: null,
				},
			}),
		).toBe("web-app.staging.veritus.space");
	});

	it("keeps generated preview labels inside DNS's 63-byte label limit", () => {
		const slug = buildPreviewServiceSlug({
			pullRequestNumber: "123456789",
			serviceName: "x".repeat(200),
			applicationId: "application-123456789",
		});
		expect(slug.length).toBeLessThanOrEqual(63);
		const host = buildManagedPreviewHost({
			appName: "x".repeat(200),
			zoneName: "sslip.io",
			targetIp: "123.123.123.123",
		});
		expect(host.split(".")[0]?.length).toBeLessThanOrEqual(63);
	});
});
