import {
	assertAuthoritativeSoaResponse,
	inspectDnsDelegation,
} from "@nearzero/server/services/dns";
import { describe, expect, it, vi } from "vitest";

const TRANSACTION_ID = 0x4e5a;

function encodeDnsName(name: string) {
	return Buffer.concat([
		...name.split(".").map((label) => {
			const encoded = Buffer.from(label, "ascii");
			return Buffer.concat([Buffer.from([encoded.length]), encoded]);
		}),
		Buffer.from([0]),
	]);
}

function compressionPointer(offset: number) {
	return Buffer.from([0xc0 | ((offset >> 8) & 0x3f), offset & 0xff]);
}

function createSoaResponse({
	zoneName = "apps.example.com",
	ownerName = zoneName,
	flags = 0x8400,
}: {
	zoneName?: string;
	ownerName?: string;
	flags?: number;
} = {}) {
	const questionName = encodeDnsName(zoneName);
	const questionTail = Buffer.alloc(4);
	questionTail.writeUInt16BE(6, 0);
	questionTail.writeUInt16BE(1, 2);
	const owner =
		ownerName === zoneName ? compressionPointer(12) : encodeDnsName(ownerName);
	const primaryNameserver = Buffer.concat([
		Buffer.from([3]),
		Buffer.from("ns1", "ascii"),
		compressionPointer(12),
	]);
	const responsibleMailbox = Buffer.concat([
		Buffer.from([10]),
		Buffer.from("hostmaster", "ascii"),
		compressionPointer(12),
	]);
	const timers = Buffer.alloc(20);
	for (let offset = 0; offset < timers.length; offset += 4) {
		timers.writeUInt32BE(offset === 0 ? 1 : 300, offset);
	}
	const rdata = Buffer.concat([primaryNameserver, responsibleMailbox, timers]);
	const resourceRecordHeader = Buffer.alloc(10);
	resourceRecordHeader.writeUInt16BE(6, 0);
	resourceRecordHeader.writeUInt16BE(1, 2);
	resourceRecordHeader.writeUInt32BE(60, 4);
	resourceRecordHeader.writeUInt16BE(rdata.length, 8);

	const header = Buffer.alloc(12);
	header.writeUInt16BE(TRANSACTION_ID, 0);
	header.writeUInt16BE(flags, 2);
	header.writeUInt16BE(1, 4);
	header.writeUInt16BE(1, 6);
	return Buffer.concat([
		header,
		questionName,
		questionTail,
		owner,
		resourceRecordHeader,
		rdata,
	]);
}

describe("managed DNS readiness", () => {
	it("accepts an authoritative exact-zone SOA response with compressed names", () => {
		const response = createSoaResponse();

		expect(() =>
			assertAuthoritativeSoaResponse(response, {
				transactionId: TRANSACTION_ID,
				zoneName: "apps.example.com.",
			}),
		).not.toThrow();
	});

	it("rejects a recursive, non-authoritative cached SOA response", () => {
		// QR + RD + RA with RCODE=0, but deliberately no authoritative AA bit.
		const response = createSoaResponse({ flags: 0x8180 });

		expect(() =>
			assertAuthoritativeSoaResponse(response, {
				transactionId: TRANSACTION_ID,
				zoneName: "apps.example.com",
			}),
		).toThrow("AA=0");
	});

	it("requires QR and a successful response code", () => {
		const queryPacket = createSoaResponse({ flags: 0x0400 });
		const serverFailure = createSoaResponse({ flags: 0x8402 });

		expect(() =>
			assertAuthoritativeSoaResponse(queryPacket, {
				transactionId: TRANSACTION_ID,
				zoneName: "apps.example.com",
			}),
		).toThrow("QR=0");
		expect(() =>
			assertAuthoritativeSoaResponse(serverFailure, {
				transactionId: TRANSACTION_ID,
				zoneName: "apps.example.com",
			}),
		).toThrow("RCODE=2");
	});

	it("rejects an authoritative SOA owned by a different zone", () => {
		const response = createSoaResponse({ ownerName: "example.com" });

		expect(() =>
			assertAuthoritativeSoaResponse(response, {
				transactionId: TRANSACTION_ID,
				zoneName: "apps.example.com",
			}),
		).toThrow("no SOA owned by apps.example.com");
	});

	it("rejects compression-pointer loops without hanging", () => {
		const response = createSoaResponse();
		const answerOffset = 12 + encodeDnsName("apps.example.com").length + 4;
		compressionPointer(answerOffset).copy(response, answerOffset);

		expect(() =>
			assertAuthoritativeSoaResponse(response, {
				transactionId: TRANSACTION_ID,
				zoneName: "apps.example.com",
			}),
		).toThrow("compression pointer loop");
	});

	it("reports publication, public delegation, and authoritative service separately", async () => {
		const result = await inspectDnsDelegation(
			{
				name: "apps.example.com",
				nameservers: ["ns1.apps.example.com", "ns2.apps.example.com"],
				status: "active",
				lastPublishedAt: new Date().toISOString(),
			},
			{
				resolveNameservers: vi.fn(async () => [
					"NS2.APPS.EXAMPLE.COM.",
					"ns1.apps.example.com",
				]),
				resolveAuthoritativeTarget: vi.fn(async () => "8.8.8.8"),
				resolveAuthoritativeSoa: vi.fn(async () => ({ serial: 1 })),
			},
		);

		expect(result).toMatchObject({
			published: true,
			delegated: true,
			authoritative: true,
			expectedNameservers: ["ns1.apps.example.com", "ns2.apps.example.com"],
			observedNameservers: ["ns1.apps.example.com", "ns2.apps.example.com"],
			diagnostics: [],
		});
	});

	it("never calls a merely published zone publicly delegated", async () => {
		const result = await inspectDnsDelegation(
			{
				name: "apps.example.com",
				nameservers: ["ns1.apps.example.com", "ns2.apps.example.com"],
				status: "active",
				lastPublishedAt: new Date().toISOString(),
			},
			{
				resolveNameservers: vi.fn(async () => ["ns1.provider.example"]),
				resolveAuthoritativeTarget: vi.fn(async () => "8.8.8.8"),
				resolveAuthoritativeSoa: vi.fn(async () => {
					throw new Error("connection refused");
				}),
			},
		);

		expect(result.published).toBe(true);
		expect(result.delegated).toBe(false);
		expect(result.authoritative).toBe(false);
		expect(result.diagnostics.join(" ")).toContain("Public NS differs");
		expect(result.diagnostics.join(" ")).toContain(
			"Authoritative SOA check failed",
		);
	});
});
